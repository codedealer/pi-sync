import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveWindowsCommandShim } from '../dist/cli/commands/pi-update.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const packageName = '@mariozechner/pi-coding-agent';

async function fixture(t, { policy = 7, versions = ['1.2.0', '1.3.0'], managerBehavior = '', manager = 'npm' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-pi-update-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'setup');
  const agentDir = path.join(root, 'agent');
  const prefix = path.join(root, 'npm-prefix');
  const isWindows = process.platform === 'win32';
  const globalRoot = isWindows ? path.join(prefix, 'node_modules') : path.join(prefix, 'lib', 'node_modules');
  const packageRoot = path.join(globalRoot, ...packageName.split('/'));
  const executableDir = isWindows ? prefix : path.join(prefix, 'bin');
  const fakeBin = path.join(root, 'fake-bin');
  const metadataPath = path.join(root, 'metadata.json');
  const log = path.join(root, 'manager.log');
  await fs.mkdir(repo, { recursive: true });
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(path.join(packageRoot, 'dist'), { recursive: true });
  await fs.mkdir(executableDir, { recursive: true });
  await fs.mkdir(fakeBin, { recursive: true });
  const manifest = { schemaVersion: 1, resources: [], dependencies: [], ...(policy === undefined ? {} : { policy: { minimumReleaseAgeDays: policy } }) };
  const lock = { schemaVersion: 1, packages: [] };
  await fs.writeFile(path.join(repo, 'pi-sync.json'), JSON.stringify(manifest, null, 2) + '\n');
  await fs.writeFile(path.join(repo, 'pi-sync.lock.json'), JSON.stringify(lock, null, 2) + '\n');
  const originalRepoFiles = await snapshotRepo(repo);
  const cliContents = '#!/usr/bin/env node\n';
  await fs.writeFile(path.join(packageRoot, 'dist', 'cli.js'), cliContents, { mode: 0o755 });
  const pkgJson = { name: packageName, version: '1.0.0', bin: { pi: 'dist/cli.js' } };
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify(pkgJson));
  if (isWindows) {
    const relativeBin = path.relative(executableDir, path.join(packageRoot, 'dist', 'cli.js')).split(path.sep).join('\\');
    const shim = [
      '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
      'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
      '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', `"%_prog%" "%dp0%\\${relativeBin}" %*`,
    ].join('\r\n') + '\r\n';
    await fs.writeFile(path.join(executableDir, 'pi.cmd'), shim);
  } else {
    await fs.symlink(path.join(packageRoot, 'dist', 'cli.js'), path.join(executableDir, 'pi'));
  }
  const times = {};
  const packageVersions = {};
  const now = Date.now();
  for (const version of versions) {
    packageVersions[version] = { name: packageName, version };
    times[version] = new Date(now - (version === versions.at(-1) ? 1 : 9) * 24 * 60 * 60 * 1000).toISOString();
  }
  await fs.writeFile(metadataPath, JSON.stringify({ name: packageName, versions: packageVersions, time: times }));
  const managerScript = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PI_MANAGER_LOG, args.join(' ') + '\\n');
if (args[0] === 'root' && args[1] === '--global') { console.log(process.env.PI_GLOBAL_ROOT); process.exit(0); }
if (args[0] === 'prefix' && args[1] === '--global') { console.log(process.env.PI_PREFIX); process.exit(0); }
if (args[0] === 'bin' && args[1] === '--global') { console.log(process.env.PI_GLOBAL_BIN); process.exit(0); }
if (args[0] !== process.env.PI_INSTALL_COMMAND || !args.includes('--global')) process.exit(3);
const spec = args.at(-1);
const version = spec.slice(spec.lastIndexOf('@') + 1);
const pkg = path.join(process.env.PI_GLOBAL_ROOT, ...${JSON.stringify(packageName.split('/'))});
const metadata = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
${managerBehavior}
metadata.version = version; fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify(metadata));
process.exit(0);
`;
  if (isWindows) {
    await fs.writeFile(path.join(fakeBin, `${manager}-script.cjs`), managerScript);
    await fs.writeFile(path.join(fakeBin, `${manager}.cmd`), `@ECHO off\r\nnode "%~dp0${manager}-script.cjs" %*\r\n`);
  } else {
    await fs.writeFile(path.join(fakeBin, manager), managerScript, { mode: 0o755 });
  }
  const preload = path.join(root, 'registry-hook.mjs');
  await fs.writeFile(preload, `import fs from 'node:fs';
