import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { createPrerequisiteInspector, extractGitHubCliBinary, githubCliReleaseAsset, inspectRequiredTools } from '../dist/prerequisites.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

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

function runRawWith(entry, args, env = {}, options = {}) {
  return spawnSync(process.execPath, [entry, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    ...options,
  });
}

function runWith(entry, args, env = {}, options = {}) {
  const jsonArgs = args.includes('--json') ? args : [...args, '--json'];
  return spawnSync(process.execPath, [entry, ...jsonArgs], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    ...options,
  });
}

function run(args, env = {}, options = {}) {
  return runWith(cli, args, env, options);
}


// Environment for the --repo default-resolution tests: the inherited
// environment is scrubbed of PI_SYNC_REPO_DIR and PI_CODING_AGENT_DIR so an
// outer developer environment cannot shadow the behavior under test.
function repoDefaultEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.PI_SYNC_REPO_DIR;
  delete env.PI_CODING_AGENT_DIR;
  return { ...env, ...overrides };
}

// A minimal valid setup repository with a single uniquely named skill so a
// test can tell which repository a command actually operated on.
async function writeRepo(repo, skillName) {
  await fs.mkdir(path.join(repo, 'resources', 'skills', skillName), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'skills', skillName, 'SKILL.md'), '# ' + skillName + '\n');
  await fs.writeFile(path.join(repo, 'pi-sync.json'), JSON.stringify({
    schemaVersion: 1,
    resources: [{ type: 'skill', source: 'resources/skills/' + skillName, target: 'skills/' + skillName }],
    dependencies: [],
  }));
  await fs.writeFile(path.join(repo, 'pi-sync.lock.json'), JSON.stringify({ schemaVersion: 1, packages: [] }));
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

// A temporary copy of the built package (CLI plus the bundled resources and
// package.json) so a test can execute a different bundle version as if that
// package were installed. Only the fixture's own bundled content and version
// differ from the built CLI under test.
async function packageFixture(t, root, { version, mutate, name = 'package-fixture' } = {}) {
  const projectRoot = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
  const fixture = path.join(root, name);
  await fs.cp(path.join(projectRoot, 'dist'), path.join(fixture, 'dist'), { recursive: true });
  await fs.cp(path.join(projectRoot, 'resources', 'skills', 'pi-sync'), path.join(fixture, 'resources', 'skills', 'pi-sync'), { recursive: true });
  await fs.cp(path.join(projectRoot, 'resources', 'extensions', 'pi-sync'), path.join(fixture, 'resources', 'extensions', 'pi-sync'), { recursive: true });
  const pkg = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  if (version) pkg.version = version;
  await fs.writeFile(path.join(fixture, 'package.json'), JSON.stringify(pkg, null, 2));
  if (mutate) await mutate(fixture);
  return { cli: path.join(fixture, 'dist', 'cli.js'), fixture };
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
    const jsonArgs = args.includes('--json') ? args : [...args, '--json'];
    const child = spawn(process.execPath, [cli, ...jsonArgs], { encoding: 'utf8', env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('bootstrap --dry-run stages a full preview without creating the setup checkout or local installation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-bootstrap-dry-run-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRepo = await bootstrapRepo(t, root);
  const fakeTools = await fakeGitHubTools(t, sourceRepo);
  const setupDir = path.join(root, 'setup');
  const agentDir = path.join(root, 'agent');
  const response = runRawWith(cli, ['bootstrap', '--dry-run', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo', setupDir, '--agent-dir', agentDir, '--json'], {
    ...fakeTools, FAKE_GIT_ACCESS: 'yes',
  });
  assert.equal(response.status, 0, `${response.stderr}\n${response.stdout}`);
  const output = JSON.parse(response.stdout);
  assert.equal(output.mode, 'preview');
  assert.equal(output.plan.command, 'status');
  await assert.rejects(fs.access(setupDir));
  await assert.rejects(fs.access(agentDir));
});

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

  const bootstrapped = run(['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo', setupDir, '--agent-dir', agentDir], {
    ...fakeTools, FAKE_GIT_ACCESS: 'yes',
  });
  assert.equal(bootstrapped.status, 0, `${bootstrapped.stderr}\n${bootstrapped.stdout}`);
  const output = result(bootstrapped);
  assert.equal(output.ok, true);
  assert.equal(output.authenticationMethod, 'git');
  assert.equal(output.packageVersion, JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
  assert.deepEqual(output.bundledResources, [
    { type: 'skill', source: 'resources/skills/pi-sync', target: 'skills/pi-sync', action: 'declared' },
    { type: 'extension', source: 'resources/extensions/pi-sync', target: 'extensions/pi-sync', action: 'declared' },
  ]);
  const manifest = JSON.parse(await fs.readFile(path.join(setupDir, 'pi-sync.json'), 'utf8'));
  assert.ok(manifest.resources.some((item) => item.type === 'skill' && item.source === 'resources/skills/pi-sync' && item.target === 'skills/pi-sync'));
  assert.ok(manifest.resources.some((item) => item.type === 'extension' && item.source === 'resources/extensions/pi-sync' && item.target === 'extensions/pi-sync'));
  assert.deepEqual(output.repositoryPolicy, { file: '.gitattributes', action: 'created' });
  assert.equal(await fs.readFile(path.join(setupDir, '.gitattributes'), 'utf8'), '* text=auto eol=lf\n');
  assert.equal(await fs.readFile(path.join(agentDir, 'skills', 'pi-sync', 'SKILL.md'), 'utf8'),
    await fs.readFile(new URL('../resources/skills/pi-sync/SKILL.md', import.meta.url), 'utf8'));
  assert.equal(await fs.readFile(path.join(agentDir, 'extensions', 'pi-sync', 'index.ts'), 'utf8'),
    await fs.readFile(new URL('../resources/extensions/pi-sync/index.ts', import.meta.url), 'utf8'));
  assert.equal(await fs.readFile(unrelated, 'utf8'), '# Keep local\n');
  const state = await fs.readFile(path.join(agentDir, '.pi-sync', 'state.json'), 'utf8').then(JSON.parse);
  assert.ok(state.resources['skills/pi-sync'], 'the bundled skill is installed and tracked by normal apply state');
});

test('bootstrap writes the missing EOL policy file, reports a matching one as current, and never overwrites divergent content', async (t) => {
  const policy = '* text=auto eol=lf\n';
  const scenarios = [
    { label: 'missing', content: null, expected: 'created' },
    { label: 'matching', content: policy, expected: 'current' },
    { label: 'divergent', content: '* text=auto\n', expected: 'divergent' },
  ];
  for (const scenario of scenarios) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `pi-sync-bootstrap-policy-${scenario.label}-`));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const sourceRepo = await bootstrapRepo(t, root);
    if (scenario.content !== null) await fs.writeFile(path.join(sourceRepo, '.gitattributes'), scenario.content);
    const fakeTools = await fakeGitHubTools(t, sourceRepo);
    const setupDir = path.join(root, 'private-checkout');
    const response = run(['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo', setupDir, '--agent-dir', path.join(root, 'agent')], {
      ...fakeTools, FAKE_GIT_ACCESS: 'yes',
    });
    assert.equal(response.status, 0, `${response.stderr}\n${response.stdout}`);
    const output = result(response);
    assert.deepEqual(output.repositoryPolicy, { file: '.gitattributes', action: scenario.expected }, scenario.label);
    assert.equal(await fs.readFile(path.join(setupDir, '.gitattributes'), 'utf8'), scenario.expected === 'divergent' ? scenario.content : policy, scenario.label);
  }
});

