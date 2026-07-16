import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { z } from "zod";
import { assertArtifactSegment } from "./artifact-path.js";
import { loadOptionalYamlArtifact } from "./artifact-yaml.js";
import { PublicHttpUrlSchema, urlUsesOfficialHost } from "./public-url.js";
import { parseStructuredOutput, runStructuredGenerator, type StructuredGenerator } from "./structured-output.js";
import type { ResolveResult } from "./vendor-resolve.js";

const CapabilityEvidenceSchema = z.object({
  doc_url: PublicHttpUrlSchema,
  quote: z.string().min(1),
  note: z.string().optional(),
});

const CapabilitySchema = z.object({
  capability_name: z.string().min(1),
  title: z.string().min(1),
  family: z.string().min(1),
  description: z.string().min(1),
  resource_kind: z.string().min(1),
  operation_kind: z.string().min(1),
  surfaces_documented: z.array(z.enum(["api", "cli", "sdk", "mcp"])).default([]),
  support_type: z.enum(["native", "idiomatic-pattern", "managed-surface", "unknown"]).default("native"),
  evidence: z.array(CapabilityEvidenceSchema).min(1),
});

const CapabilityExtractSchema = z.object({
  vendor: z.string().min(1),
  slug: z.string().min(1),
  category: z.string().min(1),
  extracted_at: z.string().datetime(),
  extraction_provenance: z.object({
    source: z.literal("official-docs"),
    extractor: z.string().min(1),
  }),
  capabilities: z.array(CapabilitySchema).min(1),
});

export type CapabilityExtractResult = z.infer<typeof CapabilityExtractSchema>;

export function buildCapabilityPrompt(vendor: ResolveResult): string {
  return [
    `Read the official documentation for ${vendor.vendor} (${vendor.category}) starting at ${vendor.docs_url}.`,
    "Use web fetch/search and cite only official vendor documentation URLs.",
    "Inventory documented capabilities before selecting benchmark tasks.",
    "For database products, cover baseline operational capabilities: create table/collection, insert rows/documents,",
    "filtered reads/querying, schema introspection, access control, tracked schema changes, export, and recovery where documented.",
    "Coverage checklist to close before you stop: data definition, writes, reads, integrity, access control, migration, and operations.",
    "Return JSON only: {\"capabilities\":[{\"capability_name\":...,\"title\":...,\"family\":...,\"description\":...,",
    "\"resource_kind\":...,\"operation_kind\":...,\"surfaces_documented\":[...],\"support_type\":...,",
    "\"evidence\":[{\"doc_url\":...,\"quote\":...,\"note\":...}]}]}.",
  ].join("\n");
}

export interface ExtractCapabilitiesOptions {
  generate?: StructuredGenerator;
  extractor?: string;
  now?: () => Date;
}

export async function extractCapabilities(
  vendor: ResolveResult,
  options: ExtractCapabilitiesOptions = {},
): Promise<CapabilityExtractResult> {
  if (!vendor.docs_url) throw new Error(`cannot extract capabilities for ${vendor.vendor}: docs_url is missing`);
  const generated = z.object({ capabilities: z.array(CapabilitySchema).min(1) }).safeParse(
    parseStructuredOutput(await runStructuredGenerator(buildCapabilityPrompt(vendor), options.generate)),
  );
  if (!generated.success) {
    throw new Error(`capability extract for ${vendor.vendor} is invalid: ${generated.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  for (const capability of generated.data.capabilities) {
    for (const evidence of capability.evidence) {
      if (!urlUsesOfficialHost(evidence.doc_url, [vendor.docs_url, vendor.site_url])) {
        throw new Error(`capability ${capability.capability_name} cites non-official host ${evidence.doc_url}`);
      }
    }
  }
  return CapabilityExtractSchema.parse({
    vendor: vendor.vendor,
    slug: vendor.slug,
    category: vendor.category,
    extracted_at: (options.now ?? (() => new Date()))().toISOString(),
    extraction_provenance: { source: "official-docs", extractor: options.extractor ?? "host-default" },
    capabilities: generated.data.capabilities,
  });
}

export function capabilityExtractPath(root: string, slug: string): string {
  return resolve(root, "targets", "extracts", assertArtifactSegment(slug, "vendor slug"), "capabilities.yaml");
}

export function writeCapabilityExtract(root: string, result: CapabilityExtractResult): string {
  const path = capabilityExtractPath(root, result.slug);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, yamlStringify(CapabilityExtractSchema.parse(result)));
  renameSync(`${path}.tmp`, path);
  return path;
}

export function loadCapabilityExtract(root: string, slug: string): CapabilityExtractResult | null {
  return loadCapabilityExtractPath(capabilityExtractPath(root, slug));
}

export function loadCapabilityExtractPath(path: string): CapabilityExtractResult | null {
  return loadOptionalYamlArtifact(path, CapabilityExtractSchema, "capability extract");
}
