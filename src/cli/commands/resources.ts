import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  LOCK_FILE,
  MANIFEST_FILE,
  RESOURCE_RULES,
  packageIdentity,
  packageSpec,
  pathsOverlap,
  resolveInside,
  validateRelativePath,
  validateRepository,
  validateResourceSource,
  validateSourceFile,
  validateSourceTree,
  type LockPackage,
  type RepositoryDeclarations,
} from '../manifest.js';
import { runCommand } from '../process.js';
import { buildPlan, sameValue, safeSnapshot, snapshotPath, type PlanStale } from '../reconciliation.js';
import { STATE_DIR, acquireLock, createBackup, loadPackagePins, loadState, writeLocalPackagePins, writeState } from '../local-state.js';
import {
  RESOURCE_ADD_RULES,
  ensureRealDirectory,
  findLikelySecrets,
  normalizeResourceTarget,
  restoreFileAtomic,
  unregisteredCandidates,
  writeJsonFileAtomic,
  type ResourceCandidate,
  type SecretFinding,
} from '../resource-operations.js';


// Match the entry point's validation and operation exit statuses: the
// structured results report them and the entry point mirrors them onto
// process.exitCode.
const VALIDATION_ERROR = 2;
const OPERATION_ERROR = 1;

interface ResourceError extends Error {
  errorCode?: string;
  details?: unknown;
}

type Dependency = { type: 'npm'; name: string } | { type: 'github'; repository: string };

export interface AddedDependencyResult {
  apiVersion: 2;
  command: 'add';
  ok: true;
  exitCode: 0;
  type: 'dependency';
  dependency: Dependency;
  action: 'added';
  mode: 'applied' | 'preview';
  next: string;
  note?: string;
}

export interface AddedResourceResult {
  apiVersion: 2;
  command: 'add';
  ok: true;
  exitCode: 0;
  type: string;
  source: string;
  target: string;
  repositorySource: string;
  action: 'added' | 'declared' | 'already-added';
  mode: 'applied' | 'preview';
  reviewRequired: SecretFinding[];
  note?: string;
}

export interface AddSecretReviewResult {
  apiVersion: 2;
  command: 'add';
  ok: false;
  errorCode: 'SECRET_REVIEW_REQUIRED';
  exitCode: number;
  error: string;
  reviewRequired: SecretFinding[];
  details: { reviewRequired: SecretFinding[] };
}


export interface AddResourceListResult {
  apiVersion: 2;
  command: 'add';
  ok: true;
  exitCode: 0;
  unregistered: ResourceCandidate[];
}

export interface AddResourceBatchResult {
  apiVersion: 2;
  command: 'add';
  ok: true;
  exitCode: 0;
  action: 'registered' | 'up-to-date';
  registered: ResourceCandidate[];
}

export type AddOutput = AddedDependencyResult | AddedResourceResult | AddSecretReviewResult | AddResourceListResult | AddResourceBatchResult;


// The local block reports what happened to the local installation:
// `removed` (backed up under .pi-sync/backups first), `preserved` (a
// diverged, untracked, or overlapping local copy that removal never touches),
// or `unchanged` (no local copy, or --keep-local). `would-remove` is the
// preview-mode counterpart of `removed`.
export interface RemovedResourceResult {
  apiVersion: 2;
  command: 'remove';
  ok: true;
  exitCode: 0;
  repository: string;
  mode: 'applied' | 'preview';
  removed: { type: string; source: string; target: string };
  local: { target: string; action: 'removed' | 'would-remove' | 'preserved' | 'unchanged'; backup?: string; reason?: string };
}

export interface RemovedDependencyResult {
  apiVersion: 2;
  command: 'remove';
  ok: true;
  exitCode: 0;
  repository: string;
  mode: 'applied' | 'preview';
  removed: { dependency: Dependency; pin: LockPackage };
  localInstallation: 'unchanged' | 'uninstalled' | 'would-uninstall';
  note: string;
  uninstalled?: { package: string; spec: string };
}

// Field order mirrors the emitted JSON: the failure metadata is appended
// after the success-shape fields (repository/removed/localInstallation/note),
// matching the pre-refactor response exactly.
export interface RemoveUninstallFailedResult {
  apiVersion: 2;
  command: 'remove';
  ok: false;
  exitCode: number;
  repository: string;
  removed: { dependency: Dependency; pin: LockPackage };
  localInstallation: 'unchanged';
  note: string;
  errorCode: 'UNINSTALL_FAILED';
  error: string;
  details: { message: string; package: string; spec: string };
  uninstall: { package: string; spec: string; status: 'failed'; error: string };
}

