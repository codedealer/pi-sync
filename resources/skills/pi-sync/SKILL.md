---
name: pi-sync
description: Use before adding, editing, or removing any skill, prompt, agent, role, extension, or settings file under the active agent directory (default ~/.pi/agent, or wherever PI_CODING_AGENT_DIR points); also for operating the explicitly managed Pi setup with the pi-sync CLI.
---

# Pi Sync agent workflow

Use `pi-sync` as the only interface for inspecting and changing resources managed by Pi Sync. Do not edit `pi-sync.json` or `pi-sync.lock.json` directly, copy managed resources into place behind Pi Sync, or install a managed dependency through another tool. Pi Sync supports authored Pi resources (skill directories, extension files or directories, and single `.md` prompt, agent, and role files), selected settings fields, and exact top-level npm/GitHub package pins. Push is opt-in and separate from apply/update unless the user explicitly authorizes it.

## Concepts and boundaries

- The **setup repository** is the user's private repository and source of truth for explicitly managed resources. The public `pi-sync` CLI package does not contain a user's setup.
- The **local Pi installation** defaults to `~/.pi/agent`; `PI_CODING_AGENT_DIR` or `--agent-dir PATH` selects another directory.
- An omitted `--repo` resolves the setup repository exactly like the pi-sync extension: an explicit `--repo PATH` flag first, then `PI_SYNC_REPO_DIR` (used verbatim, no `~` expansion), then the default `~/.pi-sync/setup`. There is no current-working-directory fallback; pass `--repo PATH` when the repository lives elsewhere.
- Only entries declared in the manifest are managed. Unlisted resources, credentials, sessions, caches, and other local-only state must remain local.
- The CLI's `.pi-sync/state.json` and backups are local bookkeeping under the agent directory, not repository content.
- Never add or copy auth files, API keys, OAuth tokens, sessions, caches, or other credentials into the setup repository. Secret detection is best effort, not a guarantee. A private repository is not a secret store.

## Inspect before changing

Use the explicit repository path where possible:

```sh
pi-sync status --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
```

Omit `--agent-dir` to use `PI_CODING_AGENT_DIR`, then the default `~/.pi/agent`. Omit `--repo` to use `PI_SYNC_REPO_DIR` (verbatim, no `~` expansion), then the default `~/.pi-sync/setup` — the same resolution the extension uses, with no current-working-directory fallback. `status` is read-only. Before reporting ahead, behind, and remote-pending they run a bounded (15-second) fetch of the configured upstream that updates Git metadata only (the upstream tracking ref and `FETCH_HEAD`), never the working tree or the local installation; `--no-fetch` (accepted by `status` only) reports the last-known tracking refs instead. A failed or timed-out fetch reports `upstream: "unavailable"` with null `ahead` and `behind` in the `repository` block while retaining the local inspection information; the summary's `clean` is `false` in that state (an unknown remote is not a verified-clean one). Commands default to compact agent-friendly text with one fact per line; review `actions`, `conflicts`, and `staleResources` there before taking an action, or request the structured JSON contract with `--json`. A stale resource remains installed; ordinary apply never removes it. `actions` includes only resources or settings targets with something to report: unchanged resource actions and fully unchanged settings targets are omitted, settings fields include only non-unchanged entries, and resource `files` include only non-unchanged files. Conflicts and stale resources remain explicit.

## Adding or editing user-level resources

When asked to add or edit a user-level (not project-scoped) resource, first determine whether the target is managed, before changing anything. The setup manifest (`pi-sync.json` at the setup repository root) is authoritative: its `resources` entries declare managed resources and its `settings` entries declare managed settings targets and fields. `pi-sync status --repo ... --agent-dir ...` exposes the same set: managed targets appear in `actions` (a locally edited managed resource shows `action: "local-divergence"`) and removed-but-installed targets appear in `staleResources`.