test('bootstrap uses authenticated GitHub CLI as a fetch fallback without exposing credentials', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-bootstrap-gh-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRepo = await bootstrapRepo(t, root);
  const fakeTools = await fakeGitHubTools(t, sourceRepo);
  const setupDir = path.join(root, 'private-checkout');
  const response = run(['bootstrap', '--repo-url', 'git@github.com:acme/private-setup.git', '--repo', setupDir, '--agent-dir', path.join(root, 'agent')], {
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
  const response = run(['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo', setupDir, '--agent-dir', agentDir, '--bin-dir', binDir], {
    ...fakeTools, FAKE_GIT_ACCESS: 'no', FAKE_GH_AUTH: 'no',
  });
  assert.equal(response.status, 1);
  const output = result(response);
  assert.equal(output.errorCode, 'AUTH_REQUIRED');
  assert.deepEqual(output.authentication, { required: true, cliAvailable: true, command: 'gh auth login --hostname github.com', commandArgs: ['gh', 'auth', 'login', '--hostname', 'github.com'], credentialHandling: 'Pi Sync does not request, print, or store credentials' });
  assert.deepEqual(output.resumeArgs, ['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo', setupDir, '--agent-dir', agentDir, '--bin-dir', binDir]);
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
  const response = run(['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo', setupDir, '--agent-dir', agentDir], {
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
  const response = run(['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo', setupDir, '--agent-dir', agentDir], {
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
  assert.deepEqual(packageJson.files, ['README.md', 'dist', 'src', 'resources/skills/pi-sync/SKILL.md', 'resources/extensions/pi-sync/guard.ts', 'resources/extensions/pi-sync/index.ts', 'resources/extensions/pi-sync/status.js', 'resources/extensions/pi-sync/process.js', 'resources/extensions/pi-sync/README.md']);
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8', cwd: path.dirname(fileURLToPath(new URL('../package.json', import.meta.url))) });
  assert.equal(packed.status, 0, packed.stderr);
  const files = JSON.parse(packed.stdout)[0].files.map((item) => item.path);
  assert.ok(files.includes('dist/cli.js'));
  assert.ok(files.includes('dist/prerequisites.js'));
  assert.ok(files.includes('dist/packages.js'));
  assert.ok(files.includes('src/cli.ts'));
  assert.ok(files.includes('src/cli/README.md'));
  assert.ok(files.includes('src/packages.ts'));
  assert.ok(files.includes('src/prerequisites.ts'));
  assert.ok(files.includes('dist/cli/arguments.js'));
  assert.ok(files.includes('dist/cli/manifest.js'));
  assert.ok(files.includes('dist/cli/process.js'));
  assert.ok(files.includes('dist/cli/reconciliation.js'));
  assert.ok(files.includes('dist/cli/commands/inspect.js'));
  assert.ok(files.includes('dist/cli/commands/pi-update.js'));
  assert.ok(files.includes('dist/cli/local-state.js'));
  assert.ok(files.includes('dist/cli/resource-operations.js'));
  assert.ok(files.includes('dist/cli/commands/apply.js'));
  assert.ok(files.includes('dist/cli/commands/sync.js'));
  assert.ok(files.includes('dist/cli/commands/bootstrap.js'));
  assert.ok(files.includes('dist/cli/commands/push.js'));
  assert.ok(files.includes('dist/cli/commands/pull.js'));
  assert.ok(files.includes('dist/cli/commands/resources.js'));
  assert.ok(files.includes('dist/cli/commands/update.js'));
  assert.ok(files.includes('src/cli/arguments.ts'));
  assert.ok(files.includes('src/cli/commands/inspect.ts'));
  assert.ok(files.includes('src/cli/commands/pi-update.ts'));
  assert.ok(files.includes('src/cli/local-state.ts'));
  assert.ok(files.includes('src/cli/process.ts'));
  assert.ok(files.includes('src/cli/resource-operations.ts'));
  assert.ok(files.includes('src/cli/commands/apply.ts'));
  assert.ok(files.includes('src/cli/commands/sync.ts'));
  assert.ok(files.includes('src/cli/commands/resources.ts'));
  assert.ok(files.includes('src/cli/commands/push.ts'));
  assert.ok(files.includes('src/cli/commands/update.ts'));
  assert.ok(files.includes('resources/skills/pi-sync/SKILL.md'));
  assert.ok(files.includes('resources/extensions/pi-sync/guard.ts'));
  assert.ok(files.includes('resources/extensions/pi-sync/index.ts'));
  assert.ok(files.includes('resources/extensions/pi-sync/status.js'));
  assert.ok(files.includes('resources/extensions/pi-sync/process.js'));
  assert.ok(!files.some((item) => /^(?:test(?:\/|$)|test-support(?:\/|$)|\.scratch(?:\/|$)|resources\/skills\/(?!pi-sync\/))/.test(item)));
  assert.deepEqual(files.sort(), ['LICENSE', 'README.md', 'dist/cli.js', 'dist/cli/arguments.js', 'dist/cli/commands/apply.js', 'dist/cli/commands/bootstrap.js', 'dist/cli/commands/inspect.js', 'dist/cli/commands/pi-update.js', 'dist/cli/commands/pull.js', 'dist/cli/commands/push.js', 'dist/cli/commands/resources.js', 'dist/cli/commands/sync.js', 'dist/cli/commands/update.js', 'dist/cli/local-state.js', 'dist/cli/manifest.js', 'dist/cli/process.js', 'dist/cli/reconciliation.js', 'dist/cli/resource-operations.js', 'dist/packages.js', 'dist/prerequisites.js', 'package.json', 'resources/extensions/pi-sync/README.md', 'resources/extensions/pi-sync/guard.ts', 'resources/extensions/pi-sync/index.ts', 'resources/extensions/pi-sync/process.js', 'resources/extensions/pi-sync/status.js', 'resources/skills/pi-sync/SKILL.md', 'src/cli.ts', 'src/cli/README.md', 'src/cli/arguments.ts', 'src/cli/commands/apply.ts', 'src/cli/commands/bootstrap.ts', 'src/cli/commands/inspect.ts', 'src/cli/commands/pi-update.ts', 'src/cli/commands/pull.ts', 'src/cli/commands/push.ts', 'src/cli/commands/resources.ts', 'src/cli/commands/sync.ts', 'src/cli/commands/update.ts', 'src/cli/local-state.ts', 'src/cli/manifest.ts', 'src/cli/process.ts', 'src/cli/reconciliation.ts', 'src/cli/resource-operations.ts', 'src/packages.ts', 'src/prerequisites.ts']);
});

test('CLI output tiers provide compact text by default and version-2 compact or legacy-pretty JSON', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const baseArgs = ['status', '--no-fetch', '--repo', repo, '--agent-dir', agentDir];
  const text = runRawWith(cli, baseArgs);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^ok\ncommand: status\n/);
  assert.match(text.stdout, /summary:/);
  assert.match(text.stdout, /localPending:/);
  assert.match(text.stdout, /actions: 1/);
  assert.match(text.stdout, /  - type: skill\n    target: skills\/hello/);
  assert.doesNotMatch(text.stdout, /"apiVersion"/);

  const compact = runRawWith(cli, [...baseArgs, '--json']);
  assert.equal(compact.status, 0, compact.stderr);
  assert.equal(compact.stdout.trim().split('\n').length, 1);
  const compactOutput = JSON.parse(compact.stdout);
  assert.equal(compactOutput.apiVersion, 2);
  assert.equal(compactOutput.command, 'status');
  const pretty = runRawWith(cli, [...baseArgs, '--json', '--pretty']);
  assert.equal(pretty.status, 0, pretty.stderr);
  assert.ok(pretty.stdout.includes('\n  "apiVersion": 2'));
  assert.deepEqual(JSON.parse(pretty.stdout), compactOutput);

  const invalidPretty = runRawWith(cli, ['--version', '--pretty']);
  assert.equal(invalidPretty.status, 2);
  assert.match(invalidPretty.stdout, /^error VALIDATION_ERROR\n/);
  // The error envelope derives the command from the leading --version flag.
  const invalidVersionJson = runRawWith(cli, ['--version', '--json', 'extra']);
  assert.equal(invalidVersionJson.status, 2);
  const invalidVersionOutput = JSON.parse(invalidVersionJson.stdout);
  assert.equal(invalidVersionOutput.ok, false);
  assert.equal(invalidVersionOutput.command, 'version');
  const invalidJson = runRawWith(cli, ['status', '--unknown-option', '--json']);
  assert.equal(invalidJson.status, 2);
  assert.equal(JSON.parse(invalidJson.stdout).apiVersion, 2);
});

test('condensed CLI rejects removed plan and legacy repository/type flags', () => {
  const removedPlan = runRawWith(cli, ['plan', '--json']);
  assert.equal(removedPlan.status, 2);
  assert.match(JSON.parse(removedPlan.stdout).error, /Usage: pi-sync/);
  for (const command of ['status', 'pull', 'apply', 'add', 'remove', 'bootstrap', 'update', 'push', 'pi-update', 'sync']) {
    for (const flags of [['--type', 'skill'], ['--repo-dir', '/tmp/setup']]) {
      const response = runRawWith(cli, [command, ...flags, '--json']);
      assert.equal(response.status, 2, `${command} ${flags[0]}: ${response.stdout}`);
      assert.match(JSON.parse(response.stdout).error, /Unknown option/);
    }
  }
});

test('register is rejected as an unknown command', () => {
  const response = runRawWith(cli, ['register', '--json']);
  assert.equal(response.status, 2);
  assert.match(JSON.parse(response.stdout).error, /Usage: pi-sync/);
});
test('prune is rejected as an unknown command', () => {
  const response = runRawWith(cli, ['prune', '--json']);
  assert.equal(response.status, 2);
  assert.match(JSON.parse(response.stdout).error, /Usage: pi-sync/);
  for (const extra of [['--confirm'], ['--dry-run']]) {
    const rejected = runRawWith(cli, ['prune', ...extra, '--json']);
    assert.equal(rejected.status, 2);
  }
});

test('remove requires exactly one selector and rejects flag combinations', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const base = ['--repo', repo, '--agent-dir', agentDir];
  const invalid = [
    ['remove', ...base],
    ['remove', '--target', 'skills/hello', '--source', 'npm:example', ...base],
    ['remove', '--stale', '--target', 'skills/hello', ...base],
    ['remove', '--stale', '--source', 'npm:example', ...base],
    ['remove', '--source', 'npm:example', '--keep-local', ...base],
    ['remove', '--stale', '--uninstall', ...base],
    ['remove', '--target', 'skills/hello', '--uninstall', ...base],
  ];
  for (const args of invalid) {
    const response = runRawWith(cli, [...args, '--json']);
    assert.equal(response.status, 2, `${args.join(' ')}: ${response.stdout}`);
    assert.equal(JSON.parse(response.stdout).ok, false);
  }
});

test('add and remove infer resource types from roots and dependency kind from source schemes', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const added = runRawWith(cli, ['add', '--target', 'skills/local-only', '--repo', repo, '--agent-dir', agentDir, '--json']);
  assert.equal(added.status, 0, added.stderr);
  assert.equal(JSON.parse(added.stdout).type, 'skill');
  const manifestPath = path.join(repo, 'pi-sync.json');
  let manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.ok(manifest.resources.some((item) => item.target === 'skills/local-only' && item.type === 'skill'));

  const rejectedSource = runRawWith(cli, ['add', '--source', 'skills/local-only', '--repo', repo, '--agent-dir', agentDir, '--json']);
  assert.equal(rejectedSource.status, 2);
  const rejectedTarget = runRawWith(cli, ['add', '--target', 'npm:example', '--repo', repo, '--agent-dir', agentDir, '--json']);
  assert.equal(rejectedTarget.status, 2);

  const removed = runRawWith(cli, ['remove', '--target', 'skills/local-only', '--repo', repo, '--agent-dir', agentDir, '--json']);
  assert.equal(removed.status, 0, removed.stderr);
  manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.ok(!manifest.resources.some((item) => item.target === 'skills/local-only'));

  const repositoryPrompt = path.join(repo, 'resources', 'prompts', 'deploy.md');
  await fs.mkdir(path.dirname(repositoryPrompt), { recursive: true });
  await fs.writeFile(repositoryPrompt, '# Deploy\n');
  const repositoryAdd = runRawWith(cli, ['add', '--target', 'prompts/deploy.md', '--repo', repo, '--json']);
  assert.equal(repositoryAdd.status, 0, repositoryAdd.stderr);
  assert.equal(JSON.parse(repositoryAdd.stdout).type, 'prompt');
  const dependency = runRawWith(cli, ['add', '--source', 'npm:example', '--repo', repo, '--json']);
  assert.equal(dependency.status, 0, dependency.stderr);
  assert.equal(JSON.parse(dependency.stdout).type, 'dependency');
});

test('retired action flags are rejected everywhere and unsupported dry-run invocations fail closed', () => {
  const commands = ['status', 'plan', 'pull', 'apply', 'add', 'remove', 'update', 'push', 'pi-update', 'bootstrap', 'sync'];
  for (const command of commands) {
    for (const flag of ['--apply', '--confirm', '--publish', '--approve']) {
      const response = runRawWith(cli, [command, flag, '--json']);
      assert.equal(response.status, 2, `${command} ${flag}: ${response.stdout}`);
    }
  }
  const updatePush = runRawWith(cli, ['update', '--push', '--json']);
  assert.equal(updatePush.status, 2);
  // No command accepts --push: push reports it as removed, not update-only.
  const pushPush = runRawWith(cli, ['push', '--push', '--json']);
  assert.equal(pushPush.status, 2);
  assert.match(JSON.parse(pushPush.stdout).error, /--push is no longer supported/);
  for (const command of ['status', 'add']) {
    const response = runRawWith(cli, [command, '--dry-run', '--json']);
    assert.equal(response.status, 2, `${command}: ${response.stdout}`);
  }
  const invalidVersion = runRawWith(cli, ['--version', '--dry-run', '--json']);
  assert.equal(invalidVersion.status, 2);
});

test('apply --dry-run returns the plan without creating local state or installing resources', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const manifestBefore = await fs.readFile(path.join(repo, 'pi-sync.json'));
  const preview = runRawWith(cli, ['apply', '--dry-run', '--json', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(preview.status, 0, preview.stderr);
  const output = JSON.parse(preview.stdout);
  assert.equal(output.command, 'status');
  assert.equal(output.actions[0].target, 'skills/hello');
  await assert.rejects(fs.access(path.join(agentDir, 'skills', 'hello')));
  await assert.rejects(fs.access(path.join(agentDir, '.pi-sync')));
  assert.deepEqual(await fs.readFile(path.join(repo, 'pi-sync.json')), manifestBefore);
});

test('supported agent commands share a versioned JSON response contract', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const responses = [];
  for (const command of ['status', 'apply']) {
    const processResult = run([command, '--repo', repo, '--agent-dir', agentDir]);
    assert.equal(processResult.status, 0, processResult.stderr);
    responses.push(result(processResult));
  }
  const added = run(['add', '--target', 'skills/local-only', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(added.status, 0, added.stderr);
  responses.push(result(added));
  const removed = run(['remove', '--target', 'skills/local-only', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(removed.status, 0, removed.stderr);
  responses.push(result(removed));
  const pruned = run(['remove', '--stale', '--dry-run', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(pruned.status, 0, pruned.stderr);
  responses.push(result(pruned));

  for (const response of responses) {
    assert.equal(response.apiVersion, 2);
    assert.equal(response.ok, true);
    assert.equal(response.exitCode, 0);
    assert.ok(['status', 'apply', 'add', 'remove'].includes(response.command));
  }
  const manifestAfterRemove = JSON.parse(await fs.readFile(path.join(repo, 'pi-sync.json'), 'utf8'));
  assert.equal(manifestAfterRemove.resources.some((item) => item.target === 'skills/local-only'), false);

  const skill = await fs.readFile(new URL('../resources/skills/pi-sync/SKILL.md', import.meta.url), 'utf8');
  const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(packageJson.files.includes('resources/skills/pi-sync/SKILL.md'));
  for (const workflow of ['pi-sync status', 'pi-sync apply', 'pi-sync add', 'pi-sync add --list', 'pi-sync add --all', 'pi-sync remove', 'pi-sync remove --stale', 'pi-sync remove --stale --dry-run']) {
    assert.ok(skill.includes(workflow), `skill documents ${workflow}`);
  }
});

test('--version reports the installed package name and version without touching repositories', async () => {
  const response = run(['--version']);
  assert.equal(response.status, 0, response.stderr);
  const output = result(response);
  assert.equal(output.apiVersion, 2);
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

  for (const command of ['status', 'apply']) {
    const processResult = run([command, '--repo', repo, '--agent-dir', agentDir]);
    assert.equal(processResult.status, 1, processResult.stderr);
    const output = result(processResult);
    assert.equal(output.apiVersion, 2);
    assert.equal(output.ok, false);
    assert.equal(output.exitCode, 1);
    assert.equal(output.conflicts[0].target, 'skills/hello');
    assert.equal(output.conflicts[0].action, 'collision');
  }
  assert.equal(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8'), '# Keep local\n');

  const invalid = run(['status', '--unknown-option']);
  assert.equal(invalid.status, 2);
  const output = result(invalid);
  assert.equal(output.apiVersion, 2);
  assert.equal(output.ok, false);
  assert.equal(output.errorCode, 'VALIDATION_ERROR');
  assert.equal(output.exitCode, 2);
  assert.equal(output.details.message, output.error);
});

test('status, apply and repeat apply through the real CLI subprocess; preserve unlisted resources', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const planned = run(['status', '--repo', repo, '--agent-dir', agentDir]);
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
  assert.deepEqual(result(second).actions, []);
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

  const rejected = run(['status', '--repo', repo, '--agent-dir', agentDir]);
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

test('fully unchanged multi-file resources are omitted from actions in status and apply', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const source = path.join(repo, 'resources', 'skills', 'hello');
  await fs.writeFile(path.join(source, 'a.md'), 'A baseline\n');
  await fs.writeFile(path.join(source, 'b.md'), 'B baseline\n');
  assert.equal(run(['apply', '--repo', repo, '--agent-dir', agentDir]).status, 0);
  for (const command of ['status', 'apply']) {
    const response = run([command, '--repo', repo, '--agent-dir', agentDir]);
    assert.equal(response.status, 0, `${command}: ${response.stderr}`);
    assert.equal(result(response).actions.some((item) => item.target === 'skills/hello'), false,
      `${command} omits a fully unchanged resource action`);
  }
});

test('changed reporting names only the affected files of a multi-file resource', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const source = path.join(repo, 'resources', 'skills', 'hello');
  await fs.writeFile(path.join(source, 'a.md'), 'A baseline\n');
  await fs.writeFile(path.join(source, 'b.md'), 'B baseline\n');
  assert.equal(run(['apply', '--repo', repo, '--agent-dir', agentDir]).status, 0);
  await fs.writeFile(path.join(source, 'a.md'), 'A repository edit\n');
  await fs.rm(path.join(source, 'b.md'));
  const expectedResourceAction = { status: 'update', plan: 'update', apply: 'updated' };
  for (const command of ['status', 'apply']) {
    const response = run([command, '--repo', repo, '--agent-dir', agentDir]);
    assert.equal(response.status, 0, `${command}: ${response.stderr}`);
    const action = result(response).actions.find((item) => item.target === 'skills/hello');
    assert.equal(action.action, expectedResourceAction[command]);
    // Exactly the edited and deleted files; the unchanged SKILL.md sibling
    // does not appear.
    assert.deepEqual(action.files.map((file) => [file.path, file.action]).sort(),
      [['a.md', 'update'], ['b.md', 'delete']]);
  }
});

test('status and apply omit unchanged settings fields and empty setting actions', async (t) => {
  const expectedAction = { status: 'update', plan: 'update', apply: 'updated' };
  for (const command of ['status', 'apply']) {
    const { repo, agentDir, manifestPath } = await settingsFixture(t, [
      { path: '/theme', value: 'dark' },
      { path: '/defaultProvider', value: 'github-copilot' },
    ]);
    const clean = run([command, '--repo', repo, '--agent-dir', agentDir]);
    assert.equal(clean.status, 0, `${command}: ${clean.stderr}`);
    assert.equal(result(clean).actions.some((item) => item.target === 'settings.json'), false,
      `${command} omits a fully unchanged settings action`);

    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.settings[0].fields[0].value = 'light';
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    const changed = run([command, '--repo', repo, '--agent-dir', agentDir]);
    assert.equal(changed.status, 0, `${command}: ${changed.stderr}`);
    const action = result(changed).actions.find((item) => item.target === 'settings.json');
    assert.equal(action.action, expectedAction[command]);
    assert.deepEqual(action.fields.map((field) => [field.path, field.action]), [['/theme', expectedAction[command]]],
      `${command} reports only the changed settings field`);
  }
});

test('apply reports package install results in the single packages array without packageInstalls', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const lockPath = path.join(repo, 'pi-sync.lock.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.dependencies = [{ type: 'npm', name: 'fixture-package' }];
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(lockPath, `${JSON.stringify({ schemaVersion: 1, packages: [
    { type: 'npm', name: 'fixture-package', version: '1.0.0', releasedAt: '2020-01-01T00:00:00.000Z' },
  ] }, null, 2)}\n`);
  const piEnv = await fakePi(t);
  const applied = runRawWith(cli, ['apply', '--approve-installs', '--json', '--repo', repo, '--agent-dir', agentDir], piEnv);
  assert.equal(applied.status, 0, applied.stderr);
  const output = result(applied);
  assert.equal(Object.hasOwn(output, 'packageInstalls'), false, 'no separate packageInstalls array');
  // The packages entry keeps its package/pin/action fields and carries the
  // install result for that package.
  assert.deepEqual(output.packages, [{ package: 'npm:fixture-package', pin: 'npm:fixture-package@1.0.0', action: 'installed' }]);
});

test('status and apply output no longer carry the dependencyModel boilerplate', async (t) => {
  const { repo, agentDir } = await fixture(t);
  for (const command of ['status', 'apply']) {
    const response = run([command, '--repo', repo, '--agent-dir', agentDir]);
    assert.equal(response.status, 0, `${command}: ${response.stderr}`);
    assert.equal(Object.hasOwn(result(response), 'dependencyModel'), false, `${command} omits dependencyModel`);
    assert.doesNotMatch(response.stdout, /dependencyModel/);
  }
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
  assert.equal(result(first).actions.find((item) => item.target === 'settings.json').fields[0].action, 'collision');
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
  assert.equal(result(conflict).actions.find((item) => item.target === 'settings.json').fields[0].action, 'conflict');
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

  const preview = run(['sync', '--dry-run', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(preview.status, 0, preview.stderr);
  const plan = result(preview);
  assert.equal(plan.mode, 'preview');
  assert.deepEqual(plan.syncable.map((item) => item.path).sort(), ['/defaultProvider', '/theme']);
  assert.deepEqual(plan.conflicts, []);
  const previewManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.equal(previewManifest.settings[0].fields.find((field) => field.path === '/theme').value, 'dark', 'preview must not write the manifest');

  const applied = run(['sync', '--repo', repo, '--agent-dir', agentDir]);
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

  const again = run(['sync', '--repo', repo, '--agent-dir', agentDir]);
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
  const second = run(['sync', '--repo', repo, '--agent-dir', agentDir]);
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

  const applied = run(['sync', '--repo', repo, '--agent-dir', agentDir]);
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
  const blocked = run(['sync', '--repo', repo, '--agent-dir', agentDir]);
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
  const rejected = run(['sync', '--repo', repo, '--agent-dir', agentDir]);
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
  const ok = run(['sync', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(result(ok).synced.map((item) => item.path), ['/providers/local']);
  assert.equal(JSON.parse(await fs.readFile(manifestPath, 'utf8')).settings[0].fields.find((field) => field.path === '/providers/local').value.apiKey, '__PLACEHOLDER__');
});

test('sync reports locally removed managed fields for review without unmanaging them', async (t) => {
  const { repo, agentDir, manifestPath, localPath } = await settingsFixture(t, [{ path: '/theme', value: 'dark' }]);
  const local = JSON.parse(await fs.readFile(localPath, 'utf8'));
  delete local.theme;
  await fs.writeFile(localPath, `${JSON.stringify(local, null, 2)}\n`);

  const applied = run(['sync', '--repo', repo, '--agent-dir', agentDir]);
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
  const missing = run(['sync', '--dry-run', '--repo', repo, '--agent-dir', path.join(agentDir, 'nope')]);
  assert.equal(missing.status, 2);
  assert.match(result(missing).error, /agent directory does not exist/);

  const local = JSON.parse(await fs.readFile(localPath, 'utf8'));
  local.theme = 'light';
  await fs.writeFile(localPath, `${JSON.stringify(local, null, 2)}\n`);
  const manifestBefore = await fs.readFile(manifestPath, 'utf8');
  const preview = run(['sync', '--dry-run', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestBefore);
});

test('serializes concurrent sync runs the way multiple Pi sessions would trigger them', async (t) => {
  const { repo, agentDir, manifestPath, localPath } = await settingsFixture(t, [{ path: '/theme', value: 'dark' }]);
  const local = JSON.parse(await fs.readFile(localPath, 'utf8'));
  local.theme = 'light';
  await fs.writeFile(localPath, `${JSON.stringify(local, null, 2)}\n`);
  const args = ['sync', '--repo', repo, '--agent-dir', agentDir];
  const [first, second] = await Promise.all([runAsync(args), runAsync(args)]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  // The winner syncs the change; the loser waits on the agent lock, re-reads the
  // fresh manifest and state, and no-ops. Exactly one run reports the sync.
  const [a, b] = [result(first), result(second)];
  assert.equal(a.synced.length + b.synced.length, 1, 'only one concurrent sync should write the field');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.equal(manifest.settings[0].fields.find((field) => field.path === '/theme').value, 'light');
  const idle = run(['sync', '--dry-run', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(idle.status, 0, idle.stderr);
  assert.match(result(idle).note, /Nothing to sync/);
});

test('sync recovers from a torn settings read and fails clearly on genuinely invalid files', async (t) => {
  const { repo, agentDir, manifestPath, localPath } = await settingsFixture(t, [{ path: '/theme', value: 'dark' }]);

  // A file that stays invalid must still fail clearly: the transient-read
  // retry must not mask a real error, and nothing may be written.
  await fs.writeFile(localPath, '{ "theme": "light"');
  const invalid = run(['sync', '--dry-run', '--repo', repo, '--agent-dir', agentDir]);
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
    runAsync(['sync', '--repo', repo, '--agent-dir', agentDir]),
    repair(),
  ]);
  assert.ok(didRepair, 'the CLI read of the torn file should be observable via atime');
  assert.equal(repaired.status, 0, repaired.stderr);
  const output = result(repaired);
  assert.equal(output.ok, true, JSON.stringify(output));
  assert.deepEqual(output.synced.map((item) => item.path), ['/theme']);
  assert.equal(JSON.parse(await fs.readFile(manifestPath, 'utf8')).settings[0].fields[0].value, 'light');
});

test('status reports the repository publish state for git setups', async (t) => {
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
  assert.deepEqual(statusOutput(run(['status', ...args])).repository, { dirty: false, ahead: 0, behind: 0 });

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
  assert.equal('repository' in statusOutput(run(['status', '--repo', plainRepo, '--agent-dir', plainAgentDir])), false);
  assert.deepEqual(nonGit.summary, { localPending: 0, remotePending: 1, needsReview: 0, clean: false });
});

test('status fetches the upstream before reporting, touching only git metadata', async (t) => {
  const { root, repo, bare } = await pushFixture(t);
  const agentDir = path.join(root, 'agent');
  await fs.mkdir(agentDir);
  const args = ['--repo', repo, '--agent-dir', agentDir];
  const statusOutput = (processResult) => {
    assert.equal(processResult.status, 0, processResult.stderr);
    return result(processResult);
  };

  // Remote advancement committed in a clone of the bare origin — with no
  // prior manual fetch in the checkout, so the tracking ref cannot know.
  const clone = path.join(root, 'second-clone');
  gitAt(root, ['clone', bare, clone]);
  gitAt(clone, ['config', 'user.name', 'Pi Sync Test']);
  gitAt(clone, ['config', 'user.email', 'pi-sync-test@example.invalid']);
  await fs.appendFile(path.join(clone, 'resources', 'skills', 'hello', 'SKILL.md'), '# Remote update\n');
  gitAt(clone, ['commit', '-am', 'remote change']);
  gitAt(clone, ['push', 'origin', 'main']);
  const remoteHead = gitAt(clone, ['rev-parse', 'HEAD']);
  assert.notEqual(gitAt(repo, ['rev-parse', 'origin/main']), remoteHead, 'the checkout has not fetched yet');

  const headBefore = gitAt(repo, ['rev-parse', 'HEAD']);
  const indexBefore = gitAt(repo, ['ls-files', '--stage']);

  // status and plan each report the fresh behind count with no manual fetch.
  for (const command of ['status']) {
    const output = statusOutput(run([command, ...args]));
    assert.deepEqual(output.repository, { dirty: false, ahead: 0, behind: 1 }, command);
    assert.equal(gitAt(repo, ['rev-parse', 'origin/main']), remoteHead, `${command} moved the tracking ref`);
  }

  // The fetch updates Git metadata only: HEAD, the index, and the working
  // tree are all unchanged.
  assert.equal(gitAt(repo, ['rev-parse', 'HEAD']), headBefore, 'HEAD unchanged');
  assert.equal(gitAt(repo, ['ls-files', '--stage']), indexBefore, 'index unchanged');
  assert.equal(gitAt(repo, ['status', '--porcelain']), '', 'working tree unchanged');
});

test('status reports an unavailable upstream instead of stale counts when the fetch fails', async (t) => {
  const { root, repo, bare } = await pushFixture(t);
  const agentDir = path.join(root, 'agent');
  await fs.mkdir(agentDir);
  const args = ['--repo', repo, '--agent-dir', agentDir];

  // Advance the remote and let the tracking ref learn about it, so a failed
  // fetch would otherwise tempt a stale behind count (1).
  const clone = path.join(root, 'second-clone');
  gitAt(root, ['clone', bare, clone]);
  gitAt(clone, ['config', 'user.name', 'Pi Sync Test']);
  gitAt(clone, ['config', 'user.email', 'pi-sync-test@example.invalid']);
  await fs.appendFile(path.join(clone, 'resources', 'skills', 'hello', 'SKILL.md'), '# Remote update\n');
  gitAt(clone, ['commit', '-am', 'remote change']);
  gitAt(clone, ['push', 'origin', 'main']);
  gitAt(repo, ['fetch', '--quiet']);

  // The remote becomes unreachable, so every fetch from here on fails.
  gitAt(repo, ['remote', 'set-url', 'origin', path.join(root, 'gone.git')]);

  for (const command of ['status']) {
    const processResult = run([command, ...args]);
    assert.equal(processResult.status, 0, processResult.stderr);
    const output = result(processResult);
    assert.equal(output.exitCode, 0);
    // The stale tracking-ref counts are not presented as current, and no
    // clean remote state is claimed: the upstream is explicitly unavailable.
    assert.deepEqual(output.repository, { dirty: false, ahead: null, behind: null, upstream: 'unavailable' }, command);
    // Local inspection information is retained: the unapplied install action
    // still counts, but the stale behind commit does not.
    assert.deepEqual(output.summary, { localPending: 0, remotePending: 1, needsReview: 0, clean: false }, command);
    assert.ok(output.actions.some((item) => item.action === 'install'), `local actions retained (${command})`);
  }

  // A failed fetch does not mask working-tree dirt: local state stays visible.
  await fs.appendFile(path.join(repo, 'pi-sync.json'), '\n');
  const dirty = result(run(['status', ...args]));
  assert.deepEqual(dirty.repository, { dirty: true, ahead: null, behind: null, upstream: 'unavailable' });
});
test('an unavailable upstream never reads as a verified-clean summary', async (t) => {
  const { root, repo } = await pushFixture(t);
  const agentDir = path.join(root, 'agent');
  await fs.mkdir(agentDir);
  const args = ['--repo', repo, '--agent-dir', agentDir];
  assert.equal(run(['apply', ...args]).status, 0);

  // The remote becomes unreachable only after the local state is fully
  // applied, so every summary count is zero and the only unknown is the
  // remote: the summary must not claim a verified-clean remote state.
  gitAt(repo, ['remote', 'set-url', 'origin', path.join(root, 'gone.git')]);

  for (const command of ['status']) {
    const output = result(run([command, ...args]));
    assert.deepEqual(output.repository, { dirty: false, ahead: null, behind: null, upstream: 'unavailable' }, command);
    assert.deepEqual(output.summary, { localPending: 0, remotePending: 0, needsReview: 0, clean: false }, command);
  }
});

test('status --no-fetch accepts last-known tracking refs without fetching', async (t) => {
  const { root, repo, bare } = await pushFixture(t);
  const agentDir = path.join(root, 'agent');
  await fs.mkdir(agentDir);
  const args = ['--repo', repo, '--agent-dir', agentDir];

  const clone = path.join(root, 'second-clone');
  gitAt(root, ['clone', bare, clone]);
  gitAt(clone, ['config', 'user.name', 'Pi Sync Test']);
  gitAt(clone, ['config', 'user.email', 'pi-sync-test@example.invalid']);
  await fs.appendFile(path.join(clone, 'resources', 'skills', 'hello', 'SKILL.md'), '# Remote update\n');
  gitAt(clone, ['commit', '-am', 'remote change']);
  gitAt(clone, ['push', 'origin', 'main']);
  const remoteHead = gitAt(clone, ['rev-parse', 'HEAD']);
  const trackingBefore = gitAt(repo, ['rev-parse', 'origin/main']);
  assert.notEqual(trackingBefore, remoteHead);

  const processResult = run(['status', '--no-fetch', ...args]);
  assert.equal(processResult.status, 0, processResult.stderr);
  const output = result(processResult);
  assert.deepEqual(output.repository, { dirty: false, ahead: 0, behind: 0 }, 'last-known refs, no fresh fetch');
  assert.equal(gitAt(repo, ['rev-parse', 'origin/main']), trackingBefore, 'the tracking ref was not updated');

  // --no-fetch is only meaningful for the inspect commands.
  const rejected = run(['remove', '--stale', '--no-fetch', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(rejected.status, 2);
  assert.match(JSON.parse(rejected.stdout).error, /--no-fetch is only supported by status/);
});
async function advanceUpstream(t, root, bare, marker) {
  const clone = path.join(root, `second-clone-${marker}`);
  gitAt(root, ['clone', bare, clone]);
  gitAt(clone, ['config', 'user.name', 'Pi Sync Test']);
  gitAt(clone, ['config', 'user.email', 'pi-sync-test@example.invalid']);
  await fs.appendFile(path.join(clone, 'resources', 'skills', 'hello', 'SKILL.md'), `# Remote update ${marker}\n`);
  gitAt(clone, ['commit', '-am', `remote change ${marker}`]);
  gitAt(clone, ['push', 'origin', 'main']);
  return gitAt(clone, ['rev-parse', 'HEAD']);
}

test('pull previews upstream changes without modifying the checkout', async (t) => {
  const { root, repo, bare } = await pushFixture(t);
  const remoteHead = await advanceUpstream(t, root, bare, 'one');

  const headBefore = gitAt(repo, ['rev-parse', 'HEAD']);
  const trackingBefore = gitAt(repo, ['rev-parse', 'origin/main']);
  assert.notEqual(trackingBefore, remoteHead, 'the checkout has not fetched yet');
  const worktreeBefore = await fs.readFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), 'utf8');

  // pull resolves --repo like the other repository commands and does not
  // require --agent-dir.
  const processResult = run(['pull', '--dry-run', '--repo', repo]);
  assert.equal(processResult.status, 0, processResult.stderr);
  const output = result(processResult);
  assert.equal(output.command, 'pull');
  assert.equal(output.ok, true);
  assert.equal(output.exitCode, 0);
  assert.equal(output.mode, 'preview');
  assert.equal(output.branch, 'main');
  assert.equal(output.upstream, 'origin/main');
  assert.equal(output.ahead, 0);
  assert.equal(output.behind, 1);
  assert.equal(output.upToDate, false);
  assert.equal(output.diverged, false);
  assert.equal(output.dirty, false);
  assert.deepEqual(output.dirtyPaths, []);
  assert.deepEqual(output.changedPaths, ['resources/skills/hello/SKILL.md']);
  assert.deepEqual(output.nextSteps, ['pi-sync status', 'pi-sync apply']);

  // Preview is read-only apart from Git metadata: HEAD, the index, and the
  // working-tree contents are untouched, while the tracking ref learned the
  // fresh tip.
  assert.equal(gitAt(repo, ['rev-parse', 'HEAD']), headBefore, 'preview does not move HEAD');
  assert.equal(gitAt(repo, ['rev-parse', 'origin/main']), remoteHead, 'preview fetched upstream metadata');
  assert.equal(gitAt(repo, ['status', '--porcelain']), '', 'preview leaves the index and worktree untouched');
  assert.equal(await fs.readFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), 'utf8'), worktreeBefore);
});

test('pull fast-forwards a clean branch without merging or rewriting history', async (t) => {
  const { root, repo, bare } = await pushFixture(t);
  const remoteHead = await advanceUpstream(t, root, bare, 'one');
  const headBefore = gitAt(repo, ['rev-parse', 'HEAD']);

  const processResult = runRawWith(cli, ['pull', '--repo', repo, '--json']);
  assert.equal(processResult.status, 0, processResult.stderr);
  const output = result(processResult);
  assert.equal(output.mode, 'applied');
  assert.equal(output.upToDate, true);
  assert.equal(output.ahead, 0);
  assert.equal(output.behind, 0);
  assert.equal(output.fromCommit, headBefore);
  assert.equal(output.toCommit, remoteHead);
  assert.deepEqual(output.changedPaths, ['resources/skills/hello/SKILL.md']);
  assert.deepEqual(output.nextSteps, ['pi-sync status', 'pi-sync apply']);

  // The branch advanced by fast-forward only: it is at the fetched tip with
  // linear history (no merge commits, first-parent history intact).
  assert.equal(gitAt(repo, ['rev-parse', 'HEAD']), remoteHead);
  assert.equal(gitAt(repo, ['rev-list', '--left-right', '--count', 'HEAD...origin/main']), '0\t0');
  assert.equal(gitAt(repo, ['rev-list', '--merges', 'HEAD']), '', 'no merge commits were created');
  assert.equal(gitAt(repo, ['rev-list', '--count', '--first-parent', 'HEAD']), gitAt(repo, ['rev-list', '--count', 'HEAD']), 'history stayed linear');
  assert.equal(gitAt(repo, ['status', '--porcelain']), '');

  // A repeat apply is an idempotent no-op that still guides the workflow.
  const again = result(run(['pull', '--repo', repo]));
  assert.equal(again.mode, 'applied');
  assert.equal(again.upToDate, true);
  assert.deepEqual(again.changedPaths, []);
  assert.equal(gitAt(repo, ['rev-parse', 'HEAD']), remoteHead);
});

test('pull rechecks upstream before mutating instead of applying a stale preview', async (t) => {
  const { root, repo, bare } = await pushFixture(t);
  await advanceUpstream(t, root, bare, 'one');
  const preview = result(run(['pull', '--dry-run', '--repo', repo]));
  assert.equal(preview.behind, 1);

  // The upstream advances a second time after the preview was taken.
  const remoteHead = await advanceUpstream(t, root, bare, 'two');
  const output = result(run(['pull', '--repo', repo]));
  assert.equal(output.mode, 'applied');
  assert.equal(output.toCommit, remoteHead, 'the fresh tip, not the previewed one, was applied');
  assert.equal(gitAt(repo, ['rev-parse', 'HEAD']), remoteHead);
});

test('pull treats a local-ahead branch without upstream advancement as up to date', async (t) => {
  const { root, repo, bare } = await pushFixture(t);
  await fs.appendFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), '# Local update\n');
  gitAt(repo, ['commit', '-am', 'local change']);
  const headBefore = gitAt(repo, ['rev-parse', 'HEAD']);

  const preview = result(run(['pull', '--dry-run', '--repo', repo]));
  assert.equal(preview.mode, 'preview');
  assert.equal(preview.ahead, 1);
  assert.equal(preview.behind, 0);
  assert.equal(preview.upToDate, true);
  assert.equal(preview.diverged, false);
  assert.match(preview.note, /pi-sync push/);

  const output = result(run(['pull', '--repo', repo]));
  assert.equal(output.mode, 'applied');
  assert.equal(output.upToDate, true);
  assert.equal(output.ahead, 1);
  assert.equal(gitAt(repo, ['rev-parse', 'HEAD']), headBefore, 'local-only commits remain pushable');
});

test('pull refuses a diverged branch without losing local commits or edits', async (t) => {
  const { root, repo, bare } = await pushFixture(t);
  await fs.appendFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), '# Local update\n');
  gitAt(repo, ['commit', '-am', 'local change']);
  const localHead = gitAt(repo, ['rev-parse', 'HEAD']);
  await advanceUpstream(t, root, bare, 'one');

  // The preview reports the divergence read-only.
  const preview = result(run(['pull', '--dry-run', '--repo', repo]));
  assert.equal(preview.mode, 'preview');
  assert.equal(preview.ahead, 1);
  assert.equal(preview.behind, 1);
  assert.equal(preview.diverged, true);
  assert.match(preview.note, /Reconcile/);

  // The apply refuses and leaves history and worktree intact.
  const rejected = run(['pull', '--repo', repo]);
  assert.equal(rejected.status, 1);
  const output = JSON.parse(rejected.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.errorCode, 'PULL_BLOCKED');
  assert.match(output.error, /diverged/);
  assert.equal(output.details.ahead, 1);
  assert.equal(output.details.behind, 1);
  assert.deepEqual(output.details.nextSteps, ['pi-sync status', 'pi-sync apply']);
  assert.equal(gitAt(repo, ['rev-parse', 'HEAD']), localHead, 'HEAD was not moved');
  assert.equal(gitAt(repo, ['status', '--porcelain']), '', 'the local commit and worktree were preserved');
});

// A git shim placed first on PATH that fails the named step ('merge',
// 'stash-apply', 'stash-verify', or 'stash-drop') and delegates everything
// so a test can exercise a pull failure at a specific step.
async function failingGit(t, fail) {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-failing-git-'));
  t.after(() => fs.rm(bin, { recursive: true, force: true }));
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  await fs.writeFile(path.join(bin, 'git'),
    `#!${process.execPath}\n` +
    `const { spawnSync } = require('node:child_process');\n` +
    `const args = process.argv.slice(2);\n` +
    `let i = 0; while (args[i] === '-C' || args[i] === '-c') i += 2;\n` +
    `const fail = process.env.FAKE_GIT_FAIL || '';\n` +
    `const isMerge = args[i] === 'merge';\n` +
    `const isStashApply = args[i] === 'stash' && args[i + 1] === 'apply';\n` +
    `const isStashVerify = args[i] === 'log' && args[i + 3] === 'refs/stash';\n` +
    `const isStashDrop = args[i] === 'stash' && args[i + 1] === 'drop';\n` +
    `if ((fail === 'merge' && isMerge) || (fail === 'stash-apply' && isStashApply) || (fail === 'stash-verify' && isStashVerify) || (fail === 'stash-drop' && isStashDrop)) { process.stderr.write('simulated ' + fail + ' failure\\n'); process.exit(1); }\n` +
    `const real = spawnSync(process.env.REAL_GIT, args, { stdio: 'inherit' });\n` +
    `process.exit(real.status === null ? 1 : real.status);\n`,
    { mode: 0o755 });
  return { PATH: `${bin}${path.delimiter}${process.env.PATH}`, REAL_GIT: realGit, FAKE_GIT_FAIL: fail };
}

test('pull restores staged, unstaged, and untracked local edits after a clean fast-forward', async (t) => {
  const { root, repo, bare } = await pushFixture(t);
  const remoteHead = await advanceUpstream(t, root, bare, 'one');
  const headBefore = gitAt(repo, ['rev-parse', 'HEAD']);

  // A staged change, an unstaged change, and a non-ignored untracked file.
  const manifest = await fs.readFile(path.join(repo, 'pi-sync.json'), 'utf8');
  await fs.writeFile(path.join(repo, 'pi-sync.json'), `${manifest}\n`);
  gitAt(repo, ['add', 'pi-sync.json']);
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), '# Local heading\n# Hello\n');
  await fs.writeFile(path.join(repo, 'scratch.txt'), 'untracked\n');
  const statusBefore = gitAt(repo, ['status', '--porcelain']);

  // The preview reports the dirt read-only while still previewing upstream.
  const preview = result(run(['pull', '--dry-run', '--repo', repo]));
  assert.equal(preview.mode, 'preview');
  assert.equal(preview.dirty, true);
  assert.deepEqual([...preview.dirtyPaths].sort(), ['pi-sync.json', 'resources/skills/hello/SKILL.md', 'scratch.txt']);
  assert.equal(preview.behind, 1);
  assert.equal(gitAt(repo, ['rev-parse', 'HEAD']), headBefore, 'preview does not move HEAD');
  assert.equal(gitAt(repo, ['status', '--porcelain']), statusBefore, 'preview leaves index and worktree untouched');

  const processResult = run(['pull', '--repo', repo]);
  assert.equal(processResult.status, 0, processResult.stderr);
  const output = result(processResult);
  assert.equal(output.mode, 'applied');
  assert.equal(output.upToDate, true);
  assert.equal(output.ahead, 0);
  assert.equal(output.behind, 0);
  assert.equal(output.fromCommit, headBefore);
  assert.equal(output.toCommit, remoteHead);
  assert.equal(output.dirty, true);
  assert.deepEqual([...output.dirtyPaths].sort(), ['pi-sync.json', 'resources/skills/hello/SKILL.md', 'scratch.txt']);
  assert.match(output.snapshotDiscarded, /^[0-9a-f]{40}$/, 'the pre-pull snapshot was created and discarded');

  // The branch advanced by fast-forward only, and every local edit survived
  // the snapshot/restore with its staging state intact.
  assert.equal(gitAt(repo, ['rev-parse', 'HEAD']), remoteHead);
  assert.equal(gitAt(repo, ['rev-list', '--merges', 'HEAD']), '', 'no merge commits were created');
  assert.equal(gitAt(repo, ['rev-list', '--left-right', '--count', 'HEAD...origin/main']), '0\t0');
  const status = gitAt(repo, ['status', '--porcelain']).split('\n');
  assert.equal(status.length, 3);
  assert.ok(status.includes('M  pi-sync.json'), 'the staged change is restored as staged');
  assert.ok(status.includes(' M resources/skills/hello/SKILL.md'), 'the unstaged change is restored');
  assert.ok(status.includes('?? scratch.txt'), 'the untracked file is restored');
  const skill = await fs.readFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), 'utf8');
  assert.equal(skill, '# Local heading\n# Hello\n# Remote update one\n', 'local and upstream edits were combined by Git');
  assert.equal(await fs.readFile(path.join(repo, 'scratch.txt'), 'utf8'), 'untracked\n');
  // Only this pull's snapshot was discarded; no recovery snapshot remains.
  assert.equal(gitAt(repo, ['stash', 'list']), '');
});

test('pull combines disjoint local and upstream edits with Git three-way behavior', async (t) => {
  const { root, repo, bare } = await pushFixture(t);
  // Grow the base to two committed lines so the local edit (line 1) and the
  // upstream edit (an appended line) land on disjoint lines.
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), '# Hello\n# Body\n');
  gitAt(repo, ['commit', '-am', 'second line']);
  gitAt(repo, ['push', 'origin', 'main']);
  const remoteHead = await advanceUpstream(t, root, bare, 'one');

  // The local edit modifies line 1; the upstream appended after line 2.
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), '# Local heading\n# Body\n');

  const processResult = run(['pull', '--repo', repo]);
  assert.equal(processResult.status, 0, processResult.stderr);
  const output = result(processResult);
  assert.equal(output.mode, 'applied');
  assert.equal(output.toCommit, remoteHead);
  const skill = await fs.readFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), 'utf8');
  // Pi Sync does not merge content itself: Git combined both sides.
  assert.equal(skill, '# Local heading\n# Body\n# Remote update one\n');
});

