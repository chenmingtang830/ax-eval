# AXArena: Strategic Plan & Launch Spec

> **Status:** Draft v1 · Branch: `axarena-branch` · Internal strategy doc
>
> **Build progress:** DAEB-1 V3 pre-execution artifacts are complete for the active 7-vendor set (`supabase`, `neon`, `mongodb-atlas`, `turso`, `convex`, `insforge`, `cockroachdb`): suite artifacts, methodology artifacts, verification extracts, composed packs, env gates, and content-hash approvals. DAEB-1/database is the flagship vertical benchmark, not proof that the engine is fully generic across every future category. Execution has started with Codex smoke runs: Supabase API low `9/9`, API high `7/9`, CLI low `6/7`; Supabase SDK is now excluded from DAEB-1 V3 scoring (`0` eligible SDK tasks) because Supabase JS cannot create the required SQL/schema/control-plane objects from a blank sandbox without a pre-existing SQL RPC/baseline setup path; Neon API low improved from `0/10` to `10/10` after adding existing sandbox project/branch context to the Neon pack; Neon SDK low is now scored over `8` eligible SQL/DDL tasks after excluding backup/CDC from SDK support, and post-audit smoke moved from `7/8` to a native Codex full-slice low result of `8/8`; native Codex Neon API low passed `10/10`; native Codex Neon CLI exposed role-disambiguation issues in the full slice (`5/10` best), then recovered to role-contract low/high smoke of `18/20` after adding a Neon CLI role/database contract; CockroachDB SDK low recovered from SQL identifier failures to `10/10`, and CockroachDB CLI low/high now verifies `19/20`; MongoDB Atlas API low improved from `0/9` to `7/8`, and MongoDB Atlas SDK low currently smokes at `5/7` after surface-aware SDK support filtering; Turso API low improved from `0/10` to `8/10` after tightening endpoint/context env handling and fixing the trigger-result verifier for server-side execution; Convex API low improved from `0/8` to `8/8` after isolating Convex-safe identifier guidance plus Convex function verifier auth/base-url/query/action contracts; Insforge API low is currently `0/9` after two smoke runs because the agent discovered the docs/admin endpoints but still chose migration/raw-SQL paths rejected by Insforge's security parser. Generic Codex harness/tooling bugs fixed during execution: non-MCP API/CLI/SDK cells now use an isolated Codex home plus `mcp_servers={}`, persisted artifacts redact line-wrapped Neon CLI API-key defaults, and normalized cell grouping/provenance now tolerate agent-authored result files that omit harness/model metadata. Claude Code headless execution is now unblocked: native Claude Code `2.1.198` exposes `--model` and `--effort`; a pinned native low lane with `--model sonnet` stamped `claude-sonnet-5` and passed Neon API `9/10`, failing only vector-search label exactness; the paired pinned high lane timed out after two 900s attempts and verified `0/10`, which is an execution/runtime lesson rather than a verifier change. The current work is execution hardening and matrix expansion, not publication finalization.
>
> This document captures the full strategic reasoning, competitive analysis,
> positioning, methodology, vendor selection, code-feasibility assessment,
> and launch plan for AXArena — the independent Agent Experience benchmark.
>
> It is the single source of truth before launch. Edit in place.

---

## 0. TL;DR

We are pivoting `ax-eval` from "yet another AX tool" into **AXArena — the
independent AX benchmark**, modeled on LMArena's path: lead with an
authoritative leaderboard, build editorial trust, monetize later via B2B.

- **Positioning:** *"The independent AX benchmark. Vendor-neutral by design."*
- **Methodology wedge:** Read-back oracle vs. LLM-as-judge (used by both
  AXIS and `app.promptingco.com/benchmark`).
- **First launch:** *Database AX Benchmark V1 (DAEB-1)* — **7 vendors**,
  canonical usability-suite scope = 3 surfaces (API / SDK / CLI), 2 harnesses
  (Claude Code + Codex). MCP remains strategically important but is not part of
  the publication-grade canonical suite scope.
- **Launch hook:** A direct, respectful head-to-head with the Prompting
  Company benchmark — where all 14 of their vendors score 50/50 on
  "Usable," our oracle-based methodology produces real differentiation.
- **Two-tier product (sequenced):**
  - **Tier 1 (T+0):** AXArena leaderboard — we run it, oracle-verified.
  - **Tier 2 (T+12 weeks):** Self-serve audit ("drop your docs URL") —
    LLM-judge, low-friction, funnel into Tier 1.
- **Domain split (confirmed):**
  - `ax-eval.io` → keep for the open-source tool / docs.
  - `axarena.ai` → **acquired**; this is the leaderboard + content brand.
- **Launch date: T+7 days** (one week from decision-lock).
- **Revenue posture:** 0-revenue brand-building, 12-month horizon. Manual
  paid audits via CTA are opportunistic, not goal-tracked.

### 0.1 Vision

AXArena is not trying to be another AX tool, a vendor self-scoring
dashboard, or a generic "AI-ready" badge machine.

AXArena exists to become the **external source of truth** for Agent
Experience: the place developers, product teams, investors, and media turn
to when they want to know whether a platform is actually usable by agents.

The core belief is simple:

> **We do not measure claims. We measure operations.**  
> **We do not trust self-report. We read back real state.**  
> **We do not reward "AI-ready" branding. We reward completed work.**

In practical terms, that means AXArena is evaluating whether an agent can
discover a product, understand its surfaces, use them correctly, complete a
real task, and have the outcome independently verified. The benchmark is not
about whether a vendor has an API, SDK, CLI, or MCP server on paper; it is
about whether those surfaces are operational in the real world.

This is the long-term ambition:

- Make Agent Experience **legible** — so the market can clearly see which
  products are genuinely agent-usable.
- Make Agent Experience **comparable** — so scores mean the same thing across
  vendors, categories, surfaces, and time.
- Make Agent Experience **hard to fake** — so marketing cannot outrun
  execution.

The strategic consequence is that AXArena must optimize for **trust before
coverage**. A complete-looking benchmark that quietly papers over auth
complexity, flaky surfaces, or non-reproducible MCP flows is less valuable
than a transparent benchmark that clearly marks what is runnable, what is
blocked, and why. This is why MCP matters strategically, but should not be a
launch blocker when it would compromise methodology quality.

If LMArena became a reference point for "which model is better," AXArena's
goal is to become the reference point for **"which product can an agent
actually use?"**

---

## 1. Why Now: Market Landscape

The "Agent Experience" (AX) category formed in 2025 when Mathias Biilmann
(Netlify CEO) coined the term. As of mid-2026 the landscape is:

