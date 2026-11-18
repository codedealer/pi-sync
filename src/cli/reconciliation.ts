import fs from 'node:fs/promises';
import path from 'node:path';
import {
  RESOURCE_TARGET_ROOTS,
  isRecord,
  pathsOverlap,
  resolveInside,
  validatePortableSettingValue,
  validateRelativePath,
  type RepositoryDeclarations,
  type ResourceType,
  type SettingsFieldDeclaration,
  type SourceKind,
} from './manifest.js';
import { gitResult } from './process.js';

export interface FileSnapshot {
  content: string;
  mode: number;
}

// A captured tree, or its invalid marker when the path is not a plain file
// or directory. The optional members reflect what the snapshots can legally
// contain; consumers check `invalidType` before treating them as trees.
export interface Snapshot {
  directories?: string[];
  files?: Record<string, FileSnapshot>;
  invalidType?: boolean;
}

export interface ResourceBaseline {
  kind?: string;
  files?: Record<string, FileSnapshot>;
  directories?: string[];
  [key: string]: unknown;
}

export type FieldBaseline = { exists: true; value: unknown } | { exists: false };

export interface LocalState {
  schemaVersion: 1;
  resources: Record<string, ResourceBaseline>;
  settings: Record<string, Record<string, FieldBaseline>>;
}

export type TargetKind = 'file' | 'directory';

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

export function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

