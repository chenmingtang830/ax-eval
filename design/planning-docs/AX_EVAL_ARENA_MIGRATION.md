# ax-eval / ax-arena Separation Migration Design

**Status:** In-repository separation implemented; release compatibility window not yet started

**Scope:** Separate the reusable `ax-eval` execution engine from DAEB/arena policy,
orchestration, aggregation, and publication

**Baseline audit date:** 2026-07-21

**Last implementation reconciliation:** 2026-07-22

**Audited refs:**

- PR #172 branch: `2aaff3534e98733d7c68aaf805485571a94fcb31`
- `origin/main`: `8228d2220a191f5c62edd19b873c8402cc163326`
- Cumulative DAEB stack through PR #171:
  `4fa2e2ba9c3d186fd2230077ae020611f9198cae`

## 1. Executive Summary

The intended architecture is correct:

> `ax-eval` owns the smallest reproducible evaluation unit. `ax-arena` applies
> benchmark policy to many such units, aggregates their records, and publishes
> comparative results.

At the audited refs, PR #172 began this separation by adding an `OracleProvider`
seam. That was a useful enabling change, but did not by itself separate the two
systems. The baseline cumulative DAEB implementation still placed benchmark
policy, database-specific runtime behavior, orchestration, production workflow
behavior, and publication inside the `ax-eval` package.

The migration establishes five boundaries together:

1. **Execution boundary:** one `ax-eval` call runs one fully specified cell and
   emits one normalized record.
2. **Extension boundary:** target-specific oracle, reset, provisioning, and
   health-check behavior is supplied explicitly to the cell runner.
3. **Policy boundary:** benchmark roster, canonical suite, model/effort policy,
   trial count, completeness rules, and ranking belong to `ax-arena`.
4. **Artifact boundary:** normalized cell records belong to `ax-eval`; benchmark
   plans, aggregate records, leaderboards, and publication bundles belong to
   `ax-arena`.
5. **Security boundary:** each production cell receives only the credentials it
   requires and executes an immutable, reviewed revision.

The direction of dependency must remain one-way:

```text
ax-arena
  imports and invokes
      ax-eval

ax-eval
  has no dependency on ax-arena, DAEB, its vendor roster, or its publication
  policy
```

The in-repository phases were implemented incrementally. Publishing the private
arena package or splitting repositories remains a later release gate; doing so
before the API, schema, and extension boundaries stabilized would only have
moved the coupling.

Implementation progress:

- PR #172 established the first oracle-provider seam and merged this design.
- The typed package root and one-cell `runCell`/CLI contracts are implemented in
  the cumulative in-repository stack.
- Immutable per-cell runtime registries now cover oracle, reset, provisioning,
  health-check, and target-adapter seams. The arena workspace imports their
  constructor only through the public `ax-eval` package specifier.
- Reset remains outside `runCell` so verified-record persistence can precede
  cleanup.
- The root package no longer declares database-only SDKs or drivers. SQL/Mongo
  verification and DAEB database cleanup execute only through arena-owned,
  explicitly injected providers; core retains v1 declaration readers but no
  database connection implementation.
- The legacy DAEB low-pass and production command names delegate to arena, and
  the old core trial loop, runtime model selection, cleanup policy, and
  production aggregate helpers have been removed. Arena publication validates
  the frozen model/effort/trial metadata against the immutable batch.
- Competitive reporting, publication bundle construction, and publication
  export now execute only in the arena workspace; the former `ax-eval` command
  names are process-launcher compatibility aliases.
- Trusted dispatch validation, OCI/sysroot and tool preparation, Bubblewrap
  smoke tests, sealed-artifact export, detached attestation construction, and
  their tests are owned under `ax-arena/benchmark/`. The required
  `.github/workflows/` file remains only the launcher and secret-binding
  surface.
- Canonical DAEB artifacts, authoring persistence, suite composition, oracle
  extraction, artifact contracts, and database-specific inventory audit policy
  live under `ax-arena/benchmark/`; core retains only reusable explicit-input
  contracts and single-product transforms.
- Exported suite writers enforce canonical lowercase `.yaml` destinations,
  preserve explicit DAEB path contexts, and the CLI preflights its complete
  11-output suite bundle before mutation.

## 2. Goals

### 2.1 Primary goals

- Make `ax-eval` usable as a library and CLI for one product/surface/harness/
  trial evaluation without importing benchmark policy.
- Make `ax-arena` the sole owner of DAEB methodology, benchmark expansion,
  production distribution, aggregation, comparison, and publication.
- Preserve the existing review gate, live verification ordering, trace parsing,
  surface awareness, and secret-redaction behavior.
- Support local serial execution and distributed production execution through
  the same cell contract.
- Allow target-specific behavior without adding target-name branches to shared
  runtime code.
- Preserve current artifacts long enough to prove migration parity.

### 2.2 Secondary goals

- Reduce `ax-eval` package size and remove benchmark-only database drivers.
- Make benchmark runs reproducible from an immutable batch plan.
- Make credential requirements machine-readable and auditable per cell.
- Allow future arenas to reuse `ax-eval` without inheriting DAEB-specific
  schemas or policies.

## 3. Non-Goals

- Redesigning task scoring or changing benchmark results during the separation.
- Replacing Codex or Claude Code transcript parsers.
- Removing all target examples or product names from the `ax-eval` repository.
  Target packs and adapters are legitimate reusable inputs. The forbidden
  coupling is benchmark-roster policy and target-specific control flow in the
  shared runtime.
- Introducing a queue service as a prerequisite. A local loop, GitHub Actions
  matrix, or later queue worker may all invoke the same cell API.
- Making live tests part of normal CI. Unit and contract tests remain keyless
  and offline.
- Automatically deleting sandbox resources. Cleanup remains explicit.

## 4. Terms and Ownership Model

### 4.1 Evaluation cell

An evaluation cell is the smallest independently executable unit:

```text
cell = evaluation set entry
     x target/product
     x surface
     x harness
     x model
     x effort
     x trial
     x immutable source revision
```

The cell includes all inputs needed to run deterministically at the orchestration
level. The model's behavior remains nondeterministic, but the identity and policy
of the requested run must not be inferred from ambient process state.

### 4.2 Benchmark plan

