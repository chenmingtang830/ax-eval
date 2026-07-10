/**
 * Post-synthesize audit for Layer 0b suite artifacts.
 *
 * Deterministic checks catch the failure modes we hit after seed+assist
 * synthesize: under-filled task banks, concept-mapping misses (inventory has
 * a capability but coverage matrix left the vendor inconclusive), bad suite
 * naming from --out suite.yaml, and thin difficulty spread. --apply rewrites
 * suite name/version metadata and can re-run a seed-only synthesize after
 * mapping fixes land in coverage-gap-check.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import {
  databaseConceptCompatibilityIssue,
  deriveCandidateUniverseDeterministic,
  matchDeterministicDatabaseConcept,
} from "./coverage-gap-check.js";
import { loadCapabilityExtract } from "./capability-extract.js";
import { loadSuite } from "./suite.js";
import {
  loadCoverageMatrix,
  loadSelectionLedger,
  loadSupportMatrix,
  loadTraceReview,
  type CoverageMatrix,
  type SupportMatrix,
} from "./methodology.js";
import { daebVendorsDir } from "./benchmark-paths.js";
import { readdirSync } from "node:fs";
import { loadVendorCard } from "./vendor-resolve.js";
import { coreVendorSlugs } from "./vendor-selection.js";

export type SuiteFindingSeverity = "error" | "warn" | "info";

export interface SuiteFinding {
  severity: SuiteFindingSeverity;
  code: string;
  message: string;
  concept_name?: string;
  auto_fixable: boolean;
}

export interface SuiteAuditReport {
  suitePath: string;
  findings: SuiteFinding[];
  summary: { errors: number; warns: number; infos: number; autoFixable: number };
  /** Suggested canonical suite name when --out was a bare suite.yaml. */
  suggestedName?: string;
  suggestedVersion?: number;
}

function listDatabaseSlugs(root: string): string[] {
  const selected = coreVendorSlugs(root);
  if (selected) return [...selected].sort();
  const dir = daebVendorsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".discovered.yaml"))
    .map((f) => f.replace(/\.discovered\.yaml$/, ""))
    .sort();
}

function loadYaml(path: string): unknown {
  return yamlParse(readFileSync(path, "utf8"));
}

/** Find inventory capabilities that should map to a concept but didn't. */
export function findMappingMisses(
  root: string,
  coverage: CoverageMatrix,
  slugs: string[],
): SuiteFinding[] {
  const findings: SuiteFinding[] = [];
  const byConcept = new Map(coverage.concepts.map((c) => [c.concept_name, c]));
  // Focus on near-miss / selected concepts — not every singleton.
  const interesting = coverage.concepts.filter((c) => {
    const supported = c.decisions.filter((d) => d.status === "supported").length;
    return supported >= 2;
  });

  const vendorToSlug = new Map<string, string>();
  for (const slug of slugs) {
    const card = loadVendorCard(root, slug);
    const inv = loadCapabilityExtract(root, slug);
    if (card?.vendor) vendorToSlug.set(card.vendor, slug);
    if (inv?.vendor) vendorToSlug.set(inv.vendor, slug);
    vendorToSlug.set(slug, slug);
  }

  for (const concept of interesting) {
    const missing = concept.decisions.filter((d) => d.status !== "supported");
    for (const decision of missing) {
      const slug = vendorToSlug.get(decision.vendor)
        ?? slugs.find((s) => s === decision.vendor.toLowerCase().replace(/\s+/g, "-"));
      if (!slug) continue;
      const inv = loadCapabilityExtract(root, slug);
      if (!inv) continue;
      const hits = inv.capabilities.filter((cap) => {
        const matched = matchDeterministicDatabaseConcept(cap);
        return matched?.concept_name === concept.concept_name;
      });
      if (!hits.length) continue;
      findings.push({
        severity: "warn",
        code: "mapping_would_cover",
        concept_name: concept.concept_name,
        message:
          `${decision.vendor} is ${decision.status} for ${concept.concept_name}, but current ` +
          `deterministic rules map inventory hits: ${hits.slice(0, 4).map((c) => c.capability_name).join(", ")} ` +
          `(re-synthesize to refresh coverage)`,
        auto_fixable: true,
      });
    }
  }
  return findings;
}

