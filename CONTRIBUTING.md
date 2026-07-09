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
- **Packs are content-addressed and must pass the review gate.** A generated set
  is approved by `ax-eval review --approve`, which writes a `*.approval.json`
  keyed on a sha256 of the reviewable fields. Any edit to the pack re-closes the
  gate, so re-run `review` after changing a pack. No AI-approves-AI.
- **Generation is an authoring aid.** Default `generate` is LLM-assisted after a
  rule-derived seed; `generate --deterministic` is the keyless fixture path. Both
  paths must produce schema-valid packs, and neither path replaces human review.
- **DAEB-1 draft iterations stay v1.** Before human freeze, re-synthesis
  overwrites the same v1 suite; git SHAs and content hashes identify exact draft
  states and invalidate stale approvals. Do not increment the suite version for
  authoring iterations or publish benchmark-of-record results from an unfrozen
  draft.

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