A benchmark plan is an immutable collection of cells plus benchmark-wide policy:

- evaluation set identity and version;
- target roster;
- supported surface matrix;
- harness/model/effort matrix;
- trial count;
- batch identity;
- completeness and comparability requirements;
- aggregation and publication policy.

The plan belongs to `ax-arena`.

### 4.3 Normalized cell record

A normalized cell record is the stable output of one `ax-eval` cell. It contains
input identity, execution provenance, task-level outcomes, scores, trace-derived
evidence, and execution errors. It ends after live verification and durable
persistence; arena cleanup evidence is written afterward as a separate
`ax.arena-cell-cleanup/v1` sidecar bound to the record hash. The normalized
record must not contain a leaderboard rank or claim that a benchmark batch is
complete.

### 4.4 Aggregate and publication artifacts

An aggregate combines records according to benchmark policy. A publication
bundle validates completeness and comparability and renders benchmark outputs.
Both belong to `ax-arena`.

## 5. Current-State Audit

This section records the historical baseline at the audited refs above. The
implementation-progress list and phase progress annotations describe the
current cumulative stack.

### 5.1 What PR #172 implements

The PR adds `src/generate/oracle-provider.ts`, integrates provider dispatch into
`src/generate/verify.ts`, and adds provider tests.

The seam provides:

- provider matching by oracle declaration;
- registration and same-ID replacement;
- provider error containment as a failed oracle result;
- fallback to built-in verification when no provider matches;
- a test-only registry reset.

This is a valid first step because it removes the requirement that generic
verification directly know every future oracle implementation.

### 5.2 Limitation of the current provider design

The provider list is mutable process-global state. That is acceptable as a
short-lived compatibility mechanism, but it must not become the final runtime
contract.

Global registration creates these problems:

- one cell can affect another cell in the same worker;
- test order or hot reload can change provider selection;
- concurrent benchmark cells cannot safely use different extension sets;
- library callers cannot inspect complete execution inputs;
- plugin precedence depends on registration order outside the call boundary.

The final cell runner must receive an immutable registry or extension list
explicitly. A global default may remain only as a deprecated CLI compatibility
layer.

### 5.3 Generic verification still contains vertical implementations

In the cumulative DAEB stack, `src/generate/verify.ts` imports SQL, MongoDB, and
surface-honesty implementations. The provider seam should invert those
dependencies:

```text
before
  generic verify -> SQL/Mongo/DAEB implementation

after
  ax-eval verify -> provider interface
  ax-arena       -> SQL/Mongo/DAEB providers
```

The generic verifier should continue to own common oracle scheduling, result
normalization, timeout/error treatment, and built-in HTTP/GraphQL behavior.

### 5.4 Reset behavior crosses the same boundary

`src/target/reset.ts` in the cumulative stack contains target- and
database-specific reset logic for MongoDB Atlas, Postgres-family targets, Turso,
Convex, and Asana. It also contains the arena-style `axarena_%` naming
convention.

Reset is part of a cell lifecycle, but its implementation is target-specific.
The shared runtime should own sequencing and safety rules:

```text
execute -> verify live state -> record verification -> explicit cleanup
```

It should not own database clients, benchmark naming conventions, or target-name
dispatch. Those belong in supplied reset providers.

### 5.5 Provisioning behavior crosses the same boundary

`src/harness/mcp-provision.ts` contains a Turso-specific installation path and
selects it by pack name. Provisioning is needed before some cells can execute,
but target-specific installers and commands are extension behavior.

The shared runtime may own a constrained provisioning lifecycle, logging,
timeouts, and redaction. The target adapter must own the actual prerequisites
and installation commands. Production should prefer prebuilt runner images over
runtime download scripts.

### 5.6 Environment checks cross the same boundary

The cumulative CLI includes a Nile-specific environment consistency check. A
generic `check-env` command may validate declared variables, auth shape, and
redaction. Product-specific consistency rules must be supplied as health-check
extensions rather than embedded branches.

### 5.7 Prompt and verification transport contain target-name branches

The cumulative runtime also contains an Asana-name fallback in harness prompt
construction and a Convex-name branch when constructing the verification HTTP
client. These are not necessarily arena responsibilities: they may be reusable
target-adapter behavior. They are nevertheless evidence that product-specific
runtime selection is still encoded in shared control flow.

Legacy compatibility may keep the Asana fallback until older packs declare the
required auth and sandbox fields. New target behavior should be selected from
pack-declared capabilities or an explicit target adapter. Verification transport
differences such as a discovered deployment URL or no-auth read-back client
should also be adapter behavior, not `pack.name` conditionals.

### 5.8 CLI ownership is mixed

The cumulative CLI combines reusable commands with arena commands.

Reusable `ax-eval` responsibilities include:

- ingest and discovery;
- deterministic or assisted pack generation;
- review and approval;
- one-cell execution and verification;
- generic reporting for one run;
- reset through an explicitly supplied provider;
- normalized record validation and diffing.

Arena responsibilities include:

- vendor-roster resolution;
- canonical extraction ledgers;
- DAEB suite composition and audit;
- run-matrix expansion;
- low-pass and production rerun policy;
- benchmark aggregation;
- publication bundle/export;
- leaderboard generation.

Temporary command aliases may remain during migration, but their implementations
must delegate to `ax-arena` and be removed on a documented schedule.

### 5.9 Schema ownership is mixed

The cumulative schema includes SQL and Mongo oracle declarations, connection
role fields, `sql_conn`, `mongo_conn`, and `standard_set_version` in the shared
schema surface.

The migration should separate:

- generic pack and record fields owned by `ax-eval`;
- provider-owned typed extension declarations;
- DAEB evaluation-set identity and publication schemas owned by `ax-arena`.

The core record should use generic identity fields:

```text
evaluation_set_id
evaluation_set_version
pack_content_hash
```

`standard_set_version` may be retained as a read/write compatibility alias for
v1 records, but new code should not treat it as the only set identity.

### 5.10 Package ownership is mixed

The cumulative package adds DAEB artifacts to the `ax-eval` tarball and adds
database runtime dependencies including Neon, Supabase, MongoDB, MySQL, and
Postgres clients. These are not required by the generic execution engine.