/** Find stale/false-positive coverage decisions whose cited capability no
 * longer maps to the claimed concept under the current semantic rules. */
export function findMappingFalsePositives(
  root: string,
  coverage: CoverageMatrix,
  slugs: string[],
): SuiteFinding[] {
  const findings: SuiteFinding[] = [];
  const vendorToSlug = new Map<string, string>();
  for (const slug of slugs) {
    const card = loadVendorCard(root, slug);
    const inv = loadCapabilityExtract(root, slug);
    if (card?.vendor) vendorToSlug.set(card.vendor, slug);
    if (inv?.vendor) vendorToSlug.set(inv.vendor, slug);
    vendorToSlug.set(slug, slug);
  }

  for (const concept of coverage.concepts) {
    for (const decision of concept.decisions) {
      const conceptCapabilityName = decision.concept_capability_name
        ?? (decision.task_fit ? undefined : decision.capability_name);
      if (decision.status !== "supported" || !conceptCapabilityName) continue;
      const slug = vendorToSlug.get(decision.vendor)
        ?? slugs.find((candidate) => candidate === decision.vendor.toLowerCase().replace(/\s+/g, "-"));
      if (!slug) continue;
      const inventory = loadCapabilityExtract(root, slug);
      if (!inventory) continue;
      const capability = inventory.capabilities.find((candidate) =>
        candidate.capability_name === conceptCapabilityName
      );
      if (!capability) continue;

      const currentMatch = matchDeterministicDatabaseConcept(capability);
      const compatibilityIssue = databaseConceptCompatibilityIssue(capability, concept.concept_name);
      const fallbackConceptName = capability.capability_name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      const effectiveConceptName = currentMatch?.concept_name ?? fallbackConceptName;
      if (effectiveConceptName === concept.concept_name && !compatibilityIssue) continue;

      const directAlternatives = inventory.capabilities
        .filter((candidate) =>
          matchDeterministicDatabaseConcept(candidate)?.concept_name === concept.concept_name
        )
        .map((candidate) => candidate.capability_name)
        .slice(0, 4);
      findings.push({
        severity: "error",
        code: "mapping_false_positive",
        concept_name: concept.concept_name,
        message:
          `${decision.vendor}/${concept.concept_name} cites ${capability.capability_name}, but current semantic mapping ` +
          `${compatibilityIssue ?? `assigns it to ${effectiveConceptName}`}` +
          `${directAlternatives.length ? `; direct inventory alternatives: ${directAlternatives.join(", ")}` : ""} ` +
          `(re-synthesize to refresh coverage)`,
        auto_fixable: true,
      });
    }
  }
  return findings;
}

/** Selected canonical coverage must be backed by concrete task-fit evidence,
 * not merely broad concept membership. */
export function findTaskFitAuditFindings(
  coverage: CoverageMatrix,
  selectedConcepts: Set<string>,
  supportMatrix?: SupportMatrix | null,
): SuiteFinding[] {
  const findings: SuiteFinding[] = [];
  for (const concept of coverage.concepts) {
    if (!selectedConcepts.has(concept.concept_name)) continue;
    for (const decision of concept.decisions) {
      if (decision.status !== "supported") continue;
      if (!decision.task_fit) {
        findings.push({
          severity: "error",
          code: "task_fit_unproven",
          concept_name: concept.concept_name,
          message:
            `${decision.vendor}/${concept.concept_name} is marked supported without task-fit evidence` +
            `${decision.capability_name ? ` (selected ${decision.capability_name})` : ""}`,
          auto_fixable: true,
        });
        continue;
      }
      const supportedCells = supportMatrix?.entries.filter((entry) =>
        entry.vendor === decision.vendor
        && entry.source_concept === concept.concept_name
        && entry.status === "supported"
      ) ?? [];
      if (decision.task_fit.status === "insufficient" && supportedCells.length) {
        findings.push({
          severity: "error",
          code: "task_fit_leaked_support",
          concept_name: concept.concept_name,
          message:
            `${decision.vendor}/${concept.concept_name} has insufficient task fit but support matrix exposes ` +
            `${supportedCells.map((entry) => entry.surface).join(", ")}`,
          auto_fixable: true,
        });
        continue;
      }
      const invalidSurfaces = supportedCells
        .map((entry) => entry.surface)
        .filter((surface) => !decision.task_fit?.supported_surfaces.includes(surface));
      if (invalidSurfaces.length) {
        findings.push({
          severity: "error",
          code: "task_fit_surface_mismatch",
          concept_name: concept.concept_name,
          message:
            `${decision.vendor}/${concept.concept_name} support matrix exposes task-fit-incompatible surfaces: ` +
            invalidSurfaces.join(", "),
          auto_fixable: true,
        });
      }
    }
  }
  return findings;
}

