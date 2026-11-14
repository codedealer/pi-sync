import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { createPrerequisiteInspector, extractGitHubCliBinary, githubCliReleaseAsset, inspectRequiredTools } from '../src/prerequisites.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function zipFixture(filePath, contents) {
  const name = Buffer.from(filePath);
  const compressed = deflateRawSync(contents);
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(0, 10);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE((0o100755 << 16) >>> 0, 38);
  name.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + compressed.length, 16);
  return Buffer.concat([local, compressed, central, end]);
}

function tarGzipFixture(filePath, contents) {
  const header = Buffer.alloc(512);
  Buffer.from(filePath).copy(header, 0, 0, 100);
  header.write('0000755 ', 100, 8, 'ascii');
  header.write('0000000 ', 108, 8, 'ascii');
  header.write('0000000 ', 116, 8, 'ascii');
  header.write(contents.length.toString(8).padStart(11, '0'), 124, 12, 'ascii');
  header.write('00000000000 ', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write('ustar ', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}  `, 148, 8, 'ascii');
  const padded = Buffer.alloc(Math.ceil(contents.length / 512) * 512);
  contents.copy(padded);
  return gzipSync(Buffer.concat([header, padded, Buffer.alloc(1024)]));
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'setup');
  const agentDir = path.join(root, 'agent');
  await fs.mkdir(path.join(repo, 'resources', 'skills', 'hello'), { recursive: true });
  await fs.mkdir(path.join(agentDir, 'skills', 'local-only'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), '# Hello\n');
  await fs.writeFile(path.join(agentDir, 'skills', 'local-only', 'SKILL.md'), '# Local\n');
  await fs.writeFile(path.join(repo, 'pi-sync.json'), JSON.stringify({
    schemaVersion: 1,
    resources: [{ type: 'skill', source: 'resources/skills/hello', target: 'skills/hello' }],
    dependencies: [],
  }));
  await fs.writeFile(path.join(repo, 'pi-sync.lock.json'), JSON.stringify({ schemaVersion: 1, packages: [] }));
  return { repo, agentDir };
}

function gitAt(directory, args, options = {}) {
  const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', ...options });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function pushFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-push-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'setup');
  const bare = path.join(root, 'origin.git');
  await fs.mkdir(repo);
  gitAt(root, ['init', '--bare', '--initial-branch=main', bare]);
  gitAt(repo, ['init', '--initial-branch=main']);
  gitAt(repo, ['config', 'user.name', 'Pi Sync Test']);
  gitAt(repo, ['config', 'user.email', 'pi-sync-test@example.invalid']);
  await fs.mkdir(path.join(repo, 'resources', 'skills', 'hello'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), '# Hello\n');
  await fs.writeFile(path.join(repo, '.gitignore'), 'resources/skills/hello/ignored.txt\n');
  await fs.writeFile(path.join(repo, 'pi-sync.json'), JSON.stringify({ schemaVersion: 1,
    resources: [{ type: 'skill', source: 'resources/skills/hello', target: 'skills/hello' }], dependencies: [] }, null, 2) + '\n');
  await fs.writeFile(path.join(repo, 'pi-sync.lock.json'), JSON.stringify({ schemaVersion: 1, packages: [] }, null, 2) + '\n');
  gitAt(repo, ['add', '--all']);
  gitAt(repo, ['commit', '-m', 'initial setup']);
  gitAt(repo, ['remote', 'add', 'origin', bare]);
  gitAt(repo, ['push', '--set-upstream', 'origin', 'main']);
  return { root, repo, bare };
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

async function fakeGitHubTools(t, sourceRepo) {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-fake-bin-'));
  t.after(() => fs.rm(bin, { recursive: true, force: true }));
  const git = `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nif (args[0] === 'ls-remote') process.exit(process.env.FAKE_GIT_ACCESS === 'yes' ? 0 : 128);\nif (args[0] === 'clone') { const destination = args.at(-1); fs.mkdirSync(destination, { recursive: true }); fs.cpSync(process.env.FAKE_SETUP_REPO, destination, { recursive: true }); process.exit(0); }\nprocess.exit(2);\n`;
  const gh = `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nif (args[0] === '--version') { console.log('gh version 2.74.2'); process.exit(0); }\nif (args[0] === 'auth' && args[1] === 'status') process.exit(process.env.FAKE_GH_AUTH === 'yes' ? 0 : 1);\nif (args[0] === 'repo' && args[1] === 'clone') { const destination = args.at(-1); fs.mkdirSync(destination, { recursive: true }); fs.cpSync(process.env.FAKE_SETUP_REPO, destination, { recursive: true }); process.exit(0); }\nprocess.exit(2);\n`;
  await fs.writeFile(path.join(bin, 'git'), git, { mode: 0o755 });
  await fs.writeFile(path.join(bin, 'gh'), gh, { mode: 0o755 });
  return {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FAKE_SETUP_REPO: sourceRepo,
  };
}

async function bootstrapRepo(t, root) {
  const repo = path.join(root, 'remote-fixture');
  await fs.mkdir(path.join(repo, 'resources', 'skills', 'hello'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), '# Private fixture\n');
  await fs.writeFile(path.join(repo, 'pi-sync.json'), JSON.stringify({
    schemaVersion: 1,
    resources: [{ type: 'skill', source: 'resources/skills/hello', target: 'skills/hello' }],
    dependencies: [],
  }));
  await fs.writeFile(path.join(repo, 'pi-sync.lock.json'), JSON.stringify({ schemaVersion: 1, packages: [] }));
  return repo;
}

function result(processResult) {
  assert.equal(processResult.error, undefined, processResult.error?.message || 'subprocess should launch');
  return JSON.parse(processResult.stdout);
}

async function fakePi(t, { fail = false } = {}) {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-fake-pi-'));
  t.after(() => fs.rm(bin, { recursive: true, force: true }));
  const script = `#!${process.execPath}\nconst fs = require('node:fs');\nif (process.env.PI_CALL_LOG) { try { fs.appendFileSync(process.env.PI_CALL_LOG, process.argv.slice(2).join(' ') + '\\n'); } catch {} }\nprocess.exit(${fail ? 1 : 0});\n`;
  await fs.writeFile(path.join(bin, 'pi'), script, { mode: 0o755 });
  return { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
}

async function piCalls(logFile) {
  try { return (await fs.readFile(logFile, 'utf8')).trim().split('\n').filter(Boolean); } catch { return []; }
}

function runAsync(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('bootstrap fetches a private setup fixture, declares the bundled skill and extension, and installs them through apply', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-bootstrap-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRepo = await bootstrapRepo(t, root);
  const fakeTools = await fakeGitHubTools(t, sourceRepo);
  const agentDir = path.join(root, 'agent');
  const unrelated = path.join(agentDir, 'skills', 'local-only', 'SKILL.md');
  await fs.mkdir(path.dirname(unrelated), { recursive: true });
  await fs.writeFile(unrelated, '# Keep local\n');
  const setupDir = path.join(root, 'private-checkout');

  const bootstrapped = run(['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo-dir', setupDir, '--agent-dir', agentDir], {
    ...fakeTools, FAKE_GIT_ACCESS: 'yes',
  });
  assert.equal(bootstrapped.status, 0, `${bootstrapped.stderr}\n${bootstrapped.stdout}`);
  const output = result(bootstrapped);
  assert.equal(output.ok, true);
  assert.equal(output.authenticationMethod, 'git');
  assert.deepEqual(output.bundledResources, [
    { type: 'skill', source: 'resources/skills/pi-sync', target: 'skills/pi-sync', action: 'declared-and-applied' },
    { type: 'extension', source: 'resources/extensions/pi-sync', target: 'extensions/pi-sync', action: 'declared-and-applied' },
  ]);
  const manifest = JSON.parse(await fs.readFile(path.join(setupDir, 'pi-sync.json'), 'utf8'));
  assert.ok(manifest.resources.some((item) => item.type === 'skill' && item.source === 'resources/skills/pi-sync' && item.target === 'skills/pi-sync'));
  assert.ok(manifest.resources.some((item) => item.type === 'extension' && item.source === 'resources/extensions/pi-sync' && item.target === 'extensions/pi-sync'));
  assert.equal(await fs.readFile(path.join(agentDir, 'skills', 'pi-sync', 'SKILL.md'), 'utf8'),
    await fs.readFile(new URL('../resources/skills/pi-sync/SKILL.md', import.meta.url), 'utf8'));
  assert.equal(await fs.readFile(path.join(agentDir, 'extensions', 'pi-sync', 'index.ts'), 'utf8'),
    await fs.readFile(new URL('../resources/extensions/pi-sync/index.ts', import.meta.url), 'utf8'));
  assert.equal(await fs.readFile(unrelated, 'utf8'), '# Keep local\n');
  const state = await fs.readFile(path.join(agentDir, '.pi-sync', 'state.json'), 'utf8').then(JSON.parse);
  assert.ok(state.resources['skills/pi-sync'], 'the bundled skill is installed and tracked by normal apply state');
});

test('bootstrap uses authenticated GitHub CLI as a fetch fallback without exposing credentials', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-bootstrap-gh-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRepo = await bootstrapRepo(t, root);
  const fakeTools = await fakeGitHubTools(t, sourceRepo);
  const setupDir = path.join(root, 'private-checkout');
  const response = run(['bootstrap', '--repo-url', 'git@github.com:acme/private-setup.git', '--repo-dir', setupDir, '--agent-dir', path.join(root, 'agent')], {
    ...fakeTools, FAKE_GIT_ACCESS: 'no', FAKE_GH_AUTH: 'yes',
  });
  assert.equal(response.status, 0, `${response.stderr}\n${response.stdout}`);
  const output = result(response);
  assert.equal(output.authenticationMethod, 'github-cli');
  assert.equal(output.ok, true);
  assert.doesNotMatch(response.stdout, /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/i);
});

test('bootstrap pauses safely for authentication and returns a resumable command without changing local state', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-bootstrap-auth-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRepo = await bootstrapRepo(t, root);
  const fakeTools = await fakeGitHubTools(t, sourceRepo);
  const agentDir = path.join(root, 'agent');
  const setupDir = path.join(root, 'private-checkout');
  const binDir = path.join(root, 'user-bin');
  const response = run(['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo-dir', setupDir, '--agent-dir', agentDir, '--bin-dir', binDir], {
    ...fakeTools, FAKE_GIT_ACCESS: 'no', FAKE_GH_AUTH: 'no',
  });
  assert.equal(response.status, 1);
  const output = result(response);
  assert.equal(output.errorCode, 'AUTH_REQUIRED');
  assert.deepEqual(output.authentication, { required: true, cliAvailable: true, command: 'gh auth login --hostname github.com', commandArgs: ['gh', 'auth', 'login', '--hostname', 'github.com'], credentialHandling: 'Pi Sync does not request, print, or store credentials' });
  assert.deepEqual(output.resumeArgs, ['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo-dir', setupDir, '--agent-dir', agentDir, '--bin-dir', binDir]);
  await assert.rejects(fs.access(setupDir));
  await assert.rejects(fs.access(agentDir));
  assert.doesNotMatch(response.stdout, /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/i);
});

test('bootstrap reports skill collisions without overwriting local content or retaining a checkout', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-bootstrap-collision-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRepo = await bootstrapRepo(t, root);
  const fakeTools = await fakeGitHubTools(t, sourceRepo);
  const agentDir = path.join(root, 'agent');
  const localSkill = path.join(agentDir, 'skills', 'pi-sync', 'SKILL.md');
  await fs.mkdir(path.dirname(localSkill), { recursive: true });
  await fs.writeFile(localSkill, '# Existing user skill\n');
  const setupDir = path.join(root, 'private-checkout');
  const response = run(['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo-dir', setupDir, '--agent-dir', agentDir], {
    ...fakeTools, FAKE_GIT_ACCESS: 'yes',
  });
  assert.equal(response.status, 1, `${response.stderr}\n${response.stdout}`);
  const output = result(response);
  assert.equal(output.errorCode, 'APPLY_CONFLICT');
  assert.equal(output.plan.conflicts[0].target, 'skills/pi-sync');
  assert.equal(await fs.readFile(localSkill, 'utf8'), '# Existing user skill\n');
  await assert.rejects(fs.access(setupDir));
});

test('bootstrap detects manifest-owned skill target collisions without editing the setup or local installation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-bootstrap-manifest-collision-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRepo = await bootstrapRepo(t, root);
  await fs.mkdir(path.join(sourceRepo, 'resources', 'skills', 'other'), { recursive: true });
  await fs.writeFile(path.join(sourceRepo, 'resources', 'skills', 'other', 'SKILL.md'), '# Other\n');
  const manifestPath = path.join(sourceRepo, 'pi-sync.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.resources.push({ type: 'skill', source: 'resources/skills/other', target: 'skills/pi-sync' });
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const fakeTools = await fakeGitHubTools(t, sourceRepo);
  const setupDir = path.join(root, 'private-checkout');
  const agentDir = path.join(root, 'agent');
  const response = run(['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo-dir', setupDir, '--agent-dir', agentDir], {
    ...fakeTools, FAKE_GIT_ACCESS: 'yes',
  });
  assert.equal(response.status, 1);
  const output = result(response);
  assert.equal(output.errorCode, 'RESOURCE_COLLISION');
  assert.equal(output.collision.target, 'skills/pi-sync');
  await assert.rejects(fs.access(setupDir));
  await assert.rejects(fs.access(agentDir));
  assert.deepEqual(JSON.parse(await fs.readFile(manifestPath, 'utf8')), manifest);
});

test('public npm package allowlist includes the CLI, skill, and extension but excludes tests and scratch data', async () => {
  const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(packageJson.files, ['README.md', 'src/cli.js', 'src/packages.js', 'src/prerequisites.js', 'resources/skills/pi-sync/SKILL.md', 'resources/extensions/pi-sync/index.ts', 'resources/extensions/pi-sync/status.js', 'resources/extensions/pi-sync/README.md']);
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8', cwd: path.dirname(fileURLToPath(new URL('../package.json', import.meta.url))) });
  assert.equal(packed.status, 0, packed.stderr);
  const files = JSON.parse(packed.stdout)[0].files.map((item) => item.path);
  assert.ok(files.includes('src/cli.js'));
  assert.ok(files.includes('src/prerequisites.js'));
  assert.ok(files.includes('src/packages.js'));
  assert.ok(files.includes('resources/skills/pi-sync/SKILL.md'));
  assert.ok(files.includes('resources/extensions/pi-sync/index.ts'));
  assert.ok(files.includes('resources/extensions/pi-sync/status.js'));
  assert.ok(!files.some((item) => /^(?:test(?:\/|$)|test-support(?:\/|$)|\.scratch(?:\/|$)|resources\/skills\/(?!pi-sync\/))/.test(item)));
  assert.deepEqual(files.sort(), ['README.md', 'package.json', 'resources/extensions/pi-sync/README.md', 'resources/extensions/pi-sync/index.ts', 'resources/extensions/pi-sync/status.js', 'resources/skills/pi-sync/SKILL.md', 'src/cli.js', 'src/packages.js', 'src/prerequisites.js']);
});

test('supported agent commands share a versioned JSON response contract', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const responses = [];
  for (const command of ['status', 'plan', 'apply']) {
    const processResult = run([command, '--repo', repo, '--agent-dir', agentDir]);
    assert.equal(processResult.status, 0, processResult.stderr);
    responses.push(result(processResult));
  }
  const added = run(['add', '--type', 'skill', '--source', 'skills/local-only', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(added.status, 0, added.stderr);
  responses.push(result(added));
  const removed = run(['remove', '--type', 'skill', '--target', 'skills/local-only', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(removed.status, 0, removed.stderr);
  responses.push(result(removed));
  const pruned = run(['prune', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(pruned.status, 0, pruned.stderr);
  responses.push(result(pruned));

  for (const response of responses) {
    assert.equal(response.apiVersion, 1);
    assert.equal(response.ok, true);
    assert.equal(response.exitCode, 0);
    assert.ok(['status', 'plan', 'apply', 'add', 'remove', 'prune'].includes(response.command));
  }
  const manifestAfterRemove = JSON.parse(await fs.readFile(path.join(repo, 'pi-sync.json'), 'utf8'));
  assert.equal(manifestAfterRemove.resources.some((item) => item.target === 'skills/local-only'), false);

  const skill = await fs.readFile(new URL('../resources/skills/pi-sync/SKILL.md', import.meta.url), 'utf8');
  const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(packageJson.files.includes('resources/skills/pi-sync/SKILL.md'));
  for (const workflow of ['pi-sync status', 'pi-sync plan', 'pi-sync apply', 'pi-sync add', 'pi-sync remove', 'pi-sync prune', 'pi-sync prune --confirm']) {
    assert.ok(skill.includes(workflow), `skill documents ${workflow}`);
  }
});

test('--version reports the installed package name and version without touching repositories', async () => {
  const response = run(['--version']);
  assert.equal(response.status, 0, response.stderr);
  const output = result(response);
  assert.equal(output.apiVersion, 1);
  assert.equal(output.command, 'version');
  assert.equal(output.ok, true);
  assert.equal(output.exitCode, 0);
  const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(output.name, packageJson.name);
  assert.equal(output.version, packageJson.version);

  const extra = run(['--version', 'extra']);
  assert.equal(extra.status, 2);
  const extraOutput = result(extra);
  assert.equal(extraOutput.ok, false);
  assert.equal(extraOutput.errorCode, 'VALIDATION_ERROR');
  assert.equal(extraOutput.exitCode, 2);
});

test('agent API reports conflicts and invalid operations as structured JSON with meaningful exits', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const target = path.join(agentDir, 'skills', 'hello');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'SKILL.md'), '# Keep local\n');

  for (const command of ['status', 'plan', 'apply']) {
    const processResult = run([command, '--repo', repo, '--agent-dir', agentDir]);
    assert.equal(processResult.status, 1, processResult.stderr);
    const output = result(processResult);
    assert.equal(output.apiVersion, 1);
    assert.equal(output.ok, false);
    assert.equal(output.exitCode, 1);
    assert.equal(output.conflicts[0].target, 'skills/hello');
    assert.equal(output.conflicts[0].action, 'collision');
  }
  assert.equal(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8'), '# Keep local\n');

  const invalid = run(['status', '--unknown-option']);
  assert.equal(invalid.status, 2);
  const output = result(invalid);
  assert.equal(output.apiVersion, 1);
  assert.equal(output.ok, false);
  assert.equal(output.errorCode, 'VALIDATION_ERROR');
  assert.equal(output.exitCode, 2);
  assert.equal(output.details.message, output.error);
});

test('plan, apply and repeat apply through the real CLI subprocess; preserve unlisted resources', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const planned = run(['plan', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(planned.status, 0, planned.stderr);
  assert.equal(result(planned).actions[0].action, 'install');
  await assert.rejects(fs.access(path.join(agentDir, 'skills', 'hello')));

  const first = run(['apply', '--repo', repo], { PI_CODING_AGENT_DIR: agentDir });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(result(first).actions[0].action, 'installed');
  assert.equal(await fs.readFile(path.join(agentDir, 'skills', 'hello', 'SKILL.md'), 'utf8'), '# Hello\n');
  assert.equal(await fs.readFile(path.join(agentDir, 'skills', 'local-only', 'SKILL.md'), 'utf8'), '# Local\n');

  const second = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(result(second).actions[0].action, 'unchanged');
});

test('invalid manifest and unsupported declarations fail before changing the local installation', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const target = path.join(agentDir, 'skills', 'hello');
  await fs.writeFile(path.join(repo, 'pi-sync.json'), '{ broken');
  const malformed = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(malformed.status, 2);
  assert.match(result(malformed).error, /not valid JSON/);
  await assert.rejects(fs.access(target));

  await fs.writeFile(path.join(repo, 'pi-sync.json'), JSON.stringify({
    schemaVersion: 1,
    resources: [{ type: 'theme', source: 'resources/skills/hello', target: 'skills/hello' }],
    dependencies: [],
  }));
  const unsupported = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(unsupported.status, 2);
  assert.match(result(unsupported).error, /Unsupported resource type/);
  await assert.rejects(fs.access(target));

  const validManifest = JSON.parse(await fs.readFile(path.join(repo, 'pi-sync.json'), 'utf8'));
  validManifest.resources[0].type = 'skill';
  await fs.writeFile(path.join(repo, 'pi-sync.json'), JSON.stringify(validManifest));
  await fs.writeFile(path.join(repo, 'pi-sync.lock.json'), JSON.stringify({ schemaVersion: 1, packages: [{ name: 'not-yet-supported' }] }));
  const unsupportedLock = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(unsupportedLock.status, 2);
  assert.match(result(unsupportedLock).error, /lockfile packages\[0\] does not match exactly one declared dependency/);
  await assert.rejects(fs.access(target));
});

test('manifest rejects resource targets that overlap under Windows case-insensitive path semantics', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const secondSource = path.join(repo, 'resources', 'skills', 'nested');
  await fs.mkdir(secondSource, { recursive: true });
  await fs.writeFile(path.join(secondSource, 'SKILL.md'), '# Nested\\n');
  await fs.writeFile(path.join(repo, 'pi-sync.json'), JSON.stringify({
    schemaVersion: 1,
    resources: [
      { type: 'skill', source: 'resources/skills/hello', target: 'skills/Shared' },
      { type: 'skill', source: 'resources/skills/nested', target: 'skills/shared/child' },
    ],
    dependencies: [],
  }));

  const rejected = run(['plan', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(rejected.status, 2);
  assert.match(result(rejected).error, /Overlapping resource targets/);
  assert.match(result(rejected).error, /skills\/Shared/);
  assert.match(result(rejected).error, /skills\/shared\/child/);
  await assert.rejects(fs.access(path.join(agentDir, 'skills', 'Shared')));
});

test('existing differing target is a reported collision and is not overwritten', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const target = path.join(agentDir, 'skills', 'hello');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'SKILL.md'), '# Local edit\n');
  const applied = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(applied.status, 1);
  const output = result(applied);
  assert.equal(output.actions[0].action, 'collision');
  assert.equal(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8'), '# Local edit\n');
});

test('uses the durable baseline for local-only updates and concurrent resource conflicts', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const targetFile = path.join(agentDir, 'skills', 'hello', 'SKILL.md');
  const initial = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(initial.status, 0, initial.stderr);
  assert.equal(await fs.readFile(targetFile, 'utf8'), '# Hello\n');
  assert.equal(await fs.readFile(path.join(agentDir, '.pi-sync', 'state.json'), 'utf8').then(JSON.parse).then((state) => state.schemaVersion), 1);

  const sourceFile = path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md');
  await fs.writeFile(sourceFile, '# Repository update\n');
  const updated = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(updated.status, 0, updated.stderr);
  assert.equal(result(updated).actions[0].action, 'updated');
  assert.equal(await fs.readFile(targetFile, 'utf8'), '# Repository update\n');

  await fs.writeFile(targetFile, '# Local-only edit\n');
  const divergence = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(divergence.status, 0, divergence.stderr);
  assert.equal(result(divergence).actions[0].action, 'local-divergence');
  assert.equal(await fs.readFile(targetFile, 'utf8'), '# Local-only edit\n');

  await fs.writeFile(sourceFile, '# Concurrent repository edit\n');
  const conflict = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(conflict.status, 1);
  assert.equal(result(conflict).actions[0].action, 'conflict');
  assert.equal(await fs.readFile(targetFile, 'utf8'), '# Local-only edit\n');
});

test('reconciles independent resource files separately and conflicts only on the overlapping file', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const source = path.join(repo, 'resources', 'skills', 'hello');
  const target = path.join(agentDir, 'skills', 'hello');
  await fs.writeFile(path.join(source, 'a.md'), 'A baseline\n');
  await fs.writeFile(path.join(source, 'b.md'), 'B baseline\n');
  assert.equal(run(['apply', '--repo', repo, '--agent-dir', agentDir]).status, 0);

  await fs.writeFile(path.join(target, 'a.md'), 'A local edit\n');
  await fs.writeFile(path.join(source, 'b.md'), 'B repository edit\n');
  const independent = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(independent.status, 0, independent.stderr);
  const independentAction = result(independent).actions[0];
  assert.equal(independentAction.action, 'updated');
  assert.equal(independentAction.files.find((file) => file.path === 'a.md').action, 'local-divergence');
  assert.equal(independentAction.files.find((file) => file.path === 'b.md').action, 'update');
  assert.equal(await fs.readFile(path.join(target, 'a.md'), 'utf8'), 'A local edit\n');
  assert.equal(await fs.readFile(path.join(target, 'b.md'), 'utf8'), 'B repository edit\n');

  await fs.writeFile(path.join(target, 'a.md'), 'A concurrent local edit\n');
  await fs.writeFile(path.join(source, 'a.md'), 'A concurrent repository edit\n');
  await fs.writeFile(path.join(source, 'b.md'), 'B second repository edit\n');
  const conflict = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(conflict.status, 1);
  const conflictAction = result(conflict).actions[0];
  assert.equal(conflictAction.action, 'conflict');
  assert.equal(conflictAction.files.find((file) => file.path === 'a.md').action, 'conflict');
  assert.equal(conflictAction.files.find((file) => file.path === 'b.md').action, 'update');
  assert.equal(await fs.readFile(path.join(target, 'a.md'), 'utf8'), 'A concurrent local edit\n');
  assert.equal(await fs.readFile(path.join(target, 'b.md'), 'utf8'), 'B second repository edit\n');
});

