# DAEB v2 local qualification handoff

This is a local, provider-aware qualification record for the five-vendor
CLI-only core plus an explicitly separate Supabase CLI-only extension. It is
not the official hosted-trusted publication bundle.

## Frozen inputs

- Workspace: `/Users/richardtang/ax-eval`
- Surface scope: CLI only; API cells: 0.
- Core: CockroachDB, InsForge, Neon, Nile, Turso.
- Core: 31 admitted tuples, 4 structural N/A tuples, 20 common-SQL tuple
  identities.
- Extension: Supabase CLI-only, 7 admitted tuples, no API cells.
- Trials: three independent trials per runnable vendor/model lane, with
  post-verification namespaced cleanup.

## Exact model evidence

| lane | task usability | observed discovery | AX harmonic composite | strict gid+oracle |
| --- | ---: | ---: | ---: | ---: |
| Core Codex / `gpt-5.6-terra` | 89/93 (95.70%) | 90.00% (15 cells) | 92.76% | 64/93 |
| Core Claude Code / `claude-sonnet-5` | 93/93 (100%) | 100% (15 cells) | 100% | 93/93 |
| Supabase CLI extension Codex / `gpt-5.6-terra` | 21/21 (100%) | 83.33% (3 cells) | 90.91% | 21/21 |
| Supabase CLI extension Claude Code / `claude-sonnet-5` | 21/21 (100%) | 100% (3 cells) | 100% | 21/21 |

Combined local release: 228 task-trial observations, 224/228 provider-oracle
passes, and 199/228 strict gid+oracle passes. The four pre-existing Codex
failures remain in the denominator and telemetry; they were not deleted or
relabelled as target support failures.

The retained transcripts also support 36 cell-level discovery observations.
Their mean discovery score is 94.44%. Combining task usability (98.25%) and
observed discovery with `2UD/(U+D)` gives a secondary local AX score of 96.31%.
The primary behavioral metric remains provider-oracle task success; the
composite does not replace `pass@1` or pool discovery as if it were measured
once per task. Each model first performed Phase 0 discovery once, then attempted
that cell's 5-7 tasks in the same session.

The exact evidence selection and hashes are in `local-ax-cohort.yaml` and
`local-ax-scorecard.json`; the complete 51-cell release-plus-appendix table is
in `local-all-results.md`. Four Codex cells received 0.5 discovery scores
(InsForge trials 1-2, Nile trial 1, and Supabase trial 2) because their observed
commands did not establish the pack's canonical CLI action or an auth lookup.
No model output was rerun or manually upgraded for this reconstruction.

Latency telemetry covers all 36 release cells: mean cell wall time is 221.0s,
median is 213.9s, mean first-action latency is 7.1s, and aggregate normalized
time is 34.9s per task observation. Harness-reported cost covers only the 18
Claude cells: $14.697 total, $0.817 per covered cell, and $0.129 per covered
task observation. Codex cost is unavailable rather than zero, so this release
does not claim a cross-harness cost winner.

## Support and exclusions

The canonical core structural N/A set is Nile T01, Turso T01, Turso T07, and
InsForge T07. Supabase is not part of that core matrix: its API/PostgREST
surface is excluded, while the separately reviewed `supabase-cli` extension
admits all seven tasks through `psql` and `SUPABASE_DB_URL`.

The Supabase extension deterministic witness is recorded under
`results/daeb-v2-supabase-cli-extension-witness-20260814/`; all seven cells
passed setup, mutation, independent SQL read-back, cleanup, and hash binding.

The repaired Turso source and production packs now declare
`TURSO_ORG_API_TOKEN` as the CLI token environment name, with
`TURSO_API_TOKEN` as an alias. The updated exact-pack witnesses and model runs
are under `results/daeb-v2-vendor-rescue-turso-witness-auth-contract-20260814/`,
`results/daeb-v2-turso-final-pack-codex-20260814/`, and
`results/daeb-v2-turso-final-pack-claude-20260814/`.

## Publication boundary

The local result can be released as a clearly labelled local experiment. It
must not be called hosted-trusted or official publication evidence until the
committed source/config batch, pinned OCI runtime, exact-scope cleanup
sidecars, detached GitHub OIDC attestation, and the arena aggregate/economics/
competitive/export gates all exist.
