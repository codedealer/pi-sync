# pi-sync

A small Node.js CLI for applying explicitly declared Pi user-level resources from a setup repository. This repository contains the public CLI only; personal setup files belong in a separate private setup repository.

## Requirements

- Node.js 22 or newer

## Public installation and private-repository bootstrap

The npm package publishes the CLI and its first-party `pi-sync` skill and extension. Its `files` allowlist excludes setup repositories, credentials, scratch planning files, and test fixtures. The package runs no install hooks, so installation works identically under npm and pnpm without script approval; after installing or updating the package, rerun your usual bootstrap command to refresh the bundled resources in your setup repository.

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

Bootstrap clones into `~/.pi-sync/setup` by default (override with `--repo-dir PATH`) and applies to `PI_CODING_AGENT_DIR` or `~/.pi/agent` (override with `--agent-dir PATH`). It first tests Git access, then uses an authenticated GitHub CLI session when available. Pi Sync never asks for, prints, or stores credentials, and it does not commit or push repository changes.

If Git access is unavailable and GitHub CLI is missing, bootstrap installs the official GitHub CLI release into `~/.local/bin` (override with `--bin-dir PATH`) when a supported platform artifact and writable destination are available, then pauses for authentication. If installation is unsupported or fails, it reports the exact missing tool and a no-sudo user action. The authentication handoff includes a `commandArgs` array for `gh auth login --hostname github.com`. When Pi Sync installed the tool locally, the array points directly to that executable. After authenticating, rerun the returned resume arguments.

Once fetched, bootstrap validates the manifest and lockfile and installs every declared `requiredTools` prerequisite before applying anything. Unsupported names are rejected, and failed required tools stop setup.

Bootstrap also keeps the first-party `pi-sync` skill and extension in sync with the executing package, declared as `{ "type": "skill", "source": "resources/skills/pi-sync", "target": "skills/pi-sync" }` and `{ "type": "extension", "source": "resources/extensions/pi-sync", "target": "extensions/pi-sync" }`. A fresh setup declares and seeds both. A rerun mirrors the executing package's contents over their exact existing declarations, including removing files the package no longer ships. The executing package's bundle is authoritative, so bootstrap run from an older package downgrades the bundled resources to that package's contents. After installing or updating the pi-sync package, rerun your usual bootstrap command to refresh them. A rerun never fetches or pulls the setup repository's remote, and an unchanged rerun is idempotent. A collision (an overlapping or non-exact declaration, or an undeclared pre-existing source path) is reported without partially refreshing the bundled set. The bootstrap result reports the executing package version and whether each bundled resource was declared, refreshed, or already current, including when the subsequent plan or apply is blocked.

After the bundle refresh, bootstrap previews the normal manifest-driven apply and installs only through the ordinary conflict-safe apply flow. Existing local content that conflicts with apply is reported and left untouched. Bootstrap is resumable. When the destination already contains a valid setup repository, for example after a failed first run, rerunning the same command continues the setup from that repository instead of requiring an empty path. Bootstrap accepts `--approve` to pre-approve first-time installation of pinned packages, so an apply blocked on approval is resumed by rerunning the same bootstrap command with `--approve`.

## Setup repository format (schema version 1)

Place `pi-sync.json` and `pi-sync.lock.json` at the root of the setup repository. Schema version 1 supports authored Pi resources: skill directories, extensions (single files or directories), prompts, agents, and roles. It also supports explicitly declared npm and GitHub Pi packages. Package pins are kept in the lockfile and ordinary apply never discovers newer releases.

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

For non-skill types the source and target must use the same name. Symbolic links are rejected, paths use relative POSIX syntax, and no path may traverse outside its root. `node_modules` directories are never imported or managed; only authored content and portable extension configuration belong in the setup repository. Package-installed code is never imported.

The optional schema-v1 `settings` list supports explicitly selected JSON Pointer fields in `settings.json`, `models.json`, `keybindings.json`, or `mcp.json`. Each entry has a `target` and a `fields` array of `{ "path": "/nested/key", "value": ... }`. Keep paths narrow and never declare literal credentials or machine-local values. Pi Sync rejects credential-like field names in managed setting values as a defense-in-depth check, with two exceptions. A credential-like key may hold a strict `$NAME` or `${NAME}` environment reference, which Pi interpolates at request time. The reference is synced while the actual value stays configured per machine. Or the key may hold the safe literal `__PLACEHOLDER__`, which is Pi's documented way to satisfy the mandatory `apiKey` field for local endpoints that require no real key. This is not a general secret scanner. Unselected keys and values are preserved. A pre-existing selected setting that differs from its declared value is reported as a collision on first apply rather than overwritten.

