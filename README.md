# ax-eval — is your product agent-ready?

**`ax-eval`** — a product exploration plus a runnable TypeScript pipeline: a **drop-a-link** eval that ingests any SaaS's OpenAPI/GraphQL spec, generates a frozen task set, runs it live against the API as the host-agent, and scores it with programmatic oracles. Proven live on Asana (REST) and Monday.com (GraphQL). **Beta — feedback welcome.** See the quickstart below.

## Is your product agent-ready?

**We run real agents against your product's agent surface and tell you where they fail and how to improve.**

Your product's agent surface — API, docs, OpenAPI spec, MCP server, SDKs, CLI — may be technically exposed. That doesn't mean an AI agent can actually use it. We run a real agent against it, give it realistic tasks, and measure whether it completes them end-to-end — with programmatic oracles that check the *real* result, and a report of *where* it failed and *what to fix*.

Not a static audit (does your site have `llms.txt`). Not an editorial benchmark (a third party ranks vendors). Not code-sample CI (does this snippet compile). It's the **integration test for Agent Experience (AX)**: audits lint, benchmarks review — we run the real thing and tell you if it works.

**Current open-skill scope:** this package runs the eval through the agent you
already have open (`host-agent`) and labels reports with that host/model. It is
useful for local proof and pack development; cross-harness scores should be
treated as a separate comparison layer, not implied by a single local run.

## Why now

As agents become the primary operators of software, a SaaS has to win on three layers: get **discovered** (AEO/GEO), **expose** machine-operable surfaces (AX / agent-readiness), and actually **succeed** when an agent tries to use them. That third layer — verification — is empty. Everything shipping today is a static audit or an editorial benchmark. We fill the gap.

Recent academic evidence confirms the gap is real: a 2026 EASE paper (*Making OpenAPI Documentation Agent-Ready*, Lima et al.) found that with original, unrevised OpenAPI docs, ~70% of agent automation tasks failed at the planning stage; with enriched docs, success jumped to 90%. Their conclusion: **structural validity does not imply agent-readiness.** That's the gap we measure — and fix.

## Quickstart

### What you get: one shareable HTML report

A single self-contained HTML file — open it in any browser, hand it to a
teammate. It carries the pass/fail matrix, pass@k robustness, the
static×behavioral **gap**, a prioritized fix list, structural trace checks, and
the per-task API calls the agent actually made. This is the artifact `verify`
produces and the thing worth showing someone:

![Sample AX eval report](./assets/sample-report.png)

### 60-second drop-a-link

The shortest path from "I have an OpenAPI URL" to "I have an HTML report",
running as the **host-agent** (the same agent reading this README — no extra
harness keys needed):

```bash
# Clone, install, generate a pack from any spec
git clone https://github.com/chenmingtang830/ax-eval.git && cd ax-eval && npm install
npm run ax-eval -- ingest --openapi https://example.com/openapi.json \
  --out results/acme-ingest.json
npm run ax-eval -- generate --from results/acme-ingest.json
npm run ax-eval -- review --pack results/acme.generated.pack.yaml --approve --by you

# Tell me what creds + sandbox ids this pack needs (no secrets read or written)
npm run ax-eval -- init  --pack results/acme.generated.pack.yaml >> .env

# Fill in real values in .env, then run as the host sub-agent (3 attempts each)
npm run ax-eval -- exec-plan --pack results/acme.generated.pack.yaml \
  --run-dir results/runs/acme
# → for each prompt-*.txt the CLI prints, run it as a host sub-agent and save the JSON

# Score & gate, write the HTML report
npm run ax-eval -- verify --pack results/acme.generated.pack.yaml \
  --results results/runs/acme/run-*.json \
  --observe ceiling=results/runs/acme/transcript-ceiling.txt \
  --min-pass-rate 0.8 --html results/runs/acme/eval.html
```

That's the full open-skill flow: **ingest → generate → review → init → exec-plan
→ verify**. Detailed walkthrough + every sub-flag is below.

