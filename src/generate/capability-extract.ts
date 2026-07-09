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
import type { Effort, HarnessId } from "./harness.js";
import { invokeGenerator, extractJsonObjectWithRepair } from "./harness.js";
import {
  CapabilityEvidenceSchema,
  CapabilityInventorySchema,
  type CapabilityInventory,
  type CapabilityInventoryEntry,
  ExtractionProvenanceSchema,
  legacyCapabilityExtractPath,
  writeCapabilityInventory,
} from "./methodology.js";
import type { ResolveResult } from "./vendor-resolve.js";

const CapabilitySchema = z.object({
  capability_name: z.string(),
  title: z.string(),
  family: z.string(),
  description: z.string(),
  resource_kind: z.string(),
  operation_kind: z.string(),
  surfaces_documented: z.array(z.enum(["api", "sdk", "cli"])).default(["api", "sdk", "cli"]),
  support_type: z.enum(["native", "idiomatic-pattern", "managed-surface", "unknown"]).default("native"),
  evidence: z.array(CapabilityEvidenceSchema).min(1),
  extraction_provenance: ExtractionProvenanceSchema.optional(),
});
export type Capability = z.infer<typeof CapabilitySchema>;
export type CapabilityExtractResult = CapabilityInventory;
const CapabilityExtractResultSchema = CapabilityInventorySchema;

const LegacyCapabilityItemSchema = z.object({
  name: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  doc_url: z.string().min(1),
  doc_quote: z.string().optional(),
});

const LegacyCapabilityExtractSchema = z.object({
  vendor: z.string().min(1),
  slug: z.string().min(1),
  category: z.string().min(1),
  extracted_at: z.string().min(1),
  capabilities: z.array(LegacyCapabilityItemSchema),
});

function inferLegacyFamily(capability: z.infer<typeof LegacyCapabilityItemSchema>): CapabilityInventoryEntry["family"] {
  const primary = `${capability.name} ${capability.title}`.toLowerCase();
  const secondary = capability.description.toLowerCase();
  if (/\b(vector|embedding|semantic|similarity|ann|nearest-neighbor)\b/.test(primary)) return "search";
  if (/\b(full-text|keyword search|atlas search|tantivy|lucene|search)\b/.test(primary)) return "search";
  if (/\b(backup|restore|pitr|point-in-time)\b/.test(primary)) return "backup-and-recovery";
  if (/\b(cdc|change data capture|change stream|changefeed|logical replication|replication)\b/.test(primary)) return "change-data-capture";
  if (/\b(row-level|rls|rbac|role-based|access control|allowlist|authentication|auth)\b/.test(primary)) return "access-control";
  if (/\b(migration|schema change|schema migration|deploy request|online ddl|branching)\b/.test(primary)) return "migration";
  if (/\b(trigger|function|procedure|rpc|cron|action|compute|webhook)\b/.test(primary)) return "compute";
  if (/\b(foreign key|unique|constraint|validation|transaction|acid)\b/.test(primary)) return "integrity";
  if (/\b(table|column|schema definition|ddl)\b/.test(primary)) return "data-definition";
  if (/\b(import|export|copy|bulk)\b/.test(primary)) return "data-write";
  if (/\b(query|read|pagination|index|analytics|sql)\b/.test(primary)) return "data-read";
  if (/\b(change data capture|change stream|logical replication|realtime)\b/.test(secondary)) return "change-data-capture";
  return "core-operations";
}

function inferLegacyResourceKind(capability: z.infer<typeof LegacyCapabilityItemSchema>): CapabilityInventoryEntry["resource_kind"] {
  const primary = `${capability.name} ${capability.title}`.toLowerCase();
  if (/\b(table|column|schema)\b/.test(primary)) return "table";
  if (/\b(role|policy|auth|token)\b/.test(primary)) return "role";
  if (/\b(function|procedure|rpc|action|trigger|cron|webhook)\b/.test(primary)) return "function";
  if (/\b(index|search)\b/.test(primary)) return "index";
  if (/\b(backup|restore|snapshot|branch)\b/.test(primary)) return "backup";
  if (/\b(stream|replication|cdc|change stream|changefeed)\b/.test(primary)) return "stream";
  return "resource";
}

