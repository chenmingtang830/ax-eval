# Discussion Log — Positioning & Landscape

**Date:** 2026-05-29
**Status:** Draft for team review
**Revisions:** rev 2 (2026-05-29) — competitive corrections (Tech Stackups downgraded, Cloudflare recategorized) + new "big players moving" signal (Stainless → Anthropic). · rev 3 (2026-05-29) — added §11 product direction; harness orchestration + telemetry decided; detailed build spec split out to `product-spec.md`. · rev 4 (2026-05-29) — added §12 (oracle credibility, Asana as first target, the sandbox/provisioning question, static+behavioral+editorial layering, open-source skill direction); open-skill build detail split out to `skill-spec.md`.
**Topic:** What we're building, what to call it, who else is in the space, and where the real gap is

> This is a working log, not a spec. It captures the reasoning behind our current
> positioning so collaborators can challenge it. Nothing here is final — the
> "Open Questions" section is where we still disagree or don't know.

---

## TL;DR

We're building a tool that tests whether **AI agents can actually complete real tasks against a SaaS product's docs / API / MCP / CLI** — not whether the docs are pretty, not whether the code samples compile, but whether an agent succeeds end-to-end.

Three decisions came out of this session:

1. **Don't call it AEO.** AEO is an *optimization* discipline (get found, get structured, get selected). We're a *testing/verification* discipline. Different verb.
2. **Anchor on AX (Agent Experience)** as the umbrella, but **don't claim "first AX testing platform"** — that flag is already contestable.
3. **The defensible wedge is the empty slot:** a self-serve, CI-native, *cross-harness* tool a team runs on *its own* product, continuously. Everything that exists today is either a static audit or an editorial benchmark.

---

## 1. What we're building (one breath)

Point a reference agent at a SaaS product, give it realistic tasks ("send a transactional email", "create an issue and assign it"), and measure whether it can complete them using only what the product exposes (docs, API, MCP, SDK, CLI). Output: a success rate, the specific failure points, and which doc/schema fixes close the gap. Run it again after every docs or API change.

The mental model is **the integration test for Agent Experience** — as opposed to the *lint* (static audits) or the *review* (editorial benchmarks).

---

## 2. Naming decision — why NOT "AEO"

"AEO" is a muddy, contested acronym pulling in three directions:

| Flavor | What it means | Layer |
|---|---|---|
| **Answer Engine Optimization** | Get cited in AI answers (ChatGPT, AI Overviews) | Discovery / visibility |
| **Agentic Engine Optimization** (marketing) | Be the tool/source the agent *selects* and transacts with | Discovery / selection |
| **Agentic Engine Optimization** (Osmani / dev) | Structure technical content so coding agents can *use* it | Static interface prep |