### 5-minute run: a committed non-Asana example (prove it generalizes)

No spec handy? Use a committed, pre-approved **non-Asana** pack to see the
pipeline run end-to-end on something that is clearly not hard-coded. Monday.com
(GraphQL) is proven live — floor and ceiling each scored a perfect round-trip on
its sandbox:

```bash
npm run ax-eval -- review --pack targets/monday/pack.yaml            # read the pre-approved set
npm run ax-eval -- init   --pack targets/monday/pack.yaml >> .env    # what creds/sandbox ids it needs
# fill .env with a Monday sandbox token, then run exec-plan → verify exactly as above
npm run ax-eval -- exec-plan --pack targets/monday/pack.yaml --run-dir results/runs/monday
npm run ax-eval -- verify    --pack targets/monday/pack.yaml \
  --results results/runs/monday/run-*.json --min-pass-rate 0.8 \
  --html results/runs/monday/eval.html
```

`targets/{notion,linear}/pack.yaml` are two more committed non-Asana packs;
adding your own SaaS is a new `ingest` link, not a code change.

### BYOK & cost — read before a live run

**Bring your own keys. Nothing is sent to us; every run is local.** A live run
uses two kinds of credential, both yours:

- **Host-agent inference** — the agent running this skill uses its own model.
  You're already paying for it (it's the agent reading this); the skill adds no
  separate harness keys.
- **Your product's sandbox** — an API key / OAuth / test account so the agent
  can *actually operate* your product. `init` prints exactly what a pack needs;
  fill it in `.env` (git-ignored). Each **surface authenticates independently**:
  the API/SDK/CLI usually share one token, but some MCP servers (Asana, Notion)
  are **OAuth-only**, while others (Monday, Linear) take the same key. A surface
  you can't authenticate is **blocked** (with a "add these keys" prompt), not a
  failed run — the rest still execute, and the blocked surface shows as a distinct
  cell in the report rather than a misleading 0%.

**Spend-cap awareness.** A live run makes real model calls *and* real (sandbox)
API writes. `exec-plan` defaults to **3 attempts × each profile** (pass@k), and
a CI gate repeats that on every push — all on **your** key. To keep cost bounded:

- `--attempts 1` for a one-shot; run `floor` before `ceiling`.
- Keep the task set small, always target a **sandbox, never prod**, and
  `ax-eval reset` between runs so attempts don't contaminate each other.

### Keyless (offline, no API keys)

The skeleton + static audit, for CI/demo:

```bash
npm install
npm run ax-eval -- run --offline       # behavioral matrix + static "gap" (no network)
npm run ax-eval -- audit --offline     # static v0 (conventional-path) audit only
npm run ax-eval -- audit --site https://yoursite.com      # audit any docs/site URL (live)
npm run ax-eval -- discover --site https://yoursite.com   # static v2: crawl the docs graph (live)
npm run ax-eval -- smells --openapi https://yoursite.com/openapi.json  # static v3: content-quality smell audit
npm run ax-eval -- init --pack <pack.yaml>                # print the .env template a pack needs
npm run ax-eval -- init --pack <pack.yaml> --surface all  # + every surface's auth (OAuth slots, surface tokens)
npm run ax-eval -- check-env --pack <pack.yaml> --surface all  # verify api + each surface's auth; show what's blocked
npm test                               # vitest (200 tests, no network)
```

### Drop-a-link: full eval (the core)

Point `ingest` at a target's OpenAPI spec (or GraphQL endpoint) and the pipeline
auto-derives the product, `auth`, `sandbox_scope`, and a frozen **L1–L4** task
set; you run it against the **live** API as the host-agent and score it with
programmatic oracles. Each profile cold-starts: it must *discover* the API
(Phase 0, behavioral AEO) before doing any task. Nothing is Asana-specific — a
new SaaS is a new link, not a code change.