The current package also exposes only the `ax-eval` binary; it has no supported
library export. That makes an arena-to-engine dependency difficult to express
without importing internal files.

The migration must add a public library entry point and move DAEB artifacts and
database dependencies to `ax-arena` or separately versioned target plugins.

### 5.11 Production workflow is a cell runner and controller simultaneously

The trusted workflow accepts one vendor and one surface, so operationally it is
a cell-level dispatch. The invoked command then loops over harnesses and trials,
embeds benchmark model/effort policy, creates a run identity, and is expected to
feed a publication gate for a global batch.

This produces a batch identity contradiction:

```text
each workflow dispatch
  run_batch_id = trusted-<unique GitHub run id>

publication
  requires every record in one benchmark run to share one run_batch_id
```

A cell runner cannot independently invent a benchmark-wide identity. The arena
controller must create `batch_id` once and pass it to every cell.

### 5.12 Production credentials are over-scoped

The trusted workflow makes every vendor's credentials available to a run for one
selected vendor. Because the host agent can execute shell commands and access
the network, a malicious instruction or dependency compromise in one cell could
expose unrelated sandbox credentials.

Environment approval does not reduce the credentials visible after the job
starts. Each cell must receive only:

- the selected target's sandbox credentials;
- the selected harness/model credential;
- narrowly scoped artifact-storage credentials, if required.

Vendor-specific jobs or reusable workflows with vendor-specific environments
are acceptable implementations. A single job populated with all secrets is not.

### 5.13 Production source and harness provenance are incomplete

The workflow accepts a free-form source ref and checks it out before a
secret-bearing execution. Reviewers need a machine-enforced guarantee that the
executed commit is the approved immutable revision.

The workflow also invokes Codex and Claude Code without installing or verifying
pinned CLI versions. Self-hosted runners may happen to contain them, but
`ubuntu-latest` does not provide that contract. Failing later with "command not
found" is only failure detection; it does not provide reproducibility.

Before secrets are exposed, the workflow should:

1. resolve and validate an immutable commit SHA;
2. prove the SHA is allowed by the protected release policy;
3. install or verify pinned harness CLI versions;
4. record harness versions in the cell record;
5. only then enter the vendor-specific secret-bearing environment.

### 5.14 Pure extraction logic should not be moved wholesale

Some cumulative modules combine reusable single-target logic with DAEB artifact
paths and methodology:

- capability extraction;
- surface extraction;
- vendor/product resolution;
- registry ingestion.

The pure resolver/extractor contracts and functions can remain in `ax-eval` if
they are useful outside DAEB. Canonical cohort schemas, benchmark ledgers,
methodology, persistence paths, support matrices, and selection policy belong to
`ax-arena`.

Moving whole files based only on names would either strand reusable behavior in
the arena or preserve arena coupling in the engine. Split by dependency and
responsibility instead.

## 6. Target Architecture

### 6.1 Component view

```text
                         ax-arena
  +-------------------------------------------------------+
  | roster + canonical suite + benchmark methodology     |
  | model/effort/trial policy + immutable batch planner   |
  | production controller + credential routing           |
  | SQL/Mongo/DB providers + DAEB target adapters         |
  | aggregation + completeness + comparison + publish    |
  +---------------------------+---------------------------+
                              |
                              | public API / cell process
                              v
                         ax-eval
  +-------------------------------------------------------+
  | pack ingest/generate/review                           |
  | surface adapters + harness invocation                 |
  | one-cell lifecycle + generic verifier                 |
  | injected extension interfaces                        |
  | normalized cell record schema                        |
  | generic one-run report and record validation          |
  +-------------------------------------------------------+
```

### 6.2 Required public cell API

Implementation status: `ax.evaluation-cell/v1`,
`ax.normalized-cell-record/v1`, `runCell`, and
`ax-eval cell run --input --output` are available through the public package
root. Historical `ax.normalized-result/v1` remains unchanged; the new strict
cell schema carries the generic identity and task-result fields without
silently widening the legacy discriminator.

The exact names may follow local conventions, but the public contract should be
equivalent to:

```ts
export interface EvaluationCell {
  cellId: string;
  batchId?: string;
  evaluationSet: {
    id: string;
    version: string;
  };
  pack: ReviewedPackReference;
  surface: Surface;
  harness: HarnessSelection;
  trial: number;
  runContext: RunContext;
}

export interface RunCellOptions {
  credentials: CredentialSource;
  extensions?: RuntimeExtensionRegistry;
  signal?: AbortSignal;
  output?: ArtifactSink;
}

export async function runCell(
  cell: EvaluationCell,
  options: RunCellOptions,
): Promise<NormalizedCellRecord>;
```

Important properties:

- `runCell` runs exactly one harness and one trial.
- Model and effort are explicit in `HarnessSelection`; `ax-eval` does not choose
  benchmark defaults.
- `batchId` is supplied by a controller. A standalone local run may omit it or
  use an explicitly labeled local identity.
- The reviewed pack and its content hash are explicit.
- Credentials are resolved at the call boundary and never serialized into the
  plan or record.
- Extensions are explicit and immutable for the call.
- The returned record is schema-valid even when execution fails.

### 6.3 Optional policy-free trial helper

`ax-eval` may expose a convenience helper that repeats a fully specified cell,
provided it has no benchmark defaults:

```ts
runTrials({ baseCell, trialIds: [1, 2, 3] }, options)
```

This helper must not choose "three trials," require exact pass-three-of-three,
pick models, aggregate vendors, or declare publication completeness. Those are
arena policies.

### 6.4 Process isolation contract

The primary integration should be a supported library API for local composition
and testing. Production workers should also support a process boundary:

```text
ax-eval cell run --input cell.json --output record.json
```

The subprocess contract provides:

- stronger environment and extension isolation;
- one-cell secret scoping;
- bounded memory and timeout enforcement;
- a stable retry unit;
- simpler distributed execution.

The CLI input and output must use the same schemas as the library API.

## 7. Runtime Extension Design

### 7.1 Design requirements

Extensions must be:

- explicitly supplied per cell;
- selected by declared capability, not product-name branches;
- deterministic in precedence;
- inspectable before execution;
- isolated from secret serialization;
- able to return structured, redacted errors;
- usable in offline tests through fakes.

