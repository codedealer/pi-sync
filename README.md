# pi-sync

A small Node.js CLI for applying explicitly declared Pi user-level resources from a setup repository. This repository contains the public CLI only; personal setup files belong in a separate private setup repository.

## Requirements

- Node.js 18 or newer

## Public installation and private-repository bootstrap

The npm package publishes the CLI and its first-party `pi-sync` skill only. Its explicit `files` allowlist excludes setup repositories, credentials, scratch planning files, and test fixtures. Install globally at user level where your npm/pnpm prefix is writable (configure a user-writable npm prefix if needed; do not use sudo), or use a one-shot runner:

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

Bootstrap clones into `~/.pi-sync/setup` by default (override with `--repo-dir PATH`) and applies to `PI_CODING_AGENT_DIR` or `~/.pi/agent` (override with `--agent-dir PATH`). It first tests Git access, then uses an authenticated GitHub CLI session when available. If Git access is unavailable and GitHub CLI is missing, bootstrap installs the official GitHub CLI release into `~/.local/bin` (override with `--bin-dir PATH`) when a supported platform artifact and writable destination are available, then pauses for authentication. If installation is unsupported or fails, it reports the exact missing tool and a no-sudo user action. The authentication handoff includes a `commandArgs` array for `gh auth login --hostname github.com`; when Pi Sync installed the tool locally, it points directly to that executable. After authenticating, rerun the returned resume arguments. Pi Sync never asks for, prints, or stores credentials. Once fetched, bootstrap validates the manifest and lockfile and installs every declared `requiredTools` prerequisite before applying anything; unsupported names are rejected and failed required tools stop setup. It declares the bundled skill as `{ "type": "skill", "source": "resources/skills/pi-sync", "target": "skills/pi-sync" }`, previews normal manifest-driven apply, and installs only through the ordinary conflict-safe apply flow. Existing declared or local content at a colliding path is reported and left untouched. Bootstrap does not commit or push repository changes.

## Setup repository format (schema version 1)

Place `pi-sync.json` and `pi-sync.lock.json` at the root of the setup repository. Schema version 1 supports authored Pi resources — skill directories, extensions (single files or directories), prompts, agents, and roles — plus explicitly declared npm/GitHub Pi packages. Package pins are kept in the lockfile and ordinary apply never discovers newer releases.

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

