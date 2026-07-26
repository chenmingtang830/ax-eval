# AXArena Benchmark

This private workspace is the in-repository ownership boundary for benchmark
planning, DAEB policy, provider composition, aggregation, and publication. It
depends on the supported `ax-eval` package API; `ax-eval` must never import it.

The workspace composes immutable runtime-extension registries through the
public `ax-eval` package specifier and owns canonical DAEB artifacts under
`daeb/`. Existing `ax-eval` commands retain their current behavior while their
dedicated arena replacements are developed.

For one minor release, DAEB readers accept the former `benchmarks/daeb/` root
only when this canonical root is absent and emit a deprecation warning. If both
roots exist, pass `--benchmark-root <dir>` explicitly. Writers use only
`ax-arena/benchmark/daeb/`; no duplicate files or symlinks are supported.

The files already frozen under `daeb/` moved byte-for-byte so approvals and
provenance remain verifiable. As a result, `daeb/README.md`, `v1/run-matrix.yaml`,
`v1/suite.audit-notes.md`, and `v1/suite.synthesis.md` retain historical
`benchmarks/daeb/` text for this relocation commit. Interpret those references
as `ax-arena/benchmark/daeb/`; current commands and links in the repository root
documentation use the canonical path above.

```bash
npm run ax-arena -- benchmark --help
```
