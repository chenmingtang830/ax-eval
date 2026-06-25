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
```

- **Node ≥ 22.** TypeScript, ESM.
- Prefer `npm run ax-eval -- <command>` while developing; it runs local source.
  Use `node dist/cli.js <command>` after `npm run build` only when you need to
  smoke-test the published CLI entrypoint.
- **Always run `npm test` and `npm run typecheck` before proposing a change.** CI
  (`.github/workflows/ci.yml`) runs both on Node 22 and is required to merge.

## Conventions that matter here

- **Tests are keyless and offline by default.** Never add a test that needs a
  live network call or a real credential. Use fixtures (`tests/fixtures/`).
- **Deterministic generation.** `generate` must produce the same pack from the
  same spec — no LLM in the v0 generation path. Don't introduce nondeterminism
  into `src/generate/pack.ts` / `graphql-pack.ts`.
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

## Where things live

- `src/cli.ts` — the `ax-eval` entrypoint and every command/flag.
- `src/ingest/` — OpenAPI + GraphQL ingestion.
- `src/generate/` — pack generation, review gate, verification, report, records.
- `src/harness/` — host-agent profiles, subprocess invoke (claude-code/codex),
  transcript + trace parsing, probe.
- `src/surface/` — API/CLI/SDK/MCP prompt adapters.
- `src/target/` — pack-declared auth + sandbox scope + reset.
- `src/static/` — static AEO audit (discoverability + OpenAPI smells).
- `targets/` — example target packs (Asana, Notion, Linear, Monday) + approvals.
- `tests/` — vitest suite; the de-facto behavior spec.
- `docs/` — **maintainer-local, git-ignored** (`roadmap.md`, `dev-guide.md`,
  `spec/`, `strategy/`). Present in a maintainer checkout, not on the public
  repo. `dev-guide.md` is the deepest file-by-file map if you have it.

## Adding a target

Prefer a **new pack over a code change**. Ingest a public spec, `generate`, then
`review --approve`. A new SaaS should usually be a pack plus, at most, a focused
test or oracle improvement. See `CONTRIBUTING.md`.

## Releasing / Publishing

The release artifact is a **GPG-signed git tag** plus the npm package. Bump
`package.json` with `npm version <x.y.z> --no-git-tag-version`, keep CI green,
then smoke-test the package contents with `npm --cache .npm-cache pack --dry-run`.
The tarball should contain `dist/`, `README.md`, `SKILL.md`, `.env.example`,
public examples/assets, and the curated `targets/*/pack.yaml` +
`targets/*/pack.approval.json` files — not `docs/`, `results/`, `.env`, or
scratch scripts. Tag the merge commit with `git tag -s v<x.y.z> <sha>` (signed,
not just `-a`), push the tag, then publish from the same clean checkout.
Pre-1.0 SemVer: a feature drop bumps the minor.

## Safety

Live evals make **real writes** — use a sandbox, never production, and keep
writes inside the scope the pack declares (for the Asana example, a single
sandbox project/portfolio). Don't add code paths that auto-delete; cleanup
(`reset`) is explicit and supports `--dry-run`.
