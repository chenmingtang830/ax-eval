# ax-eval is the open-source, CLI-first way to test whether AI agents can discover and use your product.

## API · CLI · SDK · MCP across Codex and Claude Code

## Can AI agents actually use your product?

AI agents are becoming users of software. But most teams still test docs, APIs,
SDKs, CLIs, and MCP servers as developer-facing artifacts, not as interfaces
agents must discover and operate. `ax-eval` runs reviewed sandbox tasks through
real agent harnesses, then verifies outcomes with independent outcome verification.

**Agent-facing surfaces need integration tests, not just publication checks.**

![Sample ax-eval HTML report](./assets/sample-report.png)

## What It Measures

- **Discoverability:** can an agent-style crawl find docs, auth, and machine-readable surfaces?
- **Agent discovery:** what did the real agent do from a cold start?
- **Spec quality:** is the OpenAPI/GraphQL surface clear enough to plan from?
- **Task success:** did the sandbox state actually change as requested?
- **Surface gaps:** does API pass while SDK, CLI, or MCP fails?
- **Actionability:** recommendations are written as `Target / Evidence / Fix`.

The open skill can run through the agent you already have open. The CLI can also
drive local harnesses directly with `exec-plan --invoke --harness
claude-code|codex`, producing the same neutral report matrix.

## Quickstart

Install and run the keyless checks:

```bash
git clone https://github.com/chenmingtang830/ax-eval.git
cd ax-eval
npm install

npm run ax-eval -- run --offline
npm run ax-eval -- audit --offline
npm test
```

### Library API

`ax-eval` also exposes a typed ESM entry point for orchestration code that needs
to validate reviewed packs, select surface-compatible tasks, verify results, or
consume normalized records without importing private `src/` paths:

```ts
import {
  EvaluationCellSchema,
  TargetPackSchema,
  checkApproval,
  createRuntimeExtensionRegistry,
  runCell,
  tasksForSurface,
  verifyGeneratedPack,
} from "ax-eval";
```

`runCell` is the policy-free execution boundary: one reviewed pack, target,
surface, harness, model, effort, trial, batch, and immutable source revision in;
one strict `ax.normalized-cell-record/v1` record out. The input and output are
validated by `schemas/evaluation-cell.v1.json` and
`schemas/normalized-cell-record.v1.json`; legacy `ax.normalized-result/v1`
records remain unchanged and readable. Credential values
are passed out-of-band in `RunCellOptions`, and only names listed by the cell are
forwarded to its isolated harness environment. Controllers may provide a
separate `verificationCredentials` map for health checks, target adapters, and
live read-back; those values are never copied into the harness child.

The same contract is available as a subprocess:

```bash
ax-eval cell run --input cell.json --output record.json
```

The cell runner never chooses a benchmark roster, model, effort, trial count, or
batch identity, and it does not aggregate, rank, publish, or clean up. A
controller such as ax-arena owns those policies and must pass `batch_id`
unchanged to every cell. Verification reads live state before the record is
returned; cleanup remains an explicit later lifecycle step.

Controllers compose versioned, per-cell runtime behavior through one immutable
registry:

```ts
const registry = createRuntimeExtensionRegistry({
  oracleProviders,
  provisioningProviders,
  healthCheckProviders,
  resetProviders,
  targetAdapters,
});
const record = await runCell(cell, {
  credentials: hostCredentials,
  verificationCredentials: verifierCredentials,
  extensions: { registry },
});
```

Duplicate IDs and ambiguous matches fail before invocation. Health checks run
before provisioning, provisioning environment changes are additive, and only
selected or invoked provider IDs and versions appear in optional
`provider_provenance`. A selected target adapter may replace only the independent
verification transport; it receives immutable explicit runtime context. The
runtime-computed, bounded resource namespace is persisted as
`execution_namespace`. `runCell` never invokes reset: the controller must first
persist the verified record, then plan and execute bounded cleanup and persist
its separate evidence. Global oracle registration remains only for direct
`verifyGeneratedPack` compatibility.

