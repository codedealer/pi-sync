import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { computeFingerprint, fingerprintPaths, statusCachePath } from '../resources/extensions/pi-sync/status.js';

const sourcePath = fileURLToPath(new URL('../resources/extensions/pi-sync/index.ts', import.meta.url));
const statusPath = fileURLToPath(new URL('../resources/extensions/pi-sync/status.js', import.meta.url));
const processPath = fileURLToPath(new URL('../resources/extensions/pi-sync/process.js', import.meta.url));
const guardPath = fileURLToPath(new URL('../resources/extensions/pi-sync/guard.ts', import.meta.url));
const envKeys = [
  'PI_SYNC_REPO_DIR', 'PI_SYNC_BIN', 'PI_TEST_AGENT_DIR', 'PI_TEST_CLI_LOG', 'PI_TEST_GIT_LOG',
  'PI_TEST_STATUS_DELAY_MS', 'PI_TEST_STATUS_FAIL', 'PI_TEST_STATUS_SUMMARY', 'PI_TEST_SYNC_API_VERSION', 'PI_SKIP_VERSION_CHECK', 'PATH',
];

const CLEAN_SUMMARY = { localPending: 0, remotePending: 0, needsReview: 0, clean: true };
const BEHIND_SUMMARY = { localPending: 0, remotePending: 2, needsReview: 0, clean: false };

async function fixture(t, { delayMs = 0, statusSummary = CLEAN_SUMMARY } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-extension-startup-'));
  t.after(async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
      try {
        await fs.access(root);
        await new Promise((resolve) => setTimeout(resolve, 20));
      } catch {
        return;
      }
    }
  });
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
  const gitLog = path.join(root, 'git.jsonl');
  const extensionDir = path.join(root, 'resources', 'extensions', 'pi-sync');
  const moduleDir = path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent');
  await Promise.all([
    fs.mkdir(setup, { recursive: true }), fs.mkdir(agentDir, { recursive: true }), fs.mkdir(binDir, { recursive: true }),
    fs.mkdir(extensionDir, { recursive: true }), fs.mkdir(moduleDir, { recursive: true }),
  ]);
  await fs.writeFile(path.join(setup, 'pi-sync.json'), JSON.stringify({
    schemaVersion: 1, resources: [], dependencies: [], settings: [{ target: 'settings.json' }],
  }));

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
  console.log(JSON.stringify({ apiVersion: 2, command: 'pi-update', ok: true, mode: 'preview', candidate: null }));
} else if (command === 'status') {
  if (process.env.PI_TEST_STATUS_FAIL === '1') process.exit(1);
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.PI_TEST_STATUS_DELAY_MS || 0)));
  console.log(JSON.stringify({ apiVersion: 2, command: 'status', ok: true, summary: JSON.parse(process.env.PI_TEST_STATUS_SUMMARY || JSON.stringify(${JSON.stringify(CLEAN_SUMMARY)})) }));
} else if (command === 'sync') {
  console.log(JSON.stringify({ apiVersion: Number(process.env.PI_TEST_SYNC_API_VERSION || 2), command: 'sync', ok: true, synced: [] }));
}
`;
  const cliBin = path.join(binDir, 'pi-sync');
  await fs.writeFile(cliBin, cliScript, { mode: 0o755 });
  // The extension must no longer spawn git itself: the CLI owns the fetch.
  // This fake records every call so a stray fetch is observable.
  const gitBin = path.join(binDir, 'git');
  await fs.writeFile(gitBin, `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.appendFileSync(process.env.PI_TEST_GIT_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');\n`, { mode: 0o755 });

  process.env.PI_SYNC_REPO_DIR = setup;
  process.env.PI_SYNC_BIN = cliBin;
  process.env.PI_TEST_AGENT_DIR = agentDir;
  process.env.PI_TEST_CLI_LOG = log;
  process.env.PI_TEST_GIT_LOG = gitLog;
  process.env.PI_TEST_STATUS_DELAY_MS = String(delayMs);
  process.env.PI_TEST_STATUS_FAIL = '0';
  process.env.PI_TEST_STATUS_SUMMARY = JSON.stringify(statusSummary);
  process.env.PATH = `${binDir}${path.delimiter}${previous.PATH ?? ''}`;
  delete process.env.PI_SKIP_VERSION_CHECK;

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
      setStatus: (...args) => statuses.push({ args, t: Date.now() }),
      theme: { fg: (_color, text) => text },
    },
  };
  extension(pi);
  let shutdownDone = false;
  const shutdown = () => {
    if (shutdownDone) return;
    shutdownDone = true;
    handlers.get('session_shutdown')({}, ctx);
  };
  t.after(shutdown);
  return { root, log, gitLog, setup, agentDir, handlers, notifications, statuses, pi, ctx, shutdown };
}

