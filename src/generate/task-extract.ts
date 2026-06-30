/**
 * Oracle extract: given a vendor card + canonical suite, produce ONLY the
 * vendor-specific read-back path for each suite task (plus a vendor-level
 * base_url/auth guess). This is the one part of pack authoring that
 * genuinely requires vendor knowledge — every other field (prompt, id,
 * title, difficulty) is rendered from the suite by pure code in
 * compose-pack.ts.
 *
 * One LLM call per vendor covering all suite tasks. Deliberately narrow:
 * no prompt rewriting, no code snippets, no "approach" prose — those are
 * either unnecessary (the agent discovers them itself) or noise.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { z } from "zod";
import { invokeHarness, extractJsonObject, type HarnessId, type Effort } from "./harness.js";
import type { ResolveResult } from "./vendor-resolve.js";
import type { Suite } from "./suite.js";

const OracleExtractItemSchema = z.object({
  task_id: z.string(),
  na: z.boolean(),
  na_reason: z.string().nullish().transform((v) => v ?? undefined),
  // REST read-back path to verify the task's expected state. Use {ns} for
  // the namespace placeholder. null when na=true.
  read_method: z.enum(["GET", "POST"]).nullish().transform((v) => v ?? undefined),
  read_path_template: z.string().nullish().transform((v) => v ?? undefined),
  // Dotted path into the response to assert against the suite's known
  // expected value (e.g. "length" for a row-count check, or a field name).
  assert_field: z.string().nullish().transform((v) => v ?? undefined),
});
export type OracleExtractItem = z.infer<typeof OracleExtractItemSchema>;

const VendorConfigSchema = z.object({
  base_url: z.string(),
  auth_type: z.enum(["bearer", "api-key", "oauth", "none"]),
  auth_header: z.string().nullish().transform((v) => v ?? undefined),
  auth_env: z.string(),
});

const OracleExtractResultSchema = z.object({
  vendor: z.string(),
  category: z.string(),
  slug: z.string(),
  suite_name: z.string(),
  extracted_at: z.string(),
  vendor_config: VendorConfigSchema,
  tasks: z.array(OracleExtractItemSchema),
});
export type OracleExtractResult = z.infer<typeof OracleExtractResultSchema>;

function buildExtractPrompt(vendor: ResolveResult, suite: Suite): string {
  const taskList = suite.tasks
    .map(
      (t, i) =>
        `  ${i + 1}. id="${t.id}" — ${t.oracle_hint.trim().replace(/\n\s*/g, " ")}`,
    )
    .join("\n");

  return [
    `${vendor.vendor} (${vendor.category}). Docs: ${vendor.docs_url}.`,
    ``,
    `For each task below, give ONLY the REST read-back call that verifies the described state.`,
    `Use {ns} as a literal placeholder for a namespace token embedded in resource names.`,
    `If ${vendor.vendor} cannot support a task at all (no REST API, or the mechanism is structurally absent), set na=true.`,
    ``,
    taskList,
    ``,
    `Also give the vendor's REST API base_url and auth scheme (auth_type: bearer|api-key|oauth|none, auth_header if not the default, auth_env: a SCREAMING_SNAKE_CASE env var name).`,
    ``,
    `Return ONLY this JSON object, no commentary:`,
    `{`,
    `  "vendor_config": {"base_url": "...", "auth_type": "...", "auth_header": "..." or null, "auth_env": "..."},`,
    `  "tasks": [{"task_id": "...", "na": false, "na_reason": null, "read_method": "GET", "read_path_template": "...", "assert_field": "..."}, ...]`,
    `}`,
    `Include all ${suite.tasks.length} task ids.`,
  ].join("\n");
}

export interface ExtractOraclesOptions {
  harness?: HarnessId;
  model?: string;
  effort?: Effort;
}

/** Extract oracle read-back paths + vendor config for a single vendor. */
export async function extractOracles(
  vendor: ResolveResult,
  suite: Suite,
  opts: ExtractOraclesOptions = {},
): Promise<OracleExtractResult> {
  const harness = opts.harness ?? "claude-code";
  const prompt = buildExtractPrompt(vendor, suite);
  const raw = await invokeHarness(prompt, { harness, model: opts.model, effort: opts.effort });
  const json = extractJsonObject(raw);
  const parsed = z
    .object({ vendor_config: VendorConfigSchema, tasks: z.array(OracleExtractItemSchema) })
    .safeParse(JSON.parse(json));
  if (!parsed.success) {
    throw new Error(
      `oracle-extract for "${vendor.vendor}" returned non-conforming JSON: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  const suiteIds = new Set(suite.tasks.map((t) => t.id));
  const returnedIds = new Set(parsed.data.tasks.map((t) => t.task_id));
  const missing = [...suiteIds].filter((id) => !returnedIds.has(id));
  if (missing.length > 0) {
    throw new Error(`oracle-extract for "${vendor.vendor}" missing task IDs: ${missing.join(", ")}`);
  }
  return OracleExtractResultSchema.parse({
    vendor: vendor.vendor,
    category: vendor.category,
    slug: vendor.slug,
    suite_name: suite.name,
    extracted_at: new Date().toISOString(),
    vendor_config: parsed.data.vendor_config,
    tasks: parsed.data.tasks,
  });
}

/** Extract oracles for multiple vendors in parallel. */
export async function extractOraclesAll(
  vendors: ResolveResult[],
  suite: Suite,
  opts: ExtractOraclesOptions = {},
): Promise<OracleExtractResult[]> {
  return Promise.all(vendors.map((v) => extractOracles(v, suite, opts)));
}

/** Path where an oracle-extract result is persisted. */
export function oracleExtractPath(root: string, slug: string, suiteName: string): string {
  return resolve(root, "targets", "extracts", slug, `${suiteName.toLowerCase()}.yaml`);
}

/** Write an oracle-extract to disk as YAML. */
export function writeOracleExtract(root: string, result: OracleExtractResult): string {
  const path = oracleExtractPath(root, result.slug, result.suite_name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yamlStringify(result));
  return path;
}

/** Load a previously-written oracle-extract. */
export function loadOracleExtract(root: string, slug: string, suiteName: string): OracleExtractResult | null {
  const path = oracleExtractPath(root, slug, suiteName);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const result = OracleExtractResultSchema.safeParse(yamlParse(raw));
  if (!result.success) {
    throw new Error(`oracle-extract at ${path} is malformed: ${result.error.issues.map((i) => i.message).join("; ")}`);
  }
  return result.data;
}
