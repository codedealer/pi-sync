import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const sha = '0123456789abcdef0123456789abcdef01234567';

async function setup(t, { dependencies, packages, policy } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-packages-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'setup');
  const agentDir = path.join(root, 'agent');
  await fs.mkdir(repo, { recursive: true });
  await fs.writeFile(path.join(repo, 'pi-sync.json'), JSON.stringify({ schemaVersion: 1, resources: [], dependencies: dependencies ?? [], ...(policy ? { policy } : {}) }));
  await fs.writeFile(path.join(repo, 'pi-sync.lock.json'), JSON.stringify({ schemaVersion: 1, packages: packages ?? [] }));
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  const log = path.join(root, 'tool.log');
  const piState = path.join(root, 'pi-state.json');
  const faultModule = path.join(root, 'filesystem-fault.cjs');
  await fs.writeFile(faultModule, `const fs=require('node:fs');const path=require('node:path');const original=fs.promises.rename;let failed=false;fs.promises.rename=async function(source,destination){if(!failed&&process.env.FAKE_RENAME_FAIL_TARGET&&path.resolve(destination)===path.resolve(process.env.FAKE_RENAME_FAIL_TARGET)){failed=true;const error=new Error('controlled rename failure');error.code='EIO';throw error}return original.call(this,source,destination)};`);
  const npm = `#!/usr/bin/env node\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(process.env.FAKE_LOG,JSON.stringify({tool:'npm',args:a})+'\\n');if(a[0]==='view'&&a[2]==='versions')process.stdout.write(process.env.FAKE_VERSIONS||'["1.0.0","2.0.0"]');else if(a[0]==='view'&&a[2]==='time')process.stdout.write(process.env.FAKE_TIMES||'{}');else process.exit(2);`;
  const gh = `#!/usr/bin/env node\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(process.env.FAKE_LOG,JSON.stringify({tool:'gh',args:a})+'\\n');if(a[0]==='api')process.stdout.write(process.env.FAKE_RELEASES||'[]');else process.exit(2);`;
  const git = `#!/usr/bin/env node\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(process.env.FAKE_LOG,JSON.stringify({tool:'git',args:a})+'\\n');if(a[0]==='ls-remote')console.log(process.env.FAKE_SHA+'\\t'+a.at(-1));else process.exit(2);`;
  const pi = `#!/usr/bin/env node\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(process.env.FAKE_LOG,JSON.stringify({tool:'pi',args:a})+'\\n');const file=process.env.FAKE_PI_STATE;const state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{installed:[]};if(a[0]==='install'){if(process.env.FAKE_PI_FAIL==='yes'||process.env.FAKE_PI_FAIL_SPEC===a[1])process.exit(1);const identity=a[1].startsWith('npm:')?a[1].slice(0,a[1].lastIndexOf('@')):a[1].split('#')[0];state.installed=state.installed.filter((item)=>!(item.startsWith(identity+'@')||item.startsWith(identity+'#')));state.installed.push(a[1]);fs.writeFileSync(file,JSON.stringify(state));process.exit(0)}if(a[0]==='uninstall'){state.installed=state.installed.filter((item)=>item!==a[1]);fs.writeFileSync(file,JSON.stringify(state));process.exit(0)}if(a[0]==='update'&&a[1]==='--extensions'){state.installed=['npm:widget@999.0.0'];fs.writeFileSync(file,JSON.stringify(state));process.exit(0)}process.exit(2);`;
  for (const [name, content] of Object.entries({ npm, gh, git, pi })) await fs.writeFile(path.join(bin, name), content, { mode: 0o755 });
  return { root, repo, agentDir, bin, log, piState, faultModule };
}

function run(f, args, extra = {}) {
  return spawnSync(process.execPath, [cli, ...args, '--repo', f.repo, '--agent-dir', f.agentDir], {
    encoding: 'utf8', env: { ...process.env, PATH: `${f.bin}${path.delimiter}${process.env.PATH}`, FAKE_LOG: f.log, FAKE_PI_STATE: f.piState,
      FAKE_SHA: sha, ...extra },
  });
}
function output(result) { return JSON.parse(result.stdout); }
function entries(f) { return fs.readFile(f.log, 'utf8').then((text) => text.trim().split('\n').filter(Boolean).map(JSON.parse)).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error)); }

