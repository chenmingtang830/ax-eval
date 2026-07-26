# DAEB-1 — Support Summary

Human review table derived from `suite.support-matrix.yaml`.
**✓** supported · **—** unsupported / N/A · **?** inconclusive.

| Task | Broad / task-fit vendors | Cockroachdb API / CLI | Insforge API / CLI | Neon API / CLI | Nile API / CLI | Supabase API / CLI | Turso API / CLI |
|---|---|---|---|---|---|---|---|
| db-T01-access-control access-control | 6/6 / 5/6 | — / ✓ | — / ✓ | — / ✓ | — / — | ✓ / ✓ | ✓ / ✓ |
| db-T02-evolve-schema evolve-schema | 6/6 / 6/6 | — / ✓ | ✓ / ✓ | — / ✓ | — / ✓ | ✓ / ✓ | ✓ / ✓ |
| db-T03-inspect-schema inspect-schema | 6/6 / 6/6 | — / ✓ | ✓ / — | ✓ / ✓ | — / ✓ | ✓ / — | — / ✓ |
| db-T04-query-records query-records | 6/6 / 6/6 | — / ✓ | — / ✓ | ✓ / ✓ | — / ✓ | ✓ / — | ✓ / ✓ |
| db-T05-vector-search vector-search | 6/6 / 6/6 | — / ✓ | — / ✓ | — / ✓ | — / ✓ | ✓ / — | ✓ / ✓ |
| db-T06-write-records write-records | 6/6 / 6/6 | — / ✓ | — / ✓ | — / ✓ | — / ✓ | ✓ / — | ✓ / ✓ |
| db-T07-full-text-search full-text-search | 5/6 / 5/6 | — / ✓ | ? / ? | — / ✓ | — / ✓ | ✓ / — | ✓ / ✓ |

## Unsupported / inconclusive cell reasons

| Task | Vendor | Surface | Status | Reason |
|---|---|---|---|---|
| db-T01-access-control | Cockroachdb | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T01-access-control | Insforge | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T01-access-control | Neon | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T01-access-control | Nile | api | unsupported | missing task requirements: data-access-control |
| db-T01-access-control | Nile | cli | unsupported | missing task requirements: data-access-control |
| db-T02-evolve-schema | Cockroachdb | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T02-evolve-schema | Neon | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T02-evolve-schema | Nile | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T03-inspect-schema | Cockroachdb | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T03-inspect-schema | Insforge | cli | unsupported | cli does not satisfy all task-fit requirements on one documented surface |
| db-T03-inspect-schema | Nile | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T03-inspect-schema | Supabase | cli | unsupported | cli does not satisfy all task-fit requirements on one documented surface |
| db-T03-inspect-schema | Turso | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T04-query-records | Cockroachdb | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T04-query-records | Insforge | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T04-query-records | Nile | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T04-query-records | Supabase | cli | unsupported | cli does not satisfy all task-fit requirements on one documented surface |
| db-T05-vector-search | Cockroachdb | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T05-vector-search | Insforge | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T05-vector-search | Neon | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T05-vector-search | Nile | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T05-vector-search | Supabase | cli | unsupported | cli does not satisfy all task-fit requirements on one documented surface |
| db-T06-write-records | Cockroachdb | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T06-write-records | Insforge | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T06-write-records | Neon | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T06-write-records | Nile | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T06-write-records | Supabase | cli | unsupported | cli does not satisfy all task-fit requirements on one documented surface |
| db-T07-full-text-search | Cockroachdb | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T07-full-text-search | Insforge | api | inconclusive | missing task requirements: full-text-query |
| db-T07-full-text-search | Insforge | cli | inconclusive | missing task requirements: full-text-query |
| db-T07-full-text-search | Neon | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T07-full-text-search | Nile | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T07-full-text-search | Supabase | cli | unsupported | cli does not satisfy all task-fit requirements on one documented surface |

## Research tasks (excluded from core scoring)

| Concept | Broad vendors | Task-fit vendors | Reason |
|---|---|---|---|
| backup-and-restore | 6 | 5 | strict verifier contract pending |
| change-data-capture | 5 | 5 | strict verifier contract pending |
| data-integrity-and-transactions | 5 | 3 | task-fit coverage below 75% (3/6 vendors; need ≥5) |
