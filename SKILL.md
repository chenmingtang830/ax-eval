---
name: ax-eval
description: Test whether AI agents can use your product — drop in an OpenAPI or GraphQL spec to generate a reviewed L1–L4 task ladder, run it across API/CLI/SDK/MCP surfaces at low/high effort, and verify with programmatic outcome verification.
---

# ax-eval — host-agent skill

You are the **agent harness**. The eval is a reviewed, frozen `TargetPack`;
you run it against the **live** product surface and the CLI verifies success via
**programmatic outcome verification** (API readback), not self-report.

Two things make this real:
- **Discovery is Phase 0.** You are NOT told the endpoint, base URL, request
  shape, or docs link. You must web-search to discover the API first, then do
  every task with what you found. Record your search funnel honestly — it's
  scored.
- **Effort profiles.** You run the set twice at two effort levels: `low` and
  `high`. Same model, same budget — only effort differs, so the spread is
  attributable.

## Prerequisites

Pick a target. The repo ships example packs under `targets/examples/`, or you can
generate one for any SaaS via `ingest → generate → review` (see workflow below).
Then:

```bash
npm install
npm run ax-eval -- init      --pack <pack.yaml>   # print the .env stub the pack needs
# Fill in .env with the credentials + sandbox ids the stub asks for, then:
npm run ax-eval -- check-env --pack <pack.yaml>   # verify env is set
# Testing non-API surfaces too? Add --surface all to see/stub each surface's auth:
npm run ax-eval -- init      --pack <pack.yaml> --surface all
npm run ax-eval -- check-env --pack <pack.yaml> --surface all
```

When you are working from a cloned ax-eval repository, use
`npm run ax-eval -- <command>` for every command in this skill. That runs the
local checkout, including unpublished changes. A globally installed `ax-eval`
binary is fine for released workflows, but it will not see local source edits
until the package is rebuilt and linked/installed.

Each pack declares its own `auth` (which env var holds the credential) and
`sandbox_scope` (the isolation level — workspace, project, board, etc. — that
the developer must provision). `init` and `check-env` read the declarations
verbatim, so you never need to know a target's specifics in advance.

**Per-surface auth.** Each surface (api/cli/sdk/mcp) authenticates independently,
declared in `surfaces.<s>.auth`: `inherit` (reuse the API token — SDKs/CLIs),
`token` (its own key — Monday/Linear MCP), or `oauth_app` (registered OAuth app +
refresh token — hosted MCP surfaces such as Asana). You don't pre-configure everything:
gating is **lazy and per-surface**. When `exec-plan --surface all` hits a surface it
can't authenticate, it skips the prompt, writes a **blocked cube cell**
(`run-<surface>-blocked.normalized.json`, `blocked: requires-oauth | missing-credential`),
and prints the exact env keys to add. When the OAuth env vars are present and the harness
supports provisioning, ax-eval exchanges the refresh token at invoke time and passes a
short-lived bearer token through an isolated harness config/env.
The api surface (and any token surface you have creds for) still runs; the blocked
surface shows as a distinct cell in the competitive report, never a 0%. To unblock,
add the keys it names to `.env` (`init --surface all` stubs them) and re-run.

For stdio MCP, declare `server` as a single executable name and `args` as a YAML
argv array. Do not put a shell command in `server`; the harness provisions the
executable and arguments directly for both Codex and Claude Code. Stdio supports
`inherit` or `token` auth, while OAuth refresh exchange is for hosted HTTP MCP.

## Workflow

### Suite-first canonical benchmark path

DAEB-1 is different from ordinary per-target authoring. It starts from one
frozen canonical suite, then compiles vendor adapters from public vendor cards
and vendor-specific verification extracts:

```text
evaluation suite -> vendor verification extraction -> TargetPack -> execution -> verification -> normalized records -> leaderboard
```

Use `resolve-vendor`, `extract-capabilities`, `extract-surfaces`,
`synthesize-suite`, `extract-tasks`, and `compose-pack` in that order. The
commands write reviewable artifacts; they do not approve or execute them.
Pass repeatable `--capability-spec <slug>=<source>` entries when a reviewed
OpenAPI source should seed a vendor. Explicit sources fail rather than falling
back to an unrelated fixture; unmapped vendors retain grounded extraction.
Use local spec files offline and raise the operation bound if summarization
would truncate. Capability extraction caps concurrency at three and gives each
vendor's generator call a bounded 12-minute timeout. Remote spec URLs are
validated before fetching; redirects must stay on official public hosts, DNS
must resolve publicly, and source bodies are limited to 5 MB.
Registry surface candidates are hints only: pass them through grounded
`extract-surfaces`, verify every command/package/auth claim against official
docs, and preserve the registry seed provenance and content hash in the
resulting extract.
Keep reviewed seed artifacts under `targets/seeds/<vendor>/registry.yaml`; do
not hand-edit them into a shape that bypasses the validated loader.
Create them keylessly with `map-registry-seed --from <local.json|yaml> --vendor
<slug>`, review the result, then pass its path explicitly with `--surface-seed`.