async function snapshotTree(root: string): Promise<Snapshot> {
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return { invalidType: true };
  const snapshot: Snapshot = { directories: [], files: {} };
  async function visit(directory: string, relative: string) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not supported in managed targets: ${child}`);
      if (entry.isDirectory()) {
        snapshot.directories!.push(child);
        await visit(entryPath, child);
      } else if (entry.isFile()) {
        const info = await fs.stat(entryPath);
        snapshot.files![child] = { content: (await fs.readFile(entryPath)).toString('base64'), mode: info.mode & 0o777 };
      } else throw new Error(`Unsupported file type in managed target: ${child}`);
    }
  }
  await visit(root, '');
  snapshot.directories!.sort();
  return snapshot;
}

export async function snapshotPath(root: string): Promise<Snapshot> {
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) return { invalidType: true };
  if (stat.isFile()) {
    const bytes = await fs.readFile(root);
    return { directories: [], files: { [path.basename(root)]: { content: bytes.toString('base64'), mode: stat.mode & 0o777 } } };
  }
  return snapshotTree(root);
}

async function kindOf(target: string): Promise<TargetKind | null> {
  const info = await fs.lstat(target).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  if (!info || info.isSymbolicLink()) return null;
  if (info.isFile()) return 'file';
  if (info.isDirectory()) return 'directory';
  return null;
}

export async function safeSnapshot(root: string): Promise<Snapshot | null> {
  try { return await snapshotPath(root); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function ensureTargetParents(agentDir: string, relative: string) {
  let parent = agentDir;
  for (const segment of relative.split('/').slice(0, -1)) {
    parent = path.join(parent, segment);
    try {
      const info = await fs.lstat(parent);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Managed target parent must be a real directory, not a symbolic link: ${relative}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

export type PlanFileAction = 'unchanged' | 'update' | 'delete' | 'local-divergence' | 'conflict';

export interface PlanFile {
  path: string;
  local: FileSnapshot | null;
  repository: FileSnapshot | null;
  action: PlanFileAction;
  reason?: string;
}

export type PlanResourceAction = 'install' | 'collision' | 'conflict' | 'update' | 'local-divergence' | 'unchanged';

export interface PlanResource {
  type: ResourceType;
  source: string;
  target: string;
  sourcePath: string;
  sourceKind: SourceKind;
  targetPath: string;
  kind: SourceKind;
  localSnapshot: Snapshot | null;
  snapshot: Snapshot;
  action: PlanResourceAction;
  reason?: string;
  files: PlanFile[];
  kindMismatch: boolean;
  rememberBaseline?: boolean;
}

export interface ManagedFieldLocal {
  valid: boolean;
  exists: boolean;
  value?: unknown;
}

export type PlanFieldAction = 'install' | 'update' | 'local-divergence' | 'conflict' | 'collision' | 'unchanged';

export interface PlanSettingField extends SettingsFieldDeclaration {
  action: PlanFieldAction;
  reason?: string;
  local: ManagedFieldLocal;
  baseline: FieldBaseline | undefined;
  rememberBaseline?: boolean;
}

export type PlanSettingAction = 'conflict' | 'collision' | 'update' | 'install' | 'local-divergence' | 'unchanged';

export interface PlanSetting {
  target: string;
  targetPath: string;
  fields: PlanSettingField[];
  fileText: string | null;
  fileExists: boolean;
  value: Record<string, unknown>;
  action: PlanSettingAction;
}

export type StaleState = 'overlaps-current' | 'missing' | 'unchanged' | 'modified';

export interface PlanStale {
  target: string;
  targetPath: string;
  localSnapshot: Snapshot | null;
  overlaps: string[];
  eligible: boolean;
  state: StaleState;
}

export interface ReconciliationPlan {
  resources: PlanResource[];
  settings: PlanSetting[];
  stale: PlanStale[];
}

// The single owner of the three-way (repository, local, last-applied
// baseline) semantics for resource files, settings fields, and stale
// baselines, plus the reporting summaries derived from a plan.
function resourceFileAction(local: FileSnapshot | null, repository: FileSnapshot | null, baseline: FileSnapshot | null): { action: PlanFileAction; reason?: string } {
  const repositoryChanged = !sameValue(repository, baseline);
  const localChanged = !sameValue(local, baseline);
  if (!repositoryChanged && !localChanged) return { action: 'unchanged' };
  if (repositoryChanged && !localChanged) return { action: repository === null ? 'delete' : 'update' };
  if (!repositoryChanged && localChanged) return { action: 'local-divergence' };
  if (sameValue(local, repository)) return { action: 'unchanged' };
  return { action: 'conflict', reason: 'local and setup repository both changed this file since the last apply' };
}

function resourceAction(resource: PlanResource, local: Snapshot | null, baseline: ResourceBaseline | undefined, localKind: TargetKind | null): { action: PlanResourceAction; reason?: string; files?: PlanFile[]; kindMismatch?: boolean; rememberBaseline?: boolean } {
  if (!baseline) {
    if (local === null) return { action: 'install' };
    if (localKind === resource.kind && sameValue(local, resource.snapshot)) return { action: 'unchanged', rememberBaseline: true };
    return { action: 'collision', reason: 'target exists but is not tracked by Pi Sync' };
  }
  const names = new Set([...Object.keys(baseline.files ?? {}), ...Object.keys(local?.files ?? {}), ...Object.keys(resource.snapshot.files ?? {})]);
  const files: PlanFile[] = [...names].sort().map((relative) => ({
    path: relative,
    local: local?.files?.[relative] ?? null,
    repository: resource.snapshot.files?.[relative] ?? null,
    ...resourceFileAction(local?.files?.[relative] ?? null, resource.snapshot.files?.[relative] ?? null, baseline.files?.[relative] ?? null),
  }));
  // A tracked target must keep its managed kind. A replacement by the other
  // kind (even with identical content and mode) is reported immediately
  // instead of waiting for a repository change to surface it; apply refuses
  // to touch the target until it is resolved manually.
  if (localKind !== null && localKind !== resource.kind) {
    return { action: 'conflict', files, reason: `managed target changed type since the last apply (expected ${resource.kind}); resolve manually`, kindMismatch: true };
  }
  const fileActions = files.map((file) => file.action);
  let action: PlanResourceAction = 'unchanged';
  if (fileActions.includes('conflict')) action = 'conflict';
  else if (fileActions.includes('update') || fileActions.includes('delete')) action = 'update';
  else if (fileActions.includes('local-divergence')) action = 'local-divergence';
  return { action, files, reason: action === 'conflict' ? 'local and setup repository both changed one or more files' : undefined };
}

function readManagedField(object: unknown, segments: string[]): ManagedFieldLocal {
  let current: unknown = object;
  for (const segment of segments) {
    if (!isRecord(current)) return { valid: false, exists: false };
    if (!Object.hasOwn(current, segment)) return { valid: true, exists: false };
    current = current[segment];
  }
  return { valid: true, exists: true, value: current };
}

export function setManagedField(object: Record<string, unknown>, segments: string[], value: unknown) {
  let current: Record<string, unknown> = object;
  for (const segment of segments.slice(0, -1)) {
    if (!Object.hasOwn(current, segment)) current[segment] = {};
    if (!isRecord(current[segment])) throw new Error(`Settings field parent is not an object: /${segments.join('/')}`);
    current = current[segment];
  }
  current[segments.at(-1)!] = value;
}

function fieldState(value: ManagedFieldLocal): FieldBaseline {
  return value.exists ? { exists: true, value: value.value } : { exists: false };
}

function sameField(left: FieldBaseline | undefined, right: FieldBaseline | undefined) {
  return left?.exists === right?.exists && (!left?.exists || !right?.exists || sameValue(left.value, right.value));
}

function settingFieldAction(field: SettingsFieldDeclaration, local: ManagedFieldLocal, baseline: FieldBaseline | undefined): { action: PlanFieldAction; reason?: string; rememberBaseline?: boolean } {
  if (!baseline) {
    if (!local.exists) return { action: 'install' };
    if (sameValue(local.value, field.value)) return { action: 'unchanged', rememberBaseline: true };
    return { action: 'collision', reason: 'managed setting already exists but is not tracked by Pi Sync' };
  }
  const desired: FieldBaseline = { exists: true, value: field.value };
  const localState = fieldState(local);
  const repositoryChanged = !sameField(desired, baseline);
  const localChanged = !sameField(localState, baseline);
  if (!repositoryChanged && !localChanged) return { action: 'unchanged' };
  if (repositoryChanged && !localChanged) return { action: 'update' };
  if (!repositoryChanged && localChanged) return { action: 'local-divergence' };
  if (sameField(localState, desired)) return { action: 'unchanged', rememberBaseline: true };
  return { action: 'conflict', reason: 'local and setup repository both changed since the last apply' };
}

function summarizeActions(actions: readonly string[]): PlanSettingAction {
  const priority: PlanSettingAction[] = ['conflict', 'collision', 'update', 'install', 'local-divergence', 'unchanged'];
  return priority.find((name) => actions.includes(name)) ?? 'unchanged';
}

// A managed settings file as read from disk. The `exists` discriminant makes
// the text nullability explicit for consumers (for example the rollback
// snapshots, which must restore a file body only when it existed).
export type SettingsFile =
  | { value: Record<string, unknown>; text: string; exists: true }
  | { value: Record<string, unknown>; text: null; exists: false };

export async function readSettingsFile(file: string): Promise<SettingsFile> {
  const readOnce = async (): Promise<SettingsFile> => {
    const info = await fs.lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Managed settings target must be a regular file: ${file}`);
    const text = await fs.readFile(file, 'utf8');
    let value;
    try { value = JSON.parse(text); } catch { throw new Error(`Managed settings file is not valid JSON: ${file}`); }
    if (!isRecord(value)) throw new Error(`Managed settings file must contain a JSON object: ${file}`);
    return { value, text, exists: true };
  };
  let error;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await readOnce();
    } catch (readError) {
      if (readError.code === 'ENOENT') return { value: {}, text: null, exists: false };
      error = readError;
      // Pi persists settings with an in-place write, so a concurrent read can
      // catch a partially written file for a few milliseconds. Retry once so a
      // transient torn read does not fail the whole operation; a file that is
      // genuinely invalid still fails on the second attempt.
      if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw error;
}

