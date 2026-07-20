# Separating `ax-eval` (core) from `ax-arena` (database benchmark)

Status: proposal / plan. No behavior change yet.

## Why this exists

We keep accidentally conflating two products that live in one repo:

- **ax-eval** — the building blocks. A generic engine that turns *one* product's
  spec/docs into a reviewed task pack, runs that pack through agent harnesses
  across `api` / `cli` / `sdk` / `mcp`, verifies real state with read-back
  oracles, and renders a report. Audience: a single vendor (or a few) who wants
  to know "can an agent use *my* product?"
- **ax-arena** — the scaled orchestration on top. The frozen **DAEB** database
  benchmark: a fixed vendor roster, a canonical suite, per-vendor pack
  composition, a multi-trial production matrix, cross-vendor scoring, and a
  publication bundle. Audience: someone reproducing "the entire pipeline from a
  frozen pack to scores across all these vendors."

Richard's framing: *"the execution should be more similar except for the
database benchmark; we're only focusing on api and cli."* Vaibhav's framing:
*"ax-arena runs off ax-eval, but people can enter their own tasks."* Both point
at the same target shape: **ax-arena = ax-eval run N times over a suite of
sources, plus arena-specific compile/score/publish logic.**

### What's actually wrong today

1. **There is no boundary to separate across.** There is no `src/index.ts` and
   no `exports` in `package.json` — the CLI (`dist/cli.js`) is the only
   entrypoint. Arena code doesn't consume a public ax-eval API; it lives *inside*
   `src/generate/` next to the core and reaches into internals freely.
2. **Arena logic sits in the shared engine directory.** `src/generate/` mixes
   generic building blocks (`pack.ts`, `verify.ts`, `report.ts`, `record.ts`)
   with database-vertical, cross-vendor, publication logic
   (`production-run.ts`, `low-pass.ts`, `publication.ts`, `synthesize-suite.ts`,
   `vendor-selection.ts`, `sql-verify.ts`, `database-task-fit.ts`, …).
3. **Arena concepts leak into core contracts.** `standard_set_version` flows
   through the generic `NormalizedResult`; the DAEB suite/vendor/publication
   schemas would land in the shared `src/schemas.ts`.
