# DAEB v2 production readiness record

This directory is the canonical CLI-only production candidate. It is frozen
against the five-vendor, seven-task identity set; structural N/A entries remain
explicit and are excluded from denominators.

## Local gates completed

- `prepare-v2-production` derives the source without drift: 5 vendors × 7
  canonical tasks, 31 admitted CLI tuples.
- All five pack approvals bind the current `pack.yaml` bytes.
- A provider-aware oracle audit path is checked in at
  `ax-arena/benchmark/scripts/run-v2-production-model.ts`.
- The local Codex qualification cohorts cover 3 trials for CockroachDB, InsForge,
  Neon, and Nile using the exact production packs; the current-pack aggregate is
  74/78 provider-oracle passes (49/78 strict gid+oracle passes), diagnostic only.
- The local Claude Code cohort uses `--isolated-harness-auth` (native
  `bypassPermissions`) and the exact production packs; the repaired current-pack
  Nile trials are 18/18, while the unchanged CockroachDB/InsForge/Neon trials
  are 60/60. The combined local qualification is 78/78 provider-oracle and
  strict passes, but remains local evidence rather than publication evidence.
- Nile's production `run_id` is intentionally short (`d2p-nile`) so its
  namespace-qualified PostgreSQL identifiers remain below the 63-byte limit;
  the corresponding approval sidecar was re-bound to the new pack bytes.
- The executor prompt now requires numeric trace status/exit codes, preventing
  string statuses such as `"ok"` from silently entering a required trace.
- The delegated trace review records one trace per vendor/trial in
  `suite.trace-review.yaml`.

## Publication gates still external

Local execution is not publication evidence. The official bundle remains
blocked until one immutable hosted batch provides all of the following:

1. the committed source SHA and committed batch configuration;
2. the pinned-OCI runtime and bubblewrap provenance;
3. three clean trials for every roster identity and admitted cell;
4. confirmed exact-scope cleanup sidecars;
5. detached GitHub OIDC attestation for the trusted run;
6. aggregate, economics, competitive, and export checks from the arena CLI.

The current v2 candidate intentionally does not claim official publication
readiness until those fail-closed gates are present.