export async function buildPlan(repo: string, agentDir: string, declarations: RepositoryDeclarations, state: LocalState): Promise<ReconciliationPlan> {
  const resources: PlanResource[] = [];
  for (const item of declarations.resources) {
    const targetPath = resolveInside(agentDir, item.target, 'resource target');
    await ensureTargetParents(agentDir, item.target);
    const [snapshot, sourceSnapshot, localKind] = await Promise.all([safeSnapshot(targetPath), snapshotPath(item.sourcePath), kindOf(targetPath)]);
    const resource: PlanResource = { ...item, targetPath, localSnapshot: snapshot, snapshot: sourceSnapshot, kind: item.sourceKind, action: 'unchanged', files: [], kindMismatch: false, rememberBaseline: false };
    const decision = resourceAction(resource, snapshot, state.resources[item.target], localKind);
    resource.action = decision.action;
    resource.reason = decision.reason;
    resource.files = decision.files ?? [];
    resource.kindMismatch = decision.kindMismatch === true;
    resource.rememberBaseline = decision.rememberBaseline;
    resources.push(resource);
  }

  const settings: PlanSetting[] = [];
  for (const declaration of declarations.settings) {
    const targetPath = path.join(agentDir, declaration.target);
    const [file, info] = await Promise.all([readSettingsFile(targetPath), fs.lstat(agentDir).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)))]);
    if (info?.isSymbolicLink() || (info && !info.isDirectory())) throw new Error(`Pi agent directory must be a real directory: ${agentDir}`);
    const baselineForTarget = state.settings[declaration.target] ?? {};
    const fields: PlanSettingField[] = declaration.fields.map((field) => {
      const local = readManagedField(file.value, field.segments);
      const baseline = baselineForTarget[field.pointer];
      const decision: { action: PlanFieldAction; reason?: string; rememberBaseline?: boolean } = local.valid
        ? settingFieldAction(field, local, baseline)
        : { action: 'conflict', reason: 'managed setting path crosses a non-object value' };
      return { ...field, action: decision.action, reason: decision.reason, local, baseline, rememberBaseline: decision.rememberBaseline };
    });
    settings.push({ target: declaration.target, targetPath, fields, fileText: file.text, fileExists: file.exists, value: file.value, action: summarizeActions(fields.map((field) => field.action)) });
  }
  const declaredTargets = new Set(declarations.resources.map((item) => item.target));
  const stale: PlanStale[] = [];
  for (const [target, baseline] of Object.entries(state.resources)) {
    if (declaredTargets.has(target)) continue;
    validateRelativePath(target, 'stale resource target');
    if (!RESOURCE_TARGET_ROOTS.some((root) => target.startsWith(root)) || !isRecord(baseline) || !isRecord(baseline.files) || !Array.isArray(baseline.directories)) {
      throw new Error(`Local Pi Sync state contains an invalid stale resource baseline: ${target}`);
    }
    const overlaps = [...declaredTargets].filter((declaredTarget) => pathsOverlap(target, declaredTarget));
    const targetPath = resolveInside(agentDir, target, 'stale resource target');
    await ensureTargetParents(agentDir, target);
    const [localSnapshot, localKind] = await Promise.all([safeSnapshot(targetPath), kindOf(targetPath)]);
    const baselineKind = baseline.kind === 'file' ? 'file' : 'directory';
    const unchanged = localSnapshot === null || (localKind === baselineKind && sameValue(localSnapshot, { directories: baseline.directories, files: baseline.files }));
    stale.push({ target, targetPath, localSnapshot, overlaps, eligible: overlaps.length === 0 && unchanged,
      state: overlaps.length ? 'overlaps-current' : localSnapshot === null ? 'missing' : unchanged ? 'unchanged' : 'modified' });
  }
  return { resources, settings, stale };
}

