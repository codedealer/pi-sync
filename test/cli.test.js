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

test('bootstrap fetches a private setup fixture, declares the bundled skill, and installs it through apply', async (t) => {
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
  assert.deepEqual(output.skill, { source: 'resources/skills/pi-sync', target: 'skills/pi-sync', action: 'declared-and-applied' });
  const manifest = JSON.parse(await fs.readFile(path.join(setupDir, 'pi-sync.json'), 'utf8'));
  assert.ok(manifest.resources.some((item) => item.type === 'skill' && item.source === 'resources/skills/pi-sync' && item.target === 'skills/pi-sync'));
  assert.equal(await fs.readFile(path.join(agentDir, 'skills', 'pi-sync', 'SKILL.md'), 'utf8'),
    await fs.readFile(new URL('../resources/skills/pi-sync/SKILL.md', import.meta.url), 'utf8'));
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

test('public npm package allowlist includes the CLI and skill but excludes tests and scratch data', async () => {
  const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(packageJson.files, ['README.md', 'src/cli.js', 'src/packages.js', 'src/prerequisites.js', 'resources/skills/pi-sync/SKILL.md']);
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8', cwd: path.dirname(fileURLToPath(new URL('../package.json', import.meta.url))) });
  assert.equal(packed.status, 0, packed.stderr);
  const files = JSON.parse(packed.stdout)[0].files.map((item) => item.path);
  assert.ok(files.includes('src/cli.js'));
  assert.ok(files.includes('src/prerequisites.js'));
  assert.ok(files.includes('src/packages.js'));
  assert.ok(files.includes('resources/skills/pi-sync/SKILL.md'));
  assert.ok(!files.some((item) => /^(?:test(?:\/|$)|test-support(?:\/|$)|\.scratch(?:\/|$)|resources\/skills\/(?!pi-sync\/))/.test(item)));
  assert.deepEqual(files.sort(), ['README.md', 'package.json', 'resources/skills/pi-sync/SKILL.md', 'src/cli.js', 'src/packages.js', 'src/prerequisites.js']);
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
  const pruned = run(['prune', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(pruned.status, 0, pruned.stderr);
  responses.push(result(pruned));

  for (const response of responses) {
    assert.equal(response.apiVersion, 1);
    assert.equal(response.ok, true);
    assert.equal(response.exitCode, 0);
    assert.ok(['status', 'plan', 'apply', 'add', 'prune'].includes(response.command));
  }

  const skill = await fs.readFile(new URL('../resources/skills/pi-sync/SKILL.md', import.meta.url), 'utf8');
  const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(packageJson.files.includes('resources/skills/pi-sync/SKILL.md'));
  for (const workflow of ['pi-sync status', 'pi-sync plan', 'pi-sync apply', 'pi-sync add', 'pi-sync prune', 'pi-sync prune --confirm']) {
    assert.ok(skill.includes(workflow), `skill documents ${workflow}`);
  }
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
    resources: [{ type: 'extension', source: 'resources/skills/hello', target: 'skills/hello' }],
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
  const unsupported = run(['add', '--type', 'extension', '--source', 'skills/local-only', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(unsupported.status, 2);
  assert.match(result(unsupported).error, /Unsupported resource type/);

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