Addy Osmani's April 2026 framing is the closest to our space — structuring/serving technical content so coding agents can use it — but it's still about **static preparation**: token budgets, `llms.txt`, `AGENTS.md`, markdown-first, `robots.txt`. ([Osmani](https://addyosmani.com/blog/agentic-engine-optimization/), [Search Engine Land](https://searchengineland.com/agentic-engine-optimization-google-ai-director-474358))

**The real fault line isn't "search vs not." It's optimize vs test.** Every flavor of AEO tells you how to *structure your stuff*. We tell you, empirically, *whether an agent actually succeeds*. AEO is the lint side; we're the integration-test side.

> ⚠️ If we brand around "AEO" we inherit a search/optimization connotation that fights our actual category.

---

## 3. The three-layer market map (where SaaS must win in the agent era)

A SaaS product has to win on three distinct layers as agents become the primary operators of software:

1. **Discovery / selection** — *will an agent even pick you?* → this is AEO / GEO territory (search, citation, ranking).
2. **Interface exposure** — *do you expose machine-operable surfaces?* (MCP, CLI, OpenAPI, SDKs, docs, `llms.txt`, `AGENTS.md`) → this is **AX / agent-readiness** design territory.
3. **Operational success** — *once an agent tries, does the task actually complete?* → **this slot is empty. This is us.**

We live in **Layer 3, verifying Layer 2.** The key reframe: **exposing capabilities ≠ them working.** A company can ship MCP + CLI + docs and still have agents fail end-to-end. We're the thermometer for that gap.

Market context worth knowing: Forrester has been quoted declaring "SaaS as we know it is dead", with the catalyst being that agents are becoming the primary operators of software. The "expose your capabilities to agents" thesis is real and VC-backed — our bet is on the *verification* of it.

---

## 4. The umbrella — AX (Agent Experience)

- Coined by **Mathias Biilmann (Netlify), Jan 2025**. ([biilmann.blog](https://biilmann.blog/articles/introducing-ax/), [agentexperience.ax](https://agentexperience.ax/))
- Now adopted by Sequoia, Bessemer (BVP); first AX job postings have appeared.
- Broader than AEO and **already includes "operate"** in its standard definitions — e.g. Stainless frames AX as how agents *discover, comprehend, implement, and autonomously operate* your API, and explicitly includes the mechanisms humans use to keep agents *operating correctly and continuously improving*. ([Stainless](https://www.stainless.com/blog/steps-toward-great-agent-experience-every-api-provider-can-take-today), [Nordic APIs](https://nordicapis.com/what-is-agent-experience-ax/))

**Why AX over AEO for us:** AX is the rising, dev-side, investor-backed umbrella whose own definition already covers operation and continuous verification. Riding it is tailwind; coining a rival optimization term is a fight.

**Headline minimal-change move:** reframe our prior "behavioral AEO testing" → **"behavioral AX testing"** / **"agent-operability testing."** Keeps our static-vs-behavioral differentiation; swaps the wrong umbrella for the right one.

---

## 5. Competitive landscape — what already exists

The space is **not** virgin territory. There's an ecosystem site ([agentexperience.ax](https://agentexperience.ax/)), a design standard with an installable audit skill ([axd.md](https://axd.md/)), Cloudflare's "Agent Readiness" score ([blog.cloudflare.com](https://blog.cloudflare.com/agent-readiness/)), and SDK companies (Stainless, Speakeasy) evangelizing "run evals on your AX."

Everything that exists falls into **two buckets, and neither is our shape:**

### Bucket A — Static audits (= lint)
- **Cloudflare Agent Readiness score** ([isitagentready.com](https://isitagentready.com/), launched 2026-04-17) — the canonical example. A Lighthouse-style audit scoring a site on four dimensions: Discoverability (robots.txt, sitemap, Link headers), Content (markdown content negotiation), Bot Access Control (Content Signals, Web Bot Auth), Capabilities (MCP Server Card, API Catalog, OAuth discovery, Agent Skills). It checks *whether the plumbing/standards are in place* — Layers 1–2 — and **never runs a task.** This is "more AEO than us."
  - Note: Cloudflare *did* run a one-off behavioral benchmark internally (an agent via OpenCode answering technical questions against rival docs' `llms.txt`, measuring tokens/speed/accuracy) — but that was a marketing exercise, **not a product they sell.** Even Cloudflare productized only the static audit; the behavioral test stayed a demo.
- **axd.md** AX design standard + an installable audit skill that scores any site against its principles.
- Osmani's `agentic-seo` style audits, Dashform-style "AX score."
- These check *structure against principles*. They don't run tasks.

### Bucket B — Editorial benchmarks (= reviews / Wirecutter)
- **Tech Stackups "AX Benchmark"** ([techstackups.com](https://techstackups.com/guides/introducing-ax-benchmark-agent-experience/), 2026-01-26).

#### Tech Stackups AX Benchmark — RESOLVED: it's content, not a competitor
Threat assessment done (2026-05-29). The Jan 26 article laid out a *method* near-identical to ours — give a coding agent (Claude Code) the task "integrate this service from scratch"; measure time-to-integration, human interventions, iterations; starting category email platforms (Resend, SendGrid, Postmark, SES, Mailgun), overlapping our MVP starter. **But the promised recurring benchmark never shipped.** Their `/guides/` feed after Jan 26 is scattered one-off tutorials (Telegram bots, agent password security, WordPress automation) — no email benchmark, no series. Multi-author Docusaurus blog; the benchmark piece is bylined "Claude." Verdict: **an AI-content/SEO site that published a one-off framing piece, not a product. Threat downgraded.**

- ✅ *Still useful as validation + inspiration* — they converged on the same wedge, and one later post ("[Do Agents need Quickstart Guides?](https://techstackups.com/guides/agents-still-need-docs/)", Apr 13) is a clean mini-version of the behavioral comparison we'd productize: same app integrated with vs. without a quickstart, measuring cost/context/recommended-path.
- Their 5-metric framework (discoverability, sign-up, onboarding, API design, SDK/tooling) is a decent starting rubric to borrow from.

**The still-open slot:** a tool the SaaS runs *on itself*, *continuously*, *in CI*, *across multiple agent harnesses*. Benchmark ≠ platform; someone testing you ≠ you testing yourself. Nobody — including Cloudflare — sells this.

### Signals — big players are moving (NEW, 2026-05)
- **Anthropic acquired Stainless** (announced 2026-05-18; reported >$300M per *The Information*). Stainless generated official SDKs/CLIs/MCP servers for Anthropic, OpenAI, Google, Cloudflare and others. Anthropic is **winding down all hosted Stainless products** (incl. the SDK generator) for external customers; the team joins Anthropic.
  - **What it means for us:**
    - Stainless was never a competitor — they *generate* the interface (Layer 2), we *test* it (Layer 3) — and now they're absorbed, so a vocal "run evals on your AX" evangelist exits with the practice still unproductized. Mild tailwind.
    - Bigger picture: a frontier lab just bought the factory for "API spec → agent-usable SDK/MCP/CLI." This validates that making products agent-operable is strategically hot — but the bet is on the *generation/exposure* side, **not** verification. Our slot stays open.
    - ⚠️ *Watch the labs.* Owning the generation layer is a natural adjacency into verification. No sign of it yet (this move read as control + DX), but it's a real long-term risk vector.

---

## 6. What DevRel / Docs teams test today (and the hole)

Important for sales: we're not displacing an existing tool, we're filling an admitted gap. Current testing splits into three layers — **all human or static** — and a fourth that's empty.

**Layer 1 — API functional testing** (owned by engineering, not docs)
Postman, Pact, StackHawk, Bruno. Tests whether endpoints behave (status codes, schema, contract). Nothing to do with doc comprehensibility.

**Layer 2 — Docs surface testing** (DevRel / tech-writing main battlefield — all static)
- **Code-sample CI** — confirm examples still run / don't go stale after an API change. This is the most mature docs automation, but it only verifies "this snippet compiles / returns 200," not "an agent can assemble the correct call from the docs." ([Document360](https://document360.com/blog/api-documentation/))
- Link checking, prose linting (Vale) — pure structure.
- Analytics / GitHub issues — reactive, not testing.
- OpenAPI spec sync — contract accuracy, not readability.

**Layer 3 — Human comprehension testing** (the gold standard, rarely done)
The field's own best-practice advice is to sit a few developers who've never used your API in front of the docs before a major release and watch where they hesitate — treating every hesitation as a doc bug. It also openly admits internal review catches typos but misses what actually matters. ([Document360](https://document360.com/blog/api-documentation/)) But Layer 3 is expensive, slow, non-CI, and non-recurring — so most teams skip it.

**Layer 4 — Agent comprehension testing → EMPTY**
No product asks: *"Using your docs as they are right now, can an AI agent complete a real task end-to-end?"*

### Two insights this hands us
1. **We are the automation of Layer 3 — for agents instead of humans.** The field already believes Layer 3 is the test that matters and that Layer 2 is insufficient; they just can't afford Layer 3 manually. That's our pitch, in their own words.
2. **Code-sample CI looks like us but isn't.** It tests "does this snippet mechanically run." We test "can an agent, with no hand-holding, infer the correct usage from the docs" — which is harder and is how agents actually work.

---

## 7. Positioning — what we can / cannot truthfully claim

**Cannot say:** "the first AX testing platform." (Tech Stackups benchmark exists; "run evals on your AX" is already evangelized. A sharp investor punctures this in seconds.)

**Can say** (narrower, defensible):
- *"The AX integration-test layer — audits lint your structure, benchmarks review you from outside; we let your own team run real agents against your own product, continuously, in CI."*
- *"The first **cross-harness** AX testing tool — others run one agent and rank you; we tell you your docs score 81 in a RAG harness and 38 in a minimal one, and which fix closes the gap."*

**Meta-principle:** don't anchor identity on "first" (a land-grab claim, checkable, and one we'd currently lose). Anchor on the **function we uniquely own** — "the [X] layer of AX." When the land already has squatters, *position > land-grab*.

### Candidate descriptors / names (unranked)
- Category descriptor: **behavioral AX testing**, **agent-operability testing**, **agent integration testing**
- Consumer hook (caniuse mental model): **agent compatibility** — "does your product work in Cursor? Claude Code?"
- Brandable: **Probe / AgentProbe** (agent-as-probe), **Assay** (a test/measurement; low dev-tool collision). Avoid: **Reagent** (collides with the ClojureScript lib), **Litmus** (email testing), **Crucible** (Atlassian).

---

## 8. The sales hook (DevRel-facing)

> "You already have code-sample CI — it tells you your code *runs*. We tell you agents can actually *use* your docs. Those are not the same thing."

---

## 9. Open questions / decisions needed

- [x] ~~**Final category term + product name.**~~ DONE (2026-05-29): Working name is **AX eval**; category is "behavioral AX testing."
- [x] ~~**Threat assessment on Tech Stackups.**~~ DONE (2026-05-29): AI-content/SEO site, promised benchmark never shipped, not a product competitor. See §5.
- [~] **Harness strategy.** Approach decided (orchestrate real CLIs headlessly via per-harness adapters; no cloning — see §11 + `product-spec.md`). Still open: exact launch set + how to formalize the "harness feature-space" axes.
- [~] **Wedge category.** First *target* chosen: **Asana** (issue/work tracking), picked partly because its state is API-queryable → high programmatic-oracle coverage (§12.2), and it sidesteps the email overlap with Tech Stackups. Still open: whether to broaden to a full "work tracking" category (Linear, Monday, Jira) for the comparison story.
- [x] ~~**Static vs behavioral scope.**~~ DONE (2026-05-29, §12.4): all three layers, ranked — static = free top-of-funnel hook, behavioral = paid core/moat, editorial = marketing. The sellable asset is the static-high × behavioral-low *gap*.
- [ ] **Self-serve vs services.** Day-1 self-serve product, or start as a high-touch eval-for-hire to learn, then productize?
- [ ] **What's the unit of value sold?** Agent success rate? Regression alerts? A score badge? CI gate?
- [ ] **Where exactly is the open/closed line?** (§11 has the v0 split; needs a hard call on how capable the free skill is before it cannibalizes the paid tier.)
- [ ] **Who blesses the harness standard?** Us + design partners, or a push toward a community standard? Determines whether it's a real moat.

## 10. Next steps

- [ ] Spend ~1 hour reviewing the three closest references first-hand: Tech Stackups AX Benchmark, axd.md, Osmani's framework. Decide which slot we occupy.
- [x] ~~Draft the cross-harness testing design doc.~~ Done → see `product-spec.md`.
- [ ] Build the "damning demo": same task set across one good / one mediocre / one bad SaaS, show the success-rate gap and failure points.
- [ ] Revisit the older product-thinking doc — its framing still uses AEO and is now inconsistent with this log.

---

## 11. Product direction — initial architecture decisions

High-level decisions from the product session. Full buildable detail lives in **`product-spec.md`**; this is the summary so the narrative stays in one place.

**Shape:** open skill (distribution) + a versioned cross-harness *standard set* (differentiation) + BYOK (cost) + self-run (GTM). The skill is the **funnel, not the product.**

**Open / closed boundary (the decision that makes it a business, not just an OSS repo):**
- *Open* — the skill / local runner, the harness-standard definitions, the task schema, single-shot single-harness local runs (no data retained).
- *Paid / hosted* — continuous + CI + history (regression alerts), the full cross-harness matrix at scale, diagnosis + fix suggestions, and industry percentile benchmarks. These only work as a hosted service.

**Harness orchestration — decided:** we **do not clone or reimplement** harnesses. Both launch targets run headlessly already — Claude Code (`claude -p` / Claude Agent SDK) and Codex (`codex exec`). We build a thin **adapter per harness** (launch headless → inject BYOK → normalize transcript/result into a common schema). The adapter + normalization + version-pinning layer *is* the harness standard set, and it's the real engineering moat. Cloning would drift from the real product and destroy the fidelity that makes scores credible.

**Harness mix:** brand-name (Claude Code, Codex) for credibility + a couple of OSS harnesses (Aider, OpenHands, Goose, Cline…) for cheap, version-pinnable breadth + one *synthetic minimal* harness as a deliberate worst-case floor. Choose the set to span the axes that actually change doc consumption (retrieval strategy, tool access, context window, model) — not just famous names.

**BYOK:** use **API keys, not subscription/session auth** for automated runs (both vendors point automation at API keys). Local = drive whatever CLIs the user has installed; hosted = containers with the harness fleet preinstalled + version-pinned. Give users a spend cap — CI re-runs burn real tokens on their key.

**Telemetry / data flywheel:** collect **metrics, not secrets** (pass/fail, scores, harness, target name — never keys, proprietary docs, or full transcripts). *Opt-in* on the free tier (off by default); *by-design-with-disclosure* on hosted. The real flywheel is the hosted tier — don't bank the data moat on free-tier opt-in.

---

## 12. Oracle credibility, first target, the sandbox question, and the open skill

Working session (2026-05-29). This section captures four linked decisions that came out of pressure-testing the v0 plan. The buildable detail for the open skill is split out to **`skill-spec.md`**.

### 12.1 The success oracle is the whole ballgame — define "programmatic" precisely
The credibility of every score reduces to one thing: **how we decide a task succeeded.** Two kinds of oracle:

- **Programmatic oracle (preferred):** after the run, **query the real service with code** and assert the world actually changed as required → a deterministic true/false. We do *not* read what the agent claimed; we check reality. Immune to an agent that confidently says "done!" without doing it.
- **LLM judge (fallback only):** hand the transcript to a model and ask "did it succeed?" Subjective, gameable by a confident agent, low reproducibility.

This was implied in `product-spec.md` §7 ("programmatic > llm_judge") but under-specified, and it is the single point on which the product lives or dies. **The oracle coverage of a category — what fraction of realistic tasks get a programmatic (not LLM-judge) check — is the gating constraint on whether we should enter that category at all.**

### 12.2 First target: Asana — chosen partly *because* it makes the oracle easy
Asana is the v0 reference target. The decisive reason is oracle-friendliness: nearly every Asana action (create task, assign, set a custom field, move to a section, create a webhook…) **leaves state that is queryable back via the API**, so most tasks get a clean programmatic oracle instead of degrading to an LLM judge. (Contrast "send an email," our earlier candidate, where verifying success means actually inspecting an inbox.) Picking Asana quietly de-risks the hardest part of the product.

Asana also exposes docs / REST API / OpenAPI / SDK / (official) MCP simultaneously — which doubles as a ready-made *feature-space* experiment: run the same task restricted to docs-only vs. MCP vs. SDK and watch the score move (the spec §4.4 "test the interface shape, not the famous name" idea).

Example task + its oracle, in words: *"In project `QA Sandbox`, create a task named `Ship v0`, assign it to user@example.com, due next Friday — docs/API only, don't ask for help."* → oracle queries the project, finds the task by name, asserts `assignee.email` and `due_on`. Boolean. No judgment.

### 12.3 The sandbox / provisioning question — we do NOT provision a sandbox for every SaaS
Raised: "I can register an Asana test account by hand, but does *every* SaaS need someone to hand-build a sandbox?" Resolved by separating personas:

| Mode | Who runs it | Who supplies the target account + key | Do *we* hand-build a sandbox? |
|---|---|---|---|
| **A. Self-test** (paid core) | the SaaS vendor, on its own product | the vendor (they already have staging / test workspaces / keys) | **No** — they BYOK *and* bring their own sandbox |
| **B. Benchmark / damning demo** (our marketing) | us, against someone else's product | we sign a few up by hand | Yes, but **one-off, a handful** — this is the services/GTM motion, acceptable |
| **C. Free skill** (funnel) | any developer | the user (their own product, or a test account they made) | Not our job — the skill only *consumes* a key the user supplies |

Key reframe: **provisioning accounts is not a cost we have to scale.** Most SaaS ship a test/sandbox mode (Stripe test mode, Asana free workspace, GitHub test org); the user/vendor already has one. The tool consumes a user-supplied key; it does not open accounts.

What genuinely *is* per-target work is **not the sandbox** — it's the **target pack**: the programmatic oracle code, the setup/reset hooks, and the declaration of which surfaces the target exposes. That cost is real, but it is **crowd-sourceable**: we define the format, the community/vendors fill it in. Asana is simply the *first reference target pack*. (This is the bridge to §12.5.)

### 12.4 Scope decision: static + behavioral + editorial — but with clear hierarchy
Closes the long-open question (§9 "static vs behavioral scope"). Answer: **all three layers, but ranked**, so we don't become a do-everything blur.

1. **Static layer** (borrow from Cloudflare Agent Readiness / axd.md) — **top-of-funnel, free, a hook.** "Do you have llms.txt / OpenAPI / MCP / AGENTS.md." Instant, zero-cost, shareable. It is *bait, not the product* — anyone can clone a static audit.
2. **Behavioral layer** (real agent operation + programmatic oracle, cross-harness) — **the core, the moat, the paid thing.** This is what nobody else sells.
3. **Editorial / comparison layer** (borrow from Tech Stackups) — **marketing ammunition**, not a daily product feature ("Asana 81 in Claude Code, 38 in a minimal harness"; "Asana vs Linear vs Monday").

The crucial move: **static and behavioral must corroborate each other.** The strongest, uniquely-ours story is the *gap* between them — *"your static Agent Readiness is 92 (green), but an agent trying to create a task with a custom field succeeds 3 times out of 10."* Static high-score alone is Cloudflare's game (we lose); **static-high × behavioral-low is the sellable delta** and the empirical version of our core thesis "exposing capabilities ≠ them working" (§3).

### 12.5 The open-source skill — direction (detail in `skill-spec.md`)
The free skill is the **funnel, not the product** (consistent with `product-spec.md` §3). Open-sourcing it does three jobs: win distribution (stars), drive adoption of our **task / target-pack / adapter / RunResult schemas** (schema adoption = standard adoption = the real moat), and — critically — **solve §12.3's scaling by letting the community/vendors contribute target packs.**

The skill's core deliverable is not the runner code; it's **four schemas** that become a de-facto standard once adopted:
1. **Task definition** (one task + its programmatic oracle),
2. **Target pack** (surfaces + BYOK + setup/reset + the oracle checks) — *this* is the abstraction that answers "who builds a sandbox for every SaaS": nobody central does; the format is open and anyone fills it,
3. **Harness adapter interface** (launch headless → inject BYOK → normalize),
4. **Normalized RunResult** (cross-harness comparable scoring).

Deliberately held back to protect the paid tier (per §3): hosted at-scale cross-harness matrix, history/regression alerts, industry percentiles, and full diagnosis/auto-fix (open skill gives a teaser only). One flagged tension: target packs contain **executable** oracle/setup code that runs on the user's machine, so the open ecosystem needs a sandbox/permission boundary (spec §5) or a contributed pack becomes a malware vector. See `skill-spec.md` for the full shape.

---

## Appendix A — Glossary

- **AEO** — Agentic / Answer Engine Optimization. Optimization for being *found/selected/structured*. Discovery-layer. Not us.
- **GEO** — Generative Engine Optimization. Broader umbrella over AEO; visibility in generative answers.
- **AX** — Agent Experience. How agents discover, comprehend, and *operate* a product. Our umbrella.
- **DX** — Developer Experience. The human predecessor of AX.
- **Harness** — the agent scaffolding (model + tools + retrieval + loop) doing the task. Same docs can pass in one harness and fail in another — hence cross-harness testing.
- **Static audit** — checking structure against principles (lint). **Behavioral test** — running real tasks and measuring success (integration test).
- **Agent Readiness (Cloudflare)** — a static, Lighthouse-style audit of *standards adoption* (isitagentready.com). Layers 1–2, not behavioral. A Bucket-A reference, not our category.
- **BYOK** — bring your own key: the customer supplies their own model/API credentials, so they (not us) pay for and control the agent runs.
- **Skill** — a portable, installable instruction+tool bundle an agent loads to perform a task (cf. axd.md's audit skill, Cloudflare's published skills). A candidate distribution form for our harness.
- **Adapter** — a thin per-harness wrapper that launches a harness headlessly, injects BYOK, and normalizes its transcript/result into our common schema. The set of adapters + normalization + version pins *is* the "harness standard set."
- **Telemetry** — run data reported back to us (scores, pass/fail per task, harness, target) that powers history and industry-percentile benchmarks. Metrics, never secrets. Opt-in on free; by-design-with-disclosure on hosted.
- **Oracle** — the judge that decides whether a task succeeded. **Programmatic oracle**: assert against the real service's state via code (deterministic true/false). **LLM judge**: ask a model to grade the transcript (fallback; subjective, gameable). Oracle coverage gates category credibility (§12.1).
- **Target pack** — the per-target bundle that makes a SaaS testable: declared surfaces (docs/API/MCP/SDK), BYOK config, setup/reset hooks, and the task set with their programmatic oracles. Crowd-sourceable; the open format is how testing scales across SaaS without us provisioning each one (§12.3, `skill-spec.md`).

## Appendix B — Sources

- Osmani, Agentic Engine Optimization — https://addyosmani.com/blog/agentic-engine-optimization/
- Search Engine Land on Osmani's AEO — https://searchengineland.com/agentic-engine-optimization-google-ai-director-474358
- WEF, agentic engine optimization (marketing flavor) — https://www.weforum.org/stories/2026/01/new-era-of-performance-marketing-how-brands-are-repositioning-for-agentic-engine-optimization/
- Biilmann, Introducing AX — https://biilmann.blog/articles/introducing-ax/
- Agent Experience hub — https://agentexperience.ax/
- AX Design standard — https://axd.md/
- Stainless, steps toward great agent experience (good reference; note: Stainless acquired by Anthropic 2026-05, blog now frozen) — https://www.stainless.com/blog/steps-toward-great-agent-experience-every-api-provider-can-take-today
- Nordic APIs, What is Agent Experience — https://nordicapis.com/what-is-agent-experience-ax/
- Speakeasy, designing agent experience — https://www.speakeasy.com/blog/agent-experience-introduction
- Cloudflare, Agent Readiness score — https://blog.cloudflare.com/agent-readiness/
- Cloudflare, isitagentready.com (the live audit tool) — https://isitagentready.com/
- Tech Stackups, AX Benchmark (one-off framing piece) — https://techstackups.com/guides/introducing-ax-benchmark-agent-experience/
- Tech Stackups, "Do Agents need Quickstart Guides?" (useful behavioral mini-experiment) — https://techstackups.com/guides/agents-still-need-docs/
- Anthropic, "Anthropic acquires Stainless" — https://www.anthropic.com/news/anthropic-acquires-stainless
- TechCrunch on the Stainless acquisition — https://techcrunch.com/2026/05/18/anthropic-has-acquired-the-dev-tools-startup-used-by-openai-google-and-cloudflare/
- Document360, API documentation guide (testing practices) — https://document360.com/blog/api-documentation/