export interface SyncableField { target: string; path: string; from: unknown; to: unknown; }
export interface SyncConflictField { target: string; path: string; action: PlanFieldAction; reason?: string; }
export interface SyncReviewField { target: string; path: string; reason: string; }

export interface SyncClassification {
  syncable: SyncableField[];
  conflicts: SyncConflictField[];
  rejected: SyncReviewField[];
  review: SyncReviewField[];
}

// Read-only sync classification shared by the `sync` preview/apply and the
// status/plan `sync` block, so every consumer sees identical content:
// syncable fields (local-only and portable, with from/to), conflicts (changed
// in both places or without a baseline), rejected (non-portable local
// values), and review (locally removed managed fields). No manifest write,
// no re-baseline, no lock.
export function syncClassification(plan: ReconciliationPlan): SyncClassification {
  const syncable: SyncableField[] = [];
  const conflicts: SyncConflictField[] = [];
  const rejected: SyncReviewField[] = [];
  const review: SyncReviewField[] = [];
  for (const item of plan.settings) {
    for (const field of item.fields) {
      if (field.action === 'local-divergence') {
        if (!field.local.exists) {
          review.push({ target: item.target, path: field.pointer, reason: 'managed setting was removed locally; update the setup manifest manually' });
          continue;
        }
        try {
          validatePortableSettingValue(field.local.value, `${item.target} ${field.pointer}`);
          syncable.push({ target: item.target, path: field.pointer, from: field.value, to: field.local.value });
        } catch (error) {
          rejected.push({ target: item.target, path: field.pointer, reason: error.message });
        }
      } else if (field.action === 'conflict' || field.action === 'collision') {
        conflicts.push({ target: item.target, path: field.pointer, action: field.action, ...(field.reason ? { reason: field.reason } : {}) });
      }
    }
  }
  return { syncable, conflicts, rejected, review };
}

