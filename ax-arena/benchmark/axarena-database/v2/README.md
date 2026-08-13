# AXArena-Database v2 — CLI-only authoring gate

This is the hash-bound `DAEB-v2-cli-rc0` calibration boundary, not a
publication-ready benchmark. The v1 six-vendor API/CLI matrix remains immutable
diagnostic history.

The current benchmark is deliberately SQL/CLI-only:

```text
CLI surface -> deterministic setup -> mutation -> independent verify -> cleanup
  -> admitted support tuple -> pack composition -> model pilot
```

Scope:

- Vendors: CockroachDB, InsForge, Neon, Nile, and Turso.
- Supabase is excluded entirely.
- All API tuples are excluded.
- Turso T01 is excluded because the denied-token probe requires an
  organization-level capability not supplied by the ordinary cell credential.
- Turso T07 is excluded because the admitted sandbox CLI lacks the documented
  experimental `index_method`/`fts_match` capability required for native FTS.
- Nile T01 is excluded because its documented tenant isolation is not the
  user-configurable access-control mechanism required by that task.
- The official-doc refresh added InsForge T03 schema inspection to CLI scope;
  v1 had attributed that tuple to API only. InsForge execution uses the
  admitted v1 `psql` data-plane adapter; the newer vendor CLI docs are evidence
  for the task concept and the current SQL contract remains explicit.
- The remaining 31 tuples are CLI witness candidates. All 31 are now
  `supported`; each has
  setup, mutation, independent read-back, cleanup, and hash-bound proof
  evidence in the run artifacts; the status source of truth is
  `support-matrix.yaml`.

`cli-doc-audit.yaml` records the official documentation refresh and each task
decision. `witness-plan.yaml` and `support-matrix.yaml` are fail-closed
authoring artifacts. `witness-run-matrix.yaml` is a deterministic witness
matrix, not a model/trial matrix; it intentionally has no harnesses and no
model trials. The packs have execution approvals for the witnessed run; those
approvals are not an independent semantic/publication review.

The semantic task intent is inherited from v1 and deterministically wrapped in
the CLI refresh contract. `rc0-semantic-audit.yaml` freezes the current input
hashes and separates 23 common-SQL tuples, 5 shared-PostgreSQL-extension
tuples, and only 3 vendor-feature SQL tuples. Accordingly, this is a CLI
data-plane calibration pack, not a vendor-native capability leaderboard.

Before a public benchmark release, complete independent semantic review, write
vendor-native/control-plane tasks or publish stratified scores only, bind the
final artifacts to an immutable revision, block Cockroach local-target fallback,
remove the known external cleanup residual with a cluster-admin credential, and
run the declared multi-trial hosted execution.

Regenerate from the repository root:

```bash
npm run ax-arena -- benchmark prepare-v2 --apply
```

CLI-only is the default. The command is offline, reads only the immutable v1
packs, and refuses to overwrite a non-empty v2 directory.
