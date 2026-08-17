# AXArena Database 1.0.0 frozen publication data

This directory is the deterministic, vendor-first export for the first public
AXArena Database release. It is built from the frozen internal DAEB V2.4
protocol. The primary outcome is J01 end-to-end success. Atomic tasks are
supporting diagnostics and model/trial rows are supplementary slices.

- `vendor-summary.json`: vendor rows with outcome, discovery, efficiency, and cost columns.
- `model-slices.json`: supplementary model-level J01 view.
- `tasks.json`: the frozen atomic and J01 task contract.
- `evidence-index.json`: source hashes for all 28 final-audit inputs.
- `archive-manifest.json`: explicit embedded/external/raw archive disposition.
- `evidence/`: sanitized final audits, observations, and reconciliation ledgers.
- `exclusions.json`: retained invalid/diagnostic runs and their admission decisions.
- `checksums.json`: SHA-256 inventory for every other file in this directory.

The release is diagnostic: seven model/provider slices, two trials, five core
database vendors, 420 atomic cells, and 70 J01 journeys. It is not a universal
product leaderboard. Workstation paths in evidence are replaced with
`workspace://ax-eval/` URIs. Transient upstream failures are preserved as
observations; the export does not claim those failures will recur on demand.
