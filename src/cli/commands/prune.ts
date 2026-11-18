import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { RepositoryDeclarations } from '../manifest.js';
import { buildPlan, sameValue, safeSnapshot, type LocalState, type PlanStale } from '../reconciliation.js';
import { acquireLock, createBackup, loadState, writeState } from '../local-state.js';

// Matches the entry point's operation-error exit status: prune reports it in
// the JSON output and the entry point mirrors it onto process.exitCode.
const OPERATION_ERROR = 1;

export interface PruneResult {
  target: string;
  action: string;
  installed: boolean;
  overlaps?: string[];
}

export interface PruneInput {
  repo: string;
  agentDir: string;
  declarations: RepositoryDeclarations;
  confirm: boolean;
}

export interface PruneOutput {
  apiVersion: 1;
  command: 'prune';
  ok: boolean;
  exitCode: number;
  repository: string;
  agentDirectory: string;
  mode: 'confirmed' | 'preview';
  staleResources: PruneResult[];
}

// Handles stale managed resources (declared in the local baseline but no
// longer in the manifest). Without --confirm it only reports what it would
// do. With --confirm it removes only stale targets that still match their
// baseline: overlapping targets and locally modified ones are retained, and
// each removal is backed up first and re-verified before deletion. Ordinary
// apply never removes stale resources.
async function pruneStale(agentDir: string, state: LocalState, stale: PlanStale[], confirmed: boolean): Promise<PruneResult[]> {
  const results: PruneResult[] = [];
  const nextState = structuredClone(state);
  for (const item of stale) {
    if (item.overlaps?.length) {
      results.push({ target: item.target, action: 'retained-overlap', installed: item.localSnapshot !== null, overlaps: item.overlaps });
      continue;
    }
    if (!confirmed) {
      results.push({ target: item.target, action: item.eligible ? 'would-prune' : 'modified', installed: item.localSnapshot !== null });
      continue;
    }
    if (!item.eligible) {
      results.push({ target: item.target, action: 'retained-modified', installed: true });
      continue;
    }
    if (item.localSnapshot !== null) {
      const info = await fs.lstat(item.targetPath);
      await createBackup(agentDir, item.target, item.targetPath, info.isDirectory());
      const observed = await safeSnapshot(item.targetPath);
      if (!sameValue(observed, item.localSnapshot)) throw new Error(`Stale resource changed during prune; refusing to remove: ${item.target}`);
      const tombstone = path.join(path.dirname(item.targetPath), `.${path.basename(item.targetPath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.pruned`);
      await fs.rename(item.targetPath, tombstone);
      try { await fs.rm(tombstone, { recursive: true }); }
      catch (error) {
        await fs.rename(tombstone, item.targetPath).catch(() => {});
        throw error;
      }
    }
    delete nextState.resources[item.target];
    await writeState(agentDir, nextState);
    results.push({ target: item.target, action: item.localSnapshot === null ? 'forgotten-missing' : 'pruned', installed: false });
  }
  return results;
}

// The prune workflow: distinct from ordinary apply. It only takes the apply
// lock (and re-reads the baseline under it) for the explicit --confirm mode;
// a bare prune is a read-only preview that never locks or writes.
export async function runPrune({ repo, agentDir, declarations, confirm }: PruneInput): Promise<PruneOutput> {
  const state = await loadState(agentDir);
  const releaseLock = confirm ? await acquireLock(agentDir) : null;
  try {
    const currentState = releaseLock ? await loadState(agentDir) : state;
    const plan = await buildPlan(repo, agentDir, declarations, currentState);
    const staleResources = await pruneStale(agentDir, currentState, plan.stale, confirm);
    const ok = !staleResources.some((item) => ['modified', 'retained-modified', 'retained-overlap'].includes(item.action));
    return { apiVersion: 1, command: 'prune', ok, exitCode: ok ? 0 : OPERATION_ERROR, repository: repo, agentDirectory: agentDir,
      mode: confirm ? 'confirmed' : 'preview', staleResources };
  } finally {
    if (releaseLock) await releaseLock();
  }
}