4. **The PR chain merges them together.** The open `codex/exready-*` stack
   (#138→#171) is a single line rooted at `main` that restores the whole DAEB
   arena into `src/generate/` and wires `daeb-*`, `synthesize-suite`,
   `publication-bundle`, etc. into the shared `cli.ts`. Merging it lands arena on
   ax-eval's `main`, in the ax-eval package.

So the only separation that exists today is **nominal** (`targets/examples/` vs
`benchmarks/daeb/`, and the "AXArena / DAEB" name in a comment). At the code,
schema, package, and branch level the two are fused.

## The seam

One rule, and everything else follows from it:

> **Dependencies point one way: `ax-arena` → `ax-eval`. Core must never import
> arena, and core must contain no vendor, database, DAEB, or publication
> concept.**

If a module names a specific vendor (neon, turso, supabase, …), knows the DAEB
suite, speaks SQL/Mongo, composes across a roster, or produces the publication
bundle, it is **arena**. If it operates on a single `TargetPack` without knowing
which product it is, it is **core**.

## Target architecture

```
ax-arena  (frozen DB benchmark: roster → suite → per-vendor packs →
           N-trial matrix → cross-vendor scores → publication)
   │  imports ONLY the ax-eval public API
   ▼
ax-eval   (spec → pack → run(api|cli|sdk|mcp) → read-back verify →
           report + normalized record), single product, vendor-agnostic
```

ax-arena's core loop becomes literally: for each vendor in the suite, compose a
`TargetPack`, then call ax-eval's `execPlan` + `verifyGeneratedPack` +
`normalizeResult`; then aggregate the normalized records across vendors/trials
and publish. That is the "ax-eval run x times" shape, made real by a dependency
edge instead of shared-directory osmosis.

## Module classification

Based on the current `main` tree plus everything the `codex/exready-*` chain
adds. "Shared" = stays in core, consumed by arena through the public API.

### Core — `ax-eval` (stays generic)

| Area | Modules |
|------|---------|
| Contracts | `src/schemas.ts` (core subset — see Schema split) |
| Pack | `src/generate/pack.ts`, `graphql-pack.ts` |
| Single-pack authoring | `src/generate/authoring.ts`, `review.ts`, `snapshot.ts` |
| Execution runtime | `src/harness/*` (`executor`, `invoke`, `mcp-provision`, `transcript`, `probe`, `profile`, `trace-diff`) |
| Surfaces | `src/surface/*`, `src/generate/surface-policy.ts` |
| Verification | `src/generate/verify.ts`, `verification-client.ts` (0 vendor coupling) |
| Discovery / static | `src/generate/discovery.ts`, `src/static/*` |
| Reporting / records | `src/generate/report.ts`, `record.ts` (minus `standard_set_version`), `records-diff.ts` |
| Ingest | `src/ingest/openapi.ts`, `graphql.ts`, `run.ts`, `spec-summary.ts` |
| Targets/runtime | `src/target/config.ts`, `reset.ts`, `health-check.ts` |
| Shared infra | `src/http/client.ts`, `src/util/json-parse.ts`, `src/safety/redaction.ts`, `src/generate/concurrency.ts` |
| Shared LLM infra | `src/generate/harness.ts` (LLM-invocation helper used by *both* core generate and arena tooling — stays in core, arena calls it) |
| Data | `targets/examples/*` (single-vendor reference packs) |

### Arena — `ax-arena` (moves out)

| Area | Modules |
|------|---------|
| Roster / vendors | `src/generate/vendor-resolve.ts`, `vendor-selection.ts`, `src/ingest/registry.ts` |
| Extraction | `capability-extract.ts`, `surface-extract.ts`, `task-extract.ts`, `extract-advisory.ts`, `extract-audit.ts`, `evidence-strength.ts` |
| Suite | `suite.ts`, `synthesize-suite.ts`, `suite-audit.ts`, `coverage-gap-check.ts`, `methodology.ts`, `benchmark-paths.ts` |
| Pack composition | `compose-pack.ts`, `pack-audit.ts`, `database-pack-overrides.ts`, `database-task-fit.ts` |
| Database grading | `sql-session.ts`, `sql-verify.ts`, `mongo-verify.ts`, `surface-honesty.ts` |
| Orchestration | `low-pass.ts`, `production-run.ts` |
| Publication | `publication.ts`, `schemas/normalized-result.v1.json` (published contract) |
| Data | `benchmarks/daeb/**` (roster, extracts, suite, per-vendor packs, ledgers) |

### Genuinely ambiguous (decide explicitly)

- `records-diff.ts` — a record-comparison utility with zero vendor coupling, but
  today only the arena CI (`records-diff.yml`) uses it. **Proposal:** keep the
  pure diff in core; keep the CI workflow in arena.
- `surface-honesty.ts` — generic idea ("did the agent really use the named
  surface, not a side channel?"), but its live rules are DB-shaped (`api` ≠ raw
  `pg`/SQL). **Proposal:** arena for now; promote a generic core hook later if a
  second vertical needs it.
- `health-check.ts` / `spec-summary.ts` — no vendor coupling; **core**.

## The minimal `ax-eval` public API

Create `src/index.ts` as the *only* surface arena is allowed to import. Anything
not exported here is private to core. This is the contract that lets the two
evolve independently.

```ts
// Contracts
export type {
  TargetPack, Task, OracleSpec, SurfaceConfig, SurfaceAuth,
  RunResult, OracleResult, DiscoverySpec, StaticScope,
} from "./schemas.js";
export {
  TargetPackSchema, TaskSchema, OracleSpecSchema, SurfaceConfigSchema,
} from "./schemas.js";

// Pack lifecycle
export { loadPack, validatePack } from "./generate/pack.js";

// Execution (one pack × harness × surface × effort)
export { execPlan } from "./harness/executor.js";     // build prompt / plan
export { invokeHarness } from "./harness/invoke.js";  // run a harness
export { tasksForSurface, taskSupportsSurface } from "./surface/types.js";

// Verification (read-back truth layer)
export { verifyGeneratedPack } from "./generate/verify.js";

// Reporting + normalized records
export { renderReport, renderCompetitive } from "./generate/report.js";
export {
  normalizeResult, aggregateNormalizedResults, type NormalizedResult,
} from "./generate/record.js";

// Discovery + reset
export { scoreDiscovery } from "./generate/discovery.js";
export { resetSandbox } from "./target/reset.js";

// Shared LLM-invocation helper for generation tooling
export { invokeGeneratorHarness } from "./generate/harness.js";
```

`package.json` gains:

```jsonc
"exports": {
  ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
  "./cli": "./dist/cli.js"
},
"main": "./dist/index.js",
```

ax-arena then imports `from "ax-eval"` — never `from "ax-eval/dist/generate/..."`.

## Schema split

`src/schemas.ts` stays the **core** contract: `TargetPack`, `Task`,
`OracleSpec`, `Surface*`, `Auth`, `RunResult`, `OracleResult`, `DiscoverySpec`,
`StaticScope` — everything that describes *one* pack and *one* run.

Move to `ax-arena` (new `arena/schemas.ts`): the suite/concept-universe,
coverage-matrix, selection-ledger, methodology, vendor-selection, and
publication schemas that the chain adds.

`standard_set_version` is the one field that already leaked into the core
`NormalizedResult`. Keep the field generic and optional in core (a free-form
provenance string, default `""`), but the value `"DAEB-1-v3"` and any validation
that it must be a DAEB set belong to arena. Core records a string; arena decides
what the string means.

## CLI split

Core (`ax-eval` bin) keeps the single-product commands:
`run, audit, discover, smells, report, ingest, generate, review,
automate-report, exec-plan, verify, verify-generated, render-generated,
competitive, trace-diff, reset, probe, check-env, init, list-harnesses`.

Arena (`ax-arena` bin) owns the roster/suite/publish commands:
`resolve-vendor, import-registry, extract-tasks, extract-surfaces,
extract-capabilities, audit-extracts, audit-suite, synthesize-suite,
compose-pack, publication-bundle, export-publication, daeb-low-pass,
daeb-production-rerun` (and the `records-diff` CI entry).

Mechanically, `src/cli.ts` splits into `core-cli.ts` (core switch cases) and
`arena-cli.ts`; the arena bin dispatches its own cases and delegates everything
else to core.

## Packaging: phased, not big-bang

A full two-package split is the destination, but it should not block the
separation. Do it in phases so each step is reviewable and green.

### Phase 0 — establish the boundary (this branch, cheap, no moves)
- Add `src/index.ts` with the public API above; add `package.json` `exports`.
- Add a lint/CI guard (dependency-cruiser or an ESLint `no-restricted-imports`
  rule) asserting: **no file under an `arena/` path is imported by core**, and
  **arena imports of core go only through `ax-eval` (the barrel)**.
- No files move yet. This makes the seam *enforceable* before the chain grows.

### Phase 1 — quarantine arena in-repo (`src/arena/**`)
- Move the Arena-classified modules into `src/arena/`, the DAEB data stays in
  `benchmarks/daeb/`, and rewrite their imports of core to go through the
  barrel. Split the CLI. Peel arena schemas out of `src/schemas.ts`.
- Still one package, one `npm install`, but the dependency edge is now real and
  guarded. This is the point at which "are they separated?" becomes *yes* in
  code, even before a package split.

### Phase 2 — split packages (npm workspaces)
- `packages/ax-eval` (core, published) and `packages/ax-arena` (depends on
  `ax-eval`). `benchmarks/daeb/**` and the arena bin move under `ax-arena`.
- `targets/examples/**` stays with core as reference packs.

### Re-cutting the open PR chain
The `codex/exready-*` stack (#138→#171) currently slices the *combined* system
"restore slice N of 34." Re-cut it along the seam instead:
1. Land Phase 0 (barrel + guard) on `main` first — small, independent.
2. Rebase the chain so **core-only** slices (runtime/verify/report hardening:
   e.g. #147–#154 executor/health/transcript/reset) target core and merge first.
3. Group the **arena** slices (vendor extract, suite synth, compose, database
   task-fit, production, publication: #138–#146, #155–#171) behind the
   `src/arena/**` boundary so they can't re-fuse into `src/generate/`.
4. The DAEB data slices (#161–#166 per-vendor artifacts) land under
   `benchmarks/daeb/` unchanged.

The guard from Phase 0 is what keeps every future slice honest: a PR that makes
core import arena, or arena reach past the barrel, fails CI.

## Definition of done

- `src/index.ts` is the only path arena imports from core; CI enforces it.
- `grep -rE "neon|turso|supabase|cockroach|insforge|nile|daeb|sql-verify" src/`
  scoped to core paths returns nothing.
- Core has no `standard_set_version` *semantics* (only a free-form string).
- A single vendor can `npm i ax-eval` and run `generate` → `exec-plan` →
  `verify` → `report` without pulling in any DAEB roster, suite, or publication
  code.
- ax-arena reproduces the DAEB matrix by calling the ax-eval public API per
  vendor, plus its own compile/score/publish.

## First reviewable step

Phase 0 only: add the barrel + `exports` + import guard, no file moves. It's
small, it's safe, and it's the thing that makes every later slice enforceably
separated. Everything else stacks on it.