function inferLegacyOperationKind(capability: z.infer<typeof LegacyCapabilityItemSchema>): CapabilityInventoryEntry["operation_kind"] {
  const primary = `${capability.name} ${capability.title}`.toLowerCase();
  if (/\b(search|query)\b/.test(primary)) return "search";
  if (/\b(migration|schema change|ddl|deploy)\b/.test(primary)) return "migrate";
  if (/\b(restore|recover)\b/.test(primary)) return "restore";
  if (/\b(backup|snapshot)\b/.test(primary)) return "backup";
  if (/\b(stream|replication|cdc|subscribe)\b/.test(primary)) return "stream";
  if (/\b(create|branch|import)\b/.test(primary)) return "create";
  if (/\b(export)\b/.test(primary)) return "export";
  if (/\b(read|fetch)\b/.test(primary)) return "read";
  return "operate";
}

function normalizeLegacyCapabilityExtract(legacy: z.infer<typeof LegacyCapabilityExtractSchema>): CapabilityExtractResult {
  return CapabilityExtractResultSchema.parse({
    vendor: legacy.vendor,
    slug: legacy.slug,
    category: legacy.category,
    extracted_at: legacy.extracted_at,
    capabilities: legacy.capabilities.map((capability) => ({
      capability_name: capability.name,
      title: capability.title,
      family: inferLegacyFamily(capability),
      description: capability.description,
      resource_kind: inferLegacyResourceKind(capability),
      operation_kind: inferLegacyOperationKind(capability),
      surfaces_documented: ["api", "sdk", "cli"],
      support_type: "unknown",
      evidence: [{
        doc_url: capability.doc_url,
        quote: capability.doc_quote ?? capability.description,
      }],
      extraction_provenance: {
        source: "official-docs",
        extracted_at: legacy.extracted_at,
        extractor: "legacy-capabilities-normalizer-v1",
      },
    })),
  });
}

function categoryCoverageChecklist(category: string): string[] {
  if (category !== "database") return [];
  return [
    "Baseline data definition: creating tables/collections, defining columns/fields, or schema introspection.",
    "Baseline data writes: inserts, updates, deletes, bulk writes/imports, or equivalent record mutation flows.",
    "Baseline data reads: filtered queries, sorting/pagination, counts, read-back/introspection, or equivalent retrieval flows.",
    "Schema evolution: tracked migrations, schema change workflows, branching, or deploy/apply mechanisms when documented.",
    "Integrity controls: constraints, schema validation, transactions, or equivalent correctness guarantees.",
    "Access control: row-level policies, role-based access, identity-scoped tokens, or equivalent permission boundaries.",
    "Operational recovery: backups, snapshots, restore, point-in-time recovery, export/import, or equivalent recovery paths.",
    "Server-side execution: functions, triggers, procedures, jobs, webhooks, or equivalent in-database/runtime compute.",
    "Advanced but benchmark-relevant capabilities when present: full-text search, vector search, change-data-capture, realtime subscriptions.",
  ];
}

