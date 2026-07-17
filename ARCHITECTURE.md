# Architecture

`ax-eval` is a pack-centered, surface-aware agent usability eval system. It is
both:

- a **local engineering tool** for evaluating one product across API / CLI / SDK /
  MCP, and
- the **tooling foundation** for AXArena publication-grade benchmarks (DAEB-1
  first).

Both tracks converge on the same contracts and runtime: a reviewed `TargetPack`,
a harness × surface execution matrix, read-back oracles, and report / record
interpretation.

## Dual-track overview

```text
Tool track                              Benchmark track (DAEB)
─────────                               ─────────────────────
OpenAPI / GraphQL / docs                vendor cards + extracts
  -> ingest / generate                    -> synthesize suite
  -> TargetPack draft                     -> compose-pack per vendor
       \                                 /
        \                               /
         v                             v
              reviewed TargetPack
                       |
                       v
         exec-plan (harness x surface)
                       |
                       v
              verify (live read-back)
                       |
                       v
         normalized records + HTML report
                       |
                       v  (benchmark only, when unblocked)
         publication-bundle -> export-publication
```

| | **Tool track** | **Benchmark track** |
|---|---|---|
| Audience | Product team evaluating one SaaS | AXArena / DAEB publication |
| Source of truth | Per-product pack | Canonical `suite.yaml` + ledger |
| Packs live under | `targets/examples/` (shipped) or local `targets/` | `benchmarks/daeb/v1/packs/<vendor>/` |
| Authoring | `ingest` → `generate` → `review` | extract → synthesize → compose → `review` |
| Execution matrix | Whatever the pack declares | Benchmark-of-record: `api`+`cli`, Codex+Claude Code, medium, 3 trials |
| Extra gates | Content-hash approval | Ledger, audit-suite, trace-review, publication freeze |

Deep DAEB artifact detail lives in
[`benchmarks/daeb/README.md`](./benchmarks/daeb/README.md). Maintainer status
(authoring freeze vs deferred production) lives in gitignored
`docs/latest_plan.md`.

## Shared data flow

The engine data flow is the same once a pack exists:

```text
reviewed TargetPack
  -> exec-plan per harness x surface x effort
  -> results + trace + transcript
  -> round-trip verification
  -> normalized records
  -> HTML report / competitive report
```

Tool-track authoring reaches that pack via:

```text
spec/docs -> ingest -> generate (LLM-assisted or --deterministic) -> review
```

Benchmark-track authoring reaches that pack via suite synthesis and
`compose-pack` (see DAEB README). Re-synthesis or pack edits invalidate
content-hash approvals on both tracks.

## Shared vs DAEB-only

| Layer | Shared? | Tool source | Benchmark source |
|---|---|---|---|
| `TargetPack` / `Task` / `OracleSpec` | yes | `generate` from ingest | `compose-pack` from suite + extracts |
| Review gate (`pack.approval.json`) | yes | `review --approve` | same on compiled packs |
| `exec-plan` / harness / transcript | yes | generic matrix | narrowed production matrix |
| Verify / records / report | yes | pack-declared oracles | pack + extract oracles |
| Vendor-selection ledger | DAEB-only | — | `vendor-selection-ledger.yaml` |
| Suite synthesis / audit-suite | DAEB-only | — | `synthesize-suite`, `audit-suite` |
| Trace-review memo | DAEB-only | — | `suite.trace-review.yaml` |
| `daeb-production-rerun` | DAEB-only | — | 3-trial production lane |
| `publication-bundle` / `export-publication` | DAEB-only | — | freeze → AXArena export |

## Lifecycle phases (benchmark)

```text
mutable authoring
  -> authoring freeze (suite + packs + completed trace-review)
  -> production 3-trial matrix          (deferred until team review)
  -> publication freeze (complete bundle)
  -> export-publication -> AXArena site
```

Until publication freeze, DAEB-1 is one mutable v1 draft: re-synthesis
overwrites the same suite; git SHAs and content hashes identify exact states;
suite version numbers are not authoring iteration counters. Benchmark-of-record
results begin only after human freeze. Research-lane tasks stay out of the
scored denominator.

