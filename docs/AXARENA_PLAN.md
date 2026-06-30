# AXArena: Strategic Plan & Launch Spec

> **Status:** Draft v1 · Branch: `axarena-branch` · Internal strategy doc
>
> **Build progress:** Pipeline Layers 1–2 complete. Layer 3 (task-extract) is the current blocker.
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
- **First launch:** *Database AX Benchmark V1 (DAEB-1)* — **7–8 vendors**,
  4 surfaces (API / SDK / CLI / MCP), 2 harnesses (Claude Code + Codex).
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
| **PlanetScale** | Documented REST | `@planetscale/database` | `pscale` | Re-verify | 1 DB free | MySQL leader |
| **MongoDB Atlas** | Yes (Admin API) | `mongodb` driver | `mongosh` | Re-verify | 512 MB free | Big brand |
| **Turso** | Thin REST | `@libsql/client` | `turso-cli` | Likely no | Yes | Edge SQLite, AI-dev favorite |
| **Convex** | None (functions-as-code) | `convex` SDK | `npx convex` | Has MCP | Yes | AI-native, narrow surface coverage |
| **Xata** | REST documented | `xata` SDK | `@xata.io/cli` | No | Yes | Recent product pivot; risk |
| **Firebase** | No OpenAPI | `firebase` | `firebase-tools` | No | Generous | Google-walled |

> **Caveat:** The background-agent's "no MCP" assertions for Supabase,
> Neon, PlanetScale, MongoDB are likely outdated — I'm fairly sure each
> of these has shipped (or is about to ship) an official MCP server. A
> 30-minute pre-launch sweep is needed to confirm exact MCP URLs and
> tool inventories before locking the packs.

### 6.2 Final launch lineup — 7 confirmed + 1 pending

After reviewing Prompting Company's database benchmark (Xata, Supabase,
Turso, PlanetScale, Neon, CockroachDB, Nile), we expand to cover what
they cover plus what they miss.

| # | Vendor | Why | In promptingco? |
|---|---|---|---|
| 1 | **Supabase** | Largest AI-dev mindshare. Surface-complete. | ✅ |
| 2 | **Neon** | Serverless Postgres darling; AI-tool default. | ✅ |
| 3 | **PlanetScale** | MySQL camp representation; mature CLI/SDK. | ✅ |
| 4 | **Turso** | Edge / SQLite axis; hot in agentic stacks. | ✅ |
| 5 | **MongoDB Atlas** | Biggest brand; OpenAPI confirmed; non-Postgres diversity. | ❌ (their omission) |
| 6 | **Convex** | AI-native dev choice. Surface narrowness disclosed via N/A. | ❌ (their omission) |
| 7 | **Insforge** | Agent-native BaaS — narrative pivot vendor. | ❌ (their omission) |
| 8? | **CockroachDB** | Distributed SQL, mature; in their list. | ✅ |

**Held out:**
- **Xata** — product pivoting recently, instability risk.
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

### 7.2 Why the canonical task suite needs zero schema changes

The "canonical task suite" can be implemented **purely as authoring
convention**:

1. Define DAEB-1 task IDs once: `db-T01-create-table`, `db-T02-insert-rows`,
   …, `db-T10-backup-restore`.
2. Each per-vendor pack uses **the same IDs** for the corresponding tasks.
3. Each vendor writes its own `prompt`, `oracles[].readPathTemplate`,
   and surface specifics.
4. `competitive` command already groups by `taskId` → cross-vendor
   comparison "just works."

This is mechanical reuse of existing capability. We don't need a new
"suite" object; the methodology doc plus disciplined authoring is enough
for V1.

### 7.3 Generation strategy

Use the existing `generate` (LLM-assisted) workflow per vendor, but
**guide it with the canonical task suite spec**. Practical flow:

1. Write `docs/daeb-1-suite.md` — the canonical task suite spec (this is
   also published as `axarena.ai/methodology`).
2. For each of the 6 vendors:
   - `ingest --openapi <url>` (or docs-only ingest for those without
     OpenAPI; need to verify ingest can run docs-only — see §7.5).
   - `generate --from <ingest.json>` with a prompt augmentation that
     instructs the generator to author tasks matching DAEB-1 IDs.
   - `review --approve` to freeze.
3. `exec-plan --invoke` cross-matrix.
4. `verify-generated` per vendor → individual report.
5. `competitive --results <all 6 normalized records>` → cross-vendor
   leaderboard report.

### 7.4 What we re-use vs. what we hand-author

