import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { auditBenchmarkPack } from "../src/generate/benchmark-pack-audit.js";
import {
  benchmarkCompiledPackPath,
  benchmarkOraclesPath,
  benchmarkSurfacesPath,
  benchmarkVendorCardPath,
  buildBenchmarkLayout,
  type BenchmarkLayout,
} from "../src/generate/benchmark-paths.js";
import { composePack } from "../src/generate/compose-pack.js";
import type { PackComposeConfig } from "../src/generate/pack-compose-config.js";
import type { Suite } from "../src/generate/suite.js";
import type { SurfaceExtractResult } from "../src/generate/surface-extract.js";
import type { TaskExtractResult } from "../src/generate/task-extract.js";
import type { ResolveResult } from "../src/generate/vendor-resolve.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const vendor: ResolveResult = {
  vendor: "Acme",
  category: "database",
  slug: "acme",
  discovered_at: "2026-07-16T00:00:00.000Z",
  resolver: { method: "grounded-generator", prompt_version: "test" },
  site_url: "https://acme.example",
  docs_url: "https://docs.acme.example",
};

const suite: Suite = {
  name: "database-core",
  version: 1,
  category: "database",
  tasks: [{
    id: "create-record",
    title: "Create a record",
    difficulty: "L1",
    skill: "records",
    intent: "Create one namespaced record.",
    oracle_hint: "Read the record back.",
    allowed_surfaces: ["api"],
    na_examples: [],
  }],
};

const surfaces: SurfaceExtractResult = {
  vendor: "Acme",
  slug: "acme",
  extracted_at: "2026-07-16T00:00:00.000Z",
  cli: null,
  sdk: null,
  mcp: null,
};

const tasks: TaskExtractResult = {
  vendor: "Acme",
  slug: "acme",
  suite_name: "database-core",
  suite_version: 1,
  extracted_at: "2026-07-16T00:00:00.000Z",
  extractor: "test",
  tasks: [{
    id: "create-record",
    title: "Create a record",
    difficulty: "L1",
    prompt: "Create ax_record_{ns}.",
    allowed_surfaces: ["api"],
    na: false,
    na_reason: null,
    support_evidence: [{ doc_url: "https://docs.acme.example/records", quote: "Create records." }],
    oracles: [{
      type: "roundtrip",
      readMethod: "GET",
      readPathTemplate: "/records/{gid}",
      assertField: "name",
      expected: "ax_record_{ns}",
      description: "Record exists.",
    }],
  }],
};

const config: PackComposeConfig = {
  base_url: "https://api.acme.example",
  api_style: "rest",
  auth: { type: "none", env: "", env_aliases: [], verify_env_aliases: [] },
  sandbox_scope: [],
  headers: {},
};

function layout(): BenchmarkLayout {
  const root = mkdtempSync(join(tmpdir(), "ax-benchmark-pack-audit-"));
  directories.push(root);
  return buildBenchmarkLayout(root, "database-eval", "v1");
}

function writeYaml(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yamlStringify(value));
}

function writeAuthoringArtifacts(benchmarkLayout: BenchmarkLayout, options: {
  taskExtract?: TaskExtractResult;
  packBaseUrl?: string;
} = {}): void {
  const selectedTasks = options.taskExtract ?? tasks;
  const pack = composePack(vendor, suite, surfaces, selectedTasks, config, {
    now: () => new Date("2026-07-16T01:02:03.000Z"),
  });
  writeYaml(benchmarkLayout.suite_path, suite);
  writeYaml(benchmarkVendorCardPath(benchmarkLayout, "acme"), vendor);
  writeYaml(benchmarkSurfacesPath(benchmarkLayout, "acme"), surfaces);
  writeYaml(benchmarkOraclesPath(benchmarkLayout, "acme"), selectedTasks);
  writeYaml(benchmarkCompiledPackPath(benchmarkLayout, "acme"), {
    ...pack,
    base_url: options.packBaseUrl ?? pack.base_url,
  });
}

describe("auditBenchmarkPack", () => {
  it("passes a complete benchmark-layout pack contract", () => {
    const benchmarkLayout = layout();
    writeAuthoringArtifacts(benchmarkLayout);
    expect(auditBenchmarkPack(benchmarkLayout, "acme", config)).toEqual({ status: "pass", findings: [] });
  });

  it("reports every required missing artifact in deterministic order", () => {
    const benchmarkLayout = layout();
    const result = auditBenchmarkPack(benchmarkLayout, "acme", config);
    expect(result.status).toBe("fail");
    expect(result.findings.map((finding) => "artifact" in finding ? finding.artifact : finding.code)).toEqual([
      "suite",
      "vendor-card",
      "surface-extract",
      "task-extract",
      "composed-pack",
    ]);
  });

  it("returns pack-scoped drift findings", () => {
    const benchmarkLayout = layout();
    writeAuthoringArtifacts(benchmarkLayout, { packBaseUrl: "https://changed.example" });
    expect(auditBenchmarkPack(benchmarkLayout, "acme", config)).toMatchObject({
      status: "fail",
      findings: [{ scope: "pack", slug: "acme", code: "pack_config_drift" }],
    });
  });

  it("fails closed without exposing details when authoring artifacts disagree", () => {
    const benchmarkLayout = layout();
    writeAuthoringArtifacts(benchmarkLayout);
    writeYaml(benchmarkOraclesPath(benchmarkLayout, "acme"), { ...tasks, vendor: "Other" });
    expect(auditBenchmarkPack(benchmarkLayout, "acme", config)).toEqual({
      status: "fail",
      findings: [{
        scope: "benchmark",
        slug: "acme",
        severity: "error",
        code: "benchmark_pack_inputs_invalid",
        message: "Reviewed authoring inputs cannot be composed for acme",
      }],
    });
  });
});
