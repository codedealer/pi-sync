/**
 * Pure pi-sync status helpers for the bundled Pi extension.
 *
 * Plain JavaScript with no dependency on @earendil-works/pi-coding-agent,
 * so it is unit-testable with `node --test` without a Pi runtime. The
 * extension (index.ts) is a relay: it feeds this module the `summary` block
 * of `pi-sync status`, and all glyph, ordering, and color decisions for the
 * persistent footer live here.
 *
 * The session-start fetch's freshness gate also lives here: a fetch is
 * skipped when the repository's FETCH_HEAD (rewritten by every fetch) is
 * younger than five minutes.
 *
 * Footer state table (colors are applied by the style callback):
 *   pi-sync ✓   clean: no local drift, not behind upstream, nothing needs review
 *   pi-sync ↑n  n local change(s) not yet on the remote
 *   pi-sync ↓n  n remote change(s) not yet applied to the local installation
 *   pi-sync !n  n item(s) need manual review
 *   pi-sync ✗   the status check failed (CLI unavailable, repository error)
 *   pi-sync …   checking (first status check in flight)
 *   pi-sync ⟳   auto-sync in flight
 *
 * Non-zero terms combine in the order ↑ ↓ !; zero terms are omitted; a
 * summary with no non-zero terms renders only ✓.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Footer label. */
export const LABEL = "pi-sync";

/**
 * True when value is a well-formed CLI summary block: non-negative integer
 * localPending/remotePending/needsReview counts and a clean boolean.
 */
export function isSyncSummary(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  for (const key of ["localPending", "remotePending", "needsReview"]) {
    if (!Number.isInteger(value[key]) || value[key] < 0) return false;
  }
  return typeof value.clean === "boolean";
}

/**
 * Extract the usable summary from a parsed `pi-sync status`/`plan` result.
 * Returns null when the result is not an object or carries no well-formed
 * `summary` block — the older-CLI case, which callers render as "no footer".
 */
export function extractSummary(result) {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
  return isSyncSummary(result.summary) ? result.summary : null;
}

/**
 * Render the persistent footer from a footer state, or null when no footer
 * is shown (absent state, e.g. an older CLI without a summary block).
 *
 * input is one of:
 *   - a sync summary (see isSyncSummary),
 *   - { state: "checking" } — the first status check is in flight,
 *   - { state: "syncing" } — an automatic sync is in flight,
 *   - { state: "failed" } — the status check failed.
 *
 * style(color, text) applies a theme color to text; it defaults to the
 * identity. The label is muted; ✓, …, and ⟳ are dim; ↑ is warning; ↓ is
 * accent; ! and ✗ are error.
 */
export function renderFooter(input, style = (color, text) => text) {
  if (input === null || input === undefined) return null;
  if (typeof input === "object" && !Array.isArray(input)) {
    const label = style("muted", `${LABEL} `);
    if ("state" in input) {
      if (input.state === "checking") return label + style("dim", "…");
      if (input.state === "syncing") return label + style("dim", "⟳");
      return label + style("error", "✗"); // failed, or an unknown state
    }
    if (isSyncSummary(input)) {
      const terms = [];
      if (input.localPending > 0) terms.push(style("warning", `↑${input.localPending}`));
      if (input.remotePending > 0) terms.push(style("accent", `↓${input.remotePending}`));
      if (input.needsReview > 0) terms.push(style("error", `!${input.needsReview}`));
      return label + (terms.length > 0 ? terms.join(" ") : style("dim", "✓"));
    }
  }
  return null;
}

/**
 * Derive the exact flat list of paths whose file metadata can change the
 * status summary: the git metadata (any fetch rewrites FETCH_HEAD; local
 * commits and checkouts move HEAD; dirt moves index; ref repacking moves
 * packed-refs), the manifest and lockfile, the agent baseline state, and
 * each manifest-declared settings target under the agent directory.
 * Deliberately flat — no recursive walk of resource targets — so a tick
 * costs a constant number of stat calls regardless of how many resources
 * are managed, and never touches the network.
 */
