/**
 * Pi Sync settings watcher.
 *
 * Pi writes settings.json (and other managed settings files) whenever the
 * user changes a model, theme, thinking level, or any other setting in the
 * TUI. Pi Sync manages selected fields of those files through the private
 * setup repository, so a local-only change would silently drift away from
 * the manifest until someone edits it by hand.
 *
 * This extension closes that loop: it watches the agent directory for
 * changes to the files the setup manifest declares as settings targets and,
 * after a short debounce, runs `pi-sync sync --apply`, which promotes
 * local-only changes into the manifest (three-way compared against the last
 * applied baseline, portability-validated, and atomically written). All
 * sync logic lives in the pi-sync CLI; this extension is a thin trigger
 * and relay, so the CLI remains the single source of truth and stays usable
 * headless.
 *
 * The extension also renders the CLI's sync summary as a persistent footer.
 * A single `refresh` path keeps it current: it computes a flat metadata
 * fingerprint (git refs, manifest, lockfile, agent baseline, settings
 * targets), skips when the in-memory fingerprint is unchanged, reuses a
 * matching entry from the shared status cache written by another session,
 * and otherwise runs `pi-sync status` and publishes its `summary` to the
 * cache. Refreshes are triggered at session start, after every sync
 * completion, on top-level setup-repository changes (a debounced watcher),
 * and by an unref'ed 60-second tick that costs only the fingerprint's stat
 * calls in steady state. The session-start path never awaits the CLI, and
 * the extension never computes drift itself; a failed refresh shows the
 * failure state without erasing the last successful summary. A CLI result
 * without a `summary` block (older CLI) shows no footer and falls back to
 * the pre-footer status-entry behavior, and non-managed setups stay
 * completely silent.
 *
 * At session start the extension also makes remote commits visible without
 * pulling, merging, or applying them: the session-start refresh runs a
 * fresh `pi-sync status`, which owns the upstream fetch (a bounded,
 * fetch-only update of the Git metadata) and bypasses the shared status
 * cache, so a new session is never satisfied by a cached remote summary.
 * The session-start refresh is single-flight, so overlapping starts never
 * duplicate the fetch. Every other refresh (the 60-second tick, watcher
 * events, sync completion) runs the offline `pi-sync status --no-fetch`, so
 * the tick never touches the network and the shared cache keeps
 * deduplicating steady-state refreshes. A failed refresh shows the failure
 * state without erasing the last successful summary, and the next session
 * start retries the upstream refresh.
 *
 * At Pi process startup (session_start with reason "startup" — not on
 * resume, fork, new-session, or reload starts) a managed setup also
 * receives a one-line orientation notification naming the two flows a user
 * is most likely to need: updating dependencies with `pi-sync update` and
 * managing resources by editing the setup repository and running
 * `pi-sync apply`, plus a pointer to the pi-sync skill for the full
 * workflow. It is delivered as a user-facing info notification only —
 * never a transcript entry, custom session message, or system-prompt
 * section — so it stays out of the transcript and the LLM context, and it
 * is absent on setups that are not managed by Pi Sync.
 *
 * A valid managed setup also takes ownership of Pi's built-in latest-version
 * notice by setting PI_SKIP_VERSION_CHECK during extension initialization,
 * unless the user already supplied that variable. At process startup only,
 * it asynchronously runs `pi-sync pi-update`; an eligible version gets a
 * separate warning notification with the explicit `pi-sync pi-update --apply`
 * command. The read-only check never delays startup or applies an update.
 *
 * The extension also guards the first reflexive reach for the local
 * installation: on a managed setup it intercepts tool calls that mutate
 * files under the agent directory's resource roots (skills/, extensions/,
 * prompts/, agents/, roles/). Manifest-declared settings targets are not
 * gated: the settings watcher back-syncs local edits of managed settings
 * into the setup repository's manifest, so those edits are captured instead
 * of drifting, and blocking them would only add friction. The first such
 * call in a session is blocked, and the warning — the qualified source path
 * in the setup repository, then pi-sync apply (plus the concrete pi-sync
 * register command for a new resource), and the explicit retry-to-allow
 * bypass — is returned as the tool result. Every later call in the session
 * passes (persistence is intent), and arming resets on each session_start.
 * The gate is by input shape (path-like top-level fields), not tool name,
 * and known read-only tools always pass. It carries no UI, works in TUI,
 * RPC, and headless modes alike, stays silent on setups that are not
 * managed by Pi Sync, and a failed guard evaluation passes the call
 * through. See guard.ts for the module that implements it.
 *
 * Environment overrides:
 *   PI_SYNC_REPO_DIR  setup repository path (default ~/.pi-sync/setup)
 *   PI_SYNC_BIN       pi-sync executable (default `pi-sync` on PATH)
 *   PI_SYNC_GUARD     "off" disables the first-touch write guard (default: on)
 */
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { createWriteGuard } from "./guard.js";
import { shellFor } from "./process.js";
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  computeFingerprint,
  extractSummary,
  fingerprintPaths,
  fingerprintsEqual,
  readStatusCache,
  renderFooter,
  statusCachePath,
  writeStatusCache,
} from "./status.js";

