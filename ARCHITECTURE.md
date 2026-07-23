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
| Packs live under | `targets/examples/` (shipped) or local `targets/` | `ax-arena/benchmark/daeb/v1/packs/<vendor>/` |
| Authoring | `ingest` → `generate` → `review` | `ax-arena benchmark` extract → synthesize → compose → `review` |
| Execution matrix | Whatever the pack declares | Benchmark-of-record: `api`+`cli`, Codex `gpt-5.6-terra` + Claude Code `claude-sonnet-5`, high, 3 trials |
| Extra gates | Content-hash approval | Ledger, audit-suite, trace-review, publication freeze |

Deep DAEB artifact detail lives in
[`ax-arena/benchmark/daeb/README.md`](./ax-arena/benchmark/daeb/README.md). Maintainer status
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

Benchmark-track authoring reaches that pack via arena-owned suite synthesis,
canonical-suite oracle extraction, and `compose-pack` policy (see DAEB README).
Those implementations consume only public `ax-eval` schemas, harness helpers,
and pack contracts. Re-synthesis or pack edits invalidate content-hash
approvals on both tracks. Tests that inspect canonical DAEB files live in the
arena workspace; core suite tests exercise the reusable contract with synthetic
explicit inputs.

## Shared vs DAEB-only

| Layer | Shared? | Tool source | Benchmark source |
|---|---|---|---|
| `TargetPack` / `Task` / `OracleSpec` | yes | `generate` from ingest | `compose-pack` from suite + extracts |
| Review gate (`pack.approval.json`) | yes | `review --approve` | same on compiled packs |
| `exec-plan` / harness / transcript | yes | generic matrix | narrowed production matrix |
| Verify / records / report | yes | pack-declared oracles | pack + extract oracles |
| Vendor-selection ledger | DAEB-only | — | `vendor-selection-ledger.yaml` |
| Canonical-suite oracle extraction | DAEB-only | — | `extract-tasks` + arena database seeds |
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

### Public package boundary

The supported library entry point is `src/index.ts`, published as the package
root (`import { ... } from "ax-eval"`). It exposes pack validation and approval,
surface and harness identifiers, verification/provider contracts, and
normalized-record primitives. It also exposes `EvaluationCellSchema`,
`NormalizedCellRecordSchema`, and `runCell` as the supported one-cell execution
boundary. Consumers must not import `ax-eval/src/**` or private `dist/**`
chunks; those paths may change without compatibility aliases.

`runCell` accepts exactly one explicit reviewed-pack × target × surface ×
harness × model × effort × trial × source-revision identity. It validates the
content-addressed approval plus the exact pack-file digest, passes the
controller's batch id through unchanged,
invokes one harness, verifies live state, and emits one normalized record. It
does not choose benchmark defaults, fan out a matrix, aggregate trials, rank,
publish, or clean up. The CLI process boundary consumes the same schema:
`ax-eval cell run --input cell.json --output record.json`.
Host credentials are allowlisted by the cell and are the only secrets forwarded
to the harness. An optional controller-only verifier credential map is used for
health checks and independent live read-back without entering the child
environment. The record persists the runtime-computed resource namespace so a
later controller can bind cleanup to the exact executed cell.
Cell output uses `ax.normalized-cell-record/v1`; the strict historical
`ax.normalized-result/v1` schema is not widened and remains the compatibility
format for existing report/aggregation commands.

This keeps the dependency direction suitable for AXArena:

```text
ax-arena -> public ax-eval API -> private ax-eval implementation
```

