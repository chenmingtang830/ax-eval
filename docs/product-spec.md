# Product Spec — SDK Agent Readiness Eval Platform

**Product name:** SDK Agent Readiness Eval (short handle: **AX eval**). Referred to here as **"the platform."**
**Date:** 2026-05-29 · **Updated:** 2026-05-31 · **Status:** v0 draft for team review
**Companion doc:** `ax-testing-discussion-log.md` (positioning, market map, competitive landscape — read that first for the *why*; this doc is the *what* and *how*).

> **Headline:** Is your SDK agent ready?
> **Subject:** We run real agents against your SDK and tell you where they fail and how to improve.

> Scope of this doc: the buildable shape of the product. It encodes decisions made so far and flags what's still open. Anything marked **OPEN** is not yet decided.

---

## 1. What it is (and isn't)

**Is:** a tool that runs real agent harnesses against a SaaS product's full SDK surface (docs, API/OpenAPI, MCP, SDK libraries, CLI), gives each a realistic task, and measures whether the agent can complete it — across multiple harnesses, continuously, with diagnosis of *why* it failed and *what to fix*.

**Isn't:**
- A static audit (does your site have `llms.txt` / good structure). That's Cloudflare's Agent Readiness, axd.md, etc. — Layers 1–2, "lint."
- An editorial benchmark (a third party ranks vendors and publishes). That's Tech Stackups.
- A code-sample CI tool (does this snippet compile). That tests mechanical execution, not agent comprehension.

**Mental model:** the **integration test for Agent Experience.** Audits lint; benchmarks review; we run the real thing and tell you if it works.

---

## 2. Architecture overview

The pipeline, end to end:

```
  ┌─────────┐   ┌──────────────┐   ┌──────────────────────┐   ┌────────────┐
  │ Ingest  │──▶│ Task         │──▶│ Harness orchestration│──▶│ Execution  │
  │ target  │   │ synthesis /  │   │ (the matrix)         │   │ (BYOK,     │
  │ surfaces│   │ curation     │   │  N harnesses ×       │   │  sandboxed)│
  └─────────┘   └──────────────┘   │  M tasks × K attempts│   └─────┬──────┘
                                    └──────────────────────┘         │
        ┌────────────────────────────────────────────────────────────┘
        ▼
  ┌────────────┐   ┌───────────┐   ┌──────────────┐   ┌──────────────────┐
  │ Evaluation │──▶│ Diagnosis │──▶│ Reporting +  │──▶│ Continuous / CI  │
  │ (scoring)  │   │ (why fail,│   │ history /    │   │ (regression      │
  │            │   │  what fix)│   │ benchmarks   │   │  alerts on diff) │
  └────────────┘   └───────────┘   └──────────────┘   └──────────────────┘
```

Each stage is described below. The **harness orchestration + execution** stages are the differentiator; **diagnosis** is the higher-value moat layer; **continuous/CI + history + benchmarks** is what makes it a recurring product.

---

## 3. The open / closed boundary

This is the decision that makes the platform a business rather than an OSS repo. The skill is the **funnel, not the product.**

| Layer | Open (free) | Closed (paid / hosted) |
|---|---|---|
| Skill / local runner | ✅ | — |
| Harness-standard definitions + task schema | ✅ (spec is public) | — |
| Single-shot, single-harness local run | ✅ (no data retained) | — |
| Full cross-harness matrix at scale | — | ✅ (we host the fleet) |
| Continuous runs + CI integration | — | ✅ |
| History / regression alerts ("84→61 on this PR") | — | ✅ |
| Diagnosis + fix suggestions | limited / teaser | ✅ (full) |
| Industry percentile benchmarks | — | ✅ (needs aggregate data only we hold) |

**OPEN:** exactly how capable the free skill is before it cannibalizes the paid tier (log §9).

### Tiers
- **Free open skill** — local, single-harness, no history. Wins distribution, GitHub stars, and (the real prize) adoption of our harness standard.
- **Paid hosted** — the matrix + CI + history + diagnosis + peer percentile. The business.

---

## 4. Harness standard set (the moat)

### 4.1 No cloning — orchestrate the real harnesses
We **do not reimplement** harnesses. A clone drifts from the real product and destroys the fidelity that makes scores credible (the whole point is testing what users actually use). Both launch targets already run headlessly:

