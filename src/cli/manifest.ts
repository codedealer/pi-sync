import fs from 'node:fs/promises';
import path from 'node:path';
import { validateRequiredTools } from '../prerequisites.js';
import { validatePackageState } from '../packages.js';
// Re-exported from the core module, which owns the single `npm:`/`github:`
// identity and install-spec implementations; CLI command modules import them
// from here.
export { packageIdentity, packageSpec } from '../packages.js';

export const MANIFEST_FILE = 'pi-sync.json';
export const LOCK_FILE = 'pi-sync.lock.json';
// The repository EOL policy file. Pi Sync owns this file in the setup
// repository: it pins every text file to LF so the working tree matches the
// LF content the CLI writes directly (manifest, lockfile, bundles), keeping
// Git's stat-dirty detection and the managed push flow stable on Windows
// checkouts where core.autocrlf would otherwise expect CRLF.
export const GITATTRIBUTES_FILE = '.gitattributes';
export const GITATTRIBUTES_POLICY = '* text=auto eol=lf\n';

export const SETTINGS_FILES = new Set(['settings.json', 'models.json', 'keybindings.json', 'mcp.json']);

export type ResourceType = 'skill' | 'extension' | 'prompt' | 'agent' | 'role' | 'workflow';
export type SourceKind = 'file' | 'directory';

export interface ResourceRule {
  sourceRoot: string;
  targetRoot: string;
  label: string;
  shape: 'directory' | 'file' | 'any';
  suffix?: string;
}

export const RESOURCE_RULES: Record<string, ResourceRule> = {
  skill: { sourceRoot: 'resources/skills', targetRoot: 'skills', label: 'Skill', shape: 'directory' },
  extension: { sourceRoot: 'resources/extensions', targetRoot: 'extensions', label: 'Extension', shape: 'any' },
  prompt: { sourceRoot: 'resources/prompts', targetRoot: 'prompts', label: 'Prompt', shape: 'file', suffix: '.md' },
  agent: { sourceRoot: 'resources/agents', targetRoot: 'agents', label: 'Agent', shape: 'file', suffix: '.md' },
  role: { sourceRoot: 'resources/roles', targetRoot: 'roles', label: 'Role', shape: 'file', suffix: '.md' },
  workflow: { sourceRoot: 'resources/workflows', targetRoot: 'workflows', label: 'Workflow', shape: 'file', suffix: '.js' },
};
export const RESOURCE_TARGET_ROOTS = Object.values(RESOURCE_RULES).map((rule) => `${rule.targetRoot}/`);

export interface ResourceDeclaration {
  type: ResourceType;
  source: string;
  target: string;
  sourcePath: string;
  sourceKind: SourceKind;
}

export interface SettingsFieldDeclaration {
  pointer: string;
  segments: string[];
  value: unknown;
}

export interface SettingsDeclaration {
  target: string;
  fields: SettingsFieldDeclaration[];
}

export interface NpmPackage {
  type: 'npm';
  name: string;
  version: string;
  releasedAt: string;
}

export interface GithubPackage {
  type: 'github';
  repository: string;
  commit: string;
  tag: string;
  releasedAt: string;
}

export type LockPackage = NpmPackage | GithubPackage;

export interface LockFile {
  schemaVersion: 1;
  packages: LockPackage[];
}

export interface PackageState {
  declared: Set<string>;
  locked: Set<string>;
}

