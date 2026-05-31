# Implementation notes — what's actually built

**Updated:** 2026-05-31 · **Status:** keyless v0 skeleton (M0.5)

> This is the **backward-looking** complement to [`plan.md`](./plan.md). `plan.md`
> says what we *intend* to build (milestones, decisions, open questions); this
> file records what *exists today*, file by file, so you don't have to read the
> source or the git log to track the codebase. When they disagree, the code wins
> — update this file.

See [`architecture.svg`](./architecture.svg) for the visual overview.

## How it runs (no keys)

```bash
npm install
npm run ax-eval -- run --offline     # behavioral matrix + static audit + the gap
npm run ax-eval -- audit --offline   # static (agent-readiness / AEO) audit only
npm test                             # 34 vitest tests, all offline
```

Everything runs with **no API keys**: behavioral eval uses fake harnesses + mock
oracles; static eval uses real HTTP with an offline-fixture fallback.

## Execution flow

1. **CLI** (`src/cli.ts`) parses the command + flags, then `loadDotenv()` and
   `loadPack()` (`src/config.ts`) read `.env` and the target pack YAML, validated
   by zod (`src/schemas.ts`).
2. **Behavioral** — `run()` (`src/runner.ts`) loops every task × harness. Each
   harness (`src/adapters/`) reports a *world state* + trace; oracles
   (`src/oracles.ts`) score that world → a `RunResult` per cell.
3. **Static** — `auditSite()` (`src/static/audit.ts`) runs the readiness checks
   (`src/static/checks.ts`) via the `Fetcher` (`src/static/fetcher.ts`), producing
   a weighted 0–100 score.
4. **Report** — `src/reporting.ts` renders the task×harness matrix + pass rates;
   `src/static/render.ts` renders the audit table and the **gap** (static score
   vs. best real-agent pass rate). `src/storage.ts` saves the run as JSON.

## File-by-file map

### Project config (root)

| Path | What it is |
|---|---|
| `package.json` | Node project: deps (`zod`, `yaml`), scripts (`ax-eval`/`build`/`test`/`typecheck`), Node 22+ |
| `package-lock.json` | npm dependency lockfile |
| `tsconfig.json` | TypeScript config (strict, ESM) |
| `.gitignore` | ignores `node_modules/`, `dist/`, `results/`, `.env`, … |
| `.env.example` | key template (Asana PAT + verify key, Anthropic, OpenAI, Hermes); none required for the keyless path |

### `src/` — core engine

| Path | Responsibility |
|---|---|
| `src/schemas.ts` | The four core schemas via zod: `Task`, `TargetPack` (incl. `site_url`), `OracleSpec`, `RunResult`. `Task.title` is optional and falls back to `id`. |
| `src/oracles.ts` | Programmatic checks over reported world-state: `exists` / `equals` / `contains`, addressed by dotted paths. |
| `src/runner.ts` | Orchestrates N tasks × M harnesses → `RunReport`; helpers `matrix()`, `passRate()`; records which harnesses are `synthetic`. |
| `src/reporting.ts` | Renders the behavioral matrix + pass rates. Reuses `runner.matrix()`; unrun cells show `—` (not `FAIL`). |
| `src/storage.ts` | Save / load a `RunReport` as JSON (`results/`). |
| `src/config.ts` | `loadDotenv()` (minimal `.env` parser) + `loadPack()` (YAML → validated `TargetPack`). |
| `src/cli.ts` | `ax-eval` entry: `run` / `audit` / `report` / `list-harnesses`; flag parsing with clear errors. |

### `src/adapters/` — harnesses (the agent runtimes)

| Path | Responsibility |
|---|---|
| `src/adapters/base.ts` | `HarnessAdapter` abstract class: `attempt()` → world+trace, `run()` scores it; flags `requiresKey`, `keyEnv`, `synthetic`. |
| `src/adapters/mock.ts` | Deterministic fake harness; `skip`/`wrong` options simulate competence. A flawless mock auto-marks `synthetic` (a control, not a real agent). |
| `src/adapters/hermes.ts` | **Keyless stub** for the planned Hermes harness (real provider/auth TBD). |
| `src/adapters/registry.ts` | Name → factory registry. Registers `mock`, `mock-weak`, `hermes`. Real `claude-code`/`codex` adapters slot in here at M1. |

### `src/static/` — static (agent-readiness / AEO) audit

| Path | Responsibility |
|---|---|
| `src/static/types.ts` | Audit types: `StaticCheckResult` (tri-state `pass`/`fail`/`error`, weight, source), `StaticAudit` (score, errored count, `source: live\|fixture\|mixed`). |
| `src/static/checks.ts` | The 8-check readiness list: llms.txt, AGENTS.md, llms-full.txt, OpenAPI, MCP, official SDK, robots/sitemap, OAuth discovery. Distinguishes "errored" from "absent". |
| `src/static/fetcher.ts` | `Fetcher`: live HTTP (with timeout) + offline-fixture fallback; `fixtureName()` maps URL → fixture filename (root → `__root__`, includes query). |
| `src/static/audit.ts` | `auditSite()`: runs checks concurrently, computes the weighted score (errored checks excluded), derives provenance. |
| `src/static/render.ts` | `renderAudit()` (the check table) + `renderGap()` (static score vs. best **real-agent** harness; excludes synthetic controls; "not run" ≠ "0%"). |
| `src/static/fixtures/` | Saved sample responses so the audit runs offline (see its `README.md`). Files: `asana.com_llms.txt`, `…_llms-full.txt`, `…_openapi.json`, `…_robots.txt`, `…_.well-known_oauth-authorization-server`, `…___root__`. |

### `targets/` — target packs

| Path | What it is |
|---|---|
| `targets/asana/pack.yaml` | The reference pack: 8 Asana tasks + oracle specs, plus `site_url`, `base_url`, `auth_method`, `docs_urls`. |

### `tests/` — vitest suite (34 tests, all keyless/offline)

| Path | Covers |
|---|---|
| `tests/oracles.test.ts` | the three oracle types |
| `tests/registry.test.ts` | harness registry; Hermes is a keyless stub |
| `tests/runner.test.ts` | matrix shape; differing pass rates |
| `tests/config.test.ts` | pack loading; `.env` parsing |
| `tests/schemas.test.ts` | `title` → `id` fallback; minimal pack loads |
| `tests/reporting.test.ts` | matrix render + save/load; unrun cell shows `—` |
| `tests/static.test.ts` | offline audit; errored ≠ absent; fixture-name collisions |
| `tests/gap.test.ts` | synthetic controls excluded; "not run" ≠ "0%" |
| `tests/cli.test.ts` | unknown command → usage; missing flag value → clear error |

## Not built yet (needs keys / later milestones)

- Real harness adapters: `claude-code` (`claude -p`), `codex` (`codex exec`), and a minimal floor harness — M1.
- Live API-readback oracle types (query Asana with `ASANA_VERIFY_PAT` → `ASANA_PAT`) — M1.
- `targets/asana/setup.ts` / `reset.ts` (sandbox provisioning + cleanup between attempts) — M1.
- Hermes's real provider/auth (currently a keyless stub).
- The editorial eval set (cross-competitor comparison) — deferred.