Pi Sync rejects unsupported schema fields and resource types, malformed dependency declarations, and lockfile package entries that do not exactly match manifest dependencies before the local installation changes.

Apply stores its last-applied content baseline and recoverable backups under `<agent-dir>/.pi-sync/`, outside the setup repository. The baseline enables file-level three-way resource reconciliation and per-field settings reconciliation: repository-only changes are applied independently, local-only changes are preserved and reported as `local-divergence`, and overlapping changes are reported as conflicts without overwriting the conflicted item. Non-conflicting files and settings fields are reconciled in the same apply. Apply operations serialize on a local lock. If a lock's owner process has exited, apply fails closed and asks the user to remove `.pi-sync/apply.lock` only after confirming that no apply process is running. Local state and backups are not part of the setup repository.

## Commands

Every repository command resolves the setup repository the same way as the pi-sync extension: an explicit `--repo PATH` flag first, then the `PI_SYNC_REPO_DIR` environment variable (used verbatim, with no `~` expansion), then the built-in default `~/.pi-sync/setup`. There is no current-working-directory fallback; a command run from an unrelated directory operates on the environment or default repository. Pass `--repo PATH` to select the repository explicitly:

```sh
pi-sync status [--repo PATH] [--agent-dir PATH]
pi-sync plan [--repo PATH] [--agent-dir PATH]
pi-sync apply [--repo PATH] [--agent-dir PATH] [--approve]
pi-sync add --type skill --source skills/NAME [--repo PATH] [--agent-dir PATH]
pi-sync add --type extension --source extensions/NAME [--repo PATH] [--agent-dir PATH]
pi-sync add --type prompt --source prompts/NAME.md [--repo PATH] [--agent-dir PATH]
pi-sync add --type agent --source agents/NAME.md [--repo PATH] [--agent-dir PATH]
pi-sync add --type role --source roles/NAME.md [--repo PATH] [--agent-dir PATH]
pi-sync add --type dependency --source npm:PACKAGE [--repo PATH]
pi-sync add --type dependency --source github:OWNER/REPOSITORY [--repo PATH]
pi-sync register --type skill --source resources/skills/NAME [--repo PATH]
pi-sync register --type extension --source resources/extensions/NAME [--repo PATH]
pi-sync register --type prompt --source resources/prompts/NAME.md [--repo PATH]
pi-sync register --type agent --source resources/agents/NAME.md [--repo PATH]
pi-sync register --type role --source resources/roles/NAME.md [--repo PATH]
pi-sync register --list [--type T] [--repo PATH]
pi-sync register --all [--type T] [--repo PATH]
pi-sync remove --type skill --target skills/NAME [--repo PATH] [--agent-dir PATH]
pi-sync remove --type extension --target extensions/NAME [--repo PATH] [--agent-dir PATH]
pi-sync remove --type prompt --target prompts/NAME.md [--repo PATH] [--agent-dir PATH]
pi-sync remove --type agent --target agents/NAME.md [--repo PATH] [--agent-dir PATH]
pi-sync remove --type role --target roles/NAME.md [--repo PATH] [--agent-dir PATH]
pi-sync remove --type dependency --source npm:PACKAGE [--repo PATH] [--agent-dir PATH] [--uninstall]
pi-sync remove --type dependency --source github:OWNER/REPOSITORY [--repo PATH] [--agent-dir PATH] [--uninstall]
pi-sync update [--repo PATH]
pi-sync update --apply [--repo PATH] [--agent-dir PATH] [--approve]
pi-sync update --apply --push [--repo PATH] [--agent-dir PATH] [--approve]
pi-sync pi-update [--repo PATH] [--agent-dir PATH]
pi-sync pi-update --apply [--repo PATH] [--agent-dir PATH]
pi-sync push [--repo PATH]
pi-sync push --publish [--repo PATH]
pi-sync sync [--repo PATH] [--agent-dir PATH]
pi-sync sync --apply [--repo PATH] [--agent-dir PATH]
pi-sync prune [--repo PATH] [--agent-dir PATH]
pi-sync prune --confirm [--repo PATH] [--agent-dir PATH]
pi-sync --version
```

