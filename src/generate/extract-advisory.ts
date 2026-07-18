/**
 * Opt-in semantic audit. It is deliberately advisory: deterministic extract
 * and suite audits remain the only blocking gates. Findings are persisted as
 * a review artifact and never mutate inventories, support matrices, or packs.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { z } from "zod";
import { invokeGenerator, extractJsonObjectWithRepair } from "./harness.js";
import { loadCapabilityExtract } from "./capability-extract.js";
import { loadSurfaceExtract } from "./surface-extract.js";
import { daebVendorExtractDir } from "./benchmark-paths.js";
import type { Effort, HarnessId } from "./harness.js";

const AdvisoryFindingSchema = z.object({
  severity: z.enum(["info", "warn"]),
  topic: z.enum(["self_service", "surface_auth", "sdk_grounding", "task_fit"]),
  message: z.string().min(1),
  doc_url: z.string().url(),
  quote: z.string().min(1),
});
const AdvisoryResultSchema = z.object({
  findings: z.array(AdvisoryFindingSchema).max(12),
});

export type ExtractAdvisory = z.infer<typeof AdvisoryResultSchema> & {
  schema: "ax.extract-advisory/v1";
  vendor: string;
  slug: string;
  generated_at: string;
};

export async function adviseVendorExtract(
  root: string,
  slug: string,
  opts: { harness?: HarnessId; model?: string; effort?: Effort } = {},
): Promise<ExtractAdvisory> {
  const inventory = loadCapabilityExtract(root, slug);
  const surfaces = loadSurfaceExtract(root, slug);
  if (!inventory || !surfaces) throw new Error(`advisory audit requires inventory and surfaces for ${slug}`);
  const compactCapabilities = inventory.capabilities.map((cap) => ({
    capability_name: cap.capability_name,
    title: cap.title,
    surfaces_documented: cap.surfaces_documented,
    support_type: cap.support_type,
    evidence: cap.evidence.map((e) => ({ doc_url: e.doc_url, quote: e.quote })),
  }));
  const prompt = [
    `Audit this database vendor extraction for semantic risks. You MUST WebFetch every URL you cite.`,
    `This is advisory only: do not invent capability support. Review self-service vs support-mediated operations,`,
    `CLI/SDK headless auth, GUI mislabeled as CLI, and whether a cited capability can perform a DAEB operational task.`,
    `Vendor: ${inventory.vendor}`,
    `CLI surface: ${JSON.stringify(surfaces.cli ?? null)}`,
    `SDK surface: ${JSON.stringify(surfaces.sdk ?? null)}`,
    `Capabilities/evidence: ${JSON.stringify(compactCapabilities)}`,
    `Return ONLY JSON: {"findings":[{"severity":"warn|info","topic":"self_service|surface_auth|sdk_grounding|task_fit","message":"...","doc_url":"https://...","quote":"exact fetched quote"}]}`,
  ].join("\n");
  const raw = await invokeGenerator(prompt, {
    fallbackHarness: opts.harness ?? "claude-code",
    model: opts.model,
    effort: opts.effort,
    requireWebFetch: true,
    heartbeat: { everyMs: 30_000, label: `${inventory.vendor}/advisory` },
  });
  const json = await extractJsonObjectWithRepair(raw, {
    fallbackHarness: opts.harness ?? "claude-code",
    model: opts.model,
    effort: opts.effort,
    label: `${inventory.vendor}/advisory`,
  });
  const parsed = AdvisoryResultSchema.parse(JSON.parse(json));
  return {
    schema: "ax.extract-advisory/v1",
    vendor: inventory.vendor,
    slug,
    generated_at: new Date().toISOString(),
    ...parsed,
  };
}

export function writeExtractAdvisory(root: string, advisory: ExtractAdvisory): string {
  const path = resolve(daebVendorExtractDir(root, advisory.slug), "advisory.yaml");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yamlStringify(advisory));
  return path;
}
