# DAEB-1 — Support Summary

Human review table derived from `suite.support-matrix.yaml`.
**✓** supported · **—** unsupported / N/A · **?** inconclusive.

| Task | Cockroachdb API / CLI | Insforge API / CLI | Neon API / CLI | Nile API / CLI | Supabase API / CLI | Turso API / CLI |
|---|---|---|---|---|---|---|
| db-T01-access-control access-control | — / ✓ | ✓ / — | — / ✓ | — / — | ✓ / ✓ | ✓ / ✓ |
| db-T02-backup-and-restore backup-and-restore | ✓ / ✓ | ✓ / — | ✓ / ✓ | — / — | ✓ / ✓ | ✓ / ✓ |
| db-T03-evolve-schema evolve-schema | — / ✓ | ✓ / ✓ | — / ✓ | — / ✓ | ✓ / ✓ | ✓ / ✓ |
| db-T04-inspect-schema inspect-schema | — / ✓ | ✓ / — | ✓ / ✓ | — / ✓ | ✓ / — | — / ✓ |
| db-T05-query-records query-records | — / ✓ | ✓ / — | ✓ / ✓ | — / ✓ | ✓ / — | ✓ / ✓ |
| db-T06-vector-search vector-search | — / ✓ | ✓ / — | — / ✓ | — / ✓ | ✓ / — | ✓ / ✓ |
| db-T07-write-records write-records | — / ✓ | — / — | — / ✓ | — / ✓ | ✓ / — | ✓ / ✓ |
| db-T08-change-data-capture change-data-capture | — / ✓ | ✓ / — | ✓ / ✓ | ? / ? | ✓ / — | — / ✓ |
| db-T09-data-integrity-and-transactions data-integrity-and-transactions | — / ✓ | ✓ / — | ? / ? | — / — | — / — | ✓ / ✓ |
| db-T10-full-text-search full-text-search | — / ✓ | ? / ? | — / ✓ | — / ✓ | ✓ / — | ✓ / ✓ |

## Unsupported / inconclusive cell reasons

| Task | Vendor | Surface | Status | Reason |
|---|---|---|---|---|
| db-T01-access-control | Cockroachdb | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T01-access-control | Insforge | cli | unsupported | cli does not satisfy all task-fit requirements on one documented surface |
| db-T01-access-control | Neon | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T01-access-control | Nile | api | unsupported | missing task requirements: data-access-control |
| db-T01-access-control | Nile | cli | unsupported | missing task requirements: data-access-control |
| db-T02-backup-and-restore | Insforge | cli | unsupported | cli does not satisfy all task-fit requirements on one documented surface |
| db-T02-backup-and-restore | Nile | api | unsupported | missing task requirements: artifact |
| db-T02-backup-and-restore | Nile | cli | unsupported | missing task requirements: artifact |
| db-T03-evolve-schema | Cockroachdb | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T03-evolve-schema | Neon | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T03-evolve-schema | Nile | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T04-inspect-schema | Cockroachdb | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T04-inspect-schema | Insforge | cli | unsupported | cli does not satisfy all task-fit requirements on one documented surface |
| db-T04-inspect-schema | Nile | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T04-inspect-schema | Supabase | cli | unsupported | cli does not satisfy all task-fit requirements on one documented surface |
| db-T04-inspect-schema | Turso | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T05-query-records | Cockroachdb | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T05-query-records | Insforge | cli | unsupported | cli does not satisfy all task-fit requirements on one documented surface |
| db-T05-query-records | Nile | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T05-query-records | Supabase | cli | unsupported | cli does not satisfy all task-fit requirements on one documented surface |
| db-T06-vector-search | Cockroachdb | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T06-vector-search | Insforge | cli | unsupported | cli does not satisfy all task-fit requirements on one documented surface |
| db-T06-vector-search | Neon | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T06-vector-search | Nile | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T06-vector-search | Supabase | cli | unsupported | cli does not satisfy all task-fit requirements on one documented surface |
| db-T07-write-records | Cockroachdb | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T07-write-records | Insforge | api | unsupported | missing task requirements: create-record, delete-record |
| db-T07-write-records | Insforge | cli | unsupported | missing task requirements: create-record, delete-record |
| db-T07-write-records | Neon | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T07-write-records | Nile | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T07-write-records | Supabase | cli | unsupported | cli does not satisfy all task-fit requirements on one documented surface |
| db-T08-change-data-capture | Cockroachdb | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T08-change-data-capture | Insforge | cli | unsupported | cli does not satisfy all task-fit requirements on one documented surface |
| db-T08-change-data-capture | Nile | api | inconclusive | missing task requirements: database-change-feed |
| db-T08-change-data-capture | Nile | cli | inconclusive | missing task requirements: database-change-feed |
| db-T08-change-data-capture | Supabase | cli | unsupported | cli does not satisfy all task-fit requirements on one documented surface |
| db-T08-change-data-capture | Turso | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T09-data-integrity-and-transactions | Cockroachdb | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T09-data-integrity-and-transactions | Insforge | cli | unsupported | cli does not satisfy all task-fit requirements on one documented surface |
| db-T09-data-integrity-and-transactions | Neon | api | inconclusive | missing task requirements: duplicate-rejection |
| db-T09-data-integrity-and-transactions | Neon | cli | inconclusive | missing task requirements: duplicate-rejection |
| db-T09-data-integrity-and-transactions | Nile | api | unsupported | missing task requirements: duplicate-rejection |
| db-T09-data-integrity-and-transactions | Nile | cli | unsupported | missing task requirements: duplicate-rejection |
| db-T09-data-integrity-and-transactions | Supabase | api | unsupported | missing task requirements: atomic-write |
| db-T09-data-integrity-and-transactions | Supabase | cli | unsupported | missing task requirements: atomic-write |
| db-T10-full-text-search | Cockroachdb | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T10-full-text-search | Insforge | api | inconclusive | missing task requirements: full-text-query |
| db-T10-full-text-search | Insforge | cli | inconclusive | missing task requirements: full-text-query |
| db-T10-full-text-search | Neon | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T10-full-text-search | Nile | api | unsupported | api does not satisfy all task-fit requirements on one documented surface |
| db-T10-full-text-search | Supabase | cli | unsupported | cli does not satisfy all task-fit requirements on one documented surface |