### 7.2 Oracle providers

Retain the PR #172 concept, but migrate from global registration to an injected
registry:

```ts
interface OracleProvider {
  id: string;
  version: string;
  supports(input: OracleRequest): boolean;
  verify(input: OracleRequest, context: OracleContext): Promise<OracleResult>;
}
```

Rules:

- duplicate IDs are rejected when constructing a registry;
- ambiguous matches are an error unless explicit priority is configured;
- provider exceptions become structured failures without leaking credentials;
- provider identity and version are recorded as provenance;
- built-in generic oracles use the same dispatch model where practical.

### 7.3 Reset providers

```ts
interface ResetProvider {
  id: string;
  supports(target: TargetDescriptor): boolean;
  plan(context: ResetContext): Promise<ResetPlan>;
  execute(plan: ResetPlan, context: ResetContext): Promise<ResetEvidence>;
}
```

Rules:

- cleanup is never called before verification;
- dry-run returns the exact planned resource scope;
- destructive scope must be bounded by pack-declared sandbox identity;
- automatic fallback from an unknown target to a database reset is forbidden;
- cleanup evidence is an arena-owned sidecar written only after the verified
  normalized cell record has been durably persisted;
- target-specific naming conventions live in the provider.

### 7.4 Provisioning providers

```ts
interface ProvisioningProvider {
  id: string;
  supports(cell: EvaluationCell): boolean;
  inspect(context: ProvisioningContext): Promise<ProvisioningStatus>;
  provision(context: ProvisioningContext): Promise<ProvisioningEvidence>;
}
```

Rules:

- production should use pinned preinstalled tools where possible;
- runtime downloads require checksum/version verification;
- provisioning executes before target secrets are exposed when possible;
- commands and versions are recorded, but secret values are redacted;
- a provider cannot silently modify benchmark policy.

### 7.5 Health-check providers

```ts
interface HealthCheckProvider {
  id: string;
  supports(target: TargetDescriptor): boolean;
  check(context: HealthCheckContext): Promise<HealthCheckResult[]>;
}
```

Generic checks validate declared environment variable names, reachable local
tools, and auth configuration shape. Product-specific consistency checks live in
target providers.

### 7.6 Target adapters

Some target differences affect more than one lifecycle stage but do not belong
to a benchmark. A reusable target adapter may contribute prompt context,
verification transport, and any of the narrower providers:

```ts
interface TargetAdapter {
  id: string;
  supports(target: TargetDescriptor): boolean;
  promptContext?(context: PromptContext): Promise<PromptContextPatch>;
  verificationClient?(
    context: VerificationClientContext,
  ): Promise<VerificationClientConfiguration>;
  oracleProviders?: readonly OracleProvider[];
  resetProviders?: readonly ResetProvider[];
  provisioningProviders?: readonly ProvisioningProvider[];
  healthCheckProviders?: readonly HealthCheckProvider[];
}
```

Selection should prefer a stable declared adapter ID or capability in the pack.
Name-based matching is permitted only in a versioned legacy compatibility
adapter. Target adapters may live with `ax-eval`, in independent plugin packages,
or in `ax-arena` when they exist only for its cohort. Their location is decided
by reuse and dependency ownership, not by the fact that they mention a product.

### 7.7 Registry composition

A single immutable runtime registry may aggregate all extension kinds:

```ts
interface RuntimeExtensionRegistry {
  oracles: readonly OracleProvider[];
  resets: readonly ResetProvider[];
  provisioning: readonly ProvisioningProvider[];
  healthChecks: readonly HealthCheckProvider[];
  targetAdapters: readonly TargetAdapter[];
}
```

`ax-arena` composes DAEB providers and passes the registry to `runCell`.
`ax-eval` neither imports those providers nor discovers them through ambient
global state.

## 8. Schema and Artifact Contracts

### 8.1 Core-owned schemas

`ax-eval` owns and versions:

- reviewed pack envelope and content hash;
- cell input schema;
- normalized cell record schema;
- task result and oracle result schemas;
- harness/trace provenance;
- generic failure contracts plus reset plan/evidence provider interfaces;
- provider extension envelope;
- generic record validation/diff schema.

### 8.2 Arena-owned schemas

`ax-arena` owns and versions:

- target roster and selection ledger;
- canonical capability/surface extracts;
- DAEB suite, methodology, and support matrix;
- benchmark run matrix and immutable batch manifest;
- post-record cell cleanup/result sidecars and their integrity bindings;
- trial aggregate and exact-pass policy;
- comparison and leaderboard schema;
- publication bundle and export schema.

### 8.3 Provider-owned pack extensions

Database-specific declarations should not expand the generic schema indefinitely.
Use a validated extension envelope:

```yaml
extensions:
  ax-arena.sql/v1:
    connectionRef: primary
    oracles:
      - query: "..."
  ax-arena.mongo/v1:
    connectionRef: primary
    oracles:
      - collection: "..."
```

The core validates envelope identity and serializability. The selected provider
validates its payload using its own strict schema before any side effect.

Compatibility readers may continue to accept existing `sql_conn`, `mongo_conn`,
`sqlQuery`, and `mongoQuery` fields and translate them into provider extensions.
Writers should emit the new representation after the migration version is
declared.

### 8.4 Normalized record minimum identity

Every cell record should contain at least:

```text
schema_version
record_id
cell_id
batch_id (optional only for explicitly standalone runs)
evaluation_set_id
evaluation_set_version
pack_content_hash
source_commit_sha
target_id
surface
harness
harness_version
model
effort
trial
started_at
completed_at
status
```

The record also contains denominators and task identity needed to prevent invalid
comparisons. It does not contain secrets.

### 8.5 Comparability guard

Before aggregation, `ax-arena` must reject records that disagree on any
benchmark-controlled dimension, including:

- evaluation set ID/version and pack hashes;
- source revision;
- model and effort;
- harness and harness version, when pinned by policy;
- trial identity and expected trial count;
- batch identity;
- task and score denominators;
- schema version not covered by a declared migration.

This guard must run before rankings or publication outputs are generated.

## 9. Credential and Production Security Design

### 9.1 Credential manifest

The batch planner should produce names, never values:

