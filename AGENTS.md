# AGENTS.md — working on ax-eval

Instructions for coding agents (Codex, Claude Code, etc.) making changes **to
this repository**. (Running ax-eval *as* a harness against a target is a
different thing — see `SKILL.md`.)

## What this project is

`ax-eval` turns an OpenAPI/GraphQL surface into a reviewed task pack, asks a host
agent to complete real sandbox work, and verifies the result with programmatic
read-back oracles. It measures whether an agent can actually *operate* a product
across its **API / CLI / SDK / MCP** surfaces — not just whether the product is
published. Read `README.md` for the full pitch.

## Setup, build, test

```bash
npm install
npm test            # vitest — all keyless/offline, no network or secrets
npm run typecheck   # tsc --noEmit, must be clean
npm run build       # tsup → dist/ (required before package smoke tests)
npm run ax-eval -- <command>   # run the CLI in dev (tsx)
npm run ax-arena -- benchmark --help  # private arena workspace scaffold
```

- **Node ≥ 22.** TypeScript, ESM.
- Prefer `npm run ax-eval -- <command>` while developing; it runs local source.
  Use `node dist/cli.js <command>` after `npm run build` only when you need to
  smoke-test the published CLI entrypoint.
- **Always run `npm test` and `npm run typecheck` before proposing a change.**
  These root commands cover both `ax-eval` and the private arena workspace. CI
  (`.github/workflows/ci.yml`) runs both on Node 22 and is required to merge.

## Conventions that matter here

- **Tests are keyless and offline by default.** Never add a test that needs a
  live network call or a real credential. Use fixtures (`tests/fixtures/`).
- **Generation has two paths.** Default `generate` is LLM-assisted: it first
  builds a rule-derived seed from `src/generate/pack.ts` or `graphql-pack.ts`,
  then asks the configured generator harness to improve the pack. The
  `--deterministic` path must remain keyless, stable, and suitable for CI
  fixtures. Do not let LLM output bypass schema validation or human review.
- **The review gate is load-bearing.** Generated packs are executable intent.
  `exec-plan` refuses an un-reviewed or edited pack unless `--skip-review`.
  Changing a committed pack changes its content hash and re-opens approval — do
  not bypass this in code.
- **Verify reads LIVE state.** Round-trip oracles GET resources back from the
  product. Anything that mutates/cleans the sandbox (e.g. `reset`) must run
  **after** verify, never before — deleting first zeroes the scores.
- **Secrets stay local.** `.env` is git-ignored; only env-var *names* live in
  packs. Never commit a token, and never print secret values (the probe redacts
  to key-names-only — keep it that way).
- **Surface-aware everywhere.** API / CLI / SDK / MCP differ in discovery, auth,
  and trace expectations. A change to scoring/discovery/trace logic must not
  assume the REST shape (e.g. no `missing_call POST /tasks` on an MCP run).
- **Two harnesses, parsed in their native shape.** `claude-code`
  (stream-json `tool_use`, incl. the `Bash` tool + `mcp__*` names) and `codex`
  (`item.completed`: `web_search` / `command_execution`). Codex needs an
  OpenAI-strict `--output-schema` (every object `additionalProperties:false` +
  fully `required`) and `sandbox_workspace_write.network_access=true`. If you
  touch `src/harness/transcript.ts` or `invoke.ts`, keep both shapes working.
- **Match the surrounding code.** Comment density, naming, and idioms — read the
  neighbors before adding.

## Public change checklist

When behavior changes, update the public surface that teaches that behavior.
Use this before opening a PR:

- CLI command, flag, or output changes → update `README.md` command examples,
  `SKILL.md` workflow guidance, and CLI/help tests.
- Generation, review, schemas, or pack semantics change → update `README.md`,
  `CONTRIBUTING.md`, `ARCHITECTURE.md`, `SKILL.md`, and schema/review tests.
- Harness, transcript, profile, or invoke behavior changes → update
  `SKILL.md`, `ARCHITECTURE.md`, and harness/transcript tests for both Codex
  and Claude Code.
- Report scoring, recommendations, or HTML structure changes → update report
  tests/snapshots and refresh public examples/assets when the public artifact
  changed.
- Target, auth, surface, or env behavior changes → update `.env.example`,
  `targets/README.md`, affected pack approvals, and surface-auth tests.
- Package contents or release behavior changes → update `package.json` `files`,
  release notes/checklist text, and run `npm --cache .npm-cache pack --dry-run`.
- Always finish with `npm test` and `npm run typecheck`; also run
  `npm run build` when the CLI bundle or publish path could be affected.

## Where things live

- `src/cli.ts` — the `ax-eval` entrypoint and every command/flag.
- `src/ingest/` — OpenAPI + GraphQL ingestion.
- `src/generate/` — pack generation, review gate, verification, report, records.
- `src/harness/` — host-agent profiles, subprocess invoke (claude-code/codex),
  transcript + trace parsing, probe.
- `src/runtime/` — immutable per-cell extension registries and lifecycle seams.
- `src/surface/` — API/CLI/SDK/MCP prompt adapters.
- `src/target/` — pack-declared auth + sandbox scope + reset.
- `src/static/` — static readiness audit (discoverability + OpenAPI smells).
- `targets/` — target-pack index; example target packs live under
  `targets/examples/` (Notion, Stripe, Linear, Exa, Monday, Asana) with approvals.
- `benchmarks/daeb/` — canonical DAEB-1 suite, extracts, and compiled packs
  (separate from single-vendor `targets/examples/`). For current DAEB status
  (authoring freeze vs deferred production), maintainers use
  `docs/latest_plan.md`; facts live under `benchmarks/daeb/v1/`.
- `ax-arena/benchmark/` — private workspace boundary for arena-owned code. The
  workspace is a scaffold until the dependency-ordered relocation PRs move the
  canonical DAEB files and controller behavior.
- `tests/` — vitest suite; the de-facto behavior spec.
- `docs/` — **maintainer-local, git-ignored**. Live set is minimal:
  `latest_plan.md` (now), `roadmap.md` (phases), `dev-guide.md` (how),
  `communications.md` (claims). Everything else under `docs/_archive/`.
  Present in a maintainer checkout, not on the public repo.

## Adding a target

Prefer a **new pack over a code change**. Ingest a public spec, run
LLM-assisted `generate` for authoring (or `--deterministic` for fixtures), then
`review --approve`. A new SaaS should usually be a pack plus, at most, a focused
test or oracle improvement. See `CONTRIBUTING.md`.

## Releasing / Publishing

The release artifact is a **GPG-signed git tag** plus the npm package. Bump
`package.json` with `npm version <x.y.z> --no-git-tag-version`, keep CI green,
then smoke-test the package contents with `npm --cache .npm-cache pack --dry-run`.
The tarball should contain `dist/`, `README.md`, `SKILL.md`, `.env.example`,
public examples/assets, and the curated `targets/examples/*/pack.yaml` +
`targets/examples/*/pack.approval.json` files — not `docs/`, `results/`, `.env`, or
scratch scripts. Tag the merge commit with `git tag -s v<x.y.z> <sha>` (signed,
not just `-a`), push the tag, then publish from the same clean checkout.
Pre-1.0 SemVer: a feature drop bumps the minor.

## Safety

Live evals make **real writes** — use a sandbox, never production, and keep
writes inside the scope the pack declares (for the Asana example, a single
sandbox project/portfolio). Don't add code paths that auto-delete; cleanup
(`reset`) is explicit and supports `--dry-run`.
