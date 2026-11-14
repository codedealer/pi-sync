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
 * pulling, merging, or applying them: a fetch-only `git fetch --quiet`,
 * skipped when FETCH_HEAD is younger than five minutes, single-flight,
 * bounded by a 15-second timeout, and triggered only at session start — the
 * tick never touches the network. The fetch's completion (success or
 * failure) runs the normal refresh path, so the ref and FETCH_HEAD changes
 * are picked up by the fingerprint like any other change. A fetch failure
 * is silent: network or authentication trouble is not a sync-state failure,
 * so it never shows the failure state, never announces itself, and the
 * footer keeps its last known state until the next session retries.
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
 * Environment overrides:
 *   PI_SYNC_REPO_DIR  setup repository path (default ~/.pi-sync/setup)
 *   PI_SYNC_BIN       pi-sync executable (default `pi-sync` on PATH)
 */
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  computeFingerprint,
  extractSummary,
  fetchHeadPath,
  fingerprintPaths,
  fingerprintsEqual,
  isFetchFresh,
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
const TICK_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;

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
  // Single-flight flag for the session-start fetch: while a fetch is in
  // flight, further session starts skip their own fetch (the in-flight one's
  // completion already triggers the refresh). The execFile timeout bounds
  // the in-flight window, so the flag always clears within ~15 s. It is
  // deliberately not reset on shutdown: the in-flight child finishes on its
  // own and its completion refresh still runs, while resetting would allow
  // two overlapping fetches in the same process.
  let fetchInFlight = false;
  // The fingerprint the footer currently reflects — advanced only by a
  // successful refresh (or a cache hit), never by a failed one, so the next
  // trigger retries a failed check. Reset at session start so the first
  // refresh of each session always at least consults the shared cache.
  let lastFingerprint: Fingerprint | undefined;
  let targetsMemo: { mtime: number | null; targets: string[] } | undefined;

  const repoDir = () => process.env.PI_SYNC_REPO_DIR ?? path.join(os.homedir(), ".pi-sync", "setup");
  const agentDir = () => getAgentDir();
  const cliBinary = () => process.env.PI_SYNC_BIN ?? "pi-sync";

  /** File names the setup manifest declares as settings targets, or [] when this is not a pi-sync-managed setup. */
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

  /**
   * The single refresh path for the persistent footer.
   *
   * Computes the flat metadata fingerprint (git refs, manifest, lockfile,
   * agent baseline, settings targets) and then, in order:
   *   1. fingerprint equals the in-memory last fingerprint → do nothing
   *      (the footer already reflects this state; steady-state cost is the
   *      fingerprint's stat calls only);
   *   2. the shared status cache carries this fingerprint → render the
   *      cached summary (another session already recomputed; no spawn);
   *   3. otherwise run `pi-sync status`, render the summary, and publish
   *      { fingerprint, summary } to the shared cache.
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
  async function refresh(ctx: ExtensionContext) {
    const generation = ++refreshGeneration;
    const fingerprint = computeFingerprint(
      fingerprintPaths({ repoDir: repoDir(), agentDir: agentDir(), settingsTargets: currentTargets() }),
    ) as Fingerprint;
    if (fingerprintsEqual(fingerprint, lastFingerprint)) return; // footer already correct
    const cached = readStatusCache(statusCachePath(agentDir()));
    if (cached !== null && fingerprintsEqual(cached.fingerprint, fingerprint)) {
      lastSummary = cached.summary;
      phase = "summary";
      lastFingerprint = fingerprint;
      setFooter(ctx);
      return;
    }
    let stdout: string;
    try {
      stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          cliBinary(),
          ["status", "--repo", repoDir(), "--agent-dir", agentDir()],
          { timeout: SYNC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
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
   * The session-start remote check: a fetch-only `git fetch --quiet`
   * against the upstream that makes remote commits visible in the footer
   * without ever pulling, merging, or applying them (applying remote
   * changes remains the explicit human flow: pull, then `pi-sync apply`).
   *
   * Skipped when the repository's FETCH_HEAD (rewritten by every fetch) is
   * younger than five minutes — this covers back-to-back sessions and a
   * fetch the user just ran. Otherwise a single-flight (never overlapping)
   * child process runs the fetch with a 15-second timeout. The extension
   * invokes git directly for this one read-only network operation; no CLI
   * subcommand is introduced, and nothing else in the extension touches the
   * network (the 60-second tick stays offline).
   *
   * On completion — success or failure — the normal refresh path is
   * triggered, so the ref and FETCH_HEAD mtime changes are picked up by the
   * fingerprint like any other change; when the fetch changed nothing (or
   * failed), the refresh dedupes in memory and costs stat calls only.
   * Failure is silent by design: network or authentication trouble is not a
   * sync-state failure, so it never shows the failed state, never warns, and
   * never touches the footer — which keeps its last known state — and the
   * next session retries. Never awaited by the session-start path.
   */
  async function checkRemote(ctx: ExtensionContext) {
    if (fetchInFlight) return; // single-flight: never overlapping
    let fetchHeadMtimeMs: number | null = null;
    try {
      fetchHeadMtimeMs = statSync(fetchHeadPath(repoDir())).mtimeMs;
    } catch {
      // Absent or unreadable FETCH_HEAD: never fetched (or a non-git setup) — run the fetch.
    }
    if (isFetchFresh(fetchHeadMtimeMs, Date.now())) return; // a recent fetch already moved the upstream comparison
    fetchInFlight = true;
    try {
      await new Promise<void>((resolve) => {
        execFile(
          "git",
          ["fetch", "--quiet"],
          { cwd: repoDir(), timeout: FETCH_TIMEOUT_MS },
          () => resolve(), // success and failure alike: the refresh below runs either way
        );
      });
    } finally {
      fetchInFlight = false;
    }
    void refresh(ctx);
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
      void refresh(ctx);
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
      void refresh(ctx);
    }, DEBOUNCE_MS);
    refreshTimer.unref?.();
  }

  pi.on("session_start", (event, ctx) => {
    const targets = currentTargets();
    const dir = agentDir();
    if (!targets.length || !existsSync(dir)) return; // not a pi-sync-managed setup: stay silent
    // One-line startup orientation for managed setups: process startup only
    // (reason "startup" — not resume/fork/new/reload, whose users are
    // already oriented), a user-facing info notification only (never a
    // transcript entry or LLM context), and local and free (no freshness
    // gate). The managed gate above keeps unmanaged setups silent.
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
      void refresh(ctx);
    }, TICK_MS);
    tick.unref?.();
    // Persistent footer: show the checking state immediately and run the
    // first refresh asynchronously; nothing on the session-start path
    // awaits the CLI. lastFingerprint is reset so the first refresh of this
    // session always at least consults the shared cache.
    phase = "checking";
    lastSummary = undefined;
    lastFingerprint = undefined;
    setFooter(ctx);
    void refresh(ctx);
    // Session-start remote awareness: fetch-only, freshness-gated,
    // single-flight, bounded; never awaited, and its completion triggers
    // the normal refresh path.
    void checkRemote(ctx);
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

  pi.registerCommand("pi-sync", {
    description: "Check for local Pi setting changes and sync them into the pi-sync setup repo",
    handler: async (_args, ctx) => {
      await runSync(ctx, true);
    },
  });
}