- **Managed resource:** never edit the installed copy in the agent directory — it is the output of `apply`, not an input. Edit the source in the setup repository (the manifest-declared `resources/<type-root>/` path) and run `pi-sync apply` to reconcile the local installation. Publish only with an explicit push authorization (see Push only when explicitly authorized). An in-place edit of an installed managed copy is local-only divergence: `status` reports it as a review item (the extension's footer shows `!n`) and keeps counting it until resolved. The clean recovery is to port the content into the setup repository and apply again — once local and repository content match, the resource re-baselines as unchanged.
- **Unmanaged existing file:** edit it directly. Pi Sync never touches unlisted resources or undeclared settings fields.
- **New resource:** manage by default. Author it under the matching `resources/<type-root>/` path in the setup repository, bring it under management with `pi-sync add --target <matching-agent-relative-path>`, and apply it through Pi Sync. Use the same `add --target` command for a specifically selected local resource; it imports the local copy only when the repository copy is absent.
- **Settings:** managed per field, per the manifest's `settings` declarations. Local changes to managed fields belong to the back-sync flow (see Back-sync local setting changes when requested); undeclared fields remain local and can be edited directly.

## The first-touch write guard
The first-party extension enforces the "never edit the installed copy" rule at decision time. On a managed setup it intercepts tool calls that mutate files under the agent directory's `skills/`, `extensions/`, `prompts/`, `agents/`, or `roles/` roots before they execute, whatever the tool is named. The first such call in a Pi session is blocked, and the block message is the warning: it names the target, gives the qualified source path in the setup repository (the repository's location plus the matching `resources/<type-root>/...` file), tells you to run `pi-sync apply` (and gives the concrete `pi-sync add --target` command for a brand-new resource), and ends with the explicit bypass — if the local-only change is intentional, retry the same operation; subsequent attempts in the session are allowed. Read-only tool calls always pass. `PI_SYNC_GUARD=off` disables the guard.

## Add resources under management

`pi-sync add --target` is the single resource declaration/import flow. It infers the type from the agent-relative target root. The setup repository is the source of truth: if only the repository copy exists, `add` writes the manifest declaration only and does not touch the local installation; if only the local copy exists, `add` validates and secret-scans it, imports it under `resources/<type-root>/`, and declares it. When both copies exist, identical content is declared without copying (and the response notes the match), while differing content fails closed with a collision naming both paths. Neither copy present is a validation error. Per-type shape checks, symlink rejection, `node_modules` prohibition, and secret review apply to imported or declared content. An exact existing source+target declaration is an idempotent no-op when the repository and local content match; diverged copies and other declaration overlaps fail closed as `RESOURCE_COLLISION` (exit `2`). Add `--dry-run` to run the same resolution read-only: it reports the declaration, import, or collision (and any validation or secret error) that would occur, without writing.

Use the same target for repository-authored and local resources, for example:

```sh
pi-sync add --target prompts/deploy.md --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
pi-sync add --target skills/NAME --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
pi-sync add --target extensions/NAME --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
pi-sync add --target agents/NAME.md --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
pi-sync add --target roles/NAME.md --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
```

For several resources already authored in the setup repository, use the read-only discovery and all-or-nothing batch modes:

```sh
pi-sync add --list --repo /path/to/private-setup
pi-sync add --all --repo /path/to/private-setup
```

`--list` reports undeclared resources present directly under every supported `resources/<type-root>/` with inferred `type`, `source`, and `target`; it changes nothing. `--all` validates and secret-scans every candidate and collision-checks against existing declarations and the candidate set before a single atomic manifest write. Any failure declares nothing, and zero candidates is a no-op. Exactly one of `--target`, `--list`, or `--all` may be selected for resource operations. `--source npm:PACKAGE` and `--source github:OWNER/REPOSITORY` remain dependency declarations only: they do not install packages or edit pins, and `--source --dry-run` previews the declaration without writing. `--list` and `--all` are already read-only and reject `--dry-run`.

Complete the repository-first flow with the ordinary reconcile and publish steps:

```sh
pi-sync apply --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
pi-sync push --repo /path/to/private-setup
```


