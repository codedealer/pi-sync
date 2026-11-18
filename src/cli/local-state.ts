import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { hasExactKeys, isRecord, readJson, type LockFile } from './manifest.js';
import {
  ensureTargetParents,
  readSettingsFile,
  safeSnapshot,
  type LocalState,
  type PlanResource,
  type PlanSetting,
  type Snapshot,
} from './reconciliation.js';

export const STATE_DIR = '.pi-sync';
const STATE_FILE = 'state.json';

interface StatePaths {
  directory: string;
  stateFile: string;
  lockFile: string;
  backups: string;
}

function statePaths(agentDir: string): StatePaths {
  const directory = path.join(agentDir, STATE_DIR);
  return { directory, stateFile: path.join(directory, STATE_FILE), lockFile: path.join(directory, 'apply.lock'), backups: path.join(directory, 'backups') };
}

async function validateStateDirectory(directory: string) {
  try {
    const info = await fs.lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Pi Sync state path must be a real directory: ${directory}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

// Reads the local `.pi-sync/state.json` baseline. A missing state file yields
// the empty baseline; a corrupt one fails the command.
export async function loadState(agentDir: string): Promise<LocalState> {
  const { directory, stateFile } = statePaths(agentDir);
  await validateStateDirectory(directory);
  const state = await readJson(stateFile, 'local Pi Sync state', { schemaVersion: 1, resources: {}, settings: {} });
  if (!hasExactKeys(state, ['schemaVersion', 'resources', 'settings']) || (state as LocalState).schemaVersion !== 1 || !isRecord((state as LocalState).resources) || !isRecord((state as LocalState).settings)) {
    throw new Error(`Local Pi Sync state is invalid: ${stateFile}`);
  }
  return state as LocalState;
}

// Persists the baseline with an exclusive temp file plus rename, keeping the
// previous body restorable if the write fails midway.
export async function writeState(agentDir: string, state: LocalState) {
  const { directory, stateFile } = statePaths(agentDir);
  await fs.mkdir(directory, { recursive: true });
  await validateStateDirectory(directory);
  const suffix = `${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  const temporary = `${stateFile}.${suffix}.tmp`;
  const previous = `${stateFile}.${suffix}.old`;
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  let hadState = false;
  try {
    hadState = await fs.lstat(stateFile).then(() => true).catch((error) => error.code === 'ENOENT' ? false : Promise.reject(error));
    if (hadState) await fs.rename(stateFile, previous);
    await fs.rename(temporary, stateFile);
    if (hadState) await fs.rm(previous, { force: true });
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    if (hadState) await fs.rename(previous, stateFile).catch(() => {});
    throw error;
  }
}

export type LockRelease = () => Promise<void>;

// Serializes apply-family operations with `.pi-sync/apply.lock`. While the
// lock is held, the returned release removes it only if this process still
// owns it; a live foreign lock makes the wait fail, and a stale one is
// reported rather than stolen.
export async function acquireLock(agentDir: string): Promise<LockRelease> {
  const { directory, lockFile } = statePaths(agentDir);
  await fs.mkdir(directory, { recursive: true });
  await validateStateDirectory(directory);
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const token = crypto.randomBytes(16).toString('hex');
    try {
      const handle = await fs.open(lockFile, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }));
      await handle.close();
      return async () => {
        try {
          const owner = JSON.parse(await fs.readFile(lockFile, 'utf8'));
          if (owner?.pid === process.pid && owner?.token === token) await fs.rm(lockFile);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(await fs.readFile(lockFile, 'utf8')); } catch { owner = null; }
      if (Number.isInteger(owner?.pid) && owner.pid > 0) {
        let alive = true;
        try { process.kill(owner.pid, 0); } catch (probeError) { if (probeError.code === 'ESRCH') alive = false; }
        if (!alive) {
          throw new Error('A stale Pi Sync apply lock was found; remove .pi-sync/apply.lock only after confirming no apply process is running');
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  throw new Error('Another Pi Sync apply operation holds the local lock; retry after it finishes');
}

export interface PackagePins {
  schemaVersion: 1;
  packages: Record<string, string>;
}

// Local package pin bookkeeping (`.pi-sync/packages.json`): which exact
// revisions Pi Sync has already installed for this agent directory.
export async function loadPackagePins(agentDir: string): Promise<PackagePins> {
  const file = path.join(agentDir, STATE_DIR, 'packages.json');
  const value = await readJson(file, 'local package pin state', { schemaVersion: 1, packages: {} });
  if (!hasExactKeys(value, ['schemaVersion', 'packages']) || (value as PackagePins).schemaVersion !== 1 || !isRecord((value as PackagePins).packages)) {
    throw new Error(`Local Pi Sync package state is invalid: ${file}`);
  }
  return value as PackagePins;
}

export async function writeLocalPackagePins(agentDir: string, packages: Record<string, string>) {
  const directory = path.join(agentDir, STATE_DIR);
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'packages.json');
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, packages }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function savePackagePins(agentDir: string, lock: LockFile) {
  const packages = Object.fromEntries(lock.packages.map((item) => [item.type === 'npm' ? `npm:${item.name}` : `github:${item.repository}`, item.type === 'npm' ? item.version : item.commit]));
  await writeLocalPackagePins(agentDir, packages);
}

// Copies a managed target that is about to be replaced or pruned into
// `.pi-sync/backups` under a unique timestamped directory.
export async function createBackup(agentDir: string, relative: string, source: string, isDirectory: boolean): Promise<string> {
  const { backups } = statePaths(agentDir);
  const stamp = `${new Date().toISOString().replaceAll(':', '-')}-${crypto.randomBytes(4).toString('hex')}`;
  const destination = path.join(backups, stamp, ...relative.split('/'));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  if (isDirectory) await fs.cp(source, destination, { recursive: true, errorOnExist: true, force: false });
  else await fs.copyFile(source, destination);
  return destination;
}

export type RawFileSnapshot = { exists: false } | { exists: true; content: Buffer; mode: number };

// Captures a file body (or its absence) so a transaction can restore it
// exactly, byte for byte, after a failed side effect.
export async function captureRawFile(file: string): Promise<RawFileSnapshot> {
  try {
    const info = await fs.lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Transaction state must be a regular file: ${file}`);
    return { exists: true, content: await fs.readFile(file), mode: info.mode & 0o777 };
  } catch (error) { if (error.code === 'ENOENT') return { exists: false }; throw error; }
}

