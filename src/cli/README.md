# pi-sync CLI module map

This directory is the internal module layout of the `pi-sync` CLI. This file is
a navigation index, not a second implementation guide: it maps each command to
its workflow module, the shared domain modules it uses, and the key types at
the seams. Behavioral details (rules, error semantics, guarantees) stay in the
owning module, the project README, and the pi-sync skill.

Dependency direction: `../cli.ts` (composition root) → `arguments.ts` and the
command workflows → shared domain modules. Shared domain modules never import
command workflows; command modules may import each other only through exported
interfaces (for example, update's `--push` calling the push workflow).

## Entry point

`../cli.ts` — source executable (the npm `bin` is the generated
`dist/cli.js`). Invokes argument parsing and command dispatch, serializes the
final JSON response, owns the process exit status and stream output, and maps
uncaught failures to the JSON error envelope and exit status.

## Commands

| Command | Workflow module | Shared domain modules | Key types |
| --- | --- | --- | --- |
| `status`, `plan` | `commands/inspect.ts` | `manifest.ts`, `reconciliation.ts` | `InspectInput`, `InspectOutput` |
| `pull` | `commands/pull.ts` | `reconciliation.ts`, `process.ts` | `PullInput`, `PullOutput` |
| `apply` | `commands/apply.ts` | `manifest.ts`, `reconciliation.ts`, `local-state.ts`, `../packages.ts` | `ApplyInput`, `ApplyOutput` |
| `sync` | `commands/sync.ts` | `manifest.ts`, `reconciliation.ts`, `local-state.ts`, `resource-operations.ts` | `SyncInput`, `SyncOutput` |
| `prune` | `commands/prune.ts` | `manifest.ts`, `reconciliation.ts`, `local-state.ts` | `PruneInput`, `PruneOutput`, `PruneResult` |
| `add`, `register`, `remove` | `commands/resources.ts` | `manifest.ts`, `resource-operations.ts`, `reconciliation.ts`, `local-state.ts`, `process.ts` | `AddOutput`, `RegisterOutput`, `RemoveOutput` |
| `bootstrap` | `commands/bootstrap.ts` | `../prerequisites.ts`, `manifest.ts`, `reconciliation.ts`, `resource-operations.ts`, `process.ts` | `BootstrapInput`, `BootstrapOutput`, `BootstrapErrorCode` |
| `update` | `commands/update.ts` | `../packages.ts`, `manifest.ts`, `local-state.ts`, `commands/push.ts` (command→command seam) | `UpdateInput`, `UpdateOutput`, `PackageUpdate` |
| `push` | `commands/push.ts` | `manifest.ts`, `reconciliation.ts`, `resource-operations.ts`, `process.ts` | `PushInput`, `PushOutput`, `PushChange` |
| `pi-update` | `commands/pi-update.ts` | `local-state.ts`, `process.ts` | `PiUpdateInput`, `PiCandidate` |
| `--version` | `../cli.ts` (dispatched directly) | — | `VersionRequest` |

Notes on the seams:

- `update --push` calls `runPush` from `commands/push.ts` with a fresh strict
  `validateRepository` read, `publish: true`, and the optional `--message`
  subject; the published `PushOutput` is embedded in `UpdateOutput.push`.
  Publication is owned by the push module alone, so `push` and
  `update --push` share the same managed-only safeguards and the optional
  managed-only commit subject (`push --message`, forwarded by
  `update --apply --push --message`).
- The push preview is the CLI's only intentional human-readable output: it is
  passed through the narrow `previewWriter` seam on `PushInput`, and the entry
  point supplies the stderr writer.
- `pull` dispatches before repository manifest validation and the agent
  directory check: it updates the setup-repository checkout only, so it
  requires no valid manifest and neither requires nor uses `--agent-dir`.
- `status`/`plan` accept `--no-fetch`, which skips the bounded upstream
  fetch and reports the last-known tracking refs instead (other commands
  reject it with the `--no-fetch is only supported by status and plan` error).
- `status`/`plan` and `push` receive their validated `RepositoryDeclarations`
  from the entry point (strict validation); `update` and `remove` tolerate
  missing pins at dispatch so their dedicated errors apply.

## Parsing

`arguments.ts` — parses argv, applies environment and default resolution
(`PI_SYNC_REPO_DIR`, `PI_CODING_AGENT_DIR`), validates command-specific option
combinations, and returns the discriminated `CommandRequest` union
(`StatusPlanRequest`, `ApplyRequest`, `PruneRequest`, `AddRequest`,
`RemoveRequest`, `RegisterRequest`, `PullRequest`, `PushRequest`, `UpdateRequest`, `PiUpdateRequest`,
`SyncRequest`, `BootstrapRequest`, `VersionRequest`). It never touches the
repository or Git.

## Shared domain modules

| Module | Responsibility |
| --- | --- |
| `manifest.ts` | Reads and validates the setup repository's manifest and lockfile, enforces declaration/path/schema invariants, and produces the normalized `RepositoryDeclarations` (`validateRepository`). Also owns `MANIFEST_FILE`, `LOCK_FILE`, `RESOURCE_RULES`, and `LockFile`/`ResourceDeclaration` types. |
| `resource-operations.ts` | Shared resource discovery and candidate scanning, source validation, secret review (`SecretFinding`), atomic JSON/file writes, and repository-side add/register/remove helpers. |
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