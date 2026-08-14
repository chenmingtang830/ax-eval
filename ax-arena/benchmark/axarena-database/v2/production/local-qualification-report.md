# DAEB v2 local qualification handoff

This is a local, provider-aware qualification record for the production
candidate. It is not the official publication bundle: the hosted-trusted run
and detached GitHub OIDC attestation are still required.

## Frozen inputs

- Workspace: `/Users/richardtang/ax-eval`
- Candidate revision: `73e0970`
- Suite audit: 0 errors, 0 warnings, 0 infos
- Pack approvals: all five production pack byte/content hashes match
- Scope: CLI only; CockroachDB, InsForge, Neon, and Nile are runnable. Turso
  remains excluded by the stated organization-capability constraint.
- Trials: three independent trials per runnable vendor/model lane; every cell
  ran with post-verification namespaced cleanup.

## Current-pack local results

The Nile namespace was shortened to `d2p-nile` so PostgreSQL identifiers remain
under the 63-byte limit. Nile was then rerun and its previous failed telemetry
was retained separately.

| lane | evidence roots | task observations | provider-oracle | strict gid+oracle |
| --- | --- | ---: | ---: | ---: |
| Codex / `gpt-5.6-terra` | `results/daeb-v2-codex-gpt56-production-20260814` (CockroachDB, InsForge, Neon) + `results/daeb-v2-codex-gpt56-nile-repair-20260814` | 78 | 74/78 (94.87%) | 49/78 (62.82%) |
| Claude Code / `claude-sonnet-5` | `results/daeb-v2-claude-sonnet5-auto-production-20260814` (CockroachDB, InsForge, Neon) + `results/daeb-v2-claude-sonnet5-nile-repair-20260814` (Nile trials 2–3) + `results/daeb-v2-claude-sonnet5-nile-trace-repair-20260814` (Nile trial 1) | 78 | 78/78 (100%) | 78/78 (100%) |

All listed current-pack audit roots report zero exec-plan exit failures,
approval-hash matches, and cleanup confirmation. The Codex strict denominator
is intentionally retained: provider oracles can pass when a model omitted a
gid, so strict contract completion is reported separately rather than used to
erase valid provider read-back evidence.

## Publication boundary

The fail-closed publication command was exercised against a local run and
stopped with `trusted run attestation subject does not exist`. No local result
is promoted to official/publication evidence. The next authorized step is a
hosted pinned-OCI trusted workflow that produces the committed source/config
batch, cleanup sidecars, aggregate/economics/competitive/export reports, and
detached GitHub OIDC attestation; only then can `publication-bundle` succeed.
