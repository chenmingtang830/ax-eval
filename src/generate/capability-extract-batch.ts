import { fetchSpecText } from "../ingest/run.js";
import { summarizeOpenApiText } from "../ingest/spec-summary.js";
import { extractCapabilities, type CapabilityExtractResult } from "./capability-extract.js";
import { mapSettledLimit } from "./concurrency.js";
import type { StructuredGenerator } from "./structured-output.js";
import type { ResolveResult } from "./vendor-resolve.js";

export function parseCapabilitySpecMappings(
  entries: readonly string[],
  selectedSlugs: readonly string[],
): Map<string, string> {
  const selected = new Set(selectedSlugs);
  const mappings = new Map<string, string>();
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    const slug = separator < 0 ? "" : entry.slice(0, separator).trim();
    const source = separator < 0 ? "" : entry.slice(separator + 1).trim();
    if (!slug || !source) throw new Error("--capability-spec expects <slug>=<source>");
    if (!selected.has(slug)) throw new Error(`--capability-spec names unselected vendor ${slug}`);
    if (mappings.has(slug)) throw new Error(`duplicate --capability-spec for ${slug}`);
    mappings.set(slug, source);
  }
  return mappings;
}

export interface CapabilityExtractBatchOptions {
  specSources?: ReadonlyMap<string, string>;
  maxSpecOperations?: number;
  concurrency?: number;
  offline?: boolean;
  generate?: StructuredGenerator;
  extractor?: string;
}

export interface CapabilityExtractBatchResult {
  vendor: ResolveResult;
  extract: CapabilityExtractResult;
  specSource?: string;
}

export async function extractCapabilitiesBatch(
  vendors: readonly ResolveResult[],
  options: CapabilityExtractBatchOptions = {},
): Promise<PromiseSettledResult<CapabilityExtractBatchResult>[]> {
  const concurrency = Math.min(options.concurrency ?? 3, 3);
  const maxSpecOperations = options.maxSpecOperations ?? 150;
  return mapSettledLimit(vendors, concurrency, async (vendor) => {
    const specSource = options.specSources?.get(vendor.slug);
    const fetchedSpec = specSource
      ? await fetchSpecText(specSource, {
            offline: options.offline,
            allowFixtureFallback: false,
          })
      : undefined;
    const specSummary = fetchedSpec
      ? summarizeOpenApiText(
          fetchedSpec.text,
          fetchedSpec.source,
          maxSpecOperations,
        )
      : undefined;
    const extract = await extractCapabilities(vendor, {
      generate: options.generate,
      extractor: options.extractor,
      specSummary,
    });
    return { vendor, extract, specSource };
  });
}
