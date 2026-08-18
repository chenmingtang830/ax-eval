# DAEB v2 local production-candidate readiness

This directory is a local, provider-aware release candidate for the CLI-only
database benchmark. It is not hosted-trusted publication evidence.

## Scope and denominators

- Core roster: CockroachDB, InsForge, Neon, Nile, and Turso.
- Core pack identity: 5 vendors × 7 canonical task identities; 31 admitted
  CLI tuples and 4 structural N/A tuples.
- Core comparative denominator: 20 common-SQL tuple identities (5 vendors ×
  T02, T03, T04, and T06). Vendor-feature tasks remain vendor-stratified.
- Additive local extension: Supabase CLI-only, 7/7 supported tuples. It is
  stored under `production/extensions/supabase-cli/` and is not an API cell or
  a silent change to the core denominator.
- Additive local release total: 38 admitted CLI tuple identities and 228
  model task-trial observations across two harnesses × three trials. Supabase
  contributes 42 of those observations.
- API cells: 0. Supabase API/PostgREST remains explicitly excluded because the
  API surface cannot provision the role/table/policy state required by T01.

Structural N/A entries remain visible and excluded from every denominator:
Nile T01 (tenant isolation is not the required user-configurable control),
Turso T01 (no ordinary-cell denied-token capability), Turso T07 (the admitted
sandbox lacks the experimental `index_method`/`fts_match` capability), and
InsForge T07 (not admitted by the current CLI capability audit).

## Deterministic and pack gates

- Core Turso deterministic witness: 5/5 after the CLI token contract repair;
  the witness plan and source pack hash were rebound.
- Supabase CLI-only deterministic witness: 7/7, each with setup, mutation,
  independent SQL read-back, cleanup, and hash-bound proof.
- Every runnable pack has a matching exact-file approval sidecar. The Supabase
  extension has its own standard-set version (`daeb-2-cli-extension-v1`) and
  approval; it does not inherit the frozen v2 API matrix.
- The Turso CLI contract now declares the existing `TURSO_ORG_API_TOKEN` and
  keeps `TURSO_API_TOKEN` only as an alias. The original missing-token and
  malformed-results telemetry is retained under `results/`.

## Local model evidence

The current local roster is Codex `gpt-5.6-terra` and Claude Code
`claude-sonnet-5`, both at high effort. Exact final-pack rescue runs are:

- Turso: Codex 15/15 strict+oracle; Claude Code 15/15 strict+oracle.
- Supabase CLI extension: Codex 21/21; Claude Code 21/21.
- The four-vendor pre-existing Codex cohort remains 74/78 oracle and 49/78
  strict; its failures are preserved rather than erased. The corresponding
  Claude cohort is 78/78 and 78/78.

Thus the combined local release is 224/228 provider-oracle passes and 199/228
strict gid+oracle passes. These are local qualification numbers, not a claim
that all models are equally capable or that hosted publication gates passed.

## Observed discovery and secondary AX score

Phase 0 was present in the frozen prompts and is visible in every retained
final-cohort transcript. It was executed once per vendor/harness/model/trial
cell before the cell's task batch, not independently for every task. The
post-hoc audit in `local-ax-scorecard.json` decodes those transcripts and scores
only four objective discovery signals: official source reached, canonical CLI
action observed, not misled, and auth evidence observed. Raw commands and
transcript bodies are not copied into the scorecard.

Across the 36 release cells, observed discovery is 94.44%. The secondary AX
composite is the harmonic mean of provider-oracle task usability (98.25%) and
cell-level discovery, producing 96.31%. Hops remain diagnostic, strict
gid+oracle remains a separate process-quality measure, and provider-oracle
task success remains the canonical behavioral pass rate. This reconstruction
uses only retained evidence and does not turn local runs into hosted-trusted
evidence.

Efficiency is also retained as a separate panel. All 36 release cells have
cell wall time and first-action latency (221.0s mean cell time, 213.9s median,
7.1s mean first action). Cost coverage is 18/36 because Claude Code reported
$14.697 across its 114 task observations while Codex reported `null`. Missing
cost is never interpreted as zero or replaced with a list-price estimate. See
`local-all-results.md` for every release and comparative-appendix cell.

## Publication boundary

The official bundle remains blocked until an immutable hosted run supplies the
committed configuration, pinned OCI runtime, three clean trials for every
roster identity and admitted cell, exact-scope cleanup sidecars, detached
GitHub OIDC attestation, and the arena aggregate/economics/competitive/export
checks. A local result is publishable as a clearly labelled local experiment,
but it must not be represented as the official hosted-trusted benchmark.