Publish with bare `pi-sync push` only under explicit authorization (see Push only when explicitly authorized); review `push --dry-run` first.

## Apply when requested

Run apply only when the user asks to reconcile the setup repository into the local installation:

```sh
pi-sync apply --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
```

Apply follows the reviewed repository state, preserves unlisted content and local-only divergence, and never overwrites a reported collision or conflicted item. A non-zero result requires stopping to explain the structured conflict or error; do not resolve conflicts by guessing, overwriting, or editing managed files around the CLI. Review a fresh preview after the user resolves the issue.

## Pull upstream changes into the setup repository

When `status` or the footer shows the setup repository is behind its upstream, reconcile the checkout with `pi-sync pull`:

```sh
pi-sync pull --dry-run --repo /path/to/private-setup
```

`pull` does not require `--agent-dir` and never touches the local installation. Bare `pull` performs the fast-forward when safe; `pull --dry-run` previews read-only. Both run a bounded (15-second) fetch of the configured upstream and report ahead/behind counts, working-tree dirt, and changed paths; the fetch updates Git metadata only.

Apply only when the user asks to update the setup repository checkout:

```sh
pi-sync pull --repo /path/to/private-setup
```

The bare action re-fetches and rechecks before mutating instead of applying a stale preview. If the branch is purely behind its upstream, it saves the staged, unstaged, and non-ignored untracked working changes in a uniquely identifiable recovery snapshot (ignored files are never included), advances the branch to the fetched upstream tip with fast-forward-only semantics, and restores the snapshot with Git's native three-way merge — it never creates merge commits, rebases, resets, or force-updates refs. Cleanly reconcilable local changes are preserved (index/staging state where Git permits), only this pull's snapshot is discarded, and the remaining dirty paths are reported. When the restoration leaves conflicts — including an untracked local file at a path the upstream now tracks, which is never overwritten — the branch stays fast-forwarded, Git's unresolved conflict state is left for manual resolution, the recovery snapshot is retained, and the result is a structured `PULL_CONFLICT` error (exit `1`) listing the affected paths and how to inspect or drop the snapshot. Do not resolve pull conflicts by guessing or overwriting; explain the structured result and the recovery snapshot, and do not run `apply` automatically. It refuses (exit `1`, `PULL_BLOCKED`, no files, index state, or refs changed) a diverged branch (both local-only and upstream-only commits), a missing configured upstream, a detached HEAD, an in-progress merge, or a failed fetch; a diverged branch is reconciled manually. If the fast-forward itself fails, the original working state is restored from the snapshot when possible, and a failed restoration retains the snapshot and reports its recovery identifier. An up-to-date branch is a no-op even when the working tree is dirty; a local-only-ahead branch is not a pull conflict and its commits stay publishable through `pi-sync push`. After a successful pull, run `pi-sync status` and `pi-sync apply` to reconcile the local installation, then publish local managed changes only through an explicit `pi-sync push`.
## Back-sync local setting changes when requested

Pi rewrites `settings.json` (and other managed settings targets) when the user changes the model, model scope, theme, thinking level, or any other setting in the TUI. Those local-only changes drift away from the setup manifest until someone edits it by hand. The first-party `pi-sync` extension (installed next to this skill) watches the managed files and runs `pi-sync sync` automatically after a short debounce; a `pi-sync` status-line entry and the `/pi-sync` command expose the result. When the extension is absent (or the user asks to persist a setting change), run the CLI directly:

```sh
pi-sync sync --dry-run --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
pi-sync sync --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
```

`sync` promotes local-only managed setting fields into the manifest using the same three-way comparison as apply (repository unchanged, local diverged from the last applied baseline). Eligible values are portability-validated, the rewritten manifest is secret-scanned, and the write is atomic. Fields changed in both places are conflicts and are never overwritten; baseline-less collisions and locally removed fields are reported for manual review and never written. `sync --dry-run` previews without writing; bare `sync` writes. It modifies only the setup manifest; it never touches the local installation and never commits or pushes. A non-zero result means some fields were not synced: explain the structured `conflicts`, `rejected`, or `review` entries, and publish the synced change only through an explicit `pi-sync push`.

