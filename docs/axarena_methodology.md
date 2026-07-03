# AXArena Methodology

**Status:** current working methodology for publication-grade canonical suites  
**Scope:** DAEB-1 first, then generalize  
**Owners:** maintainers of `ax-eval` / AXArena

## 1. Purpose

AXArena now treats benchmark construction as **two linked but separate products**:

1. **Discoverability & Readiness**
   Measures whether an agent can *find and understand* the surface.
2. **Usability Canonical Suite**
   Measures whether an agent can *actually complete verified tasks* end to end.

These two products are published together, but they are **never collapsed into one score**.

The key design rule is:

- **Discoverability & Readiness explains discoverability and exposure.**
- **Usability Canonical Suite explains operational usability under verified outcomes.**

This separation is load-bearing. A strong docs site cannot improve a weak pass rate, and a high pass rate cannot hide poor discoverability.

## 2. Methodology Contract

The suite pipeline uses one shared ontology across authoring, execution, grading, and publication.

### Ontology

- **task**: a single benchmark problem with fixed intent and success criteria
- **trial**: one attempt at a task in a fresh environment
- **grader**: logic that scores an outcome or transcript-derived property
- **transcript**: behavior evidence from the run
- **outcome**: final world state after the trial
- **evaluation harness**: the end-to-end system that runs suites, records transcripts, executes graders, and aggregates results
- **agent harness**: the runtime that enables a model to act in the environment
- **support decision**: recorded judgment about whether a vendor/surface can perform a task
- **selection decision**: recorded judgment about whether a concept becomes part of the canonical suite
- **suite**: the frozen task bank for a category
- **publication bundle**: the artifact set tying methodology, adapters, evidence, and results together

This ontology follows Anthropic's evaluation structure closely for `task`, `trial`, `grader`, `transcript`, `outcome`, `evaluation harness`, `agent harness`, and `evaluation suite`, while retaining AXArena-specific implementation terms such as `TargetPack` and verification extracts where the benchmark needs product-specific executable adapters.

### Non-negotiable benchmark rules

- Canonical suite benchmark scope is **`api` / `sdk` / `cli` only**
- **MCP is out of canonical usability-suite scope for v1**
- Discoverability & Readiness and usability-suite scoring are **separate layers**
- Support judgments are computed **before** outcome-verifier authoring
- Outcome correctness is the **primary authority**
- Transcript and efficiency are **secondary diagnostics**
- Every benchmark decision that affects selection or scoring must be **persisted as an artifact**
- Human review is mandatory at:
  - methodology revision
  - suite freeze
  - publication bundle release

## 3. Publication Layers

### 3.1 Discoverability & Readiness

Discoverability & Readiness answers:

- Can an agent find the relevant surface?
- Can it find the authoritative content quickly?
- Is the capability actually exposed in official docs?
- Is auth/protocol access legible enough for an external agent?

Discoverability & Readiness is a **publication/audit layer**, not a success-rate adjustment.

Its content-quality sublayer is grounded in the Hermes paper, *Making OpenAPI Documentation Agent-Ready*, which gives us a benchmarkable smell taxonomy for whether a found OpenAPI artifact is actually usable by an agent rather than merely structurally valid.

### 3.2 Usability Canonical Suite

Usability Canonical Suite answers:

- Given a fixed canonical task bank, can an agent complete each task?
- Does verification confirm the outcome in live world state?
- Which surfaces are actually supported for that task?
- Where do failures come from: product, agent, environment, or evaluation?

Usability-suite scoring is governed only by **verified task outcomes**.

## 4. Pipeline Overview

The canonical suite pipeline is now:

1. Resolve vendors
2. Extract capability inventory
3. Derive concept universe
4. Close coverage gaps
5. Build coverage matrix
6. Build selection ledger
7. Draft canonical tasks
8. Build support matrix
9. Extract vendor-specific verification configs
10. Compose packs
11. Run / verify
12. Publish bundle

Each stage produces persisted artifacts so the suite can be audited or reproduced.

## 4.1 Current Orchestration Boundary

The current repo implementation is still fundamentally **single-harness-per-command**, not a fully distributed sub-agent control plane.

What that means in practice:

- CLI commands such as `extract-capabilities`, `extract-tasks`, `extract-surfaces`, and `synthesize-suite` choose one generator harness per command invocation.
- There is already meaningful **intra-command parallelism** in code:
  - `extract-capabilities` runs per-vendor work in parallel
  - `task-extract` runs per `(vendor, task)` unit in parallel
- But these are still parent-process orchestrated async jobs, not benchmark-authoritative artifacts written independently by worker agents.

The methodology boundary is therefore:

- **Parallel proposal generation** is allowed at vendor- or concept-scoped seams.
- **Benchmark-authoritative reduction** stays centralized in the parent process.

For the current repo, the cleanest proposal-generation seam is:

- `extract-capabilities`

Likely later fan-out seams:

- `(vendor, concept)` gap adjudication
- per-concept canonical task drafting

Stages that must stay centralized and deterministic:

- concept universe
- coverage matrix
- selection ledger
- support matrix
- final frozen suite YAML

This split is deliberate. It preserves one canonical concept partition and one canonical support/selection record, while still allowing speedups at the proposal-generation edges.

## 4.2 Current DAEB-1 Compiler Shape

For the current `database` suite, the repo no longer relies on a one-shot global model call to derive the concept universe.

Instead, the compiler now does the following:

- capability inventory remains docs-grounded and vendor-local
- concept universe is derived deterministically from the inventory corpus using family-aware concept normalization
- coverage closure still allows grounded gap adjudication
- selection remains code-enforced from persisted artifacts
- the canonical task wording for the current DAEB-1 top concepts is emitted from deterministic templates

This is intentionally more reproducible than the earlier all-generator flow. The benchmark-authoritative artifacts for DAEB-1 are now mostly compiler products, not fragile prompt-only outputs.

## 5. Stage-by-Stage Method

### 5.1 Vendor Resolution

**Decision**

- Start from vendor identity and docs root.
- Treat resolution as a lightweight discovery stage, not as benchmark selection.

**Metrics**

- None used for scoring directly.
- This stage exists to anchor later official-doc evidence.

**Artifacts**

- `targets/vendors/<slug>.discovered.yaml`

**Code**

- [`src/generate/vendor-resolve.ts`](/Users/richardtang/ax-eval/src/generate/vendor-resolve.ts)
- CLI entry in [`src/cli.ts`](/Users/richardtang/ax-eval/src/cli.ts)

### 5.2 Capability Inventory

**Decision**

- Replace “top 10–20 important capabilities” with a **benchmark-grade inventory**.
- Official docs are mandatory evidence.
- Persist **every benchmark-relevant documented capability**, not just a curated subset.
- Capability families are normalized so clustering can happen on a stable representation.

**Required capability fields**

- `capability_name`
- `family`
- `title`
- `description`
- `resource_kind`
- `operation_kind`
- `surfaces_documented`
- `support_type`
- `evidence[]`
- `extraction_provenance`

**Metrics**

- Inventory size by vendor
- Family coverage by vendor
- Surface exposure by capability

These are not rank metrics by themselves; they are input completeness metrics.

**Artifacts**

- `targets/extracts/<slug>/capability-inventory.yaml`
- legacy mirror: `targets/extracts/<slug>/capabilities.yaml`

**Code**

- [`src/generate/capability-extract.ts`](/Users/richardtang/ax-eval/src/generate/capability-extract.ts)
- schema + read/write helpers in [`src/generate/methodology.ts`](/Users/richardtang/ax-eval/src/generate/methodology.ts)

### 5.3 Concept Universe

**Decision**

- The benchmark must cluster the **full extracted universe**, not only a hand-picked candidate list.
- Every extracted capability must land in exactly one concept cluster.
- Singleton clusters are preserved for auditability even if they will not survive selection.
- For DAEB-1 `database`, concept clustering is now **deterministic and family-aware** instead of a one-shot global generator pass.

**Metrics**

- Number of concepts
- Number of singleton concepts
- Number of multi-vendor concepts
- Coverage distribution across concepts

**Artifacts**

- `<suite>.concept-universe.yaml`

**Code**

- [`src/generate/coverage-gap-check.ts`](/Users/richardtang/ax-eval/src/generate/coverage-gap-check.ts)
- artifact schema in [`src/generate/methodology.ts`](/Users/richardtang/ax-eval/src/generate/methodology.ts)
- suite integration in [`src/generate/synthesize-suite.ts`](/Users/richardtang/ax-eval/src/generate/synthesize-suite.ts)

**Current DAEB-1 implementation**

- Database capability slugs are normalized into benchmark concepts such as `define-data-container`, `query-records`, `inspect-schema`, `evolve-schema`, `access-control`, `backup-and-restore`, `server-side-execution`, `vector-search`, and `change-data-capture`.
- Unmatched capabilities are preserved as singleton concepts rather than dropped.
- This eliminates the previous single-call clustering bottleneck and makes the concept universe reproducible from the inventory corpus.

