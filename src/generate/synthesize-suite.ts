/**
 * Synthesize-suite: Layer 0b of suite authoring. Reads ALL vendors'
 * capability-extract files (already grounded + cited — see
 * capability-extract.ts) and derives the canonical task suite bottom-up.
 *
 * The concept universe is the single canonical clustering source: derive it
 * once across the full vendor corpus, close support gaps, then deterministically
 * reduce that universe into selection + support artifacts. Only the final task
 * wording remains generator-assisted, one selected concept at a time.
 *
 * Deliberately NOT grounded (no WebFetch) for concept derivation / task drafting
 * — they reason over already-extracted, cited text rather than researching new
 * facts. Every claim still traces back to specific capability inventory entries.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { z } from "zod";
import { invokeGenerator, extractJsonObjectWithRepair } from "./harness.js";
import type { CapabilityExtractResult } from "./capability-extract.js";
import { deriveCandidateUniverse, crossCheckGaps } from "./coverage-gap-check.js";
import { mapSettledLimit } from "./concurrency.js";
import { evaluateDatabaseTaskFit } from "./database-task-fit.js";
import {
  CANONICAL_SURFACE_SCOPE,
  type ConceptUniverse,
  type CoverageMatrix,
  type CoverageDecision,
  type SelectionLedger,
  type SupportMatrix,
  type SuiteMethodology,
  type GraderLedger,
  type FailureTaxonomy,
  type TraceReviewMemo,
  defaultSuiteMethodology,
  writeConceptUniverse,
  writeCoverageMatrix,
  writeFailureTaxonomy,
  writeGraderLedger,
  writeMethodology,
  writeSelectionLedger,
  writeSupportMatrix,
  writeTraceReview,
} from "./methodology.js";

const CoverageSchema = z.object({ vendor: z.string(), capability_name: z.string() });

const ClusterSchema = z.object({
  cluster_name: z.string().min(1), // kebab slug, e.g. "row-level-security"
  title: z.string().min(1),
  difficulty: z.enum(["L1", "L2", "L3", "L4"]),
  rationale: z.string().min(1), // one sentence: why this made the cut
  coverage: z.array(CoverageSchema).min(1),
});
export type Cluster = z.infer<typeof ClusterSchema>;

const SynthesizedTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  difficulty: z.enum(["L1", "L2", "L3", "L4"]),
  skill: z.string().min(1),
  intent: z.string().min(1),
  oracle_hint: z.string().min(1),
  allowed_surfaces: z.array(z.enum(["api", "sdk", "cli"])).default(["api", "cli"]),
  na_examples: z.array(z.string()).default([]),
  rationale: z.string(),
  coverage: z.array(CoverageSchema),
});
export type SynthesizedTask = z.infer<typeof SynthesizedTaskSchema>;

export interface SynthesizeResult {
  tasks: SynthesizedTask[];
  methodology: SuiteMethodology;
  conceptUniverse: ConceptUniverse;
  coverageMatrix: CoverageMatrix;
  selectionLedger: SelectionLedger;
  supportMatrix: SupportMatrix;
  graderLedger: GraderLedger;
  failureTaxonomy: FailureTaxonomy;
  traceReview: TraceReviewMemo;
}

export function inferSuiteVersionFromStem(stem: string): number {
  const match = stem.match(/-v(\d+)$/i);
  return match ? Number(match[1]) : 1;
}

const CATEGORY_PREFIXES: Record<string, string> = { database: "db" };

function categoryPrefix(category: string): string {
  return CATEGORY_PREFIXES[category] ?? category.replace(/[^a-z]/gi, "").slice(0, 2).toLowerCase();
}

function buildTaskDraftPrompt(category: string, cluster: Cluster, matched: Array<{ vendor: string; title: string; description: string; doc_url: string }>, index: number): string {
  const evidence = matched.map((m) => `  - [${m.vendor}] ${m.title}: ${m.description} [${m.doc_url}]`).join("\n");
  const prefix = categoryPrefix(category);
  return [
    `Canonical task suite authoring for the "${category}" category. This cluster was already selected`,
    `(coverage: ${cluster.coverage.length} vendors) — your job is ONLY to draft its task definition.`,
    ``,
    `Cluster: ${cluster.cluster_name} — ${cluster.title}`,
    `Why selected: ${cluster.rationale}`,
    `Evidence (what vendors actually documented for this capability):`,
    evidence,
    ``,
    `Draft ONE canonical task:`,
    `- id: "${prefix}-T${String(index + 1).padStart(2, "0")}-<kebab-slug>" (e.g. "${prefix}-T01-create-table") — use`,
    `  the literal prefix "${prefix}" exactly, do not invent a different one`,
    `- title: "T${String(index + 1).padStart(2, "0")}: <short description>"`,
    `- difficulty: "${cluster.difficulty}" (already decided, keep it)`,
    `- skill: a short kebab-case skill tag`,
    `- intent: GOAL-LEVEL, vendor-agnostic prompt text an agent would receive. Include concrete,`,
    `  deterministic resource names/patterns using a literal "{ns}" placeholder for a namespace token (e.g.`,
    `  "a table named \`axarena_customers_{ns}\`"). State the vendor's idiomatic mechanism is acceptable —`,
    `  never name a specific vendor's API/SDK call. Specify exact, checkable outcomes (exact counts, exact`,
    `  patterns) so verification doesn't need guesswork.`,
    `- oracle_hint: what a verifier should read back to confirm success`,
    `- allowed_surfaces: default ["api","cli"] unless the evidence specifically suggests most`,
    `  vendors only expose this via a subset`,
    `- na_examples: example phrasing for when a vendor structurally lacks this`,
    ``,
    `Return ONLY this JSON object, no commentary:`,
    `{"id": "...", "title": "...", "difficulty": "${cluster.difficulty}", "skill": "...", "intent": "...",`,
    ` "oracle_hint": "...", "allowed_surfaces": ["api","cli"], "na_examples": ["..."]}`,
  ].join("\n");
}

interface DeterministicTaskTemplate {
  skill: string;
  title: string;
  intent: string;
  oracle_hint: string;
  allowed_surfaces?: Array<"api" | "sdk" | "cli">;
  na_examples?: string[];
}

const DATABASE_TASK_TEMPLATES: Record<string, DeterministicTaskTemplate> = {
  "define-data-container": {
    skill: "define-data-container",
    title: "Create a logical data container",
    intent:
      "Create a logical data container named `axarena_items_{ns}` using the vendor's idiomatic mechanism (table, collection, or equivalent). The resulting container must support an externally addressable id/key and a text field named `label`.",
    oracle_hint:
      "Read back metadata for `axarena_items_{ns}` and confirm the container exists with an id/key field plus a `label` field.",
    na_examples: ["This vendor cannot create or persist a named data container on api/cli surfaces."],
  },
  "query-records": {
    skill: "query-records",
    title: "Filter and read matching records",
    intent:
      "Using a container named `axarena_query_items_{ns}`, create exactly three records with a text field named `label` and values `alpha_{ns}`, `beta_{ns}`, and `gamma_{ns}` plus a `status` field such that only `alpha_{ns}` and `gamma_{ns}` are `active`. Then execute a filtered read that returns only the active records and report the container name plus the matching count.",
    oracle_hint:
      "Verify the container exists with exactly three records total (labels `alpha_{ns}`, `beta_{ns}`, `gamma_{ns}`). A filtered read for `status=active` must return exactly two records with labels `alpha_{ns}` and `gamma_{ns}` and must not include `beta_{ns}`.",
    na_examples: ["This vendor cannot perform filtered record reads on api/cli surfaces."],
  },
  "write-records": {
    skill: "write-records",
    title: "Create, update, and delete one record lifecycle",
    intent:
      "Using a container named `axarena_write_items_{ns}`, create one record labeled `draft_{ns}`, update that same record so its label becomes `final_{ns}`, then delete one separate throwaway record labeled `delete_me_{ns}`. Report the externally addressable container name and the surviving record identity.",
    oracle_hint:
      "Read back `axarena_write_items_{ns}` and confirm: (1) a surviving record labeled `final_{ns}` exists; (2) no record labeled `draft_{ns}` or `delete_me_{ns}` remains; (3) the surviving `final_{ns}` record is the updated identity of the created draft (same durable id/key reported by the agent, or an equivalent vendor update marker) — creating `final_{ns}` directly without an update does not satisfy the task.",
    na_examples: ["This vendor cannot perform create, update, and delete record operations on api/cli surfaces."],
  },
  "inspect-schema": {
    skill: "inspect-schema",
    title: "Inspect container metadata",
    intent:
      "Create or use a container named `axarena_schema_probe_{ns}` with fields `name` and `status`, then use the vendor's schema or metadata inspection mechanism to confirm both fields are present.",
    oracle_hint:
      "Read back schema or metadata for `axarena_schema_probe_{ns}` and confirm both the `name` and `status` fields are visible through the inspection surface (not only via a successful row insert).",
    na_examples: ["This vendor does not expose schema or metadata inspection on api/cli surfaces."],
  },
  "evolve-schema": {
    skill: "evolve-schema",
    title: "Apply a schema evolution",
    intent:
      "Starting from a container named `axarena_migrate_{ns}` that already contains a `title` field, apply an idiomatic schema change that adds a new `status` field. Confirm the evolved shape is visible through the vendor's schema or metadata surface.",
    oracle_hint:
      "Read back metadata for `axarena_migrate_{ns}` and confirm the added `status` field is now present and the pre-existing `title` field remains visible.",
    na_examples: ["This vendor does not support a documented schema evolution or migration flow on api/cli surfaces."],
  },
  "data-integrity-and-transactions": {
    skill: "data-integrity-and-transactions",
    title: "Enforce one integrity or atomicity rule",
    intent:
      "Create a container named `axarena_integrity_{ns}` with an integrity rule or atomic write guarantee on `external_id`. Commit one valid record using `external_id=primary_{ns}`. Then perform one conflicting or invalid write that should not leave a second committed record with the same logical key.",
    oracle_hint:
      "Read back `axarena_integrity_{ns}` and confirm only the valid `external_id=primary_{ns}` record is durably committed. The verifier must itself issue one conflicting or invalid write against the same logical key and re-read to confirm a second committed row was not created — do not rely solely on the agent reporting that the conflict failed.",
    na_examples: ["This vendor cannot enforce a documented integrity rule or atomic write guarantee on api/cli surfaces."],
  },
  "access-control": {
    skill: "access-control",
    title: "Configure an idiomatic access-control mechanism",
    intent:
      "Configure a documented access-control mechanism for a container named `axarena_acl_{ns}` using the vendor's idiomatic control (row/document ownership or RLS, role/grant RBAC, scoped token, IP allowlist, or equivalent). Create one authorized interaction against that protected container and leave the control configuration discoverable on a documented control surface.",
    oracle_hint:
      "Read back the access-control configuration protecting `axarena_acl_{ns}` and confirm it is active. Confirm one authorized read or write against the protected container succeeds. When the vendor documents a negative path for the same control (unauthorized principal, denied role, or blocked client), the verifier must also perform that deny probe and observe rejection.",
    na_examples: ["This vendor does not expose a configurable access-control mechanism on api/cli surfaces."],
  },
  "backup-and-restore": {
    skill: "backup-and-restore",
    title: "Produce a backup, snapshot, or export artifact",
    intent:
      "Create or use a container named `axarena_backup_{ns}` with one marker record labeled `marker_{ns}`, then produce a backup, snapshot, or export artifact using the vendor's idiomatic recovery or export mechanism.",
    oracle_hint:
      "Read back the backup, snapshot, or export artifact and confirm (1) its metadata references `axarena_backup_{ns}` or the producing job, and (2) the artifact payload, listing, or restore-preview includes the marker record labeled `marker_{ns}` — metadata-only existence is not enough.",
    na_examples: ["This vendor does not expose a backup, snapshot, or export flow on api/cli surfaces."],
  },
  "server-side-execution": {
    skill: "server-side-execution",
    title: "Create and invoke a server-side routine",
    intent:
      "Create a server-side routine named `axarena_echo_{ns}` that returns or writes the literal string `axarena_ok_{ns}` when invoked, then invoke it exactly once using the vendor's idiomatic execution surface.",
    oracle_hint:
      "Read back the routine metadata and the observable output or persisted result showing the literal `axarena_ok_{ns}`.",
    na_examples: ["This vendor does not expose server-side routine execution on api/cli surfaces."],
  },
  "vector-search": {
    skill: "vector-search",
    title: "Create a vector-enabled dataset and query it",
    intent:
      "Create a vector-enabled dataset named `axarena_vectors_{ns}` with a text field named `label` and at least three items labeled `alpha_{ns}`, `beta_{ns}`, and `gamma_{ns}`. Use three-dimensional embeddings where `alpha_{ns}` is closest to the probe vector `[1,0,0]`, then run one similarity query for `[1,0,0]` that ranks `alpha_{ns}` first.",
    oracle_hint:
      "Read back the vector dataset and verify a similarity query for `[1,0,0]` against the stored index returns `alpha_{ns}` as the top result.",
    na_examples: ["This vendor does not expose vector indexing or similarity search on api/cli surfaces."],
  },
  "full-text-search": {
    skill: "full-text-search",
    title: "Create a searchable text dataset and query it",
    intent:
      "Create a text-searchable dataset named `axarena_search_{ns}` with at least three items whose content includes `orchard_{ns}`, `mountain_{ns}`, and `harbor_{ns}`. Run one full-text search query that matches only the `orchard_{ns}` item and report the top matching result.",
    oracle_hint:
      "Read back the searchable dataset and verify a documented full-text search query returns `orchard_{ns}` as the top match and does not return `mountain_{ns}` or `harbor_{ns}` in the result set for that query.",
    na_examples: ["This vendor does not expose full-text search on api/cli surfaces."],
  },
  "query-pagination": {
    skill: "query-pagination",
    title: "Page through a bounded result set",
    intent:
      "Using a container named `axarena_page_items_{ns}`, create at least five records with deterministic labels, then retrieve them through the vendor's documented pagination mechanism in at least two pages without losing or duplicating records.",
    oracle_hint:
      "Read back `axarena_page_items_{ns}` and confirm the paginated traversal yields the full expected set of records across multiple pages.",
    na_examples: ["This vendor does not expose a documented pagination mechanism on api/cli surfaces."],
  },
  "change-data-capture": {
    skill: "change-data-capture",
    title: "Emit one observable change event",
    intent:
      "Enable a change stream, realtime subscription, or CDC feed for a container named `axarena_cdc_{ns}`, then create one record labeled `cdc_probe_{ns}` so the resulting insert becomes observable in the stream or feed. Persist the observed event into a durable capture container that is distinct from `axarena_cdc_{ns}`, with either a `row_label` field equal to `cdc_probe_{ns}` or a `payload` field containing `cdc_probe_{ns}`, and report that capture container name for verification.",
    oracle_hint:
      "Read back the reported capture container (must not be `axarena_cdc_{ns}` itself) and confirm at least one stored event corresponds to `cdc_probe_{ns}` and carries insert/change evidence from the feed (event type, commit watermark, or vendor-equivalent CDC fields). A hand-written row that merely copies the label without feed provenance does not pass.",
    na_examples: ["This vendor does not expose a documented CDC, change stream, or realtime feed on api/cli surfaces."],
  },
};

function deterministicDatabaseTaskDraft(cluster: Cluster, index: number): SynthesizedTask | null {
  const template = DATABASE_TASK_TEMPLATES[cluster.cluster_name];
  if (!template) return null;
  return {
    id: `${categoryPrefix("database")}-T${String(index + 1).padStart(2, "0")}-${cluster.cluster_name}`,
    title: `T${String(index + 1).padStart(2, "0")}: ${template.title}`,
    difficulty: cluster.difficulty,
    skill: template.skill,
    intent: template.intent,
    oracle_hint: template.oracle_hint,
    allowed_surfaces: template.allowed_surfaces ?? ["api", "cli"],
    na_examples: template.na_examples ?? [],
    rationale: cluster.rationale,
    coverage: cluster.coverage,
  };
}

export interface SynthesizeSuiteOptions {
  // kept for CLI backward-compat; ignored now that generation calls the
  // configured provider's API directly instead of a specific harness CLI.
  harness?: string;
  model?: string;
  effort?: string;
  /** When true, seed-only: skip LLM concept-refine and gap-check assist.
   *  Default is deterministic seed + LLM concept-refine assist with seed
   *  fallback (same pattern as registry-seeded surface extract). */
  deterministic?: boolean;
  /** Opt-in grounded LLM gap adjudication (expensive). Default off. */
  gapCheckAssist?: boolean;
  targetTaskCount?: number;
}

