# V2.1 candidate gate report (draft)

Generated from the current deterministic six-vendor CLI synthesis on
2026-08-15. This is an authoring diagnostic, not an approval or a formal
result.

## Candidate pool

- 16 candidate tasks; the three required anchors are present exactly once:
  `db-T02-evolve-schema`, `db-T04-query-records`, and `db-T06-write-records`.
- Candidate family counts: access/auth/discovery 2, schema/integrity 4,
  query/search 5, lifecycle/recovery 5.
- 12/16 concepts have CLI task-fit coverage of at least 5/6 vendors. Twelve
  concepts currently have complete independent witness coverage for every
  supported tuple in the pack-readiness ledger; this is capacity, not a
  calibration selection.
- `access-control` remains in the ledger as research-only because its generic
  negative-path contract is not independently witnessed for all admitted
  vendors. The two admitted access-family capacity candidates are the fresh
  CLI session and principal-continuity variants.
- Lower-coverage and verifier-pending concepts remain visible with their
  rejection reasons; they cannot be relabeled N/A to hide missing evidence.

## CLI support audit

| Candidate | CLI task-fit support | ready tuples | audit state |
|---|---:|---:|---|
| cli-session-discovery | 5/6 | 5 | fresh deterministic witness; Turso structural N/A |
| cli-principal-continuity | 5/6 | 5 | fresh deterministic witness; Turso structural N/A |
| constraint-preservation | 6/6 | 6 | fresh deterministic witness |
| transactional-record-recovery | 6/6 | 6 | fresh deterministic witness |
| aggregate-query | 6/6 | 6 | fresh deterministic witness |
| negative-query-verification | 5/6 | 5 | fresh deterministic witness; Turso structural N/A |
| evolve-schema | 6/6 | 6 | existing reviewed V2 witness |
| inspect-schema | 5/6 | 5 | existing reviewed V2 witness; InsForge structural N/A |
| query-records | 6/6 | 6 | existing reviewed V2 witness |
| vector-search | 6/6 | 6 | existing reviewed V2 witness |
| write-records | 6/6 | 6 | existing reviewed V2 witness |
| full-text-search | 5/6 | 5 | existing witnesses plus fresh Turso FTS witness |

The five lower-coverage/research concepts are now explicitly structural N/A or
not admitted under the registered five-of-six task-fit gate: pack readiness is
67 ready, 0 blocked supported, and 29 structural N/A/non-admitted. The only
delegated ten-sample trace/protocol review is complete; audit now has zero
errors and zero warnings. No selection, freeze, pack approval,
calibration result, or formal score is asserted from this draft.

## Hashes

- candidate suite: `e41edd3a72ae2b641fe4ac679000e1745b30d08cf4fb7f46337aa5d13dc93b70`
- selection ledger: `55bff315703530ebe228afa11a759e92d8f32eb56c2b1d1e2b16f87bc8188bbd`
- support matrix: `0f15c5f7941f622f10e8994baacff9e5a4b3d31b510b9b11d4df4781b9b1f954`
- pack readiness: `c8c233939c9ff55fa352d44afcd31292703a7509a988b09a2aabd4fde1c3a92d`
- docs snapshot: `f7cd10da61f0b13ac822617653b7f9438dbbb727aa8ef778686febf4f14d3d63`
- readiness counts: 67 ready vendor-task tuples, 0 blocked supported tuples, 29 structural N/A/non-admitted tuples.