| Player | What it is | Position |
|---|---|---|
| **Biilmann / Netlify** | Coined AX, runs [agentexperience.ax](https://agentexperience.ax) | Category founder, vendor |
| **AXIS** ([netlify/axis](https://github.com/netlify/axis)) | Open-source CLI: "Lighthouse for AX" | Self-grading framework |
| **Auth0** | [auth0.com/agent-experience](https://auth0.com/agent-experience) | AXIS founding contributor, uses it as marketing |
| **Resend** | AXIS founding contributor | Same pattern as Auth0 |
| **agentexperience.ax** | Community site / category hub | Owned by Netlify, neutral-flavored |
| **Prompting Company** | "GEO" — get cited by ChatGPT/Perplexity | Adjacent category (AI as recommender vs. AI as user) |
| **LMArena** | Independent LLM leaderboard | **Our model** — not a competitor |
| **ax-eval (us)** | OSS CLI, read-back oracle, cross-surface matrix | Independent tooling, no brand yet |

**The opening:** Netlify owns the *category* but is structurally barred from
producing an *independent cross-vendor benchmark* — they can never credibly
publish "Vercel beat us on AX." Auth0 and Resend are using AXIS to grade
themselves at 97%, which is marketing, not measurement. There is no
LMArena-equivalent for AX.

**The window:** I estimate **8–12 weeks** before either (a) Netlify hires a
content team to run their own benchmarks, (b) a competing independent
benchmark launches, or (c) MCP self-evaluation tooling commoditizes the
"drop your link" model. Move now.

---

## 2. Competitive Analysis

### 2.1 Netlify AXIS — *the most important to understand correctly*

After cloning and reading the source ([netlify/axis](https://github.com/netlify/axis)):

- **What it actually is:** An npm-installable CLI + programmatic API that
  *any product team* can run on themselves. You write `axis.config.json`,
  define scenarios, AXIS executes the agent, captures transcript, and
  produces a scored report.
- **Scoring:** LLM-as-judge across four dimensions (Goal Achievement,
  Environment, Service, Agent). Composite + sparse-index + deep-eval +
  category-score pipeline. Customizable judge model.
- **Built-in scenarios:** All meta — they test AXIS itself (`configure-mcp`,
  `apply-limits`, `init-project`). Real users are expected to write their
  own scenarios against their own product.
- **Adapter breadth:** ~22 agents (Claude Code, Codex, Cursor, Copilot,
  Cline, Aider, Goose, Kimi, Qwen, Gemini, etc.). This is where they
  invested.
- **Roadmap (per README):** historical trending, embeddable badges,
  configurable judge, CI gating, human-interruption detection.
- **Founding contributors:** Auth0, Resend. Both publish AX scores under
  this framework as marketing.

**Implication:** AXIS is *Lighthouse* (vendor-runnable framework). It is
**not** trying to be the leaderboard. The leaderboard space is open.

### 2.2 Auth0 — `auth0.com/agent-experience`

- Frames AX as "how well AI coding agents integrate Auth0."
- Headline number: **63% → 97% with Auth0 tools enabled.**
- Backed by AXIS (LLM-judge methodology).
- Product offering: Auth0 MCP server, Auth0 Agent Skills.
- **Risk for us:** If we pick Auth as first category, Auth0 will be the
  most active participant — they could either embrace us or push back on
  methodology. Both outcomes net positive (attention), but adds drama.

### 2.3 Prompting Company — `promptingcompany.com` + `app.promptingco.com/benchmark`

**Updated finding (this matters):** They are *not* just a GEO marketing
firm — they ship an actual benchmark at `app.promptingco.com/benchmark`.
This is closer to direct competition than originally assumed, but with a
methodology weak point we can exploit.

- **Sells:** GEO (Generative Engine Optimization) service + a free
  public benchmark that doubles as their lead-gen funnel.
- **Benchmark categories:** Authentication, Managed Database.
- **Methodology:**
  - **Discoverable** (50 pts) — can an agent find / read / recommend
    the tool. This is GEO scoring in disguise.
  - **Usable** (50 pts) — can an agent actually build with it.
  - **All 14 listed vendors score 50/50 on Usable.** Rankings are
    determined entirely by Discoverable (14–48 pt range).
- **What this tells us:**
  - Their Usable test is either trivial or LLM-judged at a low rigor
    threshold. Real differentiation is absent.
  - This is **the ideal foil** for AXArena's launch narrative. See §4.6.
- **Their database vendors (7):** Xata, Supabase, Turso, PlanetScale,
  Neon, CockroachDB, Nile.
- **Their database omissions (we cover these):** MongoDB Atlas, Convex,
  Insforge, Firebase.
- GitHub org ([promptingcompany](https://github.com/promptingcompany)):
  TypeScript SDK, proxy, agent-skills, plus forks of OpenAI/Vercel/NVIDIA/
  Microsoft/Databricks tools. Infrastructure play, not benchmark play.
- **Tactical lesson:** Steal their *content structure* (category landing
  pages, vendor profiles). Show methodology improvement publicly and
  respectfully — they're a stepping stone, not an enemy.

### 2.4 agentexperience.ax (community hub)

- Open-source community site, Astro/Tailwind, hosted on Netlify.
- Pitches AX as collaborative open initiative ("pioneered by open
  contributors, researchers, and volunteers").
- **Useful for us:** Submit AXArena to their tools/resources list once
  launched. Being inside the tent is cheap goodwill.

### 2.5 LMArena — *our model, not a competitor*

- Origin: UC Berkeley LMSYS / Chatbot Arena (2023, academic).
- Mechanism: anonymous side-by-side chat → human votes → Elo ranking.
- Spun out as LMArena Inc., raised ~$100M Series A (a16z), 2025.
- **Revenue (public info):**
  1. Enterprise / pre-launch evaluation (model labs pay to test pre-release
     models privately).
  2. Custom benchmarks for large enterprises.
  3. B2B API / leaderboard data access (model-routing companies).
- **Key insight:** Did **not** monetize for ~2 years. Core asset =
  **trust + traffic**, not data. Resisted the temptation to ship a SaaS
  audit tool early.

**Direct mapping to AXArena revenue model (deferred):**
| LMArena | AXArena equivalent |
|---|---|
| Pre-launch private LLM eval | Pre-launch private AX audit (dev tool ships MCP, pays us to score before public release) |
| Enterprise custom leaderboard | Large platform pays us to run AX benchmark on their internal API/SDK |
| B2B leaderboard data API | Score API for agent-routing / dev-tool-discovery products |

---

## 3. Strategic Reasoning Chain

This section captures the full decision arc that led us here, so future
contributors can pressure-test any single link in the chain.

### 3.1 Why pivot to AX language at all

- We were independently building the same thing AX describes.
- Biilmann/Netlify have already done the category-creation work; trying
  to coin a different label costs SEO and recognition.
- Adopting "AX" is **borrowing free narrative gravity**, not capitulating.

### 3.2 Why NOT just contribute to AXIS

- Honest reflection: we want to *build* this, not be a plugin author.
- The differentiation (read-back oracle, cross-vendor leaderboard) is
  *structurally* something AXIS cannot do, not just *we could do better*.
- Contributor path = best-case acquihire. Builder path = LMArena-scale
  ceiling. Both are legitimate, but they imply different tactics.

### 3.3 Why benchmark IS the strategic space (not just marketing)

- LMArena / SWE-Bench / HumanEval / MTBench → the *benchmark itself* is
  the company. They became reference infrastructure for the industry.
- A benchmark that becomes "the source of truth" is a moat deeper than
  any SaaS — Anthropic / OpenAI / Google all cite LMArena.
- AXArena's equivalent moat: become the cited benchmark when anyone
  discusses "how well does platform X work for AI agents."

### 3.4 Why Tier 1 (leaderboard) MUST come before Tier 2 (self-serve)

Critical decision. Reasoning recap:

- **Tier 2 ("drop your URL → LLM-judge → report")** is structurally
  commoditized. Any LLM-app team can build it in a week. AXIS already
  partially is it.
- **Tier 1 (curated, oracle-verified, cross-vendor leaderboard)** carries
  three uncopyable assets: read-back oracle (objective), editorial
  selection (trust), cross-vendor comparability (story).
- Launch event asymmetry:
  - Tier 1 launch = *"6 databases benchmarked, X% AX gap"* — HN top-10
    likely, vendor DevRel will engage.
  - Tier 2 launch = *"free AX audit tool"* — generic, no story, no event.
- **Counterexample for Tier 2-only:** HuggingFace Open LLM Leaderboard.
  Anyone can submit any model. Result: noise, gaming, not trusted as
  reference. Don't be that. Be LMArena.

### 3.5 Why canonical task suite + per-vendor adaptation

- Per-vendor packs with unrelated task IDs are not comparable. Scores
  read as anecdotes, not benchmark.
- Canonical task suite (T01–T10 defined at *category* level, each
  vendor's pack maps its concrete implementation) = scores are
  *meaningfully comparable*.
- This is the same approach as SWE-Bench, MLPerf, HumanEval. It is
  table-stakes for any benchmark to be cited.
- N/A handling is **transparency, not weakness**. If a vendor genuinely
  doesn't ship a surface, mark N/A and disclose. Hidden gaps destroy
  credibility faster than missing scores.

### 3.6 Why Database first

- High vendor density with clear comparable players (6+ recognizable).
- All vendors active in AI-dev positioning, racing to ship MCP/SDK
  improvements — high buyer-pain, high response probability.
- No incumbent doing AX self-marketing in this category yet (unlike Auth,
  where Auth0 has already staked out the narrative). **We can be the
  category's sole AX voice.**
- Prompting Company validated this category as developer-marketable.
- Less politically charged than LLM provider category (we don't depend
  on databases for our own harness).

---

## 4. Positioning

### Top-level message

> **"The independent AX benchmark. Vendor-neutral by design."**

### Methodology hook

> *"AXIS lets vendors grade themselves. AXArena reads the answer key back
> from production. We don't trust the agent's self-report and we don't
> trust the judge — we verify the state."*

### Tier separation message

> *"AXArena uses read-back oracles — we verify production state, not
> transcripts. AX Audit (coming soon) uses LLM judges — fast, free, good
> enough for self-assessment."*

This explicitly legitimizes LLM-judge as a valid tool for the Tier 2 use
case while keeping oracle as the rigor anchor for Tier 1.

### Launch-narrative hook (vs. Prompting Company benchmark)

> *"An AX benchmark for databases already exists at
> `app.promptingco.com/benchmark`. They deserve credit for taking the
> first step. But all 14 of their vendors score 50/50 on 'Usable' — the
> test doesn't differentiate. AXArena verifies state with read-back
> oracles. On the same vendors, our Usable score range is [X% to Y%].
> Here's what the rigorous picture looks like."*

Tone: respectful but unambiguous about the methodology gap. We do not
trash them; we improve the genre.

### Visual / shorthand

- AXIS = *Lighthouse* (anyone runs it, anyone scores themselves).
- AXArena = *WebPageTest leaderboard* / *Core Web Vitals public data*
  (third-party, comparative, cited).

---

## 5. Methodology: DAEB-1 (Database AX Benchmark V1)

The deliverable is both the leaderboard *and* a publicly documented
methodology (`axarena.ai/methodology`).

### 5.1 Canonical Task Suite v1

10 tasks defined at category level, ordered by difficulty. Each vendor's
pack maps each task to its concrete API/SDK/CLI/MCP implementation.

**Draft list (open to revision before freeze):**

| ID | Title | Skill |
|---|---|---|
| T01 | Create a table `customers` with columns (id, email unique, created_at) | DDL / schema |
| T02 | Insert 100 synthetic rows | bulk write |
| T03 | Query rows where email matches a pattern, paginated | filtered read |
| T04 | Set up row-level security: each user only sees their own rows | access control |
| T05 | Add a unique constraint; verify it rejects duplicates | constraint enforcement |
| T06 | Add a foreign key between two tables | relational integrity |
| T07 | Export the table as JSON or CSV | data export |
| T08 | Apply a schema migration (add a column with default) | migration |
| T09 | Connect from a serverless function and run a query | runtime integration |
| T10 | Set up backup or point-in-time restore | operational ops |

### 5.2 Per-Vendor Adaptation

Each vendor's pack maps canonical task ID → concrete implementation:

- **Same `id`** (`db-T01-create-table`) across all packs.
- Vendor-specific `prompt`, `oracles[].readPathTemplate`, surface configs.
- For vendors where a task is structurally N/A (e.g., Convex has no SQL
  DDL), the task is **marked N/A in the pack and disclosed publicly**, not
  silently failed.

### 5.3 Read-back Oracle (vs. LLM-judge)

For every task, success = *we can read the expected state back from the
product*. Examples:

- T01: `SELECT * FROM information_schema.tables WHERE table_name='customers'`
  (or vendor equivalent) → row exists with expected columns.
- T05: insert duplicate → expect API/SDK to return an error of the
  documented kind.
- T08: read schema after migration → new column exists with default.

Oracle is **objective and game-resistant**. Agents cannot pass by
producing convincing transcripts; they must change real state.

### 5.4 N/A Disclosure Policy

Public methodology page lists, per vendor, exactly which tasks are N/A
and why. E.g., *"Convex T01 N/A — Convex does not expose SQL DDL; the
equivalent is `schema.ts` declarations, tracked under T01-equiv in a
v2 supplement."*

### 5.5 Naming and Versioning

- Suite name: **Database AX Benchmark V1** (DAEB-1).
- Future categories: VAB-1 (VectorDB), AAB-1 (Auth), etc.
- Suite version bumped when canonical task definitions change.
- Per-vendor packs may iterate; suite version is the comparability axis.

---

## 6. Vendor Selection

### 6.1 Research summary

Background research findings (provisional — **MCP availability moves
weekly, must be re-verified within 48 hours of launch**):

| Vendor | OpenAPI | SDK | CLI | MCP (per research) | Free tier | Notes |
|---|---|---|---|---|---|---|
| **Supabase** | PostgREST | `supabase-js` | `supabase` CLI | Need to re-verify; widely reported as having one | Generous | Surface-complete |
| **Neon** | No formal spec | `@neon-tech/serverless` | `neon` CLI | Re-verify; Neon announced MCP earlier | Yes | Serverless Postgres |
| **PlanetScale** | Documented REST | `@planetscale/database` | `pscale` | Re-verify | No usable free tier | Removed from active V3 lineup |
| **MongoDB Atlas** | Yes (Admin API) | `mongodb` driver | `mongosh` | Re-verify | 512 MB free | Big brand |
| **Turso** | Thin REST | `@libsql/client` | `turso-cli` | Likely no | Yes | Edge SQLite, AI-dev favorite |
| **Convex** | None (functions-as-code) | `convex` SDK | `npx convex` | Has MCP | Yes | AI-native, narrow surface coverage |
| **Xata** | REST documented | `xata` SDK | `@xata.io/cli` | No | Yes | Recent product pivot; risk |
| **Firebase** | No OpenAPI | `firebase` | `firebase-tools` | No | Generous | Google-walled |

> **Caveat:** The background-agent's "no MCP" assertions for Supabase,
> Neon and MongoDB are likely outdated — I'm fairly sure each
> of these has shipped (or is about to ship) an official MCP server. A
> 30-minute pre-launch sweep is needed to confirm exact MCP URLs and
> tool inventories before locking the packs.

### 6.2 Final launch lineup — 7 active vendors

After reviewing Prompting Company's database benchmark (Xata, Supabase,
Turso, PlanetScale, Neon, CockroachDB, Nile), we cover their strongest
overlap where the sandbox is still practical and add omitted vendors with
high agent relevance.

| # | Vendor | Why | In promptingco? |
|---|---|---|---|
| 1 | **Supabase** | Largest AI-dev mindshare. Surface-complete. | ✅ |
| 2 | **Neon** | Serverless Postgres darling; AI-tool default. | ✅ |
| 3 | **MongoDB Atlas** | Biggest brand; OpenAPI confirmed; non-Postgres diversity. | ❌ (their omission) |
| 4 | **Turso** | Edge / SQLite axis; hot in agentic stacks. | ✅ |
| 5 | **Convex** | AI-native dev choice. Surface narrowness disclosed via N/A. | ❌ (their omission) |
| 6 | **Insforge** | Agent-native BaaS — narrative pivot vendor. | ❌ (their omission) |
| 7 | **CockroachDB** | Distributed SQL, mature; in their list. | ✅ |

**Held out:**
- **Xata** — product pivoting recently, instability risk.
- **PlanetScale** — removed from active V3 because there is no longer a usable free tier for reproducible public benchmarking.
- **Nile** — too small for HN-tier recognition.
- **Firebase** — Google walled garden, OpenAPI absence costs too high.

### 6.3 Open decision (last vendor question)

- **CockroachDB in or out?** Including it makes the narrative cleanly
  "we cover everyone they cover, plus 3 they missed" (7 → 8). Cost: ~10%
  more launch work, mostly sandbox setup. **Recommended in.**
- 7-vendor fallback if T+7 timeline slips during build: drop CockroachDB
  to V1.5 supplement.

---

## 7. Code Feasibility: Can We Ship DAEB-1 on Existing Code?

**Headline:** Yes, almost entirely. **No structural code changes required**
for the canonical-task-suite methodology. Two small TODOs flagged at the
end of this section for user pre-approval.

> **2026-06-30 update:** Layers 1–2 of the pipeline are now complete and
> committed on `axarena-branch`. See §7.6 for current status.

### 7.1 What the existing pipeline already does

The pack-centered architecture is the right shape for what we need:

```
ingest → generate → review (frozen pack) → exec-plan → verify → report
```

- `TargetPack` schema (`src/schemas.ts`) already supports per-task
  `id`, per-surface auth, oracle specs (including `roundtrip` read-back),
  N/A-via-`allowed_surfaces`.
- Read-back oracle (`OracleSpec.roundtrip`) is already the primary
  verification mechanism (used in Stripe / Notion / Linear example packs).
- `exec-plan --invoke --harness claude-code --harness codex --surface all`
  already runs the cross-harness × cross-surface matrix in parallel.
- `competitive` command (`src/cli.ts:147`) already groups results by
  `taskId` across products — confirmed by inspection of
  `src/generate/report.ts:193-197`.

### 7.2 Why the canonical task suite is the benchmark contract

DAEB-1 is **not** eight independently generated vendor benchmarks that happen
to share similar task IDs. It is one frozen canonical suite plus eight vendor
adapters:

```
canonical suite -> vendor oracle extraction -> compiled vendor pack
  -> execution -> verification -> normalized records -> leaderboard
```

The suite defines task IDs, titles, difficulty, intent, oracle hints, allowed
surfaces, scoring notes, and N/A policy. Vendor-specific work is limited to
public vendor cards, read-back oracle extraction, auth/base URLs, N/A mapping,
and surface configuration.

Implementation detail: `ax-eval` still emits one `TargetPack` per vendor because
`exec-plan` and `verify-generated` need concrete auth/oracle/surface data. But
those files are **compiled execution artifacts**, not independent benchmark
definitions.

### 7.3 Generation strategy

Use the newer layered DAEB pipeline rather than ordinary per-target generation:

1. Freeze `targets/suites/daeb-1-v3.yaml`.
2. Resolve public vendor cards with `resolve-vendor`.
3. Extract vendor-specific read-back oracle adapters with `extract-tasks`.
4. Optionally extract CLI/SDK/MCP surface adapters with `extract-surfaces`.
5. Compose compiled packs with `compose-pack` (pure code, zero LLM).
6. Review/approve each compiled pack.
7. Run `exec-plan --invoke` across the same harness/surface matrix.
8. Run `verify-generated` per vendor.
9. Run `competitive` across normalized records.
10. Freeze a publication bundle with `publication-bundle`.

### 7.4 What we re-use vs. what we hand-author

| Step | Mechanism |
|---|---|
| Spec ingestion | Existing `ingest --openapi` / `ingest --graphql` |
| Canonical suite | `targets/suites/daeb-1-v3.yaml` |
| Vendor metadata | `resolve-vendor` → `targets/vendors/<slug>.discovered.yaml` |
| Verifier adapter | `extract-tasks` → `targets/extracts/<slug>/daeb-1-v3.yaml` |
| Compiled pack | `compose-pack` → `targets/packs/<slug>/daeb-1-v3.yaml` |
| Oracle definition | Existing `OracleSpec.roundtrip` |
| Approval gate | Existing `review --approve` |
| Cross-matrix execution | Existing `exec-plan --invoke` |
| Per-vendor report | Existing `verify-generated` |
| **Cross-vendor leaderboard** | Existing `competitive` (just feed N normalized records) |
| **Publication bundle** | New `publication-bundle` manifest + copied public artifacts |
| **AXArena landing page** | NEW (static HTML/Astro, hand-authored) |
| **Per-vendor detail pages** | Could be the existing `verify-generated` HTML, embedded |
| **Embed badges** | NEW (SVG generator, trivial) |
| **Methodology page** | NEW (markdown → static page) |

### 7.5 Code TODOs — decisions locked, not yet implemented

1. **Generator prompt for canonical task suite — DECISION: option (a).**
   We add a `--suite <path>` flag to `generate` that injects a suite
   spec into the LLM prompt, guaranteeing every vendor pack uses the
   same canonical task IDs. Scope:
   - new file `targets/suites/daeb-1-v3.yaml` (the canonical suite spec)
   - `src/generate/pack.ts` — ~30–50 lines: load suite, inject into
     prompt, validate task IDs match suite after generation
   - `src/cli.ts` — wire `--suite` flag on the `generate` command
   - `src/schemas.ts` — small `Suite` type (≤15 lines)
   - `tests/` — 1–2 unit tests for the new flag path
   - **Total: ~100 new lines, 1 new file.** Awaiting "go" before touching.

2. **`ingest` without OpenAPI.** For vendors without formal OpenAPI
   (Neon, Turso, possibly CockroachDB), we need to verify whether
   `ingest` can accept docs-only or if we hand-author packs. Inspection
   step before any code change; if hand-author is needed, Stripe pack
   (~200 lines YAML) is the template — no src/ change required.

3. **Competitive report visuals — DECISION: option (b).**
   Keep `verify-generated` / `competitive` HTML reports as internal/dev
   artifacts. Build a clean public-facing AXArena landing page
   separately, consuming the snapshot JSON. Cleaner separation; lets us
   iterate the landing page without touching the report code path.

### 7.6 The Full Pipeline (as of 2026-07-01) — reference

This is the actual end-to-end chain, from "we decided to benchmark a new
category" to "a cross-vendor leaderboard exists." Steps 1–7 are validated
for Supabase; steps 8–10 have not been run for real yet (see §7.7).

| # | Step | Who/what | Tooling |
|---|---|---|---|
| 1 | **Pick a category** (e.g. `database`) | Human | — |
| 2 | **Pick vendors** (the active 7 DAEB-1 V3 vendors) | Human | — |
| 3 | **Author the canonical suite** — task `id`/`title`/`difficulty`/`intent` (goal-level, vendor-agnostic)/`oracle_hint` | Human (LLM-assisted drafting is possible but DAEB-1 was hand-written) | `targets/suites/<suite>.yaml`, validated by `src/generate/suite.ts` |
| 4 | **Vendor-resolve** — find each vendor's `site_url`/`docs_url` | LLM, one batch call (real WebSearch, `--allowedTools`) | `ax-eval resolve-vendor --vendors "A,B,C" --category X` → `targets/vendors/<slug>.discovered.yaml` |
| 5 | **Verification-extract** — for each vendor, produce only the read-back checks needed to verify the frozen suite tasks (REST `read_path_template`/`read_method`, optional `read_body_template`, or raw-SQL `sql_query`/`sql_dialect`) + `assert_field`/`expected`, plus vendor-level `base_url`/auth. Current DAEB-1 V3 uses rule-derived verifier seeds first, then falls back to grounded LLM authoring only for uncovered gaps. Task *prompt* text is NOT touched here — it's pure suite text, rendered later in step 6. | Code seed + LLM fallback | `ax-eval extract-tasks --suite <suite.yaml> --category X [--vendor slug \| --vendors a,b,c]` → `targets/extracts/<slug>/<suite>.yaml` |
| 6 | **Compose-pack** — assemble suite (prompt/id/title/difficulty) + oracle-extract (verification) + vendor card (docs/site) into one frozen `TargetPack`. Pure code, zero LLM. | Code | `ax-eval compose-pack --suite <suite.yaml> [--vendor slug]` → `targets/packs/<slug>/<suite>.yaml` |
| 7 | **Review gate** — human reads the composed pack (prompts + oracle assertions + credential surface) and approves. Approval is content-hash-locked: any post-approval edit invalidates it. | Human | `ax-eval review --pack <pack.yaml> [--approve --by <name>]` |
| 8 | **Exec** — an agent (claude-code/codex) is given ONLY the goal-level prompt (no endpoint/mechanism hints) and a real sandbox credential; it performs the task against the live vendor API and self-reports an identifier (`gid`) per task. | LLM/agent, real API calls | `ax-eval exec-plan --pack <pack.yaml> --harness <name> --surface <api\|cli\|sdk\|mcp\|all> --invoke` → `results/*.json` |
| 9 | **Verify** — independently re-reads state via the verifier (REST GET/POST, real `pg`/`mysql2` SQL connection, MongoDB wire-protocol check, or product-specific read endpoint) and asserts it matches `expected`. Does NOT trust the agent's self-report beyond reported identifiers/field values needed to address the resource. | Code | `ax-eval verify-generated --pack <pack.yaml> --results <run.json>... --html out.html --snapshot out.json` |
| 10 | **Report** — normalized per-vendor records feed a cross-vendor leaderboard, grouped by canonical task `id` so scores are comparable. | Code | `ax-eval competitive --results <normalized.json>...` / `ax-eval render-generated --snapshot ...` |

#### Status per step (DAEB-1 V3, 2026-07-02)

- ✅ **1–4**: done for the active 7-vendor set (`supabase`, `neon`,
  `mongodb-atlas`, `turso`, `convex`, `insforge`, `cockroachdb`).
- ✅ **5 (verification-extract)**: deterministic verifier seeds generated for
  all 7 active vendors. Postgres-backed vendors use SQL read-back; Turso uses
  `/v2/pipeline` body templates; MongoDB Atlas uses Mongo wire-protocol
  verifier checks; Convex uses `/api/query` and `/api/action` body templates
  with reported function path fields and a Convex-specific no-auth/public
  function read-back client.
- ✅ **6 (compose-pack)**: done for all 7 active vendors on DAEB-1 V3.
- ✅ **7 (review/approve)**: done for all 7 active vendors on DAEB-1 V3.
- ✅ **SDK support audit**: support matrix is now surface-aware and does not
  inherit SDK support from API support. Unsupported SDK task/surface cells are
  excluded from the denominator rather than scored as failures. Current SDK
  eligible-task counts: Supabase `0`, Neon `8`, MongoDB Atlas `7`, Turso `6`,
  Convex `0`, Insforge `0`, CockroachDB `10`.
- ✅ **Preflight env gate**: all 7 active packs pass `check-env`, including
  auth envs, SQL/Mongo verifier envs, and `${ENV_VAR}` URL-template vars.
- 🟨 **8 (exec)**: smoke execution is underway. Codex API/CLI/SDK low/high
  cells have already exposed real vendor adapter bugs, support-matrix
  questions, and agent execution failures. Continue expanding the matrix
  before publication logic is hardened.
- 🟨 **9 (verify)**: smoke records now exist for Supabase, Neon, MongoDB Atlas,
  Turso, and Convex; the full 7-vendor × 3-surface × 2-harness × 2-effort
  matrix is still pending.
- 🟨 **10 (report)**: single-cell generated reports and normalized records are
  working; publication-grade bundle/reporting should stay thin until the full
  execution matrix exists.

### 7.7 Findings From the First Real Dry-Run (Supabase, 2026-07-01)

Running steps 5–9 for real (not just unit tests) surfaced several bugs
that static review had missed — this is exactly why "run it and see what
breaks" matters more than reasoning about the pipeline in the abstract.

1. **Oracle-extract was 100% ungrounded on the first pass.** The prompt
   said "use WebFetch" but nothing enforced it — the model answered from
   training knowledge for all 8 vendors despite having tool permission.
   Fixed: `invokeHarness` gained `requireWebFetch`, which parses the
   `--output-format json --verbose` transcript for real `tool_use` blocks
   and throws if none are found. (Note: `usage.server_tool_use` — visible
   even without `--verbose` — always reads 0 in this environment because
   WebFetch/WebSearch are client-side tools here, not Anthropic-hosted
   ones; that counter is not a valid signal.)
2. **`{ns}` was never substituted in `readPathTemplate`/`readQueryTemplate`
   at verify time** — only in `expected` and the agent's prompt. Every
   REST/GraphQL oracle across all 8 packs would have silently 404'd.
   Fixed in `verify.ts`.
3. **CockroachDB/PlanetScale's high N/A count (7/10) was mostly a
   verifier limitation, not a vendor limitation.** The oracle-extract
   prompt only knew how to express REST checks; wire-protocol-only
   vendors got marked N/A by default. Added a `sql_dialect`/`sql_query`
   check form (`src/generate/sql-verify.ts`, real `pg`/`mysql2`
   connections) — N/A dropped to 1/10 and 2/10 respectively, and the
   remainder are genuine (no RLS in MySQL, no function-hosting API).
4. **Per-account subdomains have no substitution mechanism.**
   `base_url: https://{project_ref}.supabase.co` was a dead template —
   nothing ever replaced `{project_ref}`. Added `${ENV_VAR}` substitution
   (`resolveEnvTemplate` in `target/config.ts`), applied only at the
   point a live HTTP/SQL call is made (NOT inside `loadPack`, so approval
   hashes stay stable across different developers' `.env` values).
5. **`BearerClient` couldn't call a different host mid-pack.** Some
   oracle checks (e.g. Supabase's backup list) hit a completely different
   API host (`api.supabase.com`) than the main data-plane subdomain.
   `get`/`post`/`del` now detect an absolute URL in `path` and bypass
   `baseUrl` concatenation.
6. **PostgREST needs a second header.** Supabase (and any PostgREST-based
   vendor) rejects `Authorization: Bearer <key>` alone — it also needs
   `apikey: <key>`. Added `Auth.extra_header` (declared per-vendor by
   oracle-extract, not hardcoded) and `BearerClient.extraAuthHeader`.
7. **Error messages were blank for non-Notion/Asana error shapes.**
   `BearerClient`'s error parsing only understood `{errors: [...]}}`;
   PostgREST's `{message, code}` shape produced an empty message string,
   making failures unreadable in reports. Added a shared
   `extractErrorMessage` covering both shapes plus a bare `{error}` string.
8. **Known, not yet fixed — T10-class tasks need a DIFFERENT credential
   than the rest of the pack.** Supabase's backup-listing endpoint is on
   the *management* API and needs `SUPABASE_ACCESS_TOKEN` (a personal
   access token), not `SUPABASE_SERVICE_ROLE_KEY` (the project's data-plane
   key) — the oracle-extract LLM correctly predicted this in its own
   `description` field, but the schema only supports one credential per
   whole pack. Affects ~1/10 tasks (the backup/PITR task, which is L4 —
   hardest tier — for most vendors). Deferred: either add a per-oracle
   credential override, or accept this one task fails until a human
   manually re-checks with the right token.

---

## 7A. Trust & Editorial — Building Credibility as a Solo Operator

This section is the **most important non-code section of the plan**.
Without trust + editorial credibility, AXArena is just another GitHub
repo. With it, AXArena becomes citation infrastructure (the LMArena
ceiling). Below: 10 concrete moves, ordered by leverage.

### 7A.1 Full open-source + reproducibility *(highest leverage)*

- All packs public (already true in repo).
- All read-back oracle queries public.
- Provide `axarena reproduce --vendor supabase --version daeb-1` —
  one-command reproducibility of any published score.
- Anyone can re-run our results → benchmark survives our absence →
  **anti-fragile**. This is the LMArena pattern.

### 7A.2 Public "Independence Charter"

Ship `axarena.ai/independence` at launch (~200 words):

- We do not accept funding from listed vendors.
- We hold no equity / options in listed vendors.
- No ranking is purchasable or modifiable by payment.
- Paid audit services (future) are operationally separated from public
  leaderboard scores. Same methodology, different deliverable.
- Errors are corrected publicly with date-stamped changelog entries.
- Vendors receive a 48-hour pre-publication preview to flag factual
  errors. **They have no veto power over findings.**

This page is the rhetorical shield for every methodology challenge.

### 7A.3 Real name + visible operator

LMArena is credible because Wei-Lin Chiang and the LMSYS team are
named, UC-Berkeley-affiliated humans. Solo + transparent beats
team-pretense + anonymous.

- `axarena.ai/about` has founder's real name and background.
- Blog posts signed personally (no "AXArena team" voice).
- Twitter: `@richardt830` (already wired into ax-eval README).
- **Employment disclosure:** "AXArena is an independent personal
  project. It is not affiliated with, endorsed by, or related to my
  employer." (User is at Asana — disclosure protects both sides.)

### 7A.4 Vendor pre-publication review (NYT standard)

- T-2 days: send preview emails to every listed vendor's DevRel +
  founder (where reachable).
- Email explicitly states: *"We welcome factual corrections. We do not
  grant veto."*
- Publish the entire review process on the methodology page.
- Document received feedback and our responses: *"Supabase team flagged
  X. We re-ran with Y and updated. Original transcript preserved at
  /transcripts/v1.0/supabase."*

This converts cold outreach into invited participation and is the
single highest-trust journalistic standard, transplanted to benchmarks.

### 7A.5 Public corrections changelog

`axarena.ai/changelog` lists every correction:

> *2026-07-15: Corrected Supabase T03 score 67% → 73% after re-running
> with the correct `SUPABASE_SERVICE_ROLE_KEY`. Methodology unchanged.
> Apologies to @supabase team for the initial setup error.*

**Counterintuitive but proven:** Publicly admitting errors is more
trust-positive than appearing infallible. People trust transparent
operators, not perfect ones.

### 7A.6 Engage critics publicly

- Methodology page actively invites challenges.
- Every launch blog ends with: *"Methodological objections? Open an
  issue, DM me, or publish a rebuttal. We'll engage publicly."*
- Retweet critics. Quote-tweet with our reasoning. Update where
  appropriate.
- LMArena's habit of publicly engaging detractors is core to their
  authority.

### 7A.7 Pre-announced cadence

At T+0 launch, publish forward roadmap:

> *DAEB-2 runs October 2026. VAB-1 (Vector DB Arena) August 2026.
> AAB-1 (Auth Arena) November 2026. Subscribe to the cadence calendar
> at axarena.ai/cadence.*

Pre-committed schedule signals **persistence**, which signals **legitimacy**.
PR stunts launch once and disappear; references run for years.

### 7A.8 Cultivate external citations

12-month trust-citation goals:

- 1 academic paper using DAEB-1 as dataset / benchmark.
- 3 vendor blogs citing our methodology page.
- 1 dev-rel blog post from Anthropic / OpenAI / Google referencing us.

First citation is the hardest; subsequent ones compound. Identify 2–3
academic AX researchers within first 60 days and offer DAEB-1 as a
study artifact.

### 7A.9 Small named advisory board (T+3 to T+6 months)

Three unpaid advisors, named on `/about`:

- One MCP spec contributor / Anthropic-adjacent voice.
- One AX-aligned founder (Biilmann is the obvious candidate — he needs
  ecosystem signals).
- One veteran DevRel from a respected dev-tool company.

Each contributes 2 hours / quarter on methodology review. **Their names
are borrowed trust** — and they have incentives to publicly endorse if
methodology stays clean.

### 7A.10 Long-game: methodology as standard

Once DAEB-1, DAEB-2, DAEB-3 exist with refined methodology:

- Publish *"The AXArena Methodology v1.0"* — proper paper format.
- Submit to arXiv, then to dev-infra conferences (StrangeLoop, KubeCon,
  AI Engineer Summit).
- This is the **benchmark → industry standard** transition. SWE-Bench
  walked exactly this path. Without it, you stay a leaderboard. With
  it, you become reference infrastructure.

### Summary table

| Move | Effort | Trust ROI | When |
|---|---|---|---|
| Reproducibility command | Medium | Very High | T+0 |
| Independence Charter | Low | Very High | T+0 |
| Real name + disclosure | Trivial | High | T+0 |
| Vendor preview emails | Low | Very High | T-2 |
| Public corrections changelog | Trivial | High | T+0 onward |
| Engage critics publicly | Low (recurring) | High | Always |
| Pre-announced cadence | Low | High | T+0 |
| Academic citations | Medium | Compounds | T+30 onward |
| Advisory board | Low | Borrowed trust | T+90 |
| Methodology paper | High | Step-change | T+12 mo |

## 8. Two-Tier Product Architecture (Sequenced)

### Tier 1 — AXArena (NOW)

- **Form:** Curated leaderboard, we run it.
- **Scoring:** Read-back oracle.
- **Frequency:** Quarterly per category to start.
- **URL:** `axarena.ai/database` (first category), `axarena.ai/vectordb`
  (second), …
- **Friction:** High (we bear it), but quality is uncompromised.

### Tier 2 — AX Audit (LATER, 4–8 weeks post-launch)

- **Form:** Self-serve. User drops docs/API URL, gets a report.
- **Scoring:** LLM-as-judge.
- **Friction:** Low — designed for viral spread.
- **Purpose:** Catch traffic from Tier 1 launches, lead-gen for paid
  audits, eventual data feedstock.
- **Risk if rushed before Tier 1:** Commoditizes the brand. Defer.

### Five lightweight Tier-1 launch-time traffic catchers (no Tier 2 needed)

These ship *with* the first launch, replacing the role of Tier 2:

1. **Per-vendor detail pages** (`axarena.ai/database/supabase` …) with
   Target/Evidence/Fix recommendations. Each is independently shareable
   and SEO-optimized. *Most important.*
2. **Embed badges** for vendors scoring above a threshold — viral
   reflow when DevRel teams place them on their docs.
3. **"Request a Category" form** — email capture for next launch.
4. **"Get a private AX audit" CTA** — manual paid service, no tooling
   needed, you do the work.
5. **Methodology page** at `axarena.ai/methodology` — trust anchor for
   any future methodology criticism.

---

## 9. Domain & Branding

### Decisions

- **Acquire:** `axarena.ai` — primary brand for benchmark + content.
- **Keep:** `ax-eval.io` — open-source tool / CLI docs.
- **Sub-paths on axarena.ai:**
  - `/database` — first category leaderboard
  - `/database/<vendor>` — per-vendor detail pages
  - `/methodology` — canonical suite specs + scoring docs
  - `/about` — what AXArena is, who we are, vendor-neutral pledge
  - `/audit` (later) — Tier 2 self-serve entry point

### Why `axarena` over `axbenchmark`

- "Arena" directly invokes LMArena's mental model — borrowing recognition.
- More charged / shareable word; "benchmark" is generic and technical.
- Shorter, brand-able.

### Defensive registrations to consider

- `ax-arena.com` (variant)
- `axindex.ai` (potential alt brand if "arena" hits IP pushback)
- `ax.report` (clean alternate)

---

## 10. Launch Plan — T+7 Day Sprint

**Launch date: T+7 from decision-lock.** Aggressive but feasible if
work is parallelized between user (sandbox / accounts / content) and
assistant (code / packs / artifact pipeline).

### Day 1 — Foundation
- [x] **Assistant:** Write `targets/suites/daeb-1-v3.yaml` (canonical task spec)
- [ ] **Assistant:** Implement `--suite` flag (option (a), per §7.5)
- [ ] **User:** axarena.ai DNS / static hosting setup (Netlify, Vercel,
      or Cloudflare Pages all fine)
- [ ] **User:** Optional MCP sweep — confirm current MCP availability for
      background context. MCP is not part of the V3 canonical usability suite.

### Day 2 — Account setup + code finalization
- [ ] **Assistant:** Generator change tested, commit
- [ ] **User:** Sandbox account registration at all vendors; API keys
      into `.env`
- [ ] **User:** Confirm OAuth flow for any MCP-having vendor (refresh
      token capture)

### Day 3 — Pack generation
- [ ] **Assistant:** Run `ingest → generate --suite → review --approve`
      for each vendor (parallel where possible)
- [ ] **User:** Validate / spot-check generated packs

### Day 4 — Full matrix execution
- [ ] **Assistant:** Run `exec-plan --invoke --harness claude-code
      --harness codex --surface all` for all vendors
- [ ] **Assistant:** Run `verify-generated` per vendor
- [ ] **Assistant:** Run `competitive` across all normalized records
- [ ] **User:** Begin launch blog post draft

### Day 5 — Public artifact creation
- [ ] **Assistant:** Build axarena.ai landing page (static, consumes
      snapshot JSON)
- [ ] **Assistant:** Per-vendor detail pages (`/database/<vendor>`)
- [ ] **Assistant:** `/methodology` page (DAEB-1 suite + scoring docs)
- [ ] **Assistant:** `/independence` page (Independence Charter)
- [ ] **Assistant:** `/about` page (real name + employment disclosure)
- [ ] **User:** Blog post, Twitter thread, HN post drafts

### Day 6 — Vendor preview
- [ ] **User:** Send preview emails to all vendors (DevRel + founder if
      reachable), 48 hours ahead. *"We welcome factual corrections.
      We do not grant veto."*
- [ ] **User:** Prep DM list for amplifiers (Swyx, Simon Willison,
      Theo, Logan Kilpatrick, AX-aligned voices)
- [ ] **Assistant:** Final report rendering + freeze snapshots

### Day 7 — Launch
- [ ] **09:00 ET:** Blog post live, Twitter thread, axarena.ai live
- [ ] **10:00 ET:** HN "Show HN: We benchmarked agent experience across
      8 databases" post
- [ ] **10:30 ET:** DM amplifier list (3–5 people)
- [ ] **All day:** Respond to every comment, vendor reply, methodology
      question. Engagement drives second-wave traffic.

### T+1 to T+14 — Compounding
- [ ] Vendor follow-ups (re-runs, methodology questions, badge requests)
- [ ] Aggregate metrics (HN position, Twitter impressions, axarena.ai
      sessions, "Request a Category" signups)
- [ ] Submit AXArena to agentexperience.ax tools list
- [ ] Ship embed badge generator + "Request a Category" form (deferred
      from launch day)
- [ ] Begin authoring VAB-1 (Vector DB Arena V1)

### T+12 weeks — Tier 2 launch
- [ ] Self-serve "drop your URL" audit ships at `axarena.ai/audit`
- [ ] LLM-judge methodology; clearly distinguished from Tier 1
- [ ] Funnels traffic toward Tier 1 leaderboard

### Scope cuts if Day 4 or Day 5 slip
- Drop CockroachDB to 7-vendor V1 (covers all major players).
- Defer embed badge to T+1.
- Skip "Request a Category" form on launch day.
- *Do not cut:* per-vendor detail pages, methodology page,
  Independence Charter — these are trust-essential.

---

## 11. Historical TODO Before We Lock the Launch Date

This section is preserved as decision history. It is superseded by §16 for
current execution work.

### Immediate (do now, before scheduling launch)

- [x] **User decisions needed:** V3 active 7-vendor lineup locked; `axarena.ai`
  acquired; DAEB-1 naming adopted.
- [x] **Branch work:** suite/methodology artifacts, docs-only canonical flow,
  verification extracts, composed packs, approvals, and preflight env gates.

### Once user confirms

- [x] Sandbox credentials for active V3 vendors
- [x] Pack generation/review per vendor
- [ ] Real execution/verification matrix

---

## 12. Open Questions for User (remaining)

Most decisions are now locked in §14. What's still open:

1. **CockroachDB in lineup?** Resolved: included in the active 7-vendor V3 set.
2. **Defensive domain registrations** — `ax-arena.com` and `ax.report`
   are cheap (≤$30/yr each). Acquire as defense? Optional.
3. **Advisory board candidates** — start identifying 2–3 named people
   for T+90 outreach (§7A.9). Names to consider?

---

## 13. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Netlify (or someone) ships a competing independent benchmark first | Move now; even a 4-vendor V1 leaderboard establishes editorial position |
| A vendor disputes methodology publicly | Methodology page is the shield. N/A disclosure protocol pre-empts most attacks. |
| MCP availability changes between research and launch | Pre-launch 48h sweep is in the checklist |
| Sandbox setup is slower than expected (esp. Atlas, Firebase) | Drop slowest vendor, ship V1 with 4–5 if needed; second wave fills gaps |
| HN post doesn't take off | Twitter thread + targeted DMs are the backup. Vendor DevRel teams alone generate substantial traffic if 6 preview emails go out. |
| "Drop your URL" Tier 2 gets shipped by a competitor in our launch window | Tier 1 leaderboard is the moat; Tier 2 commoditization actually *helps* by drawing traffic into the category |
| We over-invest in tooling instead of brand | This doc is the contract: no new code paths unless flagged in §7.5 and explicitly approved |

---

## 14. Decision Log

- **2026-06-30** `axarena.ai` **acquired**.
- **2026-06-30** Launch date: **T+7 days from decision-lock**.
- **2026-06-30** Tier 2 launch deferred to **T+12 weeks**.
- **2026-06-30** Generator change: **option (a)** — implement `--suite`
  flag with canonical suite mode (~100 LOC).
- **2026-06-30** Revenue posture: **0-revenue brand-building for first
  12 months**. Manual paid audits opportunistic only.
- **2026-07-02** Vendor lineup updated to active 7: **Supabase, Neon,
  MongoDB Atlas, Turso, Convex, Insforge, CockroachDB**. PlanetScale removed
  because it no longer has a usable free tier for this benchmark.
- **2026-06-30** Methodology naming: **DAEB-1** (Database AX Benchmark V1)
  confirmed.
- **2026-06-30** Trust & Editorial section adopted; §7A is treated as
  launch-mandatory, not optional.
- **2026-06-30** Launch narrative hook: respectful head-to-head with
  `app.promptingco.com/benchmark` — "all their vendors 50/50 on Usable;
  here's the rigorous picture."

- **2026-06-30** CockroachDB **confirmed in** lineup. Later V3 vendor count
  returned to 7 after PlanetScale was removed for free-tier reasons.
- **2026-06-30** §7.5 TODO #1 (`--suite` flag): **DONE**.
- **2026-06-30** §7.5 TODO #2 (docs-only ingest): **DONE** (docs-only stub
  mode; `--from` optional when `--suite` set).
- **2026-06-30** Vendor-resolve redesigned v3: batch LLM WebSearch,
  single invocation. Initial cards created; active V3 now excludes PlanetScale.
- **2026-06-30** `AX_EVAL_CLAUDE_BIN` escape hatch implemented (Asana PATH
  shim workaround). `--allowedTools WebSearch,WebFetch` added to headless
  claude invocations.

### Still open
- **Defensive domain registrations** (`ax-arena.com`, `ax.report`) —
  optional, low cost.

- **2026-07-01** Suite authoring made reproducible/auditable: new
  `extract-capabilities` (bottom-up, cited, per-vendor) + `synthesize-suite`
  (cluster + draft) commands replace hand-authored task selection. Coverage
  threshold enforced so canonical tasks measure AX
  (can an agent use a capability that exists) not product completeness
  (does the vendor have it at all) — see the coverage-gap-check pass below.
- **2026-07-01** Coverage gaps found to be a **sampling artifact of
  bottom-up extraction**, not real product gaps: a systematic pass
  (`coverage-gap-check.ts` — union all vendors' cited capabilities, cross-
  check every capability against every vendor NOT already citing it) moved
  several capabilities from <6/8 to 6-8/8 (`database-triggers` 3→8/8,
  `backup-and-restore` 3→7/8, `schema-migration` 5→7/8, etc.). Final
  DAEB-1-v2 suite: **10 canonical tasks**, all meeting the then-current
  coverage threshold, difficulty spread L1-L4. Superseded by DAEB-1-v3.
- **2026-07-01** Model pinning target: Claude Code should run with
  `--model sonnet` (or the full stamped Sonnet 5 slug once confirmed by the
  first pinned lane) and Codex should run with a Codex-compatible GPT slug.
  Do not put both harnesses in one `exec-plan` command when passing `--model`,
  because the slug namespace is harness-specific. The normalized record's
  stamped model remains the ground truth for publication.
- **2026-07-01** ax-eval's own generation tooling (capability-extract,
  synthesize-suite, task-extract) decoupled from the exec-plan harness
  path: `invokeGenerator()` calls the configured provider's API directly
  (Anthropic or OpenAI, whichever key is set) with that provider's hosted
  web-search tool, falling back to the local CLI only if neither key is
  set. `exec-plan` is unchanged (it must keep shelling out to the real
  claude-code/codex binaries — that's the thing under test). Rationale:
  today's generation-tooling debugging (broken PATH-shadowing shim, orphan
  processes escaping their process group, a stdin hang, real multi-minute
  API latency) was all avoidable complexity for calls that were never
  actually testing a harness.
- **2026-07-01** **MCP disabled as a scored surface for v1** (code path
  kept, not deleted — see `compose-pack.ts`'s `DISABLED_SURFACES`).
  Rationale: thin/near-zero signal so far on both vendors tested, requires
  a paid API key for claude-code specifically (its Keychain-based
  subscription auth doesn't reach the isolated home MCP testing needs,
  unlike codex's file-based auth which transfers cleanly), and each
  vendor's MCP server needs its own per-vendor provisioning work (a real
  stdio-vs-http config bug was found and fixed for claude-code's provisioner
  along the way — Neon's MCP server is an npm package run over stdio, not
  an HTTP endpoint, and the provisioner only knew how to configure HTTP).
  Revisit once MCP is more uniformly mature across the active vendor set.
- **2026-07-01** Real exec-plan run completed for Supabase and Neon across
  api/sdk/cli × claude-code/codex × low/high effort (16 cells each,
  MCP excluded). Several real bugs found and fixed along the way:
  SQL identifiers containing `{ns}` (which has dashes) must be
  double-quoted or Postgres throws a syntax error; node-postgres returns
  BIGINT/NUMERIC as strings, needing numeric-string coercion in
  `valuesMatch()`; oracle checks that ask the agent to self-report a raw
  REST path break on non-REST surfaces (agent reports SDK/SQL syntax
  instead) — fixed by pinning fixed, predictable resource names in the
  suite intent instead of trusting a self-reported path; a zero-parameter
  RPC assumption for vector search broke because agents reasonably wrote
  parameterized functions — fixed by requiring a parameter-less function in
  the suite intent; added a general `sqlConnField` oracle mechanism so a
  check can verify against an agent-reported alternate connection string
  (needed for point-in-time-restore-to-a-new-branch and RBAC-role
  testing, both of which live behind a different credential than the
  pack's default). Remaining known rough edges: Supabase's sandbox plan
  genuinely doesn't support PITR (T06 correctly fails there, not a bug);
  RLS/RBAC identity tokens are sometimes malformed JWTs depending on how
  the agent obtained them (intermittent, not yet root-caused); Neon's CLI
  surface can land work on a different branch than the pack's fixed
  connection string (neonctl manages multiple branches; the sqlConnField
  mechanism could be generalized to every SQL check to close this).
- **2026-07-01** **Methodology self-critique** (asked for explicitly before
  calling any result "public-ready"). Strongest, unresolved issues:
  (1) **n=1 per cell** — no repeated trials, and real run-to-run variance
  was already observed empirically (Supabase claude-code/api/low: 88% one
  run, 63% the next, same code) — a single flaky run can swing a cell.
  (2) **effort double-encoding for codex** — codex has a native
  `model_reasoning_effort` knob AND was getting prompt-level "act lazy/act
  thorough" coaching layered on top, conflating "model capability at low
  reasoning effort" with "obedience to an instruction to behave lazily".
  Partially addressed today (see below) but not fully resolved, since
  claude-code has no native knob and still needs the prompt-level lever.
  (3) **unknown oracle-check bug rate** — several real false-negative bugs
  were found and fixed reactively (by reading failure logs), not via
  systematic audit; no guarantee the current set is bug-free.
  (4) **task suite wasn't pre-registered** — selection criteria (AX vs.
  completeness framing, coverage threshold, MCP inclusion) were refined
  iteratively while looking at real results, which is defensible per-step
  but isn't the same as a locked-before-data design.
  (5) **self-reported fields untested adversarially** — nothing checks
  whether an agent could report a plausible-but-hollow value (e.g. a
  `reader_connection_string` that's secretly the admin connection) to
  fake a pass.
  (6) **sandbox-tier limits leak into AX signal** — e.g. codex's Supabase
  run hit `SUPABASE_ACCESS_TOKEN` plan-tier limits on JWT templates; that's
  a limitation of the specific sandbox account, not of Supabase's docs/AX,
  but currently gets folded into "codex struggled" without being separated
  out.
  Fixed today: the effort-block wording was toned down from an exaggerated
  "you are a LOW-EFFORT agent, do the bare minimum, never verify" /
  "you are a HIGH-EFFORT agent, verify everything" caricature to a milder,
  more realistic instruction — still necessary for claude-code (no native
  effort knob exists there) but no longer doing most of the differentiating
  work for codex, where the native `model_reasoning_effort` knob is now the
  primary lever. Not fixed today (deferred, larger scope): repeated-trial
  sampling, systematic oracle audit, pre-registration, adversarial
  self-report testing, sandbox-limit attribution.

---

## 15. Immediate Next Steps (ordered) — superseded, kept for history

This section described the plan as of 2026-07-01 morning, before the suite
redesign and the first real exec-plan runs. It is stale (references the
old hand-authored `daeb-1.yaml`, and treats exec-plan as not-yet-run). See
§16 for the current state and next steps.

---

## 16. Current State & Next Steps — updated 2026-07-02

**Suite**: DAEB-1-v3 (`targets/suites/daeb-1-v3.yaml`), 10 canonical tasks,
bottom-up-derived via `extract-capabilities` + deterministic/family-aware
`synthesize-suite` + required `coverage-gap-check`, all constrained to
canonical usability surfaces (`api`, `sdk`, `cli`). Supersedes both the
original hand-authored `daeb-1.yaml` and the transitional V2 suite.

**Pre-execution complete for 7 of 7 active vendors**: Supabase, Neon,
MongoDB Atlas, Turso, Convex, Insforge, and CockroachDB all have V3
verification extracts, composed packs, passing `check-env`, and matching
approval sidecars. V3 execution has started with Codex smoke cells; the
remaining work is matrix expansion and evidence-backed hardening.

1. **Execution matrix** — run all 7 active vendors across `api/sdk/cli`,
   Codex and Claude Code, low/high effort. MCP remains excluded from the
   canonical usability-suite scope. For first full-matrix expansion, prefer
   `--invoke-retries 0` so one high-effort timeout consumes one timeout window
   instead of two; rerun specific flaky cells separately when evidence suggests
   a transient failure.

2. **Verification matrix** — run `verify-generated` against every execution
   result and produce snapshots/HTML reports without resetting sandboxes before
   verification.

3. **Trace/reasoning audit** — review traces for product failure, agent
   failure, environment failure, and evaluation failure before changing
   grader logic.

4. **Publication bundle** — freeze manifest + normalized records + reports +
   static Discoverability & Readiness artifacts side by side with usability
   results.

5. **Metrics interpretation** — publish correctness separately from latency,
   token cost, tool-call count, turn count, and trace diagnostics.

6. **First cross-vendor report** — `ax-eval competitive` across all 7
   normalized records. This is the first artifact that's actually a
   "benchmark" rather than a per-vendor pack.

7. **axarena.ai** — DNS/hosting setup, deploy `docs/launch/web/` with
   real scores substituted in.

8. **Vendor preview emails** (T-2 from launch).

---

*End of plan. Edit this file directly; do not fork into multiple plan docs.*
