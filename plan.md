# Plan — v0 "Damning Demo"

**Date:** 2026-05-30 · **Status:** active build plan
**Companion docs:** `ax-testing-discussion-log.md` (the *why*), `product-spec.md` (the full platform), `skill-spec.md` (the open-skill shape).

> Purpose of this doc: the concrete, sequenced plan to build v0. Everything above this is strategy; this is the to-do list. The single goal of v0 is to **turn our assertions into evidence**.

---

## 1. The one goal of v0

Every claim in our docs is currently an **assertion**: that agents really fail against real products, that scores spread across harnesses, that failures attribute to docs/schema gaps. v0 exists to make exactly one thing true:

> **Run real agent harnesses against Asana, with programmatic oracles, and produce one report that shows the gap between "the interface is exposed" and "an agent can actually use it."**

If we have that report, we have the damning demo and the proof the whole thesis rests on. If we can't get it, we've learned the thesis is weaker than we thought — cheaply.

### Definition of done (v0)

- 1 target (**Asana**) packaged as a target pack.
- 5–8 realistic tasks, **each with a programmatic oracle** (no LLM judge in v0).
- 3 harnesses runnable headless: **Claude Code + Codex + minimal**.
- One report: per-harness pass rate, cross-harness spread, failure list, + the static-audit score next to it (the gap).
- Reproducible: `harness@version` + `model` + pinned task set recorded in every result.

### Explicitly NOT in v0