```bash
# 1. Ingest the spec → auth / resources / sandbox scope are derived automatically
npm run ax-eval -- ingest --openapi <spec-url> --out results/acme-ingest.json
#    GraphQL target?  ax-eval ingest --graphql <endpoint|introspection.json>

# 2. Generate a frozen task pack (product/auth/scope inferred; override with --product/--site/--docs)
npm run ax-eval -- generate --from results/acme-ingest.json
#    → results/acme.generated.pack.yaml

# 3. Human review gate — read every task + oracle, then approve (required before any run)
npm run ax-eval -- review --pack results/acme.generated.pack.yaml
npm run ax-eval -- review --pack results/acme.generated.pack.yaml --approve --by <you>

# 4. Fill the creds the pack asks for in .env, then confirm
npm run ax-eval -- check-env --pack results/acme.generated.pack.yaml

# 5. Emit the cold-start prompts, run each as a host sub-agent, then score → HTML report
#    Defaults to 3 attempts per profile; pass --attempts 1 for the old one-shot shape.
npm run ax-eval -- exec-plan --pack results/acme.generated.pack.yaml --run-dir results/runs/acme
#    → run each results/runs/acme/prompt-<profile>-a<N>.txt as a host sub-agent
npm run ax-eval -- verify --pack results/acme.generated.pack.yaml \
    --results results/runs/acme/run-floor-a1.json --results results/runs/acme/run-floor-a2.json \
    --results results/runs/acme/run-floor-a3.json --results results/runs/acme/run-ceiling-a1.json \
    --results results/runs/acme/run-ceiling-a2.json --results results/runs/acme/run-ceiling-a3.json \
    --min-pass-rate 0.8 \
    --html results/runs/acme/eval.html

# Optional: structural trace diff on an attempt's trace file
npm run ax-eval -- trace-diff --pack results/acme.generated.pack.yaml \
    --trace results/runs/acme/run-floor-a1.trace.json

# Between live re-runs, clean the sandbox so pass@k attempts don't contaminate:
npm run ax-eval -- reset --pack results/acme.generated.pack.yaml [--dry-run]
```

**Worked examples.** Asana (REST) and Monday.com (GraphQL) are both proven live —
floor/ceiling each scored a perfect round-trip on Monday's sandbox. Asana ships a
committed, pre-approved generated pack at `targets/asana/generated.pack.yaml`; the
hand-curated `targets/{asana,notion,linear,monday}/pack.yaml` are reference packs.

**Objective discovery (no self-report).** The funnel/trace the agent *writes* is
self-reported. Pass `--observe <profile>=<sub-agent-transcript.jsonl>` to
verify-generated to instead score discovery from the **harness transcript** —
the real tool calls (web searches, the actual API calls, files written) the
platform logged, not the agent's narration. The report labels each profile
`observed` vs `self-report`. (Tool *results* / HTTP statuses aren't in the
transcript, so outcomes stay verified by the live round-trip readback.)

The product measures a target on two layers:

- **Static** — two orthogonal questions. *Can an agent **find** what it needs?*
  (**discoverability**): `audit` (v0) probes conventional paths on `site_url`
  (llms.txt, OpenAPI, MCP, SDK, OAuth); `discover` (v2) **crawls the docs graph**
  like an agent would — follows links from the entry, and only credits a surface
  that's actually *reachable*, recording at which hop. And *once found, is the
  spec usable?* (**content quality**): `smells` (v3) audits the `openapi_url`
  with a deterministic, keyless re-implementation of the Hermes 9-smell taxonomy
  (Lima et al., EASE 2026) — `structural validity ≠ agent-readiness`. Each → a
  0–100 score.
- **Behavioral** — *can an agent **do** the job?* A frozen **L1–L4 ladder**
  auto-generated from the OpenAPI spec, run by two effort **profiles**
  (`floor`/`ceiling`) that each **cold-start with discovery as Phase 0**, scored
  by independent round-trip oracles. Task prompts are goal-level — the endpoint is
  discovered, never injected.

The headline is the **gap**: a high readiness score with low task success means
"exposed ≠ usable". Real keys (Asana PAT + sandbox gids) are only needed for the
live generated pipeline; the keyless path needs none.