const nativeFetch = globalThis.fetch;
let registryFetchCount = 0;
globalThis.fetch = async (url, options) => {
  if (!String(url).startsWith('https://registry.npmjs.org/')) return nativeFetch(url, options);
  if (process.env.PI_METADATA_FAIL) throw new Error('test registry unavailable');
  registryFetchCount++;
  if (process.env.PI_POLICY_CHANGE_FETCH === String(registryFetchCount)) {
    const manifest = JSON.parse(fs.readFileSync(process.env.PI_SETUP_MANIFEST, 'utf8'));
    manifest.policy.minimumReleaseAgeDays++;
    fs.writeFileSync(process.env.PI_SETUP_MANIFEST, JSON.stringify(manifest));
  }
  if (process.env.PI_PACKAGE_CHANGE_FETCH === String(registryFetchCount)) {
    const pkg = JSON.parse(fs.readFileSync(process.env.PI_PACKAGE_JSON, 'utf8'));
    pkg.version = '1.1.0';
    fs.writeFileSync(process.env.PI_PACKAGE_JSON, JSON.stringify(pkg));
  }
  if (process.env.PI_CANDIDATE_CHANGE_FETCH === String(registryFetchCount)) {
    const metadata = JSON.parse(fs.readFileSync(process.env.PI_METADATA, 'utf8'));
    metadata.time['1.3.0'] = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(process.env.PI_METADATA, JSON.stringify(metadata));
  }
  return new Response(fs.readFileSync(process.env.PI_METADATA), { status: 200, headers: { 'content-type': 'application/json' } });
};
`);
  const env = {
    ...process.env,
    PATH: `${executableDir}${path.delimiter}${fakeBin}${path.delimiter}${process.env.PATH}`,
    PI_GLOBAL_ROOT: globalRoot,
    PI_PREFIX: prefix,
    PI_GLOBAL_BIN: executableDir,
    PI_INSTALL_COMMAND: manager === 'npm' ? 'install' : 'add',
    PI_METADATA: metadataPath,
    PI_MANAGER_LOG: log,
    PI_SETUP_MANIFEST: path.join(repo, 'pi-sync.json'),
    PI_PACKAGE_JSON: path.join(packageRoot, 'package.json'),
    PI_OTHER_ROOT: path.join(root, 'other-global-root'),
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
  };
  return { root, repo, agentDir, packageRoot, originalRepoFiles, env, log, metadataPath, fakeBin, managerScript };
}

async function addFakeManager(f, manager) {
  if (process.platform === 'win32') {
    await fs.writeFile(path.join(f.fakeBin, `${manager}-script.cjs`), f.managerScript);
    await fs.writeFile(path.join(f.fakeBin, `${manager}.cmd`), `@ECHO off\r\nnode "%~dp0${manager}-script.cjs" %*\r\n`);
  } else {
    await fs.writeFile(path.join(f.fakeBin, manager), f.managerScript, { mode: 0o755 });
  }
}

async function snapshotRepo(repo) {
  const result = {};
  for (const name of ['pi-sync.json', 'pi-sync.lock.json']) result[name] = await fs.readFile(path.join(repo, name));
  return result;
}

function run(args, env) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env });

}

function runAsync(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { encoding: 'utf8', env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function json(result) {
  assert.equal(result.error, undefined, result.error?.message);
  return JSON.parse(result.stdout);
}

async function managerCalls(log) {
  return (await fs.readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
}

test('current npm and pnpm Windows shims resolve their declared package target and reject wrappers', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-win-shim-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const binDir = path.join(root, 'bin');
  const packageBin = path.join(root, 'node_modules', ...packageName.split('/'), 'dist', 'cli.js');
  const shimPath = path.join(binDir, 'pi.cmd');
  await fs.mkdir(path.dirname(packageBin), { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(packageBin, '');
  const relativeTarget = path.relative(binDir, packageBin).split(path.sep).join('\\');
  const npmShim = [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '', `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${relativeTarget}" %*`,
  ].join('\r\n') + '\r\n';
  const pnpmDirectShim = [
    '@SETLOCAL', '@IF EXIST "%~dp0\\node.exe" (', `  "%~dp0\\node.exe"  "%~dp0\\${relativeTarget}" %*`,
    ') ELSE (', '  @SET PATHEXT=%PATHEXT:;.JS;=;%', `  node  "%~dp0\\${relativeTarget}" %*`, ')',
  ].join('\r\n') + '\r\n';
  const pnpmContextShim = [
    '@SETLOCAL', '@IF DEFINED PNPM_SHIM_BYPASS GOTO :pnpm_shim_fallback',
    '@IF NOT EXIST "%~dp0\\.pnpm-shim-v1.exe" GOTO :pnpm_shim_fallback',
    `@"%~dp0\\.pnpm-shim-v1.exe" --shim "pi" "%~f0" "%~dp0\\${relativeTarget}" -- %*`, '@EXIT /B',
    ':pnpm_shim_fallback', '@IF EXIST "%~dp0\\node.exe" (', `  "%~dp0\\node.exe"  "%~dp0\\${relativeTarget}" %*`,
    ') ELSE (', '  @SET PATHEXT=%PATHEXT:;.JS;=;%', `  node  "%~dp0\\${relativeTarget}" %*`, ')',
  ].join('\r\n') + '\r\n';

  for (const [label, text] of [['npm 11 cmd-shim', npmShim], ['pnpm direct shim', pnpmDirectShim], ['pnpm context shim', pnpmContextShim]]) {
    await fs.writeFile(shimPath, text);
    try {
      assert.equal(await resolveWindowsCommandShim(shimPath), await fs.realpath(packageBin), label);
    } catch (error) {
      error.message = `${label}: ${error.message}`;
      throw error;
    }
  }
  await fs.appendFile(shimPath, 'echo custom wrapper\r\n');
  await assert.rejects(resolveWindowsCommandShim(shimPath), /unsupported wrapper|custom wrappers are unsupported/);
  await fs.writeFile(shimPath, pnpmDirectShim.replace(
    '@IF EXIST "%~dp0\\node.exe" (',
    '@SET NODE_PATH=%NODE_PATH%;%~dp0\\node_modules\\x\r\n@IF EXIST "%~dp0\\node.exe" (',
  ));
  await assert.rejects(resolveWindowsCommandShim(shimPath), /unsupported wrapper commands/);
});