### 5.4 Coverage Gap Closure

**Decision**

- Any concept cited by multiple vendors but not all vendors must be explicitly closed.
- A missing capability mention is ambiguous until gap-check says:
  - `supported`
  - `unsupported`
  - `inconclusive`
- This stage is a **required compiler step**, not a repair script.

**Metrics**

- Count of unresolved `(concept, vendor)` gaps
- Share of gaps closed to `supported`
- Share of gaps closed to `unsupported`
- Share remaining `inconclusive`

**Artifacts**

- Incorporated into `<suite>.coverage-matrix.yaml`

**Code**

- [`src/generate/coverage-gap-check.ts`](/Users/richardtang/ax-eval/src/generate/coverage-gap-check.ts)
- [`src/generate/synthesize-suite.ts`](/Users/richardtang/ax-eval/src/generate/synthesize-suite.ts)

**Execution discipline**

- Gap adjudication now runs with controlled concurrency rather than unbounded fan-out.
- This is an orchestration reliability change, not a methodology change: the artifact contract is the same, but harness/runtime behavior is more stable and reproducible.

### 5.5 Coverage Matrix

**Decision**

- Persist a matrix over `(concept, vendor)` before task wording.
- This matrix is the authoritative support-closure record for concept-level coverage.

**Per-cell states**

- `supported`
- `unsupported`
- `inconclusive`

**Metrics**

- Coverage percentage per concept
- Covered vendor count per concept
- Number of inconclusive cells
- Family distribution among supported concepts

**Artifacts**

- `<suite>.coverage-matrix.yaml`

**Code**

- schema in [`src/generate/methodology.ts`](/Users/richardtang/ax-eval/src/generate/methodology.ts)
- construction in [`src/generate/synthesize-suite.ts`](/Users/richardtang/ax-eval/src/generate/synthesize-suite.ts)

### 5.6 Selection Ledger

**Decision**

- Task selection is not just prompt output.
- LLMs may propose cluster labels and rationale, but **final eligibility is code-enforced**.
- Selection is governed by methodology thresholds:
  - `surface_scope = [api, sdk, cli]`
  - `min_vendor_coverage_pct`
  - `target_task_count`
  - `family_diversity_cap`
  - `verifiability_requirement`
  - `difficulty_rubric`

**Selection logic**

- Reject concepts below minimum vendor coverage
- Reject concepts that are not independently verifiable
- Reject concepts beyond the family diversity cap
- Record whether the model proposed the concept
- Record whether deterministic fallback promoted it
- Persist rejection reasons for non-selected concepts

**Metrics**

- selected / rejected concept counts
- coverage percentage per selected task
- difficulty spread across selected tasks
- family spread across selected tasks
- count of deterministic fallback promotions

**Artifacts**

- `<suite>.selection-ledger.yaml`

**Code**

- methodology defaults in [`src/generate/methodology.ts`](/Users/richardtang/ax-eval/src/generate/methodology.ts)
- selection construction in [`src/generate/synthesize-suite.ts`](/Users/richardtang/ax-eval/src/generate/synthesize-suite.ts)

### 5.7 Canonical Task Drafting

**Decision**

- Task wording is authored only after concept selection is frozen.
- Task prompts remain vendor-agnostic and outcome-oriented.
- Drafting is allowed to use LLM assistance, but only after coverage and selection are already persisted.
- For the current DAEB-1 `database` suite, the selected top concepts are emitted from deterministic task templates to remove generator flakiness from the suite-freeze step.

**Metrics**

- Task count
- Difficulty distribution
- Surface scope compliance
- verification-hint quality is reviewed, not numerically scored here

**Artifacts**

- suite YAML: `targets/suites/<suite>.yaml`
- synthesis doc: `targets/suites/<suite>.synthesis.md`

**Code**

- [`src/generate/synthesize-suite.ts`](/Users/richardtang/ax-eval/src/generate/synthesize-suite.ts)
- suite schema in [`src/generate/suite.ts`](/Users/richardtang/ax-eval/src/generate/suite.ts)

**Current DAEB-1 implementation**

- The current deterministic templates cover the publication-grade database concepts selected into V3, including:
  - `access-control`
  - `backup-and-restore`
  - `change-data-capture`
  - `define-data-container`
  - `evolve-schema`
  - `inspect-schema`
  - `query-records`
  - `server-side-execution`
  - `vector-search`
  - `write-records`
- This keeps suite wording reproducible while still allowing later review-driven refinement.

### 5.8 Support Matrix

**Decision**

- Support judgments must be independent from outcome-verifier authoring.
- Compute a `(task, vendor, surface)` support matrix before task-extract.
- This matrix controls what can be marked `na` or `na_surfaces`.
- Surface support is **not inherited** across surfaces. In particular, SDK support
  must not be inferred from API support.
- SDK support requires explicit evidence that the official SDK/client-library path
  can complete the concrete canonical task, not merely that the vendor has an SDK.

**DAEB-1 SDK support policy**

- Data-plane SDKs are only eligible for tasks they can complete from the benchmark
  sandbox without hidden baseline setup. A CRUD/query SDK does not automatically
  support schema creation, migrations, RLS/access policies, triggers, functions,
  backups, CDC, or project/branch management.
- SQL-wire or control-plane SDKs remain eligible when official evidence shows they
  can execute the required SQL/DDL or management operation.
- Unsupported `(task, vendor, sdk)` cells are excluded from the execution and
  scoring denominator; they are not counted as behavioral failures.
- Current DAEB-1 V3 SDK audit:
  - Supabase SDK: `0` eligible tasks. Supabase JS is data-plane only for this
    blank-sandbox suite; schema/control-plane tasks are unsupported.
  - Neon SDK: `8` eligible tasks. SQL/DDL tasks remain eligible through the
    serverless driver; backup and CDC are excluded.
  - MongoDB Atlas SDK: `7` eligible tasks. MongoDB Node driver data-plane,
    schema-validator, change-stream, vector, query, and write tasks remain
    eligible; Atlas backup/access-control/named-routine tasks are excluded.
  - Turso SDK: `6` eligible tasks. libSQL SQL data-plane tasks remain eligible;
    access-control, backup, CDC, and server-side routine tasks are excluded.
  - CockroachDB SDK: `10` eligible tasks through the Postgres-compatible `pg`
    SQL-wire path.
  - Convex and Insforge SDK: `0` eligible tasks until a benchmark-declared
    official SDK path is evidenced.

**Per-entry fields**

- `vendor`
- `task_id`
- `surface`
- `status`
- `source_concept`
- `reason`

**States**

- `supported`
- `unsupported`
- `inconclusive`

**Metrics**

- supported surface count by task
- supported surface count by vendor
- unsupported surface count by vendor
- matrix completeness across all vendors and selected tasks

**Artifacts**

- `<suite>.support-matrix.yaml`

**Code**

- schema in [`src/generate/methodology.ts`](/Users/richardtang/ax-eval/src/generate/methodology.ts)
- construction in [`src/generate/synthesize-suite.ts`](/Users/richardtang/ax-eval/src/generate/synthesize-suite.ts)
- consumption in [`src/generate/task-extract.ts`](/Users/richardtang/ax-eval/src/generate/task-extract.ts)
- enforcement in [`src/generate/compose-pack.ts`](/Users/richardtang/ax-eval/src/generate/compose-pack.ts)

### 5.9 Verification Extraction

**Decision**

- `task-extract` is now an **adapter authoring** stage, not a support-judgment stage.
- Verification extraction follows the same architecture as the original pack generator:
  deterministic rule-derived seed first, assisted authoring only for uncovered gaps.
- It may write outcome-verifier logic, but it may not invent support claims.
- If support matrix exists, task-level `na_surfaces` and support references are derived from matrix decisions. A deterministic seed may still preserve whole-task `na=true` when the concept-level support decision is too broad for the concrete task wording and no outcome-verifiable adapter exists.
- For DAEB-1 V3, all active vendors now use deterministic verifier seeds for the selected canonical tasks.

**Metrics**

- seed coverage by vendor and task
- generator fallback count by vendor and task
- executable tasks with at least one check
- N/A tasks with support reference
- surface-excluded tasks with support reference
- checks per task

**Artifacts**

- `targets/extracts/<slug>/<suite>.yaml`

**Code**

- [`src/generate/task-extract.ts`](/Users/richardtang/ax-eval/src/generate/task-extract.ts)
- Convex verification-client adapter in [`src/generate/verification-client.ts`](/Users/richardtang/ax-eval/src/generate/verification-client.ts)

**Execution discipline**

- Verification extraction first attempts a deterministic seed for the vendor config and each `(vendor, task)` adapter.
- Seeded adapters do not invoke a generator; this keeps known database verifier patterns fast and reproducible.
- Unseeded adapters are decomposed per `(vendor, task)` plus one vendor-level config record.
- The current implementation now uses controlled concurrency both:
  - within a vendor's task extraction fan-out
  - across vendors
