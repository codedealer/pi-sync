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
} from '../manifest.js';
import { runCommand } from '../process.js';
import { sameValue, snapshotPath } from '../reconciliation.js';
import { STATE_DIR, loadPackagePins, writeLocalPackagePins } from '../local-state.js';
import {
  RESOURCE_ADD_RULES,
  ensureRealDirectory,
  findLikelySecrets,
  normalizeResourceSource,
  restoreFileAtomic,
  unregisteredCandidates,
  writeJsonFileAtomic,
  type ResourceCandidate,
  type SecretFinding,
} from '../resource-operations.js';
import type { RegisterMode } from '../arguments.js';

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
  apiVersion: 1;
  command: 'add';
  ok: true;
  exitCode: 0;
  type: 'dependency';
  dependency: Dependency;
  action: 'added';
  next: string;
}

export interface AddedResourceResult {
  apiVersion: 1;
  command: 'add';
  ok: true;
  exitCode: 0;
  type: string;
  source: string;
  target: string;
  repositorySource: string;
  action: 'added';
  reviewRequired: SecretFinding[];
}

export interface AddSecretReviewResult {
  apiVersion: 1;
  command: 'add';
  ok: false;
  errorCode: 'SECRET_REVIEW_REQUIRED';
  exitCode: number;
  error: string;
  reviewRequired: SecretFinding[];
  details: { reviewRequired: SecretFinding[] };
}

export type AddOutput = AddedDependencyResult | AddedResourceResult | AddSecretReviewResult;

export interface RegisterListResult {
  apiVersion: 1;
  command: 'register';
  ok: true;
  exitCode: 0;
  unregistered: ResourceCandidate[];
}

export interface RegisterResult {
  apiVersion: 1;
  command: 'register';
  ok: true;
  exitCode: 0;
  type: string;
  source: string;
  target: string;
  action: 'registered' | 'already-registered';
}

export interface RegisterBatchResult {
  apiVersion: 1;
  command: 'register';
  ok: true;
  exitCode: 0;
  action: 'registered' | 'up-to-date';
  registered: ResourceCandidate[];
}

export interface RegisterSecretReviewResult {
  apiVersion: 1;
  command: 'register';
  ok: false;
  errorCode: 'SECRET_REVIEW_REQUIRED';
  exitCode: number;
  error: string;
  reviewRequired: SecretFinding[];
  details: { reviewRequired: SecretFinding[] };
}

export type RegisterOutput = RegisterListResult | RegisterResult | RegisterBatchResult | RegisterSecretReviewResult;

export interface RemovedResourceResult {
  apiVersion: 1;
  command: 'remove';
  ok: true;
  exitCode: 0;
  repository: string;
  removed: { type: string; source: string; target: string };
  stale: { target: string; localInstallation: 'unchanged'; note: string };
}

export interface RemovedDependencyResult {
  apiVersion: 1;
  command: 'remove';
  ok: true;
  exitCode: 0;
  repository: string;
  removed: { dependency: Dependency; pin: LockPackage };
  localInstallation: 'unchanged' | 'uninstalled';
  note: string;
  uninstalled?: { package: string; spec: string };
}

