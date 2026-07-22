# AXArena Benchmark

This private workspace is the in-repository ownership boundary for benchmark
planning, DAEB policy, provider composition, aggregation, and publication. It
depends on the supported `ax-eval` package API; `ax-eval` must never import it.

The workspace composes immutable runtime-extension registries through the
public `ax-eval` package specifier and owns canonical DAEB artifacts under
`daeb/`. DAEB authoring policy and its nine commands now live under
`src/authoring/`; the old `ax-eval` spellings delegate here with a one-minor
deprecation warning.

Arena-owned SQL and Mongo read-back oracles, Postgres/MongoDB/Turso/Convex
reset providers, database health checks, and no-download Turso CLI attestation
live under `src/providers/`. `createDatabaseRuntimeExtensionRegistry` creates a
fresh immutable registry for each worker from explicit controller-selected
ambient state. Activation by the low-pass and production controllers, followed
by removal of the transitional core database fallbacks, is the next stack
slice.

Provider cleanup is namespace-bounded and non-cascading. Postgres revalidates
function identities server-side and includes exact DAEB-created roles; cleanup
remains unconfirmed when unrelated dependencies prevent a drop. Turso CLI
provisioning requires `AX_ARENA_TURSO_INSTALL_ROOT`,
`AX_ARENA_TURSO_CLI_VERSION`, and `AX_ARENA_TURSO_CLI_SHA256`; the executable
and its full ancestor chain must be non-writable by the controller user.

Runtime-shared pack composition, database prompt overrides, task extraction,
and artifact readers remain temporary public `ax-eval` compatibility seams;
the runtime and publication stack slices remove those residuals without
duplicating policy between packages.

`executeArenaCell` owns one reviewed cell lifecycle: it partitions host,
verifier, and reset credentials; runs against an isolated pack copy; validates
and durably persists the normalized record; then performs namespace-bounded
cleanup and persists strict `ax.arena-cell-cleanup/v1` evidence. Cleanup never
precedes record persistence. The public execution entry point fails closed
until the trusted workflow slice supplies an OS-level filesystem sandbox. A
source-only injected-runtime seam is used exclusively by offline contract tests
and is not exported by the built package. No live or credentialed evaluation is
enabled by this migration slice.

Immutable batch manifests bind the source SHA, reviewed suite and pack hashes,
credential-name partitions, model/effort/trial matrix, timeouts, reset policy,
per-cell runtime/reset provider identities, and pinned tools before execution.
The declared vendors, surfaces, harnesses, and trials must form a complete
command-specific matrix. Completion records are accepted only for the exact
cell set with matching requested/actual models, one version per harness, and
confirmed cleanup whenever reset is required; record, cleanup, and all four
runtime artifact files are sealed by contained relative paths and SHA-256.
Both contracts are shipped as
strict structural JSON schemas; cross-field and persisted-artifact guarantees
require the exported runtime validators and are not implied by JSON Schema
validation alone.

Runtime reporting consumes only a persisted, hash-bound batch completion. It
revalidates canonical record and cleanup bytes plus every sealed runtime
artifact before deriving process evidence from the native Codex or Claude Code
transcript. Unattributed native calls remain process evidence but never produce
task-scoped structural diffs. Reporting writes per-surface HTML, snapshots,
failure reviews, and
produces per-harness trial aggregates plus one immutable reporting manifest.
Reporting does not execute cells or relax the trusted-workflow gate.

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
npm run ax-arena -- benchmark synthesize-suite --help
```
