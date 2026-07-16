import {
  auditBenchmarkPackWithConfig,
  type BenchmarkPackAuditFinding,
} from "./benchmark-pack-audit.js";
import type { BenchmarkLayout } from "./benchmark-paths.js";
import type { BenchmarkVendorContext } from "./benchmark-vendor-context.js";
import { parsePackComposeConfig } from "./pack-compose-config.js";

export type BenchmarkCorePackFinding =
  | {
      scope: "benchmark";
      slug: string;
      severity: "error";
      code: "benchmark_pack_config_missing" | "benchmark_pack_config_invalid";
      message: string;
    }
  | BenchmarkPackAuditFinding;

export interface BenchmarkCorePackResult {
  slug: string;
  status: "pass" | "fail" | "skipped";
  findings: BenchmarkCorePackFinding[];
}

export interface BenchmarkCorePackAuditResult {
  status: "pass" | "fail" | "skipped";
  summary: { errors: number };
  packs: BenchmarkCorePackResult[];
}

export function auditBenchmarkCorePacks(
  layout: BenchmarkLayout,
  context: BenchmarkVendorContext,
  rawConfigs: ReadonlyMap<string, unknown>,
): BenchmarkCorePackAuditResult {
  const packs = context.core_slugs.map((slug): BenchmarkCorePackResult => {
    if (!rawConfigs.has(slug)) {
      return {
        slug,
        status: "fail",
        findings: [{
          scope: "benchmark",
          slug,
          severity: "error",
          code: "benchmark_pack_config_missing",
          message: `Core vendor ${slug} requires an explicit pack compose configuration`,
        }],
      };
    }
    let config;
    try {
      config = parsePackComposeConfig(rawConfigs.get(slug));
    } catch {
      return {
        slug,
        status: "fail",
        findings: [{
          scope: "benchmark",
          slug,
          severity: "error",
          code: "benchmark_pack_config_invalid",
          message: `Core vendor ${slug} has an invalid pack compose configuration`,
        }],
      };
    }

    const rawResult = auditBenchmarkPackWithConfig(layout, slug, config);
    const findings = rawResult.findings.filter((finding) => !(
      finding.code === "benchmark_pack_artifact_missing"
      && finding.artifact === "surface-extract"
      && !context.surfaces.has(slug)
    ));
    const suppressedFindings = rawResult.findings.length - findings.length;
    return {
      slug,
      status: findings.length > 0 ? "fail" : suppressedFindings > 0 ? "skipped" : "pass",
      findings,
    };
  });
  const errors = packs.flatMap((pack) => pack.findings).length;
  const skipped = packs.some((pack) => pack.status === "skipped");
  return {
    status: errors > 0 ? "fail" : skipped ? "skipped" : "pass",
    summary: { errors },
    packs,
  };
}