- This is an orchestration reliability requirement for publication-quality bundles: uncontrolled fan-out makes traces noisy, increases harness flakiness, and weakens reproducibility.

**Current DAEB-1 V3 status**

- Seeded, composed, env-checked, and reviewed: `supabase`, `neon`, `cockroachdb`, `insforge`, `turso`, `mongodb-atlas`, `convex`
- `supabase`, `neon`, `cockroachdb`, and `insforge` use Postgres SQL verifier seeds where live state is best read through the wire protocol.
- `turso` uses deterministic HTTP Data API verifier-body templates against `/v2/pipeline`.
- `mongodb-atlas` uses deterministic MongoDB wire-protocol verifier checks through the official `mongodb` driver.
- `convex` uses deterministic `/api/query` and `/api/action` verifier-body templates. Agents must report the deployed function path fields requested by the executor prompt so the harness can read back durable state without trusting free-form claims. Convex verification is intentionally adapter-specific: the verifier follows the agent-discovered preview deployment URL and omits deploy-key bearer auth for public function read-back.
- `Planetscale` was removed from the active suite because it no longer has a usable free tier for this benchmark.
- Pre-execution env gates now include auth envs, SQL/Mongo verifier envs, and `${ENV_VAR}` placeholders in pack URL/verifier templates.

**Current execution-learning status**

- DAEB-1/database is treated as the flagship vertical benchmark, not proof that every category is already generic.
- The core artifact architecture remains generic: capability inventory, concept universe, coverage matrix, selection ledger, support matrix, suite YAML, vendor-specific verifier adapters, execution, verification, reporting, and publication.
- Database-specific deterministic seeds/templates/verifiers are allowed, but they must remain isolated in database-specific generation or verifier branches.
- Current publication-grade execution decision: keep existing cell/batch execution mode for compatibility and smoke/regression comparisons, but move DAEB-1 publication evidence toward task-level execution. The desired publication lane is one canonical task per invocation, one task-level result JSON, one task-level trace, one task-level transcript, and one task-level invoke meta, later aggregated back into the existing cell-level normalized record.
- Two-phase DAEB-1 execution model:
  - Phase A: discovery/bootstrap per `{vendor, surface, harness, profile}`. Persist a concise runbook containing auth/base URL/CLI/SDK setup quirks and official docs links.
  - Phase B: per-task execution. Each prompt receives only the task, exact namespace/resource names, verifier-critical expected state, surface-specific allowed path, the concise runbook, and shared database contracts once.
- Prompt compaction rule: do not repeat long SQL/database contracts or all other tasks inside every execution prompt. Methodology prose belongs in docs and artifacts, not in live task prompts.
- Runtime-validity diagnostics are now first-class evidence fields: `validity_status`, `first_action_latency_ms`, `transcript_event_count`, and `action_occurred`. `runtime_timeout_no_action` and `runtime_timeout_partial` are harness/runtime validity evidence, not product capability scores.
- `--first-action-timeout <seconds>` is the execution stop-loss for high-effort no-action stalls. For DAEB-1 publication learning, use `120–180s` and at most one intentional rerun. Do not wait the full wall timeout when no tool/API/command action occurred.
- Token/cost status: latency and tool-call count are measured from invoke meta/transcripts. Token usage is parsed only when the harness transcript exposes usage fields. Token cost remains `null` until a versioned pricing table exists; unavailable cost must be documented as unavailable, not estimated.
- Initial Supabase API/Codex smoke evidence:
  - `low` / `gpt-5.5`: `9/9` verified tasks passed after database identifier, vector, query-record, and CDC wording fixes.
  - `high` / `gpt-5.5`: `7/9` verified tasks passed; failures were `vector-search` and `write-records`.
  - `low` used 11 transcript-derived tool calls; `high` used 23 transcript-derived tool calls.
- Current bug classification from the Supabase smoke:
  - Generic harness/tooling bug: Codex structured-output partial progress messages could be persisted as result files with empty metadata; fixed by exact metadata enums in the Codex output schema and stamping empty metadata from invoke options.
  - Generic harness/tooling bug: invoked agents could accidentally print secret-shaped values into stdout/transcripts; fixed with prompt hygiene plus artifact redaction before stdout/stderr/transcript/results/trace/meta are persisted.
  - Generic harness/tooling bug: host CLIs can also write their own session caches under isolated `.invoke-home` directories, bypassing the primary stdout/transcript artifacts. `runInvokeHarness` now redacts text files under `.invoke-home` when that isolated HOME is provided.
  - Generic harness/tooling bug: executor prompts contradicted themselves by telling agents to read `.env` while also forbidding `.env` file reads; fixed by making the contract explicit that declared `.env` values are preloaded into child-process `process.env` and agents should only read specific env var names silently.
  - Generic harness/tooling bug: generic/temp packs with no declared auth inherited a legacy Asana credential block. The legacy fallback is now limited to Asana packs; other no-auth packs explicitly say no credential env var is declared.
  - Generic methodology/artifact bug: normalized records lacked efficiency fields; fixed with additive `latency_ms`, `tool_call_count`, `token_usage`, and `token_cost` fields.
  - Database-category seed/template/verifier bug: SQL identifiers containing hyphenated namespaces needed quoting; vector/query/CDC task wording and verifier expectations needed alignment.
  - Agent execution failure: Supabase high-profile `vector-search` used an invalid Postgres vector type path, and `write-records` produced an internally inconsistent SQL/JS flow. Because the low-profile run passed the same pack, these are not generalized yet.
- Supabase SDK/Codex low smoke evidence:
  - `v1`: `0/8`; agent opened `.env` and produced all-null task ids. Secret redaction kept artifacts clean, but the prompt contract was wrong.
  - `v2`: `0/8`; agent no longer opened `.env`, but failed because Supabase JS could not find project SQL RPC helpers such as `exec_sql`, `execute_sql`, or `run_sql`, so no tables/functions could be created through the SDK-only surface.
  - Post-audit classification: the prompt contradiction was a generic harness/tooling bug; the remaining `0/8` is not a publication score because Supabase SDK has `0` eligible DAEB-1 V3 tasks under the stricter support matrix. Supabase JS support is not inherited from API support.
- Supabase CLI/Codex low smoke evidence:
  - `low` / `gpt-5.5`: `6/7` verified CLI tasks passed; latency was about `98.7s`, with `13` transcript-derived tool calls.
  - The single failure was `db-T10-write-records`: the agent first attempted a multi-CTE write flow, then retried with separate insert/update/delete commands, leaving two `final_{ns}` rows. The verifier correctly expected exactly one surviving final row.
  - Classification: `agent-execution-failure`. This does not justify changing the outcome verifier or weakening the task; the API low run already passed the same verifier, and CLI completed the other schema-heavy tasks.
  - `low-v2` / `gpt-5.5`: native Codex CLI low rerun verified `6/7`; latency was `198.186s`, with `14` transcript-derived tool calls. The same T10 task failed again, but with a different residual state: exactly one `final_{ns}` row existed, while one `delete_me_{ns}` throwaway row remained after a partial CTE attempt plus follow-up retry.
  - Cross-run T10 classification: repeated Supabase CLI failures are still agent execution failures for the cell, but the repeated lifecycle-retry pattern exposed a database-category prompt-contract clarity bug. SQL-backed T10 prompts now include an exact postcondition contract: before reporting, read back one `final_{ns}` row, zero `draft_{ns}` rows, and zero `delete_me_{ns}` rows, and repair only the run-scoped table if a partial retry leaked marker rows.
  - `high-v1` / `gpt-5.5`: native Codex CLI high timed out after `967.065s` before any command execution. Transcript contains only `thread.started` and `turn.started`, so verifier found `0/7` reported gids and all tasks failed. Classification: `agent-runtime-timeout-before-first-action`, not a Supabase CLI capability failure, verifier bug, or scored vendor usability failure.
  - Contrast with SDK: CLI can perform the schema-heavy setup through `supabase db query --linked`; SDK cannot create the required tables/functions without a pre-existing SQL RPC. This supports treating the current Supabase SDK failure as a surface support/baseline-ops question, not a core suite/verifier failure.
- Neon API/Codex low smoke evidence:
  - `v1`: `0/10`; agent discovered Neon API auth/base URL but attempted `POST /projects` and hit `org_id is required`.
  - Fix: `compose-pack` now adds Neon sandbox scope for `NEON_PROJECT_ID` and optional `NEON_BRANCH_ID`, so agents are told to use the existing sandbox project/branch instead of creating a fresh project.
  - `v2`: `10/10` verified tasks passed; latency was about `63.7s`, with `9` transcript-derived tool calls.
  - Classification: `vendor-specific-adapter-bug`. The engine and verifier were correct; the Neon adapter omitted required sandbox context from the pack.
  - Generic harness/tooling redaction fix from this run: DSN redaction now only matches real URI schemes, avoiding accidental redaction of package names such as `postgrest-js`; large fetched vendor-doc HTML outputs are not useful publication evidence and should be pruned or summarized.
