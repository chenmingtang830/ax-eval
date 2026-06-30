/**
 * Canonical Task Suite loader and generator-prompt augmentation.
 *
 * A Suite is a category-level contract that constrains the LLM-assisted pack
 * generator to produce per-vendor packs with IDENTICAL task ids, titles, and
 * difficulties — so cross-vendor scores are meaningfully comparable. The
 * vendor pack still authors its own `prompt`, `oracles[].readPathTemplate`,
 * and surface specifics; only the canonical task identity is locked.
 *
 * Methodology rationale lives in docs/AXARENA_PLAN.md §5.
 */
import { readFileSync } from "node:fs";
import { parse as yamlParse } from "yaml";
import { z } from "zod";

const SuiteTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  difficulty: z.enum(["L1", "L2", "L3", "L4"]),
  skill: z.string().min(1),
  intent: z.string().min(1),
  oracle_hint: z.string().min(1),
  allowed_surfaces: z.array(z.string()).default(["api", "sdk", "cli", "mcp"]),
  na_examples: z.array(z.string()).default([]),
});

const SuiteSchema = z.object({
  name: z.string().min(1),
  version: z.number().int().positive(),
  category: z.string().min(1),
  description: z.string().optional(),
  homepage: z.string().optional(),
  tasks: z.array(SuiteTaskSchema).min(1),
  scoring: z.unknown().optional(),
});

export type Suite = z.infer<typeof SuiteSchema>;
export type SuiteTask = z.infer<typeof SuiteTaskSchema>;

/** Load + validate a Suite YAML file. Throws on schema or read failure. */
export function loadSuite(path: string): Suite {
  const raw = readFileSync(path, "utf8");
  const parsed = yamlParse(raw);
  const result = SuiteSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid suite at ${path}: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

/**
 * Build the prompt fragment that constrains the LLM generator to honor the
 * canonical suite. Inserted after the seed pack JSON, before the closing
 * instruction, so it acts as the FINAL constraint (highest salience).
 */
export function suitePromptFragment(suite: Suite): string {
  const taskRows = suite.tasks
    .map((t) => {
      const naNote = t.na_examples.length
        ? `\n      N/A examples: ${t.na_examples.map((s) => JSON.stringify(s)).join("; ")}`
        : "";
      return [
        `  - id: ${t.id}`,
        `    title: ${JSON.stringify(t.title)}`,
        `    difficulty: ${t.difficulty}`,
        `    skill: ${t.skill}`,
        `    canonical_intent: |`,
        `      ${t.intent.trim().replace(/\n/g, "\n      ")}`,
        `    oracle_hint: |`,
        `      ${t.oracle_hint.trim().replace(/\n/g, "\n      ")}`,
        `    default_surfaces: [${t.allowed_surfaces.join(", ")}]${naNote}`,
      ].join("\n");
    })
    .join("\n");
  return [
    "",
    `# Canonical Task Suite: ${suite.name} v${suite.version} (${suite.category})`,
    "",
    "HARD OVERRIDE — these constraints take precedence over the seed pack and",
    "any earlier instructions:",
    "",
    "1. The generated pack MUST contain EXACTLY one task for each canonical id",
    "   listed below — no more, no fewer, no extra tasks.",
    "2. Each task's `id`, `title`, and `difficulty` MUST match the canonical",
    "   value EXACTLY. Do not paraphrase the title or change the difficulty.",
    "3. Each task's `prompt` SHOULD realize the canonical_intent for THIS",
    "   specific product. Substitute the product's idiomatic vocabulary, but",
    "   preserve the intent (resource names with `{ns}` placeholders included).",
    "4. Each task's oracles SHOULD follow the oracle_hint — pick a",
    "   read-back path that lets a verifier confirm the intended state change.",
    "5. For a task that is structurally impossible for this product (e.g.,",
    "   no foreign keys in a schemaless store), keep the id but set",
    "   `allowed_surfaces: []` and add a one-line `na_reason` field on the task.",
    "   Do NOT silently drop or paraphrase the task.",
    "6. Resource names in prompts MUST include `{ns}` placeholders so two runs",
    "   of the same pack never collide in the sandbox.",
    "7. If the seed pack and ingested spec lack concrete resource/endpoint",
    "   detail (empty `resources`, missing `auth.header`, etc.), use WEB SEARCH AND WEB FETCH",
    "   on the product's docs to discover the actual",
    "   surfaces (REST endpoints, SDK package, CLI binary, MCP server URL),",
    "   auth header name, sandbox model, and idiomatic resource shapes",
    "   before authoring the pack. Cite the docs URLs in `discovery.goal`",
    "   and `discovery.official_domains`.",
    "8. Fill `discovery.canonical_endpoint` with a real endpoint or path the",
    "   verifier can use as ground-truth for T01. Make it concrete, not a",
    "   placeholder.",
    "",
    "Canonical tasks (the exact set to emit, in order):",
    taskRows,
    "",
    "Validation: the CLI will reject the returned pack if the set of task ids",
    "does not equal the canonical set, or if any title/difficulty diverges.",
  ].join("\n");
}

/**
 * Validate a returned pack's task identity against the suite. Returns a list
 * of human-readable error strings (empty if compliant). The caller decides
 * whether to error or warn.
 */
export function validatePackAgainstSuite(
  packTasks: Array<{ id: string; title: string; difficulty: string }>,
  suite: Suite,
): string[] {
  const errors: string[] = [];
  const expected = new Map(suite.tasks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  for (const task of packTasks) {
    seen.add(task.id);
    const exp = expected.get(task.id);
    if (!exp) {
      errors.push(`Task id "${task.id}" is not in canonical suite ${suite.name}.`);
      continue;
    }
    if (task.title !== exp.title) {
      errors.push(`Task ${task.id} title diverges: expected ${JSON.stringify(exp.title)}, got ${JSON.stringify(task.title)}.`);
    }
    if (task.difficulty !== exp.difficulty) {
      errors.push(`Task ${task.id} difficulty diverges: expected ${exp.difficulty}, got ${task.difficulty}.`);
    }
  }
  for (const exp of suite.tasks) {
    if (!seen.has(exp.id)) {
      errors.push(`Task id "${exp.id}" is missing from the pack.`);
    }
  }
  return errors;
}