Self-serve onboarding, billing, hosted fleet, history storage, percentiles, auto-fix, community-pack review, and **self-serve auto-generation of the eval set / oracles from a docs URL** (the drop-a-link UX — that's v1+; log §13, `skill-spec.md` §11). Note: v0 is still authored **AI + human-in-the-loop** (AI-drafts, a human approves/edits — by hand or by prompting the AI); it's "hand-curated" only in that a human signs off on every oracle. That human-approved Asana set is the **ground truth** the later self-serve generator is validated against. (See `skill-spec.md` §10.)

---

## 2. Prerequisites — accounts & keys (do this first)

Nothing runs without these. All go in a local `.env` (see §3).


| What                                                 | Why                                                                                 | How to get                                                                                                                                                                                                                                         |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Asana account + a dedicated `QA Sandbox` project** | the target + a safe place for the agent to mutate                                   | free Asana account; create one project                                                                                                                                                                                                             |
| `**ASANA_PAT`** (agent's key)                        | BYOK — the key handed to the agent under test                                       | Asana → My Settings → Apps → Developer → personal access token                                                                                                                                                                                     |
| `**ASANA_VERIFY_PAT**` (oracle's key) — **OPTIONAL** | the oracle's verification key; only useful if it can be *narrower* than the agent's | **Skip for v0.** Asana PATs can't be scoped (they inherit full user permissions), so a second same-account PAT adds no real isolation — the runner falls back to `ASANA_PAT`. Revisit for targets with scopable keys (Stripe, GitHub fine-grained) |
| `**ASANA_SANDBOX_PROJECT_GID`**                      | where tasks are created / reset                                                     | copy from the project URL or `GET /projects`                                                                                                                                                                                                       |
| `**ANTHROPIC_API_KEY**`                              | Claude Code headless                                                                | console.anthropic.com                                                                                                                                                                                                                              |
| `**OPENAI_API_KEY**`                                 | Codex exec + the minimal harness                                                    | platform.openai.com                                                                                                                                                                                                                                |
| **Node 22+**, `**claude` CLI**, `**codex` CLI**      | the two brand-name harnesses run headless                                           | per vendor docs (spec appendix)                                                                                                                                                                                                                    |


---

## 3. The `.env` question — yes, with a committed template

- `**.env`** — real keys, **git-ignored, never committed.** Lives only on your machine.
- `**.env.example`** — committed template with placeholder values, so anyone (incl. future-us) knows which vars to set.
- The runner loads `.env` at startup; the target pack only ever reads the vars named in its `agent_env` / `verify_env` (skill-spec §4) — it never sees the rest.

This repo now ships `.env.example` + a `.gitignore` that excludes `.env`.

---

## 4. The eval set — what we actually measure

Before workstreams: be explicit about *what's being evaluated*. We evaluate a target on **three eval sets** (log §12.4), and they are not equal — behavioral is the core/moat, static is a free hook, editorial is marketing. Defining the contents of each is itself a v0 deliverable.


| Eval set                               | Question it answers               | The "set" (what's in it)                                                                                                                                                                                     | Output                                                    | v0 scope                                              |
| -------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------- |
| **Static** (lint / hook)               | Is the plumbing even exposed?     | a structural checklist borrowed from Cloudflare Agent Readiness + axd.md: `llms.txt`, `AGENTS.md`, markdown-negotiable docs, OpenAPI present, MCP server, official SDK, robots/sitemap, auth/OAuth discovery | a static readiness score                                  | **by-hand checklist** against Asana; automate post-v0 |
| **Behavioral** (core / moat)           | Can an agent actually do the job? | the 5–8 Asana tasks + **programmatic oracles** (§6) × 3 harnesses × K attempts                                                                                                                               | per-harness pass rate, cross-harness spread, failure list | **full — this is the build**                          |
| **Editorial** (comparison / marketing) | How does it stack up vs peers?    | the same behavioral task set run across competitors (Asana vs Linear vs Monday), or with/without a quickstart; rubric: discoverability, sign-up, onboarding, API design, SDK/tooling                         | a comparison table                                        | **deferred** — add 1 competitor after M4              |


The demo's punch line is the **cross-set gap**: static-high × behavioral-low ("readiness 92, but task success 3/10"). Static or editorial alone is someone else's game (Cloudflare / Tech Stackups); the *behavioral* set and the *gap* are ours.

---

## 5. Workstreams (and the recommended order)

These build the **behavioral** eval set above (the static checklist is by-hand for v0; editorial is deferred). Four pieces have to exist, depending on each other roughly in this order. **Oracle-first** is the recommendation: it's the riskiest, highest-value piece, and the task list it produces de-risks everything downstream.

```
  A. Task list + oracles  ──▶  B. Target pack (Asana)  ──▶  C. Harness adapters  ──▶  D. Report
     (define + verify)          (setup/reset/surfaces)       (claude/codex/minimal)    (the demo)
```

### A. Task list + programmatic oracles  ← start here

- Write the 5–8 tasks (§6) as `tasks/*.yaml` per skill-spec §3.
- For each, write `checks/<task>.ts` that queries Asana with the verify key (`ASANA_VERIFY_PAT`, falls back to `ASANA_PAT`) and returns a bool.
- **Prove the oracle in isolation first**: manually perform the task by hand, confirm the check returns `true`; leave it undone, confirm `false`. An oracle you haven't falsified is not trustworthy.

### B. Target pack — Asana (the reference pack)

- `targets/asana/pack.yaml` (surfaces, `agent_env`/`verify_env`, setup/reset, tasks glob) per skill-spec §4.
- `setup.ts` — ensure the sandbox project exists, return its gid.
- `reset.ts` — delete everything created in the project between attempts (so `attempts: K` / pass@k don't contaminate each other). **Critical** — without this, repeated runs lie.

### C. Harness adapters

- `minimal` first (no external CLI, just an API call loop) — it's the simplest and gives a baseline immediately.
- `claude-code`: `claude -p "<task>" --output-format json --max-turns N --allowedTools "..."`, parse JSON transcript → `RunResult`.
- `codex`: `codex exec --sandbox workspace-write --output-schema schema.json "<task>"`, parse → `RunResult`.
- Each adapter: `detect()` (installed+authed?) + `run()` → normalized `RunResult` (skill-spec §5–6).

### D. Report

- Aggregate `RunResult`s → per-harness pass rate, cross-harness spread, failure list.
- Run the **static audit** (Cloudflare-style: does Asana expose llms.txt / OpenAPI / MCP / good docs structure?) and print its score **next to** the behavioral pass rate. The gap is the headline (log §12.4).
- Output: console table + a JSON dump + a one-page Markdown report.

---

## 6. The Asana task set (draft — refine in workstream A)

Goal-level jobs a real integrator would do; each must have a **programmatic** oracle. Difficulty laddered low→high to produce spread.


| #   | Task                                                         | Oracle (query with verify key, assert)   | Why it's here                             |
| --- | ------------------------------------------------------------ | ---------------------------------------- | ----------------------------------------- |
| 1   | Create a task named `Ship v0` in the sandbox project         | task with that name exists in project    | simplest happy path / floor               |
| 2   | Create that task **and assign** it to a given user           | `assignee.email` matches                 | adds a lookup step (find user)            |
| 3   | Create a task with a **due date** = next Friday              | `due_on` equals expected date            | date handling / param formatting          |
| 4   | Create a task and move it to the `**Done` section**          | task's `memberships[].section` matches   | multi-step (create → find section → move) |
| 5   | Set a **custom field** value on a task                       | custom field value matches               | schema comprehension (custom field gids)  |
| 6   | Add a **subtask** under a parent task                        | parent has a subtask with the name       | nested resource / ordering                |
| 7   | Create a **webhook** on the project and verify the handshake | webhook resource exists + active         | hardest: async handshake, error handling  |
| 8   | Add a **comment (story)** to a task                          | a story with the text exists on the task | secondary resource type                   |


Each runs with `attempts: 3` for pass@k. Some run docs-only vs MCP vs SDK to seed the feature-space comparison (skill-spec §3 `allowed_surfaces`).

---

## 7. Milestones

- **M0 — Setup (½ day):** accounts, keys, `.env`, CLIs installed, `claude -p` and `codex exec` each run a trivial hello-world headless. *Proves the harness path is real before we build on it.*
- **M1 — Oracle spike (1–2 days):** tasks #1–#3 written + their checks proven by manual falsification. *Proves we can judge success programmatically — the riskiest bet.*
- **M2 — One full vertical slice (2–3 days):** task #1 runs end-to-end through `minimal` → `RunResult` → printed. *Proves the whole pipe connects.*
- **M3 — All 3 harnesses × tasks #1–#5 (3–5 days):** the spread appears. *First sight of the real signal.*
- **M4 — Full task set + report + static gap (2–3 days):** the damning demo. Run it ourselves on Asana, look at it, decide if the thesis holds.

---

## 8. Decisions to lock before coding (small but blocking)

- **Language/stack:** **TypeScript** (confirmed 2026-05-30) — npx-installable = frictionless funnel; ecosystem fit with MCP/skills/agent-tooling; official `node-asana`. Node 22+ (also Claude Code's requirement). Suggested tooling: `tsx`/`tsup` for the CLI, `zod` for schema validation, `vitest` for the oracle tests.
- **Repo layout:** proposed (TS/Node) `src/axeval/` (runner + CLI) · `targets/asana/` (pack: `pack.yaml`, `setup.ts`, `reset.ts`, `tasks/`, `checks/`) · `src/adapters/` (claude-code, codex, minimal) · `reports/`. Confirm or override.
- **Minimal harness model:** which model + how barebones (just a tool-calling loop with web-fetch + http)? It's the floor, so keep it deliberately weak.
- **Sandbox isolation for v0:** we run our own trusted pack, so full container isolation (skill-spec §9) can wait — but Codex should still run `--sandbox workspace-write`. Confirm we're OK deferring containerization to post-v0.
- **Static audit scope for v0:** build our own tiny checker, or just eyeball Asana against the Cloudflare/axd.md dimensions by hand for the demo? (Proposed: by-hand for v0, automate later.)

---

## 9. Risks (carried from strategy)

- **Oracle coverage** — if tasks keep needing LLM-judge, score credibility erodes. Mitigation: oracle-first (workstream A); drop any task we can't verify programmatically.
- **Harness drift** — CLIs update weekly and move scores. Mitigation: pin versions, record them in every `RunResult`.
- **Cost** — every attempt burns real tokens on real keys. Mitigation: `max_turns` caps, small task set, run `minimal` first.
- **Asana rate limits / side effects** — Mitigation: a dedicated sandbox project + reliable `reset.ts`.

---

## 10. Immediate next actions

1. You: create the Asana account + sandbox project, generate the two PATs, fill `.env` from `.env.example`.
2. Us: lock the remaining §8 decision (repo layout) — language is settled (TypeScript).
3. Us: start workstream A — write tasks #1–#3 and their oracle checks, prove them by manual falsification (M1).