const TASK_DRAFT_TIMEOUT_MS = 6 * 60 * 1000;
const TASK_DRAFT_CONCURRENCY = 3;

/** Infer difficulty from the canonical concept name. This is the deterministic
 *  prior used when no empirical trial calibration is available; the final
 *  authority remains the human pipeline-review gate. */
export function inferDifficultyFromConcept(conceptName: string): Cluster["difficulty"] {
  const l4 = new Set(["backup-and-restore", "change-data-capture", "data-integrity-and-transactions"]);
  const l3 = new Set(["server-side-execution", "evolve-schema", "migration"]);
  // query/write are multi-step record workflows (not single-action L1).
  const l2 = new Set([
    "access-control",
    "vector-search",
    "full-text-search",
    "data-integrity",
    "query-records",
    "write-records",
  ]);
  if (l4.has(conceptName)) return "L4";
  if (l3.has(conceptName)) return "L3";
  if (l2.has(conceptName)) return "L2";
  return "L1";
}

/**
 * Map observed trial difficulty signals onto the L1–L4 rubric.
 * Prefer mean pass rate; when rates are mid-band, tool-call volume breaks ties
 * toward harder labels (more orchestration cost).
 */
export function calibrateDifficultyFromTrials(opts: {
  meanPassRate: number;
  meanToolCalls?: number | null;
}): Cluster["difficulty"] {
  const rate = opts.meanPassRate;
  const tools = opts.meanToolCalls ?? null;
  if (rate >= 0.85 && (tools === null || tools <= 8)) return "L1";
  if (rate >= 0.65) return tools !== null && tools >= 20 ? "L3" : "L2";
  if (rate >= 0.35) return tools !== null && tools >= 30 ? "L4" : "L3";
  return "L4";
}

