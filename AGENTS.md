# pi-sync — navigation

Manifest-driven CLI that applies explicitly managed Pi resources, plus the first-party Pi extension and agent skill it ships.

## Layout
- `src/` — TypeScript CLI, built to `dist/` by `tsconfig.json` (only `src/` is compiled by the main build)
- `resources/extensions/pi-sync/` — first-party Pi extension (`index.ts` + `status.js` + `process.js`); shipped and loaded by the user's Pi at runtime, not by this repo's build
- `resources/skills/pi-sync/` — first-party agent skill (shipped)
- `test/` — `node:test` suite (incl. the tarball allowlist test); `test-support/` — helpers
- `README.md` — user-facing spec for the manifest format and commands
- `.pi/skills/pi-sync-publish/SKILL.md` — release (staged npm publish) workflow
- `REVIEW.md` — project review invariants (read by the review agent)

## Checks
- `npm test` — build + typecheck (CLI and extension) + full `node --test` suite
- `npm run typecheck` — CLI via `tsconfig.json`; extension via `tsconfig.extension.json` against the pinned `@earendil-works/pi-coding-agent` version in `devDependencies`

## Installed Pi runtime
To verify runtime behavior, inspect the installed Pi rather than assuming. `$(command -v pi)` is a pnpm shim whose exec line names the exact installed path of `@earendil-works/pi-coding-agent` (a content-hashed pnpm global store path). Readable, non-minified sources live under that package's `dist/` (e.g. `dist/utils/version-check.js`, `dist/modes/interactive/interactive-mode.js`, `dist/main.js`); `dist/bundle/` is minified.
