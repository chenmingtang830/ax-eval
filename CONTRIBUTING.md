# Contributing to AX eval

Thanks for wanting to help. AX eval is the **integration test for Agent
Experience (AX)** — we run real agents against a SaaS product's SDK and measure
whether they actually succeed. This guide covers how to get set up, the project
conventions, and what we expect on a PR.

By participating you agree to our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Setup

Node 22+ is required (see `engines` in `package.json`).

```bash
npm ci            # install exactly what the lockfile pins
npm run build     # bundle the CLI to dist/ (tsup)
npm test          # vitest — 152 tests, all keyless/offline
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

## Adding a new target

A new SaaS is **a pack, not code.** The runner is target-agnostic: a pack
*declares* its `auth` (which env var holds the credential and the scheme) and its
`sandbox_scope` (the isolation the developer must provision), and `check-env`,
the executor prompt, and the verifier all read those declarations.

To add one, drop a `targets/<name>/pack.yaml` (model it on
`targets/asana/pack.yaml` for REST or `targets/linear/pack.yaml` for GraphQL),
declare its `auth` / `sandbox_scope` / any required `headers`, then run
`ax-eval check-env --pack <pack>` and `ax-eval review --pack <pack> --approve`.
If you need a code change to land a new target, that's a signal the abstraction
is missing something — call it out in the PR.

## Pull requests

- **Tests green.** CI runs `npm ci → npm run typecheck → npm test` on Node 22.
  A PR is expected to keep all three passing.
- Keep changes focused; match the existing voice in the README and docs.
- If you're changing the buildable shape of the open skill, keep `SKILL.md`
  (the host-agent workflow) and the zod schemas in `src/schemas.ts` (the
  `Task` / `TargetPack` / `RunResult` contract) in sync — those are the
  source of truth a contributor needs.