The in-repository package boundary lives at `ax-arena/benchmark/`. It is a
private npm workspace during migration, with independent build, typecheck, test,
and package smoke checks. Root scripts are umbrella checks for both packages.
An AST-based CI guard rejects `ax-eval` imports of arena code, relative imports
that escape the arena workspace, and arena imports of unpublished `ax-eval`
subpaths. Canonical DAEB files live under `ax-arena/benchmark/daeb/`. For one
minor release, readers fall back to `benchmarks/daeb/` only when canonical files
are absent and emit a deprecation warning. If both roots exist, callers must
select one with `--benchmark-root`; writers always use the canonical root.
Path selection and the YAML persistence wrappers moved from core are implemented
only in arena. Concept-universe, coverage/selection/support matrix,
grader-ledger, failure-taxonomy, and trace-review contracts are arena-owned,
along with database-specific capability-inventory audit policy; the public core
boundary retains generic capability-inventory and suite-methodology schemas and
pure parsers/transforms. Arena also constructs suite methodology defaults: the core
validates the artifact shape but does not choose category scoring surfaces,
coverage thresholds, task counts, or publication checkpoints. Canonical-suite
oracle extraction is also arena-owned; core retains its validation schemas and
generic harness/concurrency helpers, not vendor seed or support-matrix policy.
Those wrappers
reject static symlink/hard-link aliases and
pin parent/file identities while reading or updating. Authoring assumes
exclusive use by the trusted checkout UID; malicious concurrent same-UID parent
renames are outside this boundary. Remaining arena-native direct file I/O is a
follow-up hardening seam and is not covered by this wrapper guarantee. Exported
suite synthesis and audit-autofix writers preflight every sibling destination
under the canonical DAEB root before their first mutation. They require a
lowercase `.yaml` suite path and accept `DaebPathContext` so an explicit root
selection remains stable; bare roots fail when canonical and legacy trees are
both present.

Library callers compose `createRuntimeExtensionRegistry({ ... })` and pass it
through `runCell` options. The immutable registry snapshots versioned oracle,
provisioning, health-check, reset, and target-adapter providers for that cell;
adapter-contributed providers pass through the same duplicate and ambiguity
checks. Health checks execute before provisioning and invocation. Provisioning
providers may add environment keys, but cannot replace scoped credentials or
the core harness environment (including direct `env.PATH` replacement). A
provider may instead return additive `pathEntries`; core canonicalizes and
prepends only real directories that resolve outside both the writable cell
workspace and artifact tree. Tool binaries must be pinned and preinstalled in
those external directories. Core harness provisioning creates generic isolated
homes and MCP auth configuration only; it has no product-name branch, tool
downloader, or Turso PATH fallback. Arena's Turso provider owns binary discovery,
version/hash attestation, and additive PATH registration. A direct core cell
without an arena registry retains ordinary caller-PATH CLI behavior and cannot
be admitted as a trusted arena cell. Product-specific credential relationships
are likewise arena preflight policy: the Postgres health provider fails a Nile
cell before connecting unless `NILE_DB` matches the database in
`NILE_DATABASE_URL`.
Trusted dispatch validation, OCI/sysroot preparation, Bubblewrap smoke tests,
sealed-artifact export, and detached-subject construction live under
`ax-arena/benchmark/scripts/`. GitHub keeps only its required launcher under
`.github/workflows/`; that YAML binds environments and credentials to the
arena-owned implementations.
`prepare-trusted-tools.sh` is the pre-credential orchestrator: it creates the
verified OCI sysroot, installs/builds with that sysroot's Node and repository
lock, then invokes the exact runtime-tool sealer as root.
The credential-free global planner and exact per-cell credential parser live in
the same arena script boundary. Each protected cell job repeats OCI extraction
and runtime sealing before its credential-bearing step; transferred tool archives
are not a trust substitute. Core exposes only the generic immutable child-sandbox
adapter and provenance fields; `ax-eval` does not import or publish arena policy.
Target adapters may override only construction of the verification transport;
the cell runner still owns trace parsing, oracle execution, record validation,
and ordering. The adapter receives frozen explicit context rather than ambient
target policy.

Controllers pass host-agent credentials through `credentials` and independent
read-back credentials through `verificationCredentials`. Only the latter reach
health checks, verification clients, and oracle providers; they never enter the
harness environment or provisioning context.

Arena runtime reporting starts only from an immutable batch completion. It
rechecks canonical sidecar hashes and all four contained artifact seals, then
derives cross-surface process evidence from native harness transcripts. Native
calls without trustworthy task IDs are not fed into task-scoped structural
diffs. Reporting uses the generic public `ax-eval` trace, snapshot-rendering,
and aggregation APIs to write
arena-owned per-surface reports and per-harness trial aggregates. Reporting does
not execute cells and cannot bypass the trusted-workflow isolation gate. Its
manifest hash-binds the batch, completion, every emitted artifact, execution
backend/trust level, and pinned sandbox provenance; these fields are mandatory.