`requiredTools` is optional and contains only tool names from Pi Sync's supported installer catalog; it is not a place for shell commands, URLs, or arbitrary installer metadata. The initial catalog supports GitHub CLI (`gh`) from official GitHub CLI release artifacts on Linux/macOS (x64/arm64) and Windows x64. Each complete release archive is checked against a code-pinned SHA-256 digest from GitHub CLI's official [`gh_2.74.2_checksums.txt`](https://github.com/cli/cli/releases/download/v2.74.2/gh_2.74.2_checksums.txt) before extraction, writing, or execution. HTTPS alone is not treated as artifact integrity. The project does not independently verify a vendor signature; changing the version or digests requires reviewed source changes. Bootstrap checks command availability and reports detected versions. Missing catalogued tools are installed into `~/.local/bin` by default (or a user-selected `--bin-dir`), without sudo or persistent PATH/configuration changes. Unsupported platform/architecture, missing pin, digest mismatch, download, execution, or write failures stop bootstrap with the exact tool, reason, and user action; no required tool is silently skipped. WSL, containers, and remote Linux environments use the Linux artifact and user-local path. On Windows, use the selected bin directory in the current user's PATH yourself if you want to invoke the installed CLI outside Pi Sync. The default Node-only Pi Sync runtime itself does not depend on these external tools. Deterministic host-injected platform fixtures validate asset selection but do not claim native behavior. A dedicated CI workflow runs the intercepted-download install, execution, temporary user-path, and PATH-discovery smoke test on native macOS and Windows runners. Linux adapter tests run on the host test environment; they do not represent executed WSL, container, or remote environments, which remain unverified as deployment environments.

The policy is repository-owned; `minimumReleaseAgeDays` defaults to seven and may not be set below seven. Machines cannot override it. The corresponding lockfile starts empty until `pi-sync update` resolves mature releases:

```json
{
  "schemaVersion": 1,
  "packages": [
    { "type": "npm", "name": "example-package", "version": "1.2.3", "releasedAt": "2025-01-01T00:00:00.000Z" },
    { "type": "github", "repository": "OWNER/pi-extension", "commit": "0123456789abcdef0123456789abcdef01234567", "tag": "v1.2.3", "releasedAt": "2025-01-01T00:00:00.000Z" }
  ]
}
```

The npm version is an exact published version; GitHub records the resolved immutable commit SHA plus tag/timestamp review metadata. Missing or incomplete timestamps, tags, or commit SHAs fail closed. Pi Sync pins only top-level package references. Pi controls transitive dependency resolution; Pi Sync does not provide a transitive lock or reproducibility guarantee.

Resources use per-type roots, and every source and target must stay inside its declared root:

| type | source | target | shape |
| --- | --- | --- | --- |
| `skill` | `resources/skills/NAME` | `skills/NAME` | directory |
| `extension` | `resources/extensions/NAME` | `extensions/NAME` | single file or directory |
| `prompt` | `resources/prompts/NAME.md` | `prompts/NAME.md` | single `.md` file |
| `agent` | `resources/agents/NAME.md` | `agents/NAME.md` | single `.md` file |
| `role` | `resources/roles/NAME.md` | `roles/NAME.md` | single `.md` file |

For non-skill types the source and target must use the same name. Symbolic links are rejected, paths use relative POSIX syntax, and no path may traverse outside its root. `node_modules` directories are never imported or managed; only authored content and portable extension configuration belong in the setup repository. Package-installed code is never imported. The optional schema-v1 `settings` list supports explicitly selected JSON Pointer fields in `settings.json`, `models.json`, `keybindings.json`, or `mcp.json`; each entry has a `target` and `fields` array of `{ "path": "/nested/key", "value": ... }`. Keep paths narrow and never declare literal credentials or machine-local values; Pi Sync rejects credential-like field names in managed setting values as a defense-in-depth check, with two exceptions: a credential-like key may hold a strict `$NAME` or `${NAME}` environment reference (which Pi interpolates at request time), so the reference is synced while the actual value stays configured per machine, or the safe literal `__PLACEHOLDER__`, which is Pi's documented way to satisfy the mandatory `apiKey` field for local endpoints that require no real key. This is not a general secret scanner. Unselected keys and values are preserved. A pre-existing selected setting that differs from its declared value is reported as a collision on first apply rather than overwritten. Unsupported schema fields, resource types, malformed dependency declarations, and lockfile package entries that do not exactly match manifest dependencies are rejected before the local installation is changed.

Apply stores its last-applied content baseline and recoverable backups under `<agent-dir>/.pi-sync/`, outside the setup repository. The baseline enables file-level three-way resource reconciliation and per-field settings reconciliation: repository-only changes are applied independently, local-only changes are preserved and reported as `local-divergence`, and overlapping changes are reported as conflicts without overwriting the conflicted item. Non-conflicting files and settings fields can still be reconciled in the same apply. Apply operations are serialized with a local lock; if a lock's owner process has exited, apply fails closed and asks the user to remove `.pi-sync/apply.lock` only after confirming that no apply process is running. Local state and backups are not part of the setup repository.

## Commands

Run from the setup repository, or select it explicitly:

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
pi-sync push [--repo PATH]
pi-sync push --publish [--repo PATH]
pi-sync sync [--repo PATH] [--agent-dir PATH]
pi-sync sync --apply [--repo PATH] [--agent-dir PATH]
pi-sync prune [--repo PATH] [--agent-dir PATH]
pi-sync prune --confirm [--repo PATH] [--agent-dir PATH]
```

The target defaults to `PI_CODING_AGENT_DIR`, then `~/.pi/agent`. Each command emits JSON. `status` and `plan` report `install`, `update`, `unchanged`, `local-divergence`, `conflict`, or `collision` actions. Apply installs absent resources, reconciles tracked changes, and leaves unlisted resources and settings untouched. Unknown pre-existing resource paths and settings collisions are never overwritten.

`add` supports explicitly importing one resource of each type from the local Pi agent directory: a skill directory from `skills/NAME`, an extension file or directory from `extensions/NAME`, or a single `.md` file from `prompts/NAME.md`, `agents/NAME.md`, or `roles/NAME.md`. It copies only the selected file or directory to the matching `resources/<type-root>/` path and appends the corresponding manifest resource. `add --type dependency` declares only the selected npm package or GitHub repository; it does not edit pins or install packages. Run `update` to preview mature exact pins, then `update --apply` to explicitly apply eligible updates. Managed package updates must be performed through `pi-sync update`; ordinary `apply` uses lockfile pins without registry/GitHub update lookups. First-time installs require interactive confirmation or explicit `--approve` for non-interactive use. Known credential-store paths and likely secret material stop resource import and are reported for review; the scanner is best-effort and does not guarantee arbitrary content is secret-free.

Do not use the external `pi update --extensions` command for managed packages. It is unsupported for managed packages and may move them beyond their recorded pins; Pi Sync cannot intercept or prevent it. Use `pi-sync update` (and `--apply` after reviewing the plan) to update managed packages under the repository's release-age policy.

`remove` is the explicit way to remove a managed resource or dependency from the repository. Resource removal takes the resource `--type` and the manifest `--target` (for example `skills/NAME` or `prompts/NAME.md`); dependency removal takes `--type dependency` and `--source npm:PACKAGE` or `github:OWNER/REPOSITORY`. Removal is non-destructive by design: it validates the entry and repository, then deletes only the manifest entry and repository content (or the manifest dependency and its exact lockfile pin). It never modifies the local Pi installation and never queues or schedules anything for deletion. A removed resource stays installed indefinitely and is reported as `stale` by `status`, `plan`, and `apply` until it is explicitly pruned or re-declared in the manifest; local removal still happens only through the explicit `pi-sync prune --confirm` flow. A removed dependency stays installed locally by default. Passing `--uninstall` additionally runs `pi uninstall` for the removed pin (for example `npm:PACKAGE@1.2.3`) and, on success, clears that package's local Pi Sync pin bookkeeping; a failed uninstall is reported with exit code `1` without rolling back or altering the repository change. Publishing a removal uses the ordinary explicit push flow, and push accepts commits that remove previously managed paths.

`sync` back-syncs local setting changes into the setup manifest, closing the loop for fields that Pi itself rewrites (model scope, default model, theme, thinking level, …). It uses the same three-way comparison as `plan`: a field is eligible only when the repository is unchanged and the local installation diverged from the last applied baseline. Eligible local values are portability-validated (credential-like keys may hold only strict `$NAME`/`${NAME}` environment references or the `__PLACEHOLDER__` placeholder), the resulting manifest is secret-scanned, and the write is atomic. Fields changed in both the repository and the local installation are reported as conflicts and never overwritten; fields changed locally without a baseline (collisions) or removed locally are reported for manual review and never written. `pi-sync sync` previews without writing; `pi-sync sync --apply` writes the manifest. Sync never commits or pushes; publishing still requires an explicit `pi-sync push`.

The first-party `pi-sync` extension (declared by bootstrap next to the skill, manifest entry `{ "type": "extension", "source": "resources/extensions/pi-sync", "target": "extensions/pi-sync" }`) automates this inside Pi: it watches the agent directory for changes to the files the manifest declares as settings targets and, after a short debounce, runs `pi-sync sync --apply`. A `pi-sync` status-line entry and a `/pi-sync` command expose the result. All sync logic stays in the CLI, which also works headless; the extension is a thin trigger and relay that stays silent on setups that are not managed by Pi Sync. It honors `PI_SYNC_REPO_DIR` and `PI_SYNC_BIN` overrides and resolves the agent directory through Pi itself (`PI_CODING_AGENT_DIR` or `~/.pi/agent`).

Multiple Pi sessions sharing one agent directory are supported: each session runs its own watcher and debounce with per-process state, and every `sync --apply` serializes on the same agent lock as `apply` (exclusive lockfile, up to 2.5 s wait). A concurrent sync that loses the race re-reads the fresh manifest and baseline and becomes a no-op instead of double-writing; if the lock is still held after the wait it fails with a readable error and retries on the next change. `sync --apply` never writes the settings files themselves (only the manifest and baseline state), so it cannot clobber a setting Pi is persisting, and settings reads retry once to ride out the brief window of Pi's in-place settings write. Genuine both-sides changes remain conflicts for manual review either way.

## Agent API and first-party skill

Every command emits JSON with `apiVersion: 1` and an `ok` boolean. Conflict responses include structured `conflicts`, `actions`, and/or `staleResources`; errors retain a readable `error` string and include `errorCode`, `details`, and `exitCode`. Exit `0` means the operation completed, `1` means an operational conflict, required first-install approval, package-manager failure, untrustworthy update metadata, a failed explicit `remove --uninstall`, or unsafe stale-resource operation, and `2` means invalid input or repository/manifest validation failed. In particular, apply leaves conflicted items untouched and returns `1`; inspect the JSON and re-plan rather than guessing or overwriting.

The agent workflow is documented in the first-party skill at `resources/skills/pi-sync/SKILL.md`, and both the skill and the settings-sync extension are included in the published CLI package and declared by bootstrap. The CLI apply installs declared Pi packages from exact lockfile pins and reconciles managed resources; it does not install undeclared bundled content.

Push is opt-in. `pi-sync push` previews the full patch for `pi-sync.json` (including policy), `pi-sync.lock.json`, and only resources explicitly registered by the manifest. It excludes unrelated staged/unstaged files, ignored files, and unregistered resources. Review the preview before `pi-sync push --publish`; the publishing flow re-displays the commit preview before creating an ordinary commit and fast-forward push. Git hooks are skipped for the Pi Sync commit so hooks cannot add paths outside the managed allowlist. Ahead commits are validated against the setup manifest as of that commit, the manifest before the commit, and the current managed set, so commits that add, edit, or remove managed paths — including a committed removal of a resource — are publishable. It stops on genuinely unrelated commits ahead of upstream or any remote advancement/divergence and never force-pushes. A rejected push leaves the managed commit local. `update --apply --push` is explicit authorization to publish after the approved package update and follows the same managed-only checks.

Resources previously applied by Pi Sync but removed from the manifest are reported as `stale` in status, plan, and apply output. Ordinary apply never removes them. The first-class way to reach this state is `pi-sync remove`, which keeps the resource installed until an explicit `pi-sync prune --confirm`. `prune` previews eligible stale resources without changing files; `prune --confirm` removes only stale resources that still exactly match their saved last-applied baseline. Modified stale resources are retained and reported. Removed resources are backed up under `.pi-sync/backups/`, and unrelated local resources are not touched.
