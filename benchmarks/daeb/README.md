# DAEB — Database AX Benchmark

Publication contract for the AXArena Database AX Benchmark (DAEB).

This tree is the **benchmark layer**. The ax-eval **tool layer** (generic CLI
example packs) lives under [`targets/examples/`](../../targets/examples/).

## Layout

```text
benchmarks/daeb/
  vendors/<slug>.discovered.yaml     # shared vendor cards (docs/site/openapi)
  v1/                                # active frozen version
    suite.yaml                       # canonical task suite
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
  → synthesize-suite --out benchmarks/daeb/v1/suite.yaml
  → extract-tasks / compose-pack
  → review --approve
```

Extracts under `v1/extracts/` are a **reproducibility contract**: they ship in
git and the npm package so suite synthesis can be audited without regenerating
from the live web.

## Hygiene

- Do not nest ad-hoc archives under live `extracts/`; use `_archive/`.
- `audit_status: reviewed` is a content gate before publication freeze.
- Runtime run artifacts stay in `results/` (gitignored), never here.