The canonical suite is the source of truth. Files under
`targets/packs/<vendor>/` are compiled execution artifacts, not
separate benchmark definitions. They keep the same task ids, titles, intents,
difficulty labels, scoring contract, surfaces, and harness matrix; only auth,
base URL, outcome-verifier checks, explicit N/A reasons, and surface configuration vary
by vendor, with official support evidence preserved in the reviewed pack.
The reviewed concept universe also owns each task's kebab-case `skill`; carry it
through coverage selection and suite synthesis. Do not add a family taxonomy to
capability, concept, selection, or methodology artifacts; review concept
diversity directly from the evidence-backed universe and selection ledger.

Always run `review` and require a current approval before `exec-plan`;
`compose-pack` never creates an approval automatically.

Before review, run the keyless benchmark authoring audit from the repository
root and provide each core vendor's compose config explicitly:

```bash
npm run ax-eval -- audit-benchmark --benchmark <benchmark> \
  --benchmark-version <version> \
  --pack-config <vendor>=path/to/<vendor>.compose.yaml
```

Repeat `--pack-config` for every core vendor. Add `--reset-verified <vendor>`
only after an external sandbox reset check has actually completed; the audit
records that evidence but never performs cleanup. A nonzero exit means the
suite, fixed-sample trace review, cohort extracts, or compiled packs are not
ready for review. A completed `suite.trace-review.yaml` must record the
reviewer, review timestamp, commit SHA, and every unique trace ID in the fixed
sample. The command is read-only: it does not autofix artifacts, approve packs,
invoke harnesses, verify live state, or reset targets.

If discovery scoring is in scope, put an explicit `discovery` block in each
vendor compose config. Treat the canonical action and official domains as
reviewed inputs: `compose-pack` preserves them verbatim and the authoring audit
flags drift. Do not infer a write endpoint from a read-back oracle or a quoted
documentation snippet.

REST canonical actions may name a resource root. Discovery scoring accepts an
exact method/path or a child path separated by `/`; lookalike prefixes such as
`/v10` for canonical `/v1` remain failures.

For access-control tasks, require an independent error-outcome oracle rather
than trusting the agent to report that denial occurred. HTTP checks declare
`assertOutcome: error` plus explicit `expectedHttpStatuses`; SQL checks assert a
non-secret driver field such as `code` under a verifier-controlled
`sqlRoleTemplate` when role isolation is required. Unexpected success must
remain failure, and SQL setup/role errors must not count as query denial.

Capability extraction accepts either the requested `{ "capabilities": [...] }`
envelope or a bare top-level array. This is shape normalization only; malformed
items and non-official evidence must still fail validation.
When a reviewed OpenAPI summary seeds extraction, treat its operations as the
API candidate set and preserve its source/count/truncation provenance. Reject
empty or truncated summaries rather than authoring against partial coverage.

Before any benchmark low-pass execution, inspect the keyless plan:

```bash
npm run ax-eval -- plan-low-pass --pack targets/packs/<vendor>/<suite>.yaml \
  --suite targets/suites/<suite>.yaml --surface all \
  --harness codex --harness claude-code
```

This command only validates and prints the task-level low-profile plan. It does
not invoke agents, make writes, verify results, or reset the target.

In the completed stack, the bundle manifest is the handoff to the AXArena
static website and the launch report. Missing snapshot/normalized artifacts
are blockers for a final publication, but acceptable in a draft bundle while
the vendor run is still in progress. Every present file must have its lowercase
SHA-256 recorded in publication manifest v2. Materialization verifies the copied
bytes before the staging directory is renamed into the final bundle.

### 1. Generate the frozen task set (or use a committed example)

Already have an example pack at `targets/examples/<name>/pack.yaml`? Skip to step 2. To
build one for a new target:

```bash
npm run ax-eval -- ingest   --openapi <spec-url>            # or --graphql <endpoint>
npm run ax-eval -- generate --from results/<name>-ingest.json
#    → writes results/<name>.generated.pack.yaml (auto-derives product, auth, sandbox scope)
```