export function resolveConceptDifficulty(
  conceptName: string,
  empirical?: { meanPassRate: number; meanToolCalls?: number | null } | null,
): Cluster["difficulty"] {
  if (empirical && Number.isFinite(empirical.meanPassRate)) {
    return calibrateDifficultyFromTrials(empirical);
  }
  return inferDifficultyFromConcept(conceptName);
}

function inventoryCoverageForConcept(universe: ConceptUniverse, conceptName: string): z.infer<typeof CoverageSchema>[] {
  return universe.clusters.find((cluster) => cluster.concept_name === conceptName)?.coverage ?? [];
}

export function proposeClustersFromUniverse(
  universe: ConceptUniverse,
  coverageMatrix: CoverageMatrix,
  empiricalByConcept: Record<string, { meanPassRate: number; meanToolCalls?: number | null }> = {},
): Cluster[] {
  return coverageMatrix.concepts.map((concept) => {
    const empirical = empiricalByConcept[concept.concept_name];
    const difficulty = resolveConceptDifficulty(concept.concept_name, empirical);
    const rationale = empirical
      ? `Empirical calibration from trials (pass=${empirical.meanPassRate.toFixed(2)}${empirical.meanToolCalls != null ? `, tools=${empirical.meanToolCalls.toFixed(1)}` : ""}); prior was ${inferDifficultyFromConcept(concept.concept_name)}.`
      : "Deterministic proposal from concept universe and coverage closure.";
    return {
      cluster_name: concept.concept_name,
      title: concept.title,
      difficulty,
      rationale,
      coverage: inventoryCoverageForConcept(universe, concept.concept_name),
    };
  });
}