The target defaults to `PI_CODING_AGENT_DIR`, then `~/.pi/agent`. Each command emits JSON. `--version` reports the installed CLI package name and version in the same JSON envelope and does not touch a repository or agent directory. `status` and `plan` report `install`, `update`, `unchanged`, `local-divergence`, `conflict`, or `collision` actions. Apply installs absent resources, reconciles tracked changes, and leaves unlisted resources and settings untouched. Unknown pre-existing resource paths and settings collisions are never overwritten.

`add` imports one resource of each type from the local Pi agent directory: a skill directory from `skills/NAME`, an extension file or directory from `extensions/NAME`, or a single `.md` file from `prompts/NAME.md`, `agents/NAME.md`, or `roles/NAME.md`. It copies only the selected file or directory to the matching `resources/<type-root>/` path and appends the corresponding manifest resource. `add --type dependency` declares only the selected npm package or GitHub repository; it does not edit pins or install packages. Run `update` to preview mature exact pins, then `update --apply` to apply the eligible updates. Use `pi-sync update` for managed package updates; ordinary `apply` uses lockfile pins without registry or GitHub update lookups. First-time installs require interactive confirmation or explicit `--approve` for non-interactive use. Known credential-store paths and likely secret material stop resource import and are reported for review. The scanner is best-effort and does not guarantee arbitrary content is secret-free.

`register` declares a resource that already exists under the setup repository's `resources/` tree as a managed resource, without hand-editing the manifest. The content must already be present with the per-type shape: a skill directory, an extension file or directory, or a single `.md` prompt, agent, or role file directly under its root. `--source` is a repository-relative path under `resources/`, unlike `add`, whose `--source` is a local-installation path. The agent-relative target is derived from the source: `resources/prompts/NAME.md` registers as `prompts/NAME.md`, and so on for the other types. `register` writes only the manifest entry. It performs no import or copy, never touches the local installation, and never commits or pushes. The subsequent `apply` copies the resource into the local installation, and an authorized `push` publishes it, exactly as for a resource added through `add`. `register` does not require or use `--agent-dir`. Re-registering an existing exact source+target declaration is an idempotent no-op (`action: already-registered`, manifest unchanged, exit `0`). Any other overlap is a `RESOURCE_COLLISION` (exit `2`) that writes nothing: the target declared under a different source, the source declared under a different target, or a nested overlap. A missing source, a source outside the type's root, an unsupported type, or a mode combination is a validation error (exit `2`). Suspected secret material in the repository content produces `SECRET_REVIEW_REQUIRED` (`ok: false`, exit `2`) and registers nothing.

`register --list` is read-only discovery. It reports every resource present directly under a type root that the manifest does not declare, with its inferred `type`, `source`, and derived `target`. It changes nothing. `register --all` registers the same candidate set in a single atomic manifest write. It is all-or-nothing: it secret-scans every candidate and collision-checks against the existing declarations and the candidate set itself, and any failure registers nothing. With zero candidates it is a no-op (`action: up-to-date`, manifest unchanged). `--type` is required for single registration and optional for `--list` and `--all`, where it narrows the roots scanned. Exactly one of the three modes may be selected: a single `--source`, `--list`, or `--all`. Combining `--source` with `--list` or `--all`, or `--list` with `--all`, is a validation error (exit `2`).

To author new content, work repository-first. Create the content under `resources/<type-root>/` in the setup repository. Review `pi-sync register --list`. Declare with `pi-sync register --type T --source resources/...` (or `pi-sync register --all` for the whole set). Reconcile with `pi-sync apply`. Publish only with an explicit `pi-sync push`.

`pi-sync pi-update` is a separate host-runtime workflow. It previews the newest stable official Pi npm version that has passed the repository's minimum release age and installs it only with `--apply`. Apply rechecks eligibility. It runs only when the local Pi executable and installation root verify as an official global npm or pnpm installation. It uses the exact candidate with lifecycle scripts disabled, verifies the result, and attempts to restore the previous local version if verification or installation fails. It never writes the setup manifest or lockfile, pushes, or updates declared dependencies. `pi-sync update` remains the separate dependency workflow. Unsupported installation methods stop with an actionable error.

Do not use the external `pi update --extensions` command for managed packages. It is unsupported for managed packages and may move them beyond their recorded pins. Pi Sync cannot intercept or prevent it. Use `pi-sync update` (and `--apply` after reviewing the plan) to update managed packages under the repository's release-age policy.

