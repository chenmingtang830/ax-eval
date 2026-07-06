# Architecture

`ax-eval` is a pack-centered, surface-aware agent usability eval system.

At a high level, it turns a product spec or docs surface into a reviewed task
pack, runs that same pack through one or more agent harnesses and product
surfaces, verifies real sandbox state with read-back oracles, and renders the
result as a report plus normalized records.

The core data flow is:

```text
spec/docs
  -> ingest
  -> generate (rule seed + LLM-assisted authoring, or deterministic fallback)
  -> reviewed TargetPack
  -> exec-plan per harness x surface x effort
  -> results + trace + transcript
  -> round-trip verification
  -> normalized records
  -> HTML report / competitive report
```

DAEB-1/database v1 adds one publication-grade production lane on top of the
generic flow: `daeb-production-rerun`. It composes fresh vendor packs from the
frozen suite and verifier extracts, runs only the benchmark-of-record `api` and
`cli` surfaces, invokes Codex and Claude Code with pinned medium-effort models,
and writes three isolated trials plus an aggregate normalized record per
supported cell. Publication bundles read those aggregate records with
`--effort-profiles medium --required-effort-profiles medium`.

## System overview

The system is organized into four layers:

1. **Contracts**
   - Shared schemas for packs, tasks, surfaces, auth, and oracle specs.
   - This is the stable center of the system: most modules consume or emit a
     `TargetPack`.
2. **Planning and orchestration**
   - CLI commands coordinate ingest, generate, review, exec, verify, reset, and
     competitive reporting.
   - This layer decides which surfaces and harnesses to run, and where artifacts
     land on disk.
3. **Harness and surface runtime**
   - Surface adapters change how the agent discovers and acts.
   - Harness runners manage subprocess invocation, MCP provisioning, transcript
     recovery, and result capture for Claude Code and Codex.
4. **Verification and interpretation**
   - Read-back oracles decide success from live product state.
   - Reports and normalized records convert raw run artifacts into a usable
     product-level narrative.

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

## Execution model

The main orchestrator is [src/cli.ts](./src/cli.ts).

Important command groups:

- **Authoring**
  - `ingest`
  - `generate`
  - `review`
- **Execution**
  - `exec-plan`
  - `probe`
  - `check-env`
  - `init`
- **Verification and reporting**
  - `verify`
  - `verify-generated`
  - `competitive`
  - `trace-diff`
  - `publication-bundle`
- **DAEB-1 production**
  - `daeb-production-rerun`
- **Maintenance**
  - `reset`

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

This became more explicit with the Stripe work.

[src/surface/types.ts](./src/surface/types.ts) now defines:

- `taskExecutionSurfaces`
- `taskSupportsSurface`
- `tasksForSurface`

This means a pack can declare a superset task bank, while a selected surface
only runs the tasks that actually apply to it.

That is especially important for MCP. A product's MCP server is often a partial
operational surface, not a perfect mirror of the public API. Without
surface-aware filtering, MCP reports would overcount "missing tool coverage" as
task failure.

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

With the Stripe work, verification also became explicitly surface-aware:

- `verifyGeneratedPack(..., surface?)`
- when a surface is provided, verification only checks `tasksForSurface(pack, surface)`

That change aligned verification semantics with prompt semantics and report
semantics.

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

The report is now explicitly framed around **agent usability**, not just
readiness.

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

## The Stripe and MCP architecture changes

The Stripe work was important because it forced several abstractions to become
real rather than aspirational.

### 1. A complete four-surface target

[targets/stripe/pack.yaml](./targets/stripe/pack.yaml) is the first flagship
target that exercises:

- API
- SDK
- CLI
- official MCP

That gives the repo a concrete, product-level reference artifact rather than
only API-first examples.

### 2. Surface-aware MCP semantics

Before this change, MCP could be judged against tasks for operations the MCP
surface did not expose. After this change:

- prompt generation is surface-aware
- Codex schema generation is surface-aware
- failure artifact generation is surface-aware
- verification is surface-aware
- report scoring can explain narrower MCP denominators

This is a substantial semantic improvement: MCP results now describe what the
MCP surface can actually operate, not what the product API can do in general.

### 3. Harness hardening

The Stripe matrix also pushed the runtime to absorb real-world harness issues:

- Codex non-interactive approval configuration
- network-enabled workspace-write sandbox config
- transcript/result recovery
- lingering subprocess cleanup
- Claude MCP isolated config and permission mode

These are not product features, but they are necessary infrastructure for a
reliable eval system.

### 4. Report maturity

The report layer now has a clearer architecture too:

- usability-first TLDR
- matrix-native narrative for multi-surface / multi-harness runs
- trace-derived process quality
- MCP score footnotes for surface-aware subsets

That makes the output more credible as a shareable artifact and less dependent
on verbal explanation from the maintainer.

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

## Where to look in the code

- CLI orchestration:
  - [src/cli.ts](./src/cli.ts)
- Shared contracts:
  - [src/schemas.ts](./src/schemas.ts)
- Surface model:
  - [src/surface/](./src/surface/)
- Prompt builder:
  - [src/harness/executor.ts](./src/harness/executor.ts)
- Harness runtime:
  - [src/harness/invoke.ts](./src/harness/invoke.ts)
- MCP provisioning:
  - [src/harness/mcp-provision.ts](./src/harness/mcp-provision.ts)
- Transcript parsing:
  - [src/harness/transcript.ts](./src/harness/transcript.ts)
- Verification:
  - [src/generate/verify.ts](./src/generate/verify.ts)
- Normalized records:
  - [src/generate/record.ts](./src/generate/record.ts)
- Report rendering:
  - [src/generate/report.ts](./src/generate/report.ts)

## Current shape

Today, the architecture is best understood as:

**a reviewed benchmark pack + a surface-aware execution matrix + a read-back
truth layer + a report/record interpretation layer.**

That separation is what lets `ax-eval` be both:

- a local engineering tool for one product team
- and the foundation for a broader cross-product, cross-surface, and eventually
  cross-harness evaluation plane