Arena planning creates an opaque batch UUID independent of run-directory names,
timestamps, or CI metadata, then freezes an ordered `ax.arena-batch-plan/v1`
document. Each descriptor binds one pack, harness pin, model/effort/trial,
timeout/reset policy, sandbox/tool pins, and four credential-name partitions;
credential values are never serialized. The manifest also binds a committed
configuration path and blob hash, which each distributed stage revalidates from
the source commit and against caller-supplied controller inputs rather than
trusting only colocated run artifacts. The matrix
worker accepts one explicit cell key, probes the actual root-owned harness
binary against its raw and semver pins using a secret-free environment, then
materializes only that cell's credentials. It emits one
`ax.arena-cell-result/v1` envelope binding the exact plan, descriptor,
normalized record, and cleanup evidence by SHA-256. Completion is a separate
credential-free assembly step that rejects missing, duplicate, extra, or
drifted envelopes and delegates final comparability checks to the same batch
completion validator used by serial execution. The existing cohort workflow is
replaced by a thin GitHub matrix launcher over these arena-owned planner,
one-cell worker, and credential-free assembler entrypoints.

Arena database reset providers never use broad cascade cleanup. Postgres drops
only exact namespace-matched tables, server-revalidated functions, and roles;
dependencies leave cleanup unconfirmed. Turso CLI attestation binds an exact
version and SHA-256 and rejects writable executable or ancestor paths.

The normalized record's optional `provider_provenance` lists only selected or
invoked oracle, provisioning, health-check, and adapter identities. Reset is
not represented there because `runCell` never cleans up. The controller must
atomically persist the verified record before calling the selected reset
provider's `plan` and `execute` methods and persisting cleanup evidence. Global
`registerOracleProvider` remains a compatibility bridge for direct legacy
verification; new orchestration must not depend on ambient provider state.
Legacy SQL/Mongo pack fields remain schema-readable, but core has no database
driver or built-in database oracle/reset path. Ax-arena supplies those behaviors
through explicit per-cell providers. The retained `resetPack` helper is limited
to the public HTTP/Asana compatibility example. Generic `exec-plan` warns when
that compatibility helper cannot inventory a target and fails closed if
`--reclaim` explicitly requests unavailable cleanup.

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
  -> render-generated
  -> ax-arena benchmark competitive   (cross-target comparison)
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
`ax-arena/benchmark/daeb/v1/`:

- `suite.yaml` — shared task bank (not a pack)
- `vendor-selection-ledger.yaml` — core / research / excluded cohort
- `extracts/<vendor>/` — reproducibility contract (capabilities, surfaces, oracles)
- `packs/<vendor>/` — **compiled** execution artifacts, not independently authored
  benchmarks. Include `discovery:` (Agent Discovery Score) and `static` /
  `openapi_url` inputs for Discoverability & Readiness; those scores never
  alter the usability pass-rate denominator.
- `suite.trace-review.yaml` — fixed-sample review memo (freeze gate)

The production lane (`daeb-production-rerun`) is narrower than the generic
engine: `api` and `cli` only, Codex `gpt-5.6-terra` and Claude Code
`claude-sonnet-5` at high effort, three clean trials plus aggregate per
supported cell. SDK evidence is research-only for v1 scoring. Harness lanes
settle before the workflow advances, and every trial persists cleanup status
after verification. Missing namespaces, unsupported resetters, reset errors,
or stale runs without confirmed cleanup halt the lane rather than contaminating
the next trial.

This production and low-pass policy is implemented only by the arena
controller. The deprecated core command names are process launchers; core
contains no DAEB trial loop, runtime model selection, cleanup policy, or
production aggregate writer. Arena publication revalidates the frozen
model/effort/trial metadata against the immutable batch.

Hosted live execution is a manual `workflow_dispatch`. A credential-free plan
job validates the full source commit and committed whole-benchmark configuration,
creates one opaque batch, and emits the exact cell matrix. Each cell runs in a fresh job
after the planner has enforced the API/CLI-only and 256-cell hosted limits,
behind the dynamically selected protected environment
`trusted-sandbox-<vendor>-<surface>-<harness>-trial-<n>`, whose sole secret is an
exact-name `AX_ARENA_CELL_CREDENTIALS_JSON` object. Required reviewers therefore
approve one explicit cell scope; the YAML contains no roster, surface policy,
harness pins, or individual secret bindings.