test('pull reports overlapping edits as conflicts and retains the recovery snapshot', async (t) => {
  const { root, repo, bare } = await pushFixture(t);
  const clone = path.join(root, 'second-clone');
  gitAt(root, ['clone', bare, clone]);
  gitAt(clone, ['config', 'user.name', 'Pi Sync Test']);
  gitAt(clone, ['config', 'user.email', 'pi-sync-test@example.invalid']);
  await fs.writeFile(path.join(clone, 'resources', 'skills', 'hello', 'SKILL.md'), '# Remote heading\n');
  gitAt(clone, ['commit', '-am', 'remote change']);
  gitAt(clone, ['push', 'origin', 'main']);
  const remoteHead = gitAt(clone, ['rev-parse', 'HEAD']);

  // The local edit touches the same line as the upstream change.
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), '# Local heading\n');

  const rejected = run(['pull', '--repo', repo]);
  assert.equal(rejected.status, 1);
  const output = JSON.parse(rejected.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.errorCode, 'PULL_CONFLICT');
  assert.match(output.error, /conflicts/i);
  assert.equal(output.details.toCommit, remoteHead, 'the branch was advanced');
  assert.deepEqual(output.details.conflictedPaths, ['resources/skills/hello/SKILL.md']);
  assert.equal(output.details.snapshot.ref, 'stash@{0}');
  assert.match(output.details.snapshot.message, /^pi-sync: pull snapshot /);
  assert.ok(Array.isArray(output.details.recovery) && output.details.recovery.length > 0);
  assert.deepEqual(output.details.nextSteps, ['pi-sync status', 'pi-sync apply']);

  // Git's unresolved conflict state is left for the user, and the recovery
  // snapshot is retained (never silently discarded).
  assert.equal(gitAt(repo, ['rev-parse', 'HEAD']), remoteHead);
  const skill = await fs.readFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), 'utf8');
  assert.match(skill, /<<<<<<</, 'conflict markers remain in the working tree');
  assert.equal(gitAt(repo, ['status', '--porcelain']), 'UU resources/skills/hello/SKILL.md');
  const stashList = gitAt(repo, ['stash', 'list']);
  assert.match(stashList, /^stash@\{0\}: On main: pi-sync: pull snapshot /m);
  assert.equal(gitAt(repo, ['rev-parse', 'refs/stash']), output.details.snapshot.sha, 'the reported identifier resolves');
});

test('pull never overwrites a local untracked file that the upstream adds', async (t) => {
  const { root, repo, bare } = await pushFixture(t);
  const clone = path.join(root, 'second-clone');
  gitAt(root, ['clone', bare, clone]);
  gitAt(clone, ['config', 'user.name', 'Pi Sync Test']);
  gitAt(clone, ['config', 'user.email', 'pi-sync-test@example.invalid']);
  await fs.writeFile(path.join(clone, 'scratch.txt'), 'theirs\n');
  gitAt(clone, ['add', 'scratch.txt']);
  gitAt(clone, ['commit', '-m', 'add scratch']);
  gitAt(clone, ['push', 'origin', 'main']);
  const remoteHead = gitAt(clone, ['rev-parse', 'HEAD']);

  // A local untracked file at the path the upstream newly tracks.
  await fs.writeFile(path.join(repo, 'scratch.txt'), 'mine\n');

  const rejected = run(['pull', '--repo', repo]);
  assert.equal(rejected.status, 1);
  const output = JSON.parse(rejected.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.errorCode, 'PULL_CONFLICT');
  assert.match(output.error, /untracked/i);
  assert.equal(output.details.toCommit, remoteHead);
  assert.deepEqual(output.details.conflictedPaths, ['scratch.txt']);

  // The branch carries the upstream file, and the local content is not lost:
  // Git refused to clobber it, and it is recoverable from the retained
  // recovery snapshot.
  assert.equal(gitAt(repo, ['rev-parse', 'HEAD']), remoteHead);
  assert.equal(await fs.readFile(path.join(repo, 'scratch.txt'), 'utf8'), 'theirs\n');
  const sha = output.details.snapshot.sha;
  assert.equal(gitAt(repo, ['show', `${sha}^3:scratch.txt`]), 'mine', 'the local content is recoverable from the snapshot (gitAt trims output)');
  assert.match(gitAt(repo, ['stash', 'list']), /pi-sync: pull snapshot/);
});

test('pull restores the original working state when the fast-forward fails', async (t) => {
  const { root, repo, bare } = await pushFixture(t);
  await advanceUpstream(t, root, bare, 'one');
  const headBefore = gitAt(repo, ['rev-parse', 'HEAD']);
  const manifest = await fs.readFile(path.join(repo, 'pi-sync.json'), 'utf8');
  await fs.writeFile(path.join(repo, 'pi-sync.json'), `${manifest}\n`);
  gitAt(repo, ['add', 'pi-sync.json']);
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), '# Hello Local\n');
  await fs.writeFile(path.join(repo, 'scratch.txt'), 'untracked\n');
  const statusBefore = gitAt(repo, ['status', '--porcelain']);
  const skillBefore = await fs.readFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), 'utf8');

  const rejected = run(['pull', '--repo', repo], await failingGit(t, 'merge'));
  assert.equal(rejected.status, 1);
  const output = JSON.parse(rejected.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.errorCode, 'PULL_BLOCKED');
  assert.match(output.error, /fast-forward could not be applied/);
  assert.equal(output.details.restored, true, 'the original working state was restored');

  // Nothing was changed: HEAD, the index/worktree state, and contents are all
  // back exactly as found, and the snapshot was discarded.
  assert.equal(gitAt(repo, ['rev-parse', 'HEAD']), headBefore, 'HEAD was not moved');
  assert.equal(gitAt(repo, ['status', '--porcelain']), statusBefore, 'index and worktree state are restored');
  assert.equal(await fs.readFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), 'utf8'), skillBefore);
  assert.equal(await fs.readFile(path.join(repo, 'scratch.txt'), 'utf8'), 'untracked\n');
  assert.equal(gitAt(repo, ['stash', 'list']), '', 'the snapshot was discarded after a clean restore');
});

test('pull retains the recovery snapshot when the restoration fails', async (t) => {
  const { root, repo, bare } = await pushFixture(t);
  const remoteHead = await advanceUpstream(t, root, bare, 'one');
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), '# Hello Local\n');
  await fs.writeFile(path.join(repo, 'scratch.txt'), 'untracked\n');

  const rejected = run(['pull', '--repo', repo], await failingGit(t, 'stash-apply'));
  assert.equal(rejected.status, 1);
  const output = JSON.parse(rejected.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.errorCode, 'PULL_CONFLICT');
  assert.equal(output.details.toCommit, remoteHead, 'the branch was advanced');

  // The failed restoration retains the snapshot and reports its recovery
  // identifier, so no user data is lost.
  const sha = output.details.snapshot.sha;
  assert.match(output.details.snapshot.message, /^pi-sync: pull snapshot /);
  assert.equal(gitAt(repo, ['rev-parse', 'refs/stash']), sha, 'the reported identifier resolves');
  assert.match(gitAt(repo, ['stash', 'list']), /pi-sync: pull snapshot/);
  assert.equal(gitAt(repo, ['show', `${sha}^3:scratch.txt`]), 'untracked', 'the local untracked content is recoverable (gitAt trims output)');
});
test('pull reports the stashed changes and recovery identity when snapshot verification fails', async (t) => {
  const { root, repo, bare } = await pushFixture(t);
  const headBefore = gitAt(repo, ['rev-parse', 'HEAD']);
  await advanceUpstream(t, root, bare, 'one');
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), '# Hello Local\n# Hello\n');
  await fs.writeFile(path.join(repo, 'scratch.txt'), 'untracked\n');

  const rejected = run(['pull', '--repo', repo], await failingGit(t, 'stash-verify'));
  assert.equal(rejected.status, 1);
  const output = JSON.parse(rejected.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.errorCode, 'PULL_BLOCKED');
  // Accurate state, not "nothing changed": the push succeeded, so the local
  // changes now sit in the stash and the branch was not advanced.
  assert.match(output.error, /could not be verified/);
  assert.match(output.error, /in the stash/);

  // The recovery identity is reported: a findable message, the stash ref,
  // and a resolvable sha, plus concrete recovery guidance.
  const snapshot = output.details.snapshot;
  assert.match(snapshot.message, /^pi-sync: pull snapshot /);
  assert.equal(snapshot.ref, 'stash@{0}');
  assert.equal(snapshot.sha, gitAt(repo, ['rev-parse', 'refs/stash']), 'the reported identifier resolves');
  assert.ok(Array.isArray(output.details.recovery) && output.details.recovery.length > 0);
  assert.match(output.details.recovery.join('\n'), /git stash list/);

  assert.equal(gitAt(repo, ['rev-parse', 'HEAD']), headBefore, 'the branch was not changed');
  assert.equal(gitAt(repo, ['status', '--porcelain']), '', 'the local changes now sit in the stash');
  assert.ok(gitAt(repo, ['stash', 'list']).includes(snapshot.message), 'the snapshot is findable in git stash list');
  assert.equal(gitAt(repo, ['show', `${snapshot.sha}^3:scratch.txt`]), 'untracked', 'the local content is recoverable from the stash (gitAt trims output)');
});

test('pull retains and reports the recovery snapshot when the drop fails', async (t) => {
  const { root, repo, bare } = await pushFixture(t);
  const remoteHead = await advanceUpstream(t, root, bare, 'one');
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), '# Hello Local\n# Hello\n');
  await fs.writeFile(path.join(repo, 'scratch.txt'), 'untracked\n');

  const processResult = run(['pull', '--repo', repo], await failingGit(t, 'stash-drop'));
  assert.equal(processResult.status, 0, processResult.stderr);
  const output = result(processResult);
  assert.equal(output.ok, true);
  assert.equal(output.mode, 'applied');
  assert.equal(gitAt(repo, ['rev-parse', 'HEAD']), remoteHead, 'the branch was advanced');
  assert.equal(output.dirty, true, 'the local changes were restored to the worktree');
  assert.equal(Object.hasOwn(output, 'snapshotDiscarded'), false);

  // The snapshot could not be safely discarded, so its identifier is reported
  // in the JSON and in the human-readable note.
  assert.match(output.snapshot.message, /^pi-sync: pull snapshot /);
  assert.equal(output.snapshot.ref, 'stash@{0}');
  assert.equal(output.snapshot.sha, gitAt(repo, ['rev-parse', 'refs/stash']), 'the retained snapshot is still the newest stash');
  assert.ok(output.note.includes(output.snapshot.message), 'the retained identifier is in the human-readable output');
  assert.match(output.note, /retained/);
  assert.match(gitAt(repo, ['stash', 'list']), /pi-sync: pull snapshot/);
});

test('pull is a no-op on an up-to-date branch even when the working tree is dirty', async (t) => {
  const { root, repo } = await pushFixture(t);
  const headBefore = gitAt(repo, ['rev-parse', 'HEAD']);
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), '# Hello Local\n');
  await fs.writeFile(path.join(repo, 'scratch.txt'), 'untracked\n');
  const statusBefore = gitAt(repo, ['status', '--porcelain']);

  const processResult = run(['pull', '--repo', repo]);
  assert.equal(processResult.status, 0, processResult.stderr);
  const output = result(processResult);
  assert.equal(output.mode, 'applied');
  assert.equal(output.upToDate, true);
  assert.equal(output.dirty, true);
  assert.deepEqual([...output.dirtyPaths].sort(), ['resources/skills/hello/SKILL.md', 'scratch.txt']);

  // Nothing to advance means nothing to snapshot: the working tree is left
  // exactly as found.
  assert.equal(gitAt(repo, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(gitAt(repo, ['status', '--porcelain']), statusBefore);
  assert.equal(gitAt(repo, ['stash', 'list']), '');
});

test('pull refuses missing upstream, detached HEAD, and unsafe repository states', async (t) => {
  const { root, repo, bare } = await pushFixture(t);

  gitAt(repo, ['checkout', '--detach']);
  let rejected = run(['pull', '--dry-run', '--repo', repo]);
  assert.equal(rejected.status, 1);
  let output = JSON.parse(rejected.stdout);
  assert.equal(output.errorCode, 'PULL_BLOCKED');
  assert.match(output.error, /checked-out branch/);
  gitAt(repo, ['checkout', 'main']);

  gitAt(repo, ['branch', '--unset-upstream']);
  rejected = run(['pull', '--dry-run', '--repo', repo]);
  assert.equal(rejected.status, 1);
  output = JSON.parse(rejected.stdout);
  assert.equal(output.errorCode, 'PULL_BLOCKED');
  assert.match(output.error, /configured upstream/);
  gitAt(repo, ['branch', '--set-upstream-to=origin/main']);

  const plain = path.join(root, 'plain');
  await fs.mkdir(plain);
  rejected = run(['pull', '--dry-run', '--repo', plain]);
  assert.equal(rejected.status, 1);
  output = JSON.parse(rejected.stdout);
  assert.equal(output.errorCode, 'PULL_BLOCKED');
  assert.match(output.error, /Git working tree/);

  rejected = run(['pull', '--dry-run', '--repo', path.join(repo, 'resources')]);
  assert.equal(rejected.status, 1);
  output = JSON.parse(rejected.stdout);
  assert.equal(output.errorCode, 'PULL_BLOCKED');
  assert.match(output.error, /root of its Git working tree/);
});

test('pull refuses when the upstream fetch fails', async (t) => {
  const { root, repo } = await pushFixture(t);
  const headBefore = gitAt(repo, ['rev-parse', 'HEAD']);
  gitAt(repo, ['remote', 'set-url', 'origin', path.join(root, 'does-not-exist.git')]);

  const rejected = run(['pull', '--dry-run', '--repo', repo]);
  assert.equal(rejected.status, 1);
  const output = JSON.parse(rejected.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.errorCode, 'PULL_BLOCKED');
  assert.match(output.error, /Could not fetch the upstream/);
  assert.equal(gitAt(repo, ['rev-parse', 'HEAD']), headBefore, 'nothing was changed');
  assert.equal(gitAt(repo, ['status', '--porcelain']), '');
});

test('pull rejects unsupported flag combinations', async (t) => {
  const { repo } = await pushFixture(t);
  let rejected = run(['pull', '--dry-run', '--repo', repo, '--no-fetch']);
  assert.equal(rejected.status, 2);
  assert.match(JSON.parse(rejected.stdout).error, /--no-fetch is only supported by status/);
  rejected = runRawWith(cli, ['pull', '--repo', repo, '--publish', '--json']);
  assert.equal(rejected.status, 2);
  assert.match(JSON.parse(rejected.stdout).error, /--publish is no longer supported/);
  rejected = runRawWith(cli, ['pull', '--repo', repo, '--approve', '--json']);
  assert.equal(rejected.status, 2);
  assert.match(JSON.parse(rejected.stdout).error, /--approve is no longer supported/);
});

