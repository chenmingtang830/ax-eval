/**
 * Synthesize-suite: Layer 0b of suite authoring. Reads ALL vendors'
 * capability-extract files (already grounded + cited — see
 * capability-extract.ts) and derives the canonical task suite bottom-up:
 * cluster similar capabilities across vendors, keep the ones with the
 * broadest real coverage, draft one canonical task per cluster.
 *
 * Split into two cheap steps instead of one large one:
 *   Step A (clusterCapabilities): ONE call — mechanical clustering +
 *     coverage counting + a one-line rationale + difficulty per SELECTED
 *     cluster. No task copy yet, so this is fast even over a large corpus.
 *   Step B (draftTask, parallel per selected cluster): only for the ~10
 *     winners, write the actual goal-level intent/oracle_hint text — the
 *     same kind of careful, precise writing the original hand-authored
 *     suite needed, now done once per cluster in parallel instead of
 *     serially inside one giant call.
 *
 * Deliberately NOT grounded (no WebFetch) — both steps reason over
 * already-extracted, cited text, they don't research new facts. Every
 * claim traces back to a specific vendor's capabilities.yaml.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { z } from "zod";
import { invokeHarness, extractJsonObject, type HarnessId, type Effort } from "./harness.js";
import type { CapabilityExtractResult } from "./capability-extract.js";

const CoverageSchema = z.object({ vendor: z.string(), capability_name: z.string() });

const ClusterSchema = z.object({
  cluster_name: z.string().min(1), // kebab slug, e.g. "row-level-security"
  title: z.string().min(1),
  difficulty: z.enum(["L1", "L2", "L3", "L4"]),
  rationale: z.string().min(1), // one sentence: why this made the cut
  coverage: z.array(CoverageSchema).min(1),
});
export type Cluster = z.infer<typeof ClusterSchema>;

const ClusterResultSchema = z.object({ clusters: z.array(ClusterSchema) });

const SynthesizedTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  difficulty: z.enum(["L1", "L2", "L3", "L4"]),
  skill: z.string().min(1),
  intent: z.string().min(1),
  oracle_hint: z.string().min(1),
  allowed_surfaces: z.array(z.enum(["api", "sdk", "cli", "mcp"])).default(["api", "sdk", "cli", "mcp"]),
  na_examples: z.array(z.string()).default([]),
  rationale: z.string(),
  coverage: z.array(CoverageSchema),
});
export type SynthesizedTask = z.infer<typeof SynthesizedTaskSchema>;

export interface SynthesizeResult {
  tasks: SynthesizedTask[];
}

function buildClusterPrompt(category: string, extracts: CapabilityExtractResult[], targetCount: number): string {
  const corpus = extracts
    .map((e) => {
      const caps = e.capabilities.map((c) => `    - ${c.name}: ${c.title} — ${c.description}`).join("\n");
      return `${e.vendor} (${e.capabilities.length} capabilities):\n${caps}`;
    })
    .join("\n\n");

  return [
    `Deriving a canonical task suite for the "${category}" category from ${extracts.length} vendors'`,
    `already-cited capability lists below (bottom-up — reflect what's actually documented, not an assumed`,
    `standard list).`,
    ``,
    `=== VENDOR CAPABILITIES ===`,
    corpus,
    ``,
    `=== JOB ===`,
    `1. Cluster capabilities across vendors representing the SAME underlying concept, even if named`,
    `   differently.`,
    `2. Count how many of the ${extracts.length} vendors have something in each cluster.`,
    `3. Select ~${targetCount} clusters, prioritizing: broad coverage (genuinely category-defining, not one`,
    `   vendor's specialty) AND meaningful AX differentiation (skip trivial-everywhere or one-vendor-only`,
    `   things, unless a low-coverage capability's ABSENCE elsewhere is itself meaningful signal). Spread`,
    `   difficulty L1 (simple) to L4 (complex/operational) across the selection — not all one tier.`,
    `4. For each SELECTED cluster only, give: cluster_name (kebab slug), title, difficulty, one-sentence`,
    `   rationale, and coverage (every (vendor, capability_name) pair from above that fed it — must be`,
    `   traceable to real entries, not invented). Do NOT draft full task prompts yet — just the selection.`,
    `Do not report on rejected clusters — only the ~${targetCount} selected.`,
    ``,
    `Return ONLY this JSON object, no commentary:`,
    `{"clusters": [{"cluster_name": "...", "title": "...", "difficulty": "L1", "rationale": "...",`,
    ` "coverage": [{"vendor": "...", "capability_name": "..."}]}]}`,
  ].join("\n");
}

function buildTaskDraftPrompt(category: string, cluster: Cluster, matched: Array<{ vendor: string; title: string; description: string; doc_url: string }>, index: number): string {
  const evidence = matched.map((m) => `  - [${m.vendor}] ${m.title}: ${m.description} [${m.doc_url}]`).join("\n");
  return [
    `Canonical task suite authoring for the "${category}" category. This cluster was already selected`,
    `(coverage: ${cluster.coverage.length} vendors) — your job is ONLY to draft its task definition.`,
    ``,
    `Cluster: ${cluster.cluster_name} — ${cluster.title}`,
    `Why selected: ${cluster.rationale}`,
    `Evidence (what vendors actually documented for this capability):`,
    evidence,
    ``,
    `Draft ONE canonical task:`,
    `- id: "${category.slice(0, 2)}-T${String(index + 1).padStart(2, "0")}-<kebab-slug>" (e.g. "db-T01-create-table")`,
    `- title: "T${String(index + 1).padStart(2, "0")}: <short description>"`,
    `- difficulty: "${cluster.difficulty}" (already decided, keep it)`,
    `- skill: a short kebab-case skill tag`,
    `- intent: GOAL-LEVEL, vendor-agnostic prompt text an agent would receive. Include concrete,`,
    `  deterministic resource names/patterns using a literal "{ns}" placeholder for a namespace token (e.g.`,
    `  "a table named \`axarena_customers_{ns}\`"). State the vendor's idiomatic mechanism is acceptable —`,
    `  never name a specific vendor's API/SDK call. Specify exact, checkable outcomes (exact counts, exact`,
    `  patterns) so verification doesn't need guesswork.`,
    `- oracle_hint: what a verifier should read back to confirm success`,
    `- allowed_surfaces: default ["api","sdk","cli","mcp"] unless the evidence specifically suggests most`,
    `  vendors only expose this via a subset`,
    `- na_examples: example phrasing for when a vendor structurally lacks this`,
    ``,
    `Return ONLY this JSON object, no commentary:`,
    `{"id": "...", "title": "...", "difficulty": "${cluster.difficulty}", "skill": "...", "intent": "...",`,
    ` "oracle_hint": "...", "allowed_surfaces": ["api","sdk","cli","mcp"], "na_examples": ["..."]}`,
  ].join("\n");
}

export interface SynthesizeSuiteOptions {
  harness?: HarnessId;
  model?: string;
  effort?: Effort;
  targetTaskCount?: number;
}

const CLUSTER_TIMEOUT_MS = 10 * 60 * 1000;
const TASK_DRAFT_TIMEOUT_MS = 6 * 60 * 1000;

/** Step A: cluster + select, no task copy yet. */
export async function clusterCapabilities(
  category: string,
  extracts: CapabilityExtractResult[],
  opts: SynthesizeSuiteOptions = {},
): Promise<Cluster[]> {
  if (extracts.length < 2) {
    throw new Error("synthesize-suite needs at least 2 vendors' capability extracts to find cross-vendor coverage");
  }
  const raw = await invokeHarness(buildClusterPrompt(category, extracts, opts.targetTaskCount ?? 10), {
    harness: opts.harness ?? "claude-code",
    model: opts.model,
    effort: opts.effort ?? "high",
    heartbeat: { everyMs: 30_000, label: `cluster-capabilities/${category}` },
    timeoutMs: CLUSTER_TIMEOUT_MS,
  });
  const json = extractJsonObject(raw);
  const parsed = ClusterResultSchema.safeParse(JSON.parse(json));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
    throw new Error(`cluster-capabilities returned non-conforming JSON: ${issues}\nRaw: ${json.slice(0, 3000)}`);
  }
  return parsed.data.clusters;
}

