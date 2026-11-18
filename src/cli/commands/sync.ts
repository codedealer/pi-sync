import fs from 'node:fs/promises';
import path from 'node:path';
import { MANIFEST_FILE, validateRepository, type RepositoryDeclarations } from '../manifest.js';
import {
  buildPlan,
  syncClassification,
  type LocalState,
  type SyncConflictField,
  type SyncReviewField,
  type SyncableField,
} from '../reconciliation.js';
import { acquireLock, loadState, writeState } from '../local-state.js';
import { findLikelySecretsInText, restoreFileAtomic, writeJsonFileAtomic } from '../resource-operations.js';

// Matches the entry point's operation-error exit status: sync reports it in
// the JSON output and the entry point mirrors it onto process.exitCode.
const OPERATION_ERROR = 1;

interface SyncError extends Error {
  errorCode?: string;
  details?: unknown;
}

export interface SyncInput {
  repo: string;
  agentDir: string;
  declarations: RepositoryDeclarations;
  apply: boolean;
}

export interface SyncOutput {
  apiVersion: 1;
  command: 'sync';
  ok: boolean;
  exitCode: number;
  repository: string;
  agentDirectory: string;
  mode: 'preview' | 'applied';
  syncable?: SyncableField[];
  synced?: SyncableField[];
  conflicts: SyncConflictField[];
  rejected: SyncReviewField[];
  review: SyncReviewField[];
  note: string;
}

// Back-syncs local-only managed setting changes into the setup manifest.
// A field is eligible only when the three-way comparison says the repository
// is unchanged and the local installation diverged from the last applied
// baseline. Conflicts, collisions (no baseline), and locally removed fields
// are reported for manual review and never written. The manifest is the only
// file this command modifies; it is rewritten with the same atomic
// read-check-rename pattern as add/remove and re-validated after the write.
async function syncSettings(repo: string, agentDir: string, declarations: RepositoryDeclarations, state: LocalState, applyChanges: boolean): Promise<SyncOutput> {
  const plan = await buildPlan(repo, agentDir, declarations, state);
  const { syncable, conflicts, rejected, review } = syncClassification(plan);

  if (!applyChanges) {
    return { apiVersion: 1, command: 'sync', ok: true, exitCode: 0, repository: repo, agentDirectory: agentDir, mode: 'preview',
      syncable, conflicts, rejected, review,
      note: syncable.length
        ? 'Preview only: run `pi-sync sync --apply` to write the local values into the setup manifest. Pushing the change still requires an explicit `pi-sync push`.'
        : 'Nothing to sync: every managed setting field matches the setup manifest locally.' };
  }

  const output: SyncOutput = { apiVersion: 1, command: 'sync', ok: true, exitCode: 0, repository: repo, agentDirectory: agentDir, mode: 'applied',
    synced: [], conflicts, rejected, review, note: '' };
  if (!syncable.length) {
    output.note = conflicts.length || rejected.length || review.length
      ? 'No eligible local-only changes to write; the reported fields need manual review.'
      : 'Nothing to sync: every managed setting field matches the setup manifest locally.';
    if (conflicts.length || rejected.length || review.length) { output.ok = false; output.exitCode = OPERATION_ERROR; }
    return output;
  }

  const manifestPath = path.join(repo, MANIFEST_FILE);
  const manifestText = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  const nextManifest = structuredClone(manifest);
  for (const change of syncable) {
    const field = nextManifest.settings?.find((item: any) => item.target === change.target)?.fields?.find((item: any) => item.path === change.path);
    if (!field) throw new Error(`Manifest no longer declares ${change.target} ${change.path}; re-run sync`);
    field.value = change.to;
  }
  const findings = findLikelySecretsInText(`${JSON.stringify(nextManifest, null, 2)}\n`, MANIFEST_FILE);
  if (findings.length) {
    const error: SyncError = new Error('Synced local setting values contain suspected credential material; nothing was written');
    error.errorCode = 'SYNC_BLOCKED';
    error.details = { reviewRequired: findings };
    throw error;
  }
  await writeJsonFileAtomic(manifestPath, nextManifest, manifestText, 'sync');
  try {
    await validateRepository(repo);
  } catch (error) {
    await restoreFileAtomic(manifestPath, manifestText);
    throw error;
  }
  // Re-baseline the synced fields so a later local change is compared against
  // the value this sync just published, not against the pre-sync baseline
  // (which would misclassify the next local-only change as a both-sides conflict).
  const mutableState = structuredClone(state);
  for (const change of syncable) {
    mutableState.settings[change.target] ??= {};
    mutableState.settings[change.target][change.path] = { exists: true, value: change.to };
  }
  await writeState(agentDir, mutableState);
  output.synced = syncable;
  output.note = 'Local values were written to the setup manifest. The setup repository is not committed or pushed; publish with an explicit `pi-sync push`.';
  if (conflicts.length || rejected.length || review.length) { output.ok = false; output.exitCode = OPERATION_ERROR; }
  return output;
}

// The sync workflow: read-only preview by default; with --apply it takes the
// same agent lock as apply (it writes the manifest and re-baselines the
// synced fields) and publishes the local-only values into the setup manifest
// without committing or pushing anything.
export async function runSync({ repo, agentDir, declarations, apply }: SyncInput): Promise<SyncOutput> {
  const agentInfo = await fs.lstat(agentDir).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!agentInfo) throw new Error(`Pi agent directory does not exist: ${agentDir}`);
  // --apply writes the manifest and re-baselines synced fields, so it takes
  // the same agent lock as apply to serialize state.json updates.
  const releaseSyncLock = apply ? await acquireLock(agentDir) : null;
  try {
    const state = await loadState(agentDir);
    return await syncSettings(repo, agentDir, declarations, state, apply);
  } finally {
    if (releaseSyncLock) await releaseSyncLock();
  }
}