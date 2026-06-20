# Target Packs

Each target pack declares the product contract ax-eval needs: auth env names,
sandbox scope, available surfaces, tasks, and read-back oracles. Secrets never
live here; run `ax-eval init --pack <pack.yaml> --surface all` to print the exact
`.env` stub for a pack.

## Good Starting Points

- `notion/pack.yaml` — REST target with API / CLI / SDK / MCP coverage and the
  current README screenshot/report.
- `stripe/pack.yaml` — REST target with API / CLI / SDK / MCP in test mode.
- `linear/pack.yaml` — GraphQL target with SDK + MCP surfaces.
- `exa/pack.yaml` — non-CRUD/search API target.

## Additional Packs

- `asana/pack.yaml` — original REST reference pack and internal benchmark.
- `monday/pack.yaml` — GraphQL work-management pack; useful for local rehearsal.

Generated variants such as `generated.pack.yaml` and `generated.full.pack.yaml`
are fixtures or larger benchmark sets. Prefer the plain `pack.yaml` when you are
trying ax-eval for the first time.