const npmDependency = [{ type: 'npm', name: 'widget' }];
const npmPin = [{ type: 'npm', name: 'widget', version: '1.0.0', releasedAt: '2020-01-01T00:00:00.000Z' }];

test('apply uses exact npm pins; standalone pi update is unsupported and can move a managed package beyond its pin', async (t) => {
  const f = await setup(t, { dependencies: npmDependency, packages: npmPin });
  const denied = run(f, ['apply']);
  assert.equal(denied.status, 1);
  assert.equal(output(denied).errorCode, 'APPROVAL_REQUIRED');
  assert.deepEqual(await entries(f), []);

  const approved = run(f, ['apply', '--approve']);
  assert.equal(approved.status, 0, approved.stderr || approved.stdout);
  assert.deepEqual((await entries(f)).map(({ tool, args }) => [tool, args]), [['pi', ['install', 'npm:widget@1.0.0']]]);
  assert.deepEqual(JSON.parse(await fs.readFile(f.piState, 'utf8')), { installed: ['npm:widget@1.0.0'] });
  assert.match(output(approved).dependencyModel, /transitive/);

  const updatedByPi = spawnSync(path.join(f.bin, 'pi'), ['update', '--extensions'], {
    encoding: 'utf8', env: { ...process.env, FAKE_LOG: f.log, FAKE_PI_STATE: f.piState },
  });
  assert.equal(updatedByPi.status, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(f.piState, 'utf8')), { installed: ['npm:widget@999.0.0'] },
    'the package manager command itself can leave the managed top-level package beyond its recorded pin');
  const skill = await fs.readFile(new URL('../resources/skills/pi-sync/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /Do not run `pi update --extensions` when it could update managed packages/i);
  assert.match(skill, /unsupported for managed packages, may move them beyond their recorded exact pins, and Pi Sync cannot intercept or prevent it/i);
  assert.match(skill, /When a user requests or discusses updating managed packages, explain\/remind them to use Pi Sync instead/i);
  assert.deepEqual((await entries(f)).filter(({ tool }) => tool === 'npm' || tool === 'gh'), []);
  assert.deepEqual((await entries(f)).filter(({ tool }) => tool === 'pi').map(({ args }) => args), [
    ['install', 'npm:widget@1.0.0'], ['update', '--extensions'],
  ]);
});

test('apply rejects declarations without exact lock pins before invoking Pi', async (t) => {
  const f = await setup(t, { dependencies: npmDependency, packages: [] });
  const response = run(f, ['apply', '--approve']);
  assert.equal(response.status, 2);
  assert.match(output(response).error, /missing exact pins.*npm:widget/);
  assert.deepEqual(await entries(f), []);
  await assert.rejects(fs.access(f.agentDir));
});

test('update preview applies the repository-owned seven-day minimum and does not change pins or install', async (t) => {
  const now = Date.now();
  const f = await setup(t, { dependencies: npmDependency,
    packages: [{ type: 'npm', name: 'widget', version: '0.9.0', releasedAt: '2020-01-01T00:00:00.000Z' }],
    policy: { minimumReleaseAgeDays: 7 } });
  const times = { '0.9.0': '2020-01-01T00:00:00.000Z', '1.0.0': new Date(now - 9 * 86400000).toISOString(), '2.0.0': new Date(now - 2 * 86400000).toISOString() };
  const before = await fs.readFile(path.join(f.repo, 'pi-sync.lock.json'), 'utf8');
  const preview = run(f, ['update'], { FAKE_VERSIONS: JSON.stringify(['0.9.0', '1.0.0', '2.0.0']), FAKE_TIMES: JSON.stringify(times) });
  assert.equal(preview.status, 0, preview.stderr || preview.stdout);
  const response = output(preview);
  assert.equal(response.minimumReleaseAgeDays, 7);
  assert.equal(response.policySource, 'setup repository pi-sync.json');
  assert.equal(response.updates[0].to.version, '1.0.0');
  assert.equal(await fs.readFile(path.join(f.repo, 'pi-sync.lock.json'), 'utf8'), before);
  assert.equal((await entries(f)).some(({ tool }) => tool === 'pi'), false);
});

test('update --apply requires first-install approval and writes the new exact lock only after Pi install succeeds', async (t) => {
  const f = await setup(t, { dependencies: npmDependency });
  const env = { FAKE_VERSIONS: '["1.0.0"]', FAKE_TIMES: '{"1.0.0":"2020-01-01T00:00:00.000Z"}' };
  const denied = run(f, ['update', '--apply'], env);
  assert.equal(denied.status, 1);
  assert.equal(output(denied).errorCode, 'APPROVAL_REQUIRED');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.repo, 'pi-sync.lock.json'), 'utf8')), { schemaVersion: 1, packages: [] });
  assert.equal((await entries(f)).some(({ tool }) => tool === 'pi'), false);

  const failedInstall = run(f, ['update', '--apply', '--approve'], { ...env, FAKE_PI_FAIL: 'yes' });
  assert.equal(failedInstall.status, 1);
  assert.equal(output(failedInstall).errorCode, 'PACKAGE_INSTALL_FAILED');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.repo, 'pi-sync.lock.json'), 'utf8')), { schemaVersion: 1, packages: [] });

  const accepted = run(f, ['update', '--apply', '--approve'], env);
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
  const lock = JSON.parse(await fs.readFile(path.join(f.repo, 'pi-sync.lock.json'), 'utf8'));
  assert.deepEqual(lock.packages, [{ type: 'npm', name: 'widget', version: '1.0.0', releasedAt: '2020-01-01T00:00:00.000Z' }]);
  assert.ok((await entries(f)).some(({ tool, args }) => tool === 'pi' && args[0] === 'install' && args[1] === 'npm:widget@1.0.0'));
});

