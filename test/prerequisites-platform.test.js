import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { createPrerequisiteInspector, githubCliReleaseAsset } from '../src/prerequisites.js';

function zipFixture(filePath, contents) {
  const name = Buffer.from(filePath);
  const compressed = deflateRawSync(contents);
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
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

async function windowsExecutable(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-csc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const compiler = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  await fs.access(compiler);
  const source = path.join(root, 'gh.cs');
  const executable = path.join(root, 'gh.exe');
  await fs.writeFile(source, 'using System; class Program { static void Main(string[] args) { if (args.Length == 1 && args[0] == "--version") Console.WriteLine("gh version 2.74.2"); } }');
  const compiled = spawnSync(compiler, ['/nologo', `/out:${executable}`, source], { encoding: 'utf8', windowsHide: true });
  assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`);
  return fs.readFile(executable);
}

test('native macOS/Windows user-local install, execution, and PATH smoke', { skip: !['darwin', 'win32'].includes(process.platform) }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-native-platform-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const platform = process.platform;
  const architecture = process.arch;
  const asset = githubCliReleaseAsset(platform, architecture);
  assert.ok(asset, `native runner architecture ${platform}/${architecture} must have a catalogued asset`);
  let executableBytes;
  if (platform === 'win32') {
    executableBytes = await windowsExecutable(t);
  } else {
    executableBytes = Buffer.from('#!/usr/bin/env node\nif (process.argv[2] === "--version") console.log("gh version 2.74.2");\n');
  }
  const assetRoot = asset.file.replace(/\.(?:tar\.gz|zip)$/, '');
  const archive = zipFixture(`${assetRoot}/bin/${asset.binary}`, executableBytes);
  let downloads = 0;
  const inspector = createPrerequisiteInspector({
    expectedArtifactSha256: () => createHash('sha256').update(archive).digest('hex'),
    fetchArtifact: async (url) => {
      downloads++;
      assert.match(url, /^https:\/\/github\.com\/cli\/cli\/releases\/download\//);
      return new Response(archive, { status: 200 });
    },
  });

  const home = path.join(root, 'isolated-user-home');
  const binDir = path.join(home, '.local', 'bin');
  // Hosted runners (macOS in particular) ship a preinstalled gh on PATH, which
  // would short-circuit the user-local install path. Isolate PATH so the test
  // exercises the install: only node (needed by the shebang fixture) and the
  // standard system directories, plus the inspector's own binDir prefix.
  const nodeDir = path.join(root, 'node-dir');
  await fs.mkdir(nodeDir);
  await fs.copyFile(process.execPath, path.join(nodeDir, platform === 'win32' ? 'node.exe' : 'node'));
  const systemDirs = platform === 'win32' ? ['C:\\Windows\\system32', 'C:\\Windows'] : ['/usr/bin', '/bin'];
  const isolatedEnv = { ...process.env, PATH: [nodeDir, ...systemDirs].join(path.delimiter) };
  const options = { binDir, env: isolatedEnv, platform, architecture };
  const installed = await inspector(['gh'], options);
  assert.equal(installed.ok, true, JSON.stringify(installed.tools));
  const executable = path.join(binDir, asset.binary);
  assert.equal(installed.tools[0].installPath, executable);
  assert.equal(installed.tools[0].version, '2.74.2');
  assert.equal((await fs.stat(executable)).isFile(), true);
  assert.equal(downloads, 1);

  const pathDir = path.join(home, 'path-entry');
  await fs.mkdir(pathDir, { recursive: true });
  await fs.copyFile(executable, path.join(pathDir, asset.binary));
  if (platform !== 'win32') await fs.chmod(path.join(pathDir, asset.binary), 0o755);
  const externalPath = [pathDir, process.env.PATH ?? ''].join(path.delimiter);
  const discovered = await inspector(['gh'], {
    binDir: path.join(home, 'different-install-dir'),
    env: { ...process.env, PATH: externalPath },
    platform,
    architecture,
    install: false,
  });
  assert.equal(discovered.ok, true, JSON.stringify(discovered.tools));
  assert.equal(discovered.tools[0].status, 'available');
  assert.equal(Object.hasOwn(discovered.tools[0], 'installPath'), false);
  assert.equal(downloads, 1, 'PATH discovery must not download another artifact');
});