Pass controller-only read-back secrets through `verificationCredentials`; they
are available to health checks, verification clients, and oracle providers but
never copied into the harness child. Provisioning never receives verifier-only
credentials, cannot replace PATH or
any scoped/core environment key, and all environment values it adds are treated
as secrets during artifact and error redaction. Providers may request additive
`pathEntries`; core canonicalizes and prepends only real directories outside
the writable cell workspace and artifact tree. Required tools must already be
pinned in those external directories.

The pack reference carries a full SHA-256 of the exact pack file in addition to
the existing approval sidecar check, so executable surface/auth changes cannot
hide behind the narrower legacy approval digest. CLI cells currently use built-in
extensions only; controllers that inject a runtime registry should call the
library API until the explicit extension-loader CLI seam lands.
Approvals created before this field was introduced remain valid for legacy
commands, but `cell run` requires the operator to review and approve the exact
pack again; ax-eval never upgrades that human decision automatically.

### Private arena workspace

The repository now contains a private `@ax-arena/benchmark` workspace at
`ax-arena/benchmark/`. It owns canonical DAEB artifacts plus roster, synthesis,
audit, and authoring-command policy behind `ax-arena benchmark`. Arena source
may consume only public `ax-eval` exports; CI rejects core-to-arena imports and
private `ax-eval/src/**` imports. Runtime providers, aggregation, and publication
move in the following stack slices; legacy authoring spellings are temporary
process launchers. Root `npm test`, `npm run typecheck`, `npm run build`, and
`npm run pack:check` validate both packages.

Run a live eval against a sandbox. `generate` is LLM-assisted by default: it
builds a rule-derived seed from the spec, then asks a local generator harness
(`codex` or `claude-code`) to turn it into a product-quality pack. Use
`--deterministic` when you need a keyless CI/offline fixture instead.

`automate-report` can orchestrate discovery, generation, review/configuration
handoff, a low-effort smoke gate, and the requested full report. It still stops
at the content-addressed review gate: it never approves a generated pack for
the operator.

```bash
npm run ax-eval -- automate-report --company Acme \
  --openapi https://example.com/openapi.json --surface all --harness codex
```

```bash
# 1. Draft a task pack from a public spec, then review/freeze it.
npm run ax-eval -- ingest --openapi https://example.com/openapi.json \
  --out results/acme-ingest.json
npm run ax-eval -- generate --from results/acme-ingest.json
npm run ax-eval -- review --pack results/acme.generated.pack.yaml --approve --by you

# 2. Fill only the credentials and sandbox ids this pack declares.
npm run ax-eval -- init --pack results/acme.generated.pack.yaml >> .env
npm run ax-eval -- check-env --pack results/acme.generated.pack.yaml

# 3. Emit prompts, run them, then verify with independent outcome verification.
npm run ax-eval -- exec-plan --pack results/acme.generated.pack.yaml \
  --run-dir results/runs/acme
npm run ax-eval -- verify-generated --pack results/acme.generated.pack.yaml \
  --results results/runs/acme/run-*.json \
  --min-pass-rate 0.8 \
  --html results/runs/acme/eval.html
```

`verify-generated` writes a saved report snapshot next to the HTML by default.
You can re-render that exact report later without touching live state:

```bash
npm run ax-eval -- render-generated \
  --snapshot results/runs/acme/generated-eval.snapshot.json \
  --html results/runs/acme/generated-eval.html
```

GraphQL targets use the same review and verification gate:

```bash
npm run ax-eval -- ingest --graphql https://api.example.com/graphql \
  --out results/acme-graphql-ingest.json
npm run ax-eval -- generate --from results/acme-graphql-ingest.json \
  --product Acme --out results/acme.generated.pack.yaml
```

For CI/offline fixtures, keep the rule-derived path explicit:

```bash
npm run ax-eval -- generate --deterministic --from results/acme-ingest.json \
  --product Acme --out results/acme.generated.pack.yaml
```

