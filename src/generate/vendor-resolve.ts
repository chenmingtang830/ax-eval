/**
 * Vendor resolve: given vendor name(s), find canonical site_url + docs_url
 * via a single LLM call that does WebSearch for each vendor.
 *
 * Batch-first design: resolveVendors() sends all vendors in one prompt so
 * the harness does N searches in a single invocation (~20-40 sec for 8
 * vendors vs 8 separate spawns). resolveVendor() is a thin wrapper for the
 * single-vendor CLI use case.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { z } from "zod";
import { invokeHarness, extractJsonObject, type HarnessId, type Effort } from "./harness.js";

const ResolveResultSchema = z.object({
  vendor: z.string(),
  category: z.string(),
  slug: z.string(),
  discovered_at: z.string(),
  resolver: z.object({
    method: z.literal("llm-search"),
    harness: z.string().optional(),
    model: z.string().optional(),
    prompt_version: z.string().optional(),
  }),
  site_url: z.string().nullable(),
  docs_url: z.string().nullable(),
  http_status: z.number().nullable(),
});
export type ResolveResult = z.infer<typeof ResolveResultSchema>;

const LlmBatchItemSchema = z.object({
  vendor: z.string(),
  site_url: z.string().nullable(),
  docs_url: z.string().nullable(),
});
const LlmBatchResultSchema = z.array(LlmBatchItemSchema);

export const PROMPT_VERSION = "vendor-resolve-v3";

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function buildBatchPrompt(vendors: string[], category: string): string {
  const list = vendors.map((v, i) => `  ${i + 1}. ${v}`).join("\n");
  return [
    `Find the canonical documentation URL for each of these ${category} products.`,
    `For each one, do a WebSearch for "<vendor name> docs" and return the root documentation page.`,
    "",
    "Products:",
    list,
    "",
    "Return ONLY a JSON array (no commentary, no markdown fences):",
    '[{"vendor": "Supabase", "site_url": "https://supabase.com", "docs_url": "https://supabase.com/docs"}, ...]',
  ].join("\n");
}

export interface ResolveVendorOptions {
  harness?: HarnessId;
  model?: string;
  effort?: Effort;
}

/** Resolve docs URLs for multiple vendors in a single LLM invocation. */
export async function resolveVendors(
  vendors: string[],
  category: string,
  opts: ResolveVendorOptions = {},
): Promise<ResolveResult[]> {
  const harness = opts.harness ?? "claude-code";
  const prompt = buildBatchPrompt(vendors, category);
  const raw = await invokeHarness(prompt, { harness, model: opts.model, effort: opts.effort });
  const json = extractJsonObject(raw);
  const parsed = LlmBatchResultSchema.safeParse(JSON.parse(json));
  if (!parsed.success) {
    throw new Error(
      `vendor-resolve batch returned non-conforming JSON: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  const now = new Date().toISOString();
  return parsed.data.map((item) =>
    ResolveResultSchema.parse({
      vendor: item.vendor,
      category,
      slug: slugify(item.vendor),
      discovered_at: now,
      resolver: {
        method: "llm-search",
        harness,
        model: opts.model ?? "host-default",
        prompt_version: PROMPT_VERSION,
      },
      site_url: item.site_url,
      docs_url: item.docs_url,
      http_status: null,
    }),
  );
}

/** Resolve a single vendor's docs URL. */
export async function resolveVendor(
  vendor: string,
  category: string,
  opts: ResolveVendorOptions = {},
): Promise<ResolveResult> {
  const results = await resolveVendors([vendor], category, opts);
  if (!results[0]) throw new Error(`vendor-resolve: no result returned for "${vendor}"`);
  return results[0];
}

/** Path where a resolved vendor card is persisted. */
export function vendorCardPath(root: string, slug: string): string {
  return resolve(root, "targets", "vendors", `${slug}.discovered.yaml`);
}

/** Write a vendor card to disk as YAML. */
export function writeVendorCard(root: string, result: ResolveResult): string {
  const path = vendorCardPath(root, result.slug);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yamlStringify(result));
  return path;
}

/** Load a previously-resolved vendor card. */
export function loadVendorCard(root: string, slug: string): ResolveResult | null {
  const path = vendorCardPath(root, slug);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const parsed = yamlParse(raw);
  const result = ResolveResultSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `vendor card at ${path} is malformed: ${result.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return result.data;
}
