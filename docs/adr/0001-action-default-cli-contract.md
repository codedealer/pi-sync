# Action-default CLI contract: verbs act, `--dry-run` previews

Pi Sync's command surface had grown two preview/commit patterns (default-preview plus a commit flag on some verbs, separate plan/apply verbs on others), four different flag names for "actually do it" (`--apply`, `--confirm`, `--publish`, `--approve`), verbs that did not do what their names said (`remove` left the resource installed, requiring `prune` to complete the action), and an output contract that claimed to be an agent API while emitting human-formatted pretty-printed JSON by default. We decided on one template: **every verb performs its action and `--dry-run` runs the same workflow in preview mode**; the verb set is condensed so each verb is a complete, honest action (14 → 11: `plan` merges into `status`, `register` into `add`, `prune` into `remove`); and output is tiered — compact agent-friendly text by default, condensed parseable JSON (`--json`, `apiVersion` 2) as the only stable machine contract, legacy two-space JSON behind `--json --pretty`.

**Status:** accepted

**Considered options:**

- Keep default-preview plus per-command commit flags (status quo): the flag vocabulary stays per-command, and `apply` remains an exception to its own preview rule.
- A separate preview verb for every action (plan-style): doubles the verb count, and "preview" is not an action users ask for.
- Chosen: action-default with a single unified `--dry-run` (the git/npm convention). The preview-then-act pair is the authorization mechanism for publish and removal; the only remaining approval flag is `--approve-installs`, for the one action that cannot be two-staged (non-interactive first-time package installs).

**Consequences:**

- Breaking, hard cut: deleted verbs and flags are not aliased. The CLI, first-party extension, skill, and README ship in one package and are updated together via `bootstrap`; between a package upgrade and the bootstrap rerun, the old installed extension cannot parse the text default and its footer shows the designed check-failed state until refreshed.
- The managed diff appears only in `push --dry-run` (on stdout); the publish happy path reports a short confirmation. The pre-publication stderr preview channel and the publish digest fields are removed.
- The text tier is deliberately not a versioned machine contract; it may evolve across minor versions as long as decision-relevant facts remain present.