| Step | Mechanism |
|---|---|
| Spec ingestion | Existing `ingest --openapi` / `ingest --graphql` |
| Task generation | Existing `generate` (LLM-assisted), augmented with DAEB-1 prompt |
| Oracle definition | Existing `OracleSpec.roundtrip` |
| Approval gate | Existing `review --approve` |
| Cross-matrix execution | Existing `exec-plan --invoke` |
| Per-vendor report | Existing `verify-generated` |
| **Cross-vendor leaderboard** | Existing `competitive` (just feed N normalized records) |
| **AXArena landing page** | NEW (static HTML/Astro, hand-authored) |
| **Per-vendor detail pages** | Could be the existing `verify-generated` HTML, embedded |
| **Embed badges** | NEW (SVG generator, trivial) |
| **Methodology page** | NEW (markdown → static page) |

### 7.5 Code TODOs — decisions locked, not yet implemented

1. **Generator prompt for canonical task suite — DECISION: option (a).**
   We add a `--suite <path>` flag to `generate` that injects a suite
   spec into the LLM prompt, guaranteeing every vendor pack uses the
   same canonical task IDs. Scope:
   - new file `targets/suites/daeb-1.yaml` (the canonical suite spec)
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

### 7.6 Pipeline Build Status (as of 2026-06-30)

The original verdict was correct. Here is the actual implementation state:

#### ✅ Layer 1: Canonical Task Suite

- `targets/suites/daeb-1.yaml` — 10-task DAEB-1 suite authored (T01–T10,
  L1–L4 difficulty, `skill`, `intent`, `oracle_hint`, `allowed_surfaces`,
  `na_examples` per task)
- `src/generate/suite.ts` — `loadSuite()`, `suitePromptFragment()`,
  `validatePackAgainstSuite()`; `PROMPT_VERSION = "vendor-resolve-v1"`
- `--suite <path>` flag wired into `generate` command
- `generate` validates pack task IDs against suite after LLM generation
- `--from` made optional when `--suite` is set (docs-only mode)
- `src/generate/harness.ts` extracted — centralises harness invocation,
  `AX_EVAL_CLAUDE_BIN` / `AX_EVAL_CODEX_BIN` escape hatches for Asana
  PATH-shadowing; `--allowedTools WebSearch,WebFetch` passed to claude -p
- Silent Asana fixture fallback removed from `ingest/run.ts`
- Supabase OpenAPI fixture removed (not needed)
- Tests: `tests/suite.test.ts` (5), `tests/cli.test.ts` updated

#### ✅ Layer 2: Vendor Cards (resolved)

All 8 DAEB-1 vendor cards created at `targets/vendors/<slug>.discovered.yaml`:

| Vendor | docs_url |
|---|---|
| Supabase | `https://supabase.com/docs` |
| Neon | `https://neon.com/docs` |
| PlanetScale | `https://planetscale.com/docs` |
| MongoDB Atlas | `https://www.mongodb.com/docs/atlas/` |
| Turso | `https://docs.turso.tech` |
| Convex | `https://docs.convex.dev/home` |
| Insforge | `https://docs.insforge.dev` |
| CockroachDB | `https://www.cockroachlabs.com/docs/` |

`vendor-resolve.ts` redesigned to v3: single batch LLM call (one claude
invocation, 8 WebSearches) → replaces pattern-probe. `resolve-vendor`
CLI now accepts `--vendors "A,B,C"` for batch. `extractJsonObject` now
handles JSON arrays.

#### 🔲 Layer 3: Task Extract (CURRENT BLOCKER)

For each vendor × task, a narrow LLM call produces the concrete
implementation spec: `{endpoint, method, body_template, oracle_path,
identity_field}`. 10 calls per vendor × 8 vendors = 80 parallel calls.
These feed Layer 4.

*Not started. This is the immediate next step.*

#### 🔲 Layer 4: Compose Pack

Code assembles suite + task-extracts + vendor card → frozen
`targets/packs/<vendor>/daeb-1.yaml` ready for `exec-plan`.

*Not started. Depends on Layer 3.*

#### 🔲 Layer 5+: Exec, Verify, Report, Website

`exec-plan --invoke`, `verify-generated`, `competitive` — all exist in
the codebase, no new code needed. Website HTML at `docs/launch/web/`
exists (gitignored sub-agent draft); needs real scores before publishing.

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
- [ ] **Assistant:** Write `targets/suites/daeb-1.yaml` (canonical task spec)
- [ ] **Assistant:** Implement `--suite` flag (option (a), per §7.5)
- [ ] **User:** axarena.ai DNS / static hosting setup (Netlify, Vercel,
      or Cloudflare Pages all fine)