test('initial replacement rename failures leave existing resource and settings intact', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const targetDir = path.join(agentDir, 'skills', 'hello');
  const targetFile = path.join(targetDir, 'SKILL.md');
  assert.equal(run(['apply', '--repo', repo, '--agent-dir', agentDir]).status, 0);
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), '# repository update\n');
  const injectedEnv = (source) => ({
    PI_SYNC_FAIL_RENAME_FROM: source,
    NODE_OPTIONS: `--require=${fileURLToPath(new URL('../test-support/fail-first-rename.cjs', import.meta.url))}`,
  });
  const resourceFailure = run(['apply', '--repo', repo, '--agent-dir', agentDir], injectedEnv(targetDir));
  assert.notEqual(resourceFailure.status, 0);
  assert.match(result(resourceFailure).error, /injected initial target rename failure/);
  assert.equal(await fs.readFile(targetFile, 'utf8'), '# Hello\n');

  const settingsPath = path.join(agentDir, 'settings.json');
  const manifestPath = path.join(repo, 'pi-sync.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.settings = [{ target: 'settings.json', fields: [{ path: '/theme', value: 'dark' }] }];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  assert.equal(run(['apply', '--repo', repo, '--agent-dir', agentDir]).status, 0);
  manifest.settings[0].fields[0].value = 'light';
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const settingsFailure = run(['apply', '--repo', repo, '--agent-dir', agentDir], injectedEnv(settingsPath));
  assert.notEqual(settingsFailure.status, 0);
  assert.match(result(settingsFailure).error, /injected initial target rename failure/);
  assert.equal(await fs.readFile(settingsPath, 'utf8').then(JSON.parse).then((value) => value.theme), 'dark');
});

test('concurrent contenders do not remove or bypass a stale apply lock', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const lockPath = path.join(agentDir, '.pi-sync', 'apply.lock');
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const staleLock = JSON.stringify({ pid: 2147483647, token: 'stale-owner', startedAt: '2000-01-01T00:00:00.000Z' });
  await fs.writeFile(lockPath, staleLock, { mode: 0o600 });

  const args = ['apply', '--repo', repo, '--agent-dir', agentDir];
  const [first, second] = await Promise.all([runAsync(args), runAsync(args)]);
  for (const contender of [first, second]) {
    assert.equal(contender.status, 1);
    assert.match(JSON.parse(contender.stdout).error, /stale Pi Sync apply lock/);
  }
  assert.equal(await fs.readFile(lockPath, 'utf8'), staleLock);
  await assert.rejects(fs.access(path.join(agentDir, 'skills', 'hello')));
});

test('merges explicitly managed settings fields and preserves unknown and machine-local values', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const settingsPath = path.join(agentDir, 'settings.json');
  await fs.writeFile(settingsPath, JSON.stringify({ customLocal: 'keep', theme: 'unmanaged-theme', model: { name: 'initial-model', localFlag: true } }, null, 2));
  const manifestPath = path.join(repo, 'pi-sync.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.settings = [{ target: 'settings.json', fields: [
    { path: '/theme', value: 'dark' },
    { path: '/model/name', value: 'managed-model' },
  ] }];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));

  const first = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(first.status, 1, 'pre-existing selected settings values are collisions');
  assert.equal(result(first).actions[1].fields[0].action, 'collision');
  assert.equal(await fs.readFile(settingsPath, 'utf8').then(JSON.parse).then((value) => value.model.name), 'initial-model');

  // A selected field absent locally can be safely introduced while unrelated fields remain intact.
  const initialSettings = { customLocal: 'keep', model: { localFlag: true } };
  await fs.writeFile(settingsPath, JSON.stringify(initialSettings, null, 2));
  const applied = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(applied.status, 0, applied.stderr);
  const merged = await fs.readFile(settingsPath, 'utf8').then(JSON.parse);
  assert.equal(merged.theme, 'dark');
  assert.equal(merged.model.name, 'managed-model');
  assert.equal(merged.model.localFlag, true);
  assert.equal(merged.customLocal, 'keep');

  manifest.settings[0].fields[0].value = 'light';
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  merged.model.name = 'machine-model';
  merged.machineOnly = true;
  await fs.writeFile(settingsPath, JSON.stringify(merged, null, 2));
  const partial = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(partial.status, 0, partial.stderr);
  const partiallyMerged = await fs.readFile(settingsPath, 'utf8').then(JSON.parse);
  assert.equal(partiallyMerged.theme, 'light');
  assert.equal(partiallyMerged.model.name, 'machine-model');
  assert.equal(partiallyMerged.model.localFlag, true);
  assert.equal(partiallyMerged.machineOnly, true);

  manifest.settings[0].fields[0].value = 'repository-again';
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  partiallyMerged.theme = 'local-theme';
  await fs.writeFile(settingsPath, JSON.stringify(partiallyMerged, null, 2));
  const conflict = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(conflict.status, 1);
  assert.equal(result(conflict).actions[1].fields[0].action, 'conflict');
  assert.equal(await fs.readFile(settingsPath, 'utf8').then(JSON.parse).then((value) => value.theme), 'local-theme');
  const backupDir = path.join(agentDir, '.pi-sync', 'backups');
  assert.ok((await fs.readdir(backupDir)).length > 0, 'prior settings are retained in recoverable backups');
});

test('rejects credential-like fields in portable settings before changing local files', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.settings = [{ target: 'settings.json', fields: [{ path: '/provider/apiKey', value: 'not-a-real-secret' }] }];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const applied = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(applied.status, 2);
  assert.match(result(applied).error, /credential-like key/);
  await assert.rejects(fs.access(path.join(agentDir, 'skills', 'hello')));
  await assert.rejects(fs.access(path.join(agentDir, 'settings.json')));
});

test('manages credential-like settings fields as environment references only', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const settingsPath = path.join(agentDir, 'settings.json');

  manifest.settings = [{ target: 'settings.json', fields: [{ path: '/providers/local', value: { baseUrl: 'http://llama-swap:8080/v1', apiKey: '$LLAMA_SWAP_API_KEY', models: [{ id: 'qwen-3.8-27b', maxTokens: 131072 }] } }] }];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const applied = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(applied.status, 0, applied.stderr);
  const value = await fs.readFile(settingsPath, 'utf8').then(JSON.parse);
  assert.equal(value.providers.local.apiKey, '$LLAMA_SWAP_API_KEY');
  assert.equal(value.providers.local.models[0].maxTokens, 131072);

  const braced = { path: '/providers/local', value: { apiKey: '${BRACED_NAME}' } };
  manifest.settings = [{ target: 'settings.json', fields: [braced] }];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const appliedBraced = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(appliedBraced.status, 0, appliedBraced.stderr);

  // The safe placeholder is Pi's documented way to satisfy the mandatory apiKey
  // field for local endpoints that require no real key, without a per-machine env var.
  const placeholder = { path: '/providers/local', value: { baseUrl: 'http://localhost:11434/v1', apiKey: '__PLACEHOLDER__' } };
  manifest.settings = [{ target: 'settings.json', fields: [placeholder] }];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const appliedPlaceholder = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(appliedPlaceholder.status, 0, appliedPlaceholder.stderr);
  const placeholderValue = await fs.readFile(settingsPath, 'utf8').then(JSON.parse);
  assert.equal(placeholderValue.providers.local.apiKey, '__PLACEHOLDER__');
  assert.equal(placeholderValue.providers.local.baseUrl, 'http://localhost:11434/v1');

  for (const badValue of ['literal-secret', '!echo pwned', '$$NAME', '$1BAD', '__PLACEHOLDER__EXTRA', { env: 'LLAMA_SWAP_API_KEY' }, 42]) {
    manifest.settings = [{ target: 'settings.json', fields: [{ path: '/providers/local', value: { apiKey: badValue } }] }];
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    const rejected = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
    assert.equal(rejected.status, 2, `expected rejection for ${JSON.stringify(badValue)}`);
    assert.match(result(rejected).error, /credential-like key/);
  }

  manifest.settings = [{ target: 'settings.json', fields: [{ path: '/providers/local', value: { authToken: 'literal' } }] }];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const rejectedAuth = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(rejectedAuth.status, 2);
  assert.match(result(rejectedAuth).error, /credential-like key \(authToken\)/);
});

// Sets up a baseline for settings fields, then mutates the local file the way
// Pi does when a user changes a setting in the TUI.
async function settingsFixture(t, fields, target = 'settings.json') {
  const { repo, agentDir } = await fixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.settings = [{ target, fields }];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const applied = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(applied.status, 0, applied.stderr);
  const localPath = path.join(agentDir, target);
  return { repo, agentDir, manifestPath, localPath };
}

