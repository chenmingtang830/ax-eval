/**
 * Capability extract: Layer 0a of suite authoring. One grounded call per
 * vendor asks "what are this product's most important, documented
 * capabilities in this category?" — raw, unfiltered, cited evidence.
 *
 * This is the reproducibility/audit foundation for the canonical suite:
 * synthesize-suite reads these files (never re-derives from memory), so
 * anyone can rerun extract-capabilities themselves and check that the
 * final suite's tasks trace back to real, cited vendor documentation
 * rather than the benchmark author's assumptions.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { z } from "zod";
import { invokeHarness, extractJsonObject, type HarnessId, type Effort } from "./harness.js";
import type { ResolveResult } from "./vendor-resolve.js";

const CapabilitySchema = z.object({
  // Short, stable, cross-vendor-comparable slug for clustering later, e.g.
  // "row-level-security", "schema-migration". Use a generic category-level
  // name, not a vendor-specific product name.
  name: z.string(),
  title: z.string(),
  description: z.string(),
  doc_url: z.string(),
  doc_quote: z.string().nullish().transform((v) => v ?? undefined),
});
export type Capability = z.infer<typeof CapabilitySchema>;

const CapabilityExtractResultSchema = z.object({
  vendor: z.string(),
  slug: z.string(),
  category: z.string(),
  extracted_at: z.string(),
  capabilities: z.array(CapabilitySchema),
});
export type CapabilityExtractResult = z.infer<typeof CapabilityExtractResultSchema>;

function buildCapabilityPrompt(vendor: ResolveResult): string {
  return [
    `${vendor.vendor} (${vendor.category}).`,
    ``,
    `WebFetch ${vendor.docs_url} and follow linked pages (guides, API/SDK reference, feature list) as needed.`,
    `Ground every capability in what you actually read — cite the specific doc URL and, where practical, a`,
    `short supporting quote. Do not list capabilities from memory/training knowledge alone.`,
    ``,
    `List the most important, documented capabilities of ${vendor.vendor} AS A ${vendor.category.toUpperCase()}`,
    `— the kinds of things a developer/agent would actually DO with it (not marketing claims, not pricing/`,
    `plans). Aim for the 10-20 most significant, concrete capabilities spanning different areas (e.g. for a`,
    `database: schema/data-definition, data read/write, access control, data integrity/constraints,`,
    `import/export, schema evolution, compute/runtime integration, operational/backup concerns — but use`,
    `whatever areas ${vendor.vendor}'s OWN docs actually emphasize, don't force a fixed list).`,
    ``,
    `For each capability:`,
    `- name: a short, generic, cross-vendor-comparable slug (kebab-case) for the CAPABILITY, not the vendor's`,
    `  product name for it — e.g. "row-level-security" not "supabase-rls", "schema-migration" not`,
    `  "database-migrations-feature". This lets the same capability be recognized across different vendors.`,
    `- title: short human title`,
    `- description: 1-2 sentences, what it actually does`,
    `- doc_url: the specific page you found it on (not just the docs root)`,
    `- doc_quote: a short supporting quote from that page, if one clearly demonstrates the capability`,
    ``,
    `Return ONLY this JSON object, no commentary:`,
    `{"capabilities": [`,
    `  {"name": "...", "title": "...", "description": "...", "doc_url": "...", "doc_quote": "..." or null}`,
    `]}`,
  ].join("\n");
}

export interface ExtractCapabilitiesOptions {
  harness?: HarnessId;
  model?: string;
  effort?: Effort;
}

const TIMEOUT_MS = 8 * 60 * 1000;

/** Extract raw, cited capabilities for a single vendor. */
export async function extractCapabilities(
  vendor: ResolveResult,
  opts: ExtractCapabilitiesOptions = {},
): Promise<CapabilityExtractResult> {
  const label = `${vendor.vendor}/capabilities`;
  const raw = await invokeHarness(buildCapabilityPrompt(vendor), {
    harness: opts.harness ?? "claude-code",
    model: opts.model,
    effort: opts.effort,
    requireWebFetch: true,
    heartbeat: { everyMs: 30_000, label },
    timeoutMs: TIMEOUT_MS,
  });
  const json = extractJsonObject(raw);
  const parsed = z.object({ capabilities: z.array(CapabilitySchema) }).safeParse(JSON.parse(json));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
    throw new Error(`capability-extract for "${label}" returned non-conforming JSON: ${issues}\nRaw: ${json.slice(0, 2000)}`);
  }
  return CapabilityExtractResultSchema.parse({
    vendor: vendor.vendor,
    slug: vendor.slug,
    category: vendor.category,
    extracted_at: new Date().toISOString(),
    capabilities: parsed.data.capabilities,
  });
}

export type CapabilityOutcome =
  | { vendor: string; ok: true; result: CapabilityExtractResult }
  | { vendor: string; ok: false; error: string };

/** Extract capabilities for multiple vendors in parallel. */
export async function extractCapabilitiesAll(
  vendors: ResolveResult[],
  opts: ExtractCapabilitiesOptions = {},
): Promise<CapabilityOutcome[]> {
  const settled = await Promise.allSettled(vendors.map((v) => extractCapabilities(v, opts)));
  return settled.map((s, i) => {
    const vendor = vendors[i]!.vendor;
    return s.status === "fulfilled"
      ? { vendor, ok: true as const, result: s.value }
      : { vendor, ok: false as const, error: s.reason instanceof Error ? s.reason.message : String(s.reason) };
  });
}

export function capabilityExtractPath(root: string, slug: string): string {
  return resolve(root, "targets", "extracts", slug, "capabilities.yaml");
}

export function writeCapabilityExtract(root: string, result: CapabilityExtractResult): string {
  const path = capabilityExtractPath(root, result.slug);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yamlStringify(result));
  return path;
}

export function loadCapabilityExtract(root: string, slug: string): CapabilityExtractResult | null {
  const path = capabilityExtractPath(root, slug);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const result = CapabilityExtractResultSchema.safeParse(yamlParse(raw));
  if (!result.success) {
    throw new Error(`capability-extract at ${path} is malformed: ${result.error.issues.map((i) => i.message).join("; ")}`);
  }
  return result.data;
}
