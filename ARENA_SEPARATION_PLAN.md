# Separating `ax-eval` (core) from `ax-arena` (database benchmark)

Status: plan, partially implemented. The oracle-provider seam (see "Verification:
pluggable oracles") is already landed on this branch; the rest is proposal.

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

"ax-arena = ax-eval run x times" is directionally right but too coarse — arena
is not just a for-loop. It has three layers, and only the middle one is
ax-eval:

```
arena-authoring   roster → canonical suite → capability extracts →
                  per-vendor pack composition (frozen, comparable packs)
      │  produces TargetPacks
      ▼
   ax-eval        ONE pack × harness × surface × trial → execute →
                  read-back verify → report + normalized record
      ▲  called per cell (library import or CLI subprocess)
      │
arena-runtime     vendor × surface × harness cross-product, DAEB run
                  layout, cross-vendor scoring, freeze + publication
```

Key point: what arena reuses from ax-eval is **the execution cell and the
record/report primitives** — not task generation. The canonical suite pipeline
(arena-authoring) is deliberately *not* ax-eval's `generate`: `generate` asks
"given MY spec, invent tasks for MY product"; the canonical pipeline asks
"given ONE fixed vendor-neutral task set, project it onto every vendor so
scores are comparable and reproducible." Different contract, different owner.
That pipeline stays in arena permanently — it is what makes the benchmark a
benchmark.

### The API is local and in-process

The `ax-eval` public API is a **library API, not a service**. ax-arena consumes
it in the same process via `import { ... } from "ax-eval"`, exactly like any
npm dependency — no HTTP, no daemon, no hosted component. Arena uses it in two
local forms, both already present in today's code:

1. **Library import** (in-process function calls) — for orchestration,
   aggregation, and scoring, where arena needs the returned data structures.
2. **CLI subprocess** (`spawn("ax-eval", ["exec-plan", ...])`) — for the actual
   harness runs, where per-run process/env isolation matters. `cli.ts` already
   does this internally via `runCliSubcommand`.

If a hosted arena ever exists, it wraps *around* this local boundary; the
boundary itself does not change.

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
| Reporting / records | `src/generate/report.ts`, `record.ts` (minus `standard_set_version` semantics), `records-diff.ts` |
| Trial primitives | `aggregateNormalizedResults`, pass@k / consistency-at-N math, and a generic "run one pack N trials and aggregate" runner (promoted from arena — see note below) |
| Oracle plugin seam | `src/generate/oracle-provider.ts` (**implemented**) |
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
| Database oracles | `sql-session.ts`, `sql-verify.ts`, `mongo-verify.ts`, `surface-honesty.ts` — registered as core oracle providers, see below |
| Matrix orchestration | `low-pass.ts`, `production-run.ts` — the vendor × surface × harness cross-product, DAEB run-directory layout, archive policy |
| Publication | `publication.ts`, `schemas/normalized-result.v1.json` (published contract) |
| Data | `benchmarks/daeb/**` (roster, extracts, suite, per-vendor packs, ledgers) |

### Matrix orchestration: what's reusable vs. arena-specific

Trial repetition is *not* inherently an arena concept — a single vendor also
wants "run my pack 3 times, tell me pass^3 and which tasks are flaky." So the
bucket splits:

- **Core (reusable):** the trial loop over ONE pack, `aggregateNormalizedResults`,
  mean/range/pass@k/task-consistency-at-N math, trial/aggregate directory
  convention for a single target. (`aggregateNormalizedResults` already lives
  in core `record.ts`; the chain's `production-run.ts` per-cell trial logic
  gets promoted into a core "trial runner" during Phase 1.)
- **Arena:** iterating that cell over the vendor roster, the DAEB dated run
  root (`daeb-v1-YYYYMMDD`), vendor ordering, debug-artifact archive policy,
  and everything keyed to the frozen benchmark-of-record.

### Genuinely ambiguous (decide explicitly)

- `records-diff.ts` — a record-comparison utility with zero vendor coupling, but
  today only the arena CI (`records-diff.yml`) uses it. **Proposal:** keep the
  pure diff in core; keep the CI workflow in arena.
- `surface-honesty.ts` — generic idea ("did the agent really use the named
  surface, not a side channel?"), but its live rules are DB-shaped (`api` ≠ raw
  `pg`/SQL). **Proposal:** arena for now; promote a generic core hook later if a
  second vertical needs it.
- `health-check.ts` / `spec-summary.ts` — no vendor coupling; **core**.

## Verification: pluggable oracles (implemented)

The chain fuses DB verification into core by importing `sql-verify.js` /
`mongo-verify.js` directly inside `verify.ts` and branching inline on
`oracle.sqlQuery` / `oracle.mongoQuery`. The decoupled design inverts that:
**core defines an oracle-provider interface; arena registers SQL/Mongo
implementations into it.**

This seam is now landed on this branch as
[src/generate/oracle-provider.ts](./src/generate/oracle-provider.ts):

```ts
interface OracleProvider {
  id: string;                                  // "sql", "mongo", ...
  matches(oracle: OracleSpec): boolean;        // claims a spec
  verify(oracle, ctx): Promise<OracleResult>;  // runs the read-back
}
registerOracleProvider(provider);
```

`verifyGeneratedPack` consults registered providers first for every oracle;
unmatched oracles fall through to the built-in HTTP round-trip (REST +
GraphQL), which remains core's default truth layer. Provider errors are
contained as failed oracle results. With no providers registered, behavior is
byte-for-byte unchanged (covered by tests).

When the chain lands, its `verify.ts` edits are replaced by two registrations
in arena startup code:

```ts
registerOracleProvider(sqlOracleProvider);    // matches oracle.sqlQuery
registerOracleProvider(mongoOracleProvider);  // matches oracle.mongoQuery
```

Schema note: the SQL/Mongo oracle fields (`sqlQuery`, `mongoQuery`,
`sqlRoleTemplate`, …) already leaked into core `OracleSpecSchema` on `main`
via #115–#117. They can stay short-term (they're inert without a provider);
Phase 1 moves them to an arena schema extension and core's `OracleSpecSchema`
becomes passthrough for provider-owned fields.

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

// Verification (read-back truth layer + vertical oracle plugins)
export { verifyGeneratedPack } from "./generate/verify.js";
export {
  registerOracleProvider, type OracleProvider, type OracleVerifyContext,
} from "./generate/oracle-provider.js";

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

### Phase 0 — establish the boundary (cheap, no moves)
- Add `src/index.ts` with the public API above; add `package.json` `exports`.
- Add a lint/CI guard (dependency-cruiser or an ESLint `no-restricted-imports`
  rule) asserting: **no file under an `arena/` path is imported by core**, and
  **arena imports of core go only through `ax-eval` (the barrel)**.
- No files move yet. The oracle-provider seam (already landed on this branch)
  is the first Phase-0 piece; the barrel and guard follow once the chain has
  merged (see "Strategy vs. the open PR chain").

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

### Strategy vs. the open PR chain: merge first, decouple after

Two options were considered for the `codex/exready-*` stack (#138→#171):

- **(a) Edit inside the stack** — reroute each slice's imports through the
  boundary as part of its review.
- **(b) Merge the stack as-is, then decouple in one follow-up round.**

**Decision: (b).** Rationale:

1. The stack's entire review contract is "the cumulative tip reproduces #137
   exactly, checked by a parity audit." Refactoring inside the slices destroys
   the invariant the stack exists to prove, and restarts its review.
2. Any structural edit at slice k forces a rebase + force-push of every slice
   above it — up to 33 branches per change, repeatedly. That is where "越弄越乱"
   actually comes from.
3. It would mix two unrelated review questions ("was the restoration faithful?"
   vs "is the architecture right?") in the same PRs.

So the sequencing is:

1. **Chain #138–#171 reviews and merges unchanged.** No new PRs are inserted,
   no slices are rewritten.
2. **This branch (`claude/pr-chains-axeval-arena-separation-0sl2tf`) is the
   single decoupling round**, rebased onto post-merge `main`. It carries this
   plan, the oracle-provider seam (already implemented here), and then Phase
   0 + Phase 1: the barrel, the import guard, re-registering `sql-verify` /
   `mongo-verify` as oracle providers, and quarantining arena modules under
   `src/arena/**`. One PR total.
3. Phase 2 (package split) is its own later round, only if/when we want
   separately publishable packages.

Known cost of this order: the chain rewrites `verify.ts` (inline SQL/Mongo
branches), so the post-merge rebase of this branch re-applies the provider
delegation onto the chain's version of `verifyRoundtrip` and converts its
inline branches into the two provider registrations. That conflict is small,
localized, and expected — it is the decoupling work itself.

From then on, the Phase-0 import guard keeps every future PR honest: a change
that makes core import arena, or arena reach past the barrel, fails CI.

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

## Current status / next steps

1. **Done (this branch):** this plan; the oracle-provider seam
   (`src/generate/oracle-provider.ts` + `verify.ts` delegation + tests; full
   suite green, no behavior change without registered providers).
2. **Next:** review/merge the `codex/exready-*` chain unchanged.
3. **Then (same branch, post-merge rebase):** barrel + `exports` + import
   guard; convert the chain's inline SQL/Mongo verify branches into oracle
   providers; quarantine arena modules under `src/arena/**`; split the CLI;
   promote the generic trial runner to core.
4. **Later, optional:** Phase 2 package split.
