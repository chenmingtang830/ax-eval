# Open Skill Spec — AX eval (the open-source runner)

**Working name:** AX eval · **Date:** 2026-05-29 · **Status:** v0 draft for team review
**Companion docs:** `ax-testing-discussion-log.md` (the *why* — read §12 first), `product-spec.md` (the full platform incl. the hosted/paid tier).

> Scope of this doc: the **open-source skill** only — the free, local, single-harness runner that is the **funnel, not the product**. The hosted matrix, history, percentiles, and full diagnosis live in `product-spec.md` and are deliberately *out* of this doc. Anything marked **OPEN** is not yet decided.

---

## 1. Why this is open (and what it is not)

Open-sourcing the skill does three jobs:

1. **Distribution** — stars, bottom-up adoption, "the thing you `npx`/install and run on your own product in 5 minutes."
2. **Standard adoption = the real moat** — if our **task / target-pack / adapter / RunResult** schemas become how people describe "can an agent use this product," we own the standard regardless of who runs it.
3. **Crowd-sourced scale** — the per-target work (oracles, setup/reset, surface declarations) is contributed by the community/vendors as **target packs**. We define the format; we do not hand-build a test harness for every SaaS (see discussion log §12.3).

**The skill is NOT** the business. It is local, single-harness, no history, no hosted fleet, no percentiles, diagnosis-teaser-only. The open/closed line is in §7 and mirrors `product-spec.md` §3.

---

## 2. The deliverable is four schemas, not the runner code

The runner is replaceable; the **schemas are the standard**. Everything else is plumbing around these four contracts.

```
Target Pack ──contains──▶ Task definitions ──run through──▶ Harness Adapter ──emits──▶ RunResult
   (§4)                       (§3)                              (§5)                      (§6)
```

---

## 3. Schema ① — Task definition

A single realistic, goal-level job plus a **machine-checkable success oracle**. A task without a verifiable oracle does not ship (see discussion log §12.1).

```yaml
# tasks/create-and-assign-task.yaml
id: asana-create-and-assign-task
category: work-tracking
target: asana
prompt: >
  In the project "QA Sandbox", create a task named "Ship v0", assign it to
  user@example.com, and set the due date to next Friday. Use only the official
  docs/API. Do not ask for help.
setup:
  allowed_surfaces: [docs, api]        # which surfaces the agent may use this run
  env: [ASANA_PAT]                     # BYOK — the agent's key
success_criteria:
  type: programmatic                   # preferred; `llm_judge` is fallback only
  check: checks/task_assigned.ts       # returns bool against the REAL service
limits:
  max_turns: 25
  attempts: 3                          # for pass@k / variance
```

- `type: programmatic` is strongly preferred. `llm_judge` is allowed only where no programmatic check exists, and packs **must report their programmatic-oracle coverage** (it gates credibility).
- `allowed_surfaces` is what powers the feature-space experiment (docs-only vs MCP vs SDK).

---

## 4. Schema ② — Target Pack (the abstraction that scales)

A target pack makes one SaaS testable. **This is the answer to "does every SaaS need a hand-built sandbox?" — no: the format is open and anyone fills it** (discussion log §12.3). It bundles surface declarations, BYOK config, setup/reset hooks, and the task set.

```yaml
# targets/asana/pack.yaml
id: asana
display_name: Asana
surfaces:
  docs:    https://developers.asana.com/docs
  openapi: https://raw.githubusercontent.com/Asana/openapi/master/defs/asana_oas.yaml
  mcp:     <asana official mcp endpoint>   # VERIFY current availability
  sdk:     node-asana
auth:
  agent_env:  [ASANA_PAT]          # key handed to the agent under test (BYOK)
  verify_env: [ASANA_VERIFY_PAT]   # oracle's verification key; OPTIONAL — falls back to agent_env
setup:  setup.ts                   # ensure/create the sandbox project, return ids
reset:  reset.ts                   # delete entities created during an attempt
tasks:  tasks/*.yaml
```

Design rules:

- **`verify_env` is a separate-key option, not a requirement.** Conceptually the oracle should verify with its own (ideally read-only) key so the agent can't conflate "acting" and "checking" — this matters for targets with scopable keys (Stripe restricted keys, GitHub fine-grained PATs). But many services (incl. **Asana**, whose PATs inherit the full user's permissions and can't be scoped read-only) gain no real isolation from a second same-account key. So `verify_env` is **optional and falls back to `agent_env`**; require a genuinely separate key only where the target actually supports a narrower one.
- **`setup`/`reset` are mandatory for stateful targets.** Without reset, `attempts: 3` and pass@k contaminate each other (attempt 2 "passes" because attempt 1 already created the entity).
- **The pack ships no secrets.** Keys come from the environment at run time, never the repo.
- **Surfaces are gated, not just listed.** The runner restricts the agent to `allowed_surfaces` for a given task so cross-surface comparisons are meaningful.