test('status carries the sync preview classification without writing or locking', async (t) => {
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

  const preview = result(run(['sync', '--dry-run', '--repo', repo, '--agent-dir', agentDir]));
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
  for (const command of ['status']) {
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
  const plan = run(['status', '--repo', repo, '--agent-dir', agentDir]);
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
  const added = run(['add', '--target', 'skills/local-only', '--repo', repo, '--agent-dir', agentDir]);
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

test('add rejects the removed type flag, invalid target roots, collisions, and suspected credential material without importing', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const unsupported = runRawWith(cli, ['add', '--type', 'theme', '--target', 'skills/local-only', '--repo', repo, '--agent-dir', agentDir, '--json']);
  assert.equal(unsupported.status, 2);
  assert.match(JSON.parse(unsupported.stdout).error, /Unknown option: --type/);

  const wrongRoot = runRawWith(cli, ['add', '--target', 'unknown/local-only', '--repo', repo, '--agent-dir', agentDir, '--json']);
  assert.equal(wrongRoot.status, 2);
  assert.match(JSON.parse(wrongRoot.stdout).error, /--target must identify a resource/);

  await fs.mkdir(path.join(repo, 'resources', 'skills', 'local-only'), { recursive: true });
  const collision = run(['add', '--target', 'skills/local-only', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(collision.status, 2);
  const collisionOutput = result(collision);
  assert.match(collisionOutput.error, /collision/i);
  assert.equal(collisionOutput.apiVersion, 2);
  assert.equal(collisionOutput.ok, false);
  assert.equal(collisionOutput.errorCode, 'RESOURCE_COLLISION');
  assert.deepEqual(collisionOutput.details, { localPath: path.join(agentDir, 'skills', 'local-only'), repositoryPath: path.join(repo, 'resources', 'skills', 'local-only') });
  await fs.rm(path.join(repo, 'resources', 'skills', 'local-only'), { recursive: true });

  await fs.mkdir(path.join(agentDir, 'skills', 'local-only', 'credentials'), { recursive: true });
  const credentialPath = run(['add', '--target', 'skills/local-only', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(credentialPath.status, 2);
  assert.match(result(credentialPath).reviewRequired[0].reason, /known credential-store path/);
  await fs.rm(path.join(agentDir, 'skills', 'local-only', 'credentials'), { recursive: true });

  await fs.writeFile(path.join(agentDir, 'skills', 'local-only', 'notes.md'), 'Example token: ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ\n');
  const secret = run(['add', '--target', 'skills/local-only', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(secret.status, 2);
  const secretOutput = result(secret);
  assert.equal(secretOutput.apiVersion, 2);
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

test('reports stale resources without deleting them and removes them with remove --stale', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const applied = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(applied.status, 0, applied.stderr);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.resources = [];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));

  const planned = run(['status', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(planned.status, 0, planned.stderr);
  assert.deepEqual(result(planned).staleResources, [{ target: 'skills/hello', state: 'unchanged', installed: true, pruneAvailable: true }]);
  const ordinaryApply = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(ordinaryApply.status, 0, ordinaryApply.stderr);
  assert.equal(result(ordinaryApply).actions[0].action, 'stale');
  assert.equal(await fs.readFile(path.join(agentDir, 'skills', 'hello', 'SKILL.md'), 'utf8'), '# Hello\n');

  const preview = run(['remove', '--stale', '--dry-run', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(result(preview).mode, 'preview');
  assert.deepEqual(result(preview).staleResources[0], { target: 'skills/hello', action: 'would-prune', installed: true });
  await fs.access(path.join(agentDir, 'skills', 'hello', 'SKILL.md'));

  const pruned = run(['remove', '--stale', '--repo', repo, '--agent-dir', agentDir]);
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

test('remove --stale retains a stale parent target that overlaps a currently managed nested target', async (t) => {
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

  const preview = run(['remove', '--stale', '--dry-run', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(preview.status, 1);
  assert.deepEqual(result(preview).staleResources, [{ target: 'skills/foo', action: 'retained-overlap',
    installed: true, overlaps: ['skills/foo/bar'] }]);
  const confirmed = run(['remove', '--stale', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(confirmed.status, 1);
  assert.deepEqual(result(confirmed).staleResources, [{ target: 'skills/foo', action: 'retained-overlap',
    installed: true, overlaps: ['skills/foo/bar'] }]);
  assert.equal(await fs.readFile(path.join(agentDir, 'skills', 'foo', 'bar', 'SKILL.md'), 'utf8'), '# Nested skill\\n');
  const state = await fs.readFile(path.join(agentDir, '.pi-sync', 'state.json'), 'utf8').then(JSON.parse);
  assert.ok(state.resources['skills/foo'], 'overlapping stale baseline remains available for safe resolution');
  assert.ok(state.resources['skills/foo/bar'], 'currently managed nested target remains state-managed');
});

test('remove --stale retains case-variant stale/current nested targets on Windows filesystems', async (t) => {
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

  const preview = run(['remove', '--stale', '--dry-run', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(preview.status, 1);
  assert.deepEqual(result(preview).staleResources, [{ target: 'skills/foo', action: 'retained-overlap',
    installed: true, overlaps: ['skills/FOO/child'] }]);
  const confirmed = run(['remove', '--stale', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(confirmed.status, 1);
  assert.deepEqual(result(confirmed).staleResources, [{ target: 'skills/foo', action: 'retained-overlap',
    installed: true, overlaps: ['skills/FOO/child'] }]);
  assert.equal(await fs.readFile(path.join(agentDir, 'skills', 'FOO', 'child', 'SKILL.md'), 'utf8'), '# Case-overlap\\n');
  const state = await fs.readFile(path.join(agentDir, '.pi-sync', 'state.json'), 'utf8').then(JSON.parse);
  assert.ok(state.resources['skills/foo']);
  assert.ok(state.resources['skills/FOO/child']);
});

test('remove --stale preserves stale resources with local edits and reports why', async (t) => {
  const { repo, agentDir } = await fixture(t);
  assert.equal(run(['apply', '--repo', repo, '--agent-dir', agentDir]).status, 0);
  const manifest = JSON.parse(await fs.readFile(path.join(repo, 'pi-sync.json'), 'utf8'));
  manifest.resources = [];
  await fs.writeFile(path.join(repo, 'pi-sync.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(agentDir, 'skills', 'hello', 'SKILL.md'), '# Keep my local work\n');
  const prune = run(['remove', '--stale', '--repo', repo, '--agent-dir', agentDir]);
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
  const response = run(['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo', path.join(root, 'checkout'), '--agent-dir', path.join(root, 'agent'), '--bin-dir', binDir], {
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
  const response = run(['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo', path.join(root, 'checkout'), '--agent-dir', path.join(root, 'agent'), '--bin-dir', notDirectory], {
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

test('push acts by default while --dry-run preserves the commit and remote refs', async (t) => {
  const { repo, bare } = await pushFixture(t);
  const managed = path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md');
  await fs.writeFile(managed, '# Action-default push\n');
  const headBefore = gitAt(repo, ['rev-parse', 'HEAD']);
  const remoteBefore = gitAt(repo, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0];
  const preview = runRawWith(cli, ['push', '--dry-run', '--json', '--repo', repo]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).mode, 'preview');
  assert.equal(gitAt(repo, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(gitAt(repo, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0], remoteBefore);
  const published = runRawWith(cli, ['push', '--json', '--repo', repo]);
  assert.equal(published.status, 0, `${published.stderr}\n${published.stdout}`);
  assert.equal(JSON.parse(published.stdout).mode, 'published');
  assert.notEqual(gitAt(repo, ['rev-parse', 'HEAD']), headBefore);
  assert.notEqual(gitAt(repo, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0], remoteBefore);
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

  const preview = run(['push', '--dry-run', '--repo', repo]);
  assert.equal(preview.status, 0, `${preview.stderr}\n${preview.stdout}`);
  const plan = result(preview);
  assert.equal(plan.mode, 'preview');
  assert.equal(plan.publicationAuthorized, false);
  assert.deepEqual(plan.changes.map((item) => item.path).sort(), ['pi-sync.json', 'resources/skills/hello/SKILL.md']);
  assert.equal(plan.commitRequired, true);
  assert.match(plan.patch, /Edited skill/);
  assert.doesNotMatch(plan.patch, /ignored content changed/);
  assert.match(gitAt(repo, ['diff', '--cached', '--name-only']), /^unrelated\.txt$/);

  const published = run(['push', '--repo', repo]);
  assert.equal(published.status, 0, published.stderr);
  assert.equal(published.stderr, '', 'a successful bare push writes nothing to stderr');
  assert.doesNotMatch(published.stdout, /Edited skill/, 'the published result carries no diff content');
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

test('push publishes the managed EOL policy file and accepts ahead commits touching it', async (t) => {
  const { repo, bare } = await pushFixture(t);
  // Bootstrap-style adoption: the policy file appears untracked in the working tree.
  await fs.writeFile(path.join(repo, '.gitattributes'), '* text=auto eol=lf\n');
  const preview = run(['push', '--dry-run', '--repo', repo]);
  assert.equal(preview.status, 0, `${preview.stderr}\n${preview.stdout}`);
  const plan = result(preview);
  assert.deepEqual(plan.changes.map((item) => item.path), ['.gitattributes']);
  assert.equal(plan.commitRequired, true);

  const published = run(['push', '--repo', repo]);
  assert.equal(published.status, 0, `${published.stderr}\n${published.stdout}`);
  const output = result(published);
  assert.equal(output.mode, 'published');
  assert.deepEqual(output.changes.map((item) => item.path), ['.gitattributes']);
  const remoteFiles = spawnSync('git', ['--git-dir', bare, 'ls-tree', '--name-only', 'main'], { encoding: 'utf8' });
  assert.equal(remoteFiles.status, 0, remoteFiles.stderr);
  assert.ok(remoteFiles.stdout.includes('.gitattributes'));

  // A previously committed change to the policy file is publishable too.
  await fs.writeFile(path.join(repo, '.gitattributes'), '* text=auto eol=lf\n# managed by pi-sync\n');
  gitAt(repo, ['add', '--', '.gitattributes']);
  gitAt(repo, ['commit', '-m', 'annotate policy']);
  const republished = run(['push', '--repo', repo]);
  assert.equal(republished.status, 0, `${republished.stderr}\n${republished.stdout}`);
  const republishedOutput = result(republished);
  assert.equal(republishedOutput.mode, 'published');
  assert.deepEqual(republishedOutput.changes.map((item) => item.path), ['.gitattributes']);
});

test('published push reports the short confirmation with no diff or digest in every tier', async (t) => {
  // JSON tier: the published result carries the confirmation content and no
  // diff or digest fields; the dry-run preview keeps the full diff on stdout.
  {
    const { repo, bare } = await pushFixture(t);
    await fs.writeFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), '# Edited skill\n');
    const preview = run(['push', '--dry-run', '--repo', repo]);
    assert.equal(preview.status, 0, `${preview.stderr}\n${preview.stdout}`);
    assert.equal(preview.stderr, '', 'the dry-run preview writes nothing to stderr');
    const previewOutput = result(preview);
    assert.equal(previewOutput.mode, 'preview');
    assert.match(previewOutput.patch, /Edited skill/, 'the full managed diff is the preview decision payload on stdout');
    const published = run(['push', '--repo', repo]);
    assert.equal(published.status, 0, `${published.stderr}\n${published.stdout}`);
    assert.equal(published.stderr, '', 'a successful bare push writes nothing to stderr');
    const output = result(published);
    assert.equal(output.mode, 'published');
    assert.match(output.commit, /^[0-9a-f]{40}$/, 'the published commit is reported');
    assert.equal(output.branch, 'main');
    assert.equal(output.upstream, 'origin/main');
    assert.deepEqual(output.changes.map((item) => item.path), ['resources/skills/hello/SKILL.md']);
    assert.equal(Object.hasOwn(output, 'patch'), false, 'no patch text in the published result');
    assert.equal(Object.hasOwn(output, 'patchSha256'), false, 'no digest field in the published result');
    assert.equal(Object.hasOwn(output, 'patchBytes'), false, 'no digest field in the published result');
    assert.doesNotMatch(published.stdout, /Edited skill/, 'no diff content in the published result');
    // The published commit landed on the bare upstream.
    const remote = spawnSync('git', ['--git-dir', bare, 'rev-parse', 'main'], { encoding: 'utf8' });
    assert.equal(remote.status, 0, remote.stderr);
    assert.equal(remote.stdout.trim(), output.commit);
  }
  // Text tier: the same short confirmation, one fact per line, no diff or digest.
  {
    const { repo } = await pushFixture(t);
    await fs.writeFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), '# Edited skill\n');
    const published = runRawWith(cli, ['push', '--repo', repo]);
    assert.equal(published.status, 0, `${published.stderr}\n${published.stdout}`);
    assert.equal(published.stderr, '', 'the text-tier push writes nothing to stderr');
    assert.match(published.stdout, /^ok$/m);
    assert.match(published.stdout, /commit: [0-9a-f]{40}/, 'the text tier reports the published commit');
    assert.match(published.stdout, /branch: main/);
    assert.match(published.stdout, /upstream: origin\/main/);
    assert.match(published.stdout, /path: resources\/skills\/hello\/SKILL\.md/, 'the text tier lists the changed managed path');
    assert.doesNotMatch(published.stdout, /Edited skill/, 'no diff content in the text tier');
    assert.doesNotMatch(published.stdout, /patchSha256/);
    assert.doesNotMatch(published.stdout, /diff --git/);
  }
});

test('publish with no managed changes reports an empty result without patch or digest fields', async (t) => {
  const { repo } = await pushFixture(t);
  const published = run(['push', '--repo', repo]);
  assert.equal(published.status, 0, `${published.stderr}\n${published.stdout}`);
  const output = result(published);
  assert.equal(output.mode, 'published');
  assert.deepEqual(output.changes, []);
  assert.equal(output.commit, null);
  assert.equal(Object.hasOwn(output, 'patch'), false);
  assert.equal(Object.hasOwn(output, 'patchSha256'), false);
  assert.equal(Object.hasOwn(output, 'patchBytes'), false);
  assert.equal(published.stderr, '');
});
test('bare update installing a mature pin followed by a bare push publishes the lockfile change', async (t) => {
  const { root, repo, bare } = await pushFixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const lockPath = path.join(repo, 'pi-sync.lock.json');
  // Declare the dependency at an older pin and commit it, so the follow-on
  // push publishes only the lockfile change the update produces.
  await fs.writeFile(manifestPath, JSON.stringify({ schemaVersion: 1,
    resources: [{ type: 'skill', source: 'resources/skills/hello', target: 'skills/hello' }],
    dependencies: [{ type: 'npm', name: 'fixture-package' }],
    policy: { minimumReleaseAgeDays: 7 } }, null, 2) + '\n');
  await fs.writeFile(lockPath, JSON.stringify({ schemaVersion: 1, packages: [
    { type: 'npm', name: 'fixture-package', version: '1.0.0', releasedAt: '2020-01-01T00:00:00.000Z' },
  ] }, null, 2) + '\n');
  gitAt(repo, ['add', '--all']);
  gitAt(repo, ['commit', '-m', 'declare dependency at initial pin']);
  gitAt(repo, ['push', 'origin', 'main']);

  // The agent directory already has the initial pin installed, so a bare
  // update needs no first-time-install approval.
  const agentDir = path.join(root, 'agent');
  await fs.mkdir(path.join(agentDir, '.pi-sync'), { recursive: true });
  await fs.writeFile(path.join(agentDir, '.pi-sync', 'packages.json'), JSON.stringify({ schemaVersion: 1, packages: { 'npm:fixture-package': '1.0.0' } }, null, 2) + '\n');

  const piEnv = await fakePi(t);
  const npmBin = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-fake-npm-'));
  t.after(() => fs.rm(npmBin, { recursive: true, force: true }));
  const npmScript = `#!${process.execPath}\nconst a=process.argv.slice(2);\nif(a[0]==='view'&&a[2]==='versions'&&a[3]==='--json'){console.log(JSON.stringify(['1.0.0','2.0.0']));process.exit(0);}\nif(a[0]==='view'&&a[2]==='time'&&a[3]==='--json'){console.log(JSON.stringify({'1.0.0':'2020-01-01T00:00:00.000Z','2.0.0':'2020-06-01T00:00:00.000Z'}));process.exit(0);}\nprocess.exit(2);\n`;
  await fs.writeFile(path.join(npmBin, 'npm'), npmScript, { mode: 0o755 });
  const env = { PATH: `${npmBin}${path.delimiter}${piEnv.PATH}` };

  const updated = run(['update', '--repo', repo, '--agent-dir', agentDir], env);
  assert.equal(updated.status, 0, `${updated.stderr}\n${updated.stdout}`);
  assert.equal(updated.stderr, '', 'update writes nothing to stderr in normal operation');
  const updateOutput = result(updated);
  assert.equal(updateOutput.mode, 'applied');
  assert.deepEqual(JSON.parse(await fs.readFile(lockPath, 'utf8')).packages,
    [{ type: 'npm', name: 'fixture-package', version: '2.0.0', releasedAt: '2020-06-01T00:00:00.000Z' }]);

  const published = run(['push', '--repo', repo]);
  assert.equal(published.status, 0, `${published.stderr}\n${published.stdout}`);
  assert.equal(published.stderr, '', 'the follow-on bare push writes nothing to stderr');
  const pushed = result(published);
  assert.equal(pushed.mode, 'published');
  assert.deepEqual(pushed.changes.map((item) => item.path), ['pi-sync.lock.json']);
  assert.equal(Object.hasOwn(pushed, 'patch'), false);
  assert.equal(Object.hasOwn(pushed, 'patchSha256'), false);
  assert.equal(Object.hasOwn(pushed, 'patchBytes'), false);
  assert.doesNotMatch(published.stdout, /2\.0\.0/, 'the published result carries no diff content');
  const remoteLock = spawnSync('git', ['--git-dir', bare, 'show', 'main:pi-sync.lock.json'], { encoding: 'utf8' });
  assert.equal(remoteLock.status, 0, remoteLock.stderr);
  assert.deepEqual(JSON.parse(remoteLock.stdout).packages,
    [{ type: 'npm', name: 'fixture-package', version: '2.0.0', releasedAt: '2020-06-01T00:00:00.000Z' }]);
});
test('push --message reports the effective subject in preview and creates the commit with it', async (t) => {
  const { repo } = await pushFixture(t);
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), '# Edited skill\n');
  const message = 'Refresh the hello skill for the deploy guide';

  const preview = run(['push', '--dry-run', '--message', message, '--repo', repo]);
  assert.equal(preview.status, 0, `${preview.stderr}\n${preview.stdout}`);
  const plan = result(preview);
  assert.equal(plan.mode, 'preview');
  assert.equal(plan.commitRequired, true);
  assert.equal(plan.commitMessage, message, 'preview JSON carries the intended subject');
  // The preview authorizes nothing: no commit exists and nothing was published.
  assert.equal(gitAt(repo, ['rev-list', '--count', '@{upstream}..HEAD']), '0');

  const published = run(['push', '--message', message, '--repo', repo]);
  assert.equal(published.status, 0, `${published.stderr}\n${published.stdout}`);
  const output = result(published);
  assert.equal(output.mode, 'published');
  assert.equal(output.commitMessage, message);
  assert.equal(gitAt(repo, ['log', '-1', '--format=%s']), message, 'the custom subject is the new commit subject');
});

test('push without --message keeps the default subject and reports it as the effective message', async (t) => {
  const { repo } = await pushFixture(t);
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), '# Edited skill\n');
  const defaultSubject = 'pi-sync: publish managed setup';

  const preview = run(['push', '--dry-run', '--repo', repo]);
  assert.equal(preview.status, 0, `${preview.stderr}\n${preview.stdout}`);
  const plan = result(preview);
  assert.equal(plan.commitRequired, true);
  assert.equal(plan.commitMessage, defaultSubject, 'the default subject remains the effective message');

  const published = run(['push', '--repo', repo]);
  assert.equal(published.status, 0, `${published.stderr}\n${published.stdout}`);
  const output = result(published);
  assert.equal(output.commitMessage, defaultSubject);
  assert.equal(gitAt(repo, ['log', '-1', '--format=%s']), defaultSubject, 'the default subject is unchanged');
});

test('push --message has no effect when no new managed-only commit is created', async (t) => {
  const { repo } = await pushFixture(t);
  // Publishing with nothing to commit: no commit is created and the message
  // must not appear in the output at all.
  const idle = run(['push', '--message', 'Should not appear', '--repo', repo]);
  assert.equal(idle.status, 0, `${idle.stderr}\n${idle.stdout}`);
  const idleOutput = result(idle);
  assert.equal(idleOutput.commit, null);
  assert.equal(Object.hasOwn(idleOutput, 'commitMessage'), false);
  const idlePreview = run(['push', '--dry-run', '--message', 'Should not appear', '--repo', repo]);
  assert.equal(idlePreview.status, 0, `${idlePreview.stderr}\n${idlePreview.stdout}`);
  assert.equal(result(idlePreview).commitRequired, false);
  assert.equal(Object.hasOwn(result(idlePreview), 'commitMessage'), false);

  // Publishing an already-committed ahead commit: the existing commit is
  // published untouched and never rewritten with the new message.
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), '# Committed edit\n');
  gitAt(repo, ['add', '--', 'resources/skills/hello']);
  gitAt(repo, ['commit', '-m', 'an existing local commit']);
  const published = run(['push', '--message', 'Should not appear', '--repo', repo]);
  assert.equal(published.status, 0, `${published.stderr}\n${published.stdout}`);
  const output = result(published);
  assert.equal(output.mode, 'published');
  assert.equal(output.commit, gitAt(repo, ['rev-parse', 'HEAD']));
  assert.equal(Object.hasOwn(output, 'commitMessage'), false, 'no new commit was created, so the message has no effect');
  assert.equal(gitAt(repo, ['log', '-1', '--format=%s']), 'an existing local commit', 'the existing commit subject is never rewritten');
});

test('push --message passes the subject as a process argument, not shell-interpolated text', async (t) => {
  const { repo } = await pushFixture(t);
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), '# Edited skill\n');
  const markerDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-message-test-'));
  t.after(() => fs.rm(markerDir, { recursive: true, force: true }));
  const marker = path.join(markerDir, 'executed');
  const message = `subject with "quotes", $(touch ${marker}), and ; semicolons`;
  const published = run(['push', '--message', message, '--repo', repo]);
  assert.equal(published.status, 0, `${published.stderr}\n${published.stdout}`);
  assert.equal(gitAt(repo, ['log', '-1', '--format=%s']), message, 'shell metacharacters are not interpreted');
  assert.equal(result(published).commitMessage, message);
  await assert.rejects(fs.access(marker), 'the $(...) payload was not executed');
});

test('push --message rejects empty and whitespace-only subjects and unsupported flag combinations', async (t) => {
  const { repo, root } = await pushFixture(t);
  const agentDir = path.join(root, 'agent');
  await fs.mkdir(agentDir, { recursive: true });

  const empty = run(['push', '--dry-run', '--message', '', '--repo', repo]);
  assert.equal(empty.status, 2, empty.stderr);
  assert.equal(result(empty).errorCode, 'VALIDATION_ERROR');
  assert.match(result(empty).error, /--message requires a value/);

  const blank = run(['push', '--dry-run', '--message', '   ', '--repo', repo]);
  assert.equal(blank.status, 2, blank.stderr);
  assert.match(result(blank).error, /--message must not be empty/);

  const unrelated = run(['status', '--message', 'a subject', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(unrelated.status, 2, unrelated.stderr);
  assert.match(result(unrelated).error, /--message is only supported by push/);

  const updateNoPush = run(['update', '--message', 'a subject', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(updateNoPush.status, 2, updateNoPush.stderr);
  assert.match(result(updateNoPush).error, /--message is only supported by push/);

  // No repository state changed by any rejected run.
  assert.equal(gitAt(repo, ['status', '--porcelain']), '');
});

test('push stops for suspected credential content in a managed resource', async (t) => {
  const { repo } = await pushFixture(t);
  const skill = path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md');
  const credential = 'ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ';
  await fs.writeFile(skill, `example token: ${credential}\n`);
  const response = run(['push', '--dry-run', '--repo', repo]);
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

  const response = run(['push', '--repo', repo]);
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

  const response = run(['push', '--repo', repo]);
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
  const ahead = run(['push', '--repo', repo]);
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
  const diverged = run(['push', '--repo', other]);
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
  const rejected = run(['push', '--repo', repo]);
  assert.equal(rejected.status, 1);
  const output = result(rejected);
  assert.equal(output.errorCode, 'PUSH_BLOCKED');
  assert.match(output.error, /push was rejected/);
  assert.equal(await fs.readFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), 'utf8'), '# Commit remains local\n');
  assert.deepEqual(gitAt(repo, ['show', '--format=', '--name-only', 'HEAD']).split(/\r?\n/).filter(Boolean), ['resources/skills/hello/SKILL.md']);
  assert.equal(gitAt(repo, ['diff', '--cached', '--name-only']), 'unrelated.txt');
});

test('update --push is rejected; publishing requires a separate push command', () => {
  const response = runRawWith(cli, ['update', '--push', '--json']);
  assert.equal(response.status, 2);
  assert.match(result(response).error, /update --push is no longer supported/);
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
    const response = run(['add', '--target', source, '--repo', repo, '--agent-dir', agentDir]);
    assert.equal(response.status, 0, `${type} ${source}: ${response.stderr}\n${response.stdout}`);
  }
}

test('add imports prompts, agents, roles, and file and directory extension forms with manifest updates', async (t) => {
  const { repo, agentDir } = await extendedFixture(t);
  for (const [type, source] of EXTENDED_ADDS) {
    const response = run(['add', '--target', source, '--repo', repo, '--agent-dir', agentDir]);
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
  assert.deepEqual(result(second).actions, []);

  // Unmanaged content under the same roots is invisible to plan/status and untouched by apply.
  const planned = run(['status', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(planned.status, 0, planned.stderr);
  assert.deepEqual(result(planned).actions, []);
  assert.equal(result(planned).conflicts.length, 0);
  assert.equal(result(planned).staleResources.length, 0);
  assert.equal(await fs.readFile(path.join(agentDir, 'prompts', 'unmanaged.md'), 'utf8'), '# Unmanaged prompt\n');
  assert.equal(await fs.readFile(path.join(agentDir, 'extensions', 'unmanaged-ext.ts'), 'utf8'), 'export const x = 1;\n');
});

test('prompt, agent, and role resources reconcile with the same three-way semantics as skills', async (t) => {
  const { repo, agentDir } = await extendedFixture(t);
  for (const [type, source] of [['prompt', 'prompts/deploy.md'], ['agent', 'agents/reviewer.md'], ['role', 'roles/moderator.md']]) {
    const response = run(['add', '--target', source, '--repo', repo, '--agent-dir', agentDir]);
    assert.equal(response.status, 0, response.stderr);
  }
  const first = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(result(first).actions, []);

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
test('add imports workflow scripts and rejects non-.js or nested workflow sources', async (t) => {
  const { repo, agentDir } = await extendedFixture(t);
  await fs.mkdir(path.join(agentDir, 'workflows'), { recursive: true });
  await fs.writeFile(path.join(agentDir, 'workflows', 'octopus-loop.js'), 'export async function run() {}\n');
  await fs.writeFile(path.join(agentDir, 'workflows', 'notes.txt'), 'not a workflow\n');

  const response = run(['add', '--target', 'workflows/octopus-loop.js', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(response.status, 0, `${response.stderr}\n${response.stdout}`);
  const output = result(response);
  assert.equal(output.action, 'added');
  assert.equal(output.type, 'workflow');
  assert.equal(output.source, 'workflows/octopus-loop.js');
  assert.equal(output.target, 'workflows/octopus-loop.js');
  assert.equal(output.repositorySource, 'resources/workflows/octopus-loop.js');
  const manifest = JSON.parse(await fs.readFile(path.join(repo, 'pi-sync.json'), 'utf8'));
  assert.deepEqual(manifest.resources, [{ type: 'workflow', source: 'resources/workflows/octopus-loop.js', target: 'workflows/octopus-loop.js' }]);
  assert.equal(await fs.readFile(path.join(repo, 'resources', 'workflows', 'octopus-loop.js'), 'utf8'), 'export async function run() {}\n');
  assert.equal(await fs.readFile(path.join(agentDir, 'workflows', 'octopus-loop.js'), 'utf8'), 'export async function run() {}\n');

  // A non-.js file and a nested path are validation rejections that write nothing.
  for (const source of ['workflows/notes.txt', 'workflows/inner/deep.js']) {
    const rejected = run(['add', '--target', source, '--repo', repo, '--agent-dir', agentDir]);
    assert.equal(rejected.status, 2, `${source}: ${rejected.stderr}\n${rejected.stdout}`);
  }
  assert.equal(JSON.parse(await fs.readFile(path.join(repo, 'pi-sync.json'), 'utf8')).resources.length, 1);
});

test('add registers repository-present workflow scripts, and --list and --all discover them', async (t) => {
  const { repo, agentDir } = await fixture(t);
  await fs.mkdir(path.join(repo, 'resources', 'workflows'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'workflows', 'octopus-loop.js'), 'export async function run() {}\n');
  // Non-resources: a non-.js file and a nested file are not candidates.
  await fs.writeFile(path.join(repo, 'resources', 'workflows', 'notes.txt'), 'not a workflow\n');
  await fs.mkdir(path.join(repo, 'resources', 'workflows', 'inner'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'workflows', 'inner', 'deep.js'), 'export const deep = true;\n');

  const listed = run(['add', '--list', '--repo', repo]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(result(listed).unregistered, [
    { type: 'workflow', source: 'resources/workflows/octopus-loop.js', target: 'workflows/octopus-loop.js' },
  ]);

  const response = run(['add', '--target', 'workflows/octopus-loop.js', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(response.status, 0, response.stderr);
  const output = result(response);
  assert.equal(output.action, 'declared');
  assert.equal(output.type, 'workflow');
  assert.equal(output.source, 'workflows/octopus-loop.js');
  assert.equal(output.target, 'workflows/octopus-loop.js');
  const manifest = JSON.parse(await fs.readFile(path.join(repo, 'pi-sync.json'), 'utf8'));
  assert.deepEqual(manifest.resources.at(-1), { type: 'workflow', source: 'resources/workflows/octopus-loop.js', target: 'workflows/octopus-loop.js' });
  // No import or copy: the local installation is not created or modified.
  await assert.rejects(fs.access(path.join(agentDir, 'workflows')));

  // Re-registering the exact declaration is an idempotent no-op.
  const again = run(['add', '--target', 'workflows/octopus-loop.js', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(result(again).action, 'already-added');

  // --all batch-registers the remaining candidate of the narrowed type.
  await fs.writeFile(path.join(repo, 'resources', 'workflows', 'second.js'), 'export async function second() {}\n');
  const batched = run(['add', '--all', '--repo', repo]);
  assert.equal(batched.status, 0, batched.stderr);
  const batchedOutput = result(batched);
  assert.equal(batchedOutput.action, 'registered');
  assert.deepEqual(batchedOutput.registered, [{ type: 'workflow', source: 'resources/workflows/second.js', target: 'workflows/second.js' }]);
  const finalManifest = JSON.parse(await fs.readFile(path.join(repo, 'pi-sync.json'), 'utf8'));
  assert.deepEqual(finalManifest.resources.map((item) => item.type), ['skill', 'workflow', 'workflow']);
});

test('apply installs workflow scripts, and remove --keep-local and remove --stale handle them like the other file types', async (t) => {
  const { repo, agentDir } = await extendedFixture(t);
  await fs.mkdir(path.join(agentDir, 'workflows'), { recursive: true });
  await fs.writeFile(path.join(agentDir, 'workflows', 'octopus-loop.js'), 'export async function run() {}\n');
  assert.equal(run(['add', '--target', 'workflows/octopus-loop.js', '--repo', repo, '--agent-dir', agentDir]).status, 0);

  // Remove the local original so apply performs a real install.
  await fs.rm(path.join(agentDir, 'workflows', 'octopus-loop.js'));
  const installed = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(installed.status, 0, installed.stderr);
  assert.deepEqual(result(installed).actions.map((item) => item.target), ['workflows/octopus-loop.js']);
  assert.equal(result(installed).actions[0].action, 'installed');
  assert.equal(await fs.readFile(path.join(agentDir, 'workflows', 'octopus-loop.js'), 'utf8'), 'export async function run() {}\n');

  // plan and status report nothing pending once applied.
  for (const command of ['status']) {
    const clean = run([command, '--repo', repo, '--agent-dir', agentDir]);
    assert.equal(clean.status, 0, clean.stderr);
    assert.deepEqual(result(clean).actions, []);
  }

  // Removal with --keep-local is repository-only: manifest entry and
  // repository content are gone, the local installation is unchanged, and the
  // resource is reported stale.
  const removed = run(['remove', '--target', 'workflows/octopus-loop.js', '--keep-local', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(removed.status, 0, removed.stderr);
  const removedOutput = result(removed);
  assert.deepEqual(removedOutput.removed, { type: 'workflow', source: 'resources/workflows/octopus-loop.js', target: 'workflows/octopus-loop.js' });
  assert.equal(removedOutput.local.action, 'unchanged');
  await assert.rejects(fs.access(path.join(repo, 'resources', 'workflows', 'octopus-loop.js')));
  assert.equal(await fs.readFile(path.join(agentDir, 'workflows', 'octopus-loop.js'), 'utf8'), 'export async function run() {}\n');

  const stale = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(stale.status, 0, stale.stderr);
  const staleOutput = result(stale);
  assert.deepEqual(staleOutput.staleResources.map((item) => item.target), ['workflows/octopus-loop.js']);
  assert.equal(staleOutput.actions.find((item) => item.target === 'workflows/octopus-loop.js').action, 'stale');

  // remove --stale removes the local file copy.
  const pruned = run(['remove', '--stale', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(pruned.status, 0, pruned.stderr);
  assert.deepEqual(result(pruned).staleResources.map((item) => item.target), ['workflows/octopus-loop.js']);
  await assert.rejects(fs.access(path.join(agentDir, 'workflows', 'octopus-loop.js')));
});

test('multi-file extension directories are managed end to end with the same three-way semantics', async (t) => {
  const { repo, agentDir } = await extendedFixture(t);
  const response = run(['add', '--target', 'extensions/github-copilot-usage', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(response.status, 0, response.stderr);
  assert.equal(result(response).repositorySource, 'resources/extensions/github-copilot-usage');
  const first = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(result(first).actions, []);

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
  const response = run(['add', '--target', 'extensions/subagent/config.json', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(response.status, 0, response.stderr);
  const first = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(result(first).actions, []);
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
  const symlink = run(['add', '--target', 'prompts/linked.md', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(symlink.status, 2, symlink.stderr);
  assert.match(result(symlink).error, /symbolic link/i);
  await assert.rejects(fs.access(path.join(repo, 'resources', 'prompts', 'linked.md')));
  await fs.rm(path.join(agentDir, 'prompts', 'linked.md'));

  // Path traversal is rejected before any import.
  const traversal = run(['add', '--target', 'prompts/../../outside.md', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(traversal.status, 2);
  assert.match(result(traversal).error, /.. path segments/);

  // A source outside the type root is rejected.
  const wrongRoot = run(['add', '--target', 'unknown/deploy.md', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(wrongRoot.status, 2);
  assert.match(result(wrongRoot).error, /--target must identify a resource/);

  // A non-.md file is rejected for prompt types.
  const wrongShape = run(['add', '--target', 'agents/reviewer.txt', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(wrongShape.status, 2);
  assert.match(result(wrongShape).error, /Agent target must be a \.md file directly under agents\//);

  // Re-adding an already-declared exact source and target is an idempotent no-op.
  const initial = run(['add', '--target', 'prompts/deploy.md', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(initial.status, 0, initial.stderr);
  const repeated = run(['add', '--target', 'prompts/deploy.md', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(result(repeated).action, 'already-added');

  // Repository-only content is declared without a local copy or import.
  await fs.mkdir(path.join(repo, 'resources', 'agents'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'agents', 'new-agent.md'), '# Existing\n');
  const repositoryOnly = run(['add', '--target', 'agents/new-agent.md', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(repositoryOnly.status, 0, repositoryOnly.stderr);
  assert.equal(result(repositoryOnly).action, 'declared');
  await assert.rejects(fs.access(path.join(agentDir, 'agents', 'new-agent.md')));

  // Likely secret material stops the import before anything is copied.
  await fs.writeFile(path.join(agentDir, 'extensions', 'subagent', 'config.json'), 'apiKey = "ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ"\n');
  const secret = run(['add', '--target', 'extensions/subagent/config.json', '--repo', repo, '--agent-dir', agentDir]);
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
  const packageCode = run(['add', '--target', 'extensions/github-copilot-usage', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(packageCode.status, 2);
  assert.match(result(packageCode).error, /node_modules/);
  await assert.rejects(fs.access(path.join(repo, 'resources', 'extensions', 'github-copilot-usage')));
  await fs.rm(path.join(agentDir, 'extensions', 'github-copilot-usage', 'node_modules'), { recursive: true });
});

test('add declares a repository-present resource and never touches the local installation', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  await fs.mkdir(path.join(repo, 'resources', 'prompts'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'prompts', 'deploy.md'), '# Repository prompt\n');

  // --agent-dir is not required: register operates on the repository only.
  const registered = run(['add', '--target', 'prompts/deploy.md', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(registered.status, 0, registered.stderr);
  const output = result(registered);
  assert.equal(output.apiVersion, 2);
  assert.equal(output.command, 'add');
  assert.equal(output.ok, true);
  assert.equal(output.exitCode, 0);
  assert.equal(output.type, 'prompt');
  assert.equal(output.source, 'prompts/deploy.md');
  assert.equal(output.target, 'prompts/deploy.md');
  assert.equal(output.action, 'declared');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.deepEqual(manifest.resources.at(-1), { type: 'prompt', source: 'resources/prompts/deploy.md', target: 'prompts/deploy.md' });

  // No import or copy: the local installation is not created or modified.
  await assert.rejects(fs.access(path.join(agentDir, 'prompts')));
  assert.equal(await fs.readFile(path.join(agentDir, 'skills', 'local-only', 'SKILL.md'), 'utf8'), '# Local\n');

  // --agent-dir is not used even when supplied: a missing directory is not created.
  const missingAgentDir = path.join(path.dirname(agentDir), 'no-such-agent');
  await fs.writeFile(path.join(repo, 'resources', 'prompts', 'second.md'), '# Second prompt\n');
  const withAgentFlag = run(['add', '--target', 'prompts/second.md', '--repo', repo, '--agent-dir', missingAgentDir]);
  assert.equal(withAgentFlag.status, 0, withAgentFlag.stderr);
  assert.equal(result(withAgentFlag).action, 'declared');
  await assert.rejects(fs.access(missingAgentDir));
});

test('add declares identical repository and local content without copying and rejects differing copies', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const localPath = path.join(agentDir, 'prompts', 'deploy.md');
  const repositoryPath = path.join(repo, 'resources', 'prompts', 'deploy.md');
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.mkdir(path.dirname(repositoryPath), { recursive: true });
  await fs.writeFile(localPath, '# Same content\n');
  await fs.writeFile(repositoryPath, '# Same content\n');

  const first = run(['add', '--target', 'prompts/deploy.md', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(first.status, 0, first.stderr);
  const output = result(first);
  assert.equal(output.action, 'declared');
  assert.match(output.note, /repository and local content match/i);
  assert.equal(await fs.readFile(localPath, 'utf8'), '# Same content\n');
  assert.equal(await fs.readFile(repositoryPath, 'utf8'), '# Same content\n');

  const manifestPath = path.join(repo, 'pi-sync.json');
  const manifestBefore = await fs.readFile(manifestPath, 'utf8');
  await fs.writeFile(localPath, '# Different content\n');
  const collision = run(['add', '--target', 'prompts/deploy.md', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(collision.status, 2, collision.stderr);
  const failure = result(collision);
  assert.equal(failure.errorCode, 'RESOURCE_COLLISION');
  assert.ok(failure.error.includes(localPath));
  assert.ok(failure.error.includes(repositoryPath));
  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestBefore);
  assert.equal(await fs.readFile(localPath, 'utf8'), '# Different content\n');
  assert.equal(await fs.readFile(repositoryPath, 'utf8'), '# Same content\n');
});

test('add works for every resource type with repository-present content', async (t) => {
  const { repo, agentDir } = await fixture(t);
  await fs.mkdir(path.join(repo, 'resources', 'skills', 'alpha'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'alpha', 'SKILL.md'), '# Alpha\n');
  await fs.mkdir(path.join(repo, 'resources', 'extensions', 'alpha-ext'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'extensions', 'alpha-ext', 'index.ts'), 'export const alpha = true;\n');
  await fs.writeFile(path.join(repo, 'resources', 'extensions', 'alpha-config.json'), `${JSON.stringify({ model: 'local-model' }, null, 2)}\n`);
  await fs.mkdir(path.join(repo, 'resources', 'prompts'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'prompts', 'deploy.md'), '# Deploy prompt\n');
  await fs.mkdir(path.join(repo, 'resources', 'agents'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'agents', 'reviewer.md'), '# Reviewer agent\n');
  await fs.mkdir(path.join(repo, 'resources', 'roles'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'roles', 'moderator.md'), '# Moderator role\n');
  const registrations = [
    ['skill', 'resources/skills/alpha', 'skills/alpha'],
    ['extension', 'resources/extensions/alpha-ext', 'extensions/alpha-ext'],
    ['extension', 'resources/extensions/alpha-config.json', 'extensions/alpha-config.json'],
    ['prompt', 'resources/prompts/deploy.md', 'prompts/deploy.md'],
    ['agent', 'resources/agents/reviewer.md', 'agents/reviewer.md'],
    ['role', 'resources/roles/moderator.md', 'roles/moderator.md'],
  ];
  for (const [type, source, target] of registrations) {
    const response = run(['add', '--target', target, '--repo', repo]);
    assert.equal(response.status, 0, `${type} ${source}: ${response.stderr}\n${response.stdout}`);
    const output = result(response);
    assert.equal(output.action, 'declared');
    assert.equal(output.type, type);
    assert.equal(output.source, target);
    assert.equal(output.target, target);
  }
  const manifest = JSON.parse(await fs.readFile(path.join(repo, 'pi-sync.json'), 'utf8'));
  assert.deepEqual(manifest.resources.slice(1), registrations.map(([type, source, target]) => ({ type, source, target })));
  // Nothing was copied into the local installation.
  for (const [, , target] of registrations) {
    await assert.rejects(fs.access(path.join(agentDir, ...target.split('/'))));
  }
});

test('add is idempotent for an exact source and target match', async (t) => {
  const { repo } = await fixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  await fs.mkdir(path.join(repo, 'resources', 'prompts'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'prompts', 'deploy.md'), '# Repository prompt\n');
  const first = run(['add', '--target', 'prompts/deploy.md', '--repo', repo]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(result(first).action, 'declared');
  const manifestBefore = await fs.readFile(manifestPath, 'utf8');

  const second = run(['add', '--target', 'prompts/deploy.md', '--repo', repo]);
  assert.equal(second.status, 0, second.stderr);
  const output = result(second);
  assert.equal(output.apiVersion, 2);
  assert.equal(output.command, 'add');
  assert.equal(output.ok, true);
  assert.equal(output.exitCode, 0);
  assert.equal(output.type, 'prompt');
  assert.equal(output.source, 'prompts/deploy.md');
  assert.equal(output.target, 'prompts/deploy.md');
  assert.equal(output.action, 'already-added');
  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestBefore, 'the manifest is unchanged by the no-op');
});

test('add reports RESOURCE_COLLISION for any other overlap and writes nothing', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const writeManifest = (resources) => fs.writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, resources, dependencies: [] }));

  // The target is declared under a different source.
  await fs.mkdir(path.join(repo, 'resources', 'skills', 'renamed'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'renamed', 'SKILL.md'), '# Renamed\n');
  await writeManifest([{ type: 'skill', source: 'resources/skills/renamed', target: 'skills/hello' }]);
  let collision = run(['add', '--target', 'skills/hello', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(collision.status, 2, collision.stderr);
  let output = result(collision);
  assert.equal(output.ok, false);
  assert.equal(output.exitCode, 2);
  assert.equal(output.errorCode, 'RESOURCE_COLLISION');
  assert.match(output.error, /collision/i);
  assert.deepEqual(output.details, { type: 'skill', source: 'skills/hello', target: 'skills/hello', repositorySource: 'resources/skills/hello' });

  // The source is declared under a different target.
  await writeManifest([{ type: 'skill', source: 'resources/skills/hello', target: 'skills/renamed' }]);
  collision = run(['add', '--target', 'skills/hello', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(collision.status, 2, collision.stderr);
  assert.equal(result(collision).errorCode, 'RESOURCE_COLLISION');

  // A nested overlap: the declared target contains the derived target.
  await fs.mkdir(path.join(repo, 'resources', 'extensions', 'subagent'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'extensions', 'subagent', 'config.json'), `${JSON.stringify({ model: 'local-model' }, null, 2)}\n`);
  await writeManifest([{ type: 'extension', source: 'resources/extensions/subagent', target: 'extensions/subagent' }]);
  collision = run(['add', '--target', 'extensions/subagent/config.json', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(collision.status, 2, collision.stderr);
  output = result(collision);
  assert.equal(output.errorCode, 'RESOURCE_COLLISION');
  assert.deepEqual(output.details, { type: 'extension', source: 'extensions/subagent/config.json', target: 'extensions/subagent/config.json', repositorySource: 'resources/extensions/subagent/config.json' });

  // Nothing was written: the manifest keeps its single entry.
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.equal(manifest.resources.length, 1);
});

test('add validates resource targets, requires one mode, and rejects removed selectors', async (t) => {
  const { repo } = await fixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const manifestBefore = await fs.readFile(manifestPath, 'utf8');
  await fs.mkdir(path.join(repo, 'resources', 'prompts'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'prompts', 'deploy.md'), '# Repository prompt\n');

  const failures = [
    { args: ['add', '--target', 'prompts/absent.md', '--repo', repo], message: /does not exist in the setup repository or local installation/ },
    { args: ['add', '--target', 'prompts/nested/deploy.md', '--repo', repo], message: /Prompt target must be a \.md file directly under prompts\// },
    { args: ['add', '--target', 'unknown/example.md', '--repo', repo], message: /--target must identify a resource/ },
    { args: ['add', '--target', 'resources/prompts/deploy.md', '--repo', repo], message: /--target must identify a resource/ },
    { args: ['add', '--repo', repo], message: /add requires --target/ },
    { args: ['add', '--type', 'prompt', '--target', 'prompts/deploy.md', '--repo', repo], message: /Unknown option: --type/ },
    { args: ['add', '--target', 'prompts/deploy.md', '--source', 'npm:example', '--repo', repo], message: /either --target.*--source/ },
  ];
  for (const { args, message } of failures) {
    const response = runRawWith(cli, [...args, '--json']);
    assert.equal(response.status, 2, `${args.join(' ')}: ${response.stderr}\n${response.stdout}`);
    const output = result(response);
    assert.equal(output.ok, false);
    assert.equal(output.exitCode, 2);
    assert.match(output.error, message);
  }
  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestBefore);
});
test('add stops on suspected secret material without registering or echoing the value', async (t) => {
  const { repo } = await fixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const manifestBefore = await fs.readFile(manifestPath, 'utf8');

  // Known credential-store path.
  await fs.mkdir(path.join(repo, 'resources', 'skills', 'leaky'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'leaky', 'SKILL.md'), '# Leaky\n');
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'leaky', 'credentials.json'), `${JSON.stringify({ token: 'placeholder' }, null, 2)}\n`);
  const credential = run(['add', '--target', 'skills/leaky', '--repo', repo]);
  assert.equal(credential.status, 2, credential.stderr);
  const credentialOutput = result(credential);
  assert.equal(credentialOutput.apiVersion, 2);
  assert.equal(credentialOutput.command, 'add');
  assert.equal(credentialOutput.ok, false);
  assert.equal(credentialOutput.exitCode, 2);
  assert.equal(credentialOutput.errorCode, 'SECRET_REVIEW_REQUIRED');
  assert.match(credentialOutput.error, /review suspected secret material/);
  assert.equal(credentialOutput.reviewRequired[0].path, 'resources/skills/leaky/credentials.json');
  assert.match(credentialOutput.reviewRequired[0].reason, /known credential-store path/);
  assert.deepEqual(credentialOutput.details.reviewRequired, credentialOutput.reviewRequired);

  // Likely secret value in a repository prompt.
  await fs.mkdir(path.join(repo, 'resources', 'prompts'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'prompts', 'leak.md'), 'token: ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ\n');
  const secret = run(['add', '--target', 'prompts/leak.md', '--repo', repo]);
  assert.equal(secret.status, 2, secret.stderr);
  const secretOutput = result(secret);
  assert.equal(secretOutput.errorCode, 'SECRET_REVIEW_REQUIRED');
  assert.equal(secretOutput.reviewRequired[0].path, 'resources/prompts/leak.md');
  assert.match(secretOutput.reviewRequired[0].reason, /GitHub token/);
  assert.doesNotMatch(secret.stdout, /ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ/);

  // Sensitive filename.
  await fs.mkdir(path.join(repo, 'resources', 'skills', 'leaky-key'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'leaky-key', 'SKILL.md'), '# Key\n');
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'leaky-key', 'id_rsa'), 'not a real key\n');
  const sensitive = run(['add', '--target', 'skills/leaky-key', '--repo', repo]);
  assert.equal(sensitive.status, 2, sensitive.stderr);
  assert.match(result(sensitive).reviewRequired[0].reason, /sensitive filename/);

  // Nothing was registered.
  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestBefore);
});

test('add rejects symlinks and node_modules in repository content', async (t) => {
  const { repo } = await fixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const manifestBefore = await fs.readFile(manifestPath, 'utf8');
  await fs.writeFile(path.join(repo, 'outside.md'), '# Outside\n');
  await fs.mkdir(path.join(repo, 'resources', 'prompts'), { recursive: true });

  // A symlinked file source is rejected.
  await fs.symlink(path.join(repo, 'outside.md'), path.join(repo, 'resources', 'prompts', 'linked.md'));
  let response = run(['add', '--target', 'prompts/linked.md', '--repo', repo]);
  assert.equal(response.status, 2, response.stderr);
  assert.match(result(response).error, /Symbolic links are not supported/);
  await fs.rm(path.join(repo, 'resources', 'prompts', 'linked.md'));

  // A symlinked directory source is rejected.
  await fs.mkdir(path.join(repo, 'elsewhere', 'real'), { recursive: true });
  await fs.writeFile(path.join(repo, 'elsewhere', 'real', 'SKILL.md'), '# Real\n');
  await fs.symlink(path.join(repo, 'elsewhere', 'real'), path.join(repo, 'resources', 'skills', 'linked-skill'));
  response = run(['add', '--target', 'skills/linked-skill', '--repo', repo]);
  assert.equal(response.status, 2, response.stderr);
  assert.match(result(response).error, /symbolic links?/i);
  await fs.rm(path.join(repo, 'resources', 'skills', 'linked-skill'));

  // A symbolic link inside the resource is rejected.
  await fs.mkdir(path.join(repo, 'resources', 'skills', 'inner-link'), { recursive: true });
  await fs.symlink(path.join(repo, 'outside.md'), path.join(repo, 'resources', 'skills', 'inner-link', 'linked.md'));
  response = run(['add', '--target', 'skills/inner-link', '--repo', repo]);
  assert.equal(response.status, 2, response.stderr);
  assert.match(result(response).error, /Symbolic links are not supported/);
  await fs.rm(path.join(repo, 'resources', 'skills', 'inner-link'), { recursive: true });

  // Package-installed code is rejected.
  await fs.mkdir(path.join(repo, 'resources', 'skills', 'with-packages', 'node_modules', 'pinned'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'with-packages', 'node_modules', 'pinned', 'index.js'), 'module.exports = 1;\n');
  response = run(['add', '--target', 'skills/with-packages', '--repo', repo]);
  assert.equal(response.status, 2, response.stderr);
  assert.match(result(response).error, /node_modules/);

  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestBefore);
});

test('add never commits or pushes: only the manifest changes in the working tree', async (t) => {
  const { repo, bare } = await pushFixture(t);
  await fs.mkdir(path.join(repo, 'resources', 'agents'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'agents', 'reviewer.md'), '# Reviewer agent\n');
  const headBefore = gitAt(repo, ['rev-parse', 'HEAD']);
  const logBefore = gitAt(repo, ['log', '--oneline']);
  const remoteHeadBefore = gitAt(bare, ['rev-parse', 'HEAD']);

  const response = run(['add', '--target', 'agents/reviewer.md', '--repo', repo]);
  assert.equal(response.status, 0, response.stderr);
  assert.equal(result(response).action, 'declared');

  // No commit or push: the working tree holds only the manifest edit and the
  // untracked resource, and local and remote history are unchanged.
  const status = gitAt(repo, ['status', '--porcelain']).split('\n').filter(Boolean);
  assert.equal(status.length, 2, `unexpected working-tree state: ${status.join(' | ')}`);
  assert.ok(status.some((line) => line.includes('M') && line.includes('pi-sync.json')), 'the manifest edit remains uncommitted in the working tree');
  assert.ok(status.some((line) => line.startsWith('??') && line.includes('resources/agents')), 'the new resource remains untracked');
  assert.equal(gitAt(repo, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(gitAt(repo, ['log', '--oneline']), logBefore);
  assert.equal(gitAt(bare, ['rev-parse', 'HEAD']), remoteHeadBefore);
});

test('add validates the repository up front and changes nothing on failure', async (t) => {
  const { repo } = await fixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const lockPath = path.join(repo, 'pi-sync.lock.json');
  const manifestBefore = await fs.readFile(manifestPath, 'utf8');
  await fs.mkdir(path.join(repo, 'resources', 'prompts'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'prompts', 'deploy.md'), '# Repository prompt\n');

  // A manifest that is not valid JSON fails before register does anything.
  await fs.writeFile(manifestPath, '{ not json');
  let response = run(['add', '--target', 'prompts/deploy.md', '--repo', repo]);
  assert.equal(response.status, 2, response.stderr);
  let output = result(response);
  assert.equal(output.ok, false);
  assert.equal(output.exitCode, 2);
  assert.equal(output.errorCode, 'VALIDATION_ERROR');
  assert.match(output.error, /not valid JSON/);
  await fs.writeFile(manifestPath, manifestBefore);

  // A missing lockfile fails the repository validation up front.
  await fs.rm(lockPath);
  response = run(['add', '--target', 'prompts/deploy.md', '--repo', repo]);
  assert.equal(response.status, 2, response.stderr);
  assert.match(result(response).error, /Missing lockfile/);
  await fs.writeFile(lockPath, JSON.stringify({ schemaVersion: 1, packages: [] }));

  // A declared resource whose repository content is missing fails before registration.
  await fs.rm(path.join(repo, 'resources', 'skills', 'hello'), { recursive: true });
  response = run(['add', '--target', 'prompts/deploy.md', '--repo', repo]);
  assert.equal(response.status, 2, response.stderr);
  output = result(response);
  assert.equal(output.errorCode, 'VALIDATION_ERROR');
  assert.match(output.error, /resources\/skills\/hello/);

  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestBefore);
  assert.equal(await fs.readFile(path.join(repo, 'resources', 'prompts', 'deploy.md'), 'utf8'), '# Repository prompt\n');
});

test('add --list and --all fail on an invalid repository manifest without modifying repository state', async (t) => {
  const { repo } = await fixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const manifestBefore = await fs.readFile(manifestPath, 'utf8');
  const lockPath = path.join(repo, 'pi-sync.lock.json');
  const lockBefore = await fs.readFile(lockPath, 'utf8');
  await fs.mkdir(path.join(repo, 'resources', 'prompts'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'prompts', 'deploy.md'), '# Repository prompt\n');
  const treeOf = async (dir) => {
    const out = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await treeOf(entryPath)));
      else out.push(path.relative(repo, entryPath));
    }
    return out;
  };
  const treeBefore = (await treeOf(path.join(repo, 'resources'))).sort();
  const invalidManifests = [
    ['{ not json', /not valid JSON/],
    [JSON.stringify({ schemaVersion: 2, resources: [], dependencies: [] }), /Manifest must have schemaVersion 1/],
  ];
  for (const mode of ['--list', '--all']) {
    for (const [invalid, message] of invalidManifests) {
      await fs.writeFile(manifestPath, invalid);
      const response = run(['add', mode, '--repo', repo]);
      assert.equal(response.status, 2, `${mode}: ${response.stderr}\n${response.stdout}`);
      const output = result(response);
      assert.equal(output.apiVersion, 2);
      assert.equal(output.command, 'add');
      assert.equal(output.ok, false);
      assert.equal(output.exitCode, 2);
      assert.equal(output.errorCode, 'VALIDATION_ERROR');
      assert.match(output.error, message);
      // The invalid manifest is left exactly as written and nothing else in
      // the repository is touched.
      assert.equal(await fs.readFile(manifestPath, 'utf8'), invalid);
      assert.equal(await fs.readFile(lockPath, 'utf8'), lockBefore);
      assert.deepEqual((await treeOf(path.join(repo, 'resources'))).sort(), treeBefore);
    }
  }
  await fs.writeFile(manifestPath, manifestBefore);
});

test('add --list reports exactly the unregistered resources and changes nothing', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const manifestBefore = await fs.readFile(manifestPath, 'utf8');
  // Unregistered resources across every type root.
  await fs.mkdir(path.join(repo, 'resources', 'skills', 'alpha'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'alpha', 'SKILL.md'), '# Alpha\n');
  await fs.mkdir(path.join(repo, 'resources', 'extensions', 'alpha-ext'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'extensions', 'alpha-ext', 'index.ts'), 'export const alpha = true;\n');
  await fs.writeFile(path.join(repo, 'resources', 'extensions', 'alpha-config.json'), `${JSON.stringify({ model: 'local-model' }, null, 2)}\n`);
  await fs.mkdir(path.join(repo, 'resources', 'prompts'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'prompts', 'deploy.md'), '# Deploy prompt\n');
  await fs.mkdir(path.join(repo, 'resources', 'agents'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'agents', 'reviewer.md'), '# Reviewer agent\n');
  await fs.mkdir(path.join(repo, 'resources', 'roles'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'roles', 'moderator.md'), '# Moderator role\n');
  // Non-resources: other paths in resources/, a non-.md file, a nested
  // file, and symlinked entries are not candidates.
  await fs.writeFile(path.join(repo, 'resources', 'README.md'), '# Repository notes\n');
  await fs.writeFile(path.join(repo, 'resources', 'prompts', 'notes.txt'), 'not a prompt\n');
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'hello', 'inner.md'), '# Inner\n');
  await fs.writeFile(path.join(repo, 'outside.md'), '# Outside\n');
  await fs.symlink(path.join(repo, 'outside.md'), path.join(repo, 'resources', 'prompts', 'linked.md'));
  await fs.mkdir(path.join(repo, 'elsewhere'), { recursive: true });
  await fs.symlink(path.join(repo, 'elsewhere'), path.join(repo, 'resources', 'skills', 'linked-skill'));

  const treeOf = async (dir) => {
    const out = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await treeOf(entryPath)));
      else out.push(path.relative(repo, entryPath));
    }
    return out;
  };
  const resourcesDir = path.join(repo, 'resources');
  const treeBefore = (await treeOf(resourcesDir)).sort();

  const response = run(['add', '--list', '--repo', repo]);
  assert.equal(response.status, 0, response.stderr);
  const output = result(response);
  assert.equal(output.apiVersion, 2);
  assert.equal(output.command, 'add');
  assert.equal(output.ok, true);
  assert.equal(output.exitCode, 0);
  assert.deepEqual(output.unregistered, [
    { type: 'skill', source: 'resources/skills/alpha', target: 'skills/alpha' },
    { type: 'extension', source: 'resources/extensions/alpha-config.json', target: 'extensions/alpha-config.json' },
    { type: 'extension', source: 'resources/extensions/alpha-ext', target: 'extensions/alpha-ext' },
    { type: 'prompt', source: 'resources/prompts/deploy.md', target: 'prompts/deploy.md' },
    { type: 'agent', source: 'resources/agents/reviewer.md', target: 'agents/reviewer.md' },
    { type: 'role', source: 'resources/roles/moderator.md', target: 'roles/moderator.md' },
  ]);

  // Read-only: the manifest and the repository tree are unchanged, and the
  // local installation is untouched.
  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestBefore);
  assert.deepEqual((await treeOf(resourcesDir)).sort(), treeBefore);
  assert.equal(await fs.readFile(path.join(agentDir, 'skills', 'local-only', 'SKILL.md'), 'utf8'), '# Local\n');
});

test('add --list and --all scan every inferred type root; --type is rejected', async (t) => {
  const { repo } = await fixture(t);
  await fs.mkdir(path.join(repo, 'resources', 'prompts'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'prompts', 'deploy.md'), '# Deploy prompt\n');
  await fs.mkdir(path.join(repo, 'resources', 'agents'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'agents', 'reviewer.md'), '# Reviewer agent\n');

  const response = run(['add', '--list', '--repo', repo]);
  assert.equal(response.status, 0, response.stderr);
  assert.deepEqual(result(response).unregistered, [
    { type: 'prompt', source: 'resources/prompts/deploy.md', target: 'prompts/deploy.md' },
    { type: 'agent', source: 'resources/agents/reviewer.md', target: 'agents/reviewer.md' },
  ]);
  const typed = runRawWith(cli, ['add', '--list', '--type', 'prompt', '--repo', repo, '--json']);
  assert.equal(typed.status, 2);

  const all = run(['add', '--all', '--repo', repo]);
  assert.equal(all.status, 0, all.stderr);
  assert.equal(result(all).action, 'registered');
  assert.deepEqual(result(all).registered, [
    { type: 'prompt', source: 'resources/prompts/deploy.md', target: 'prompts/deploy.md' },
    { type: 'agent', source: 'resources/agents/reviewer.md', target: 'agents/reviewer.md' },
  ]);
  const manifest = JSON.parse(await fs.readFile(path.join(repo, 'pi-sync.json'), 'utf8'));
  assert.equal(manifest.resources.length, 3);
});

test('add --all registers every unregistered resource in a single manifest write', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  await fs.mkdir(path.join(repo, 'resources', 'skills', 'alpha'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'alpha', 'SKILL.md'), '# Alpha\n');
  await fs.mkdir(path.join(repo, 'resources', 'extensions', 'alpha-ext'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'extensions', 'alpha-ext', 'index.ts'), 'export const alpha = true;\n');
  await fs.writeFile(path.join(repo, 'resources', 'extensions', 'alpha-config.json'), `${JSON.stringify({ model: 'local-model' }, null, 2)}\n`);
  await fs.mkdir(path.join(repo, 'resources', 'prompts'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'prompts', 'deploy.md'), '# Deploy prompt\n');
  await fs.mkdir(path.join(repo, 'resources', 'agents'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'agents', 'reviewer.md'), '# Reviewer agent\n');
  await fs.mkdir(path.join(repo, 'resources', 'roles'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'roles', 'moderator.md'), '# Moderator role\n');

  const response = run(['add', '--all', '--repo', repo]);
  assert.equal(response.status, 0, response.stderr);
  const output = result(response);
  assert.equal(output.apiVersion, 2);
  assert.equal(output.command, 'add');
  assert.equal(output.ok, true);
  assert.equal(output.exitCode, 0);
  assert.equal(output.action, 'registered');
  assert.deepEqual(output.registered, [
    { type: 'skill', source: 'resources/skills/alpha', target: 'skills/alpha' },
    { type: 'extension', source: 'resources/extensions/alpha-config.json', target: 'extensions/alpha-config.json' },
    { type: 'extension', source: 'resources/extensions/alpha-ext', target: 'extensions/alpha-ext' },
    { type: 'prompt', source: 'resources/prompts/deploy.md', target: 'prompts/deploy.md' },
    { type: 'agent', source: 'resources/agents/reviewer.md', target: 'agents/reviewer.md' },
    { type: 'role', source: 'resources/roles/moderator.md', target: 'roles/moderator.md' },
  ]);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  // The original declaration keeps its position and every new entry is
  // appended in discovery order: one write, no reordering.
  assert.deepEqual(manifest.resources, [
    { type: 'skill', source: 'resources/skills/hello', target: 'skills/hello' },
    { type: 'skill', source: 'resources/skills/alpha', target: 'skills/alpha' },
    { type: 'extension', source: 'resources/extensions/alpha-config.json', target: 'extensions/alpha-config.json' },
    { type: 'extension', source: 'resources/extensions/alpha-ext', target: 'extensions/alpha-ext' },
    { type: 'prompt', source: 'resources/prompts/deploy.md', target: 'prompts/deploy.md' },
    { type: 'agent', source: 'resources/agents/reviewer.md', target: 'agents/reviewer.md' },
    { type: 'role', source: 'resources/roles/moderator.md', target: 'roles/moderator.md' },
  ]);
  // No copy: the local installation is not created or modified.
  for (const { target } of output.registered) await assert.rejects(fs.access(path.join(agentDir, ...target.split('/'))));
  assert.equal(await fs.readFile(path.join(agentDir, 'skills', 'local-only', 'SKILL.md'), 'utf8'), '# Local\n');
});

test('add --all is a no-op up-to-date when there are no candidates', async (t) => {
  const { repo } = await fixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const manifestBefore = await fs.readFile(manifestPath, 'utf8');
  const response = run(['add', '--all', '--repo', repo]);
  assert.equal(response.status, 0, response.stderr);
  const output = result(response);
  assert.equal(output.apiVersion, 2);
  assert.equal(output.command, 'add');
  assert.equal(output.ok, true);
  assert.equal(output.exitCode, 0);
  assert.equal(output.action, 'up-to-date');
  assert.deepEqual(output.registered, []);
  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestBefore, 'the manifest is unchanged by the no-op');
});

test('add --all secret-scans every candidate and registers nothing on any finding', async (t) => {
  const { repo } = await fixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const manifestBefore = await fs.readFile(manifestPath, 'utf8');
  // A clean candidate plus two candidates with findings.
  await fs.mkdir(path.join(repo, 'resources', 'prompts'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'prompts', 'clean.md'), '# Clean prompt\n');
  await fs.writeFile(path.join(repo, 'resources', 'prompts', 'leak.md'), 'token: ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ\n');
  await fs.mkdir(path.join(repo, 'resources', 'skills', 'leaky'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'leaky', 'SKILL.md'), '# Leaky\n');
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'leaky', 'credentials.json'), `${JSON.stringify({ token: 'placeholder' }, null, 2)}\n`);

  const response = run(['add', '--all', '--repo', repo]);
  assert.equal(response.status, 2, response.stderr);
  const output = result(response);
  assert.equal(output.apiVersion, 2);
  assert.equal(output.command, 'add');
  assert.equal(output.ok, false);
  assert.equal(output.exitCode, 2);
  assert.equal(output.errorCode, 'SECRET_REVIEW_REQUIRED');
  assert.match(output.error, /review suspected secret material/);
  // Every candidate is scanned and all findings are reported.
  assert.deepEqual(output.reviewRequired, [
    { path: 'resources/skills/leaky/credentials.json', reason: 'known credential-store path' },
    { path: 'resources/prompts/leak.md', reason: 'GitHub token' },
  ]);
  assert.doesNotMatch(response.stdout, /ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ/);
  // All-or-nothing: the clean candidate is not registered either.
  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestBefore);
});

test('add --all performs a collision pre-flight and registers nothing', async (t) => {
  const { repo } = await fixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const writeManifest = (resources) => fs.writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, resources, dependencies: [] }));
  await fs.mkdir(path.join(repo, 'resources', 'skills', 'renamed'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'renamed', 'SKILL.md'), '# Renamed\n');

  // A candidate whose target is declared under a different source collides.
  await writeManifest([{ type: 'skill', source: 'resources/skills/renamed', target: 'skills/hello' }]);
  let manifestText = await fs.readFile(manifestPath, 'utf8');
  let response = run(['add', '--all', '--repo', repo]);
  assert.equal(response.status, 2, response.stderr);
  let output = result(response);
  assert.equal(output.apiVersion, 2);
  assert.equal(output.command, 'add');
  assert.equal(output.ok, false);
  assert.equal(output.exitCode, 2);
  assert.equal(output.errorCode, 'RESOURCE_COLLISION');
  assert.match(output.error, /collision/i);
  assert.deepEqual(output.details, {
    source: 'resources/skills/hello',
    target: 'skills/hello',
    conflictingSource: 'resources/skills/renamed',
    conflictingTarget: 'skills/hello',
  });
  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestText);

  // Candidates that overlap only case-insensitively collide against the
  // candidate set itself; a case-sensitive filesystem is required.
  const probe = path.join(repo, 'case-probe');
  await fs.mkdir(probe);
  let caseSensitive = true;
  try {
    await fs.mkdir(path.join(probe, 'Case'));
    await fs.mkdir(path.join(probe, 'case'));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    caseSensitive = false;
  }
  await fs.rm(probe, { recursive: true, force: true });
  if (caseSensitive) {
    await fs.mkdir(path.join(repo, 'resources', 'extensions', 'Foo'), { recursive: true });
    await fs.writeFile(path.join(repo, 'resources', 'extensions', 'Foo', 'index.ts'), 'export const foo = true;\n');
    await fs.writeFile(path.join(repo, 'resources', 'extensions', 'foo'), 'module.exports = 1;\n');
    await writeManifest([]);
    manifestText = await fs.readFile(manifestPath, 'utf8');
    response = run(['add', '--all', '--repo', repo]);
    assert.equal(response.status, 2, response.stderr);
    output = result(response);
    assert.equal(output.errorCode, 'RESOURCE_COLLISION');
    assert.deepEqual(output.details, {
      source: 'resources/extensions/Foo',
      target: 'extensions/Foo',
      conflictingSource: 'resources/extensions/foo',
      conflictingTarget: 'extensions/foo',
    });
    assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestText);
  }
});

test('add --all reports RESOURCE_COLLISION for a candidate whose source is declared under a different target', async (t) => {
  const { repo } = await fixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  // The candidate's source is already declared, under a different target.
  await fs.mkdir(path.join(repo, 'resources', 'skills', 'renamed'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'renamed', 'SKILL.md'), '# Renamed\n');
  await fs.writeFile(manifestPath, JSON.stringify({
    schemaVersion: 1,
    resources: [
      { type: 'skill', source: 'resources/skills/hello', target: 'skills/hello' },
      { type: 'skill', source: 'resources/skills/renamed', target: 'skills/other' },
    ],
    dependencies: [],
  }));
  const manifestBefore = await fs.readFile(manifestPath, 'utf8');

  // --list reports the candidate under its inferred source and derived target.
  const list = run(['add', '--list', '--repo', repo]);
  assert.equal(list.status, 0, list.stderr);
  const listOutput = result(list);
  assert.equal(listOutput.ok, true);
  assert.equal(listOutput.exitCode, 0);
  assert.deepEqual(listOutput.unregistered, [
    { type: 'skill', source: 'resources/skills/renamed', target: 'skills/renamed' },
  ]);

  // --all refuses the batch: the candidate's source is already declared.
  const batch = run(['add', '--all', '--repo', repo]);
  assert.equal(batch.status, 2, batch.stderr);
  const output = result(batch);
  assert.equal(output.apiVersion, 2);
  assert.equal(output.command, 'add');
  assert.equal(output.ok, false);
  assert.equal(output.exitCode, 2);
  assert.equal(output.errorCode, 'RESOURCE_COLLISION');
  assert.match(output.error, /collision/i);
  assert.deepEqual(output.details, {
    source: 'resources/skills/renamed',
    target: 'skills/renamed',
    conflictingSource: 'resources/skills/renamed',
    conflictingTarget: 'skills/other',
  });
  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestBefore, 'the manifest is byte-identical after the collision');
});

test('add --all validates repository content for every candidate before writing', async (t) => {
  const { repo } = await fixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const manifestBefore = await fs.readFile(manifestPath, 'utf8');
  // A clean candidate plus a skill whose repository content is not
  // registrable: package-installed code inside the resource.
  await fs.mkdir(path.join(repo, 'resources', 'prompts'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'prompts', 'clean.md'), '# Clean prompt\n');
  await fs.mkdir(path.join(repo, 'resources', 'skills', 'with-packages', 'node_modules', 'pinned'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'with-packages', 'node_modules', 'pinned', 'index.js'), 'module.exports = 1;\n');
  await fs.writeFile(path.join(repo, 'resources', 'skills', 'with-packages', 'SKILL.md'), '# With packages\n');

  const response = run(['add', '--all', '--repo', repo]);
  assert.equal(response.status, 2, response.stderr);
  const output = result(response);
  assert.equal(output.apiVersion, 2);
  assert.equal(output.command, 'add');
  assert.equal(output.ok, false);
  assert.equal(output.exitCode, 2);
  assert.equal(output.errorCode, 'VALIDATION_ERROR');
  assert.match(output.error, /node_modules/);
  // All-or-nothing: the clean candidate is not registered either.
  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestBefore);
});

test('add mode exclusivity: exactly one of --source, --list, or --all', async (t) => {
  const { repo } = await fixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const manifestBefore = await fs.readFile(manifestPath, 'utf8');
  await fs.mkdir(path.join(repo, 'resources', 'prompts'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'prompts', 'deploy.md'), '# Deploy prompt\n');

  const failures = [
    { args: ['add', '--target', 'prompts/deploy.md', '--list', '--repo', repo], message: /--target cannot be combined/ },
    { args: ['add', '--target', 'prompts/deploy.md', '--all', '--repo', repo], message: /--target cannot be combined/ },
    { args: ['add', '--list', '--all', '--repo', repo], message: /--list and --all are mutually exclusive/ },
    { args: ['add', '--list', '--all', '--source', 'resources/prompts/deploy.md', '--repo', repo], message: /--list and --all are mutually exclusive/ },
    { args: ['add', '--type', 'theme', '--list', '--repo', repo], message: /Unknown option: --type/ },
    { args: ['add', '--repo', repo], message: /add requires --target/ },
  ];
  for (const { args, message } of failures) {
    const response = run(args);
    assert.equal(response.status, 2, `${args.join(' ')}: ${response.stderr}\n${response.stdout}`);
    const output = result(response);
    assert.equal(output.ok, false);
    assert.equal(output.exitCode, 2);
    assert.equal(output.errorCode, 'VALIDATION_ERROR');
    assert.match(output.error, message);
  }
  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestBefore);

  // --list and --all are add-only options.
  for (const args of [['status', '--list', '--repo', repo], ['status', '--all', '--repo', repo]]) {
    const response = run(args);
    assert.equal(response.status, 2, response.stderr);
    assert.match(result(response).error, /only supported by add/);
  }
});

test('add reports an accurate concurrency diagnostic when the manifest changes during the write', async (t) => {
  const { repo } = await fixture(t);
  const root = path.dirname(repo);
  const manifestPath = path.join(repo, 'pi-sync.json');
  await fs.mkdir(path.join(repo, 'resources', 'prompts'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'prompts', 'deploy.md'), '# Repository prompt\n');
  // The concurrent change: another process registers a different prompt
  // while this register write is in flight.
  await fs.writeFile(path.join(repo, 'resources', 'prompts', 'concurrent.md'), '# Concurrent prompt\n');
  const concurrentManifest = JSON.stringify({
    schemaVersion: 1,
    resources: [
      { type: 'skill', source: 'resources/skills/hello', target: 'skills/hello' },
      { type: 'prompt', source: 'resources/prompts/concurrent.md', target: 'prompts/concurrent.md' },
    ],
    dependencies: [],
  });
  // Deterministic synchronization: the hold marker makes the atomic writer
  // wait between its temp-file write and its before-rename comparison read,
  // so the concurrent change lands exactly in that window without racing it.
  const marker = path.join(root, 'hold-before-compare');
  await fs.writeFile(marker, '');
  const args = ['add', '--target', 'prompts/deploy.md', '--repo', repo];
  const pending = runAsync(args, { PI_SYNC_TEST_HOLD_BEFORE_COMPARE: marker });
  // Bounded wait for the atomic writer's temp file: its appearance means the
  // write has entered and is held in the comparison window.
  const tempDeadline = Date.now() + 15000;
  for (;;) {
    const tempFile = (await fs.readdir(repo)).find((name) => name.startsWith('pi-sync.json.') && name.endsWith('.tmp'));
    if (tempFile) break;
    if (Date.now() > tempDeadline) {
      await fs.rm(marker, { force: true }); // release the hold so the CLI exits
      await pending;
      assert.fail('the atomic writer did not reach the comparison window in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // Apply the concurrent change while the write is held, then release it.
  await fs.writeFile(manifestPath, concurrentManifest);
  await fs.rm(marker);
  const response = await pending;
  assert.equal(response.status, 2, response.stderr || response.stdout);
  const output = result(response);
  assert.equal(output.apiVersion, 2);
  assert.equal(output.command, 'add');
  assert.equal(output.ok, false);
  assert.equal(output.exitCode, 2);
  assert.equal(output.errorCode, 'VALIDATION_ERROR');
  // The diagnostic names the operation that was actually in flight, keeps
  // the retry guidance, and no longer mislabels the register write as a
  // remove.
  assert.match(output.error, /pi-sync\.json changed during add/);
  assert.doesNotMatch(output.error, /during remove/);
  assert.match(output.error, /retry without overwriting concurrent changes/);
  // The concurrent content is intact: the held write was refused before its
  // rename, so the manifest is still byte-identical to the concurrent change
  // and no temp file from the refused write remains.
  assert.equal(await fs.readFile(manifestPath, 'utf8'), concurrentManifest);
  assert.ok(!(await fs.readdir(repo)).some((name) => name.startsWith('pi-sync.json.') && name.endsWith('.tmp')), 'no temp file from the refused write remains');
  // The retry guidance holds: retrying on top of the concurrent change
  // succeeds and keeps the concurrent entry.
  const retry = run(args);
  assert.equal(retry.status, 0, retry.stderr || retry.stdout);
  assert.equal(result(retry).action, 'declared');
  const finalManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.deepEqual(finalManifest.resources, [
    { type: 'skill', source: 'resources/skills/hello', target: 'skills/hello' },
    { type: 'prompt', source: 'resources/prompts/concurrent.md', target: 'prompts/concurrent.md' },
    { type: 'prompt', source: 'resources/prompts/deploy.md', target: 'prompts/deploy.md' },
  ]);
});

test('add --target --dry-run previews the declaration or import outcome without writing', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const manifestBefore = await fs.readFile(manifestPath, 'utf8');

  // Repository copy present only: the preview reports a declaration.
  await fs.mkdir(path.join(repo, 'resources', 'prompts'), { recursive: true });
  await fs.writeFile(path.join(repo, 'resources', 'prompts', 'deploy.md'), '# Repository prompt\n');
  const declare = runRawWith(cli, ['add', '--target', 'prompts/deploy.md', '--dry-run', '--repo', repo, '--agent-dir', agentDir, '--json']);
  assert.equal(declare.status, 0, declare.stderr);
  const declareOut = result(declare);
  assert.equal(declareOut.command, 'add');
  assert.equal(declareOut.ok, true);
  assert.equal(declareOut.exitCode, 0);
  assert.equal(declareOut.mode, 'preview');
  assert.equal(declareOut.action, 'declared');
  assert.equal(declareOut.type, 'prompt');
  assert.equal(declareOut.target, 'prompts/deploy.md');
  assert.equal(declareOut.repositorySource, 'resources/prompts/deploy.md');
  // The preview declares without copying: the local installation is untouched.
  await assert.rejects(fs.access(path.join(agentDir, 'prompts')));

  // Local copy present only: the preview reports an import.
  const importRes = runRawWith(cli, ['add', '--target', 'skills/local-only', '--dry-run', '--repo', repo, '--agent-dir', agentDir, '--json']);
  assert.equal(importRes.status, 0, importRes.stderr);
  const importOut = result(importRes);
  assert.equal(importOut.mode, 'preview');
  assert.equal(importOut.action, 'added');
  // The preview imports without copying: the repository is untouched.
  await assert.rejects(fs.access(path.join(repo, 'resources', 'skills', 'local-only')));

  // Both copies present and identical: the preview declares and notes the match.
  const localPath = path.join(agentDir, 'prompts', 'deploy.md');
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, '# Repository prompt\n');
  const match = result(runRawWith(cli, ['add', '--target', 'prompts/deploy.md', '--dry-run', '--repo', repo, '--agent-dir', agentDir, '--json']));
  assert.equal(match.action, 'declared');
  assert.equal(match.mode, 'preview');
  assert.match(match.note, /repository and local content match/i);
  // Re-adding an already-declared exact source+target stays an idempotent no-op in preview too.
  const already = result(runRawWith(cli, ['add', '--target', 'skills/hello', '--dry-run', '--repo', repo, '--agent-dir', agentDir, '--json']));
  assert.equal(already.exitCode, 0);
  assert.equal(already.action, 'already-added');
  assert.equal(already.mode, 'preview');

  // Nothing was written by any preview: the manifest is byte-identical.
  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestBefore);
});

test('add --target --dry-run reports collisions and validation errors without writing', async (t) => {
  const { repo, agentDir } = await fixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const manifestBefore = await fs.readFile(manifestPath, 'utf8');

  // Both copies present and differing: a collision that fails closed, naming both paths.
  const localPath = path.join(agentDir, 'prompts', 'deploy.md');
  const repositoryPath = path.join(repo, 'resources', 'prompts', 'deploy.md');
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.mkdir(path.dirname(repositoryPath), { recursive: true });
  await fs.writeFile(localPath, '# Local\n');
  await fs.writeFile(repositoryPath, '# Repository\n');
  const collision = runRawWith(cli, ['add', '--target', 'prompts/deploy.md', '--dry-run', '--repo', repo, '--agent-dir', agentDir, '--json']);
  assert.equal(collision.status, 2, collision.stderr);
  const collisionOut = result(collision);
  assert.equal(collisionOut.ok, false);
  assert.equal(collisionOut.errorCode, 'RESOURCE_COLLISION');
  assert.ok(collisionOut.error.includes(localPath));
  assert.ok(collisionOut.error.includes(repositoryPath));
  await fs.rm(path.join(agentDir, 'prompts'), { recursive: true });
  await fs.rm(path.join(repo, 'resources', 'prompts'), { recursive: true });

  // Neither copy present: a validation error.
  const missing = runRawWith(cli, ['add', '--target', 'prompts/absent.md', '--dry-run', '--repo', repo, '--agent-dir', agentDir, '--json']);
  assert.equal(missing.status, 2, missing.stderr);
  assert.match(result(missing).error, /does not exist in the setup repository or local installation/);

  // Suspected secret material: reported with nothing written.
  const secretPath = path.join(agentDir, 'skills', 'local-only', 'notes.md');
  await fs.writeFile(secretPath, 'Example token: ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ\n');
  const secret = runRawWith(cli, ['add', '--target', 'skills/local-only', '--dry-run', '--repo', repo, '--agent-dir', agentDir, '--json']);
  assert.equal(secret.status, 2, secret.stderr);
  const secretOut = result(secret);
  assert.equal(secretOut.errorCode, 'SECRET_REVIEW_REQUIRED');
  assert.equal(secretOut.reviewRequired[0].path, 'skills/local-only/notes.md');
  await fs.rm(secretPath);

  // Nothing was written by any error preview: manifest unchanged, no import.
  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestBefore);
  await assert.rejects(fs.access(path.join(repo, 'resources', 'skills', 'local-only')));
});

test('add --source --dry-run previews the dependency declaration without writing', async (t) => {
  const { repo } = await fixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const lockPath = path.join(repo, 'pi-sync.lock.json');
  const manifestBefore = await fs.readFile(manifestPath, 'utf8');

  // A dependency not yet declared: the preview reports an addition.
  const declare = runRawWith(cli, ['add', '--source', 'npm:example-package', '--dry-run', '--repo', repo, '--json']);
  assert.equal(declare.status, 0, declare.stderr);
  const output = result(declare);
  assert.equal(output.command, 'add');
  assert.equal(output.ok, true);
  assert.equal(output.mode, 'preview');
  assert.equal(output.action, 'added');
  assert.equal(output.type, 'dependency');
  assert.deepEqual(output.dependency, { type: 'npm', name: 'example-package' });
  // The preview declares without writing: the manifest is unchanged.
  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestBefore);

  // An already-declared dependency is a collision in preview too.
  await fs.writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, resources: [], dependencies: [{ type: 'npm', name: 'example-package' }] }));
  await fs.writeFile(lockPath, JSON.stringify({ schemaVersion: 1, packages: [{ type: 'npm', name: 'example-package', version: '1.2.3', releasedAt: '2024-01-01T00:00:00.000Z' }] }));
  const collision = runRawWith(cli, ['add', '--source', 'npm:example-package', '--dry-run', '--repo', repo, '--json']);
  assert.equal(collision.status, 2, collision.stderr);
  assert.equal(result(collision).errorCode, 'DEPENDENCY_COLLISION');
  // Still nothing was written.
  assert.equal(await fs.readFile(manifestPath, 'utf8'), JSON.stringify({ schemaVersion: 1, resources: [], dependencies: [{ type: 'npm', name: 'example-package' }] }));
});

test('add --list and add --all reject --dry-run because discovery is read-only', async (t) => {
  const { repo } = await fixture(t);
  const list = runRawWith(cli, ['add', '--list', '--dry-run', '--repo', repo, '--json']);
  assert.equal(list.status, 2, list.stdout);
  assert.match(JSON.parse(list.stdout).error, /not supported with --list/);
  const all = runRawWith(cli, ['add', '--all', '--dry-run', '--repo', repo, '--json']);
  assert.equal(all.status, 2, all.stdout);
  assert.match(JSON.parse(all.stdout).error, /not supported with --all/);
  // A bare --dry-run with no selector still fails on the missing selector.
  const bare = runRawWith(cli, ['add', '--dry-run', '--repo', repo, '--json']);
  assert.equal(bare.status, 2, bare.stdout);
  assert.match(JSON.parse(bare.stdout).error, /add requires --target/);
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

test('stale new-type resources are reported and remove --stale removes managed file resources', async (t) => {
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
  const preview = run(['remove', '--stale', '--dry-run', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.deepEqual(result(preview).staleResources.map((item) => item.action).sort(), ['would-prune', 'would-prune']);
  await fs.access(path.join(agentDir, 'prompts', 'deploy.md'));

  // Confirmed prune removes the local file copies and their state entries.
  const pruned = run(['remove', '--stale', '--repo', repo, '--agent-dir', agentDir]);
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
  const prunedDir = run(['remove', '--stale', '--repo', repo, '--agent-dir', agentDir]);
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
  const retained = run(['remove', '--stale', '--repo', repo, '--agent-dir', agentDir]);
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
  const added = run(['add', '--target', 'prompts/deploy.md', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(added.status, 0, added.stderr);
  const first = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(result(first).actions, []);
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

  const planned = run(['status', '--repo', repo, '--agent-dir', agentDir]);
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
  const added = run(['add', '--target', 'extensions/tool', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(added.status, 0, added.stderr);
  const first = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(result(first).actions, []);
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

  const planned = run(['status', '--repo', repo, '--agent-dir', agentDir]);
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
  const added = run(['add', '--target', 'prompts/deploy.md', '--repo', repo, '--agent-dir', agentDir]);
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
    assert.deepEqual(result(repeated).actions, []);
  } finally {
    process.umask(previousUmask);
  }
});

test('a failed file apply restores the previous file through rollback and keeps the baseline', async (t) => {
  const { repo, agentDir } = await extendedFixture(t);
  const added = run(['add', '--target', 'prompts/deploy.md', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(added.status, 0, added.stderr);
  const first = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(result(first).actions, []);
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

test('remove --keep-local deletes managed resources and dependencies from the repository without touching the local installation', async (t) => {
  const { root, repo, agentDir } = await extendedFixture(t);
  const skillDir = path.join(agentDir, 'skills', 'hello');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Hello\n');
  assert.equal(run(['add', '--target', 'skills/hello', '--repo', repo, '--agent-dir', agentDir]).status, 0);
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
  const applied = run(['apply', '--approve-installs', '--repo', repo, '--agent-dir', agentDir], { ...piEnv, PI_CALL_LOG: log });
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
    const response = run(['remove', '--repo', repo, '--agent-dir', agentDir, '--target', target, '--keep-local'], piEnv);
    assert.equal(response.status, 0, `${type} ${target}: ${response.stderr}\n${response.stdout}`);
    const output = result(response);
    assert.equal(output.apiVersion, 2);
    assert.equal(output.command, 'remove');
    assert.equal(output.ok, true);
    assert.equal(output.exitCode, 0);
    assert.deepEqual(output.removed, { type, source: `resources/${target}`, target });
    assert.equal(output.local.target, target);
    assert.equal(output.local.action, 'unchanged');
    // Repository content and manifest entry are gone.
    await assert.rejects(fs.access(path.join(repo, 'resources', ...target.split('/'))));
    const current = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    assert.equal(current.resources.some((item) => item.target === target), false);
    // The local installation is never modified and nothing is queued: the
    // baseline stays in the local state for the stale report and remove --stale flow.
    const state = JSON.parse(await fs.readFile(path.join(agentDir, '.pi-sync', 'state.json'), 'utf8'));
    assert.ok(state.resources[target], `baseline for ${target} is retained`);
  }
  assert.equal(await fs.readFile(path.join(agentDir, 'skills', 'hello', 'SKILL.md'), 'utf8'), '# Hello\n');
  assert.equal(await fs.readFile(path.join(agentDir, 'extensions', 'github-copilot-usage', 'index.ts'), 'utf8'), 'export const usage = true;\n');
  assert.equal(await fs.readFile(path.join(agentDir, 'prompts', 'deploy.md'), 'utf8'), '# Deploy prompt\n');

  const npmRemoved = run(['remove', '--repo', repo, '--agent-dir', agentDir, '--source', 'npm:fixture-package'], piEnv);
  assert.equal(npmRemoved.status, 0, npmRemoved.stderr);
  const npmOutput = result(npmRemoved);
  assert.deepEqual(npmOutput.removed.dependency, { type: 'npm', name: 'fixture-package' });
  assert.equal(npmOutput.removed.pin.version, '1.0.0');
  assert.equal(npmOutput.localInstallation, 'unchanged');
  const githubRemoved = run(['remove', '--repo', repo, '--agent-dir', agentDir, '--source', 'github:acme/pi-extension'], piEnv);
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
  assert.equal(run(['add', '--target', 'skills/hello', '--repo', repo, '--agent-dir', agentDir]).status, 0);
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
    { args: ['remove', '--repo', repo, '--agent-dir', agentDir, '--target', 'skills/absent'], errorCode: 'REMOVE_TARGET_NOT_FOUND' },
    { args: ['remove', '--repo', repo, '--agent-dir', agentDir, '--source', 'npm:absent'], errorCode: 'REMOVE_DEPENDENCY_NOT_FOUND' },
    { args: ['remove', '--repo', repo, '--agent-dir', agentDir, '--type', 'theme', '--target', 'skills/hello'], errorCode: 'VALIDATION_ERROR' },
    { args: ['remove', '--repo', repo, '--agent-dir', agentDir] },
    { args: ['remove', '--repo', repo, '--agent-dir', agentDir, '--target', 'skills/hello', '--source', 'npm:fixture-package'] },
    { args: ['remove', '--repo', repo, '--agent-dir', agentDir, '--target', 'skills/hello', '--uninstall'], errorCode: 'VALIDATION_ERROR' },
    { args: ['remove', '--repo', repo, '--agent-dir', agentDir, '--target', '../escape'], errorCode: 'VALIDATION_ERROR' },
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
  const invalid = run(['remove', '--repo', repo, '--agent-dir', agentDir, '--target', 'skills/hello']);
  assert.equal(invalid.status, 2, invalid.stderr);
  assert.equal(result(invalid).errorCode, 'VALIDATION_ERROR');
  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestBefore);
  assert.equal(await fs.readFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), 'utf8'), contentBefore);
});
test('remove --target previews the removal set with --dry-run without mutating anything', async (t) => {
  const { repo, agentDir } = await fixture(t);
  assert.equal(run(['apply', '--repo', repo, '--agent-dir', agentDir]).status, 0);
  await fs.writeFile(path.join(agentDir, 'skills', 'hello', 'SKILL.md'), '# Diverged\n');
  const manifestBefore = await fs.readFile(path.join(repo, 'pi-sync.json'), 'utf8');
  const contentBefore = await fs.readFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), 'utf8');

  const preview = run(['remove', '--target', 'skills/hello', '--dry-run', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(preview.status, 0, preview.stderr);
  const output = result(preview);
  assert.equal(output.command, 'remove');
  assert.equal(output.mode, 'preview');
  assert.deepEqual(output.removed, { type: 'skill', source: 'resources/skills/hello', target: 'skills/hello' });
  assert.equal(output.local.target, 'skills/hello');
  assert.equal(output.local.action, 'preserved');
  assert.match(output.local.reason, /diverged/);
  assert.equal(await fs.readFile(path.join(repo, 'pi-sync.json'), 'utf8'), manifestBefore);
  assert.equal(await fs.readFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), 'utf8'), contentBefore);
  assert.equal(await fs.readFile(path.join(agentDir, 'skills', 'hello', 'SKILL.md'), 'utf8'), '# Diverged\n');
  const state = JSON.parse(await fs.readFile(path.join(agentDir, '.pi-sync', 'state.json'), 'utf8'));
  assert.ok(state.resources['skills/hello'], 'baseline is untouched by the preview');
});

test('remove --target fully removes the manifest entry, repository content, and local installation with a backup', async (t) => {
  const { repo, agentDir } = await fixture(t);
  assert.equal(run(['apply', '--repo', repo, '--agent-dir', agentDir]).status, 0);
  const manifestPath = path.join(repo, 'pi-sync.json');

  const preview = run(['remove', '--target', 'skills/hello', '--dry-run', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(result(preview).local.action, 'would-remove');

  const removed = run(['remove', '--target', 'skills/hello', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(removed.status, 0, removed.stderr);
  const output = result(removed);
  assert.equal(output.command, 'remove');
  assert.equal(output.mode, 'applied');
  assert.deepEqual(output.removed, { type: 'skill', source: 'resources/skills/hello', target: 'skills/hello' });
  assert.equal(output.local.target, 'skills/hello');
  assert.equal(output.local.action, 'removed');
  await assert.rejects(fs.access(path.join(agentDir, 'skills', 'hello')));
  await assert.rejects(fs.access(path.join(repo, 'resources', 'skills', 'hello')));
  assert.ok(!JSON.parse(await fs.readFile(manifestPath, 'utf8')).resources.some((item) => item.target === 'skills/hello'));
  const backupRoot = path.join(agentDir, '.pi-sync', 'backups');
  const backupStamp = (await fs.readdir(backupRoot)).at(-1);
  assert.equal(await fs.readFile(path.join(backupRoot, backupStamp, 'skills', 'hello', 'SKILL.md'), 'utf8'), '# Hello\n');
  const state = JSON.parse(await fs.readFile(path.join(agentDir, '.pi-sync', 'state.json'), 'utf8'));
  assert.equal(Object.hasOwn(state.resources, 'skills/hello'), false);
});

test('remove --target preserves a diverged local copy and reports it while the repository removal proceeds', async (t) => {
  const { repo, agentDir } = await fixture(t);
  assert.equal(run(['apply', '--repo', repo, '--agent-dir', agentDir]).status, 0);
  await fs.writeFile(path.join(agentDir, 'skills', 'hello', 'SKILL.md'), '# Keep my local work\n');

  const removed = run(['remove', '--target', 'skills/hello', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(removed.status, 0, removed.stderr);
  const output = result(removed);
  assert.deepEqual(output.removed, { type: 'skill', source: 'resources/skills/hello', target: 'skills/hello' });
  assert.equal(output.local.target, 'skills/hello');
  assert.equal(output.local.action, 'preserved');
  assert.match(output.local.reason, /diverged/);
  // The manifest entry and repository content are still removed.
  await assert.rejects(fs.access(path.join(repo, 'resources', 'skills', 'hello')));
  assert.equal(JSON.parse(await fs.readFile(path.join(repo, 'pi-sync.json'), 'utf8')).resources.length, 0);
  // The local copy stays intact and is reported stale.
  assert.equal(await fs.readFile(path.join(agentDir, 'skills', 'hello', 'SKILL.md'), 'utf8'), '# Keep my local work\n');
  const status = run(['status', '--no-fetch', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(result(status).staleResources, [{ target: 'skills/hello', state: 'modified', installed: true, pruneAvailable: true }]);
});

test('push publishes removal commits that delete previously managed paths', async (t) => {
  // Working-tree removal: remove, preview, and publish through managed push.
  const { repo, bare, root } = await pushFixture(t);
  const agentDir = path.join(root, 'agent');
  const removed = run(['remove', '--repo', repo, '--agent-dir', agentDir, '--target', 'skills/hello']);
  assert.equal(removed.status, 0, removed.stderr);
  const preview = run(['push', '--dry-run', '--repo', repo]);
  assert.equal(preview.status, 0, preview.stderr);
  const plan = result(preview);
  assert.equal(plan.mode, 'preview');
  assert.deepEqual(plan.changes.map((item) => [item.status, item.path]).sort(), [['D', 'resources/skills/hello/SKILL.md'], ['M', 'pi-sync.json']]);
  assert.equal(plan.commitRequired, true);
  const published = run(['push', '--repo', repo]);
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
  const ahead = run(['push', '--repo', repo2]);
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
  const rejected = run(['push', '--repo', repo]);
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
  const blocked = run(['push', '--repo', sneaky.repo]);
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
  const applied = run(['apply', '--approve-installs', '--repo', repo, '--agent-dir', agentDir], { ...okPi, PI_CALL_LOG: okLog });
  assert.equal(applied.status, 0, applied.stderr);
  const pinsBefore = JSON.parse(await fs.readFile(pinsFile, 'utf8'));
  assert.equal(pinsBefore.packages['npm:fixture-package'], '1.0.0');

  const okLogBefore = await fs.readFile(okLog, 'utf8');
  const removed = run(['remove', '--repo', repo, '--agent-dir', agentDir, '--source', 'npm:fixture-package', '--uninstall'],
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
  const reinstalled = run(['apply', '--approve-installs', '--repo', repo, '--agent-dir', agentDir], { ...okPi, PI_CALL_LOG: okLog });  assert.equal(reinstalled.status, 0, reinstalled.stderr);
  const failPi = await fakePi(t, { fail: true });
  const failLog = path.join(root, 'pi-fail.log');
  await fs.writeFile(failLog, '');
  const failed = run(['remove', '--repo', repo, '--agent-dir', agentDir, '--source', 'npm:fixture-package', '--uninstall'],
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
  // GitHub dependencies uninstall through Pi's git: source spec.
  const githubCommit = 'b'.repeat(40);
  const manifest3 = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest3.dependencies = [{ type: 'github', repository: 'acme/pi-extension' }];
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest3, null, 2)}\n`);
  await fs.writeFile(lockPath, `${JSON.stringify({ schemaVersion: 1, packages: [
    { type: 'github', repository: 'acme/pi-extension', commit: githubCommit, tag: 'v1.0.0', releasedAt: '2020-01-01T00:00:00.000Z' },
  ] }, null, 2)}\n`);
  const githubApplied = run(['apply', '--approve-installs', '--repo', repo, '--agent-dir', agentDir], { ...okPi, PI_CALL_LOG: okLog });
  assert.equal(githubApplied.status, 0, githubApplied.stderr);
  const okLogBefore2 = await fs.readFile(okLog, 'utf8');
  const githubRemoved = run(['remove', '--repo', repo, '--agent-dir', agentDir, '--source', 'github:acme/pi-extension', '--uninstall'],
    { ...okPi, PI_CALL_LOG: okLog });
  assert.equal(githubRemoved.status, 0, `${githubRemoved.stderr}\n${githubRemoved.stdout}`);
  const githubOutput = result(githubRemoved);
  assert.equal(githubOutput.ok, true);
  assert.deepEqual(githubOutput.removed.dependency, { type: 'github', repository: 'acme/pi-extension' });
  assert.deepEqual(githubOutput.uninstalled, { package: 'github:acme/pi-extension', spec: `git:github.com/acme/pi-extension@${githubCommit}` });
  assert.equal(githubOutput.localInstallation, 'uninstalled');
  assert.deepEqual(await piCalls(okLog), [...okLogBefore2.trim().split('\n').filter(Boolean), `uninstall git:github.com/acme/pi-extension@${githubCommit}`]);
  const pinsGithub = JSON.parse(await fs.readFile(pinsFile, 'utf8'));
  assert.equal(pinsGithub.packages['github:acme/pi-extension'], undefined, 'local pin bookkeeping cleared after a GitHub uninstall');
});

test('the full remove, stale, and remove --stale sequence works end to end after publication', async (t) => {
  const { repo, bare, root } = await pushFixture(t);
  const agentDir = path.join(root, 'agent');
  const applied = run(['apply', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(applied.status, 0, applied.stderr);
  const manifestPath = path.join(repo, 'pi-sync.json');

  const removed = run(['remove', '--repo', repo, '--agent-dir', agentDir, '--target', 'skills/hello', '--keep-local']);
  assert.equal(removed.status, 0, removed.stderr);
  const published = run(['push', '--repo', repo]);
  assert.equal(published.status, 0, published.stderr);
  assert.equal(result(published).mode, 'published');
  const remoteFiles = spawnSync('git', ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' });
  assert.deepEqual(remoteFiles.stdout.trim().split(/\r?\n/).sort(), ['.gitignore', 'pi-sync.json', 'pi-sync.lock.json']);

  // status/plan/apply report the removed resource as stale; apply never deletes it.
  for (const command of ['status', 'apply']) {
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
  const replanned = run(['status', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(replanned.status, 0, replanned.stderr);
  assert.deepEqual(result(replanned).staleResources, []);
  // Remove it again for the explicit local removal.
  const removedAgain = run(['remove', '--repo', repo, '--agent-dir', agentDir, '--target', 'skills/hello', '--keep-local']);
  assert.equal(removedAgain.status, 0, removedAgain.stderr);

  // Prune preview does not delete; confirmed prune removes with a backup and
  // clears the local state entry.
  const preview = run(['remove', '--stale', '--dry-run', '--repo', repo, '--agent-dir', agentDir]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.deepEqual(result(preview).staleResources, [{ target: 'skills/hello', action: 'would-prune', installed: true }]);
  await fs.access(path.join(agentDir, 'skills', 'hello', 'SKILL.md'));
  const pruned = run(['remove', '--stale', '--repo', repo, '--agent-dir', agentDir]);
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
  const added = run(['add', '--target', 'prompts/deploy.md', '--repo', repo, '--agent-dir', agentDir]);
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

  const planned = run(['status', '--repo', repo, '--agent-dir', agentDir]);
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
  assert.deepEqual(result(recovered).actions, []);
});

test('a tracked extension directory replaced by a same-content same-mode file reports the kind mismatch without a repository change', async (t) => {
  const { repo, agentDir } = await extendedFixture(t);
  const sourceDir = path.join(agentDir, 'extensions', 'tool');
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'tool'), 'export const tool = 1;\n');
  const added = run(['add', '--target', 'extensions/tool', '--repo', repo, '--agent-dir', agentDir]);
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

  const planned = run(['status', '--repo', repo, '--agent-dir', agentDir]);
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
  assert.deepEqual(result(recovered).actions, []);
});

test('remove of a declared dependency without a lock pin reports the structured not-pinned error', async (t) => {
  const { repo, agentDir } = await extendedFixture(t);
  const skillDir = path.join(agentDir, 'skills', 'hello');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Hello\n');
  assert.equal(run(['add', '--target', 'skills/hello', '--repo', repo, '--agent-dir', agentDir]).status, 0);
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

  const response = run(['remove', '--repo', repo, '--agent-dir', agentDir, '--source', 'npm:fixture-package']);
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
  const resourceRemove = run(['remove', '--repo', repo, '--agent-dir', agentDir, '--target', 'skills/hello']);
  assert.equal(resourceRemove.status, 2, resourceRemove.stderr);
  assert.equal(result(resourceRemove).errorCode, 'VALIDATION_ERROR');
  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestBefore);
  assert.equal(await fs.readFile(path.join(repo, 'resources', 'skills', 'hello', 'SKILL.md'), 'utf8'), contentBefore);
});

test('remove --source --dry-run previews dependency removal without uninstalling or writing', async (t) => {
  const { root, repo, agentDir } = await extendedFixture(t);
  const manifestPath = path.join(repo, 'pi-sync.json');
  const lockPath = path.join(repo, 'pi-sync.lock.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.dependencies = [{ type: 'npm', name: 'fixture-package' }];
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const pin = { type: 'npm', name: 'fixture-package', version: '1.0.0', releasedAt: '2020-01-01T00:00:00.000Z' };
  await fs.writeFile(lockPath, `${JSON.stringify({ schemaVersion: 1, packages: [pin] }, null, 2)}\n`);
  const okPi = await fakePi(t);
  const log = path.join(root, 'pi-calls.log');
  const pinsFile = path.join(agentDir, '.pi-sync', 'packages.json');
  const applied = run(['apply', '--approve-installs', '--repo', repo, '--agent-dir', agentDir], { ...okPi, PI_CALL_LOG: log });
  assert.equal(applied.status, 0, applied.stderr);
  const pinsBefore = await fs.readFile(pinsFile, 'utf8');
  const manifestBefore = await fs.readFile(manifestPath, 'utf8');
  const lockBefore = await fs.readFile(lockPath, 'utf8');

  const preview = run(['remove', '--repo', repo, '--agent-dir', agentDir, '--source', 'npm:fixture-package', '--dry-run'], { ...okPi, PI_CALL_LOG: log });
  assert.equal(preview.status, 0, `${preview.stderr}\n${preview.stdout}`);
  const output = result(preview);
  assert.equal(output.ok, true);
  assert.equal(output.mode, 'preview');
  assert.equal(output.localInstallation, 'unchanged');
  assert.deepEqual(output.removed.dependency, { type: 'npm', name: 'fixture-package' });
  assert.equal(output.removed.pin.version, '1.0.0');
  assert.match(output.note, /^Dry run: .*would be removed, leaving it installed locally; nothing was changed\.$/);
  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestBefore, 'manifest byte-identical');
  assert.equal(await fs.readFile(lockPath, 'utf8'), lockBefore, 'lockfile byte-identical');
  assert.equal(await fs.readFile(pinsFile, 'utf8'), pinsBefore, 'pin bookkeeping byte-identical');
  assert.deepEqual(await piCalls(log), ['install npm:fixture-package@1.0.0'], 'no uninstall ran');

  // The --uninstall preview reports would-uninstall, still without any effect.
  const uninstallPreview = run(['remove', '--repo', repo, '--agent-dir', agentDir, '--source', 'npm:fixture-package', '--uninstall', '--dry-run'], { ...okPi, PI_CALL_LOG: log });
  assert.equal(uninstallPreview.status, 0, `${uninstallPreview.stderr}\n${uninstallPreview.stdout}`);
  const uninstallOutput = result(uninstallPreview);
  assert.equal(uninstallOutput.mode, 'preview');
  assert.equal(uninstallOutput.localInstallation, 'would-uninstall');
  assert.match(uninstallOutput.note, /and the package uninstalled; nothing was changed\./);
  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestBefore, 'manifest still byte-identical');
  assert.equal(await fs.readFile(lockPath, 'utf8'), lockBefore, 'lockfile still byte-identical');
  assert.equal(await fs.readFile(pinsFile, 'utf8'), pinsBefore, 'the package stays installed');
  assert.deepEqual(await piCalls(log), ['install npm:fixture-package@1.0.0'], 'still no uninstall ran');
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
  const applied = run(['apply', '--approve-installs', '--repo', repo, '--agent-dir', agentDir], { ...okPi, PI_CALL_LOG: log });
  assert.equal(applied.status, 0, applied.stderr);

  // Corrupt the local pin bookkeeping after a successful install.
  await fs.writeFile(pinsFile, '{ corrupted\n');
  const manifestBefore = await fs.readFile(manifestPath, 'utf8');
  const lockBefore = await fs.readFile(lockPath, 'utf8');
  const pinsBefore = await fs.readFile(pinsFile, 'utf8');

  const response = run(['remove', '--repo', repo, '--agent-dir', agentDir, '--source', 'npm:fixture-package', '--uninstall'],
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
  const retried = run(['remove', '--repo', repo, '--agent-dir', agentDir, '--source', 'npm:fixture-package', '--uninstall'],
    { ...okPi, PI_CALL_LOG: log });
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(result(retried).localInstallation, 'uninstalled');
  assert.deepEqual((await piCalls(log)).filter((call) => call.startsWith('uninstall')), ['uninstall npm:fixture-package@1.0.0']);
  const pinsAfter = JSON.parse(await fs.readFile(pinsFile, 'utf8'));
  assert.equal(pinsAfter.packages['npm:fixture-package'], undefined, 'local pin bookkeeping cleared after successful uninstall');
});

test('remove restores the manifest atomically when the content deletion fails', async (t) => {
  const { repo, agentDir } = await extendedFixture(t);
  const added = run(['add', '--target', 'prompts/deploy.md', '--repo', repo, '--agent-dir', agentDir]);
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
    response = run(['remove', '--repo', repo, '--agent-dir', agentDir, '--target', 'prompts/deploy.md']);
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
  const rejected = run(['push', '--repo', repo]);
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
  const republished = run(['push', '--repo', repo]);
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

  const response = run(['push', '--repo', repo]);
  assert.equal(response.status, 0, response.stderr);
  assert.equal(result(response).ok, true);
  assert.equal(gitAt(repo, ['rev-list', '--count', '@{upstream}..HEAD']), '0');
  assert.equal(gitAt(repo, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0], gitAt(repo, ['rev-parse', 'HEAD']), 'remote advanced to local HEAD');
})

test('omitted --repo resolves PI_SYNC_REPO_DIR, and an explicit --repo beats it', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-repo-default-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const envRepo = path.join(root, 'env-repo');
  const flagRepo = path.join(root, 'flag-repo');
  // The working directory is an unrelated directory that also contains a
  // valid setup repository: with the removed cwd fallback this decoy must
  // never be selected.
  const workDir = path.join(root, 'elsewhere');
  await writeRepo(envRepo, 'env-skill');
  await writeRepo(flagRepo, 'flag-skill');
  await writeRepo(workDir, 'cwd-skill');

  const flagged = run(['apply', '--repo', flagRepo, '--agent-dir', path.join(root, 'agent-flag')], repoDefaultEnv({ PI_SYNC_REPO_DIR: envRepo }), { cwd: workDir });
  assert.equal(flagged.status, 0, `${flagged.stderr}\n${flagged.stdout}`);
  assert.equal(result(flagged).repository, flagRepo, 'the explicit --repo flag beats PI_SYNC_REPO_DIR and the working directory');

  const envResolved = run(['apply', '--agent-dir', path.join(root, 'agent-env')], repoDefaultEnv({ PI_SYNC_REPO_DIR: envRepo }), { cwd: workDir });
  assert.equal(envResolved.status, 0, `${envResolved.stderr}\n${envResolved.stdout}`);
  const envOutput = result(envResolved);
  assert.equal(envOutput.repository, envRepo, 'an omitted --repo resolves PI_SYNC_REPO_DIR over the working directory');
  assert.equal(envOutput.actions[0].target, 'skills/env-skill');
});

test('PI_SYNC_REPO_DIR is used verbatim without ~ expansion', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-repo-verbatim-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workDir = path.join(root, 'work');
  const home = path.join(root, 'home');
  await fs.mkdir(workDir);
  await fs.mkdir(home);
  // A literal "~" directory in the working directory: the environment value
  // "~/setup" must resolve here, not to the (empty) home directory.
  const verbatimRepo = path.join(workDir, '~', 'setup');
  await writeRepo(verbatimRepo, 'verbatim-skill');

  const response = run(['apply', '--agent-dir', path.join(root, 'agent')], repoDefaultEnv({ HOME: home, USERPROFILE: home, PI_SYNC_REPO_DIR: '~/setup' }), { cwd: workDir });
  assert.equal(response.status, 0, `${response.stderr}\n${response.stdout}`);
  assert.equal(result(response).repository, path.join(workDir, '~', 'setup'), 'PI_SYNC_REPO_DIR is used verbatim and its ~ is not expanded');
  await assert.rejects(fs.access(path.join(home, 'setup')), 'a ~-expanded repository path must not be consulted');
});

test('omitted --repo without PI_SYNC_REPO_DIR defaults to ~/.pi-sync/setup under a hermetic home', async (t) => {
  // Portable home override: Node resolves os.homedir() from HOME on POSIX
  // hosts and from USERPROFILE on Windows, so both are pointed at the
  // temporary home; on WSL (a POSIX host) HOME applies. The real user home
  // is never touched.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-repo-home-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const workDir = path.join(root, 'elsewhere');
  const defaultRepo = path.join(home, '.pi-sync', 'setup');
  await writeRepo(defaultRepo, 'home-skill');
  await writeRepo(workDir, 'cwd-skill'); // decoy: the removed cwd fallback would select this

  const response = run(['apply', '--agent-dir', path.join(root, 'agent')], repoDefaultEnv({ HOME: home, USERPROFILE: home }), { cwd: workDir });
  assert.equal(response.status, 0, `${response.stderr}\n${response.stdout}`);
  const output = result(response);
  assert.equal(output.repository, defaultRepo, 'the built-in default under the user home is used, not the working directory');
  assert.equal(output.actions[0].target, 'skills/home-skill');
});

test('bootstrap rejects --repo-dir and accepts the unified --repo flag', () => {
  const response = runRawWith(cli, ['bootstrap', '--repo-dir', path.join(os.tmpdir(), 'never'), '--json'], repoDefaultEnv());
  assert.equal(response.status, 2, `${response.stderr}\n${response.stdout}`);
  assert.match(JSON.parse(response.stdout).error, /Unknown option: --repo-dir/);
});
test('bootstrap --approve-installs resumes a first run blocked on first-install approval from the existing setup repository', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-bootstrap-approve-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRepo = path.join(root, 'remote-fixture');
  await fs.mkdir(path.join(sourceRepo, 'resources', 'skills', 'hello'), { recursive: true });
  await fs.writeFile(path.join(sourceRepo, 'resources', 'skills', 'hello', 'SKILL.md'), '# Private fixture\n');
  await fs.writeFile(path.join(sourceRepo, 'pi-sync.json'), JSON.stringify({
    schemaVersion: 1,
    resources: [{ type: 'skill', source: 'resources/skills/hello', target: 'skills/hello' }],
    dependencies: [{ type: 'npm', name: 'widget' }],
  }));
  await fs.writeFile(path.join(sourceRepo, 'pi-sync.lock.json'), JSON.stringify({
    schemaVersion: 1,
    packages: [{ type: 'npm', name: 'widget', version: '1.0.0', releasedAt: '2020-01-01T00:00:00.000Z' }],
  }));
  const fakeTools = await fakeGitHubTools(t, sourceRepo);
  const fakePiTools = await fakePi(t);
  const toolBins = fakeTools.PATH.slice(0, fakeTools.PATH.indexOf(path.delimiter));
  const piBins = fakePiTools.PATH.slice(0, fakePiTools.PATH.indexOf(path.delimiter));
  const env = {
    FAKE_SETUP_REPO: fakeTools.FAKE_SETUP_REPO,
    PATH: `${toolBins}${path.delimiter}${piBins}${path.delimiter}${process.env.PATH}`,
    FAKE_GIT_ACCESS: 'yes',
    PI_CALL_LOG: path.join(root, 'pi-calls.log'),
  };
  const agentDir = path.join(root, 'agent');
  const setupDir = path.join(root, 'private-checkout');
  const args = ['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo', setupDir, '--agent-dir', agentDir];

  const first = run(args, env);
  assert.equal(first.status, 1, `${first.stderr}\n${first.stdout}`);
  const firstOutput = result(first);
  assert.equal(firstOutput.ok, false);
  assert.equal(firstOutput.errorCode, 'APPLY_CONFLICT');
  assert.equal(firstOutput.apply.errorCode, 'APPROVAL_REQUIRED');
  assert.deepEqual(await piCalls(env.PI_CALL_LOG), []);

  const resumed = run([...args, '--approve-installs'], env);
  assert.equal(resumed.status, 0, `${resumed.stderr}\n${resumed.stdout}`);
  const resumedOutput = result(resumed);
  assert.equal(resumedOutput.ok, true);
  assert.equal(resumedOutput.authenticationMethod, null, 'a resumed bootstrap does not refetch the repository');
  assert.deepEqual(await piCalls(env.PI_CALL_LOG), ['install npm:widget@1.0.0']);
  assert.equal(await fs.readFile(path.join(agentDir, 'skills', 'hello', 'SKILL.md'), 'utf8'), '# Private fixture\n');
});

test('bootstrap rerun without --repo-url infers the repository URL from the checkout origin remote', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-bootstrap-infer-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRepo = await bootstrapRepo(t, root);
  const fakeTools = await fakeGitHubTools(t, sourceRepo);
  const agentDir = path.join(root, 'agent');
  const setupDir = path.join(root, 'private-checkout');

  const first = run(['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo', setupDir, '--agent-dir', agentDir], { ...fakeTools, FAKE_GIT_ACCESS: 'yes' });
  assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
  const firstOutput = result(first);
  assert.equal(firstOutput.repoUrl, 'https://github.com/acme/private-setup.git');
  assert.equal(firstOutput.repoUrlSource, 'flag');

  // The destination now holds a valid setup repository whose origin records
  // the remote URL, so a rerun without --repo-url must infer it.
  gitAt(setupDir, ['init', '--initial-branch=main']);
  gitAt(setupDir, ['remote', 'add', 'origin', 'https://github.com/acme/private-setup.git']);

  const resumed = run(['bootstrap', '--repo', setupDir, '--agent-dir', agentDir], { ...repoDefaultEnv() });
  assert.equal(resumed.status, 0, `${resumed.stderr}\n${resumed.stdout}`);
  const output = result(resumed);
  assert.equal(output.ok, true);
  assert.equal(output.repoUrl, 'https://github.com/acme/private-setup.git');
  assert.equal(output.repoUrlSource, 'remote');
  assert.equal(output.authenticationMethod, null, 'a resumed bootstrap does not refetch the repository');
});

test('bootstrap first-time fetch without --repo-url fails with a usage error naming the flag and destination', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-bootstrap-nourl-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const setupDir = path.join(root, 'never-fetched');

  const response = run(['bootstrap', '--repo', setupDir, '--agent-dir', path.join(root, 'agent')], { ...repoDefaultEnv() });
  assert.equal(response.status, 2, `${response.stderr}\n${response.stdout}`);
  const output = result(response);
  assert.equal(output.ok, false);
  assert.equal(output.errorCode, 'VALIDATION_ERROR');
  assert.match(output.error, /--repo-url/);
  assert.ok(output.error.includes(setupDir), `usage error names the destination: ${output.error}`);
});

test('bootstrap without --repo-url fails closed when the checkout origin remote is missing or not a GitHub URL', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-bootstrap-badremote-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRepo = await bootstrapRepo(t, root);
  const fakeTools = await fakeGitHubTools(t, sourceRepo);
  const agentDir = path.join(root, 'agent');
  const setupDir = path.join(root, 'private-checkout');

  const first = run(['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo', setupDir, '--agent-dir', agentDir], { ...fakeTools, FAKE_GIT_ACCESS: 'yes' });
  assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
  gitAt(setupDir, ['init', '--initial-branch=main']);

  // A non-GitHub origin URL fails validation and is never trusted.
  gitAt(setupDir, ['remote', 'add', 'origin', 'https://example.com/not-github.git']);
  const badOrigin = run(['bootstrap', '--repo', setupDir, '--agent-dir', agentDir], { ...repoDefaultEnv() });
  assert.equal(badOrigin.status, 1, `${badOrigin.stderr}\n${badOrigin.stdout}`);
  const badOriginOutput = result(badOrigin);
  assert.equal(badOriginOutput.ok, false);
  assert.equal(badOriginOutput.errorCode, 'REPOSITORY_REMOTE_UNRESOLVABLE');
  assert.match(badOriginOutput.error, /--repo-url/);

  // No origin remote at all fails the same way.
  gitAt(setupDir, ['remote', 'remove', 'origin']);
  const noOrigin = run(['bootstrap', '--repo', setupDir, '--agent-dir', agentDir], { ...repoDefaultEnv() });
  assert.equal(noOrigin.status, 1, `${noOrigin.stderr}\n${noOrigin.stdout}`);
  const noOriginOutput = result(noOrigin);
  assert.equal(noOriginOutput.ok, false);
  assert.equal(noOriginOutput.errorCode, 'REPOSITORY_REMOTE_UNRESOLVABLE');
  assert.match(noOriginOutput.error, /--repo-url/);
});

test('bootstrap explicit --repo-url wins over a differing origin remote and reports the flag source', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-bootstrap-flagwins-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRepo = await bootstrapRepo(t, root);
  const fakeTools = await fakeGitHubTools(t, sourceRepo);
  const agentDir = path.join(root, 'agent');
  const setupDir = path.join(root, 'private-checkout');

  const first = run(['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo', setupDir, '--agent-dir', agentDir], { ...fakeTools, FAKE_GIT_ACCESS: 'yes' });
  assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
  gitAt(setupDir, ['init', '--initial-branch=main']);
  gitAt(setupDir, ['remote', 'add', 'origin', 'https://github.com/acme/other-setup.git']);

  const resumed = run(['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo', setupDir, '--agent-dir', agentDir], { ...repoDefaultEnv() });
  assert.equal(resumed.status, 0, `${resumed.stderr}\n${resumed.stdout}`);
  const output = result(resumed);
  assert.equal(output.ok, true);
  assert.equal(output.repoUrl, 'https://github.com/acme/private-setup.git');
  assert.equal(output.repoUrlSource, 'flag');
  assert.equal(output.authenticationMethod, null, 'a resumed bootstrap does not refetch the repository');
});

test('bootstrap rerun resumes from an existing valid setup repository and applies repository changes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-bootstrap-resume-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRepo = await bootstrapRepo(t, root);
  const fakeTools = await fakeGitHubTools(t, sourceRepo);
  const agentDir = path.join(root, 'agent');
  const setupDir = path.join(root, 'private-checkout');
  const args = ['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo', setupDir, '--agent-dir', agentDir];

  const first = run(args, { ...fakeTools, FAKE_GIT_ACCESS: 'yes' });
  assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
  const bundledSkill = new URL('../resources/skills/pi-sync/SKILL.md', import.meta.url);
  assert.equal(await fs.readFile(path.join(agentDir, 'skills', 'pi-sync', 'SKILL.md'), 'utf8'), await fs.readFile(bundledSkill, 'utf8'));

  // The destination now holds a valid setup repository; a new resource added
  // to it must be picked up by the resumed apply.
  const newSkillSource = path.join(setupDir, 'resources', 'skills', 'resume-skill');
  await fs.mkdir(newSkillSource, { recursive: true });
  await fs.writeFile(path.join(newSkillSource, 'SKILL.md'), '# Resumed\n');
  const manifestPath = path.join(setupDir, 'pi-sync.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.resources.push({ type: 'skill', source: 'resources/skills/resume-skill', target: 'skills/resume-skill' });
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const resumed = run(args, { ...fakeTools, FAKE_GIT_ACCESS: 'yes' });
  assert.equal(resumed.status, 0, `${resumed.stderr}\n${resumed.stdout}`);
  const output = result(resumed);
  assert.equal(output.ok, true);
  assert.equal(output.authenticationMethod, null, 'a resumed bootstrap does not refetch the repository');
  assert.equal(await fs.readFile(path.join(agentDir, 'skills', 'resume-skill', 'SKILL.md'), 'utf8'), '# Resumed\n', 'the new repository resource is applied on resume');
});

// Recursive read-only snapshot: relative path -> file content (Buffer).
// Symlinks and special entries are recorded by name only.
async function snapshotTree(directory) {
  const entries = new Map();
  async function walk(dir, prefix) {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) entries.set(rel, await fs.readFile(full));
      else entries.set(rel, `special:${entry.name}`);
    }
  }
  await walk(directory, '');
  return entries;
}

async function stagingCopies() {
  return (await fs.readdir(os.tmpdir())).filter((entry) => entry.startsWith('.pi-sync-bootstrap-')).sort();
}

test('bootstrap --dry-run resumes from an existing valid setup repository without refetching or mutating', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-bootstrap-dry-run-resume-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRepo = await bootstrapRepo(t, root);
  const fakeTools = await fakeGitHubTools(t, sourceRepo);
  const agentDir = path.join(root, 'agent');
  const setupDir = path.join(root, 'private-checkout');
  const args = ['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo', setupDir, '--agent-dir', agentDir];

  const first = run(args, { ...fakeTools, FAKE_GIT_ACCESS: 'yes' });
  assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
  const setupBefore = await snapshotTree(setupDir);
  const agentBefore = await snapshotTree(agentDir);
  const stagingBefore = await stagingCopies();

  // Resume branch: the existing checkout is copied to a temp staging dir and
  // planned against the copy, then the preview returns before rename/apply.
  const preview = run([...args, '--dry-run'], { ...fakeTools, FAKE_GIT_ACCESS: 'yes' });
  assert.equal(preview.status, 0, `${preview.stderr}\n${preview.stdout}`);
  const output = result(preview);
  assert.equal(output.ok, true);
  assert.equal(output.mode, 'preview');
  assert.equal(output.authenticationMethod, null, 'a resumed preview never refetches the repository');
  assert.equal(output.plan.ok, true);
  assert.equal(output.plan.command, 'status');
  assert.deepEqual(await snapshotTree(setupDir), setupBefore, 'the real setup repository is byte-identical after the preview');
  assert.deepEqual(await snapshotTree(agentDir), agentBefore, 'the local installation is untouched by the preview');
  assert.deepEqual(await stagingCopies(), stagingBefore, 'the staging copy is cleaned up after the preview');
});

test('bootstrap success output in the compact text tier omits undefined fields', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-bootstrap-text-tier-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRepo = await bootstrapRepo(t, root);
  const fakeTools = await fakeGitHubTools(t, sourceRepo);
  const agentDir = path.join(root, 'agent');
  const setupDir = path.join(root, 'private-checkout');
  const args = ['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo', setupDir, '--agent-dir', agentDir];

  // bootstrapResponse always carries errorCode/error keys; on success both are
  // undefined. The compact text tier must omit them (as JSON.stringify does)
  // rather than render the literal "undefined".
  const text = runRawWith(cli, args, { ...fakeTools, FAKE_GIT_ACCESS: 'yes' });
  assert.equal(text.status, 0, `${text.stderr}\n${text.stdout}`);
  assert.match(text.stdout.trim().split('\n')[0], /^ok$/);
  assert.ok(!text.stdout.split(/\r?\n/).some((line) => /:\s*undefined$/.test(line)), `compact text tier must not render undefined fields:\n${text.stdout}`);
});

test('bootstrap --dry-run removes the staging copy before rethrowing a copy failure', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-bootstrap-dry-run-cp-fail-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRepo = await bootstrapRepo(t, root);
  const fakeTools = await fakeGitHubTools(t, sourceRepo);
  const agentDir = path.join(root, 'agent');
  const setupDir = path.join(root, 'private-checkout');
  const args = ['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo', setupDir, '--agent-dir', agentDir];

  const first = run(args, { ...fakeTools, FAKE_GIT_ACCESS: 'yes' });
  assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
  const setupBefore = await snapshotTree(setupDir);
  const agentBefore = await snapshotTree(agentDir);
  const stagingBefore = await stagingCopies();

  // An undeclared unreadable file passes validateRepository (which only reads
  // the manifest and declared sources) but makes the staging fs.cp fail.
  const blocker = path.join(setupDir, 'unreadable.txt');
  await fs.writeFile(blocker, 'unreadable\n');
  await fs.chmod(blocker, 0o000);
  let response;
  try {
    response = run([...args, '--dry-run'], { ...fakeTools, FAKE_GIT_ACCESS: 'yes' });
  } finally {
    await fs.chmod(blocker, 0o644);
  }
  assert.notEqual(response.status, 0, response.stderr);
  const output = result(response);
  assert.equal(output.ok, false);
  assert.equal(output.errorCode, 'VALIDATION_ERROR');
  assert.match(output.error, /EACCES|permission denied/);
  assert.deepEqual(await stagingCopies(), stagingBefore, 'cleanStaging removed the staging copy before the rethrow');
  assert.deepEqual(await snapshotTree(setupDir).then((snapshot) => { snapshot.delete('unreadable.txt'); return snapshot; }), setupBefore, 'the real setup repository is untouched');
  assert.deepEqual(await snapshotTree(agentDir), agentBefore, 'the local installation is untouched');
});
test('bootstrap surfaces the inner plan failure instead of hiding it', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-bootstrap-plan-error-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRepo = await bootstrapRepo(t, root);
  const fakeTools = await fakeGitHubTools(t, sourceRepo);
  const agentDir = path.join(root, 'agent');
  const setupDir = path.join(root, 'private-checkout');
  const args = ['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo', setupDir, '--agent-dir', agentDir];
  const first = run(args, { ...fakeTools, FAKE_GIT_ACCESS: 'yes' });
  assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);

  // The inner plan child is the first to load local state; a corrupted state
  // file must surface as the nested plan result, not a bare CLI failure.
  const stateFile = path.join(agentDir, '.pi-sync', 'state.json');
  await fs.writeFile(stateFile, `${JSON.stringify({ schemaVersion: 2 }, null, 2)}\n`);
  const failed = run(args, { ...fakeTools, FAKE_GIT_ACCESS: 'yes' });
  assert.equal(failed.status, 1, `${failed.stderr}\n${failed.stdout}`);
  const output = result(failed);
  assert.equal(output.ok, false);
  assert.equal(output.errorCode, 'APPLY_CONFLICT');
  assert.equal(output.plan.ok, false);
  assert.match(output.plan.error, /Local Pi Sync state is invalid/);
});

test('bootstrap still collides when the destination exists but is not a setup repository', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-bootstrap-invalid-dest-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRepo = await bootstrapRepo(t, root);
  const fakeTools = await fakeGitHubTools(t, sourceRepo);
  const agentDir = path.join(root, 'agent');
  const setupDir = path.join(root, 'private-checkout');
  await fs.mkdir(setupDir, { recursive: true });
  await fs.writeFile(path.join(setupDir, 'notes.txt'), 'not a setup repository\n');

  const response = run(['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo', setupDir, '--agent-dir', agentDir], {
    ...fakeTools, FAKE_GIT_ACCESS: 'yes',
  });
  assert.equal(response.status, 1, `${response.stderr}\n${response.stdout}`);
  const output = result(response);
  assert.equal(output.ok, false);
  assert.equal(output.errorCode, 'REPOSITORY_PATH_COLLISION');
  assert.match(output.error, /not a valid Pi Sync setup repository/);
  await assert.rejects(fs.access(agentDir));
  assert.equal(await fs.readFile(path.join(setupDir, 'notes.txt'), 'utf8'), 'not a setup repository\n');
});

test('bootstrap rerun with the same package is idempotent and reports the bundled resources already-current', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-bootstrap-idempotent-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRepo = await bootstrapRepo(t, root);
  const fakeTools = await fakeGitHubTools(t, sourceRepo);
  const agentDir = path.join(root, 'agent');
  const setupDir = path.join(root, 'private-checkout');
  const args = ['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo', setupDir, '--agent-dir', agentDir];

  const first = run(args, { ...fakeTools, FAKE_GIT_ACCESS: 'yes' });
  assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);

  const manifestPath = path.join(setupDir, 'pi-sync.json');
  const manifestBefore = await fs.readFile(manifestPath, 'utf8');
  const lockBefore = await fs.readFile(path.join(setupDir, 'pi-sync.lock.json'), 'utf8');
  const bundledSkillBefore = await fs.readFile(path.join(setupDir, 'resources', 'skills', 'pi-sync', 'SKILL.md'), 'utf8');
  const helloBefore = await fs.readFile(path.join(setupDir, 'resources', 'skills', 'hello', 'SKILL.md'), 'utf8');
  const localSkillBefore = await fs.readFile(path.join(agentDir, 'skills', 'pi-sync', 'SKILL.md'), 'utf8');

  const resumed = run(args, { ...fakeTools, FAKE_GIT_ACCESS: 'yes' });
  assert.equal(resumed.status, 0, `${resumed.stderr}\n${resumed.stdout}`);
  const output = result(resumed);
  assert.equal(output.ok, true);
  assert.equal(output.packageVersion, JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
  assert.deepEqual(output.bundledResources, [
    { type: 'skill', source: 'resources/skills/pi-sync', target: 'skills/pi-sync', action: 'already-current' },
    { type: 'extension', source: 'resources/extensions/pi-sync', target: 'extensions/pi-sync', action: 'already-current' },
  ]);
  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestBefore, 'an already-current refresh does not rewrite the manifest');
  assert.equal(await fs.readFile(path.join(setupDir, 'pi-sync.lock.json'), 'utf8'), lockBefore);
  assert.equal(await fs.readFile(path.join(setupDir, 'resources', 'skills', 'pi-sync', 'SKILL.md'), 'utf8'), bundledSkillBefore);
  assert.equal(await fs.readFile(path.join(setupDir, 'resources', 'skills', 'hello', 'SKILL.md'), 'utf8'), helloBefore);
  assert.equal(await fs.readFile(path.join(agentDir, 'skills', 'pi-sync', 'SKILL.md'), 'utf8'), localSkillBefore);
});

test('bootstrap rerun refreshes changed bundled resources from the executing package and preserves unrelated state', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-bootstrap-refresh-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRepo = await bootstrapRepo(t, root);
  const fakeTools = await fakeGitHubTools(t, sourceRepo);
  const agentDir = path.join(root, 'agent');
  const unrelated = path.join(agentDir, 'skills', 'local-only', 'SKILL.md');
  await fs.mkdir(path.dirname(unrelated), { recursive: true });
  await fs.writeFile(unrelated, '# Keep local\n');
  const setupDir = path.join(root, 'private-checkout');
  const args = ['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo', setupDir, '--agent-dir', agentDir];

  const first = run(args, { ...fakeTools, FAKE_GIT_ACCESS: 'yes' });
  assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);

  const { cli: fixtureCli, fixture } = await packageFixture(t, root, {
    version: '9.9.9',
    mutate: async (dir) => {
      await fs.appendFile(path.join(dir, 'resources', 'skills', 'pi-sync', 'SKILL.md'), '\n# Refreshed bundle marker\n');
      await fs.appendFile(path.join(dir, 'resources', 'extensions', 'pi-sync', 'status.js'), '\n// refreshed\n');
    },
  });
  const lockBefore = await fs.readFile(path.join(setupDir, 'pi-sync.lock.json'), 'utf8');

  const resumed = runWith(fixtureCli, args, { ...fakeTools, FAKE_GIT_ACCESS: 'yes' });
  assert.equal(resumed.status, 0, `${resumed.stderr}\n${resumed.stdout}`);
  const output = result(resumed);
  assert.equal(output.ok, true);
  assert.equal(output.packageVersion, '9.9.9');
  assert.deepEqual(output.bundledResources, [
    { type: 'skill', source: 'resources/skills/pi-sync', target: 'skills/pi-sync', action: 'refreshed' },
    { type: 'extension', source: 'resources/extensions/pi-sync', target: 'extensions/pi-sync', action: 'refreshed' },
  ]);
  assert.equal(await fs.readFile(path.join(setupDir, 'resources', 'skills', 'pi-sync', 'SKILL.md'), 'utf8'),
    await fs.readFile(path.join(fixture, 'resources', 'skills', 'pi-sync', 'SKILL.md'), 'utf8'));
  assert.equal(await fs.readFile(path.join(setupDir, 'resources', 'extensions', 'pi-sync', 'status.js'), 'utf8'),
    await fs.readFile(path.join(fixture, 'resources', 'extensions', 'pi-sync', 'status.js'), 'utf8'));
  assert.equal(await fs.readFile(path.join(agentDir, 'skills', 'pi-sync', 'SKILL.md'), 'utf8'),
    await fs.readFile(path.join(fixture, 'resources', 'skills', 'pi-sync', 'SKILL.md'), 'utf8'));
  assert.equal(await fs.readFile(path.join(agentDir, 'extensions', 'pi-sync', 'status.js'), 'utf8'),
    await fs.readFile(path.join(fixture, 'resources', 'extensions', 'pi-sync', 'status.js'), 'utf8'));
  assert.equal(await fs.readFile(path.join(setupDir, 'resources', 'skills', 'hello', 'SKILL.md'), 'utf8'), '# Private fixture\n');
  const manifest = JSON.parse(await fs.readFile(path.join(setupDir, 'pi-sync.json'), 'utf8'));
  assert.ok(manifest.resources.some((item) => item.source === 'resources/skills/hello' && item.target === 'skills/hello'));
  assert.equal(await fs.readFile(path.join(setupDir, 'pi-sync.lock.json'), 'utf8'), lockBefore);
  assert.equal(await fs.readFile(unrelated, 'utf8'), '# Keep local\n');
});

test('bootstrap rerun with an older package downgrades the bundled resources to that package contents', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-bootstrap-downgrade-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRepo = await bootstrapRepo(t, root);
  const fakeTools = await fakeGitHubTools(t, sourceRepo);
  const agentDir = path.join(root, 'agent');
  const setupDir = path.join(root, 'private-checkout');
  const args = ['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo', setupDir, '--agent-dir', agentDir];
  const originalSkill = await fs.readFile(new URL('../resources/skills/pi-sync/SKILL.md', import.meta.url), 'utf8');

  const first = run(args, { ...fakeTools, FAKE_GIT_ACCESS: 'yes' });
  assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);

  const newer = await packageFixture(t, root, {
    version: '2.0.0',
    name: 'package-fixture-newer',
    mutate: async (dir) => {
      await fs.appendFile(path.join(dir, 'resources', 'skills', 'pi-sync', 'SKILL.md'), '\n# Newer bundle\n');
    },
  });
  const upgraded = runWith(newer.cli, args, { ...fakeTools, FAKE_GIT_ACCESS: 'yes' });
  assert.equal(upgraded.status, 0, `${upgraded.stderr}\n${upgraded.stdout}`);
  const upgradedOutput = result(upgraded);
  assert.equal(upgradedOutput.packageVersion, '2.0.0');
  assert.equal(upgradedOutput.bundledResources[0].action, 'refreshed');
  assert.equal(await fs.readFile(path.join(setupDir, 'resources', 'skills', 'pi-sync', 'SKILL.md'), 'utf8'),
    await fs.readFile(path.join(newer.fixture, 'resources', 'skills', 'pi-sync', 'SKILL.md'), 'utf8'));

  const older = await packageFixture(t, root, { version: '1.9.0', name: 'package-fixture-older' });
  const downgraded = runWith(older.cli, args, { ...fakeTools, FAKE_GIT_ACCESS: 'yes' });
  assert.equal(downgraded.status, 0, `${downgraded.stderr}\n${downgraded.stdout}`);
  const downgradedOutput = result(downgraded);
  assert.equal(downgradedOutput.packageVersion, '1.9.0');
  assert.equal(downgradedOutput.bundledResources[0].action, 'refreshed');
  assert.equal(await fs.readFile(path.join(setupDir, 'resources', 'skills', 'pi-sync', 'SKILL.md'), 'utf8'), originalSkill,
    'an older executing package downgrades the setup repository bundle to its own contents');
  assert.equal(await fs.readFile(path.join(agentDir, 'skills', 'pi-sync', 'SKILL.md'), 'utf8'), originalSkill);
});

test('bootstrap rerun removes bundled files the executing package no longer ships', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-bootstrap-removed-files-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRepo = await bootstrapRepo(t, root);
  const fakeTools = await fakeGitHubTools(t, sourceRepo);
  const agentDir = path.join(root, 'agent');
  const setupDir = path.join(root, 'private-checkout');
  const args = ['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo', setupDir, '--agent-dir', agentDir];
  const extraFile = 'extra-notes.md';

  const firstPkg = await packageFixture(t, root, {
    version: '9.8.0',
    name: 'package-fixture-with-extra',
    mutate: async (dir) => {
      await fs.writeFile(path.join(dir, 'resources', 'skills', 'pi-sync', extraFile), 'temporary note\n');
    },
  });
  const first = runWith(firstPkg.cli, args, { ...fakeTools, FAKE_GIT_ACCESS: 'yes' });
  assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
  const firstOutput = result(first);
  assert.equal(firstOutput.packageVersion, '9.8.0');
  assert.equal(firstOutput.bundledResources[0].action, 'declared');
  assert.equal(await fs.readFile(path.join(setupDir, 'resources', 'skills', 'pi-sync', extraFile), 'utf8'), 'temporary note\n');
  assert.equal(await fs.readFile(path.join(agentDir, 'skills', 'pi-sync', extraFile), 'utf8'), 'temporary note\n');

  const secondPkg = await packageFixture(t, root, { version: '9.7.0', name: 'package-fixture-no-extra' });
  const second = runWith(secondPkg.cli, args, { ...fakeTools, FAKE_GIT_ACCESS: 'yes' });
  assert.equal(second.status, 0, `${second.stderr}\n${second.stdout}`);
  const secondOutput = result(second);
  assert.equal(secondOutput.packageVersion, '9.7.0');
  assert.equal(secondOutput.bundledResources[0].action, 'refreshed');
  await assert.rejects(fs.access(path.join(setupDir, 'resources', 'skills', 'pi-sync', extraFile)),
    'obsolete bundled files are removed from the setup repository source');
  await assert.rejects(fs.access(path.join(agentDir, 'skills', 'pi-sync', extraFile)),
    'ordinary apply removes the file from the local installation');
  assert.equal(await fs.readFile(path.join(setupDir, 'resources', 'skills', 'pi-sync', 'SKILL.md'), 'utf8'),
    await fs.readFile(path.join(secondPkg.fixture, 'resources', 'skills', 'pi-sync', 'SKILL.md'), 'utf8'));
});

test('bootstrap rerun collision preflights the bundled set and leaves every bundled source unchanged', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-bootstrap-collision-atomic-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRepo = await bootstrapRepo(t, root);
  const fakeTools = await fakeGitHubTools(t, sourceRepo);
  const agentDir = path.join(root, 'agent');
  const setupDir = path.join(root, 'private-checkout');
  const args = ['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo', setupDir, '--agent-dir', agentDir];

  const first = run(args, { ...fakeTools, FAKE_GIT_ACCESS: 'yes' });
  assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);

  // The extension bundle source still exists on disk but is no longer declared:
  // an undeclared pre-existing source path is a collision.
  const manifestPath = path.join(setupDir, 'pi-sync.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.resources = manifest.resources.filter((item) => item.source !== 'resources/extensions/pi-sync');
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await fs.writeFile(manifestPath, manifestText);
  const skillBefore = await fs.readFile(path.join(setupDir, 'resources', 'skills', 'pi-sync', 'SKILL.md'), 'utf8');

  const response = run(args, { ...fakeTools, FAKE_GIT_ACCESS: 'yes' });
  assert.equal(response.status, 1, `${response.stderr}\n${response.stdout}`);
  const output = result(response);
  assert.equal(output.ok, false);
  assert.equal(output.errorCode, 'RESOURCE_COLLISION');
  assert.equal(output.collision.bundled.type, 'extension');
  assert.match(output.collision.reason, /not declared/);
  assert.equal(await fs.readFile(path.join(setupDir, 'resources', 'skills', 'pi-sync', 'SKILL.md'), 'utf8'), skillBefore,
    'the exact-declared skill bundle is not partially refreshed after a collision');
  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestText);
});

test('bootstrap rerun reports an overlapping bundled declaration as a collision without refreshing', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-bootstrap-overlap-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRepo = await bootstrapRepo(t, root);
  const fakeTools = await fakeGitHubTools(t, sourceRepo);
  const agentDir = path.join(root, 'agent');
  const setupDir = path.join(root, 'private-checkout');
  const args = ['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo', setupDir, '--agent-dir', agentDir];

  const first = run(args, { ...fakeTools, FAKE_GIT_ACCESS: 'yes' });
  assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);

  // A single-file extension declaration nested inside the bundled extension
  // target overlaps the Pi Sync-owned bundle.
  const manifestPath = path.join(setupDir, 'pi-sync.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.resources = manifest.resources
    .filter((item) => item.source !== 'resources/extensions/pi-sync')
    .concat({ type: 'extension', source: 'resources/extensions/pi-sync/index.ts', target: 'extensions/pi-sync/index.ts' });
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await fs.writeFile(manifestPath, manifestText);
  const skillBefore = await fs.readFile(path.join(setupDir, 'resources', 'skills', 'pi-sync', 'SKILL.md'), 'utf8');

  const response = run(args, { ...fakeTools, FAKE_GIT_ACCESS: 'yes' });
  assert.equal(response.status, 1, `${response.stderr}\n${response.stdout}`);
  const output = result(response);
  assert.equal(output.ok, false);
  assert.equal(output.errorCode, 'RESOURCE_COLLISION');
  assert.equal(output.collision.target, 'extensions/pi-sync/index.ts');
  assert.equal(output.collision.bundled.type, 'extension');
  assert.equal(await fs.readFile(path.join(setupDir, 'resources', 'skills', 'pi-sync', 'SKILL.md'), 'utf8'), skillBefore,
    'the exact-declared skill bundle is not refreshed after a collision');
  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestText);
});

test('bootstrap rerun does not fetch or pull the existing setup repository', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-bootstrap-nofetch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRepo = await bootstrapRepo(t, root);
  const fakeTools = await fakeGitHubTools(t, sourceRepo);
  const agentDir = path.join(root, 'agent');
  const setupDir = path.join(root, 'private-checkout');
  const args = ['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo', setupDir, '--agent-dir', agentDir];

  const first = run(args, { ...fakeTools, FAKE_GIT_ACCESS: 'yes' });
  assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);

  // A logging git that fails every call: any fetch/pull/clone/ls-remote by
  // the rerun is observable and would also break a fetch attempt.
  const logFile = path.join(root, 'git-calls.log');
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-nofetch-bin-'));
  t.after(() => fs.rm(bin, { recursive: true, force: true }));
  await fs.writeFile(path.join(bin, 'git'),
    `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.GIT_CALL_LOG, process.argv.slice(2).join(' ') + '\\n');\nprocess.exit(2);\n`,
    { mode: 0o755 });

  const resumed = run(args, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, GIT_CALL_LOG: logFile });
  assert.equal(resumed.status, 0, `${resumed.stderr}\n${resumed.stdout}`);
  const output = result(resumed);
  assert.equal(output.ok, true);
  assert.equal(output.authenticationMethod, null, 'a resumed bootstrap does not refetch the repository');
  let calls = '';
  try { calls = await fs.readFile(logFile, 'utf8'); } catch { calls = ''; }
  const remoteCalls = calls.trim().split('\n').filter((line) =>
    /\b(?:fetch|pull|clone|ls-remote)\b/.test(line));
  assert.equal(remoteCalls.join(' | '), '', 'a rerun never fetches or pulls the setup repository remote');
});

test('bootstrap reports a local conflict while still reporting the refreshed setup repository bundle', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-bootstrap-local-conflict-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRepo = await bootstrapRepo(t, root);
  const fakeTools = await fakeGitHubTools(t, sourceRepo);
  const agentDir = path.join(root, 'agent');
  const setupDir = path.join(root, 'private-checkout');
  const args = ['bootstrap', '--repo-url', 'https://github.com/acme/private-setup.git', '--repo', setupDir, '--agent-dir', agentDir];

  const first = run(args, { ...fakeTools, FAKE_GIT_ACCESS: 'yes' });
  assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);

  const localSkill = path.join(agentDir, 'skills', 'pi-sync', 'SKILL.md');
  await fs.writeFile(localSkill, '# Local edit\n');

  const { cli: fixtureCli, fixture } = await packageFixture(t, root, {
    version: '9.9.0',
    mutate: async (dir) => {
      await fs.appendFile(path.join(dir, 'resources', 'skills', 'pi-sync', 'SKILL.md'), '\n# Refreshed bundle marker\n');
    },
  });

  const response = runWith(fixtureCli, args, { ...fakeTools, FAKE_GIT_ACCESS: 'yes' });
  assert.equal(response.status, 1, `${response.stderr}\n${response.stdout}`);
  const output = result(response);
  assert.equal(output.ok, false);
  assert.equal(output.errorCode, 'APPLY_CONFLICT');
  assert.match(output.error, /setup repository was already refreshed/);
  assert.equal(output.packageVersion, '9.9.0');
  assert.equal(output.plan.ok, false);
  assert.equal(output.plan.conflicts[0].target, 'skills/pi-sync');
  assert.equal(await fs.readFile(localSkill, 'utf8'), '# Local edit\n', 'the local conflict is left untouched');
  assert.equal(await fs.readFile(path.join(setupDir, 'resources', 'skills', 'pi-sync', 'SKILL.md'), 'utf8'),
    await fs.readFile(path.join(fixture, 'resources', 'skills', 'pi-sync', 'SKILL.md'), 'utf8'),
    'the setup repository bundle was refreshed before planning');
  assert.deepEqual(output.bundledResources, [
    { type: 'skill', source: 'resources/skills/pi-sync', target: 'skills/pi-sync', action: 'refreshed' },
    { type: 'extension', source: 'resources/extensions/pi-sync', target: 'extensions/pi-sync', action: 'already-current' },
  ]);
});

test('runCommand timeout is deterministic: a killed child reports ETIMEDOUT, a completed child its own status', async (t) => {
  const { runCommand } = await import('../dist/cli/process.js');
  const timedOut = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 400)'], {}, 100);
  assert.equal(timedOut.status, null, 'a child killed at the deadline has no process status');
  assert.equal(timedOut.error?.code, 'ETIMEDOUT');

  const completed = await runCommand(process.execPath, ['-e', 'setTimeout(() => process.exit(7), 20)'], {}, 500);
  assert.equal(completed.status, 7, 'a child that completes on its own reports its own status');
  assert.equal(completed.error, null);
});

test('gitExecutable resolves to the bare name on non-Windows platforms', async (t) => {
  if (process.platform === 'win32') return; // Windows resolution is covered by the platform-appropriate smoke test
  const { gitExecutable } = await import('../dist/cli/process.js');
  assert.equal(await gitExecutable(), 'git');
});

test('gitExecutable resolves a path-qualified Windows git.exe and distrusts shims', async (t) => {
  // Exercise the Windows branch on any host: the platform check is the only
  // host dependency, and the resolution is driven by a fake `where` on PATH.
  // Fresh module instances (query-string imports) give fresh resolution caches.
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalPath = process.env.PATH;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  t.after(() => {
    Object.defineProperty(process, 'platform', platformDescriptor);
    process.env.PATH = originalPath;
  });

  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-where-'));
  t.after(() => fs.rm(bin, { recursive: true, force: true }));
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`;

  // A path-qualified .exe from `where` is trusted: git then spawns shell-free,
  // so arguments are never interpreted by cmd.exe.
  await fs.writeFile(path.join(bin, 'where'), `#!${process.execPath}\nconsole.log('C:/Program Files/Git/cmd/git.exe');\n`, { mode: 0o755 });
  const resolved = await (await import(`../dist/cli/process.js?gitexe-exe-${Date.now()}`)).gitExecutable();
  assert.equal(resolved, 'C:/Program Files/Git/cmd/git.exe');

  // A .cmd shim cannot be launched shell-free, so the bare name keeps the
  // legacy shell behavior rather than a broken direct spawn.
  await fs.writeFile(path.join(bin, 'where'), `#!${process.execPath}\nconsole.log('C:/Program Files/Git/cmd/git.cmd');\n`, { mode: 0o755 });
  const shimmed = await (await import(`../dist/cli/process.js?gitexe-shim-${Date.now()}`)).gitExecutable();
  assert.equal(shimmed, 'git');

  // `where` finding nothing falls back to the bare name as well.
  await fs.rm(path.join(bin, 'where'));
  const missing = await (await import(`../dist/cli/process.js?gitexe-none-${Date.now()}`)).gitExecutable();
  assert.equal(missing, 'git');
});
