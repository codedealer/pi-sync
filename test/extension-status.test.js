import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeFingerprint,
  extractSummary,
  fetchHeadPath,
  FETCH_MAX_AGE_MS,
  fingerprintPaths,
  fingerprintsEqual,
  isFetchFresh,
  isSyncSummary,
  readStatusCache,
  renderFooter,
  statusCachePath,
  writeStatusCache,
} from '../resources/extensions/pi-sync/status.js';

const LABEL = 'pi-sync ';

/** Render with a style that records [color, text] calls and returns the plain text. */
function styledFooter(input) {
  const calls = [];
  const style = (color, text) => {
    calls.push([color, text]);
    return text;
  };
  return { text: renderFooter(input, style), calls };
}

test('renderFooter renders the clean state with only the check mark', () => {
  const clean = { localPending: 0, remotePending: 0, needsReview: 0, clean: true };
  assert.equal(renderFooter(clean), 'pi-sync ✓');
  assert.deepEqual(styledFooter(clean), { text: 'pi-sync ✓', calls: [['muted', LABEL], ['dim', '✓']] });
});

test('renderFooter renders each pending state with its glyph, count, and color', () => {
  assert.equal(renderFooter({ localPending: 2, remotePending: 0, needsReview: 0, clean: false }), 'pi-sync ↑2');
  assert.equal(renderFooter({ localPending: 0, remotePending: 3, needsReview: 0, clean: false }), 'pi-sync ↓3');
  assert.equal(renderFooter({ localPending: 0, remotePending: 0, needsReview: 1, clean: false }), 'pi-sync !1');
  assert.deepEqual(styledFooter({ localPending: 2, remotePending: 0, needsReview: 0, clean: false }), { text: 'pi-sync ↑2', calls: [['muted', LABEL], ['warning', '↑2']] });
  assert.deepEqual(styledFooter({ localPending: 0, remotePending: 3, needsReview: 0, clean: false }), { text: 'pi-sync ↓3', calls: [['muted', LABEL], ['accent', '↓3']] });
  assert.deepEqual(styledFooter({ localPending: 0, remotePending: 0, needsReview: 1, clean: false }), { text: 'pi-sync !1', calls: [['muted', LABEL], ['error', '!1']] });
});

test('renderFooter combines non-zero terms in the order ↑ ↓ ! and omits zero terms', () => {
  assert.equal(renderFooter({ localPending: 1, remotePending: 2, needsReview: 3, clean: false }), 'pi-sync ↑1 ↓2 !3');
  assert.equal(renderFooter({ localPending: 0, remotePending: 2, needsReview: 0, clean: false }), 'pi-sync ↓2');
  assert.deepEqual(styledFooter({ localPending: 1, remotePending: 2, needsReview: 3, clean: false }), {
    text: 'pi-sync ↑1 ↓2 !3',
    calls: [['muted', LABEL], ['warning', '↑1'], ['accent', '↓2'], ['error', '!3']],
  });
});

test('renderFooter renders the checking, syncing, and failed states', () => {
  assert.equal(renderFooter({ state: 'checking' }), 'pi-sync …');
  assert.equal(renderFooter({ state: 'syncing' }), 'pi-sync ⟳');
  assert.equal(renderFooter({ state: 'failed' }), 'pi-sync ✗');
  assert.deepEqual(styledFooter({ state: 'checking' }), { text: 'pi-sync …', calls: [['muted', LABEL], ['dim', '…']] });
  assert.deepEqual(styledFooter({ state: 'syncing' }), { text: 'pi-sync ⟳', calls: [['muted', LABEL], ['dim', '⟳']] });
  assert.deepEqual(styledFooter({ state: 'failed' }), { text: 'pi-sync ✗', calls: [['muted', LABEL], ['error', '✗']] });
  assert.deepEqual(styledFooter({ state: 'unknown' }), { text: 'pi-sync ✗', calls: [['muted', LABEL], ['error', '✗']] });
});

