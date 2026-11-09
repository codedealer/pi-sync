---
name: pi-sync
description: Inspect and safely operate the explicitly managed Pi setup using the pi-sync CLI.
---

# Pi Sync agent workflow

Use `pi-sync` as the only interface for inspecting and changing resources managed by Pi Sync. Do not edit `pi-sync.json` or `pi-sync.lock.json` directly, copy managed resources into place behind Pi Sync, or install a managed dependency through another tool. Pi Sync supports authored skill resources, selected settings fields, and exact top-level npm/GitHub package pins. Push is opt-in and separate from apply/update unless the user explicitly authorizes it.

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

## Apply when requested

Run apply only when the user asks to reconcile the setup repository into the local installation:

```sh
pi-sync apply --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
```

Apply follows the reviewed repository state, preserves unlisted content and local-only divergence, and never overwrites a reported collision or conflicted item. A non-zero result requires stopping to explain the structured conflict or error; do not resolve conflicts by guessing, overwriting, or editing managed files around the CLI. Review a new plan after the user resolves the issue.

## Add only a specifically selected local skill

When the user explicitly asks to add a named local skill, review its contents for private data and use the CLI:

```sh
pi-sync add --type skill --source skills/NAME --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
```

`add` imports only that selected skill to `resources/skills/NAME` and registers it in the manifest. It does not import unrelated files. Review any `reviewRequired` findings and remove suspected secret content before retrying; never bypass the check. A collision, invalid path, or malformed repository stops the operation. Do not install an added resource separately; apply it through Pi Sync when requested.

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

## Push only when explicitly authorized

Never infer permission to publish from a request to inspect, set up, apply, add, or update Pi Sync. First preview the exact managed-only commit contents:

```sh
pi-sync push --repo /path/to/private-setup
```

Review the listed paths and full patch with the user. The preview includes only `pi-sync.json` (including repository policy), `pi-sync.lock.json`, and files under resources explicitly registered by the manifest. Unrelated staged/unstaged files, ignored files, and unregistered resources are excluded. The publishing command prints the same managed commit preview to stderr immediately before committing/pushing. If the user explicitly asks to publish, run:

```sh
pi-sync push --publish --repo /path/to/private-setup
```

This creates an ordinary commit and uses a normal fast-forward push; force-push is never used. Git hooks are skipped for this Pi Sync commit so they cannot stage content outside the managed allowlist. Pi Sync stops if local commits contain unrelated paths or if the upstream has advanced/diverged. Reconcile such branches manually and review a fresh preview; do not reset, rebase, merge, or force-push on the user's behalf. A rejected push preserves the local managed commit and changes for a later safe retry. `update --apply --push` is also an explicit publication request after approved package updates; the same full managed patch preview is shown immediately before publication. Preview with `pi-sync push` first whenever possible so the resulting managed commit paths are reviewed before that command.

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

- Exit `0`: operation succeeded (including a read-only plan that reports eligible actions).
- Exit `1`: an operational conflict, required first-install approval, package-manager failure, untrustworthy update metadata, or a stale item that cannot safely be pruned. Stop and explain the structured result; do not override it.
- Exit `2`: invalid input, unsupported operation, or repository/manifest validation failure. Correct the input only with the user's authorization, then re-plan.

`apply` can complete independent non-conflicting resource actions while leaving conflicted items untouched; its exit status remains `1` when any conflict was reported. Bootstrap returns structured authentication and prerequisite-install handoffs; follow them without exposing credentials, invoking sudo, or installing outside the user-writable destination. `update` returns a JSON preview by default and changes lockfile pins or installs packages only with `--apply`. `update --apply --push` requires explicit update approval plus explicit publication authorization and then follows the same managed-only fast-forward push rules. `--approve` is solely for explicit first-time package-install approval; it does not lower release-age policy or resolve conflicts. Push previews and results use the versioned JSON API. Pi Sync pins only top-level package versions/revisions; transitive reproducibility is not guaranteed.