/** Step B: draft the full task for one selected cluster (call in parallel per cluster). */
export async function draftTask(
  category: string,
  cluster: Cluster,
  extracts: CapabilityExtractResult[],
  index: number,
  opts: SynthesizeSuiteOptions = {},
): Promise<SynthesizedTask> {
  const byVendorCap = new Map<string, { vendor: string; title: string; description: string; doc_url: string }>();
  for (const e of extracts) {
    for (const c of e.capabilities) {
      byVendorCap.set(`${e.vendor}::${c.name}`, { vendor: e.vendor, title: c.title, description: c.description, doc_url: c.doc_url });
    }
  }
  const matched = cluster.coverage
    .map((cov) => byVendorCap.get(`${cov.vendor}::${cov.capability_name}`))
    .filter((m): m is NonNullable<typeof m> => m !== undefined);

  const label = `draft-task/${cluster.cluster_name}`;
  const raw = await invokeHarness(buildTaskDraftPrompt(category, cluster, matched, index), {
    harness: opts.harness ?? "claude-code",
    model: opts.model,
    effort: opts.effort ?? "high",
    heartbeat: { everyMs: 30_000, label },
    timeoutMs: TASK_DRAFT_TIMEOUT_MS,
  });
  const json = extractJsonObject(raw);
  const draftSchema = z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    difficulty: z.enum(["L1", "L2", "L3", "L4"]),
    skill: z.string().min(1),
    intent: z.string().min(1),
    oracle_hint: z.string().min(1),
    allowed_surfaces: z.array(z.enum(["api", "sdk", "cli", "mcp"])).default(["api", "sdk", "cli", "mcp"]),
    na_examples: z.array(z.string()).default([]),
  });
  const parsed = draftSchema.safeParse(JSON.parse(json));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
    throw new Error(`draft-task for "${label}" returned non-conforming JSON: ${issues}\nRaw: ${json.slice(0, 2000)}`);
  }
  return { ...parsed.data, rationale: cluster.rationale, coverage: cluster.coverage };
}