export type RemoveOutput = RemovedResourceResult | RemovedDependencyResult | RemoveUninstallFailedResult | RemoveStaleOutput;

async function addDependency(repo: string, source: string, dryRun: boolean): Promise<AddedDependencyResult> {
  const match = /^(npm):(.+)$/.exec(source) ?? /^(github):(.+)$/.exec(source);
  if (!match) throw new Error('Dependency source must be npm:PACKAGE or github:OWNER/REPOSITORY; Pi Sync resolves and writes the pin through update');
  const dependency: Dependency = match[1] === 'npm' ? { type: 'npm', name: match[2] } : { type: 'github', repository: match[2] };
  if ((dependency.type === 'npm' && !/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(dependency.name)) ||
      (dependency.type === 'github' && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(dependency.repository))) {
    throw new Error('Dependency source has an invalid npm package name or GitHub owner/repository');
  }
  const manifestPath = path.join(repo, MANIFEST_FILE);
  const manifestText = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  const identity = packageIdentity(dependency);
  if (manifest.dependencies.some((item: any) => packageIdentity(item) === identity)) {
    const error: ResourceError = new Error(`Dependency is already declared: ${identity}`);
    error.errorCode = 'DEPENDENCY_COLLISION';
    throw error;
  }
  const result: AddedDependencyResult = { apiVersion: 2, command: 'add', ok: true, exitCode: 0, type: 'dependency', dependency, action: 'added', mode: dryRun ? 'preview' : 'applied',
    next: dryRun ? 'Run bare pi-sync add --source to declare the dependency, then pi-sync update --dry-run' : 'Run pi-sync update to preview an age-eligible exact pin',
    ...(dryRun ? { note: 'Dry run: no dependency was declared; nothing was changed.' } : {}) };
  if (dryRun) return result;
  const next = { ...manifest, dependencies: [...manifest.dependencies, dependency] };
  const temporary = `${manifestPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  // Deliberately no `mode` here: the pre-refactor dependency add wrote its
  // temp file without preserving the manifest's mode bits (unlike
  // writeJsonFileAtomic and the resource add path). Preserved exactly.
  await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' });
  try {
    if (await fs.readFile(manifestPath, 'utf8') !== manifestText) throw new Error('Manifest changed during add; retry without overwriting concurrent changes');
    await fs.rename(temporary, manifestPath);
  } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
  return result;
}

async function addResource(repo: string, agentDir: string, type: string, selector: string, dryRun: boolean): Promise<AddedResourceResult | AddSecretReviewResult> {
  const rule = RESOURCE_ADD_RULES[type];
  const relative = normalizeResourceTarget(type, selector, agentDir);
  const targetPath = resolveInside(agentDir, relative, '--target');
  const managedSource = `${rule.sourceRoot}/${path.posix.relative(rule.localRoot, relative)}`;
  const repositoryPath = resolveInside(repo, managedSource, 'repository resource');
  const localInfo = await fs.lstat(targetPath).catch((error: any) => error.code === 'ENOENT' ? null : Promise.reject(error));
  const repositoryInfo = await fs.lstat(repositoryPath).catch((error: any) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!localInfo && !repositoryInfo) {
    const declarations = await validateRepository(repo);
    if (declarations.resources.some((item) => pathsOverlap(item.target, relative) || pathsOverlap(item.source, managedSource))) {
      const error: ResourceError = new Error(`Resource collision: ${relative} or ${managedSource} is already declared`);
      error.errorCode = 'RESOURCE_COLLISION';
      error.details = { type, source: relative, target: relative, repositorySource: managedSource };
      throw error;
    }
    throw new Error(`Resource does not exist in the setup repository or local installation: ${managedSource} and ${relative}`);
  }

  const validateShape = async (info: any, file: string, source: string, label: string, repository: boolean) => {
    if (info?.isSymbolicLink()) throw new Error(`Symbolic links are not supported for ${label}: ${source}`);
    if (!info) throw new Error(`${label} does not exist: ${source}`);
    const isFile = info.isFile();
    if (rule.shape === 'directory' && !info.isDirectory()) throw new Error(`${rule.label} ${label} must be a directory: ${source}`);
    if (rule.shape === 'file' && !isFile) throw new Error(`${rule.label} ${label} must be a regular file: ${source}`);
    if (rule.shape === 'any' && !isFile && !info.isDirectory()) throw new Error(`${rule.label} ${label} must be a file or directory: ${source}`);
    if (repository) await validateResourceSource(repo, file, source, rule);
    else if (isFile) await validateSourceFile(agentDir, relative);
    else await validateSourceTree(agentDir, file, relative);
  };
  if (localInfo) await validateShape(localInfo, targetPath, relative, 'target', false);
  if (repositoryInfo) await validateShape(repositoryInfo, repositoryPath, managedSource, 'repository source', true);

  if (localInfo && repositoryInfo) {
    const [localSnapshot, repositorySnapshot] = await Promise.all([snapshotPath(targetPath), snapshotPath(repositoryPath)]);
    if (!sameValue(localSnapshot, repositorySnapshot)) {
      const error: ResourceError = new Error(`Resource collision: local target ${targetPath} differs from setup repository source ${repositoryPath}`);
      error.errorCode = 'RESOURCE_COLLISION';
      error.details = { localPath: targetPath, repositoryPath };
      throw error;
    }
  }
  const declarations = await validateRepository(repo);
  const target = relative;
  if (declarations.resources.some((item) => item.source === managedSource && item.target === target)) {
    return { apiVersion: 2, command: 'add', ok: true, exitCode: 0, type, source: relative, target, repositorySource: managedSource, action: 'already-added', mode: dryRun ? 'preview' : 'applied', reviewRequired: [], ...(dryRun ? { note: 'Dry run: the resource is already declared; nothing was changed.' } : {}) };
  }

  const sourceToReview = repositoryInfo ? repositoryPath : targetPath;
  const sourceLabel = repositoryInfo ? managedSource : relative;
  const findings = await findLikelySecrets(sourceToReview, sourceLabel);
  if (findings.length) return {
    apiVersion: 2, command: 'add', ok: false, errorCode: 'SECRET_REVIEW_REQUIRED', exitCode: VALIDATION_ERROR,
    error: 'Import was not performed; review suspected secret material and remove it before retrying', reviewRequired: findings,
    details: { reviewRequired: findings },
  };

  if (declarations.resources.some((item) => pathsOverlap(item.target, target) || pathsOverlap(item.source, managedSource))) {
    const error: ResourceError = new Error(`Resource collision: ${target} or ${managedSource} is already declared`);
    error.errorCode = 'RESOURCE_COLLISION';
    error.details = { type, source: relative, target, repositorySource: managedSource };
    throw error;
  }

  const action = repositoryInfo ? 'declared' : 'added';
  const result: AddedResourceResult = {
    apiVersion: 2, command: 'add', ok: true, exitCode: 0, type, source: relative, target, repositorySource: managedSource,
    action,
    mode: dryRun ? 'preview' : 'applied',
    reviewRequired: [],
    ...(dryRun
      ? { note: action === 'declared'
          ? (localInfo && repositoryInfo
              ? 'Dry run: the setup repository and local content match; the resource would be declared without copying; nothing was changed.'
              : 'Dry run: the setup repository resource would be declared in the manifest; nothing was changed.')
          : 'Dry run: the local resource would be copied into the setup repository and declared in the manifest; nothing was changed.' }
      : localInfo && repositoryInfo ? { note: 'Setup repository and local content match; declared without copying.' } : {}),
  };
  if (dryRun) return result;

  const manifestPath = path.join(repo, MANIFEST_FILE);
  const manifestText = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  if (repositoryInfo) {
    await writeJsonFileAtomic(manifestPath, { ...manifest, resources: [...manifest.resources, { type, source: managedSource, target }] }, manifestText, 'add');
    return result;
  }

  const parent = path.posix.dirname(managedSource);
  const parentExists = await ensureRealDirectory(repo, parent, true);
  if (!parentExists) throw new Error(`Could not create ${parent} in the setup repository`);
  const before = await snapshotPath(targetPath);
  const temporary = `${manifestPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let createdDestination = false;
  try {
    if (localInfo!.isFile()) {
      await fs.mkdir(path.dirname(repositoryPath), { recursive: true });
      await fs.copyFile(targetPath, repositoryPath);
    } else {
      await fs.mkdir(repositoryPath);
      createdDestination = true;
      for (const entry of await fs.readdir(targetPath)) {
        await fs.cp(path.join(targetPath, entry), path.join(repositoryPath, entry), { recursive: true, errorOnExist: true, force: false });
      }
    }
    const after = await snapshotPath(targetPath);
    const imported = await snapshotPath(repositoryPath);
    if (!sameValue(before, after) || !sameValue(before, imported)) throw new Error(`Selected ${rule.label.toLowerCase()} changed during import; retry after it is stable`);
    const nextManifest = { ...manifest, resources: [...manifest.resources, { type, source: managedSource, target }] };
    const manifestInfo = await fs.stat(manifestPath);
    await fs.writeFile(temporary, `${JSON.stringify(nextManifest, null, 2)}\n`, { flag: 'wx', mode: manifestInfo.mode & 0o777 });
    const latestManifestText = await fs.readFile(manifestPath, 'utf8');
    if (latestManifestText !== manifestText) throw new Error('Manifest changed during add; retry without overwriting concurrent changes');
    await fs.rename(temporary, manifestPath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    if (createdDestination) await fs.rm(repositoryPath, { recursive: true, force: true }).catch(() => {});
    if (localInfo!.isFile()) await fs.rm(repositoryPath, { force: true }).catch(() => {});
    throw error;
  }
  return result;
}

// Discovery and batch registration use the repository's type roots as their
// candidate set. --list is read-only; --all validates, reviews, and collision-
// checks the complete set before performing one atomic manifest write.
async function listAddCandidates(repo: string): Promise<AddResourceListResult> {
  const resources = (await validateRepository(repo)).resources;
  return { apiVersion: 2, command: 'add', ok: true, exitCode: 0, unregistered: await unregisteredCandidates(repo, resources) };
}

function resourceCollision(candidate: ResourceCandidate, other: ResourceCandidate): ResourceError {
  const error: ResourceError = new Error(`Resource collision: ${candidate.target} or ${candidate.source} overlaps ${other.target} (${other.source})`);
  error.errorCode = 'RESOURCE_COLLISION';
  error.details = { source: candidate.source, target: candidate.target, conflictingSource: other.source, conflictingTarget: other.target };
  return error;
}

async function addAllResources(repo: string): Promise<AddResourceBatchResult | AddSecretReviewResult> {
  const declarations = await validateRepository(repo);
  const candidates = await unregisteredCandidates(repo, declarations.resources);
  if (candidates.length === 0) return { apiVersion: 2, command: 'add', ok: true, exitCode: 0, action: 'up-to-date', registered: [] };
  for (const candidate of candidates) {
    const rule = RESOURCE_ADD_RULES[candidate.type];
    const sourcePath = resolveInside(repo, candidate.source, '--source');
    await validateResourceSource(repo, sourcePath, candidate.source, rule);
  }
  const findings: SecretFinding[] = [];
  for (const candidate of candidates) {
    const sourcePath = resolveInside(repo, candidate.source, '--source');
    findings.push(...(await findLikelySecrets(sourcePath, candidate.source)));
  }
  if (findings.length) return {
    apiVersion: 2, command: 'add', ok: false, errorCode: 'SECRET_REVIEW_REQUIRED', exitCode: VALIDATION_ERROR,
    error: 'Registration was not performed; review suspected secret material and remove it before retrying',
    reviewRequired: findings, details: { reviewRequired: findings },
  };
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const conflict = [...declarations.resources, ...candidates.slice(i + 1)]
      .find((other) => pathsOverlap(other.target, candidate.target) || pathsOverlap(other.source, candidate.source));
    if (conflict) throw resourceCollision(candidate, conflict);
  }
  const manifestPath = path.join(repo, MANIFEST_FILE);
  const manifestText = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  await writeJsonFileAtomic(manifestPath, { ...manifest, resources: [...manifest.resources, ...candidates] }, manifestText, 'add');
  return { apiVersion: 2, command: 'add', ok: true, exitCode: 0, action: 'registered', registered: candidates };
}

// Full resource removal: manifest entry + repository content + local
// installation. The local side keeps the stale-batch safety, evaluated
// through the same plan the `remove --stale` workflow uses, against the
// manifest with this target taken out: a local copy that still exactly
// matches its saved last-applied baseline is backed up under
// .pi-sync/backups and removed; a diverged, untracked, or overlapping local
// copy is preserved and reported, never overwritten or destroyed.
// `--keep-local` limits the removal to the manifest and repository content,
// leaving the local copy installed (and stale-reported) as before.
// `--dry-run` previews the removal set without mutating.
async function removeResource(repo: string, agentDir: string, type: string, target: string, keepLocal: boolean, dryRun: boolean): Promise<RemovedResourceResult> {
  const rule = RESOURCE_RULES[type];
  if (!rule) throw new Error(`Unsupported resource type: ${type}`);
  validateRelativePath(target, '--target');
  const declarations = await validateRepository(repo);
  const entry = declarations.resources.find((item) => item.target === target);
  if (!entry) {
    const error: ResourceError = new Error(`No managed resource with target ${target} is declared in the manifest; remove only entries declared in the manifest`);
    error.errorCode = 'REMOVE_TARGET_NOT_FOUND';
    throw error;
  }
  if (entry.type !== type) {
    const error: ResourceError = new Error(`Target ${target} is managed as ${entry.type}, not ${type}; use a target under the matching resource root`);
    error.errorCode = 'REMOVE_TYPE_MISMATCH';
    throw error;
  }
  const targetPath = resolveInside(agentDir, target, '--target');
  const declarationsAfter: RepositoryDeclarations = { ...declarations, resources: declarations.resources.filter((item) => item.target !== target) };

  const describeLocal = async (staleItem: PlanStale | undefined): Promise<RemovedResourceResult['local']> => {
    if (keepLocal) return { target, action: 'unchanged', reason: 'kept by --keep-local; status reports it as stale' };
    if (staleItem === undefined) {
      return (await localExists(targetPath))
        ? { target, action: 'preserved', reason: 'local copy is not tracked by Pi Sync (no last-applied baseline); it stays installed' }
        : { target, action: 'unchanged', reason: 'no local installation' };
    }
    if (!staleItem.eligible) {
      const reason = staleItem.overlaps.length
        ? `local copy overlaps currently managed targets: ${staleItem.overlaps.join(', ')}; it stays installed`
        : 'local copy diverged from its last-applied baseline; it stays installed and is reported as stale by status';
      return { target, action: 'preserved', reason };
    }
    if (staleItem.localSnapshot === null) return { target, action: 'unchanged', reason: 'no local copy; the baseline entry is forgotten' };
    return dryRun ? { target, action: 'would-remove' } : { target, action: 'removed' };
  };

  if (dryRun) {
    const state = await loadState(agentDir);
    const plan = await buildPlan(repo, agentDir, declarationsAfter, state);
    const staleItem = plan.stale.find((item) => item.target === target);
    return { apiVersion: 2, command: 'remove', ok: true, exitCode: 0, repository: repo, mode: 'preview',
      removed: { type: entry.type, source: entry.source, target: entry.target }, local: await describeLocal(staleItem) };
  }

  // The local installation and its state are apply-owned, so the removal runs
  // under the apply lock, re-reading the baseline after acquiring it (the same
  // discipline as the stale batch).
  const releaseLock = await acquireLock(agentDir);
  try {
    const state = await loadState(agentDir);
    const plan = await buildPlan(repo, agentDir, declarationsAfter, state);
    const staleItem = plan.stale.find((item) => item.target === target);
    const manifestPath = path.join(repo, MANIFEST_FILE);
    const manifestText = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestText);
    const nextManifest = { ...manifest, resources: manifest.resources.filter((item: any) => item.target !== target) };
    // Snapshot the repository content before deleting it so a failure after
    // the manifest rewrite can leave the repository exactly as it was.
    const contentBackup = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-remove-content-'));
    let manifestWritten = false;
    try {
      try {
        await fs.cp(entry.sourcePath, path.join(contentBackup, 'source'), { recursive: true, errorOnExist: true, force: false });
      } catch (error) {
        throw new Error(`Could not snapshot managed resource content before removal: ${entry.source} (${error.message})`);
      }
      await writeJsonFileAtomic(manifestPath, nextManifest, manifestText, 'remove');
      manifestWritten = true;
      try {
        await fs.rm(entry.sourcePath, { recursive: true });
      } catch (error) {
        if (manifestWritten) await restoreFileAtomic(manifestPath, manifestText);
        throw new Error(`Could not remove managed resource content: ${entry.source} (${error.message})`);
      }
      try {
        await validateRepository(repo);
      } catch (error) {
        if (manifestWritten) await restoreFileAtomic(manifestPath, manifestText);
        await fs.cp(path.join(contentBackup, 'source'), entry.sourcePath, { recursive: true, errorOnExist: true, force: false });
        throw error;
      }
    } finally {
      await fs.rm(contentBackup, { recursive: true, force: true }).catch(() => {});
    }
    const local = keepLocal
      ? { target, action: 'unchanged' as const, reason: 'kept by --keep-local; status reports it as stale' }
      : await removeLocalIfEligible(agentDir, target, targetPath, staleItem, state);
    return { apiVersion: 2, command: 'remove', ok: true, exitCode: 0, repository: repo, mode: 'applied',
      removed: { type: entry.type, source: entry.source, target: entry.target }, local };
  } finally {
    await releaseLock();
  }
}