export function fingerprintPaths({ repoDir, agentDir, settingsTargets = [] }) {
  const paths = [
    path.join(repoDir, ".git", "HEAD"),
    path.join(repoDir, ".git", "index"),
    path.join(repoDir, ".git", "packed-refs"),
    path.join(repoDir, ".git", "FETCH_HEAD"),
    path.join(repoDir, "pi-sync.json"),
    path.join(repoDir, "pi-sync.lock.json"),
    path.join(agentDir, ".pi-sync", "state.json"),
  ];
  for (const target of settingsTargets) {
    if (typeof target === "string" && target.length > 0) paths.push(path.join(agentDir, target));
  }
  return [...new Set(paths)];
}

/**
 * Compute the fingerprint for a path list: one [path, mtimeMs] pair per
 * path, with the stable absent marker null for paths that do not exist.
 * stat is injectable for tests; it must return { mtimeMs } for existing
 * paths and null for absent ones.
 */
export function computeFingerprint(paths, stat = defaultStat) {
  return paths.map((item) => [item, stat(item)?.mtimeMs ?? null]);
}

function defaultStat(filePath) {
  try {
    return { mtimeMs: statSync(filePath).mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Structurally compare two fingerprints: the same ordered list of
 * [path, mtimeMs | null] pairs, with the stable absent marker (null)
 * comparing equal to null. Returns false for non-array input, a length
 * mismatch, or malformed entries, so a stale or corrupt fingerprint never
 * matches and forces a recompute.
 */
export function fingerprintsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== 2 || right.length !== 2) return false;
    if (left[0] !== right[0] || left[1] !== right[1]) return false;
  }
  return true;
}

/**
 * The setup repository's FETCH_HEAD, which git rewrites on every fetch and
 * whose mtime gates the session-start fetch.
 */
export function fetchHeadPath(repoDir) {
  return path.join(repoDir, ".git", "FETCH_HEAD");
}

/** Maximum FETCH_HEAD age (in milliseconds) for which the session-start fetch is skipped. */
export const FETCH_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * The session-start fetch's freshness gate: true when FETCH_HEAD's mtime is
 * younger than maxAgeMs relative to nowMs — a recent fetch already moved the
 * upstream comparison, so fetching again is skipped. A missing FETCH_HEAD
 * (null mtime) is never fresh: the fetch runs. Non-numeric input is never
 * fresh, so a bad read can only cost a redundant fetch, never a stale skip.
 */
export function isFetchFresh(fetchHeadMtimeMs, nowMs, maxAgeMs = FETCH_MAX_AGE_MS) {
  return (
    typeof fetchHeadMtimeMs === "number" &&
    Number.isFinite(fetchHeadMtimeMs) &&
    nowMs - fetchHeadMtimeMs < maxAgeMs
  );
}

/**
 * Shared status cache location: the agent directory's local bookkeeping
 * state, next to the baseline.
 */
export function statusCachePath(agentDir) {
  return path.join(agentDir, ".pi-sync", "status-cache.json");
}

/**
 * Read the shared status cache. Returns the entry ({ fingerprint, summary })
 * when the file exists, parses, and carries a usable fingerprint and
 * summary; null otherwise — an absent or corrupt cache is simply recomputed.
 */
export function readStatusCache(cachePath) {
  let raw;
  try {
    raw = readFileSync(cachePath, "utf8");
  } catch {
    return null;
  }
  try {
    const entry = JSON.parse(raw);
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
    if (!Array.isArray(entry.fingerprint)) return null;
    if (!isSyncSummary(entry.summary)) return null;
    return entry;
  } catch {
    return null;
  }
}

/**
 * Write the shared status cache atomically (temp file + rename). No
 * locking: the same fingerprint deterministically yields the same summary,
 * so concurrent writers are safe (last writer wins).
 */
export function writeStatusCache(cachePath, entry) {
  mkdirSync(path.dirname(cachePath), { recursive: true });
  const tempPath = `${cachePath}.tmp-${process.pid}`;
  writeFileSync(tempPath, JSON.stringify(entry));
  renameSync(tempPath, cachePath);
}