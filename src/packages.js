import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const MINIMUM_RELEASE_AGE_DAYS = 7;
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function run(executable, args) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ status: null, stdout, stderr, error }));
    child.on('close', (status) => resolve({ status, stdout, stderr, error: null }));
  });
}

export function validatePackageState(manifest, lock, { allowMissingPins = false } = {}) {
  if (!Array.isArray(manifest.dependencies) || !exactKeys(lock, ['schemaVersion', 'packages']) || lock.schemaVersion !== 1 || !Array.isArray(lock.packages)) {
    throw new Error('Manifest dependencies and lockfile packages must be arrays (lockfile schemaVersion must be 1)');
  }
  const keys = new Set();
  for (const [index, dep] of manifest.dependencies.entries()) {
    if (exactKeys(dep, ['type', 'name']) && dep.type === 'npm' && typeof dep.name === 'string' && /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(dep.name)) {
      if (keys.has(`npm:${dep.name}`)) throw new Error(`Duplicate dependency: npm:${dep.name}`);
      keys.add(`npm:${dep.name}`);
    } else if (exactKeys(dep, ['type', 'repository']) && dep.type === 'github' && typeof dep.repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(dep.repository)) {
      if (keys.has(`github:${dep.repository}`)) throw new Error(`Duplicate dependency: github:${dep.repository}`);
      keys.add(`github:${dep.repository}`);
    } else throw new Error(`dependencies[${index}] must be {type:"npm",name} or {type:"github",repository}`);
  }
  const locked = new Set();
  for (const [index, item] of lock.packages.entries()) {
    const key = item?.type === 'npm' ? `npm:${item.name}` : item?.type === 'github' ? `github:${item.repository}` : null;
    if (!key || !keys.has(key) || locked.has(key)) throw new Error(`lockfile packages[${index}] does not match exactly one declared dependency`);
    if (item.type === 'npm') {
      if (!exactKeys(item, ['type', 'name', 'version', 'releasedAt']) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(item.version) || !validDate(item.releasedAt)) throw new Error(`lockfile npm package ${item.name} requires an exact version and trustworthy releasedAt timestamp`);
    } else if (!exactKeys(item, ['type', 'repository', 'commit', 'tag', 'releasedAt']) || !/^[0-9a-f]{40}$/i.test(item.commit) || typeof item.tag !== 'string' || item.tag.length === 0 || !validDate(item.releasedAt)) {
      throw new Error(`lockfile GitHub package ${item.repository} requires an immutable 40-character commit, tag, and trustworthy releasedAt timestamp`);
    }
    locked.add(key);
  }
  const missing = [...keys].filter((key) => !locked.has(key));
  if (missing.length && !allowMissingPins) throw new Error(`lockfile is missing exact pins for declared dependencies: ${missing.join(', ')}`);
  return { declared: keys, locked };
}

function validDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function packageKey(item) { return item.type === 'npm' ? `npm:${item.name}` : `github:${item.repository}`; }
function spec(item) { return item.type === 'npm' ? `npm:${item.name}@${item.version}` : `github:${item.repository}#${item.commit}`; }
function parseJson(output, source) {
  try { return JSON.parse(output); } catch { throw new Error(`${source} metadata was not valid JSON; update stopped closed`); }
}
function compareVersions(a, b) {
  const left = a.split('+', 1)[0].split(/[.-]/).map((part) => /^\d+$/.test(part) ? Number(part) : part);
  const right = b.split('+', 1)[0].split(/[.-]/).map((part) => /^\d+$/.test(part) ? Number(part) : part);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] === undefined) return right[i] === undefined ? 0 : (typeof right[i] === 'number' ? -1 : 1);
    if (right[i] === undefined) return typeof left[i] === 'number' ? 1 : -1;
    if (left[i] === right[i]) continue;
    if (typeof left[i] === 'number' && typeof right[i] === 'number') return left[i] - right[i];
    return String(left[i]).localeCompare(String(right[i]));
  }
  return 0;
}

