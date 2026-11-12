#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectRequiredTools, validateRequiredTools } from './prerequisites.js';
import { discoverUpdates, installPinnedPackages, lockWithUpdates, rollbackPinnedPackages, validatePackageState, writeLockfile } from './packages.js';

const MANIFEST_FILE = 'pi-sync.json';
const LOCK_FILE = 'pi-sync.lock.json';
const STATE_DIR = '.pi-sync';
const STATE_FILE = 'state.json';
const VALIDATION_ERROR = 2;
const OPERATION_ERROR = 1;
const SETTINGS_FILES = new Set(['settings.json', 'models.json', 'keybindings.json', 'mcp.json']);
const RESOURCE_RULES = {
  skill: { sourceRoot: 'resources/skills', targetRoot: 'skills', label: 'Skill', shape: 'directory' },
  extension: { sourceRoot: 'resources/extensions', targetRoot: 'extensions', label: 'Extension', shape: 'any' },
  prompt: { sourceRoot: 'resources/prompts', targetRoot: 'prompts', label: 'Prompt', shape: 'file', suffix: '.md' },
  agent: { sourceRoot: 'resources/agents', targetRoot: 'agents', label: 'Agent', shape: 'file', suffix: '.md' },
  role: { sourceRoot: 'resources/roles', targetRoot: 'roles', label: 'Role', shape: 'file', suffix: '.md' },
};
const RESOURCE_TARGET_ROOTS = Object.values(RESOURCE_RULES).map((rule) => `${rule.targetRoot}/`);
const BUNDLED_SKILL = fileURLToPath(new URL('../resources/skills/pi-sync', import.meta.url));

function fail(error, code = VALIDATION_ERROR) {
  const command = process.argv[2] ?? null;
  const message = error instanceof Error ? error.message : String(error);
  const errorCode = error?.errorCode ?? (code === OPERATION_ERROR ? 'OPERATION_FAILED' : 'VALIDATION_ERROR');
  console.log(JSON.stringify({ apiVersion: 1, command, ok: false, error: message, errorCode,
    details: error?.details ?? { message }, exitCode: code }, null, 2));
  process.exitCode = code;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validateRelativePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || path.posix.isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty relative POSIX path`);
  }
  const segments = value.split('/');
  if (segments.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`${label} must not contain empty, '.', or '..' path segments`);
  }
}

function pathsOverlap(left, right) {
  // Treat target paths case-insensitively on every host so repositories remain
  // safe and portable when applied on Windows filesystems.
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  return normalizedLeft === normalizedRight || normalizedLeft.startsWith(`${normalizedRight}/`) || normalizedRight.startsWith(`${normalizedLeft}/`);
}

function resolveInside(root, relative, label) {
  validateRelativePath(relative, label);
  const resolved = path.resolve(root, ...relative.split('/'));
  if (resolved === root || !(root === path.parse(root).root ? resolved.startsWith(root) : resolved.startsWith(`${root}${path.sep}`))) {
    throw new Error(`${label} must remain inside its root directory`);
  }
  return resolved;
}

async function readJson(file, label, missingValue) {
  let content;
  try {
    content = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' && arguments.length === 3) return missingValue;
    if (error.code === 'ENOENT') throw new Error(`Missing ${label}: ${file}`);
    throw error;
  }
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

async function validateSourceTree(repo, source, relative) {
  let component = repo;
  for (const segment of relative.split('/')) {
    component = path.join(component, segment);
    const info = await fs.lstat(component).catch(() => null);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Resource source must be an existing directory without symbolic-link path components: ${relative}`);
    }
  }
  async function visit(directory, displayPath) {
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

async function validateSourceFile(root, relative) {
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

async function validateResourceSource(repo, sourcePath, relative, rule) {
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

const CREDENTIAL_PATH_SEGMENTS = new Set(['auth.json', 'oauth.json', 'credentials.json', 'session.json', 'sessions', 'credentials', 'auth']);
const SECRET_PATTERNS = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i],
  // Keep the __placeholder__ exclusion in sync with SAFE_PLACEHOLDER below.
  ['credential assignment', /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?(?!your[_ -]|example|changeme|placeholder|__placeholder__)[A-Za-z0-9_./+=-]{12,}/i],
];

function findLikelySecretsInText(text, relative) {
  return SECRET_PATTERNS.flatMap(([reason, pattern]) => pattern.test(text) ? [{ path: relative, reason }] : []);
}

async function scanFileForSecrets(file, relativePath, findings) {
  const name = path.posix.basename(relativePath);
  if (CREDENTIAL_PATH_SEGMENTS.has(name.toLowerCase())) {
    findings.push({ path: relativePath, reason: 'known credential-store path' });
    return;
  }
  if (/^(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|p12|pfx|key))$/i.test(name)) {
    findings.push({ path: relativePath, reason: 'sensitive filename' });
    return;
  }
  const bytes = await fs.readFile(file);
  if (bytes.includes(0)) return;
  findings.push(...findLikelySecretsInText(bytes.toString('utf8'), relativePath));
}

