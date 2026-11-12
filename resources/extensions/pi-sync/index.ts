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
 * Environment overrides:
 *   PI_SYNC_REPO_DIR  setup repository path (default ~/.pi-sync/setup)
 *   PI_SYNC_BIN       pi-sync executable (default `pi-sync` on PATH)
 */
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const STATUS_ID = "pi-sync";
const DEBOUNCE_MS = 400;
const INITIAL_SYNC_DELAY_MS = 1500;
const SYNC_TIMEOUT_MS = 20_000;

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

export default function (pi: ExtensionAPI) {
  let watcher: FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let pending = false;
  let warned = false;

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

  function announce(ctx: ExtensionContext, message: string, color: "dim" | "warning", level: "info" | "warning") {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.notify(message, level);
      ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg(color, "pi-sync"));
    } catch {
      // UI state can be torn down while a debounced sync is in flight; never let that break the session.
    }
  }

  async function runSync(ctx: ExtensionContext, manual: boolean) {
    if (running) {
      pending = true;
      return;
    }
    running = true;
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
      if (pending) {
        pending = false;
        schedule(ctx);
      }
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

  pi.on("session_start", (_event, ctx) => {
    const targets = managedTargets();
    const dir = agentDir();
    if (!targets.length || !existsSync(dir)) return; // not a pi-sync-managed setup: stay silent
    watcher = watch(dir, (_eventType, filename) => {
      const name = filename?.toString();
      if (name && targets.includes(name)) schedule(ctx);
    });
    // Reconcile changes made while no watched Pi session was running.
    timer = setTimeout(() => {
      timer = undefined;
      void runSync(ctx, false);
    }, INITIAL_SYNC_DELAY_MS);
    timer.unref?.();
  });

  pi.on("session_shutdown", () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    watcher?.close();
    watcher = undefined;
    pending = false;
  });

  pi.registerCommand("pi-sync", {
    description: "Check for local Pi setting changes and sync them into the pi-sync setup repo",
    handler: async (_args, ctx) => {
      await runSync(ctx, true);
    },
  });
}