import fs from 'node:fs/promises';
import path from 'node:path';
import {
  discoverUpdates,
  installPinnedPackages,
  lockWithUpdates,
  obtainFirstInstallApproval,
  rollbackPinnedPackages,
  writeLockfile,
} from '../../packages.js';
import { MANIFEST_FILE, LOCK_FILE, readJson, validateRepository, type LockFile, type LockPackage, type RepositoryDeclarations } from '../manifest.js';
import { runPush, type PushOutput } from './push.js';
import { STATE_DIR, acquireLock, captureRawFile, loadPackagePins, restoreRawFile, savePackagePins } from '../local-state.js';

export interface PackageUpdate {
  from: LockPackage | null;
  to: LockPackage;
  installSpec: string;
}

export interface UpdateInput {
  repo: string;
  agentDir: string;
  declarations: RepositoryDeclarations;
  apply: boolean;
  approve: boolean;
  push: boolean;
  // Forwarded to the managed-only push workflow for `update --apply --push`.
  message?: string;
  // The entry point owns stream output: for `update --push` the push module's
  // human-readable preview is passed through this entry-point-supplied writer.
  previewWriter: (preview: string) => void;
}

// The manifest fields this workflow reads directly. It re-reads the raw
// manifest (not the validated declarations) so the release-age policy
// reflects current repository content; discoverUpdates runtime-validates the
// rest of what it reads.
interface PolicyManifest {
  policy?: { minimumReleaseAgeDays?: number };
}

export interface InstalledPackage {
  package: string;
  pin: string;
  action: 'installed';
}

interface UpdateOutputBase {
  apiVersion: 1;
  command: 'update';
  ok: true;
  exitCode: 0;
  repository: string;
  minimumReleaseAgeDays: number;
  policySource: 'setup repository pi-sync.json';
}

// The response shapes are discriminated by `mode` so consumers can rely on
// the pin fields that actually exist for each shape (proposedPins for
// previews; pins plus install results for applied runs).
export interface UpdatePreviewOutput extends UpdateOutputBase {
  mode: 'preview';
  updates: PackageUpdate[];
  proposedPins: LockPackage[];
  note: string;
}

export interface UpdateAppliedNoUpdatesOutput extends UpdateOutputBase {
  mode: 'applied';
  updates: PackageUpdate[];
  pins: LockPackage[];
  note: string;
}

export interface UpdateAppliedInstalledOutput extends UpdateOutputBase {
  mode: 'applied';
  updates: PackageUpdate[];
  pins: LockPackage[];
  installed: InstalledPackage[];
  push?: PushOutput;
  dependencyModel?: string;
}

export type UpdateOutput = UpdatePreviewOutput | UpdateAppliedNoUpdatesOutput | UpdateAppliedInstalledOutput;

// The update workflow: it discovers eligible newer releases for the
// declared dependencies (honoring the repository-owned release-age policy),
// previews the exact proposed pins without side effects, and with --apply
// installs the new pins through Pi, persists the lockfile and local pin
// state under the package lock, and rolls package pins plus both pin files
// back to their previous state when persistence fails. With --push the
// approved pin change is published through the managed-only push workflow.
export async function runUpdate({ repo, agentDir, declarations, apply, approve, push, message, previewWriter }: UpdateInput): Promise<UpdateOutput> {
  const manifest = (await readJson(path.join(repo, MANIFEST_FILE), 'manifest')) as PolicyManifest;
  const updates = (await discoverUpdates(manifest, declarations.lock)) as PackageUpdate[];
  const minimumReleaseAgeDays = manifest.policy?.minimumReleaseAgeDays ?? 7;
  const nextLock = lockWithUpdates(declarations.lock, updates) as LockFile;
  if (!apply) {
    return { apiVersion: 1, command: 'update', ok: true, exitCode: 0, repository: repo,
      minimumReleaseAgeDays, policySource: 'setup repository pi-sync.json', mode: 'preview', updates,
      proposedPins: nextLock.packages, note: 'No pins were changed and no package installation was performed.' };
  }
  if (!updates.length) {
    return { apiVersion: 1, command: 'update', ok: true, exitCode: 0, repository: repo,
      minimumReleaseAgeDays, policySource: 'setup repository pi-sync.json', mode: 'applied', updates: [], pins: declarations.lock.packages,
      note: 'No eligible newer releases were found; no installs or pin changes were performed.' };
  }
  let agentInfo = await fs.lstat(agentDir).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!agentInfo) { await fs.mkdir(agentDir, { recursive: true }); agentInfo = await fs.lstat(agentDir); }
  const releasePackageLock = await acquireLock(agentDir);
  try {
    const pins = await loadPackagePins(agentDir);
    await obtainFirstInstallApproval(nextLock, pins, approve);
    const lockPath = path.join(repo, LOCK_FILE);
    const packageStatePath = path.join(agentDir, STATE_DIR, 'packages.json');
    const lockBefore = await captureRawFile(lockPath);
    const packageStateBefore = await captureRawFile(packageStatePath);
    const installed = (await installPinnedPackages(nextLock, { approved: true, previousPins: pins.packages })) as InstalledPackage[];
    try {
      await writeLockfile(repo, nextLock);
      await savePackagePins(agentDir, nextLock);
    } catch (error) {
      const rollbackErrors = (await rollbackPinnedPackages(updates.map((update) => update.to), pins.packages))
        .map((item) => `${item.package}: ${item.error}`);
      try { await restoreRawFile(lockPath, lockBefore); }
      catch (restoreError) { rollbackErrors.push(`lockfile: ${restoreError.message}`); }
      try { await restoreRawFile(packageStatePath, packageStateBefore); }
      catch (restoreError) { rollbackErrors.push(`local package pin state: ${restoreError.message}`); }
      error.errorCode = 'UPDATE_TRANSACTION_FAILED';
      error.message = `Update package installation succeeded but pin persistence failed: ${error.message}; ${rollbackErrors.length
        ? `rollback was incomplete (${rollbackErrors.join('; ')})`
        : 'previous package pins, lockfile, and local pin state were restored'}`;
      error.details = { message: error.message, rollbackErrors };
      throw error;
    }
    const output: UpdateAppliedInstalledOutput = { apiVersion: 1, command: 'update', ok: true, exitCode: 0, repository: repo,
      minimumReleaseAgeDays, policySource: 'setup repository pi-sync.json', mode: 'applied', updates,
      pins: nextLock.packages, installed };
    if (push) output.push = await runPush({ repo, declarations: await validateRepository(repo), publish: true, message, previewWriter });
    output.dependencyModel = 'exact top-level pins; transitive dependency tree is controlled by Pi and is not locked by Pi Sync';
    return output;
  } finally { await releasePackageLock(); }
}