```json
{
  "cell_id": "...",
  "required_credentials": [
    "NEON_API_KEY",
    "OPENAI_API_KEY"
  ]
}
```

The worker resolves only those names from its selected environment. Missing
requirements fail before invoking the host agent. Extra vendor secrets should
not be present in the process environment.

### 9.2 Workflow stages

Recommended production stages:

1. **Plan:** arena validates suite, roster, source SHA, policy, and batch ID.
2. **Prepare worker:** install or verify pinned harness/tool versions without
   vendor secrets.
3. **Approve environment:** enter the selected target environment.
4. **Execute cell:** invoke one `ax-eval` cell with scoped credentials.
5. **Verify:** read live state and write normalized record.
6. **Cleanup:** run explicit provider cleanup after verification.
7. **Upload:** store record and evidence under batch/cell identity.
8. **Aggregate:** arena validates completeness and comparability.
9. **Publish:** generate outputs from the validated immutable record set.

### 9.3 Immutable revision policy

The controller resolves a requested ref to a full SHA before fan-out. The
secret-bearing worker accepts only that SHA. The workflow must verify the SHA
against the repository's release policy, for example an approved protected-main
commit or signed release tag.

An environment approval is a human authorization control; it is not a source
integrity check. Both are required.

### 9.4 Harness availability and failure detection

Relying on a runner image to happen to contain `codex` or `claude` is not a
stable contract. Add explicit checks such as `codex --version` and `claude
--version`, but checks alone only improve diagnosis.

The reproducible solution is one of:

- install pinned versions in the non-secret preparation stage;
- use a versioned runner image containing pinned versions;
- on a controlled self-hosted runner, verify exact allowed versions and fail
  before entering the secret environment.

Record the resolved versions in every cell record.

## 10. Package and Repository Boundary

### 10.1 Transitional layout

Ownership is now separated inside one repository:

```text
src/                       # existing generic modules
schemas/                   # public core schemas
ax-arena/benchmark/        # private arena npm workspace
ax-arena/benchmark/daeb/   # canonical arena artifacts
```

Dependency rules enforce `arena -> core` only. This makes a later optional
package/repository split mechanical and reviewable.

### 10.2 Public exports

The supported engine entry point is:

```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./schemas/evaluation-cell.v1.json": "./schemas/evaluation-cell.v1.json",
    "./schemas/normalized-cell-record.v1.json": "./schemas/normalized-cell-record.v1.json",
    "./schemas/normalized-result.v1.json": "./schemas/normalized-result.v1.json",
    "./package.json": "./package.json"
  },
  "bin": {
    "ax-eval": "./dist/cli.js"
  }
}
```

The build emits public artifacts from both `src/index.ts` and `src/cli.ts`.
Arena code imports only public exports; direct `src/...` imports are forbidden.

### 10.3 Final package ownership

`ax-eval` package:

- engine/library and one-cell CLI;
- generic schemas and reports;
- generic surface/harness behavior;
- public target packs or adapters that are intentionally reusable;
- no DAEB benchmark artifacts;
- no benchmark-only database dependencies.

`ax-arena` package/repository:

- DAEB methodology and canonical artifacts;
- database providers and runtime dependencies;
- controller/workflows;
- aggregation and publication;
- local workspace dependency on `ax-eval` while private, replaced by a pinned
  released version at the publication gate.

### 10.4 Automated dependency guards

CI checks fail when:

- core imports an arena path;
- core imports benchmark-only database drivers;
- arena imports non-public `ax-eval/src/...` paths;
- the `ax-eval` tarball contains `ax-arena/`, legacy `benchmarks/daeb`, or arena schemas;
- the `ax-eval` dependency tree gains a package classified as arena-only;
- known arena-owned module filenames or declarations are reintroduced into
  core; CLI/help tests separately pin the allowlisted compatibility launchers.

Lexical checks for DAEB or vendor names are useful warnings, not authoritative
rules. Import and package boundaries are the enforceable source of truth.

## 11. Migration Plan

Each phase should be a reviewable PR or small stack. Do not combine semantic
changes with file movement unless tests prove parity independently.

### Phase 0: Freeze and characterize current behavior

**Progress:** Implemented through offline surface/harness fixtures, frozen DAEB
hash/approval tests, ownership guards, and package inspections.

**Changes**

- Capture golden normalized records for representative API, CLI, SDK, and MCP
  fixtures using both harness transcript shapes.
- Capture current DAEB plan, aggregate, and publication fixtures.
- Add a machine-readable inventory assigning every cumulative module, command,
  schema, artifact, workflow, and dependency to core, arena, split, or temporary
  compatibility ownership.
- Record current pack hashes and approval files.
- Add an offline parity test that compares normalized semantic content while
  ignoring documented volatile fields such as timestamps.

**Exit criteria**

- Existing behavior has deterministic offline fixtures.
- Every relevant component has a named destination.
- Pack approvals are unchanged.
- `npm test`, `npm run typecheck`, and `npm run build` pass.

**Rollback**

- Test-only and documentation changes can be reverted without artifact changes.

### Phase 1: Establish the public engine API

**Progress:** Implemented. The public package exports the strict cell/record
schemas, `runCell`, runtime extension contracts, and the one-cell CLI boundary.

**Changes**

- Add `src/index.ts` and package exports.
- Define versioned `EvaluationCell`, `RunCellOptions`, and
  `NormalizedCellRecord` schemas.
- Implement `runCell` by composing existing execution, verification, reporting,
  and record-writing code without changing behavior.
- Add `ax-eval cell run --input --output` using the same schemas.
- Keep current CLI commands as wrappers around the new API.

**Exit criteria**

- A keyless fixture cell runs through the library and subprocess paths.
- Both paths produce semantically equivalent records.
- A package smoke test imports only the published package exports.
- Arena-facing code no longer needs internal file imports.

**Rollback**

- Existing CLI wrappers remain available; callers can return to them while the
  API is corrected.

### Phase 2: Complete explicit runtime extension seams

**Progress:** Registry contracts, per-cell health/provisioning dispatch,
versioned provenance, adapter composition, and reset plan/execute interfaces are
implemented in the cumulative stack. SQL/Mongo verification and DAEB database
reset implementations now live only behind arena-owned providers; core retains
no database driver and its database runtime aliases delegate to arena's
fail-closed trusted-workflow boundary.