test('failed multi-package apply rolls back package installs, resources, settings, and baseline state', async (t) => {
  const f = await setup(t);
  const source = path.join(f.repo, 'resources', 'skills', 'managed');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), '# Original\\n');
  const manifestPath = path.join(f.repo, 'pi-sync.json');
  let manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.resources = [{ type: 'skill', source: 'resources/skills/managed', target: 'skills/managed' }];
  manifest.settings = [{ target: 'settings.json', fields: [{ path: '/theme', value: 'dark' }] }];
  manifest.dependencies = [{ type: 'npm', name: 'first' }];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await fs.writeFile(path.join(f.repo, 'pi-sync.lock.json'), JSON.stringify({ schemaVersion: 1, packages: [
    { type: 'npm', name: 'first', version: '0.9.0', releasedAt: '2020-01-01T00:00:00.000Z' },
  ] }));
  await fs.mkdir(f.agentDir, { recursive: true });
  await fs.writeFile(path.join(f.agentDir, 'settings.json'), JSON.stringify({ localOnly: true }, null, 2));
  const initial = run(f, ['apply', '--approve']);
  assert.equal(initial.status, 0, initial.stderr || initial.stdout);
  const statePath = path.join(f.agentDir, '.pi-sync', 'state.json');
  const stateBefore = await fs.readFile(statePath, 'utf8');
  const packageStatePath = path.join(f.agentDir, '.pi-sync', 'packages.json');
  const packageStateBefore = await fs.readFile(packageStatePath, 'utf8');
  const settingsBefore = await fs.readFile(path.join(f.agentDir, 'settings.json'), 'utf8');
  await fs.writeFile(path.join(source, 'SKILL.md'), '# Updated\\n');
  manifest.dependencies = [{ type: 'npm', name: 'first' }, { type: 'npm', name: 'second' }];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const lockPath = path.join(f.repo, 'pi-sync.lock.json');
  await fs.writeFile(lockPath, JSON.stringify({ schemaVersion: 1, packages: [
    { type: 'npm', name: 'first', version: '1.0.0', releasedAt: '2020-01-01T00:00:00.000Z' },
    { type: 'npm', name: 'second', version: '1.0.0', releasedAt: '2020-01-01T00:00:00.000Z' },
  ] }));

  const failed = run(f, ['apply', '--approve'], { FAKE_PI_FAIL_SPEC: 'npm:second@1.0.0' });
  assert.equal(failed.status, 1, failed.stderr || failed.stdout);
  assert.equal(output(failed).errorCode, 'PACKAGE_INSTALL_FAILED');
  assert.match(output(failed).error, /previously installed package pins were restored/);
  assert.equal(await fs.readFile(path.join(f.agentDir, 'skills', 'managed', 'SKILL.md'), 'utf8'), '# Original\\n');
  assert.equal(await fs.readFile(path.join(f.agentDir, 'settings.json'), 'utf8'), settingsBefore);
  assert.equal(await fs.readFile(statePath, 'utf8'), stateBefore);
  assert.equal(await fs.readFile(packageStatePath, 'utf8'), packageStateBefore);
  assert.deepEqual(JSON.parse(await fs.readFile(f.piState, 'utf8')), { installed: ['npm:first@0.9.0'] });
  assert.deepEqual((await entries(f)).filter(({ tool, args }) => tool === 'pi').slice(-4).map(({ args }) => args), [
    ['install', 'npm:first@1.0.0'], ['install', 'npm:second@1.0.0'],
    ['uninstall', 'npm:second@1.0.0'], ['install', 'npm:first@0.9.0'],
  ]);
});

