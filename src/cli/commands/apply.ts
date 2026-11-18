import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { packageIdentity, packageRevision, type RepositoryDeclarations } from '../manifest.js';
import {
  buildPlan,
  readSettingsFile,
  reportBlocks,
  safeSnapshot,
  sameValue,
  setManagedField,
  snapshotPath,
  type PlanOutputAction,
  type PlanResource,
  type PlanSetting,
  type Snapshot,
  type StaleReportItem,
} from '../reconciliation.js';
import {
  STATE_DIR,
  acquireLock,
  atomicSwapFile,
  captureManagedFilesystem,
  captureRawFile,
  createBackup,
  loadPackagePins,
  loadState,
  materializeSnapshot,
  restoreManagedFilesystem,
  restoreRawFile,
  savePackagePins,
  writeState,
  type PackagePins,
} from '../local-state.js';
import { installPinnedPackages, obtainFirstInstallApproval, rollbackPinnedPackages } from '../../packages.js';

// Matches the entry point's operation-error exit status: apply reports it in
// the JSON output and the entry point mirrors it onto process.exitCode.
const OPERATION_ERROR = 1;

export interface ApplyInput {
  repo: string;
  agentDir: string;
  declarations: RepositoryDeclarations;
  approve: boolean;
}

export interface ApplyOutput {
  apiVersion: 1;
  command: 'apply';
  ok: boolean;
  exitCode: number;
  repository: string;
  agentDirectory: string;
  actions: PlanOutputAction[];
  conflicts: PlanOutputAction[];
  staleResources: StaleReportItem[];
  // One entry per pinned package: initially the planned pin install, and
  // merged with the install result (action becomes `installed`) once the
  // package step completes.
  packages: ApplyPackageEntry[];
}

export interface ApplyPackageEntry {
  package: string;
  pin: string;
  action: 'pinned-install' | 'installed';
}

