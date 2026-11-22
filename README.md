# pi-sync

A small Node.js CLI for applying explicitly declared Pi user-level resources from a setup repository. This repository contains the public CLI only; personal setup files belong in a separate private setup repository.

## Requirements

- Node.js 22 or newer

## Public installation and private-repository bootstrap

The npm package publishes the CLI and its first-party `pi-sync` skill and extension. Its `files` allowlist excludes setup repositories, credentials, scratch design files, and test fixtures. The package runs no install hooks, so installation works identically under npm and pnpm without script approval; after installing or updating the package, rerun your usual bootstrap command to refresh the bundled resources in your setup repository.

Install globally at user level where your npm/pnpm prefix is writable, or use a one-shot runner. Configure a user-writable npm prefix if needed; do not use sudo.

```sh
npm install --global @codedealer/pi-sync
# or: pnpm add --global @codedealer/pi-sync
# fallback without a global install:
pnpm dlx @codedealer/pi-sync bootstrap --repo-url https://github.com/OWNER/PRIVATE-SETUP.git
# optionally select a user-writable prerequisite install directory:
pnpm dlx @codedealer/pi-sync bootstrap --repo-url https://github.com/OWNER/PRIVATE-SETUP.git --bin-dir "$HOME/.local/bin"
# or:
npx --yes @codedealer/pi-sync bootstrap --repo-url https://github.com/OWNER/PRIVATE-SETUP.git
```

Bootstrap clones into `~/.pi-sync/setup` by default (override with `--repo PATH`) and applies to `PI_CODING_AGENT_DIR` or `~/.pi/agent` (override with `--agent-dir PATH`). It first tests Git access, then uses an authenticated GitHub CLI session when available. Pi Sync never asks for, prints, or stores credentials, and it does not commit or push repository changes.

If Git access is unavailable and GitHub CLI is missing, bootstrap installs the official GitHub CLI release into `~/.local/bin` (override with `--bin-dir PATH`) when a supported platform artifact and writable destination are available, then pauses for authentication. If installation is unsupported or fails, it reports the exact missing tool and a no-sudo user action. The authentication handoff includes a `commandArgs` array for `gh auth login --hostname github.com`. When Pi Sync installed the tool locally, the array points directly to that executable. After authenticating, rerun the returned resume arguments.

Once fetched, bootstrap validates the manifest and lockfile and installs every declared `requiredTools` prerequisite before applying anything. Unsupported names are rejected, and failed required tools stop setup.

Bootstrap also keeps the first-party `pi-sync` skill and extension in sync with the executing package, declared as `{ "type": "skill", "source": "resources/skills/pi-sync", "target": "skills/pi-sync" }` and `{ "type": "extension", "source": "resources/extensions/pi-sync", "target": "extensions/pi-sync" }`. A fresh setup declares and seeds both. A rerun mirrors the executing package's contents over their exact existing declarations, including removing files the package no longer ships. The executing package's bundle is authoritative, so bootstrap run from an older package downgrades the bundled resources to that package's contents. After installing or updating the pi-sync package, rerun your usual bootstrap command to refresh them. A rerun never fetches or pulls the setup repository's remote, and an unchanged rerun is idempotent. A collision (an overlapping or non-exact declaration, or an undeclared pre-existing source path) is reported without partially refreshing the bundled set. The bootstrap result reports the executing package version and whether each bundled resource was declared, refreshed, or already current, including when the subsequent apply is blocked.