test('failed multi-package update restores existing Pi pins and leaves the lockfile unchanged', async (t) => {
  const dependencies = [{ type: 'npm', name: 'first' }, { type: 'npm', name: 'second' }];
  const packages = dependencies.map(({ name }) => ({ type: 'npm', name, version: '0.9.0', releasedAt: '2020-01-01T00:00:00.000Z' }));
  const f = await setup(t, { dependencies, packages });
  const initial = run(f, ['apply', '--approve']);
  assert.equal(initial.status, 0, initial.stderr || initial.stdout);
  const lockPath = path.join(f.repo, 'pi-sync.lock.json');
  const lockBefore = await fs.readFile(lockPath, 'utf8');
  const packageStatePath = path.join(f.agentDir, '.pi-sync', 'packages.json');
  const packageStateBefore = await fs.readFile(packageStatePath, 'utf8');
  const failed = run(f, ['update', '--apply', '--approve'], {
    FAKE_VERSIONS: '["0.9.0","1.0.0"]',
    FAKE_TIMES: '{"0.9.0":"2020-01-01T00:00:00.000Z","1.0.0":"2020-01-01T00:00:00.000Z"}',
    FAKE_PI_FAIL_SPEC: 'npm:second@1.0.0',
  });
  assert.equal(failed.status, 1, failed.stderr || failed.stdout);
  assert.equal(output(failed).errorCode, 'PACKAGE_INSTALL_FAILED');
  assert.equal(await fs.readFile(lockPath, 'utf8'), lockBefore);
  assert.equal(await fs.readFile(packageStatePath, 'utf8'), packageStateBefore);
  assert.deepEqual(JSON.parse(await fs.readFile(f.piState, 'utf8')).installed.sort(), ['npm:first@0.9.0', 'npm:second@0.9.0']);
  assert.deepEqual((await entries(f)).filter(({ tool, args }) => tool === 'pi').slice(-4).map(({ args }) => args), [
    ['install', 'npm:first@1.0.0'], ['install', 'npm:second@1.0.0'],
    ['install', 'npm:second@0.9.0'], ['install', 'npm:first@0.9.0'],
  ]);
});

test('update rolls back installed packages and both pin files when either persistence write fails', async (t) => {
  for (const failedTarget of ['lockfile', 'local package state']) {
    await t.test(failedTarget, async (t) => {
      const f = await setup(t, { dependencies: npmDependency, packages: npmPin });
      const initial = run(f, ['apply', '--approve']);
      assert.equal(initial.status, 0, initial.stderr || initial.stdout);
      const lockPath = path.join(f.repo, 'pi-sync.lock.json');
      const packageStatePath = path.join(f.agentDir, '.pi-sync', 'packages.json');
      const lockBefore = await fs.readFile(lockPath, 'utf8');
      const packageStateBefore = await fs.readFile(packageStatePath, 'utf8');
      const destination = failedTarget === 'lockfile' ? lockPath : packageStatePath;
      const failed = run(f, ['update', '--apply', '--approve'], {
        FAKE_VERSIONS: '["1.0.0","2.0.0"]',
        FAKE_TIMES: '{"1.0.0":"2020-01-01T00:00:00.000Z","2.0.0":"2020-01-01T00:00:00.000Z"}',
        NODE_OPTIONS: `--require=${f.faultModule}`,
        FAKE_RENAME_FAIL_TARGET: destination,
      });
      assert.equal(failed.status, 1, failed.stderr || failed.stdout);
      assert.equal(output(failed).errorCode, 'UPDATE_TRANSACTION_FAILED');
      assert.match(output(failed).error, /previous package pins, lockfile, and local pin state were restored/);
      assert.equal(await fs.readFile(lockPath, 'utf8'), lockBefore);
      assert.equal(await fs.readFile(packageStatePath, 'utf8'), packageStateBefore);
      assert.deepEqual(JSON.parse(await fs.readFile(f.piState, 'utf8')), { installed: ['npm:widget@1.0.0'] });
      assert.deepEqual((await fs.readdir(path.dirname(packageStatePath))).sort(), ['packages.json']);
      const piCalls = (await entries(f)).filter(({ tool, args }) => tool === 'pi').map(({ args }) => args);
      assert.deepEqual(piCalls.slice(-2), [['install', 'npm:widget@2.0.0'], ['install', 'npm:widget@1.0.0']]);
    });
  }
});