- Neon SDK/Codex low smoke evidence:
  - `v1`: `0/10` under the pre-audit matrix; latency was about `65.7s`, with `6` transcript-derived tool calls.
  - The agent installed and read `@neondatabase/serverless` official package docs/types and discovered the connection-string based SQL client path.
  - All task attempts failed with the same SDK usage error: the installed SDK now requires `sql\`...\`` tagged-template calls or `sql.query(...)`, but the agent called the query function as a conventional `sql("...", values)` function.
  - Post-audit classification: `agent-execution-failure` for the SDK-eligible SQL/DDL subset, but the denominator is now `8`, not `10`, because Neon backup and CDC are not evidenced through the serverless driver SDK path.
  - `v2`: `0/8` under the stricter SDK denominator. The agent connected to Neon through the SDK, but every SQL-backed task failed on unquoted hyphenated SQL identifiers derived from `{ns}`. Classification: `database-category seed/template/verifier bug`.
  - Fix: SQL-backed database packs now include a database-specific SQL identifier contract telling agents to double-quote canonical table/function/policy/index/trigger identifiers containing `{ns}`, while preserving exact canonical names for verifier read-back.
  - `v3`: `7/8`; latency was about `100.8s`, with `15` transcript-derived tool calls. The identifier contract fixed the schema/data tasks. The remaining failure was `db-T08-server-side-execution`: the agent created a zero-argument SQL function body that referenced `$1`, so the routine was never created. Classification: `agent-execution-failure` with a database prompt-hardening follow-up.
  - Fix: SQL-backed T08 prompts now include a server-side routine contract: create a zero-argument routine that returns the literal marker directly, and do not rely on bind parameters inside `CREATE FUNCTION` or `CREATE PROCEDURE`.
  - `v4`: `7/8`; latency was about `89.8s`, with `16` transcript-derived tool calls. T08 passed after the routine contract. The remaining failure is `db-T01-access-control`: the agent created the protected table but then hit `permission denied to set role` while trying to verify/use a run-created role, leaving zero allowed rows. Classification: `agent-execution-failure` / product-permission interaction for now, not an SDK support-denominator issue.
  - Current post-audit conclusion: Neon SDK is eligible for `8` DAEB-1 V3 SQL/DDL tasks and currently smokes at `7/8` for Codex low. Unsupported backup/CDC cells remain excluded from denominator rather than counted as failures.
  - Watch item: if high-profile Neon SDK or other SDK cells repeat SDK signature-misuse patterns, reconsider whether SDK execution prompts need a generic "confirm callable signature from installed types" scaffold. Do not add vendor-specific answer hints from this single failure.
- Neon CLI/Codex low smoke evidence:
  - `v1`: `10/10` verified tasks passed; latency was about `328.7s`, with `36` transcript-derived tool calls.
  - This gives a useful cross-surface contrast: Neon API and CLI both passed in the same sandbox, while SDK failed on a client-call signature mistake. Current evidence points to SDK agent execution failure, not a Neon-wide product or verifier failure.
  - The run exposed a generic sandbox-scope guardrail gap: when backup branch creation hit a branch quota, the agent deleted a pre-existing stale eval branch to free capacity before retrying.
  - Classification for the pass result: verified outcome success. Classification for the deletion behavior: `generic-harness-tooling-bug`.
  - Fix: executor prompts now explicitly forbid deleting, resetting, overwriting, or mutating pre-existing resources not created in the current run. If a quota or sandbox limit blocks a task, the agent must record that task as failed instead of cleaning up unrelated resources.
  - Native full-slice regression: a later native Codex full slice showed CLI low `0/10` and CLI high `5/10`; the low trace failed every SQL-backed task with `Multiple roles found for the branch, please provide one with the --role-name option`. Classification: `vendor-specific-adapter-bug` in the Neon CLI prompt contract, not a verifier/report bug.
  - Fix: Neon composed prompts now include a CLI role/database contract: when using `neonctl psql` or `neonctl connection-string`, silently parse `NEON_DATABASE_URL` for role and database and pass `--project-id`, `--role-name`, and `--database-name`; use `NEON_BRANCH_ID` as the branch argument when set; never print connection strings or tokens.
  - `rolecontract-v1`: targeted native Codex CLI low smoke verified `9/10`; latency was `58.981s`, with `4` transcript-derived tool calls and model `gpt-5.5`. The role error disappeared. The remaining failure was `db-T10-write-records`: final record count was `0` and `delete_me` count was `1`, so the agent's write lifecycle logic reversed the expected final/delete state. Classification: `agent-execution-failure`.
  - `rolecontract-lowhigh-v1`: targeted native Codex CLI low/high smoke verified `18/20` with `--invoke-retries 0`. Low passed `9/10` in `74.961s` with `5` transcript-derived tool calls and failed only `db-T10-write-records` on final/delete state. High passed `9/10` in `1,193.060s` with `11` transcript-derived tool calls and failed only `db-T05-evolve-schema` after a timeout path. The role-disambiguation error did not recur. Classification: remaining failures are `agent-execution-failure` / runtime behavior, not verifier failures.
  - The same smoke still hit `branches limit exceeded` while creating a recovery branch after the backup marker existed. Because the backup-marker verifier passed, classify the branch quota as an `environment-failure` diagnostic, not a failed product capability for this cell.
  - Generic harness/tooling bug from the artifact audit: `neonctl --help` can echo a line-wrapped default API key into stdout/transcript. Persisted artifact redaction now covers raw, line-wrapped, JSON-escaped, and partially redacted Neon `napi_` token shapes.
  - Generic methodology/artifact bug from `rolecontract-lowhigh-v1`: one agent-authored result file omitted `harness` and `model`, so normalized cell generation grouped low and high separately but wrote both through the same fallback file stem (`codex.cli`), overwriting one cell record. Fix: normalized cell grouping applies fallback harness before grouping, and `verify-generated` enriches missing provenance from sibling invoke metadata, invoke args, and Codex stderr before building snapshots/normalized records. Outcome scoring is unchanged.
- CockroachDB SDK/Codex low smoke evidence:
  - `v3`: `0/10` before SQL prompt hardening. The agent connected through the official Postgres-compatible `pg` SQL-wire path but every schema/data task failed on unquoted hyphenated canonical SQL identifiers.
  - Fix: the same database SQL identifier contract used for Neon was applied to SQL-backed database packs, and the T08 zero-argument routine contract was added for server-side execution.
  - `v4`: `10/10` verified tasks passed; latency was about `98s`. This cross-vendor recovery confirms the identifier/routine changes are database-category template hardening, not a Neon-specific workaround.
- CockroachDB SDK/Codex high smoke evidence:
  - `high-v1`: native Codex SDK high smoke verified `9/10` with `--invoke-retries 0` and passed the `0.80` gate. The normalized `{codex, sdk}` high-profile record reports model `gpt-5.5`, latency `234.200s`, `22` transcript-derived tool calls, and null token usage/cost because native Codex transcripts do not expose provider token accounting.
  - The single failure was `db-T03-change-data-capture`: the trace shows the agent created source/capture tables and inserted the source row, then timed out after `20s` waiting for a sinkless changefeed event. Because `capture_table` remained `null`, the verifier queried the placeholder `{capture_table}` and failed.
  - Classification: `agent-execution-failure` / runtime timing for the high profile's CDC implementation. The SDK low profile already passed `10/10`, so this does not justify weakening the CDC verifier or changing CockroachDB SDK support.
- CockroachDB CLI/Codex low-high smoke evidence:
  - `v1`: low/high native Codex CLI smoke verified `19/20` with `--invoke-retries 0`. Low passed `10/10` in `157.097s` with `4` transcript-derived tool calls. High passed `9/10` in `302.006s` with `18` transcript-derived tool calls.
  - The normalized `{codex, cli}` cell reports best profile `low`, model `gpt-5.5`, pass@1 `10/10`, latency `157.097s`, and `4` tool calls. This is useful evidence that the SQL identifier and zero-argument routine contracts generalize from SDK to CLI for CockroachDB.
  - The single high failure was `db-T03-change-data-capture`: the trace shows the agent created source/capture tables, inserted the probe row, and read a CockroachDB changefeed event whose payload encoded the label in hex. It then checked for the plain label string and did not persist the decoded event into the capture table, so the verifier found `0` captured rows.
  - Classification: `agent-execution-failure` for the high profile's CDC implementation. Low passed the same task on the same surface, so do not weaken the verifier or change support from this one failure.
