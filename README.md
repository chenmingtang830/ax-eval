# ax-eval — Agent operability evals for product surfaces

API / CLI / SDK / MCP

## Can agents actually operate your product?

Agents are becoming users of software. They read your docs, call your APIs,
invoke your MCP server, install your SDK, and try to complete work without a
human sitting beside them.

Most teams know what they have published. They do **not** know whether an agent
can actually operate it, or whether success depends on the particular harness
and surface combination being tested.

`ax-eval` turns that into a real integration matrix. It runs the same reviewed
task pack across host agents and product surfaces — for example Claude Code vs.
Codex, and API vs. SDK vs. MCP — then verifies the resulting sandbox state with
programmatic read-back oracles. The report shows which cells passed, which cells
failed, and whether the gap is product docs, surface coverage, auth setup,
harness behavior, or verification.

That matters because agent operability is not a single green check. API docs can
be usable while MCP tools are missing. Claude Code can recover through REST
fallbacks while a headless Codex run exposes an approval or provisioning gap. A
static readiness score can look fine while a real agent still cannot complete the
job.

Matrix reports keep those signals separate: product-level discovery and spec
quality, per-harness behavioral success, per-surface subgates, and evidence-backed
recommendations. An overall pass can still surface a failing MCP/SDK/API cell
instead of hiding it behind one number.

**Being published is not the same as being operable by agents.**

`AX` means **Agent Experience**: how agents discover, understand, authenticate
against, and use your product surfaces. `ax-eval` measures the hardest outcome
inside AX: **agent operability** — whether an agent can complete real sandbox
work and have that work verified by live read-back.

## The Problem

- A static readiness score can tell you that `llms.txt`, OpenAPI, SDK docs, or an
  MCP entry point exists. It cannot prove an agent can finish the job.
- Code-sample CI can prove a snippet compiles. It cannot prove an agent can find
  the right path from a cold start.
- Editorial benchmarks can rank vendors. They do not give your team a local,
  repeatable integration test for your own product surface.

`ax-eval` is the operability layer: run the task, check the real state, show the
gap between exposed interfaces and verified agent success.

![Sample ax-eval HTML report](./assets/sample-report.png)

## What It Measures

- **Docs discoverability (static):** crawling the docs *website*, can the docs,
  API shape, and auth model be found by an agent-style crawler? A publisher-facing
  signal, measured independent of any run.
- **Agent discovery (behavioral):** what a real agent *actually did* from a cold
  start to find the product — web search for the API surface, or listing the MCP
  tools / introspecting the SDK for those surfaces. Scored per run, and kept
  distinct from the static docs crawl above.
- **Spec quality:** once found, is the OpenAPI/GraphQL surface clear enough for
  an agent to plan from?
- **Behavioral success:** did the agent create or mutate the real sandbox state
  the task asked for?
- **Robustness:** does the result hold across repeated attempts, or was it a
  lucky pass?
- **Actionable gaps:** recommendations are written as `Target / Evidence / Fix`
  rows. MCP tool coverage failures are grouped by missing capability instead of
  buried in raw trace text; harness/tool-call approval failures are reported
  separately so they are not mistaken for missing product tools.
- **Competitive position:** how does one product or surface compare against
  another when you stack normalized result records into a competitive report?

The open skill runs through the agent you already have open (`host-agent`) and
labels reports with that host/model. The CLI can also drive other agent
harnesses as subprocesses — `exec-plan --invoke --harness claude-code|codex`
runs the same reviewed pack through each (parallel by default) and stamps the
model the harness *actually* reported running, so one report can lay harnesses
and surfaces out side by side as a neutral matrix. A single local run should
still be read as local proof, not a universal score.

For product-owner review, treat a first live matrix as a **directional draft**:
it is enough to start an engineering discussion, but it is not a final benchmark
until the team has sanity-checked attribution and repeated the run with
`--attempts N` for pass@k. Send the HTML together with the raw result, trace,
transcript, stdout/stderr, and `MANIFEST.json` artifacts so owners can inspect
the evidence behind each recommendation.

## Quickstart

Install and run the keyless checks first:

```bash
git clone https://github.com/chenmingtang830/ax-eval.git
cd ax-eval
npm install

npm run ax-eval -- run --offline
npm run ax-eval -- audit --offline
npm test
```

Run a live drop-a-link eval against a sandbox:

```bash
# 1. Draft a task pack from a public spec/docs, then review/freeze it.
npm run ax-eval -- ingest --openapi https://example.com/openapi.json \
  --out results/acme-ingest.json
npm run ax-eval -- generate --from results/acme-ingest.json
npm run ax-eval -- review --pack results/acme.generated.pack.yaml --approve --by you

# 2. Fill only the credentials and sandbox ids this pack declares.
npm run ax-eval -- init --pack results/acme.generated.pack.yaml >> .env
npm run ax-eval -- check-env --pack results/acme.generated.pack.yaml

# 3. Emit host-agent prompts, run them, then verify with read-back oracles.
npm run ax-eval -- exec-plan --pack results/acme.generated.pack.yaml \
  --run-dir results/runs/acme
npm run ax-eval -- verify --pack results/acme.generated.pack.yaml \
  --results results/runs/acme/run-*.json \
  --min-pass-rate 0.8 \
  --html results/runs/acme/eval.html
```