Default generation is LLM-assisted: ax-eval builds a rule-derived seed from the
spec, then asks a local generator harness (`codex` or `claude-code`) to improve
it. Product presets can add authoring hints and surface-shaping rules, but code
still validates the generated pack and will trigger one repair pass before
giving up. Pass `--deterministic` for keyless/offline fixtures. Either way, the
output is only a draft until the review gate approves it.

Generation is surface-aware at task-selection time too: if a declared CLI/SDK/MCP
surface only covers part of the product, ax-eval narrows that surface to the
tasks it can actually support instead of assuming it mirrors the full API.

For an automated report pass, use:

```bash
npm run ax-eval -- automate-report --company <name> \
  --openapi <spec-url> \
  --surface all --harness codex
```

`automate-report` never uses Exa. It prefers explicit official `--openapi`,
`--graphql`, `--site`, or `--docs` inputs; if only a company name is provided it
asks the configured local harness to find official candidates, then validates
them with direct fetch/crawl before ingesting anything. It always runs an API
low-effort smoke gate before the fuller requested report, but generated packs
still stop at the review gate until a human approves them with `ax-eval review`.

This produces an **L1–L4 ladder** (L1 single create · L2 composed chain · L3
ambiguous goal-level comprehension · L4 state mutation) with goal-level prompts
(no endpoints) + a discovery spec. Drop-a-link: a new SaaS is a new pack, not
a code change.

### 2. Review gate — a human approves the generated set (required)

```bash
npm run ax-eval -- review --pack <pack.yaml>            # read the set
npm run ax-eval -- review --pack <pack.yaml> --approve --by <name>
```

Generated tasks/outcome verifiers are executable intent that will run write-ops against
a sandbox, so **nothing runs un-reviewed**. The summary lists every task +
prompt + outcome verifier (flagged by confidence tier: T1 round-trip = strong, T2
existence/2xx = weak) and the credential/sandbox surface it will touch.
Approval is **content-addressed** — it records a hash of the reviewable
fields, including headers and API/CLI/SDK/MCP execution configuration, so any
later edit re-closes the gate and forces re-approval (no AI-approves-AI). The
committed example packs ship pre-approved (`*.approval.json`);
`exec-plan` refuses an un-reviewed/changed pack unless you pass `--skip-review`.

### 3. Emit one prompt per profile

```bash
npm run ax-eval -- exec-plan --pack <pack.yaml> --run-dir results/runs/<id>
```

Writes `results/runs/<id>/prompt-<profile>-a<N>.txt` for each profile and
attempt (default 1 attempt per profile; `--attempts N` for pass@k), each a two-phase prompt (Phase 0
discovery → Phase 1 tasks) with a unique namespace per attempt.

### 4. Run each prompt (as the host agent / sub-agents)

For each profile prompt, follow it **exactly**:
- **Phase 0:** actually web-search the target's official docs; find the base
  URL, auth scheme, request/response envelope, and how to create resources.
  Record every search query and URL you open.
- **Phase 1:** perform each task against the live sandbox using only what
  you discovered. Create resources with the **exact** namespaced names given.
- Write `run-<profile>-a<N>.json` (discovery funnel + per-task ids) and
  `run-<profile>-a<N>.trace.json` (every API call) to the paths in the
  prompt. Edit no other files.

Honor the effort profile: `low` does the minimum and gives up fast;
`high` investigates prerequisites, recovers from errors, and verifies
read-backs.

Between repeated attempts on the same profile, run
`ax-eval reset --pack <pack> --ns <completed-run-namespace>`
only when the user explicitly asks you to prepare the next attempt. Do not clean
up by default: `verify` reads live product state, so deleting resources before
the report is rendered corrupts scores.

### 5. Verify + report

```bash
npm run ax-eval -- verify-generated --pack <pack.yaml> \
  --results results/runs/<id>/run-*.json \
  --min-pass-rate 0.8 \
  --html results/runs/<id>/generated-eval.html
```

The CLI GETs every resource back, scores outcome verifiers + each profile's
discovery funnel, gates on `--min-pass-rate`, and writes a self-contained HTML
report. Then summarize for the user:
- Static discovery score (docs-site crawl) and agent discovery score
  (usability-suite Phase 0) as separate signals.
- Pass rate by config/profile, difficulty (L1–L4), and pass@k across attempts.
- If `--min-pass-rate` was used, call out both the overall gate and any
  per-surface subgate failures.
- **Discovery scorecard** per config/profile (reached source / canonical action /
  hops / misled / auth), using surface-relative wording for API vs MCP/SDK/CLI.
- Top recommendations, especially any MCP tool coverage gaps, as
  Target / Evidence / Fix rather than a raw failure dump.