/** Full pipeline: cluster+select (Step A), then draft all selected tasks in parallel (Step B). */
export async function synthesizeSuite(
  category: string,
  extracts: CapabilityExtractResult[],
  opts: SynthesizeSuiteOptions = {},
): Promise<SynthesizeResult> {
  const clusters = await clusterCapabilities(category, extracts, opts);
  const tasks = await Promise.all(clusters.map((c, i) => draftTask(category, c, extracts, i, opts)));
  return { tasks };
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

/** Render the human-readable synthesis/audit-trail doc (coverage + rationale per task). */
export function renderSynthesisDoc(name: string, category: string, result: SynthesizeResult): string {
  const lines: string[] = [
    `# ${name} — Suite Synthesis Audit Trail`,
    ``,
    `Generated by \`synthesize-suite\` from vendor capability extracts (\`targets/extracts/<vendor>/capabilities.yaml\`).`,
    `Every task below traces to specific, cited vendor documentation.`,
    ``,
    `## Selected tasks (${result.tasks.length})`,
    ``,
  ];
  for (const t of result.tasks) {
    lines.push(`### ${t.id} — ${t.title}`);
    lines.push(``);
    lines.push(`Difficulty: ${t.difficulty} · Skill: ${t.skill}`);
    lines.push(``);
    lines.push(`**Why selected**: ${t.rationale}`);
    lines.push(``);
    lines.push(`**Coverage** (${t.coverage.length} vendor capabilities clustered into this task):`);
    lines.push(``);
    lines.push(`| Vendor | Capability |`);
    lines.push(`|---|---|`);
    for (const c of t.coverage) lines.push(`| ${c.vendor} | ${c.capability_name} |`);
    lines.push(``);
  }
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