## Add only a specifically selected local resource

When the user explicitly asks to add a named local resource, review its contents for private data and use `--target` with its agent-relative resource path:

```sh
pi-sync add --target skills/NAME --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
pi-sync add --target extensions/NAME --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
pi-sync add --target prompts/NAME.md --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
pi-sync add --target agents/NAME.md --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
pi-sync add --target roles/NAME.md --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
```

`add --target` uses the repository-first resolution described above. For a local-only target it imports only the selected file or directory to the matching `resources/<type-root>/` path (skills are direct child directories, extensions may be a single file or directory, and prompts/agents/roles/workflows are directly rooted files of their required suffix), then declares it. It does not import unrelated files, and `node_modules` or package-installed code is never imported. Review `reviewRequired` findings and remove suspected secret content before retrying; never bypass the check. A collision, invalid path, or malformed repository stops the operation. Do not install an added resource separately; apply it through Pi Sync when requested.

The first-party skill is shipped at `resources/skills/pi-sync/SKILL.md`. Fresh-machine setup uses the CLI bootstrap command, which safely declares it in the fetched setup repository as:

```json
{ "type": "skill", "source": "resources/skills/pi-sync", "target": "skills/pi-sync" }
```

The shipped `pi-sync` skill and first-party `pi-sync` extension are special bootstrap-managed bundle resources: after installing or updating the Pi Sync package, rerun your usual `pi-sync bootstrap` command to refresh both in the setup repository. Bootstrap mirrors these two resources from the executing package into their exact declarations; it does not change their ownership model for other resources. Ordinary managed skills, extensions, prompts, agents, roles, settings, and dependencies remain owned by the setup repository and are changed there through the normal Pi Sync workflow. Bootstrap also manages the setup repository's EOL policy: a missing `.gitattributes` is created with the fixed policy `* text=auto eol=lf` (pinning every text file to LF in the working tree, independent of `core.autocrlf`), so Git's line-ending expectations match the LF content the CLI writes directly and routine rewrites do not surface as phantom modifications. A matching file is reported as `current`; a divergent file is never overwritten and is reported as `divergent` for manual review (result field `repositoryPolicy`). CRLF-committed managed content converges to LF when an authorized `pi-sync push` next stages those paths.

Bootstrap previews the manifest-driven apply before applying; it does not install this skill through a separate copy path or overwrite a collision. To start or resume setup, run `pi-sync bootstrap --repo-url https://github.com/OWNER/PRIVATE-SETUP.git` (optionally `--repo PATH`, `--agent-dir PATH`, and `--bin-dir PATH`). Rerunning is safe: when the destination already contains a valid setup repository (for example after a failed first run), bootstrap continues the setup from that repository instead of requiring an empty path. Bootstrap accepts `--approve-installs` to pre-approve first-time installation of pinned packages. `bootstrap --dry-run` previews the full staged workflow without changing repository/local files or installing missing prerequisites. The setup manifest may list tools in `requiredTools`, but only catalogued names are accepted; never add shell commands or arbitrary installer metadata. Bootstrap checks versions, installs supported missing tools into a user-writable directory without sudo, and stops with an actionable structured handoff if a required tool cannot be installed. Before extracting or executing GitHub CLI, it verifies the complete official release archive against the reviewed, code-pinned SHA-256 digest; a mismatch fails closed. When GitHub CLI is needed for private-repository access, bootstrap installs the official release if supported, then pauses for authentication. Follow the JSON handoff and use its `commandArgs` for `gh auth login --hostname github.com` (the executable may be in the local install directory), then rerun the returned command arguments. Bootstrap never prints or stores credentials and never commits or pushes the private setup repository.

## Add and update managed packages only when asked

Add only a specifically requested dependency using a package identity, not a mutable version or branch:

