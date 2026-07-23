# AXArena Benchmark

This private workspace is the in-repository ownership boundary for benchmark
planning, DAEB policy, provider composition, aggregation, and publication. It
depends on the supported `ax-eval` package API; `ax-eval` must never import it.

**Trusted execution architecture:** read
[`TRUSTED_EXECUTION_DESIGN.md`](./TRUSTED_EXECUTION_DESIGN.md) before changing
runtime backends, credentials, sandboxing, source trust, or publication gates.

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
provisioning requires an explicit install root, version, and SHA-256. Official
hosted execution gets those values only from the committed trusted-runtime lock;
the executable and its full ancestor chain must be non-writable by the
controller user.

Pack composition and database prompt overrides are arena-owned under
`src/authoring/`; the core package no longer exports their implementation.
Canonical/legacy benchmark paths and the artifact persistence wrappers moved
from core are also arena-owned. They use no-follow, single-link, and inode
validation under an exclusive trusted-checkout-UID assumption. Remaining
arena-native direct file I/O is a later hardening seam. Generic task extraction
and schema validation remain public `ax-eval` contracts.

`executeArenaCell` owns one reviewed cell lifecycle: it partitions host,
verifier, and reset credentials; runs against an isolated pack copy; validates
and durably persists the normalized record; then performs namespace-bounded
cleanup and persists strict `ax.arena-cell-cleanup/v1` evidence. Cleanup never
precedes record persistence. Callers must explicitly choose `native` or
`pinned-oci` and `local` or `hosted-trusted`; only pinned OCI hosted execution is
publishable, and pinned execution never falls back to native tools. The protected
workflow freezes one committed whole-benchmark configuration, derives a bounded
API/CLI matrix without secrets, and runs exactly one descriptor per fresh
protected job. Each per-cell environment supplies one exact-name credential JSON
object. Before that secret is injected, Docker and sudo re-extract the verified
OCI digest into a root-owned sysroot and seal the exact locked Node, harnesses,
Bubblewrap, and database tools. Every pinned result binds that runtime-manifest
hash. After execution, the controller no-follow copies only the result, record,
cleanup, and four declared evidence files into a fixed-name transfer envelope;
the harness-writable workspace is never uploaded. A credential-free assembler
requires the exact transfer tree, exact cell set, and one byte-identical runtime
manifest; a separate OIDC-enabled job signs only the reverified detached subject.
The v2 Bubblewrap policy mounts only the OCI `/usr` and root-owned tool tree
read-only, with no `seccomp=unconfined`. A source-only injected-runtime seam is
used exclusively by offline contract tests and is not exported by the package.

Immutable batch manifests use an opaque `batch-<UUID>` identity and bind the
source SHA, reviewed suite and pack hashes, credential-name partitions,
model/effort/trial matrix, timeouts, reset policy, per-cell runtime/reset
provider identities, and pinned tools before execution. The declared vendors,
surfaces, harnesses, and trials must form a complete command-specific matrix.
`ax-arena benchmark plan` also freezes `batch-plan.json`: an ordered
whole-benchmark plan whose one-cell descriptors carry only credential names,
never values. The manifest records the committed configuration path and blob
hash; workers and the assembler re-read that file from the immutable source
commit and require its path/hash again as an external controller attestation,
so replacing both run-local artifacts cannot redefine the cohort. A
worker selects exactly one descriptor, attests the actual root-owned harness
binary and version with a secret-free probe, and only then materializes that
cell's four credential partitions. It writes one hash-bound
`ax.arena-cell-result/v1` envelope; a separate credential-free assembler accepts
exactly one envelope per planned key before it writes completion. Serial and
matrix execution therefore share the same completion validation.

Completion records are accepted only for the exact cell set with matching
requested/actual models, one version per harness, and confirmed cleanup whenever
reset is required; record, cleanup, and all four runtime artifact files are
sealed by contained relative paths and SHA-256. The manifest, plan, cell-result,
and completion contracts are
shipped as strict structural JSON schemas; cross-field and persisted-artifact
guarantees require the exported runtime validators and are not implied by JSON
Schema validation alone. `trusted:plan`, `trusted:worker`, and
`trusted:assemble` are compiled and package-smoked controller boundaries used by
the thin workflow. The source change remains manual-only and does not run a live
or credentialed benchmark by itself.

Runtime reporting consumes only a persisted, hash-bound batch completion. It
revalidates canonical record and cleanup bytes plus every sealed runtime
artifact before deriving process evidence from the native Codex or Claude Code
transcript. Unattributed native calls remain process evidence but never produce
task-scoped structural diffs. Reporting writes per-surface HTML, snapshots,
failure reviews, and
produces per-harness trial aggregates plus one immutable reporting manifest.
That manifest requires the source SHA, exact batch/completion hashes, explicit
runtime backend and trust level, nullable pinned-sandbox provenance, and the
SHA-256 of every emitted report and aggregate artifact.
Reporting does not execute cells or relax the trusted-workflow gate.