After the bundle refresh, bootstrap previews the normal manifest-driven apply and installs only through the ordinary conflict-safe apply flow. Existing local content that conflicts with apply is reported and left untouched. Bootstrap is resumable. When the destination already contains a valid setup repository, for example after a failed first run, rerunning the same command continues the setup from that repository instead of requiring an empty path. Bootstrap accepts `--approve-installs` to pre-approve first-time installation of pinned packages, so an apply blocked on approval is resumed by rerunning the same bootstrap command with `--approve-installs`. Use `bootstrap --dry-run` to preview the full run without changing the destination, local installation, or prerequisite tools. The `--repo-url` flag is required only for the initial fetch: a rerun over an existing valid setup repository infers the repository URL from the checkout's `origin` remote and reports it in the result as `repoUrl` with `repoUrlSource: 'remote'`. An explicit `--repo-url` always wins over inference (`repoUrlSource: 'flag'`), and a missing or invalid `origin` remote fails closed with `REPOSITORY_REMOTE_UNRESOLVABLE`.
Bootstrap also manages the setup repository's EOL policy: a missing `.gitattributes` is created with the fixed policy `* text=auto eol=lf`, which pins every text file to LF in the working tree regardless of `core.autocrlf`. That keeps Git's line-ending expectations aligned with the LF content the CLI writes directly (manifest, lockfile, bundled resources), so routine rewrites do not show up as phantom modifications. A file that already matches the policy is reported as `current`; a divergent file is never overwritten and is reported as `divergent` for manual review. The result reports this as `repositoryPolicy`. Existing content committed with CRLF converges to LF when its managed paths are next staged by an authorized `pi-sync push`.

## Setup repository format (schema version 1)

Place `pi-sync.json` and `pi-sync.lock.json` at the root of the setup repository. Schema version 1 supports authored Pi resources: skill directories, extensions (single files or directories), prompts, agents, roles, and workflow scripts. It also supports explicitly declared npm and GitHub Pi packages. Package pins are kept in the lockfile and ordinary apply never discovers newer releases.

```json
{
  "schemaVersion": 1,
  "resources": [
    {
      "type": "skill",
      "source": "resources/skills/example",
      "target": "skills/example"
    }
  ],
  "settings": [
    {
      "target": "settings.json",
      "fields": [
        { "path": "/theme", "value": "dark" },
        { "path": "/ui/compactMode", "value": true }
      ]
    }
  ],
  "dependencies": [
    { "type": "npm", "name": "example-package" },
    { "type": "github", "repository": "OWNER/pi-extension" }
  ],
  "policy": { "minimumReleaseAgeDays": 7 },
  "requiredTools": ["gh"]
}
```