async function waitFor(predicate, message, timeoutMs = 3000) {
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

async function gitCalls(log) {
  try {
    return (await fs.readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch {
    return [];
  }
}

// The footer texts currently set on the UI, in order.
function footerTexts(statuses) {
  return statuses.map((entry) => entry.args[1]).filter((text) => typeof text === 'string');
}

// Touch a top-level, non-fingerprinted file of the setup repository to
// trigger the debounced repository-watcher refresh.
async function touchRepo(setup) {
  const marker = path.join(setup, 'notes.txt');
  await fs.writeFile(marker, `${Date.now()}\n`);
}

test('session-start refresh runs a fresh CLI status, is non-blocking, and never fetches in the extension', async (t) => {
  const state = await fixture(t, { delayMs: 300 });
  const start = Date.now();
  state.handlers.get('session_start')({ reason: 'startup' }, state.ctx);
  assert.ok(Date.now() - start < 100, 'startup handler does not await the CLI status');

  // A second session start while the first refresh is still in flight must
  // not duplicate the upstream fetch: shutdown (which closes the watchers)
  // followed by a new start hits the single-flight guard.
  state.handlers.get('session_shutdown')({}, state.ctx);
  state.handlers.get('session_start')({ reason: 'startup' }, state.ctx);

  await waitFor(() => cliCalls(state.log, 'status').then((calls) => calls.length === 1), 'session-start status run');
  const [call] = await cliCalls(state.log, 'status');
  // The CLI status owns upstream freshness: no --no-fetch on session start.
  assert.deepEqual(call.args, ['status', '--json', '--repo', state.setup, '--agent-dir', state.agentDir]);

  await waitFor(() => footerTexts(state.statuses).some((text) => text.includes('✓')), 'clean footer');
  assert.equal((await cliCalls(state.log, 'status')).length, 1, 'no duplicate fetch for an overlapping start');
  assert.deepEqual(await gitCalls(state.gitLog), [], 'the extension spawns no git (no duplicate fetch)');
  state.shutdown();
});

test('a matching shared cache cannot suppress the required session-start refresh', async (t) => {
  const state = await fixture(t);
  // Pre-seed the shared status cache with the exact current fingerprint and
  // a recognizable summary, as a previous session would have published.
  const fingerprint = computeFingerprint(fingerprintPaths({ repoDir: state.setup, agentDir: state.agentDir, settingsTargets: ['settings.json'] }));
  await fs.mkdir(path.dirname(statusCachePath(state.agentDir)), { recursive: true });
  await fs.writeFile(statusCachePath(state.agentDir), JSON.stringify({ fingerprint, summary: BEHIND_SUMMARY }));

  state.handlers.get('session_start')({ reason: 'startup' }, state.ctx);
  await waitFor(() => cliCalls(state.log, 'status').then((calls) => calls.length === 1), 'session-start status despite a matching cache');

  // The footer reflects the fresh CLI result, not the cached summary.
  await waitFor(() => footerTexts(state.statuses).some((text) => text.includes('✓')), 'fresh footer');
  assert.ok(!footerTexts(state.statuses).some((text) => text.includes('↓2')), 'cached behind summary never rendered');
  state.shutdown();
});

test('non-session-start refreshes stay offline and cache-first', async (t) => {
  const state = await fixture(t);
  state.handlers.get('session_start')({ reason: 'startup' }, state.ctx);
  await waitFor(() => cliCalls(state.log, 'status').then((calls) => calls.length === 1), 'session-start status run');
  // The successful refresh publishes the shared cache entry.
  await waitFor(() => fs.access(statusCachePath(state.agentDir)).then(() => true, () => false), 'cache publication');

  // A watcher-triggered refresh with an unchanged fingerprint is a no-op
  // (in-memory dedupe) and spawns no CLI at all.
  await touchRepo(state.setup);
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal((await cliCalls(state.log, 'status')).length, 1, 'steady-state refresh spawns no CLI');

  // The shared cache is cross-session: another session may have observed a
  // newer fingerprint and published its summary. This session's in-memory
  // fingerprint is stale (a failed or missed re-check), so the watcher
  // refresh must re-check — and the matching cache entry satisfies it
  // without a CLI spawn.
  const manifest = path.join(state.setup, 'pi-sync.json');
  await fs.writeFile(manifest, JSON.stringify({ schemaVersion: 1, resources: [], dependencies: [], settings: [{ target: 'settings.json' }] }));
  const fingerprint = computeFingerprint(fingerprintPaths({ repoDir: state.setup, agentDir: state.agentDir, settingsTargets: ['settings.json'] }));
  await fs.writeFile(statusCachePath(state.agentDir), JSON.stringify({ fingerprint, summary: BEHIND_SUMMARY }));
  await waitFor(() => footerTexts(state.statuses).some((text) => text.includes('↓2')), 'cached summary footer');
  assert.equal((await cliCalls(state.log, 'status')).length, 1, 'matching cache satisfies the re-check');

  // With the cache gone, a further fingerprint move runs the CLI status —
  // offline (--no-fetch), so the periodic path never touches the network.
  await fs.rm(statusCachePath(state.agentDir));
  await fs.writeFile(manifest, JSON.stringify({ schemaVersion: 1, resources: [], dependencies: [], settings: [{ target: 'settings.json' }] }));
  await waitFor(() => cliCalls(state.log, 'status').then((calls) => calls.length === 2), 'offline status after cache miss');
  const [, second] = await cliCalls(state.log, 'status');
  assert.deepEqual(second.args, ['status', '--json', '--no-fetch', '--repo', state.setup, '--agent-dir', state.agentDir]);
  await waitFor(() => fs.access(statusCachePath(state.agentDir)).then(() => true, () => false), 'cache republished');
  state.shutdown();
});

test('a failed refresh keeps the failure state but retains the last successful summary', async (t) => {
  const state = await fixture(t, { statusSummary: BEHIND_SUMMARY });
  state.handlers.get('session_start')({ reason: 'startup' }, state.ctx);
  await waitFor(() => footerTexts(state.statuses).some((text) => text.includes('↓2')), 'behind footer');

  // Break the CLI and force a re-check by moving a fingerprinted file
  // (the manifest mtime is part of the fingerprint).
  process.env.PI_TEST_STATUS_FAIL = '1';
  const manifest = path.join(state.setup, 'pi-sync.json');
  await fs.writeFile(manifest, JSON.stringify({ schemaVersion: 1, resources: [], dependencies: [], settings: [{ target: 'settings.json' }] }));
  await waitFor(() => footerTexts(state.statuses).some((text) => text.includes('✗')), 'failure footer');

  // The failure must not have erased the last successful summary: the
  // shared cache still carries it, and the footer returns to it once the
  // next check succeeds.
  const cached = JSON.parse(await fs.readFile(statusCachePath(state.agentDir), 'utf8'));
  assert.deepEqual(cached.summary, BEHIND_SUMMARY, 'cache keeps the last successful summary');

  process.env.PI_TEST_STATUS_FAIL = '0';
  await fs.writeFile(manifest, JSON.stringify({ schemaVersion: 1, resources: [], dependencies: [], settings: [{ target: 'settings.json' }] }));
  await waitFor(() => {
    const texts = footerTexts(state.statuses);
    const failed = texts.map((text, i) => (text.includes('✗') ? i : -1)).filter((i) => i !== -1).pop();
    const summary = texts.map((text, i) => (text.includes('↓2') ? i : -1)).filter((i) => i !== -1).pop();
    return failed !== undefined && summary !== undefined && summary > failed;
  }, 'footer returns to the last successful summary');
  const texts = footerTexts(state.statuses);
  assert.ok(texts.lastIndexOf('pi-sync ↓2') > texts.lastIndexOf('pi-sync ✗'), 'the summary footer follows the failure footer');
  state.shutdown();
});
test('an unsupported sync API version degrades to a warning instead of crashing', async (t) => {
  const state = await fixture(t);
  // The session-start handler arms the debounced initial sync (~1.5 s later);
  // the spawned CLI reads the API version at spawn time, so the guard sees an
  // unsupported apiVersion.
  process.env.PI_TEST_SYNC_API_VERSION = '1';
  state.handlers.get('session_start')({ reason: 'startup' }, state.ctx);
  await waitFor(() => cliCalls(state.log, 'sync').then((calls) => calls.length >= 1), 'initial sync run', 5000);

  // The version guard throws inside runSync's try; the catch must degrade to
  // a one-shot warning rather than crashing the session.
  await waitFor(
    () => state.notifications.some((entry) => entry.level === 'warning' && /unsupported JSON API version/.test(entry.message)),
    'unsupported-version warning',
    5000
  );
  const warning = state.notifications.find((entry) => /unsupported JSON API version/.test(entry.message));
  assert.match(warning.message, /automatic settings sync failed/);
  assert.match(warning.message, /it will retry on the next change/);

  // Warn-once: the extension must stay alive after the failure. A subsequent
  // session-start refresh still runs a fresh CLI status (the process and its
  // handlers were never torn down by the guard's throw). Shut down the first
  // session first: session_start re-arms the watchers, and only the latest
  // pair is closed at shutdown, so the previous session must be torn down
  // before a new one starts.
  const statusBefore = (await cliCalls(state.log, 'status')).length;
  state.handlers.get('session_shutdown')({}, state.ctx);
  state.handlers.get('session_start')({ reason: 'startup' }, state.ctx);
  await waitFor(() => cliCalls(state.log, 'status').then((calls) => calls.length === statusBefore + 1), 'post-failure status run', 5000);
  assert.equal(state.notifications.filter((entry) => /unsupported JSON API version/.test(entry.message)).length, 1, 'the warning is emitted exactly once');
  state.shutdown();
});