- Keep MCP tool coverage separate from harness/approval failures: missing
  project-brief/archive/portfolio capabilities are product/tool gaps, while
  `user cancelled MCP tool call` on an existing update tool is a harness
  interaction signal.
- **Attribution:** separate genuine product/docs gaps from **plan-limited**
  (402, free tier) and **discovery-blocked** failures. The headline gap is
  high static discovery with low usability-suite success, and only applies directly
  on surfaces where the docs site is the agent's discovery path.
- Label a first live matrix as a **directional draft**, not a final benchmark,
  unless it has repeated attempts (`--attempts N`) and the product owner has
  sanity-checked attribution. Share the HTML together with result JSON, trace,
  transcript/stdout/stderr, and a manifest/artifact bundle.

### Cross-harness / cross-surface (optional, CLI-driven)

The steps above make *you* the harness. To compare harnesses instead, let the
CLI drive them as subprocesses: run one lane per harness so each receives a
compatible model slug, for example `exec-plan --invoke --harness claude-code
--surface all --profile low --profile high --model sonnet --invoke-retries 0`,
then a separate Codex lane with `--harness codex --model <gpt-model>
--invoke-retries 0`. The CLI stamps the model each harness actually reported,
applies native effort where available, and writes one normalized `{surface,
product, harness}` record per cell. `verify` then renders them as a single
**neutral matrix** (surface · harness · effort) — no cell is crowned "best".
Codex needs its sandbox network opened and an OpenAI-strict output schema; the
adapter handles both.

Both harness adapters parse agent-authored result JSON fail-closed. The only
recovery allowed is removal of invalid shell-style `\'` escapes copied from
commands; bare inner quotes and other malformed JSON produce a
`results_json_invalid` invoke status instead of being repaired or scored.

For publication-grade lanes, prefer native binaries through `AX_EVAL_CLAUDE_BIN`
and `AX_EVAL_CODEX_BIN` when PATH wrappers inject corporate/local defaults. API,
CLI, and SDK Codex cells are invoked with an isolated Codex home plus
`mcp_servers={}` so unrelated global MCP auth failures do not become benchmark
failures. MCP cells still receive their explicit pack-declared MCP provisioning.
This is one product across harnesses/surfaces — `competitive` is reserved for
cross-*product* comparison.

When consolidating a report for review, put every cell's artifacts in one run
directory before rendering the HTML. Keep result JSON, trace JSON, transcript,
stdout/stderr, invoke metadata, and a small manifest together so reviewers can
deep-dive without hunting through prior scratch runs.

### Planned DAEB-1 production lane

The completed DAEB-1/database v1 stack has a dedicated production rerun command
for the benchmark-of-record matrix. That command is not implemented in this
revision.

This lane is intentionally scoped to `api` and `cli`, Codex and Claude Code,
`medium` effort, and three trials per supported vendor/surface/harness cell.
It writes `trial-1/2/3` directories plus an `aggregate/` directory whose
normalized record reports the three-trial mean and range. SDK and MCP should
not be mixed into the DAEB-1 v1 leaderboard denominator; keep those runs as
research evidence unless a later suite revision says otherwise.

The completed stack also freezes a publication bundle and exports website data.
This keeps the repo boundary clean: `ax-eval` owns suite compilation, execution,
verification, aggregation, redaction, bundles, and public JSON exports;
`axarena` owns the curated website, leaderboard presentation, result
interpretation, and paper-style appendix.

## Rules

- Only mutate the **sandbox** scope the pack declares. Never touch production
  data.
- Discovery is real: web-search, don't paste a known endpoint from memory.
  Never inject an endpoint the prompt didn't give you.
- Never run an un-reviewed pack: get human `review --approve` first (or
  `--skip-review` only for a committed/trusted pack). A changed pack must be
  re-approved.
- Do not skip `verify` — success requires verifier PASS against live state.
- Database verifier credentials stay in pack-declared environment variables.
  Never ask an executor to report a token or connection string in result JSON.
- Report `harness: host-agent` and the host model; label the low↔high spread as an
  **effort** spread (same model), not a cross-model score. The `sonnet`/`gpt5`
  cross-model profiles only produce real cross-model data in Cursor Composer
  (where the `Task` tool spawns alternative-model sub-agents); a plain CLI host
  should stick to `low`/`high` (or pin a model per run with `--model`).

## References

- Example packs: `targets/examples/*/pack.yaml`
- Every command + flag: `src/cli.ts`
- Expected behavior, documented: the `tests/` suite (keyless/offline)
- Report rendering: `src/generate/report.ts`