```sh
pi-sync add --source npm:PACKAGE --repo /path/to/private-setup
pi-sync add --source github:OWNER/REPOSITORY --repo /path/to/private-setup
```

Then inspect the release-age-gated preview and the exact proposed lock entries:

```sh
pi-sync update --dry-run --repo /path/to/private-setup
```

The setup repository's `pi-sync.json` owns `policy.minimumReleaseAgeDays` (at least seven days; defaults to seven). Machine arguments and local settings cannot lower it. npm pins are exact published versions; GitHub pins are immutable commit SHAs with release tag and timestamp retained for review. Missing or untrustworthy release timestamps/SHAs stop update discovery closed. `update --dry-run` does not modify pins or install packages. Run bare `update` only when the user explicitly asks to apply the reviewed update:

```sh
pi-sync update --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
```

Ordinary `apply` never queries newer registry/GitHub releases. It installs only lockfile pins; an initial third-party install requires an interactive confirmation or explicit `--approve-installs` for non-interactive operation. For example:

```sh
pi-sync apply --approve-installs --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
```

Pi Sync coordinates exact top-level pins through Pi's package manager. Pi currently owns transitive dependency resolution; Pi Sync does not provide or claim a reproducible transitive tree. Managed package updates must be previewed with `pi-sync update --dry-run` and performed through bare `pi-sync update` under the repository's age policy. Do not run `pi update --extensions` when it could update managed packages: that command is unsupported for managed packages, may move them beyond their recorded exact pins, and Pi Sync cannot intercept or prevent it. When a user requests or discusses updating managed packages, explain/remind them to use Pi Sync instead. Do not claim that external Pi updates preserve pins or are constrained by Pi Sync, or claim/assume transitive dependencies are locked.

## Remove only an explicitly requested resource or dependency

Removal is the inverse of add. Only when the user explicitly asks to remove a named resource or dependency, select the resource via `--target` or a dependency via `--source`:

```sh
pi-sync remove --target skills/NAME --repo /path/to/private-setup
pi-sync remove --target extensions/NAME --repo /path/to/private-setup
pi-sync remove --target prompts/NAME.md --repo /path/to/private-setup
pi-sync remove --target agents/NAME.md --repo /path/to/private-setup
pi-sync remove --target roles/NAME.md --repo /path/to/private-setup
pi-sync remove --source npm:PACKAGE --repo /path/to/private-setup
pi-sync remove --source github:OWNER/REPOSITORY --repo /path/to/private-setup
```

Removal is explicit and complete: `remove --target` deletes the manifest entry, the repository content, and the local installation, backing up the removed local content under `.pi-sync/backups/`. A local copy that diverged from its saved last-applied baseline is preserved, never overwritten or destroyed, and reported in the removal result; the manifest and repository removal still proceed for that resource. `remove --target --keep-local` limits removal to the manifest entry and repository content, leaving the local copy installed and reported as `stale` by `status` and `apply` until it is removed with `pi-sync remove --stale` or re-declared in the manifest. Local removal of stale resources requires an explicit user request: first preview with `pi-sync remove --stale --dry-run`, then run bare `pi-sync remove --stale` only after authorization; the baseline-match and backup protections remain mandatory. `remove --dry-run` previews any removal without mutating. A removed dependency stays installed locally by default; only an explicit `pi-sync remove --source ... --uninstall` uninstalls it by running `pi uninstall` for the removed pin, and an uninstall failure is reported (exit `1`) without rolling back or altering the repository change. `remove` validates the entry and the repository before changing anything, uses the atomic manifest write pattern, and exits `2` on invalid input or repository validation failure. Publish a removal with the normal explicit push flow (`pi-sync push --dry-run` preview, then bare `pi-sync push`), which accepts commits that remove previously managed paths.

## Push only when explicitly authorized

Never infer permission to publish from a request to inspect, set up, apply, add, or update Pi Sync. First preview the exact managed-only commit contents:

```sh
pi-sync push --dry-run --repo /path/to/private-setup
```