`remove` is the explicit way to remove a managed resource or dependency from the repository. Resource removal takes the resource `--type` and the manifest `--target` (for example `skills/NAME` or `prompts/NAME.md`). Dependency removal takes `--type dependency` and `--source npm:PACKAGE` or `github:OWNER/REPOSITORY`. Removal is non-destructive. It validates the entry and repository, then deletes only the manifest entry and repository content (or the manifest dependency and its exact lockfile pin). It never modifies the local Pi installation and never queues or schedules anything for deletion. A removed resource stays installed indefinitely. `status`, `plan`, and `apply` report it as `stale` until it is explicitly pruned or re-declared in the manifest, and local removal still happens only through the explicit `pi-sync prune --confirm` flow. A removed dependency stays installed locally by default. Passing `--uninstall` additionally runs `pi uninstall` for the removed pin (for example `npm:PACKAGE@1.2.3`). On success it clears that package's local Pi Sync pin bookkeeping. A failed uninstall is reported with exit code `1` without rolling back or altering the repository change. Publishing a removal uses the ordinary explicit push flow, and push accepts commits that remove previously managed paths.

`sync` back-syncs local setting changes into the setup manifest. It covers fields that Pi itself rewrites, such as model scope, default model, theme, and thinking level. It uses the same three-way comparison as `plan`. A field is eligible only when the repository is unchanged and the local installation diverged from the last applied baseline. Pi Sync validates eligible local values for portability (credential-like keys may hold only strict `$NAME` or `${NAME}` environment references or the `__PLACEHOLDER__` placeholder), secret-scans the resulting manifest, and writes it atomically. Fields changed in both the repository and the local installation are reported as conflicts and never overwritten. Fields changed locally without a baseline (collisions) or removed locally are reported for manual review and never written. `pi-sync sync` previews without writing. `pi-sync sync --apply` writes the manifest. Sync never commits or pushes; publishing still requires an explicit `pi-sync push`.

The first-party `pi-sync` extension automates this inside Pi. Bootstrap declares it next to the skill with the manifest entry `{ "type": "extension", "source": "resources/extensions/pi-sync", "target": "extensions/pi-sync" }`. It watches the agent directory for changes to the files the manifest declares as settings targets and, after a short debounce, runs `pi-sync sync --apply`. A persistent `pi-sync` footer and a `/pi-sync` command expose the sync state. All sync logic stays in the CLI, which also works headless. The extension is a thin trigger and relay that stays silent on setups that are not managed by Pi Sync. It honors `PI_SYNC_REPO_DIR` and `PI_SYNC_BIN` overrides and resolves the agent directory through Pi itself (`PI_CODING_AGENT_DIR` or `~/.pi/agent`). The CLI resolves an omitted `--repo` the same way: an explicit flag first, then `PI_SYNC_REPO_DIR` verbatim, then `~/.pi-sync/setup`. The CLI and the extension agree on the default repository location.

The footer renders the `summary` block of `pi-sync status` in at most one line. The CLI decides what counts as pending or review-worthy, and the extension never computes drift itself:

| Footer | Meaning |
| --- | --- |
| `pi-sync ✓` | Fully in sync: no local drift, repository clean, not behind upstream, nothing needs review. |
| `pi-sync ↑n` | n local change(s) not yet on the remote. |
| `pi-sync ↓n` | n remote change(s) not yet applied to the local installation. |
| `pi-sync !n` | n item(s) need manual review. |
| `pi-sync ✗` | The status check failed (CLI unavailable, repository error). |
| `pi-sync …` / `pi-sync ⟳` | Checking / auto-sync in flight. |

Non-zero terms combine in the order `↑ ↓ !`. Zero terms are omitted. A fully clean state shows only `✓`. The footer refreshes on real changes (session start, sync completion, agent-directory and setup-repository watcher events) and on a 60-second tick that only re-reads file metadata (no network, no CLI spawn in steady state). A shared status cache under the agent directory deduplicates full refreshes across concurrent Pi sessions.