test('pi-update previews newest mature stable Pi version read-only', async (t) => {
  const f = await fixture(t);
  const result = run(['pi-update', '--repo', f.repo, '--agent-dir', f.agentDir], f.env);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const output = json(result);
  assert.equal(output.command, 'pi-update');
  assert.equal(output.mode, 'preview');
  assert.equal(output.localVersion, '1.0.0');
  assert.equal(output.installationMethod, 'npm');
  assert.equal(output.minimumReleaseAgeDays, 7);
  assert.equal(output.policySource, 'setup repository pi-sync.json');
  assert.equal(output.candidate.version, '1.2.0');
  assert.equal(output.candidate.ageDays, 9);
  assert.deepEqual(await snapshotRepo(f.repo), f.originalRepoFiles);
  assert.equal(await fs.readFile(path.join(f.packageRoot, 'package.json'), 'utf8').then((text) => JSON.parse(text).version), '1.0.0');
  assert.deepEqual(await managerCalls(f.log), (process.platform === 'win32' ? ['root --global', 'prefix --global'] : ['root --global']));
});

test('pi-update --apply installs the exact rechecked version with scripts disabled', async (t) => {
  const f = await fixture(t);
  const result = run(['pi-update', '--apply', '--repo', f.repo, '--agent-dir', f.agentDir], f.env);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const output = json(result);
  assert.equal(output.mode, 'applied');
  assert.equal(output.installedVersion, '1.2.0');
  assert.equal(await fs.readFile(path.join(f.packageRoot, 'package.json'), 'utf8').then((text) => JSON.parse(text).version), '1.2.0');
  const calls = await managerCalls(f.log);
  assert.equal(calls.filter((call) => call.startsWith('install ')).length, 1);
  assert.match(calls.find((call) => call.startsWith('install ')), /--ignore-scripts/);
  assert.match(calls.find((call) => call.startsWith('install ')), /@mariozechner\/pi-coding-agent@1\.2\.0$/);
  assert.doesNotMatch(calls.join('\n'), /pi update|--minimum-release-age|--age=0|--min-release-age=0/);
  assert.deepEqual(await snapshotRepo(f.repo), f.originalRepoFiles);
});

