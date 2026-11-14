---
name: pi-sync
description: Use before adding, editing, or removing any skill, prompt, agent, role, extension, or settings file under the active agent directory (default ~/.pi/agent, or wherever PI_CODING_AGENT_DIR points); also for operating the explicitly managed Pi setup with the pi-sync CLI.
---

# Pi Sync agent workflow

Use `pi-sync` as the only interface for inspecting and changing resources managed by Pi Sync. Do not edit `pi-sync.json` or `pi-sync.lock.json` directly, copy managed resources into place behind Pi Sync, or install a managed dependency through another tool. Pi Sync supports authored Pi resources (skill directories, extension files or directories, and single `.md` prompt, agent, and role files), selected settings fields, and exact top-level npm/GitHub package pins. Push is opt-in and separate from apply/update unless the user explicitly authorizes it.

## Concepts and boundaries

- The **setup repository** is the user's private repository and source of truth for explicitly managed resources. The public `pi-sync` CLI package does not contain a user's setup.
- The **local Pi installation** defaults to `~/.pi/agent`; `PI_CODING_AGENT_DIR` or `--agent-dir PATH` selects another directory.
- Only entries declared in the manifest are managed. Unlisted resources, credentials, sessions, caches, and other local-only state must remain local.
- The CLI's `.pi-sync/state.json` and backups are local bookkeeping under the agent directory, not repository content.
- Never add or copy auth files, API keys, OAuth tokens, sessions, caches, or other credentials into the setup repository. Secret detection is best effort, not a guarantee. A private repository is not a secret store.

## Inspect before changing

Use the explicit repository path where possible:

```sh
pi-sync status --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
pi-sync plan --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
```

Omit `--agent-dir` to use `PI_CODING_AGENT_DIR`, then the default `~/.pi/agent`. `status` and `plan` are read-only. Review `actions`, `conflicts`, and `staleResources` in the JSON before taking an action. A stale resource remains installed; ordinary apply does not prune it.

## Adding or editing user-level resources

When asked to add or edit a user-level (not project-scoped) resource, first determine whether the target is managed, before changing anything. The setup manifest (`pi-sync.json` at the setup repository root) is authoritative: its `resources` entries declare managed resources and its `settings` entries declare managed settings targets and fields. `pi-sync status --repo ... --agent-dir ...` exposes the same set: managed targets appear in `actions` (a locally edited managed resource shows `action: "local-divergence"`) and removed-but-installed targets appear in `staleResources`.