export interface RepositoryDeclarations {
  resources: ResourceDeclaration[];
  settings: SettingsDeclaration[];
  requiredTools: string[];
  lock: LockFile;
  packageState: PackageState;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function hasExactKeys(value: unknown, keys: readonly string[]) {
  return isRecord(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

export function validateRelativePath(value: unknown, label: string) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || path.posix.isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty relative POSIX path`);
  }
  const segments = value.split('/');
  if (segments.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`${label} must not contain empty, '.', or '..' path segments`);
  }
}

export function pathsOverlap(left: string, right: string) {
  // Treat target paths case-insensitively on every host so repositories remain
  // safe and portable when applied on Windows filesystems.
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  return normalizedLeft === normalizedRight || normalizedLeft.startsWith(`${normalizedRight}/`) || normalizedRight.startsWith(`${normalizedLeft}/`);
}

export function resolveInside(root: string, relative: string, label: string) {
  validateRelativePath(relative, label);
  const resolved = path.resolve(root, ...relative.split('/'));
  if (resolved === root || !(root === path.parse(root).root ? resolved.startsWith(root) : resolved.startsWith(`${root}${path.sep}`))) {
    throw new Error(`${label} must remain inside its root directory`);
  }
  return resolved;
}

export async function readJson(file: string, label: string, missingValue?: unknown): Promise<unknown> {
  let content;
  try {
    content = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' && missingValue !== undefined) return missingValue;
    if (error.code === 'ENOENT') throw new Error(`Missing ${label}: ${file}`);
    throw error;
  }
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

export async function validateSourceTree(repo: string, source: string, relative: string) {
  let component = repo;
  for (const segment of relative.split('/')) {
    component = path.join(component, segment);
    const info = await fs.lstat(component).catch(() => null);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Resource source must be an existing directory without symbolic-link path components: ${relative}`);
    }
  }
  async function visit(directory: string, displayPath: string) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not supported in resources: ${displayPath}/${entry.name}`);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') throw new Error(`Package-installed code is not managed content and is never imported: ${displayPath}/${entry.name}`);
        await visit(entryPath, `${displayPath}/${entry.name}`);
      } else if (!entry.isFile()) throw new Error(`Unsupported file type in resource: ${displayPath}/${entry.name}`);
    }
  }
  await visit(source, relative);
}

export async function validateSourceFile(root: string, relative: string) {
  const segments = relative.split('/');
  let component = root;
  for (let i = 0; i < segments.length; i++) {
    component = path.join(component, segments[i]);
    if (segments[i] === 'node_modules') throw new Error(`Package-installed code is not managed content and is never imported: ${relative}`);
    const info = await fs.lstat(component).catch(() => null);
    if (!info) throw new Error(`Resource source does not exist: ${relative}`);
    if (info.isSymbolicLink()) throw new Error(`Symbolic links are not supported in resources: ${relative}`);
    const isFinal = i === segments.length - 1;
    if (isFinal ? !info.isFile() : !info.isDirectory()) {
      throw new Error(`Resource source must be an existing regular file without symbolic-link path components: ${relative}`);
    }
  }
}

export async function validateResourceSource(repo: string, sourcePath: string, relative: string, rule: Pick<ResourceRule, 'shape'>): Promise<SourceKind> {
  if (rule.shape === 'file') {
    await validateSourceFile(repo, relative);
    return 'file';
  }
  if (rule.shape === 'any') {
    let info;
    try {
      info = await fs.lstat(sourcePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (!info) throw new Error(`Resource source does not exist: ${relative}`);
    if (info.isSymbolicLink()) throw new Error(`Symbolic links are not supported in resources: ${relative}`);
    if (info.isDirectory()) {
      await validateSourceTree(repo, sourcePath, relative);
      return 'directory';
    }
    if (info.isFile()) {
      await validateSourceFile(repo, relative);
      return 'file';
    }
    throw new Error(`Resource source must be a regular file or directory without symbolic links: ${relative}`);
  }
  await validateSourceTree(repo, sourcePath, relative);
  return 'directory';
}

const ENV_REFERENCE = /^\$[A-Za-z_][A-Za-z0-9_]*$|^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
// Safe literal for credential-like keys of providers that require no real API key
// (Pi's documented way to satisfy the mandatory apiKey field for local endpoints).
const SAFE_PLACEHOLDER = '__PLACEHOLDER__';
// LLM usage/limit parameters that contain "token" but never carry credentials.
const NON_CREDENTIAL_TOKEN_KEYS = new Set(['tokens', 'maxtokens', 'mintokens', 'tokencount', 'tokenlimit', 'numtokens']);

export function isCredentialLikeKey(normalized: string) {
  if (['apikey', 'password', 'passwd', 'secret', 'credential', 'privatekey'].some((part) => normalized.includes(part))) return true;
  if (normalized.includes('token')) return !NON_CREDENTIAL_TOKEN_KEYS.has(normalized);
  if (normalized.includes('auth')) return !normalized.startsWith('author');
  return false;
}

export function validatePortableSettingValue(value: unknown, label: string) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validatePortableSettingValue(item, `${label}[${index}]`));
  } else if (isRecord(value)) {
    for (const [key, nested] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (isCredentialLikeKey(normalized)) {
        if (typeof nested !== 'string' || !(nested === SAFE_PLACEHOLDER || ENV_REFERENCE.test(nested))) {
          throw new Error(`${label} contains a credential-like key (${key}); only a $NAME or ${'$'}{NAME} environment reference or the ${SAFE_PLACEHOLDER} placeholder may be managed`);
        }
        continue;
      }
      validatePortableSettingValue(nested, `${label}.${key}`);
    }
  }
}

export function decodePointer(pointer: unknown, label: string): string[] {
  if (typeof pointer !== 'string' || !pointer.startsWith('/') || pointer === '/') {
    throw new Error(`${label} must be a non-empty JSON Pointer (for example, /theme)`);
  }
  const segments = pointer.slice(1).split('/').map((part) => {
    if (/~(?![01])/.test(part)) throw new Error(`${label} contains an invalid JSON Pointer escape`);
    const decoded = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (['__proto__', 'prototype', 'constructor'].includes(decoded)) throw new Error(`${label} contains a prohibited object key`);
    return decoded;
  });
  return segments;
}

// Reads and validates the setup repository's manifest and lockfile. Parsed
// JSON is treated as unknown until these checks establish the normalized
// typed data returned to callers.
export async function validateRepository(repo: string, { allowMissingPins = false }: { allowMissingPins?: boolean } = {}): Promise<RepositoryDeclarations> {
  const manifest = await readJson(path.join(repo, MANIFEST_FILE), 'manifest');
  const allowedManifestKeys = ['schemaVersion', 'resources', 'dependencies'];
  if (Object.hasOwn((manifest ?? {}) as Record<string, unknown>, 'policy')) {
    allowedManifestKeys.push('policy');
    const policy = (manifest as { policy?: { minimumReleaseAgeDays?: unknown } }).policy;
    if (!hasExactKeys(policy, ['minimumReleaseAgeDays']) || !Number.isInteger(policy?.minimumReleaseAgeDays) || (policy as { minimumReleaseAgeDays: number }).minimumReleaseAgeDays < 7) {
      throw new Error('Manifest policy.minimumReleaseAgeDays must be an integer of at least seven days');
    }
  }
  if (Object.hasOwn((manifest ?? {}) as Record<string, unknown>, 'settings')) allowedManifestKeys.push('settings');
  if (Object.hasOwn((manifest ?? {}) as Record<string, unknown>, 'requiredTools')) allowedManifestKeys.push('requiredTools');
  if (!hasExactKeys(manifest, allowedManifestKeys) || (manifest as { schemaVersion?: unknown }).schemaVersion !== 1 ||
      !Array.isArray((manifest as { resources?: unknown }).resources) || !Array.isArray((manifest as { dependencies?: unknown }).dependencies) ||
      ((manifest as { settings?: unknown }).settings !== undefined && !Array.isArray((manifest as { settings?: unknown }).settings))) {
    throw new Error('Manifest must have schemaVersion 1, resources[], dependencies[], and optional settings[] and requiredTools[] only');
  }
  const requiredTools = validateRequiredTools((manifest as { requiredTools?: unknown[] }).requiredTools ?? []);

  const lock = await readJson(path.join(repo, LOCK_FILE), 'lockfile');
  const packageState = validatePackageState(manifest, lock, { allowMissingPins }) as PackageState;

  const resources: ResourceDeclaration[] = [];
  const targets = new Set<string>();
  const sources = new Set<string>();
  for (const [index, item] of ((manifest as { resources: unknown[] }).resources).entries()) {
    if (!hasExactKeys(item, ['type', 'source', 'target'])) throw new Error(`resources[${index}] must contain exactly type, source, and target`);
    const entry = item as { type: string; source: string; target: string };
    const rule = RESOURCE_RULES[entry.type];
    if (!rule) throw new Error(`Unsupported resource type in resources[${index}]: ${String(entry.type)}`);
    validateRelativePath(entry.source, `resources[${index}].source`);
    validateRelativePath(entry.target, `resources[${index}].target`);
    if (!entry.source.startsWith(`${rule.sourceRoot}/`) || !entry.target.startsWith(`${rule.targetRoot}/`)) {
      throw new Error(`${rule.label} resources must use ${rule.sourceRoot}/ sources and ${rule.targetRoot}/ targets (resources[${index}])`);
    }
    const sourceName = entry.source.slice(rule.sourceRoot.length + 1);
    const targetName = entry.target.slice(rule.targetRoot.length + 1);
    if (entry.type !== 'skill' && sourceName !== targetName) {
      throw new Error(`${rule.label} resource source and target must use the same name: ${entry.source} vs ${entry.target} (resources[${index}])`);
    }
    if (rule.shape === 'file') {
      if (targetName !== path.posix.basename(targetName) || !targetName.endsWith(rule.suffix!) || path.posix.basename(targetName).slice(0, -rule.suffix!.length).length === 0) {
        throw new Error(`${rule.label} resources must be a single ${rule.suffix} file directly under ${rule.targetRoot}/ (for example, ${rule.targetRoot}/example${rule.suffix}) (resources[${index}])`);
      }
    }
    if (targets.has(entry.target)) throw new Error(`Duplicate resource target: ${entry.target}`);
    for (const existingTarget of targets) {
      if (pathsOverlap(entry.target, existingTarget)) {
        throw new Error(`Overlapping resource targets: ${existingTarget} and ${entry.target}`);
      }
    }
    if (sources.has(entry.source)) throw new Error(`Duplicate resource source: ${entry.source}`);
    targets.add(entry.target);
    sources.add(entry.source);
    const sourcePath = resolveInside(repo, entry.source, `resources[${index}].source`);
    const sourceKind = await validateResourceSource(repo, sourcePath, entry.source, rule);
    resources.push({ type: entry.type as ResourceType, source: entry.source, target: entry.target, sourcePath, sourceKind });
  }

  const settings: SettingsDeclaration[] = [];
  const settingsTargets = new Set<string>();
  for (const [index, item] of (((manifest as { settings?: unknown[] }).settings) ?? []).entries()) {
    if (!hasExactKeys(item, ['target', 'fields']) || !SETTINGS_FILES.has((item as { target: string }).target) || !Array.isArray((item as { fields: unknown }).fields) || (item as { fields: unknown[] }).fields.length === 0) {
      throw new Error(`settings[${index}] must contain an allowed target and a non-empty fields[] array`);
    }
    const entry = item as { target: string; fields: unknown[] };
    if (settingsTargets.has(entry.target)) throw new Error(`Duplicate settings target: ${entry.target}`);
    settingsTargets.add(entry.target);
    const paths: string[][] = [];
    const fields: SettingsFieldDeclaration[] = [];
    for (const [fieldIndex, field] of entry.fields.entries()) {
      if (!hasExactKeys(field, ['path', 'value'])) throw new Error(`settings[${index}].fields[${fieldIndex}] must contain exactly path and value`);
      const fieldEntry = field as { path: string; value: unknown };
      const fieldLabel = `settings[${index}].fields[${fieldIndex}]`;
      const segments = decodePointer(fieldEntry.path, `${fieldLabel}.path`);
      validatePortableSettingValue(fieldEntry.value, `${fieldLabel}.value`);
      for (const segment of segments) {
        if (isCredentialLikeKey(segment.toLowerCase().replace(/[^a-z0-9]/g, ''))) {
          throw new Error(`${fieldLabel}.path contains a credential-like key`);
        }
      }
      if (paths.some((existing) => segments.slice(0, Math.min(existing.length, segments.length)).every((part, i) => part === existing[i]))) {
        throw new Error(`Overlapping or duplicate managed settings path: ${fieldEntry.path}`);
      }
      paths.push(segments);
      fields.push({ pointer: fieldEntry.path, segments, value: fieldEntry.value });
    }
    settings.push({ target: entry.target, fields });
  }
  return { resources, settings, requiredTools, lock: lock as LockFile, packageState };
}

export function packageRevision(item: LockPackage) { return item.type === 'npm' ? item.version : item.commit; }