- [ ] **User:** Pre-launch MCP sweep — confirm current MCP availability
      for each of the 7–8 vendors (URLs change weekly)

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

## 11. TODO Before We Lock the Launch Date

Concrete next-step list, ordered by what blocks what.

### Immediate (do now, before scheduling launch)

- [ ] **User decisions needed:**
  - Confirm 6-vendor lineup (or swap Convex / add Xata / Firebase)
  - Acquire `axarena.ai` (and decide on `ax-arena.com` / defensive)
  - Approve methodology naming: "DAEB-1" or alternative
- [ ] **My next steps (this branch):**
  - Write `docs/daeb-1-suite.md` — canonical task suite spec
  - Inspect `src/ingest/` to confirm whether docs-only ingest is
    supported (relevant for Neon, Turso, Firebase if kept)
  - Draft the AXArena landing page wireframe (HTML mockup)
  - Draft launch blog post outline
  - Draft Twitter thread + HN post outline
  - Draft 6 vendor preview emails

### Once user confirms

- [ ] Sandbox account registration at 6 vendors (user does, or shared
      pairing session)
- [ ] Pack generation per vendor
- [ ] Lock launch date based on actual progress

---

## 12. Open Questions for User (remaining)

Most decisions are now locked in §14. What's still open:

1. **CockroachDB in lineup?** Recommended in for narrative completeness
   ("we cover everyone they cover, plus 3 they missed"). 7 → 8 vendors;
   ~10% more launch work. Acceptable to drop to V1.5 if Day 4 slips.
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
- **2026-06-30** Vendor lineup: **Supabase, Neon, PlanetScale,
  MongoDB Atlas, Turso, Convex, Insforge** confirmed.
  CockroachDB **pending user confirmation** (recommend in → total 8).
- **2026-06-30** Methodology naming: **DAEB-1** (Database AX Benchmark V1)
  confirmed.
- **2026-06-30** Trust & Editorial section adopted; §7A is treated as
  launch-mandatory, not optional.
- **2026-06-30** Launch narrative hook: respectful head-to-head with
  `app.promptingco.com/benchmark` — "all their vendors 50/50 on Usable;
  here's the rigorous picture."

- **2026-06-30** CockroachDB **confirmed in** lineup (8 vendors total).
- **2026-06-30** §7.5 TODO #1 (`--suite` flag): **DONE**.
- **2026-06-30** §7.5 TODO #2 (docs-only ingest): **DONE** (docs-only stub
  mode; `--from` optional when `--suite` set).
- **2026-06-30** Vendor-resolve redesigned v3: batch LLM WebSearch,
  single invocation. All 8 vendor cards created.
- **2026-06-30** `AX_EVAL_CLAUDE_BIN` escape hatch implemented (Asana PATH
  shim workaround). `--allowedTools WebSearch,WebFetch` added to headless
  claude invocations.

### Still open
- **Defensive domain registrations** (`ax-arena.com`, `ax.report`) —
  optional, low cost.

---

## 15. Immediate Next Steps (ordered)

1. **Layer 3: task-extract** — per-task narrow LLM calls. For each of the
   10 DAEB-1 tasks × 8 vendors, one call returning structured JSON:
   `{endpoint, method, body_template, oracle_path, identity_field}`. 80
   parallel calls, schema-locked. Design: `src/generate/task-extract.ts` +
   new CLI command `extract-tasks --suite daeb-1 --vendor supabase`.

2. **Layer 4: compose-pack** — code assembles suite + task-extracts +
   vendor card → `targets/packs/<vendor>/daeb-1.yaml`. New CLI command
   `compose-pack --vendor supabase`. No LLM needed here — pure code.

3. **Human review pass** — inspect first Supabase pack, fix any task
   mapping errors, approve. Then replicate to 7 others.

4. **Sandbox env setup** — user registers test accounts at all 8 vendors,
   fills `.env` with real API keys. Supabase partially done.

5. **exec-plan runs** — `exec-plan --invoke --harness claude-code --surface
   api --vendor supabase` as the first E2E proof-of-concept.

6. **Full matrix** — all 8 vendors × 4 surfaces × 2 harnesses.

7. **axarena.ai** — DNS / hosting setup, deploy `docs/launch/web/` with
   real scores substituted in.

8. **Vendor preview emails** (T-2 from launch).

---

*End of plan. Edit this file directly; do not fork into multiple plan docs.*
