# Supabase CLI-only extension

This is an additive local extension to DAEB v2. It is intentionally separate
from the five-vendor core matrix:

- admitted surface: `psql` against `SUPABASE_DB_URL`;
- API/PostgREST cells: zero;
- tasks: all seven canonical database task identities;
- deterministic witness: 7/7 with independent read-back and cleanup;
- model evidence: Codex `gpt-5.6-terra` 21/21 and Claude Code
  `claude-sonnet-5` 21/21 strict+oracle observations.

The pack is derived from the v1 task intent but has a new CLI-only standard-set
version and its own approval sidecar. Official Supabase documentation used for
the refresh is recorded in `pack.yaml`; the local witness artifacts live at
`results/daeb-v2-supabase-cli-extension-witness-20260814/`.

This extension must not be combined with the core five-vendor score without
declaring a new denominator. The core comparison remains 20 common-SQL tuple
identities; adding Supabase yields a descriptive six-vendor common-SQL view of
24 tuple identities, not a retroactive rewrite of the frozen core.