export function buildCoverageMatrixArtifact(
  category: string,
  universe: ConceptUniverse,
  extracts: CapabilityExtractResult[],
  gapChecks: Awaited<ReturnType<typeof crossCheckGaps>>,
): CoverageMatrix {
  const capabilityByVendorName = new Map<string, CapabilityExtractResult["capabilities"][number]>();
  const extractByVendor = new Map(extracts.map((extract) => [extract.vendor, extract]));
  for (const extract of extracts) {
    for (const capability of extract.capabilities) {
      capabilityByVendorName.set(`${extract.vendor}::${capability.capability_name}`, capability);
    }
  }
  const gapByVendorConcept = new Map(gapChecks.map((result) => [`${result.vendor}::${result.concept}`, result] as const));
  const allVendors = extracts.map((extract) => extract.vendor);
  return {
    schema: "ax.coverage-matrix/v1",
    category,
    generated_at: new Date().toISOString(),
    concepts: universe.clusters.map((cluster) => ({
      concept_name: cluster.concept_name,
      title: cluster.title,
      decisions: allVendors.map((vendor) => {
        const vendorCapabilities = extractByVendor.get(vendor)?.capabilities ?? [];
        const coverageCandidates = cluster.coverage.filter((item) => item.vendor === vendor);
        const conceptCapabilities = coverageCandidates
          .map((item) => capabilityByVendorName.get(`${vendor}::${item.capability_name}`))
          .filter((capability): capability is CapabilityExtractResult["capabilities"][number] => capability !== undefined);
        const taskFit = category === "database"
          ? evaluateDatabaseTaskFit(cluster.concept_name, vendorCapabilities)
          : null;
        if (taskFit) {
          const bundleCapabilities = taskFit.capability_bundle
            .map((capabilityName) => capabilityByVendorName.get(`${vendor}::${capabilityName}`))
            .filter((capability): capability is CapabilityExtractResult["capabilities"][number] => capability !== undefined);
          const selectedCapability = bundleCapabilities[0]
            ?? conceptCapabilities[0]
            ?? vendorCapabilities.find((capability) =>
              capability.capability_name === taskFit.candidates[0]?.capability_name
            );
          const conceptSupported = conceptCapabilities.length > 0 || taskFit.candidates.length > 0;
          if (!conceptSupported) {
            return {
              concept_name: cluster.concept_name,
              vendor,
              status: "inconclusive" as const,
              source: "selection-default" as const,
              candidate_capabilities: taskFit.candidates,
              capability_bundle: [],
              task_fit: {
                status: taskFit.status,
                requirement_path: taskFit.requirement_path,
                matched_requirements: taskFit.matched_requirements,
                missing_requirements: taskFit.missing_requirements,
                supported_surfaces: taskFit.supported_surfaces,
                reason: taskFit.reason,
              },
              evidence: [],
              reason: taskFit.reason ?? "No inventory citation or task-fit candidate found.",
            };
          }
          const evidenceCapabilities = bundleCapabilities.length ? bundleCapabilities : conceptCapabilities;
          return {
            concept_name: cluster.concept_name,
            vendor,
            // Concept coverage selects the broad canonical bank. Concrete
            // task/surface applicability is enforced separately below by
            // task_fit when building the support matrix.
            status: "supported" as const,
            source: "inventory" as const,
            capability_name: selectedCapability?.capability_name,
            concept_capability_name: conceptCapabilities[0]?.capability_name,
            candidate_capabilities: taskFit.candidates,
            capability_bundle: taskFit.capability_bundle,
            task_fit: {
              status: taskFit.status,
              requirement_path: taskFit.requirement_path,
              matched_requirements: taskFit.matched_requirements,
              missing_requirements: taskFit.missing_requirements,
              supported_surfaces: taskFit.supported_surfaces,
              reason: taskFit.reason,
            },
            surfaces_documented: taskFit.supported_surfaces,
            evidence: evidenceCapabilities.flatMap((capability) => capability.evidence),
            reason: taskFit.status === "insufficient"
              ? `Concept supported, but concrete task fit is insufficient: ${taskFit.reason}`
              : undefined,
          };
        }
        if (coverageCandidates.length) {
          const selected = conceptCapabilities[0];
          return {
            concept_name: cluster.concept_name,
            vendor,
            status: "supported" as const,
            source: "inventory" as const,
            capability_name: selected?.capability_name ?? coverageCandidates[0]?.capability_name,
            concept_capability_name: selected?.capability_name ?? coverageCandidates[0]?.capability_name,
            candidate_capabilities: conceptCapabilities.map((capability) => ({
              capability_name: capability.capability_name,
              matched_requirements: [],
              fit_score: 0,
              surfaces_documented: capability.surfaces_documented,
              evidence: capability.evidence,
            })),
            capability_bundle: selected ? [selected.capability_name] : [],
            surfaces_documented: [...new Set(conceptCapabilities.flatMap((capability) => capability.surfaces_documented))],
            evidence: conceptCapabilities.flatMap((capability) => capability.evidence),
          };
        }
        const gap = gapByVendorConcept.get(`${vendor}::${cluster.concept_name}`);
        if (gap) {
          return {
            concept_name: cluster.concept_name,
            vendor,
            status: gap.supported ? "supported" as const : "unsupported" as const,
            source: "gap-check" as const,
            evidence: gap.supported && gap.doc_url && gap.quote ? [{ doc_url: gap.doc_url, quote: gap.quote }] : [],
            reason: gap.supported ? "Gap check confirmed support." : "Gap check confirmed lack of support.",
          };
        }
        return {
          concept_name: cluster.concept_name,
          vendor,
          status: "inconclusive" as const,
          source: "selection-default" as const,
          evidence: [],
          reason: "No inventory citation or gap-check confirmation found.",
        };
      }),
    })),
  };
}

