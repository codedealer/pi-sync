import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { createHash, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';

const GH_VERSION = '2.74.2';
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const INSTALL_CATALOG = Object.freeze({ gh: 'github-cli' });

export function validateRequiredTools(requiredTools = []) {
  if (!Array.isArray(requiredTools)) throw new Error('Manifest requiredTools must be an array');
  const seen = new Set();
  for (const [index, name] of requiredTools.entries()) {
    if (typeof name !== 'string' || !Object.hasOwn(INSTALL_CATALOG, name)) {
      throw new Error(`Unsupported required tool in requiredTools[${index}]: ${String(name)}. Supported tools: ${Object.keys(INSTALL_CATALOG).join(', ')}`);
    }
    if (seen.has(name)) throw new Error(`Duplicate required tool: ${name}`);
    seen.add(name);
  }
  return [...requiredTools];
}

const RELEASE_SHA256 = Object.freeze({
  'gh_2.74.2_linux_amd64.tar.gz': 'c421091ae5800390e6aef1f50bfda59cc1d4f2ef2200bcd4e1a662c05c28c444',
  'gh_2.74.2_linux_arm64.tar.gz': 'f0b07f0aeaf00f137df1bd33a76e717b1945f4b83bd6a3296b365414d3eb413f',
  'gh_2.74.2_macOS_amd64.zip': 'c716ecdd9d5e381e521d772caa4dea29d647d465b94b1c67df9154e71f33451e',
  'gh_2.74.2_macOS_arm64.zip': '42dceea5beae957a8a9545e38043a6d75fa3b5505fdcea75a278f873f0845b26',
  'gh_2.74.2_windows_amd64.zip': '3ac27af5ee8dd13b1b0002e4e4764163683889cea7f21231c9951e300c95eb29',
});

export function githubCliReleaseAsset(platform, architecture) {
  const arch = architecture === 'x64' ? 'amd64' : architecture === 'arm64' ? 'arm64' : null;
  if (!arch) return null;
  let file;
  let binary;
  let format;
  if (platform === 'linux') [file, binary, format] = [`gh_${GH_VERSION}_linux_${arch}.tar.gz`, 'gh', 'tar.gz'];
  else if (platform === 'darwin') [file, binary, format] = [`gh_${GH_VERSION}_macOS_${arch}.zip`, 'gh', 'zip'];
  else if (platform === 'win32' && arch === 'amd64') [file, binary, format] = [`gh_${GH_VERSION}_windows_amd64.zip`, 'gh.exe', 'zip'];
  else return null;
  const sha256 = RELEASE_SHA256[file];
  if (!sha256) return null;
  return { file, binary, format, sha256 };
}

function runVersion(executable, env) {
  return new Promise((resolve) => {
    const child = spawn(executable, ['--version'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { if (output.length < 4096) output += chunk; });
    child.stderr.on('data', () => {});
    child.on('error', () => resolve(null));
    child.on('close', (status) => {
      if (status !== 0) return resolve(null);
      const match = /\bversion\s+v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i.exec(output);
      resolve(match?.[1] ?? null);
    });
  });
}

function isSafeArchivePath(name) {
  return typeof name === 'string' && !name.startsWith('/') && !name.includes('\\') &&
    !name.split('/').some((part) => part === '..' || part === '.');
}

function fromTarGzip(archive, expectedBinary) {
  const tar = zlib.gunzipSync(archive, { maxOutputLength: MAX_ARCHIVE_BYTES * 4 });
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const readString = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const name = readString(0, 100);
    const prefix = readString(345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeText = readString(124, 12).trim().replace(/\0.*$/s, '');
    const size = Number.parseInt(sizeText || '0', 8);
    const type = readString(156, 1);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('Downloaded GitHub CLI archive has an invalid tar entry');
    if (!isSafeArchivePath(fullName)) throw new Error('Downloaded GitHub CLI archive contains an unsafe path');
    if (fullName.endsWith(`/bin/${expectedBinary}`) && (type === '' || type === '0')) {
      return Buffer.from(tar.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`Downloaded GitHub CLI archive did not contain bin/${expectedBinary}`);
}

function fromZip(archive, expectedBinary) {
  const searchStart = Math.max(0, archive.length - 65_557);
  let endOffset = -1;
  for (let cursor = archive.length - 22; cursor >= searchStart; cursor--) {
    if (archive.readUInt32LE(cursor) === 0x06054b50) { endOffset = cursor; break; }
  }
  if (endOffset < 0) throw new Error('Downloaded GitHub CLI archive has no zip directory');
  const entryCount = archive.readUInt16LE(endOffset + 10);
  let offset = archive.readUInt32LE(endOffset + 16);
  for (let entry = 0; entry < entryCount; entry++) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) throw new Error('Downloaded GitHub CLI archive has an invalid zip directory');
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const localOffset = archive.readUInt32LE(offset + 42);
    if (offset + 46 + nameLength + extraLength + commentLength > archive.length) throw new Error('Downloaded GitHub CLI archive has an invalid zip entry');
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (!isSafeArchivePath(name)) throw new Error('Downloaded GitHub CLI archive contains an unsafe path');
    const unixMode = externalAttributes >>> 16;
    if (name.endsWith(`/bin/${expectedBinary}`) && ((unixMode & 0o170000) === 0 || (unixMode & 0o170000) === 0o100000)) {
      if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Downloaded GitHub CLI archive has an invalid zip entry');
      const localNameLength = archive.readUInt16LE(localOffset + 26);
      const localExtraLength = archive.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const end = start + compressedSize;
      if (end > archive.length || uncompressedSize > MAX_ARCHIVE_BYTES) throw new Error('Downloaded GitHub CLI archive has an invalid zip entry size');
      let contents;
      if (method === 0) contents = Buffer.from(archive.subarray(start, end));
      else if (method === 8) contents = zlib.inflateRawSync(archive.subarray(start, end), { maxOutputLength: MAX_ARCHIVE_BYTES });
      else throw new Error(`Unsupported GitHub CLI zip compression method: ${method}`);
      if (contents.length !== uncompressedSize) throw new Error('Downloaded GitHub CLI archive entry size did not match');
      return contents;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`Downloaded GitHub CLI archive did not contain bin/${expectedBinary}`);
}

export function extractGitHubCliBinary(archive, asset) {
  if (!asset || !Buffer.isBuffer(archive)) throw new Error('A supported release asset and archive buffer are required');
  return asset.format === 'tar.gz' ? fromTarGzip(archive, asset.binary) : fromZip(archive, asset.binary);
}

async function downloadGitHubCli(asset, expectedSha256, fetchArtifact) {
  if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error(`No trusted SHA-256 pin is available for official GitHub CLI artifact ${asset.file}`);
  }
  const url = `https://github.com/cli/cli/releases/download/v${GH_VERSION}/${asset.file}`;
  const response = await fetchArtifact(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Official GitHub CLI download failed with HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_ARCHIVE_BYTES) throw new Error('Official GitHub CLI archive is empty or exceeds the 100 MiB safety limit');
  const actual = createHash('sha256').update(bytes).digest();
  const expected = Buffer.from(expectedSha256, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error(`Official GitHub CLI archive SHA-256 mismatch for ${asset.file}; refusing to extract or execute it`);
  }
  return extractGitHubCliBinary(bytes, asset);
}

async function installGitHubCli(binDir, platform, architecture, expectedSha256, fetchArtifact) {
  const asset = githubCliReleaseAsset(platform, architecture);
  if (!asset) return { ok: false, reason: `No supported official GitHub CLI installer for ${platform}/${architecture}`, action: 'Install GitHub CLI from https://cli.github.com/ using a user-writable method without sudo, then rerun Pi Sync.' };
  const executable = path.join(binDir, asset.binary);
  try {
    const existing = await fs.lstat(executable).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing) return { ok: false, reason: `Refusing to overwrite existing path: ${executable}`, action: `Review ${executable}; move it only if it is not user data, then rerun Pi Sync.` };
    const contents = await downloadGitHubCli(asset, expectedSha256, fetchArtifact);
    await fs.mkdir(binDir, { recursive: true });
    const temporary = `${executable}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await fs.writeFile(temporary, contents, { flag: 'wx', mode: 0o700 });
      if (platform !== 'win32') await fs.chmod(temporary, 0o755);
      await fs.link(temporary, executable);
      await fs.rm(temporary);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return { ok: true, executable };
  } catch (error) {
    return { ok: false, reason: error.code === 'EACCES' || error.code === 'EPERM'
      ? `Permission denied while installing into ${binDir}` : error.message,
    action: `Install GitHub CLI from https://cli.github.com/ into a directory writable by this user (no sudo), then rerun Pi Sync.` };
  }
}

export function createPrerequisiteInspector({
  expectedArtifactSha256 = (asset) => asset.sha256,
  fetchArtifact = (...args) => globalThis.fetch(...args),
} = {}) {
  return async function inspectRequiredTools(names, { binDir = path.join(os.homedir(), '.local', 'bin'), env = process.env,
    platform = process.platform, architecture = process.arch, install = true } = {}) {
    const tools = validateRequiredTools(names);
    const bin = path.resolve(binDir);
    const toolEnv = { ...env, PATH: `${bin}${path.delimiter}${env.PATH ?? ''}` };
    const command = platform === 'win32' ? 'gh.exe' : 'gh';
    const results = [];
    for (const name of tools) {
      const localExecutable = path.join(bin, platform === 'win32' ? `${name}.exe` : name);
      const localExists = await fs.lstat(localExecutable).then((info) => info.isFile() && !info.isSymbolicLink())
        .catch((error) => ['ENOENT', 'ENOTDIR'].includes(error.code) ? false : Promise.reject(error));
      const version = await runVersion(localExists ? localExecutable : command, toolEnv);
      if (version) {
        results.push({ name, required: true, status: 'available', version, ...(localExists ? { installPath: localExecutable } : {}) });
        continue;
      }
      if (!install) {
        results.push({ name, required: true, status: 'missing', version: null });
        continue;
      }
      const asset = githubCliReleaseAsset(platform, architecture);
      const result = await installGitHubCli(bin, platform, architecture, asset ? expectedArtifactSha256(asset) : null, fetchArtifact);
      if (!result.ok) {
        results.push({ name, required: true, status: 'failed', version: null, reason: result.reason, action: result.action });
        continue;
      }
      const installedVersion = await runVersion(result.executable, toolEnv);
      if (!installedVersion) {
        results.push({ name, required: true, status: 'failed', version: null,
          reason: 'GitHub CLI was downloaded but could not be executed or did not report a version',
          action: `Check that ${result.executable} is compatible with this machine, then rerun Pi Sync.` });
        continue;
      }
      results.push({ name, required: true, status: 'installed', version: installedVersion, installPath: result.executable });
    }
    return { tools: results, ok: results.every((tool) => ['available', 'installed'].includes(tool.status)), binDir: bin };
  };
}

export const inspectRequiredTools = createPrerequisiteInspector();