**Current public contract:** authoring freeze is done for the 6-vendor core
cohort; production and publication are deferred. Treat production commands as
the eventual path, not the default next step.

## System overview

The runtime is organized into four layers:

1. **Contracts** — shared schemas; most modules consume or emit a `TargetPack`.
2. **Planning and orchestration** — CLI coordinates authoring, exec, verify,
   reset, reporting, and (for DAEB) publication.
3. **Harness and surface runtime** — surface adapters + Claude Code / Codex
   invoke, MCP provision, transcript recovery.
4. **Verification and interpretation** — live read-back oracles, reports,
   normalized records.

## Core contracts

The shared contracts live in [src/schemas.ts](./src/schemas.ts).

The most important types are:

- `TargetPack`
  - the frozen benchmark artifact
  - declares auth, sandbox scope, task bank, discovery probe, and optional
    surface configs
- `Task`
  - a goal-level operation with difficulty, allowed surfaces, and oracle specs
- `OracleSpec`
  - declarative verification, especially `roundtrip` read-back assertions
- `SurfaceConfig` / `SurfaceAuth`
  - optional CLI / SDK / MCP surfaces and how each authenticates
- `RunResult` / `OracleResult`
  - execution and verification result shapes

This contract-first design is what makes the runner largely target-agnostic.
Most SaaS additions should be a new pack, not a code change.

### Review and approval gate

`review --approve` writes `pack.approval.json` keyed on a sha256 of reviewable
fields. Any edit to the pack re-closes the gate on both tracks. `exec-plan`
refuses an un-reviewed or edited pack unless `--skip-review`. Do not bypass this
in code.

DAEB orchestration may recompose a run-scoped pack for provenance, but it must
first prove that the result matches the committed human-approved content hash.
The approval sidecar is then staged beside the run-scoped pack and `exec-plan`
performs its ordinary review check; orchestration does not use `--skip-review`.

## Tool track

Layout:

- `targets/examples/<product>/` — shipped npm baselines (Notion, Stripe, Linear,
  Exa, Monday, Asana, …) with `pack.yaml` + `pack.approval.json`
- local / generated packs under `targets/<product>/` (not necessarily published)

Authoring path:

```text
ingest -> generate -> review --approve
  -> init / check-env
  -> exec-plan [--invoke]
  -> verify-generated
  -> render-generated / competitive
  -> reset   (only after verify)
```

Also useful: `probe`, `check-env`, static readiness under `src/static/`.
Default `generate` is LLM-assisted after a rule-derived seed; `--deterministic`
is the keyless fixture path. Neither replaces human review.

See [`targets/README.md`](./targets/README.md), [`SKILL.md`](./SKILL.md), and
[`CONTRIBUTING.md`](./CONTRIBUTING.md).

### Reference target (Stripe)

[`targets/examples/stripe/pack.yaml`](./targets/examples/stripe/pack.yaml) is the
flagship four-surface example (API, SDK, CLI, official MCP). It forced several
abstractions to become real:

- surface-aware task selection (`tasksForSurface`) so MCP is not scored against
  API-only operations
- harness hardening (Codex sandbox/network, transcript recovery, MCP isolation)
- report maturity (matrix narrative, MCP denominator footnotes)

Those design lessons apply to both tracks; Stripe is the concrete tool-track
reference artifact.

## Benchmark track (summary)

DAEB-1 is the AXArena Database AX Benchmark. Canonical sources live under
`benchmarks/daeb/v1/`:

- `suite.yaml` — shared task bank (not a pack)
- `vendor-selection-ledger.yaml` — core / research / excluded cohort
- `extracts/<vendor>/` — reproducibility contract (capabilities, surfaces, oracles)
- `packs/<vendor>/` — **compiled** execution artifacts, not independently authored
  benchmarks. Include `discovery:` (Agent Discovery Score) and `static` /
  `openapi_url` inputs for Discoverability & Readiness; those scores never
  alter the usability pass-rate denominator.
- `suite.trace-review.yaml` — fixed-sample review memo (freeze gate)

