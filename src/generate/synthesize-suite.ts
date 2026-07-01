/**
 * Synthesize-suite: Layer 0b of suite authoring. Reads ALL vendors'
 * capability-extract files (already grounded + cited — see
 * capability-extract.ts) and derives the canonical task suite bottom-up:
 * cluster similar capabilities across vendors, keep the ones with the
 * broadest real-world coverage, draft one canonical task per cluster.
 *
 * Deliberately NOT grounded (no WebFetch) — this step reasons over already-
 * extracted, cited text, it doesn't research new facts. Every claim in its
 * output traces back to a specific vendor's capabilities.yaml, which traces
 * back to a specific doc URL/quote — the audit trail a reproducible,
 * defensible public methodology needs.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { z } from "zod";
import { invokeHarness, extractJsonObject, type HarnessId, type Effort } from "./harness.js";
import type { CapabilityExtractResult } from "./capability-extract.js";

const SynthesizedTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  difficulty: z.enum(["L1", "L2", "L3", "L4"]),
  skill: z.string().min(1),
  intent: z.string().min(1),
  oracle_hint: z.string().min(1),
  allowed_surfaces: z.array(z.enum(["api", "sdk", "cli", "mcp"])).default(["api", "sdk", "cli", "mcp"]),
  na_examples: z.array(z.string()).default([]),
  // Audit trail: which vendors' capability clusters this task derives from,
  // and the raw capability names (from each vendor's capabilities.yaml) it
  // clusters together.
  coverage: z.array(z.object({ vendor: z.string(), capability_name: z.string() })),
});
export type SynthesizedTask = z.infer<typeof SynthesizedTaskSchema>;

const SynthesizeResultSchema = z.object({
  tasks: z.array(SynthesizedTaskSchema),
  // Clusters considered but NOT selected, with why — goes in the synthesis
  // doc so the "why not" is as auditable as the "why".
  rejected_clusters: z.array(z.object({
    capability_name: z.string(),
    covered_by: z.array(z.string()),
    reason_excluded: z.string(),
  })),
});
export type SynthesizeResult = z.infer<typeof SynthesizeResultSchema>;

function buildSynthesisPrompt(category: string, extracts: CapabilityExtractResult[], targetCount: number): string {
  const corpus = extracts
    .map((e) => {
      const caps = e.capabilities
        .map((c) => `    - ${c.name}: ${c.title} — ${c.description} [${c.doc_url}]`)
        .join("\n");
      return `${e.vendor} (${e.capabilities.length} capabilities):\n${caps}`;
    })
    .join("\n\n");

  return [
    `You are deriving a canonical task suite for the "${category}" category of an Agent Experience`,
    `benchmark, from ${extracts.length} vendors' already-extracted, cited capability lists below. This is`,
    `bottom-up: the suite must reflect what's ACTUALLY documented across these vendors, not an assumed`,
    `standard feature list.`,
    ``,
    `=== VENDOR CAPABILITIES (already grounded in each vendor's docs) ===`,
    corpus,
    ``,
    `=== YOUR JOB ===`,
    `1. Cluster capabilities across vendors that represent the SAME underlying concept, even if named`,
    `   differently (e.g. "row-level-security" / "attribute-based-access" / "policy-based-filtering" might`,
    `   all be the same cluster: per-row access control).`,
    `2. Count how many of the ${extracts.length} vendors' capability lists have something in each cluster.`,
    `3. Select ~${targetCount} clusters for the canonical suite, prioritizing: (a) broad coverage — appears`,
    `   in most vendors, so it's genuinely a category-defining capability, not one vendor's specialty; (b)`,
    `   meaningful AX differentiation — a capability where HOW WELL an agent can discover/use it actually`,
    `   varies (skip trivial universal things and skip capabilities so vendor-specific almost nobody else`,
    `   has them). A capability with low coverage can still be selected if it's a genuinely defining`,
    `   category capability where the absence itself is meaningful signal (document this reasoning).`,
    `4. For each SELECTED cluster, draft ONE canonical task:`,
    `   - id: "${category.slice(0, 2)}-T<NN>-<kebab-slug>" (e.g. "db-T01-create-table"), numbered in a`,
    `     sensible difficulty/dependency order`,
    `   - title: "T<NN>: <short description>"`,
    `   - difficulty: L1 (single simple op) to L4 (complex/operational) — spread across the suite, not all`,
    `     the same tier`,
    `   - skill: a short kebab-case skill tag`,
    `   - intent: GOAL-LEVEL, vendor-agnostic prompt text an agent would receive. Must include concrete,`,
    `     deterministic resource names/patterns using a literal "{ns}" placeholder for a namespace token`,
    `     (e.g. "a table named \`axarena_customers_{ns}\`"), and state the vendor's idiomatic mechanism is`,
    `     acceptable (never name a specific vendor's API/SDK call). Must specify exact, checkable outcomes`,
    `     (exact counts, exact patterns) so verification doesn't need guesswork.`,
    `   - oracle_hint: what a verifier should read back to confirm success`,
    `   - allowed_surfaces: default ["api","sdk","cli","mcp"] unless you have specific evidence (from the`,
    `     capability list) that most vendors only expose this via a subset`,
    `   - na_examples: example phrasing for when a vendor structurally lacks this (for the methodology page)`,
    `   - coverage: list EVERY (vendor, capability_name) pair from the corpus above that fed this cluster —`,
    `     this is the audit trail, it must be traceable to real entries above, not invented`,
    `5. For clusters you considered but did NOT select, list them in rejected_clusters with which vendors`,
    `   covered it and why you excluded it (e.g. "too narrow, only 2/${extracts.length} vendors", "not`,
    `   meaningfully differentiating", "redundant with cluster X").`,
    ``,
    `Return ONLY this JSON object, no commentary:`,
    `{"tasks": [{"id": "...", "title": "...", "difficulty": "L1", "skill": "...", "intent": "...",`,
    ` "oracle_hint": "...", "allowed_surfaces": ["api","sdk","cli","mcp"], "na_examples": ["..."],`,
    ` "coverage": [{"vendor": "...", "capability_name": "..."}]}],`,
    ` "rejected_clusters": [{"capability_name": "...", "covered_by": ["..."], "reason_excluded": "..."}]}`,
  ].join("\n");
}

export interface SynthesizeSuiteOptions {
  harness?: HarnessId;
  model?: string;
  effort?: Effort;
  targetTaskCount?: number;
}

// A large corpus (8 vendors x ~18 cited capabilities) plus a verbose,
// detailed output (10 tasks with full intent/oracle_hint text + coverage +
// rejected clusters) is genuinely slow for one call — measured exceeding
// 10min once already. This runs once (not per-vendor), so latency is cheap
// to tolerate.
const TIMEOUT_MS = 25 * 60 * 1000;

/** Synthesize the canonical suite from all vendors' capability extracts. */
export async function synthesizeSuite(
  category: string,
  extracts: CapabilityExtractResult[],
  opts: SynthesizeSuiteOptions = {},
): Promise<SynthesizeResult> {
  if (extracts.length < 2) {
    throw new Error("synthesize-suite needs at least 2 vendors' capability extracts to find cross-vendor coverage");
  }
  const raw = await invokeHarness(buildSynthesisPrompt(category, extracts, opts.targetTaskCount ?? 10), {
    harness: opts.harness ?? "claude-code",
    model: opts.model,
    effort: opts.effort ?? "high",
    // No requireWebFetch — this step reasons over already-grounded input text.
    heartbeat: { everyMs: 30_000, label: `synthesize-suite/${category}` },
    timeoutMs: TIMEOUT_MS,
  });
  const json = extractJsonObject(raw);
  const parsed = SynthesizeResultSchema.safeParse(JSON.parse(json));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
    throw new Error(`synthesize-suite returned non-conforming JSON: ${issues}\nRaw: ${json.slice(0, 3000)}`);
  }
  return parsed.data;
}

