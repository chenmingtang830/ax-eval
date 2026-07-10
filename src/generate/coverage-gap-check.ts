/**
 * Coverage gap check: closes the "candidate list is manually authored and
 * therefore incomplete" gap in cross-vendor capability coverage.
 *
 * The original synthesize-suite flow cross-checked a hand-picked list of 10
 * candidate capabilities — which is exactly why it missed universally-
 * supported basics like database triggers and bulk import/export (nobody
 * happened to think to ask about them). This module derives the candidate
 * universe directly from the DATA instead: cluster every capability every
 * vendor's bottom-up extraction actually cited (not a human's guess), then
 * for any concept cited by 2+ but not all vendors, explicitly cross-check it
 * against every vendor that didn't surface it — closing the "sampling gap
 * vs. true absence" ambiguity mechanically, for any category, every time.
 */
import { z } from "zod";
import type { Effort, HarnessId } from "./harness.js";
import { invokeGenerator, extractJsonObjectWithRepair } from "./harness.js";
import type { CapabilityExtractResult } from "./capability-extract.js";
import { mapSettledLimit } from "./concurrency.js";

const ConceptClusterSchema = z.object({
  concept_name: z.string(),
  title: z.string(),
  vendors_citing: z.array(z.object({ vendor: z.string(), capability_name: z.string() })).min(1),
});
export type ConceptCluster = z.infer<typeof ConceptClusterSchema>;

function buildUniverseClusterPrompt(extracts: CapabilityExtractResult[]): string {
  const corpus = extracts
    .map((e) => `${e.vendor}:\n${e.capabilities.map((c) => `  - ${c.capability_name}: ${c.title}`).join("\n")}`)
    .join("\n\n");
  return [
    `Cluster ALL of the capabilities below (from ${extracts.length} vendors, every capability from every`,
    `vendor's own bottom-up docs research) into concept groups. Every capability must land in exactly one`,
    `cluster, including singleton (cited by only 1 vendor) clusters — do not drop or skip any.`,
    `Group by underlying concept an agent would need to discover/use, not by exact name — e.g. Postgres`,
    `"row-level-security" and generic "database-rbac" are DIFFERENT concepts (different agent task), don't`,
    `force-merge things that aren't really the same task just because they're both "access control".`,
    ``,
    corpus,
    ``,
    `Return ONLY this JSON, no commentary:`,
    `{"clusters": [{"concept_name": "kebab-slug", "title": "...", "vendors_citing": [{"vendor": "...", "capability_name": "..."}]}]}`,
  ].join("\n");
}

const UniverseResultSchema = z.object({ clusters: z.array(ConceptClusterSchema) });

type CapabilityRecord = CapabilityExtractResult["capabilities"][number];

interface DeterministicConceptRule {
  concept_name: string;
  title: string;
  patterns: RegExp[];
  excludePatterns?: RegExp[];
}