async function localExists(targetPath: string): Promise<boolean> {
  const info = await fs.lstat(targetPath).catch((error: any) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  return info !== null;
}

// Removes the local copy when it still exactly matches its saved baseline
// (after backing it up under .pi-sync/backups and re-verifying it unchanged),
// or forgets a baseline whose local copy is already gone. Diverged,
// untracked, and overlapping copies are preserved and reported.
async function removeLocalIfEligible(agentDir: string, target: string, targetPath: string, staleItem: PlanStale | undefined, state: Awaited<ReturnType<typeof loadState>>): Promise<RemovedResourceResult['local']> {
  if (staleItem === undefined) {
    return (await localExists(targetPath))
      ? { target, action: 'preserved', reason: 'local copy is not tracked by Pi Sync (no last-applied baseline); it stays installed' }
      : { target, action: 'unchanged', reason: 'no local installation' };
  }
  if (!staleItem.eligible) {
    const reason = staleItem.overlaps.length
      ? `local copy overlaps currently managed targets: ${staleItem.overlaps.join(', ')}; it stays installed`
      : 'local copy diverged from its last-applied baseline; it stays installed and is reported as stale by status';
    return { target, action: 'preserved', reason };
  }
  let backup: string | undefined;
  if (staleItem.localSnapshot !== null) {
    const info = await fs.lstat(targetPath);
    backup = await createBackup(agentDir, target, targetPath, info.isDirectory());
    const observed = await safeSnapshot(targetPath);
    if (!sameValue(observed, staleItem.localSnapshot)) throw new Error(`Managed resource changed during remove; refusing to remove: ${target}`);
    const tombstone = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.removed`);
    await fs.rename(targetPath, tombstone);
    try { await fs.rm(tombstone, { recursive: true }); }
    catch (error) {
      await fs.rename(tombstone, targetPath).catch(() => {});
      throw error;
    }
  }
  delete state.resources[target];
  await writeState(agentDir, state);
  return staleItem.localSnapshot === null
    ? { target, action: 'unchanged', reason: 'no local copy; the baseline entry is forgotten' }
    : { target, action: 'removed', backup };
}

async function removeDependency(repo: string, source: string, agentDir: string, uninstall: boolean, dryRun: boolean): Promise<RemovedDependencyResult | RemoveUninstallFailedResult> {
  const match = /^(npm):(.+)$/.exec(source) ?? /^(github):(.+)$/.exec(source);
  if (!match) throw new Error('Dependency source must be npm:PACKAGE or github:OWNER/REPOSITORY');
  const dependency: Dependency = match[1] === 'npm' ? { type: 'npm', name: match[2] } : { type: 'github', repository: match[2] };
  if ((dependency.type === 'npm' && !/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(dependency.name)) ||
      (dependency.type === 'github' && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(dependency.repository))) {
    throw new Error('Dependency source has an invalid npm package name or GitHub owner/repository');
  }
  // Missing pins are tolerated here so that removing a declared-but-unpinned
  // dependency reaches the dedicated REMOVE_DEPENDENCY_NOT_PINNED error
  // instead of the generic repository validation failure.
  const declarations = await validateRepository(repo, { allowMissingPins: true });
  const identity = packageIdentity(dependency);
  const manifestPath = path.join(repo, MANIFEST_FILE);
  const lockPath = path.join(repo, LOCK_FILE);
  const manifestText = await fs.readFile(manifestPath, 'utf8');
  const lockText = await fs.readFile(lockPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  const lock = JSON.parse(lockText);
  if (!manifest.dependencies.some((item: any) => packageIdentity(item) === identity)) {
    const error: ResourceError = new Error(`Dependency is not declared in the manifest: ${identity}; remove only entries declared in the manifest`);
    error.errorCode = 'REMOVE_DEPENDENCY_NOT_FOUND';
    throw error;
  }
  const pin = declarations.lock.packages.find((item) => packageIdentity(item) === identity);
  if (!pin) {
    const error: ResourceError = new Error(`Dependency has no exact pin in the lockfile: ${identity}; resolve the lockfile before removing it`);
    error.errorCode = 'REMOVE_DEPENDENCY_NOT_PINNED';
    throw error;
  }
  // --uninstall also modifies the local package pin bookkeeping, so that
  // state must be readable and valid before any side effect. A corrupted
  // pin file fails the command up front, before the repository change or
  // the uninstall, instead of falsely failing after both have succeeded.
  let localPins: any = null;
  if (uninstall) {
    const pinsFile = path.join(agentDir, STATE_DIR, 'packages.json');
    const pinsInfo = await fs.lstat(pinsFile).catch((error: any) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
    if (pinsInfo && pinsInfo.isFile()) localPins = await loadPackagePins(agentDir);
  }
  if (dryRun) {
    return { apiVersion: 2, command: 'remove', ok: true, exitCode: 0, repository: repo, mode: 'preview',
      removed: { dependency, pin },
      localInstallation: uninstall ? 'would-uninstall' : 'unchanged',
      note: `Dry run: the manifest dependency and its exact lockfile pin would be removed${uninstall ? ' and the package uninstalled' : ', leaving it installed locally'}; nothing was changed.` };
  }
  const nextManifest = { ...manifest, dependencies: manifest.dependencies.filter((item: any) => packageIdentity(item) !== identity) };
  const nextLock = { ...lock, packages: lock.packages.filter((item: any) => packageIdentity(item) !== identity) };
  let manifestWritten = false;
  let lockWritten = false;
  try {
    await writeJsonFileAtomic(manifestPath, nextManifest, manifestText, 'remove');
    manifestWritten = true;
    await writeJsonFileAtomic(lockPath, nextLock, lockText, 'remove');
    lockWritten = true;
    try {
      await validateRepository(repo);
    } catch (error) {
      if (lockWritten) await restoreFileAtomic(lockPath, lockText);
      if (manifestWritten) await restoreFileAtomic(manifestPath, manifestText);
      throw error;
    }
  } catch (error) {
    if (lockWritten) await restoreFileAtomic(lockPath, lockText).catch(() => {});
    if (manifestWritten) await restoreFileAtomic(manifestPath, manifestText).catch(() => {});
    throw error;
  }
  const spec = packageSpec(pin);
  const output: RemovedDependencyResult = { apiVersion: 2, command: 'remove', ok: true, exitCode: 0, repository: repo, mode: 'applied',
    removed: { dependency, pin },
    localInstallation: 'unchanged',
    note: 'Removal is repository-only: the package remains installed locally and nothing is queued or scheduled for deletion. Rerun with --uninstall to uninstall it explicitly.' };
  if (!uninstall) return output;
  // The repository change is complete at this point; an uninstall failure is
  // reported without rolling back or altering it.
  const uninstalled = await runCommand('pi', ['uninstall', spec]);
  if (uninstalled.status !== 0 || uninstalled.error) {
    const detail = uninstalled.error?.message ?? uninstalled.stderr.trim() ?? `Pi exited ${uninstalled.status}`;
    // Key order matches the pre-refactor response: the success-shape fields
    // come first, then the failure metadata.
    const failed: RemoveUninstallFailedResult = { apiVersion: 2, command: 'remove', ok: false, exitCode: OPERATION_ERROR,
      repository: repo, removed: { dependency, pin }, localInstallation: 'unchanged',
      note: 'The repository removal is in place, but the package is still installed locally; retry the uninstall when Pi can remove it.',
      errorCode: 'UNINSTALL_FAILED',
      error: `pi uninstall failed for ${spec}: ${detail}; the repository removal was completed and left in place`,
      details: { message: `pi uninstall failed for ${spec}: ${detail}; the repository removal was completed and left in place`, package: identity, spec },
      uninstall: { package: identity, spec, status: 'failed', error: detail } };
    return failed;
  }
  // Clear the local pin bookkeeping only when Pi Sync tracks it for this agent
  // directory; the installed package itself is left to Pi. The pin state was
  // already validated before the side effects, so this cleanup cannot throw
  // from unreadable pin data.
  if (localPins && Object.hasOwn(localPins.packages, identity)) {
    const { [identity]: gone, ...remaining } = localPins.packages;
    await writeLocalPackagePins(agentDir, remaining);
  }
  output.uninstalled = { package: identity, spec };
  output.localInstallation = 'uninstalled';
  output.note = 'The repository removal is in place and the package was uninstalled locally.';
  return output;
}

export type AddInput =
  | { repo: string; agentDir: string; type: 'dependency'; source: string; dryRun: boolean }
  | { repo: string; agentDir: string; type: 'resource-discovery'; mode: { list: true } | { all: true } }
  | { repo: string; agentDir: string; type: 'skill' | 'extension' | 'prompt' | 'agent' | 'role' | 'workflow'; target: string; dryRun: boolean };

// Dependency sources remain declarations only. Resource additions resolve
// repository and local copies together, while discovery operates repository-first.
export async function runAdd(input: AddInput): Promise<AddOutput> {
  if (input.type === 'dependency') return addDependency(input.repo, input.source, input.dryRun);
  if (input.type === 'resource-discovery') return 'list' in input.mode ? listAddCandidates(input.repo) : addAllResources(input.repo);
  return addResource(input.repo, input.agentDir, input.type, input.target, input.dryRun);
}

// The `remove --stale` batch: the old prune workflow. It removes local
// installations that Pi Sync installed and that now exactly match their saved
// last-applied baseline. Diverged local copies stay and are reported, as do
// copies that overlap still-managed targets. The output shape mirrors the
// former prune output (staleResources with per-target action/installed) so
// the workflow reads the same.
export interface RemoveStaleResourceResult {
  target: string;
  action: string;
  installed: boolean;
  overlaps?: string[];
}

export interface RemoveStaleResult {
  apiVersion: 2;
  command: 'remove';
  ok: boolean;
  exitCode: number;
  repository: string;
  agentDirectory: string;
  mode: 'applied' | 'preview';
  staleResources: RemoveStaleResourceResult[];
}

export type RemoveStaleOutput = RemoveStaleResult;

// Matches the entry point's operation-error exit status: retained or modified
// stale resources fail the command so a caller sees they were not all removed.
const REMOVE_STALE_OPERATION_ERROR = 1;

async function removeStale(agentDir: string, state: Awaited<ReturnType<typeof loadState>>, stale: PlanStale[], dryRun: boolean): Promise<RemoveStaleResourceResult[]> {
  const results: RemoveStaleResourceResult[] = [];
  const nextState = structuredClone(state);
  for (const item of stale) {
    if (item.overlaps.length) {
      results.push({ target: item.target, action: 'retained-overlap', installed: item.localSnapshot !== null, overlaps: item.overlaps });
      continue;
    }
    if (dryRun) {
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
      if (!sameValue(observed, item.localSnapshot)) throw new Error(`Stale resource changed during remove; refusing to remove: ${item.target}`);
      const tombstone = path.join(path.dirname(item.targetPath), `.${path.basename(item.targetPath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.removed`);
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

// The stale workflow is distinct from ordinary apply. It takes the apply lock
// and re-reads the baseline for the default mutating action; `--dry-run` is
// read-only and never locks or writes.
async function runRemoveStale(repo: string, agentDir: string, declarations: RepositoryDeclarations, dryRun: boolean): Promise<RemoveStaleResult> {
  const state = await loadState(agentDir);
  const releaseLock = dryRun ? null : await acquireLock(agentDir);
  try {
    const currentState = releaseLock ? await loadState(agentDir) : state;
    const plan = await buildPlan(repo, agentDir, declarations, currentState);
    const staleResources = await removeStale(agentDir, currentState, plan.stale, dryRun);
    const ok = !staleResources.some((item) => ['modified', 'retained-modified', 'retained-overlap'].includes(item.action));
    return { apiVersion: 2, command: 'remove', ok, exitCode: ok ? 0 : REMOVE_STALE_OPERATION_ERROR, repository: repo, agentDirectory: agentDir,
      mode: dryRun ? 'preview' : 'applied', staleResources };
  } finally {
    if (releaseLock) await releaseLock();
  }
}

// The remove workflow: `remove --target` removes a managed resource fully
// (manifest entry, repository content, and — unless --keep-local — the local
// installation), `remove --source` removes a dependency declaration and its
// exact lockfile pin (optionally uninstalling the package), and
// `remove --stale` removes stale local installations in one batch. The
// discriminated input type carries the parser's selector guarantee, so no
// optional-field casts are needed.
export type RemoveInput =
  | { repo: string; agentDir: string; type: 'stale'; dryRun: boolean }
  | { repo: string; agentDir: string; type: 'dependency'; source: string; uninstall: boolean; dryRun: boolean }
  | { repo: string; agentDir: string; type: 'skill' | 'extension' | 'prompt' | 'agent' | 'role' | 'workflow'; target: string; keepLocal: boolean; dryRun: boolean };

export async function runRemove(input: RemoveInput): Promise<RemoveOutput> {
  if (input.type === 'stale') {
    // The stale batch does not touch dependency pins, so missing pins are
    // tolerated here, matching the entry point's remove validation.
    const declarations = await validateRepository(input.repo, { allowMissingPins: true });
    return runRemoveStale(input.repo, input.agentDir, declarations, input.dryRun);
  }
  if (input.type === 'dependency') return removeDependency(input.repo, input.source, input.agentDir, input.uninstall, input.dryRun);
  return removeResource(input.repo, input.agentDir, input.type, input.target, input.keepLocal, input.dryRun);
}