- Insforge API/Codex low smoke evidence:
  - `v1`: `0/9`; latency was about `161.4s`, with `32` transcript-derived tool calls. The agent discovered project-local docs under `/api/docs`, used valid auth, then batched table creation, RLS policies, triggers, and functions into one `/api/database/migrations` request. Insforge rejected the migration with `Query could not be parsed and was rejected for security reasons`, and every later record write cascaded into missing-table `404`s.
  - Initial classification: `vendor-specific-adapter-bug` in the Insforge database prompt contract. The core harness and SQL verifier were correct; the composed pack guidance said to prefer admin/schema endpoints but did not name concrete endpoints or explain how to recover from migration parser rejection.
  - Fix: Insforge composed prompts now explicitly name `POST /api/database/tables`, `PATCH /api/database/tables/{tableName}/schema`, `GET /api/database/tables/{tableName}/schema`, and `/api/database/records/{tableName}` as the first API path, with migrations/raw SQL reserved for small task-local fragments.
  - `v2`: `0/9`; latency was about `19.1s`, with `4` transcript-derived tool calls. The agent short-circuited by writing a placeholder all-null result before meaningful live work. Classification: `agent-execution-failure`, not a pack/verifier result.
  - `v3`: `0/9` after denominator correction; latency was `71.917s`, with `9` transcript-derived tool calls. The agent switched to `POST /api/database/tables`, which proves the endpoint guidance changed behavior, but the live hosted API rejected the table body because it required `columnName`, `isNullable`, and `isUnique` while the official docs fetched during the run showed `name`, `nullable`, and `unique`. The same run also used an invalid underscore migration name and called database RPC under `/api/database/records/rpc/...`.
  - v3 classification: `vendor-specific-adapter-bug` / docs-live API drift plus prompt-contract gap. This remains isolated to Insforge's database API adapter; do not generalize it into core harness logic.
  - Fix: Insforge composed prompts now include the live-hosted table-column fallback shape `columns: [{columnName, type, isNullable, isUnique}]`, require lowercase letter/number/hyphen migration names, and specify `POST /api/database/rpc/{functionName}` for database RPC invocation.
  - Generic methodology/tooling bug found during v3/v4 audit: `tasksForSurface` still treated `allowed_surfaces: []` as a wildcard, so unsupported tasks could leak into execution prompts and scoring denominators. Fix: empty `allowed_surfaces` now means no executable surface, matching V3 support-matrix semantics; tests assert unsupported tasks are excluded from prompts and denominators.
  - `v4`: native Codex API low timed out after `956.774s` with `10` transcript-derived tool calls and verified `0/9` after denominator correction. The transcript shows the agent spent the window fetching official docs and never wrote a final task artifact beyond the early placeholder; no verifier-visible gids were reported.
  - v4 classification: `agent-execution-failure` / runtime timeout after adapter prompt hardening. Methodology consequence: Insforge remains an active execution-learning target, but this sequence should not trigger generic harness changes until another vendor repeats the same docs/live-schema drift pattern.
- MongoDB Atlas API/Codex low smoke evidence:
  - `v1`: `0/9`; latency was about `272.7s`, with `37` transcript-derived tool calls.
  - The agent correctly discovered that Atlas Admin API cannot access cluster data with the provided credential, then used the MongoDB data-plane connection string. It failed all executable tasks because it invented a run-scoped database name longer than MongoDB's 38-byte database-name limit.
  - Classification: `database-category-seed/template/verifier-bug`. The MongoDB pack did not provide a short non-secret database scope even though the verifier expected all state in a Mongo database.
  - Fix: MongoDB Atlas seeded vendor config now declares `mongo_database: axarena_eval`; executor prompts expose that non-secret database name when a pack declares `mongo_conn.database`; MongoDB verifier queries default to the pack-level database rather than requiring agents to self-report `database_name`.
  - `v2`: initial verify improved to `5/9`; after fixing MongoDB schema verifiers to read collection validator metadata instead of counting documents with schema fields, the same run verified at `7/9`.
  - Schema verifier classification: `database-category-seed/template/verifier-bug`. MongoDB schema evolution and inspection are visible through `listCollections(...).options.validator`, not necessarily through inserted documents.
  - Support-matrix correction: `db-T08-server-side-execution` is now N/A for MongoDB Atlas because the cited capability is inline aggregation `$function`, not a named server-side routine with observable invocation output as required by the DAEB-1 database T08 template.
  - Classification: `database-category-seed/template/verifier-bug`. The fix is isolated to database task-support compatibility in `synthesize-suite`, then persisted in `daeb-1-v3.support-matrix.yaml`; verifier extraction only consumes that support decision.
  - After the support-matrix correction and pack reapproval, the same `v2` run verifies at `7/8` (`88%`) and passes the `0.80` smoke gate.
  - Remaining v2 failure:
    - `db-T03-change-data-capture`: agent opened a change stream but timed out before persisting an observed event into the capture collection. Classification: `agent-execution-failure` for now.
- MongoDB Atlas CLI/Codex low-high smoke evidence:
  - `v1`: low/high native Codex CLI smoke verified `14/16` with `--invoke-retries 0`. Both profiles passed backup/export marker, change-stream capture, collection creation, schema validator checks, query filtering, and write lifecycle. Both failed `db-T09-vector-search` because Atlas reported the maximum number of FTS indexes had been reached for the instance size.
  - Classification for v1 T09: `environment-failure` / sandbox baseline contamination. The agent correctly refused to delete unrelated indexes during execution. This is not a support-denominator failure and not a generic harness bug.
  - Fix: MongoDB Atlas now has an explicit vendor-specific resetter in `src/target/reset.ts`. It uses the official MongoDB driver and pack-declared `mongo_conn`, refuses broad resets without a dedicated database, and only targets eval-created `axarena_*` collections plus matching Atlas Search indexes. This is baseline ops, not agent behavior; run it after verification, never before.
  - Reset evidence: dry-run found `49` eval-created resources, including an old `axarena_vector_index_*`; explicit reset deleted `49/49`. After the v2 verify, a second reset deleted `20/20` newly-created eval resources.
  - `v2`: after reset, low passed vector search and verified `6/8`; high verified `7/8`. Low failures were T05/T06 because it created collections without the expected validator metadata. High failed T09 because the low run's vector index consumed the small shared Atlas FTS quota during the concurrent low/high run.
  - Methodology consequence: bounded execution remains necessary even within one vendor when a surface uses scarce shared quota. For MongoDB Atlas vector-search cells, either run low/high sequentially after reset or use per-run cleanup before interpreting a high-profile T09 failure as capability evidence.
- MongoDB Atlas SDK/Codex low smoke evidence:
  - `v1`: `5/7`; latency was about `98s`. The stricter SDK denominator correctly excluded Atlas access-control, backup, and named-routine cells. Passing tasks were collection creation, schema evolution, schema inspection, query filtering, and write lifecycle.
  - `v1` failures: `db-T03-change-data-capture` timed out before durable capture persistence, and `db-T09-vector-search` failed because the agent enabled Stable API strict mode, which rejects `createSearchIndexes`.
  - Fix: MongoDB Atlas composed prompts now add task-local SDK contracts: open the change stream before inserting and persist the observed event into `capture_collection`; do not enable `apiStrict: true` for Atlas Search/vector index creation.
  - `v2`: `0/7`; the agent handled T03 first, timed out, and aborted the remaining tasks due to a monolithic script-level `try/catch`. Classification: `generic harness/tooling bug`.
  - Fix: executor prompts now explicitly require task-level isolation: if one task fails, record that task as null, log the failure, and continue the remaining tasks rather than aborting the whole run.
  - `v3`: `5/7`; latency was about `140s`. The per-task isolation fix worked: after T03 timed out, the agent continued and completed T04/T05/T06/T07/T10. T09 no longer failed on `apiStrict`; it now failed because the sandbox reached the Atlas FTS index quota. Classification: `environment failure` for that run, not a verifier or support-denominator bug.
  - Current post-audit conclusion: MongoDB Atlas SDK is eligible for `7` DAEB-1 V3 tasks and currently smokes at `5/7` for Codex low, with failures concentrated in CDC timing and Atlas Search index quota.
