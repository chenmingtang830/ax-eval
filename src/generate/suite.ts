import { readFileSync } from "node:fs";
import { parse as yamlParse } from "yaml";
import { z } from "zod";
import { SuiteMethodologySchema } from "./suite-methodology.js";

const SuiteTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  difficulty: z.enum(["L1", "L2", "L3", "L4"]),
  skill: z.string().min(1),
  intent: z.string().min(1),
  oracle_hint: z.string().min(1),
  allowed_surfaces: z.array(z.enum(["api", "cli", "sdk", "mcp"])).default(["api", "cli"]),
  na_examples: z.array(z.string()).default([]),
});

export const SuiteSchema = z.object({
  name: z.string().min(1),
  version: z.number().int().positive(),
  category: z.string().min(1),
  description: z.string().optional(),
  homepage: z.string().url().optional(),
  methodology: SuiteMethodologySchema.optional(),
  tasks: z.array(SuiteTaskSchema).min(1),
  scoring: z.unknown().optional(),
}).superRefine((suite, context) => {
  const seen = new Set<string>();
  for (const [index, task] of suite.tasks.entries()) {
    if (seen.has(task.id)) {
      context.addIssue({
        code: "custom",
        path: ["tasks", index, "id"],
        message: `duplicate task id ${task.id}`,
      });
    }
    seen.add(task.id);
  }
  if (suite.methodology && suite.methodology.target_task_count !== suite.tasks.length) {
    context.addIssue({
      code: "custom",
      path: ["methodology", "target_task_count"],
      message: `target_task_count must equal tasks.length (${suite.tasks.length})`,
    });
  }
});

export type Suite = z.infer<typeof SuiteSchema>;
export type SuiteTask = z.infer<typeof SuiteTaskSchema>;

export function loadSuite(path: string): Suite {
  const result = SuiteSchema.safeParse(yamlParse(readFileSync(path, "utf8")));
  if (!result.success) {
    throw new Error(
      `Invalid suite at ${path}: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

export function suitePromptFragment(suite: Suite): string {
  const tasks = suite.tasks.map((task) => [
    `  - id: ${task.id}`,
    `    title: ${JSON.stringify(task.title)}`,
    `    difficulty: ${task.difficulty}`,
    `    canonical_intent: |`,
    `      ${task.intent.trim().replace(/\n/g, "\n      ")}`,
    `    oracle_hint: |`,
    `      ${task.oracle_hint.trim().replace(/\n/g, "\n      ")}`,
    `    allowed_surfaces: [${task.allowed_surfaces.join(", ")}]`,
  ].join("\n")).join("\n");

  return [
    "",
    `# Canonical Task Suite: ${suite.name} v${suite.version} (${suite.category})`,
    "",
    "HARD OVERRIDE — these constraints take precedence over earlier authoring instructions:",
    "1. Emit exactly one task for every canonical id below, with no extras.",
    "2. Preserve each task's id, title, difficulty, intent, and allowed surfaces.",
    "3. Adapt only product-specific prompt vocabulary and deterministic read-back oracles.",
    "4. If a task is structurally impossible for the target, keep it and set `na: true`.",
    "5. Never use an empty allowed_surfaces list to represent N/A; empty remains unrestricted.",
    "6. Keep `{ns}` in resource names so parallel runs cannot collide.",
    "",
    tasks,
    "",
  ].join("\n");
}

export function validatePackAgainstSuite(
  packTasks: Array<{ id: string; title: string; difficulty: string }>,
  suite: Suite,
): string[] {
  const errors: string[] = [];
  const expected = new Map(suite.tasks.map((task) => [task.id, task]));
  const seen = new Set<string>();
  for (const task of packTasks) {
    if (seen.has(task.id)) errors.push(`Task id "${task.id}" appears more than once in the pack.`);
    seen.add(task.id);
    const canonical = expected.get(task.id);
    if (!canonical) {
      errors.push(`Task id "${task.id}" is not in canonical suite ${suite.name}.`);
      continue;
    }
    if (task.title !== canonical.title) {
      errors.push(`Task ${task.id} title diverges: expected ${JSON.stringify(canonical.title)}, got ${JSON.stringify(task.title)}.`);
    }
    if (task.difficulty !== canonical.difficulty) {
      errors.push(`Task ${task.id} difficulty diverges: expected ${canonical.difficulty}, got ${task.difficulty}.`);
    }
  }
  for (const task of suite.tasks) {
    if (!seen.has(task.id)) errors.push(`Task id "${task.id}" is missing from the pack.`);
  }
  return errors;
}