**Changes**

- Keep PR #172's oracle behavior but add an immutable provider registry passed
  to verification and `runCell`.
- Introduce reset, provisioning, and health-check provider interfaces.
- Move SQL/Mongo/DB verification, DB reset behavior, Turso provisioning, Nile
  health checks, Convex verification-client routing, legacy Asana prompt
  fallback, and arena naming conventions behind providers or target adapters.
- Retain global registration only as a deprecated compatibility adapter, if
  required.
- Add provider identity/version to provenance.

**Exit criteria**

- Core runtime contains no target-name conditional for these lifecycle stages.
- Two concurrent cells can use different registries without interference.
- Ambiguous or duplicate providers fail deterministically.
- Provider failures are redacted and normalized.
- Verification always precedes cleanup.

**Rollback**

- Compatibility adapters delegate to the old implementation while retaining the
  new call signatures.

### Phase 3: Separate schemas and records

**Progress:** Implemented. Core owns the normalized one-cell record; arena owns
cleanup/result envelopes, batch completion, runtime reporting, comparability,
and publication schemas. Compatibility readers remain for the announced
window.

**Changes**

- Add generic evaluation-set identity fields.
- Define provider extension envelopes.
- Keep generic v1 oracle declaration validation in core while moving SQL/Mongo
  runtime interpretation and provider configuration to arena.
- Split normalized cell schemas from benchmark aggregate/publication schemas.
- Add v1 readers/translators for current fields and artifact paths.
- Define and test the arena comparability guard.

**Exit criteria**

- `ax-eval` validates a cell record without importing arena schemas.
- `ax-arena` rejects incomplete or incomparable record sets.
- Existing v1 records remain readable.
- New records do not require `standard_set_version` as their sole identity.
- No secret values appear in plans, records, or validation errors.

**Rollback**

- Compatibility readers accept legacy schemas and paths for the announced
  window; writers emit only canonical artifacts. Rollback reverts the phase as
  a unit and does not rely on a dual-write path.

### Phase 4: Quarantine arena implementation in-repository

**Progress:** Implemented. The private `ax-arena/benchmark/` npm workspace owns
canonical DAEB files, authoring policy, providers, controller, aggregation, and
publication. Import and package guards enforce the one-way dependency and
tarball ownership boundaries.

**Changes**

- Move DAEB suite synthesis, support matrices, extraction ledgers, production
  policy, aggregation, and publication under an arena-owned tree.
- Split reusable pure extraction/resolution functions from DAEB persistence and
  methodology.
- Move database providers and dependencies to the arena boundary.
- Add import-boundary tests.

**Exit criteria**

- Core has no import path into arena code.
- Arena uses only public core exports.
- The core build succeeds when the arena tree and benchmark artifacts are
  excluded.
- Golden output parity remains within the declared volatile-field exclusions.

**Rollback**

- File moves preserve compatibility re-exports until downstream imports are
  migrated.

### Phase 5: Split CLI and production workflows

**Progress:** Implemented in-repository. `ax-arena benchmark` owns controller,
aggregation, publication, and authoring commands; protected workflow YAML is a
thin matrix launcher over arena-owned planning, worker, assembly, and isolation
scripts. Deprecated `ax-eval` names remain process launchers; their one-minor
compatibility clock begins only when the arena package is available to users.

**Changes**

- Add an `ax-arena` controller CLI for plan, execute, aggregate, and publish.
- Make each production worker run one explicit cell.
- Create one immutable `batch_id` in the controller and pass it to every cell.
- Scope environments and secrets per target and harness.
- validate source SHA and pinned harness versions before secret-bearing steps.
- Move trusted production and publication workflows to arena ownership.
- Keep temporary deprecated `ax-eval` aliases where needed.

**Exit criteria**

- A local serial controller and distributed matrix consume the same plan.
- Every record in a batch has the controller-supplied batch ID.
- No cell process receives unrelated vendor credentials.
- Harness/version absence fails before target secrets are exposed.
- Publication consumes only a complete, comparable record set.

**Rollback**

- Revert this phase as a unit. There is no legacy-orchestrator fallback flag.
  Compatibility launchers remain functional for non-credentialed reporting and
  export commands; `execute`, direct `publish`, `daeb-low-pass`, and
  `daeb-production-rerun` fail closed outside the trusted workflow.

### Phase 6: Split packages and optionally repositories

**Progress:** The private arena npm workspace and package boundary are complete,
and both dry-run tarballs enforce their ownership. Publishing the arena package
with a pinned released `ax-eval` semver starts the compatibility clock. Any
repository split remains an optional later gate after parity sign-off.

**Changes**

- Publish a versioned `ax-eval` package with the stable library API.
- Create `ax-arena` with a pinned engine dependency.
- Move DAEB artifacts, workflows, providers, and DB dependencies.
- Remove arena files from the `ax-eval` package manifest.
- Update contributor and release documentation in both projects.

**Exit criteria**

- `npm pack --dry-run` for `ax-eval` contains no DAEB artifacts.
- A clean `ax-arena` install can execute fixture cells through public exports.
- Package dependency inspection shows no arena-only DB drivers in `ax-eval`.
- Both projects pass offline unit, type, build, and package smoke tests.

**Rollback**

- Pin arena to the last compatible engine version; do not copy core source back
  into arena.

### Phase 7: Remove compatibility paths

**Progress:** Pending the arena package release and its announced one-minor
compatibility window. No compatibility path is removed early.

**Changes**

- Remove global provider registration from normal runtime use.
- Remove deprecated arena commands from the `ax-eval` CLI.
- Remove legacy record/path readers after the announced compatibility window.
- Remove compatibility re-exports and remaining artifact translators when all stored
  canonical data has been migrated or archived.

**Exit criteria**

- No supported workflow depends on deprecated paths.
- Search, import-boundary checks, and package inspection confirm the final
  ownership model.
- A complete benchmark rerun passes parity and publication validation.

## 12. Detailed Ownership Inventory

The exact file list may evolve after the cumulative stack. Use these
classifications as decision rules, not as permission for unreviewed bulk moves.

### 12.1 Keep in ax-eval