- Turso API/Codex low smoke evidence:
  - `v1`: `0/10`; latency was about `247s`. The agent discovered SQL-over-HTTP but reconstructed the Turso host incorrectly by splitting hyphenated endpoint/context env values, causing `Host not found` for every task call.
  - Classification: `generic-harness-tooling-bug`. The executor prompt previously gave broad "leading numeric/id portion" guidance that was useful for sandbox scope IDs but unsafe for endpoint/context vars such as host components, org slugs, project refs, and database names.
  - Fix: executor prompts now say endpoint/context env values must be used literally when constructing hosts or URLs, and URL-id extraction guidance applies only to explicit sandbox scope vars.
  - `v2`: `6/10`; latency was about `231s`. Passed `define-data-container`, `evolve-schema`, `inspect-schema`, `query-records`, `vector-search`, and `write-records` through Turso SQL-over-HTTP.
  - `v3`: `8/10`; latency was about `376s`. The run passed `backup-and-restore` and `server-side-execution` in addition to the six v2 passes.
  - T08 verifier classification: `database-category seed/template/verifier-bug`. Turso documents server-side triggers, not SQL UDFs, so the verifier now checks an agent-reported trigger result table (`result_table`) with a `value = axarena_ok_{ns}` marker instead of calling `SELECT axarena_echo_{ns}()`.
  - T02 verifier-strength watch item: the agent did call `/dump` and the trace records a non-empty export, but the current outcome verifier still only reads back the marker row in the active database. Treat this as a publication-quality review item before final leaderboard freeze; do not over-generalize backup artifact semantics from this single Turso cell.
  - `high-v1`: native Codex API high timed out after one `900s` attempt and verified `0/10`; the invoke metadata reports `SIGTERM`, duration `1,017.244s`, `14` transcript-derived tool calls, and no trace file. The result JSON contains discovery evidence and all task gids as `null`, so it provides no verifier-visible outcome evidence.
  - High-timeout classification: `agent-execution/runtime-failure`. The transcript shows the agent completed extensive docs discovery and announced live calls, but did not enter the API execution script before timeout. This does not justify changing Turso support, task eligibility, or verifier logic; the current best Turso API cell remains low `8/10`.
  - Remaining v3 failures:
    - `db-T01-access-control`: agent inspected auth-related SQL surface but did not implement a verifiable fine-grained token flow with the provided database token. Classification: `agent-execution-failure` for now; watch whether high-effort or CLI can complete it before changing support.
    - `db-T03-change-data-capture`: agent tried both documented CDC/listen directions; the generic database host returned `404` for `/beta/listen`, while earlier PRAGMA attempts were rejected through SQL-over-HTTP. Classification: `database-category seed/template/verifier watch item`; evidence suggests Turso CDC may require primary-instance host context or a different adapter path, not a broad core change.
- Turso CLI/Codex low-high smoke evidence:
  - `v1`: native Codex CLI low/high smoke verified `9/20` with `--invoke-retries 0`. Low passed `0/10` in `104.920s` with `19` transcript-derived tool calls; high passed `9/10` in `483.767s` with `14` transcript-derived tool calls. The normalized `{codex, cli}` cell reports best profile `high`, model `gpt-5.5`, pass@1 `9/10`, latency `483.767s`, and `14` tool calls.
  - Low classification: `agent-execution-failure`. The low trace used the database token as a Turso platform token/config credential and wrote no verifier-visible state. The high trace discovered the usable official CLI shell path by passing the database JWT through the `libsql://...turso.io?jwt=<redacted>` URL.
  - High T08 classification: `database-category seed/template/verifier contract bug`. High created and invoked a trigger-backed routine analogue and reported `result_table`, but used a `result` column while the verifier required `value`. The task prompt did not previously make that helper-table column contract explicit enough.
  - Fix: SQL-backed DAEB server-side-execution prompts now state that trigger/helper-table implementations must persist the marker in a result table column named `value` and report that table as `result_table`. The verifier remains strict and outcome-first; it was not widened to accept arbitrary agent-chosen column names.
- Turso SDK/Codex low-high smoke evidence:
  - `v1`: native Codex SDK low/high smoke verified `11/12` with `--invoke-retries 0` and passed the `0.80` gate. Low passed `5/6`; high passed `6/6`.
  - The normalized `{codex, sdk}` cell reports best profile `high`, model `gpt-5.5`, pass@1 `6/6`, latency `134.150s`, `21` transcript-derived tool calls, and null token usage/cost because the current native Codex transcript does not expose provider token accounting.
  - Low T09 classification: `agent-execution-failure`. Low installed and used `@libsql/client` correctly for CRUD/schema/query/write tasks, but modeled vector search with plain numeric `x/y/z` columns and a hand-written distance expression. The canonical Turso verifier requires a vector-enabled table using `embedding` plus `vector_distance_cos`, so read-back returned `undefined`.
  - High T09 completed the canonical vector path with `F32_BLOB(3)`, `vector32(...)`, and `vector_distance_cos(...)`. Its attempted DiskANN/vector-index path failed with `unable to initialize diskann`, then the agent fell back to exact vector distance and passed. This is execution-learning evidence, not a support-matrix change.
- Convex API/Codex low smoke evidence:
  - `v1`: `0/8`; latency was about `276s`. The agent found Convex deployment/admin APIs and function APIs, but deployment failed because canonical DAEB names included hyphens and Convex table/function identifiers may only use letters, digits, and underscores.
  - Classification: `vendor-specific-adapter-bug`. The canonical names and marker strings remain benchmark outcomes, but Convex code identifiers need a deterministic safe-identifier mapping.
  - Fix: Convex composed pack prompts now add isolated database adapter guidance: replace non-alphanumeric characters with underscores only for Convex code identifiers, while preserving exact canonical names and marker strings in records or verifier outputs.
  - `v2`: `0/8`; latency was about `366s`. The agent successfully deployed and reported all 8 API-task gids/query paths, but verification failed because `/api/query` was called against the pack `CONVEX_URL` with deploy-key bearer auth, while the run used an agent-discovered preview deployment and public function endpoints should not receive the deploy key as a JWT bearer token.
  - Classification: `vendor-specific-adapter-bug`. The core verifier/scoring model was correct; the Convex verifier client needed adapter-specific base-URL and auth behavior.
  - Fix: `verification-client` now uses the agent-discovered `*.convex.cloud` deployment for Convex read-back when present and sets verifier auth to `none` for public function calls.
  - Additional v2 verifier-contract finding: several agent-authored query functions returned real state with ad hoc shapes, and action-backed tasks were incorrectly seeded as `/api/query`.
  - Classification: `vendor-specific-adapter/verifier-bug`. The pack must tell agents the exact verifier function return contract and must read actions through `/api/action`.
  - Fix: Convex prompt overrides now include task-specific verifier contracts such as `{hasLabelField:boolean}`, `{activeCount:number, expectedLabelsCount:number}`, action return `axarena_ok_{ns}`, and `{topLabel:string}`. Convex T08/T09 seeded checks now use `/api/action`.
  - `v3`: `8/8`; latency was about `276s`. All eight API-surface Convex tasks passed verified read-back, including access control, CDC capture, schema/container checks, query filtering, server-side execution, vector search, and write lifecycle.
  - `high-v1`: native Codex API high-only smoke timed out after `905.972s` with `34` transcript-derived tool calls and verified `0/10` in the raw normalized output. The artifact had no trace file and no verifier-visible function paths or gids; the transcript shows the agent spent the run window researching Convex deployment internals, npm package source, and push-request mechanics, then timed out while generating the deploy bundle before durable writes.
  - High-v1 classification: `agent-execution-failure` / runtime timeout. This does not change Convex API support semantics or the verifier contract because the low profile already produced verified `8/8` outcome evidence on the same composed pack. Methodology consequence: high-effort cells can over-investigate deployment machinery; timeout/partial artifacts should be recorded as execution learning, not converted into support-matrix changes without repeated evidence.
  - Generalization decision: do not move these fixes into core harness/report/publication. They are isolated Convex/database adapter behavior. Revisit only if another functions-as-code database repeats the same preview-deployment or public-function auth pattern.
- Do not add large abstractions from a single failing cell. Generalize only when the same failure mode appears across multiple vendors, surfaces, or harnesses.
- Claude Code execution lane status:
  - Native Claude Code CLI headless auth is now unblocked, and the Asana `claude` wrapper has also been validated for headless invocation.
  - A local temp-pack smoke proved `ax-eval exec-plan --invoke --harness claude-code` can produce the expected invoke artifacts (`run-*.json`, trace, transcript, invoke meta).
  - A real DAEB-1 Neon API low smoke using the default `claude` executable passed `10/10` verified tasks and produced normalized latency/tool-call diagnostics. The stamped model was `claude-sonnet-4-6`, so this proves lane viability but not the desired Sonnet 5 pin.
  - Native Claude Code `2.1.198` was discovered at `/Users/richardtang/.cursor/extensions/anthropic.claude-code-2.1.198-darwin-arm64/resources/native-binary/claude`; its help exposes both `--model` and `--effort`.
  - A pinned native DAEB-1 Neon API low smoke with `AX_EVAL_CLAUDE_BIN=<native claude>` and `--model sonnet` stamped the actual model as `claude-sonnet-5`, completed in about `210s`, and verified `9/10`. The single failure was `db-T09-vector-search`: the trace shows top label `alpha`, while the canonical outcome required `alpha_{ns}`. Classification: `agent-execution-failure` in this Claude low cell, not a harness/model-pin/verifier bug.
  - The paired pinned native Neon API high smoke stamped `claude-sonnet-5` in stdout but timed out after two `900s` attempts, producing a failure artifact that verified `0/10`. The transcript shows the agent spent the window in discovery/research rather than completing resource creation. Classification: `agent-execution-failure` / runtime timeout for this high-effort cell. Methodology consequence: first-pass full-matrix execution should use `--invoke-retries 0` and rerun specific timeout cells intentionally, rather than doubling every timeout by default.
  - Generic harness/tooling bug found from that timeout: failure/timeout result artifacts did not carry the requested or stamped model, so normalized records could show `model: null` despite a model-pinned run. Fix: timeout failure artifacts now pass through the same result stamping path as successful artifacts, preserving requested model and any detectable harness-reported model for publication diagnostics.
  - Methodology decision: Claude Code is now eligible for DAEB-1 execution learning and the full matrix. Publication-grade Claude lanes should prefer `AX_EVAL_CLAUDE_BIN=<native claude>` plus `--model sonnet`; the normalized record's stamped model is the source of truth.