**Target-agnostic by design.** The runner has no Asana hard-coding: each pack
*declares* its `auth` (which env var holds the credential + the scheme) and its
`sandbox_scope` (the isolation level the developer must provision — Stripe = a
test account, Asana = workspace + project, GitHub = a repo). `check-env`, the
executor prompt, and the verifier all read those declarations, so a new SaaS is a
new pack, not a code change.

## Architecture

Two eval layers converge into one report. Left = **behavioral** (real tasks ×
harnesses, scored by oracles); right = **static** (agent-readiness / AEO checks);
the bottom merges them into the matrix + the **gap**.

![Architecture & execution flow](./assets/architecture.svg)

## Repository layout

```
src/                runner, CLI, oracles, config, reporting, storage, schemas
  ingest/           OpenAPI → IngestedSpec (CRUD resources, auth, headers) · GraphQL introspection
  generate/         IngestedSpec → frozen pack (L1–L4 + discovery) · verify · discovery scoring · review gate · report
  harness/          execution profiles (floor/ceiling/sonnet/gpt5) + two-phase prompt builder + transcript + probe
  target/           target-agnostic auth + sandbox_scope resolution + sandbox reset (pack-declared env)
  http/  asana/     live HTTP client (bearer / api-key / GraphQL) + Asana gid/url parsing & readback
  adapters/         keyless matrix harnesses (mock / mock-weak / hermes) + registry
  static/           agent-readiness audit — v0 checks + v2 docs-graph crawl (discover) + v3 content-quality smells + fixtures/
targets/            one dir per SaaS: asana · notion · linear · monday (pack.yaml + approvals)
scripts/            Asana sandbox provisioning (setup / clear / seed)
tests/              vitest suite (200 tests, all keyless/offline)
.github/workflows/  CI — typecheck + test on Node 22
docs/               maintainer-local design notes (gitignored; not in the public repo)
```

See `CONTRIBUTING.md` for setup, the test/typecheck commands, and the pack +
review-gate conventions for adding a new target. The fastest way to understand
what's built is the code itself — start at `src/cli.ts` (every command) and the
`tests/` suite (200 keyless/offline tests document expected behavior).

> Detailed design docs (strategy, full spec, build status, file-by-file map)
> are kept **maintainer-local** under `docs/` and are intentionally not part of
> the public repo. This README is the public surface.

## Where we are

