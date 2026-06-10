---
name: ax-eval
description: Run ax-eval against any SaaS to check whether it is agent-ready — drop in its OpenAPI or GraphQL spec to auto-generate an L1–L4 task ladder, cold-start discover the API (behavioral AEO), execute against the live API at low/high effort, and verify with programmatic round-trip oracles (host-agent harness).
---

# AX eval — host-agent skill

You are the **harness**. The eval is a frozen, auto-generated `standard_set`
(per-target pack); you run it against the **live** API and the CLI verifies
success via **programmatic oracles** (API readback), not self-report.

Two things make this real:
- **Discovery is Phase 0.** You are NOT told the endpoint, base URL, request
  shape, or docs link. You must web-search to discover the API first, then do
  every task with what you found. Record your search funnel honestly — it's
  scored.
- **Effort profiles.** You run the set twice at two effort levels: `low` and
  `high`. Same model, same budget — only effort differs, so the spread is
  attributable. (The old names `floor`/`ceiling` still work as aliases.)

## Prerequisites

Pick a target. The repo ships example packs at `targets/{asana,notion,linear,monday}/pack.yaml`,
or generate one for any new SaaS via `ingest → generate → review` (see workflow
below). Then:

```bash
npm install
npm run ax-eval -- init      --pack <pack.yaml>   # print the .env stub the pack needs
# Fill in .env with the credentials + sandbox ids the stub asks for, then:
npm run ax-eval -- check-env --pack <pack.yaml>   # verify env is set
# Testing non-API surfaces too? Add --surface all to see/stub each surface's auth:
npm run ax-eval -- init      --pack <pack.yaml> --surface all
npm run ax-eval -- check-env --pack <pack.yaml> --surface all
```

Each pack declares its own `auth` (which env var holds the credential) and
`sandbox_scope` (the isolation level — workspace, project, board, etc. — that
the developer must provision). `init` and `check-env` read the declarations
verbatim, so you never need to know a target's specifics in advance.

**Per-surface auth.** Each surface (api/cli/sdk/mcp) authenticates independently,
declared in `surfaces.<s>.auth`: `inherit` (reuse the API token — SDKs/CLIs),
`token` (its own key — Monday/Linear MCP), or `oauth_app` (OAuth-only, no headless
token — Asana/Notion MCP). You don't pre-configure everything: gating is **lazy and
per-surface**. When `exec-plan --surface all` hits a surface it can't authenticate,
it skips the prompt, writes a **blocked cube cell** (`run-<surface>-blocked.normalized.json`,
`blocked: requires-oauth | missing-credential`), and prints the exact env keys to add.
The api surface (and any token surface you have creds for) still runs; the blocked
surface shows as a distinct cell in the competitive report, never a 0%. To unblock,
add the keys it names to `.env` (`init --surface all` stubs them) and re-run.

## Workflow

### 1. Generate the frozen task set (or use a committed example)

Already have an example pack at `targets/<name>/pack.yaml`? Skip to step 2. To
build one for a new target:

```bash
npm run ax-eval -- ingest   --openapi <spec-url>            # or --graphql <endpoint>
npm run ax-eval -- generate --from results/<name>-ingest.json
#    → writes results/<name>.generated.pack.yaml (auto-derives product, auth, sandbox scope)
```

This produces an **L1–L4 ladder** (L1 single create · L2 composed chain · L3
ambiguous goal-level comprehension · L4 state mutation) with goal-level prompts
(no endpoints) + a discovery spec. Drop-a-link: a new SaaS is a new pack, not
a code change.

### 2. Review gate — a human approves the generated set (required)

```bash
npm run ax-eval -- review --pack <pack.yaml>            # read the set
npm run ax-eval -- review --pack <pack.yaml> --approve --by <name>
```

Generated tasks/oracles are executable intent that will run write-ops against
a sandbox, so **nothing runs un-reviewed**. The summary lists every task +
prompt + oracle (flagged by confidence tier: T1 round-trip = strong, T2
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

Between attempts on the same profile, run `ax-eval reset --pack <pack>` to
clean the sandbox so pass@k attempts don't contaminate each other.

### 5. Verify + report

```bash
npm run ax-eval -- verify --pack <pack.yaml> \
  --results results/runs/<id>/run-*.json \
  --min-pass-rate 0.8 \
  --html results/runs/<id>/generated-eval.html
```

The CLI GETs every resource back, scores round-trip oracles + each profile's
discovery funnel, gates on `--min-pass-rate`, and writes a self-contained HTML
report. Then summarize for the user:
- Static discovery score (docs-site crawl) and agent discovery score
  (behavioral Phase 0) as separate signals.
- Pass rate by config/profile, difficulty (L1–L4), and pass@k across attempts.
- If `--min-pass-rate` was used, call out both the overall gate and any
  per-surface subgate failures.
- **Discovery scorecard** per config/profile (reached source / canonical action /
  hops / misled / auth), using surface-relative wording for API vs MCP/SDK/CLI.
- Top recommendations, especially any MCP tool coverage gaps, as
  Target / Evidence / Fix rather than a raw failure dump.
- **Attribution:** separate genuine product/docs gaps from **plan-limited**
  (402, free tier) and **discovery-blocked** failures. The headline gap is
  high static discovery with low behavioral success, and only applies directly
  on surfaces where the docs site is the agent's discovery path.

## Rules

- Only mutate the **sandbox** scope the pack declares. Never touch production
  data.
- Discovery is real: web-search, don't paste a known endpoint from memory.
  Never inject an endpoint the prompt didn't give you.
- Never run an un-reviewed pack: get human `review --approve` first (or
  `--skip-review` only for a committed/trusted pack). A changed pack must be
  re-approved.
- Do not skip `verify` — success requires oracle PASS against live state.
- Report `harness: host-agent` and the host model; label the low↔high spread as an
  **effort** spread (same model), not a cross-model score. The `sonnet`/`gpt5`
  cross-model profiles only produce real cross-model data in Cursor Composer
  (where the `Task` tool spawns alternative-model sub-agents); a plain CLI host
  should stick to `low`/`high` (or pin a model per run with `--model`).

## References

- Example packs: `targets/{asana,notion,linear,monday}/pack.yaml`
- Every command + flag: `src/cli.ts`
- Expected behavior, documented: the `tests/` suite (keyless/offline)
- Report rendering: `src/generate/report.ts`
