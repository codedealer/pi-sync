/**
 * First-touch write guard for the managed agent directory.
 *
 * Agents reflexively edit the installed copies of managed resources (or drop
 * new resources straight into the agent directory) even though the pi-sync
 * skill says to work in the setup repository. Passive skill text cannot stop
 * that reflex at the moment of decision, so this guard intercepts the Pi
 * `tool_call` event before file-mutating tool calls execute:
 *
 * - Gate by input shape, not tool name: a small list of known read-only tool
 *   names always passes; any other tool whose input carries a top-level
 *   string field with a file-path-like name is a gate candidate when any
 *   resolved candidate path falls under a gated root. This covers the
 *   built-in `write`/`edit` tools and third-party mutation toolsets (for
 *   example hashline's `replace`, `replace_match`, `insert`) alike.
 * - Gated roots: the six resource roots under the agent directory
 *   (skills/, extensions/, prompts/, agents/, roles/, workflows/). Manifest-declared
 *   watcher back-syncs local edits of managed settings into the setup
 *   repository's manifest, so those edits are captured instead of drifting,
 *   and blocking them would only add friction. Gating the resource roots —
 *   not just manifest-declared targets — is deliberate: a brand-new skill is
 *   not in the manifest yet, and "add a new skill" is the motivating failure.
 *   mutating call in a session is blocked, and the block's reason — the
 *   warning — is delivered to the agent as the tool result. Every
 *   subsequent gated call in the session passes. The arming is global for
 *   the session and resets on each session_start.
 * - The warning is self-contained: it names the target, states the main
 *   path with the qualified source path in the setup repository (edit that
 *   path → `pi-sync apply`, plus the concrete `pi-sync add` command
 *   for a brand-new resource), and ends with the explicit retry-to-allow
 *   bypass.
 *
 * The guard is active only on setups managed by Pi Sync (the extension's
 * existing silence rule) and only when PI_SYNC_GUARD is not "off". It
 * performs synchronous path computation plus the extension's managed-setup
 * check; if evaluation itself fails, the call passes through and the failure
 * is at most a one-time warning, degrading to the previous state.
 */
import path from "node:path";

/** A tool_call event as far as the guard needs it: the tool name and its raw input. */
export interface GuardedToolCall {
  toolName: unknown;
  input: unknown;
}

/** The guard's decision: pass through (no result) or block with a reason. */
export interface GuardDecision {
  block?: boolean;
  reason?: string;
}

/** Facts the guard needs from the extension. */
export interface GuardContext {
  /** True when the setup is managed by Pi Sync (the extension's existing silence rule). */
  isManaged: () => boolean;
  /** The managed agent directory. */
  agentDir: () => string;
  /** The setup repository directory. */
  repoDir: () => string;
}

/** The six resource roots under the agent directory, one per manifest resource type. */
const RESOURCE_ROOTS = ["skills", "extensions", "prompts", "agents", "roles", "workflows"];

/**
 * Read-only tools: agents legitimately read the installed copies (for
 * example to port content into the setup repository), so they always pass.
 * Everything not on this list fails closed: a tool targeting a gated root
 * is gated, because one blocked attempt (cheap — arming makes it
 * retryable) is a far smaller cost than an ungated mutation of the managed
 * installation.
 */
const READ_ONLY_TOOLS = new Set(["read", "grep", "cat", "view", "head", "tail", "ls", "list", "search", "stat"]);

/** Top-level input field names that carry file paths. */
const PATH_FIELD_NAMES = ["path", "file", "filePath", "filename", "target", "dir", "directory", "source", "destination", "dest"];

export function createWriteGuard(ctx: GuardContext) {
  let armed = false;
  let warnedOnce = false;

  /** Arming is per session: a fresh session has no warning in context and gets one. */
  function reset(): void {
    armed = false;
  }

  function isGated(p: string): { root: string; relative: string } | undefined {
    const agentDir = path.resolve(ctx.agentDir());
    const relative = path.relative(agentDir, p);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
    const segments = relative.split(path.sep);
    const root = segments[0];
    if (!RESOURCE_ROOTS.includes(root)) return undefined;
    return { root, relative: segments.slice(1).join(path.sep) };
  }

  function candidatePaths(input: unknown, cwd: string): string[] {
    if (typeof input !== "object" || input === null) return [];
    const candidates: string[] = [];
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (PATH_FIELD_NAMES.includes(key) && typeof value === "string" && value.length > 0) {
        candidates.push(path.resolve(cwd, value));
      }
    }
    return candidates;
  }

  /**
   * The resource-root warning. It names the qualified source path in the
   * setup repository — the repository's location plus the matching
   * resources/<root>/ file — so the agent never has to hunt for the setup
   * repository, and gives the concrete add command for a brand-new
   * resource. The add target is the first segment under the type root
   * (a skill directory, an extension file or directory, a single .md
   * prompt/agent/role file, or a single .js workflow file); `--target` takes it agent-relative.
   */
  function resourceWarning(target: string, root: string, relative: string): string {
    const repoDir = ctx.repoDir();
    const resourceRoot = path.join(repoDir, "resources", root);
    const source = relative ? path.join(resourceRoot, relative) : resourceRoot;
    let add: string;
    if (relative) {
      const unit = path.join(resourceRoot, relative.split(path.sep)[0]);
      const target = path.posix.join(root, relative.split(path.sep)[0]);
      add = ` (for a brand-new resource, author it under ${unit}, then run ` +
        `pi-sync add --target ${target} and pi-sync apply to bring it under management)`;
    } else {
      add = ` (for a brand-new resource, author it under ${resourceRoot}, then run ` +
        `pi-sync add --list to discover undeclared resources)`;
    }
    return (
      `pi-sync write guard: ${target} is under ${root}/ of the Pi agent directory, which Pi Sync manages from ` +
      `the setup repository at ${repoDir}. ` +
      `Do not edit the installed copy directly. Edit the source at ${source} in the setup repository, ` +
      `then run: pi-sync apply${add}. ` +
      `If this is an intentional local-only change, retry the same operation: ` +
      `subsequent attempts are allowed. The pi-sync skill documents the full workflow.`
    );
  }

  /**
   * Evaluate one tool call. Returns undefined (pass through) or a block
   * decision with the warning as its reason. Never throws: a guard
   * evaluation failure degrades to pass-through with a one-time warning.
   */
  function evaluate(event: GuardedToolCall, cwd: string): GuardDecision | undefined {
    try {
      if (process.env.PI_SYNC_GUARD === "off") return undefined;
      if (!ctx.isManaged()) return undefined;
      const toolName = typeof event.toolName === "string" ? event.toolName : "";
      if (READ_ONLY_TOOLS.has(toolName)) return undefined;
      for (const candidate of candidatePaths(event.input, cwd)) {
        const gate = isGated(candidate);
        if (gate !== undefined) {
          if (armed) return undefined; // first touch already warned this session: persistence is intent
          armed = true;
          return { block: true, reason: resourceWarning(candidate, gate.root, gate.relative) };
        }
      }
      return undefined;
    } catch {
      if (!warnedOnce) {
        warnedOnce = true;
        try {
          console.warn("pi-sync write guard: evaluation failed; passing the tool call through");
        } catch {
          // The guard must never crash the session, even if warnings cannot be written.
        }
      }
      return undefined;
    }
  }

  return { reset, evaluate };
}