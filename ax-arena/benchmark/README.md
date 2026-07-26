# AXArena Benchmark

This private workspace is the in-repository ownership boundary for benchmark
planning, DAEB policy, provider composition, aggregation, and publication. It
depends on the supported `ax-eval` package API; `ax-eval` must never import it.

The workspace currently composes immutable runtime-extension registries through
the public `ax-eval` package specifier. Canonical DAEB artifacts remain under
`benchmarks/daeb/`, and existing `ax-eval` commands retain their current
behavior until their dedicated relocation PRs.

```bash
npm run ax-arena -- benchmark --help
```