At session start the extension also makes remote commits visible without manual action. It runs an async, fetch-only `git fetch` against the upstream that never pulls, merges, or applies anything. The fetch is freshness-gated (skipped when the repository's `FETCH_HEAD` is younger than five minutes) and bounded by a 15-second timeout. Network access happens at most once per session, and the periodic tick never touches the network. A fetch failure is silent. Network or authentication trouble is not a sync-state failure, and the footer keeps its last known state. Applying remote changes stays a manual step: pull, then `pi-sync apply`.

At Pi process startup on a managed setup, the extension shows a one-line orientation notification. It is user-facing only and never enters the transcript or the LLM context. It names the two main flows: update dependencies with `pi-sync update`, and manage resources by editing the setup repository and running `pi-sync apply`. The bundled `pi-sync` skill documents the full workflow. The notification appears once per process start, not on session resume, fork, or new-session starts, and never on setups that are not managed by Pi Sync.

When the footer shows `✗`, the status check itself failed (CLI unavailable, timeout, or repository error). Run `/pi-sync` (or `pi-sync status` in a terminal) to see the structured error. A failed check does not clear the last computed summary. The footer returns to it once the next check succeeds.

Multiple Pi sessions can share one agent directory. Each session runs its own watcher and debounce with per-process state. Every `sync --apply` serializes on the same agent lock as `apply` (exclusive lockfile, up to 2.5 s wait). The shared status cache deduplicates the footer's full refreshes across sessions. After a real change, the first session to refresh recomputes and publishes, and the others read the cache. A concurrent sync that loses the race re-reads the fresh manifest and baseline and becomes a no-op instead of double-writing. If the lock is still held after the wait, it fails with a readable error and retries on the next change. `sync --apply` never writes the settings files themselves (only the manifest and baseline state), so it cannot overwrite a setting Pi is persisting. Settings reads retry once to cover the brief window of Pi's in-place settings write. Both-sides changes remain conflicts for manual review.

## Agent API and first-party skill

Every command emits JSON with `apiVersion: 1` and an `ok` boolean. Conflict responses include structured `conflicts`, `actions`, and/or `staleResources`. Errors retain a readable `error` string and include `errorCode`, `details`, and `exitCode`. Exit `0` means the operation completed. Exit `1` means an operational conflict, required first-install approval, package-manager failure, untrustworthy update metadata, a failed explicit `remove --uninstall`, or unsafe stale-resource operation. Exit `2` means invalid input or repository/manifest validation failed. Apply leaves conflicted items untouched and returns `1`. Inspect the JSON and re-plan rather than guessing or overwriting. In `status`, `plan`, and `apply`, `actions` omits unchanged resources and settings targets. Setting actions include only non-unchanged fields, and resource `files` arrays include only non-unchanged files. Conflicts and stale resources remain explicit. Apply reports each package's install result in the single `packages` array; there is no separate `packageInstalls`.

The agent workflow is documented in the first-party skill at `resources/skills/pi-sync/SKILL.md`, and both the skill and the settings-sync extension are included in the published CLI package and declared by bootstrap. The CLI apply installs declared Pi packages from exact lockfile pins and reconciles setup-repository-owned managed resources. It does not install undeclared bundled content. Bootstrap refreshes only the first-party bundled `pi-sync` skill and extension from the executing package.

Push is opt-in. `pi-sync push` previews the full patch for `pi-sync.json` (including policy), `pi-sync.lock.json`, and only resources explicitly registered by the manifest. It excludes unrelated staged/unstaged files, ignored files, and unregistered resources. Review the preview before `pi-sync push --publish`. The full diff is read from the preview step, because the publish result no longer embeds the patch text. The publishing flow re-displays the same commit preview on stderr before creating an ordinary commit and fast-forward push. Its stdout JSON confirms the publication with a compact digest of the exact rendered preview (SHA-256 hex plus byte length) alongside the published `changes` and `commit`. Pi Sync skips git hooks for its commit so hooks cannot add paths outside the managed allowlist. Ahead commits are validated against the setup manifest as of that commit, the manifest before the commit, and the current managed set. Commits that add, edit, or remove managed paths, including a committed removal of a resource, are publishable. Push stops on genuinely unrelated commits ahead of upstream or any remote advancement or divergence, and it never force-pushes. A rejected push leaves the managed commit local. `update --apply --push` is explicit authorization to publish after the approved package update and follows the same managed-only checks.

`status`, `plan`, and `apply` report resources previously applied by Pi Sync but removed from the manifest as `stale`. Ordinary apply never removes them. Use `pi-sync remove` to remove a resource from the manifest. It keeps the resource installed until an explicit `pi-sync prune --confirm`. `prune` previews eligible stale resources without changing files. `prune --confirm` removes only stale resources that still exactly match their saved last-applied baseline, backs up the removed resources under `.pi-sync/backups/`, and does not touch unrelated local resources. Modified stale resources are retained and reported.