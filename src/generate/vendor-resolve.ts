import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { z } from "zod";
import { assertArtifactSegment } from "./artifact-path.js";
import { loadOptionalYamlArtifact } from "./artifact-yaml.js";
import { parseStructuredOutput, runStructuredGenerator, type StructuredGenerator } from "./structured-output.js";
import { PublicHttpUrlSchema } from "./public-url.js";

export const ResolveResultSchema = z.object({
  vendor: z.string().min(1),
  category: z.string().min(1),
  slug: z.string().min(1),
  discovered_at: z.string().datetime(),
  resolver: z.object({
    method: z.literal("grounded-generator"),
    harness: z.string().optional(),
    model: z.string().optional(),
    prompt_version: z.string(),
  }),
  site_url: PublicHttpUrlSchema.nullable(),
  docs_url: PublicHttpUrlSchema.nullable(),
});

const GeneratedVendorSchema = z.object({
  vendor: z.string().min(1),
  site_url: PublicHttpUrlSchema.nullable(),
  docs_url: PublicHttpUrlSchema.nullable(),
});

export type ResolveResult = z.infer<typeof ResolveResultSchema>;
export const VENDOR_RESOLVE_PROMPT_VERSION = "vendor-resolve-v4";

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function buildVendorResolvePrompt(vendors: readonly string[], category: string): string {
  return [
    `Research the canonical website and official documentation root for each ${category} product below.`,
    "Use web search and official vendor pages; do not answer from memory alone.",
    "Return exactly one object per requested vendor, preserving each vendor name exactly.",
    "Return JSON only with fields vendor, site_url, and docs_url. Use null only when official evidence cannot be found.",
    "",
    ...vendors.map((vendor) => `- ${vendor}`),
  ].join("\n");
}

export interface ResolveVendorOptions {
  generate?: StructuredGenerator;
  harness?: string;
  model?: string;
  now?: () => Date;
}

export async function resolveVendors(
  vendors: readonly string[],
  category: string,
  options: ResolveVendorOptions = {},
): Promise<ResolveResult[]> {
  if (vendors.length === 0) return [];
  const duplicateInput = vendors.find((vendor, index) => vendors.indexOf(vendor) !== index);
  if (duplicateInput) throw new Error(`vendor list contains duplicate entry ${duplicateInput}`);

  const raw = await runStructuredGenerator(buildVendorResolvePrompt(vendors, category), options.generate);
  const parsed = z.array(GeneratedVendorSchema).safeParse(parseStructuredOutput(raw));
  if (!parsed.success) {
    throw new Error(`vendor resolve returned non-conforming output: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  const byVendor = new Map<string, z.infer<typeof GeneratedVendorSchema>>();
  for (const item of parsed.data) {
    if (byVendor.has(item.vendor)) throw new Error(`vendor resolve returned duplicate result ${item.vendor}`);
    byVendor.set(item.vendor, item);
  }
  const missing = vendors.filter((vendor) => !byVendor.has(vendor));
  const extra = [...byVendor.keys()].filter((vendor) => !vendors.includes(vendor));
  if (missing.length || extra.length) {
    throw new Error(`vendor resolve result mismatch: missing [${missing.join(", ")}], extra [${extra.join(", ")}]`);
  }

  const discoveredAt = (options.now ?? (() => new Date()))().toISOString();
  return vendors.map((vendor) => {
    const item = byVendor.get(vendor)!;
    return ResolveResultSchema.parse({
      vendor,
      category,
      slug: slugify(vendor),
      discovered_at: discoveredAt,
      resolver: {
        method: "grounded-generator",
        harness: options.harness,
        model: options.model,
        prompt_version: VENDOR_RESOLVE_PROMPT_VERSION,
      },
      site_url: item.site_url,
      docs_url: item.docs_url,
    });
  });
}

export async function resolveVendor(
  vendor: string,
  category: string,
  options: ResolveVendorOptions = {},
): Promise<ResolveResult> {
  const [result] = await resolveVendors([vendor], category, options);
  if (!result) throw new Error(`vendor resolve returned no result for ${vendor}`);
  return result;
}

export function vendorCardPath(root: string, slug: string): string {
  return resolve(root, "targets", "vendors", `${assertArtifactSegment(slug, "vendor slug")}.discovered.yaml`);
}

export function writeVendorCard(root: string, result: ResolveResult): string {
  const path = vendorCardPath(root, result.slug);
  const temporaryPath = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temporaryPath, yamlStringify(ResolveResultSchema.parse(result)));
  renameSync(temporaryPath, path);
  return path;
}

export function loadVendorCard(root: string, slug: string): ResolveResult | null {
  return loadVendorCardPath(vendorCardPath(root, slug));
}

export function loadVendorCardPath(path: string): ResolveResult | null {
  return loadOptionalYamlArtifact(path, ResolveResultSchema, "vendor card");
}