export function buildCapabilityPrompt(vendor: ResolveResult): string {
  const checklist = categoryCoverageChecklist(vendor.category);
  return [
    `${vendor.vendor} (${vendor.category}).`,
    ``,
    `WebFetch ${vendor.docs_url} and follow linked pages (guides, API/SDK reference, feature list) as needed.`,
    `Ground every capability in what you actually read — cite the specific doc URL and, where practical, a`,
    `short supporting quote. Do not list capabilities from memory/training knowledge alone.`,
    ``,
    `Build a benchmark-grade capability inventory for ${vendor.vendor} AS A ${vendor.category.toUpperCase()}.`,
    `Capture the documented capabilities a benchmark author would need to reason about canonical task coverage.`,
    `This is an inventory stage, not a "top 10" ranking stage: include every benchmark-relevant documented`,
    `capability you can find across the main capability families the docs expose; do NOT stop at the most`,
    `important 10-20 if the docs clearly cover more.`,
    `Do NOT over-index on differentiated premium/platform features while skipping baseline operational capabilities.`,
    `If the docs show a general SQL surface, document API, Postgres/SQLite compatibility, table API, or typed SDK,`,
    `you MUST also inventory the baseline operations that surface enables when the docs support them`,
    `(for example: create table/collection, insert rows/documents, filtered reads/querying, pagination/count/read-back,`,
    `schema introspection, export/import, or tracked schema changes). Those baseline ops are part of the benchmark`,
    `concept universe even if the vendor does not market them as named flagship features.`,
    checklist.length ? "" : undefined,
    checklist.length ? "Coverage checklist to close before you stop:" : undefined,
    ...checklist.map((line, index) => `${index + 1}. ${line}`),
    checklist.length ? "" : undefined,
    `Prefer product capabilities that can underpin benchmark tasks over pure compliance posture, pricing, or generic hosting claims.`,
    ``,
    `For each capability:`,
    `- capability_name: a short, generic, cross-vendor-comparable slug (kebab-case) for the CAPABILITY, not the vendor's`,
    `  product name for it — e.g. "row-level-security" not "supabase-rls", "schema-migration" not`,
    `  "database-migrations-feature". This lets the same capability be recognized across different vendors.`,
    `- family: a benchmark-oriented family such as data-definition, data-write, data-read, access-control,`,
    `  integrity, migration, search, compute, change-data-capture, or backup-and-recovery. Prefer a family`,
    `  from the docs' actual behavior, not marketing taxonomy.`,
    `- title: short human title`,
    `- description: 1-2 sentences, what it actually does`,
    `- resource_kind: the primary resource type touched (table, row, collection, role, function, snapshot, etc.)`,
    `- operation_kind: the primary operation type (create, read, update, search, migrate, restore, stream, etc.)`,
    `- surfaces_documented: subset of ["api","sdk","cli"] directly evidenced in the docs`,
    `- support_type: native | idiomatic-pattern | managed-surface | unknown`,
    `- evidence: one or more objects with {doc_url, quote, note?}; doc_url must be a specific page, not only the docs root`,
    `- extraction_provenance: {"source":"official-docs","extracted_at":"<iso>","extractor":"llm-capability-inventory-v1"}`,
    ``,
    `Return ONLY this JSON object, no commentary:`,
    `{"capabilities": [`,
    `  {"capability_name": "...", "title": "...", "family": "...", "description": "...", "resource_kind": "...",`,
    `   "operation_kind": "...", "surfaces_documented": ["api","cli"], "support_type": "native", "evidence": [{"doc_url": "...", "quote": "..."}],`,
    `   "extraction_provenance": {"source":"official-docs","extracted_at":"2026-01-01T00:00:00.000Z","extractor":"llm-capability-inventory-v1"}}`,
    `]}`,
  ].filter((line): line is string => typeof line === "string").join("\n");
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
  const raw = await invokeGenerator(buildCapabilityPrompt(vendor), {
    requireWebFetch: true,
    fallbackHarness: (opts.harness === "codex" ? "claude-code" : opts.harness) ?? "claude-code",
    model: opts.model,
    effort: opts.effort,
    heartbeat: { everyMs: 30_000, label },
    timeoutMs: TIMEOUT_MS,
  });
  const json = await extractJsonObjectWithRepair(raw, {
    fallbackHarness: (opts.harness === "codex" ? "claude-code" : opts.harness) ?? "claude-code",
    model: opts.model,
    effort: opts.effort,
    label,
  });
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
    capabilities: parsed.data.capabilities.map((cap) => ({
      ...cap,
      extraction_provenance: cap.extraction_provenance ?? {
        source: "official-docs",
        extracted_at: new Date().toISOString(),
        extractor: "llm-capability-inventory-v1",
      },
    })),
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
  return legacyCapabilityExtractPath(root, slug);
}

export function writeCapabilityExtract(root: string, result: CapabilityExtractResult): string {
  const newPath = writeCapabilityInventory(root, result);
  return newPath;
}

export function loadCapabilityExtract(root: string, slug: string): CapabilityExtractResult | null {
  const inventoryPath = resolve(root, "targets", "extracts", slug, "capability-inventory.yaml");
  const legacyPath = capabilityExtractPath(root, slug);

  if (existsSync(inventoryPath)) {
    const inventoryRaw = readFileSync(inventoryPath, "utf8");
    const inventory = CapabilityExtractResultSchema.safeParse(yamlParse(inventoryRaw));
    if (inventory.success) {
      const isLegacyNormalized = inventory.data.capabilities.some(
        (capability) => capability.extraction_provenance.extractor === "legacy-capabilities-normalizer-v1",
      );
      if (!isLegacyNormalized || !existsSync(legacyPath)) return inventory.data;
    }
  }

  if (!existsSync(legacyPath)) return null;
  const raw = readFileSync(legacyPath, "utf8");
  const legacy = LegacyCapabilityExtractSchema.safeParse(yamlParse(raw));
  if (legacy.success) {
    const normalized = normalizeLegacyCapabilityExtract(legacy.data);
    writeCapabilityInventory(root, normalized);
    return normalized;
  }
  const result = CapabilityExtractResultSchema.safeParse(yamlParse(raw));
  if (result.success) return result.data;
  throw new Error(`capability-extract at ${legacyPath} is malformed: ${result.error.issues.map((i) => i.message).join("; ")}`);
}