export function buildSelectionLedgerArtifact(
  benchmark: string,
  category: string,
  methodology: SuiteMethodology,
  universe: ConceptUniverse,
  coverageMatrix: CoverageMatrix,
  proposed: Cluster[],
): SelectionLedger {
  const proposedByConcept = new Map(proposed.map((cluster) => [cluster.cluster_name, cluster]));
  const entries = coverageMatrix.concepts.map((concept) => {
    const supported = concept.decisions.filter((decision) => decision.status === "supported");
    const coveragePct = concept.decisions.length === 0 ? 0 : supported.length / concept.decisions.length;
    const proposal = proposedByConcept.get(concept.concept_name);
    const proposedDifficulty = proposal?.difficulty ?? resolveConceptDifficulty(concept.concept_name);
    const selectedByModel = Boolean(proposal);
    const coveredVendors = supported.map((decision) => decision.vendor);
    let selected = false;
    let rejectionReason: string | undefined;
    // Integer vendor threshold: for 7 vendors and 75%, require ceil(0.75*7)=6
    // supported vendors. Comparing raw ratios alone rejects 5/7 (≈0.714) even
    // though methodology text is "75% of vendors".
    const minVendors = Math.max(
      1,
      Math.ceil(methodology.min_vendor_coverage_pct * Math.max(concept.decisions.length, 1)),
    );
    const meetsCoverage = supported.length >= minVendors;
    if (!meetsCoverage) {
      rejectionReason = `coverage below ${Math.round(methodology.min_vendor_coverage_pct * 100)}% (${supported.length}/${concept.decisions.length} vendors; need ≥${minVendors})`;
    } else if (!selectedByModel) {
      rejectionReason = "not proposed by clustering stage";
    } else {
      selected = true;
    }
    return {
      concept_name: concept.concept_name,
      title: concept.title,
      proposed_difficulty: proposedDifficulty,
      coverage_pct: coveragePct,
      covered_vendors: coveredVendors,
      verifiable: true,
      selected_by_model: selectedByModel,
      selected,
      rationale: proposal?.rationale ?? "Deterministic coverage candidate from concept universe.",
      rejection_reason: rejectionReason,
    };
  }).sort((a, b) => Number(b.selected) - Number(a.selected) || b.coverage_pct - a.coverage_pct || a.concept_name.localeCompare(b.concept_name));

  const selectedEntries = entries.filter((entry) => entry.selected);
  if (selectedEntries.length > methodology.target_task_count) {
    for (const entry of selectedEntries.slice(methodology.target_task_count)) {
      entry.selected = false;
      entry.rejection_reason = "trimmed to target task count after deterministic ranking";
    }
  }

  const vendorCount = coverageMatrix.concepts[0]?.decisions.length
    ?? new Set(coverageMatrix.concepts.flatMap((c) => c.decisions.map((d) => d.vendor))).size
    ?? 0;
  const minVendors = Math.max(1, Math.ceil(methodology.min_vendor_coverage_pct * Math.max(vendorCount, 1)));
  const selectedCount = entries.filter((entry) => entry.selected).length;
  if (selectedCount < methodology.target_task_count) {
    for (const entry of entries) {
      if (entry.selected) continue;
      if ((entry.covered_vendors?.length ?? 0) < minVendors) continue;
      entry.selected = true;
      entry.rejection_reason = undefined;
      entry.rationale = `${entry.rationale} Promoted by deterministic coverage fallback to hit target task count.`;
      if (entries.filter((candidate) => candidate.selected).length >= methodology.target_task_count) break;
    }
  }

  if (!entries.some((entry) => entry.selected && entry.proposed_difficulty === "L4")) {
    const l4Candidate = entries.find((entry) =>
      !entry.selected
      && entry.proposed_difficulty === "L4"
      && (entry.covered_vendors?.length ?? 0) >= minVendors,
    );
    if (l4Candidate) {
      const demotionCandidate = [...entries]
        .reverse()
        .find((entry) => entry.selected && entry.proposed_difficulty !== "L4");
      if (demotionCandidate) {
        demotionCandidate.selected = false;
        demotionCandidate.rejection_reason = "replaced to preserve L4 difficulty coverage";
      }
      l4Candidate.selected = true;
      l4Candidate.rejection_reason = undefined;
      l4Candidate.rationale = `${l4Candidate.rationale} Promoted to satisfy minimum L4 coverage.`;
    }
  }

  return {
    schema: "ax.selection-ledger/v1",
    benchmark,
    category,
    generated_at: new Date().toISOString(),
    methodology,
    entries,
  };
}

export function buildSupportMatrixArtifact(
  benchmark: string,
  category: string,
  methodology: SuiteMethodology,
  coverageMatrix: CoverageMatrix,
  tasks: SynthesizedTask[],
  selectedClusters: Cluster[],
): SupportMatrix {
  const allVendors = [...new Set(coverageMatrix.concepts.flatMap((concept) => concept.decisions.map((decision) => decision.vendor)))];
  const coverageByConcept = new Map(coverageMatrix.concepts.map((concept) => [concept.concept_name, concept]));
  const entries = tasks.flatMap((task, index) => {
    const cluster = selectedClusters[index];
    const conceptName = cluster?.cluster_name ?? task.skill;
    const concept = coverageByConcept.get(conceptName);
    const decisionsByVendor = new Map(concept?.decisions.map((decision) => [decision.vendor, decision]) ?? []);
    return allVendors.flatMap((vendor) =>
      methodology.surface_scope.map((surface) => {
        const decision = decisionsByVendor.get(vendor);
        if (!decision || decision.status === "inconclusive") {
          return {
            vendor,
            task_id: task.id,
            surface,
            status: "inconclusive" as const,
            source_concept: conceptName,
            reason: decision?.reason ?? "No conclusive support decision for vendor/concept.",
          };
        }
        if (decision.status === "unsupported") {
          return {
            vendor,
            task_id: task.id,
            surface,
            status: "unsupported" as const,
            source_concept: conceptName,
            reason: decision.reason ?? "Vendor not covered for selected concept in support matrix.",
          };
        }
        if (!task.allowed_surfaces.includes(surface)) {
          return {
            vendor,
            task_id: task.id,
            surface,
            status: "unsupported" as const,
            source_concept: conceptName,
            reason: `${surface} excluded from task allowed_surfaces`,
          };
        }
        if (decision.task_fit?.status === "insufficient") {
          return {
            vendor,
            task_id: task.id,
            surface,
            status: "unsupported" as const,
            source_concept: conceptName,
            reason: decision.task_fit.reason ?? "Concept is documented, but concrete canonical task requirements are not satisfied.",
          };
        }
        if (
          decision.task_fit?.status === "sufficient"
          && !decision.task_fit.supported_surfaces.includes(surface)
        ) {
          return {
            vendor,
            task_id: task.id,
            surface,
            status: "unsupported" as const,
            source_concept: conceptName,
            reason: `${surface} does not satisfy all task-fit requirements on one documented surface`,
          };
        }
        const compatibilityOverride = databaseTaskSupportOverride(category, vendor, task, decision, surface);
        if (compatibilityOverride) {
          return {
            vendor,
            task_id: task.id,
            surface,
            status: compatibilityOverride.status,
            source_concept: conceptName,
            reason: compatibilityOverride.reason,
          };
        }
        const documentedSurfaces = decision.surfaces_documented?.length ? decision.surfaces_documented : task.allowed_surfaces;
        if (!documentedSurfaces.includes(surface)) {
          return {
            vendor,
            task_id: task.id,
            surface,
            status: "unsupported" as const,
            source_concept: conceptName,
            reason: `${surface} not documented for supported concept`,
          };
        }
        return {
          vendor,
          task_id: task.id,
          surface,
          status: "supported" as const,
          source_concept: conceptName,
          reason: undefined,
        };
      }),
    );
  });
  return {
    schema: "ax.support-matrix/v1",
    benchmark,
    category,
    generated_at: new Date().toISOString(),
    entries,
  };
}