export function auditSuite(root: string, suitePath: string): SuiteAuditReport {
  const abs = resolve(root, suitePath);
  const suite = loadSuite(abs);
  const findings: SuiteFinding[] = [];
  const ledger = loadSelectionLedger(root, suitePath);
  const coverage = loadCoverageMatrix(root, suitePath);
  const supportMatrix = loadSupportMatrix(root, suitePath);
  const traceReview = loadTraceReview(root, suitePath);
  const target = suite.methodology?.target_task_count ?? 10;
  const minPct = suite.methodology?.min_vendor_coverage_pct ?? 0.75;

  if (suite.tasks.length < target) {
    findings.push({
      severity: "error",
      code: "underfilled_task_bank",
      message: `Suite has ${suite.tasks.length} tasks; methodology target_task_count is ${target}`,
      auto_fixable: true,
    });
  }

  const stem = basename(suitePath).replace(/\.yaml$/i, "");
  // Active contract path is suite.yaml; only flag when the *name* is still the
  // placeholder "SUITE" (from older synthesize that uppercased the stem).
  if (suite.name === "SUITE" || /^suite$/i.test(suite.name)) {
    findings.push({
      severity: "error",
      code: "generic_suite_name",
      message: `Suite name is generic ("${suite.name}" from ${stem}.yaml); prefer DAEB-1`,
      auto_fixable: true,
    });
  }

  const difficulties = new Set(suite.tasks.map((t) => t.difficulty));
  for (const level of ["L1", "L2", "L3", "L4"] as const) {
    if (!difficulties.has(level)) {
      findings.push({
        severity: "warn",
        code: "missing_difficulty",
        message: `No selected task at difficulty ${level}`,
        auto_fixable: false,
      });
    }
  }

  if (!traceReview || traceReview.status !== "completed") {
    findings.push({
      severity: "error",
      code: traceReview ? "trace_review_pending" : "trace_review_missing",
      message: traceReview
        ? `Trace-review checkpoint is pending (${traceReview.sample_ids.length}/${traceReview.sample_size} sample ids recorded)`
        : "Trace-review artifact is missing",
      auto_fixable: false,
    });
  }

  if (ledger) {
    const nearMiss = ledger.entries.filter((entry) => {
      if (entry.selected) return false;
      const n = entry.covered_vendors?.length ?? 0;
      const totalGuess = Math.round(n / Math.max(entry.coverage_pct || 0.01, 0.01));
      const minVendors = Math.ceil(minPct * Math.max(totalGuess, n, 1));
      return n >= minVendors - 1 && n < minVendors;
    });
    for (const entry of nearMiss.slice(0, 12)) {
      findings.push({
        severity: "warn",
        code: "near_miss_coverage",
        concept_name: entry.concept_name,
        message:
          `${entry.concept_name} rejected (${entry.rejection_reason ?? "coverage"}) with ` +
          `${entry.covered_vendors?.length ?? 0} vendors @ ${(entry.coverage_pct * 100).toFixed(1)}%`,
        auto_fixable: false,
      });
    }
  }

  if (coverage) {
    const slugs = listDatabaseSlugs(root);
    findings.push(...findTaskFitAuditFindings(
      coverage,
      new Set(suite.tasks.map((task) => task.skill)),
      supportMatrix,
    ));
    findings.push(...findMappingFalsePositives(root, coverage, slugs));
    findings.push(...findMappingMisses(root, coverage, slugs));

    // Preview: with current deterministic rules, how many concepts hit ≥75%?
    const extracts = slugs
      .map((s) => loadCapabilityExtract(root, s))
      .filter((e): e is NonNullable<typeof e> => e !== null);
    if (extracts.length >= 2) {
      const clusters = deriveCandidateUniverseDeterministic(extracts);
      const vendorTotal = extracts.length;
      const minVendors = Math.ceil(minPct * vendorTotal);
      const eligible = clusters.filter((c) => new Set(c.vendors_citing.map((v) => v.vendor)).size >= minVendors);
      if (eligible.length < target) {
        findings.push({
          severity: "warn",
          code: "seed_eligible_short",
          message:
            `Current deterministic seed yields ${eligible.length} concepts with ≥${minVendors}/${vendorTotal} vendors ` +
            `(need ${target}). Extend mapping rules or lower coverage bar.`,
          auto_fixable: false,
        });
      } else if (suite.tasks.length < target) {
        findings.push({
          severity: "info",
          code: "seed_eligible_ok",
          message:
            `Current deterministic seed has ${eligible.length} concepts ≥${minVendors}/${vendorTotal} — ` +
            `re-synthesize should fill the task bank`,
          auto_fixable: true,
        });
      }
    }
  }

  return {
    suitePath: abs,
    findings,
    summary: {
      errors: findings.filter((f) => f.severity === "error").length,
      warns: findings.filter((f) => f.severity === "warn").length,
      infos: findings.filter((f) => f.severity === "info").length,
      autoFixable: findings.filter((f) => f.auto_fixable).length,
    },
    suggestedName: "DAEB-1",
    suggestedVersion: 1,
  };
}