- OpenAPI and GraphQL ingestion.
- Pack generation, schema validation, review, and content-hash approval gate.
- Surface adapters for API, CLI, SDK, and MCP.
- Harness profile/invocation and native transcript parsing for Codex and Claude
  Code.
- Generic execution planner for a reviewed pack.
- Generic verification lifecycle and built-in protocol oracles.
- One-cell normalized record and report generation.
- Generic record validation and diffing.
- Explicit cleanup lifecycle and provider interfaces.
- Pure single-target discovery/extraction utilities that have no benchmark
  methodology or persistence dependency.

### 12.2 Owned by ax-arena

- `ax-arena/benchmark/daeb/**` methodology and canonical artifacts (formerly
  `benchmarks/daeb/**` during the one-release read compatibility window).
- DAEB roster, selection ledger, support matrix, suite synthesis, and audit.
- Database pack overrides tied to the canonical arena suite.
- DAEB low-pass and production-rerun policy.
- Hardcoded benchmark models, effort, harness matrix, and three-trial policy.
- SQL/Mongo/DB providers used by the DAEB cohort.
- Cross-trial aggregation and exact-pass policy.
- Cross-target comparison, leaderboard, publication bundle, and export.
- Trusted benchmark execution and publication workflows.
- Arena cell-result, cleanup, batch, reporting, and publication schemas that are
  not part of the generic normalized-cell contract.

Current stack status: DAEB roster, coverage/task-fit, synthesis, extract/suite
audit, pack composition, artifact contracts/readers/writers, and their CLI
handlers live under `ax-arena/benchmark/src/authoring/`. Providers, cell/batch
lifecycle, runtime reporting, aggregation, competitive reporting, publication,
and trusted workflow implementation also live in the arena workspace. Former
`ax-eval` arena commands are one-minor process launchers, not duplicate policy
implementations.

### 12.3 Split by responsibility

- **Vendor/product resolution:** generic resolver in core; DAEB roster decisions
  and artifact paths in arena.
- **Surface extraction:** protocol inspection in core; canonical extract ledger
  and cohort coverage requirements in arena.
- **Capability extraction:** generic product capability model in core if reusable;
  DAEB concept universe, methodology, and selection policy in arena.
- **Registry ingestion:** generic integrations registry ingestion in core; DAEB
  target selection and snapshots in arena.
- **Reset:** lifecycle and safety contract in core; implementations in target or
  arena providers.
- **Provisioning:** lifecycle in core; target installers in providers and pinned
  production images in arena operations.
- **Environment checks:** generic declared-env checks in core; product-specific
  consistency rules in providers.
- **Prompt and verification transport:** generic construction in core; declared
  target-adapter patches for product-specific endpoint, auth, or prompt context.

## 13. Test Strategy

### 13.1 Core unit tests

- Cell schema validation and stable identity.
- Review gate rejects unreviewed or edited packs.
- API/CLI/SDK/MCP surface behavior remains surface-aware.
- Codex and Claude Code transcripts retain native-shape parsing.
- Provider selection, duplicate/ambiguous matches, error normalization, and
  redaction.
- Registry isolation across concurrent cell runs.
- Verification-before-cleanup ordering.
- Standalone cell behavior without a benchmark batch.
- Library and subprocess parity.

### 13.2 Arena unit tests

- Plan expansion produces the complete expected matrix.
- One batch ID is propagated to all cells.
- Credential requirements contain only selected target/harness names.
- Aggregate rejects missing, duplicate, or incomparable cells.
- Trial policy is applied only during arena aggregation.
- Publication refuses incomplete or mixed-batch inputs.
- Ranking and export fixtures remain stable.

### 13.3 Contract tests

- Arena compiles against published `ax-eval` exports, not source paths.
- Every arena provider validates its extension payload.
- Core record schema round-trips through arena ingestion.
- Supported schema-version migrations are explicit and tested.
- A fixture batch executed serially and as a simulated matrix produces identical
  aggregate inputs.

### 13.4 Security tests

- Generated cell environments exclude unrelated credential names.
- Error output and records do not contain fixture secret values.
- Free-form refs are rejected by the secret-bearing worker.
- Missing or wrong harness versions fail before credential resolution.
- Reset dry-run cannot escape declared sandbox scope.

### 13.5 Package tests

- `npm pack --dry-run` contains the public API, CLI, core schemas, examples, and
  approvals required by the engine.
- It excludes `ax-arena/`, legacy `benchmarks/daeb`, arena workflows,
  publication schemas, results,
  secrets, and scratch artifacts.
- A clean temporary consumer imports `runCell` and validates a fixture record.

### 13.6 Required verification per phase

Every behavior-affecting PR must run:

```bash
npm test
npm run typecheck
npm run build
npm --cache .npm-cache pack --dry-run
```

Live benchmark tests remain manual, sandboxed, and post-merge-gated. They do not
replace offline contract tests.

## 14. Observability and Failure Semantics

Each cell should have explicit lifecycle states:

```text
planned
prepared
executing
verifying
verified
cleaning
completed
failed
```

The record must distinguish:

- controller/planning failure;
- worker preparation or missing-tool failure;
- harness invocation failure;
- agent task failure;
- oracle/provider failure;
- cleanup failure after successful verification;
- artifact upload failure.

A cleanup failure must not erase a valid verification result. A verification
failure must not be converted into success by successful cleanup. Retries should
create a new attempt identity while preserving the logical cell identity and
linking the superseded attempt.

## 15. Compatibility and Data Migration

### 15.1 CLI compatibility

- Keep current command names as thin deprecated wrappers for one release window.
- Print machine-readable deprecation metadata where scripts consume JSON.
- Do not silently change a command from many cells to one cell; introduce the
  explicit `cell run` contract first.
- Document the replacement arena command in help and public guides.

### 15.2 Pack compatibility

- Do not mutate reviewed pack content solely to move runtime implementations.
- Preserve approval hashes when semantic pack content is unchanged.
- Translators from legacy SQL/Mongo fields should operate after review-hash
  validation, not rewrite the reviewed source invisibly before hashing.
- Any semantic schema change requires a version bump and renewed approval.

### 15.3 Record compatibility

