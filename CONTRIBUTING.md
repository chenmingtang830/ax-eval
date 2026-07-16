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
`npm ci`. Keys are only needed for the *live* generated pipeline; copy
`.env.example` to `.env` and fill in the target section for that.

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
- **No committed secrets.** Real keys live only in `.env` (gitignored). Use
  `.env.example` as the template and never paste tokens, real workspace ids, or
  personal identifiers into tracked files. `results/` is gitignored — keep run
  artifacts out of commits.
- **Content-address publication inputs.** Every present publication artifact and
  aggregate record needs a lowercase SHA-256 in manifest v2. Never update a path
  without updating its digest, and keep digest-mismatch tests keyless and local.
- **Packs are content-addressed and must pass the review gate.** A generated set
  is approved by `ax-eval review --approve`, which writes a `*.approval.json`
  keyed on a sha256 of the reviewable fields. Any edit to the pack re-closes the
  gate, so re-run `review` after changing tasks, verifiers, headers, credentials,
  or CLI/SDK/MCP execution configuration. No AI-approves-AI.
- **Unsupported tasks stay explicit.** Use `na: true` with a concise
  `na_reason` and official `support_evidence`; an empty `allowed_surfaces` list
  means unrestricted, not N/A.
- **Generation is an authoring aid.** Default `generate` is LLM-assisted after a
  rule-derived seed. Product presets can add hints for the authoring pass, but
  the validator still owns schema fidelity and minimum surface coverage; failed
  drafts get one repair pass before surfacing an error. `generate --deterministic`
  is the keyless fixture path. Both paths must produce schema-valid packs, and
  neither path replaces human review.
- **Concept skill is reviewed identity.** Preserve the concept universe's
  kebab-case `skill` through coverage selection and canonical suite synthesis.
  Do not introduce a family taxonomy into capability, concept, selection, or
  methodology artifacts. Review concept diversity directly, and do not split
  equivalent normalized capabilities because vendors label them differently.
- **Canonical benchmark changes require trace calibration.** Keep the fixed
  sample review in `suite.trace-review.yaml`; completion requires a reviewer,
  review timestamp, commit SHA, and every unique trace ID in the declared
  sample. Missing or pending evidence must keep the authoring audit failing.
- **Discovery contracts are reviewed inputs, not heuristics.** When behavioral
  discovery is scored, declare `discovery` in the vendor compose config and
  review its goal, official domains, canonical action, deprecated markers, and
  auth scheme. Do not derive write actions from read-back oracles or prose.
- **Access-control success needs an independent denial check.** Use an
  error-outcome oracle with explicit HTTP statuses or a non-secret SQL driver
  field, using a verifier-controlled Postgres role where needed. Never pass a
  task because the agent merely said a restricted action failed, and never
  treat an unexpected verifier error or role-setup failure as the expected
  query denial.
- **Normalize generator shape narrowly.** Capability extraction may wrap a bare
  top-level capability array in the requested envelope, but it must not repair,
  infer, or bypass invalid capability fields or evidence.
- **Spec seeds are reviewed inputs.** Use deterministic OpenAPI operation
  summaries to bound capability candidates, reject non-official remote sources,
  and retain source/count/truncation provenance in the extract. Do not author
  from an empty or truncated operation inventory. Validate remote hosts and
  redirects before reading response bodies, reject private-network resolution,
  bound source size, and require offline mode for local files.
- **Explicit spec mappings fail closed.** `--capability-spec` sources must be
  fetched exactly; do not replace a missing source with a generic fixture.
  Keep multi-vendor generator concurrency bounded, result ordering stable, and
  the capability-specific generator timeout finite.
- **Registry candidates are not executable truth.** Use sanitized candidates as
  bounded hypotheses for grounded surface extraction. Require domain alignment,
  bounded prompt size, official output evidence, and hashed seed provenance
  before writing an extract.
- **Persist registry seeds as reviewed artifacts.** Write them atomically under
  `targets/seeds/<vendor>/registry.yaml`; loaders must reject traversal, unsafe
  commands, unbounded arrays, and schema drift.
- **Keep registry ingestion keyless and explicit.** Map a local source document,
  review the sanitized seed, and pass its path per vendor. Do not auto-fetch a
  registry service or auto-apply a discovered seed. Reject oversized local
  source documents before parsing.

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
- Stdio MCP surfaces declare one executable in `server` and each argument in
  `args`; never encode a shell command or credential value in either field.
  Use `inherit` or `token` auth for stdio and reserve `oauth_app` for HTTP MCP.
- SQL and MongoDB outcome verification declares only connection environment
  variable names in the pack. SQL queries must be single-statement reads;
  MongoDB checks must use the declarative read operations. Never put a token,
  DSN, or connection string in a pack, result artifact, or fixture.

Also note that `profile` and `surface` are different axes: the pack declares
which product surfaces exist, while harness profiles vary execution settings
(effort/model/autonomy). Do not use profiles to smuggle in or hide surfaces.

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
