import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const notifier = path.join(projectRoot, 'scripts', 'install-notice.js');

async function listing(directory) {
  const entries = [];
  async function walk(current, relative) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const rel = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) await walk(path.join(current, entry.name), rel);
      else entries.push(rel);
    }
  }
  await walk(directory, '');
  return entries.sort();
}

test('install notice prints the bootstrap rerun instruction and exits successfully', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-notice-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [notifier], {
    encoding: 'utf8',
    cwd: root,
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.equal(result.stderr, '', 'the notice prints to stdout only');
  assert.match(result.stdout, /bootstrap/);
  assert.match(result.stdout, /rerun/i);
  assert.match(result.stdout, /pi-sync bootstrap --repo-url/);
});

test('install notice performs no setup or local-installation writes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-notice-writes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const setupDir = path.join(root, 'setup');
  const agentDir = path.join(root, 'agent');
  await fs.mkdir(path.join(setupDir, 'resources', 'skills', 'hello'), { recursive: true });
  await fs.mkdir(path.join(agentDir, 'skills', 'local-only'), { recursive: true });
  await fs.writeFile(path.join(setupDir, 'resources', 'skills', 'hello', 'SKILL.md'), '# Hello\n');
  await fs.writeFile(path.join(setupDir, 'pi-sync.json'), '{}\n');
  await fs.writeFile(path.join(agentDir, 'skills', 'local-only', 'SKILL.md'), '# Local\n');
  const setupBefore = await listing(setupDir);
  const agentBefore = await listing(agentDir);
  const cwdBefore = await listing(root);

  const result = spawnSync(process.execPath, [notifier], {
    encoding: 'utf8',
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      PI_SYNC_REPO_DIR: setupDir,
      PI_CODING_AGENT_DIR: agentDir,
    },
  });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.deepEqual(await listing(setupDir), setupBefore, 'the setup repository is untouched');
  assert.deepEqual(await listing(agentDir), agentBefore, 'the local installation is untouched');
  assert.deepEqual(await listing(root), cwdBefore, 'the working directory is untouched');
});

test('install notice stays notice-only: no imports, environment reads, or side effects', async () => {
  const source = await fs.readFile(notifier, 'utf8');
  assert.ok(!/^\s*(?:import\s|require\s*\()\s*['"]/.test(source), 'the notifier must not import or require any module');
  assert.ok(!/process\s*\./.test(source), 'the notifier must not read the environment or process state');
  assert.ok(!/\b(?:fs|net|https?|child_process|worker_threads)\b/.test(source),
    'the notifier must not reference filesystem, network, or subprocess APIs');
});

test('package.json wires the notifier as a notice-only postinstall hook and ships it', async () => {
  const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts.postinstall, 'node scripts/install-notice.js');
  assert.ok(packageJson.files.includes('scripts/install-notice.js'),
    'the notice-only notifier is part of the narrow package allowlist');
  assert.ok(!Object.values(packageJson.scripts).some((command) => /\bpi-sync\b|bootstrap/.test(command)),
    'no package script invokes pi-sync or bootstrap');
});
