export const DATABASE_CAPABILITY_COVERAGE_REQUIREMENTS = Object.freeze([
  "Do not over-index on differentiated premium/platform features while skipping baseline operational capabilities.",
  "When docs expose SQL, a document API, Postgres/SQLite compatibility, a table API, or a typed SDK, inventory supported baseline operations: create table/collection, insert rows/documents, filtered reads/querying, pagination/count/read-back, schema introspection, export/import, and tracked schema changes.",
  "Baseline data definition: creating tables/collections, defining columns/fields, or schema introspection.",
  "Baseline data writes: inserts, updates, deletes, bulk writes/imports, or equivalent record mutation flows.",
  "Baseline data reads: filtered queries, sorting/pagination, counts, read-back/introspection, or equivalent retrieval flows.",
  "Schema evolution: tracked migrations, schema change workflows, branching, or deploy/apply mechanisms when documented.",
  "Integrity controls: constraints, schema validation, transactions, or equivalent correctness guarantees.",
  "Access control: row-level policies, role-based access, identity-scoped tokens, or equivalent permission boundaries.",
  "Operational recovery: backups, snapshots, restore, point-in-time recovery, export/import, or equivalent recovery paths.",
  "Server-side execution: functions, triggers, procedures, jobs, webhooks, or equivalent in-database/runtime compute.",
  "Advanced but benchmark-relevant capabilities when present: full-text search, vector search, change-data-capture, realtime subscriptions.",
]);