Asana is the **first reference target pack** — its job is to demonstrate the format and produce the v0 demo, not to be exhaustive.

---

## 5. Schema ③ — Harness Adapter interface

We **do not clone harnesses** (discussion log §11, spec §4). An adapter is a thin wrapper: launch the real CLI headless → inject BYOK → parse the native transcript into the normalized `RunResult`.

```typescript
interface HarnessAdapter {
  name: string;            // "claude-code"
  version: string;         // pinned, e.g. "claude-code@1.0.x"
  featureProfile: FeatureProfile;   // retrieval / tools / context / model / autonomy

  // Is this harness installed + authed on the local machine?
  detect(): Promise<boolean>;

  // Shell out headless (e.g. `claude -p ... --output-format json` or
  // `codex exec ... --output-schema ...`), capture transcript + tool calls,
  // normalize into a RunResult.
  run(task: Task, workdir: string, env: Record<string, string>): Promise<RunResult>;
}
```

Built-in adapters in the open skill:

- **`claude-code`** — `claude -p "<task>" --output-format json --max-turns N --allowedTools "..."` (Node 22+, API key).
- **`codex`** — `codex exec --sandbox workspace-write --output-schema schema.json "<task>"`.
- **`minimal`** — a deliberate worst-case floor: a plain model + barebones scaffold (NOT a clone). Provides a fixed, reproducible baseline and powers the spread story ("81 vs 38").

Everything is **version-pinned**: a score is meaningless without `harness@version` + `model` + `standard_set@version`. A new harness version is a first-class event (surface "harness drift" vs "your-product drift").

---

## 6. Schema ④ — Normalized RunResult

The cross-harness-comparable output. Identical shape regardless of which harness produced it.

```json
{
  "task_id": "asana-create-and-assign-task",
  "target": "asana",
  "harness": "claude-code@1.0.x",
  "model": "claude-opus-4-x",
  "standard_set": "v0.1",
  "allowed_surfaces": ["docs", "api"],
  "attempts": 3, "passed": 2, "pass_rate": 0.67,
  "turns_median": 9, "tokens": 48000, "cost_usd": 0.14, "wall_clock_s": 73,
  "oracle": "programmatic",
  "failures": [
    {"attempt": 2, "stage": "auth_setup",
     "reason": "could not determine where the API key is configured",
     "evidence_ref": "transcripts/....jsonl#L120"}
  ]
}
```

Failure `stage` uses the taxonomy from `product-spec.md` §8 (discovery, auth/setup, wrong endpoint, schema misunderstanding, missing example, hallucinated param, multi-step ordering, ambiguous docs, rate-limit/error-handling).

---

## 7. Open vs closed boundary (what the skill must NOT do)

Mirrors `product-spec.md` §3. The skill is the funnel; the table below is the contract for what stays free.

| Capability | In the open skill | Held back (paid/hosted) |
|---|---|---|
| Local single-harness run (whatever CLI you have) | ✅ | — |
| The four schemas + task/target-pack formats | ✅ (public spec) | — |
| Multiple harnesses locally | ✅ but self-hosted (you install + pay tokens) | hosted version-pinned fleet ✅ |
| History / regression alerts ("84→61 on this PR") | — | ✅ |
| Industry percentile benchmarks | — | ✅ (needs aggregate data only we hold) |
| Diagnosis + fix suggestions | teaser only (name the failure stage) | ✅ full (cluster causes, draft doc/schema patch) |
| Static audit (Cloudflare-style) | ✅ free top-of-funnel hook (log §12.4) | — |

**OPEN:** exactly how capable the local multi-harness path is before it cannibalizes the hosted matrix (log §9).

---

## 8. CLI surface

```bash
axeval run --target asana --harness auto      # auto = detect installed+authed CLIs
axeval run --target asana --harness claude-code --surfaces docs,api
axeval list targets | harnesses | tasks
axeval init-target stripe                      # scaffold a new target pack (invite contributions)
axeval audit --target asana                    # static-only, free hook (log §12.4)
```