- ✅ Positioning + competitive landscape mapped
- ✅ Initial architecture decided — host-agent execution, BYOK, target-agnostic packs
- ✅ First target chosen — **Asana**, picked for high programmatic-oracle coverage; scope settled as static + behavioral + editorial; open-skill shape specced
- ✅ North-star UX + stack decided — **drop-a-link** auto-eval with a mandatory human **review gate** on auto-drafted oracles, tiered oracle generation; language locked to **TypeScript**
- ✅ **Keyless v0 skeleton built (TypeScript)** — `ax-eval run/audit/report` runs end-to-end with no keys: behavioral matrix × mock harnesses, programmatic oracles, the static audit, and the static×behavioral gap.
- ✅ **Generated pipeline built + proven live** — `ingest → generate → exec-plan → verify-generated`: OpenAPI → frozen **L1–L4** standard_set (goal-level, endpoint discovered not injected) → run by `floor`/`ceiling` profiles → independent round-trip oracles → report. Ran against the live Asana sandbox (floor 9/12, ceiling 10/12).
- ✅ **Behavioral AEO = discovery as Phase 0** — each profile cold-starts (product + creds only, no endpoint/docs/spec), web-searches to find the API, then every task builds on what it found; discovery scored per profile. Failures bucket into product/docs vs **plan-limited** (402) vs **discovery-blocked**.
- ✅ **Runs as `host-agent`** — the skill executes in *your own* agent (no extra harness keys). `floor`/`ceiling` differ by **effort only** on the same host model, so the spread is attributable.
- ✅ **Objective discovery capture** — discovery can now be scored from the **harness sub-agent transcript** (real tool calls), not the agent's self-report (`verify-generated --observe`). On the live run it flipped "reached official docs" PASS→FAIL for both profiles: they self-reported reading the docs but objectively only web-searched and went straight to the API.
- ✅ **Static v2 (`discover`)** — agent-style **crawl of the docs graph**: BFS from the entry, surface detectors on every page, credit only what's reachable-by-link (with hop).
- ✅ **Static v3 (`smells`) — content quality** — the orthogonal "once found, is it *usable*?" axis: a keyless, deterministic re-implementation of the Hermes OpenAPI smell taxonomy (Lima et al., EASE 2026 — 4 doc + 5 REST smells) that scores a spec 0–100 on semantic agent-readiness with per-endpoint `[CATEGORY] - <fix>` suggestions. Folded into both the single `verify-generated` report (between Discovery and the scores) and the `competitive` heatmap (a content-quality column).
- ✅ **The gap, in one report** — `verify-generated` now renders static readiness (v0 conventional-path + v2 crawl) next to best behavioral success. This completes **Asana as one full end-to-end target** (the generator's ground truth). On the live run the gap is negative (behavioral 83% > readiness 38) — Asana is more usable than its discoverability surfaces suggest.
- ✅ **Generalization foundation (target-agnostic)** — packs declare `auth` + `sandbox_scope`; a new `src/target/` layer resolves credentials/scope from the env the *pack* names (legacy Asana fallback kept). `check-env`, the executor prompt, and the verifier are all de-Asana'd. Asana is now just the first compliant pack — adding a SaaS is a pack, not a code change.
- ✅ **Review gate built (`review`)** — a human must approve the generated set before `exec-plan` will emit runnable prompts; it refuses an un-reviewed/changed pack (escape: `--skip-review`). Approval is **content-addressed** (sha256 of the reviewable fields → `*.approval.json`), so any edit re-closes the gate (no AI-approves-AI). The summary tiers oracles (T1 round-trip / T2 existence) and shows the credential + sandbox surface the run will touch.
- ✅ **Second target proves generality — Notion** (`targets/notion/pack.yaml`). `ingest`-ing Notion's public OpenAPI worked with **no code change**; the runtime grew two pack-declared knobs it forced: **constant `headers`** (Notion's required `Notion-Version`) and **`field_select_param`** (Asana=`opt_fields`, Notion=unset). The read-back client now **honors `auth.type`** (`bearer` vs `api-key` raw-token), which is exactly what the GraphQL pair (Linear/Monday) will reuse.
- ✅ **Cross-model profiles** — added `sonnet` (claude-4.6-sonnet) + `gpt5` (gpt-5.5) alongside effort-only `floor`/`ceiling`; a mixed run is auto-labeled cross-model. **These profiles only produce real cross-model data when the host can spawn alternative-model sub-agents (e.g. Cursor Composer's `Task` tool).** A plain CLI host (Claude Code, Codex) is locked to its own model and should stick to `floor`/`ceiling`.
- ✅ **GraphQL adapter** — packs declare `api_style: graphql`; the read-back client POSTs hand-authored read queries to a single endpoint (reusing `api-key` raw-token auth), and `ingest --graphql` introspects a schema for coverage/provenance. Two GraphQL targets ship and pass the review gate: **Linear** (`targets/linear/pack.yaml`) and **Monday.com** (`targets/monday/pack.yaml`).
- ✅ **HTML report** — `verify-generated` now emits a self-contained, design-system-styled HTML report (Linear structure × Mercury warmth, `keep / watch / monitor / fix_now` status family) with a built-in recommendations engine; `--md` is kept as an alias.
- ✅ **Harness probe (`probe`)** — self-detects the host harness/model from env signals (Cursor / Claude Code / Codex / CI / unknown fallback; records env-var **key names only**, never secret values), stamps run **provenance** (host, model, node/platform, timestamp) into the report, and **suggests a matching profile** (Claude Code → `sonnet`, Codex → `gpt5`, else host-default floor/ceiling). `ax-eval probe [--out json]`.
- ✅ **Drop-a-link is real (generic `generate`)** — `generate` derives `product`, `auth`, `sandbox_scope`, and `headers` straight from the ingested spec (override with `--product`/`--site`/`--docs`); the Asana-specific tuning is now an opt-in preset applied only when the product is Asana. Pointing the pipeline at a new spec is a link, not a code edit. Validated end-to-end on a fresh **Stripe** OpenAPI (ingest → generate → review).
- ✅ **Second live target — Monday.com (GraphQL)** — ran the full generated pipeline against a real Monday sandbox with live tokens: floor and ceiling each scored a perfect round-trip, and the run caught a genuine doc-vs-live discrepancy (archived-item behavior). Proves the target-agnostic path live, not just on paper.
- ✅ **Multi-surface live runs (SDK + MCP)** — drove the same task bank through Asana's official **SDK** (PAT) and Monday's **MCP** server (local stdio, API-key) end-to-end, then rendered both in one heatmap-coded competitive report. Surfaced a real capability gap (Monday's default MCP toolset has no `archive_item`).
- ✅ **Per-surface auth (declarative + lazily gated)** — packs declare how each surface authenticates (`surfaces.<s>.auth`: `inherit` the API token / its own `token` / `oauth_app`). Auth is gated **per surface at run time**, not as a global precondition: a surface you can't authenticate (Asana/Notion MCP are OAuth-only) becomes a **blocked cube cell** (`requires-oauth` / `missing-credential`) with an "add these keys to `.env`" prompt — never a misleading 0%. `check-env`/`init --surface all` report and stub each surface's auth; the competitive report renders blocked cells as a distinct pill.
- ✅ **Sandbox reset (`reset`)** — `ax-eval reset --pack <pack>` deletes everything a run created (honoring the pack's `auth`/scope), with `--dry-run`, so pass@k re-runs don't contaminate each other.
- ✅ **Ingest pairing fix** — create/read endpoint pairing no longer collapses when several collections share a name or expose multiple `GET-by-id` routes (a real Stripe mispairing); it now keeps all candidate reads and picks the best per create path.
- ✅ **Attribution fix** — failure attribution blocks only on `canonical` (did the agent reach + use the right endpoint), not on `official` (did it open a docs page), so objective scoring no longer over-fires `discovery-blocked`.
- ✅ **Launch hygiene** — `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, GitHub Actions CI (typecheck + 200 tests on Node 22), packaging metadata, and a secret scrub (live tokens are `.env`-only and git-ignored). Beta-ready for a drop-a-link run by a fresh clone.
- ✅ **Drop-a-link UX polish** — `ax-eval init --pack <yaml>` prints a copy-paste `.env` stub for any pack (no secrets read or written); `verify` captures runtime warnings (missing trace files, unreadable transcripts, static-readiness failures) and surfaces them verbatim in the report's Methodology section so caveats are visible.
- ⬜ Open: community-pack review/signing conventions for safely sharing target packs.
- ⬜ Out of scope: network-proxy capture of raw HTTP statuses.

## How to contribute

The repo has a runnable keyless skeleton and the live
drop-a-link pipeline. See **[`CONTRIBUTING.md`](./CONTRIBUTING.md)** for setup + conventions.

- To run the code: see the quickstart above (keyless offline, or the live drop-a-link pipeline).
- **Add a target:** `ingest` its spec → `generate` → curate/approve a pack via the review gate. A new SaaS is a new pack, not a code change — that's the abstraction to stress-test. Best next contribution: a fresh non-Asana spec run end-to-end.
- Contributions are best aimed at the drop-a-link pipeline, target packs, and oracles.

## TL;DR for a newcomer

Agents are becoming the main users of APIs and docs. Nobody can tell a SaaS team whether agents actually *succeed* against their product. This open **skill** runs in *your* agent (no extra harness keys), drives real tasks against your live API with programmatic oracles, and shows the static×behavioral gap — where agents fail and what to fix.