export function formatSuiteAuditReport(report: SuiteAuditReport): string {
  const lines = [
    `Suite audit: ${report.suitePath}`,
    `  ${report.summary.errors} error(s), ${report.summary.warns} warn(s), ` +
      `${report.summary.infos} info(s), ${report.summary.autoFixable} auto-fixable`,
  ];
  for (const f of report.findings) {
    const where = f.concept_name ? ` [${f.concept_name}]` : "";
    lines.push(`  - ${f.severity}/${f.code}${where}: ${f.message}${f.auto_fixable ? " (autofix)" : ""}`);
  }
  return lines.join("\n");
}

/**
 * Apply metadata autofixes (name/version). Mapping fixes live in code
 * (DATABASE_DETERMINISTIC_RULES); caller should re-synthesize after --apply.
 */
export function applySuiteAudit(root: string, suitePath: string, report: SuiteAuditReport): string[] {
  const written: string[] = [];
  const abs = resolve(root, suitePath);
  if (!existsSync(abs)) return written;
  const raw = loadYaml(abs) as Record<string, unknown>;
  let changed = false;
  if (report.findings.some((f) => f.code === "generic_suite_name")) {
    raw.name = report.suggestedName ?? "DAEB-1";
    if (typeof raw.version !== "number" || raw.version < 1) raw.version = report.suggestedVersion ?? 1;
    changed = true;
  }
  if (changed) {
    const header = `# Canonical task suite (draft until human freeze).\n# Autofixed by audit-suite --apply.\n`;
    writeFileSync(abs, `${header}${yamlStringify(raw)}`);
    written.push(abs);
  }
  // Sibling methodology artifacts keep the stem; rename note for humans.
  const notePath = resolve(dirname(abs), `${basename(abs, ".yaml")}.audit-notes.md`);
  const notes = [
    "# Suite audit autofix notes",
    "",
    `- Applied at: ${new Date().toISOString()}`,
    `- Findings: ${report.summary.errors}e / ${report.summary.warns}w / ${report.summary.infos}i`,
    "",
    "Mapping / coverage autofixes require re-running:",
    "",
    "```bash",
    `npm run ax-eval -- synthesize-suite --category database --out ${suitePath} --deterministic --task-count 10`,
    "npm run ax-eval -- audit-suite --suite " + suitePath,
    "```",
    "",
    ...report.findings.map((f) => `- **${f.severity}/${f.code}**: ${f.message}`),
    "",
  ];
  writeFileSync(notePath, notes.join("\n"));
  written.push(notePath);
  return written;
}