The repo ships example target packs under `targets/examples/`. Adding another SaaS should
usually be a new pack, not a code change.

## Examples

The repo ships self-contained HTML reports under [`examples/`](./examples/):

- [Stripe four-surface cross-harness report](./examples/stripe-four-surface-cross-harness.html)
- [Notion four-surface cross-harness report](./examples/notion-four-surface-cross-harness.html)
- [Linear GraphQL cross-surface, cross-harness report](./examples/linear-graphql-cross-surface-cross-harness.html)
- [Exa cross-harness, cross-surface report](./examples/exa-cross-harness-cross-surface.html)

Stripe and Notion are the current four-surface examples: one product evaluated
across `API / SDK / CLI / MCP`, with both `claude-code` and `codex` in the same
matrix. Linear shows the GraphQL path; Exa shows a non-CRUD/search API case.
These examples are the fastest way to see what a finished ax-eval artifact looks
like.

These are stable copies of real run artifacts, so you can inspect the output
without digging through `results/runs/`.

## DAEB-1 Publication Flow

DAEB-1, the AXArena database benchmark, uses a stricter publication pipeline
than ordinary local pack authoring:

```text
evaluation suite -> vendor verification extraction -> TargetPack -> execution -> verification -> normalized records -> leaderboard
```

**Current status (mutable v1):** authoring freeze is done for the 6-vendor core
cohort (Neon, CockroachDB, Turso, Supabase, Insforge, Nile) — packs are
`review --approve`d and `suite.trace-review.yaml` is `completed`. Production
3-trial reruns, publication freeze, and website export are **deferred** until
after team review; do not treat the commands below as the default next step.
Research-lane tasks (e.g. backup/CDC/integrity) stay out of the scored
denominator. Core facts live under
[`ax-arena/benchmark/daeb/v1/`](./ax-arena/benchmark/daeb/v1/).

The canonical benchmark contract is
[`ax-arena/benchmark/daeb/v1/suite.yaml`](./ax-arena/benchmark/daeb/v1/suite.yaml).
Its purposive-stratified core/research/excluded cohort is recorded separately in
[`ax-arena/benchmark/daeb/v1/vendor-selection-ledger.yaml`](./ax-arena/benchmark/daeb/v1/vendor-selection-ledger.yaml);
vendor inclusion is fixed before task outcomes and requires a persistent free
managed sandbox plus documented headless API/CLI access for the core cohort.
Each database vendor has a compiled pack under
`ax-arena/benchmark/daeb/v1/packs/<vendor>/pack.yaml`,
but those packs are execution artifacts, not independently authored benchmark
definitions. They are produced from the same suite plus vendor-specific public
metadata, outcome-verifier checks, auth/base URLs, N/A mapping, and surface
configuration.

During the one-minor-release relocation window, DAEB readers fall back to the
former `benchmarks/daeb/` root only when the canonical arena root is absent and
emit a deprecation warning. If both roots exist, pass `--benchmark-root <dir>`
to choose explicitly. Writers always use `ax-arena/benchmark/daeb/`.

DAEB authoring is owned by the private arena workspace:

```bash
npm run ax-arena -- benchmark synthesize-suite --help
```

The `resolve-vendor`, `import-registry`, extract, audit, `compose-pack`, and
`synthesize-suite` commands use this `ax-arena benchmark` form. Their former
`ax-eval` spellings remain shell-free deprecation launchers for one minor
release and preserve the arena command exit status.

Arena runtime commands use the same boundary: `plan` freezes an explicit batch
configuration, `aggregate` consumes a completed batch, and `execute`/`publish`
remain fail-closed from direct local invocation until trusted-workflow
activation. The legacy `ax-eval daeb-low-pass` and
`ax-eval daeb-production-rerun` implementations remain active until the private
arena package passes its publication gate; only then does the one-minor
shell-free delegation window begin.