export interface PlanOutputAction {
  type: string;
  target: string;
  action: string;
  reason?: string;
  files?: { path: string; action: string; reason?: string }[];
  fields?: { path: string; action: string; reason?: string }[];
  installed?: boolean;
  state?: StaleState;
  pruneAvailable?: boolean;
  overlaps?: string[];
}

export interface OutputActionSource {
  type?: string;
  target: string;
  action: string;
  reason?: string;
  files?: PlanFile[];
}

export function outputAction(item: OutputActionSource, key: 'target'): PlanOutputAction | null {
  if (item.action === 'unchanged') return null;
  const changedFiles = (item.files ?? []).filter((file) => file.action !== 'unchanged');
  return { type: item.type ?? 'setting', [key]: item[key], action: item.action, ...(item.reason ? { reason: item.reason } : {}),
    ...(changedFiles.length ? { files: changedFiles.map(({ path: file, action, reason }) => ({ path: file, action, ...(reason ? { reason } : {}) })) } : {}) };
}

export interface StaleReportItem {
  target: string;
  state: StaleState;
  installed: boolean;
  pruneAvailable: boolean;
  overlaps?: string[];
}

export interface ReportBlocks {
  actions: PlanOutputAction[];
  conflicts: PlanOutputAction[];
  staleResources: StaleReportItem[];
}

