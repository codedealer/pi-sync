import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourcePath = fileURLToPath(new URL('../resources/extensions/pi-sync/index.ts', import.meta.url));
const statusPath = fileURLToPath(new URL('../resources/extensions/pi-sync/status.js', import.meta.url));
const processPath = fileURLToPath(new URL('../resources/extensions/pi-sync/process.js', import.meta.url));
const guardPath = fileURLToPath(new URL('../resources/extensions/pi-sync/guard.ts', import.meta.url));
const envKeys = [
  'PI_SYNC_REPO_DIR', 'PI_SYNC_BIN', 'PI_TEST_AGENT_DIR', 'PI_TEST_CLI_LOG', 'PI_TEST_UPDATE_RESULT',
  'PI_TEST_UPDATE_DELAY_MS', 'PI_TEST_UPDATE_DONE', 'PI_TEST_UPDATE_EXIT', 'PI_SKIP_VERSION_CHECK', 'PATH',
];

async function fixture(t, { manifest = true, result, delayMs = 0, exitFailure = false, skipVersionCheck } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-update-notice-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });

  const setup = path.join(root, 'setup');
  const agentDir = path.join(root, 'agent');
  const binDir = path.join(root, 'bin');
  const log = path.join(root, 'cli.jsonl');
  const done = path.join(root, 'update.done');
  const extensionDir = path.join(root, 'resources', 'extensions', 'pi-sync');
  const moduleDir = path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent');
  await Promise.all([
    fs.mkdir(setup, { recursive: true }), fs.mkdir(agentDir, { recursive: true }), fs.mkdir(binDir, { recursive: true }),
    fs.mkdir(extensionDir, { recursive: true }), fs.mkdir(moduleDir, { recursive: true }),
  ]);
  if (manifest) {
    await fs.writeFile(path.join(setup, 'pi-sync.json'), JSON.stringify({
      schemaVersion: 1, resources: [], dependencies: [], settings: [],
    }));
  }
  await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
  await fs.writeFile(path.join(moduleDir, 'package.json'), '{"type":"module","exports":"./index.js"}\n');
  await fs.writeFile(path.join(moduleDir, 'index.js'), 'export function getAgentDir() { return process.env.PI_TEST_AGENT_DIR; }\n');
  await fs.copyFile(statusPath, path.join(extensionDir, 'status.js'));
  await fs.copyFile(processPath, path.join(extensionDir, 'process.js'));
  const guardTranspiled = ts.transpileModule(await fs.readFile(guardPath, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    reportDiagnostics: true,
  });
  assert.deepEqual(guardTranspiled.diagnostics ?? [], [], 'guard transpiles without TypeScript diagnostics');
  await fs.writeFile(path.join(extensionDir, 'guard.js'), guardTranspiled.outputText);
  const transpiled = ts.transpileModule(await fs.readFile(sourcePath, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    reportDiagnostics: true,
  });
  assert.deepEqual(transpiled.diagnostics ?? [], [], 'extension transpiles without TypeScript diagnostics');
  await fs.writeFile(path.join(extensionDir, 'index.js'), transpiled.outputText);
  const cliScript = `#!/usr/bin/env node
import fs from 'node:fs';
const [command] = process.argv.slice(2);
fs.appendFileSync(process.env.PI_TEST_CLI_LOG, JSON.stringify({ command, args: process.argv.slice(2) }) + '\\n');
if (command === 'pi-update') {
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.PI_TEST_UPDATE_DELAY_MS || 0)));
  const result = JSON.parse(process.env.PI_TEST_UPDATE_RESULT || JSON.stringify({ apiVersion: 1, command: 'pi-update', ok: true, mode: 'preview', candidate: { version: '9.8.7' } }));
  console.log(JSON.stringify(result));
  fs.writeFileSync(process.env.PI_TEST_UPDATE_DONE, 'done');
  if (process.env.PI_TEST_UPDATE_EXIT === '1') process.exitCode = 2;
} else if (command === 'status') {
  console.log(JSON.stringify({ apiVersion: 1, command: 'status', ok: true, summary: { localPending: 0, remotePending: 0, needsReview: 0, clean: true } }));
} else if (command === 'sync') {
  console.log(JSON.stringify({ apiVersion: 1, command: 'sync', ok: true, synced: [] }));
}
`;
  const cliBin = path.join(binDir, 'pi-sync');
  await fs.writeFile(cliBin, cliScript, { mode: 0o755 });
  const gitBin = path.join(binDir, 'git');
  await fs.writeFile(gitBin, '#!/bin/sh\nexit 1\n', { mode: 0o755 });

  process.env.PI_SYNC_REPO_DIR = setup;
  process.env.PI_SYNC_BIN = cliBin;
  process.env.PI_TEST_AGENT_DIR = agentDir;
  process.env.PI_TEST_CLI_LOG = log;
  process.env.PI_TEST_UPDATE_RESULT = JSON.stringify(result ?? {
    apiVersion: 1, command: 'pi-update', ok: true, mode: 'preview', candidate: { version: '9.8.7' },
  });
  process.env.PI_TEST_UPDATE_DELAY_MS = String(delayMs);
  process.env.PI_TEST_UPDATE_DONE = done;
  process.env.PI_TEST_UPDATE_EXIT = exitFailure ? '1' : '0';
  process.env.PATH = `${binDir}${path.delimiter}${previous.PATH ?? ''}`;
  if (skipVersionCheck === undefined) delete process.env.PI_SKIP_VERSION_CHECK;
  else process.env.PI_SKIP_VERSION_CHECK = skipVersionCheck;

  const moduleUrl = pathToFileURL(path.join(extensionDir, 'index.js')).href;
  const { default: extension } = await import(moduleUrl);
  const handlers = new Map();
  const notifications = [];
  const statuses = [];
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: () => {},
  };
  const ctx = {
    hasUI: true,
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
      setStatus: (...args) => statuses.push(args),
      theme: { fg: (_color, text) => text },
    },
  };
  extension(pi);
  return { root, log, done, setup, agentDir, handlers, notifications, statuses, pi, ctx };
}

