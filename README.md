# ax-eval

**Test whether an AI agent can actually use your product.**

`ax-eval` turns your API, CLI, SDK, or MCP server into reviewed sandbox tasks,
runs them with real coding agents, and verifies the resulting product state.
It measures agent usability—not whether a surface merely exists or has
documentation.

![Sample ax-eval HTML report](./assets/sample-report.png)

## Why use it?

An agent can read your docs and still fail to complete a useful workflow. The
failure may be a missing discovery path, unclear auth, an awkward SDK, or an
MCP tool that cannot complete a common multi-step task. `ax-eval` makes those
gaps visible with reproducible evidence.

It answers questions such as:

- Can an agent discover how to authenticate and use this surface from a cold start?
- Can it complete a realistic workflow through the API, CLI, SDK, or MCP?
- Did the expected state actually change in the sandbox?
- Does one surface work much better than the others?

The report combines task outcomes, observed agent behavior, and concrete
recommendations in the form **target → evidence → fix**.

## What it does

```text
public spec or docs
        ↓
reviewed TargetPack ──→ real agent × product surface ──→ live read-back verification
        ↓                                                    ↓
  declared auth, sandbox scope, tasks                    HTML report + normalized records
```

The important distinction is the last step: task success is decided by an
independent read-back oracle, not by the agent saying that it succeeded.

## Quick start

Requires Node.js 22 or newer.

```bash
git clone https://github.com/chenmingtang830/ax-eval.git
cd ax-eval
npm install

# Keyless, offline checks using the bundled example pack.
npm run ax-eval -- run --offline
npm run ax-eval -- audit --offline
```

To work on the repository:

```bash
npm test
npm run typecheck
```

## Evaluate a product

Use a disposable sandbox, never production. The standard workflow is:

1. Ingest a public OpenAPI or GraphQL surface.
2. Generate a draft pack and review it.
3. Declare only the credentials and sandbox identifiers the pack asks for.
4. Run the reviewed tasks with a host agent.
5. Verify the live state and open the report.

```bash
# 1. Build a draft from a public OpenAPI document.
npm run ax-eval -- ingest --openapi https://example.com/openapi.json \
  --out results/acme-ingest.json
npm run ax-eval -- generate --from results/acme-ingest.json \
  --product Acme --out results/acme.pack.yaml

# 2. Review the executable task pack. Any later edit requires re-approval.
npm run ax-eval -- review --pack results/acme.pack.yaml --approve --by you

# 3. Print and check the local environment contract.
npm run ax-eval -- init --pack results/acme.pack.yaml >> .env
npm run ax-eval -- check-env --pack results/acme.pack.yaml

# 4. Run tasks through a local host-agent harness.
npm run ax-eval -- exec-plan --pack results/acme.pack.yaml --invoke \
  --harness codex --surface all --profile medium --effort medium \
  --model <gpt-model> --run-dir results/runs/acme

# 5. Read the sandbox state back and produce a self-contained report.
npm run ax-eval -- verify-generated --pack results/acme.pack.yaml \
  --results results/runs/acme/run-*.json \
  --min-pass-rate 0.8 --html results/runs/acme/eval.html
```

For GraphQL, replace the first command with:

```bash
npm run ax-eval -- ingest --graphql https://api.example.com/graphql \
  --out results/acme-ingest.json
```

`generate` is LLM-assisted by default. For deterministic, keyless CI fixtures,
add `--deterministic`.

### One-command authoring handoff

`automate-report` can perform discovery, ingest, generation, configuration
handoff, and a smoke gate. It deliberately stops before approval: a person must
review every generated pack.

```bash
npm run ax-eval -- automate-report --company Acme \
  --openapi https://example.com/openapi.json --surface all --harness codex
```

## Core ideas

| Concept | Why it matters |
| --- | --- |
| **TargetPack** | A versioned description of tasks, allowed surfaces, authentication names, sandbox scope, and outcome oracles. |
| **Review gate** | Packs are executable intent. Approval is content-addressed, so changing a pack re-opens review. |
| **Surface matrix** | The same task can be evaluated through `api`, `cli`, `sdk`, and `mcp`, without conflating their results. |
| **Harness** | Run through Claude Code, Codex, OpenCode, or Pi and retain a normalized result for each configuration. Pi currently supports API, CLI, and SDK cells. |
| **Read-back oracle** | Verify the product's live state after execution; agent self-report is never the authority. |