const DATABASE_DETERMINISTIC_RULES: DeterministicConceptRule[] = [
  {
    concept_name: "define-data-container",
    title: "Define Data Container",
    patterns: [
      /\bcreate-table\b/,
      /\bcreate-collection\b/,
      /\bdocument-data-model\b/,
      /\btable-and-schema-definition\b/,
      /\btable-schema-definition\b/,
      /\bschema-definition\b/,
      /\bcreate-schema\b/,
      /\bcreate-logical-database\b/,
    ],
  },
  {
    concept_name: "write-records",
    title: "Write Records",
    patterns: [
      /\brow-insert\b/,
      /\bdocument-insert\b/,
      /\brow-update\b/,
      /\bdocument-update\b/,
      /\bdocument-patch-update\b/,
      /\bdocument-replace\b/,
      /\brow-delete\b/,
      /\bdocument-delete\b/,
      /\brow-upsert\b/,
      /\bupsert\b/,
      /\bbulk-import\b/,
      /\bbulk-copy\b/,
      /\bpgloader-import\b/,
      // Vendor-idiomatic CRUD / SQL row ops that seed previously left as singletons.
      /\brest-data-api-crud\b/,
      /\bbaseline-sql-table-and-row-operations\b/,
      /\bsql-table-and-row-operations\b/,
      /\binsert-update-delete\b/,
      /\bcrud\b/,
    ],
  },
  {
    concept_name: "query-records",
    title: "Query Records",
    patterns: [
      /\bfiltered-query\b/,
      /\bfiltered-read-query\b/,
      /\bfiltered-reads\b/,
      /\bfiltered-reads-and-counts\b/,
      /\bfiltered-reads-and-aggregates\b/,
      /\bfiltered-document-queries\b/,
      /\bsingle-document-read\b/,
      /\baggregation-pipeline\b/,
      /\bcount-query\b/,
      /\bcount-documents\b/,
      /\bjavascript-aggregation-and-count\b/,
      /\bjoin-query\b/,
      /\bjsonb-path-query\b/,
      /\brpc-function-call\b/,
      /\bgraphql-query\b/,
      /\brest-api-crud\b/,
      /\bstandard-postgres-tool-connectivity\b/,
      /\bsorted-query\b/,
      /\bquery-sorting-pagination\b/,
      /\btime-travel-historical-query\b/,
    ],
  },
  {
    concept_name: "inspect-schema",
    title: "Inspect Schema",
    patterns: [
      /\bschema-introspection\b/,
      /\bcollection-introspection\b/,
      /\bget-table-schema\b/,
      /\bdatabase-object-introspection\b/,
      /\bsystem-table-introspection\b/,
      /\blist-tables\b/,
    ],
  },
  {
    concept_name: "evolve-schema",
    title: "Evolve Schema",
    patterns: [
      /\bschema-evolution\b/,
      /\balter-table-schema-evolution\b/,
      /\bonline-schema-evolution\b/,
      /\bonline-data-migrations\b/,
      /\btracked-migration-files\b/,
      /\bschema-diff\b/,
      /\bschema-diff-migration-review\b/,
      /\bfile-based-migrations\b/,
      /\bad-hoc-migration-execution\b/,
      /\bschema-migration\b/,
      /\bschema-alteration\b/,
      /\brelational-schema-migration\b/,
      /\bschema-migration-orm-tooling\b/,
      /\bschema-migration-tracked\b/,
      /\bmigration-execution-api\b/,
    ],
  },
  {
    concept_name: "data-integrity-and-transactions",
    title: "Data Integrity And Transactions",
    patterns: [
      /\bconstraint\b/,
      /\bschema-validation\b/,
      /\btyped-schema-definition\b/,
      /\btransactions?\b/,
      /\bacid\b/,
      /\bintegrity-controls\b/,
      /\bsnapshot-consistent-query-reads\b/,
      /\btransactional-writes\b/,
      /\btransactional-bulk-writes\b/,
      /\bdatabase-trigger\b/,
      /\bconcurrent-write-transactions\b/,
    ],
  },
  {
    concept_name: "access-control",
    title: "Access Control",
    patterns: [
      /\brow-level-security\b/,
      /\brow-level-access-control\b/,
      /\brole-based-access-control\b/,
      /\bcolumn-level-security\b/,
      /\boidc-jwt-authentication\b/,
      /\bfunction-level-auth-checks\b/,
      /\bmultiple-authentication-methods\b/,
      /\bfine-grained-access-control\b/,
      /\bfine-grained-permissions\b/,
      /\bscoped-auth-tokens\b/,
      /\bcustom-roles\b/,
      /\bnetwork-access-allow-rules\b/,
      /\bnetwork-access-restriction\b/,
      /\bip-allowlisting-and-private-networking\b/,
      /\bip-access-list\b/,
      /\bjwt-auth-integration\b/,
    ],
  },
  {
    concept_name: "backup-and-restore",
    title: "Backup And Restore",
    patterns: [
      /\bbackup\b/,
      /\brestore\b/,
      /\bpoint-in-time\b/,
      /\bsnapshot\b/,
      /\bbulk-export\b/,
      /\bdatabase-export\b/,
      /\bdata-export\b/,
    ],
    // Scheduling a period where backups are suppressed is not itself a
    // backup/export artifact that can satisfy the canonical task.
    excludePatterns: [/\bblackout\b/],
  },
  {
    concept_name: "server-side-execution",
    title: "Server-Side Execution",
    patterns: [
      /\bstored-function\b/,
      /\bstored-procedure\b/,
      /\bstored-procedures-and-udfs\b/,
      /\bstored-procedure-execution\b/,
      /\bserver-side-javascript-function\b/,
      /\bserver-side-triggers\b/,
      /\bserver-side-actions\b/,
      /\bserver-side-mutation-functions\b/,
      /\bserver-side-function\b/,
      /\bserver-side-functions-triggers\b/,
      /\bscheduled-functions\b/,
      /\bscheduled-sql-jobs\b/,
      /\bscheduled-job\b/,
      /\bedge-function\b/,
      /\bedge-functions\b/,
      /\bdatabase-webhook\b/,
      /\bdatabase-rpc\b/,
      /\badmin-raw-sql\b/,
      /\braw-sql-execution\b/,
      /\bsql-over-http\b/,
      /\bsql-query-execution\b/,
      /\bhttp-api-query-execution\b/,
      /\bmanagement-api-and-sdk\b/,
    ],
  },
  {
    concept_name: "vector-search",
    title: "Vector Search",
    patterns: [/\bvector\b/],
  },
  {
    concept_name: "full-text-search",
    title: "Full-Text Search",
    patterns: [
      /\bfull-text-search\b/,
      /\bfull-text\b/,
      /\btsvector\b/,
      /\bbm25\b/,
      /\btext-search\b/,
    ],
  },
  {
    concept_name: "change-data-capture",
    title: "Change Data Capture",
    patterns: [
      /\blogical-replication\b/,
      /\bchange-streams\b/,
      /\bchange-data-capture\b/,
      /\breactive-query-subscriptions\b/,
      /\brealtime-postgres-changes\b/,
      /\brealtime-change-feeds\b/,
      /\brealtime-change-feed\b/,
      /\brealtime-subscriptions\b/,
      /\brealtime-broadcast\b/,
      /\brealtime-presence\b/,
      /\bmanaged-cdc-pipeline\b/,
      /\bchange-listen-endpoint\b/,
    ],
  },
];