The npm `prepublishOnly` release gate enforces that ordering: `ax-eval` cannot
be published with delegated aliases until the arena package is public and pins
the release version of `ax-eval`. The dependency remains one-way; users of the
temporary aliases install the now-available arena package explicitly. Dry-run
package inspection remains available during the private workspace migration.

Until human **publication** freeze, DAEB-1 is one mutable v1 draft: re-synthesis
overwrites the same suite and invalidates content-hash approvals. Git SHAs and
artifact content hashes identify exact draft states; draft iterations do not
increment the suite version. Benchmark-of-record results are produced only after
freeze.

Selection and applicability are separate. The 75% concept-coverage bar chooses
the shared task bank; each coverage decision also retains ranked capability
candidates, the selected capability bundle, and concrete task-fit requirements.
Only surfaces where the full task-fit bundle is documented enter the support
matrix denominator. Broad concept membership alone never enables a run cell.
Suite freeze additionally requires `suite.trace-review.yaml` to record a
completed fixed-sample review (sample IDs, reviewer, timestamp, commit SHA, and
findings); regeneration resets that checkpoint to `pending`.

For DAEB-1/database v1, the benchmark-of-record production lane is narrower
than the generic engine: `api` and `cli` only, Codex with `gpt-5.6-terra` and
Claude Code with `claude-sonnet-5`, both at high effort, and three clean trials
per supported vendor/surface/harness cell. SDK remains available in the engine, but DAEB-1
SDK evidence is research-only for v1.

When production is unblocked, run the production lane with:

```bash
npm run ax-arena -- benchmark daeb-production-rerun \
  --suite ax-arena/benchmark/daeb/v1/suite.yaml
```

Maintainers can run the same command through the **Trusted sandbox production
records** workflow. The repository's `trusted-sandbox` environment must have
required reviewers and the vendor credentials configured; approval happens
before the reviewed ref receives any secret. An optional prior workflow run ID
produces a normalized-records diff, and an optional PR number updates one bot
comment with that diff.

Each cell writes `trial-1/2/3` evidence plus an `aggregate/` record with mean
pass rate, observed range, exact pass³ count, harness version, run batch,
successful-attempt latency, retry-inclusive duration/tokens/cost, and links to
the source trial artifacts. Runtime
recomposition is allowed only when the generated pack matches the committed
human-approved content hash; the staged approval is then enforced by the normal
`exec-plan` review gate. Each trial also records `cleanup.json`. A failed or
resumed lane stops before the next trial unless namespace cleanup is confirmed;
production runs cannot skip reset. After
running and verifying the vendor matrix, freeze a publication bundle:

```bash
npm run ax-eval -- publication-bundle \
  --suite ax-arena/benchmark/daeb/v1/suite.yaml \
  --run-dir results/runs/daeb-1-v1-production \
  --out results/runs/daeb-1-v1-production/publication-bundle \
  --effort-profiles high \
  --required-effort-profiles high
```

The bundle writes `manifest.json` tying together the canonical suite, vendor
cards, verification extracts, compiled TargetPacks, approvals, snapshots, normalized
records, and competitive report. Missing live artifacts are listed explicitly;
a publication-ready DAEB-1 v1 bundle has no missing references and all required
quality gates passing.

Arena export accepts only bundles with a complete `ax.publication-integrity/v1`
envelope. It binds aggregate scores to the canonical production batch and
completion, derives trial scores and task drilldowns from sealed task outcomes,
binds every snapshot run to one exact completed-cell evidence set, and
recomputes the scored three-trial fields before writing. The legacy core bundle
command remains draft-only until the hardened arena bundle writer lands; an
unsealed historical v2 bundle cannot be promoted through this command.

`ax-eval` remains the tooling layer. The AXArena website should consume an
exported dataset instead of learning runner internals or recomputing scores:

```bash
npm run ax-arena -- benchmark export-publication \
  --from results/runs/daeb-1-v1-production/publication-bundle-final \
  --out results/runs/daeb-1-v1-production/axarena-export
```