Execution flow per `run`: ingest target surfaces → for each task → `setup`/`reset` sandbox → launch harness headless (inject `agent_env`) → capture transcript + tool calls → run the programmatic oracle with `verify_env` → write a `RunResult` → render report (console + JSON).

---

## 9. Safety boundary (do not skip)

Target packs contain **executable** `check` / `setup` / `reset` code, and the open ecosystem invites contributed packs. A contributed pack is therefore an **untrusted-code vector**.

- Run packs in an isolated container (`codex exec --sandbox workspace-write`, Claude Code with restricted `--allowedTools`); network scoped to the target service + its docs (spec §5).
- Never let a pack read the host environment beyond its declared `agent_env` / `verify_env`.
- **OPEN:** a review/signing process for community packs before they're listed as "official."

---

## 10. Phasing (open skill only)

- **v0** — Asana reference target pack (5–8 tasks, programmatic oracles) × `claude-code` + `codex` + `minimal`; console + JSON report; the static `audit` hook. This *is* the "damning demo" engine (spec §11).
- **v1** — publish the four schemas as a versioned `standard_set`; `init-target` + contribution docs; 1–2 more reference packs; 1–2 OSS adapters (Aider, OpenHands…).
- **v2** — stable adapter SDK so third parties ship their own adapters; the skill becomes the on-ramp into the hosted product.

**Out of scope for the open skill (always):** hosted fleet, billing, history storage, percentiles, full auto-fix.

---

## 11. Auto-generation & the drop-a-link UX (v1+)

The north-star free-tier UX (discussion log §13): the developer supplies keys + a docs URL and gets a report, with a **mandatory human review gate** in the middle. v0 is hand-curated (Asana); this is the v1+ shape.

**Flow:**
1. `axeval init --target <docs-url>` — ingest the docs site, discover OpenAPI / `llms.txt` / MCP.
2. `axeval generate` — synthesize an eval set: tasks + drafted oracles + setup/reset, each tagged with an **oracle tier + confidence**.
3. `axeval review` — **required before any run.** Opens the generated `tasks/` + `checks/` for the developer to approve/edit — **by hand or by prompting the AI to revise** (the skill runs inside an agent, so AI-assisted editing is native). Nothing executes un-reviewed, and **an explicit human approval is required regardless of how the edit was made** (no AI-approves-AI). This is the credibility + safety + flywheel gate (log §13.2); the whole set is reviewed (tasks + oracles + setup/reset), presented by confidence tier.
4. `axeval run` — execute the approved set across available harness(es) → report.

**Oracle tiers (what gets auto-drafted, and how it's labeled):**
- **T1 — OpenAPI CRUD round-trip:** derive verification from the spec (POST-create → GET-confirm the fields the task named). Auto, high-confidence, genuinely programmatic — the class that makes drop-a-link produce *real* scores.
- **T2 — weak signal:** "call returned 2xx / no error," or LLM-judge on the transcript. Auto, low-confidence, **always labeled** so a weak check never passes as a strong one.
- **T3 — curated:** human-written (the v0 Asana set; the paid/services layer). Highest confidence.

**Inputs (a docs link alone is not enough — write ops need auth):** harness/model keys (the dev's inference spend) + the product's sandbox auth (API key / OAuth / test account), scoped to a sandbox **not** prod + the docs URL.

**On-ramp to target packs:** a reviewed, edited generated set *is* a target pack (§4) the dev can keep, version, and optionally contribute back — closing the crowd-sourcing loop from §1.

**Safety:** generated `check`/`setup`/`reset` is executable code that will run write ops on the dev's sandbox — the review gate (step 3) **and** the isolation in §10 are both mandatory before first run.

---

## 12. Open questions (skill-specific)

- How capable is local multi-harness before it cannibalizes the hosted matrix? (the open/closed line)
- Distribution form: a Cursor/Claude **skill** bundle, an `npx` CLI, or both? (the word "skill" implies an installable agent bundle; we may ship both.)
- Who blesses the `standard_set` — us + design partners, or a community-standard push? (Determines whether schema-adoption is a true moat — mirrors log §9.)
- Pack review/signing model (§9) before there's an ecosystem to abuse it.
- How much of the failure taxonomy is exposed for free vs reserved as the paid diagnosis teaser.
- Auto-generation (§11): how much of the `generate → review` loop is free vs a paid "deep generation"? And the confidence threshold below which an auto-drafted oracle is dropped rather than shown for review.