function databaseTaskSupportOverride(
  category: string,
  vendor: string,
  task: SynthesizedTask,
  decision: CoverageDecision,
  surface: "api" | "sdk" | "cli",
): { status: "unsupported"; reason: string } | null {
  if (category !== "database") return null;
  if (vendor === "MongoDB Atlas" && task.skill === "server-side-execution" && decision.capability_name === "server-side-javascript-function") {
    return {
      status: "unsupported",
      reason:
        "MongoDB Atlas evidence is inline aggregation `$function`; DAEB T08 requires a named server-side routine with observable invocation output, so this concrete task is unsupported for the current database benchmark template.",
    };
  }
  if (surface !== "sdk") return null;
  const sdkUnsupportedReason =
    databaseSdkUnsupportedReason(vendor, task.skill) ??
    databaseSdkFamilyUnsupportedReason(vendor, task.skill);
  return sdkUnsupportedReason ? { status: "unsupported", reason: sdkUnsupportedReason } : null;
}

const SUPABASE_SDK_UNSUPPORTED = new Set([
  "access-control",
  "backup-and-restore",
  "data-integrity-and-transactions",
  "evolve-schema",
  "query-records",
  "vector-search",
  "write-records",
  "change-data-capture",
  "full-text-search",
  "inspect-schema",
]);

const NEON_SDK_UNSUPPORTED = new Set([
  "backup-and-restore",
  "change-data-capture",
]);

const MONGODB_ATLAS_SDK_UNSUPPORTED = new Set([
  "access-control",
  "backup-and-restore",
]);

const TURSO_SDK_UNSUPPORTED = new Set([
  "access-control",
  "backup-and-restore",
  "change-data-capture",
]);

const CONVEX_SDK_UNSUPPORTED = new Set([
  "access-control",
  "backup-and-restore",
  "data-integrity-and-transactions",
  "evolve-schema",
  "query-records",
  "vector-search",
  "write-records",
  "change-data-capture",
  "full-text-search",
  "inspect-schema",
]);

const INSFORGE_SDK_UNSUPPORTED = new Set([
  "access-control",
  "backup-and-restore",
  "data-integrity-and-transactions",
  "evolve-schema",
  "query-records",
  "vector-search",
  "write-records",
  "change-data-capture",
  "full-text-search",
  "inspect-schema",
]);

function databaseSdkUnsupportedReason(vendor: string, skill: string): string | null {
  if (vendor === "Supabase" && SUPABASE_SDK_UNSUPPORTED.has(skill)) {
    return "Supabase JS is a data-plane client and does not expose the DDL/control-plane path this DAEB task requires from a blank sandbox; unsupported SDK cells are excluded from the denominator.";
  }
  if (vendor === "Neon" && NEON_SDK_UNSUPPORTED.has(skill)) {
    return "Neon's serverless driver is a SQL data-plane driver; this task requires backup/CDC/control-plane behavior not evidenced through that SDK path.";
  }
  if (vendor === "MongoDB Atlas" && MONGODB_ATLAS_SDK_UNSUPPORTED.has(skill)) {
    return "MongoDB's Node driver supports data-plane operations, but this DAEB task requires Atlas Admin/control-plane or named-routine behavior not evidenced through the driver.";
  }
  if (vendor === "Turso" && TURSO_SDK_UNSUPPORTED.has(skill)) {
    return "Turso's libSQL client supports SQL data-plane operations, but this DAEB task requires access-control, backup, CDC, or server-side routine behavior not evidenced through the SDK.";
  }
  if (vendor === "Convex" && CONVEX_SDK_UNSUPPORTED.has(skill)) {
    return "Convex DAEB tasks require project code/schema/function deployment; no standalone official SDK path is evidenced for completing this canonical task from the benchmark runner.";
  }
  if (vendor === "Insforge" && INSFORGE_SDK_UNSUPPORTED.has(skill)) {
    return "Insforge has no benchmark-declared official SDK/client-library path for completing this DAEB task; API support is not inherited by SDK.";
  }
  return null;
}

function databaseSdkFamilyUnsupportedReason(vendor: string, skill: string): string | null {
  if (vendor === "CockroachDB") return null;
  if (["backup-and-restore", "change-data-capture"].includes(skill) && ["Neon", "Turso"].includes(vendor)) {
    return `${vendor}'s SDK path is treated as data-plane only for DAEB; ${skill} requires explicit SDK evidence before it can enter the denominator.`;
  }
  return null;
}

function buildGraderLedgerArtifact(benchmark: string, tasks: SynthesizedTask[]) {
  return {
    schema: "ax.grader-ledger/v1" as const,
    benchmark,
    generated_at: new Date().toISOString(),
    tasks: tasks.map((task) => ({
      task_id: task.id,
      outcome_graders: ["read-back-world-state"],
      trajectory_graders: ["transcript-review", "trace-shape"],
      efficiency_metrics: [
        "latency_ms",
        "tool_call_count",
        "token_input_count",
        "token_output_count",
        "token_cost_usd",
      ],
      human_calibration: task.difficulty === "L4" ? ["manual-spot-check", "grader-fairness-review"] : ["grader-fairness-review"],
    })),
  };
}

