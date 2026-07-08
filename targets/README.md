# Target Packs

Each target pack declares the product contract ax-eval needs: auth env names,
sandbox scope, available surfaces, tasks, and read-back oracles. Secrets never
live here; run `ax-eval init --pack <pack.yaml> --surface all` to print the exact
`.env` stub for a pack. Generated packs are drafts until their matching
`*.approval.json` passes the review gate.

The committed example packs themselves live under `targets/examples/<product>/`.
If you generate your own local pack and keep the default output path, it may
land under `targets/<product>/`; that path is for user-local/generated packs,
not for the shipped example baselines.

Use `targets/examples/<product>/` for the repository-tracked example/reference
packs. Runtime artifacts still belong under `results/`.

## AXArena Canonical Suites

AXArena benchmark suites live under `targets/suites/`. DAEB-1 is the first
canonical suite:

```text
targets/suites/daeb-1-v3.yaml
```

For DAEB-1, the vendor files are layered:

- `targets/vendors/<vendor>.discovered.yaml` — public vendor card: product name,
  docs URL, site URL, category metadata.
- `targets/extracts/<vendor>/daeb-1-v3.yaml` — vendor-specific verifier adapter:
  read-back checks, auth/base URL, N/A mapping.
- `targets/extracts/<vendor>/surfaces.yaml` — optional CLI/SDK/MCP surface
  adapters for the agent (`extract-surfaces`). REST API is the implicit default
  surface and is intentionally omitted from this file; API auth/base URL live in
  the oracle extract.
- `targets/extracts/<vendor>/capability-inventory.yaml` — cited capability
  inventory (`extract-capabilities`). Each entry's `surfaces_documented` field
  records which surfaces the official docs say can perform that capability
  (documentation attribution for suite synthesis), which is separate from
  `surfaces.yaml`.
- `targets/packs/<vendor>/daeb-1-v3.yaml` — compiled executable `TargetPack`
  produced from the canonical suite plus the adapters above.

Publication-grade suites also carry sibling methodology artifacts next to the
suite YAML itself: methodology, concept universe, coverage matrix, selection
ledger, support matrix, grader ledger, failure taxonomy, and trace-review memo.
Those artifacts explain how the Discoverability & Readiness layer and the usability canonical
suite layer were derived without collapsing them into one score.

The compiled DAEB-1 packs are not separate benchmark definitions. They exist so
`exec-plan` and `verify-generated` can run against each vendor while preserving
one shared suite and scoring contract.

## Auditing Extracts

Files under `targets/extracts/<vendor>/` are candidate methodology inputs until
the pipeline-review gate signs them off. For publication work, review them in
this order:

1. Rerun `ax-eval extract-surfaces` and `ax-eval extract-capabilities` (with
   registry/OpenAPI seeds where available) and diff capability slugs, evidence
   URLs, and surface auth fields.
2. Spot-check each quoted `doc_url`. Capability evidence marked
   `derived_from_connection_surface`, `summary_index`, `marketing_claim`, or
   `inferred` needs an explicit reviewer decision before it can support a
   behavioral task.
3. Verify `surfaces_documented` describes documented capability attribution, not
   merely agent setup. The implicit API surface comes from the oracle extract;
   non-API execution surfaces must be declared in `surfaces.yaml` or generated
   by a vendor-specific fallback.
4. Keep managed-only capabilities (`support_type: managed-surface`) out of the
   behavioral suite unless the task can perform and verify a user-visible state
   change.
5. Reconcile accepted capabilities with the suite coverage matrix, selection
   ledger, and support matrix before publishing.

## Good Starting Points

- `examples/notion/pack.yaml` — REST target with API / CLI / SDK / MCP coverage and the
  current README screenshot/report.
- `examples/stripe/pack.yaml` — REST target with API / CLI / SDK / MCP in test mode.
- `examples/linear/pack.yaml` — GraphQL target with SDK + MCP surfaces.
- `examples/exa/pack.yaml` — non-CRUD/search API target.

## Additional Packs

- `examples/asana/pack.yaml` — legacy REST reference pack and internal benchmark; review
  and approve it before live runs, or use one of the committed generated Asana
  variants in this repository.
- `examples/monday/pack.yaml` — GraphQL work-management pack; useful for local rehearsal.

Generated variants such as `generated.pack.yaml` and `generated.full.pack.yaml`
are fixtures or larger benchmark sets. Prefer the plain `pack.yaml` when you are
trying ax-eval for the first time.

If you want to keep generated or experimental packs in-repo without replacing a
committed example pack, prefer a separate user-local path such as
`targets/<product>/generated.pack.yaml`, or pass `--out` explicitly.
