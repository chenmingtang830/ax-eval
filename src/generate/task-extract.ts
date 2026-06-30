/**
 * Task extract: given a vendor card + canonical suite, produce a
 * per-vendor task-extract JSON that maps each suite task to the
 * vendor's concrete implementation details.
 *
 * One LLM call per vendor (not per task) — prompt includes all 10
 * tasks and the vendor's docs URL. Returns a JSON array of TaskExtract
 * objects, one per task.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { z } from "zod";
import { invokeHarness, extractJsonObject, type HarnessId, type Effort } from "./harness.js";
import type { ResolveResult } from "./vendor-resolve.js";
import type { Suite } from "./suite.js";

const TaskExtractItemSchema = z.object({
  task_id: z.string(),
  na: z.boolean(),
  na_reason: z.string().nullish().transform((v) => v ?? undefined),
  // How an agent should accomplish this task for this vendor.
  approach: z.string().nullable(),
  // The vendor's idiomatic mechanism name (e.g. "PostgREST REST API", "supabase-js SDK").
  mechanism: z.string().nullable(),
  // Minimal representative code snippet or CLI command.
  snippet: z.string().nullable(),
  // How to verify success (the oracle read-back path).
  oracle_approach: z.string().nullable(),
});
export type TaskExtractItem = z.infer<typeof TaskExtractItemSchema>;

const TaskExtractResultSchema = z.object({
  vendor: z.string(),
  category: z.string(),
  slug: z.string(),
  suite_name: z.string(),
  extracted_at: z.string(),
  tasks: z.array(TaskExtractItemSchema),
});
export type TaskExtractResult = z.infer<typeof TaskExtractResultSchema>;

function buildExtractPrompt(vendor: ResolveResult, suite: Suite): string {
  const taskList = suite.tasks
    .map(
      (t, i) =>
        `  ${i + 1}. id="${t.id}" | "${t.title}" (${t.difficulty})\n     intent: ${t.intent.trim().replace(/\n\s*/g, " ")}\n     oracle_hint: ${t.oracle_hint.trim().replace(/\n\s*/g, " ")}`,
    )
    .join("\n\n");

  return [
    `You are an AX (Agent Experience) benchmark researcher building the Database AX Benchmark V1 (DAEB-1).`,
    ``,
    `Vendor: ${vendor.vendor}`,
    `Category: ${vendor.category}`,
    `Docs URL: ${vendor.docs_url}`,
    ``,
    `For each of the following ${suite.tasks.length} canonical benchmark tasks, describe how an AI agent would accomplish it using ${vendor.vendor}.`,
    `Use your knowledge of ${vendor.vendor}'s documentation at ${vendor.docs_url}.`,
    ``,
    `Tasks:`,
    taskList,
    ``,
    `For each task, return:`,
    `- task_id: the exact id string above`,
    `- na: true if ${vendor.vendor} structurally cannot support this task (e.g. no SQL DDL, no foreign keys, no backup API)`,
    `- na_reason: if na=true, one sentence explaining why`,
    `- approach: brief description of how an agent would accomplish this task (null if na)`,
    `- mechanism: the vendor's idiomatic mechanism name, e.g. "PostgREST REST API", "supabase-js SDK", "Neon serverless driver" (null if na)`,
    `- snippet: a minimal representative code or CLI snippet (null if na)`,
    `- oracle_approach: how to verify success by reading state back from ${vendor.vendor} (null if na)`,
    ``,
    `Return ONLY a JSON array of ${suite.tasks.length} objects, one per task, in the same order as the tasks above.`,
    `No commentary, no markdown prose outside the JSON.`,
  ].join("\n");
}

export interface ExtractTasksOptions {
  harness?: HarnessId;
  model?: string;
  effort?: Effort;
}

/** Extract task implementation details for a single vendor. */
export async function extractTasks(
  vendor: ResolveResult,
  suite: Suite,
  opts: ExtractTasksOptions = {},
): Promise<TaskExtractResult> {
  const harness = opts.harness ?? "claude-code";
  const prompt = buildExtractPrompt(vendor, suite);
  const raw = await invokeHarness(prompt, { harness, model: opts.model, effort: opts.effort });
  const json = extractJsonObject(raw);
  const items = z.array(TaskExtractItemSchema).safeParse(JSON.parse(json));
  if (!items.success) {
    throw new Error(
      `task-extract for "${vendor.vendor}" returned non-conforming JSON: ${items.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  // Verify all suite task IDs are present.
  const suiteIds = new Set(suite.tasks.map((t) => t.id));
  const returnedIds = new Set(items.data.map((t) => t.task_id));
  const missing = [...suiteIds].filter((id) => !returnedIds.has(id));
  if (missing.length > 0) {
    throw new Error(`task-extract for "${vendor.vendor}" missing task IDs: ${missing.join(", ")}`);
  }
  return TaskExtractResultSchema.parse({
    vendor: vendor.vendor,
    category: vendor.category,
    slug: vendor.slug,
    suite_name: suite.name,
    extracted_at: new Date().toISOString(),
    tasks: items.data,
  });
}

/** Extract tasks for multiple vendors in parallel. */
export async function extractTasksAll(
  vendors: ResolveResult[],
  suite: Suite,
  opts: ExtractTasksOptions = {},
): Promise<TaskExtractResult[]> {
  return Promise.all(vendors.map((v) => extractTasks(v, suite, opts)));
}

/** Path where a task-extract result is persisted. */
export function taskExtractPath(root: string, slug: string, suiteName: string): string {
  return resolve(root, "targets", "extracts", slug, `${suiteName.toLowerCase()}.yaml`);
}

/** Write a task-extract to disk as YAML. */
export function writeTaskExtract(root: string, result: TaskExtractResult): string {
  const path = taskExtractPath(root, result.slug, result.suite_name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yamlStringify(result));
  return path;
}

import { parse as yamlParse } from "yaml";

/** Load a previously-written task-extract. */
export function loadTaskExtract(root: string, slug: string, suiteName: string): TaskExtractResult | null {
  const path = taskExtractPath(root, slug, suiteName);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const result = TaskExtractResultSchema.safeParse(yamlParse(raw));
  if (!result.success) {
    throw new Error(`task-extract at ${path} is malformed: ${result.error.issues.map((i) => i.message).join("; ")}`);
  }
  return result.data;
}