// Replaces a managed directory target with the desired snapshot. The current
// target is re-snapshotted against the plan's expectation right before the
// swap, so a concurrent local change aborts instead of being overwritten.
async function replaceDirectory(target: string, desiredSnapshot: Snapshot, expectedSnapshot: Snapshot | null, relative: string) {
  const parent = path.dirname(target);
  await fs.mkdir(parent, { recursive: true });
  const prepared = path.join(parent, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.new`);
  const previous = path.join(parent, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.old`);
  await materializeSnapshot(prepared, desiredSnapshot);
  const observed = await safeSnapshot(target);
  if (!sameValue(observed, expectedSnapshot)) {
    await fs.rm(prepared, { recursive: true, force: true });
    throw new Error(`Managed target changed during apply; refusing to overwrite: ${relative}`);
  }
  let originalMoved = false;
  let replacementInstalled = false;
  try {
    if (observed !== null) {
      await fs.rename(target, previous);
      originalMoved = true;
    }
    await fs.rename(prepared, target);
    replacementInstalled = true;
    if (originalMoved) await fs.rm(previous, { recursive: true, force: true });
  } catch (error) {
    if (replacementInstalled) await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    if (originalMoved) await fs.rename(previous, target).catch(() => {});
    await fs.rm(prepared, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

// Applies a directory-kind resource: backs up the previous target, verifies
// the setup source has not drifted, computes the desired tree, and swaps it
// in atomically.
async function applyDirectory(agentDir: string, resource: PlanResource) {
  const current = await safeSnapshot(resource.targetPath);
  if (!sameValue(current, resource.localSnapshot)) throw new Error(`Managed resource changed during apply; refusing to overwrite: ${resource.target}`);
  if (current !== null) await createBackup(agentDir, resource.target, resource.targetPath, true);
  const sourceNow = await snapshotPath(resource.sourcePath);
  if (!sameValue(sourceNow, resource.snapshot)) throw new Error(`Setup resource changed during apply; retry: ${resource.target}`);
  const desired: Snapshot = structuredClone(current ?? { directories: [], files: {} });
  if (resource.action === 'install') desired.files = structuredClone(resource.snapshot.files);
  for (const file of resource.files ?? []) {
    if (file.action === 'update') desired.files![file.path] = file.repository!;
    if (file.action === 'delete') delete desired.files![file.path];
  }
  const directories = new Set([...(desired.directories ?? []), ...resource.snapshot.directories!]);
  desired.directories = [...directories].sort();
  await replaceDirectory(resource.targetPath, desired, current, resource.target);
}

async function replaceFileResource(target: string, desiredFile: { content: string; mode: number }, expectedSnapshot: Snapshot | null, relative: string) {
  const parent = path.dirname(target);
  await fs.mkdir(parent, { recursive: true });
  const prepared = path.join(parent, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.new`);
  await fs.writeFile(prepared, Buffer.from(desiredFile.content, 'base64'), { flag: 'wx', mode: desiredFile.mode });
  await fs.chmod(prepared, desiredFile.mode);
  const current = await safeSnapshot(target);
  if (!sameValue(current, expectedSnapshot)) {
    await fs.rm(prepared, { force: true });
    throw new Error(`Managed resource changed during apply; refusing to overwrite: ${relative}`);
  }
  await atomicSwapFile(target, prepared, relative);
}

// Applies a file-kind resource. A null desired file removes the target
// (after backing it up); otherwise the file is swapped in atomically.
async function applyFileResource(agentDir: string, resource: PlanResource) {
  const name = path.posix.basename(resource.target);
  const desiredFile = resource.action === 'install'
    ? resource.snapshot.files![name]
    : (resource.files.find((file) => file.action === 'update') ?? { repository: null }).repository;
  const current = await safeSnapshot(resource.targetPath);
  if (!sameValue(current, resource.localSnapshot)) throw new Error(`Managed resource changed during apply; refusing to overwrite: ${resource.target}`);
  if (current !== null) await createBackup(agentDir, resource.target, resource.targetPath, false);
  const sourceNow = await snapshotPath(resource.sourcePath);
  if (!sameValue(sourceNow, resource.snapshot)) throw new Error(`Setup resource changed during apply; retry: ${resource.target}`);
  if (desiredFile === undefined || desiredFile === null) {
    if (current !== null) await fs.rm(resource.targetPath);
    return;
  }
  await replaceFileResource(resource.targetPath, desiredFile, current, resource.target);
}

async function replaceFile(target: string, content: string, expectedText: string | null, relative: string) {
  const parent = path.dirname(target);
  await fs.mkdir(parent, { recursive: true });
  const prepared = path.join(parent, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.new`);
  const previous = path.join(parent, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.old`);
  await fs.writeFile(prepared, content, { flag: 'wx', mode: 0o600 });
  const current = await readSettingsFile(target);
  if (current.text !== expectedText) {
    await fs.rm(prepared, { force: true });
    throw new Error(`Settings file changed during apply; refusing to overwrite: ${relative}`);
  }
  const existed = current.exists;
  let originalMoved = false;
  let replacementInstalled = false;
  try {
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

async function applySettings(agentDir: string, settings: PlanSetting) {
  const current = await readSettingsFile(settings.targetPath);
  if (current.text !== settings.fileText) throw new Error(`Settings file changed during apply; refusing to overwrite: ${settings.target}`);
  const next = structuredClone(settings.value);
  for (const field of settings.fields) {
    if (field.action === 'install' || field.action === 'update') setManagedField(next, field.segments, field.value);
  }
  const content = `${JSON.stringify(next, null, 2)}\n`;
  if (settings.fileExists) await createBackup(agentDir, `settings/${settings.target}`, settings.targetPath, false);
  await replaceFile(settings.targetPath, content, current.text, settings.target);
}

// The apply workflow: it reconciles the setup repository against the local
// installation, applies resource and settings actions, installs pinned
// packages, and re-baselines the local state — all under the apply lock and
// with full rollback of managed content, package pins, and pin state when
// any step fails. Stale managed resources are reported but never touched;
// only `prune --confirm` removes them.
export async function runApply({ repo, agentDir, declarations, approve }: ApplyInput): Promise<ApplyOutput> {
  let agentInfo = await fs.lstat(agentDir).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!agentInfo) {
    await fs.mkdir(agentDir, { recursive: true });
    agentInfo = await fs.lstat(agentDir);
    if (agentInfo.isSymbolicLink() || !agentInfo.isDirectory()) throw new Error(`Pi agent directory must be a real directory: ${agentDir}`);
  }
  // Deliberately read the state before taking the lock: this mirrors the
  // pre-refactor ordering, where a corrupt state file fails the command
  // before the apply lock is ever created. Do not "clean up" this read.
  const state = await loadState(agentDir);
  const releaseLock = await acquireLock(agentDir);
  try {
    const currentState = await loadState(agentDir);
    let packagePins: PackagePins | null = null;
    if (declarations.lock.packages.length > 0) {
      packagePins = await loadPackagePins(agentDir);
      await obtainFirstInstallApproval(declarations.lock, packagePins, approve);
    }
    const plan = await buildPlan(repo, agentDir, declarations, currentState);
    const { actions, conflicts, staleResources } = reportBlocks(plan);
    const output: ApplyOutput = { apiVersion: 1, command: 'apply', ok: conflicts.length === 0, exitCode: conflicts.length ? OPERATION_ERROR : 0,
      repository: repo,
      agentDirectory: agentDir, actions, conflicts, staleResources,
      packages: declarations.lock.packages.map((item) => ({ package: packageIdentity(item), pin: packageRevision(item), action: 'pinned-install' })) };

    await fs.mkdir(agentDir, { recursive: true });
    const checkedAgent = await fs.lstat(agentDir);
    if (checkedAgent.isSymbolicLink() || !checkedAgent.isDirectory()) throw new Error(`Pi agent directory must be a real directory: ${agentDir}`);
    const mutableState = structuredClone(currentState);
    const changingResources = plan.resources.filter((resource) => resource.action !== 'collision' && !resource.kindMismatch &&
      (resource.action === 'install' || resource.files.some((file) => file.action === 'update' || file.action === 'delete')));
    const changingSettings = plan.settings.filter((item) => item.fields.some((field) => field.action === 'install' || field.action === 'update'));
    const snapshots = await captureManagedFilesystem(agentDir, changingResources, changingSettings);
    const packageStatePath = path.join(agentDir, STATE_DIR, 'packages.json');
    const packageStateBefore = await captureRawFile(packageStatePath);
    let packageInstallationCompleted = false;
    try {
      for (const resource of plan.resources) {
        // A kind-mismatch conflict means the tracked target is no longer the managed kind;
        // nothing may be applied or re-baselined until the user resolves it manually.
        if (resource.action === 'collision' || resource.kindMismatch) continue;
        if (resource.action === 'install' || resource.files.some((file) => file.action === 'update' || file.action === 'delete')) {
          if (resource.kind === 'file') await applyFileResource(agentDir, resource);
          else await applyDirectory(agentDir, resource);
        }
        const previous = mutableState.resources[resource.target];
        if (!previous) mutableState.resources[resource.target] = structuredClone({ kind: resource.kind, ...resource.snapshot });
        else {
          const baseline = structuredClone(previous);
          baseline.kind = resource.kind;
          baseline.files ??= {};
          baseline.directories ??= [];
          for (const file of resource.files) {
            if (file.action === 'conflict') continue;
            if (file.repository === null) delete baseline.files[file.path];
            else baseline.files[file.path] = file.repository;
          }
          baseline.directories = resource.snapshot.directories;
          mutableState.resources[resource.target] = baseline;
        }
      }
      for (const item of plan.settings) {
        if (item.fields.some((field) => field.action === 'install' || field.action === 'update')) await applySettings(agentDir, item);
        mutableState.settings[item.target] ??= {};
        for (const field of item.fields) {
          if (!['conflict', 'collision'].includes(field.action)) mutableState.settings[item.target][field.pointer] = { exists: true, value: field.value };
        }
      }
      if (declarations.lock.packages.length > 0 && conflicts.length === 0) {
        // Each packages entry keeps its package/pin/action fields and merges
        // in that package's install result; no separate packageInstalls
        // array is emitted.
        const installs = await installPinnedPackages(declarations.lock, { approved: true, previousPins: packagePins?.packages ?? {} });
        output.packages = output.packages.map((entry) => {
          const install = (installs.find((item: any) => item.package === entry.package) ?? {}) as Partial<ApplyPackageEntry>;
          return { ...entry, ...install };
        });
        packageInstallationCompleted = true;
        await savePackagePins(agentDir, declarations.lock);
      }
      if (plan.resources.some((resource) => resource.action !== 'collision') || plan.settings.some((item) => item.fields.some((field) => !['conflict', 'collision'].includes(field.action)))) {
        await writeState(agentDir, mutableState);
      }
    } catch (error) {
      const rollbackErrors = await restoreManagedFilesystem(agentDir, snapshots);
      if (packageInstallationCompleted) rollbackErrors.push(...(await rollbackPinnedPackages(declarations.lock.packages, packagePins?.packages ?? {})).map((item) => `${item.package}: ${item.error}`));
      try { await restoreRawFile(packageStatePath, packageStateBefore); }
      catch (restoreError) { rollbackErrors.push(`package pin state: ${restoreError.message}`); }
      if (rollbackErrors.length) {
        error.message += `; apply rollback was incomplete (${rollbackErrors.join('; ')})`;
        error.details = { ...(error.details ?? { message: error.message }), rollbackErrors };
      }
      throw error;
    }
    output.actions = output.actions.map((action) => {
      if (action.type === 'setting') {
        return { ...action,
          action: ['install', 'update'].includes(action.action) ? (action.action === 'install' ? 'installed' : 'updated') : action.action,
          fields: action.fields!.map((field) => ['install', 'update'].includes(field.action)
            ? { ...field, action: field.action === 'install' ? 'installed' : 'updated' }
            : field),
        };
      }
      return ['install', 'update'].includes(action.action) ? { ...action, action: action.action === 'install' ? 'installed' : 'updated' } : action;
    });
    return output;
  } finally { await releaseLock(); }
}