- **Managed resource:** never edit the installed copy in the agent directory — it is the output of `apply`, not an input. Edit the source in the setup repository (the manifest-declared `resources/<type-root>/` path) and run `pi-sync apply` to reconcile the local installation. Publish only with an explicit push authorization (see Push only when explicitly authorized). An in-place edit of an installed managed copy is local-only divergence: `status` reports it as a review item (the extension's footer shows `!n`) and keeps counting it until resolved. The clean recovery is to port the content into the setup repository and apply again — once local and repository content match, the resource re-baselines as unchanged.
- **Unmanaged existing file:** edit it directly. Pi Sync never touches unlisted resources or undeclared settings fields.
- **New resource:** manage by default. Create the resource, then bring it under management with `pi-sync add` (see Add only a specifically selected local resource) rather than leaving it unmanaged, and apply it through Pi Sync.
- **Settings:** managed per field, per the manifest's `settings` declarations. Local changes to managed fields belong to the back-sync flow (see Back-sync local setting changes when requested); undeclared fields remain local and can be edited directly.

## Apply when requested

Run apply only when the user asks to reconcile the setup repository into the local installation:

```sh
pi-sync apply --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
```

Apply follows the reviewed repository state, preserves unlisted content and local-only divergence, and never overwrites a reported collision or conflicted item. A non-zero result requires stopping to explain the structured conflict or error; do not resolve conflicts by guessing, overwriting, or editing managed files around the CLI. Review a new plan after the user resolves the issue.

## Back-sync local setting changes when requested

Pi rewrites `settings.json` (and other managed settings targets) when the user changes the model, model scope, theme, thinking level, or any other setting in the TUI. Those local-only changes drift away from the setup manifest until someone edits it by hand. The first-party `pi-sync` extension (installed next to this skill) watches the managed files and runs `pi-sync sync --apply` automatically after a short debounce; a `pi-sync` status-line entry and the `/pi-sync` command expose the result. When the extension is absent (or the user asks to persist a setting change), run the CLI directly:

```sh
pi-sync sync --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
pi-sync sync --apply --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
```

`sync` promotes local-only managed setting fields into the manifest using the same three-way comparison as `plan` (repository unchanged, local diverged from the last applied baseline). Eligible values are portability-validated, the rewritten manifest is secret-scanned, and the write is atomic. Fields changed in both places are conflicts and are never overwritten; baseline-less collisions and locally removed fields are reported for manual review and never written. `sync` previews by default and writes only with `--apply`. It modifies only the setup manifest; it never touches the local installation and never commits or pushes. A non-zero result means some fields were not synced: explain the structured `conflicts`, `rejected`, or `review` entries, and publish the synced change only through an explicit `pi-sync push`.

## Add only a specifically selected local resource

When the user explicitly asks to add a named local resource, review its contents for private data and use the CLI with the matching type:

```sh
pi-sync add --type skill --source skills/NAME --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
pi-sync add --type extension --source extensions/NAME --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
pi-sync add --type prompt --source prompts/NAME.md --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
pi-sync add --type agent --source agents/NAME.md --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
pi-sync add --type role --source roles/NAME.md --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
```

`add` imports only the selected file or directory to the matching `resources/<type-root>/` path (skills are directories, extensions may be a single file or directory, and prompts/agents/roles must be single `.md` files directly under their root) and registers it in the manifest. It does not import unrelated files, and `node_modules` or package-installed code is never imported. Review any `reviewRequired` findings and remove suspected secret content before retrying; never bypass the check. A collision, invalid path, or malformed repository stops the operation. Do not install an added resource separately; apply it through Pi Sync when requested.

The first-party skill is shipped at `resources/skills/pi-sync/SKILL.md`. Fresh-machine setup uses the CLI bootstrap command, which safely declares it in the fetched setup repository as:

```json
{ "type": "skill", "source": "resources/skills/pi-sync", "target": "skills/pi-sync" }
```

Bootstrap previews the manifest-driven apply before applying; it does not install this skill through a separate copy path or overwrite a collision. To start or resume setup, run `pi-sync bootstrap --repo-url https://github.com/OWNER/PRIVATE-SETUP.git` (optionally `--repo-dir PATH`, `--agent-dir PATH`, and `--bin-dir PATH`). The setup manifest may list tools in `requiredTools`, but only catalogued names are accepted; never add shell commands or arbitrary installer metadata. Bootstrap checks versions, installs supported missing tools into a user-writable directory without sudo, and stops with an actionable structured handoff if a required tool cannot be installed. Before extracting or executing GitHub CLI, it verifies the complete official release archive against the reviewed, code-pinned SHA-256 digest; a mismatch fails closed. When GitHub CLI is needed for private-repository access, bootstrap installs the official release if supported, then pauses for authentication. Follow the JSON handoff and use its `commandArgs` for `gh auth login --hostname github.com` (the executable may be in the local install directory), then rerun the returned command arguments. Bootstrap never prints or stores credentials and never commits or pushes the private setup repository.

## Add and update managed packages only when asked

Add only a specifically requested dependency using a package identity, not a mutable version or branch:

```sh
pi-sync add --type dependency --source npm:PACKAGE --repo /path/to/private-setup
pi-sync add --type dependency --source github:OWNER/REPOSITORY --repo /path/to/private-setup
```

Then inspect the release-age-gated update plan and exact proposed lock entries:

```sh
pi-sync update --repo /path/to/private-setup
```

The setup repository's `pi-sync.json` owns `policy.minimumReleaseAgeDays` (at least seven days; defaults to seven). Machine arguments and local settings cannot lower it. npm pins are exact published versions; GitHub pins are immutable commit SHAs with release tag and timestamp retained for review. Missing or untrustworthy release timestamps/SHAs stop update discovery closed. Preview does not modify pins or install packages. Only apply an explicitly approved update:

```sh
pi-sync update --apply --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
```

Ordinary `apply` never queries newer registry/GitHub releases. It installs only lockfile pins; an initial third-party install requires an interactive confirmation or explicit `--approve` for non-interactive operation. For example:

```sh
pi-sync apply --approve --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
```

Pi Sync coordinates exact top-level pins through Pi's package manager. Pi currently owns transitive dependency resolution; Pi Sync does not provide or claim a reproducible transitive tree. Managed package updates must be performed through `pi-sync update --apply` under the repository's age policy. Do not run `pi update --extensions` when it could update managed packages: that command is unsupported for managed packages, may move them beyond their recorded exact pins, and Pi Sync cannot intercept or prevent it. When a user requests or discusses updating managed packages, explain/remind them to use Pi Sync instead. Do not claim that external Pi updates preserve pins or are constrained by Pi Sync, or claim/assume transitive dependencies are locked.

## Remove only an explicitly requested resource or dependency

Removal is the inverse of add. Only when the user explicitly asks to remove a named resource or dependency, use the matching type:

```sh
pi-sync remove --type skill --target skills/NAME --repo /path/to/private-setup
pi-sync remove --type extension --target extensions/NAME --repo /path/to/private-setup
pi-sync remove --type prompt --target prompts/NAME.md --repo /path/to/private-setup
pi-sync remove --type agent --target agents/NAME.md --repo /path/to/private-setup
pi-sync remove --type role --target roles/NAME.md --repo /path/to/private-setup
pi-sync remove --type dependency --source npm:PACKAGE --repo /path/to/private-setup
pi-sync remove --type dependency --source github:OWNER/REPOSITORY --repo /path/to/private-setup
```

Removal is non-destructive by design: it deletes only the manifest entry and the repository content (or the manifest dependency and its exact lockfile pin). It never modifies the local Pi installation and never queues or schedules anything for deletion. A removed resource stays installed indefinitely and is reported as `stale` by `status`, `plan`, and `apply` until it is explicitly pruned or re-declared in the manifest. Local removal of a removed resource happens only through the existing explicit `pi-sync prune --confirm` flow, which keeps its baseline-match and backup protections. A removed dependency stays installed locally by default; only an explicit `pi-sync remove --type dependency --source ... --uninstall` uninstalls it by running `pi uninstall` for the removed pin, and an uninstall failure is reported (exit `1`) without rolling back or altering the repository change. `remove` validates the entry and the repository before changing anything, uses the atomic manifest write pattern, and exits `2` on invalid input or repository validation failure. Publish a removal with the normal explicit push flow (`pi-sync push` preview, then `--publish`), which accepts commits that remove previously managed paths.

## Push only when explicitly authorized

Never infer permission to publish from a request to inspect, set up, apply, add, or update Pi Sync. First preview the exact managed-only commit contents:

```sh
pi-sync push --repo /path/to/private-setup
```

Review the listed paths and full patch with the user. The preview includes only `pi-sync.json` (including repository policy), `pi-sync.lock.json`, and files under resources explicitly registered by the manifest. Unrelated staged/unstaged files, ignored files, and unregistered resources are excluded. The publishing command prints the same managed commit preview to stderr immediately before committing/pushing. If the user explicitly asks to publish, run:

```sh
pi-sync push --publish --repo /path/to/private-setup
```

This creates an ordinary commit and uses a normal fast-forward push; force-push is never used. Git hooks are skipped for this Pi Sync commit so they cannot stage content outside the managed allowlist. Ahead commits are validated against the setup manifest as of that commit, the manifest before the commit, and the current managed set, so commits that add, edit, or remove managed paths — including a committed removal of a resource — are publishable. Pi Sync stops when local commits contain genuinely unrelated paths or when the upstream has advanced/diverged. Reconcile such branches manually and review a fresh preview; do not reset, rebase, merge, or force-push on the user's behalf. A rejected push preserves the local managed commit and changes for a later safe retry. `update --apply --push` is also an explicit publication request after approved package updates; the same full managed patch preview is shown immediately before publication. Preview with `pi-sync push` first whenever possible so the resulting managed commit paths are reviewed before that command.

## Prune only on an explicit request

Pruning is destructive and is never part of ordinary apply. Do not infer permission to prune from a request to inspect, set up, or apply Pi Sync. Only when the user explicitly authorizes pruning, first show the preview:

```sh
pi-sync prune --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
```

Explain the listed targets and any retained modified/overlapping resources. If the user confirms the specific prune, then run:

```sh
pi-sync prune --confirm --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
```

Pi Sync removes only previously managed stale resources that still match their saved baseline, and backs them up. Modified or overlapping resources are retained for manual resolution. Never delete them by another means to work around that protection.

## JSON and exit status

Every response is JSON with `apiVersion: 1`. Successful operations have `ok: true`. Conflicts and blocked operations have `ok: false`; inspect structured `conflicts`, `actions`, `staleResources`, `reviewRequired`, or `details` instead of parsing prose. Error responses include `errorCode`, a readable `error`, `details`, and `exitCode`.

- Exit `0`: operation succeeded (including a read-only plan that reports eligible actions and a completed `remove`).
- Exit `1`: an operational conflict, required first-install approval, package-manager failure, untrustworthy update metadata, a failed explicit `remove --uninstall`, or a stale item that cannot safely be pruned. Stop and explain the structured result; do not override it.
- Exit `2`: invalid input, unsupported operation, or repository/manifest validation failure. Correct the input only with the user's authorization, then re-plan.

`apply` can complete independent non-conflicting resource actions while leaving conflicted items untouched; its exit status remains `1` when any conflict was reported. Bootstrap returns structured authentication and prerequisite-install handoffs; follow them without exposing credentials, invoking sudo, or installing outside the user-writable destination. `update` returns a JSON preview by default and changes lockfile pins or installs packages only with `--apply`. `update --apply --push` requires explicit update approval plus explicit publication authorization and then follows the same managed-only fast-forward push rules. `--approve` is solely for explicit first-time package-install approval; it does not lower release-age policy or resolve conflicts. Push previews and results use the versioned JSON API. Pi Sync pins only top-level package versions/revisions; transitive reproducibility is not guaranteed.
