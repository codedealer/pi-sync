import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateRelativePath, type ResourceDeclaration } from './manifest.js';

// Shared secret review and safe repository-side write primitives for the
// resource command workflows. Secret scanning never echoes the suspected
// value; the atomic writers guard against concurrent changes so a manifest
// or lockfile is never overwritten underneath a concurrent writer.

export interface SecretFinding {
  path: string;
  reason: string;
}

const CREDENTIAL_PATH_SEGMENTS = new Set(['auth.json', 'oauth.json', 'credentials.json', 'session.json', 'sessions', 'credentials', 'auth']);
const SECRET_PATTERNS: [string, RegExp][] = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i],
  // Keep the __placeholder__ exclusion in sync with SAFE_PLACEHOLDER below.
  ['credential assignment', /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?(?!your[_ -]|example|changeme|placeholder|__placeholder__)[A-Za-z0-9_./+=-]{12,}/i],
];

export function findLikelySecretsInText(text: string, relative: string): SecretFinding[] {
  return SECRET_PATTERNS.flatMap(([reason, pattern]) => pattern.test(text) ? [{ path: relative, reason }] : []);
}

async function scanFileForSecrets(file: string, relativePath: string, findings: SecretFinding[]) {
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

export async function findLikelySecrets(root: string, relative: string): Promise<SecretFinding[]> {
  const findings: SecretFinding[] = [];
  const info = await fs.lstat(root);
  if (info.isFile()) {
    await scanFileForSecrets(root, relative, findings);
    return findings;
  }
  async function visit(directory: string, display: string) {
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

// Test-only, environment-gated hold point for deterministic concurrency
// tests: while PI_SYNC_TEST_HOLD_BEFORE_COMPARE names an existing file, the
// atomic writer waits (bounded) after writing its temp file and before the
// before-rename comparison read, so a test can apply a concurrent change in
// that window without racing it (the temp file's appearance marks the
// window). It is never set outside tests, and the wait is capped so a stale
// marker cannot wedge the writer indefinitely.
async function holdForTestBeforeCompare() {
  const marker = process.env.PI_SYNC_TEST_HOLD_BEFORE_COMPARE;
  if (!marker) return;
  const deadline = Date.now() + 30000;
  for (;;) {
    const holding = await fs.access(marker).then(() => true, () => false);
    if (!holding || Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// Shared atomic, concurrency-guarded manifest and lockfile write: an
// exclusively created temp file whose sibling's text is compared before the
// rename, so a concurrent change is never overwritten. `operation` names the
// command performing the write (for example 'remove', 'add', or 'sync')
// so a concurrent-change failure reports the operation that was actually in
// flight, not a stale one.
export async function writeJsonFileAtomic(file: string, value: unknown, previousText: string, operation: string) {
  const info = await fs.stat(file);
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: info.mode & 0o777 });
    await holdForTestBeforeCompare();
    if (await fs.readFile(file, 'utf8') !== previousText) {
      throw new Error(`${path.basename(file)} changed during ${operation}; retry without overwriting concurrent changes`);
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
export async function restoreFileAtomic(file: string, text: string) {
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

// Per-type rules for the add workflow: the local installation
// root, the setup repository source root, the required content shape, and the
// source pattern expressed against the agent-relative local root.
export interface ResourceAddRule {
  localRoot: string;
  sourceRoot: string;
  shape: 'directory' | 'file' | 'any';
  label: string;
  suffix?: string;
  pattern: RegExp;
  patternError: string;
}

export const RESOURCE_ADD_RULES: Record<string, ResourceAddRule> = {
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
  workflow: { localRoot: 'workflows', sourceRoot: 'resources/workflows', shape: 'file', label: 'Workflow', suffix: '.js',
    pattern: /^workflows\/[A-Za-z0-9._-]+\.js$/, patternError: 'Workflow source must be a .js file directly under workflows/ (for example, workflows/octopus-loop.js)' },
};

// Normalizes an add --target value into an agent-relative POSIX path and
// validates it against the inferred type's target pattern.
export function normalizeResourceTarget(type: string, target: string, agentDir: string): string {
  const rule = RESOURCE_ADD_RULES[type];
  if (!rule) throw new Error(`Unsupported resource type: ${type}`);
  if (typeof target !== 'string' || target.length === 0) throw new Error('--target must be a non-empty path');
  let relative: string;
  if (path.isAbsolute(target)) {
    const absolute = path.resolve(target);
    relative = path.relative(agentDir, absolute).split(path.sep).join('/');
    if (relative === '' || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
      throw new Error('--target must identify a resource inside the Pi agent directory');
    }
  } else {
    if (target.includes('\\')) throw new Error('Relative --target paths must use POSIX separators');
    relative = target;
  }
  validateRelativePath(relative, '--target');
  if (!rule.pattern.test(relative)) throw new Error(rule.patternError.replace('source', 'target'));
  return relative;
}

export interface ResourceCandidate {
  type: string;
  source: string;
  target: string;
}

// Discovery for add --list and --all: candidates are the resources
// present directly under a type root that the manifest does not declare.
// The per-type shape rules are reused: .md files directly under the
// prompts/agents/roles roots, .js files directly under the workflows
// root, direct child directories under the skills root, and direct
// file-or-directory children under the extensions root.
// Files under any other path in resources/ are not resources and are
// ignored. Candidates are reported in RESOURCE_RULES type order and by
// name within a root, so --list and --all agree on the candidate set.
export async function unregisteredCandidates(repo: string, resources: ResourceDeclaration[], type?: string): Promise<ResourceCandidate[]> {
  const types = type ? [type] : Object.keys(RESOURCE_ADD_RULES);
  const candidates: ResourceCandidate[] = [];
  for (const candidateType of types) {
    const rule = RESOURCE_ADD_RULES[candidateType];
    const rootPath = path.join(repo, ...rule.sourceRoot.split('/'));
    let entries;
    try {
      entries = await fs.readdir(rootPath, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') continue; // a missing type root has no candidates
      throw error;
    }
    const names = entries
      .filter((entry) => {
        const isDirectory = entry.isDirectory();
        const isFile = entry.isFile();
        if (!isDirectory && !isFile) return false; // symbolic links and other entries are not resources
        if (rule.shape === 'directory') return isDirectory;
        if (rule.shape === 'file') return isFile && entry.name.endsWith(rule.suffix ?? '.md');
        return true;
      })
      .filter((entry) => rule.pattern.test(`${rule.localRoot}/${entry.name}`))
      .map((entry) => entry.name)
      .sort();
    for (const name of names) {
      const source = `${rule.sourceRoot}/${name}`;
      const target = `${rule.localRoot}/${name}`;
      if (resources.some((item) => item.source === source && item.target === target)) continue;
      candidates.push({ type: candidateType, source, target });
    }
  }
  return candidates;
}

// Walks a repository-relative directory path, creating missing real
// directories when `create` is set, and rejects symbolic links or
// non-directory components so resource writes never follow them.
export async function ensureRealDirectory(root: string, relative: string, create: boolean): Promise<boolean> {
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    let info = await fs.lstat(current).catch((error: any) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!info && create) {
      await fs.mkdir(current);
      info = await fs.lstat(current);
    }
    if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Error(`Repository path must contain only real directories: ${path.relative(root, current)}`);
    if (!info) return false;
  }
  return true;
}