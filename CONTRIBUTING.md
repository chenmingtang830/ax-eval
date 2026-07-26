# Contributing to ax-eval

Thanks for wanting to help. ax-eval is the **integration test for agent usability**
— we run real agents against a SaaS product's surfaces and measure whether they
can actually complete verified sandbox workflows. This guide covers how to get
set up, the project conventions, and what we expect on a PR.

By participating you agree to our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Setup

Node 22+ is required (see `engines` in `package.json`).

```bash
npm ci            # install exactly what the lockfile pins
npm run build     # bundle the CLI to dist/ (tsup)
npm test          # vitest — all keyless/offline
npm run typecheck # tsc --noEmit, must be clean
```

The full test suite is **keyless and offline** — it needs no API keys and makes
no network calls. You should be able to run `npm test` immediately after
`npm ci`. Keys are only needed for the *live* generated pipeline; copy the
relevant section from `.env.example` to `.env` for ordinary targets, or from
`ax-arena/benchmark/.env.example` for a reviewed DAEB cohort.

The quickest local sanity check:

```bash
npm run ax-eval -- run --offline    # behavioral matrix + static gap, no network
```

While developing from a clone, prefer `npm run ax-eval -- <command>` so you are
running the local TypeScript entrypoint rather than any globally installed
package. If you need to test the installed command shape, run `npm run build`
and then `npm link` or `node dist/cli.js <command>` from the checkout.

If you are new to the repo, also open one of the full HTML examples in
[`examples/`](./examples/) before changing reporting
or target-pack behavior. They are the fastest way to see the intended output
shape.

## Conventions

- **TypeScript, ESM, Node 22.** `"type": "module"` — use ESM imports, not
  CommonJS. Keep the code typed; `npm run typecheck` must stay clean.
- **Tests are vitest.** New behavior needs a test. Tests must stay keyless and
  offline — no live network, no real credentials. Use fixtures (see
  `src/static/fixtures/`) and the keyless mock harnesses.
- **No committed secrets.** Real keys live only in `.env` (gitignored). Use the
  root `.env.example` for generic targets and `ax-arena/benchmark/.env.example`
  for DAEB cohorts; never paste tokens, real workspace ids, or personal
  identifiers into tracked files. Runtime/tool identity comes only from the
  committed arena runtime lock. `results/` is gitignored — keep run artifacts
  out of commits.
- **Packs are content-addressed and must pass the review gate.** A generated set
  is approved by `ax-eval review --approve`, which writes a `*.approval.json`
  keyed on a sha256 of the reviewable fields. Any edit to the pack re-closes the
  gate, so re-run `review` after changing a pack. No AI-approves-AI.
- **Runtime recompilation must preserve that approval.** DAEB orchestration may
  write a run-scoped compiled pack only after proving its reviewable content
  matches the committed approved pack. Stage the existing human approval and
  let `exec-plan` check it normally; never add an orchestration-only
  `--skip-review` bypass.
- **Failed live trials must not leak state forward.** Preserve results and
  verification artifacts first, then record namespace cleanup. If cleanup is
  missing, unsupported, or errors, halt the lane before another trial starts.
- **One cell has no benchmark policy.** `runCell` and `ax-eval cell run` execute
  one fully specified reviewed pack/surface/harness/model/effort/trial and use
  the caller-supplied batch id. Roster expansion, trial counts, aggregation,
  ranking, publication, and cleanup policy belong to the controller.
- **Runtime extensions are explicit and versioned.** Build an immutable
  per-cell registry; do not add ambient provider discovery or target-name
  dispatch. Health checks precede provisioning, environment changes are
  additive, and reset remains after verified-record persistence.
- **Generation is an authoring aid.** Default `generate` is LLM-assisted after a
  rule-derived seed. Product presets may add hints and surface-specific task
  shaping, but schema validation and the review gate remain authoritative;
  `generate --deterministic` is the keyless fixture path. Neither path, nor
  `automate-report`, replaces human review.
- **DAEB-1 draft iterations stay v1.** Before human **publication** freeze,
  re-synthesis overwrites the same v1 suite; git SHAs and content hashes identify
  exact draft states and invalidate stale approvals. Do not increment the suite
  version for authoring iterations or publish benchmark-of-record results from an
  unfrozen draft. **Current status:** authoring freeze is done for the 6-vendor
  core cohort (packs approved; trace review completed); production 3-trial and
  publication freeze are deferred until after team review.
- **Freeze the vendor cohort before task outcomes.** The DAEB vendor-selection
  ledger records core, research, and excluded candidates using managed-sandbox,
  headless-auth, benchmark-surface, and product-stratum criteria. Only core
  vendors affect synthesis and production order.
- **Concept coverage is not task applicability.** DAEB coverage artifacts retain
  ranked capability candidates and same-surface capability bundles. A support
  cell may be enabled only when its bundle satisfies every concrete task
  requirement; never promote the first broad concept match directly into the
  denominator.
- **Trace review is a real freeze gate.** Re-synthesis resets the memo to
  `pending`; mark it complete only after reviewing the full fixed sample and
  recording sample IDs, reviewer, timestamp, commit SHA, and findings.

## Adding a new target

A new SaaS is **a pack, not code.** The runner is target-agnostic: a pack
*declares* its `auth` (which env var holds the credential and the scheme) and its
`sandbox_scope` (the isolation the developer must provision), and `check-env`,
the executor prompt, and the verifier all read those declarations.

To add one, start from `ingest → generate → review` when a public OpenAPI or
GraphQL surface exists, or hand-write `targets/examples/<name>/pack.yaml` when the target
needs curation. Model REST packs on `targets/examples/notion/pack.yaml` or
`targets/examples/stripe/pack.yaml`; model GraphQL packs on `targets/examples/linear/pack.yaml`.
Declare `auth` / `sandbox_scope` / any required `headers`, then run
`ax-eval check-env --pack <pack>` and `ax-eval review --pack <pack> --approve`.
If you need a code change to land a new target, that's a signal the abstraction
is missing something — call it out in the PR.

Two details matter for public packs:

- `auth.env` is the canonical API credential name, but packs may also declare
  `env_aliases` / `verify_env_aliases` for older local env setups.
- SDK/CLI/MCP surfaces declare their own auth contract in `surfaces.*.auth`.
  Token-based surfaces can add `token_env_aliases`; OAuth-only surfaces should
  be modeled as `kind: oauth_app` so the report shows an honest blocked cell
  instead of a fake 0%.

Also note that `profile` and `surface` are different axes: the pack declares
which product surfaces exist, while harness profiles vary execution settings
(effort/model/autonomy). New live runs use the single `medium` effort profile;
legacy low/high artifacts remain readable. Do not use profiles to smuggle in or
hide surfaces.

## Pull requests

- **Tests green.** CI runs `npm ci → npm run typecheck → npm test` on Node 22.
  A PR is expected to keep all three passing.
- Keep changes focused; match the existing voice in the README and docs.
- If you're changing the buildable shape of the open skill, keep `SKILL.md`
  (the host-agent workflow) and the zod schemas in `src/schemas.ts` (the
  `Task` / `TargetPack` / `RunResult` contract) in sync — those are the
  source of truth a contributor needs.
- If you're changing publishable files, run `npm --cache .npm-cache pack
  --dry-run` and confirm the tarball contains only the public CLI, examples,
  target packs, and docs you intend to ship.