test('renderFooter returns null for absent or unusable input instead of claiming a state', () => {
  assert.equal(renderFooter(null), null);
  assert.equal(renderFooter(undefined), null);
  assert.equal(renderFooter('pi-sync ✓'), null);
  assert.equal(renderFooter([1, 2, 3]), null);
  assert.equal(renderFooter({ localPending: 'one', remotePending: 0, needsReview: 0, clean: false }), null);
});

test('isSyncSummary validates the CLI summary shape', () => {
  assert.equal(isSyncSummary({ localPending: 0, remotePending: 0, needsReview: 0, clean: true }), true);
  assert.equal(isSyncSummary({ localPending: 1, remotePending: 2, needsReview: 3, clean: false }), true);
  assert.equal(isSyncSummary({ localPending: -1, remotePending: 0, needsReview: 0, clean: false }), false);
  assert.equal(isSyncSummary({ localPending: 1.5, remotePending: 0, needsReview: 0, clean: false }), false);
  assert.equal(isSyncSummary({ localPending: '0', remotePending: 0, needsReview: 0, clean: false }), false);
  assert.equal(isSyncSummary({ localPending: 0, remotePending: 0, needsReview: 0 }), false);
  assert.equal(isSyncSummary({ localPending: 0, remotePending: 0, needsReview: 0, clean: 'true' }), false);
  assert.equal(isSyncSummary(null), false);
  assert.equal(isSyncSummary([]), false);
});

test('extractSummary tolerates older CLI results without a summary block', () => {
  const summary = { localPending: 1, remotePending: 0, needsReview: 0, clean: false };
  assert.deepEqual(extractSummary({ apiVersion: 1, command: 'status', ok: true, summary }), summary);
  assert.equal(extractSummary({ apiVersion: 1, command: 'status', ok: true }), null);
  assert.equal(extractSummary({ apiVersion: 1, command: 'status', ok: false, error: 'boom', errorCode: 'VALIDATION_ERROR' }), null);
  assert.equal(extractSummary({ summary: { localPending: 'one', remotePending: 0, needsReview: 0, clean: false } }), null);
  assert.equal(extractSummary(null), null);
  assert.equal(extractSummary('not an object'), null);
});

test('fingerprintPaths derives the exact flat path list', () => {
  const paths = fingerprintPaths({ repoDir: '/repo', agentDir: '/agent', settingsTargets: ['settings.json', 'models.json'] });
  assert.deepEqual(paths, [
    '/repo/.git/HEAD',
    '/repo/.git/index',
    '/repo/.git/packed-refs',
    '/repo/.git/FETCH_HEAD',
    '/repo/pi-sync.json',
    '/repo/pi-sync.lock.json',
    '/agent/.pi-sync/state.json',
    '/agent/settings.json',
    '/agent/models.json',
  ]);
});

test('fingerprintPaths handles missing targets, duplicates, and non-string entries', () => {
  assert.deepEqual(
    fingerprintPaths({ repoDir: '/repo', agentDir: '/agent', settingsTargets: [] }),
    ['/repo/.git/HEAD', '/repo/.git/index', '/repo/.git/packed-refs', '/repo/.git/FETCH_HEAD', '/repo/pi-sync.json', '/repo/pi-sync.lock.json', '/agent/.pi-sync/state.json'],
  );
  assert.deepEqual(
    fingerprintPaths({ repoDir: '/repo', agentDir: '/agent', settingsTargets: ['settings.json', 'settings.json', '', 42] }),
    ['/repo/.git/HEAD', '/repo/.git/index', '/repo/.git/packed-refs', '/repo/.git/FETCH_HEAD', '/repo/pi-sync.json', '/repo/pi-sync.lock.json', '/agent/.pi-sync/state.json', '/agent/settings.json'],
  );
  assert.deepEqual(fingerprintPaths({ repoDir: '/repo', agentDir: '/agent' }), fingerprintPaths({ repoDir: '/repo', agentDir: '/agent', settingsTargets: [] }));
});

test('computeFingerprint uses mtimes for present paths and the stable absent marker for missing ones', () => {
  const paths = ['/a', '/b', '/c'];
  const stat = (item) => (item === '/b' ? null : { mtimeMs: item === '/a' ? 111.5 : 222.25 });
  assert.deepEqual(computeFingerprint(paths, stat), [['/a', 111.5], ['/b', null], ['/c', 222.25]]);
});