The manifest may list `requiredTools`. It accepts only tool names from Pi Sync's supported installer catalog, not shell commands, URLs, or arbitrary installer metadata. The initial catalog supports GitHub CLI (`gh`) from official GitHub CLI release artifacts on Linux/macOS (x64/arm64) and Windows x64. Bootstrap checks each complete release archive against a code-pinned SHA-256 digest from GitHub CLI's official [`gh_2.74.2_checksums.txt`](https://github.com/cli/cli/releases/download/v2.74.2/gh_2.74.2_checksums.txt) before extraction, writing, or execution. Pi Sync does not treat HTTPS alone as artifact integrity, and it does not verify a vendor signature. Changing the version or digests requires a reviewed source change.

Bootstrap checks command availability and reports detected versions. It installs missing catalogued tools into `~/.local/bin` by default (or a user-selected `--bin-dir`), without sudo or persistent PATH or configuration changes. An unsupported platform or architecture, a missing pin, a digest mismatch, a download, execution, or write failure stops bootstrap with the exact tool, reason, and user action. No required tool is silently skipped. WSL, containers, and remote Linux environments use the Linux artifact and user-local path. On Windows, add the selected bin directory to the current user's PATH to invoke the installed CLI outside Pi Sync. The default Node-only Pi Sync runtime does not depend on these external tools.

Deterministic host-injected platform fixtures validate asset selection but do not claim native behavior. A dedicated CI workflow runs the intercepted-download install, execution, temporary user-path, and PATH-discovery smoke test on native macOS and Windows runners. Linux adapter tests run on the host test environment. They do not represent executed WSL, container, or remote environments, which remain unverified as deployment targets.

The policy is repository-owned. `minimumReleaseAgeDays` defaults to seven and may not be set below seven, and machines cannot override it. The corresponding lockfile starts empty until `pi-sync update` resolves mature releases:

```json
{
  "schemaVersion": 1,
  "packages": [
    { "type": "npm", "name": "example-package", "version": "1.2.3", "releasedAt": "2025-01-01T00:00:00.000Z" },
    { "type": "github", "repository": "OWNER/pi-extension", "commit": "0123456789abcdef0123456789abcdef01234567", "tag": "v1.2.3", "releasedAt": "2025-01-01T00:00:00.000Z" }
  ]
}
```

The npm version is an exact published version. GitHub records the resolved immutable commit SHA plus tag and timestamp review metadata. Missing or incomplete timestamps, tags, or commit SHAs fail closed. Pi Sync pins only top-level package references. Pi controls transitive dependency resolution, and Pi Sync does not provide a transitive lock or reproducibility guarantee.

Resources use per-type roots, and every source and target must stay inside its declared root:

| type | source | target | shape |
| --- | --- | --- | --- |
| `skill` | `resources/skills/NAME` | `skills/NAME` | directory |
| `extension` | `resources/extensions/NAME` | `extensions/NAME` | single file or directory |
| `prompt` | `resources/prompts/NAME.md` | `prompts/NAME.md` | single `.md` file |
| `agent` | `resources/agents/NAME.md` | `agents/NAME.md` | single `.md` file |
| `role` | `resources/roles/NAME.md` | `roles/NAME.md` | single `.md` file |
| `workflow` | `resources/workflows/NAME.js` | `workflows/NAME.js` | single `.js` file |

For non-skill types the source and target must use the same name. Symbolic links are rejected, paths use relative POSIX syntax, and no path may traverse outside its root. `node_modules` directories are never imported or managed; only authored content and portable extension configuration belong in the setup repository. Package-installed code is never imported.

The optional schema-v1 `settings` list supports explicitly selected JSON Pointer fields in `settings.json`, `models.json`, `keybindings.json`, or `mcp.json`. Each entry has a `target` and a `fields` array of `{ "path": "/nested/key", "value": ... }`. Keep paths narrow and never declare literal credentials or machine-local values. Pi Sync rejects credential-like field names in managed setting values as a defense-in-depth check, with two exceptions. A credential-like key may hold a strict `$NAME` or `${NAME}` environment reference, which Pi interpolates at request time. The reference is synced while the actual value stays configured per machine. Or the key may hold the safe literal `__PLACEHOLDER__`, which is Pi's documented way to satisfy the mandatory `apiKey` field for local endpoints that require no real key. This is not a general secret scanner. Unselected keys and values are preserved. A pre-existing selected setting that differs from its declared value is reported as a collision on first apply rather than overwritten.

Pi Sync rejects unsupported schema fields and resource types, malformed dependency declarations, and lockfile package entries that do not exactly match manifest dependencies before the local installation changes.

Apply stores its last-applied content baseline and recoverable backups under `<agent-dir>/.pi-sync/`, outside the setup repository. The baseline enables file-level three-way resource reconciliation and per-field settings reconciliation: repository-only changes are applied independently, local-only changes are preserved and reported as `local-divergence`, and overlapping changes are reported as conflicts without overwriting the conflicted item. Non-conflicting files and settings fields are reconciled in the same apply. Apply operations serialize on a local lock. If a lock's owner process has exited, apply fails closed and asks the user to remove `.pi-sync/apply.lock` only after confirming that no apply process is running. Local state and backups are not part of the setup repository.

## Commands

Every repository command accepts the same `--repo PATH` override: an explicit flag first, then `PI_SYNC_REPO_DIR` verbatim, then the built-in default `~/.pi-sync/setup`. Bootstrap uses `--repo` for its clone destination and to resume an existing checkout. There is no current-working-directory fallback; a command run from an unrelated directory operates on the environment or default repository.

```sh
pi-sync status [--repo PATH] [--agent-dir PATH] [--no-fetch]
pi-sync pull [--repo PATH]
pi-sync pull --dry-run [--repo PATH]
pi-sync apply [--repo PATH] [--agent-dir PATH] [--approve-installs]
pi-sync apply --dry-run [--repo PATH] [--agent-dir PATH]
pi-sync add --target skills/NAME [--repo PATH] [--agent-dir PATH] [--dry-run]
pi-sync add --target extensions/NAME [--repo PATH] [--agent-dir PATH]
pi-sync add --target prompts/NAME.md [--repo PATH] [--agent-dir PATH]
pi-sync add --target agents/NAME.md [--repo PATH] [--agent-dir PATH]
pi-sync add --target roles/NAME.md [--repo PATH] [--agent-dir PATH]
pi-sync add --target workflows/NAME.js [--repo PATH] [--agent-dir PATH]
pi-sync add --source npm:PACKAGE [--repo PATH] [--dry-run]
pi-sync add --source github:OWNER/REPOSITORY [--repo PATH] [--dry-run]
pi-sync add --list [--repo PATH]
pi-sync add --all [--repo PATH]
pi-sync remove --target skills/NAME [--repo PATH] [--agent-dir PATH]
pi-sync remove --target skills/NAME --keep-local [--repo PATH] [--agent-dir PATH]
pi-sync remove --target extensions/NAME [--repo PATH] [--agent-dir PATH]
pi-sync remove --target prompts/NAME.md [--repo PATH] [--agent-dir PATH]
pi-sync remove --target agents/NAME.md [--repo PATH] [--agent-dir PATH]
pi-sync remove --target roles/NAME.md [--repo PATH] [--agent-dir PATH]
pi-sync remove --target workflows/NAME.js [--repo PATH] [--agent-dir PATH]
pi-sync remove --source npm:PACKAGE [--repo PATH] [--agent-dir PATH] [--uninstall]
pi-sync remove --source github:OWNER/REPOSITORY [--repo PATH] [--agent-dir PATH] [--uninstall]
pi-sync update [--repo PATH]
pi-sync update [--repo PATH] [--agent-dir PATH] [--approve-installs]
pi-sync update --dry-run [--repo PATH] [--agent-dir PATH]
pi-sync pi-update [--repo PATH] [--agent-dir PATH]
pi-sync pi-update --dry-run [--repo PATH] [--agent-dir PATH]
pi-sync push [--message TEXT] [--repo PATH]
pi-sync push --dry-run [--message TEXT] [--repo PATH]
pi-sync sync [--repo PATH] [--agent-dir PATH]
pi-sync sync --dry-run [--repo PATH] [--agent-dir PATH]
pi-sync remove --stale [--repo PATH] [--agent-dir PATH]
pi-sync remove --stale --dry-run [--repo PATH] [--agent-dir PATH]
pi-sync bootstrap [--repo PATH] [--repo-url URL] [--agent-dir PATH] [--bin-dir PATH] [--approve-installs] [--dry-run]
pi-sync --version
```

`pull`, `update`, `sync`, `pi-update`, `push`, `apply`, `add`, and `bootstrap` perform their actions by default; `--dry-run` previews these workflows without changing repository files, local files, package installations, commit/push state, or refs. `add --dry-run` runs the same resolution read-only and reports the declaration or import a mutating `add --target` or `add --source` would perform (or the collision/validation error that stops it) without writing; it is rejected on the already read-only `add --list` and `add --all`. Pull and status previews may fetch bounded upstream metadata as part of their read workflow. `apply --dry-run` returns the ordinary status report. Bare `remove --stale` removes eligible stale resources; `remove --stale --dry-run` previews them, and `--dry-run` on any `remove` form previews the removal set without changing files. Bootstrap previews use temporary staging and do not install missing tools. `--approve-installs` is the single pre-approval flag: it pre-approves first-time installation of pinned packages only. Updating packages and publishing them are separate invocations: run `pi-sync update`, then `pi-sync push`.
The target defaults to `PI_CODING_AGENT_DIR`, then `~/.pi/agent`. Commands default to compact agent-friendly text (`ok` or `error CODE` followed by one fact per line). Use `--json` for single-line JSON with `apiVersion: 2`; its per-command response shapes retain the established structured fields. Add `--pretty` with `--json` for the legacy two-space JSON formatting; `--pretty` alone is a validation error. `--version` follows the same output tiers and does not touch a repository or agent directory. `status` reports `install`, `update`, `unchanged`, `local-divergence`, `conflict`, or `collision` actions. Apply installs absent resources, reconciles tracked changes, and leaves unlisted resources and settings untouched. Unknown pre-existing resource paths and settings collisions are never overwritten.

`add --target` brings one resource under management using the setup repository as the source of truth. Resource type is inferred from the target root. If only the repository copy exists, `add` declares it without copying or touching the local installation. If only the local copy exists, `add` validates and secret-scans it, imports it under `resources/<type-root>/`, and declares it. If both copies exist and match, it declares only and notes that the content matches; if they differ, it fails closed with a collision naming both paths. Missing copies, invalid per-type shapes, symlinks, `node_modules`, and suspected secrets are rejected without writing. An exact existing source+target declaration is an idempotent no-op when the repository and local content match; diverged copies fail closed as a collision. Add `--agent-dir` to select the local installation when resolving a target. `add --target --dry-run` previews the declaration, import, or collision it would produce without writing anything.

`add --list` is read-only discovery across every type root. It reports undeclared resources directly under those roots with inferred `type`, repository `source`, and derived `target`. `add --all` declares that same candidate set with a single manifest write. It secret-scans every candidate and checks collisions against existing declarations and within the candidate set before writing anything; a failure declares nothing, while zero candidates is a no-op. Exactly one of `--target`, `--source`, `--list`, or `--all` must be selected. `add --source npm:PACKAGE` and `github:OWNER/REPOSITORY` remain dependency declarations only; they do not edit pins or install packages, and `add --source --dry-run` previews the declaration without writing. The read-only `--list` and `--all` reject `--dry-run`. Run `update --dry-run` to preview mature exact pins, then bare `update` to apply eligible updates.

To author new content, work repository-first: create content under `resources/<type-root>/`, review `pi-sync add --list`, then declare it with `pi-sync add --target <matching-agent-relative-path>` (or `pi-sync add --all`). Reconcile with `pi-sync apply` and publish only with an explicit `pi-sync push`.

`pi-sync pi-update` is a separate host-runtime workflow. It previews the newest stable official Pi npm version that has passed the repository's minimum release age and installs it by default; `pi-update --dry-run` previews without installing. Action rechecks eligibility. It runs only when the local Pi executable and installation root verify as an official global npm or pnpm installation. It uses the exact candidate with lifecycle scripts disabled, verifies the result, and attempts to restore the previous local version if verification or installation fails. It never writes the setup manifest or lockfile, pushes, or updates declared dependencies. `pi-sync update` remains the separate dependency workflow. Unsupported installation methods stop with an actionable error.

Do not use the external `pi update --extensions` command for managed packages. It is unsupported for managed packages and may move them beyond their recorded pins. Pi Sync cannot intercept or prevent it. Use `pi-sync update --dry-run` to review the proposed pins, then bare `pi-sync update` to update managed packages under the repository's release-age policy.

`remove` is the explicit way to remove a managed resource or dependency. Resource removal infers type from the `--target` root (for example `skills/NAME` or `prompts/NAME.md`). Dependency removal uses `--source npm:PACKAGE` or `github:OWNER/REPOSITORY`. `remove --target` deletes the manifest entry, the repository content, and the local installation: the removed local content is backed up under `.pi-sync/backups/`, and a local copy that diverged from its saved last-applied baseline is preserved, reported in the result, and never overwritten or destroyed (the manifest and repository removal still proceed). `--keep-local` limits removal to the manifest entry and repository content, leaving the local copy installed and stale-reported; the stale batch `remove --stale` is the explicit local-removal flow. `remove` validates the entry and repository before changing anything, uses the atomic manifest write pattern, and `--dry-run` previews any removal without mutating. A removed dependency stays installed locally by default. Passing `--uninstall` additionally runs `pi uninstall` for the removed pin (for example `npm:PACKAGE@1.2.3`). On success it clears that package's local Pi Sync pin bookkeeping. A failed uninstall is reported with exit code `1` without rolling back or altering the repository change. Publishing a removal uses the ordinary explicit push flow, and push accepts commits that remove previously managed paths.

`sync` back-syncs local setting changes into the setup manifest. It covers fields that Pi itself rewrites, such as model scope, default model, theme, and thinking level. It uses the same three-way comparison as apply. A field is eligible only when the repository is unchanged and the local installation diverged from the last applied baseline. Pi Sync validates eligible local values for portability (credential-like keys may hold only strict `$NAME` or `${NAME}` environment references or the `__PLACEHOLDER__` placeholder), secret-scans the resulting manifest, and writes it atomically. Fields changed in both the repository and the local installation are reported as conflicts and never overwritten. Fields changed locally without a baseline (collisions) or removed locally are reported for manual review and never written. `pi-sync sync --dry-run` previews without writing. Bare `pi-sync sync` writes the manifest. Sync never commits or pushes; publishing still requires an explicit `pi-sync push`.
`pi-sync pull` brings the setup-repository checkout up with its configured upstream without touching the local installation. It resolves `--repo` like the other repository commands and does not require `--agent-dir`. Bare `pull` performs the fast-forward when safe; `pull --dry-run` is the read-only preview. Both run the bounded (15-second) metadata-only upstream fetch and report ahead/behind counts, working-tree dirt, and changed paths. The mutating run re-fetches and rechecks before changing state rather than acting on a stale preview. If the branch is purely behind its upstream, it saves the staged, unstaged, and non-ignored untracked working changes in a uniquely identifiable recovery snapshot (ignored files are never included), advances the branch to the fetched upstream tip with fast-forward-only semantics, and restores the snapshot with Git's native three-way merge. It never creates merge commits, rebases, resets, or force-updates refs. Cleanly reconcilable local changes are preserved — including the index/staging state where Git permits — and only this pull's snapshot is discarded, with the remaining dirty paths reported. When the restoration leaves conflicts — including an untracked local file at a path the upstream now tracks, which is never overwritten — the branch stays fast-forwarded, Git's unresolved conflict state is left in the working tree for manual resolution, the recovery snapshot is retained, and the result is a structured `PULL_CONFLICT` error (exit `1`) listing the affected paths and how to inspect or drop the snapshot. Pi Sync does not implement a content merge, does not run `apply` automatically, and never commits the restored changes. A diverged branch (local-only and upstream-only commits), a missing configured upstream, a detached HEAD, an in-progress merge, or a failed fetch is refused with a structured `PULL_BLOCKED` error (exit `1`) without changing files, index state, or refs. If the fast-forward itself fails, the original working state is restored from the snapshot when possible; if that restoration also fails, the snapshot is retained and its recovery identifier is reported. An up-to-date branch is a no-op even when the working tree is dirty. After a successful pull, run `pi-sync status` and `pi-sync apply` to reconcile the local installation, then publish local managed changes with an explicit `pi-sync push`.

The first-party `pi-sync` extension automates this inside Pi. Bootstrap declares it next to the skill with the manifest entry `{ "type": "extension", "source": "resources/extensions/pi-sync", "target": "extensions/pi-sync" }`. It watches the agent directory for changes to the files the manifest declares as settings targets and, after a short debounce, runs `pi-sync sync`. A persistent `pi-sync` footer and a `/pi-sync` command expose the sync state. All sync logic stays in the CLI, which also works headless. The extension is a thin trigger and relay that stays silent on setups that are not managed by Pi Sync. It honors `PI_SYNC_REPO_DIR` and `PI_SYNC_BIN` overrides and resolves the agent directory through Pi itself (`PI_CODING_AGENT_DIR` or `~/.pi/agent`). The CLI resolves an omitted `--repo` the same way: an explicit flag first, then `PI_SYNC_REPO_DIR` verbatim, then `~/.pi-sync/setup`. The CLI and the extension agree on the default repository location.

The footer renders the `summary` block of `pi-sync status` in at most one line. The CLI decides what counts as pending or review-worthy, and the extension never computes drift itself:

| Footer | Meaning |
| --- | --- |
| `pi-sync ✓` | Fully in sync: no local drift, repository clean, not behind upstream, nothing needs review. |
| `pi-sync ↑n` | n local change(s) not yet on the remote. |
| `pi-sync ↓n` | n remote change(s) not yet applied to the local installation. |
| `pi-sync !n` | n item(s) need manual review. |
| `pi-sync ✗` | The status check failed (CLI unavailable, repository error). |
| `pi-sync …` / `pi-sync ⟳` | Checking / auto-sync in flight. |

Non-zero terms combine in the order `↑ ↓ !`. Zero terms are omitted. A fully clean state shows only `✓`. The footer refreshes on real changes (session start, sync completion, agent-directory and setup-repository watcher events) and on a 60-second tick that only re-reads file metadata (no network, no CLI spawn in steady state). The session-start refresh is the only one that fetches the upstream: it runs the CLI status fresh and bypasses the shared status cache, so a cached remote summary can never suppress it, and overlapping session starts share the single in-flight check instead of duplicating the fetch. Every other refresh runs the offline CLI status (`--no-fetch`) and is cache-first. A shared status cache under the agent directory deduplicates full refreshes across concurrent Pi sessions.

Upstream freshness is owned by the CLI. `status` runs a bounded, fetch-only `git fetch` of the configured upstream (15-second timeout) before deriving ahead, behind, and remote-pending values. The fetch updates Git metadata only (the upstream tracking ref and `FETCH_HEAD`) and never pulls, merges, or applies anything, leaving the setup-repository working tree and the local installation unchanged. `--no-fetch` (accepted by `status` only) skips the fetch and reports the last-known tracking refs. A failed or timed-out fetch never presents stale tracking-ref counts as current or shows a clean remote state: the `repository` block reports `upstream: "unavailable"` with null `ahead` and `behind` while retaining the local dirt flag, and the summary omits the upstream-derived counts and reports `clean: false` — an unknown remote is not a verified-clean remote state, even when every summary count is zero. The extension's session-start refresh runs a fresh CLI status that bypasses the shared cache, and its other refreshes (watchers, sync completion, the 60-second tick) run the CLI status with `--no-fetch`, so only an explicit `status` or a new Pi session touches the network. Applying remote changes stays a manual step: `pi-sync pull`, then `pi-sync apply`.

At Pi process startup on a managed setup, the extension shows a one-line orientation notification. It is user-facing only and never enters the transcript or the LLM context. It names the two main flows: update dependencies with `pi-sync update`, and manage resources by editing the setup repository and running `pi-sync apply`. The bundled `pi-sync` skill documents the full workflow. The notification appears once per process start, not on session resume, fork, or new-session starts, and never on setups that are not managed by Pi Sync.
The extension also enforces the "never edit the installed copy" rule at decision time. On a managed setup it intercepts file-mutating tool calls — by input shape (top-level path-like fields), not tool name — whose target falls under the agent directory's resource roots (`skills/`, `extensions/`, `prompts/`, `agents/`, `roles/`). Manifest-declared settings targets are not gated: the extension's settings watcher back-syncs local edits of managed settings into the setup repository's manifest, so those edits are captured instead of drifting. The first such call in a Pi session is blocked, and the block's reason is delivered to the agent as the tool result: it names the target, gives the qualified source path in the setup repository (the repository's location plus the matching `resources/<type-root>/...` file) with `pi-sync apply` (and the concrete `pi-sync add --target <matching-agent-relative-path>` command for a new resource) as the main path, and ends with the explicit bypass — retry the same operation for an intentional local-only change, since subsequent attempts in the session are allowed. Arming is global per session and resets on each session start; read-only tool calls, `bash`, and everything outside the gated roots (including the setup repository itself) always pass. The block requires no user interaction, so it works in TUI, RPC, and headless modes alike. `PI_SYNC_GUARD=off` disables the gate, and the extension stays silent on setups that are not managed by Pi Sync. The bundled `pi-sync` skill documents the guard from the agent's side.

When the footer shows `✗`, the status check itself failed (CLI unavailable, timeout, or repository error). Run `/pi-sync` (or `pi-sync status` in a terminal) to see the structured error. A failed check does not clear the last computed summary. The footer returns to it once the next check succeeds. An unavailable upstream (a failed or timed-out fetch) is not a check failure: the summary renders from the remaining local information and the `repository` block marks it `upstream: "unavailable"`.

Multiple Pi sessions can share one agent directory. Each session runs its own watcher and debounce with per-process state. Every `sync` serializes on the same agent lock as `apply` (exclusive lockfile, up to 2.5 s wait). The shared status cache deduplicates the footer's full refreshes across sessions. After a real change, the first session to refresh recomputes and publishes, and the others read the cache. A concurrent sync that loses the race re-reads the fresh manifest and baseline and becomes a no-op instead of double-writing. If the lock is still held after the wait, it fails with a readable error and retries on the next change. Bare `sync` never writes the settings files themselves (only the manifest and baseline state), so it cannot overwrite a setting Pi is persisting. Settings reads retry once to cover the brief window of Pi's in-place settings write. Both-sides changes remain conflicts for manual review.

## Agent API and first-party skill

Every command has three output tiers: compact agent-friendly text by default (`ok` or `error CODE` followed by one fact per line) as a convenience for the primary LLM consumer, which is not a versioned contract; `--json` for single-line JSON with `apiVersion: 2` and an `ok` boolean, the stable machine contract; and `--json --pretty` for the legacy two-space JSON formatting (`--pretty` alone is a validation error). Conflict responses include structured `conflicts`, `actions`, and/or `staleResources`. Errors retain a readable `error` string and include `errorCode`, `details`, and `exitCode`. Exit `0` means the operation completed. Exit `1` means an operational conflict, required first-install approval, package-manager failure, untrustworthy update metadata, a failed explicit `remove --uninstall`, or unsafe stale-resource operation. Exit `2` means invalid input or repository/manifest validation failed. Apply leaves conflicted items untouched and returns `1`. Inspect the JSON and re-run `status` rather than guessing or overwriting. In `status` and `apply`, `actions` omits unchanged resources and settings targets. Setting actions include only non-unchanged fields, and resource `files` arrays include only non-unchanged files. Conflicts and stale resources remain explicit. Apply reports each package's install result in the single `packages` array; there is no separate `packageInstalls`.

The agent workflow is documented in the first-party skill at `resources/skills/pi-sync/SKILL.md`, and both the skill and the settings-sync extension are included in the published CLI package and declared by bootstrap. The CLI apply installs declared Pi packages from exact lockfile pins and reconciles setup-repository-owned managed resources. It does not install undeclared bundled content. Bootstrap refreshes only the first-party bundled `pi-sync` skill and extension from the executing package.

Push previews the complete managed patch with `pi-sync push --dry-run`; bare `pi-sync push` commits only explicitly managed paths and fast-forwards the configured upstream. It excludes unrelated staged/unstaged files, ignored files, and undeclared resources. A bare `push` reports a short confirmation — the published commit, branch/upstream, and the changed managed paths — with no diff text and no digest, and the CLI writes nothing to stderr in normal operation; the full managed diff appears only in `push --dry-run` output on stdout. Pi Sync skips git hooks for its commit so hooks cannot add paths outside the managed allowlist. Ahead commits are validated against the setup manifest as of that commit, the manifest before the commit, and the current managed set. Commits that add, edit, or remove managed paths are publishable. Push stops on unrelated commits ahead of upstream or any remote advancement/divergence, and never force-pushes. A rejected push leaves the managed commit local. `push --message TEXT` sets the subject for a new managed-only commit and never rewrites existing commits. Updating packages and publishing them are separate invocations: review `update --dry-run`, run bare `update`, then review `push --dry-run` and run bare `push` when authorized.

`status` and `apply` report resources previously applied by Pi Sync but removed from the manifest as `stale`. Ordinary apply never removes them. Use `pi-sync remove --target` to remove a resource: it deletes the manifest entry, the repository content, and the local installation, backing up the removed local content under `.pi-sync/backups/`. A local copy that diverged from its saved last-applied baseline is preserved, reported, and never overwritten or destroyed; the manifest and repository removal still proceeds. `--keep-local` limits removal to the manifest and repository content, leaving the copy installed and stale-reported. Bare `remove --stale` removes only stale resources that still exactly match their saved last-applied baseline, backs them up, and does not touch unrelated local resources; `remove --stale --dry-run` previews without changing files. Modified or overlapping stale resources are retained and reported.