import {
  auditLoadedBenchmarkCohortAuthoring,
  type BenchmarkCohortAuthoringAuditResult,
} from "./benchmark-cohort-authoring-audit.js";
import {
  auditBenchmarkCorePacks,
  type BenchmarkCorePackAuditResult,
} from "./benchmark-core-pack-audit.js";
import type { BenchmarkLayout } from "./benchmark-paths.js";
import {
  auditBenchmarkSuiteAuthoring,
  type BenchmarkSuiteAuthoringAuditResult,
} from "./benchmark-suite-authoring-audit.js";
import { loadBenchmarkVendorContext } from "./benchmark-vendor-context.js";

export interface BenchmarkAuthoringAuditResult {
  status: "pass" | "warn" | "fail";
  summary: {
    errors: number;
    warnings: number;
  };
  suite_authoring: BenchmarkSuiteAuthoringAuditResult;
  cohort_authoring: BenchmarkCohortAuthoringAuditResult;
  packs: BenchmarkCorePackAuditResult;
}

function suppressSuiteOwnedPackFindings(
  packs: BenchmarkCorePackAuditResult,
  suiteAuthoring: BenchmarkSuiteAuthoringAuditResult,
): BenchmarkCorePackAuditResult {
  const suiteMissing = suiteAuthoring.suite.findings.some((finding) =>
    finding.code === "benchmark_suite_artifact_missing" && finding.artifact === "suite");
  if (!suiteMissing) return packs;
  let suppressedFindings = 0;
  const filteredPacks = packs.packs.map((pack) => {
    const findings = pack.findings.filter((finding) => !(
      finding.code === "benchmark_pack_artifact_missing" && finding.artifact === "suite"
    ));
    const suppressedPackFindings = pack.findings.length - findings.length;
    suppressedFindings += suppressedPackFindings;
    return {
      ...pack,
      status: findings.length > 0 ? "fail" as const : suppressedPackFindings > 0 ? "skipped" as const : pack.status,
      findings,
    };
  });
  if (suppressedFindings === 0) return packs;
  const errors = filteredPacks.flatMap((pack) => pack.findings).length;
  return {
    status: errors > 0
      ? "fail"
      : filteredPacks.some((pack) => pack.status === "skipped")
        ? "skipped"
        : "pass",
    summary: { errors },
    packs: filteredPacks,
  };
}

export function auditBenchmarkAuthoring(
  layout: BenchmarkLayout,
  options: {
    resetVerified: ReadonlySet<string>;
    packConfigs: ReadonlyMap<string, unknown>;
  },
): BenchmarkAuthoringAuditResult {
  const suiteAuthoring = auditBenchmarkSuiteAuthoring(layout);
  const loadedContext = loadBenchmarkVendorContext(layout);
  const cohortAuthoring = auditLoadedBenchmarkCohortAuthoring(loadedContext, options.resetVerified);
  const rawPacks = loadedContext.status === "ready"
    ? auditBenchmarkCorePacks(layout, loadedContext.context, options.packConfigs)
    : { status: "skipped" as const, summary: { errors: 0 }, packs: [] };
  const packs = suppressSuiteOwnedPackFindings(rawPacks, suiteAuthoring);
  const errors = suiteAuthoring.summary.errors + cohortAuthoring.summary.errors + packs.summary.errors;
  const warnings = suiteAuthoring.summary.warnings + cohortAuthoring.summary.warnings;
  return {
    status: errors > 0 ? "fail" : warnings > 0 ? "warn" : "pass",
    summary: { errors, warnings },
    suite_authoring: suiteAuthoring,
    cohort_authoring: cohortAuthoring,
    packs,
  };
}