async function waitFor(predicate, message, timeoutMs = 2500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${message}`);
}

async function cliCalls(log, command) {
  try {
    return (await fs.readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse).filter((entry) => entry.command === command);
  } catch {
    return [];
  }
}

test('managed startup suppresses Pi check before its lifecycle check and asynchronously notifies only eligible updates once', async (t) => {
  const state = await fixture(t, { delayMs: 300 });
  assert.equal(process.env.PI_SKIP_VERSION_CHECK, '1', 'extension initialization takes ownership before Pi checks versions');

  // Compatibility smoke for Pi's documented lifecycle: its built-in check runs
  // after extension initialization and honors PI_SKIP_VERSION_CHECK.
  let piBuiltInNoticeCount = 0;
  if (!process.env.PI_SKIP_VERSION_CHECK) piBuiltInNoticeCount++;
  assert.equal(piBuiltInNoticeCount, 0);

  const start = Date.now();
  state.handlers.get('session_start')({ reason: 'startup' }, state.ctx);
  assert.ok(Date.now() - start < 100, 'startup handler does not wait for the delayed CLI check');
  await waitFor(() => fs.access(state.done).then(() => true, () => false), 'pi-update check completion');
  await waitFor(() => state.notifications.some((item) => item.message.includes('Pi 9.8.7')), 'eligible version notification');
  const notice = state.notifications.find((item) => item.message.includes('Pi 9.8.7'));
  assert.equal(notice.level, 'warning');
  assert.match(notice.message, /Pi Sync Update Available/);
  assert.match(notice.message, /pi-sync pi-update --apply/);
  assert.equal(state.notifications.filter((item) => item.message.includes('Pi Sync Update Available')).length, 1);
  assert.deepEqual((await cliCalls(state.log, 'pi-update')).map((entry) => entry.args), [
    ['pi-update', '--repo', state.setup, '--agent-dir', state.agentDir],
  ]);

  for (const reason of ['resume', 'fork', 'new']) state.handlers.get('session_start')({ reason }, state.ctx);
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal((await cliCalls(state.log, 'pi-update')).length, 1, 'resume, fork, and new-session do not repeat startup check');
  assert.equal(state.notifications.some((item) => item.message.includes('Pi Sync Update Available')), true);
  assert.equal(Object.hasOwn(state.ctx, 'appendEntry'), false, 'notice is UI-only, not a transcript or context message');
});

test('unmanaged setups preserve Pi built-in behavior and do not run the Pi Sync check', async (t) => {
  const state = await fixture(t, { manifest: false });
  assert.equal(process.env.PI_SKIP_VERSION_CHECK, undefined);
  let piBuiltInNoticeCount = 0;
  if (!process.env.PI_SKIP_VERSION_CHECK) piBuiltInNoticeCount++;
  assert.equal(piBuiltInNoticeCount, 1);
  state.handlers.get('session_start')({ reason: 'startup' }, state.ctx);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await cliCalls(state.log, 'pi-update'), []);
  assert.deepEqual(state.notifications, []);
});

test('managed initialization preserves an explicitly supplied PI_SKIP_VERSION_CHECK value', async (t) => {
  const state = await fixture(t, { skipVersionCheck: 'custom-value' });
  assert.equal(process.env.PI_SKIP_VERSION_CHECK, 'custom-value');
  state.handlers.get('session_start')({ reason: 'startup' }, state.ctx);
  await waitFor(() => fs.access(state.done).then(() => true, () => false), 'pi-update check completion');
  await waitFor(() => state.notifications.some((item) => item.message.includes('Pi 9.8.7')), 'Pi Sync notice despite preserved configuration');
  assert.equal(process.env.PI_SKIP_VERSION_CHECK, 'custom-value');
  assert.equal((await cliCalls(state.log, 'pi-update')).length, 1);
});

test('a no-candidate result shows no version-specific startup notice', async (t) => {
  const state = await fixture(t, { result: {
    apiVersion: 1, command: 'pi-update', ok: true, mode: 'preview', candidate: null,
  } });
  state.handlers.get('session_start')({ reason: 'startup' }, state.ctx);
  await waitFor(() => fs.access(state.done).then(() => true, () => false), 'no-candidate check completion');
  assert.equal(state.notifications.some((item) => item.message.includes('Pi Sync Update Available')), false);
});

test('a failed check never breaks startup or shows a version-specific notice', async (t) => {
  const state = await fixture(t, { exitFailure: true });
  const start = Date.now();
  state.handlers.get('session_start')({ reason: 'startup' }, state.ctx);
  assert.ok(Date.now() - start < 100, 'startup does not wait for a failing CLI check');
  await waitFor(() => fs.access(state.done).then(() => true, () => false), 'failed check completion');
  assert.equal(state.notifications.some((item) => item.message.includes('Pi Sync Update Available')), false);
});