test('a too-young newest release is not proposed and a machine age override is rejected', async (t) => {
  const f = await fixture(t, { versions: ['1.2.0', '1.3.0'] });
  const preview = run(['pi-update', '--repo', f.repo, '--agent-dir', f.agentDir], f.env);
  assert.equal(json(preview).candidate.version, '1.2.0');
  const noOverride = run(['pi-update', '--minimum-release-age-days', '0', '--repo', f.repo], f.env);
  assert.notEqual(noOverride.status, 0);
  assert.match(json(noOverride).error, /Unknown option/);
  const f2 = await fixture(t, { versions: ['1.3.0'] });
  const onlyYoung = run(['pi-update', '--repo', f2.repo, '--agent-dir', f2.agentDir], f2.env);
  assert.equal(json(onlyYoung).candidate, null);
});

test('missing or malformed publication timestamps stop discovery closed', async (t) => {
  const f = await fixture(t);
  const metadata = JSON.parse(await fs.readFile(f.metadataPath, 'utf8'));
  delete metadata.time['1.2.0'];
  await fs.writeFile(f.metadataPath, JSON.stringify(metadata));
  const result = run(['pi-update', '--repo', f.repo, '--agent-dir', f.agentDir], f.env);
  assert.notEqual(result.status, 0);
  assert.match(json(result).error, /timestamp.*stopped closed/i);
  assert.deepEqual(await managerCalls(f.log), (process.platform === 'win32' ? ['root --global', 'prefix --global'] : ['root --global']));
  assert.deepEqual(await snapshotRepo(f.repo), f.originalRepoFiles);
});

test('malformed, non-canonical, and future publication timestamps stop discovery closed', async (t) => {
  const invalidTimes = ['not-an-iso-date', '2024-02-31T12:00:00.000Z', new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()];
  for (const publishedAt of invalidTimes) {
    const f = await fixture(t);
    const metadata = JSON.parse(await fs.readFile(f.metadataPath, 'utf8'));
    metadata.time['1.2.0'] = publishedAt;
    await fs.writeFile(f.metadataPath, JSON.stringify(metadata));
    const result = run(['pi-update', '--repo', f.repo, '--agent-dir', f.agentDir], f.env);
    assert.notEqual(result.status, 0);
    assert.match(json(result).error, /timestamp.*stopped closed/i);
    assert.equal((await managerCalls(f.log)).some((call) => /^(install|add) /.test(call)), false);
    assert.deepEqual(await snapshotRepo(f.repo), f.originalRepoFiles);
  }
});

test('registry transport errors fail closed with an operational error envelope', async (t) => {
  const f = await fixture(t);
  const result = run(['pi-update', '--repo', f.repo, '--agent-dir', f.agentDir], { ...f.env, PI_METADATA_FAIL: '1' });
  assert.equal(result.status, 1);
  const output = json(result);
  assert.equal(output.errorCode, 'OPERATION_FAILED');
  assert.match(output.error, /Could not read official npm Pi release metadata.*update discovery stopped closed/);
  assert.equal((await managerCalls(f.log)).some((call) => /^(install|add) /.test(call)), false);
  assert.deepEqual(await snapshotRepo(f.repo), f.originalRepoFiles);
});