async function findLikelySecrets(root, relative) {
  const findings = [];
  const info = await fs.lstat(root);
  if (info.isFile()) {
    await scanFileForSecrets(root, relative, findings);
    return findings;
  }
  async function visit(directory, display) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const name = display ? `${display}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (CREDENTIAL_PATH_SEGMENTS.has(entry.name.toLowerCase())) {
          findings.push({ path: `${relative}/${name}`, reason: 'known credential-store path' });
        } else await visit(file, name);
      } else {
        await scanFileForSecrets(file, `${relative}/${name}`, findings);
      }
    }
  }
  await visit(root, '');
  return findings;
}

const ENV_REFERENCE = /^\$[A-Za-z_][A-Za-z0-9_]*$|^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
// Safe literal for credential-like keys of providers that require no real API key
// (Pi's documented way to satisfy the mandatory apiKey field for local endpoints).
const SAFE_PLACEHOLDER = '__PLACEHOLDER__';
// LLM usage/limit parameters that contain "token" but never carry credentials.
const NON_CREDENTIAL_TOKEN_KEYS = new Set(['tokens', 'maxtokens', 'mintokens', 'tokencount', 'tokenlimit', 'numtokens']);

function isCredentialLikeKey(normalized) {
  if (['apikey', 'password', 'passwd', 'secret', 'credential', 'privatekey'].some((part) => normalized.includes(part))) return true;
  if (normalized.includes('token')) return !NON_CREDENTIAL_TOKEN_KEYS.has(normalized);
  if (normalized.includes('auth')) return !normalized.startsWith('author');
  return false;
}

function validatePortableSettingValue(value, label) {
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

function decodePointer(pointer, label) {
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

async function validateRepository(repo, { allowMissingPins = false } = {}) {
  const manifest = await readJson(path.join(repo, MANIFEST_FILE), 'manifest');
  const allowedManifestKeys = ['schemaVersion', 'resources', 'dependencies'];
  if (Object.hasOwn(manifest ?? {}, 'policy')) {
    allowedManifestKeys.push('policy');
    if (!hasExactKeys(manifest.policy, ['minimumReleaseAgeDays']) || !Number.isInteger(manifest.policy.minimumReleaseAgeDays) || manifest.policy.minimumReleaseAgeDays < 7) {
      throw new Error('Manifest policy.minimumReleaseAgeDays must be an integer of at least seven days');
    }
  }
  if (Object.hasOwn(manifest ?? {}, 'settings')) allowedManifestKeys.push('settings');
  if (Object.hasOwn(manifest ?? {}, 'requiredTools')) allowedManifestKeys.push('requiredTools');
  if (!hasExactKeys(manifest, allowedManifestKeys) || manifest.schemaVersion !== 1 ||
      !Array.isArray(manifest.resources) || !Array.isArray(manifest.dependencies) ||
      (manifest.settings !== undefined && !Array.isArray(manifest.settings))) {
    throw new Error('Manifest must have schemaVersion 1, resources[], dependencies[], and optional settings[] and requiredTools[] only');
  }
  const requiredTools = validateRequiredTools(manifest.requiredTools ?? []);

  const lock = await readJson(path.join(repo, LOCK_FILE), 'lockfile');
  const packageState = validatePackageState(manifest, lock, { allowMissingPins });

  const resources = [];
  const targets = new Set();
  const sources = new Set();
  for (const [index, item] of manifest.resources.entries()) {
    if (!hasExactKeys(item, ['type', 'source', 'target'])) throw new Error(`resources[${index}] must contain exactly type, source, and target`);
    const rule = RESOURCE_RULES[item.type];
    if (!rule) throw new Error(`Unsupported resource type in resources[${index}]: ${String(item.type)}`);
    validateRelativePath(item.source, `resources[${index}].source`);
    validateRelativePath(item.target, `resources[${index}].target`);
    if (!item.source.startsWith(`${rule.sourceRoot}/`) || !item.target.startsWith(`${rule.targetRoot}/`)) {
      throw new Error(`${rule.label} resources must use ${rule.sourceRoot}/ sources and ${rule.targetRoot}/ targets (resources[${index}])`);
    }
    const sourceName = item.source.slice(rule.sourceRoot.length + 1);
    const targetName = item.target.slice(rule.targetRoot.length + 1);
    if (item.type !== 'skill' && sourceName !== targetName) {
      throw new Error(`${rule.label} resource source and target must use the same name: ${item.source} vs ${item.target} (resources[${index}])`);
    }
    if (rule.shape === 'file') {
      if (targetName !== path.posix.basename(targetName) || !targetName.endsWith(rule.suffix) || path.posix.basename(targetName).slice(0, -rule.suffix.length).length === 0) {
        throw new Error(`${rule.label} resources must be a single ${rule.suffix} file directly under ${rule.targetRoot}/ (for example, ${rule.targetRoot}/example${rule.suffix}) (resources[${index}])`);
      }
    }
    if (targets.has(item.target)) throw new Error(`Duplicate resource target: ${item.target}`);
    for (const existingTarget of targets) {
      if (pathsOverlap(item.target, existingTarget)) {
        throw new Error(`Overlapping resource targets: ${existingTarget} and ${item.target}`);
      }
    }
    if (sources.has(item.source)) throw new Error(`Duplicate resource source: ${item.source}`);
    targets.add(item.target);
    sources.add(item.source);
    const sourcePath = resolveInside(repo, item.source, `resources[${index}].source`);
    const sourceKind = await validateResourceSource(repo, sourcePath, item.source, rule);
    resources.push({ ...item, sourcePath, sourceKind });
  }

  const settings = [];
  const settingsTargets = new Set();
  for (const [index, item] of (manifest.settings ?? []).entries()) {
    if (!hasExactKeys(item, ['target', 'fields']) || !SETTINGS_FILES.has(item.target) || !Array.isArray(item.fields) || item.fields.length === 0) {
      throw new Error(`settings[${index}] must contain an allowed target and a non-empty fields[] array`);
    }
    if (settingsTargets.has(item.target)) throw new Error(`Duplicate settings target: ${item.target}`);
    settingsTargets.add(item.target);
    const paths = [];
    const fields = [];
    for (const [fieldIndex, field] of item.fields.entries()) {
      if (!hasExactKeys(field, ['path', 'value'])) throw new Error(`settings[${index}].fields[${fieldIndex}] must contain exactly path and value`);
      const fieldLabel = `settings[${index}].fields[${fieldIndex}]`;
      const segments = decodePointer(field.path, `${fieldLabel}.path`);
      validatePortableSettingValue(field.value, `${fieldLabel}.value`);
      for (const segment of segments) {
        if (isCredentialLikeKey(segment.toLowerCase().replace(/[^a-z0-9]/g, ''))) {
          throw new Error(`${fieldLabel}.path contains a credential-like key`);
        }
      }
      if (paths.some((existing) => segments.slice(0, Math.min(existing.length, segments.length)).every((part, i) => part === existing[i]))) {
        throw new Error(`Overlapping or duplicate managed settings path: ${field.path}`);
      }
      paths.push(segments);
      fields.push({ pointer: field.path, segments, value: field.value });
    }
    settings.push({ target: item.target, fields });
  }
  return { resources, settings, requiredTools, lock, packageState };
}

async function ensureRealDirectory(root, relative, create) {
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    let info = await fs.lstat(current).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!info && create) {
      await fs.mkdir(current);
      info = await fs.lstat(current);
    }
    if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Error(`Repository path must contain only real directories: ${path.relative(root, current)}`);
    if (!info) return false;
  }
  return true;
}

const RESOURCE_ADD_RULES = {
  skill: { localRoot: 'skills', sourceRoot: 'resources/skills', shape: 'directory', label: 'Skill',
    pattern: /^skills\/[A-Za-z0-9._-]+$/, patternError: 'Skill source must be a direct child directory of skills/ (for example, skills/example)' },
  extension: { localRoot: 'extensions', sourceRoot: 'resources/extensions', shape: 'any', label: 'Extension',
    pattern: /^extensions\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/, patternError: 'Extension source must be a file or directory under extensions/ (for example, extensions/github-copilot-usage or extensions/subagent/config.json)' },
  prompt: { localRoot: 'prompts', sourceRoot: 'resources/prompts', shape: 'file', label: 'Prompt',
    pattern: /^prompts\/[A-Za-z0-9._-]+\.md$/, patternError: 'Prompt source must be a .md file directly under prompts/ (for example, prompts/deploy.md)' },
  agent: { localRoot: 'agents', sourceRoot: 'resources/agents', shape: 'file', label: 'Agent',
    pattern: /^agents\/[A-Za-z0-9._-]+\.md$/, patternError: 'Agent source must be a .md file directly under agents/ (for example, agents/reviewer.md)' },
  role: { localRoot: 'roles', sourceRoot: 'resources/roles', shape: 'file', label: 'Role',
    pattern: /^roles\/[A-Za-z0-9._-]+\.md$/, patternError: 'Role source must be a .md file directly under roles/ (for example, roles/moderator.md)' },
};

function normalizeResourceSource(type, source, agentDir) {
  const rule = RESOURCE_ADD_RULES[type];
  if (!rule) throw new Error(`Unsupported resource type: ${type}`);
  if (typeof source !== 'string' || source.length === 0) throw new Error('--source must be a non-empty path');
  let relative;
  if (path.isAbsolute(source)) {
    const absolute = path.resolve(source);
    relative = path.relative(agentDir, absolute).split(path.sep).join('/');
    if (relative === '' || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
      throw new Error('--source must identify a resource inside the Pi agent directory');
    }
  } else {
    if (source.includes('\\')) throw new Error('Relative --source paths must use POSIX separators');
    relative = source;
  }
  validateRelativePath(relative, '--source');
  if (!rule.pattern.test(relative)) throw new Error(rule.patternError);
  return relative;
}

async function addDependency(repo, source) {
  const match = /^(npm):(.+)$/.exec(source) ?? /^(github):(.+)$/.exec(source);
  if (!match) throw new Error('Dependency source must be npm:PACKAGE or github:OWNER/REPOSITORY; Pi Sync resolves and writes the pin through update');
  const dependency = match[1] === 'npm' ? { type: 'npm', name: match[2] } : { type: 'github', repository: match[2] };
  if ((dependency.type === 'npm' && !/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(dependency.name)) ||
      (dependency.type === 'github' && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(dependency.repository))) {
    throw new Error('Dependency source has an invalid npm package name or GitHub owner/repository');
  }
  const manifestPath = path.join(repo, MANIFEST_FILE);
  const manifestText = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  const identity = dependency.type === 'npm' ? `npm:${dependency.name}` : `github:${dependency.repository}`;
  if (manifest.dependencies.some((item) => (item.type === 'npm' ? `npm:${item.name}` : `github:${item.repository}`) === identity)) {
    const error = new Error(`Dependency is already declared: ${identity}`);
    error.errorCode = 'DEPENDENCY_COLLISION';
    throw error;
  }
  const next = { ...manifest, dependencies: [...manifest.dependencies, dependency] };
  const temporary = `${manifestPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' });
  try {
    if (await fs.readFile(manifestPath, 'utf8') !== manifestText) throw new Error('Manifest changed during add; retry without overwriting concurrent changes');
    await fs.rename(temporary, manifestPath);
  } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
  return { apiVersion: 1, command: 'add', ok: true, exitCode: 0, type: 'dependency', dependency, action: 'added', next: 'Run pi-sync update to preview an age-eligible exact pin' };
}

async function addResource(repo, agentDir, type, source) {
  const rule = RESOURCE_ADD_RULES[type];
  const relative = normalizeResourceSource(type, source, agentDir);
  const sourcePath = resolveInside(agentDir, relative, '--source');
  const info = await fs.lstat(sourcePath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
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
    const error = new Error(`Resource collision: ${target} or ${managedSource} is already declared`);
    error.errorCode = 'RESOURCE_COLLISION';
    error.details = { type, source: relative, target, repositorySource: managedSource };
    throw error;
  }
  const destination = resolveInside(repo, managedSource, 'new resource source');
  if (await fs.lstat(destination).then(() => true).catch((error) => error.code === 'ENOENT' ? false : Promise.reject(error))) {
    const error = new Error(`Resource collision: setup repository path already exists: ${managedSource}`);
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

async function writeJsonFileAtomic(file, value, previousText) {
  const info = await fs.stat(file);
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: info.mode & 0o777 });
    if (await fs.readFile(file, 'utf8') !== previousText) {
      throw new Error(`${path.basename(file)} changed during remove; retry without overwriting concurrent changes`);
    }
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

// Restores a known previous file body through the same temp-file + rename
// pattern as the happy-path writes, so a mid-write failure can never leave
// the manifest or lockfile half-rewritten during a remove rollback.
async function restoreFileAtomic(file, text) {
  const info = await fs.stat(file);
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, text, { flag: 'wx', mode: info.mode & 0o777 });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

// Removal is repository-only by design: it deletes the manifest entry and the
// repository content, never touches the local Pi installation, and queues or
// schedules nothing for deletion. Removed resources surface as stale through
// the existing status/plan/apply reporting and stay installed until an
// explicit `prune --confirm` removes them (with its baseline-match and
// backup protections).
async function removeResource(repo, type, target) {
  const rule = RESOURCE_RULES[type];
  if (!rule) throw new Error(`Unsupported resource type: ${type}`);
  validateRelativePath(target, '--target');
  const declarations = await validateRepository(repo);
  const entry = declarations.resources.find((item) => item.target === target);
  if (!entry) {
    const error = new Error(`No managed resource with target ${target} is declared in the manifest; remove only entries declared in the manifest`);
    error.errorCode = 'REMOVE_TARGET_NOT_FOUND';
    throw error;
  }
  if (entry.type !== type) {
    const error = new Error(`Target ${target} is managed as ${entry.type}, not ${type}; use remove --type ${entry.type}`);
    error.errorCode = 'REMOVE_TYPE_MISMATCH';
    throw error;
  }
  const manifestPath = path.join(repo, MANIFEST_FILE);
  const manifestText = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  const nextManifest = { ...manifest, resources: manifest.resources.filter((item) => item.target !== target) };
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
    await writeJsonFileAtomic(manifestPath, nextManifest, manifestText);
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

async function removeDependency(repo, source, agentDir, uninstall) {
  const match = /^(npm):(.+)$/.exec(source) ?? /^(github):(.+)$/.exec(source);
  if (!match) throw new Error('Dependency source must be npm:PACKAGE or github:OWNER/REPOSITORY');
  const dependency = match[1] === 'npm' ? { type: 'npm', name: match[2] } : { type: 'github', repository: match[2] };
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
  if (!manifest.dependencies.some((item) => packageIdentity(item) === identity)) {
    const error = new Error(`Dependency is not declared in the manifest: ${identity}; remove only entries declared in the manifest`);
    error.errorCode = 'REMOVE_DEPENDENCY_NOT_FOUND';
    throw error;
  }
  const pin = declarations.lock.packages.find((item) => packageIdentity(item) === identity);
  if (!pin) {
    const error = new Error(`Dependency has no exact pin in the lockfile: ${identity}; resolve the lockfile before removing it`);
    error.errorCode = 'REMOVE_DEPENDENCY_NOT_PINNED';
    throw error;
  }
  // --uninstall also modifies the local package pin bookkeeping, so that
  // state must be readable and valid before any side effect. A corrupted
  // pin file fails the command up front, before the repository change or
  // the uninstall, instead of falsely failing after both have succeeded.
  let localPins = null;
  if (uninstall) {
    const pinsFile = path.join(agentDir, STATE_DIR, 'packages.json');
    const pinsInfo = await fs.lstat(pinsFile).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
    if (pinsInfo && pinsInfo.isFile()) localPins = await loadPackagePins(agentDir);
  }
  const nextManifest = { ...manifest, dependencies: manifest.dependencies.filter((item) => packageIdentity(item) !== identity) };
  const nextLock = { ...lock, packages: lock.packages.filter((item) => packageIdentity(item) !== identity) };
  let manifestWritten = false;
  let lockWritten = false;
  try {
    await writeJsonFileAtomic(manifestPath, nextManifest, manifestText);
    manifestWritten = true;
    await writeJsonFileAtomic(lockPath, nextLock, lockText);
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
  const spec = dependency.type === 'npm' ? `npm:${dependency.name}@${pin.version}` : `github:${dependency.repository}#${pin.commit}`;
  const output = { apiVersion: 1, command: 'remove', ok: true, exitCode: 0, repository: repo,
    removed: { dependency, pin },
    localInstallation: 'unchanged',
    note: 'Removal is repository-only: the package remains installed locally and nothing is queued or scheduled for deletion. Rerun with --uninstall to uninstall it explicitly.' };
  if (!uninstall) return output;
  // The repository change is complete at this point; an uninstall failure is
  // reported without rolling back or altering it.
  const uninstalled = await runCommand('pi', ['uninstall', spec]);
  if (uninstalled.status !== 0 || uninstalled.error) {
    const detail = uninstalled.error?.message ?? uninstalled.stderr.trim() ?? `Pi exited ${uninstalled.status}`;
    output.ok = false;
    output.exitCode = OPERATION_ERROR;
    output.errorCode = 'UNINSTALL_FAILED';
    output.error = `pi uninstall failed for ${spec}: ${detail}; the repository removal was completed and left in place`;
    output.details = { message: output.error, package: identity, spec };
    output.uninstall = { package: identity, spec, status: 'failed', error: detail };
    output.localInstallation = 'unchanged';
    output.note = 'The repository removal is in place, but the package is still installed locally; retry the uninstall when Pi can remove it.';
    return output;
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

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

async function snapshotTree(root) {
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return { invalidType: true };
  const snapshot = { directories: [], files: {} };
  async function visit(directory, relative) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not supported in managed targets: ${child}`);
      if (entry.isDirectory()) {
        snapshot.directories.push(child);
        await visit(entryPath, child);
      } else if (entry.isFile()) {
        const info = await fs.stat(entryPath);
        snapshot.files[child] = { content: (await fs.readFile(entryPath)).toString('base64'), mode: info.mode & 0o777 };
      } else throw new Error(`Unsupported file type in managed target: ${child}`);
    }
  }
  await visit(root, '');
  snapshot.directories.sort();
  return snapshot;
}

async function snapshotPath(root) {
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) return { invalidType: true };
  if (stat.isFile()) {
    const bytes = await fs.readFile(root);
    return { directories: [], files: { [path.basename(root)]: { content: bytes.toString('base64'), mode: stat.mode & 0o777 } } };
  }
  return snapshotTree(root);
}

async function kindOf(target) {
  const info = await fs.lstat(target).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  if (!info || info.isSymbolicLink()) return null;
  if (info.isFile()) return 'file';
  if (info.isDirectory()) return 'directory';
  return null;
}

async function safeSnapshot(root) {
  try { return await snapshotPath(root); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function ensureTargetParents(agentDir, relative) {
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

function statePaths(agentDir) {
  const directory = path.join(agentDir, STATE_DIR);
  return { directory, stateFile: path.join(directory, STATE_FILE), lockFile: path.join(directory, 'apply.lock'), backups: path.join(directory, 'backups') };
}

async function validateStateDirectory(directory) {
  try {
    const info = await fs.lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Pi Sync state path must be a real directory: ${directory}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function loadState(agentDir) {
  const { directory, stateFile } = statePaths(agentDir);
  await validateStateDirectory(directory);
  const state = await readJson(stateFile, 'local Pi Sync state', { schemaVersion: 1, resources: {}, settings: {} });
  if (!hasExactKeys(state, ['schemaVersion', 'resources', 'settings']) || state.schemaVersion !== 1 || !isRecord(state.resources) || !isRecord(state.settings)) {
    throw new Error(`Local Pi Sync state is invalid: ${stateFile}`);
  }
  return state;
}

async function writeState(agentDir, state) {
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

async function acquireLock(agentDir) {
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

function resourceFileAction(local, repository, baseline) {
  const repositoryChanged = !sameValue(repository, baseline);
  const localChanged = !sameValue(local, baseline);
  if (!repositoryChanged && !localChanged) return { action: 'unchanged' };
  if (repositoryChanged && !localChanged) return { action: repository === null ? 'delete' : 'update' };
  if (!repositoryChanged && localChanged) return { action: 'local-divergence' };
  if (sameValue(local, repository)) return { action: 'unchanged' };
  return { action: 'conflict', reason: 'local and setup repository both changed this file since the last apply' };
}

function resourceAction(resource, local, baseline, localKind) {
  if (!baseline) {
    if (local === null) return { action: 'install' };
    if (localKind === resource.kind && sameValue(local, resource.snapshot)) return { action: 'unchanged', rememberBaseline: true };
    return { action: 'collision', reason: 'target exists but is not tracked by Pi Sync' };
  }
  const names = new Set([...Object.keys(baseline.files ?? {}), ...Object.keys(local?.files ?? {}), ...Object.keys(resource.snapshot.files)]);
  const files = [...names].sort().map((relative) => ({
    path: relative,
    local: local?.files?.[relative] ?? null,
    repository: resource.snapshot.files[relative] ?? null,
    ...resourceFileAction(local?.files?.[relative] ?? null, resource.snapshot.files[relative] ?? null, baseline.files?.[relative] ?? null),
  }));
  // A tracked target must keep its managed kind. A replacement by the other
  // kind (even with identical content and mode) is reported immediately
  // instead of waiting for a repository change to surface it; apply refuses
  // to touch the target until it is resolved manually.
  if (localKind !== null && localKind !== resource.kind) {
    return { action: 'conflict', files, reason: `managed target changed type since the last apply (expected ${resource.kind}); resolve manually`, kindMismatch: true };
  }
  const fileActions = files.map((file) => file.action);
  let action = 'unchanged';
  if (fileActions.includes('conflict')) action = 'conflict';
  else if (fileActions.includes('update') || fileActions.includes('delete')) action = 'update';
  else if (fileActions.includes('local-divergence')) action = 'local-divergence';
  return { action, files, reason: action === 'conflict' ? 'local and setup repository both changed one or more files' : undefined };
}

function readManagedField(object, segments) {
  let current = object;
  for (const segment of segments) {
    if (!isRecord(current)) return { valid: false, exists: false };
    if (!Object.hasOwn(current, segment)) return { valid: true, exists: false };
    current = current[segment];
  }
  return { valid: true, exists: true, value: current };
}

function setManagedField(object, segments, value) {
  let current = object;
  for (const segment of segments.slice(0, -1)) {
    if (!Object.hasOwn(current, segment)) current[segment] = {};
    if (!isRecord(current[segment])) throw new Error(`Settings field parent is not an object: /${segments.join('/')}`);
    current = current[segment];
  }
  current[segments.at(-1)] = value;
}

function fieldState(value) {
  return value.exists ? { exists: true, value: value.value } : { exists: false };
}

function sameField(left, right) {
  return left?.exists === right?.exists && (!left?.exists || sameValue(left.value, right.value));
}

function settingFieldAction(field, local, baseline) {
  if (!baseline) {
    if (!local.exists) return { action: 'install' };
    if (sameValue(local.value, field.value)) return { action: 'unchanged', rememberBaseline: true };
    return { action: 'collision', reason: 'managed setting already exists but is not tracked by Pi Sync' };
  }
  const desired = { exists: true, value: field.value };
  const localState = fieldState(local);
  const repositoryChanged = !sameField(desired, baseline);
  const localChanged = !sameField(localState, baseline);
  if (!repositoryChanged && !localChanged) return { action: 'unchanged' };
  if (repositoryChanged && !localChanged) return { action: 'update' };
  if (!repositoryChanged && localChanged) return { action: 'local-divergence' };
  if (sameField(localState, desired)) return { action: 'unchanged', rememberBaseline: true };
  return { action: 'conflict', reason: 'local and setup repository both changed since the last apply' };
}

function summarizeActions(actions) {
  const priority = ['conflict', 'collision', 'update', 'install', 'local-divergence', 'unchanged'];
  return priority.find((name) => actions.includes(name)) ?? 'unchanged';
}

async function readSettingsFile(file) {
  try {
    const info = await fs.lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Managed settings target must be a regular file: ${file}`);
    const text = await fs.readFile(file, 'utf8');
    let value;
    try { value = JSON.parse(text); } catch { throw new Error(`Managed settings file is not valid JSON: ${file}`); }
    if (!isRecord(value)) throw new Error(`Managed settings file must contain a JSON object: ${file}`);
    return { value, text, exists: true };
  } catch (error) {
    if (error.code === 'ENOENT') return { value: {}, text: null, exists: false };
    throw error;
  }
}

async function buildPlan(repo, agentDir, declarations, state) {
  const resources = [];
  for (const item of declarations.resources) {
    const targetPath = resolveInside(agentDir, item.target, 'resource target');
    await ensureTargetParents(agentDir, item.target);
    const [snapshot, sourceSnapshot, localKind] = await Promise.all([safeSnapshot(targetPath), snapshotPath(item.sourcePath), kindOf(targetPath)]);
    const resource = { ...item, targetPath, localSnapshot: snapshot, snapshot: sourceSnapshot, kind: item.sourceKind };
    const decision = resourceAction(resource, snapshot, state.resources[item.target], localKind);
    resource.action = decision.action;
    resource.reason = decision.reason;
    resource.files = decision.files ?? [];
    resource.kindMismatch = decision.kindMismatch === true;
    resource.rememberBaseline = decision.rememberBaseline;
    resources.push(resource);
  }

  const settings = [];
  for (const declaration of declarations.settings) {
    const targetPath = path.join(agentDir, declaration.target);
    const [file, info] = await Promise.all([readSettingsFile(targetPath), fs.lstat(agentDir).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))]);
    if (info?.isSymbolicLink() || (info && !info.isDirectory())) throw new Error(`Pi agent directory must be a real directory: ${agentDir}`);
    const baselineForTarget = state.settings[declaration.target] ?? {};
    const fields = declaration.fields.map((field) => {
      const local = readManagedField(file.value, field.segments);
      const baseline = baselineForTarget[field.pointer];
      const decision = local.valid ? settingFieldAction(field, local, baseline) : { action: 'conflict', reason: 'managed setting path crosses a non-object value' };
      return { ...field, action: decision.action, reason: decision.reason, local, baseline, rememberBaseline: decision.rememberBaseline };
    });
    settings.push({ target: declaration.target, targetPath, fields, fileText: file.text, fileExists: file.exists, value: file.value, action: summarizeActions(fields.map((field) => field.action)) });
  }
  const declaredTargets = new Set(declarations.resources.map((item) => item.target));
  const stale = [];
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

function outputAction(item, key) {
  return { type: item.type ?? 'setting', [key]: item[key], action: item.action, ...(item.reason ? { reason: item.reason } : {}),
    ...(item.files?.length ? { files: item.files.map(({ path: file, action, reason }) => ({ path: file, action, ...(reason ? { reason } : {}) })) } : {}) };
}

async function createBackup(agentDir, relative, source, isDirectory) {
  const { backups } = statePaths(agentDir);
  const stamp = `${new Date().toISOString().replaceAll(':', '-')}-${crypto.randomBytes(4).toString('hex')}`;
  const destination = path.join(backups, stamp, ...relative.split('/'));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  if (isDirectory) await fs.cp(source, destination, { recursive: true, errorOnExist: true, force: false });
  else await fs.copyFile(source, destination);
  return destination;
}

async function materializeSnapshot(directory, snapshot) {
  await fs.mkdir(directory, { recursive: true });
  for (const relative of snapshot.directories) await fs.mkdir(path.join(directory, ...relative.split('/')), { recursive: true });
  for (const [relative, file] of Object.entries(snapshot.files)) {
    const destination = path.join(directory, ...relative.split('/'));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, Buffer.from(file.content, 'base64'), { mode: file.mode });
    await fs.chmod(destination, file.mode);
  }
}

async function replaceDirectory(target, desiredSnapshot, expectedSnapshot, relative) {
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

async function applyDirectory(agentDir, resource) {
  const current = await safeSnapshot(resource.targetPath);
  if (!sameValue(current, resource.localSnapshot)) throw new Error(`Managed resource changed during apply; refusing to overwrite: ${resource.target}`);
  if (current !== null) await createBackup(agentDir, resource.target, resource.targetPath, true);
  const sourceNow = await snapshotPath(resource.sourcePath);
  if (!sameValue(sourceNow, resource.snapshot)) throw new Error(`Setup resource changed during apply; retry: ${resource.target}`);
  const desired = structuredClone(current ?? { directories: [], files: {} });
  if (resource.action === 'install') desired.files = structuredClone(resource.snapshot.files);
  for (const file of resource.files ?? []) {
    if (file.action === 'update') desired.files[file.path] = file.repository;
    if (file.action === 'delete') delete desired.files[file.path];
  }
  const directories = new Set([...(desired.directories ?? []), ...resource.snapshot.directories]);
  desired.directories = [...directories].sort();
  await replaceDirectory(resource.targetPath, desired, current, resource.target);
}

async function applyFileResource(agentDir, resource) {
  const name = path.posix.basename(resource.target);
  const desiredFile = resource.action === 'install'
    ? resource.snapshot.files[name]
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

async function atomicSwapFile(target, prepared, relative) {
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

async function replaceFileResource(target, desiredFile, expectedSnapshot, relative) {
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

async function replaceFile(target, content, expectedText, relative) {
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

async function applySettings(agentDir, settings) {
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

async function pruneStale(agentDir, state, stale, confirmed) {
  const results = [];
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

async function loadPackagePins(agentDir) {
  const file = path.join(agentDir, STATE_DIR, 'packages.json');
  const value = await readJson(file, 'local package pin state', { schemaVersion: 1, packages: {} });
  if (!hasExactKeys(value, ['schemaVersion', 'packages']) || value.schemaVersion !== 1 || !isRecord(value.packages)) {
    throw new Error(`Local Pi Sync package state is invalid: ${file}`);
  }
  return value;
}

async function writeLocalPackagePins(agentDir, packages) {
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

async function savePackagePins(agentDir, lock) {
  const packages = Object.fromEntries(lock.packages.map((item) => [item.type === 'npm' ? `npm:${item.name}` : `github:${item.repository}`, item.type === 'npm' ? item.version : item.commit]));
  await writeLocalPackagePins(agentDir, packages);
}

function packageIdentity(item) { return item.type === 'npm' ? `npm:${item.name}` : `github:${item.repository}`; }
function packageRevision(item) { return item.type === 'npm' ? item.version : item.commit; }

async function captureRawFile(file) {
  try {
    const info = await fs.lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Transaction state must be a regular file: ${file}`);
    return { exists: true, content: await fs.readFile(file), mode: info.mode & 0o777 };
  } catch (error) { if (error.code === 'ENOENT') return { exists: false }; throw error; }
}

async function restoreRawFile(file, snapshot) {
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

async function captureManagedFilesystem(agentDir, resources, settings) {
  const resourceSnapshots = [];
  for (const resource of resources) resourceSnapshots.push({ target: resource.target, targetPath: resource.targetPath, kind: resource.kind, snapshot: await safeSnapshot(resource.targetPath) });
  const settingsSnapshots = [];
  for (const item of settings) {
    const file = item.targetPath;
    const current = await readSettingsFile(file);
    let mode = 0o600;
    if (current.exists) mode = (await fs.stat(file)).mode & 0o777;
    settingsSnapshots.push({ target: item.target, file, exists: current.exists, text: current.text, mode });
  }
  return { resourceSnapshots, settingsSnapshots };
}

async function restoreResourceSnapshot(agentDir, target, targetPath, kind, snapshot) {
  await ensureTargetParents(agentDir, target);
  if (snapshot === null) {
    await fs.rm(targetPath, { recursive: true, force: true });
    return;
  }
  if (snapshot.invalidType) throw new Error(`Cannot restore unsupported resource snapshot: ${target}`);
  if (kind === 'file') {
    const name = Object.keys(snapshot.files).find((file) => snapshot.files[file] !== undefined);
    const file = name ? snapshot.files[name] : null;
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
    for (const directory of snapshot.directories) await fs.mkdir(path.join(temporary, ...directory.split('/')), { recursive: true });
    for (const [relative, file] of Object.entries(snapshot.files)) {
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

async function restoreManagedFilesystem(agentDir, snapshots) {
  const errors = [];
  for (const item of [...snapshots.resourceSnapshots].reverse()) {
    try { await restoreResourceSnapshot(agentDir, item.target, item.targetPath, item.kind ?? 'directory', item.snapshot); }
    catch (error) { errors.push(`${item.target}: ${error.message}`); }
  }
  for (const item of [...snapshots.settingsSnapshots].reverse()) {
    try {
      await ensureTargetParents(agentDir, item.target);
      await restoreRawFile(item.file, { exists: item.exists, ...(item.exists ? { content: Buffer.from(item.text), mode: item.mode } : {}) });
    } catch (error) { errors.push(`${item.target}: ${error.message}`); }
  }
  return errors;
}

async function obtainFirstInstallApproval(lock, pins, explicitlyApproved) {
  for (const item of lock.packages) {
    if (Object.hasOwn(pins.packages, packageIdentity(item))) continue;
    if (explicitlyApproved) continue;
    const prompt = approvalPrompt(item);
    if (!prompt) {
      const error = new Error(`First-time installation requires explicit approval for ${packageIdentity(item)}; rerun with --approve`);
      error.errorCode = 'APPROVAL_REQUIRED';
      throw error;
    }
    if (!await prompt) {
      const error = new Error(`First-time installation approval was not granted for ${packageIdentity(item)}`);
      error.errorCode = 'APPROVAL_REQUIRED';
      throw error;
    }
  }
}

function approvalPrompt(item) {
  if (!process.stdin.isTTY) return null;
  return new Promise((resolve) => {
    process.stdout.write(`Install pinned Pi package ${item.type === 'npm' ? `npm:${item.name}@${item.version}` : `github:${item.repository}#${item.commit}`}? [y/N] `);
    process.stdin.resume();
    process.stdin.once('data', (data) => {
      process.stdin.pause();
      resolve(/^y(?:es)?\s*$/i.test(String(data).trim()));
    });
  });
}

function runCommand(executable, args, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ status: null, stdout, stderr, error }));
    child.on('close', (status) => resolve({ status, stdout, stderr, error: null }));
  });
}

function validateBootstrapUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n]/.test(value)) throw new Error('--repo-url must be a GitHub URL');
  const scp = /^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(value);
  if (scp) return { value, githubSlug: scp[1] };
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('--repo-url must be an HTTPS, SSH, or local file Git URL'); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('--repo-url must not contain credentials, query parameters, or fragments');
  if (parsed.protocol === 'file:') return { value, githubSlug: null };
  if (!['https:', 'ssh:'].includes(parsed.protocol) || parsed.hostname.toLowerCase() !== 'github.com') {
    throw new Error('--repo-url must use github.com (or a local file URL for testing)');
  }
  const slug = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) throw new Error('--repo-url must identify a GitHub owner/repository');
  return { value, githubSlug: slug };
}

function bootstrapResponse(ok, errorCode, error, extra = {}) {
  return { apiVersion: 1, command: 'bootstrap', ok, errorCode, error, exitCode: ok ? 0 : OPERATION_ERROR, ...extra };
}

async function installBundledSkill(repo) {
  const manifestPath = path.join(repo, MANIFEST_FILE);
  const manifestText = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  const declarations = await validateRepository(repo);
  const source = 'resources/skills/pi-sync';
  const target = 'skills/pi-sync';
  const exact = declarations.resources.some((item) => item.source === source && item.target === target);
  if (exact) return { ok: true, added: false };

  const collision = declarations.resources.find((item) => pathsOverlap(item.target, target) || pathsOverlap(item.source, source));
  if (collision) return { ok: false, collision: { source: collision.source, target: collision.target } };
  const sourcePath = path.join(repo, ...source.split('/'));
  const existingSource = await fs.lstat(sourcePath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (existingSource) return { ok: false, collision: { source, target, reason: 'setup repository source path already exists and is not declared as this resource' } };

  const bundled = await fs.lstat(BUNDLED_SKILL).catch((error) => { throw new Error(`Bundled pi-sync skill is unavailable: ${error.message}`); });
  if (bundled.isSymbolicLink() || !bundled.isDirectory()) throw new Error('Bundled pi-sync skill is not a real directory');
  await ensureRealDirectory(repo, 'resources/skills', true);
  await fs.mkdir(sourcePath);
  try {
    for (const entry of await fs.readdir(BUNDLED_SKILL)) {
      await fs.cp(path.join(BUNDLED_SKILL, entry), path.join(sourcePath, entry), { recursive: true, errorOnExist: true, force: false });
    }
    const nextManifest = { ...manifest, resources: [...manifest.resources, { type: 'skill', source, target }] };
    const temporary = `${manifestPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      const info = await fs.stat(manifestPath);
      await fs.writeFile(temporary, `${JSON.stringify(nextManifest, null, 2)}\n`, { flag: 'wx', mode: info.mode & 0o777 });
      if (await fs.readFile(manifestPath, 'utf8') !== manifestText) throw new Error('Setup manifest changed during bootstrap; refusing to overwrite concurrent changes');
      await fs.rename(temporary, manifestPath);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  } catch (error) {
    await fs.rm(sourcePath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  await validateRepository(repo);
  return { ok: true, added: true };
}

async function runPiSync(command, repo, agentDir) {
  const result = await runCommand(process.execPath, [fileURLToPath(import.meta.url), command, '--repo', repo, '--agent-dir', agentDir]);
  let output;
  try { output = JSON.parse(result.stdout); } catch {
    return { status: result.status ?? 1, output: { apiVersion: 1, command, ok: false, errorCode: 'CLI_FAILED',
      error: 'Pi Sync command returned no valid JSON output', exitCode: OPERATION_ERROR } };
  }
  return { status: result.status ?? output.exitCode ?? 1, output };
}

async function bootstrap(repoUrl, repoDir, agentDir, binDir) {
  const remote = validateBootstrapUrl(repoUrl);
  const destination = path.resolve(repoDir);
  const existing = await fs.lstat(destination).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing) return bootstrapResponse(false, 'REPOSITORY_PATH_COLLISION', 'Setup repository destination already exists; choose an empty path', { repository: destination });
  const access = await runCommand('git', ['ls-remote', remote.value]);
  let authenticationMethod = 'git';
  const bin = path.resolve(binDir ?? path.join(os.homedir(), '.local', 'bin'));
  if (access.status !== 0) {
    let ghAuthenticated = false;
    let ghAvailable = false;
    let prerequisiteResult = null;
    if (remote.githubSlug) {
      prerequisiteResult = await inspectRequiredTools(['gh'], { binDir: bin });
      ghAvailable = prerequisiteResult.ok;
      if (!ghAvailable) return bootstrapResponse(false, 'PREREQUISITE_INSTALL_REQUIRED',
        'GitHub CLI is required for this authentication handoff but could not be installed automatically.', {
          repository: destination, prerequisites: prerequisiteResult.tools,
          missingPrerequisites: prerequisiteResult.tools.filter((tool) => tool.status === 'failed'),
        });
      const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };
      const status = await runCommand('gh', ['auth', 'status', '--hostname', 'github.com'], env);
      ghAuthenticated = status.status === 0;
    }
    if (!ghAuthenticated) {
      const resumeArgs = ['bootstrap', '--repo-url', remote.value, '--repo-dir', destination, '--agent-dir', path.resolve(agentDir), '--bin-dir', bin];
      const ghTool = prerequisiteResult?.tools.find((tool) => tool.name === 'gh');
      const ghExecutable = ghTool?.installPath ?? 'gh';
      const authArgs = [ghExecutable, 'auth', 'login', '--hostname', 'github.com'];
      return bootstrapResponse(false, 'AUTH_REQUIRED', 'Private setup repository access is unavailable. Complete the GitHub authentication handoff, then resume bootstrap.', {
        repository: destination,
        prerequisites: prerequisiteResult?.tools ?? [],
        authentication: {
          required: true,
          cliAvailable: ghAvailable,
          command: authArgs.join(' '),
          commandArgs: authArgs,
          credentialHandling: 'Pi Sync does not request, print, or store credentials',
        },
        resumeArgs,
      });
    }
    authenticationMethod = 'github-cli';
  }
  const parent = path.dirname(destination);
  await fs.mkdir(parent, { recursive: true });
  const stagingRoot = await fs.mkdtemp(path.join(parent, '.pi-sync-bootstrap-'));
  const checkout = path.join(stagingRoot, 'checkout');
  try {
    const cloneEnv = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };
    const clone = authenticationMethod === 'git'
      ? await runCommand('git', ['clone', '--quiet', '--', remote.value, checkout], cloneEnv)
      : await runCommand('gh', ['repo', 'clone', remote.githubSlug, checkout], cloneEnv);
    if (clone.status !== 0) return bootstrapResponse(false, 'FETCH_FAILED',
      authenticationMethod === 'git' ? 'GitHub access was detected but cloning the setup repository failed' : 'GitHub CLI authentication was detected but it could not fetch the setup repository',
      { repository: destination });

    const setup = await validateRepository(checkout);
    const prerequisites = await inspectRequiredTools(setup.requiredTools, { binDir: bin });
    if (!prerequisites.ok) return bootstrapResponse(false, 'PREREQUISITE_INSTALL_REQUIRED',
      'One or more required setup tools are unavailable. Resolve the listed handoff before applying the setup.', {
        repository: destination, prerequisites: prerequisites.tools,
        missingPrerequisites: prerequisites.tools.filter((tool) => tool.status === 'failed'),
      });

    const declaration = await installBundledSkill(checkout);
    if (!declaration.ok) return bootstrapResponse(false, 'RESOURCE_COLLISION', 'The bundled pi-sync skill conflicts with existing setup repository content; no installation was performed', {
      repository: destination, collision: declaration.collision, skill: { source: 'resources/skills/pi-sync', target: 'skills/pi-sync' },
    });

    await validateRepository(checkout);
    const plan = await runPiSync('plan', checkout, path.resolve(agentDir));
    if (plan.status !== 0 || !plan.output.ok) {
      return bootstrapResponse(false, 'APPLY_CONFLICT', 'Bootstrap plan found a collision or conflict; existing local content was left untouched', {
        repository: destination, skill: { source: 'resources/skills/pi-sync', target: 'skills/pi-sync' }, plan: plan.output,
      });
    }
    if (await fs.lstat(destination).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))) {
      return bootstrapResponse(false, 'REPOSITORY_PATH_COLLISION', 'Setup repository destination appeared during bootstrap; no content was replaced', { repository: destination });
    }
    await fs.rename(checkout, destination);
    const applied = await runPiSync('apply', destination, path.resolve(agentDir));
    return bootstrapResponse(applied.status === 0 && applied.output.ok, applied.status === 0 && applied.output.ok ? undefined : 'APPLY_CONFLICT',
      applied.status === 0 && applied.output.ok ? undefined : 'Bootstrap apply did not complete cleanly; inspect the structured apply result and resume after resolving it', {
        repository: destination, authenticationMethod, prerequisites: prerequisites.tools,
        skill: { source: 'resources/skills/pi-sync', target: 'skills/pi-sync', action: declaration.added ? 'declared-and-applied' : 'applied' },
        apply: applied.output,
      });
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function gitFailure(message, details = {}) {
  const error = new Error(message);
  error.errorCode = 'PUSH_BLOCKED';
  error.details = { message, ...details };
  return error;
}

async function gitResult(repo, args, extraEnv = {}) {
  const result = await runCommand('git', ['-C', repo, ...args], { ...process.env, ...extraEnv });
  if (result.status !== 0) return { ...result, output: result.stdout.trim(), errorText: result.stderr.trim() };
  return { ...result, output: result.stdout.trim(), errorText: result.stderr.trim() };
}

async function requireGit(repo, args, message, extraEnv = {}) {
  const result = await gitResult(repo, args, extraEnv);
  if (result.status !== 0) throw gitFailure(message, { gitStatus: result.status });
  return result.output;
}

function managedGitPath(relative, resourceSources) {
  return relative === MANIFEST_FILE || relative === LOCK_FILE || resourceSources.some((source) => relative === source || relative.startsWith(`${source}/`));
}

// Returns the resource sources declared in the setup manifest at the given
// commit, or an empty list when that commit predates the manifest. Malformed
// manifests at ahead commits fail closed so they are reconciled manually.
async function managedSourcesAtCommit(repo, ref) {
  const listed = await gitResult(repo, ['ls-tree', ref, '--', MANIFEST_FILE]);
  if (listed.status !== 0) throw gitFailure('Could not inspect the setup manifest at an ahead commit; push stopped safely', { ref, gitStatus: listed.status });
  if (!listed.output) return [];
  const shown = await gitResult(repo, ['show', `${ref}:${MANIFEST_FILE}`]);
  if (shown.status !== 0) throw gitFailure('Could not read the setup manifest at an ahead commit; push stopped safely', { ref, gitStatus: shown.status });
  let manifest;
  try { manifest = JSON.parse(shown.output); } catch {
    throw gitFailure('The setup manifest at an ahead commit is not valid JSON; reconcile the branch manually before pushing', { ref });
  }
  if (!isRecord(manifest) || !Array.isArray(manifest.resources)) {
    throw gitFailure('The setup manifest at an ahead commit is malformed; reconcile the branch manually before pushing', { ref });
  }
  return manifest.resources.filter((item) => isRecord(item) && typeof item.source === 'string').map((item) => item.source);
}

function parseNameStatus(output) {
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const changes = [];
  for (let i = 0; i < fields.length; i += 2) changes.push({ status: fields[i], path: fields[i + 1] });
  return changes;
}

// Validates the repository state as of a single commit: the manifest and
// lockfile at that commit must form a valid, applyable setup repository and
// every declared resource source must exist in that commit's tree with the
// correct file/directory shape. This makes an intermediate ahead commit that
// leaves the repository broken (for example, managed content deleted without
// a matching manifest update) unpublishable even when a later commit repairs
// the state and HEAD itself validates. Commits that predate the manifest are
// accepted, mirroring managedSourcesAtCommit.
async function validateAheadCommitTree(repo, commit) {
  // -t includes directory entries: without it the recursive listing contains
  // only blobs, so a valid directory resource source would look missing.
  const treeResult = await gitResult(repo, ['ls-tree', '-r', '-t', '-z', commit]);
  if (treeResult.status !== 0) throw gitFailure('Could not inspect the tree of a local commit ahead of upstream; push stopped safely', { commit, gitStatus: treeResult.status });
  const tree = new Map();
  for (const entry of treeResult.stdout.split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const meta = entry.slice(0, tab).split(' ');
    tree.set(entry.slice(tab + 1), meta[0]);
  }
  if (!tree.has(MANIFEST_FILE)) return;
  if (!tree.has(LOCK_FILE)) throw gitFailure('The setup lockfile is missing at an ahead commit; reconcile the branch manually before pushing', { commit });
  const manifestText = (await gitResult(repo, ['show', `${commit}:${MANIFEST_FILE}`])).output;
  let manifest;
  try { manifest = JSON.parse(manifestText); } catch {
    throw gitFailure('The setup manifest at an ahead commit is not valid JSON; reconcile the branch manually before pushing', { commit });
  }
  if (!isRecord(manifest) || manifest.schemaVersion !== 1 || !Array.isArray(manifest.resources) || !Array.isArray(manifest.dependencies)) {
    throw gitFailure('The setup manifest at an ahead commit is invalid; reconcile the branch manually before pushing', { commit });
  }
  for (const [index, item] of manifest.resources.entries()) {
    if (!isRecord(item) || typeof item.type !== 'string' || typeof item.source !== 'string' || typeof item.target !== 'string') {
      throw gitFailure(`The setup manifest at an ahead commit has an invalid resource entry (resources[${index}]); reconcile the branch manually before pushing`, { commit });
    }
    const rule = RESOURCE_RULES[item.type];
    if (!rule) throw gitFailure(`The setup manifest at an ahead commit declares an unsupported resource type: ${item.type}`, { commit });
    const mode = tree.get(item.source);
    const isBlob = mode !== undefined && mode.startsWith('100');
    // A directory exists when the tree lists a directory entry at the exact
    // path, or when at least one blob lives under the path prefix.
    const isDirectory = mode === '040000' || [...tree.keys()].some((key) => key.startsWith(`${item.source}/`));
    if (!isBlob && !isDirectory) {
      throw gitFailure(`The setup manifest at an ahead commit declares a resource source that is missing from that commit's tree: ${item.source}`, { commit });
    }
    if (rule.shape === 'file' && !isBlob) throw gitFailure(`The resource source at an ahead commit must be a file: ${item.source}`, { commit });
    if (rule.shape === 'directory' && !isDirectory) throw gitFailure(`The resource source at an ahead commit must be a directory: ${item.source}`, { commit });
  }
  const lockText = (await gitResult(repo, ['show', `${commit}:${LOCK_FILE}`])).output;
  let lock;
  try { lock = JSON.parse(lockText); } catch {
    throw gitFailure('The setup lockfile at an ahead commit is not valid JSON; reconcile the branch manually before pushing', { commit });
  }
  if (!isRecord(lock) || lock.schemaVersion !== 1 || !Array.isArray(lock.packages)) {
    throw gitFailure('The setup lockfile at an ahead commit is invalid; reconcile the branch manually before pushing', { commit });
  }
  const dependencyIdentity = (item) => isRecord(item) && item.type === 'npm' && typeof item.name === 'string' ? `npm:${item.name}`
    : isRecord(item) && item.type === 'github' && typeof item.repository === 'string' ? `github:${item.repository}` : null;
  const declared = new Set();
  for (const [index, dep] of manifest.dependencies.entries()) {
    const identity = dependencyIdentity(dep);
    if (!identity || declared.has(identity)) {
      throw gitFailure(`The setup manifest at an ahead commit has an invalid or duplicate dependency (dependencies[${index}]); reconcile the branch manually before pushing`, { commit });
    }
    declared.add(identity);
  }
  const locked = new Set();
  for (const [index, item] of lock.packages.entries()) {
    const identity = dependencyIdentity(item);
    if (!identity || !declared.has(identity) || locked.has(identity)) {
      throw gitFailure(`The setup lockfile at an ahead commit does not match the declared dependencies (packages[${index}]); reconcile the branch manually before pushing`, { commit });
    }
    locked.add(identity);
  }
  const missing = [...declared].filter((key) => !locked.has(key));
  if (missing.length) throw gitFailure(`The setup lockfile at an ahead commit is missing exact pins for declared dependencies: ${missing.join(', ')}`, { commit });
}

async function managedPush(repo, declarations, publish = false) {
  const resourceSources = declarations.resources.map((item) => item.source);
  for (const managedFile of [MANIFEST_FILE, LOCK_FILE]) {
    const bytes = await fs.readFile(path.join(repo, managedFile));
    if (!bytes.includes(0)) {
      const findings = findLikelySecretsInText(bytes.toString('utf8'), managedFile);
      if (findings.length) throw gitFailure('Managed setup metadata contains suspected credential material; review and remove it before push', { reviewRequired: findings });
    }
  }
  for (const resource of declarations.resources) {
    const findings = await findLikelySecrets(resource.sourcePath, resource.source);
    if (findings.length) throw gitFailure('Managed resources contain suspected credential material; review and remove it before push', { reviewRequired: findings });
  }

  const top = await requireGit(repo, ['rev-parse', '--show-toplevel'], 'Push requires a Git working tree');
  if (path.resolve(top) !== path.resolve(repo)) throw gitFailure('The setup repository path must be the root of its Git working tree', { repository: repo, gitRoot: top });
  const branch = await requireGit(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 'Push requires a checked-out branch (detached HEAD is not supported)');
  const upstream = await requireGit(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], 'Push requires a configured upstream branch');
  const slash = upstream.indexOf('/');
  if (slash < 1 || slash === upstream.length - 1) throw gitFailure('The configured upstream branch could not be resolved', { upstream });
  const remote = upstream.slice(0, slash);

  const fetched = await gitResult(repo, ['fetch', '--quiet', remote]);
  if (fetched.status !== 0) throw gitFailure('Could not check the upstream branch; no commit or push was attempted', { upstream, gitStatus: fetched.status });
  const counts = await requireGit(repo, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`], 'Could not compare the local branch with its upstream');
  const [ahead, behind] = counts.split(/\s+/).map(Number);
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) throw gitFailure('Git returned an invalid upstream comparison', { upstream });
  if (behind > 0) throw gitFailure('The upstream has advanced; reconcile the remote changes before pushing (Pi Sync will not merge or rewrite history)', { upstream, ahead, behind });

  const allowed = (relative) => managedGitPath(relative, resourceSources);
  let existingAheadChanges = [];
  if (ahead > 0) {
    const commits = (await requireGit(repo, ['rev-list', '--reverse', `${upstream}..HEAD`], 'Could not inspect local commits ahead of upstream')).split(/\r?\n/).filter(Boolean);
    for (const commit of commits) {
      const parentFields = (await requireGit(repo, ['rev-list', '--parents', '-n', '1', commit], 'Could not inspect a local commit ahead of upstream')).trim().split(/\s+/);
      if (parentFields.length > 2) throw gitFailure('Merge commits ahead of upstream require manual reconciliation before pushing', { upstream, ahead, commit });
      const output = await requireGit(repo, ['diff-tree', '--root', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', commit], 'Could not inspect a local commit ahead of upstream');
      const paths = output.split('\0').filter(Boolean);
      if (!paths.length) throw gitFailure('An empty local commit is ahead of upstream; reconcile the branch before pushing', { upstream, ahead, commit });
      // Validate the commit against the manifest as of that commit, the
      // manifest before the commit (its parent), and the current managed set.
      // Together these cover commits that add, edit, or remove managed paths,
      // including removal commits whose deleted paths the current manifest no
      // longer manages, while genuinely unrelated paths still stop the push.
      const commitSources = await managedSourcesAtCommit(repo, commit);
      const parentSources = parentFields.length > 1 ? await managedSourcesAtCommit(repo, parentFields[1]) : [];
      const commitAllowed = (relative) => managedGitPath(relative, [...new Set([...resourceSources, ...commitSources, ...parentSources])]);
      const unrelated = paths.filter((item) => !commitAllowed(item));
      if (unrelated.length) throw gitFailure('The branch contains unrelated local commits; reconcile them before pushing', { upstream, ahead, commit, unrelatedPaths: unrelated });
      // The commit itself must be a valid repository state, not just a set of
      // managed paths: an intermediate commit that leaves the repository broken
      // (for example, managed content deleted without a manifest update) is
      // rejected even when a later commit repairs it.
      await validateAheadCommitTree(repo, commit);
      for (const item of paths) {
        const ignored = await gitResult(repo, ['check-ignore', '--no-index', '--quiet', '--', path.resolve(repo, ...item.split('/'))]);
        if (ignored.status === 0) throw gitFailure('A local commit contains an ignored path; reconcile it manually before pushing', { upstream, path: item, commit });
        if (ignored.status !== 1) throw gitFailure('Could not determine whether an ahead-commit path is ignored; push stopped safely', { path: item, commit });
      }
      existingAheadChanges.push(...paths.map((item) => ({ status: 'committed', path: item, commit })));
    }
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-push-index-'));
  const indexFile = path.join(tempDir, 'index');
  const hooksPath = path.join(tempDir, 'hooks');
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    await fs.mkdir(hooksPath);
    await requireGit(repo, ['read-tree', 'HEAD'], 'Could not prepare an isolated Git index', env);
    // A removal is published as a deletion of a previously managed path: the
    // current manifest no longer lists the source, but HEAD still does. Track
    // those sources separately so deletions of them can be staged, while
    // untracked content is still only accepted for currently managed paths.
    const headSources = await managedSourcesAtCommit(repo, 'HEAD');
    const removedSources = headSources.filter((source) => !resourceSources.includes(source));
    const removedSourcePath = (relative) => removedSources.some((source) => relative === source || relative.startsWith(`${source}/`));
    const pathspecs = [MANIFEST_FILE, LOCK_FILE, ...resourceSources, ...removedSources].map((item) => `:(top,literal)${item}`);
    const currentPathspecs = [MANIFEST_FILE, LOCK_FILE, ...resourceSources].map((item) => `:(top,literal)${item}`);
    const tracked = await requireGit(repo, ['ls-files', '--cached', '-z', '--', ...pathspecs], 'Could not enumerate managed files', env);
    const untracked = await requireGit(repo, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...currentPathspecs], 'Could not enumerate managed files', env);
    const candidates = [...new Set([...tracked.split('\0'), ...untracked.split('\0')].filter(Boolean))];
    const stage = [];
    for (const item of candidates) {
      if (!allowed(item) && !removedSourcePath(item)) continue;
      const ignored = await gitResult(repo, ['check-ignore', '--no-index', '--quiet', '--', path.resolve(repo, ...item.split('/'))]);
      if (ignored.status === 0) continue;
      if (ignored.status !== 1) throw gitFailure('Could not determine whether a managed file is ignored; push stopped safely', { path: item });
      stage.push(item);
    }
    for (const item of stage) await requireGit(repo, ['add', '--all', '--', `:(top,literal)${item}`], `Could not stage managed path: ${item}`, env);
    const staged = await requireGit(repo, ['diff', '--cached', '--name-status', '--no-renames', '-z'], 'Could not preview the isolated commit', env);
    let changes = parseNameStatus(staged);
    // Previously managed paths are publishable only as deletions; re-adding
    // content under a removed source without re-declaring it is not.
    const stagedAllowed = (item) => allowed(item.path) || (item.status === 'D' && removedSourcePath(item.path));
    const unrelated = changes.filter((item) => !stagedAllowed(item)).map((item) => item.path);
    if (unrelated.length) throw gitFailure('The isolated commit contains a path outside the managed allowlist', { unrelatedPaths: unrelated });
    changes = [...existingAheadChanges, ...changes];

    const cachedDiff = await gitResult(repo, ['diff', '--cached', '--quiet'], env);
    if (cachedDiff.status !== 0 && cachedDiff.status !== 1) throw gitFailure('Could not inspect staged managed changes', { gitStatus: cachedDiff.status });
    const commitRequired = cachedDiff.status === 1;
    const diffResult = await gitResult(repo, ['diff', '--cached', '--no-ext-diff', '--binary', upstream], env);
    if (diffResult.status !== 0) throw gitFailure('Could not render the managed-only commit preview', { gitStatus: diffResult.status });
    const patch = diffResult.stdout;
    const patchFindings = findLikelySecretsInText(patch, 'staged managed patch');
    if (patchFindings.length) throw gitFailure('Publishable managed changes contain suspected credential material; review and remove it before push', { reviewRequired: patchFindings });
    if (!publish) return { apiVersion: 1, command: 'push', ok: true, exitCode: 0, repository: repo, branch, upstream,
      mode: 'preview', changes, patch, commitRequired, publicationAuthorized: false,
      note: 'Only these managed paths can be committed; rerun with --publish to authorize commit and push.' };
    if (changes.length) process.stderr.write(`Pi Sync managed commit preview (before publication):\n${patch || '(no new working-tree diff; publishing already-committed managed changes)'}\n`);

    if (commitRequired) {
      const committedPaths = changes.filter((item) => item.status !== 'committed').map((item) => item.path);
      const commitResult = await gitResult(repo, ['-c', `core.hooksPath=${hooksPath}`, 'commit', '-m', 'pi-sync: publish managed setup'], env);
      if (commitResult.status !== 0) throw gitFailure('Could not create the managed-only commit; working-tree and index changes were preserved', { changes, gitStatus: commitResult.status });
      // The alternate index isolates unrelated staging. Rebase only the committed paths
      // in the user's index onto the new HEAD, leaving every unrelated staged change intact.
      for (const item of committedPaths) {
        const reset = await gitResult(repo, ['reset', '--quiet', 'HEAD', '--', `:(top,literal)${item}`]);
        if (reset.status !== 0) throw gitFailure('Managed commit was created, but the normal Git index could not be refreshed; no local changes were discarded', { changes, gitStatus: reset.status });
      }
    }
    if (!changes.length) return { apiVersion: 1, command: 'push', ok: true, exitCode: 0, repository: repo, branch, upstream,
      mode: 'published', changes: [], commit: null, note: 'No managed changes or managed-only commits were available to push.' };

    const pushed = await gitResult(repo, ['push', '--porcelain', remote, `HEAD:${upstream.slice(slash + 1)}`]);
    if (pushed.status !== 0) throw gitFailure('The ordinary fast-forward push was rejected; local managed changes and commits were preserved', {
      upstream, changes, gitStatus: pushed.status,
    });
    const commit = await requireGit(repo, ['rev-parse', 'HEAD'], 'Push succeeded but the local commit could not be identified');
    return { apiVersion: 1, command: 'push', ok: true, exitCode: 0, repository: repo, branch, upstream,
      mode: 'published', changes, patch, commit, forcePush: false };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  const command = process.argv[2];
  if (!['status', 'plan', 'apply', 'add', 'remove', 'prune', 'bootstrap', 'update', 'push'].includes(command)) {
    throw new Error('Usage: pi-sync <status|plan|apply|add|remove|prune|update|push|bootstrap> [--repo PATH] [--repo-url URL --repo-dir PATH] [--agent-dir PATH] [--type skill|extension|prompt|agent|role|dependency --target VALUE | --source VALUE] [--confirm] [--approve] [--apply] [--push] [--publish] [--uninstall]');
  }
  const options = { repo: process.cwd(), repoDir: path.join(os.homedir(), '.pi-sync', 'setup'), agentDir: process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'), binDir: path.join(os.homedir(), '.local', 'bin'), confirm: false, approve: false, applyUpdate: false, pushUpdate: false, publish: false, uninstall: false };
  for (let i = 3; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (['--repo', '--repo-url', '--repo-dir', '--agent-dir', '--bin-dir', '--type', '--source', '--target'].includes(arg)) {
      const value = process.argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--repo') options.repo = value;
      else if (arg === '--repo-url') options.repoUrl = value;
      else if (arg === '--repo-dir') options.repoDir = value;
      else if (arg === '--agent-dir') options.agentDir = value;
      else if (arg === '--bin-dir') options.binDir = value;
      else if (arg === '--type') options.type = value;
      else if (arg === '--target') options.target = value;
      else options.source = value;
    } else if (arg === '--confirm') options.confirm = true;
    else if (arg === '--approve') options.approve = true;
    else if (arg === '--apply') options.applyUpdate = true;
    else if (arg === '--push') options.pushUpdate = true;
    else if (arg === '--publish') options.publish = true;
    else if (arg === '--uninstall') options.uninstall = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.confirm && command !== 'prune') throw new Error('--confirm is only supported by prune');
  if (options.approve && !['apply', 'update'].includes(command)) throw new Error('--approve is only supported by apply or update');
  if (options.applyUpdate && command !== 'update') throw new Error('--apply is only supported by update');
  if (options.pushUpdate && command !== 'update') throw new Error('--push is only supported by update');
  if (options.pushUpdate && !options.applyUpdate) throw new Error('update --push requires --apply so package updates are explicitly approved');
  if (options.publish && command !== 'push') throw new Error('--publish is only supported by push');
  if (command === 'add' && (!options.type || !options.source)) throw new Error('add requires explicit --type and --source options');
  if (command === 'add' && !['skill', 'extension', 'prompt', 'agent', 'role', 'dependency'].includes(options.type)) throw new Error(`Unsupported resource type: ${options.type}`);
  if (command === 'remove' && !options.type) throw new Error('remove requires explicit --type and --target (or --source for dependencies)');
  if (command === 'remove' && !['skill', 'extension', 'prompt', 'agent', 'role', 'dependency'].includes(options.type)) throw new Error(`Unsupported resource type: ${options.type}`);
  if (command === 'remove' && options.type === 'dependency') {
    if (!options.source) throw new Error('remove --type dependency requires --source npm:PACKAGE or github:OWNER/REPOSITORY');
    if (options.target) throw new Error('--target is only supported for resource types; remove --type dependency uses --source');
  }
  if (command === 'remove' && options.type && options.type !== 'dependency') {
    if (!options.target) throw new Error('remove requires --target for resource types (for example, skills/NAME)');
    if (options.source) throw new Error('--source is only supported by remove --type dependency; resource removal uses --target');
  }
  if (options.uninstall && (command !== 'remove' || options.type !== 'dependency')) throw new Error('--uninstall is only supported by remove --type dependency');
  if (options.target !== undefined && !(command === 'remove' && options.type && options.type !== 'dependency')) throw new Error('--target is only supported by remove for resource types');
  if (command === 'bootstrap') {
    if (!options.repoUrl) throw new Error('bootstrap requires --repo-url');
    if (process.argv.includes('--repo')) throw new Error('bootstrap uses --repo-dir, not --repo');
    const output = await bootstrap(options.repoUrl, options.repoDir, options.agentDir, options.binDir);
    console.log(JSON.stringify(output, null, 2));
    if (!output.ok) process.exitCode = output.exitCode;
    return;
  }

  const repo = path.resolve(options.repo);
  const agentDir = path.resolve(options.agentDir);
  // remove tolerates missing pins up front so that removing an unpinned
  // dependency reaches its dedicated REMOVE_DEPENDENCY_NOT_PINNED error
  // instead of the generic repository validation failure. removeResource
  // keeps its own strict repository validation for resource removals.
  const declarations = await validateRepository(repo, { allowMissingPins: command === 'update' || command === 'remove' });
  if (command === 'push') {
    const output = await managedPush(repo, declarations, options.publish);
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  if (command === 'remove') {
    if (options.type === 'dependency') {
      const output = await removeDependency(repo, options.source, agentDir, options.uninstall);
      console.log(JSON.stringify(output, null, 2));
      if (!output.ok) process.exitCode = output.exitCode;
      return;
    }
    const output = await removeResource(repo, options.type, options.target);
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  let agentInfo = await fs.lstat(agentDir).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (agentInfo?.isSymbolicLink() || (agentInfo && !agentInfo.isDirectory())) throw new Error(`Pi agent directory must be a real directory: ${agentDir}`);
  if (command === 'add') {
    if (options.type === 'dependency') {
      const output = await addDependency(repo, options.source);
      console.log(JSON.stringify(output, null, 2));
      return;
    }
    if (!agentInfo) throw new Error(`Pi agent directory does not exist: ${agentDir}`);
    const output = await addResource(repo, agentDir, options.type, options.source);
    console.log(JSON.stringify(output, null, 2));
    if (output.error) process.exitCode = VALIDATION_ERROR;
    return;
  }
  if (command === 'update') {
    const manifest = await readJson(path.join(repo, MANIFEST_FILE), 'manifest');
    const updates = await discoverUpdates(manifest, declarations.lock);
    const minimumReleaseAgeDays = manifest.policy?.minimumReleaseAgeDays ?? 7;
    const nextLock = lockWithUpdates(declarations.lock, updates);
    if (!options.applyUpdate) {
      console.log(JSON.stringify({ apiVersion: 1, command, ok: true, exitCode: 0, repository: repo,
        minimumReleaseAgeDays, policySource: 'setup repository pi-sync.json', mode: 'preview', updates,
        proposedPins: nextLock.packages, note: 'No pins were changed and no package installation was performed.' }, null, 2));
      return;
    }
    if (!updates.length) {
      console.log(JSON.stringify({ apiVersion: 1, command, ok: true, exitCode: 0, repository: repo,
        minimumReleaseAgeDays, policySource: 'setup repository pi-sync.json', mode: 'applied', updates: [], pins: declarations.lock.packages,
        note: 'No eligible newer releases were found; no installs or pin changes were performed.' }, null, 2));
      return;
    }
    if (!agentInfo) { await fs.mkdir(agentDir, { recursive: true }); agentInfo = await fs.lstat(agentDir); }
    const releasePackageLock = await acquireLock(agentDir);
    try {
      const pins = await loadPackagePins(agentDir);
      await obtainFirstInstallApproval(nextLock, pins, options.approve);
      const lockPath = path.join(repo, LOCK_FILE);
      const packageStatePath = path.join(agentDir, STATE_DIR, 'packages.json');
      const lockBefore = await captureRawFile(lockPath);
      const packageStateBefore = await captureRawFile(packageStatePath);
      const installed = await installPinnedPackages(nextLock, { approved: true, previousPins: pins.packages });
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
      const push = options.pushUpdate ? await managedPush(repo, await validateRepository(repo), true) : undefined;
      console.log(JSON.stringify({ apiVersion: 1, command, ok: true, exitCode: 0, repository: repo,
        minimumReleaseAgeDays, policySource: 'setup repository pi-sync.json', mode: 'applied', updates,
        pins: nextLock.packages, installed, ...(push ? { push } : {}), dependencyModel: 'exact top-level pins; transitive dependency tree is controlled by Pi and is not locked by Pi Sync' }, null, 2));
    } finally { await releasePackageLock(); }
    return;
  }
  if (command === 'apply' && !agentInfo) {
    await fs.mkdir(agentDir, { recursive: true });
    agentInfo = await fs.lstat(agentDir);
    if (agentInfo.isSymbolicLink() || !agentInfo.isDirectory()) throw new Error(`Pi agent directory must be a real directory: ${agentDir}`);
  }
  const state = await loadState(agentDir);
  const releaseLock = command === 'apply' || (command === 'prune' && options.confirm) ? await acquireLock(agentDir) : null;
  try {
    const currentState = releaseLock ? await loadState(agentDir) : state;
    let packagePins = null;
    if (command === 'apply' && declarations.lock.packages.length > 0) {
      packagePins = await loadPackagePins(agentDir);
      await obtainFirstInstallApproval(declarations.lock, packagePins, options.approve);
    }
    const plan = await buildPlan(repo, agentDir, declarations, currentState);
    if (command === 'prune') {
      const staleResources = await pruneStale(agentDir, currentState, plan.stale, options.confirm);
      const ok = !staleResources.some((item) => ['modified', 'retained-modified', 'retained-overlap'].includes(item.action));
      console.log(JSON.stringify({ apiVersion: 1, command, ok, exitCode: ok ? 0 : OPERATION_ERROR, repository: repo, agentDirectory: agentDir,
        mode: options.confirm ? 'confirmed' : 'preview', staleResources }, null, 2));
      if (!ok) process.exitCode = OPERATION_ERROR;
      return;
    }
    const actions = [
      ...plan.resources.map((item) => outputAction(item, 'target')),
      ...plan.settings.map((item) => ({ type: 'setting', target: item.target, action: item.action,
        fields: item.fields.map((field) => ({ path: field.pointer, action: field.action, ...(field.reason ? { reason: field.reason } : {}) })) })),
      ...plan.stale.map((item) => ({ type: 'resource', target: item.target, action: 'stale', installed: item.localSnapshot !== null,
        state: item.state, pruneAvailable: item.overlaps.length === 0, ...(item.overlaps.length ? { overlaps: item.overlaps } : {}) })),
    ];
    const conflicts = actions.filter((item) => ['collision', 'conflict'].includes(item.action) || item.fields?.some((field) => ['collision', 'conflict'].includes(field.action)));
    const staleResources = plan.stale.map(({ target, state: staleState, localSnapshot, overlaps }) => ({ target, state: staleState,
      installed: localSnapshot !== null, pruneAvailable: overlaps.length === 0, ...(overlaps.length ? { overlaps } : {}) }));
    const output = { apiVersion: 1, command, ok: conflicts.length === 0, exitCode: conflicts.length ? OPERATION_ERROR : 0,
      repository: repo, agentDirectory: agentDir, actions, conflicts, staleResources,
      packages: declarations.lock.packages.map((item) => ({ package: packageIdentity(item), pin: packageRevision(item), action: command === 'apply' ? 'pinned-install' : 'locked' })),
      dependencyModel: 'exact top-level pins; Pi controls transitive dependencies, which Pi Sync does not lock or claim reproducible' };

    if (command === 'apply') {
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
          output.packageInstalls = await installPinnedPackages(declarations.lock, { approved: true, previousPins: packagePins?.packages ?? {} });
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
            fields: action.fields.map((field) => ['install', 'update'].includes(field.action)
              ? { ...field, action: field.action === 'install' ? 'installed' : 'updated' }
              : field),
          };
        }
        return ['install', 'update'].includes(action.action) ? { ...action, action: action.action === 'install' ? 'installed' : 'updated' } : action;
      });
    }
    console.log(JSON.stringify(output, null, 2));
    if (conflicts.length > 0) process.exitCode = OPERATION_ERROR;
  } finally {
    if (releaseLock) await releaseLock();
  }
}

main().catch((error) => fail(error, ['PACKAGE_INSTALL_FAILED', 'APPROVAL_REQUIRED', 'UPDATE_TRANSACTION_FAILED', 'PUSH_BLOCKED'].includes(error?.errorCode) || /update stopped closed|^(Another Pi Sync|A stale Pi Sync)/.test(error.message) ? OPERATION_ERROR : VALIDATION_ERROR));
