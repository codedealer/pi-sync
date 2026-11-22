# pi-sync CLI module map

This directory is the internal module layout of the `pi-sync` CLI. This file is
a navigation index, not a second implementation guide: it maps each command to
its workflow module, the shared domain modules it uses, and the key types at
the seams. Behavioral details (rules, error semantics, guarantees) stay in the
owning module, the project README, and the pi-sync skill.

Dependency direction: `../cli.ts` (composition root) → `arguments.ts` and the
command workflows → shared domain modules. Shared domain modules never import
command workflows; command modules may import each other only through exported
interfaces; publishing after package updates is a separate `push` invocation.

## Entry point

`../cli.ts` — source executable (the npm `bin` is the generated
`dist/cli.js`). Invokes argument parsing and command dispatch, serializes the
final text or JSON response, owns the process exit status and stream output, and maps
uncaught failures to either the structured JSON error envelope or compact text error and exit status.

## Commands

| Command | Workflow module | Shared domain modules | Key types |
| --- | --- | --- | --- |
| `status` | `commands/inspect.ts` | `manifest.ts`, `reconciliation.ts` | `InspectInput`, `InspectOutput` |
| `pull` | `commands/pull.ts` | `reconciliation.ts`, `process.ts` | `PullInput`, `PullOutput` |
| `apply` | `commands/apply.ts` | `manifest.ts`, `reconciliation.ts`, `local-state.ts`, `../packages.ts` | `ApplyInput`, `ApplyOutput` |
| `sync` | `commands/sync.ts` | `manifest.ts`, `reconciliation.ts`, `local-state.ts`, `resource-operations.ts` | `SyncInput`, `SyncOutput` |
| `add`, `remove` | `commands/resources.ts` | `manifest.ts`, `resource-operations.ts`, `reconciliation.ts`, `local-state.ts`, `process.ts` | `AddOutput`, `RemoveOutput` |
| `bootstrap` | `commands/bootstrap.ts` | `../prerequisites.ts`, `manifest.ts`, `reconciliation.ts`, `resource-operations.ts`, `process.ts` | `BootstrapInput`, `BootstrapOutput`, `BootstrapErrorCode` |
| `update` | `commands/update.ts` | `../packages.ts`, `manifest.ts`, `local-state.ts` | `UpdateInput`, `UpdateOutput`, `PackageUpdate` |
| `push` | `commands/push.ts` | `manifest.ts`, `reconciliation.ts`, `resource-operations.ts`, `process.ts` | `PushInput`, `PushOutput`, `PushChange` |
| `pi-update` | `commands/pi-update.ts` | `local-state.ts`, `process.ts` | `PiUpdateInput`, `PiCandidate` |
| `--version` | `../cli.ts` (dispatched directly) | — | `VersionRequest` |

Notes on the seams:

- `update` only discovers, approves, installs, and persists the new exact package pins. It does not publish; use the separate `push` command after reviewing the update.
- `push` reports what happened, not the diff: a bare `push` emits the
  published commit, branch/upstream, and the changed managed paths (no diff,
  no digest); the full managed diff appears only in `push --dry-run`, on
  stdout. The CLI writes nothing to stderr in normal operation. Command
  results use compact text by default; `--json` selects compact
  `apiVersion: 2` JSON and `--json --pretty` retains the legacy two-space JSON
  formatting.
- `pull` dispatches before repository manifest validation and the agent
  directory check: it updates the setup-repository checkout only, so it
  requires no valid manifest and neither requires nor uses `--agent-dir`.
- `status` accept `--no-fetch`, which skips the bounded upstream
  fetch and reports the last-known tracking refs instead (other commands
  reject it with the `--no-fetch is only supported by status` error).
- `status` and `push` receive their validated `RepositoryDeclarations`
  from the entry point (strict validation); `update` and `remove` tolerate
  missing pins at dispatch so their dedicated errors apply.

## Parsing

`arguments.ts` — parses argv, applies environment and default resolution
(`PI_SYNC_REPO_DIR`, `PI_CODING_AGENT_DIR`), validates command-specific option
combinations, and returns the discriminated `CommandRequest` union
(`StatusRequest`, `ApplyRequest`, `AddRequest`,
`RemoveRequest`, `AddResourceDiscoveryRequest`, `PullRequest`, `PushRequest`, `UpdateRequest`, `PiUpdateRequest`,
`SyncRequest`, `BootstrapRequest`, `VersionRequest`). It never touches the
repository or Git.

## Shared domain modules

| Module | Responsibility |
| --- | --- |
| `manifest.ts` | Reads and validates the setup repository's manifest and lockfile, enforces declaration/path/schema invariants, and produces the normalized `RepositoryDeclarations` (`validateRepository`). Also owns `MANIFEST_FILE`, `LOCK_FILE`, `RESOURCE_RULES`, and `LockFile`/`ResourceDeclaration` types. |
| `resource-operations.ts` | Shared resource discovery and candidate scanning, source validation, secret review (`SecretFinding`), atomic JSON/file writes, and repository-side add/remove helpers. |
| `reconciliation.ts` | The single owner of three-way reconciliation: plans, resource/settings actions, sync classification, and reporting summaries from the setup repository and local baseline. |
| `process.ts` | The single owner of the CLI's process-execution and read-only Git inspection primitives (`runCommand`, `gitResult`), including the Windows PATH shell semantics via `shellFor` and the Windows-only `gitExecutable` resolution (a path-qualified Git binary so git arguments are never interpreted by a shell). Used by the push, bootstrap, and resources workflows and by reconciliation's publish-state check. |
| `local-state.ts` | Owns the `.pi-sync` state directory and package-pin persistence, apply locks, snapshots/backups, and atomic restoration/rollback primitives. |
| `../packages.ts` | Package pin/update discovery, exact-pin lockfile updates, installation, rollback, and approval. |
| `../prerequisites.ts` | Prerequisite tool validation and the artifact-fetch-injecting prerequisite inspector. |

## Build

The TypeScript source is compiled with `tsc` (strict, NodeNext ESM,
`tsconfig.json`) to a one-to-one module tree under `dist/`; `dist/cli.js` is
the published executable. `npm run build` compiles, `npm run typecheck` runs
the same project with `--noEmit`, and `npm test` builds before running the
subprocess test suite against `dist/cli.js`.