- Read existing records through an explicit v1 adapter.
- Add new identity fields without changing old field meanings.
- Dual-write only for a bounded transition period.
- Never compare translated and native records without recording the migration
  version used.

### 15.4 Artifact path compatibility

- Canonical artifacts live under `ax-arena/benchmark/daeb/`; writers never use
  the former root.
- During the one-minor-release read window, readers use `benchmarks/daeb/` only when
  the canonical root is absent and emit a deprecation warning.
- If both roots exist, callers must choose explicitly with `--benchmark-root`
  or a `DaebPathContext`; no manifest, duplicate tree, or symlink alias is used.
- The relocation preserves canonical artifact and approval bytes. Immutable
  published bundles retain their historical references.

## 16. Risks and Mitigations

### Risk: The new API simply wraps existing orchestration

**Mitigation:** enforce that `runCell` accepts one harness and one trial and add a
test that rejects a matrix-shaped input.

### Risk: Global providers become permanent

**Mitigation:** mark global registration deprecated immediately, add injected
registry support in the next phase, and test concurrent registry isolation.

### Risk: File moves conceal behavior changes

**Mitigation:** establish golden fixtures first and separate movement from policy
changes.

### Risk: Provider envelopes weaken validation

**Mitigation:** require strict provider schemas and fail before execution when a
selected provider cannot validate its payload.

### Risk: Core still depends on arena transitively

**Mitigation:** enforce package dependency and import rules in CI, then smoke-test
the packed engine in a clean consumer.

### Risk: Batch retries create duplicate publication inputs

**Mitigation:** distinguish logical cell ID from attempt ID; aggregation accepts
one explicitly selected terminal attempt per logical cell.

### Risk: Secret scoping is implemented only by convention

**Mitigation:** derive required credential names from the immutable cell plan and
use vendor-specific environments/jobs that cannot access other vendor secrets.

### Risk: Target adapters are mistaken for arena coupling

**Mitigation:** judge code by dependency direction and policy ownership. Reusable
target packs/adapters may remain core-compatible; benchmark roster decisions may
not.

### Risk: Local and production paths drift

**Mitigation:** both paths consume the same cell schema and invoke the same
`runCell` behavior; only scheduling and credential resolution differ.

## 17. Pull Request Sequencing Guidance

Prefer a dependency-ordered stack with each PR independently testable:

Items 1–11 are implemented in the in-repository stack. Item 12 is an optional
release/repository decision; item 13 begins only after the announced one-minor
compatibility window.

1. Characterization fixtures and ownership inventory.
2. Public schemas and package export, with no behavior change.
3. `runCell` library API and one-cell CLI.
4. Injected oracle registry replacing required global state.
5. Reset provider seam and migrated implementations.
6. Provisioning and health-check seams.
7. Core/arena schema split and compatibility readers.
8. Arena quarantine plus import-boundary enforcement.
9. Arena controller and externally supplied batch ID.
10. Scoped production workflows and immutable source/harness provenance.
11. Aggregation/publication move with parity fixtures.
12. Package/repository split.
13. Compatibility removal after the announced window.

Each PR description should state:

- ownership boundary changed;
- behavior intentionally unchanged or changed;
- compatibility path added or removed;
- tests proving the boundary;
- rollback method;
- next dependent PR.

## 18. Definition of Done

The separation is complete only when all statements below are true:

- `ax-eval` exposes a supported, versioned library API.
- One call to `runCell` executes exactly one fully specified evaluation cell.
- Local serial and production distributed runs use the same cell schema and
  engine implementation.
- `ax-eval` does not select benchmark vendors, models, effort, trial count, batch
  identity, completeness, ranking, or publication policy.
- Oracle, reset, provisioning, and product-specific health behavior are supplied
  through explicit per-cell extensions.
- Product-specific prompt and verification transport behavior is selected through
  declared target adapters, with name-based matching confined to compatibility
  code.
- Normal runtime does not depend on mutable global provider state.
- The normalized cell record schema is owned by `ax-eval`.
- Aggregate, leaderboard, and publication schemas are owned by `ax-arena`.
- DAEB artifacts and database-only runtime dependencies are absent from the
  `ax-eval` package.
- `ax-arena` imports only public `ax-eval` exports.
- Core-to-arena imports are blocked in CI.
- The arena controller creates one immutable batch ID and passes it to every
  cell.
- Every production cell receives only selected target and harness credentials.
- Secret-bearing execution uses an approved immutable source SHA.
- Harness/tool versions are pinned or verified before secret-bearing execution
  and recorded in provenance.
- Existing reviewed pack semantics and verification-before-cleanup ordering are
  preserved.
- Both harness transcript formats and all four surfaces remain covered.
- Existing v1 records remain readable for the declared compatibility period.
- Golden fixtures demonstrate semantic parity across canonical publication
  moves.
- Core, arena, package, schema, and security test suites pass.

## 19. Historical Recommendation for PR #172 (Completed)

PR #172 was correctly treated as the first extension-boundary PR, not as the
complete arena separation. The seven follow-on recommendations below are
implemented in the cumulative stack and retained here for audit provenance.

Before treating the oracle seam as final:

1. keep the current fallback behavior and tests;
2. add explicit registry injection into verification and `runCell`;
3. define deterministic duplicate and ambiguity handling;
4. record provider identity/version in result provenance;
5. document the global registry as transitional;
6. follow immediately with reset, provisioning, and health-check seams;
7. avoid moving benchmark files until characterization fixtures and the public
   cell contract exist.

This ordering turned PR #172 into a stable dependency-inversion step and
prevents the migration from replacing direct imports with hidden global coupling.

## 20. Audit Conclusion

The architectural direction proved sound: the true boundary is the complete
cell lifecycle and its artifact contract, not oracle dispatch alone.

`ax-eval` now answers:

> Given one reviewed pack, one surface, one harness/model/effort selection, one
> trial identity, scoped credentials, and explicit runtime extensions, what
> happened and what normalized evidence was produced?

`ax-arena` now answers:

> Which cells constitute this benchmark, how are they securely scheduled, when
> is the batch complete and comparable, and how are results aggregated and
> published?

Those questions are answered by different packages with a one-way public
dependency. Compatibility launchers and legacy path readers remain bounded
release mechanics rather than shared policy implementations.