const execFileAsync = promisify(execFile);

const STATUS_ID = "pi-sync";
const DEBOUNCE_MS = 400;
const INITIAL_SYNC_DELAY_MS = 1500;
const SYNC_TIMEOUT_MS = 20_000;
// Timeout for the CLI `status` spawn. The CLI's own upstream fetch is
// bounded at 15 s, so this must keep enough margin above it for the fetch
// plus the validation/plan/state work to finish before the extension
// kills the child; a tighter bound would turn a slow-but-fine fetch into
// a spurious failed footer.
const CLI_STATUS_TIMEOUT_MS = 30_000;
const PI_UPDATE_TIMEOUT_MS = 20_000;
const TICK_MS = 60_000;

interface SyncedField {
  target: string;
  path: string;
}

interface SyncResult {
  apiVersion: number;
  command: string;
  ok: boolean;
  exitCode: number;
  mode: string;
  synced?: SyncedField[];
  conflicts?: unknown[];
  rejected?: unknown[];
  review?: unknown[];
}

interface SyncSummary {
  localPending: number;
  remotePending: number;
  needsReview: number;
  clean: boolean;
}

/** A fingerprint: ordered [path, mtimeMs] pairs, with the stable absent marker null for missing paths. */
type Fingerprint = [string, number | null][];

/** What the persistent footer currently renders. */
type FooterPhase = "checking" | "summary" | "failed" | "legacy";

/** True for a structured CLI failure result (ok:false plus an error string), as opposed to a valid result that merely reports conflicts. */
function isCliError(value: unknown): value is { ok: false; error: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { error?: unknown }).error === "string"
  );
}