test('sync previews local-only settings changes and applies them to the manifest', async (t) => {
  const { repo, agentDir, manifestPath, localPath } = await settingsFixture(t, [
    { path: '/theme', value: 'dark' },
    { path: '/defaultProvider', value: 'github-copilot' },
  ]);
  const local = JSON.parse(await fs.readFile(localPath, 'utf8'));
  local.theme = 'light';
  local.defaultProvider = 'openrouter';
  await fs.writeFile(localPath, `${JSON.stringify(local, null, 2)}\n`);

  const preview = run(['sync', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(preview.status, 0, preview.stderr);
  const plan = result(preview);
  assert.equal(plan.mode, 'preview');
  assert.deepEqual(plan.syncable.map((item) => item.path).sort(), ['/defaultProvider', '/theme']);
  assert.deepEqual(plan.conflicts, []);
  const previewManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.equal(previewManifest.settings[0].fields.find((field) => field.path === '/theme').value, 'dark', 'preview must not write the manifest');

  const applied = run(['sync', '--apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(applied.status, 0, applied.stderr);
  const output = result(applied);
  assert.equal(output.mode, 'applied');
  assert.equal(output.ok, true);
  assert.deepEqual(output.synced.map((item) => item.path).sort(), ['/defaultProvider', '/theme']);
  assert.equal(output.synced.find((item) => item.path === '/theme').from, 'dark');
  assert.equal(output.synced.find((item) => item.path === '/theme').to, 'light');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.equal(manifest.settings[0].fields.find((field) => field.path === '/theme').value, 'light');
  assert.equal(manifest.settings[0].fields.find((field) => field.path === '/defaultProvider').value, 'openrouter');

  const again = run(['sync', '--apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(again.status, 0, again.stderr);
  const idle = result(again);
  assert.deepEqual(idle.synced, []);
  assert.match(idle.note, /Nothing to sync/);

  // A second local change after a sync must still be eligible: the first sync
  // re-baselines the field so this change is a local-only divergence, not a
  // both-sides conflict against the stale pre-sync baseline.
  const local2 = JSON.parse(await fs.readFile(localPath, 'utf8'));
  local2.theme = 'dark';
  await fs.writeFile(localPath, `${JSON.stringify(local2, null, 2)}\n`);
  const second = run(['sync', '--apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(second.status, 0, second.stderr);
  const secondOutput = result(second);
  assert.deepEqual(secondOutput.synced.map((item) => item.path), ['/theme']);
  assert.deepEqual(secondOutput.conflicts, [], 're-baselining prevents a false conflict on the next change');
  assert.equal(JSON.parse(await fs.readFile(manifestPath, 'utf8')).settings[0].fields.find((field) => field.path === '/theme').value, 'dark');

  const reapply = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(reapply.status, 0, reapply.stderr);
  assert.equal(result(reapply).ok, true, 'apply after sync is conflict-free and re-baselines the fields');
});

test('sync writes eligible fields but never overwrites fields changed in both places', async (t) => {
  const { repo, agentDir, manifestPath, localPath } = await settingsFixture(t, [
    { path: '/theme', value: 'dark' },
    { path: '/defaultThinkingLevel', value: 'medium' },
  ]);
  const local = JSON.parse(await fs.readFile(localPath, 'utf8'));
  local.theme = 'light'; // local-only change: eligible
  local.defaultThinkingLevel = 'high'; // local change...
  await fs.writeFile(localPath, `${JSON.stringify(local, null, 2)}\n`);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); // ...and a repository change: conflict
  manifest.settings[0].fields.find((field) => field.path === '/defaultThinkingLevel').value = 'low';
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const applied = run(['sync', '--apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(applied.status, 1, applied.stderr);
  const output = result(applied);
  assert.equal(output.ok, false);
  assert.deepEqual(output.synced.map((item) => item.path), ['/theme'], 'independent eligible fields are still synced');
  assert.deepEqual(output.conflicts, [{ target: 'settings.json', path: '/defaultThinkingLevel', action: 'conflict', reason: 'local and setup repository both changed since the last apply' }]);
  const after = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.equal(after.settings[0].fields.find((field) => field.path === '/theme').value, 'light');
  assert.equal(after.settings[0].fields.find((field) => field.path === '/defaultThinkingLevel').value, 'low', 'conflicted repository value is preserved');
  assert.equal(JSON.parse(await fs.readFile(localPath, 'utf8')).defaultThinkingLevel, 'high', 'conflicted local value is preserved');
});

test('sync rejects non-portable and suspected-secret local values before writing', async (t) => {
  const { repo, agentDir, manifestPath, localPath } = await settingsFixture(t, [
    { path: '/providers/local', value: { baseUrl: 'http://llama-swap:8080/v1', apiKey: '$LLAMA_SWAP_API_KEY' } },
    { path: '/theme', value: 'dark' },
  ], 'models.json');
  const local = JSON.parse(await fs.readFile(localPath, 'utf8'));
  local.providers.local.apiKey = 'sk-supersecret12345'; // literal credential: not portable
  local.theme = 'ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ'; // suspected GitHub token
  await fs.writeFile(localPath, `${JSON.stringify(local, null, 2)}\n`);

  // The suspected secret blocks the whole write, so nothing is synced.
  const blocked = run(['sync', '--apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(blocked.status, 1, blocked.stderr);
  assert.equal(result(blocked).errorCode, 'SYNC_BLOCKED');
  assert.match(result(blocked).error, /suspected credential material/);
  const untouched = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.equal(untouched.settings[0].fields.find((field) => field.path === '/providers/local').value.apiKey, '$LLAMA_SWAP_API_KEY', 'nothing is written when the secret scan blocks');
  assert.equal(untouched.settings[0].fields.find((field) => field.path === '/theme').value, 'dark');

  // With the secret gone, the literal credential is rejected portability-wise.
  const portable = JSON.parse(await fs.readFile(localPath, 'utf8'));
  portable.theme = 'dark';
  await fs.writeFile(localPath, `${JSON.stringify(portable, null, 2)}\n`);
  const rejected = run(['sync', '--apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(rejected.status, 1, rejected.stderr);
  const output = result(rejected);
  assert.equal(output.ok, false);
  assert.deepEqual(output.synced, []);
  assert.equal(output.rejected.length, 1);
  assert.equal(output.rejected[0].path, '/providers/local');
  assert.match(output.rejected[0].reason, /credential-like key \(apiKey\)/);
  assert.deepEqual(output.review, []);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.equal(manifest.settings[0].fields.find((field) => field.path === '/providers/local').value.apiKey, '$LLAMA_SWAP_API_KEY', 'manifest is untouched when any field is rejected');

  // The placeholder itself is portable and syncs cleanly.
  portable.providers.local.apiKey = '__PLACEHOLDER__';
  await fs.writeFile(localPath, `${JSON.stringify(portable, null, 2)}\n`);
  const ok = run(['sync', '--apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(result(ok).synced.map((item) => item.path), ['/providers/local']);
  assert.equal(JSON.parse(await fs.readFile(manifestPath, 'utf8')).settings[0].fields.find((field) => field.path === '/providers/local').value.apiKey, '__PLACEHOLDER__');
});

test('sync reports locally removed managed fields for review without unmanaging them', async (t) => {
  const { repo, agentDir, manifestPath, localPath } = await settingsFixture(t, [{ path: '/theme', value: 'dark' }]);
  const local = JSON.parse(await fs.readFile(localPath, 'utf8'));
  delete local.theme;
  await fs.writeFile(localPath, `${JSON.stringify(local, null, 2)}\n`);

  const applied = run(['sync', '--apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(applied.status, 1, applied.stderr);
  const output = result(applied);
  assert.equal(output.ok, false);
  assert.deepEqual(output.synced, []);
  assert.equal(output.review.length, 1);
  assert.equal(output.review[0].path, '/theme');
  assert.match(output.review[0].reason, /removed locally/);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.equal(manifest.settings[0].fields.find((field) => field.path === '/theme').value, 'dark', 'removals are never back-synced automatically');
});

test('sync requires an existing agent directory and never writes on preview', async (t) => {
  const { repo, agentDir, manifestPath, localPath } = await settingsFixture(t, [{ path: '/theme', value: 'dark' }]);
  const missing = run(['sync', '--repo', repo, '--agent-dir', path.join(agentDir, 'nope')]);
  assert.equal(missing.status, 2);
  assert.match(result(missing).error, /agent directory does not exist/);

  const local = JSON.parse(await fs.readFile(localPath, 'utf8'));
  local.theme = 'light';
  await fs.writeFile(localPath, `${JSON.stringify(local, null, 2)}\n`);
  const manifestBefore = await fs.readFile(manifestPath, 'utf8');
  const preview = run(['sync', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestBefore);
});

test('serializes concurrent sync --apply runs the way multiple Pi sessions would trigger them', async (t) => {
  const { repo, agentDir, manifestPath, localPath } = await settingsFixture(t, [{ path: '/theme', value: 'dark' }]);
  const local = JSON.parse(await fs.readFile(localPath, 'utf8'));
  local.theme = 'light';
  await fs.writeFile(localPath, `${JSON.stringify(local, null, 2)}\n`);
  const args = ['sync', '--apply', '--repo', repo, '--agent-dir', agentDir];
  const [first, second] = await Promise.all([runAsync(args), runAsync(args)]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  // The winner syncs the change; the loser waits on the agent lock, re-reads the
  // fresh manifest and state, and no-ops. Exactly one run reports the sync.
  const [a, b] = [result(first), result(second)];
  assert.equal(a.synced.length + b.synced.length, 1, 'only one concurrent sync should write the field');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.equal(manifest.settings[0].fields.find((field) => field.path === '/theme').value, 'light');
  const idle = run(['sync', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(idle.status, 0, idle.stderr);
  assert.match(result(idle).note, /Nothing to sync/);
});

test('sync recovers from a torn settings read and fails clearly on genuinely invalid files', async (t) => {
  const { repo, agentDir, manifestPath, localPath } = await settingsFixture(t, [{ path: '/theme', value: 'dark' }]);

  // A file that stays invalid must still fail clearly: the transient-read
  // retry must not mask a real error, and nothing may be written.
  await fs.writeFile(localPath, '{ "theme": "light"');
  const invalid = run(['sync', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(invalid.status, 2);
  assert.match(result(invalid).error, /not valid JSON/);
  assert.equal(JSON.parse(await fs.readFile(manifestPath, 'utf8')).settings[0].fields[0].value, 'dark', 'failed sync must not write the manifest');

  // A file that is only briefly half-written (as Pi's in-place settings write
  // can leave it) must recover on the retry. Simulate the concurrent writer by
  // repairing the file as soon as the CLI's first read is observed (its atime
  // advances past the torn write's mtime).
  await fs.writeFile(localPath, '{ "theme": "li');
  const repair = async () => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const stat = await fs.stat(localPath);
      if (stat.atimeMs >= stat.mtimeMs) {
        await fs.writeFile(localPath, `${JSON.stringify({ theme: 'light' }, null, 2)}\n`);
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return false;
  };
  const [repaired, didRepair] = await Promise.all([
    runAsync(['sync', '--apply', '--repo', repo, '--agent-dir', agentDir]),
    repair(),
  ]);
  assert.ok(didRepair, 'the CLI read of the torn file should be observable via atime');
  assert.equal(repaired.status, 0, repaired.stderr);
  const output = result(repaired);
  assert.equal(output.ok, true, JSON.stringify(output));
  assert.deepEqual(output.synced.map((item) => item.path), ['/theme']);
  assert.equal(JSON.parse(await fs.readFile(manifestPath, 'utf8')).settings[0].fields[0].value, 'light');
});

test('status and plan report the repository publish state for git setups', async (t) => {
  const { root, repo, bare } = await pushFixture(t);
  const agentDir = path.join(root, 'agent');
  await fs.mkdir(agentDir);
  const args = ['--repo', repo, '--agent-dir', agentDir];
  const manifestPath = path.join(repo, 'pi-sync.json');
  const statusOutput = (processResult) => {
    assert.equal(processResult.status, 0, processResult.stderr);
    return result(processResult);
  };

  // Clean at upstream: no dirt, no ahead, no behind.
  assert.deepEqual(statusOutput(run(['status', ...args])).repository, { dirty: false, ahead: 0, behind: 0 });
  assert.deepEqual(statusOutput(run(['plan', ...args])).repository, { dirty: false, ahead: 0, behind: 0 });

  // Uncommitted manifest change: the tracked tree is dirty.
  await fs.appendFile(manifestPath, '\n');
  assert.deepEqual(statusOutput(run(['status', ...args])).repository, { dirty: true, ahead: 0, behind: 0 });

  // Local commit: one ahead of upstream.
  gitAt(repo, ['commit', '-am', 'local manifest change']);
  assert.deepEqual(statusOutput(run(['status', ...args])).repository, { dirty: false, ahead: 1, behind: 0 });

  // Remote advancement committed in a clone of the bare origin: one behind.
  const clone = path.join(root, 'second-clone');
  gitAt(root, ['clone', bare, clone]);
  gitAt(clone, ['config', 'user.name', 'Pi Sync Test']);
  gitAt(clone, ['config', 'user.email', 'pi-sync-test@example.invalid']);
  await fs.appendFile(path.join(clone, 'resources', 'skills', 'hello', 'SKILL.md'), '# Remote update\n');
  gitAt(clone, ['commit', '-am', 'remote change']);
  gitAt(clone, ['push', 'origin', 'main']);
  gitAt(repo, ['fetch', '--quiet']);
  assert.deepEqual(statusOutput(run(['status', ...args])).repository, { dirty: false, ahead: 1, behind: 1 });

  // No remote configured: ahead/behind are null, dirt is still reported.
  const isolated = path.join(root, 'isolated');
  gitAt(root, ['init', '--initial-branch=main', isolated]);
  gitAt(isolated, ['config', 'user.name', 'Pi Sync Test']);
  gitAt(isolated, ['config', 'user.email', 'pi-sync-test@example.invalid']);
  for (const file of ['pi-sync.json', 'pi-sync.lock.json']) await fs.cp(path.join(repo, file), path.join(isolated, file));
  await fs.cp(path.join(repo, 'resources'), path.join(isolated, 'resources'), { recursive: true });
  gitAt(isolated, ['add', '--all']);
  gitAt(isolated, ['commit', '-m', 'initial setup']);
  const isolatedOutput = statusOutput(run(['status', '--repo', isolated, '--agent-dir', agentDir]));
  assert.deepEqual(isolatedOutput.repository, { dirty: false, ahead: null, behind: null });
  assert.deepEqual(isolatedOutput.summary, { localPending: 0, remotePending: 1, needsReview: 0, clean: false },
    'without an upstream the summary degrades to unapplied actions');

  // Non-git setup directory: the repository block is omitted entirely.
  const { repo: plainRepo, agentDir: plainAgentDir } = await fixture(t);
  const nonGit = statusOutput(run(['status', '--repo', plainRepo, '--agent-dir', plainAgentDir]));
  assert.equal('repository' in nonGit, false);
  assert.equal('repository' in statusOutput(run(['plan', '--repo', plainRepo, '--agent-dir', plainAgentDir])), false);
  assert.deepEqual(nonGit.summary, { localPending: 0, remotePending: 1, needsReview: 0, clean: false });
});

test('status and plan carry the sync preview classification without writing or locking', async (t) => {
  const { repo, agentDir, manifestPath, localPath } = await settingsFixture(t, [
    { path: '/theme', value: 'dark' },
    { path: '/defaultProvider', value: 'github-copilot' },
    { path: '/providers/local', value: { baseUrl: 'http://llama-swap:8080/v1', apiKey: '$LLAMA_SWAP_API_KEY' } },
    { path: '/defaultThinkingLevel', value: 'medium' },
  ]);
  // One field per classification: local-only change (syncable), both-sides
  // change (conflict), non-portable local value (rejected), local removal
  // (review).
  const local = JSON.parse(await fs.readFile(localPath, 'utf8'));
  local.theme = 'light';
  local.defaultProvider = 'openrouter';
  local.providers.local.apiKey = 'sk-supersecret12345';
  delete local.defaultThinkingLevel;
  await fs.writeFile(localPath, `${JSON.stringify(local, null, 2)}\n`);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.settings[0].fields.find((field) => field.path === '/defaultProvider').value = 'acme';
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const preview = result(run(['sync', '--repo', repo, '--agent-dir', agentDir]));
  assert.equal(preview.syncable.length, 1);
  assert.equal(preview.conflicts.length, 1);
  assert.equal(preview.rejected.length, 1);
  assert.equal(preview.review.length, 1);
  const expected = { syncable: preview.syncable, conflicts: preview.conflicts, rejected: preview.rejected, review: preview.review };

  const snapshots = {
    manifest: await fs.readFile(manifestPath, 'utf8'),
    lockfile: await fs.readFile(path.join(repo, 'pi-sync.lock.json'), 'utf8'),
    state: await fs.readFile(path.join(agentDir, '.pi-sync', 'state.json'), 'utf8'),
    local: await fs.readFile(localPath, 'utf8'),
  };
  for (const command of ['status', 'plan']) {
    const processResult = run([command, '--repo', repo, '--agent-dir', agentDir]);
    // The conflicted field is an operational conflict: exit 1, as before.
    assert.equal(processResult.status, 1, processResult.stderr);
    const output = result(processResult);
    assert.deepEqual({ syncable: output.sync.syncable, conflicts: output.sync.conflicts, rejected: output.sync.rejected, review: output.sync.review }, expected);
    assert.match(output.sync.rejected[0].reason, /credential-like key/);
  }
  assert.equal(await fs.readFile(manifestPath, 'utf8'), snapshots.manifest, 'must not write the manifest');
  assert.equal(await fs.readFile(path.join(repo, 'pi-sync.lock.json'), 'utf8'), snapshots.lockfile, 'must not write the lockfile');
  assert.equal(await fs.readFile(path.join(agentDir, '.pi-sync', 'state.json'), 'utf8'), snapshots.state, 'must not re-baseline');
  assert.equal(await fs.readFile(localPath, 'utf8'), snapshots.local, 'must not touch the local installation');
  await assert.rejects(fs.access(path.join(agentDir, '.pi-sync', 'apply.lock')), 'must not take the agent lock');
});

test('summary local pending combines syncable fields, repository dirt, and ahead commits', async (t) => {
  const { root, repo } = await pushFixture(t);
  const agentDir = path.join(root, 'agent');
  await fs.mkdir(agentDir);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.settings = [{ target: 'settings.json', fields: [{ path: '/theme', value: 'dark' }] }];
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.equal(run(['apply', '--repo', repo, '--agent-dir', agentDir]).status, 0);
  // One ahead commit: the manifest change is committed locally, not pushed.
  gitAt(repo, ['commit', '-am', 'declare settings']);
  // A dirty tracked tree: an uncommitted manifest change.
  await fs.appendFile(manifestPath, '\n');
  // One syncable field: a local-only settings change.
  const localPath = path.join(agentDir, 'settings.json');
  await fs.writeFile(localPath, `${JSON.stringify({ theme: 'light' }, null, 2)}\n`);

  const processResult = run(['status', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(processResult.status, 0, processResult.stderr);
  const output = result(processResult);
  assert.deepEqual(output.repository, { dirty: true, ahead: 1, behind: 0 });
  assert.deepEqual(output.sync.syncable.map((item) => item.path), ['/theme']);
  assert.deepEqual(output.summary, { localPending: 3, remotePending: 0, needsReview: 0, clean: false });
  const plan = run(['plan', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(plan.status, 0, plan.stderr);
  assert.deepEqual(result(plan).summary, output.summary);
});

test('summary remote pending combines behind commits and unapplied install actions', async (t) => {
  const { root, repo, bare } = await pushFixture(t);
  const agentDir = path.join(root, 'agent');
  await fs.mkdir(agentDir);
  // One behind commit: made in a clone of the bare origin, then fetched.
  const clone = path.join(root, 'second-clone');
  gitAt(root, ['clone', bare, clone]);
  gitAt(clone, ['config', 'user.name', 'Pi Sync Test']);
  gitAt(clone, ['config', 'user.email', 'pi-sync-test@example.invalid']);
  await fs.appendFile(path.join(clone, 'resources', 'skills', 'hello', 'SKILL.md'), '# Remote update\n');
  gitAt(clone, ['commit', '-am', 'remote change']);
  gitAt(clone, ['push', 'origin', 'main']);
  gitAt(repo, ['fetch', '--quiet']);

  const processResult = run(['status', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(processResult.status, 0, processResult.stderr);
  const output = result(processResult);
  assert.deepEqual(output.repository, { dirty: false, ahead: 0, behind: 1 });
  assert.deepEqual(output.actions.map((item) => item.action), ['install']);
  assert.deepEqual(output.summary, { localPending: 0, remotePending: 2, needsReview: 0, clean: false });
});

test('summary review combines conflicts and locally diverged resources', async (t) => {
  const { repo, agentDir, manifestPath, localPath } = await settingsFixture(t, [
    { path: '/theme', value: 'dark' },
    { path: '/defaultProvider', value: 'github-copilot' },
  ]);
  // A both-sides field change: a setting action in the conflicts aggregate.
  const local = JSON.parse(await fs.readFile(localPath, 'utf8'));
  local.defaultProvider = 'openrouter';
  await fs.writeFile(localPath, `${JSON.stringify(local, null, 2)}\n`);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.settings[0].fields.find((field) => field.path === '/defaultProvider').value = 'acme';
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  // A locally edited resource: a local-only divergence.
  await fs.writeFile(path.join(agentDir, 'skills', 'hello', 'SKILL.md'), '# Local edit\n');

  const processResult = run(['status', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(processResult.status, 1, processResult.stderr);
  const output = result(processResult);
  assert.equal('repository' in output, false, 'non-git setup: the repository block is omitted');
  assert.deepEqual(output.summary, { localPending: 0, remotePending: 0, needsReview: 2, clean: false });
});

test('summary is clean exactly when every count is zero', async (t) => {
  const { root, repo } = await pushFixture(t);
  const agentDir = path.join(root, 'agent');
  await fs.mkdir(agentDir);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.settings = [{ target: 'settings.json', fields: [{ path: '/theme', value: 'dark' }] }];
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.equal(run(['apply', '--repo', repo, '--agent-dir', agentDir]).status, 0);
  gitAt(repo, ['commit', '-am', 'declare settings']);
  gitAt(repo, ['push', '--quiet', 'origin', 'main']);

  const processResult = run(['status', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(processResult.status, 0, processResult.stderr);
  const output = result(processResult);
  assert.deepEqual(output.repository, { dirty: false, ahead: 0, behind: 0 });
  assert.deepEqual(output.sync, { syncable: [], conflicts: [], rejected: [], review: [] });
  assert.deepEqual(output.summary, { localPending: 0, remotePending: 0, needsReview: 0, clean: true });
});

test('serializes concurrent applies and leaves one consistent managed installation', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const args = ['apply', '--repo', repo, '--agent-dir', agentDir];
  const [first, second] = await Promise.all([runAsync(args), runAsync(args)]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(await fs.readFile(path.join(agentDir, 'skills', 'hello', 'SKILL.md'), 'utf8'), '# Hello\n');
  const state = await fs.readFile(path.join(agentDir, '.pi-sync', 'state.json'), 'utf8').then(JSON.parse);
  assert.ok(state.resources['skills/hello']);
});

test('rejects source traversal before applying', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const manifest = JSON.parse(await fs.readFile(path.join(repo, 'pi-sync.json'), 'utf8'));
  manifest.resources[0].source = 'resources/skills/../../outside';
  await fs.writeFile(path.join(repo, 'pi-sync.json'), JSON.stringify(manifest));
  const applied = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(applied.status, 2);
  assert.match(result(applied).error, /.. path segments/);
  await assert.rejects(fs.access(path.join(agentDir, 'skills', 'hello')));
});

test('add imports only the explicitly selected skill and updates the manifest', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const localSkill = path.join(agentDir, 'skills', 'local-only');
  const added = run(['add', '--type', 'skill', '--source', 'skills/local-only', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(added.status, 0, added.stderr);
  const output = result(added);
  assert.equal(output.action, 'added');
  assert.equal(output.target, 'skills/local-only');
  assert.equal(await fs.readFile(path.join(repo, 'resources', 'skills', 'local-only', 'SKILL.md'), 'utf8'), '# Local\n');
  const manifest = JSON.parse(await fs.readFile(path.join(repo, 'pi-sync.json'), 'utf8'));
  assert.deepEqual(manifest.resources.at(-1), { type: 'skill', source: 'resources/skills/local-only', target: 'skills/local-only' });
  assert.equal(await fs.readFile(path.join(localSkill, 'SKILL.md'), 'utf8'), '# Local\n');
  await assert.rejects(fs.access(path.join(repo, 'resources', 'skills', 'hello', 'local-only')));
});

test('add rejects unsupported types, collisions, and suspected credential material without importing', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const unsupported = run(['add', '--type', 'theme', '--source', 'skills/local-only', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(unsupported.status, 2);
  assert.match(result(unsupported).error, /Unsupported resource type/);

  const wrongRoot = run(['add', '--type', 'extension', '--source', 'skills/local-only', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(wrongRoot.status, 2);
  assert.match(result(wrongRoot).error, /Extension source must be a file or directory under extensions\//);

  await fs.mkdir(path.join(repo, 'resources', 'skills', 'local-only'), { recursive: true });
  const collision = run(['add', '--type', 'skill', '--source', 'skills/local-only', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(collision.status, 2);
  const collisionOutput = result(collision);
  assert.match(collisionOutput.error, /collision/i);
  assert.equal(collisionOutput.apiVersion, 1);
  assert.equal(collisionOutput.ok, false);
  assert.equal(collisionOutput.errorCode, 'RESOURCE_COLLISION');
  assert.deepEqual(collisionOutput.details, { type: 'skill', source: 'skills/local-only', target: 'skills/local-only', repositorySource: 'resources/skills/local-only' });
  await fs.rm(path.join(repo, 'resources', 'skills', 'local-only'), { recursive: true });

  await fs.mkdir(path.join(agentDir, 'skills', 'local-only', 'credentials'), { recursive: true });
  const credentialPath = run(['add', '--type', 'skill', '--source', 'skills/local-only', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(credentialPath.status, 2);
  assert.match(result(credentialPath).reviewRequired[0].reason, /known credential-store path/);
  await fs.rm(path.join(agentDir, 'skills', 'local-only', 'credentials'), { recursive: true });

  await fs.writeFile(path.join(agentDir, 'skills', 'local-only', 'notes.md'), 'Example token: ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ\n');
  const secret = run(['add', '--type', 'skill', '--source', 'skills/local-only', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(secret.status, 2);
  const secretOutput = result(secret);
  assert.equal(secretOutput.apiVersion, 1);
  assert.equal(secretOutput.ok, false);
  assert.equal(secretOutput.exitCode, 2);
  assert.deepEqual(secretOutput.details.reviewRequired, secretOutput.reviewRequired);
  assert.match(secretOutput.error, /review suspected secret material/);
  assert.equal(secretOutput.reviewRequired[0].path, 'skills/local-only/notes.md');
  assert.doesNotMatch(secret.stdout, /ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ/);
  await assert.rejects(fs.access(path.join(repo, 'resources', 'skills', 'local-only')));
  const unchangedManifest = JSON.parse(await fs.readFile(path.join(repo, 'pi-sync.json'), 'utf8'));
  assert.equal(unchangedManifest.resources.length, 1);
});

test('reports stale resources without deleting them and prunes only on explicit confirmation', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const applied = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(applied.status, 0, applied.stderr);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.resources = [];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));

  const planned = run(['plan', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(planned.status, 0, planned.stderr);
  assert.deepEqual(result(planned).staleResources, [{ target: 'skills/hello', state: 'unchanged', installed: true, pruneAvailable: true }]);
  const ordinaryApply = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(ordinaryApply.status, 0, ordinaryApply.stderr);
  assert.equal(result(ordinaryApply).actions[0].action, 'stale');
  assert.equal(await fs.readFile(path.join(agentDir, 'skills', 'hello', 'SKILL.md'), 'utf8'), '# Hello\n');

  const preview = run(['prune', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(result(preview).mode, 'preview');
  assert.deepEqual(result(preview).staleResources[0], { target: 'skills/hello', action: 'would-prune', installed: true });
  await fs.access(path.join(agentDir, 'skills', 'hello', 'SKILL.md'));

  const pruned = run(['prune', '--confirm', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(pruned.status, 0, pruned.stderr);
  assert.equal(result(pruned).staleResources[0].action, 'pruned');
  await assert.rejects(fs.access(path.join(agentDir, 'skills', 'hello')));
  assert.equal(await fs.readFile(path.join(agentDir, 'skills', 'local-only', 'SKILL.md'), 'utf8'), '# Local\n');
  const backupRoot = path.join(agentDir, '.pi-sync', 'backups');
  const backupStamp = (await fs.readdir(backupRoot))[0];
  assert.equal(await fs.readFile(path.join(backupRoot, backupStamp, 'skills', 'hello', 'SKILL.md'), 'utf8'), '# Hello\n');
  const state = JSON.parse(await fs.readFile(path.join(agentDir, '.pi-sync', 'state.json'), 'utf8'));
  assert.equal(Object.hasOwn(state.resources, 'skills/hello'), false);
});

test('confirmed prune retains a stale parent target that overlaps a currently managed nested target', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const oldSource = path.join(repo, 'resources', 'skills', 'foo');
  await fs.mkdir(path.join(oldSource, 'bar'), { recursive: true });
  await fs.writeFile(path.join(oldSource, 'bar', 'SKILL.md'), '# Nested skill\\n');
  manifest.resources = [{ type: 'skill', source: 'resources/skills/foo', target: 'skills/foo' }];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const firstApply = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(firstApply.status, 0, firstApply.stderr);

  const newSource = path.join(repo, 'resources', 'skills', 'bar');
  await fs.mkdir(newSource, { recursive: true });
  await fs.writeFile(path.join(newSource, 'SKILL.md'), '# Nested skill\\n');
  manifest.resources = [{ type: 'skill', source: 'resources/skills/bar', target: 'skills/foo/bar' }];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const secondApply = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(secondApply.status, 0, secondApply.stderr);
  const plan = result(secondApply);
  assert.deepEqual(plan.staleResources, [{ target: 'skills/foo', state: 'overlaps-current', installed: true,
    pruneAvailable: false, overlaps: ['skills/foo/bar'] }]);
  const staleAction = plan.actions.find((action) => action.target === 'skills/foo');
  assert.deepEqual(staleAction.overlaps, ['skills/foo/bar']);
  assert.equal(staleAction.pruneAvailable, false);

  const preview = run(['prune', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(preview.status, 1);
  assert.deepEqual(result(preview).staleResources, [{ target: 'skills/foo', action: 'retained-overlap',
    installed: true, overlaps: ['skills/foo/bar'] }]);
  const confirmed = run(['prune', '--confirm', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(confirmed.status, 1);
  assert.deepEqual(result(confirmed).staleResources, [{ target: 'skills/foo', action: 'retained-overlap',
    installed: true, overlaps: ['skills/foo/bar'] }]);
  assert.equal(await fs.readFile(path.join(agentDir, 'skills', 'foo', 'bar', 'SKILL.md'), 'utf8'), '# Nested skill\\n');
  const state = await fs.readFile(path.join(agentDir, '.pi-sync', 'state.json'), 'utf8').then(JSON.parse);
  assert.ok(state.resources['skills/foo'], 'overlapping stale baseline remains available for safe resolution');
  assert.ok(state.resources['skills/foo/bar'], 'currently managed nested target remains state-managed');
});

test('confirmed prune retains case-variant stale/current nested targets on Windows filesystems', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const staleSource = path.join(repo, 'resources', 'skills', 'case-parent');
  await fs.mkdir(path.join(staleSource, 'child'), { recursive: true });
  await fs.writeFile(path.join(staleSource, 'child', 'SKILL.md'), '# Case-overlap\\n');
  manifest.resources = [{ type: 'skill', source: 'resources/skills/case-parent', target: 'skills/foo' }];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const firstApply = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(firstApply.status, 0, firstApply.stderr);

  const currentSource = path.join(repo, 'resources', 'skills', 'case-child');
  await fs.mkdir(currentSource, { recursive: true });
  await fs.writeFile(path.join(currentSource, 'SKILL.md'), '# Case-overlap\\n');
  manifest.resources = [{ type: 'skill', source: 'resources/skills/case-child', target: 'skills/FOO/child' }];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const applied = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(applied.status, 0, applied.stderr);
  const output = result(applied);
  assert.deepEqual(output.staleResources, [{ target: 'skills/foo', state: 'overlaps-current', installed: true,
    pruneAvailable: false, overlaps: ['skills/FOO/child'] }]);

  const preview = run(['prune', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(preview.status, 1);
  assert.deepEqual(result(preview).staleResources, [{ target: 'skills/foo', action: 'retained-overlap',
    installed: true, overlaps: ['skills/FOO/child'] }]);
  const confirmed = run(['prune', '--confirm', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(confirmed.status, 1);
  assert.deepEqual(result(confirmed).staleResources, [{ target: 'skills/foo', action: 'retained-overlap',
    installed: true, overlaps: ['skills/FOO/child'] }]);
  assert.equal(await fs.readFile(path.join(agentDir, 'skills', 'FOO', 'child', 'SKILL.md'), 'utf8'), '# Case-overlap\\n');
  const state = await fs.readFile(path.join(agentDir, '.pi-sync', 'state.json'), 'utf8').then(JSON.parse);
  assert.ok(state.resources['skills/foo']);
  assert.ok(state.resources['skills/FOO/child']);
});

test('prune preserves stale resources with local edits and reports why', async (t) => {
  const { repo, agentDir } = await fixture(t);
  assert.equal(run(['apply', '--repo', repo, '--agent-dir', agentDir]).status, 0);
  const manifest = JSON.parse(await fs.readFile(path.join(repo, 'pi-sync.json'), 'utf8'));
  manifest.resources = [];
  await fs.writeFile(path.join(repo, 'pi-sync.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(agentDir, 'skills', 'hello', 'SKILL.md'), '# Keep my local work\n');
  const prune = run(['prune', '--confirm', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(prune.status, 1);
  assert.equal(result(prune).staleResources[0].action, 'retained-modified');
  assert.equal(await fs.readFile(path.join(agentDir, 'skills', 'hello', 'SKILL.md'), 'utf8'), '# Keep my local work\n');
});

test('installer catalog maps supported official GitHub CLI assets to pinned SHA-256 digests', () => {
  assert.deepEqual(githubCliReleaseAsset('linux', 'x64'), { file: 'gh_2.74.2_linux_amd64.tar.gz', binary: 'gh', format: 'tar.gz', sha256: 'c421091ae5800390e6aef1f50bfda59cc1d4f2ef2200bcd4e1a662c05c28c444' });
  assert.deepEqual(githubCliReleaseAsset('linux', 'arm64'), { file: 'gh_2.74.2_linux_arm64.tar.gz', binary: 'gh', format: 'tar.gz', sha256: 'f0b07f0aeaf00f137df1bd33a76e717b1945f4b83bd6a3296b365414d3eb413f' });
  assert.deepEqual(githubCliReleaseAsset('darwin', 'arm64'), { file: 'gh_2.74.2_macOS_arm64.zip', binary: 'gh', format: 'zip', sha256: '42dceea5beae957a8a9545e38043a6d75fa3b5505fdcea75a278f873f0845b26' });
  assert.deepEqual(githubCliReleaseAsset('win32', 'x64'), { file: 'gh_2.74.2_windows_amd64.zip', binary: 'gh.exe', format: 'zip', sha256: '3ac27af5ee8dd13b1b0002e4e4764163683889cea7f21231c9951e300c95eb29' });
  assert.equal(githubCliReleaseAsset('win32', 'arm64'), null);
  assert.equal(githubCliReleaseAsset('freebsd', 'x64'), null);
  const macAsset = githubCliReleaseAsset('darwin', 'x64');
  const binary = Buffer.from('fake executable');
  assert.deepEqual(extractGitHubCliBinary(zipFixture('gh_2.74.2_macOS_amd64/bin/gh', binary), macAsset), binary);
  const windowsAsset = githubCliReleaseAsset('win32', 'x64');
  const windowsBinary = Buffer.from('fake windows executable');
  assert.deepEqual(extractGitHubCliBinary(zipFixture('gh_2.74.2_windows_amd64/bin/gh.exe', windowsBinary), windowsAsset), windowsBinary);
});

test('unsupported installer platform returns a required-tool handoff without attempting a download', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-prerequisite-unsupported-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await inspectRequiredTools(['gh'], { binDir: path.join(root, 'bin'), env: { PATH: root }, platform: 'freebsd', architecture: 'x64' });
  assert.equal(result.ok, false);
  assert.equal(result.tools[0].status, 'failed');
  assert.match(result.tools[0].reason, /No supported official GitHub CLI installer for freebsd\/x64/);
  assert.match(result.tools[0].action, /user-writable.*without sudo/i);
  await assert.rejects(fs.access(path.join(root, 'bin')));
});

test('host-injected Linux/macOS/Windows adapter fixtures install to temp user paths and rediscover tools', async (t) => {
  const platforms = [
    { platform: 'linux', architecture: 'x64', label: 'Linux adapter fixture' },
    { platform: 'darwin', architecture: 'arm64', label: 'macOS asset adapter fixture' },
    { platform: 'win32', architecture: 'x64', label: 'Windows executable-name adapter fixture' },
  ];
  for (const { platform, architecture, label } of platforms) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-platform-smoke-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const asset = githubCliReleaseAsset(platform, architecture);
    const script = Buffer.from(`#!${process.execPath}\nif (process.argv[2] === '--version') console.log('gh version 2.74.2');\n`);
    const archiveBase = asset.file.endsWith('.tar.gz') ? asset.file.slice(0, -7) : asset.file.slice(0, -4);
    const archive = asset.format === 'tar.gz'
      ? tarGzipFixture(`${archiveBase}/bin/${asset.binary}`, script)
      : zipFixture(`${archiveBase}/bin/${asset.binary}`, script);
    let downloads = 0;
    const inspect = createPrerequisiteInspector({
      expectedArtifactSha256: () => createHash('sha256').update(archive).digest('hex'),
      fetchArtifact: async (url) => {
        downloads++;
        assert.match(url, /^https:\/\/github\.com\/cli\/cli\/releases\/download\//);
        return new Response(archive, { status: 200 });
      },
    });
    const binDir = path.join(root, 'home', 'user-local', 'bin');
    const options = { binDir, env: { PATH: root }, platform, architecture };
    const installed = await inspect(['gh'], options);
    assert.equal(installed.ok, true, `${label}: ${JSON.stringify(installed.tools)}`);
    assert.deepEqual(installed.tools[0], { name: 'gh', required: true, status: 'installed', version: '2.74.2', installPath: path.join(binDir, asset.binary) });
    const detected = await inspect(['gh'], options);
    assert.deepEqual(detected.tools[0], { name: 'gh', required: true, status: 'available', version: '2.74.2', installPath: path.join(binDir, asset.binary) });
    assert.equal(downloads, 1, `${label}: discovery must not redownload`);
    assert.ok(path.isAbsolute(detected.binDir));
    assert.equal((await fs.stat(path.join(binDir, asset.binary))).isFile(), true);
  }
});

test('Windows platform fixture discovers gh.exe through the supplied user PATH', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-windows-path-smoke-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const windowsPathFixture = path.join(root, 'user-path');
  await fs.mkdir(windowsPathFixture);
  await fs.writeFile(path.join(windowsPathFixture, 'gh.exe'), `#!${process.execPath}\nif (process.argv[2] === '--version') console.log('gh version 2.74.2');\n`, { mode: 0o755 });
  const result = await inspectRequiredTools(['gh'], { binDir: path.join(root, 'pi-sync-local-bin'), env: { PATH: windowsPathFixture }, platform: 'win32', architecture: 'x64', install: false });
  assert.equal(result.ok, true);
  assert.equal(result.tools[0].status, 'available');
  assert.equal(Object.hasOwn(result.tools[0], 'installPath'), false);
});

test('Linux-style custom-home fixture discovers a user-local command without changing parent PATH', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-remote-smoke-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const binDir = path.join(root, 'remote-home', '.local', 'bin');
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(binDir, 'gh'), `#!${process.execPath}\nif (process.argv[2] === '--version') console.log('gh version 2.74.2');\n`, { mode: 0o755 });
  const originalPath = `${root}/system-bin`;
  const parentPath = process.env.PATH;
  const discovered = await inspectRequiredTools(['gh'], { binDir, env: { PATH: originalPath }, platform: 'linux', architecture: 'x64', install: false });
  assert.equal(discovered.ok, true);
  assert.equal(discovered.tools[0].status, 'available');
  assert.equal(discovered.tools[0].installPath, path.join(binDir, 'gh'));
  assert.equal(process.env.PATH, parentPath, 'inspection must not mutate the parent process environment');
});

test('tampered official-release archive fails closed before extraction, installation, or execution', async (t) => {
  const platforms = [
    { platform: 'linux', architecture: 'x64' },
    { platform: 'darwin', architecture: 'arm64' },
    { platform: 'win32', architecture: 'x64' },
  ];
  for (const { platform, architecture } of platforms) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-tampered-archive-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const asset = githubCliReleaseAsset(platform, architecture);
    const marker = path.join(root, 'executed-marker');
    const script = Buffer.from(`#!${process.execPath}\nimport fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'executed');\n`);
    const archiveBase = asset.file.endsWith('.tar.gz') ? asset.file.slice(0, -7) : asset.file.slice(0, -4);
    const original = asset.format === 'tar.gz'
      ? tarGzipFixture(`${archiveBase}/bin/${asset.binary}`, script)
      : zipFixture(`${archiveBase}/bin/${asset.binary}`, script);
    const tampered = Buffer.from(original);
    tampered[tampered.length - 1] ^= 0xff;
    const inspect = createPrerequisiteInspector({
      expectedArtifactSha256: () => createHash('sha256').update(original).digest('hex'),
      fetchArtifact: async () => new Response(tampered, { status: 200 }),
    });
    const binDir = path.join(root, 'bin');
    const outcome = await inspect(['gh'], { binDir, env: { PATH: root }, platform, architecture });
    assert.equal(outcome.ok, false);
    assert.match(outcome.tools[0].reason, /SHA-256 mismatch.*refusing to extract or execute/);
    await assert.rejects(fs.access(binDir));
    await assert.rejects(fs.access(marker));
  }
});

test('bootstrap fails closed when a downloaded archive mismatches the pinned digest', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-bootstrap-unpinned-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRepo = await bootstrapRepo(t, root);
  const manifestPath = path.join(sourceRepo, 'pi-sync.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.requiredTools = ['gh'];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const fakeTools = await fakeGitHubTools(t, sourceRepo);
  const gitBin = path.join(root, 'git-only-bin');
  await fs.mkdir(gitBin);
  await fs.copyFile(path.join(fakeTools.PATH.split(path.delimiter)[0], 'git'), path.join(gitBin, 'git'));
  const asset = githubCliReleaseAsset(process.platform, process.arch);
  assert.ok(asset, 'test host must have a catalogued asset');
  const script = Buffer.from(`#!${process.execPath}\nif (process.argv[2] === '--version') console.log('gh version 2.74.2');\n`);
  const archiveBase = asset.file.endsWith('.tar.gz') ? asset.file.slice(0, -7) : asset.file.slice(0, -4);
  const archive = asset.format === 'tar.gz'
    ? tarGzipFixture(`${archiveBase}/bin/${asset.binary}`, script)
    : zipFixture(`${archiveBase}/bin/${asset.binary}`, script);
  const archivePath = path.join(root, 'test-archive');
  await fs.writeFile(archivePath, archive);
  const preload = path.join(root, 'fake-fetch.mjs');
  await fs.writeFile(preload, `import fs from 'node:fs/promises';\nglobalThis.fetch = async (url) => { if (!String(url).startsWith('https://github.com/cli/cli/releases/download/')) throw new Error('unexpected URL'); return new Response(await fs.readFile(process.env.FAKE_RELEASE_ARCHIVE), { status: 200 }); };\n`);
  const binDir = path.join(root, 'user-bin');
  const response = run(['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo-dir', path.join(root, 'checkout'), '--agent-dir', path.join(root, 'agent'), '--bin-dir', binDir], {
    PATH: gitBin, FAKE_SETUP_REPO: sourceRepo, FAKE_GIT_ACCESS: 'yes', FAKE_RELEASE_ARCHIVE: archivePath,
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
  });
  assert.equal(response.status, 1, `${response.stderr}\n${response.stdout}`);
  const output = result(response);
  assert.equal(output.errorCode, 'PREREQUISITE_INSTALL_REQUIRED');
  assert.match(output.missingPrerequisites[0].reason, /SHA-256 mismatch/);
  await assert.rejects(fs.access(binDir));
  await assert.rejects(fs.access(path.join(root, 'checkout')));
  await assert.rejects(fs.access(path.join(root, 'agent')));
});

test('bootstrap permission/path failure returns an actionable prerequisite handoff without sudo or overwrite', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-prerequisite-denied-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRepo = await bootstrapRepo(t, root);
  const fakeTools = await fakeGitHubTools(t, sourceRepo);
  const gitBin = path.join(root, 'git-only-bin');
  await fs.mkdir(gitBin);
  await fs.copyFile(path.join(fakeTools.PATH.split(path.delimiter)[0], 'git'), path.join(gitBin, 'git'));
  const notDirectory = path.join(root, 'not-a-bin-directory');
  await fs.writeFile(notDirectory, 'keep this user file');
  const response = run(['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo-dir', path.join(root, 'checkout'), '--agent-dir', path.join(root, 'agent'), '--bin-dir', notDirectory], {
    PATH: gitBin, FAKE_GIT_ACCESS: 'no',
  });
  assert.equal(response.status, 1, `${response.stderr}\n${response.stdout}`);
  const output = result(response);
  assert.equal(output.errorCode, 'PREREQUISITE_INSTALL_REQUIRED');
  assert.deepEqual(output.missingPrerequisites.map(({ name, status }) => ({ name, status })), [{ name: 'gh', status: 'failed' }]);
  assert.match(output.missingPrerequisites[0].action, /writable.*no sudo/i);
  assert.equal(await fs.readFile(notDirectory, 'utf8'), 'keep this user file');
  await assert.rejects(fs.access(path.join(root, 'checkout')));
  await assert.rejects(fs.access(path.join(root, 'agent')));
  assert.doesNotMatch(response.stdout, /\"command\":\s*\"sudo\"/);
});

test('push preview and publish include only explicit managed, non-ignored paths and preserve unrelated staging', async (t) => {
  const { repo, bare } = await pushFixture(t);
  const ignoredFile = path.join(repo, 'resources', 'skills', 'hello', 'ignored.txt');
  await fs.writeFile(ignoredFile, 'tracked ignored baseline\n');
  gitAt(repo, ['add', '--force', '--', 'resources/skills/hello/ignored.txt']);
  gitAt(repo, ['commit', '-m', 'track an ignored fixture']);
  gitAt(repo, ['push', 'origin', 'main']);
  await fs.writeFile(path.join(repo, 'pi-sync.json'), JSON.stringify({ schemaVersion: 1,
    resources: [{ type: 'skill', source: 'resources/skills/hello', target: 'skills/hello' }], dependencies: [], policy: { minimumReleaseAgeDays: 7 } }, null, 2) + '\n');
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), '# Edited skill\n');
  await fs.writeFile(ignoredFile, 'ignored content changed\n');
  await fs.writeFile(path.join(repo, 'unrelated.txt'), 'unrelated content\n');
  gitAt(repo, ['add', '--', 'unrelated.txt']);

  const preview = run(['push', '--repo', repo]);
  assert.equal(preview.status, 0, `${preview.stderr}\n${preview.stdout}`);
  const plan = result(preview);
  assert.equal(plan.mode, 'preview');
  assert.equal(plan.publicationAuthorized, false);
  assert.deepEqual(plan.changes.map((item) => item.path).sort(), ['pi-sync.json', 'resources/skills/hello/SKILL.md']);
  assert.equal(plan.commitRequired, true);
  assert.match(plan.patch, /Edited skill/);
  assert.doesNotMatch(plan.patch, /ignored content changed/);
  assert.match(gitAt(repo, ['diff', '--cached', '--name-only']), /^unrelated\.txt$/);

  const published = run(['push', '--publish', '--repo', repo]);
  assert.equal(published.status, 0, published.stderr);
  assert.match(published.stderr, /managed commit preview \(before publication\)/);
  assert.match(published.stderr, /Edited skill/);
  const output = result(published);
  assert.equal(output.mode, 'published');
  assert.equal(output.forcePush, false);
  assert.deepEqual(output.changes.map((item) => item.path).sort(), ['pi-sync.json', 'resources/skills/hello/SKILL.md']);
  const remoteFiles = spawnSync('git', ['--git-dir', bare, 'show', '--format=', '--name-only', 'main'], { encoding: 'utf8' });
  assert.equal(remoteFiles.status, 0, remoteFiles.stderr);
  assert.deepEqual(remoteFiles.stdout.trim().split(/\r?\n/).sort(), ['pi-sync.json', 'resources/skills/hello/SKILL.md']);
  assert.match(gitAt(repo, ['diff', '--cached', '--name-only']), /^unrelated\.txt$/);
  assert.equal(await fs.readFile(path.join(repo, 'unrelated.txt'), 'utf8'), 'unrelated content\n');
});

test('push stops for suspected credential content in a managed resource', async (t) => {
  const { repo } = await pushFixture(t);
  const skill = path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md');
  const credential = 'ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ';
  await fs.writeFile(skill, `example token: ${credential}\n`);
  const response = run(['push', '--repo', repo]);
  assert.equal(response.status, 1);
  const output = result(response);
  assert.equal(output.errorCode, 'PUSH_BLOCKED');
  assert.equal(output.details.reviewRequired[0].reason, 'GitHub token');
  assert.equal(await fs.readFile(skill, 'utf8'), `example token: ${credential}\n`);
  assert.equal(gitAt(repo, ['diff', '--cached', '--name-only']), '');
});

test('push blocks a likely token in a manifest setting before commit or publication', async (t) => {
  const { repo, bare } = await pushFixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const credential = 'ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ';
  manifest.settings = [{ target: 'settings.json', fields: [{ path: '/theme', value: credential }] }];
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const headBefore = gitAt(repo, ['rev-parse', 'HEAD']);
  const remoteBefore = gitAt(repo, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0];

  const response = run(['push', '--publish', '--repo', repo]);
  assert.equal(response.status, 1);
  const output = result(response);
  assert.equal(output.errorCode, 'PUSH_BLOCKED');
  assert.match(output.error, /suspected credential material/);
  assert.equal(output.details.reviewRequired[0].reason, 'GitHub token');
  assert.equal(output.details.reviewRequired[0].path, 'pi-sync.json');
  assert.equal(gitAt(repo, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(gitAt(repo, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0], remoteBefore);
  assert.equal(gitAt(repo, ['diff', '--cached', '--name-only']), '');
  assert.equal(await fs.readFile(manifestPath, 'utf8'), `${JSON.stringify(manifest, null, 2)}\n`);
});

test('push allows the safe placeholder in a manifest credential-like setting', async (t) => {
  const { repo, bare } = await pushFixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.settings = [{ target: 'models.json', fields: [{ path: '/providers/local', value: { baseUrl: 'http://localhost:11434/v1', apiKey: '__PLACEHOLDER__' } }] }];
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const response = run(['push', '--publish', '--repo', repo]);
  assert.equal(response.status, 0, response.stderr);
  const output = result(response);
  assert.equal(output.mode, 'published');
  const remote = spawnSync('git', ['--git-dir', bare, 'show', 'main:pi-sync.json'], { encoding: 'utf8' });
  assert.equal(remote.status, 0, remote.stderr);
  const remoteManifest = JSON.parse(remote.stdout);
  assert.equal(remoteManifest.settings[0].fields[0].value.apiKey, '__PLACEHOLDER__');
});

test('push refuses unrelated local commits and remote advancement without losing local edits', async (t) => {
  const { repo, root } = await pushFixture(t);
  await fs.writeFile(path.join(repo, 'unrelated-commit.txt'), 'unrelated commit\n');
  gitAt(repo, ['add', '--', 'unrelated-commit.txt']);
  gitAt(repo, ['commit', '-m', 'unrelated local work']);
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), '# Keep local managed edit\n');
  const ahead = run(['push', '--publish', '--repo', repo]);
  assert.equal(ahead.status, 1);
  assert.equal(result(ahead).errorCode, 'PUSH_BLOCKED');
  assert.equal(await fs.readFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), 'utf8'), '# Keep local managed edit\n');
  assert.equal(gitAt(repo, ['rev-list', '--count', '@{upstream}..HEAD']), '1');

  const remoteClone = path.join(root, 'remote-writer');
  gitAt(root, ['clone', '--quiet', path.join(root, 'origin.git'), remoteClone]);
  gitAt(remoteClone, ['config', 'user.name', 'Remote Writer']);
  gitAt(remoteClone, ['config', 'user.email', 'remote@example.invalid']);
  // Keep a checkout of the old upstream before the remote advances.
  const other = path.join(root, 'other-setup');
  gitAt(root, ['clone', '--quiet', path.join(root, 'origin.git'), other]);
  gitAt(other, ['config', 'user.name', 'Pi Sync Test']);
  gitAt(other, ['config', 'user.email', 'pi-sync-test@example.invalid']);
  await fs.writeFile(path.join(remoteClone, 'remote-change.txt'), 'remote advanced\n');
  gitAt(remoteClone, ['add', '--', 'remote-change.txt']);
  gitAt(remoteClone, ['commit', '-m', 'remote advancement']);
  gitAt(remoteClone, ['push', 'origin', 'main']);
  await fs.writeFile(path.join(other, 'resources', 'skills', 'hello', 'SKILL.md'), '# Local edit after remote advance\n');
  const diverged = run(['push', '--publish', '--repo', other]);
  assert.equal(diverged.status, 1);
  assert.match(result(diverged).error, /upstream has advanced/);
  assert.equal(await fs.readFile(path.join(other, 'resources', 'skills', 'hello', 'SKILL.md'), 'utf8'), '# Local edit after remote advance\n');
});

test('rejected fast-forward push preserves the local managed commit and unrelated staged work', async (t) => {
  const { repo, bare } = await pushFixture(t);
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), '# Commit remains local\n');
  await fs.writeFile(path.join(repo, 'unrelated.txt'), 'still staged\n');
  gitAt(repo, ['add', '--', 'unrelated.txt']);
  const hook = path.join(bare, 'hooks', 'pre-receive');
  await fs.writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const rejected = run(['push', '--publish', '--repo', repo]);
  assert.equal(rejected.status, 1);
  const output = result(rejected);
  assert.equal(output.errorCode, 'PUSH_BLOCKED');
  assert.match(output.error, /push was rejected/);
  assert.equal(await fs.readFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), 'utf8'), '# Commit remains local\n');
  assert.deepEqual(gitAt(repo, ['show', '--format=', '--name-only', 'HEAD']).split(/\r?\n/).filter(Boolean), ['resources/skills/hello/SKILL.md']);
  assert.equal(gitAt(repo, ['diff', '--cached', '--name-only']), 'unrelated.txt');
});

test('update --apply --push publishes the approved exact pin change through managed-only push', async (t) => {
  const { repo, bare, root } = await pushFixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  await fs.writeFile(manifestPath, JSON.stringify({ schemaVersion: 1,
    resources: [{ type: 'skill', source: 'resources/skills/hello', target: 'skills/hello' }],
    dependencies: [{ type: 'npm', name: 'fixture-package' }] }, null, 2) + '\n');
  await fs.writeFile(path.join(repo, 'pi-sync.lock.json'), JSON.stringify({ schemaVersion: 1, packages: [
    { type: 'npm', name: 'fixture-package', version: '1.0.0', releasedAt: '2020-01-01T00:00:00.000Z' },
  ] }, null, 2) + '\n');
  gitAt(repo, ['add', '--all']);
  gitAt(repo, ['commit', '-m', 'declare pinned package']);
  gitAt(repo, ['push', 'origin', 'main']);

  const bin = path.join(root, 'fake-bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'npm'), `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args[0] === 'view' && args[2] === 'versions') console.log(JSON.stringify(['1.0.0','1.1.0']));\nelse if (args[0] === 'view' && args[2] === 'time') console.log(JSON.stringify({'1.0.0':'2020-01-01T00:00:00.000Z','1.1.0':'2020-02-01T00:00:00.000Z'}));\nelse process.exit(2);\n`, { mode: 0o755 });
  await fs.writeFile(path.join(bin, 'pi'), `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o755 });
  const agentDir = path.join(root, 'agent');
  const invalid = run(['update', '--push', '--repo', repo, '--agent-dir', agentDir], { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  assert.equal(invalid.status, 2);
  assert.match(result(invalid).error, /requires --apply/);

  const updated = run(['update', '--apply', '--push', '--approve', '--repo', repo, '--agent-dir', agentDir], {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  });
  assert.equal(updated.status, 0, `${updated.stderr}\n${updated.stdout}`);
  assert.match(updated.stderr, /managed commit preview \(before publication\)/);
  const output = result(updated);
  assert.equal(output.push.mode, 'published');
  assert.deepEqual(output.push.changes.map((item) => item.path), ['pi-sync.lock.json']);
  const lock = JSON.parse(spawnSync('git', ['--git-dir', bare, 'show', 'main:pi-sync.lock.json'], { encoding: 'utf8' }).stdout);
  assert.equal(lock.packages[0].version, '1.1.0');
  assert.deepEqual(gitAt(repo, ['show', '--format=', '--name-only', 'HEAD']).split(/\r?\n/).filter(Boolean), ['pi-sync.lock.json']);
});

test('manifest rejects arbitrary or unsupported prerequisite declarations before apply', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.requiredTools = ['curl | sh'];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const response = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(response.status, 2);
  assert.match(result(response).error, /Unsupported required tool/);
  await assert.rejects(fs.access(path.join(agentDir, 'skills', 'hello')));
});

test('EACCES installation fixture returns a user-writable handoff without elevated retry', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-prerequisite-eacces-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const asset = githubCliReleaseAsset('linux', 'x64');
  const script = Buffer.from(`#!${process.execPath}\nif (process.argv[2] === '--version') console.log('gh version 2.74.2');\n`);
  const archive = tarGzipFixture('gh_2.74.2_linux_amd64/bin/gh', script);
  const inspect = createPrerequisiteInspector({
    expectedArtifactSha256: () => createHash('sha256').update(archive).digest('hex'),
    fetchArtifact: async () => new Response(archive, { status: 200 }),
  });
  const binDir = path.join(root, 'denied-bin');
  const originalMkdir = fs.mkdir;
  fs.mkdir = async (target, ...args) => {
    if (path.resolve(target) === path.resolve(binDir)) throw Object.assign(new Error('permission denied fixture'), { code: 'EACCES' });
    return originalMkdir(target, ...args);
  };
  try {
    const outcome = await inspect(['gh'], { binDir, env: { PATH: root }, platform: 'linux', architecture: 'x64' });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.tools[0].name, 'gh');
    assert.match(outcome.tools[0].reason, /Permission denied/);
    assert.match(outcome.tools[0].action, /writable.*no sudo/i);
    assert.equal(asset.binary, 'gh');
    await assert.rejects(fs.access(binDir));
  } finally {
    fs.mkdir = originalMkdir;
  }
});

async function extendedFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-extended-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'setup');
  const agentDir = path.join(root, 'agent');
  await fs.mkdir(repo, { recursive: true });
  // Authored local content that the tests import through add.
  await fs.mkdir(path.join(agentDir, 'prompts'), { recursive: true });
  await fs.writeFile(path.join(agentDir, 'prompts', 'deploy.md'), '# Deploy prompt\n');
  await fs.mkdir(path.join(agentDir, 'agents'), { recursive: true });
  await fs.writeFile(path.join(agentDir, 'agents', 'reviewer.md'), '# Reviewer agent\n');
  await fs.mkdir(path.join(agentDir, 'roles'), { recursive: true });
  await fs.writeFile(path.join(agentDir, 'roles', 'moderator.md'), '# Moderator role\n');
  await fs.mkdir(path.join(agentDir, 'extensions', 'github-copilot-usage'), { recursive: true });
  await fs.writeFile(path.join(agentDir, 'extensions', 'github-copilot-usage', 'index.ts'), 'export const usage = true;\n');
  await fs.writeFile(path.join(agentDir, 'extensions', 'github-copilot-usage', 'test.ts'), 'export const t = true;\n');
  await fs.mkdir(path.join(agentDir, 'extensions', 'subagent'), { recursive: true });
  await fs.writeFile(path.join(agentDir, 'extensions', 'subagent', 'config.json'), `${JSON.stringify({ model: 'local-model', maxAgents: 3 }, null, 2)}\n`);
  // Unmanaged content that must remain invisible to reconciliation and untouched by apply.
  await fs.writeFile(path.join(agentDir, 'prompts', 'unmanaged.md'), '# Unmanaged prompt\n');
  await fs.writeFile(path.join(agentDir, 'extensions', 'unmanaged-ext.ts'), 'export const x = 1;\n');
  await fs.writeFile(path.join(repo, 'pi-sync.json'), `${JSON.stringify({ schemaVersion: 1, resources: [], dependencies: [] }, null, 2)}\n`);
  await fs.writeFile(path.join(repo, 'pi-sync.lock.json'), `${JSON.stringify({ schemaVersion: 1, packages: [] }, null, 2)}\n`);
  return { root, repo, agentDir };
}

const EXTENDED_ADDS = [
  ['prompt', 'prompts/deploy.md'],
  ['agent', 'agents/reviewer.md'],
  ['role', 'roles/moderator.md'],
  ['extension', 'extensions/github-copilot-usage'],
  ['extension', 'extensions/subagent/config.json'],
];

function addAllExtended(repo, agentDir) {
  for (const [type, source] of EXTENDED_ADDS) {
    const response = run(['add', '--type', type, '--source', source, '--repo', repo, '--agent-dir', agentDir]);
    assert.equal(response.status, 0, `${type} ${source}: ${response.stderr}\n${response.stdout}`);
  }
}

test('add imports prompts, agents, roles, and file and directory extension forms with manifest updates', async (t) => {
  const { repo, agentDir } = await extendedFixture(t);
  for (const [type, source] of EXTENDED_ADDS) {
    const response = run(['add', '--type', type, '--source', source, '--repo', repo, '--agent-dir', agentDir]);
    assert.equal(response.status, 0, `${type} ${source}: ${response.stderr}\n${response.stdout}`);
    const output = result(response);
    assert.equal(output.action, 'added');
    assert.equal(output.type, type);
    assert.equal(output.source, source);
    assert.equal(output.target, source);
    assert.equal(output.repositorySource, `resources/${source}`);
  }
  const manifest = JSON.parse(await fs.readFile(path.join(repo, 'pi-sync.json'), 'utf8'));
  assert.deepEqual(manifest.resources.map((item) => [item.type, item.source, item.target]), [
    ['prompt', 'resources/prompts/deploy.md', 'prompts/deploy.md'],
    ['agent', 'resources/agents/reviewer.md', 'agents/reviewer.md'],
    ['role', 'resources/roles/moderator.md', 'roles/moderator.md'],
    ['extension', 'resources/extensions/github-copilot-usage', 'extensions/github-copilot-usage'],
    ['extension', 'resources/extensions/subagent/config.json', 'extensions/subagent/config.json'],
  ]);
  assert.equal(await fs.readFile(path.join(repo, 'resources', 'prompts', 'deploy.md'), 'utf8'), '# Deploy prompt\n');
  assert.equal(await fs.readFile(path.join(repo, 'resources', 'agents', 'reviewer.md'), 'utf8'), '# Reviewer agent\n');
  assert.equal(await fs.readFile(path.join(repo, 'resources', 'roles', 'moderator.md'), 'utf8'), '# Moderator role\n');
  assert.equal(await fs.readFile(path.join(repo, 'resources', 'extensions', 'github-copilot-usage', 'index.ts'), 'utf8'), 'export const usage = true;\n');
  assert.equal(await fs.readFile(path.join(repo, 'resources', 'extensions', 'subagent', 'config.json'), 'utf8'),
    await fs.readFile(path.join(agentDir, 'extensions', 'subagent', 'config.json'), 'utf8'));
  // Local sources remain in place and unrelated local content is not imported.
  assert.equal(await fs.readFile(path.join(agentDir, 'prompts', 'deploy.md'), 'utf8'), '# Deploy prompt\n');
  await assert.rejects(fs.access(path.join(repo, 'resources', 'prompts', 'unmanaged.md')));
  await assert.rejects(fs.access(path.join(repo, 'resources', 'extensions', 'unmanaged-ext.ts')));
});

test('apply installs new-type resources, is idempotent, and leaves unmanaged content untouched', async (t) => {
  const { repo, agentDir } = await extendedFixture(t);
  addAllExtended(repo, agentDir);
  // Remove the local originals so apply performs real installs.
  await fs.rm(path.join(agentDir, 'prompts', 'deploy.md'));
  await fs.rm(path.join(agentDir, 'agents', 'reviewer.md'));
  await fs.rm(path.join(agentDir, 'roles', 'moderator.md'));
  await fs.rm(path.join(agentDir, 'extensions', 'github-copilot-usage'), { recursive: true });
  await fs.rm(path.join(agentDir, 'extensions', 'subagent', 'config.json'));

  const first = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(result(first).actions.map((item) => item.action).sort(), ['installed', 'installed', 'installed', 'installed', 'installed']);
  assert.equal(await fs.readFile(path.join(agentDir, 'prompts', 'deploy.md'), 'utf8'), '# Deploy prompt\n');
  assert.equal(await fs.readFile(path.join(agentDir, 'agents', 'reviewer.md'), 'utf8'), '# Reviewer agent\n');
  assert.equal(await fs.readFile(path.join(agentDir, 'roles', 'moderator.md'), 'utf8'), '# Moderator role\n');
  assert.equal(await fs.readFile(path.join(agentDir, 'extensions', 'github-copilot-usage', 'index.ts'), 'utf8'), 'export const usage = true;\n');
  assert.equal(await fs.readFile(path.join(agentDir, 'extensions', 'github-copilot-usage', 'test.ts'), 'utf8'), 'export const t = true;\n');
  assert.equal(await fs.readFile(path.join(agentDir, 'extensions', 'subagent', 'config.json'), 'utf8'), `${JSON.stringify({ model: 'local-model', maxAgents: 3 }, null, 2)}\n`);

  const second = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(result(second).ok, true);
  assert.deepEqual(result(second).actions.map((item) => item.action).sort(), ['unchanged', 'unchanged', 'unchanged', 'unchanged', 'unchanged']);

  // Unmanaged content under the same roots is invisible to plan/status and untouched by apply.
  const planned = run(['plan', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(planned.status, 0, planned.stderr);
  assert.deepEqual(result(planned).actions.map((item) => item.target).sort(),
    ['agents/reviewer.md', 'extensions/github-copilot-usage', 'extensions/subagent/config.json', 'prompts/deploy.md', 'roles/moderator.md']);
  assert.equal(result(planned).conflicts.length, 0);
  assert.equal(result(planned).staleResources.length, 0);
  assert.equal(await fs.readFile(path.join(agentDir, 'prompts', 'unmanaged.md'), 'utf8'), '# Unmanaged prompt\n');
  assert.equal(await fs.readFile(path.join(agentDir, 'extensions', 'unmanaged-ext.ts'), 'utf8'), 'export const x = 1;\n');
});

test('prompt, agent, and role resources reconcile with the same three-way semantics as skills', async (t) => {
  const { repo, agentDir } = await extendedFixture(t);
  for (const [type, source] of [['prompt', 'prompts/deploy.md'], ['agent', 'agents/reviewer.md'], ['role', 'roles/moderator.md']]) {
    const response = run(['add', '--type', type, '--source', source, '--repo', repo, '--agent-dir', agentDir]);
    assert.equal(response.status, 0, response.stderr);
  }
  const first = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(first.status, 0, first.stderr);
  for (const action of result(first).actions) assert.equal(action.action, 'unchanged');

  // prompt: a local-only edit is preserved and reported as local-divergence.
  const prompt = path.join(agentDir, 'prompts', 'deploy.md');
  await fs.writeFile(prompt, '# Local prompt edit\n');
  const divergence = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(divergence.status, 0, divergence.stderr);
  assert.equal(result(divergence).actions.find((item) => item.target === 'prompts/deploy.md').action, 'local-divergence');
  assert.equal(await fs.readFile(prompt, 'utf8'), '# Local prompt edit\n');

  // role: a repository-only edit applies.
  const roleTarget = path.join(agentDir, 'roles', 'moderator.md');
  await fs.writeFile(path.join(repo, 'resources', 'roles', 'moderator.md'), '# Repository role edit\n');
  const updated = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(updated.status, 0, updated.stderr);
  assert.equal(result(updated).actions.find((item) => item.target === 'roles/moderator.md').action, 'updated');
  assert.equal(await fs.readFile(roleTarget, 'utf8'), '# Repository role edit\n');

  // agent: repository and local both changed conflicts without overwriting.
  const agentTarget = path.join(agentDir, 'agents', 'reviewer.md');
  await fs.writeFile(agentTarget, '# Local agent edit\n');
  await fs.writeFile(path.join(repo, 'resources', 'agents', 'reviewer.md'), '# Repository agent edit\n');
  const conflict = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(conflict.status, 1, conflict.stderr);
  assert.equal(result(conflict).actions.find((item) => item.target === 'agents/reviewer.md').action, 'conflict');
  assert.equal(await fs.readFile(agentTarget, 'utf8'), '# Local agent edit\n');
});

test('multi-file extension directories are managed end to end with the same three-way semantics', async (t) => {
  const { repo, agentDir } = await extendedFixture(t);
  const response = run(['add', '--type', 'extension', '--source', 'extensions/github-copilot-usage', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(response.status, 0, response.stderr);
  assert.equal(result(response).repositorySource, 'resources/extensions/github-copilot-usage');
  const first = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(result(first).actions[0].action, 'unchanged');

  // Local-only change is preserved and reported with per-file detail.
  const targetIndex = path.join(agentDir, 'extensions', 'github-copilot-usage', 'index.ts');
  await fs.writeFile(targetIndex, 'export const usage = "local";\n');
  const divergence = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(divergence.status, 0, divergence.stderr);
  const divergenceAction = result(divergence).actions[0];
  assert.equal(divergenceAction.action, 'local-divergence');
  assert.equal(divergenceAction.files.find((file) => file.path === 'index.ts').action, 'local-divergence');
  assert.equal(await fs.readFile(targetIndex, 'utf8'), 'export const usage = "local";\n');

  // Repository and local both changed conflicts without overwriting.
  await fs.writeFile(path.join(repo, 'resources', 'extensions', 'github-copilot-usage', 'index.ts'), 'export const usage = "repo";\n');
  const conflict = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(conflict.status, 1, conflict.stderr);
  const conflictAction = result(conflict).actions[0];
  assert.equal(conflictAction.action, 'conflict');
  assert.equal(conflictAction.files.find((file) => file.path === 'index.ts').action, 'conflict');
  assert.equal(await fs.readFile(targetIndex, 'utf8'), 'export const usage = "local";\n');

  // Aligning the local file with the last-applied baseline lets the repository-only change apply.
  await fs.writeFile(targetIndex, 'export const usage = true;\n');
  const updated = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(updated.status, 0, updated.stderr);
  assert.equal(result(updated).actions[0].action, 'updated');
  assert.equal(await fs.readFile(targetIndex, 'utf8'), 'export const usage = "repo";\n');
  // The sibling file that never changed stays intact.
  assert.equal(await fs.readFile(path.join(agentDir, 'extensions', 'github-copilot-usage', 'test.ts'), 'utf8'), 'export const t = true;\n');
});

test('a package update rewrite of a managed extension config file is reported, never silently overwritten', async (t) => {
  const { repo, agentDir } = await extendedFixture(t);
  const response = run(['add', '--type', 'extension', '--source', 'extensions/subagent/config.json', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(response.status, 0, response.stderr);
  const first = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(result(first).actions[0].action, 'unchanged');
  const config = path.join(agentDir, 'extensions', 'subagent', 'config.json');

  // A pinned package install rewrites the managed config file locally: local-only change.
  await fs.writeFile(config, `${JSON.stringify({ model: 'package-rewritten' }, null, 2)}\n`);
  const divergence = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(divergence.status, 0, divergence.stderr);
  assert.equal(result(divergence).actions[0].action, 'local-divergence');
  assert.equal(JSON.parse(await fs.readFile(config, 'utf8')).model, 'package-rewritten');

  // Repository and local both changed: conflict through the ordinary three-way rules.
  await fs.writeFile(path.join(repo, 'resources', 'extensions', 'subagent', 'config.json'), `${JSON.stringify({ model: 'repo-config' }, null, 2)}\n`);
  const conflict = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(conflict.status, 1, conflict.stderr);
  assert.equal(result(conflict).actions[0].action, 'conflict');
  assert.equal(JSON.parse(await fs.readFile(config, 'utf8')).model, 'package-rewritten');

  // Resolving locally to the last-applied baseline lets the repository change apply.
  await fs.writeFile(config, `${JSON.stringify({ model: 'local-model', maxAgents: 3 }, null, 2)}\n`);
  const updated = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(updated.status, 0, updated.stderr);
  assert.equal(result(updated).actions[0].action, 'updated');
  assert.equal(JSON.parse(await fs.readFile(config, 'utf8')).model, 'repo-config');
});

test('new-type add guards reject symlinks, traversal, collisions, secrets, and package-installed code', async (t) => {
  const { repo, agentDir } = await extendedFixture(t);

  // Symlinked file source is rejected.
  await fs.symlink(path.join(agentDir, 'prompts', 'deploy.md'), path.join(agentDir, 'prompts', 'linked.md'));
  const symlink = run(['add', '--type', 'prompt', '--source', 'prompts/linked.md', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(symlink.status, 2, symlink.stderr);
  assert.match(result(symlink).error, /symbolic link/i);
  await assert.rejects(fs.access(path.join(repo, 'resources', 'prompts', 'linked.md')));
  await fs.rm(path.join(agentDir, 'prompts', 'linked.md'));

  // Path traversal is rejected before any import.
  const traversal = run(['add', '--type', 'prompt', '--source', 'prompts/../../outside.md', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(traversal.status, 2);
  assert.match(result(traversal).error, /.. path segments/);

  // A source outside the type root is rejected.
  const wrongRoot = run(['add', '--type', 'extension', '--source', 'prompts/deploy.md', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(wrongRoot.status, 2);
  assert.match(result(wrongRoot).error, /Extension source must be a file or directory under extensions\//);

  // A non-.md file is rejected for prompt types.
  const wrongShape = run(['add', '--type', 'agent', '--source', 'prompts/deploy.md', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(wrongShape.status, 2);
  assert.match(result(wrongShape).error, /Agent source must be a \.md file directly under agents\//);

  // Re-adding an already declared source is a collision.
  assert.equal(run(['add', '--type', 'prompt', '--source', 'prompts/deploy.md', '--repo', repo, '--agent-dir', agentDir]).status, 0);
  const collision = run(['add', '--type', 'prompt', '--source', 'prompts/deploy.md', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(collision.status, 2);
  assert.equal(result(collision).errorCode, 'RESOURCE_COLLISION');

  // A repository path that exists but is not declared is a collision.
  await fs.mkdir(path.join(repo, 'resources', 'agents'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'agents', 'reviewer.md'), '# Existing\n');
  const repoCollision = run(['add', '--type', 'agent', '--source', 'agents/reviewer.md', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(repoCollision.status, 2);
  assert.equal(result(repoCollision).errorCode, 'RESOURCE_COLLISION');
  assert.match(result(repoCollision).error, /setup repository path already exists/);
  await fs.rm(path.join(repo, 'resources', 'agents'), { recursive: true });

  // Likely secret material stops the import before anything is copied.
  await fs.writeFile(path.join(agentDir, 'extensions', 'subagent', 'config.json'), 'apiKey = "ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ"\n');
  const secret = run(['add', '--type', 'extension', '--source', 'extensions/subagent/config.json', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(secret.status, 2);
  const secretOutput = result(secret);
  assert.equal(secretOutput.errorCode, 'SECRET_REVIEW_REQUIRED');
  assert.equal(secretOutput.reviewRequired[0].path, 'extensions/subagent/config.json');
  assert.match(secretOutput.reviewRequired[0].reason, /GitHub token/);
  await assert.rejects(fs.access(path.join(repo, 'resources', 'extensions', 'subagent')));
  await fs.writeFile(path.join(agentDir, 'extensions', 'subagent', 'config.json'), `${JSON.stringify({ model: 'local-model', maxAgents: 3 }, null, 2)}\n`);

  // Package-installed code (npm tree) is never imported into the repository.
  await fs.mkdir(path.join(agentDir, 'extensions', 'github-copilot-usage', 'node_modules', 'pinned'), { recursive: true });
  await fs.writeFile(path.join(agentDir, 'extensions', 'github-copilot-usage', 'node_modules', 'pinned', 'index.js'), 'module.exports = 1;\n');
  const packageCode = run(['add', '--type', 'extension', '--source', 'extensions/github-copilot-usage', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(packageCode.status, 2);
  assert.match(result(packageCode).error, /node_modules/);
  await assert.rejects(fs.access(path.join(repo, 'resources', 'extensions', 'github-copilot-usage')));
  await fs.rm(path.join(agentDir, 'extensions', 'github-copilot-usage', 'node_modules'), { recursive: true });
});

test('declared targets that already exist unmanaged are reported as collisions and never overwritten', async (t) => {
  const { repo, agentDir } = await extendedFixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');

  // Unmanaged file with different content at a declared file target.
  await fs.writeFile(path.join(agentDir, 'prompts', 'deploy.md'), '# Keep my local prompt\n');
  await fs.mkdir(path.join(repo, 'resources', 'prompts'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'prompts', 'deploy.md'), '# Repository prompt\n');
  let manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.resources.push({ type: 'prompt', source: 'resources/prompts/deploy.md', target: 'prompts/deploy.md' });
  await fs.writeFile(manifestPath, JSON.stringify(manifest));

  const applied = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(applied.status, 1, applied.stderr);
  const output = result(applied);
  assert.equal(output.actions[0].action, 'collision');
  assert.equal(output.conflicts[0].target, 'prompts/deploy.md');
  assert.equal(await fs.readFile(path.join(agentDir, 'prompts', 'deploy.md'), 'utf8'), '# Keep my local prompt\n');

  // A directory where a managed file is declared is also a collision and is left intact.
  await fs.rm(path.join(agentDir, 'prompts', 'deploy.md'));
  await fs.rm(path.join(agentDir, 'extensions', 'subagent', 'config.json'));
  await fs.mkdir(path.join(agentDir, 'extensions', 'subagent', 'config.json'), { recursive: true });
  await fs.writeFile(path.join(agentDir, 'extensions', 'subagent', 'config.json', 'inner.txt'), 'keep\n');
  await fs.mkdir(path.join(repo, 'resources', 'extensions', 'subagent'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'extensions', 'subagent', 'config.json'), '{"model":"x"}\n');
  manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.resources.push({ type: 'extension', source: 'resources/extensions/subagent/config.json', target: 'extensions/subagent/config.json' });
  await fs.writeFile(manifestPath, JSON.stringify(manifest));

  const second = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(second.status, 1, second.stderr);
  const secondOutput = result(second);
  assert.equal(secondOutput.actions.find((item) => item.target === 'extensions/subagent/config.json').action, 'collision');
  assert.equal(await fs.readFile(path.join(agentDir, 'extensions', 'subagent', 'config.json', 'inner.txt'), 'utf8'), 'keep\n');
  const stillDirectory = await fs.lstat(path.join(agentDir, 'extensions', 'subagent', 'config.json'));
  assert.equal(stillDirectory.isDirectory(), true);
});

test('stale new-type resources are reported and prune removes managed file resources', async (t) => {
  const { repo, agentDir } = await extendedFixture(t);
  addAllExtended(repo, agentDir);
  const first = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(first.status, 0, first.stderr);

  // Undeclaring two file-kind resources leaves stale baselines for them.
  const manifestPath = path.join(repo, 'pi-sync.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.resources = manifest.resources.filter((item) => !['prompts/deploy.md', 'extensions/subagent/config.json'].includes(item.target));
  await fs.writeFile(manifestPath, JSON.stringify(manifest));

  const applied = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(applied.status, 0, applied.stderr);
  const appliedOutput = result(applied);
  assert.deepEqual(appliedOutput.staleResources.map((item) => item.target).sort(), ['extensions/subagent/config.json', 'prompts/deploy.md']);
  for (const target of ['extensions/subagent/config.json', 'prompts/deploy.md']) {
    assert.equal(appliedOutput.staleResources.find((item) => item.target === target).state, 'unchanged');
    assert.equal(appliedOutput.actions.find((item) => item.target === target).action, 'stale');
  }
  // Local content of the stale resources is intact.
  assert.equal(await fs.readFile(path.join(agentDir, 'prompts', 'deploy.md'), 'utf8'), '# Deploy prompt\n');
  assert.equal(await fs.readFile(path.join(agentDir, 'extensions', 'subagent', 'config.json'), 'utf8'), `${JSON.stringify({ model: 'local-model', maxAgents: 3 }, null, 2)}\n`);

  // Preview does not delete.
  const preview = run(['prune', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.deepEqual(result(preview).staleResources.map((item) => item.action).sort(), ['would-prune', 'would-prune']);
  await fs.access(path.join(agentDir, 'prompts', 'deploy.md'));

  // Confirmed prune removes the local file copies and their state entries.
  const pruned = run(['prune', '--confirm', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(pruned.status, 0, pruned.stderr);
  assert.deepEqual(result(pruned).staleResources.map((item) => item.target).sort(), ['extensions/subagent/config.json', 'prompts/deploy.md']);
  await assert.rejects(fs.access(path.join(agentDir, 'prompts', 'deploy.md')));
  await assert.rejects(fs.access(path.join(agentDir, 'extensions', 'subagent', 'config.json')));
  const state = JSON.parse(await fs.readFile(path.join(agentDir, '.pi-sync', 'state.json'), 'utf8'));
  assert.equal(Object.hasOwn(state.resources, 'prompts/deploy.md'), false);
  assert.equal(Object.hasOwn(state.resources, 'extensions/subagent/config.json'), false);
  // The sibling unmanaged prompt and the remaining managed resources stay intact.
  assert.equal(await fs.readFile(path.join(agentDir, 'prompts', 'unmanaged.md'), 'utf8'), '# Unmanaged prompt\n');
  assert.equal(await fs.readFile(path.join(agentDir, 'roles', 'moderator.md'), 'utf8'), '# Moderator role\n');

  // A stale multi-file extension directory is pruned the same way.
  const manifest3 = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest3.resources = manifest3.resources.filter((item) => item.target !== 'extensions/github-copilot-usage');
  await fs.writeFile(manifestPath, JSON.stringify(manifest3));
  const prunedDir = run(['prune', '--confirm', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(prunedDir.status, 0, prunedDir.stderr);
  const pruneDirOutput = result(prunedDir);
  assert.equal(pruneDirOutput.staleResources[0].target, 'extensions/github-copilot-usage');
  assert.equal(pruneDirOutput.staleResources[0].action, 'pruned');
  await assert.rejects(fs.access(path.join(agentDir, 'extensions', 'github-copilot-usage')));
  const state3 = JSON.parse(await fs.readFile(path.join(agentDir, '.pi-sync', 'state.json'), 'utf8'));
  assert.equal(Object.hasOwn(state3.resources, 'extensions/github-copilot-usage'), false);
  // The pruned directory was backed up.
  const backupRoot = path.join(agentDir, '.pi-sync', 'backups');
  const backupEntries = await fs.readdir(backupRoot);
  assert.ok(backupEntries.length >= 3, 'pruned resources are backed up');
  const prunedBackups = await fs.readdir(path.join(backupRoot, backupEntries.at(-1)));
  assert.equal(prunedBackups[0], 'extensions');
  assert.equal(await fs.readFile(path.join(backupRoot, backupEntries.at(-1), 'extensions', 'github-copilot-usage', 'index.ts'), 'utf8'), 'export const usage = true;\n');

  // A stale file resource with local edits is retained, not overwritten.
  const manifest2 = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest2.resources = manifest2.resources.filter((item) => item.target !== 'agents/reviewer.md');
  await fs.writeFile(manifestPath, JSON.stringify(manifest2));
  await fs.writeFile(path.join(agentDir, 'agents', 'reviewer.md'), '# Keep my local agent\n');
  const retained = run(['prune', '--confirm', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(retained.status, 1, retained.stderr);
  assert.equal(result(retained).staleResources[0].action, 'retained-modified');
  assert.equal(await fs.readFile(path.join(agentDir, 'agents', 'reviewer.md'), 'utf8'), '# Keep my local agent\n');
});

test('manifest validation fails closed for wrong-type roots, missing sources, and duplicate targets before local changes', async (t) => {
  const { repo, agentDir } = await extendedFixture(t);
  await fs.mkdir(path.join(repo, 'resources', 'extensions'), { recursive: true });
  await fs.mkdir(path.join(repo, 'resources', 'prompts'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'extensions', 'config.json'), '{}\n');
  await fs.writeFile(path.join(repo, 'resources', 'prompts', 'deploy.md'), '# Deploy prompt\n');

  // extension source under a foreign root
  await fs.writeFile(path.join(repo, 'pi-sync.json'), JSON.stringify({
    schemaVersion: 1,
    resources: [{ type: 'extension', source: 'resources/prompts/deploy.md', target: 'extensions/deploy' }],
    dependencies: [],
  }));
  let check = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(check.status, 2);
  assert.match(result(check).error, /Extension resources must use resources\/extensions\/ sources/);

  // prompt source with the wrong file shape under the correct root
  await fs.writeFile(path.join(repo, 'pi-sync.json'), JSON.stringify({
    schemaVersion: 1,
    resources: [{ type: 'prompt', source: 'resources/prompts/deploy', target: 'prompts/deploy' }],
    dependencies: [],
  }));
  check = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(check.status, 2);
  assert.match(result(check).error, /must be a single \.md file directly under prompts\//);

  // prompt target outside its root
  await fs.writeFile(path.join(repo, 'pi-sync.json'), JSON.stringify({
    schemaVersion: 1,
    resources: [{ type: 'prompt', source: 'resources/prompts/deploy.md', target: 'agents/deploy.md' }],
    dependencies: [],
  }));
  check = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(check.status, 2);
  assert.match(result(check).error, /Prompt resources must use resources\/prompts\/ sources and prompts\/ targets/);

  // unknown resource type
  await fs.writeFile(path.join(repo, 'pi-sync.json'), JSON.stringify({
    schemaVersion: 1,
    resources: [{ type: 'theme', source: 'resources/prompts/deploy.md', target: 'prompts/deploy.md' }],
    dependencies: [],
  }));
  check = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(check.status, 2);
  assert.match(result(check).error, /Unsupported resource type in resources\[0\]: theme/);

  // missing source file
  await fs.writeFile(path.join(repo, 'pi-sync.json'), JSON.stringify({
    schemaVersion: 1,
    resources: [{ type: 'role', source: 'resources/roles/missing.md', target: 'roles/missing.md' }],
    dependencies: [],
  }));
  check = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(check.status, 2);
  assert.match(result(check).error, /Resource source does not exist: resources\/roles\/missing\.md/);

  // duplicate targets
  await fs.writeFile(path.join(repo, 'pi-sync.json'), JSON.stringify({
    schemaVersion: 1,
    resources: [
      { type: 'prompt', source: 'resources/prompts/deploy.md', target: 'prompts/deploy.md' },
      { type: 'prompt', source: 'resources/prompts/deploy.md', target: 'prompts/deploy.md' },
    ],
    dependencies: [],
  }));
  check = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(check.status, 2);
  assert.match(result(check).error, /Duplicate resource target: prompts\/deploy\.md/);

  // A valid file-resource manifest validates and applies cleanly.
  await fs.writeFile(path.join(repo, 'pi-sync.json'), JSON.stringify({
    schemaVersion: 1,
    resources: [{ type: 'prompt', source: 'resources/prompts/deploy.md', target: 'prompts/deploy.md' }],
    dependencies: [],
  }));
  await fs.rm(path.join(agentDir, 'prompts', 'deploy.md'));
  const ok = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(result(ok).actions[0].action, 'installed');
  assert.equal(await fs.readFile(path.join(agentDir, 'prompts', 'deploy.md'), 'utf8'), '# Deploy prompt\n');
});

test('a managed file target replaced by a directory conflicts at apply without crashing or changing the target', async (t) => {
  const { repo, agentDir } = await extendedFixture(t);
  const added = run(['add', '--type', 'prompt', '--source', 'prompts/deploy.md', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(added.status, 0, added.stderr);
  const first = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(result(first).actions[0].action, 'unchanged');
  const target = path.join(agentDir, 'prompts', 'deploy.md');
  const statePath = path.join(agentDir, '.pi-sync', 'state.json');
  const baselineState = await fs.readFile(statePath, 'utf8');
  const baselineFile = JSON.parse(baselineState).resources['prompts/deploy.md'].files['deploy.md'];

  // Locally replace the managed file with a directory that still holds the baseline content.
  await fs.rm(target);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'deploy.md'), '# Deploy prompt\n');
  await fs.chmod(path.join(target, 'deploy.md'), baselineFile.mode);
  await fs.writeFile(path.join(repo, 'resources', 'prompts', 'deploy.md'), '# Repository prompt edit\n');

  const planned = run(['plan', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(planned.status, 1, planned.stderr);
  assert.equal(result(planned).actions[0].action, 'conflict');
  assert.match(result(planned).actions[0].reason, /changed type/);

  // Apply reports the same structured conflict instead of crashing on the directory.
  const applied = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(applied.status, 1, applied.stderr);
  assert.doesNotMatch(applied.stdout, /rollback was incomplete/);
  assert.doesNotMatch(applied.stdout, /EISDIR/);
  const appliedAction = result(applied).actions[0];
  assert.equal(appliedAction.action, 'conflict');
  assert.match(appliedAction.reason, /changed type/);
  // The local directory and its content are untouched and the baseline was not advanced.
  const stillDirectory = await fs.lstat(target);
  assert.equal(stillDirectory.isDirectory(), true);
  assert.equal(await fs.readFile(path.join(target, 'deploy.md'), 'utf8'), '# Deploy prompt\n');
  assert.equal(await fs.readFile(statePath, 'utf8'), baselineState);

  // Restoring the file to the baseline lets the pending repository change apply.
  await fs.rm(path.join(target, 'deploy.md'));
  await fs.rm(target, { recursive: true });
  await fs.writeFile(target, '# Deploy prompt\n');
  await fs.chmod(target, baselineFile.mode);
  const resolved = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.equal(result(resolved).actions[0].action, 'updated');
  assert.equal(await fs.readFile(target, 'utf8'), '# Repository prompt edit\n');
});

test('a managed extension directory replaced by a file conflicts at apply without re-materializing the directory', async (t) => {
  const { repo, agentDir } = await extendedFixture(t);
  // A directory extension whose name matches an inner file, so a file standing in for the
  // directory still matches the baseline content and the kind-change guard is the conflict.
  const sourceDir = path.join(agentDir, 'extensions', 'tool');
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'tool'), 'export const tool = 1;\n');
  const added = run(['add', '--type', 'extension', '--source', 'extensions/tool', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(added.status, 0, added.stderr);
  const first = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(result(first).actions[0].action, 'unchanged');
  const target = path.join(agentDir, 'extensions', 'tool');
  const statePath = path.join(agentDir, '.pi-sync', 'state.json');
  const baselineState = await fs.readFile(statePath, 'utf8');
  const baselineFile = JSON.parse(baselineState).resources['extensions/tool'].files['tool'];

  // Locally replace the managed directory with a single file holding the baseline content,
  // then have the repository remove that file: a pending delete that must not re-create the directory.
  await fs.rm(target, { recursive: true });
  await fs.writeFile(target, Buffer.from(baselineFile.content, 'base64'));
  await fs.chmod(target, baselineFile.mode);
  await fs.rm(path.join(repo, 'resources', 'extensions', 'tool', 'tool'));

  const planned = run(['plan', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(planned.status, 1, planned.stderr);
  const plannedAction = result(planned).actions[0];
  assert.equal(plannedAction.action, 'conflict');
  assert.match(plannedAction.reason, /changed type/);
  assert.equal(plannedAction.files[0].action, 'delete');

  const applied = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(applied.status, 1, applied.stderr);
  assert.doesNotMatch(applied.stdout, /rollback was incomplete/);
  const appliedAction = result(applied).actions[0];
  assert.equal(appliedAction.action, 'conflict');
  assert.match(appliedAction.reason, /changed type/);
  // The user's file is not absorbed into a re-materialized directory and the baseline is unchanged.
  const stillFile = await fs.lstat(target);
  assert.equal(stillFile.isFile(), true);
  assert.equal(await fs.readFile(target, 'utf8'), 'export const tool = 1;\n');
  assert.equal(await fs.readFile(statePath, 'utf8'), baselineState);
});

test('file resource installs keep the repository file mode under a restrictive umask and stay idempotent', async (t) => {
  const { repo, agentDir } = await extendedFixture(t);
  const added = run(['add', '--type', 'prompt', '--source', 'prompts/deploy.md', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(added.status, 0, added.stderr);
  const target = path.join(agentDir, 'prompts', 'deploy.md');
  await fs.rm(target);
  const repoMode = (await fs.stat(path.join(repo, 'resources', 'prompts', 'deploy.md'))).mode & 0o777;
  const previousUmask = process.umask(0o077);
  try {
    const installed = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(result(installed).actions[0].action, 'installed');
    assert.equal((await fs.stat(target)).mode & 0o777, repoMode);
    const repeated = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(result(repeated).actions[0].action, 'unchanged');
  } finally {
    process.umask(previousUmask);
  }
});

test('a failed file apply restores the previous file through rollback and keeps the baseline', async (t) => {
  const { repo, agentDir } = await extendedFixture(t);
  const added = run(['add', '--type', 'prompt', '--source', 'prompts/deploy.md', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(added.status, 0, added.stderr);
  const first = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(result(first).actions[0].action, 'unchanged');
  const target = path.join(agentDir, 'prompts', 'deploy.md');
  const original = await fs.readFile(target, 'utf8');
  const originalMode = (await fs.stat(target)).mode & 0o777;
  const statePath = path.join(agentDir, '.pi-sync', 'state.json');
  const baselineState = await fs.readFile(statePath, 'utf8');

  await fs.writeFile(path.join(repo, 'resources', 'prompts', 'deploy.md'), '# Repository prompt edit\n');
  // Block the backup step so the file apply fails after planning and rollback capture.
  const backupsPath = path.join(agentDir, '.pi-sync', 'backups');
  await fs.writeFile(backupsPath, 'blocked\n');
  const failed = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(failed.status, 2, failed.stderr);
  assert.equal(result(failed).ok, false);
  assert.doesNotMatch(failed.stdout, /rollback was incomplete/);
  // The previous file is intact, the repository change did not leak in, and the baseline was not advanced.
  assert.equal(await fs.readFile(target, 'utf8'), original);
  assert.equal((await fs.stat(target)).mode & 0o777, originalMode);
  assert.equal(await fs.readFile(statePath, 'utf8'), baselineState);

  // Unblocking backups lets the pending update apply.
  await fs.rm(backupsPath);
  const retried = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(result(retried).actions[0].action, 'updated');
  assert.equal(await fs.readFile(target, 'utf8'), '# Repository prompt edit\n');
});

test('remove deletes managed resources and dependencies from the repository without touching the local installation', async (t) => {
  const { root, repo, agentDir } = await extendedFixture(t);
  const skillDir = path.join(agentDir, 'skills', 'hello');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Hello\n');
  assert.equal(run(['add', '--type', 'skill', '--source', 'skills/hello', '--repo', repo, '--agent-dir', agentDir]).status, 0);
  addAllExtended(repo, agentDir);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const lockPath = path.join(repo, 'pi-sync.lock.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.dependencies = [{ type: 'npm', name: 'fixture-package' }, { type: 'github', repository: 'acme/pi-extension' }];
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(lockPath, `${JSON.stringify({ schemaVersion: 1, packages: [
    { type: 'npm', name: 'fixture-package', version: '1.0.0', releasedAt: '2020-01-01T00:00:00.000Z' },
    { type: 'github', repository: 'acme/pi-extension', commit: 'a'.repeat(40), tag: 'v1.0.0', releasedAt: '2020-01-01T00:00:00.000Z' },
  ] }, null, 2)}\n`);
  const piEnv = await fakePi(t);
  const log = path.join(root, 'pi-calls.log');
  const applied = run(['apply', '--approve', '--repo', repo, '--agent-dir', agentDir], { ...piEnv, PI_CALL_LOG: log });
  assert.equal(applied.status, 0, `${applied.stderr}\n${applied.stdout}`);
  assert.equal((await piCalls(log)).filter((call) => call.startsWith('install')).length, 2, 'both packages installed locally before removal');

  const removals = [
    ['skill', 'skills/hello'],
    ['extension', 'extensions/github-copilot-usage'],
    ['extension', 'extensions/subagent/config.json'],
    ['prompt', 'prompts/deploy.md'],
    ['agent', 'agents/reviewer.md'],
    ['role', 'roles/moderator.md'],
  ];
  for (const [type, target] of removals) {
    const response = run(['remove', '--repo', repo, '--agent-dir', agentDir, '--type', type, '--target', target], piEnv);
    assert.equal(response.status, 0, `${type} ${target}: ${response.stderr}\n${response.stdout}`);
    const output = result(response);
    assert.equal(output.apiVersion, 1);
    assert.equal(output.command, 'remove');
    assert.equal(output.ok, true);
    assert.equal(output.exitCode, 0);
    assert.deepEqual(output.removed, { type, source: `resources/${target}`, target });
    assert.equal(output.stale.target, target);
    assert.equal(output.stale.localInstallation, 'unchanged');
    // Repository content and manifest entry are gone.
    await assert.rejects(fs.access(path.join(repo, 'resources', ...target.split('/'))));
    const current = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    assert.equal(current.resources.some((item) => item.target === target), false);
    // The local installation is never modified and nothing is queued: the
    // baseline stays in the local state for the stale report and prune flow.
    const state = JSON.parse(await fs.readFile(path.join(agentDir, '.pi-sync', 'state.json'), 'utf8'));
    assert.ok(state.resources[target], `baseline for ${target} is retained`);
  }
  assert.equal(await fs.readFile(path.join(agentDir, 'skills', 'hello', 'SKILL.md'), 'utf8'), '# Hello\n');
  assert.equal(await fs.readFile(path.join(agentDir, 'extensions', 'github-copilot-usage', 'index.ts'), 'utf8'), 'export const usage = true;\n');
  assert.equal(await fs.readFile(path.join(agentDir, 'prompts', 'deploy.md'), 'utf8'), '# Deploy prompt\n');

  const npmRemoved = run(['remove', '--repo', repo, '--agent-dir', agentDir, '--type', 'dependency', '--source', 'npm:fixture-package'], piEnv);
  assert.equal(npmRemoved.status, 0, npmRemoved.stderr);
  const npmOutput = result(npmRemoved);
  assert.deepEqual(npmOutput.removed.dependency, { type: 'npm', name: 'fixture-package' });
  assert.equal(npmOutput.removed.pin.version, '1.0.0');
  assert.equal(npmOutput.localInstallation, 'unchanged');
  const githubRemoved = run(['remove', '--repo', repo, '--agent-dir', agentDir, '--type', 'dependency', '--source', 'github:acme/pi-extension'], piEnv);
  assert.equal(githubRemoved.status, 0, githubRemoved.stderr);
  assert.deepEqual(result(githubRemoved).removed.dependency, { type: 'github', repository: 'acme/pi-extension' });
  const finalManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.deepEqual(finalManifest.dependencies, []);
  const finalLock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  assert.deepEqual(finalLock.packages, []);
  // Removal never uninstalls on its own.
  assert.equal((await piCalls(log)).filter((call) => call.startsWith('uninstall')).length, 0);
});

test('remove validates before changing anything and leaves the repository unchanged on failure', async (t) => {
  const { repo, agentDir } = await extendedFixture(t);
  const skillDir = path.join(agentDir, 'skills', 'hello');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Hello\n');
  assert.equal(run(['add', '--type', 'skill', '--source', 'skills/hello', '--repo', repo, '--agent-dir', agentDir]).status, 0);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const lockPath = path.join(repo, 'pi-sync.lock.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.dependencies = [{ type: 'npm', name: 'fixture-package' }];
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(lockPath, `${JSON.stringify({ schemaVersion: 1, packages: [
    { type: 'npm', name: 'fixture-package', version: '1.0.0', releasedAt: '2020-01-01T00:00:00.000Z' },
  ] }, null, 2)}\n`);
  const manifestBefore = await fs.readFile(manifestPath, 'utf8');
  const lockBefore = await fs.readFile(lockPath, 'utf8');
  const contentBefore = await fs.readFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), 'utf8');

  const failures = [
    { args: ['remove', '--repo', repo, '--agent-dir', agentDir, '--type', 'skill', '--target', 'skills/absent'], errorCode: 'REMOVE_TARGET_NOT_FOUND' },
    { args: ['remove', '--repo', repo, '--agent-dir', agentDir, '--type', 'prompt', '--target', 'skills/hello'], errorCode: 'REMOVE_TYPE_MISMATCH' },
    { args: ['remove', '--repo', repo, '--agent-dir', agentDir, '--type', 'dependency', '--source', 'npm:absent'], errorCode: 'REMOVE_DEPENDENCY_NOT_FOUND' },
    { args: ['remove', '--repo', repo, '--agent-dir', agentDir, '--type', 'theme', '--target', 'skills/hello'], errorCode: 'VALIDATION_ERROR' },
    { args: ['remove', '--repo', repo, '--agent-dir', agentDir, '--type', 'skill'] },
    { args: ['remove', '--repo', repo, '--agent-dir', agentDir, '--type', 'dependency'] },
    { args: ['remove', '--repo', repo, '--agent-dir', agentDir, '--type', 'skill', '--target', 'skills/hello', '--uninstall'], errorCode: 'VALIDATION_ERROR' },
    { args: ['remove', '--repo', repo, '--agent-dir', agentDir, '--type', 'skill', '--target', '../escape'], errorCode: 'VALIDATION_ERROR' },
  ];
  for (const { args, errorCode } of failures) {
    const response = run(args);
    assert.equal(response.status, 2, `${args.join(' ')}: ${response.stderr}\n${response.stdout}`);
    const output = result(response);
    assert.equal(output.ok, false);
    assert.equal(output.exitCode, 2);
    if (errorCode) assert.equal(output.errorCode, errorCode);
  }
  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestBefore);
  assert.equal(await fs.readFile(lockPath, 'utf8'), lockBefore);
  assert.equal(await fs.readFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), 'utf8'), contentBefore);

  // A repository that does not validate stops remove before any change.
  await fs.writeFile(lockPath, `${JSON.stringify({ schemaVersion: 1, packages: [] }, null, 2)}\n`);
  const invalid = run(['remove', '--repo', repo, '--agent-dir', agentDir, '--type', 'skill', '--target', 'skills/hello']);
  assert.equal(invalid.status, 2, invalid.stderr);
  assert.equal(result(invalid).errorCode, 'VALIDATION_ERROR');
  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestBefore);
  assert.equal(await fs.readFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), 'utf8'), contentBefore);
});

test('push publishes removal commits that delete previously managed paths', async (t) => {
  // Working-tree removal: remove, preview, and publish through managed push.
  const { repo, bare, root } = await pushFixture(t);
  const agentDir = path.join(root, 'agent');
  const removed = run(['remove', '--repo', repo, '--agent-dir', agentDir, '--type', 'skill', '--target', 'skills/hello']);
  assert.equal(removed.status, 0, removed.stderr);
  const preview = run(['push', '--repo', repo]);
  assert.equal(preview.status, 0, preview.stderr);
  const plan = result(preview);
  assert.equal(plan.mode, 'preview');
  assert.deepEqual(plan.changes.map((item) => [item.status, item.path]).sort(), [['D', 'resources/skills/hello/SKILL.md'], ['M', 'pi-sync.json']]);
  assert.equal(plan.commitRequired, true);
  const published = run(['push', '--publish', '--repo', repo]);
  assert.equal(published.status, 0, published.stderr);
  const output = result(published);
  assert.equal(output.mode, 'published');
  assert.deepEqual(output.changes.map((item) => [item.status, item.path]).sort(), [['D', 'resources/skills/hello/SKILL.md'], ['M', 'pi-sync.json']]);
  const remoteFiles = spawnSync('git', ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' });
  assert.equal(remoteFiles.status, 0, remoteFiles.stderr);
  assert.deepEqual(remoteFiles.stdout.trim().split(/\r?\n/).sort(), ['.gitignore', 'pi-sync.json', 'pi-sync.lock.json']);
  const headFiles = gitAt(repo, ['show', '--format=', '--name-only', 'HEAD']).split(/\r?\n/).filter(Boolean);
  assert.deepEqual(headFiles.sort(), ['pi-sync.json', 'resources/skills/hello/SKILL.md']);

  // Committed removal ahead of upstream: validated against the manifest as of
  // the commit (plus the current managed set) and publishable.
  const second = await pushFixture(t);
  const { repo: repo2, bare: bare2 } = second;
  const manifest2 = path.join(repo2, 'pi-sync.json');
  await fs.writeFile(manifest2, `${JSON.stringify({ schemaVersion: 1, resources: [], dependencies: [] }, null, 2)}\n`);
  gitAt(repo2, ['rm', '--quiet', '-r', '--', 'resources/skills/hello']);
  gitAt(repo2, ['add', '--', 'pi-sync.json']);
  gitAt(repo2, ['commit', '-m', 'roll back skill']);
  const ahead = run(['push', '--publish', '--repo', repo2]);
  assert.equal(ahead.status, 0, `${ahead.stderr}\n${ahead.stdout}`);
  const aheadOutput = result(ahead);
  assert.equal(aheadOutput.mode, 'published');
  assert.deepEqual(aheadOutput.changes.map((item) => [item.status, item.path]).sort(),
    [['committed', 'pi-sync.json'], ['committed', 'resources/skills/hello/SKILL.md']]);
  const remoteFiles2 = spawnSync('git', ['--git-dir', bare2, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' });
  assert.equal(remoteFiles2.status, 0, remoteFiles2.stderr);
  assert.deepEqual(remoteFiles2.stdout.trim().split(/\r?\n/).sort(), ['.gitignore', 'pi-sync.json', 'pi-sync.lock.json']);
});

test('push rejects unrelated ahead commits, including ones mixed with a removal commit', async (t) => {
  const { repo } = await pushFixture(t);
  const manifest = path.join(repo, 'pi-sync.json');
  await fs.writeFile(manifest, `${JSON.stringify({ schemaVersion: 1, resources: [], dependencies: [] }, null, 2)}\n`);
  gitAt(repo, ['rm', '--quiet', '-r', '--', 'resources/skills/hello']);
  gitAt(repo, ['add', '--', 'pi-sync.json']);
  gitAt(repo, ['commit', '-m', 'roll back skill']);
  await fs.writeFile(path.join(repo, 'notes.txt'), 'unrelated ahead commit\n');
  gitAt(repo, ['add', '--', 'notes.txt']);
  gitAt(repo, ['commit', '-m', 'unrelated note']);
  const before = gitAt(repo, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0];
  const rejected = run(['push', '--publish', '--repo', repo]);
  assert.equal(rejected.status, 1, rejected.stderr);
  const output = result(rejected);
  assert.equal(output.errorCode, 'PUSH_BLOCKED');
  assert.deepEqual(output.details.unrelatedPaths, ['notes.txt']);
  assert.equal(gitAt(repo, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0], before, 'remote unchanged');
  // The local removal commit and the unrelated file both remain local.
  assert.equal(gitAt(repo, ['rev-list', '--count', '@{upstream}..HEAD']), '2');
  assert.equal(await fs.readFile(path.join(repo, 'notes.txt'), 'utf8'), 'unrelated ahead commit\n');

  // Re-adding content under a removed source without re-declaring it is not a
  // publishable managed change.
  const sneaky = await pushFixture(t);
  await fs.writeFile(path.join(sneaky.repo, 'pi-sync.json'), `${JSON.stringify({ schemaVersion: 1, resources: [], dependencies: [] }, null, 2)}\n`);
  await fs.writeFile(path.join(sneaky.repo, 'resources', 'skills', 'hello', 'SKILL.md'), '# Sneaky re-add\n');
  const blocked = run(['push', '--publish', '--repo', sneaky.repo]);
  assert.equal(blocked.status, 1, blocked.stderr);
  assert.equal(result(blocked).errorCode, 'PUSH_BLOCKED');
  assert.deepEqual(result(blocked).details.unrelatedPaths, ['resources/skills/hello/SKILL.md']);
  assert.equal(gitAt(sneaky.repo, ['rev-parse', 'HEAD']), gitAt(sneaky.repo, ['rev-parse', '@{upstream}']), 'no commit was created');
  assert.equal(await fs.readFile(path.join(sneaky.repo, 'resources', 'skills', 'hello', 'SKILL.md'), 'utf8'), '# Sneaky re-add\n');
});

test('remove --uninstall uninstalls the dependency explicitly and reports failures without altering the repository change', async (t) => {
  const { root, repo, agentDir } = await extendedFixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const lockPath = path.join(repo, 'pi-sync.lock.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.dependencies = [{ type: 'npm', name: 'fixture-package' }];
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const pin = { type: 'npm', name: 'fixture-package', version: '1.0.0', releasedAt: '2020-01-01T00:00:00.000Z' };
  await fs.writeFile(lockPath, `${JSON.stringify({ schemaVersion: 1, packages: [pin] }, null, 2)}\n`);
  const pinsFile = path.join(agentDir, '.pi-sync', 'packages.json');
  const okPi = await fakePi(t);
  const okLog = path.join(root, 'pi-ok.log');
  const applied = run(['apply', '--approve', '--repo', repo, '--agent-dir', agentDir], { ...okPi, PI_CALL_LOG: okLog });
  assert.equal(applied.status, 0, applied.stderr);
  const pinsBefore = JSON.parse(await fs.readFile(pinsFile, 'utf8'));
  assert.equal(pinsBefore.packages['npm:fixture-package'], '1.0.0');

  const okLogBefore = await fs.readFile(okLog, 'utf8');
  const removed = run(['remove', '--repo', repo, '--agent-dir', agentDir, '--type', 'dependency', '--source', 'npm:fixture-package', '--uninstall'],
    { ...okPi, PI_CALL_LOG: okLog });
  assert.equal(removed.status, 0, `${removed.stderr}\n${removed.stdout}`);
  const output = result(removed);
  assert.equal(output.ok, true);
  assert.deepEqual(output.removed.dependency, { type: 'npm', name: 'fixture-package' });
  assert.deepEqual(output.uninstalled, { package: 'npm:fixture-package', spec: 'npm:fixture-package@1.0.0' });
  assert.equal(output.localInstallation, 'uninstalled');
  assert.deepEqual(await piCalls(okLog), [...okLogBefore.trim().split('\n').filter(Boolean), 'uninstall npm:fixture-package@1.0.0']);
  const pinsAfter = JSON.parse(await fs.readFile(pinsFile, 'utf8'));
  assert.equal(pinsAfter.packages['npm:fixture-package'], undefined, 'local pin bookkeeping cleared after successful uninstall');
  // The repository change is complete and persisted.
  assert.deepEqual(JSON.parse(await fs.readFile(manifestPath, 'utf8')).dependencies, []);
  assert.deepEqual(JSON.parse(await fs.readFile(lockPath, 'utf8')).packages, []);

  // A failed uninstall is reported without rolling back or altering the
  // repository change: re-declare the dependency, reinstall it, then remove
  // with a failing Pi.
  const manifest2 = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest2.dependencies = [{ type: 'npm', name: 'fixture-package' }];
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest2, null, 2)}\n`);
  await fs.writeFile(lockPath, `${JSON.stringify({ schemaVersion: 1, packages: [pin] }, null, 2)}\n`);
  const reinstalled = run(['apply', '--approve', '--repo', repo, '--agent-dir', agentDir], { ...okPi, PI_CALL_LOG: okLog });  assert.equal(reinstalled.status, 0, reinstalled.stderr);
  const failPi = await fakePi(t, { fail: true });
  const failLog = path.join(root, 'pi-fail.log');
  await fs.writeFile(failLog, '');
  const failed = run(['remove', '--repo', repo, '--agent-dir', agentDir, '--type', 'dependency', '--source', 'npm:fixture-package', '--uninstall'],
    { ...failPi, PI_CALL_LOG: failLog });
  assert.equal(failed.status, 1, failed.stderr);
  const failure = result(failed);
  assert.equal(failure.ok, false);
  assert.equal(failure.exitCode, 1);
  assert.equal(failure.errorCode, 'UNINSTALL_FAILED');
  assert.match(failure.error, /pi uninstall failed for npm:fixture-package@1\.0\.0/);
  assert.equal(failure.uninstall.status, 'failed');
  assert.equal(await fs.readFile(failLog, 'utf8'), 'uninstall npm:fixture-package@1.0.0\n');
  assert.deepEqual(JSON.parse(await fs.readFile(manifestPath, 'utf8')).dependencies, [], 'manifest change persisted despite the uninstall failure');
  assert.deepEqual(JSON.parse(await fs.readFile(lockPath, 'utf8')).packages, [], 'lockfile change persisted despite the uninstall failure');
  const pinsStill = JSON.parse(await fs.readFile(pinsFile, 'utf8'));
  assert.equal(pinsStill.packages['npm:fixture-package'], '1.0.0', 'local pin bookkeeping is untouched when the uninstall fails');
});

test('the full remove, stale, and prune sequence works end to end after publication', async (t) => {
  const { repo, bare, root } = await pushFixture(t);
  const agentDir = path.join(root, 'agent');
  const applied = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(applied.status, 0, applied.stderr);
  const manifestPath = path.join(repo, 'pi-sync.json');

  const removed = run(['remove', '--repo', repo, '--agent-dir', agentDir, '--type', 'skill', '--target', 'skills/hello']);
  assert.equal(removed.status, 0, removed.stderr);
  const published = run(['push', '--publish', '--repo', repo]);
  assert.equal(published.status, 0, published.stderr);
  assert.equal(result(published).mode, 'published');
  const remoteFiles = spawnSync('git', ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' });
  assert.deepEqual(remoteFiles.stdout.trim().split(/\r?\n/).sort(), ['.gitignore', 'pi-sync.json', 'pi-sync.lock.json']);

  // status/plan/apply report the removed resource as stale; apply never deletes it.
  for (const command of ['status', 'plan', 'apply']) {
    const response = run([command, '--repo', repo, '--agent-dir', agentDir]);
    assert.equal(response.status, 0, `${command}: ${response.stderr}`);
    const output = result(response);
    assert.deepEqual(output.staleResources, [{ target: 'skills/hello', state: 'unchanged', installed: true, pruneAvailable: true }]);
  }
  assert.equal(await fs.readFile(path.join(agentDir, 'skills', 'hello', 'SKILL.md'), 'utf8'), '# Hello\n');

  // Re-declaring the resource stops stale reporting.
  await fs.mkdir(path.join(repo, 'resources', 'skills', 'hello'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), '# Hello\n');
  const redeclared = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  redeclared.resources = [{ type: 'skill', source: 'resources/skills/hello', target: 'skills/hello' }];
  await fs.writeFile(manifestPath, `${JSON.stringify(redeclared, null, 2)}\n`);
  const replanned = run(['plan', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(replanned.status, 0, replanned.stderr);
  assert.deepEqual(result(replanned).staleResources, []);
  // Remove it again for the explicit local removal.
  const removedAgain = run(['remove', '--repo', repo, '--agent-dir', agentDir, '--type', 'skill', '--target', 'skills/hello']);
  assert.equal(removedAgain.status, 0, removedAgain.stderr);

  // Prune preview does not delete; confirmed prune removes with a backup and
  // clears the local state entry.
  const preview = run(['prune', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.deepEqual(result(preview).staleResources, [{ target: 'skills/hello', action: 'would-prune', installed: true }]);
  await fs.access(path.join(agentDir, 'skills', 'hello', 'SKILL.md'));
  const pruned = run(['prune', '--confirm', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(pruned.status, 0, pruned.stderr);
  assert.deepEqual(result(pruned).staleResources, [{ target: 'skills/hello', action: 'pruned', installed: false }]);
  await assert.rejects(fs.access(path.join(agentDir, 'skills', 'hello')));
  const backupRoot = path.join(agentDir, '.pi-sync', 'backups');
  const backupStamp = (await fs.readdir(backupRoot)).at(-1);
  assert.equal(await fs.readFile(path.join(backupRoot, backupStamp, 'skills', 'hello', 'SKILL.md'), 'utf8'), '# Hello\n');
  const state = JSON.parse(await fs.readFile(path.join(agentDir, '.pi-sync', 'state.json'), 'utf8'));
  assert.equal(Object.hasOwn(state.resources, 'skills/hello'), false);
});

test('a tracked file target replaced by a same-content same-mode directory reports the kind mismatch without a repository change', async (t) => {
  const { repo, agentDir } = await extendedFixture(t);
  const added = run(['add', '--type', 'prompt', '--source', 'prompts/deploy.md', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(added.status, 0, added.stderr);
  const first = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(first.status, 0, first.stderr);
  const target = path.join(agentDir, 'prompts', 'deploy.md');
  const statePath = path.join(agentDir, '.pi-sync', 'state.json');
  const baselineState = await fs.readFile(statePath, 'utf8');
  const baselineFile = JSON.parse(baselineState).resources['prompts/deploy.md'].files['deploy.md'];

  // Replace the tracked file with a directory holding the baseline content and
  // mode; the repository is deliberately left unchanged.
  await fs.rm(target);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'deploy.md'), '# Deploy prompt\n');
  await fs.chmod(path.join(target, 'deploy.md'), baselineFile.mode);

  const planned = run(['plan', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(planned.status, 1, planned.stderr);
  const plannedAction = result(planned).actions[0];
  assert.equal(plannedAction.action, 'conflict');
  assert.match(plannedAction.reason, /changed type/);

  const applied = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(applied.status, 1, applied.stderr);
  const appliedAction = result(applied).actions[0];
  assert.equal(appliedAction.action, 'conflict');
  assert.match(appliedAction.reason, /changed type/);
  assert.equal((await fs.lstat(target)).isDirectory(), true);
  assert.equal(await fs.readFile(path.join(target, 'deploy.md'), 'utf8'), '# Deploy prompt\n');
  assert.equal(await fs.readFile(statePath, 'utf8'), baselineState);

  // Restoring the file clears the conflict immediately, still without a
  // repository change.
  await fs.rm(target, { recursive: true });
  await fs.writeFile(target, '# Deploy prompt\n');
  await fs.chmod(target, baselineFile.mode);
  const recovered = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(result(recovered).actions[0].action, 'unchanged');
});

test('a tracked extension directory replaced by a same-content same-mode file reports the kind mismatch without a repository change', async (t) => {
  const { repo, agentDir } = await extendedFixture(t);
  const sourceDir = path.join(agentDir, 'extensions', 'tool');
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'tool'), 'export const tool = 1;\n');
  const added = run(['add', '--type', 'extension', '--source', 'extensions/tool', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(added.status, 0, added.stderr);
  const first = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(first.status, 0, first.stderr);
  const target = path.join(agentDir, 'extensions', 'tool');
  const statePath = path.join(agentDir, '.pi-sync', 'state.json');
  const baselineState = await fs.readFile(statePath, 'utf8');
  const baselineFile = JSON.parse(baselineState).resources['extensions/tool'].files['tool'];

  // Replace the tracked directory with a single file holding the baseline
  // content and mode; the repository is deliberately left unchanged.
  await fs.rm(target, { recursive: true });
  await fs.writeFile(target, Buffer.from(baselineFile.content, 'base64'));
  await fs.chmod(target, baselineFile.mode);

  const planned = run(['plan', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(planned.status, 1, planned.stderr);
  const plannedAction = result(planned).actions[0];
  assert.equal(plannedAction.action, 'conflict');
  assert.match(plannedAction.reason, /changed type/);

  const applied = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(applied.status, 1, applied.stderr);
  const appliedAction = result(applied).actions[0];
  assert.equal(appliedAction.action, 'conflict');
  assert.match(appliedAction.reason, /changed type/);
  assert.equal((await fs.lstat(target)).isFile(), true);
  assert.equal(await fs.readFile(target, 'utf8'), 'export const tool = 1;\n');
  assert.equal(await fs.readFile(statePath, 'utf8'), baselineState);

  // Restoring the directory clears the conflict immediately.
  await fs.rm(target);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'tool'), 'export const tool = 1;\n');
  await fs.chmod(path.join(target, 'tool'), baselineFile.mode);
  const recovered = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(result(recovered).actions[0].action, 'unchanged');
});

test('remove of a declared dependency without a lock pin reports the structured not-pinned error', async (t) => {
  const { repo, agentDir } = await extendedFixture(t);
  const skillDir = path.join(agentDir, 'skills', 'hello');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Hello\n');
  assert.equal(run(['add', '--type', 'skill', '--source', 'skills/hello', '--repo', repo, '--agent-dir', agentDir]).status, 0);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const lockPath = path.join(repo, 'pi-sync.lock.json');
  // Declare the dependency without a lock pin: the repository no longer
  // validates strictly, but remove must surface the specific error.
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.dependencies = [{ type: 'npm', name: 'fixture-package' }];
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const manifestBefore = await fs.readFile(manifestPath, 'utf8');
  const lockBefore = await fs.readFile(lockPath, 'utf8');
  const contentBefore = await fs.readFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), 'utf8');

  const response = run(['remove', '--repo', repo, '--agent-dir', agentDir, '--type', 'dependency', '--source', 'npm:fixture-package']);
  assert.equal(response.status, 2, response.stderr);
  const output = result(response);
  assert.equal(output.ok, false);
  assert.equal(output.exitCode, 2);
  assert.equal(output.errorCode, 'REMOVE_DEPENDENCY_NOT_PINNED');
  assert.match(output.error, /no exact pin in the lockfile/);
  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestBefore);
  assert.equal(await fs.readFile(lockPath, 'utf8'), lockBefore);

  // Resource removal in the same repository keeps its strict repository
  // validation and still fails with the generic validation error.
  const resourceRemove = run(['remove', '--repo', repo, '--agent-dir', agentDir, '--type', 'skill', '--target', 'skills/hello']);
  assert.equal(resourceRemove.status, 2, resourceRemove.stderr);
  assert.equal(result(resourceRemove).errorCode, 'VALIDATION_ERROR');
  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestBefore);
  assert.equal(await fs.readFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), 'utf8'), contentBefore);
});

test('remove --uninstall with a corrupted local pin file fails before any side effect', async (t) => {
  const { root, repo, agentDir } = await extendedFixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const lockPath = path.join(repo, 'pi-sync.lock.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.dependencies = [{ type: 'npm', name: 'fixture-package' }];
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const pin = { type: 'npm', name: 'fixture-package', version: '1.0.0', releasedAt: '2020-01-01T00:00:00.000Z' };
  await fs.writeFile(lockPath, `${JSON.stringify({ schemaVersion: 1, packages: [pin] }, null, 2)}\n`);
  const pinsFile = path.join(agentDir, '.pi-sync', 'packages.json');
  const okPi = await fakePi(t);
  const log = path.join(root, 'pi-calls.log');
  const applied = run(['apply', '--approve', '--repo', repo, '--agent-dir', agentDir], { ...okPi, PI_CALL_LOG: log });
  assert.equal(applied.status, 0, applied.stderr);

  // Corrupt the local pin bookkeeping after a successful install.
  await fs.writeFile(pinsFile, '{ corrupted\n');
  const manifestBefore = await fs.readFile(manifestPath, 'utf8');
  const lockBefore = await fs.readFile(lockPath, 'utf8');
  const pinsBefore = await fs.readFile(pinsFile, 'utf8');

  const response = run(['remove', '--repo', repo, '--agent-dir', agentDir, '--type', 'dependency', '--source', 'npm:fixture-package', '--uninstall'],
    { ...okPi, PI_CALL_LOG: log });
  assert.equal(response.status, 2, response.stderr);
  const output = result(response);
  assert.equal(output.ok, false);
  assert.equal(output.exitCode, 2);
  assert.equal(output.errorCode, 'VALIDATION_ERROR');
  assert.match(output.error, /local package pin state/);
  // No side effects: the repository is unchanged, the pin file is untouched,
  // and nothing was uninstalled.
  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestBefore);
  assert.equal(await fs.readFile(lockPath, 'utf8'), lockBefore);
  assert.equal(await fs.readFile(pinsFile, 'utf8'), pinsBefore);
  assert.deepEqual((await piCalls(log)).filter((call) => call.startsWith('uninstall')), []);

  // A valid pin file keeps the successful uninstall flow working.
  await fs.writeFile(pinsFile, `${JSON.stringify({ schemaVersion: 1, packages: { 'npm:fixture-package': '1.0.0' } }, null, 2)}\n`);
  const retried = run(['remove', '--repo', repo, '--agent-dir', agentDir, '--type', 'dependency', '--source', 'npm:fixture-package', '--uninstall'],
    { ...okPi, PI_CALL_LOG: log });
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(result(retried).localInstallation, 'uninstalled');
  assert.deepEqual((await piCalls(log)).filter((call) => call.startsWith('uninstall')), ['uninstall npm:fixture-package@1.0.0']);
  const pinsAfter = JSON.parse(await fs.readFile(pinsFile, 'utf8'));
  assert.equal(pinsAfter.packages['npm:fixture-package'], undefined, 'local pin bookkeeping cleared after successful uninstall');
});

test('remove restores the manifest atomically when the content deletion fails', async (t) => {
  const { repo, agentDir } = await extendedFixture(t);
  const added = run(['add', '--type', 'prompt', '--source', 'prompts/deploy.md', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(added.status, 0, added.stderr);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const lockPath = path.join(repo, 'pi-sync.lock.json');
  const manifestBefore = await fs.readFile(manifestPath, 'utf8');
  const lockBefore = await fs.readFile(lockPath, 'utf8');
  const contentBefore = await fs.readFile(path.join(repo, 'resources', 'prompts', 'deploy.md'), 'utf8');

  // Make the managed content undeletable so the remove fails after the
  // manifest rewrite and exercises the rollback path.
  const sourceParent = path.join(repo, 'resources', 'prompts');
  await fs.chmod(sourceParent, 0o500);
  let response;
  try {
    response = run(['remove', '--repo', repo, '--agent-dir', agentDir, '--type', 'prompt', '--target', 'prompts/deploy.md']);
  } finally {
    await fs.chmod(sourceParent, 0o755);
  }
  assert.equal(response.status, 2, response.stderr);
  const output = result(response);
  assert.equal(output.ok, false);
  assert.equal(output.errorCode, 'VALIDATION_ERROR');
  assert.match(output.error, /Could not remove managed resource content/);
  // The repository is restored byte-for-byte and no temporary files remain.
  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestBefore, 'manifest restored byte-for-byte');
  assert.equal(await fs.readFile(lockPath, 'utf8'), lockBefore);
  assert.equal(await fs.readFile(path.join(repo, 'resources', 'prompts', 'deploy.md'), 'utf8'), contentBefore);
  assert.deepEqual((await fs.readdir(repo)).filter((name) => name.includes('.tmp')), []);
});

test('push rejects an ahead commit that leaves the repository in an invalid state even when a later commit repairs it', async (t) => {
  const { repo } = await pushFixture(t);
  // The first ahead commit deletes the managed content but leaves the manifest
  // declaring it, so the repository state at that commit is invalid (the
  // declared source is missing from the tree).
  gitAt(repo, ['rm', '--quiet', '-r', '--', 'resources/skills/hello']);
  gitAt(repo, ['commit', '-m', 'delete content without updating the manifest']);
  // The second ahead commit restores the content; HEAD itself is a valid
  // repository state, so only the per-commit validation catches the chain.
  await fs.mkdir(path.join(repo, 'resources', 'skills', 'hello'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), '# Restored\n');
  gitAt(repo, ['add', '--', 'resources/skills/hello']);
  gitAt(repo, ['commit', '-m', 'restore the content']);

  const remoteBefore = gitAt(repo, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0];
  const rejected = run(['push', '--publish', '--repo', repo]);
  assert.equal(rejected.status, 1, rejected.stderr);
  const output = result(rejected);
  assert.equal(output.errorCode, 'PUSH_BLOCKED');
  assert.match(output.error, /missing from that commit/);
  assert.equal(output.details.commit, gitAt(repo, ['rev-parse', 'HEAD~1']), 'the broken intermediate commit is reported');
  assert.equal(gitAt(repo, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0], remoteBefore, 'remote unchanged');
  assert.equal(gitAt(repo, ['rev-list', '--count', '@{upstream}..HEAD']), '2', 'local commits preserved');

  // Repair the broken intermediate commit in place (the final commit's content
  // makes the manifest state valid) and push again: the repaired chain must
  // now be accepted, proving the repair-commit half of the requirement rather
  // than only the rejection.
  // reset --soft keeps the index at the final (repaired) tree, so amending
  // the broken commit rewrites it with the valid content.
  gitAt(repo, ['reset', '--soft', 'HEAD~1']);
  gitAt(repo, ['commit', '--amend', '--no-edit']);
  const republished = run(['push', '--publish', '--repo', repo]);
  assert.equal(republished.status, 0, republished.stderr);
  assert.equal(result(republished).ok, true);
  assert.equal(gitAt(repo, ['rev-list', '--count', '@{upstream}..HEAD']), '0', 'repaired commits published');
  assert.equal(gitAt(repo, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0], gitAt(repo, ['rev-parse', 'HEAD']), 'remote advanced to local HEAD');
});

test('push publishes a valid ahead commit that edits a directory resource source', async (t) => {
  const { repo } = await pushFixture(t);
  // A single ahead commit that edits the skill (a directory-shaped resource
  // source) is a fully valid repository state and must publish.
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), '# Hello v2\n');
  gitAt(repo, ['add', '--', 'resources/skills/hello']);
  gitAt(repo, ['commit', '-m', 'edit the skill']);

  const response = run(['push', '--publish', '--repo', repo]);
  assert.equal(response.status, 0, response.stderr);
  assert.equal(result(response).ok, true);
  assert.equal(gitAt(repo, ['rev-list', '--count', '@{upstream}..HEAD']), '0');
  assert.equal(gitAt(repo, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0], gitAt(repo, ['rev-parse', 'HEAD']), 'remote advanced to local HEAD');
})