- Codex execution lane status:
  - Wrapper-based Codex runs initially exposed a generic harness/tooling bug: API/CLI/SDK cells inherited unrelated global MCP server configuration from the operator's Codex home. Broken local MCP OAuth/login state then stalled non-MCP benchmark cells and produced auth-noise stderr unrelated to the vendor under test.
  - Fix: non-MCP Codex invocations now get an isolated per-cell Codex home, copy only the operator's Codex login when needed, and pass `mcp_servers={}`. MCP cells remain explicitly provisioned from the pack's MCP auth contract.
  - Publication-grade Codex lanes should prefer the native app binary through `AX_EVAL_CODEX_BIN=/Applications/Codex.app/Contents/Resources/codex` instead of wrapper executables that may rewrite config or inject corporate defaults.
  - Native Codex Neon API low smoke with `gpt-5.5` completed in about `69s` and verified `10/10`. The isolated config stayed clean (`mcp_servers = {}`), with no unrelated MCP auth failures.
  - Native Codex Neon full slice over `api`, `cli`, and `sdk`, low/high profiles, `--invoke-retries 0`, produced these best normalized cells: API `10/10`, SDK `8/8`, CLI `5/10`, aggregate `32/56` verified outcomes.
  - CLI failures are not verifier failures. The low CLI run failed every task because `neonctl psql` required an explicit `--role-name` when multiple branch roles existed; the high CLI run timed out after partial success. Classification: `vendor-specific-adapter-bug` / database CLI prompt contract for role disambiguation, plus `agent-execution-failure` / runtime timeout for the high cell.
  - After the Neon role/database contract, a focused native Codex CLI low/high smoke verified `18/20` and produced a single clean `ax.normalized-result/v1` record for the `{codex, cli}` cell with profiles `low/high`, best profile `low`, model `gpt-5.5`, latency `74.961s`, and `5` tool calls.
  - SDK high timed out with no useful artifacts while SDK low passed `8/8`; classification remains `agent-execution-failure` / runtime timeout, not a support-denominator issue.

### 5.10 Compose Pack

**Decision**

- Final pack scope is constrained by:
  - suite allowed surfaces
  - suite methodology surface scope
  - per-task `na_surfaces`
  - support matrix supported surfaces
- Canonical v1 packs exclude MCP from usability-suite scope.

**Metrics**

- allowed surfaces per task
- N/A task count
- surface-filtered task count

**Artifacts**

- `targets/packs/<slug>/<suite>.yaml`

**Code**

- [`src/generate/compose-pack.ts`](/Users/richardtang/ax-eval/src/generate/compose-pack.ts)

### 5.11 Grader Ledger

**Decision**

- Each canonical task publishes which grader classes apply.
- Outcome is first-class.
- Transcript and efficiency are kept as diagnostics and calibration tools.
- Efficiency metrics should include both interaction complexity and runtime cost.

**Grader classes**

- `outcome_graders`
- `trajectory_graders`
- `efficiency_metrics`
- `human_calibration`

**Metrics**

- Presence of outcome grader per task
- Trajectory review coverage per task
- Efficiency metrics declared per task
  - `turn_count`
  - `tool_calls`
  - `token_usage`
  - `token_cost` / `cost_per_task`
  - `latency_ms`
  - `first_action_latency_ms`
  - `transcript_event_count`
  - `action_occurred`
  - `validity_status`
  - `time_to_first_token`
  - `time_to_last_token`
- Human calibration requirements by difficulty

**Artifacts**

- `<suite>.grader-ledger.yaml`

**Code**

- schema in [`src/generate/methodology.ts`](/Users/richardtang/ax-eval/src/generate/methodology.ts)
- construction in [`src/generate/synthesize-suite.ts`](/Users/richardtang/ax-eval/src/generate/synthesize-suite.ts)

### 5.12 Failure Taxonomy and Trace Review

**Decision**

- Any methodology revision must be accompanied by:
  - a fixed-sample trace review discipline
  - a persisted failure taxonomy
- This prevents silent grader or suite changes without reading real traces.

**Failure buckets**

- `generic-harness-tooling-bug`
- `generic-methodology-artifact-bug`
- `database-category-seed-template-verifier-bug`
- `vendor-specific-adapter-bug`
- `agent-execution-failure`
- `environment-runtime-failure`
- `agent-runtime-timeout-before-first-action`

These buckets are intentionally engineering-facing for the DAEB-1 hardening loop. They keep the core engine generic while letting database-specific seeds/templates/verifiers evolve quickly when real execution proves they are wrong. A no-action timeout is a runtime-validity finding; it should be disclosed separately and excluded from vendor usability pass-rate denominators unless a later task-level execution actually performs vendor-visible work and fails verification.

**Metrics**

- failure counts by taxonomy bucket
- trace sample size per methodology revision
- calibration notes by revision

**Artifacts**

- `<suite>.failure-taxonomy.yaml`
- `<suite>.trace-review.yaml`

**Code**

- schemas in [`src/generate/methodology.ts`](/Users/richardtang/ax-eval/src/generate/methodology.ts)
- default construction in [`src/generate/synthesize-suite.ts`](/Users/richardtang/ax-eval/src/generate/synthesize-suite.ts)

### 5.13 Publication Bundle

**Decision**

- Publication is a contract, not just a directory copy.
- Bundle must include both:
- Discoverability & Readiness methodology artifacts
  - usability-suite artifacts
- Missing files are explicitly recorded.

**Metrics**

- missing artifact count
- pack validation error count
- vendor coverage in bundle

**Artifacts**

- publication output directory
- `manifest.json`

**Code**

- [`src/generate/publication.ts`](/Users/richardtang/ax-eval/src/generate/publication.ts)
- CLI entry in [`src/cli.ts`](/Users/richardtang/ax-eval/src/cli.ts)

## 6. Metrics of Record

These are the metrics that matter at publication time.

### Discoverability & Readiness metrics

- surface discoverability
- content quality
- capability exposure
- protocol/access readiness

These metrics describe how easy the surface is to find and understand.

### Usability suite metrics

- pass rate over non-NA tasks
- pass rate by surface
- pass rate by difficulty
- pass rate by vendor
- support matrix coverage
- grader diagnostics
- failure taxonomy breakdown

These metrics describe operational usability under verified outcomes.

### Explicit non-metric

There is **no combined single score** that mixes Discoverability & Readiness and usability-suite success.

## 7. Artifact Set

For a publication-grade suite, the expected methodology artifacts are:

- `<suite>.methodology.yaml`
- `<suite>.concept-universe.yaml`
- `<suite>.coverage-matrix.yaml`
- `<suite>.selection-ledger.yaml`
- `<suite>.support-matrix.yaml`
- `<suite>.grader-ledger.yaml`
- `<suite>.failure-taxonomy.yaml`
- `<suite>.trace-review.yaml`
- `<suite>.synthesis.md`

For each vendor:

- vendor card
- capability inventory
- verification extract
- compiled pack
- approval file
- report / snapshot / normalized results when live runs exist

## 8. Test Invariants

The methodology is enforced by tests, not only prose.

### Current enforced invariants

- canonical suite scope defaults to `api/sdk/cli`
- no canonical suite task includes `mcp`
- capability inventory writes new and legacy extract files
- compose-pack respects support matrix
- publication manifest exposes separate `static_ax` and `behavioral` layers
- Discoverability & Readiness notes explicitly do not alter usability-suite pass rates
- DAEB-1 synthesis emits the five execution-learning failure buckets used to classify fixes

**Code**

- [`tests/methodology.test.ts`](/Users/richardtang/ax-eval/tests/methodology.test.ts)
- [`tests/suite.test.ts`](/Users/richardtang/ax-eval/tests/suite.test.ts)
- [`tests/cli.test.ts`](/Users/richardtang/ax-eval/tests/cli.test.ts)

### Desired next invariants

- every extracted capability appears in exactly one concept cluster
- every `(concept, vendor)` cell closes to `supported | unsupported | inconclusive`
- selection ledger obeys coverage threshold and family diversity cap deterministically
- `na` / `na_surfaces` cannot exist without support-matrix reference
- publication-grade bundle validation requires both static and usability-suite artifact sets