test('a failed install attempts and verifies rollback without modifying the setup repository', async (t) => {
  const behavior = `const marker = process.env.PI_MANAGER_LOG + '.first'; if (!fs.existsSync(marker)) { fs.writeFileSync(marker, '1'); metadata.version = version; fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify(metadata)); process.exit(9); }`;
  const f = await fixture(t, { managerBehavior: behavior });
  const result = run(['pi-update', '--apply', '--repo', f.repo, '--agent-dir', f.agentDir], f.env);
  assert.notEqual(result.status, 0);
  assert.match(json(result).error, /previous Pi version 1\.0\.0 was restored and verified/);
  assert.equal(await fs.readFile(path.join(f.packageRoot, 'package.json'), 'utf8').then((text) => JSON.parse(text).version), '1.0.0');
  const calls = await managerCalls(f.log);
  assert.ok(calls.some((call) => call.endsWith('@mariozechner/pi-coding-agent@1.2.0')));
  assert.ok(calls.some((call) => call.endsWith('@mariozechner/pi-coding-agent@1.0.0')));
  assert.deepEqual(await snapshotRepo(f.repo), f.originalRepoFiles);
});

test('verifiable global pnpm installations use pnpm add with scripts disabled', async (t) => {
  const f = await fixture(t, { manager: 'pnpm' });
  const result = run(['pi-update', '--apply', '--repo', f.repo, '--agent-dir', f.agentDir], f.env);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const output = json(result);
  assert.equal(output.installationMethod, 'pnpm');
  assert.equal(output.installedVersion, '1.2.0');
  const calls = await managerCalls(f.log);
  assert.ok(calls.some((call) => call.startsWith('add --global --ignore-scripts')));
  assert.deepEqual(await snapshotRepo(f.repo), f.originalRepoFiles);
});

