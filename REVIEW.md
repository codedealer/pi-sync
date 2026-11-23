# Review standards — pi-sync

Complements the generic review skill with this project's binding invariants.

## Compatibility with the installed Pi runtime
- The first-party extension (`resources/extensions/pi-sync/index.ts`, `status.js`, `process.js`) runs inside the user's Pi process. It must never block or crash startup: every Pi-runtime interaction is best-effort, asynchronous, or guarded, and a failed check degrades to the previous state.
- Claims about Pi behavior (event ordering, environment variables, UI APIs) must be verified against the installed `@earendil-works/pi-coding-agent` runtime, not assumed — see `AGENTS.md` for how to locate it.
- The extension type-checks against the Pi version pinned in `devDependencies` (`tsconfig.extension.json`). Changing that pinned version is a compatibility decision, not a routine dependency bump: flag it explicitly.

## Shipped surface
- The exact shipped file list is pinned by the tarball allowlist test in `test/cli.test.js` (asserts `package.json` `files` and the packed tarball contents). Any change to shipped files must update `package.json` `files` and that test in the same commit, and re-check `npm stage publish . --dry-run`.

## CLI contract
- The extension consumes the CLI's JSON results (`apiVersion` and per-command shapes, e.g. the `pi-update` preview). Changing a command's result shape is a breaking change for the shipped extension: flag it explicitly and check the extension's validation in the same review.
## Text tier (compact output)
- `renderText` in `src/cli.ts` renders every top-level response key not in its `skipped` set. Response fields that are machine-oriented or unbounded in size (full patches, raw diffs, long logs) must never reach the compact tier: exclude them per command and keep the full payload in `--json`/`--pretty`. A new command whose response carries such a field is a review blocker until its text-tier output is bounded.
- Every command needs a compact-tier success test asserting that no line renders a literal `undefined` (model: the bootstrap text-tier test in `test/cli.test.js`) and that the output stays within a sane size bound.
## Tests and checks
- `npm test` (build + typecheck incl. the extension + full `node --test` suite) must pass.
- Changes touching extension startup, the update notice, or the footer must update the corresponding tests in `test/pi-update-notice.test.js` or `test/extension-status.test.js` in the same commit.

## Release
- Releases follow `.pi/skills/pi-sync-publish/SKILL.md`: staged publishing only, never `npm publish`; only a committed and pushed state is staged; the commit subject carries the version (e.g. `Add X (v1.y.z)`).