/** Render the frozen suite YAML (loadSuite()-compatible) from a synthesis result. */
export function renderSuiteYaml(name: string, version: number, category: string, result: SynthesizeResult): string {
  const suite = {
    name,
    version,
    category,
    description: `Bottom-up-derived canonical task suite for the "${category}" category, synthesized from ${
      new Set(result.tasks.flatMap((t) => t.coverage.map((c) => c.vendor))).size
    } vendors' cited documentation (see ${name.toLowerCase()}.synthesis.md for the full audit trail).`,
    tasks: result.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      difficulty: t.difficulty,
      skill: t.skill,
      intent: t.intent,
      oracle_hint: t.oracle_hint,
      allowed_surfaces: t.allowed_surfaces,
      na_examples: t.na_examples,
    })),
    scoring: {
      per_task: "pass | fail | na",
      overall: {
        formula: "score = sum(passes) / sum(non_na_tasks)",
        notes:
          "N/A tasks (and N/A surfaces within a task) are excluded from both numerator and denominator. Cross-vendor comparisons are valid only across tasks/surfaces both vendors actually run.",
      },
    },
  };
  return yamlStringify(suite);
}

/** Render the human-readable synthesis/audit-trail doc (coverage table + rejected clusters). */
export function renderSynthesisDoc(name: string, category: string, result: SynthesizeResult): string {
  const lines: string[] = [
    `# ${name} — Suite Synthesis Audit Trail`,
    ``,
    `Generated by \`synthesize-suite\` from vendor capability extracts (\`targets/extracts/<vendor>/capabilities.yaml\`).`,
    `Every task below traces to specific, cited vendor documentation — see each task's Coverage table.`,
    ``,
    `## Selected tasks (${result.tasks.length})`,
    ``,
  ];
  for (const t of result.tasks) {
    lines.push(`### ${t.id} — ${t.title}`);
    lines.push(``);
    lines.push(`Difficulty: ${t.difficulty} · Skill: ${t.skill}`);
    lines.push(``);
    lines.push(`**Coverage** (${t.coverage.length} vendor capabilities clustered into this task):`);
    lines.push(``);
    lines.push(`| Vendor | Capability |`);
    lines.push(`|---|---|`);
    for (const c of t.coverage) lines.push(`| ${c.vendor} | ${c.capability_name} |`);
    lines.push(``);
  }
  lines.push(`## Rejected clusters (${result.rejected_clusters.length})`);
  lines.push(``);
  lines.push(`| Capability | Covered by | Why excluded |`);
  lines.push(`|---|---|---|`);
  for (const r of result.rejected_clusters) {
    lines.push(`| ${r.capability_name} | ${r.covered_by.join(", ")} | ${r.reason_excluded} |`);
  }
  lines.push(``);
  return lines.join("\n");
}

export function writeSuiteFiles(root: string, path: string, suiteYaml: string, synthesisDoc: string): { suitePath: string; synthesisPath: string } {
  const suitePath = resolve(root, path);
  const synthesisPath = suitePath.replace(/\.yaml$/, ".synthesis.md");
  mkdirSync(dirname(suitePath), { recursive: true });
  writeFileSync(suitePath, suiteYaml);
  writeFileSync(synthesisPath, synthesisDoc);
  return { suitePath, synthesisPath };
}
