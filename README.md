# AX eval — working repo

**Working name: AX eval.** A product exploration. This repo holds our thinking plus the v0 skeleton (TypeScript) — see the quickstart below.

## The one-liner

We test whether **AI agents can actually complete real tasks against a SaaS product's docs / API / MCP / CLI** — across multiple agent harnesses, continuously, with diagnosis of *why* they fail and *what to fix*.

Not a static audit (does your site have `llms.txt`). Not an editorial benchmark (a third party ranks vendors). Not code-sample CI (does this snippet compile). It's the **integration test for Agent Experience (AX)**: audits lint, benchmarks review — we run the real thing and tell you if it works.

## Why now

As agents become the primary operators of software, a SaaS has to win on three layers: get **discovered** (AEO/GEO), **expose** machine-operable surfaces (AX / agent-readiness), and actually **succeed** when an agent tries to use them. That third layer — verification — is empty. Everything shipping today is a static audit or an editorial benchmark. We fill the gap.

## Quickstart (no keys)

The v0 skeleton (TypeScript / Node 22+, per `plan.md` §8) runs end-to-end with
**no API keys** using the bundled keyless harnesses (`mock`, `mock-weak`, and a
`hermes` stub) and mock oracles:

```bash
npm install
npm run ax-eval -- run --offline       # behavioral matrix + static "gap" (no network)
npm run ax-eval -- audit --offline     # static (agent-readiness / AEO) audit only
npm run ax-eval -- audit --site https://yoursite.com   # audit any docs/site URL (live)
npm run ax-eval -- list-harnesses      # see registered harnesses
npm run ax-eval -- report results/last-run.json
npm test                               # vitest (34 tests, no network)
```

The product measures a target on two layers (plan.md §4):

- **Static** (`audit`) — *is the plumbing exposed?* Inspects public surfaces
  (llms.txt, AGENTS.md, OpenAPI, MCP, SDK refs, robots/sitemap, OAuth discovery)
  and gives a 0–100 agent-readiness score. Just reads URLs — no keys, no agent.
  Real fetch by default; `--offline` uses bundled fixtures.
- **Behavioral** (the harness matrix) — *can an agent actually do the job?* Runs
  the tasks across harnesses for a per-harness pass rate.

`run` prints both side by side. The headline is the **gap**: a high readiness
score with low task success means "exposed ≠ usable".

This is milestone **M0** ("skeleton runs end-to-end with a fake harness + fake
oracle"). Real keys (Asana PAT, Anthropic, OpenAI) are only needed for live runs
(M1+); see [`plan.md`](./plan.md). Layout: `src/` (runner + CLI + oracles),
`src/adapters/` (harnesses), `targets/asana/` (the pack), `tests/`.

## What's in here

- **[`ax-testing-discussion-log.md`](./ax-testing-discussion-log.md)** — start here. The *why*: positioning, the naming decision (why not "AEO"), the market map, competitive landscape, and the running list of open questions. Read this first.
- **[`product-spec.md`](./product-spec.md)** — the *what/how* of the whole platform: architecture, open/closed tiering, harness + adapter design, BYOK, scoring, telemetry, and v0→v2 phasing.
- **[`skill-spec.md`](./skill-spec.md)** — the buildable shape of the **open-source skill** (the free, local, single-harness runner that is the funnel): the four schemas (task / target pack / adapter / RunResult), the CLI, the safety boundary, and the open/closed line.
- **[`plan.md`](./plan.md)** — the active **v0 build plan**: the "damning demo" goal, prerequisites/keys, workstreams (oracle-first), the Asana task set, milestones, and the decisions to lock before coding.

## Where we are

- ✅ Positioning + competitive landscape mapped (log §1–8)
- ✅ Initial architecture decided — orchestrate real harnesses (Claude Code, Codex) via adapters, BYOK, cross-harness matrix as the paid tier (log §11, spec)
- ✅ First target chosen — **Asana**, picked for high programmatic-oracle coverage (log §12.2); scope settled as static + behavioral + editorial, ranked (log §12.4); open-skill shape specced (`skill-spec.md`)
- ✅ North-star UX + stack decided — **drop-a-link** auto-eval with a mandatory human **review gate** on auto-drafted oracles, tiered oracle generation (log §13); language locked to **TypeScript**; v0 build plan in [`plan.md`](./plan.md)
- ✅ **Keyless v0 skeleton built (TypeScript)** — `ax-eval run/audit/report` runs end-to-end with no keys: behavioral matrix (8 Asana tasks × mock/mock-weak/hermes), programmatic oracles, the static (agent-readiness/AEO) audit, and the static×behavioral gap. 34 tests. See `plan.md` "Build status".
- ⬜ Not yet decided: open/closed line, full oracle coverage per category, pricing, who blesses the harness standard, community-pack review/signing; Hermes's real provider/auth; the minimal-harness model
- ⬜ Not yet built (needs keys, M1+): real `claude-code`/`codex` adapters, live API-readback oracles, sandbox setup/reset, the editorial eval set

## How to contribute

The repo now has both the decision record (docs) and a runnable keyless skeleton.
- Open questions live in **log §9** and **spec §12** — that's the to-do list. Disagree, narrow, or close one.
- The log is the narrative/decision record (append revisions at the top). The spec is the buildable detail.
- To run the code: see the quickstart above (`npm install`, `npm run ax-eval -- run --offline`).
- Next concrete milestone: **M1** — real harness adapters + live oracles against an Asana sandbox (the full "damning demo").

## TL;DR for a newcomer

Agents are becoming the main users of APIs and docs. Nobody can tell a SaaS team whether agents actually *succeed* against their product. We can — across the agents people really use, in CI, with fixes. The skill is the funnel; hosted continuous cross-harness testing is the business.