test('computeFingerprint with the default stat reads real file metadata', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-status-fp-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const present = path.join(dir, 'file.json');
  await fs.writeFile(present, '{}');
  const absent = path.join(dir, 'missing.json');
  const fingerprint = computeFingerprint([present, absent]);
  assert.deepEqual(fingerprint[0][0], present);
  assert.equal(typeof fingerprint[0][1], 'number');
  assert.ok(Number.isFinite(fingerprint[0][1]) && fingerprint[0][1] > 0);
  assert.deepEqual(fingerprint[1], [absent, null]);
  // The fingerprint is JSON-serializable so it can be stored in the shared cache.
  assert.deepEqual(JSON.parse(JSON.stringify(fingerprint)), fingerprint);
});

test('status cache round-trips the fingerprint and summary atomically', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-status-cache-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cachePath = path.join(dir, '.pi-sync', 'status-cache.json');
  assert.equal(statusCachePath(dir), cachePath);

  assert.equal(readStatusCache(cachePath), null, 'absent cache reads as null');

  const entry = {
    fingerprint: [['/repo/pi-sync.json', 1234.5], ['/agent/settings.json', null]],
    summary: { localPending: 1, remotePending: 0, needsReview: 2, clean: false },
  };
  writeStatusCache(cachePath, entry);
  assert.deepEqual(readStatusCache(cachePath), entry);

  const leftover = (await fs.readdir(dir)).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftover, [], 'atomic write leaves no temp file behind');
});

test('fingerprintsEqual matches identical fingerprints including absent markers', () => {
  const fp = [['/repo/pi-sync.json', 1234.5], ['/agent/.pi-sync/state.json', null], ['/agent/settings.json', 42]];
  // Round-tripping through JSON (as the shared cache does) preserves equality.
  assert.equal(fingerprintsEqual(fp, JSON.parse(JSON.stringify(fp))), true);
  assert.equal(fingerprintsEqual([], []), true);
  assert.equal(fingerprintsEqual([['/a', null]], [['/a', null]]), true, 'absent marker equals absent marker');
});

test('fingerprintsEqual rejects any difference in path, mtime, or shape', () => {
  const a = [['/repo/pi-sync.json', 1234.5], ['/agent/settings.json', null]];
  assert.equal(fingerprintsEqual(a, [['/repo/pi-sync.json', 1234.5], ['/agent/settings.json', 1]]), false, 'mtime change');
  assert.equal(fingerprintsEqual(a, [['/repo/pi-sync.json', 1234.5], ['/agent/settings.json', 1]]), false, 'absent marker vs present');
  assert.equal(fingerprintsEqual(a, [['/other/pi-sync.json', 1234.5], ['/agent/settings.json', null]]), false, 'path change');
  assert.equal(fingerprintsEqual(a, a.slice(0, 1)), false, 'length mismatch');
  assert.equal(fingerprintsEqual(a, null), false, 'null input');
  assert.equal(fingerprintsEqual(null, a), false, 'null other');
  assert.equal(fingerprintsEqual('nope', 'nope'), false, 'non-array input');
  assert.equal(fingerprintsEqual(a, [['/repo/pi-sync.json', 1234.5, 'extra'], ['/agent/settings.json', null]]), false, 'malformed pair');
  assert.equal(fingerprintsEqual(a, [null, ['/agent/settings.json', null]]), false, 'non-array entry');
});

