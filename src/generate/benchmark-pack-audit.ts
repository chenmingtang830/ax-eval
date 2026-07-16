import { TargetPackSchema } from "../schemas.js";
import { loadOptionalYamlArtifact } from "./artifact-yaml.js";
import {
  benchmarkCompiledPackPath,
  benchmarkOraclesPath,
  benchmarkSurfacesPath,
  benchmarkVendorCardPath,
  type BenchmarkLayout,
} from "./benchmark-paths.js";
import { parsePackComposeConfig, type PackComposeConfig } from "./pack-compose-config.js";
import { auditComposedPack, type PackAuditFinding } from "./pack-audit.js";
import { loadOptionalSuitePath } from "./suite.js";
import { loadSurfaceExtractPath } from "./surface-extract.js";
import { loadTaskExtractPath } from "./task-extract.js";
import { loadVendorCardPath } from "./vendor-resolve.js";

export type BenchmarkPackArtifact = "suite" | "vendor-card" | "surface-extract" | "task-extract" | "composed-pack";

export type BenchmarkPackAuditFinding =
  | {
      scope: "benchmark";
      slug: string;
      severity: "error";
      code: "benchmark_pack_artifact_missing";
      artifact: BenchmarkPackArtifact;
      message: string;
    }
  | {
      scope: "benchmark";
      slug: string;
      severity: "error";
      code: "benchmark_pack_inputs_invalid";
      message: string;
    }
  | (PackAuditFinding & { scope: "pack"; slug: string });

export interface BenchmarkPackAuditResult {
  status: "pass" | "fail";
  findings: BenchmarkPackAuditFinding[];
}

export function auditBenchmarkPack(
  layout: BenchmarkLayout,
  slug: string,
  rawConfig: PackComposeConfig,
): BenchmarkPackAuditResult {
  const config = parsePackComposeConfig(rawConfig);
  const artifactPaths: Record<BenchmarkPackArtifact, string> = {
    suite: layout.suite_path,
    "vendor-card": benchmarkVendorCardPath(layout, slug),
    "surface-extract": benchmarkSurfacesPath(layout, slug),
    "task-extract": benchmarkOraclesPath(layout, slug),
    "composed-pack": benchmarkCompiledPackPath(layout, slug),
  };
  const suite = loadOptionalSuitePath(artifactPaths.suite);
  const vendor = loadVendorCardPath(artifactPaths["vendor-card"]);
  const surfaces = loadSurfaceExtractPath(artifactPaths["surface-extract"]);
  const tasks = loadTaskExtractPath(artifactPaths["task-extract"]);
  const pack = loadOptionalYamlArtifact(artifactPaths["composed-pack"], TargetPackSchema, "composed pack");
  const loaded = { suite, "vendor-card": vendor, "surface-extract": surfaces, "task-extract": tasks, "composed-pack": pack };
  const missing = (Object.keys(artifactPaths) as BenchmarkPackArtifact[]).filter((artifact) => !loaded[artifact]);
  if (missing.length > 0) {
    return {
      status: "fail",
      findings: missing.map((artifact) => ({
        scope: "benchmark",
        slug,
        severity: "error",
        code: "benchmark_pack_artifact_missing",
        artifact,
        message: `Required ${artifact} is missing at ${artifactPaths[artifact]}`,
      })),
    };
  }

  try {
    const findings = auditComposedPack({
      pack: pack!,
      vendor: vendor!,
      suite: suite!,
      surfaces: surfaces!,
      tasks: tasks!,
      config,
    }).map((finding): BenchmarkPackAuditFinding => ({ ...finding, scope: "pack", slug }));
    return { status: findings.length === 0 ? "pass" : "fail", findings };
  } catch {
    return {
      status: "fail",
      findings: [{
        scope: "benchmark",
        slug,
        severity: "error",
        code: "benchmark_pack_inputs_invalid",
        message: `Reviewed authoring inputs cannot be composed for ${slug}`,
      }],
    };
  }
}