- **Claude Code** — non-interactive via `claude -p` / `--print`; the Claude Agent SDK also exposes the same loop as CLI + Python/TS, with `text|json|stream-json` output and `--max-turns` for cost control. Needs Node 22+ and an API key. ([docs](https://code.claude.com/docs/en/headless))
- **Codex** — non-interactive via `codex exec`, with `--sandbox` levels (`read-only` / `workspace-write` / `danger-full-access`) and `--output-schema` for structured JSON. CLI is open source (`openai/codex`); API keys are the recommended automation auth. ([docs](https://developers.openai.com/codex/noninteractive))

### 4.2 The adapter pattern
For each harness we build a thin **adapter**: launch headless → inject BYOK → parse the native transcript/result into a **common normalized schema**. The set of adapters + the normalization layer + version pinning **is** the harness standard set. This is the real engineering moat — annoying to build and to keep current as both CLIs ship weekly.

```typescript
interface HarnessAdapter {
  name: string;          // "claude-code"
  version: string;       // pinned, e.g. "claude-code@1.0.x"
  featureProfile: FeatureProfile;   // see 4.4

  // Shell out headless (e.g. `claude -p ... --output-format json` or
  // `codex exec ... --output-schema ...`), capture transcript + tool calls,
  // normalize into a RunResult.
  run(task: Task, workdir: string, env: Record<string, string>): Promise<RunResult>;
}
```

### 4.3 The harness mix
- **Brand-name** (Claude Code, Codex) → credibility; "the agents people actually use."
- **OSS** (Aider, OpenHands, Goose, Cline, SWE-agent…) → cheap, scriptable, version-pinnable, no ToS friction; represents the DIY/OSS-integrator class; fills out the matrix. (Codex CLI is itself OSS, so the line is already blurry.)
- **Synthetic minimal** (plain model + barebones scaffold, *not* a clone) → a deliberate worst-case floor and a fixed, reproducible baseline. Powers the spread story: "81 in Claude Code, 38 in a minimal harness."

### 4.4 Feature-space, not famous names
"Cross-harness" only means something if harnesses differ on axes that actually change how a product's surface gets consumed. Define each harness by a **feature profile** and pick the set to *span* the space:
- **Retrieval strategy** — fetches `llms.txt` / markdown negotiation vs grep vs full-context dump
- **Tool access** — web fetch? MCP client? shell?
- **Context window**
- **Model** (and reasoning effort)
- **Autonomy / permission model** (asks vs full-auto)

### 4.5 Versioning
Everything pinned and dated. A score is meaningless without `harness@version` + `model` + `standard-set@version`. Re-runs on a new harness version are a *first-class event* (could move scores; surface as "harness drift" vs "your-product drift").

---

## 5. Execution & BYOK

- **BYOK = API keys, not subscription/session auth.** Both vendors point automation at API keys; subscription auth has ToS/rate-limit issues and (for Claude) separate metering for SDK/`-p` usage as of 2026-06-15. Users supply their own keys → they pay for and control inference.
- **Local execution (free):** the runner drives whatever CLIs the user already has installed + authed. Most have one, maybe two → no real cross-harness locally. Local = "test against what's on your machine."
- **Hosted execution (paid):** containers with the full harness fleet preinstalled and version-pinned; user supplies keys; we run the matrix reproducibly. *This is why cross-harness belongs in the paid tier — nobody wants to self-host a harness fleet.*
- **Sandboxing:** runs happen in isolated containers (`codex exec --sandbox workspace-write`, Claude Code with restricted `--allowedTools`). Network access scoped to the target service + docs.
- **Spend caps:** expose `--max-turns` / attempt limits / per-run budget. CI re-runs burn real tokens on the user's key — make cost visible and bounded.

---

## 6. Task synthesis & curation

- Tasks are realistic, goal-level jobs a real integrator would do ("send a transactional email," "create an issue and assign it," "set up a webhook and verify delivery").
- **Sources:** (a) auto-synthesized from the target's docs/API/OpenAPI, (b) curated per category, (c) drawn from real support tickets / common quickstart paths.
- Each task needs a machine-checkable **success oracle** (see §7). A task without a verifiable oracle doesn't ship.
- Tasks are **category-scoped** (email, issue tracking, payments…) so we can build per-category benchmarks and percentiles.

```yaml
# task definition (sketch)
id: resend-send-transactional-email
category: email
target: resend
prompt: >
  Send a transactional email to test@example.com with subject "Hi" and a
  simple HTML body, using only the official docs/API. Do not ask for help.
setup:
  env: [RESEND_API_KEY]        # BYOK against a test account
  allowed_surfaces: [docs, api]
success_criteria:
  type: programmatic            # preferred; falls back to llm_judge
  assert: checks/resend_email_received.ts
limits:
  max_turns: 25
  attempts: 3                   # for pass@k / variance
```

---

## 7. Scoring & metrics

Per task × harness × attempt, capture:

- **Task success** (the headline) — did it complete to spec? Verified by the oracle: **programmatic assertion against the real service** (did the email actually arrive? did the issue exist?) > LLM judge on transcript (fallback).
- **Autonomy** — did it finish without getting stuck / asking for clarification / dead-ending? (Proxy for "would a human have had to step in.")
- **Efficiency** — turns/steps, wall-clock, tokens, cost.
- **Robustness** — variance across K attempts (pass@k); flaky ≠ reliable.
- **Failure stage + reason** — taxonomy (see §8).

Roll-ups:
- **Per-harness pass rate** → an **AX score** per harness.
- **Cross-harness spread** — the signature output ("81 / 62 / 38 across the matrix").
- **Trend over time** — the regression line; the thing CI alerts on.
- **Category percentile** — "p40 among email APIs" (hosted, needs aggregate data).

```json
// normalized RunResult (sketch)
{
  "task_id": "resend-send-transactional-email",
  "harness": "claude-code@1.0.x",
  "model": "claude-opus-4-x",
  "standard_set": "v0.1",
  "attempts": 3, "passed": 2, "pass_rate": 0.67,
  "turns_median": 9, "tokens": 48000, "cost_usd": 0.14, "wall_clock_s": 73,
  "failures": [
    {"attempt": 2, "stage": "auth_setup",
     "reason": "could not determine where the API key is configured",
     "evidence_ref": "transcripts/....jsonl#L120"}
  ]
}
```

---

## 8. Diagnosis & fix (the higher-value layer)

Don't stop at "task failed." Attribute and prescribe:

- **Failure taxonomy** (stage): discovery, auth/setup, wrong endpoint, schema misunderstanding, missing/incorrect example, hallucinated param, multi-step ordering, ambiguous docs, rate-limit/error-handling.
- **Attribution:** is this a *doc* gap, a *schema/OpenAPI* ambiguity, or a *product* gap? Cluster failures across attempts/harnesses to find the systemic cause (if every harness trips on the same step, it's the docs, not the agent).
- **Fix suggestion:** concrete — "add a quickstart for X," "this field's description is ambiguous, suggest: …," eventually **auto-draft the doc patch / better example / improved tool schema**. This is the LLM-native moat from the strategy doc.

---

## 9. Telemetry & data model

- **Collect metrics, not secrets:** pass/fail, scores, harness, target name, failure taxonomy. **Never** keys, proprietary docs, or full transcripts (transcripts stay client-side / in the user's own storage unless they explicitly share for diagnosis).
- **Consent:** *opt-in* on the free tier (off by default, asked once); *by-design-with-disclosure* on hosted (runs go through us; enterprise can opt out of aggregation/benchmarking specifically, not of their own history).
- **Flywheel reality:** the aggregate dataset (→ percentiles) comes mainly from the hosted tier. Don't bank the moat on free-tier opt-in.

---

## 10. GTM (summary — detail in log §7–8)

- **Outbound "damning demo"** creates demand: we run the matrix on a prospect, show the success-rate gap + failures. Nobody tests for a problem they don't know they have.
- **Self-run skill** captures and expands: land bottom-up, grow into hosted/CI.
- **Sales hook:** "You already have code-sample CI — it tells you your code *runs*. We tell you agents can actually *use* your docs."
- **Neutrality is the defense vs. a lab** (esp. Anthropic post-Stainless): we test across Claude/GPT/Gemini/OSS harnesses; a single lab won't do that neutrally.

---

## 11. MVP / phasing

**v0 (prove the wedge + the damning demo):**
- One category: **email** (or a less-contested pick — OPEN, log §9). 3–5 targets (e.g., Resend, SendGrid, Postmark).
- 3 harnesses: **Claude Code + Codex + synthetic minimal.**
- 5–10 curated tasks with programmatic oracles.
- Output: a clean report — per-harness pass rate, cross-harness spread, failure list. This *is* the damning demo.
- Run it ourselves (services-flavored) before any self-serve.

**v1:** the free skill (local, single-harness) + a hosted run that produces history. Add 1–2 OSS harnesses.

**v2:** CI integration + regression alerts + diagnosis/fix + first category percentile.

**Explicitly out of scope for v0:** self-serve onboarding, billing, the full harness fleet, auto-fix, multi-category percentiles.

---

## 12. Open questions (live)

- Open/closed line: how capable is the free skill before it cannibalizes paid?
- Wedge category: email (overlaps Tech Stackups content) vs. something less contested.
- Success oracle coverage: how many realistic tasks can get *programmatic* (not LLM-judge) verification? Determines score credibility.
- Who blesses the harness standard — us + design partners, or a community-standard push? (Determines whether it's a true moat.)
- Pricing unit: per-run? per-seat? per-target? CI-gate subscription?
- "Watch the labs": Anthropic owns the generation layer (Stainless) — monitor for a move into verification.

---

## Appendix — harness command reference (verified 2026-05-29)

- **Claude Code headless / Agent SDK:** https://code.claude.com/docs/en/headless · `claude -p "<task>" --output-format json --max-turns N --allowedTools "..."`
- **Codex non-interactive:** https://developers.openai.com/codex/noninteractive · `codex exec --sandbox workspace-write --output-schema schema.json "<task>"`
- **Codex CLI (OSS):** https://github.com/openai/codex
- Companion: `ax-testing-discussion-log.md`
