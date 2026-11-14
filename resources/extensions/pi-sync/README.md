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

## Footer status

The extension renders the `summary` block of `pi-sync status` as a persistent
footer. The CLI decides what counts as pending or review-worthy; the
extension never computes drift itself.

| Footer | Meaning |
| --- | --- |
| `pi-sync ✓` | Fully in sync: no local drift, repository clean, not behind upstream, nothing needs review. |
| `pi-sync ↑n` | n local change(s) not yet on the remote. |
| `pi-sync ↓n` | n remote change(s) not yet applied to the local installation. |
| `pi-sync !n` | n item(s) need manual review. |
| `pi-sync ✗` | The status check failed (CLI unavailable, repository error). |
| `pi-sync …` / `pi-sync ⟳` | Checking / auto-sync in flight. |

Non-zero terms combine in the order `↑ ↓ !`; zero terms are omitted; a fully
clean state shows only `✓`. The footer refreshes on real changes (session
start, sync completion, agent-directory and setup-repository watcher events)
and on a 60-second tick that only re-reads file metadata — no network, no
CLI spawn in steady state. A shared status cache under the agent directory
deduplicates full refreshes across concurrent Pi sessions.

If the footer shows `✗`, the status check itself failed (CLI unavailable,
timeout, or repository error): run `/pi-sync` to see the structured error.
A failed check does not clear the last computed summary; the footer returns
to it once the next check succeeds.

## Session-start remote awareness

At session start the extension also makes remote commits visible without
manual action: an async, fetch-only `git fetch` against the upstream that
never pulls, merges, or applies anything (applying remote changes remains the
explicit human flow: pull, then `pi-sync apply`). The fetch is
freshness-gated (skipped when the repository's `FETCH_HEAD` is younger than
five minutes), single-flight, and bounded by a 15-second timeout, so network
access happens at most once per session and the periodic tick never touches
the network. A fetch failure is silent: network or authentication trouble is
not a sync-state failure, so the footer keeps its last known state and the
next session retries.

## Startup orientation

At Pi process startup — not on session resume, fork, or new-session starts —
a managed setup receives a one-line orientation notification naming the two
main flows: update dependencies with `pi-sync update`, and manage resources
by editing the setup repository and running `pi-sync apply`. It points at
the `pi-sync` skill for the full workflow. It is a user-facing info
notification only: it never enters the transcript or the LLM context.

## Command and environment

- Command: `/pi-sync` runs a manual sync and reports the result.
- Environment overrides: `PI_SYNC_REPO_DIR` (default `~/.pi-sync/setup`),
  `PI_SYNC_BIN` (default `pi-sync` on PATH). The agent directory is resolved
  through Pi itself (`PI_CODING_AGENT_DIR` or `~/.pi/agent`).

## Multiple sessions

Multiple Pi sessions sharing one agent directory are safe: each session runs
its own watcher with per-process state, every `sync --apply` serializes on
the same agent lock as `apply`, and the shared status cache ensures at most
one full footer refresh per real change. A concurrent sync that loses the
race re-reads the fresh manifest and baseline and becomes a no-op instead of
double-writing. `sync --apply` never writes the settings files themselves
(only the manifest and baseline state), so it cannot clobber a setting Pi is
persisting.

## Non-managed setups

The extension stays completely silent on setups that are not managed by
pi-sync (no settings targets declared in the setup manifest): no footer, no
orientation message, no status entry, and no network activity.
