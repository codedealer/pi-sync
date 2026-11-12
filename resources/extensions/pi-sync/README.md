# pi-sync extension

Bundled first-party Pi extension that keeps local Pi setting changes in sync
with your pi-sync setup repository.

Pi writes `settings.json` (and any other file your setup manifest declares as
a settings target) when you change the model, theme, thinking level, model
scope, or any other setting in the TUI. This extension watches those files
and, after a short debounce, runs:

```sh
pi-sync sync --apply --repo ~/.pi-sync/setup --agent-dir <agent dir>
```

`pi-sync sync` promotes local-only changes into the `settings` declarations of
`pi-sync.json` using the same three-way comparison as `apply` (managed fields
where the repository is unchanged and the local file diverged from the last
applied baseline). Values are portability-validated (credential-like keys may
only hold strict `$NAME`/`${NAME}` environment references or the
`__PLACEHOLDER__` placeholder), secret-scanned, and written atomically.
Conflicting fields (changed locally and in the repository) are never
overwritten; they are reported for manual review.

The extension is a thin trigger and relay: all sync logic lives in the
`pi-sync` CLI, which also works headless (`pi-sync sync` previews,
`pi-sync sync --apply` writes). Publishing synced changes still requires an
explicit `pi-sync push`.

- Status line: a `pi-sync` entry appears after the first sync result
  (dim when healthy, warning-colored when changes need review).
- Command: `/pi-sync` runs a manual check and reports the result.
- Environment overrides: `PI_SYNC_REPO_DIR` (default `~/.pi-sync/setup`),
  `PI_SYNC_BIN` (default `pi-sync` on PATH). The agent directory is resolved
  through Pi itself (`PI_CODING_AGENT_DIR` or `~/.pi/agent`).

Multiple Pi sessions sharing one agent directory are safe: each session runs
its own watcher with per-process state, and every `sync --apply` serializes on
the same agent lock as `apply`. A concurrent sync that loses the race re-reads
the fresh manifest and baseline and becomes a no-op instead of double-writing.
`sync --apply` never writes the settings files themselves (only the manifest
and baseline state), so it cannot clobber a setting Pi is persisting.

The extension stays silent on setups that are not managed by pi-sync
(no `~/.pi-sync/setup/pi-sync.json` with settings targets).