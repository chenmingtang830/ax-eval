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

## Workflow

### AXArena / DAEB-1 canonical benchmark path

DAEB-1 is different from ordinary per-target authoring. It starts from one
frozen canonical suite, then compiles vendor adapters from public vendor cards
and vendor-specific verification extracts:

```text
evaluation suite -> vendor verification extraction -> TargetPack -> execution -> verification -> normalized records -> leaderboard
```

Use `targets/suites/daeb-1-v3.yaml` as the source of truth. The files under
`targets/packs/<vendor>/daeb-1-v3.yaml` are compiled execution artifacts, not
separate benchmark definitions. They should keep the same task ids, titles,
intents, difficulty labels, scoring contract, surfaces, and harness matrix;
only auth, base URL, outcome-verifier checks, N/A mapping, and surface configuration vary
by vendor.

Once all vendor runs have been verified, freeze the publication bundle:

```bash
npm run ax-eval -- publication-bundle \
  --suite targets/suites/daeb-1-v3.yaml \
  --vendors supabase,neon,mongodb-atlas,turso,convex,insforge,cockroachdb \
  --run-dir results/runs/daeb-1-v3 \
  --out results/publications/daeb-1-v3
```

The bundle manifest is the handoff to the AXArena static website and the launch
report. Treat missing snapshot/normalized artifacts as blockers for a final
publication, but acceptable in a draft bundle while the 8-vendor run is still
in progress.

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
it. Pass `--deterministic` for keyless/offline fixtures. Either way, the output
is only a draft until the review gate approves it.

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
fields, so any later edit re-closes the gate and forces re-approval (no
AI-approves-AI). The committed example packs ship pre-approved (`*.approval.json`);
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

Between repeated attempts on the same profile, run `ax-eval reset --pack <pack>`
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

### DAEB-1 production lane

DAEB-1/database v1 has a dedicated production rerun command for the
benchmark-of-record matrix:

```bash
ax-eval daeb-production-rerun \
  --suite targets/suites/daeb-1-v3.yaml \
  --codex-model gpt-5.4 \
  --claude-model sonnet
```

This lane is intentionally scoped to `api` and `cli`, Codex and Claude Code,
`medium` effort, and three trials per supported vendor/surface/harness cell.
It writes `trial-1/2/3` directories plus an `aggregate/` directory whose
normalized record reports the three-trial mean and range. SDK and MCP should
not be mixed into the DAEB-1 v1 leaderboard denominator; keep those runs as
research evidence unless a later suite revision says otherwise.

After freezing a publication bundle, export website data with:

```bash
ax-eval export-publication \
  --from results/runs/daeb-1-v4-production/publication-bundle-final \
  --out results/runs/daeb-1-v4-production/axarena-export
```

This keeps the repo boundary clean: `ax-eval` owns suite compilation,
execution, verification, aggregation, redaction, bundles, and public JSON
exports; `axarena` owns the curated website, leaderboard presentation, result
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