export async function restoreRawFile(file: string, snapshot: RawFileSnapshot) {
  if (!snapshot.exists) { await fs.rm(file, { force: true }); return; }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.pi-sync-rollback-${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
  const previous = `${temporary}.old`;
  await fs.writeFile(temporary, snapshot.content, { flag: 'wx', mode: snapshot.mode });
  await fs.chmod(temporary, snapshot.mode);
  let moved = false;
  try {
    await fs.rename(file, previous);
    moved = true;
  } catch (error) { if (error.code !== 'ENOENT') { await fs.rm(temporary, { force: true }); throw error; } }
  try { await fs.rename(temporary, file); }
  catch (error) {
    if (moved) await fs.rename(previous, file).catch(() => {});
    await fs.rm(temporary, { force: true });
    throw error;
  }
  if (moved) await fs.rm(previous, { force: true });
}

// Settings snapshots are discriminated by `exists` so rollback can restore a
// file body without a non-null assertion: `text` is a string exactly when the
// file existed.
export interface ManagedFilesystemSnapshots {
  resourceSnapshots: { target: string; targetPath: string; kind: string; snapshot: Snapshot | null }[];
  settingsSnapshots: (
    | { target: string; file: string; exists: true; text: string; mode: number }
    | { target: string; file: string; exists: false; text: null; mode: number }
  )[];
}

// Snapshots every managed target an apply is about to change, so the
// transaction can roll back to exactly this state on failure.
export async function captureManagedFilesystem(agentDir: string, resources: PlanResource[], settings: PlanSetting[]): Promise<ManagedFilesystemSnapshots> {
  const resourceSnapshots: ManagedFilesystemSnapshots['resourceSnapshots'] = [];
  for (const resource of resources) resourceSnapshots.push({ target: resource.target, targetPath: resource.targetPath, kind: resource.kind, snapshot: await safeSnapshot(resource.targetPath) });
  const settingsSnapshots: ManagedFilesystemSnapshots['settingsSnapshots'] = [];
  for (const item of settings) {
    const file = item.targetPath;
    const current = await readSettingsFile(file);
    let mode = 0o600;
    if (current.exists) mode = (await fs.stat(file)).mode & 0o777;
    settingsSnapshots.push(current.exists
      ? { target: item.target, file, exists: true, text: current.text, mode }
      : { target: item.target, file, exists: false, text: null, mode });
  }
  return { resourceSnapshots, settingsSnapshots };
}

// Writes a captured tree (directories plus files with modes) into a fresh
// directory; used when materializing a replacement from a snapshot.
export async function materializeSnapshot(directory: string, snapshot: Snapshot) {
  await fs.mkdir(directory, { recursive: true });
  for (const relative of snapshot.directories!) await fs.mkdir(path.join(directory, ...relative.split('/')), { recursive: true });
  for (const [relative, file] of Object.entries(snapshot.files!)) {
    const destination = path.join(directory, ...relative.split('/'));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, Buffer.from(file.content, 'base64'), { mode: file.mode });
    await fs.chmod(destination, file.mode);
  }
}