GraphQL targets use the same review and verification gate. Their task ladder and
read-back queries are drafted from rich introspection and must still be reviewed
before use:

```bash
npm run ax-eval -- ingest --graphql https://api.example.com/graphql \
  --out results/acme-graphql-ingest.json
npm run ax-eval -- generate --from results/acme-graphql-ingest.json \
  --product Acme --out results/acme.generated.pack.yaml
```

For CI/offline fixtures, keep the rule-derived path explicit:

```bash
npm run ax-eval -- generate --deterministic --from results/acme-ingest.json \
  --product Acme --out results/acme.generated.pack.yaml
```

The repo ships a few example target packs under `targets/` for REST and GraphQL
products. They demonstrate the pack format; adding another SaaS should usually
be a new pack, not a code change.

## How It Works

![ax-eval architecture](./assets/architecture.svg)

1. **Ingest:** parse OpenAPI into resources/auth hints, or GraphQL into rich
   schema metadata, typed inputs, create-style mutations, and update mutations.
2. **Generate:** draft REST and GraphQL packs with LLM-assisted authoring from
   docs/specs, producing an L1-L4 task ladder, round-trip oracles, and discovery
   requirements.
3. **Review:** require human approval before any generated task, oracle, setup,
   or reset logic can run. The reviewed pack is hash-locked and becomes the
   reproducible benchmark artifact.
4. **Execute:** the host agent performs each task against a sandbox, with
   discovery as Phase 0.
5. **Verify:** the CLI reads live state back through the API and scores the run,
   then writes the HTML report and normalized result record.

## Why It Is Different

- **Goal-level prompts, not endpoint hints.** The agent has to discover the
  surface instead of being handed a curl command.
- **Programmatic oracles, not self-report.** Success means the verifier can read
  the expected state back from the product.
- **Target-declared auth and sandbox scope.** Packs say exactly which env vars and
  sandbox ids are needed; secrets stay local in `.env`.
- **Static and behavioral in one report.** A product can be published and still
  not be usable by agents. The report shows that gap directly.
- **Layered gates, not misleading green.** `--min-pass-rate` reports the overall
  gate and per-surface subgates, so a weak MCP or SDK surface remains visible.
- **Competitive reports from the same records.** Stack normalized results across
  products or surfaces to see where competitors, SDKs, CLIs, APIs, or MCP servers
  are easier for agents to operate.

## Command Map

```bash
npm run ax-eval -- ingest --openapi <url>       # deterministic REST/OpenAPI path
npm run ax-eval -- ingest --graphql <endpoint|file> # rich GraphQL introspection
npm run ax-eval -- generate --from <ingest.json> [--base-url <graphql-endpoint>]
npm run ax-eval -- generate --deterministic --from <ingest.json> # CI/offline fallback
npm run ax-eval -- review --pack <pack.yaml> [--approve --by you]
npm run ax-eval -- init --pack <pack.yaml> [--surface all]
npm run ax-eval -- check-env --pack <pack.yaml> [--surface all]
npm run ax-eval -- exec-plan --pack <pack.yaml> --run-dir <dir>
npm run ax-eval -- exec-plan --pack <pack.yaml> --invoke \
  --harness claude-code --harness codex --surface all --run-dir <dir> # cross-harness × cross-surface (parallel)
npm run ax-eval -- verify --pack <pack.yaml> --results <run.json>... --html <out.html>
npm run ax-eval -- reset --pack <pack.yaml> [--dry-run]

npm run ax-eval -- audit --site <url>
npm run ax-eval -- discover --site <url>
npm run ax-eval -- smells --openapi <url>
npm run ax-eval -- competitive --results <normalized.json>... --html <out.html>
```

CI should validate frozen packs, approvals, deterministic fixtures, tests, and
typecheck. It should not depend on live LLM regeneration; fresh authoring is a
developer workflow that ends at `review --approve`.

## Safety

Live evals make real writes. Use a sandbox, never production. `init` prints the
env stub a pack declares; `.env` is git-ignored. Surfaces authenticate
independently, so an unavailable SDK/CLI/MCP credential becomes a blocked cell in
the report instead of a misleading failure. OAuth-backed MCP surfaces can be run
headlessly when the pack declares client id, client secret, refresh token, and token
URL env names: ax-eval exchanges the refresh token at invoke time, passes the
short-lived bearer only to the child harness environment, and keeps secret values out
of tracked files.

`verify-generated` reads live product state. Do not reset or sweep the sandbox
until after the report is rendered and the user explicitly asks for cleanup.
Cleaning first will make otherwise valid result ids read back as missing and
will corrupt the report.

Generated packs are executable intent. `exec-plan` refuses unreviewed or changed
packs unless you explicitly bypass the review gate.

## Repository Layout

```text
src/                CLI, generation, verification, reporting, static checks
src/ingest/         OpenAPI and GraphQL ingestion
src/generate/       task-pack generation, review, report, normalized records
src/harness/        host-agent profiles, transcripts, traces, probe
src/surface/        API, CLI, SDK, MCP surface prompt adapters
src/target/         pack-declared auth, sandbox scope, reset
targets/            example target packs and approvals
tests/              vitest suite, keyless/offline by default
assets/             README images and report screenshots
docs/               maintainer-local notes, intentionally not public docs
```

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). The best first contribution is a new
target pack generated from a public spec, reviewed with the gate, and backed by a
focused test or oracle improvement.
