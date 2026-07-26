# Target Packs (tool layer)

Each target pack declares the product contract ax-eval needs: auth env names,
sandbox scope, available surfaces, tasks, and read-back oracles. Secrets never
live here; run `ax-eval init --pack <pack.yaml> --surface all` to print the exact
`.env` stub for a pack. Generated packs are drafts until their matching
`*.approval.json` passes the review gate.

## Example packs

Committed example packs live under `targets/examples/<product>/`.

Use these when you want a single-vendor ax-eval demo (Notion, Stripe, Linear,
Exa, …). They are **tool-layer** fixtures, not the AXArena publication suite.

If you generate your own local pack and keep the default output path, it may
land under `targets/<product>/`; that path is for user-local/generated packs,
not for the shipped example baselines.

Runtime artifacts still belong under `results/`.

## AXArena / DAEB

The Database AX Benchmark publication contract lives under
[`ax-arena/benchmark/daeb/`](../ax-arena/benchmark/daeb/README.md) — suites, vendor cards,
capability inventories, surfaces, and compiled packs for the multi-vendor
canonical suite. Do not put DAEB artifacts back under `targets/`.

## Good starting points (tool demos)

- `examples/notion/pack.yaml` — REST target with API / CLI / SDK / MCP coverage
- `examples/stripe/pack.yaml` — REST target with API / CLI / SDK / MCP in test mode
- `examples/linear/pack.yaml` — GraphQL target with SDK + MCP surfaces
- `examples/exa/pack.yaml` — non-CRUD/search API target

## Additional packs

- `examples/asana/pack.yaml` — legacy REST reference pack
- `examples/monday/pack.yaml` — GraphQL work-management pack for local rehearsal
