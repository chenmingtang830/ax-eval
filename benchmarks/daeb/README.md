# DAEB — Database AX Benchmark

Publication contract for the AXArena Database AX Benchmark (DAEB).

This tree is the **benchmark layer**. The ax-eval **tool layer** (generic CLI
example packs) lives under [`targets/examples/`](../../targets/examples/).

## Layout

```text
benchmarks/daeb/
  vendors/<slug>.discovered.yaml     # shared vendor cards (docs/site/openapi)
  v1/                                # active frozen version
    vendor-selection-ledger.yaml     # core/research/excluded cohort contract
    suite.yaml                       # canonical task suite
    suite.support-summary.md         # human-readable API/CLI support table
    extracts/<vendor>/
      capability-inventory.yaml      # Layer 0a cited capabilities
      surfaces.yaml                  # CLI/SDK/MCP agent adapters
      oracles.yaml                   # per-task read-back checks (when present)
    packs/<vendor>/
      pack.yaml                      # compiled TargetPack
      pack.approval.json             # review gate
  _archive/                          # superseded suites / pre-audit snapshots
```

## Authoring pipeline

```text
import-registry / resolve-vendor
  → extract-surfaces
  → extract-capabilities
  → audit-extracts --apply
  → audit-extracts --advisory       # optional WebFetch-grounded human aid
  → synthesize-suite --out benchmarks/daeb/v1/suite.yaml
  → audit-suite                     # task-fit, pack, cohort, trace gates
  → extract-tasks / compose-pack
  → review --approve
```

Extracts under `v1/extracts/` are a **reproducibility contract**: they ship in
git and the npm package so suite synthesis can be audited without regenerating
from the live web.

The vendor-selection ledger is upstream of suite synthesis. Core vendors define
the 75% concept-selection cohort and production run order; research vendors
remain available for methodology work without affecting the canonical bank.
Exclusions record dated eligibility reasons (for example, no persistent free
managed sandbox) so the cohort is not chosen from benchmark outcomes.

Audits have two layers: deterministic gates block stale task fit, unsupported
surfaces, pack/sandbox drift, and cohort-contract violations. The optional
`audit-extracts --advisory` layer uses WebFetch-grounded LLM review only to
surface cited semantic questions; it writes `advisory.yaml`, never rewrites
artifacts or changes a blocking result.

## Hygiene

- Do not nest ad-hoc archives under live `extracts/`; use `_archive/`.
- `audit_status: reviewed` is a content gate before publication freeze.
- Runtime run artifacts stay in `results/` (gitignored), never here.
- Clean production reruns use dated roots: `results/runs/daeb-v1-YYYYMMDD/`
  (see [`v1/run-matrix.yaml`](./v1/run-matrix.yaml)).
