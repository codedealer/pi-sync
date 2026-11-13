---
name: pi-sync-publish
description: Release a new version of the @codedealer/pi-sync npm package by staging it for human 2FA approval. Use when asked to publish, release, or bump a pi-sync npm version.
---

# Publishing @codedealer/pi-sync

Publishes go through npm's staged publishing flow, never a direct `npm publish`. The npm account enforces 2FA (proof of presence) for publishing, and registry tokens — including granular tokens with bypass or trusted publishing — cannot satisfy that prompt, so an automated agent cannot publish directly. `npm stage publish` exists for exactly this: it stages the package without a 2FA prompt (any token type works) and defers the 2FA gate to a later human approval.

## Rules

- Never run `npm publish` for this package, and never try to work around the 2FA requirement (no OTP guessing or relayed OTPs, no alternate unauthenticated sessions, no registry workarounds). If staging fails, stop and explain the structured error.
- Only the user approves or rejects a staged package. `npm stage approve` and `npm stage reject` prompt for 2FA. Hand the user the exact command with the stage id instead of running it yourself, unless the user is at the terminal and explicitly asks you to run it.
- Stage only a committed state: the version bump and all release changes are committed and pushed before staging, so the staged tarball matches a pushed commit.

## Release workflow

1. Confirm the release changes are in place and `npm test` (`node --test`) passes.
2. Bump `version` in `package.json` (patch for fixes, minor for additive features, major for breaking changes). The version must be new: staged and published versions share the same semver uniqueness index, and a version that already exists cannot be staged or published again.
3. Review the exact tarball contents:

   ```sh
   npm stage publish . --dry-run
   ```

   The tarball must contain only the `package.json` `files` allowlist (`README.md`, `src/cli.js`, `src/packages.js`, `src/prerequisites.js`, `resources/skills/pi-sync/SKILL.md`, `resources/extensions/pi-sync/index.ts`, `resources/extensions/pi-sync/README.md`). If the release adds or moves a shipped file, update the `files` allowlist in the same commit and re-check the dry-run.
4. Commit the version bump with the release subject convention used by this repo (for example `Add feature X (v1.4.0)`), push to the default branch, then stage:

   ```sh
   npm stage publish .
   ```

   This packs the directory and places that version on the registry in a non-public staged state. It does not prompt for 2FA and does not make the package available. Add `--tag <tag>` only if the user requested a dist-tag other than `latest`. Note the stage id from the output; `npm stage list` shows all staged versions.
5. Hand off to the user: report the package name and version, the stage id, and the approval command:

   ```sh
   npm stage approve <stage-id>
   ```

   The user runs it with their 2FA enabled; only then does the staged package go live. If the user declines or the staged package is wrong, the stage is cancelled with `npm stage reject <stage-id>` (also 2FA). A rejected stage is removed, freeing that version for a corrected re-stage.
6. After the user confirms approval, verify the release is live and report back:

   ```sh
   npm stage list
   npm view @codedealer/pi-sync version
   ```

## Inspecting staged packages

- `npm stage list` — list all staged versions (no 2FA).
- `npm stage view <stage-id>` — details of one staged version (no 2FA).
- `npm stage download <stage-id>` — download the staged tarball for inspection (no 2FA).
- `npm stage approve <stage-id>` / `npm stage reject <stage-id>` — require 2FA; human steps.

## Notes

- You can stage multiple versions of the package at once, and ordinary publishing still works while staged packages are pending.
- `npm stage publish` has parity with `npm publish`: it respects `"private": true` (refuses to stage) and `--access`.
- Prerequisites: the npm account has write access to `@codedealer/pi-sync`, the package already exists on the registry, and the account has 2FA enabled.
- This is a project skill for this repository (`.pi/skills/`); it is deliberately not part of the `files` allowlist and is not shipped in the npm package.