## 9. Human Review Checkpoints

### 9.1 Methodology Revision Review

Reviewer checks:

- Was the suite logic changed?
- Was trace review performed?
- Was failure taxonomy updated?
- Did the thresholds or selection rules change?

### 9.2 Suite Freeze Review

Reviewer checks:

- Are selected tasks coverage-valid?
- Are rejection reasons preserved?
- Is difficulty spread acceptable?
- Are tasks independently verifiable?

### 9.3 Publication Bundle Review

Reviewer checks:

- Are both publication layers present?
- Are vendor adapters valid?
- Are missing artifacts disclosed?
- Are usability-suite scores still computed independently from static readiness?

## 10. Code Map

### Core methodology and artifacts

- [`src/generate/methodology.ts`](/Users/richardtang/ax-eval/src/generate/methodology.ts)

### Capability inventory and clustering

- [`src/generate/capability-extract.ts`](/Users/richardtang/ax-eval/src/generate/capability-extract.ts)
- [`src/generate/coverage-gap-check.ts`](/Users/richardtang/ax-eval/src/generate/coverage-gap-check.ts)
- [`src/generate/synthesize-suite.ts`](/Users/richardtang/ax-eval/src/generate/synthesize-suite.ts)

### Suite and vendor adapters

- [`src/generate/suite.ts`](/Users/richardtang/ax-eval/src/generate/suite.ts)
- [`src/generate/task-extract.ts`](/Users/richardtang/ax-eval/src/generate/task-extract.ts)
- [`src/generate/compose-pack.ts`](/Users/richardtang/ax-eval/src/generate/compose-pack.ts)
- [`src/generate/mongo-verify.ts`](/Users/richardtang/ax-eval/src/generate/mongo-verify.ts)
- [`src/generate/verify.ts`](/Users/richardtang/ax-eval/src/generate/verify.ts)

### Publication and CLI

- [`src/generate/publication.ts`](/Users/richardtang/ax-eval/src/generate/publication.ts)
- [`src/cli.ts`](/Users/richardtang/ax-eval/src/cli.ts)
- [`src/target/reset.ts`](/Users/richardtang/ax-eval/src/target/reset.ts)

### Execution / profile context

- [`src/harness/executor.ts`](/Users/richardtang/ax-eval/src/harness/executor.ts)
- [`src/harness/invoke.ts`](/Users/richardtang/ax-eval/src/harness/invoke.ts)
- [`src/harness/mcp-provision.ts`](/Users/richardtang/ax-eval/src/harness/mcp-provision.ts)

Claude Code execution recipe:

```bash
AX_EVAL_CLAUDE_BIN=/Users/richardtang/.cursor/extensions/anthropic.claude-code-2.1.198-darwin-arm64/resources/native-binary/claude \
npm run ax-eval -- exec-plan --pack targets/packs/neon/daeb-1-v3.yaml \
  --run-dir results/runs/daeb-1-v3/smoke/neon-api-claude-low-pinned \
  --invoke --harness claude-code --profile low --surface api --model sonnet \
  --invoke-retries 0 --first-action-timeout 180
```

Codex execution recipe:

```bash
AX_EVAL_CODEX_BIN=/Applications/Codex.app/Contents/Resources/codex \
npm run ax-eval -- exec-plan --pack targets/packs/neon/daeb-1-v3.yaml \
  --run-dir results/runs/daeb-1-v3/full/neon-codex-gpt55-native-v1 \
  --invoke --harness codex --profile low --profile high --surface all \
  --model gpt-5.5 --invoke-retries 0 --first-action-timeout 180 --concurrency 3
```

Codex and Claude Code should be run as separate model-pinned lanes. `--model` is passed through to the selected harness, and the model namespace is not shared across harnesses. `--effort low|medium|high` is now translated to native harness effort where available (`codex` model reasoning effort, Claude Code `--effort`) and is also described in the executor prompt for trace interpretability.

Execution parallelism stays bounded. Use parallel proposal/review where it is safe (vendor capability extraction, `(vendor, concept, surface)` support/gap adjudication, task drafting, trace triage), but keep canonical concept clustering, coverage closure, selection ledgers, support matrix finalization, frozen suite YAML, and publication bundle assembly centralized and deterministic. Live execution should usually run one vendor at a time with low/high profiles in parallel; do not fan out across many vendors sharing quota-bound sandboxes.

Sandbox reset is an explicit baseline operation, never an agent behavior and never a pre-verify cleanup. Run `reset` only after verification has persisted the result artifacts. MongoDB Atlas now has a vendor-specific resetter that clears eval-created `axarena_*` collections and matching Atlas Search indexes in the dedicated `axarena_eval` database, which prevents old vector-search indexes from turning Atlas FTS quotas into fake capability failures.

`integrations.sh` is a candidate upstream evidence source for the front half of the pipeline: surface inventory bootstrap, official docs/auth pointers, API/CLI/MCP existence prefill, discoverability inputs, and vendor onboarding. It must not become benchmark authority. SDK support remains explicitly adjudicated from official SDK/client-library evidence, and final support semantics still come from the AXArena support matrix plus reviewer-approved artifacts.

For non-MCP Codex surfaces, the invocation layer creates an isolated Codex home and passes `mcp_servers={}`. This keeps API/CLI/SDK usability evidence independent from unrelated operator MCP server login state. For MCP surfaces, the harness still uses the pack-declared MCP provisioning path.

For first-pass matrix expansion, prefer `--invoke-retries 0` plus `--first-action-timeout 180`. A retry can be useful for a known flaky cell, but automatic retries on high-effort timeouts can double wall-clock time without adding independent evidence. A no-action timeout is reported as runtime validity evidence and should not enter the vendor pass-rate denominator.

## 11. What Is Done vs. What Remains

### Done

- Two-layer publication contract exists in code
- Canonical benchmark scope is narrowed to `api/sdk/cli`
- Capability inventory is first-class
- Concept universe / coverage matrix / selection ledger / support matrix are persisted
- Support decisions are separated from outcome-verifier authoring
- DAEB-1 V3 has seven active vendor packs seeded, composed, env-checked, and content-hash approved
- Grader ledger exists
- Failure taxonomy and trace review artifacts exist
- Publication bundle exposes static and usability-suite layers separately
- Codex native execution has verified Neon API low `10/10`, SDK low `8/8`, post-role-contract Neon CLI low/high `18/20`, CockroachDB SDK low/high best-cell `10/10`, CockroachDB CLI low/high `19/20`, Turso SDK low/high best-cell `6/6`, Turso CLI low/high best-cell `9/10`, and Convex API low `8/8`; Convex API high-only and Insforge API low v4 timed out before verifier-visible writes and are recorded as execution-learning evidence
- Claude Code native headless execution is unblocked and eligible for DAEB-1 matrix expansion
- Non-MCP Codex surfaces are isolated from unrelated global MCP server config
- Neon CLI role/database disambiguation is now encoded in the composed pack and approved review hash
- Normalized records now carry efficiency diagnostics fields without changing outcome scoring
- Normalized cell grouping/provenance is hardened against agent-authored result files that omit `harness` or `model`
- Harness artifacts are redacted before persistence to avoid publishing secret-shaped values

### Remaining upgrades

- richer Discoverability & Readiness scoring contract in the same artifact language
- stronger deterministic selection tests for concept clustering closure
- regression-set graduation workflow once tasks saturate
- methodology revision memo template per suite release
- real execution, verification, normalized records, and publication-bundle interpretation for the remaining 7-vendor × 3-surface × 2-harness × 2-effort matrix cells
- true latency values for all normalized records, available automatically for new invokes through `durationMs` in invoke metadata

## 12. Working Principle

The benchmark should feel like a **scientific instrument**, not a demo script.

That means:

- the inventory is exhaustive enough to audit
- the selection logic is explicit enough to reproduce
- the adapters are narrow enough to review
- the graders are outcome-grounded enough to trust
- the publication bundle is structured enough to defend publicly

If a future change improves convenience but weakens any of those properties, the methodology should reject it.

## 13. References

- **Anthropic, "Demystifying evals for AI agents" (January 9, 2026).**
  Used for the benchmark ontology (`task`, `trial`, `grader`, `transcript`, `outcome`, `evaluation harness`, `agent harness`, `evaluation suite`), for the distinction between outcome and transcript grading, for the multi-grader framing, and for tracking latency, token usage, and cost-oriented metrics alongside correctness.
- **Rayfran Rocha Lima, Davi G. Assuncao Pinheiro, Thiago Medeiros de Menezes, "Making OpenAPI Documentation Agent-Ready: Detecting Documentation and REST Smells with a Multi-Agent LLM System" (EASE 2026; arXiv:2605.14312).**
  Used for the content-quality part of Discoverability & Readiness, especially the distinction between structural validity and agent usability, the OpenAPI smell taxonomy, and the idea that artifact maturity can be an upstream bottleneck even when the underlying product capability exists.