async function npmCandidate(dep, current, eligible) {
  const [versionsResult, timesResult] = await Promise.all([
    run('npm', ['view', dep.name, 'versions', '--json']), run('npm', ['view', dep.name, 'time', '--json']),
  ]);
  if (versionsResult.status !== 0 || timesResult.status !== 0) throw new Error(`Could not retrieve npm release metadata for ${dep.name}; update stopped closed`);
  let versions = parseJson(versionsResult.stdout, `npm ${dep.name} versions`);
  const times = parseJson(timesResult.stdout, `npm ${dep.name} timestamps`);
  if (typeof versions === 'string') versions = [versions];
  if (!Array.isArray(versions) || !times || typeof times !== 'object') throw new Error(`npm release metadata for ${dep.name} is incomplete; update stopped closed`);
  if (versions.some((version) => typeof version !== 'string' || !validDate(times[version]))) throw new Error(`npm release timestamps for ${dep.name} are incomplete; update stopped closed`);
  const candidates = versions.filter((version) => eligible(times[version])).sort(compareVersions);
  const selected = candidates.at(-1);
  if (!selected || (current && compareVersions(selected, current.version) <= 0)) return null;
  return { type: 'npm', name: dep.name, version: selected, releasedAt: new Date(Date.parse(times[selected])).toISOString() };
}

async function githubCandidate(dep, current, eligible) {
  const releasesResult = await run('gh', ['api', `repos/${dep.repository}/releases?per_page=100`]);
  if (releasesResult.status !== 0) throw new Error(`Could not retrieve GitHub release metadata for ${dep.repository}; update stopped closed`);
  const releases = parseJson(releasesResult.stdout, `GitHub ${dep.repository} releases`);
  if (!Array.isArray(releases) || releases.length >= 100) throw new Error(`GitHub release metadata for ${dep.repository} is incomplete or possibly truncated; update stopped closed`);
  const publishedReleases = releases.filter((release) => release && !release.draft && !release.prerelease);
  if (publishedReleases.some((release) => typeof release.tag_name !== 'string' || release.tag_name.length === 0 || !validDate(release.published_at))) {
    throw new Error(`GitHub release tags or timestamps for ${dep.repository} are incomplete; update stopped closed`);
  }
  const candidates = publishedReleases.filter((release) => eligible(release.published_at))
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
  const release = candidates[0];
  if (!release || (current && (release.tag_name === current.tag || (validDate(current.releasedAt) && Date.parse(release.published_at) <= Date.parse(current.releasedAt))))) return null;
  const remote = `https://github.com/${dep.repository}.git`;
  const refs = await run('git', ['ls-remote', remote, `refs/tags/${release.tag_name}`, `refs/tags/${release.tag_name}^{}`]);
  if (refs.status !== 0) throw new Error(`Could not resolve immutable GitHub tag ${release.tag_name} for ${dep.repository}; update stopped closed`);
  const refLines = refs.stdout.trim().split(/\r?\n/).map((line) => /^([0-9a-f]{40})\s+(\S+)$/.exec(line)).filter(Boolean);
  const peeledRef = `refs/tags/${release.tag_name}^{}`;
  const exactRef = `refs/tags/${release.tag_name}`;
  const commit = refLines.find(([, , ref]) => ref === peeledRef)?.[1] ?? refLines.find(([, , ref]) => ref === exactRef)?.[1];
  if (!commit) throw new Error(`GitHub tag ${release.tag_name} for ${dep.repository} has no resolvable commit SHA; update stopped closed`);
  return { type: 'github', repository: dep.repository, commit, tag: release.tag_name, releasedAt: new Date(Date.parse(release.published_at)).toISOString() };
}