test('update fails closed when any npm version has no trustworthy release timestamp', async (t) => {
  const f = await setup(t, { dependencies: npmDependency });
  const response = run(f, ['update'], { FAKE_VERSIONS: '["1.0.0","2.0.0"]', FAKE_TIMES: '{"1.0.0":"2020-01-01T00:00:00.000Z"}' });
  assert.equal(response.status, 1);
  assert.match(output(response).error, /timestamps.*incomplete.*stopped closed/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.repo, 'pi-sync.lock.json'), 'utf8')), { schemaVersion: 1, packages: [] });
});

test('GitHub update records an immutable commit, release tag, and published timestamp', async (t) => {
  const f = await setup(t, { dependencies: [{ type: 'github', repository: 'acme/extension' }] });
  const release = [{ tag_name: 'v2.0.0', published_at: '2020-01-01T00:00:00Z', draft: false, prerelease: false }];
  const preview = run(f, ['update'], { FAKE_RELEASES: JSON.stringify(release) });
  assert.equal(preview.status, 0, `${preview.stderr || preview.stdout}\n${JSON.stringify(await entries(f))}`);
  const pin = output(preview).proposedPins[0];
  assert.deepEqual(pin, { type: 'github', repository: 'acme/extension', commit: sha, tag: 'v2.0.0', releasedAt: '2020-01-01T00:00:00.000Z' });
  const tools = await entries(f);
  assert.ok(tools.some(({ tool, args }) => tool === 'gh' && args[0] === 'api'));
  assert.ok(tools.some(({ tool, args }) => tool === 'git' && args[0] === 'ls-remote'));
  assert.ok(!tools.some(({ tool }) => tool === 'pi'));
});

test('GitHub release metadata without a timestamp fails closed', async (t) => {
  const f = await setup(t, { dependencies: [{ type: 'github', repository: 'acme/extension' }] });
  const preview = run(f, ['update'], { FAKE_RELEASES: JSON.stringify([{ tag_name: 'v1', published_at: null, draft: false, prerelease: false }]) });
  assert.equal(preview.status, 1);
  assert.match(output(preview).error, /tags or timestamps.*stopped closed/);
  assert.equal((await entries(f)).some(({ tool }) => tool === 'pi'), false);
});

test('dependency add updates only the declaration and directs agents through update', async (t) => {
  const f = await setup(t);
  const added = run(f, ['add', '--type', 'dependency', '--source', 'npm:widget']);
  assert.equal(added.status, 0, added.stderr || added.stdout);
  assert.deepEqual(output(added).dependency, { type: 'npm', name: 'widget' });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.repo, 'pi-sync.json'), 'utf8')).dependencies, [{ type: 'npm', name: 'widget' }]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.repo, 'pi-sync.lock.json'), 'utf8')).packages, []);
  assert.deepEqual(await entries(f), []);
});

test('repository policy cannot lower seven days and malformed pins are rejected before package-manager calls', async (t) => {
  const f = await setup(t, { dependencies: npmDependency, packages: npmPin, policy: { minimumReleaseAgeDays: 6 } });
  const response = run(f, ['apply', '--approve']);
  assert.equal(response.status, 2);
  assert.match(output(response).error, /at least seven days/);
  assert.deepEqual(await entries(f), []);
});
