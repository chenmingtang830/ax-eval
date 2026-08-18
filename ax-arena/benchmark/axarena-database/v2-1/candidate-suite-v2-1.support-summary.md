# CANDIDATE-SUITE-V2-1 — Support Summary

Human review table derived from `suite.support-matrix.yaml`.
**✓** supported · **—** unsupported / N/A · **?** inconclusive.

| Task | Broad / task-fit vendors | Cockroachdb API / CLI | Insforge API / CLI | Neon API / CLI | Nile API / CLI | Supabase API / CLI | Turso API / CLI |
|---|---|---|---|---|---|---|---|
| db-T17-cli-session-discovery cli-session-discovery | 5/6 / 5/6 | · / ✓ | · / ✓ | · / ✓ | · / ✓ | · / ✓ | · / ? |
| db-T21-cli-principal-continuity cli-principal-continuity | 5/6 / 5/6 | · / ✓ | · / ✓ | · / ✓ | · / ✓ | · / ✓ | · / ? |
| db-T18-constraint-preservation constraint-preservation | 6/6 / 6/6 | · / ✓ | · / ✓ | · / ✓ | · / ✓ | · / ✓ | · / ✓ |
| db-T19-transactional-record-recovery transactional-record-recovery | 6/6 / 6/6 | · / ✓ | · / ✓ | · / ✓ | · / ✓ | · / ✓ | · / ✓ |
| db-T20-aggregate-query aggregate-query | 6/6 / 6/6 | · / ✓ | · / ✓ | · / ✓ | · / ✓ | · / ✓ | · / ✓ |
| db-T22-negative-query-verification negative-query-verification | 5/6 / 5/6 | · / ✓ | · / ✓ | · / ✓ | · / ✓ | · / ✓ | · / ? |
| db-T07-backup-and-restore backup-and-restore | 6/6 / 5/6 | · / ✓ | · / — | · / ✓ | · / — | · / ✓ | · / ✓ |
| db-T02-evolve-schema evolve-schema | 6/6 / 6/6 | · / ✓ | · / ✓ | · / ✓ | · / ✓ | · / ✓ | · / ✓ |
| db-T09-inspect-schema inspect-schema | 6/6 / 6/6 | · / ✓ | · / — | · / ✓ | · / ✓ | · / ✓ | · / ✓ |
| db-T04-query-records query-records | 6/6 / 6/6 | · / ✓ | · / ✓ | · / ✓ | · / ✓ | · / ✓ | · / ✓ |
| db-T11-vector-search vector-search | 6/6 / 6/6 | · / ✓ | · / ✓ | · / ✓ | · / ✓ | · / ✓ | · / ✓ |
| db-T06-write-records write-records | 6/6 / 6/6 | · / ✓ | · / ✓ | · / ✓ | · / ✓ | · / ✓ | · / ✓ |
| db-T13-change-data-capture change-data-capture | 5/6 / 5/6 | · / ✓ | · / — | · / ✓ | · / ? | · / — | · / ✓ |
| db-T14-full-text-search full-text-search | 5/6 / 5/6 | · / ✓ | · / ? | · / ✓ | · / ✓ | · / ✓ | · / ✓ |
| db-T15-database-branching database-branching | 4/6 / 4/6 | · / ? | · / — | · / — | · / ? | · / — | · / — |
| db-T16-data-integrity-and-transactions data-integrity-and-transactions | 5/6 / 3/6 | · / ✓ | · / — | · / ? | · / — | · / — | · / ✓ |

## Unsupported / inconclusive cell reasons

| Task | Vendor | Surface | Status | Reason |
|---|---|---|---|---|
| db-T17-cli-session-discovery | Turso | cli | inconclusive | missing task requirements: authenticated-cli-session |
| db-T21-cli-principal-continuity | Turso | cli | inconclusive | missing task requirements: authenticated-principal-continuity |
| db-T22-negative-query-verification | Turso | cli | inconclusive | missing task requirements: negative-query-with-state-preservation |
| db-T07-backup-and-restore | Insforge | cli | unsupported | cli does not satisfy all task-fit requirements on one documented surface |
| db-T07-backup-and-restore | Nile | cli | unsupported | missing task requirements: artifact |
| db-T09-inspect-schema | Insforge | cli | unsupported | cli does not satisfy all task-fit requirements on one documented surface |
| db-T13-change-data-capture | Insforge | cli | unsupported | cli does not satisfy all task-fit requirements on one documented surface |
| db-T13-change-data-capture | Nile | cli | inconclusive | missing task requirements: database-change-feed |
| db-T13-change-data-capture | Supabase | cli | unsupported | cli does not satisfy all task-fit requirements on one documented surface |
| db-T14-full-text-search | Insforge | cli | inconclusive | missing task requirements: full-text-query |
| db-T15-database-branching | Cockroachdb | cli | inconclusive | No inventory citation or gap-check confirmation found. |
| db-T15-database-branching | Insforge | cli | unsupported | Concrete database task-fit evidence is absent for this concept; retained as research-only and excluded from the CLI denominator. |
| db-T15-database-branching | Neon | cli | unsupported | Concrete database task-fit evidence is absent for this concept; retained as research-only and excluded from the CLI denominator. |
| db-T15-database-branching | Nile | cli | inconclusive | No inventory citation or gap-check confirmation found. |
| db-T15-database-branching | Supabase | cli | unsupported | Concrete database task-fit evidence is absent for this concept; retained as research-only and excluded from the CLI denominator. |
| db-T15-database-branching | Turso | cli | unsupported | Concrete database task-fit evidence is absent for this concept; retained as research-only and excluded from the CLI denominator. |
| db-T16-data-integrity-and-transactions | Insforge | cli | unsupported | cli does not satisfy all task-fit requirements on one documented surface |
| db-T16-data-integrity-and-transactions | Neon | cli | inconclusive | missing task requirements: duplicate-rejection |
| db-T16-data-integrity-and-transactions | Nile | cli | unsupported | missing task requirements: duplicate-rejection |
| db-T16-data-integrity-and-transactions | Supabase | cli | unsupported | missing task requirements: atomic-write |

## Research tasks (excluded from core scoring)

| Concept | Broad vendors | Task-fit vendors | Reason |
|---|---|---|---|
| access-control | 6 | 5 | retained as research only: independent CLI access-control witness is not complete for all admitted vendors |
| backup-and-restore | 6 | 5 | strict verifier contract pending |
| change-data-capture | 5 | 5 | strict verifier contract pending |
| database-branching | 4 | 4 | coverage below 75% (4/6 vendors; need ≥5) |
| data-integrity-and-transactions | 5 | 3 | task-fit coverage below 75% (3/6 vendors; need ≥5) |
