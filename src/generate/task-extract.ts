/**
 * Oracle extract: given a vendor card + canonical suite, produce ONLY the
 * vendor-specific read-back checks for each suite task (plus a vendor-level
 * base_url/auth guess). This is the one part of pack authoring that
 * genuinely requires vendor knowledge — every other field (prompt, id,
 * title, difficulty) is rendered from the suite by pure code in
 * compose-pack.ts.
 *
 * Each check becomes one `roundtrip` OracleSpec entry: the verifier (see
 * generate/verify.ts) GETs/POSTs `read_path_template`, resolves the dotted
 * `assert_field` against the response via resolveDotted(), and compares it
 * to the literal `expected` value. assert_field MUST be a real dotted key
 * path (e.g. "count", "0.email", "documents.0.total") — free-text
 * explanations don't resolve to anything and silently fail as `undefined`.
 * Multi-step verification (e.g. "count is 1 AND the error code is X") is
 * modeled as two separate checks, not one compound sentence.
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

const OracleCheckSchema = z.object({
  read_method: z.enum(["GET", "POST"]).default("GET"),
  read_path_template: z.string().min(1),
  // A single dotted key path into the JSON response, e.g. "count",
  // "0.email", "documents.0.total". NOT a sentence.
  assert_field: z.string().min(1),
  // The literal value assert_field must equal. May contain "{ns}".
  expected: z.union([z.string(), z.number(), z.boolean()]),
  description: z.string().default(""),
});
export type OracleCheck = z.infer<typeof OracleCheckSchema>;

const OracleExtractItemSchema = z.object({
  task_id: z.string(),
  na: z.boolean(),
  na_reason: z.string().nullish().transform((v) => v ?? undefined),
  checks: z.array(OracleCheckSchema).default([]),
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
    `For each task below, give the REST read-back call(s) that verify the described state.`,
    `Use {ns} as a literal placeholder for a namespace token embedded in resource names.`,
    `If ${vendor.vendor} cannot support a task at all (no REST API, or the mechanism is structurally absent), set na=true and checks=[].`,
    ``,
    taskList,
    ``,
    `Each check is ONE machine-checkable assertion:`,
    `- read_method/read_path_template: the call to make`,
    `- assert_field: a SHORT DOTTED KEY PATH into the JSON response — e.g. "count", "0.email",`,
    `  "documents.0.total". NEVER a sentence or explanation.`,
    `- expected: the literal value assert_field must equal (a number, string, or boolean —`,
    `  taken directly from the task's stated expectation, e.g. 100, 11, 1, true)`,
    `- description: one short phrase for a human reviewer (optional)`,
    `If a task needs more than one assertion (e.g. "row count is 1" AND "error code is X"),`,
    `emit two separate check objects, not one compound sentence.`,
    ``,
    `Also give the vendor's REST API base_url and auth scheme (auth_type: bearer|api-key|oauth|none, auth_header if not the default, auth_env: a SCREAMING_SNAKE_CASE env var name).`,
    ``,
    `Return ONLY this JSON object, no commentary:`,
    `{`,
    `  "vendor_config": {"base_url": "...", "auth_type": "...", "auth_header": "..." or null, "auth_env": "..."},`,
    `  "tasks": [`,
    `    {"task_id": "...", "na": false, "na_reason": null, "checks": [`,
    `      {"read_method": "GET", "read_path_template": "...", "assert_field": "count", "expected": 100, "description": "..."}`,
    `    ]},`,
    `    ...`,
    `  ]`,
    `}`,
    `Include all ${suite.tasks.length} task ids.`,
  ].join("\n");
}

export interface ExtractOraclesOptions {
  harness?: HarnessId;
  model?: string;
  effort?: Effort;
}

/** Extract oracle read-back checks + vendor config for a single vendor. */
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

/** One vendor's extraction outcome — success or the error it failed with. */
export type ExtractOutcome =
  | { vendor: string; ok: true; result: OracleExtractResult }
  | { vendor: string; ok: false; error: string };

/** Extract oracles for multiple vendors in parallel. One vendor's failure
 *  (e.g. malformed LLM JSON) does not lose the other vendors' results —
 *  each runs an independent, expensive LLM call. */
export async function extractOraclesAll(
  vendors: ResolveResult[],
  suite: Suite,
  opts: ExtractOraclesOptions = {},
): Promise<ExtractOutcome[]> {
  const settled = await Promise.allSettled(vendors.map((v) => extractOracles(v, suite, opts)));
  return settled.map((s, i) => {
    const vendor = vendors[i]!.vendor;
    return s.status === "fulfilled"
      ? { vendor, ok: true as const, result: s.value }
      : { vendor, ok: false as const, error: s.reason instanceof Error ? s.reason.message : String(s.reason) };
  });
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