export default function (pi: ExtensionAPI) {
  let watcher: FSWatcher | undefined;
  let repoWatcher: FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  let refreshTimer: NodeJS.Timeout | undefined;
  let tick: NodeJS.Timeout | undefined;
  let running = false;
  let pending = false;
  let warned = false;
  // Persistent footer state: the phase plus the last successfully rendered
  // summary. A failed check never clears lastSummary — it only shows the
  // failure state until the next successful check. footerShown tracks whether
  // the footer currently owns the status entry: in the legacy phase (older
  // CLI) it clears the entry once when leaving the footer and then leaves
  // the entry alone so the pre-footer announce behavior keeps working.
  let phase: FooterPhase = "checking";
  let lastSummary: SyncSummary | undefined;
  let footerShown = false;
  let statusWarned = false;
  let refreshGeneration = 0;
  // Single-flight flag for the session-start refresh: while one is in
  // flight, further session starts skip their own refresh (the in-flight one
  // runs the fresh CLI status, which owns the upstream fetch, and its
  // completion renders and publishes the result). The CLI status timeout
  // bounds the in-flight window, so the flag always clears. It is
  // deliberately not reset on shutdown: the in-flight child finishes on its
  // own and its completion refresh still runs, while resetting would allow
  // two overlapping upstream fetches in the same process.
  let sessionStartRefreshInFlight = false;
  // The fingerprint the footer currently reflects — advanced only by a
  // successful refresh (or a cache hit), never by a failed one, so the next
  // trigger retries a failed check. Reset at session start so the first
  // refresh of each session always runs the fresh CLI status.
  let lastFingerprint: Fingerprint | undefined;
  let targetsMemo: { mtime: number | null; targets: string[] } | undefined;

  const repoDir = () => process.env.PI_SYNC_REPO_DIR ?? path.join(os.homedir(), ".pi-sync", "setup");
  const agentDir = () => getAgentDir();
  const cliBinary = () => process.env.PI_SYNC_BIN ?? "pi-sync";

  function isManagedSetup(): boolean {
    try {
      const manifest = JSON.parse(readFileSync(path.join(repoDir(), "pi-sync.json"), "utf8")) as {
        schemaVersion?: unknown;
        resources?: unknown;
        dependencies?: unknown;
        settings?: unknown;
      };
      return manifest.schemaVersion === 1 && Array.isArray(manifest.resources) && Array.isArray(manifest.dependencies) &&
        (manifest.settings === undefined || Array.isArray(manifest.settings)) && existsSync(agentDir());
    } catch {
      return false;
    }
  }

  const managedSetupAtInitialization = isManagedSetup();
  // Pi performs its own version check after extension initialization. Take over
  // that check only for managed setups, and never overwrite user configuration.
  if (managedSetupAtInitialization && process.env.PI_SKIP_VERSION_CHECK === undefined) {
    process.env.PI_SKIP_VERSION_CHECK = "1";
  }
  let piUpdateNoticeStarted = false;
  /** File names the setup manifest declares as settings targets, or [] when no settings targets are declared. */
  function managedTargets(): string[] {
    try {
      const manifest = JSON.parse(readFileSync(path.join(repoDir(), "pi-sync.json"), "utf8")) as {
        settings?: Array<{ target?: unknown }>;
      };
      const targets = (manifest.settings ?? []).map((item) => item?.target);
      return [...new Set(targets.filter((target): target is string => typeof target === "string"))];
    } catch {
      return [];
    }
  }

  function styleOf(ctx: ExtensionContext) {
    return (color: "muted" | "dim" | "warning" | "accent" | "error", text: string) => ctx.ui.theme.fg(color, text);
  }

  /**
   * The manifest's declared settings targets, memoized on the manifest's
   * mtime so the 60-second tick stays metadata-only (stat calls, no file
   * reads). The manifest's mtime is part of the fingerprint, so any real
   * manifest change invalidates the memo and the fingerprint together.
   */
  function currentTargets(): string[] {
    const manifestPath = path.join(repoDir(), "pi-sync.json");
    let mtime: number | null = null;
    try {
      mtime = statSync(manifestPath).mtimeMs;
    } catch {
      // Absent manifest: the targets stay [] (unmanaged setup).
    }
    if (targetsMemo !== undefined && targetsMemo.mtime === mtime) return targetsMemo.targets;
    targetsMemo = { mtime, targets: managedTargets() };
    return targetsMemo.targets;
  }
  // First-touch write guard: intercepts tool calls that mutate files under
  // the agent directory's resource roots. The first such call in a session
  // is blocked, and the warning (the qualified source path in the setup
  // repository, pi-sync apply, plus the explicit retry-to-allow bypass) is
  // delivered as the tool result; later calls pass — persistence is intent.
  // Settings targets are not gated: the settings watcher back-syncs local
  // edits into the manifest. Silent on setups that are not managed by Pi
  // Sync and when PI_SYNC_GUARD=off; a failed guard evaluation passes the
  // call through, so this never blocks or crashes a session (see guard.ts).
  const writeGuard = createWriteGuard({
    isManaged: isManagedSetup,
    agentDir,
    repoDir,
  });
  /** The footer text for the current state, or undefined when no footer is shown (legacy CLI). */
  function footerText(ctx: ExtensionContext): string | undefined {
    let input: unknown;
    if (running) input = { state: "syncing" };
    else if (phase === "failed") input = { state: "failed" };
    else if (phase === "summary") input = lastSummary;
    else if (phase === "checking") input = { state: "checking" };
    else input = null; // legacy: no footer
    return renderFooter(input, styleOf(ctx)) ?? undefined;
  }

  function setFooter(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    try {
      if (phase === "legacy") {
        if (footerShown) {
          ctx.ui.setStatus(STATUS_ID, undefined);
          footerShown = false;
        }
        return;
      }
      ctx.ui.setStatus(STATUS_ID, footerText(ctx));
      footerShown = true;
    } catch {
      // UI state can be torn down while an async check is in flight; never let that break the session.
    }
  }

  function announce(ctx: ExtensionContext, message: string, color: "dim" | "warning", level: "info" | "warning") {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.notify(message, level);
      // The footer is the canonical persistent indicator once it is shown;
      // only the legacy (older-CLI) fallback keeps the bare status entry.
      if (phase === "legacy") {
        ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg(color, "pi-sync"));
      }
    } catch {
      // UI state can be torn down while a debounced sync is in flight; never let that break the session.
    }
  }

  /** A best-effort, read-only eligibility check; never block or fail session startup. */
  async function checkPiUpdate(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    try {
      const { stdout } = await execFileAsync(cliBinary(), ["pi-update", "--repo", repoDir(), "--agent-dir", agentDir()], {
        timeout: PI_UPDATE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        shell: shellFor(cliBinary()),
      });
      const result = JSON.parse(stdout) as {
        apiVersion?: unknown;
        command?: unknown;
        ok?: unknown;
        mode?: unknown;
        candidate?: { version?: unknown } | null;
      };
      if (result.apiVersion !== 1 || result.command !== "pi-update" || result.ok !== true || result.mode !== "preview" ||
          typeof result.candidate?.version !== "string" || !result.candidate.version) return;
      ctx.ui.notify(
        `Pi Sync Update Available: Pi ${result.candidate.version} has passed your release-age policy. Run \`pi-sync pi-update --apply\` to update.`,
        "warning",
      );
    } catch {
      // Discovery is advisory; unavailable CLI, registry, or UI must not affect startup.
    }
  }

