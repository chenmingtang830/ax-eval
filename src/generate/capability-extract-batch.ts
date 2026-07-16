import { fetchSpecText } from "../ingest/run.js";
import { summarizeOpenApiText } from "../ingest/spec-summary.js";
import type { GeneratorHarnessConfig } from "./authoring.js";
import { extractCapabilities, type CapabilityExtractResult } from "./capability-extract.js";
import { mapSettledLimit } from "./concurrency.js";
import { parseSelectedMappings } from "./selected-mapping.js";
import type { StructuredGenerator } from "./structured-output.js";
import type { ResolveResult } from "./vendor-resolve.js";

export const CAPABILITY_EXTRACTION_TIMEOUT_MS = 12 * 60 * 1000;

export function capabilityExtractionHarnessConfig(config: GeneratorHarnessConfig): GeneratorHarnessConfig {
  return { ...config, timeoutMs: CAPABILITY_EXTRACTION_TIMEOUT_MS };
}
export const MAX_CAPABILITY_SPEC_BYTES = 5 * 1024 * 1024;

export function parseCapabilitySpecMappings(
  entries: readonly string[],
  selectedSlugs: readonly string[],
): Map<string, string> {
  return parseSelectedMappings(entries, selectedSlugs, "--capability-spec");
}

export interface CapabilityExtractBatchOptions {
  specSources?: ReadonlyMap<string, string>;
  maxSpecOperations?: number;
  concurrency?: number;
  offline?: boolean;
  resolveHost?: (hostname: string) => Promise<readonly string[]>;
  fetchRemote?: (url: URL, addresses: readonly string[], signal: AbortSignal) => Promise<Response>;
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
            allowLocalFiles: options.offline === true,
            allowedRemoteRoots: [vendor.docs_url, vendor.site_url].filter((value): value is string => Boolean(value)),
            rejectPrivateNetwork: true,
            maxBytes: MAX_CAPABILITY_SPEC_BYTES,
            resolveHost: options.resolveHost,
            fetchRemote: options.fetchRemote,
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
