# DAEB — Database AX Benchmark

Publication contract for the AXArena Database AX Benchmark (DAEB).

This tree is the **benchmark layer**. The ax-eval **tool layer** (generic CLI
example packs) lives under [`targets/examples/`](../../../targets/examples/).
Shared engine architecture (both tracks) lives in
[`ARCHITECTURE.md`](../../../ARCHITECTURE.md).

**Current status:** mutable v1 authoring freeze is done for the 6-vendor core
cohort (Neon, CockroachDB, Turso, Supabase, Insforge, Nile) — packs approved;
trace review completed. Composed packs now carry a `discovery:` contract
(Agent Discovery Score) and `openapi_url` when the vendor card has one; static
v0/v2 (/v3 when OpenAPI is present) still run at `verify-generated` time and
remain a separate Discoverability & Readiness layer from task pass rates.
Production dated reruns and publication freeze are **deferred** until after
team review.

## Layout

```text
ax-arena/benchmark/daeb/
  vendors/<slug>.discovered.yaml     # shared vendor cards (docs/site/openapi)
  v1/                                # active mutable version until publication freeze
    vendor-selection-ledger.yaml     # core/research/excluded cohort contract
    suite.yaml                       # canonical task suite
    suite.support-summary.md         # human-readable API/CLI support table
    suite.trace-review.yaml          # fixed-sample freeze memo
    run-matrix.yaml                  # production cell / dated-root conventions
    extracts/<vendor>/
      capability-inventory.yaml      # Layer 0a cited capabilities
      surfaces.yaml                  # CLI/SDK/MCP agent adapters
      oracles.yaml                   # per-task read-back checks (when present)
      advisory.yaml                  # optional audit-extracts --advisory notes
    packs/<vendor>/
      pack.yaml                      # compiled TargetPack
      pack.approval.json             # review gate
  _archive/                          # superseded suites / pre-audit snapshots
```

## Artifact roles

| Artifact | Role |
|---|---|
| `suite.yaml` | Canonical shared task bank. Not a pack. Owns task ids, intents, difficulty, scoring contract. |
| `vendor-selection-ledger.yaml` | Core / research / excluded cohort. Fixed before task outcomes. Core alone drives synthesis + production order. |
| `extracts/<vendor>/` | Reproducibility contract: cited capabilities, surfaces, oracles. Ships in git and npm. |
| `packs/<vendor>/pack.yaml` | **Compiled** execution artifact from suite + extracts. Not an independently authored benchmark. Includes `discovery:` for Agent Discovery Score and `static` / `openapi_url` inputs for Discoverability & Readiness. |
| `suite.support-summary.md` | Human-readable which vendor/surface cells are applicable. |
| `suite.trace-review.yaml` | Fixed-sample transcript review memo; incomplete memo blocks `audit-suite` / freeze. |
| `run-matrix.yaml` | Production cell shape and dated run-root conventions. |

## Authoring pipeline

```text
import-registry / resolve-vendor
  → extract-surfaces
  → extract-capabilities
  → audit-extracts --apply
  → audit-extracts --advisory       # optional WebFetch-grounded human aid
  → synthesize-suite --out ax-arena/benchmark/daeb/v1/suite.yaml
  → audit-suite                     # task-fit, pack, cohort, trace gates
  → extract-tasks / compose-pack
  → review --approve
```

Extracts under `v1/extracts/` are a **reproducibility contract**: they ship in
git and the npm package so suite synthesis can be audited without regenerating
from the live web.

### Vendor-selection ledger

The ledger is upstream of suite synthesis:

- **Core** — 75% concept-selection cohort and production run order
- **Research** — methodology work; must not enter the scored denominator silently
- **Excluded** — dated eligibility reasons (e.g. no persistent free managed sandbox)

Cohort membership is not chosen from benchmark outcomes.

### Concept coverage vs applicability

The 75% concept-coverage bar chooses the shared task bank. Each coverage
decision retains ranked capability candidates and the selected capability
bundle. A support-matrix cell is enabled only when every task-fit requirement is
evidenced on that same surface. Broad concept membership alone never enables a
run cell.

## Quality gates

Audits have two layers:

1. **Deterministic** (`audit-extracts --apply`, `audit-suite`) — block stale task
   fit, unsupported surfaces, pack/sandbox drift, cohort-contract violations, and
   incomplete trace-review memos.
2. **Advisory** (`audit-extracts --advisory`) — WebFetch-grounded LLM review that
   writes `advisory.yaml` only; never rewrites artifacts or changes a blocking
   result.

Additional content gates:

- `audit_status: reviewed` on extracts before publication freeze
- Pack content-hash approvals (`review --approve`)
- Re-synthesis resets `suite.trace-review.yaml` to `pending`

## Calibration vs production

| Mode | Purpose | Root convention |
|---|---|---|
| Pilot / remediation / trace refresh | Authoring calibration | local `results/` (gitignored); not benchmark-of-record |
| `daeb-production-rerun` | Benchmark-of-record matrix | dated `results/runs/daeb-v1-YYYYMMDD/` |

Production lane constraints:

- Surfaces: `api` and `cli` only
- Harnesses: Codex and Claude Code
- Effort: `high`; Codex `gpt-5.6-terra`, Claude Code `claude-sonnet-5`
- Trials: three isolated trials + `aggregate/` mean/range per cell
- SDK / MCP: research evidence only for v1 scoring denominator

When production is unblocked, dispatch the **Trusted sandbox arena benchmark**
workflow with the full reviewed source SHA and a committed configuration path
under `ax-arena/benchmark/daeb/`. Do not invoke the production command directly:
both `ax-arena benchmark daeb-production-rerun` and its deprecated `ax-eval`
alias intentionally fail closed without the workflow-attested OS sandbox.

## Publication bundle and export

After production cells are verified:

```bash
npm run ax-eval -- publication-bundle \
  --suite ax-arena/benchmark/daeb/v1/suite.yaml \
  --vendors neon,cockroachdb,turso,supabase,insforge,nile \
  --run-dir results/runs/daeb-1-v1-production \
  --out results/runs/daeb-1-v1-production/publication-bundle \
  --effort-profiles high \
  --required-effort-profiles high

npm run ax-arena -- benchmark export-publication \
  --from results/runs/daeb-1-v1-production/publication-bundle-final \
  --out results/runs/daeb-1-v1-production/axarena-export
```

The bundle ties together suite, vendor cards, extracts, compiled packs,
approvals, snapshots, normalized records, and competitive report. Missing live
artifacts are listed explicitly. Arena export additionally requires the final
bundle to carry and satisfy a complete `ax.publication-integrity/v1` envelope;
the envelope binds canonical production batch/completion bytes, all completed
cell sidecars and nested evidence, and recomputable three-trial aggregates.
Legacy unsealed v2 bundles remain draft-only. `ax-eval` owns truth generation;
the AXArena website imports exported JSON indexes rather than recomputing scores.

## Hygiene

- Do not nest ad-hoc archives under live `extracts/`; use `_archive/`.
- Runtime run artifacts stay in `results/` (gitignored), never here.
- Clean production reruns use dated roots (see [`v1/run-matrix.yaml`](./v1/run-matrix.yaml)).
- Until publication freeze, re-synthesis overwrites the same v1 contract and
  invalidates pack approvals; do not bump the suite version for authoring
  iterations.
- **Two layers stay separate:** usability suite pass rates from read-back
  oracles; Discoverability & Readiness from static audit + Agent Discovery
  Score (`pack.discovery`). Never fold static/disc into the task denominator.