function buildFailureTaxonomyArtifact(benchmark: string) {
  return {
    schema: "ax.failure-taxonomy/v1" as const,
    benchmark,
    generated_at: new Date().toISOString(),
    categories: [
      { id: "generic-harness-tooling-bug", label: "Generic harness/tooling bug", description: "A reusable runner, transcript, redaction, invocation, metrics, or execution-control bug independent of the database category." },
      { id: "generic-methodology-artifact-bug", label: "Generic methodology/artifact bug", description: "A reusable suite artifact, schema, selection, support, or reporting contract bug independent of the database category." },
      { id: "database-category-seed-template-verifier-bug", label: "Database-category seed/template/verifier bug", description: "A DAEB database-specific deterministic seed, task template, verifier seed, or category adapter bug that should stay isolated from generic engine logic." },
      { id: "vendor-specific-adapter-bug", label: "Vendor-specific adapter bug", description: "A bug in one vendor's auth, endpoint, verifier, N/A mapping, or surface adapter that should not generalize without cross-vendor evidence." },
      { id: "agent-execution-failure", label: "Agent execution failure", description: "The product and verifier were supportable, but the agent failed to discover, plan, execute, or report the task correctly in a trial." },
    ],
  };
}

function buildTraceReviewArtifact(benchmark: string) {
  return {
    schema: "ax.trace-review/v1" as const,
    benchmark,
    generated_at: new Date().toISOString(),
    sample_size: 10,
    summary: "Methodology revisions require manual review of a fixed trace sample before changing task selection or grader logic.",
  };
}

/** Step B: draft the full task for one selected cluster (call in parallel per cluster). */
export async function draftTask(
  category: string,
  cluster: Cluster,
  extracts: CapabilityExtractResult[],
  index: number,
  opts: SynthesizeSuiteOptions = {},
): Promise<SynthesizedTask> {
  if (category === "database") {
    const deterministic = deterministicDatabaseTaskDraft(cluster, index);
    if (deterministic) return deterministic;
  }
  const byVendorCap = new Map<string, { vendor: string; title: string; description: string; doc_url: string }>();
  for (const e of extracts) {
    for (const c of e.capabilities) {
      byVendorCap.set(`${e.vendor}::${c.capability_name}`, {
        vendor: e.vendor,
        title: c.title,
        description: c.description,
        doc_url: c.evidence[0]?.doc_url ?? "official-docs",
      });
    }
  }
  const matched = cluster.coverage
    .map((cov) => byVendorCap.get(`${cov.vendor}::${cov.capability_name}`))
    .filter((m): m is NonNullable<typeof m> => m !== undefined);

  const label = `draft-task/${cluster.cluster_name}`;
  const raw = await invokeGenerator(buildTaskDraftPrompt(category, cluster, matched, index), {
    fallbackHarness: (opts.harness as "claude-code" | "codex" | undefined) ?? "claude-code",
    model: opts.model,
    effort: opts.effort as "low" | "medium" | "high" | undefined,
    heartbeat: { everyMs: 30_000, label },
    timeoutMs: TASK_DRAFT_TIMEOUT_MS,
  });
  const json = await extractJsonObjectWithRepair(raw, {
    fallbackHarness: (opts.harness as "claude-code" | "codex" | undefined) ?? "claude-code",
    model: opts.model,
    effort: opts.effort as "low" | "medium" | "high" | undefined,
    label,
  });
  const draftSchema = z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    difficulty: z.enum(["L1", "L2", "L3", "L4"]),
    skill: z.string().min(1),
    intent: z.string().min(1),
    oracle_hint: z.string().min(1),
    allowed_surfaces: z.array(z.enum(["api", "sdk", "cli"])).default(["api", "cli"]),
    na_examples: z.array(z.string()).default([]),
  });
  const parsed = draftSchema.safeParse(JSON.parse(json));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
    throw new Error(`draft-task for "${label}" returned non-conforming JSON: ${issues}\nRaw: ${json.slice(0, 2000)}`);
  }
  return { ...parsed.data, rationale: cluster.rationale, coverage: cluster.coverage };
}

/** Full pipeline: cluster+select (Step A), then draft all selected tasks in parallel (Step B). */
export async function synthesizeSuite(
  category: string,
  extracts: CapabilityExtractResult[],
  opts: SynthesizeSuiteOptions = {},
): Promise<SynthesizeResult> {
  const benchmark = `${category.toUpperCase()}-CANONICAL`;
  const methodology = {
    ...defaultSuiteMethodology(category),
    ...(opts.targetTaskCount ? { target_task_count: opts.targetTaskCount } : {}),
  };
  const universeClusters = await deriveCandidateUniverse(extracts, {
    harness: opts.harness as "claude-code" | "codex" | undefined,
    model: opts.model,
    effort: opts.effort as "low" | "medium" | "high" | undefined,
    deterministic: opts.deterministic,
  });
  const conceptUniverse: ConceptUniverse = {
    schema: "ax.concept-universe/v1",
    category,
    generated_at: new Date().toISOString(),
    clusters: universeClusters.map((cluster) => ({
      concept_name: cluster.concept_name,
      title: cluster.title,
      coverage: cluster.vendors_citing,
    })),
  };
  const gapChecks = await crossCheckGaps(extracts, universeClusters, {
    harness: opts.harness as "claude-code" | "codex" | undefined,
    model: opts.model,
    effort: opts.effort as "low" | "medium" | "high" | undefined,
    deterministic: opts.deterministic,
    gapCheckAssist: opts.gapCheckAssist,
  });
  const coverageMatrix = buildCoverageMatrixArtifact(category, conceptUniverse, extracts, gapChecks);
  const proposed = proposeClustersFromUniverse(conceptUniverse, coverageMatrix);
  const selectionLedger = buildSelectionLedgerArtifact(benchmark, category, methodology, conceptUniverse, coverageMatrix, proposed);
  const selectedClusters: Cluster[] = selectionLedger.entries
    .filter((entry) => entry.selected)
    .slice(0, methodology.target_task_count)
    .map((entry) => {
      const concept = coverageMatrix.concepts.find((candidate) => candidate.concept_name === entry.concept_name);
      const fittedCoverage = concept?.decisions
        .filter((decision) => decision.status === "supported")
        .flatMap((decision) => {
          const names = decision.capability_bundle?.length
            ? decision.capability_bundle
            : decision.capability_name ? [decision.capability_name] : [];
          return names.map((capability_name) => ({ vendor: decision.vendor, capability_name }));
        }) ?? [];
      return {
        cluster_name: entry.concept_name,
        title: entry.title,
        difficulty: entry.proposed_difficulty ?? resolveConceptDifficulty(entry.concept_name),
        rationale: entry.rationale,
        coverage: fittedCoverage,
      };
    });
  const drafted = await mapSettledLimit(
    selectedClusters,
    TASK_DRAFT_CONCURRENCY,
    (cluster, index) => draftTask(category, cluster, extracts, index, opts),
  );
  const taskFailures = drafted
    .map((result, index) => ({ result, cluster: selectedClusters[index] }))
    .filter((entry): entry is { result: PromiseRejectedResult; cluster: Cluster | undefined } => entry.result.status === "rejected");
  if (taskFailures.length > 0) {
    const details = taskFailures
      .map((entry) => `${entry.cluster?.cluster_name ?? "unknown"}: ${entry.result.reason instanceof Error ? entry.result.reason.message : String(entry.result.reason)}`)
      .join("; ");
    throw new Error(`task drafting failed for ${taskFailures.length} cluster(s): ${details}`);
  }
  const tasks = drafted
    .filter((result): result is PromiseFulfilledResult<SynthesizedTask> => result.status === "fulfilled")
    .map((result) => result.value);
  const supportMatrix = buildSupportMatrixArtifact(
    benchmark,
    category,
    methodology,
    coverageMatrix,
    tasks,
    selectedClusters,
  );
  const graderLedger = buildGraderLedgerArtifact(benchmark, tasks);
  const failureTaxonomy = buildFailureTaxonomyArtifact(benchmark);
  const traceReview = buildTraceReviewArtifact(benchmark);
  return { tasks, methodology, conceptUniverse, coverageMatrix, selectionLedger, supportMatrix, graderLedger, failureTaxonomy, traceReview };
}