// Field order mirrors the emitted JSON: the failure metadata is appended
// after the success-shape fields (repository/removed/localInstallation/note),
// matching the pre-refactor response exactly.
export interface RemoveUninstallFailedResult {
  apiVersion: 1;
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

export type RemoveOutput = RemovedResourceResult | RemovedDependencyResult | RemoveUninstallFailedResult;

async function addDependency(repo: string, source: string): Promise<AddedDependencyResult> {
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
  return { apiVersion: 1, command: 'add', ok: true, exitCode: 0, type: 'dependency', dependency, action: 'added', next: 'Run pi-sync update to preview an age-eligible exact pin' };
}

async function addResource(repo: string, agentDir: string, type: string, source: string): Promise<AddedResourceResult | AddSecretReviewResult> {
  const rule = RESOURCE_ADD_RULES[type];
  const relative = normalizeResourceSource(type, source, agentDir);
  const sourcePath = resolveInside(agentDir, relative, '--source');
  const info = await fs.lstat(sourcePath).catch((error: any) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info || info.isSymbolicLink()) throw new Error(`Resource source does not exist or is a symbolic link: ${relative}`);
  const isFile = info.isFile();
  if (rule.shape === 'directory' && !info.isDirectory()) throw new Error(`${rule.label} source must be an existing directory: ${relative}`);
  if (rule.shape === 'file' && !isFile) throw new Error(`${rule.label} source must be an existing regular file: ${relative}`);
  if (rule.shape === 'any' && !isFile && !info.isDirectory()) throw new Error(`Extension source must be an existing file or directory: ${relative}`);
  if (isFile) await validateSourceFile(agentDir, relative);
  else await validateSourceTree(agentDir, sourcePath, relative);
  const findings = await findLikelySecrets(sourcePath, relative);
  if (findings.length) return {
    apiVersion: 1, command: 'add', ok: false, errorCode: 'SECRET_REVIEW_REQUIRED', exitCode: VALIDATION_ERROR,
    error: 'Import was not performed; review suspected secret material and remove it before retrying', reviewRequired: findings,
    details: { reviewRequired: findings },
  };

  const manifestPath = path.join(repo, MANIFEST_FILE);
  const manifestText = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  const declarations = await validateRepository(repo);
  const target = relative;
  const managedSource = `${rule.sourceRoot}/${path.posix.relative(rule.localRoot, relative)}`;
  if (declarations.resources.some((item) => pathsOverlap(item.target, target) || pathsOverlap(item.source, managedSource))) {
    const error: ResourceError = new Error(`Resource collision: ${target} or ${managedSource} is already declared`);
    error.errorCode = 'RESOURCE_COLLISION';
    error.details = { type, source: relative, target, repositorySource: managedSource };
    throw error;
  }
  const destination = resolveInside(repo, managedSource, 'new resource source');
  if (await fs.lstat(destination).then(() => true).catch((error: any) => error.code === 'ENOENT' ? false : Promise.reject(error))) {
    const error: ResourceError = new Error(`Resource collision: setup repository path already exists: ${managedSource}`);
    error.errorCode = 'RESOURCE_COLLISION';
    error.details = { type, source: relative, target, repositorySource: managedSource };
    throw error;
  }
  const parent = path.posix.dirname(managedSource);
  const parentExists = await ensureRealDirectory(repo, parent, true);
  if (!parentExists) throw new Error(`Could not create ${parent} in the setup repository`);
  const before = await snapshotPath(sourcePath);
  const temporary = `${manifestPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let createdDestination = false;
  try {
    if (isFile) {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(sourcePath, destination);
    } else {
      await fs.mkdir(destination);
      createdDestination = true;
      for (const entry of await fs.readdir(sourcePath)) {
        await fs.cp(path.join(sourcePath, entry), path.join(destination, entry), { recursive: true, errorOnExist: true, force: false });
      }
    }
    const after = await snapshotPath(sourcePath);
    const imported = await snapshotPath(destination);
    if (!sameValue(before, after) || !sameValue(before, imported)) throw new Error(`Selected ${rule.label.toLowerCase()} changed during import; retry after it is stable`);
    const nextManifest = { ...manifest, resources: [...manifest.resources, { type, source: managedSource, target }] };
    const manifestInfo = await fs.stat(manifestPath);
    await fs.writeFile(temporary, `${JSON.stringify(nextManifest, null, 2)}\n`, { flag: 'wx', mode: manifestInfo.mode & 0o777 });
    const latestManifestText = await fs.readFile(manifestPath, 'utf8');
    if (latestManifestText !== manifestText) throw new Error('Manifest changed during add; retry without overwriting concurrent changes');
    await fs.rename(temporary, manifestPath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    if (createdDestination) await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
    if (isFile) await fs.rm(destination, { force: true }).catch(() => {});
    throw error;
  }
  return { apiVersion: 1, command: 'add', ok: true, exitCode: 0, type, source: relative, target, repositorySource: managedSource, action: 'added', reviewRequired: [] };
}

// Register is the inverse-direction complement of add: the resource content
// must already be present under the type's repository sourceRoot, and only
// the manifest entry is written. There is no import or copy, no
// local-installation write, and no commit or push; the subsequent apply
// copies the resource into the local installation and push publishes it,
// exactly as for resources added through add.
async function registerResource(repo: string, type: string, source: string): Promise<RegisterResult | RegisterSecretReviewResult> {
  const rule = RESOURCE_ADD_RULES[type];
  if (!rule) throw new Error(`Unsupported resource type: ${type}`);
  if (typeof source !== 'string' || source.length === 0) throw new Error('--source must be a non-empty path');
  if (source.includes('\\')) throw new Error('Relative --source paths must use POSIX separators');
  if (path.isAbsolute(source)) throw new Error('register --source must be a repository-relative path under resources/ (for example, resources/prompts/example.md)');
  validateRelativePath(source, '--source');
  // The per-type shape rules are expressed against the agent-relative local
  // root; the repository source is the same path under resources/, and the
  // target is derived by substituting the type's localRoot.
  const localRelative = path.posix.relative('resources', source);
  if (!rule.pattern.test(localRelative)) throw new Error(rule.patternError.split(rule.localRoot).join(`resources/${rule.localRoot}`));
  const target = localRelative;
  const sourcePath = resolveInside(repo, source, '--source');
  await validateResourceSource(repo, sourcePath, source, rule);
  const findings = await findLikelySecrets(sourcePath, source);
  if (findings.length) {
    return {
      apiVersion: 1, command: 'register', ok: false, errorCode: 'SECRET_REVIEW_REQUIRED', exitCode: VALIDATION_ERROR,
      error: 'Registration was not performed; review suspected secret material and remove it before retrying',
      reviewRequired: findings, details: { reviewRequired: findings },
    };
  }
  const declarations = await validateRepository(repo);
  if (declarations.resources.some((item) => item.source === source && item.target === target)) {
    return { apiVersion: 1, command: 'register', ok: true, exitCode: 0, type, source, target, action: 'already-registered' };
  }
  if (declarations.resources.some((item) => pathsOverlap(item.target, target) || pathsOverlap(item.source, source))) {
    const error: ResourceError = new Error(`Resource collision: ${target} or ${source} is already declared`);
    error.errorCode = 'RESOURCE_COLLISION';
    error.details = { type, source, target };
    throw error;
  }
  const manifestPath = path.join(repo, MANIFEST_FILE);
  const manifestText = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  // The manifest write reuses the same atomic, concurrency-guarded write as
  // remove: an exclusively created temp file whose manifest text is compared
  // before rename, so a concurrent change is never overwritten.
  await writeJsonFileAtomic(manifestPath, { ...manifest, resources: [...manifest.resources, { type, source, target }] }, manifestText, 'register');
  return { apiVersion: 1, command: 'register', ok: true, exitCode: 0, type, source, target, action: 'registered' };
}

// register --list: read-only discovery. It validates the repository up
// front, reports the unregistered candidates with their inferred type,
// source, and derived target, and changes nothing.
async function listUnregisteredResources(repo: string, type?: string): Promise<RegisterListResult> {
  const resources = (await validateRepository(repo)).resources;
  const unregistered = await unregisteredCandidates(repo, resources, type);
  return { apiVersion: 1, command: 'register', ok: true, exitCode: 0, unregistered };
}

function resourceCollision(candidate: ResourceCandidate, other: ResourceCandidate): ResourceError {
  const error: ResourceError = new Error(`Resource collision: ${candidate.target} or ${candidate.source} overlaps ${other.target} (${other.source})`);
  error.errorCode = 'RESOURCE_COLLISION';
  error.details = { source: candidate.source, target: candidate.target, conflictingSource: other.source, conflictingTarget: other.target };
  return error;
}

// register --all: batch registration of the same candidate set --list
// reports. It is all-or-nothing: the repository content of every candidate
// is validated, every candidate is secret-scanned, and a collision
// pre-flight runs against the existing declarations and the candidate set
// itself; any failure registers nothing. Otherwise a single atomic,
// concurrency-guarded manifest write appends every new entry. As with
// single mode there is no copy, no local-installation write, and no commit
// or push; apply performs the copy afterward.
async function registerAllResources(repo: string, type?: string): Promise<RegisterBatchResult | RegisterSecretReviewResult> {
  const declarations = await validateRepository(repo);
  const candidates = await unregisteredCandidates(repo, declarations.resources, type);
  if (candidates.length === 0) {
    return { apiVersion: 1, command: 'register', ok: true, exitCode: 0, action: 'up-to-date', registered: [] };
  }
  // Every candidate must be registrable the way single mode registers it,
  // so the manifest that is about to be written stays valid.
  for (const candidate of candidates) {
    const rule = RESOURCE_ADD_RULES[candidate.type];
    const sourcePath = resolveInside(repo, candidate.source, '--source');
    await validateResourceSource(repo, sourcePath, candidate.source, rule);
  }
  // All-or-nothing secret review: every candidate is scanned up front and
  // any finding aborts the whole batch with all findings reported. The
  // suspected value is never echoed.
  const findings: SecretFinding[] = [];
  for (const candidate of candidates) {
    const sourcePath = resolveInside(repo, candidate.source, '--source');
    findings.push(...(await findLikelySecrets(sourcePath, candidate.source)));
  }
  if (findings.length) {
    return {
      apiVersion: 1, command: 'register', ok: false, errorCode: 'SECRET_REVIEW_REQUIRED', exitCode: VALIDATION_ERROR,
      error: 'Registration was not performed; review suspected secret material and remove it before retrying',
      reviewRequired: findings, details: { reviewRequired: findings },
    };
  }
  // Collision pre-flight against the existing declarations and against the
  // candidate set itself (case-insensitive target/source overlap).
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const conflict = [...declarations.resources, ...candidates.slice(i + 1)]
      .find((other) => pathsOverlap(other.target, candidate.target) || pathsOverlap(other.source, candidate.source));
    if (conflict) throw resourceCollision(candidate, conflict);
  }
  const manifestPath = path.join(repo, MANIFEST_FILE);
  const manifestText = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  await writeJsonFileAtomic(manifestPath, { ...manifest, resources: [...manifest.resources, ...candidates] }, manifestText, 'register');
  return { apiVersion: 1, command: 'register', ok: true, exitCode: 0, action: 'registered', registered: candidates };
}

// Removal is repository-only by design: it deletes the manifest entry and the
// repository content, never touches the local Pi installation, and queues or
// schedules nothing for deletion. Removed resources surface as stale through
// the existing status/plan/apply reporting and stay installed until an
// explicit `prune --confirm` removes them (with its baseline-match and
// backup protections).
async function removeResource(repo: string, type: string, target: string): Promise<RemovedResourceResult> {
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
    const error: ResourceError = new Error(`Target ${target} is managed as ${entry.type}, not ${type}; use remove --type ${entry.type}`);
    error.errorCode = 'REMOVE_TYPE_MISMATCH';
    throw error;
  }
  const manifestPath = path.join(repo, MANIFEST_FILE);
  const manifestText = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  const nextManifest = { ...manifest, resources: manifest.resources.filter((item: any) => item.target !== target) };
  // Snapshot the repository content before deleting it so a failure after the
  // manifest rewrite can leave the repository exactly as it was.
  const contentBackup = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-remove-content-'));
  try {
    await fs.cp(entry.sourcePath, path.join(contentBackup, 'source'), { recursive: true, errorOnExist: true, force: false });
  } catch (error) {
    await fs.rm(contentBackup, { recursive: true, force: true }).catch(() => {});
    throw new Error(`Could not snapshot managed resource content before removal: ${entry.source} (${error.message})`);
  }
  let manifestWritten = false;
  try {
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
  return { apiVersion: 1, command: 'remove', ok: true, exitCode: 0, repository: repo,
    removed: { type: entry.type, source: entry.source, target: entry.target },
    stale: { target: entry.target, localInstallation: 'unchanged',
      note: 'Removal is repository-only: the local installation is unchanged and nothing is queued or scheduled for deletion. status, plan, and apply now report this resource as stale until it is pruned with `pi-sync prune --confirm` or re-declared in the manifest.' } };
}

async function removeDependency(repo: string, source: string, agentDir: string, uninstall: boolean): Promise<RemovedDependencyResult | RemoveUninstallFailedResult> {
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
  const output: RemovedDependencyResult = { apiVersion: 1, command: 'remove', ok: true, exitCode: 0, repository: repo,
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
    const failed: RemoveUninstallFailedResult = { apiVersion: 1, command: 'remove', ok: false, exitCode: OPERATION_ERROR,
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

export interface AddInput {
  repo: string;
  agentDir: string;
  type: 'skill' | 'extension' | 'prompt' | 'agent' | 'role' | 'dependency';
  source: string;
}

// The add workflow: `add --type dependency` declares a dependency without
// pinning it (update resolves and writes the pin), and every other type
// imports the selected agent-directory resource into the setup repository
// and declares it. Both paths change only the explicitly selected content
// and the manifest declarations.
export async function runAdd({ repo, agentDir, type, source }: AddInput): Promise<AddOutput> {
  if (type === 'dependency') return addDependency(repo, source);
  return addResource(repo, agentDir, type, source);
}

export interface RegisterInput {
  repo: string;
  mode: RegisterMode;
}

// The register workflow: exactly one mode is selected by the parser — a
// single registration via --source, read-only discovery via --list, or a
// batch registration via --all. None of the modes requires or uses
// --agent-dir. The parser requires --type for single registration.
export async function runRegister({ repo, mode }: RegisterInput): Promise<RegisterOutput> {
  if ('source' in mode) return registerResource(repo, mode.type, mode.source);
  if ('list' in mode) return listUnregisteredResources(repo, mode.type);
  return registerAllResources(repo, mode.type);
}

// Mirrors the parser's discriminated remove request: dependency removals
// carry the required --source, resource removals the required --target.
export type RemoveInput =
  | { repo: string; agentDir: string; type: 'dependency'; source: string; uninstall: boolean }
  | { repo: string; agentDir: string; type: 'skill' | 'extension' | 'prompt' | 'agent' | 'role'; target: string; uninstall: boolean };

// The remove workflow: `remove --type dependency` (with --source, and
// optionally --uninstall) and every other type (with --target). Both paths
// are repository-only by design and change only the explicitly selected
// manifest declarations and repository content. The discriminated input
// type carries the parser's selector guarantee, so no optional-field casts
// are needed.
export async function runRemove(input: RemoveInput): Promise<RemoveOutput> {
  if (input.type === 'dependency') return removeDependency(input.repo, input.source, input.agentDir, input.uninstall);
  return removeResource(input.repo, input.type, input.target);
}