Before credential injection, every cell runner independently re-pulls the exact
OCI digest, extracts a root-owned non-writable sysroot, installs exact dependency
locks, and verifies the runtime manifest. It then uses only that Node/tool tree
and Bubblewrap, with no native fallback. Workers upload only sealed controller
artifacts and the per-cell runtime manifest. An environment-free job requires
one hash-bound result per planned key and byte-identical manifests before
completion; an isolated OIDC-enabled job reverifies and signs the detached
subject. Pull requests remain keyless and never receive arena secrets.

Invocation metadata preserves every retry attempt. The normalized public record
uses successful-attempt latency, retry-inclusive total duration/tokens/native
cost, raw + semver harness version, and run batch identity. Production
aggregation uses median trial latency and total consumption. `pass_hat_3`
(mean cubed) is deprecated; ranking uses exact tasks passing all three trials.

Publication exports keep harnesses independent. Within one harness, tasks are
averaged inside each surface and Overall is the equal-weight macro-average of
participating surfaces. The pass³ tie-break is the exact eligible
task×surface-cell ratio, with numerator and denominator published.

Publication boundary: `publication-bundle` then `export-publication`. The arena
workspace owns benchmark truth and artifacts; an `axarena` app imports exported indexes
rather than recomputing scores from raw run directories. `publication-bundle`
accepts only `pinned-oci + hosted-trusted` production evidence and verifies the
detached GitHub OIDC attestation from the protected-main workflow before it
creates a `publication_ready` bundle; no local or low-pass draft path exists.
The verifier requires externally supplied `AX_ARENA_APPROVED_SIGNER_SHA`; a
subject cannot authorize its own workflow revision. Canonical aggregation and
reporting run before the atomic rename and again on every downstream load,
which also checks signed source assets, canonical metadata, and the exact
physical inventory rather than trusting self-hashed manifest fields.

Full tree, authoring commands, gates, and hygiene:
[`ax-arena/benchmark/daeb/README.md`](./ax-arena/benchmark/daeb/README.md).

## Execution model

The main orchestrator is [src/cli.ts](./src/cli.ts).

Important command groups:

- **Authoring (tool)** — `ingest`, `generate`, `review`; `automate-report`
  orchestrates these steps but still stops at manual review/configuration gates
- **Authoring (DAEB)** — arena-owned extract / synthesize / audit / compose via
  `ax-arena benchmark` (legacy `ax-eval` aliases are one-minor launchers)
- **Execution** — generic `exec-plan`, `probe`, `check-env`, `init`; arena-owned
  `plan` / `execute` (direct `execute` stays fail-closed; the protected workflow calls the sandboxed cell lifecycle)
- **Verification and reporting** — core `verify`, `verify-generated`,
  `trace-diff`, and `records-diff`; arena-owned `competitive`
- **Publication (DAEB)** — arena-owned `aggregate`, `publication-bundle`,
  `export-publication`, and `publish`; deprecated core names delegate through
  the compatibility launcher, while production execution stays fail-closed
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

It does not install or select product CLIs. Controllers provide those through
the runtime provisioning registry; DAEB's pinned Turso implementation lives in
`ax-arena/benchmark/src/providers/turso-provisioning.ts`.

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

The arena competitive command consumes normalized records rather than raw run
artifacts, which cleanly separates:

- execution and verification
- interpretation and comparison

The competitive renderer and its cross-target semantics live under
`ax-arena/benchmark/src/publication/`; core retains normalized-record creation
and generic single-run HTML reporting only.

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
- DAEB: [ax-arena/benchmark/daeb/](./ax-arena/benchmark/daeb/), especially `v1/`
- Workflow skill: [SKILL.md](./SKILL.md)
- Contributor conventions: [CONTRIBUTING.md](./CONTRIBUTING.md)

## Current shape

Today, the architecture is best understood as:

**two authoring tracks → one reviewed pack → a surface-aware execution matrix →
a read-back truth layer → report/record interpretation → (optionally)
publication export.**

That separation is what lets `ax-eval` be both a local engineering tool and the
foundation for a cross-product, cross-surface, cross-harness evaluation plane.
