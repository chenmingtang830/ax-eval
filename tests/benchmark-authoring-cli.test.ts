import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  benchmarkCapabilityInventoryPath,
  benchmarkCompiledPackPath,
  benchmarkOraclesPath,
  benchmarkSurfacesPath,
  benchmarkVendorCardPath,
  buildBenchmarkLayout,
} from "../src/generate/benchmark-paths.js";
import { createBenchmarkAuthoringArtifacts } from "./fixtures/benchmark-authoring.js";
import { useBenchmarkTestLayout } from "./fixtures/benchmark-layout.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "src", "cli.ts");
const { layout, writeYaml } = useBenchmarkTestLayout("ax-benchmark-authoring-cli-");

function runCli(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync("node", ["--import", "tsx", CLI, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      code: failure.status ?? 1,
      out: (failure.stdout ?? "") + (failure.stderr ?? ""),
    };
  }
}

async function writeBenchmarkArtifacts() {
  const benchmarkLayout = layout();
  const artifacts = await createBenchmarkAuthoringArtifacts();
  writeYaml(benchmarkLayout.suite_path, artifacts.suite);
  writeYaml(benchmarkLayout.suite_concept_universe_path, artifacts.universe);
  writeYaml(benchmarkLayout.suite_coverage_selection_path, artifacts.selection);
  writeYaml(benchmarkLayout.suite_coverage_matrix_path, artifacts.matrix);
  writeYaml(benchmarkLayout.suite_trace_review_path, artifacts.trace_review);
  writeYaml(benchmarkLayout.vendor_selection_ledger_path, artifacts.ledger);
  writeYaml(benchmarkCapabilityInventoryPath(benchmarkLayout, "acme"), artifacts.capabilities);
  writeYaml(benchmarkSurfacesPath(benchmarkLayout, "acme"), artifacts.surfaces);
  writeYaml(benchmarkVendorCardPath(benchmarkLayout, "acme"), artifacts.vendor);
  writeYaml(benchmarkOraclesPath(benchmarkLayout, "acme"), artifacts.tasks);
  writeYaml(benchmarkCompiledPackPath(benchmarkLayout, "acme"), artifacts.pack);
  const configPath = resolve(benchmarkLayout.root, "acme.compose.yaml");
  writeYaml(configPath, artifacts.config);
  return { benchmarkLayout, configPath };
}

describe("audit-benchmark CLI", () => {
  it("documents its read-only contract", () => {
    const result = runCli(["audit-benchmark", "--help"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("--pack-config <slug>=<yaml>");
    expect(result.out).toContain("Never writes, repairs, approves, invokes, verifies, or resets");
  });

  it("prints a passing JSON report for coherent artifacts", async () => {
    const { benchmarkLayout, configPath } = await writeBenchmarkArtifacts();
    const result = runCli([
      "audit-benchmark",
      "--benchmark-root", benchmarkLayout.root,
      "--benchmark", benchmarkLayout.benchmark,
      "--benchmark-version", benchmarkLayout.version,
      "--pack-config", `acme=${configPath}`,
      "--reset-verified", "acme",
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({
      status: "pass",
      summary: { errors: 0, warnings: 0 },
    });
  });

  it("exits nonzero and reports missing authoring artifacts", () => {
    const benchmarkLayout = buildBenchmarkLayout(layout().root, "missing-benchmark", "v1");
    const result = runCli([
      "audit-benchmark",
      "--benchmark-root", benchmarkLayout.root,
      "--benchmark", benchmarkLayout.benchmark,
      "--benchmark-version", benchmarkLayout.version,
    ]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({ status: "fail" });
  });

  it("rejects malformed and duplicate pack config assignments", () => {
    expect(runCli([
      "audit-benchmark", "--benchmark", "sample", "--benchmark-version", "v1",
      "--pack-config", "acme",
    ]).out).toContain("--pack-config expects <slug>=<yaml>");
    expect(runCli([
      "audit-benchmark", "--benchmark", "sample", "--benchmark-version", "v1",
      "--pack-config", "acme=first.yaml", "--pack-config", "acme=second.yaml",
    ]).out).toContain("duplicate --pack-config for acme");
  });
});