This writes website-ready JSON indexes for leaderboard rows, cells, task
drilldowns, trial outcomes, evidence links, methodology metadata, and failure
review placeholders. Codex and Claude Code remain
separate rankings. Overall first averages eligible tasks within each surface,
then macro-averages the participating surfaces; pass³ is reported as `x% (y/z)`.
The former `ax-eval export-publication` implementation remains available during
the private-workspace compatibility period; it is not yet a delegated alias.

Compare two normalized-record sets without decoding HTML:

```bash
npm run ax-eval -- records-diff --base <baseline-dir> --head <candidate-dir> --out records-diff.md
```
New reusable benchmark tooling should live here; the
`axarena` repo should own the curated website, narrative, and presentation.

## Architecture

`ax-eval` is pack-centered and surface-aware.

- **Contracts:** `TargetPack`, `Task`, `OracleSpec`, and per-surface auth/config
  live in versioned schemas and act as the stable center of the system.
- **Execution matrix:** the same reviewed pack runs across one or more harnesses
  and surfaces (`api`, `cli`, `sdk`, `mcp`), with surface adapters changing how
  the agent discovers and acts rather than changing the outcome-verification model.
- **Truth layer:** executors report ids, but success is decided by independent
  read-back verification against live product state.
- **Interpretation layer:** reports and normalized records turn results, traces,
  and transcripts into recommendations and comparisons.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full system design.

## How It Works

![ax-eval architecture](./assets/architecture.svg)

1. **Ingest:** parse OpenAPI, GraphQL, docs, auth, and sandbox hints.
2. **Generate:** draft an L1-L4 task pack with rule-derived outcome verifiers and
   LLM-assisted task authoring by default.
3. **Review:** hash-lock the pack after human approval and Pack QA warnings.
4. **Execute:** run the same pack across selected surfaces and harnesses.
5. **Verify:** read live state back, score the matrix, and write reports.

## Why It Is Different

- **Goal-level prompts, not endpoint hints.** The agent has to discover the
  surface instead of being handed a curl command.
- **Programmatic outcome verification, not self-report.** Success means the verifier can read
  the expected state back from the product.
- **Target-declared auth and sandbox scope.** Packs say exactly which env vars and
  sandbox ids are needed; secrets stay local in `.env`.
- **Layered gates, not misleading green.** `--min-pass-rate` reports the overall
  gate and per-surface subgates, so a weak MCP or SDK surface remains visible.
- **Competitive reports from the same records.** Stack normalized results across
  products or surfaces to see where competitors, SDKs, CLIs, APIs, or MCP servers
  are easier for agents to use successfully.

## Command Map

```bash
npm run ax-eval -- ingest --openapi <url>       # parse REST/OpenAPI into an ingest file
npm run ax-eval -- ingest --graphql <endpoint|file> # rich GraphQL introspection
npm run ax-eval -- generate --from <ingest.json> [--base-url <graphql-endpoint>] # LLM-assisted by default
npm run ax-eval -- generate --deterministic --from <ingest.json> # CI/offline fallback
npm run ax-eval -- automate-report --company <name> [--openapi <url>|--graphql <endpoint>]
npm run ax-eval -- review --pack <pack.yaml> [--approve --by you]
npm run ax-eval -- init --pack <pack.yaml> [--surface all]
npm run ax-eval -- check-env --pack <pack.yaml> [--surface all]
npm run ax-eval -- exec-plan --pack <pack.yaml> --run-dir <dir>
npm run ax-eval -- exec-plan --pack <pack.yaml> --invoke \
  --harness claude-code --surface all --profile medium --effort medium \
  --model sonnet --run-dir <dir> --invoke-retries 0 # Claude Code, records the actual reported Sonnet model
npm run ax-eval -- exec-plan --pack <pack.yaml> --invoke \
  --harness codex --surface all --profile medium --effort medium \
  --model <gpt-model> --run-dir <dir> --invoke-retries 0 # Codex, use a Codex-compatible model slug
npm run ax-eval -- verify-generated --pack <pack.yaml> --results <run.json>... \
  --html <out.html> [--snapshot <out.snapshot.json>]
npm run ax-eval -- render-generated --snapshot <report.snapshot.json> [--html <out.html>]
npm run ax-eval -- reset --pack <pack.yaml> --ns <run-namespace> [--dry-run]
# Omit --ns only with --dry-run to inventory all probe resources safely.

npm run ax-eval -- audit --site <url>
npm run ax-eval -- discover --site <url>
npm run ax-eval -- smells --openapi <url>
npm run ax-arena -- benchmark competitive --from <sealed-publication-bundle> --html <ignored-output.html>
npm run ax-eval -- records-diff --base <dir> --head <dir> --out <diff.md>
```

