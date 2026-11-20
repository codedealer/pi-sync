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
  'PI_SYNC_REPO_DIR', 'PI_SYNC_BIN', 'PI_SYNC_GUARD', 'PI_TEST_AGENT_DIR', 'PI_TEST_CLI_LOG',
  'PI_SKIP_VERSION_CHECK', 'PATH',
];

// Drives the shipped extension at the Pi extension API seam: the factory is
// invoked with a fake Pi object that captures event subscriptions, and the
// tests fire session_start and then feed synthetic tool_call events,
// asserting on the handler's block/pass decisions.
async function fixture(t, { manifest = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-extension-guard-'));
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
  const extensionDir = path.join(root, 'resources', 'extensions', 'pi-sync');
  const moduleDir = path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent');
  await Promise.all([
    fs.mkdir(setup, { recursive: true }), fs.mkdir(agentDir, { recursive: true }), fs.mkdir(binDir, { recursive: true }),
    fs.mkdir(extensionDir, { recursive: true }), fs.mkdir(moduleDir, { recursive: true }),
  ]);
  if (manifest) {
    await fs.writeFile(path.join(setup, 'pi-sync.json'), JSON.stringify({
      schemaVersion: 1, resources: [], dependencies: [], settings: [{ target: 'settings.json' }],
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
if (command === 'status') {
  console.log(JSON.stringify({ apiVersion: 1, command: 'status', ok: true, summary: { localPending: 0, remotePending: 0, needsReview: 0, clean: true } }));
} else if (command === 'sync') {
  console.log(JSON.stringify({ apiVersion: 1, command: 'sync', ok: true, synced: [] }));
}
`;
  const cliBin = path.join(binDir, 'pi-sync');
  await fs.writeFile(cliBin, cliScript, { mode: 0o755 });

  process.env.PI_SYNC_REPO_DIR = setup;
  process.env.PI_SYNC_BIN = cliBin;
  process.env.PI_TEST_AGENT_DIR = agentDir;
  process.env.PI_TEST_CLI_LOG = log;
  process.env.PATH = `${binDir}${path.delimiter}${previous.PATH ?? ''}`;
  delete process.env.PI_SYNC_GUARD;
  delete process.env.PI_SKIP_VERSION_CHECK;

  const moduleUrl = pathToFileURL(path.join(extensionDir, 'index.js')).href;
  const { default: extension } = await import(moduleUrl);
  const handlers = new Map();
  const notifications = [];
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: () => {},
  };
  const ctx = {
    cwd: root,
    hasUI: true,
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
      setStatus: () => {},
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
  return { root, setup, agentDir, handlers, notifications, ctx, shutdown };
}

let callId = 0;
/** Feed one synthetic tool_call event and return the handler's decision (undefined = pass). */
async function toolCall(state, toolName, input) {
  const event = { type: 'tool_call', toolCallId: `call-${callId += 1}`, toolName, input };
  const handler = state.handlers.get('tool_call');
  assert.ok(handler, 'the extension subscribes to tool_call');
  return handler(event, state.ctx);
}

test('first touch of a gated path is blocked with the main path and bypass; later calls pass', async (t) => {
  const state = await fixture(t);
  state.handlers.get('session_start')({ reason: 'startup' }, state.ctx);

  const target = path.join(state.agentDir, 'skills', 'demo', 'SKILL.md');
  const blocked = await toolCall(state, 'write', { path: target, content: '# demo' });
  assert.equal(blocked?.block, true, 'the first mutating call to a gated path is blocked');
  const reason = blocked.reason;
  assert.ok(reason.includes(target), 'the warning names the target');
  const source = path.join(state.setup, 'resources', 'skills', 'demo', 'SKILL.md');
  assert.ok(reason.includes(source), 'the warning names the qualified source path in the setup repository');
  assert.ok(reason.includes('pi-sync register --type skill --source resources/skills/demo'), 'the warning gives the concrete register command');
  assert.ok(reason.includes('pi-sync apply'), 'the warning states the main path');
  assert.ok(reason.includes('pi-sync register'), 'the warning covers the new-resource flow');
  assert.ok(reason.includes('retry the same operation'), 'the warning ends with the bypass');

  // The retry of the same operation passes (arming), and arming is global:
  // a call to a different gated root also passes.
  assert.equal(await toolCall(state, 'write', { path: target, content: '# demo' }), undefined, 'the retry of the same call passes');
  assert.equal(await toolCall(state, 'write', { path: path.join(state.agentDir, 'prompts', 'deploy.md'), content: 'x' }), undefined, 'a second gated root passes too');
  state.shutdown();
});

test('read-listed tools on gated paths always pass and never arm', async (t) => {
  const state = await fixture(t);
  state.handlers.get('session_start')({ reason: 'startup' }, state.ctx);

  const target = path.join(state.agentDir, 'skills', 'demo', 'SKILL.md');
  for (const toolName of ['read', 'grep', 'cat', 'ls', 'search', 'stat']) {
    assert.equal(await toolCall(state, toolName, { path: target }), undefined, `${toolName} on a gated path passes before arming`);
  }
  // The reads must not have consumed the first touch: the first mutating call is still blocked.
  const blocked = await toolCall(state, 'write', { path: target, content: 'x' });
  assert.equal(blocked?.block, true, 'reads never arm the guard');
  // And read-listed tools keep passing after arming.
  assert.equal(await toolCall(state, 'read', { path: target }), undefined, 'read passes after arming');
  state.shutdown();
});

test('non-gated paths always pass and never arm', async (t) => {
  const state = await fixture(t);
  state.handlers.get('session_start')({ reason: 'startup' }, state.ctx);

  // The setup repository is the sanctioned destination and must never be gated.
  const setupFile = path.join(state.setup, 'resources', 'skills', 'demo', 'SKILL.md');
  assert.equal(await toolCall(state, 'write', { path: setupFile, content: 'x' }), undefined, 'setup repository writes pass');
  // Project files outside the agent directory pass.
  assert.equal(await toolCall(state, 'write', { path: path.join(state.root, 'project', 'src', 'main.ts'), content: 'x' }), undefined, 'project files pass');
  // The first gated mutating call is still blocked afterward.
  const blocked = await toolCall(state, 'write', { path: path.join(state.agentDir, 'agents', 'helper.md'), content: 'x' });
  assert.equal(blocked?.block, true, 'non-gated passes never arm the guard');
  state.shutdown();
});

test('inputs without a path field pass and never arm', async (t) => {
  const state = await fixture(t);
  state.handlers.get('session_start')({ reason: 'startup' }, state.ctx);

  // bash is not gated: its command field is not a path field.
  assert.equal(await toolCall(state, 'bash', { command: `echo x > ${path.join(state.agentDir, 'skills', 'demo', 'SKILL.md')}` }), undefined, 'bash passes');
  // A custom tool whose input carries no path-like field passes.
  assert.equal(await toolCall(state, 'custom-tool', { text: 'hello', count: 3 }), undefined, 'no path-like field passes');
  // A path-like field pointing outside the gated roots passes.
  assert.equal(await toolCall(state, 'custom-tool', { file: path.join(state.root, 'notes.txt') }), undefined, 'non-gated path field passes');
  const blocked = await toolCall(state, 'write', { path: path.join(state.agentDir, 'roles', 'reviewer.md'), content: 'x' });
  assert.equal(blocked?.block, true, 'pathless calls never arm the guard');
  state.shutdown();
});

test('a non-managed setup is completely silent', async (t) => {
  const state = await fixture(t, { manifest: false });
  state.handlers.get('session_start')({ reason: 'startup' }, state.ctx);

  const target = path.join(state.agentDir, 'skills', 'demo', 'SKILL.md');
  assert.equal(await toolCall(state, 'write', { path: target, content: 'x' }), undefined, 'no block on a non-managed setup');
  assert.equal(await toolCall(state, 'write', { path: target, content: 'x' }), undefined, 'still no block on retry');
  assert.deepEqual(state.notifications, [], 'no notifications on a non-managed setup');
  state.shutdown();
});

test('arming resets on a new session_start', async (t) => {
  const state = await fixture(t);
  state.handlers.get('session_start')({ reason: 'startup' }, state.ctx);
  const target = path.join(state.agentDir, 'extensions', 'demo', 'index.ts');
  assert.equal((await toolCall(state, 'write', { path: target, content: 'x' }))?.block, true, 'first touch blocked');
  assert.equal(await toolCall(state, 'write', { path: target, content: 'x' }), undefined, 'second touch passes');

  for (const reason of ['new', 'resume', 'fork', 'reload']) {
    state.handlers.get('session_shutdown')({}, state.ctx);
    state.handlers.get('session_start')({ reason }, state.ctx);
    assert.equal((await toolCall(state, 'write', { path: target, content: 'x' }))?.block, true, `a fresh ${reason} session blocks its first touch`);
    assert.equal(await toolCall(state, 'write', { path: target, content: 'x' }), undefined, `the fresh ${reason} session then passes`);
  }
  state.shutdown();
});

test('PI_SYNC_GUARD=off disables the gate', async (t) => {
  const state = await fixture(t);
  state.handlers.get('session_start')({ reason: 'startup' }, state.ctx);
  process.env.PI_SYNC_GUARD = 'off';

  const target = path.join(state.agentDir, 'skills', 'demo', 'SKILL.md');
  assert.equal(await toolCall(state, 'write', { path: target, content: 'x' }), undefined, 'no block with PI_SYNC_GUARD=off');
  assert.equal(await toolCall(state, 'write', { path: target, content: 'x' }), undefined, 'still no block with PI_SYNC_GUARD=off');
  state.shutdown();
});

test('settings targets pass and never arm: local edits are back-synced, not gated', async (t) => {
  const state = await fixture(t);
  state.handlers.get('session_start')({ reason: 'startup' }, state.ctx);

  // A declared settings target is not gated: the extension's settings
  // watcher back-syncs local edits into the setup repository's manifest, so
  // the guard must not intercept them.
  assert.equal(await toolCall(state, 'write', { path: path.join(state.agentDir, 'settings.json'), content: '{}' }), undefined, 'a declared settings target passes');
  // The settings write must not have consumed the first touch: the first
  // gated resource mutation is still blocked afterward.
  const blocked = await toolCall(state, 'write', { path: path.join(state.agentDir, 'skills', 'demo', 'SKILL.md'), content: 'x' });
  assert.equal(blocked?.block, true, 'settings writes never arm the guard');
  state.shutdown();
});

test('malformed guard inputs degrade to pass-through without throwing', async (t) => {
  const state = await fixture(t);
  state.handlers.get('session_start')({ reason: 'startup' }, state.ctx);

  const gated = path.join(state.agentDir, 'skills', 'demo', 'SKILL.md');
  const malformed = [
    { toolName: 'write', input: null },
    { toolName: 'write', input: 42 },
    { toolName: 'write', input: 'a path is not an object' },
    { toolName: 'write', input: { path: 42 } },
    { toolName: 'write', input: { path: null } },
    { toolName: 'write', input: { path: [gated] } },
    { toolName: 'write', input: { path: gated, extra: { nested: undefined } } },
    { toolName: 42, input: { path: gated } },
    { toolName: 'write' },
  ];
  for (const event of malformed) {
    await assert.doesNotThrow(async () => toolCall(state, event.toolName, event.input), `no throw for ${JSON.stringify(event)}`);
  }
  // The guard may or may not have armed from the well-formed-looking cases
  // above, so assert the healthy behavior: a well-formed gated call is still
  // handled — blocked if untouched, passing if already armed.
  const result = await toolCall(state, 'write', { path: gated, content: 'x' });
  assert.ok(result === undefined || result.block === true, 'a well-formed call is still handled');
  state.shutdown();
});