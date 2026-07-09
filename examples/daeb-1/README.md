# DAEB-1 publication snapshot

Frozen suite/adapters live in `benchmarks/daeb/v1/`. This directory holds the
exportable publication bundle consumed by `axarena-site`.

Current `publication-bundle/` is a **draft scaffold** produced by
`ax-eval publication-bundle` against the frozen packs (no live run matrix yet).
Replace it after a clean dated production rerun:

```bash
npm run ax-eval -- daeb-production-rerun \
  --suite benchmarks/daeb/v1/suite.yaml \
  --run-dir results/runs/daeb-v1-YYYYMMDD

npm run ax-eval -- publication-bundle \
  --suite benchmarks/daeb/v1/suite.yaml \
  --run-dir results/runs/daeb-v1-YYYYMMDD \
  --out examples/daeb-1/publication-bundle

npm run ax-eval -- export-publication \
  --from examples/daeb-1/publication-bundle \
  --out examples/daeb-1/export
```

Then point `axarena-site/data/` at the export (or regenerate site data from the
manifest) and redeploy.