The production lane (`daeb-production-rerun`) is narrower than the generic
engine: `api` and `cli` only, Codex and Claude Code only, one medium-effort model
per harness, three trials plus aggregate per supported cell. SDK evidence is
research-only for v1 scoring. Harness lanes settle before the workflow advances,
and every trial persists cleanup status after verification. Missing namespaces,
unsupported resetters, reset errors, or stale runs without confirmed cleanup
halt the lane rather than contaminating the next trial.

Publication boundary: `publication-bundle` then `export-publication`. `ax-eval`
owns benchmark truth and artifacts; an `axarena` app imports exported indexes
rather than recomputing scores from raw run directories.

Full tree, authoring commands, gates, and hygiene:
[`benchmarks/daeb/README.md`](./benchmarks/daeb/README.md).

## Execution model

The main orchestrator is [src/cli.ts](./src/cli.ts).

Important command groups:

- **Authoring (tool)** — `ingest`, `generate`, `review`; `automate-report`
  orchestrates these steps but still stops at manual review/configuration gates
- **Authoring (DAEB)** — extract / synthesize / audit / compose (see DAEB README)
- **Execution** — `exec-plan`, `probe`, `check-env`, `init`
- **Verification and reporting** — `verify`, `verify-generated`, `competitive`,
  `trace-diff`
- **Publication (DAEB)** — `publication-bundle`, `export-publication`,
  `daeb-production-rerun`
- **Maintenance** — `reset` (after verify, never before)

The CLI does not embed target logic. Instead, it:

1. loads a pack
2. resolves the selected surface set
3. resolves auth and sandbox scope
4. emits prompts or invokes harnesses
5. verifies through the API
6. renders reports and records

## Surface model

The surface abstraction lives in:

- [src/surface/types.ts](./src/surface/types.ts)
- [src/surface/index.ts](./src/surface/index.ts)
- `src/surface/api.ts`, `cli.ts`, `sdk.ts`, `mcp.ts`

`ax-eval` treats surface as a first-class axis:

- `api`
- `cli`
- `sdk`
- `mcp`

The key idea is that a task bank is shared across surfaces, but each surface
changes:

1. **how discovery works**
   - API: web/docs search
   - CLI: `--help` and CLI docs
   - SDK: package install / SDK reference / method discovery
   - MCP: server/tool listing and MCP docs
2. **how the agent acts**
   - curl / HTTP calls
   - CLI commands
   - SDK method calls
   - MCP tool calls

### Surface-aware task selection

[src/surface/types.ts](./src/surface/types.ts) defines:

- `taskExecutionSurfaces`
- `taskSupportsSurface`
- `tasksForSurface`

A pack can declare a superset task bank, while a selected surface only runs the
tasks that actually apply to it. That is especially important for MCP: a
product's MCP server is often a partial operational surface, not a perfect
mirror of the public API. Without surface-aware filtering, MCP reports would
overcount "missing tool coverage" as task failure.

## Prompt and harness runtime

### Prompt builder

The prompt builder is [src/harness/executor.ts](./src/harness/executor.ts).

It turns:

- `TargetPack`
- harness profile
- selected surface
- namespace
- result paths

into a single prompt with:

1. a discovery phase
2. a task phase
3. a trace-writing contract
4. a results-writing contract

The prompt builder is pure and deterministic. It does not know anything about a
specific target beyond what the pack declares.

### Harness runners

The main subprocess runtime is [src/harness/invoke.ts](./src/harness/invoke.ts).

It is responsible for:

- detecting the harness CLI (`claude` or `codex`)
- building the exact invocation arguments
- writing a strict Codex output schema
- applying per-run env overrides
- collecting stdout/stderr/transcripts
- retrying failed or timed-out runs
- recovering results from transcript or agent output when files are missing
- terminating lingering wrappers once required artifacts exist

This layer is intentionally harness-specific. The rest of the system stays
generic; the runner absorbs the quirks of each agent CLI.

### MCP provisioning

MCP provisioning lives in [src/harness/mcp-provision.ts](./src/harness/mcp-provision.ts).

It supports:

- token-based MCP auth
- OAuth-app MCP auth via refresh-token exchange
- isolated per-run Codex and Claude homes/configs
- bearer token injection without writing secrets to tracked files

This is how hosted OAuth-backed MCP surfaces can run headlessly while still
keeping secret handling local to the invoking process.

### Transcript parsing