function fallbackConceptTitle(capability: CapabilityRecord): string {
  return capability.title
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeFallbackConceptName(capabilityName: string): string {
  return capabilityName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Exported for suite-audit mapping-miss detection / tests. */
export const DATABASE_DETERMINISTIC_RULES_FOR_AUDIT = DATABASE_DETERMINISTIC_RULES;

/** Return why a nominal rule match cannot perform the canonical concept.
 * Keep this narrow and evidence-shaped: unmatched capabilities remain
 * singleton concepts rather than being silently dropped. */
export function databaseConceptCompatibilityIssue(
  capability: CapabilityRecord,
  conceptName: string,
): string | null {
  const name = normalizeFallbackConceptName(capability.capability_name);
  if (conceptName === "write-records" && (name.includes("blackout") || name.includes("disruption"))) {
    return `${capability.capability_name} manages operations/control-plane scheduling, not row/document writes`;
  }
  if (conceptName === "backup-and-restore" && name.includes("blackout")) {
    return `${capability.capability_name} suppresses scheduled backups and does not produce a backup/export artifact`;
  }
  if (conceptName === "change-data-capture" && /\bread-replicas?\b/.test(name)) {
    return `${capability.capability_name} exposes a read topology, not a change-event stream`;
  }
  return null;
}

/** Match a capability to a canonical concept via deterministic rules, or null. */
export function matchDeterministicDatabaseConcept(
  capability: CapabilityRecord,
): { concept_name: string; title: string } | null {
  // Inventory capability names/titles are curated identifiers. Descriptions
  // frequently mention unrelated transport verbs ("CRUD API resource") and
  // caused false positives such as backup-blackout-windows → write-records.
  const identity = `${capability.capability_name} ${capability.title}`.toLowerCase();
  for (const rule of DATABASE_DETERMINISTIC_RULES) {
    if (rule.excludePatterns?.some((pattern) => pattern.test(identity))) continue;
    if (
      rule.patterns.some((pattern) => pattern.test(identity))
      && !databaseConceptCompatibilityIssue(capability, rule.concept_name)
    ) {
      return { concept_name: rule.concept_name, title: rule.title };
    }
  }
  return null;
}

function deterministicDatabaseConcept(capability: CapabilityRecord): { concept_name: string; title: string } {
  return matchDeterministicDatabaseConcept(capability) ?? {
    concept_name: normalizeFallbackConceptName(capability.capability_name),
    title: fallbackConceptTitle(capability),
  };
}

export function deriveCandidateUniverseDeterministic(extracts: CapabilityExtractResult[]): ConceptCluster[] {
  const category = extracts[0]?.category;
  if (category !== "database") {
    throw new Error(`deterministic candidate-universe is currently only implemented for database, got "${category ?? "unknown"}"`);
  }

  const clusters = new Map<string, ConceptCluster>();
  for (const extract of extracts) {
    for (const capability of extract.capabilities) {
      const concept = deterministicDatabaseConcept(capability);
      const existing = clusters.get(concept.concept_name);
      if (existing) {
        existing.vendors_citing.push({ vendor: extract.vendor, capability_name: capability.capability_name });
        continue;
      }
      clusters.set(concept.concept_name, {
        concept_name: concept.concept_name,
        title: concept.title,
        vendors_citing: [{ vendor: extract.vendor, capability_name: capability.capability_name }],
      });
    }
  }

  return [...clusters.values()].sort((a, b) => {
    const aCoverage = new Set(a.vendors_citing.map((entry) => entry.vendor)).size;
    const bCoverage = new Set(b.vendors_citing.map((entry) => entry.vendor)).size;
    return bCoverage - aCoverage || a.concept_name.localeCompare(b.concept_name);
  });
}

export interface GapCheckGeneratorOptions {
  harness?: HarnessId;
  model?: string;
  effort?: Effort;
  /** When true, seed-only: skip LLM concept-refine and gap-check assist. */
  deterministic?: boolean;
  /** Opt-in grounded LLM gap adjudication (expensive: one WebFetch call per
   *  partial-coverage cell). Default off — inventory evidence alone closes the
   *  coverage matrix; enable for a deeper assist pass after human review. */
  gapCheckAssist?: boolean;
}

const GAP_CHECK_CONCURRENCY = 6;

function buildConceptRefinePrompt(seedClusters: ConceptCluster[], extracts: CapabilityExtractResult[]): string {
  const seedSummary = seedClusters
    .map(
      (c) =>
        `- ${c.concept_name} (${c.title})\n  vendors: ${c.vendors_citing.map((v) => `${v.vendor}=${v.capability_name}`).join(", ")}`,
    )
    .join("\n");
  const capabilityCorpus = extracts
    .map((e) => `${e.vendor}:\n${e.capabilities.map((c) => `  - ${c.capability_name}: ${c.title}`).join("\n")}`)
    .join("\n\n");
  return [
    `Refine a candidate concept universe for a benchmark. The SEED clusters below were produced by a`,
    `deterministic rule pass over the vendor capability inventories. Your job is to clean them up:`,
    `  1. Merge clusters that are really the same underlying agent task but were split because vendors used`,
    `     different capability names (e.g. "query-pagination", "cursor-based-pagination", "paginated-query"`,
    `     should all merge into a single "pagination" concept).`,
    `  2. Keep clusters that represent genuinely distinct agent tasks separate — do NOT over-merge.`,
    `  3. Use canonical, cross-vendor, kebab-case concept names that reflect the underlying task, not vendor jargon.`,
    `  4. Preserve all vendor citations from the merged clusters in the final cluster's vendors_citing list.`,
    `  5. You MAY drop singleton clusters (cited by only 1 vendor) if they are clearly vendor-specific noise,`,
    `     but keep any singleton that represents a real, distinct benchmark-worthy task.`,
    ``,
    `SEED CLUSTERS:`,
    seedSummary,
    ``,
    `RAW CAPABILITY INVENTORIES (for reference):`,
    capabilityCorpus,
    ``,
    `Return ONLY this JSON, no commentary:`,
    `{"clusters": [{"concept_name": "kebab-slug", "title": "...", "vendors_citing": [{"vendor": "...", "capability_name": "..."}]}]}`,
  ].join("\n");
}

export async function refineConceptUniverse(
  seedClusters: ConceptCluster[],
  extracts: CapabilityExtractResult[],
  opts: GapCheckGeneratorOptions = {},
): Promise<ConceptCluster[]> {
  // Assist step only — keep wall-clock short so a hung harness falls back to seed.
  const timeoutMs = 4 * 60 * 1000;
  const raw = await invokeGenerator(buildConceptRefinePrompt(seedClusters, extracts), {
    fallbackHarness: opts.harness ?? "claude-code",
    model: opts.model,
    effort: opts.effort,
    heartbeat: { everyMs: 30_000, label: "refine-concept-universe" },
    timeoutMs,
  });
  const json = await extractJsonObjectWithRepair(raw, {
    fallbackHarness: opts.harness ?? "claude-code",
    model: opts.model,
    effort: opts.effort,
    label: "refine-concept-universe",
  });
  const parsed = UniverseResultSchema.safeParse(JSON.parse(json));
  if (!parsed.success) {
    throw new Error(`refine-concept-universe returned non-conforming JSON: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  return parsed.data.clusters;
}

/** Cluster the full union of every vendor's cited capabilities — no selection,
 *  no coverage filtering, just an exhaustive concept map to cross-check against.
 *
 * Default (database): deterministic seed + optional LLM refine assist, with
 * seed fallback on timeout/parse failure — same pattern as registry-seeded
 * surface extract. Pass `deterministic: true` for seed-only (CI / offline). */
export async function deriveCandidateUniverse(
  extracts: CapabilityExtractResult[],
  opts: GapCheckGeneratorOptions = {},
): Promise<ConceptCluster[]> {
  if (extracts[0]?.category === "database") {
    const seed = deriveCandidateUniverseDeterministic(extracts);
    if (opts.deterministic) {
      process.stderr.write(`  [concept-universe] seed-only (${seed.length} concepts)\n`);
      return seed;
    }
    try {
      process.stderr.write(`  [concept-universe] refining ${seed.length} seed concepts with LLM assist…\n`);
      const refined = await refineConceptUniverse(seed, extracts, {
        ...opts,
        // Keep assist bounded; hung refine previously blocked the whole pipeline.
        // Caller can still pass a lower/higher timeout via future opts if needed.
      });
      if (!refined.length) {
        process.stderr.write(`  [concept-universe] refine returned empty — keeping seed\n`);
        return seed;
      }
      process.stderr.write(`  [concept-universe] refine ok (${refined.length} concepts)\n`);
      return refined;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`  [concept-universe] refine failed (${msg}); keeping deterministic seed\n`);
      return seed;
    }
  }
  const raw = await invokeGenerator(buildUniverseClusterPrompt(extracts), {
    fallbackHarness: opts.harness ?? "claude-code",
    model: opts.model,
    effort: opts.effort,
    heartbeat: { everyMs: 30_000, label: "derive-candidate-universe" },
    timeoutMs: 8 * 60 * 1000,
  });
  const json = await extractJsonObjectWithRepair(raw, {
    fallbackHarness: opts.harness ?? "claude-code",
    model: opts.model,
    effort: opts.effort,
    label: "derive-candidate-universe",
  });
  const parsed = UniverseResultSchema.safeParse(JSON.parse(json));
  if (!parsed.success) {
    throw new Error(`derive-candidate-universe returned non-conforming JSON: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  return parsed.data.clusters;
}

const GapCheckResultSchema = z.object({
  vendor: z.string(),
  concept: z.string(),
  supported: z.boolean(),
  doc_url: z.string().optional(),
  quote: z.string().optional(),
});
export type GapCheckResult = z.infer<typeof GapCheckResultSchema>;

function buildGapCheckPrompt(vendor: string, concept: ConceptCluster): string {
  const others = concept.vendors_citing.map((v) => `${v.vendor} calls it "${v.capability_name}"`).join("; ");
  return [
    `Quick fact-check against ${vendor}'s official docs using web search.`,
    ``,
    `Does ${vendor} support "${concept.title}" (concept: ${concept.concept_name})? Other vendors document`,
    `this same underlying concept: ${others}. ${vendor} was NOT already listed for it in an earlier bottom-up`,
    `pass — that could mean it genuinely lacks the capability, OR it could mean the earlier pass simply`,
    `missed it. Check ${vendor}'s docs directly and give a definitive, cited answer either way.`,
    ``,
    `Return ONLY this JSON, no commentary:`,
    `{"vendor": "${vendor}", "concept": "${concept.concept_name}", "supported": true|false, "doc_url": "...", "quote": "..."}`,
  ].join("\n");
}

/** For every concept cited by 2+ vendors but not yet universal, cross-check it
 *  against each vendor that didn't already cite it in their own bottom-up pass. */
export async function crossCheckGaps(
  extracts: CapabilityExtractResult[],
  clusters: ConceptCluster[],
  opts: GapCheckGeneratorOptions = {},
): Promise<GapCheckResult[]> {
  // Default: inventory-only coverage. Grounded per-cell gap LLM is opt-in
  // (--gap-check-assist) because 50–100 WebFetch calls routinely stall the
  // authoring pipeline. Seed-only (--deterministic) also skips.
  if (opts.deterministic || !opts.gapCheckAssist) {
    process.stderr.write(
      opts.deterministic
        ? `  [gap-check] seed-only — skipping LLM gap adjudication\n`
        : `  [gap-check] inventory-only (pass --gap-check-assist for grounded LLM adjudication)\n`,
    );
    return [];
  }
  const allVendors = extracts.map((e) => e.vendor);
  const gapChecks: Array<{ vendor: string; concept: ConceptCluster }> = [];
  for (const cluster of clusters) {
    const citingVendors = new Set(cluster.vendors_citing.map((v) => v.vendor));
    if (citingVendors.size < 2 || citingVendors.size === allVendors.length) continue; // skip singletons and already-universal
    for (const vendor of allVendors) {
      if (!citingVendors.has(vendor)) gapChecks.push({ vendor, concept: cluster });
    }
  }
  if (!gapChecks.length) {
    process.stderr.write(`  [gap-check] no partial-coverage concepts to adjudicate\n`);
    return [];
  }
  process.stderr.write(`  [gap-check] LLM-assist adjudicating ${gapChecks.length} gap cell(s)…\n`);
  const settled = await mapSettledLimit(
    gapChecks,
    GAP_CHECK_CONCURRENCY,
    async ({ vendor, concept }) => {
      const raw = await invokeGenerator(buildGapCheckPrompt(vendor, concept), {
        requireWebFetch: true,
        fallbackHarness: (opts.harness === "codex" ? "claude-code" : opts.harness) ?? "claude-code",
        model: opts.model,
        effort: opts.effort,
        timeoutMs: 3 * 60 * 1000,
        heartbeat: { everyMs: 30_000, label: `gap-check/${vendor}/${concept.concept_name}` },
      });
      const json = await extractJsonObjectWithRepair(raw, {
        fallbackHarness: (opts.harness === "codex" ? "claude-code" : opts.harness) ?? "claude-code",
        model: opts.model,
        effort: opts.effort,
        label: `gap-check/${vendor}/${concept.concept_name}`,
      });
      return GapCheckResultSchema.parse(JSON.parse(json));
    },
  );
  for (const [i, s] of settled.entries()) {
    if (s.status === "rejected") {
      const check = gapChecks[i];
      const label = check ? `${check.vendor}/${check.concept.concept_name}` : `#${i}`;
      process.stderr.write(`  [gap-check] ${label} failed: ${s.reason instanceof Error ? s.reason.message : s.reason}\n`);
    }
  }
  const ok = settled.filter((s): s is PromiseFulfilledResult<GapCheckResult> => s.status === "fulfilled").map((s) => s.value);
  process.stderr.write(`  [gap-check] ${ok.length}/${gapChecks.length} cell(s) adjudicated (failures keep inventory-only coverage)\n`);
  return ok;
}