/**
   * The single refresh path for the persistent footer.
   *
   * Computes the flat metadata fingerprint (git refs, manifest, lockfile,
   * agent baseline, settings targets) and then, in order:
   *   1. fingerprint equals the in-memory last fingerprint → do nothing
   *      (the footer already reflects this state; steady-state cost is the
   *      fingerprint's stat calls only);
   *   2. (unless bypassCache) the shared status cache carries this
   *      fingerprint → render the cached summary (another session already
   *      recomputed; no spawn);
   *   3. otherwise run `pi-sync status`, render the summary, and publish
   *      { fingerprint, summary } to the shared cache.
   *
   * Two flavors: the session-start refresh (bypassCache) always runs the
   * CLI status, which owns the bounded upstream fetch — a new session is
   * never satisfied by a cached remote summary. Every other refresh passes
   * offline, so the CLI status runs --no-fetch: it reads last-known
   * tracking refs, touches no network, and the fingerprint (which includes
   * FETCH_HEAD) invalidates the result once a fetch moves the upstream.
   *
   * Never awaited by the session-start path. A non-zero exit is not itself
   * a failure: the CLI emits its full JSON result on stdout even when
   * conflicts need review (exit 1) or validation fails (exit 2); only
   * spawn, timeout, structured CLI error, and unparseable output count as
   * failures. A failure shows the failure state and warns once (reusing the
   * existing one-time warning pattern); it never clears the last successful
   * summary and never advances the in-memory fingerprint, so the next
   * trigger retries.
   */
  async function refresh(ctx: ExtensionContext, options: { bypassCache?: boolean; offline?: boolean } = {}) {
    const generation = ++refreshGeneration;
    const fingerprint = computeFingerprint(
      fingerprintPaths({ repoDir: repoDir(), agentDir: agentDir(), settingsTargets: currentTargets() }),
    ) as Fingerprint;
    if (fingerprintsEqual(fingerprint, lastFingerprint)) return; // footer already correct
    // The session-start refresh bypasses the shared cache: a new session
    // must see a freshly fetched upstream state, not another session's
    // cached remote summary.
    if (!options.bypassCache) {
      const cached = readStatusCache(statusCachePath(agentDir()));
      if (cached !== null && fingerprintsEqual(cached.fingerprint, fingerprint)) {
        lastSummary = cached.summary;
        phase = "summary";
        lastFingerprint = fingerprint;
        setFooter(ctx);
        return;
      }
    }
    let stdout: string;
    try {
      stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          cliBinary(),
          ["status", ...(options.offline ? ["--no-fetch"] : []), "--repo", repoDir(), "--agent-dir", agentDir()],
          { timeout: CLI_STATUS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, shell: shellFor(cliBinary()) },
          (error, out) => {
            if (error !== null && (error.killed === true || error.signal !== undefined)) {
              reject(error); // timeout or kill: no usable output
            } else if (typeof out === "string" && out.length > 0) {
              resolve(out);
            } else {
              reject(error ?? new Error("pi-sync status produced no output"));
            }
          },
        );
      });
    } catch (error) {
      if (generation !== refreshGeneration) return; // superseded by a newer session's check
      phase = "failed";
      if (!statusWarned) {
        statusWarned = true;
        const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
        announce(ctx, `pi-sync: status check failed (${detail}); the footer shows the failure state until the next check`, "warning", "warning");
      }
      setFooter(ctx);
      return; // lastSummary and lastFingerprint are untouched: the next trigger retries
    }
    if (generation !== refreshGeneration) return; // superseded by a newer session's check
    let parsed: unknown;
    let parseOk = false;
    try {
      parsed = JSON.parse(stdout);
      parseOk = true;
    } catch {
      parsed = null;
    }
    const summary = extractSummary(parsed);
    if (summary) {
      lastSummary = summary;
      phase = "summary";
      lastFingerprint = fingerprint;
      try {
        writeStatusCache(statusCachePath(agentDir()), { fingerprint, summary });
      } catch {
        // The shared cache is a cross-session optimization; a write failure
        // only costs other sessions a redundant recompute, not this render.
      }
    } else if (isCliError(parsed)) {
      // A structured CLI failure (repository error, invalid manifest, …) is
      // a status-check failure, not a sync state.
      phase = "failed";
      if (!statusWarned) {
        statusWarned = true;
        announce(ctx, `pi-sync: status check failed (${parsed.error}); run pi-sync status for details`, "warning", "warning");
      }
    } else if (parseOk) {
      // Older CLI without a summary block: show no footer and keep the
      // pre-footer post-sync status entry behavior. There is nothing to
      // cache, but the result is deterministic for this fingerprint, so
      // record it to keep the tick from re-spawning the CLI every minute.
      phase = "legacy";
      lastFingerprint = fingerprint;
    } else {
      // Unparseable output is a check failure per the spec, not a legacy result.
      phase = "failed";
      if (!statusWarned) {
        statusWarned = true;
        announce(ctx, "pi-sync: status check produced unparseable output; the footer shows the failure state until the next check", "warning", "warning");
      }
    }
    setFooter(ctx);
  }