Review the listed paths and full patch with the user. The preview includes only `pi-sync.json` (including repository policy), `pi-sync.lock.json`, the managed `.gitattributes` EOL policy file, and files under resources explicitly declared by the manifest. Unrelated staged/unstaged files, ignored files, and undeclared resources are excluded. If the user explicitly authorizes publication, run:

```sh
pi-sync push --repo /path/to/private-setup
```

This creates an ordinary commit and uses a normal fast-forward push; force-push is never used. Git hooks are skipped for this Pi Sync commit so they cannot stage content outside the managed allowlist. Ahead commits are validated against the setup manifest as of that commit, the manifest before the commit, and the current managed set, so commits that add, edit, or remove managed paths are publishable. Pi Sync stops when local commits contain genuinely unrelated paths or when the upstream has advanced/diverged. Reconcile such branches manually and review a fresh preview; do not reset, rebase, merge, or force-push on the user's behalf. A rejected push preserves the managed commit and changes for a later safe retry. Package update and publication are separate invocations. When the user names a commit subject, pass it with `--message TEXT` on both the preview and action runs. The preview reports `commitMessage`, and the new managed-only commit uses that subject (default `pi-sync: publish managed setup` otherwise). The message applies only to a new commit and never rewrites existing local commits.

## Remove stale resources only on an explicit request

Removing stale local installations is destructive and is never part of ordinary apply. Do not infer permission to remove stale resources from a request to inspect, set up, or apply Pi Sync. Only when the user explicitly authorizes the stale removal, first show the preview with `--dry-run`:

```sh
pi-sync remove --stale --dry-run --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
```

Explain the listed targets and any retained modified/overlapping resources. After the user approves the listed targets, run:

```sh
pi-sync remove --stale --repo /path/to/private-setup --agent-dir "$PI_CODING_AGENT_DIR"
```

Pi Sync removes only previously managed stale resources that still match their saved baseline, and backs them up. Modified or overlapping resources are retained for manual resolution. Never delete them by another means to work around that protection.

## JSON and exit status

Output has three tiers. The default compact text tier is a convenience for you, the agent: one fact per line, beginning with `ok` or `error CODE`. It is not a versioned contract — do not parse it positionally. When you need strict parsing, use `--json`, the stable machine-readable contract (single-line JSON, `apiVersion: 2`, with stable per-command payload shapes); add `--pretty` with `--json` for the legacy two-space JSON formatting. Successful operations have `ok: true`. Conflicts and blocked operations have `ok: false`; inspect structured `conflicts`, `actions`, `staleResources`, `reviewRequired`, or `details` instead of parsing prose. Error responses include `errorCode`, a readable `error`, `details`, and `exitCode`.

- Exit `0`: operation succeeded (including a read-only `status`, a read-only `add --list`, a completed `remove`, and a completed or already-added `add`).
- Exit `1`: an operational conflict, required first-install approval, package-manager failure, untrustworthy update metadata, a failed explicit `remove --uninstall`, a refused pull (diverged branch, missing upstream, failed fetch, or failed fast-forward), a pull restoration conflict (`PULL_CONFLICT`, with the recovery snapshot retained), or a stale item that cannot safely be removed. Stop and explain the structured result; do not override it.
- Exit `2`: invalid input, unsupported operation, or repository/manifest validation failure. Correct the input only with the user's authorization, then re-run.
`apply` can complete independent non-conflicting resource actions while leaving conflicted items untouched; its exit status remains `1` when any conflict was reported. Bootstrap returns structured authentication and prerequisite-install handoffs; follow them without exposing credentials, invoking sudo, or installing outside the user-writable destination. `update --dry-run` previews and bare `update` changes lockfile pins or installs packages. Package update never publishes; use separate `push --dry-run` and, when authorized, bare `push`. `--approve-installs` is solely for explicit first-time package-install approval; it does not lower release-age policy or resolve conflicts. Push previews and results default to compact text; use `--json` for the versioned JSON API. Pi Sync pins only top-level package versions/revisions; transitive reproducibility is not guaranteed.