test('unsupported wrapper installations and invalid repository age policies fail closed', async (t) => {
  const f = await fixture(t);
  const binDir = process.platform === 'win32' ? path.join(f.root, 'npm-prefix') : path.join(f.root, 'npm-prefix', 'bin');
  const launcher = path.join(binDir, process.platform === 'win32' ? 'pi.cmd' : 'pi');
  await fs.unlink(launcher);
  await fs.writeFile(launcher, process.platform === 'win32' ? '@ECHO off\r\necho custom wrapper\r\n' : '#!/usr/bin/env node\n', { mode: 0o755 });
  const unsupported = run(['pi-update', '--repo', f.repo, '--agent-dir', f.agentDir], f.env);
  assert.notEqual(unsupported.status, 0);
  assert.match(json(unsupported).error, /unsupported|custom-wrapper/i);

  const f2 = await fixture(t);
  const manifestPath = path.join(f2.repo, 'pi-sync.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.policy.minimumReleaseAgeDays = 1;
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const invalidPolicy = run(['pi-update', '--repo', f2.repo, '--agent-dir', f2.agentDir], f2.env);
  assert.notEqual(invalidPolicy.status, 0);
  assert.match(json(invalidPolicy).error, /at least seven days/);
});

test('ambiguous managers and packages outside global roots fail closed', async (t) => {
  const ambiguous = await fixture(t);
  await addFakeManager(ambiguous, 'pnpm');
  const ambiguousResult = run(['pi-update', '--repo', ambiguous.repo, '--agent-dir', ambiguous.agentDir], ambiguous.env);
  assert.notEqual(ambiguousResult.status, 0);
  assert.match(json(ambiguousResult).error, /matches multiple global package managers/);

  const unmanaged = await fixture(t);
  await fs.mkdir(unmanaged.env.PI_OTHER_ROOT, { recursive: true });
  const unmanagedResult = run(['pi-update', '--repo', unmanaged.repo, '--agent-dir', unmanaged.agentDir], { ...unmanaged.env, PI_GLOBAL_ROOT: unmanaged.env.PI_OTHER_ROOT });
  assert.notEqual(unmanagedResult.status, 0);
  assert.match(json(unmanagedResult).error, /not verifiably managed by global npm or pnpm/);
});

test('apply fails closed when policy, installation, or candidate changes during the locked recheck', async (t) => {
  const policy = await fixture(t);
  const policyResult = run(['pi-update', '--apply', '--repo', policy.repo, '--agent-dir', policy.agentDir], { ...policy.env, PI_POLICY_CHANGE_FETCH: '1' });
  assert.notEqual(policyResult.status, 0);
  assert.match(json(policyResult).error, /release-age policy changed/);
  assert.equal((await managerCalls(policy.log)).some((call) => /^(install|add) /.test(call)), false);

  const installation = await fixture(t);
  const installationResult = run(['pi-update', '--apply', '--repo', installation.repo, '--agent-dir', installation.agentDir], { ...installation.env, PI_PACKAGE_CHANGE_FETCH: '1' });
  assert.notEqual(installationResult.status, 0);
  assert.match(json(installationResult).error, /local Pi installation changed/);
  assert.equal((await managerCalls(installation.log)).some((call) => /^(install|add) /.test(call)), false);

  const candidate = await fixture(t);
  const candidateResult = run(['pi-update', '--apply', '--repo', candidate.repo, '--agent-dir', candidate.agentDir], { ...candidate.env, PI_CANDIDATE_CHANGE_FETCH: '2' });
  assert.notEqual(candidateResult.status, 0);
  assert.match(json(candidateResult).error, /release eligibility changed/);
  assert.equal((await managerCalls(candidate.log)).some((call) => /^(install|add) /.test(call)), false);
});

test('simultaneous pi-update applies do not race the host installation', async (t) => {
  const f = await fixture(t, { managerBehavior: "if (version === '1.2.0') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3200);" });
  const args = ['pi-update', '--apply', '--repo', f.repo, '--agent-dir', f.agentDir];
  const first = runAsync(args, f.env);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const second = runAsync(args, f.env);
  const results = await Promise.all([first, second]);
  assert.equal(results.filter((item) => item.status === 0).length, 1);
  assert.equal(results.filter((item) => item.status !== 0).length, 1);
  assert.equal(await fs.readFile(path.join(f.packageRoot, 'package.json'), 'utf8').then((text) => JSON.parse(text).version), '1.2.0');
  assert.equal((await managerCalls(f.log)).filter((call) => /^(install|add) /.test(call)).length, 1);
  assert.deepEqual(await snapshotRepo(f.repo), f.originalRepoFiles);
});

test('a serialized apply proceeds after the preceding operation rolls back and releases its lock', async (t) => {
  const behavior = `const marker = process.env.PI_MANAGER_LOG + '.delayed-failure'; if (version === '1.2.0' && !fs.existsSync(marker)) { fs.writeFileSync(marker, '1'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200); process.exit(9); }`;
  const f = await fixture(t, { managerBehavior: behavior });
  const args = ['pi-update', '--apply', '--repo', f.repo, '--agent-dir', f.agentDir];
  const first = runAsync(args, f.env);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const second = runAsync(args, f.env);
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.notEqual(firstResult.status, 0);
  assert.match(json(firstResult).error, /previous Pi version 1\.0\.0 was restored and verified/);
  assert.equal(secondResult.status, 0, secondResult.stderr + secondResult.stdout);
  assert.equal(json(secondResult).installedVersion, '1.2.0');
  assert.deepEqual(await snapshotRepo(f.repo), f.originalRepoFiles);
});

test('an unverifiable rollback is reported explicitly', async (t) => {
  const behavior = `if (version === '1.2.0') { metadata.version = version; fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify(metadata)); } process.exit(9);`;
  const f = await fixture(t, { managerBehavior: behavior });
  const result = run(['pi-update', '--apply', '--repo', f.repo, '--agent-dir', f.agentDir], f.env);
  assert.notEqual(result.status, 0);
  assert.match(json(result).error, /rollback was incomplete/);
  assert.deepEqual(await snapshotRepo(f.repo), f.originalRepoFiles);
});