/**
   * The session-start remote awareness: the fresh refresh flavor, which
   * runs the CLI status without the shared cache so the CLI's bounded
   * upstream fetch makes remote commits visible in the footer without ever
   * pulling, merging, or applying them (applying remote changes remains the
   * explicit human flow: pull, then `pi-sync apply`). The extension no
   * longer invokes git itself; the CLI owns the fetch, and a matching
   * shared cache entry cannot suppress this refresh.
   *
   * Single-flight (never overlapping): while one is in flight, further
   * session starts skip their own refresh, so the upstream fetch never
   * duplicates within this process. Never awaited by the session-start
   * path: startup stays asynchronous and unblocked.
   */
  async function sessionStartRefresh(ctx: ExtensionContext) {
    if (sessionStartRefreshInFlight) return; // single-flight: never overlapping
    sessionStartRefreshInFlight = true;
    try {
      await refresh(ctx, { bypassCache: true });
    } finally {
      sessionStartRefreshInFlight = false;
    }
  }

  async function runSync(ctx: ExtensionContext, manual: boolean) {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    setFooter(ctx); // auto-sync in flight: footer shows ⟳
    try {
      const { stdout } = await execFileAsync(cliBinary(), ["sync", "--apply", "--repo", repoDir(), "--agent-dir", agentDir()], {
        timeout: SYNC_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        shell: shellFor(cliBinary()),
      });
      const result = JSON.parse(stdout) as SyncResult;
      if (result.ok && result.synced?.length) {
        const summary = result.synced.map((item) => `${item.target} ${item.path}`).join(", ");
        announce(ctx, `pi-sync: synced local setting change${result.synced.length > 1 ? "s" : ""} to the setup repo (${summary})`, "dim", "info");
      } else if (!result.ok) {
        const count = (result.conflicts?.length ?? 0) + (result.rejected?.length ?? 0) + (result.review?.length ?? 0);
        announce(ctx, `pi-sync: ${count} managed setting change${count === 1 ? "" : "s"} need manual review; run pi-sync plan`, "warning", "warning");
      } else if (manual) {
        announce(ctx, "pi-sync: nothing to sync; local settings match the setup repo", "dim", "info");
      }
    } catch (error) {
      if (!warned) {
        warned = true;
        const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
        announce(ctx, `pi-sync: automatic settings sync failed (${detail}); it will retry on the next change`, "warning", "warning");
      }
    } finally {
      running = false;
      setFooter(ctx); // back to the last known state (summary, failure, or checking)
      if (pending) {
        pending = false;
        schedule(ctx);
      }
      // After every sync completion (watcher-triggered or manual), re-check
      // so the footer matches the sync's result; the fingerprint dedupes if
      // nothing the sync wrote is fingerprinted.
      void refresh(ctx, { offline: true });
    }
  }

  function schedule(ctx: ExtensionContext) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void runSync(ctx, false);
    }, DEBOUNCE_MS);
    timer.unref?.();
  }

  /** Debounced refresh from top-level setup-repository watcher events. */
  function scheduleRefresh(ctx: ExtensionContext) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void refresh(ctx, { offline: true });
    }, DEBOUNCE_MS);
    refreshTimer.unref?.();
  }

  pi.on("session_start", (event, ctx) => {
    const dir = agentDir();
    if (!managedSetupAtInitialization || !existsSync(dir)) return; // not a managed setup: stay silent
    // Arming is per session: a fresh session has no warning in context and
    // gets its own first-touch block.
    writeGuard.reset();
    const targets = currentTargets();
    // One-line startup orientation for managed setups: process startup only
    // (reason "startup" — not resume/fork/new/reload, whose users are
    // already oriented), a user-facing info notification only (never a
    // transcript entry or LLM context), and local and free (no freshness
    // gate). The managed gate above keeps unmanaged setups silent.
    if (event.reason === "startup" && !piUpdateNoticeStarted) {
      piUpdateNoticeStarted = true;
      void checkPiUpdate(ctx);
    }
    if (event.reason === "startup" && ctx.hasUI) {
      try {
        ctx.ui.notify(
          "pi-sync: managed setup — update dependencies with pi-sync update; manage resources by editing the setup repository, then pi-sync apply; the pi-sync skill documents the full workflow",
          "info",
        );
      } catch {
        // UI state can be unavailable while the session boots; orientation is best-effort.
      }
    }
    if (!targets.length) return; // Pi update notices also apply to managed setups without settings targets.
    watcher = watch(dir, (_eventType, filename) => {
      const name = filename?.toString();
      if (name && targets.includes(name)) schedule(ctx);
    });
    // New top-level, non-recursive watch of the setup repository: any
    // top-level change (manual manifest edits, git pull file writes from
    // another terminal, fetch ref updates) schedules a debounced refresh.
    if (existsSync(repoDir())) {
      repoWatcher = watch(repoDir(), () => scheduleRefresh(ctx));
      repoWatcher.on("error", () => {
        // The repository may be moved or deleted out from under us; the
        // 60-second tick keeps the footer current from the agent side.
      });
    }
    // Reconcile changes made while no watched Pi session was running.
    timer = setTimeout(() => {
      timer = undefined;
      void runSync(ctx, false);
    }, INITIAL_SYNC_DELAY_MS);
    timer.unref?.();
    // 60-second metadata-only tick: the same refresh path, which in steady
    // state costs the fingerprint's stat calls only (in-memory skip) and
    // never touches the network. unref'ed so it never keeps the process
    // alive.
    tick = setInterval(() => {
      void refresh(ctx, { offline: true });
    }, TICK_MS);
    tick.unref?.();
    // Persistent footer: show the checking state immediately and run the
    // session-start refresh asynchronously; nothing on the session-start
    // path awaits the CLI. The refresh bypasses the shared status cache and
    // runs the CLI status, which owns the bounded upstream fetch, so a new
    // session is never satisfied by a cached remote summary and the fetch
    // never duplicates (single-flight). lastFingerprint is reset so the
    // first refresh of this session always runs the fresh status.
    phase = "checking";
    lastSummary = undefined;
    lastFingerprint = undefined;
    setFooter(ctx);
    void sessionStartRefresh(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
    if (tick) {
      clearInterval(tick);
      tick = undefined;
    }
    watcher?.close();
    watcher = undefined;
    repoWatcher?.close();
    repoWatcher = undefined;
    pending = false;
    // Explicitly clear the footer entry (in addition to the existing
    // teardown); the next session start re-checks and re-renders.
    if (ctx.hasUI) {
      try {
        ctx.ui.setStatus(STATUS_ID, undefined);
      } catch {
        // The UI may already be torn down; there is nothing left to clear.
      }
    }
    footerShown = false;
  });

  pi.on("tool_call", (event, ctx) => {
    // The first gated mutating call in a session is blocked, and the
    // warning is returned as the tool result; every later call passes
    // (persistence is intent). The block carries no UI, so it works in
    // TUI, RPC, and headless modes alike.
    try {
      return writeGuard.evaluate(event, ctx.cwd);
    } catch {
      // The guard must never crash the session: pass the call through.
      return undefined;
    }
  });

  pi.registerCommand("pi-sync", {
    description: "Check for local Pi setting changes and sync them into the pi-sync setup repo",
    handler: async (_args, ctx) => {
      await runSync(ctx, true);
    },
  });
}