Packs belong in `targets/`. In most cases, adding support for a product means
adding a reviewed pack—not changing the runner.

## See a finished report

The repository includes stable, self-contained examples:

- [Stripe: four surfaces × two harnesses](./examples/stripe-four-surface-cross-harness.html)
- [Notion: four surfaces × two harnesses](./examples/notion-four-surface-cross-harness.html)
- [Linear: GraphQL across surfaces and harnesses](./examples/linear-graphql-cross-surface-cross-harness.html)
- [Exa: search-oriented API evaluation](./examples/exa-cross-harness-cross-surface.html)

## Command guide

| Goal | Command |
| --- | --- |
| Check baseline readiness | `run --offline`, `audit --site <url>`, `discover --site <url>` |
| Inspect an OpenAPI document | `smells --openapi <url>` |
| Create a pack | `ingest` → `generate` → `review --approve` |
| Run a reviewed pack | `exec-plan --pack <pack.yaml> --invoke` |
| Verify and report | `verify-generated --pack <pack.yaml> --results <run.json>...` |
| Re-render without touching live state | `render-generated --snapshot <snapshot.json>` |
| Inspect environment needs | `init --pack <pack.yaml>`, `check-env --pack <pack.yaml>` |
| Clean a sandbox after verification | `reset --pack <pack.yaml> --ns <namespace>` |
| Compare result sets | `records-diff --base <dir> --head <dir> --out <diff.md>` |

Run `npm run ax-eval -- <command> --help` for exact flags. While developing in
a clone, this runs local TypeScript source; use `node dist/cli.js` only after
`npm run build` when smoke-testing the package entrypoint.

### Running agents yourself

Omit `--invoke` from `exec-plan` to emit prompts and run them with your own
agent workflow. Then pass the resulting run JSON files to `verify-generated`.
For a pilot run, use the same `--task <id>` on both commands so unrun tasks do
not enter the denominator.

## Safety and reproducibility

- **Use a sandbox.** Live evaluations create real resources. Keep credentials in
  local `.env`; it is ignored by Git.
- **Verify before cleanup.** `verify-generated` reads live state. Resetting
  first turns valid results into missing resources and corrupts the report.
- **Keep the review gate.** `exec-plan` refuses an unreviewed or modified pack
  unless you explicitly bypass it. Do not bypass it for normal work.
- **Keep reports stable.** Verification saves a snapshot beside the HTML. Use
  `render-generated` to revisit the same evidence without a new live run.
- **Keep identities separate.** Results are keyed by product, surface, harness,
  model, and effort; configurations are not silently averaged together.

## Library API

The package also exposes a typed ESM API for controllers that need to validate
packs, select surface-compatible tasks, or execute one fully specified cell.

```ts
import {
  EvaluationCellSchema,
  TargetPackSchema,
  checkApproval,
  runCell,
  tasksForSurface,
  verifyGeneratedPack,
} from "ax-eval";
```

`runCell` executes exactly one approved pack × target × surface × harness ×
model × effort × trial and emits an `ax.normalized-cell-record/v1` record. It
does not choose a roster, aggregate results, publish a leaderboard, or clean up
resources; a controller owns those policies. See [ARCHITECTURE.md](./ARCHITECTURE.md)
for the public contracts and runtime design.

## AXArena-Database

This repository also contains the tooling boundary for the private
AXArena-Database benchmark workspace. It uses the same reviewed packs,
execution, and verification contracts, but owns its benchmark roster,
production workflow, aggregation, and publication policy separately.

Most product teams can ignore this section. Benchmark maintainers should start
with [the AXArena-Database README](./ax-arena/benchmark/axarena-database/README.md)
and [the architecture guide](./ARCHITECTURE.md).

## Project layout

```text
src/                 CLI, generation, execution, verification, reporting
src/ingest/          OpenAPI and GraphQL ingestion
src/generate/        pack generation, review, oracles, records, reports
src/harness/         Codex / Claude Code / OpenCode / Pi invocation and traces
src/surface/         API, CLI, SDK, and MCP adapters
src/target/          pack-declared auth, sandbox scope, and reset
targets/examples/    reviewed example packs
examples/            finished HTML reports
tests/               keyless, offline Vitest suite
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). The usual contribution is a focused
pack or verifier improvement, with keyless/offline tests where behavior changes.

## Contact

Questions or target ideas? [Open an issue](https://github.com/chenmingtang830/ax-eval/issues)
or reach out on X: [@richardt830](https://x.com/richardt830).