/** Render the frozen suite YAML (loadSuite()-compatible) from a synthesis result. */
export function renderSuiteYaml(name: string, version: number, category: string, result: SynthesizeResult): string {
  const suite = {
    name,
    version,
    category,
    description: `Bottom-up-derived canonical task suite for the "${category}" category, synthesized from ${
      new Set(result.tasks.flatMap((t) => t.coverage.map((c) => c.vendor))).size
    } vendors' cited documentation (see ${name.toLowerCase()}.synthesis.md for the full audit trail).`,
    methodology: result.methodology,
    tasks: result.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      difficulty: t.difficulty,
      skill: t.skill,
      intent: t.intent,
      oracle_hint: t.oracle_hint,
      allowed_surfaces: t.allowed_surfaces,
      na_examples: t.na_examples,
    })),
    scoring: {
      per_task: "pass | fail | na",
      overall: {
        formula: "score = sum(passes) / sum(non_na_tasks)",
        notes:
          "N/A tasks (and N/A surfaces within a task) are excluded from both numerator and denominator. Support-matrix unsupported cells are N/A, not fail. Cross-vendor comparisons are valid only across tasks/surfaces both vendors actually run. Publication should also report intersection/core score, applicability coverage, and the full task×surface matrix — do not treat applicable pass rate as the sole leaderboard number.",
      },
      layers: {
        static_ax: "Discoverability & Readiness is published separately and never alters usability-suite pass rates.",
        behavioral: "Usability Canonical Suite is scored only from verified outcomes on api/cli for DAEB/database v1; SDK remains a deferred future surface and any existing SDK runs are research artifacts, not benchmark-of-record cells.",
      },
    },
  };
  return yamlStringify(suite);
}

/** Render the human-readable synthesis/audit-trail doc (coverage + rationale per task). */
export function renderSynthesisDoc(name: string, category: string, result: SynthesizeResult): string {
  const lines: string[] = [
    `# ${name} — Suite Synthesis Audit Trail`,
    ``,
    `Generated by \`synthesize-suite\` from vendor capability inventories (\`benchmarks/daeb/v1/extracts/<vendor>/capability-inventory.yaml\`).`,
    `Every task below traces to specific, cited vendor documentation.`,
    ``,
    `## Two-layer methodology`,
    ``,
    `- Discoverability & Readiness is a separate publication layer covering discoverability, content quality, and capability exposure.`,
    `- Usability Canonical Suite remains the benchmark of record and is scored only from verified outcomes on ${result.methodology.surface_scope.join("/")}.`,
    ``,
    `## Ontology`,
    ``,
    ...Object.entries(result.methodology.ontology).map(([term, definition]) => `- **${term}**: ${definition}`),
    ``,
    `## Selected tasks (${result.tasks.length})`,
    ``,
  ];
  for (const t of result.tasks) {
    lines.push(`### ${t.id} — ${t.title}`);
    lines.push(``);
    lines.push(`Difficulty: ${t.difficulty} · Skill: ${t.skill}`);
    lines.push(``);
    lines.push(`**Why selected**: ${t.rationale}`);
    lines.push(``);
    lines.push(`**Coverage** (${t.coverage.length} vendor capabilities clustered into this task):`);
    lines.push(``);
    lines.push(`| Vendor | Capability |`);
    lines.push(`|---|---|`);
    for (const c of t.coverage) lines.push(`| ${c.vendor} | ${c.capability_name} |`);
    lines.push(``);
  }
  return lines.join("\n");
}

export function writeSuiteFiles(root: string, path: string, suiteYaml: string, synthesisDoc: string): { suitePath: string; synthesisPath: string } {
  const suitePath = resolve(root, path);
  const synthesisPath = suitePath.replace(/\.yaml$/, ".synthesis.md");
  mkdirSync(dirname(suitePath), { recursive: true });
  writeFileSync(suitePath, suiteYaml);
  writeFileSync(synthesisPath, synthesisDoc);
  return { suitePath, synthesisPath };
}

export function writeSuiteArtifacts(root: string, suitePath: string, result: SynthesizeResult): string[] {
  const benchmark = suitePath.split("/").pop()?.replace(/\.yaml$/i, "").toUpperCase() ?? "CANONICAL-SUITE";
  return [
    writeMethodology(root, suitePath, result.methodology),
    writeConceptUniverse(root, suitePath, result.conceptUniverse),
    writeCoverageMatrix(root, suitePath, result.coverageMatrix),
    writeSelectionLedger(root, suitePath, { ...result.selectionLedger, benchmark }),
    writeSupportMatrix(root, suitePath, { ...result.supportMatrix, benchmark }),
    writeGraderLedger(root, suitePath, { ...result.graderLedger, benchmark }),
    writeFailureTaxonomy(root, suitePath, { ...result.failureTaxonomy, benchmark }),
    writeTraceReview(root, suitePath, { ...result.traceReview, benchmark }),
  ];
}