// Swaps a prepared file into place with an exclusive rename pair so a crash
// never leaves a half-written target. Shared by forward writes and rollback.
export async function atomicSwapFile(target: string, prepared: string, relative: string) {
  const previous = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.old`);
  let originalMoved = false;
  let replacementInstalled = false;
  try {
    const existed = await fs.lstat(target).then(() => true).catch((error) => (error.code === 'ENOENT' ? false : Promise.reject(error)));
    if (existed) {
      await fs.rename(target, previous);
      originalMoved = true;
    }
    await fs.rename(prepared, target);
    replacementInstalled = true;
    if (originalMoved) await fs.rm(previous, { force: true });
  } catch (error) {
    if (replacementInstalled) await fs.rm(target, { force: true }).catch(() => {});
    if (originalMoved) await fs.rename(previous, target).catch(() => {});
    await fs.rm(prepared, { force: true }).catch(() => {});
    throw new Error(`Could not atomically update ${relative}: ${error.message}`);
  }
}

// Restores one captured managed resource: a null snapshot removes the target,
// a file snapshot goes through the atomic file swap, and a directory snapshot
// is staged in a temp directory and renamed over the target.
async function restoreResourceSnapshot(agentDir: string, target: string, targetPath: string, kind: string, snapshot: Snapshot | null) {
  await ensureTargetParents(agentDir, target);
  if (snapshot === null) {
    await fs.rm(targetPath, { recursive: true, force: true });
    return;
  }
  if (snapshot.invalidType) throw new Error(`Cannot restore unsupported resource snapshot: ${target}`);
  if (kind === 'file') {
    const name = Object.keys(snapshot.files!).find((file) => snapshot.files![file] !== undefined);
    const file = name ? snapshot.files![name] : null;
    if (!file) throw new Error(`Cannot restore empty file resource snapshot: ${target}`);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const prepared = `${targetPath}.pi-sync-rollback-${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
    await fs.writeFile(prepared, Buffer.from(file.content, 'base64'), { flag: 'wx', mode: file.mode });
    await fs.chmod(prepared, file.mode);
    await atomicSwapFile(targetPath, prepared, target);
    return;
  }
  const temporary = `${targetPath}.pi-sync-rollback-${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
  const previous = `${temporary}.old`;
  await fs.mkdir(temporary, { recursive: false });
  try {
    for (const directory of snapshot.directories!) await fs.mkdir(path.join(temporary, ...directory.split('/')), { recursive: true });
    for (const [relative, file] of Object.entries(snapshot.files!)) {
      const destination = path.join(temporary, ...relative.split('/'));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, Buffer.from(file.content, 'base64'), { mode: file.mode });
      await fs.chmod(destination, file.mode);
    }
    let moved = false;
    try {
      await fs.rename(targetPath, previous);
      moved = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await fs.rename(temporary, targetPath); }
    catch (error) {
      if (moved) await fs.rename(previous, targetPath).catch(() => {});
      throw error;
    }
    if (moved) await fs.rm(previous, { recursive: true, force: true });
  } finally { await fs.rm(temporary, { recursive: true, force: true }).catch(() => {}); }
}

// Rolls a failed transaction back by restoring every captured target in
// reverse order, reporting (instead of throwing away) individual failures so
// the command error can carry the incomplete-rollback details.
export async function restoreManagedFilesystem(agentDir: string, snapshots: ManagedFilesystemSnapshots): Promise<string[]> {
  const errors: string[] = [];
  for (const item of [...snapshots.resourceSnapshots].reverse()) {
    try { await restoreResourceSnapshot(agentDir, item.target, item.targetPath, item.kind ?? 'directory', item.snapshot); }
    catch (error) { errors.push(`${item.target}: ${error.message}`); }
  }
  for (const item of [...snapshots.settingsSnapshots].reverse()) {
    try {
      await ensureTargetParents(agentDir, item.target);
      await restoreRawFile(item.file, item.exists ? { exists: true, content: Buffer.from(item.text), mode: item.mode } : { exists: false });
    } catch (error) { errors.push(`${item.target}: ${error.message}`); }
  }
  return errors;
}