export async function discoverUpdates(manifest, lock, now = Date.now()) {
  const minimumReleaseAgeDays = manifest.policy?.minimumReleaseAgeDays ?? MINIMUM_RELEASE_AGE_DAYS;
  if (!Number.isInteger(minimumReleaseAgeDays) || minimumReleaseAgeDays < MINIMUM_RELEASE_AGE_DAYS) throw new Error('Repository policy minimumReleaseAgeDays must be an integer of at least seven days');
  const ageCutoffMs = minimumReleaseAgeDays * 24 * 60 * 60 * 1000;
  const eligible = (date) => validDate(date) && now - Date.parse(date) >= ageCutoffMs;
  const current = new Map(lock.packages.map((item) => [packageKey(item), item]));
  const updates = [];
  for (const dep of manifest.dependencies) {
    const old = current.get(packageKey(dep));
    const next = dep.type === 'npm' ? await npmCandidate(dep, old, eligible) : await githubCandidate(dep, old, eligible);
    if (next && (!old || packageKey(next) === packageKey(old))) updates.push({ from: old ?? null, to: next, installSpec: spec(next) });
  }
  return updates;
}

function previousSpec(key, revision) {
  if (key.startsWith('npm:')) return `npm:${key.slice(4)}@${revision}`;
  return `github:${key.slice(7)}#${revision}`;
}

export async function rollbackPinnedPackages(items, previousPins = {}) {
  const errors = [];
  for (const item of [...items].reverse()) {
    const key = packageKey(item);
    const previous = previousPins[key];
    const result = previous === undefined
      ? await run('pi', ['uninstall', spec(item)])
      : await run('pi', ['install', previousSpec(key, previous)]);
    if (result.status !== 0) errors.push({ package: key, action: previous === undefined ? 'uninstall' : 'restore-pin',
      error: result.error?.message ?? result.stderr.trim() ?? `Pi exited ${result.status}` });
  }
  return errors;
}

export async function installPinnedPackages(lock, { approved = false, prompt = null, approvalRequired = () => true, previousPins = {} } = {}) {
  const results = [];
  const attempted = [];
  for (const item of lock.packages) {
    if (approvalRequired(item) && !approved && prompt && !await prompt(item)) throw Object.assign(new Error(`First-time installation approval was not granted for ${packageKey(item)}`), { errorCode: 'APPROVAL_REQUIRED' });
    if (approvalRequired(item) && !approved && !prompt) throw Object.assign(new Error(`First-time installation requires explicit approval for ${packageKey(item)}; rerun with --approve`), { errorCode: 'APPROVAL_REQUIRED' });
    attempted.push(item);
    const result = await run('pi', ['install', spec(item)]);
    if (result.status !== 0) {
      const rollbackErrors = await rollbackPinnedPackages(attempted, previousPins);
      const error = Object.assign(new Error(`Pi package installation failed for ${packageKey(item)} at recorded pin ${spec(item)}${result.stderr ? `: ${result.stderr.trim()}` : ''}${rollbackErrors.length ? '; package rollback was incomplete' : '; previously installed package pins were restored'}`), {
        errorCode: 'PACKAGE_INSTALL_FAILED', packagesRolledBack: true,
      });
      if (rollbackErrors.length) error.details = { message: error.message, rollbackErrors };
      throw error;
    }
    results.push({ package: packageKey(item), pin: spec(item), action: 'installed' });
  }
  return results;
}

export async function writeLockfile(repo, lock) {
  const file = path.join(repo, 'pi-sync.lock.json');
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(lock, null, 2)}\n`, { flag: 'wx' });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export function lockWithUpdates(lock, updates) {
  const next = structuredClone(lock);
  for (const update of updates) {
    const key = packageKey(update.to);
    const index = next.packages.findIndex((item) => packageKey(item) === key);
    if (index < 0) next.packages.push(update.to); else next.packages[index] = update.to;
  }
  next.packages.sort((a, b) => packageKey(a).localeCompare(packageKey(b)));
  return next;
}