The legacy `ax-eval competitive` command remains active while the arena
workspace is private; it is not yet a delegated alias.

CI should validate frozen packs, approvals, deterministic fixtures, tests, and
typecheck. It should not depend on live LLM-assisted regeneration; fresh pack
authoring is a developer workflow that ends at `review --approve`.

For publication-grade cross-harness lanes, prefer native host-agent binaries over
PATH wrappers when a wrapper injects unrelated local config. `AX_EVAL_CLAUDE_BIN`
and `AX_EVAL_CODEX_BIN` let a run pin the executable while the normalized record
still stamps the model actually reported by the harness. Non-MCP Codex cells are
run with an isolated Codex home and `mcp_servers={}` so API/CLI/SDK scores are not
polluted by the operator's unrelated global MCP server logins.

## Safety

Live evals make real writes. Use a sandbox, never production. `init` prints the
env stub a pack declares; `.env` is git-ignored. Surfaces authenticate
independently, so an unavailable SDK/CLI/MCP credential becomes a blocked cell in
the report instead of a misleading failure. OAuth-backed MCP surfaces can be run
headlessly when the pack declares client id, client secret, refresh token, and token
URL env names: ax-eval exchanges the refresh token at invoke time, passes the
short-lived bearer only to the child harness environment, and keeps secret values out
of tracked files.

Packs can declare backward-compatible env aliases too: top-level auth supports
`env_aliases` / `verify_env_aliases`, and token-authenticated SDK/CLI/MCP
surfaces support `token_env_aliases`. The first name stays canonical in packs
and prompts; aliases let an older local setup keep working without changing the
benchmark artifact.

`verify-generated` reads live product state. Do not reset or sweep the sandbox
until after the report is rendered and the user explicitly asks for cleanup.
Cleaning first will make otherwise valid result ids read back as missing and
will corrupt the report.

If you want a stable artifact for examples, review, or later design work, keep
the saved report snapshot and use `render-generated` instead of re-running live
verification. Re-rendering from the snapshot preserves the report inputs; a new
`verify-generated` is a fresh measurement.

Generated packs are executable intent. `exec-plan` refuses unreviewed or changed
packs unless you explicitly bypass the review gate.

## Repository Layout

```text
ARCHITECTURE.md     full technical architecture and system design
src/                CLI, generation, verification, reporting, static checks
src/ingest/         OpenAPI and GraphQL ingestion
src/generate/       task-pack generation, review, report, normalized records
src/harness/        host-agent profiles, transcripts, traces, probe
src/surface/        API, CLI, SDK, MCP surface prompt adapters
src/target/         pack-declared auth, sandbox scope, reset
targets/            tool-layer example packs (see targets/README.md)
ax-arena/benchmark/ private arena workspace and DAEB publication contract
examples/           stable example reports and case-study artifacts
tests/              vitest suite, keyless/offline by default
assets/             README images and report screenshots
docs/               maintainer-local notes, intentionally not public docs
```

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). The best first contribution is a new
target pack generated from a public spec, reviewed with the gate, and backed by a
focused test or outcome-verifier improvement.

## Contact

Questions, target ideas, or agent-usability examples? Open an issue or reach me
on X: [@richardt830](https://x.com/richardt830).
