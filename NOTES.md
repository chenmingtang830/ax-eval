# ax-eval — Ideas & Proposals

## Roadmap

- **Step 1:** Auto-generate GraphQL read-back oracles (see below)
- **Step 2:** Shift to orchestrator-style evals (see below)

---

## Step 1: Auto-generate GraphQL read-back oracles (LLM-assisted synthesis)

**Approach:** At pack generation time, pass the GraphQL schema + the create mutation to Claude and have it write the read-back query. The output still goes through the human review gate before anything runs — Claude drafts it, a human approves it.

**Why LLM over pure convention-matching:** GraphQL APIs don't follow predictable URL patterns like REST. A convention-based approach breaks on non-standard schemas. An LLM can handle the messiness.

**What already exists:**
- `src/ingest/graphql.ts` already introspects the schema — knows object types, mutations, and which are create-style
- `src/generate/pack.ts` already builds oracles for REST via `roundtripOracle()` — GraphQL needs an equivalent that emits a `readQueryTemplate` instead of a `readPathTemplate`
- The gap: `graphql.ts` explicitly documents "oracles for GraphQL packs are HAND-AUTHORED" — that's what gets fixed

**What the LLM call does:**
- Input: the create mutation name + the return type's fields (from introspection)
- Output: a `readQueryTemplate` (e.g. `{ issue(id: "{gid}") { state { type } } }`) + the `assertField` to check
- Written into the pack as a draft oracle, flagged for human review before approval

---

## Business-goal-aware task ladder generation

The L1–L4 task ladder is generated from what the API *can do*, not what the business *wants to do*. Tasks end up generic and don't prove an agent can do your actual job with the product.

Design options for where business context comes in:
1. **At pack generation time** — add a `business_context` field to the pack YAML (industry, team type, top 3 use cases)
2. **At ingest time** — let the user describe goals before the spec is parsed, so task synthesis is goal-aware from the start
3. **As a separate pack layer** — keep the generic spec-driven tasks as a baseline, but let teams add a "scenario layer" on top

Outcome: shifts the eval from "can an agent use this API" → "can an agent do *our* work with this API"

---

## Past project examples as task seeds

Instead of generating tasks from scratch based on a spec, feed ax-eval real examples of work the team has actually done — past projects, tickets, workflows — and have the agent try to recreate them.

Stronger than the business-context idea: instead of describing what a team does in abstract terms, you're showing concrete examples. The agent recreates something that actually happened, so the task is known to be realistic and achievable.

Design options:
1. **Past project examples as input** — pass a list of real project names/descriptions at pack gen time, tasks are synthesized to recreate that shape of work
2. **Exported tickets/tasks as a seed** — pass an actual export (CSV or JSON of past tasks), generator picks representative ones to turn into eval tasks
3. **A "replay" mode** — agent tries to recreate a specific past project exactly; oracle checks the output matches the original structure

---

## Orchestrator/subagent split as the review gate

Instead of a human manually approving whether a task pack makes sense, use a finished project as the source of truth and automate the review entirely.

How it works:
- **Orchestrator** holds full context of what "correct" looks like (the finished project / expected state) — acts as the oracle
- **Subagent** is spun up cold with no context, only the product's API/docs, and tries to accomplish the task from scratch — acts as the agent under eval
- Orchestrator verifies the subagent's output against the known-good reference

Why this is stronger than the current review gate: today a human approves whether the task prompt and oracle are correct. This skips that entirely — the finished project *defines* correctness, so the eval becomes "can the agent reproduce it." No AI-approves-AI problem, no manual review bottleneck.

The finished project is the SoT for the eval.

---

## Step 2: Shift to orchestrator-style evals

Right now ax-eval is a linear task runner — one agent, one task, one oracle. It proves "can an agent do X with this API" but that's a shallow test of real-world usability.

Orchestrator style enables:
- **Multi-agent workflows** — orchestrator delegates subtasks to specialized subagents; evaluate whether the whole *system* accomplishes a goal, not just a single agent
- **Complex multi-step goals** — instead of "create an issue," something like "plan a sprint: create a project, populate it with tasks from a brief, assign them, set due dates, mark dependencies"
- **Realistic work** — real work is a sequence of decisions and actions that build on each other, not a single API call

Shifts the question from "can an agent operate your API?" → "can an agent do *real work* using your API as a tool?"

Oracle design evolves too — instead of checking a single field on a single resource, check that an entire *state of work* was produced correctly.

Connects directly to: past project examples as seeds, orchestrator/subagent split as review gate, finished project as SoT.