[src/harness/transcript.ts](./src/harness/transcript.ts) parses harness-native
event streams into a shared observed-run shape.

It extracts:

- web searches
- visited URLs
- CLI commands
- SDK install and method-call hints
- MCP tool listing and tool calls
- API-like call traces when observable

The parser then projects that observed behavior into:

- discovery scoring input
- trace rows for process-quality and structural diff

This is what makes behavioral discovery objective rather than purely
self-reported.

## Verification model

The verification layer lives in [src/generate/verify.ts](./src/generate/verify.ts).

The important rule is:

**the executor does not decide success.**

The executor only reports ids. The verifier then:

1. reads those resources back from the live API
2. resolves response envelopes
3. asserts fields against oracle expectations
4. records per-task outcomes

This is the truth layer of the system. It keeps evaluation grounded in actual
product state instead of agent narration.

Verification is surface-aware:

- `verifyGeneratedPack(..., surface?)`
- when a surface is provided, verification only checks `tasksForSurface(pack, surface)`

That aligns verification with prompt semantics and report semantics.

## Reporting and normalized records

### Generated report

The main report renderer is [src/generate/report.ts](./src/generate/report.ts).

It does more than template HTML. It also:

- groups runs into harness x surface cells
- derives findings
- builds recommendations
- computes process-quality signals
- renders TLDR, scorecards, discovery, content quality, scores, robustness, and
  appendix sections

The report is framed around **agent usability**, not just readiness.

### Normalized records

[src/generate/record.ts](./src/generate/record.ts) turns run outputs into a
portable, comparable record keyed by:

- `surface`
- `product`
- `harness`

Those records power:

- cross-surface comparisons for one product
- cross-product comparisons for one surface
- future hosted cross-harness aggregation

### Competitive report

The competitive renderer also lives in
[src/generate/report.ts](./src/generate/report.ts).

It consumes normalized records rather than raw run artifacts, which cleanly
separates:

- execution and verification
- interpretation and comparison

## Design principles

Several architectural choices are load-bearing:

- **Pack-centered design**
  - new SaaS targets should usually be new packs
- **Read-back verification**
  - agent self-report is never the source of truth
- **Surface-awareness**
  - API assumptions must not leak into CLI / SDK / MCP paths
- **Harness-specific parsing**
  - Claude Code and Codex are normalized after capture, not forced into one raw
    wire format
- **Blocked, not fake-failed**
  - missing surface auth should render as blocked configuration state, not a
    misleading 0%
- **Two freezes for publication benchmarks**
  - authoring freeze (suite/packs/trace-review) is not the same as publication
    freeze (complete bundle); do not conflate them

## Where to look

**Engine**

- CLI orchestration: [src/cli.ts](./src/cli.ts)
- Shared contracts: [src/schemas.ts](./src/schemas.ts)
- Surface model: [src/surface/](./src/surface/)
- Prompt builder: [src/harness/executor.ts](./src/harness/executor.ts)
- Harness runtime: [src/harness/invoke.ts](./src/harness/invoke.ts)
- MCP provisioning: [src/harness/mcp-provision.ts](./src/harness/mcp-provision.ts)
- Transcript parsing: [src/harness/transcript.ts](./src/harness/transcript.ts)
- Verification: [src/generate/verify.ts](./src/generate/verify.ts)
- Normalized records: [src/generate/record.ts](./src/generate/record.ts)
- Report rendering: [src/generate/report.ts](./src/generate/report.ts)
- Static readiness: [src/static/](./src/static/)

**Tracks**

- Tool packs: [targets/examples/](./targets/examples/), [targets/README.md](./targets/README.md)
- DAEB: [benchmarks/daeb/](./benchmarks/daeb/), especially `v1/`
- Workflow skill: [SKILL.md](./SKILL.md)
- Contributor conventions: [CONTRIBUTING.md](./CONTRIBUTING.md)

## Current shape

Today, the architecture is best understood as:

**two authoring tracks → one reviewed pack → a surface-aware execution matrix →
a read-back truth layer → report/record interpretation → (optionally)
publication export.**

That separation is what lets `ax-eval` be both a local engineering tool and the
foundation for a cross-product, cross-surface, cross-harness evaluation plane.