test('shared cache lets a second session reuse a fingerprint without a recompute', async (t) => {
  // A "first session" computes the fingerprint from a real file and
  // publishes the cache entry; a "second session" recomputes from the same
  // files and finds a matching cache entry — the refresh path renders the
  // cached summary instead of spawning the CLI.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-status-cache-reuse-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  await fs.writeFile(file, '{"model":"x"}');
  const cachePath = path.join(dir, 'status-cache.json');

  const firstFingerprint = computeFingerprint([file]);
  writeStatusCache(cachePath, { fingerprint: firstFingerprint, summary: { localPending: 0, remotePending: 0, needsReview: 0, clean: true } });

  const cached = readStatusCache(cachePath);
  assert.ok(cached !== null, 'cache entry reads back');
  assert.equal(fingerprintsEqual(cached.fingerprint, computeFingerprint([file])), true, 'second session reuses the cached result');

  // A real change (distinct mtime) invalidates the match, forcing a recompute.
  await fs.writeFile(file, '{"model":"y"}');
  await fs.utimes(file, new Date(2000, 0, 1), new Date(2000, 0, 2));
  assert.equal(fingerprintsEqual(cached.fingerprint, computeFingerprint([file])), false, 'changed file no longer matches');

  // A path that disappears switches to the absent marker, which also
  // invalidates the match.
  await fs.rm(file);
  assert.deepEqual(computeFingerprint([file]), [[file, null]], 'absent file uses the stable absent marker');
  assert.equal(fingerprintsEqual(cached.fingerprint, computeFingerprint([file])), false);
});

test('fetchHeadPath points at the setup repository FETCH_HEAD', () => {
  assert.equal(fetchHeadPath('/repo'), '/repo/.git/FETCH_HEAD');
  assert.equal(fetchHeadPath('relative'), path.join('relative', '.git', 'FETCH_HEAD'));
});

test('isFetchFresh skips the session-start fetch only for a recent FETCH_HEAD', () => {
  const now = 1_000_000_000_000;
  assert.equal(isFetchFresh(now - 60_000, now), true, 'one minute old: fresh');
  assert.equal(isFetchFresh(now - (FETCH_MAX_AGE_MS - 1), now), true, 'just under five minutes: fresh');
  assert.equal(isFetchFresh(now - FETCH_MAX_AGE_MS, now), false, 'exactly five minutes old: not fresh (fetch runs)');
  assert.equal(isFetchFresh(now - (FETCH_MAX_AGE_MS + 1), now), false, 'five minutes plus one ms: stale');
  assert.equal(isFetchFresh(now - 3_600_000, now), false, 'an hour old: stale');
  assert.equal(isFetchFresh(null, now), false, 'absent FETCH_HEAD: the fetch runs');
  assert.equal(isFetchFresh(undefined, now), false, 'missing mtime: the fetch runs');
  assert.equal(isFetchFresh('nope', now), false, 'non-numeric mtime: the fetch runs');
  assert.equal(isFetchFresh(now + 5_000, now), true, 'clock skew (future mtime): treated as fresh');
  assert.equal(isFetchFresh(123, 'nope'), false, 'non-numeric now: the fetch runs (the safe direction)');
  assert.equal(isFetchFresh(now - 60_000, now, 30_000), false, 'custom max age: one minute exceeds thirty seconds');
  assert.equal(isFetchFresh(now - 10_000, now, 30_000), true, 'custom max age: ten seconds is within thirty seconds');
});

test('readStatusCache rejects absent, corrupt, and malformed entries', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sync-status-cache-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cachePath = path.join(dir, 'status-cache.json');

  assert.equal(readStatusCache(path.join(dir, 'nope', 'status-cache.json')), null, 'absent file');

  await fs.writeFile(cachePath, '{ not json');
  assert.equal(readStatusCache(cachePath), null, 'unparseable file');

  await fs.writeFile(cachePath, JSON.stringify({ fingerprint: 'nope', summary: { localPending: 0, remotePending: 0, needsReview: 0, clean: true } }));
  assert.equal(readStatusCache(cachePath), null, 'non-array fingerprint');

  await fs.writeFile(cachePath, JSON.stringify({ fingerprint: [], summary: { localPending: 0, remotePending: 0, needsReview: 0 } }));
  assert.equal(readStatusCache(cachePath), null, 'malformed summary');

  await fs.writeFile(cachePath, JSON.stringify([{ fingerprint: [], summary: { localPending: 0, remotePending: 0, needsReview: 0, clean: true } }]));
  assert.equal(readStatusCache(cachePath), null, 'non-object entry');
});