// Builds the reporting blocks (actions, conflicts, stale resources) from a
// plan; shared by the read-only status/plan workflow and apply so their
// reported content stays identical.
export function reportBlocks(plan: ReconciliationPlan): ReportBlocks {
  const actions: PlanOutputAction[] = [
    ...plan.resources.map((item) => outputAction(item, 'target')).filter((item): item is PlanOutputAction => item !== null),
    ...plan.settings.flatMap((item) => {
      const fields = item.fields.filter((field) => field.action !== 'unchanged');
      return fields.length ? [{ type: 'setting', target: item.target, action: item.action,
        fields: fields.map((field) => ({ path: field.pointer, action: field.action, ...(field.reason ? { reason: field.reason} : {}) })) }] : [];
    }),
    ...plan.stale.map((item) => ({ type: 'resource', target: item.target, action: 'stale', installed: item.localSnapshot !== null,
      state: item.state, pruneAvailable: item.overlaps.length === 0, ...(item.overlaps.length ? { overlaps: item.overlaps } : {}) })),
  ];
  const conflicts = actions.filter((item) => ['collision', 'conflict'].includes(item.action) || item.fields?.some((field) => ['collision', 'conflict'].includes(field.action)));
  const staleResources: StaleReportItem[] = plan.stale.map(({ target, state, localSnapshot, overlaps }) => ({ target, state,
    installed: localSnapshot !== null, pruneAvailable: overlaps.length === 0, ...(overlaps.length ? { overlaps } : {}) }));
  return { actions, conflicts, staleResources };
}

export interface PublishState {
  dirty: boolean;
  ahead: number | null;
  behind: number | null;
}

// Read-only publish state of the setup repository relative to its upstream,
// computed with the same git primitives the managed push uses: working-tree
// dirt from `git status --porcelain --untracked-files=no` (untracked files do
// not count: managed-only push never stages them, so they are not
// publishable changes) and ahead/behind from
// `git rev-list --left-right --count HEAD...@{upstream}`. Returns null when
// the setup directory is not the root of a git working tree (status still
// works in that case for manifest validation), and null ahead/behind when no
// upstream can be resolved (no remote, no upstream configured, detached HEAD,
// or an upstream ref that cannot be compared, such as an unfetched one).
export async function repositoryPublishState(repo: string): Promise<PublishState | null> {
  const top = await gitResult(repo, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) return null;
  if (path.resolve(top.output) !== path.resolve(repo)) return null;
  const dirty = await gitResult(repo, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty.status !== 0) throw new Error(`Could not inspect the setup repository working tree: ${dirty.errorText || `git exited ${dirty.status}`}`);
  let ahead: number | null = null;
  let behind: number | null = null;
  const upstream = await gitResult(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (upstream.status === 0) {
    const counts = await gitResult(repo, ['rev-list', '--left-right', '--count', `HEAD...${upstream.output}`]);
    if (counts.status === 0) {
      const [left, right] = counts.output.split(/\s+/).map(Number);
      if (Number.isInteger(left) && Number.isInteger(right)) { ahead = left; behind = right; }
    }
  }
  return { dirty: dirty.output.length > 0, ahead, behind };
}

export interface StatusSummary {
  localPending: number;
  remotePending: number;
  needsReview: number;
  clean: boolean;
}

// Derives the footer-ready summary from the reporting blocks. Counts follow
// the two-stage pipeline with no double counting (a change always lives in
// exactly one stage): syncable fields, working-tree dirt, and ahead commits
// are local-pending; behind commits and unapplied install/update actions are
// remote-pending; conflict/collision actions, rejected and locally removed
// fields, and locally diverged resources need review. syncable counts fields
// (the sync unit); review counts manifest items (actions).
export function deriveStatusSummary(publishState: PublishState | null, sync: SyncClassification, conflicts: PlanOutputAction[], actions: PlanOutputAction[]): StatusSummary {
  const localPending = sync.syncable.length + (publishState ? (publishState.dirty ? 1 : 0) + (publishState.ahead ?? 0) : 0);
  const remotePending = (publishState?.behind ?? 0) + actions.filter((item) => item.action === 'install' || item.action === 'update').length;
  const needsReview = conflicts.length + sync.rejected.length + sync.review.length +
    actions.filter((item) => item.type !== 'setting' && item.action === 'local-divergence').length;
  const clean = localPending === 0 && remotePending === 0 && needsReview === 0;
  return { localPending, remotePending, needsReview, clean };
}