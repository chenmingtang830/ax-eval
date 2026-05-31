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

### Build status (updated 2026-05-31)

The keyless skeleton is now built in TypeScript and runs end-to-end with **no API
keys** (mock + Hermes-stub harnesses, mock oracles, real-or-fixture static audit).
What exists today:

- ✅ **Skeleton + CLI** — `ax-eval run | audit | report | list-harnesses` (TS, Node 22+, tsx/tsup/zod/vitest).
- ✅ **Behavioral matrix** — 8 Asana tasks × 3 keyless harnesses (`mock`, `mock-weak`, `hermes` stub) → task×harness PASS/FAIL matrix + per-harness pass rate.
- ✅ **Programmatic oracles** — `exists` / `equals` / `contains` over reported world-state (dotted paths).
- ✅ **Static (agent-readiness / AEO) audit** — `ax-eval audit --site <url>`: llms.txt, AGENTS.md, llms-full.txt, OpenAPI, MCP, SDK, robots/sitemap, OAuth discovery; weighted 0–100 score; live fetch with offline-fixture fallback; errored checks excluded from the score.
- ✅ **The gap** — `run` prints the static score next to behavioral pass rate; synthetic controls (a perfect mock) are excluded so the gap is honest.
- ✅ **34 unit tests**, all keyless/offline. Local JSON result storage + a `report` renderer.

Still **not** built (needs keys / later milestones): the real `claude-code` and
`codex` adapters (M1+), live API-readback oracles, Hermes's real provider/auth,
the editorial eval set, and `setup.ts`/`reset.ts` sandbox provisioning.

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

- 🟡 The 8 tasks (§6) currently live inline in `targets/asana/pack.yaml` (one file, not `tasks/*.yaml` — fine for v0). Each carries its oracle specs.
- 🟡 Oracle **types** are built as data-driven checks in `src/oracles.ts` (`exists`/`equals`/`contains` over reported world-state), not per-task `checks/<task>.ts`. The live API-readback variant (querying Asana with `ASANA_VERIFY_PAT` → `ASANA_PAT`) is the M1 piece still to write.
- ⬜ **Prove the oracle in isolation first**: manually perform the task by hand, confirm `true`; leave it undone, confirm `false`. (Pending live mode.)

### B. Target pack — Asana (the reference pack)

- ✅ `targets/asana/pack.yaml` — 8 tasks + oracles + `site_url` (for the static audit) + `base_url`/`auth_method`/`docs_urls`.
- ⬜ `setup.ts` — ensure the sandbox project exists, return its gid. (M1)
- ⬜ `reset.ts` — delete everything created between attempts (so pass@k don't contaminate). **Critical** for repeated live runs. (M1)

### C. Harness adapters

- 🟡 Adapter **interface + registry** built (`src/adapters/base.ts` + `registry.ts`); current keyless harnesses are `mock`, `mock-weak`, `hermes` (stub). The three real adapters below are the M1 work:
- ⬜ `minimal` — no external CLI, just an API call loop; the deliberately-weak floor/baseline.
- ⬜ `claude-code`: `claude -p "<task>" --output-format json --max-turns N --allowedTools "..."`, parse JSON transcript → `RunResult`.
- ⬜ `codex`: `codex exec --sandbox workspace-write --output-schema schema.json "<task>"`, parse → `RunResult`.
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

- **M0 — Setup (½ day):** accounts, keys, `.env`, CLIs installed, `claude -p` and `codex exec` each run a trivial hello-world headless. *Proves the harness path is real before we build on it.* — ⬜ pending (needs real keys/CLIs).
- **M0.5 — Keyless skeleton (DONE 2026-05-31):** the full pipe runs with **no keys** on fake harnesses + mock oracles + a real-or-fixture static audit. `ax-eval run --offline` prints the matrix, the static score, and the gap. *Proves the whole pipe connects before any key is spent — the runnable foundation M1–M4 build on.* See "Build status" above.
- **M1 — Oracle spike (1–2 days):** tasks #1–#3 written + their checks proven by manual falsification. *Proves we can judge success programmatically — the riskiest bet.* — oracle **types** + mock-mode tests done; live API-readback checks still to do.
- **M2 — One full vertical slice (2–3 days):** task #1 runs end-to-end through `minimal` → `RunResult` → printed. *Proves the whole pipe connects.*
- **M3 — All 3 harnesses × tasks #1–#5 (3–5 days):** the spread appears. *First sight of the real signal.*
- **M4 — Full task set + report + static gap (2–3 days):** the damning demo. Run it ourselves on Asana, look at it, decide if the thesis holds.

---

## 8. Decisions to lock before coding (small but blocking)

- **Language/stack:** ✅ **LOCKED + built — TypeScript** (confirmed 2026-05-30). Node 22+, `tsx` (run) / `tsup` (build) for the CLI, `zod` for schema validation, `vitest` for tests, `yaml` for pack loading.
- **Repo layout:** ✅ **implemented** (slightly flattened from the proposal): `src/` (runner, CLI, oracles, config, reporting, storage, schemas) · `src/adapters/` (`base`, `mock`, `hermes`, `registry`) · `src/static/` (the audit module + `fixtures/`) · `targets/asana/pack.yaml` · `tests/`. `setup.ts`/`reset.ts` and a `checks/` dir are deferred to M1 (live mode).
- **Minimal harness model:** ⬜ still open — which model + how barebones. The current `mock`/`mock-weak`/`hermes` are keyless stand-ins; the real "minimal" floor harness arrives with M1.
- **Sandbox isolation for v0:** ⬜ still open (Codex should run `--sandbox workspace-write`; containerization deferred post-v0).
- **Static audit scope for v0:** ✅ **decided + built — automated**, not by-hand. `src/static/` implements the Cloudflare/axd.md checklist as code (`ax-eval audit`), with offline fixtures so it runs without network. (Upgraded from the original "by-hand for v0" proposal.)

---

## 9. Risks (carried from strategy)

- **Oracle coverage** — if tasks keep needing LLM-judge, score credibility erodes. Mitigation: oracle-first (workstream A); drop any task we can't verify programmatically.
- **Harness drift** — CLIs update weekly and move scores. Mitigation: pin versions, record them in every `RunResult`.
- **Cost** — every attempt burns real tokens on real keys. Mitigation: `max_turns` caps, small task set, run `minimal` first.
- **Asana rate limits / side effects** — Mitigation: a dedicated sandbox project + reliable `reset.ts`.

---

## 10. Immediate next actions

The keyless skeleton (M0.5), the static audit, and the TS/layout decisions are
done (see "Build status" + §8). Remaining next actions:

1. You: create the Asana account + sandbox project, generate the PAT, fill `.env` from `.env.example` — unblocks M1 live runs.
2. Us: build the real harness adapters (`claude-code` via `claude -p`, `codex` via `codex exec`, and a minimal floor) behind the existing registry, replacing the keyless stubs.
3. Us: write live API-readback oracle types and prove tasks #1–#3 by manual falsification against the Asana sandbox (M1).
4. Decide Hermes's real provider/auth (currently a keyless stub) and the minimal-harness model (§8).