Trusted dispatch validation, OCI/sysroot and exact-tool preparation, the real
Bubblewrap smoke, sealed-artifact export, and detached-subject construction are
arena-owned under `scripts/`. The repository-root workflow YAML is only the
GitHub-required launcher and environment/credential binding surface.
`scripts/prepare-trusted-tools.sh` sequences verified sysroot extraction,
lockfile-only repository installation, build, and exact tool sealing before
the workflow exposes credentials.

For one minor release, DAEB readers accept the former `benchmarks/daeb/` root
only when this canonical root is absent and emit a deprecation warning. If both
roots exist, pass `--benchmark-root <dir>` explicitly. Writers use only
`ax-arena/benchmark/daeb/`; no duplicate files or symlinks are supported.

Frozen benchmark artifacts under `daeb/` moved byte-for-byte so pack approvals
and provenance remain verifiable. Documentation-only path and link corrections
in `daeb/README.md` do not change pack or approval bytes. The frozen
`v1/run-matrix.yaml`, `v1/suite.audit-notes.md`, and `v1/suite.synthesis.md`
still retain historical `benchmarks/daeb/` text from the relocation commit;
interpret those references as `ax-arena/benchmark/daeb/`.

```bash
npm run ax-arena -- benchmark --help
npm run ax-arena -- benchmark synthesize-suite --help
```

For a reviewed live cohort, copy only the required credential entries from
`.env.example` into the repository-root `.env`. Generic harness credentials
remain in the root ax-eval template. OCI, Node, harness, Bubblewrap, and Turso
executable identity is committed in `trusted-runtime/runtime-lock.json` and has
no environment override.

`ax-arena benchmark export-publication` provides offline parity for converting
a sealed `ax.publication-bundle/v2` directory into the seven axarena JSON
indexes. It validates canonical batch/completion provenance, derives task and
trial outputs from completed records, binds snapshot outcomes to exact cell
evidence, and recomputes aggregate scores before an atomic output write. This
does not activate the trusted `publish` command, which remains fail-closed.

`ax-arena benchmark competitive` renders the offline surface × product ×
harness comparison from high-effort three-trial aggregate records bound to a
sealed publication bundle. Its canonical batch supplies each vendor's supported
surfaces, and its completed records bind every displayed score, model, and exact
harness pin. Structural N/A rows remain explicit. The ignored output directory
must already exist; the no-follow writer never creates parent directories. The
deprecated `ax-eval competitive` name delegates to this command during the
private-workspace compatibility period. Pass
`--from <sealed-publication-bundle>`.

`ax-arena benchmark publication-bundle` freezes a completed, aggregated arena
run into a hardened `ax.publication-bundle/v2` directory. The immutable batch
selects the vendors, surfaces, harnesses, models, profiles, and trials; callers
cannot override the cohort. The command revalidates the batch, completion,
report, aggregate, suite, pack, and approval hashes, copies only the canonical
DAEB allowlist, generates the competitive report, and atomically publishes a
manifest whose integrity section binds every exported artifact. Production
bundles are created only from `pinned-oci + hosted-trusted` reruns whose
detached GitHub OIDC attestation verifies against the protected-main workflow;
native, local-pinned, low-pass, missing-attestation, and invalid-attestation
runs fail closed instead of producing drafts. Verification requires external
`AX_ARENA_APPROVED_SIGNER_SHA`; the protected environment variable
`AX_ARENA_APPROVED_SIGNER_SHA` must equal `github.workflow_sha` before either
credentials or signing are available. The bundle preserves the signed
subject, runtime/configuration provenance, exact runtime report, completed-cell
records, cleanup evidence, and all four artifact seals. Before the atomic rename,
the writer reruns the canonical aggregator and reporting renderer from those
attested cells and requires byte-identical aggregates, snapshots, HTML, and
failure review. Its reporting timestamp must equal the signed completion time.
Downstream cohort loading repeats that derivation, verifies
the signed DAEB source set and exact physical inventory, and rejects rewritten
manifest prose or extra files; a self-described integrity envelope is never
sufficient.
Legacy `ax-eval publication-bundle` flags remain accepted only when their
suite, vendor, and effort selectors exactly match the immutable batch; they
cannot narrow or rewrite the cohort.
Freeze runs after all harness children exit and assumes exclusive use by the
trusted controller UID; do not run an untrusted same-UID process concurrently
against the output parent. The output parent must not be writable by an
untrusted group or other UID.
