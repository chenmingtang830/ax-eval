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
  capabilityInventoryPath,
  legacyCapabilityExtractPath,
  writeCapabilityInventory,
} from "./methodology.js";
import type { ResolveResult } from "./vendor-resolve.js";

const CanonicalSurfaceSchema = z.enum(["api", "sdk", "cli"]);

/** Map model-invented surface labels onto the canonical api/sdk/cli set.
 *  SQL/wire/console are not first-class surfaces in this inventory schema. */
export function normalizeSurfacesDocumented(raw: unknown): Array<"api" | "sdk" | "cli"> {
  if (!Array.isArray(raw)) return ["api", "sdk", "cli"];
  const out = new Set<"api" | "sdk" | "cli">();
  for (const item of raw) {
    const s = String(item).trim().toLowerCase();
    if (s === "api" || s === "rest" || s === "http" || s === "graphql") out.add("api");
    else if (s === "sdk" || s === "client" || s === "library" || s === "driver") out.add("sdk");
    else if (s === "cli" || s === "command-line" || s === "shell") out.add("cli");
    // sql / wire / psql / console / ui → drop; evidence still carries the detail
  }
  return out.size ? [...out] : ["api"];
}

const CapabilitySchema = z.object({
  capability_name: z.string(),
  title: z.string(),
  family: z.string().optional(),
  description: z.string(),
  resource_kind: z.string(),
  operation_kind: z.string(),
  surfaces_documented: z.preprocess(normalizeSurfacesDocumented, z.array(CanonicalSurfaceSchema)).default(["api", "sdk", "cli"]),
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

export function buildCapabilityPrompt(vendor: ResolveResult, specSummary?: string): string {
  const checklist = categoryCoverageChecklist(vendor.category);
  const groundingBlock = specSummary
    ? [
        `You have a SEED of documented API operations from ${vendor.vendor}'s OpenAPI / registry surface.`,
        `Treat them as the candidate surface area — start from this set, group related ops into capabilities,`,
        `and include benchmark-relevant capabilities the operations imply even if not marketed as features.`,
        ``,
        `Then WebFetch ${vendor.docs_url} and follow linked guides / API / SDK / CLI pages to gap-fill.`,
        `The seed is usually control-plane / Management API heavy: you MUST also inventory data-plane and`,
        `docs-only capabilities the seed misses when the docs support them (SQL/table APIs, SDK client ops,`,
        `RLS/auth, realtime, migrations, backups, etc.). Do not stop at the seed alone.`,
        `Ground every capability in what you actually read — cite a specific doc URL and, where practical, a`,
        `short supporting quote. Prefer page-specific docs over the OpenAPI root when both exist.`,
        `Do not list capabilities from memory/training knowledge alone.`,
        ``,
        `=== SEEDED API OPERATIONS (candidate surface) ===`,
        specSummary,
        `=== END SEEDED OPERATIONS ===`,
        ``,
      ]
    : [
        `WebFetch ${vendor.docs_url} and follow linked pages (guides, API/SDK reference, feature list) as needed.`,
        `Ground every capability in what you actually read — cite the specific doc URL and, where practical, a`,
        `short supporting quote. Do not list capabilities from memory/training knowledge alone.`,
        ``,
      ];
  return [
    `${vendor.vendor} (${vendor.category}).`,
    ``,
    ...groundingBlock,
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
    `- title: short human title`,
    `- description: 1-2 sentences, what it actually does`,
    `- resource_kind: the primary resource type touched (table, row, collection, role, function, snapshot, etc.)`,
    `- operation_kind: the primary operation type (create, read, update, search, migrate, restore, stream, etc.)`,
    `- surfaces_documented: subset of ["api","sdk","cli"] ONLY — never invent values like "sql", "http",`,
    `  "wire", or "console". SQL/wire access evidenced via an official SDK or CLI counts as "sdk"/"cli";`,
    `  a documented REST/HTTP API counts as "api". Omit the surface if none of those three apply.`,
    `- support_type: native | idiomatic-pattern | managed-surface | unknown`,
    `- evidence: one or more objects with {doc_url, quote, note?, strength?}; doc_url must be a specific page, not only the docs root`,
    `  strength is "direct" when the quote directly documents the capability,`,
    `  "derived_from_connection_surface" when a control-plane endpoint only exposes a SQL/wire/data-plane connection,`,
    `  "summary_index" for llms.txt or other summary indexes, "marketing_claim" for product/marketing pages,`,
    `  and "inferred" when the quote only indirectly supports the capability.`,
    `- extraction_provenance: {"source":"official-docs","extracted_at":"<current ISO timestamp>","extractor":"llm-capability-inventory-v1"}`,
    ``,
    `Return ONLY this JSON object, no commentary:`,
    `{"capabilities": [`,
    `  {"capability_name": "...", "title": "...", "description": "...", "resource_kind": "...",`,
    `   "operation_kind": "...", "surfaces_documented": ["api","cli"], "support_type": "native", "evidence": [{"doc_url": "...", "quote": "...", "strength": "direct"}],`,
    `   "extraction_provenance": {"source":"official-docs","extracted_at":"<current ISO timestamp>","extractor":"llm-capability-inventory-v1"}}`,
    `]}`,
  ].filter((line): line is string => typeof line === "string").join("\n");
}

export interface ExtractCapabilitiesOptions {
  harness?: HarnessId;
  model?: string;
  effort?: Effort;
  /** Compact OpenAPI operation inventory (see ingest/spec-summary.ts). When set,
   *  it seeds the candidate surface so the model does not blind-crawl from
   *  scratch; WebFetch is still required to gap-fill docs-only / data-plane
   *  capabilities the seed misses. */
  specSummary?: string;
  specUrl?: string;
}

/** Seed+grounded inventories (large OpenAPI + docs gap-fill) routinely need
 *  more than a blind 12m crawl; keep headroom without unbounded hangs. */
const TIMEOUT_MS = 18 * 60 * 1000;

/** Extract raw, cited capabilities for a single vendor. */
export async function extractCapabilities(
  vendor: ResolveResult,
  opts: ExtractCapabilitiesOptions = {},
): Promise<CapabilityExtractResult> {
  const label = `${vendor.vendor}/capabilities`;
  // Always require WebFetch: OpenAPI seed narrows the search space, it does not
  // replace grounded docs review (Management APIs routinely omit data-plane).
  const raw = await invokeGenerator(buildCapabilityPrompt(vendor, opts.specSummary), {
    requireWebFetch: true,
    fallbackHarness: opts.harness ?? "claude-code",
    model: opts.model,
    effort: opts.effort,
    heartbeat: { everyMs: 30_000, label },
    timeoutMs: TIMEOUT_MS,
  });
  const json = await extractJsonObjectWithRepair(raw, {
    fallbackHarness: opts.harness ?? "claude-code",
    model: opts.model,
    effort: opts.effort,
    label,
  });
  // Some models return a bare `[...]` of capabilities instead of the requested
  // `{"capabilities": [...]}` envelope — accept both.
  const rawJson = JSON.parse(json) as unknown;
  const enveloped = Array.isArray(rawJson) ? { capabilities: rawJson } : rawJson;
  const parsed = z.object({ capabilities: z.array(CapabilitySchema) }).safeParse(enveloped);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
    throw new Error(`capability-extract for "${label}" returned non-conforming JSON: ${issues}\nRaw: ${json.slice(0, 2000)}`);
  }
  return CapabilityExtractResultSchema.parse({
    vendor: vendor.vendor,
    slug: vendor.slug,
    category: vendor.category,
    extracted_at: new Date().toISOString(),
    extraction_context: {
      mode: opts.specSummary ? "openapi-seeded-grounded" : "grounded-doc-crawl",
      harness: opts.harness,
      model: opts.model,
      spec_url: opts.specUrl,
      notes: opts.specSummary
        ? "OpenAPI/registry seed used as candidate surface; WebFetch gap-filled against live docs."
        : "Grounded doc-crawl with no OpenAPI seed.",
    },
    audit_status: "candidate",
    audit_notes: opts.specSummary
      ? ["OpenAPI-seeded + grounded candidate inventory; citations require human review before publication."]
      : ["Grounded doc-crawl candidate inventory; citations require human review before publication."],
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
  return capabilityInventoryPath(root, slug);
}

export function writeCapabilityExtract(root: string, result: CapabilityExtractResult): string {
  const newPath = writeCapabilityInventory(root, result);
  return newPath;
}

export function loadCapabilityExtract(root: string, slug: string): CapabilityExtractResult | null {
  const inventoryPath = resolve(root, "targets", "extracts", slug, "capability-inventory.yaml");
  const legacyPath = legacyCapabilityExtractPath(root, slug);

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
