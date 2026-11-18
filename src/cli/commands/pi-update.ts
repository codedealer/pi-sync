import fs from 'node:fs/promises';
import path from 'node:path';

import { acquireLock } from '../local-state.js';
import { runCommand } from '../process.js';

const PACKAGE_NAME = '@mariozechner/pi-coding-agent';
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}`;
const DAY_MS = 24 * 60 * 60 * 1000;

type Manager = 'npm' | 'pnpm';
interface Installation { method: Manager; packageRoot: string; version: string; executable: string; launcher: string; }
interface VersionParts { major: bigint; minor: bigint; patch: bigint; prerelease: string[]; }
export interface PiUpdateInput { repo: string; agentDir: string; apply: boolean; }
export interface PiCandidate { version: string; publishedAt: string; ageDays: number; }

function parseVersion(value: unknown): VersionParts | null {
  if (typeof value !== 'string') return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) return null;
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some((item) => /^0\d+$/.test(item))) return null;
  return { major: BigInt(match[1]), minor: BigInt(match[2]), patch: BigInt(match[3]), prerelease };
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)!;
  const b = parseVersion(right)!;
  for (const key of ['major', 'minor', 'patch'] as const) if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    if (a.prerelease[i] === undefined || b.prerelease[i] === undefined) return a.prerelease[i] === undefined ? -1 : 1;
    if (a.prerelease[i] === b.prerelease[i]) continue;
    const an = /^\d+$/.test(a.prerelease[i]);
    const bn = /^\d+$/.test(b.prerelease[i]);
    if (an && bn) return BigInt(a.prerelease[i]) < BigInt(b.prerelease[i]) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1;
    return a.prerelease[i] < b.prerelease[i] ? -1 : 1;
  }
  return 0;
}

interface LocatedExecutable { executable: string; launcher: string; }

export async function resolveWindowsCommandShim(shim: string): Promise<string> {
  const contents = await fs.readFile(shim, 'utf8');
  const lines = contents.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean);
  const normalized = lines.map((line) => line.toLowerCase());
  const npmPreamble = [
    '@echo off', 'goto start', ':find_dp0', 'set dp0=%~dp0', 'exit /b', ':start', 'setlocal', 'call :find_dp0',
    'if exist "%dp0%\\node.exe" (', 'set "_prog=%dp0%\\node.exe"', ') else (', 'set "_prog=node"',
    'set pathext=%pathext:;.js;=;%', ')',
  ];
  const npmInvocation = /^(?:endlocal\s*&\s*goto\s+#_undefined_#\s+2>nul\s*\|\|\s*title\s+%comspec%\s*&\s*)?"%_prog%"\s+"([^"]+)"\s+%\*$/i;
  let targets: string[] = [];
  const npmTarget = npmPreamble.length === lines.length - 1 && npmPreamble.every((line, index) => normalized[index] === line)
    ? npmInvocation.exec(lines.at(-1) ?? '')?.[1]
    : undefined;
  if (npmTarget) {
    targets = [npmTarget];
  } else {
    // NODE_PATH-enriched pnpm wrappers are intentionally rejected until their generated shape is explicitly verified.
    let directNodeExe = false;
    let directNode = false;
    let contextDispatcher = false;
    let hasLocalScope = false;
    let nodeConditional = false;
    let hasElse = false;
    let hasPathextSetup = false;
    let hasBypassGuard = false;
    let hasShimGuard = false;
    let hasFallbackLabel = false;
    let hasExit = false;
    const pnpmInvocationPatterns = [
      { kind: 'nodeExe', pattern: /^@?"%~dp0\\node\.exe"\s+"([^"]+)"\s+%\*$/i },
      { kind: 'node', pattern: /^@?node\s+"([^"]+)"\s+%\*$/i },
      { kind: 'context', pattern: /^@?"%~dp0\\\.pnpm-shim-v1\.exe"\s+--shim\s+"pi"\s+"%~f0"\s+"([^"]+)"\s+--\s+%\*$/i },
    ];
    for (const line of lines) {
      let matched = false;
      for (const { kind, pattern } of pnpmInvocationPatterns) {
        const match = pattern.exec(line);
        if (!match) continue;
        targets.push(match[1]);
        if (kind === 'nodeExe') directNodeExe = true;
        else if (kind === 'node') directNode = true;
        else contextDispatcher = true;
        matched = true;
        break;
      }
      if (matched) continue;
      const safeLine = line.toLowerCase().replace(/^@/, '');
      if (safeLine === 'setlocal') {
        hasLocalScope = true;
        continue;
      }
      if (safeLine === 'endlocal' || safeLine === ')' || safeLine === ') else (' || safeLine === 'exit /b' ||
          safeLine === ':pnpm_shim_fallback' || safeLine === 'set pathext=%pathext:;.js;=;%') {
        if (safeLine === ') else (') hasElse = true;
        if (safeLine === 'exit /b') hasExit = true;
        if (safeLine === ':pnpm_shim_fallback') hasFallbackLabel = true;
        if (safeLine === 'set pathext=%pathext:;.js;=;%') hasPathextSetup = true;
        continue;
      }
      if (safeLine === 'if defined pnpm_shim_bypass goto :pnpm_shim_fallback') {
        hasBypassGuard = true;
        continue;
      }
      if (/^if not exist "%~dp0\\\.pnpm-shim-v1\.exe" goto :pnpm_shim_fallback$/i.test(safeLine)) {
        hasShimGuard = true;
        continue;
      }
      if (/^if exist "%~dp0\\(?:node\.exe|\.pnpm-shim-v1\.exe)" \($/i.test(safeLine)) {
        if (safeLine.startsWith('if exist "%~dp0\\node.exe"')) nodeConditional = true;
        continue;
      }
      throw new Error('The local Pi Windows command shim contains unsupported wrapper commands; refusing to update it.');
    }
    const hasDirectNodeFallback = directNodeExe && directNode && nodeConditional && hasElse && hasPathextSetup;
    const hasContextAwareGlobalShim = contextDispatcher && hasLocalScope && hasBypassGuard && hasShimGuard && hasExit && hasFallbackLabel && hasDirectNodeFallback;
    if (!targets.length || !(hasLocalScope && hasDirectNodeFallback) || (contextDispatcher && !hasContextAwareGlobalShim)) {
      throw new Error('The local Pi Windows command shim is not a recognized npm/pnpm-generated shim; custom wrappers are unsupported.');
    }
  }

  const resolveTarget = async (target: string) => {
    if (!/^(?:%~dp0|%dp0%)[\\/]/i.test(target)) throw new Error('The local Pi Windows command shim target is not relative to its generated global bin directory.');
    const relativeTarget = target.replace(/^(?:%~dp0|%dp0%)[\\/]/i, '').replace(/[\\/]/g, path.sep);
    return await fs.realpath(path.resolve(path.dirname(shim), relativeTarget));
  };
  const resolvedTargets = await Promise.all(targets.map(resolveTarget));
  if (resolvedTargets.some((target) => target.toLowerCase() !== resolvedTargets[0].toLowerCase())) {
    throw new Error('The local Pi Windows command shim has conflicting executable targets; refusing to update it.');
  }
  return resolvedTargets[0];
}

async function findPiExecutable(): Promise<LocatedExecutable> {
  const names = process.platform === 'win32' ? ['pi.cmd', 'pi.exe'] : ['pi'];
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      try {
        const info = await fs.lstat(candidate);
        if (!info.isFile() && !info.isSymbolicLink()) continue;
        const launcher = await fs.realpath(candidate);
        return { executable: process.platform === 'win32' && name.toLowerCase() === 'pi.cmd' ? await resolveWindowsCommandShim(launcher) : launcher, launcher };
      } catch (error: any) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    }
  }
  throw new Error('Could not locate the local Pi executable or command shim on PATH; only verifiable global npm or pnpm installations are supported.');
}
function declaredPiBin(pkg: any): string {
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.pi;
  if (typeof bin !== 'string' || !bin || path.isAbsolute(bin)) throw new Error('The installed Pi package does not declare a verifiable "pi" executable.');
  return bin;
}

async function packageAtExecutable(executable: string): Promise<{ root: string; version: string }> {
  let directory = path.dirname(executable);
  while (true) {
    const manifestPath = path.join(directory, 'package.json');
    try {
      const pkg = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      if (pkg.name === PACKAGE_NAME) {
        const version = pkg.version;
        if (!parseVersion(version)) throw new Error('The installed Pi package has an invalid version; refusing to update it.');
        const declaredPath = path.resolve(directory, declaredPiBin(pkg));
        const relativeBin = path.relative(directory, declaredPath);
        if (!relativeBin || relativeBin === '..' || relativeBin.startsWith(`..${path.sep}`) || path.isAbsolute(relativeBin)) {
          throw new Error('The installed Pi package declares an executable outside its package root; refusing to update it.');
        }
        const declared = await fs.realpath(declaredPath);
        if (declared !== executable) throw new Error('The Pi executable does not match the official package bin metadata; refusing to update an ambiguous installation.');
        return { root: await fs.realpath(directory), version };
      }
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('The Pi executable is not backed by the official @mariozechner/pi-coding-agent package; unsupported or custom-wrapper installations cannot be updated.');
}

async function globalRoot(manager: Manager): Promise<string | null> {
  const result = await runCommand(manager, ['root', '--global']);
  if (result.error || result.status !== 0 || !result.stdout.trim()) return null;
  try { return await fs.realpath(result.stdout.trim()); } catch { return null; }
}

async function managerGlobalBin(manager: Manager): Promise<string | null> {
  const args = manager === 'npm' ? ['prefix', '--global'] : ['bin', '--global'];
  const result = await runCommand(manager, args);
  if (result.error || result.status !== 0 || !result.stdout.trim()) return null;
  try { return await fs.realpath(result.stdout.trim()); } catch { return null; }
}

async function detectInstallation(): Promise<Installation> {
  const located = await findPiExecutable();
  const installed = await packageAtExecutable(located.executable);
  const matches: Manager[] = [];
  for (const manager of ['npm', 'pnpm'] as const) {
    const root = await globalRoot(manager);
    if (!root) continue;
    const packagePath = path.join(root, ...PACKAGE_NAME.split('/'));
    try {
      if (await fs.realpath(packagePath) !== installed.root) continue;
      if (process.platform === 'win32') {
        const bin = await managerGlobalBin(manager);
        if (!bin) continue;
        let expectedShim: string;
        try { expectedShim = await fs.realpath(path.join(bin, 'pi.cmd')); } catch { continue; }
        if (expectedShim.toLowerCase() !== located.launcher.toLowerCase()) continue;
      }
      matches.push(manager);
    } catch (error: any) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  }
  if (matches.length !== 1) {
    throw new Error(matches.length ? 'The Pi installation matches multiple global package managers; refusing an ambiguous update.' : 'The Pi installation is not verifiably managed by global npm or pnpm. Install Pi globally with npm or pnpm before using pi-sync pi-update.');
  }
  return { method: matches[0], packageRoot: installed.root, version: installed.version, executable: located.executable, launcher: located.launcher };
}

async function repositoryPolicy(repo: string): Promise<number> {
  const manifestPath = path.join(repo, 'pi-sync.json');
  let manifest: any;
  try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); }
  catch (error: any) { throw new Error(`Could not read setup repository manifest (${manifestPath}): ${error.message}`); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.schemaVersion !== 1) {
    throw new Error('Setup repository manifest must have schemaVersion 1 to determine the Pi release-age policy.');
  }
  if (!Object.hasOwn(manifest, 'policy')) return 7;
  const policy = manifest.policy;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).length !== 1 ||
      !Number.isInteger(policy.minimumReleaseAgeDays) || policy.minimumReleaseAgeDays < 7) {
    throw new Error('Manifest policy.minimumReleaseAgeDays must be an integer of at least seven days; Pi update discovery stopped closed.');
  }
  return policy.minimumReleaseAgeDays;
}

function publicationTime(value: unknown, version: string): number {
  const match = typeof value === 'string' ? /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(value) : null;
  if (!match) throw new Error(`Missing or malformed npm publication timestamp for Pi ${version}; update discovery stopped closed.`);
  const timestamp = Date.parse(value as string);
  const canonical = `${match[1]}.${(match[2] ?? '').padEnd(3, '0').slice(0, 3)}Z`;
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== canonical) {
    throw new Error(`Untrustworthy npm publication timestamp for Pi ${version}; update discovery stopped closed.`);
  }
  if (timestamp > Date.now()) throw new Error(`npm publication timestamp for Pi ${version} is in the future; update discovery stopped closed.`);
  return timestamp;
}

async function findCandidate(installedVersion: string, minimumReleaseAgeDays: number): Promise<PiCandidate | null> {
  let response: Response;
  try { response = await fetch(REGISTRY_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000), redirect: 'error' }); }
  catch (error: any) { throw new Error(`Could not read official npm Pi release metadata${error?.message ? ` (${error.message})` : ''}; update discovery stopped closed.`); }
  if (!response.ok) throw new Error(`Could not read official npm Pi release metadata (HTTP ${response.status}); update discovery stopped closed.`);
  let metadata: any;
  try { metadata = await response.json(); } catch { throw new Error('Official npm Pi release metadata was not valid JSON; update discovery stopped closed.'); }
  if (!metadata || metadata.name !== PACKAGE_NAME || !metadata.versions || typeof metadata.versions !== 'object' || Array.isArray(metadata.versions) || Object.keys(metadata.versions).length === 0 ||
      !metadata.time || typeof metadata.time !== 'object' || Array.isArray(metadata.time)) {
    throw new Error('Official npm Pi release metadata is incomplete or identifies a different package; update discovery stopped closed.');
  }
  const versions: { version: string; publishedAt: string; timestamp: number }[] = [];
  for (const version of Object.keys(metadata.versions)) {
    const versionData = metadata.versions[version];
    if (!parseVersion(version) || !versionData || versionData.name !== PACKAGE_NAME || versionData.version !== version) {
      throw new Error(`Official npm Pi release metadata contains an invalid version record (${version}); update discovery stopped closed.`);
    }
    const timestamp = publicationTime(metadata.time[version], version);
    versions.push({ version, publishedAt: metadata.time[version], timestamp });
  }
  const now = Date.now();
  const minimumAgeMs = minimumReleaseAgeDays * DAY_MS;
  const eligible = versions.filter((item) => !parseVersion(item.version)!.prerelease.length && compareVersions(item.version, installedVersion) > 0 && now - item.timestamp >= minimumAgeMs)
    .sort((a, b) => compareVersions(a.version, b.version));
  const selected = eligible.at(-1);
  return selected ? { version: selected.version, publishedAt: selected.publishedAt, ageDays: Math.floor((now - selected.timestamp) / DAY_MS * 100) / 100 } : null;
}

async function install(manager: Manager, version: string): Promise<void> {
  const spec = `${PACKAGE_NAME}@${version}`;
  const args = manager === 'npm'
    ? ['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', spec]
    : ['add', '--global', '--ignore-scripts', spec];
  const result = await runCommand(manager, args);
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim() ?? '';
    throw new Error(`${manager} could not install exact Pi version ${version}${detail ? `: ${detail}` : ''}`);
  }
}
async function verifyInstallation(expected: Installation, version: string): Promise<void> {
  const actual = await detectInstallation().catch(() => null);
  if (!actual || actual.method !== expected.method || actual.packageRoot !== expected.packageRoot || (process.platform === 'win32' ? actual.launcher.toLowerCase() !== expected.launcher.toLowerCase() : actual.launcher !== expected.launcher) || actual.version !== version) {
    throw new Error(`Pi installation verification failed; expected ${version} in the original ${expected.method} installation.`);
  }
}

export async function runPiUpdate({ repo, agentDir, apply }: PiUpdateInput) {
  const minimumReleaseAgeDays = await repositoryPolicy(repo);
  const installation = await detectInstallation();
  const candidate = await findCandidate(installation.version, minimumReleaseAgeDays);
  if (!apply || !candidate) {
    return { apiVersion: 1, command: 'pi-update', ok: true, exitCode: 0, mode: 'preview', localVersion: installation.version,
      installationMethod: installation.method, candidate, minimumReleaseAgeDays, policySource: 'setup repository pi-sync.json',
      note: candidate ? 'Preview only; no Pi installation or setup repository files were changed.' : 'No newer stable Pi release has met the setup repository release-age policy.' };
  }

  const releaseLock = await acquireLock(agentDir);
  try {
    // Discovery and installation identity are rechecked while holding the same
    // local apply lock used by other Pi Sync operations.
    const currentPolicy = await repositoryPolicy(repo);
    if (currentPolicy !== minimumReleaseAgeDays) throw new Error('The setup repository release-age policy changed while preparing the update; no installation was performed. Run pi-sync pi-update again to preview.');
    const currentInstallation = await detectInstallation();
    if (currentInstallation.version !== installation.version || currentInstallation.packageRoot !== installation.packageRoot || currentInstallation.method !== installation.method || (process.platform === 'win32' ? currentInstallation.launcher.toLowerCase() !== installation.launcher.toLowerCase() : currentInstallation.launcher !== installation.launcher)) {
      throw new Error('The local Pi installation changed while preparing the update; retry pi-sync pi-update.');
    }
    const currentCandidate = await findCandidate(currentInstallation.version, minimumReleaseAgeDays);
    if (!currentCandidate || currentCandidate.version !== candidate.version) {
      throw new Error('Pi release eligibility changed during the update; no installation was performed. Run pi-sync pi-update again to preview.');
    }
    let installFailure: Error | null = null;
    try {
      await install(currentInstallation.method, currentCandidate.version);
      await verifyInstallation(currentInstallation, currentCandidate.version);
    } catch (error: any) { installFailure = error; }
    if (installFailure) {
      let rollbackError: string | null = null;
      try {
        await install(currentInstallation.method, currentInstallation.version);
        await verifyInstallation(currentInstallation, currentInstallation.version);
      } catch (error: any) { rollbackError = error.message; }
      const message = `Pi update to ${currentCandidate.version} failed: ${installFailure.message}; ${rollbackError ? `rollback was incomplete: ${rollbackError}` : `previous Pi version ${currentInstallation.version} was restored and verified`}`;
      const failure: any = new Error(message);
      failure.errorCode = 'PI_UPDATE_FAILED';
      failure.details = { message, rollbackError };
      throw failure;
    }
    return { apiVersion: 1, command: 'pi-update', ok: true, exitCode: 0, mode: 'applied', localVersion: currentInstallation.version,
      installedVersion: currentCandidate.version, installationMethod: currentInstallation.method, candidate: currentCandidate,
      minimumReleaseAgeDays, policySource: 'setup repository pi-sync.json', note: 'Pi was updated locally; the setup repository was not changed.' };
  } finally { await releaseLock(); }
}
