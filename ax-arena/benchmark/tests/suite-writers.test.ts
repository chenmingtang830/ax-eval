import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applySuiteAudit, type SuiteAuditReport } from "../src/authoring/suite-audit.js";
import {
  DAEB_BENCHMARK_ROOT,
  DAEB_LEGACY_BENCHMARK_ROOT,
  createDaebPathContext,
} from "../src/authoring/benchmark-paths.js";
import {
  synthesizeSuite,
  writeSuiteArtifacts,
  writeSuiteBundle,
  writeSuiteFiles,
} from "../src/authoring/synthesize-suite.js";

const roots: string[] = [];

function freshRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), "ax-suite-writers-"));
  roots.push(root);
  return root;
}

function genericNameReport(suitePath: string): SuiteAuditReport {
  return {
    suitePath,
    findings: [{
      severity: "error",
      code: "generic_suite_name",
      message: "Use DAEB-1.",
      auto_fixable: true,
    }],
    summary: { errors: 1, warns: 0, infos: 0, autoFixable: 1 },
    suggestedName: "DAEB-1",
    suggestedVersion: 1,
  };
}

async function synthesisFixture() {
  return synthesizeSuite("database", [{
    schema: "ax.capability-inventory/v1",
    vendor: "Acme",
    slug: "acme",
    category: "database",
    extracted_at: "2026-01-01T00:00:00.000Z",
    audit_status: "candidate",
    audit_notes: [],
    capabilities: [{
      capability_name: "create-table",
      title: "Create table",
      family: "data-definition",
      description: "Create a table.",
      resource_kind: "table",
      operation_kind: "create",
      surfaces_documented: ["api", "sdk", "cli"],
      support_type: "native",
      evidence: [{ doc_url: "https://docs.example/tables", quote: "Create tables." }],
      extraction_provenance: {
        source: "official-docs",
        extracted_at: "2026-01-01T00:00:00.000Z",
        extractor: "test",
      },
    }],
  }], { targetTaskCount: 1, deterministic: true });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("canonical suite writers", () => {
  it("rejects legacy and outside suite destinations before writing", () => {
    const root = freshRoot();
    for (const path of ["benchmarks/daeb/v1/suite.yaml", "outside/suite.yaml"]) {
      expect(() => writeSuiteFiles(root, path, "suite", "synthesis"))
        .toThrow(/writers use only the canonical benchmark root/);
      expect(existsSync(resolve(root, path))).toBe(false);
    }

    const written = writeSuiteFiles(
      root,
      "ax-arena/benchmark/daeb/v1/suite.yaml",
      "suite",
      "synthesis",
    );
    expect(readFileSync(written.suitePath, "utf8")).toBe("suite");
    expect(readFileSync(written.synthesisPath, "utf8")).toBe("synthesis");
  });

  it("rejects suite paths whose sibling names would collide", async () => {
    const root = freshRoot();
    const result = await synthesisFixture();
    for (const name of ["suite.YAML", "suite.yml", "suite"]) {
      const path = `ax-arena/benchmark/daeb/v1/${name}`;
      expect(() => writeSuiteFiles(root, path, "suite", "synthesis"))
        .toThrow(/canonical lowercase \.yaml/);
      expect(() => writeSuiteArtifacts(root, path, result))
        .toThrow(/canonical lowercase \.yaml/);
      expect(() => applySuiteAudit(root, path, genericNameReport(path)))
        .toThrow(/canonical lowercase \.yaml/);
      expect(existsSync(resolve(root, path))).toBe(false);
    }
  });

  it("requires an explicit path context for ambiguous roots and supports it consistently", async () => {
    const root = freshRoot();
    const canonical = resolve(root, DAEB_BENCHMARK_ROOT);
    const legacy = resolve(root, DAEB_LEGACY_BENCHMARK_ROOT);
    mkdirSync(resolve(canonical, "v1"), { recursive: true });
    mkdirSync(legacy, { recursive: true });
    const suitePath = "ax-arena/benchmark/daeb/v1/suite.yaml";

    expect(() => writeSuiteFiles(root, suitePath, "name: SUITE\nversion: 0\n", "synthesis"))
      .toThrow(/ambiguous benchmark roots/);
    const paths = createDaebPathContext(root, { explicitRoot: DAEB_BENCHMARK_ROOT });
    const suite = writeSuiteFiles(paths, suitePath, "name: SUITE\nversion: 0\n", "synthesis");
    const artifacts = writeSuiteArtifacts(paths, suitePath, await synthesisFixture());
    const audit = applySuiteAudit(paths, suitePath, genericNameReport(suitePath));

    expect(suite.suitePath).toBe(resolve(canonical, "v1", "suite.yaml"));
    expect(artifacts).toHaveLength(9);
    expect(audit).toHaveLength(2);
    expect(readFileSync(suite.suitePath, "utf8")).toMatch(/name: DAEB-1/);
  });

  it("preflights every suite sibling before the first write", () => {
    const root = freshRoot();
    const version = resolve(root, "ax-arena", "benchmark", "daeb", "v1");
    mkdirSync(version, { recursive: true });
    const outside = resolve(root, "outside.txt");
    writeFileSync(outside, "unchanged");
    symlinkSync(outside, resolve(version, "suite.synthesis.md"));

    expect(() => writeSuiteFiles(
      root,
      "ax-arena/benchmark/daeb/v1/suite.yaml",
      "suite",
      "synthesis",
    )).toThrow(/regular, single-link non-symlink/);
    expect(existsSync(resolve(version, "suite.yaml"))).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("unchanged");
  });

  it("does not create a support summary before rejecting a noncanonical artifact root", async () => {
    const root = freshRoot();
    const result = await synthesisFixture();
    const legacySuite = "benchmarks/daeb/v1/suite.yaml";

    expect(() => writeSuiteArtifacts(root, legacySuite, result))
      .toThrow(/writers use only the canonical benchmark root/);
    expect(existsSync(resolve(root, "benchmarks", "daeb", "v1", "suite.support-summary.md"))).toBe(false);
  });

  it("preflights every methodology artifact before writing any sibling", async () => {
    const root = freshRoot();
    const result = await synthesisFixture();
    const version = resolve(root, "ax-arena", "benchmark", "daeb", "v1");
    mkdirSync(version, { recursive: true });
    const outside = resolve(root, "outside.txt");
    writeFileSync(outside, "unchanged");
    symlinkSync(outside, resolve(version, "suite.support-summary.md"));

    expect(() => writeSuiteArtifacts(root, "ax-arena/benchmark/daeb/v1/suite.yaml", result))
      .toThrow(/regular, single-link non-symlink/);
    expect(existsSync(resolve(version, "suite.methodology.yaml"))).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("unchanged");
  });

  it("preflights the complete CLI bundle before replacing the suite pair", async () => {
    const root = freshRoot();
    const result = await synthesisFixture();
    const version = resolve(root, "ax-arena", "benchmark", "daeb", "v1");
    const suitePath = resolve(version, "suite.yaml");
    const synthesisPath = resolve(version, "suite.synthesis.md");
    mkdirSync(version, { recursive: true });
    writeFileSync(suitePath, "original suite");
    writeFileSync(synthesisPath, "original synthesis");
    const outside = resolve(root, "outside.txt");
    writeFileSync(outside, "unchanged");
    symlinkSync(outside, resolve(version, "suite.support-summary.md"));

    expect(() => writeSuiteBundle(
      root,
      "ax-arena/benchmark/daeb/v1/suite.yaml",
      "replacement suite",
      "replacement synthesis",
      result,
    )).toThrow(/regular, single-link non-symlink/);
    expect(readFileSync(suitePath, "utf8")).toBe("original suite");
    expect(readFileSync(synthesisPath, "utf8")).toBe("original synthesis");
    expect(readFileSync(outside, "utf8")).toBe("unchanged");
  });

  it("keeps audit autofixes canonical and preflights the notes sibling", () => {
    const root = freshRoot();
    const legacySuite = resolve(root, "benchmarks", "daeb", "v1", "suite.yaml");
    mkdirSync(resolve(legacySuite, ".."), { recursive: true });
    writeFileSync(legacySuite, "name: SUITE\nversion: 0\n");
    expect(() => applySuiteAudit(root, legacySuite, genericNameReport(legacySuite)))
      .toThrow(/writers use only the canonical benchmark root/);
    expect(readFileSync(legacySuite, "utf8")).toBe("name: SUITE\nversion: 0\n");

    const canonicalRoot = freshRoot();
    const canonicalSuite = resolve(canonicalRoot, "ax-arena", "benchmark", "daeb", "v1", "suite.yaml");
    mkdirSync(resolve(canonicalSuite, ".."), { recursive: true });
    writeFileSync(canonicalSuite, "name: SUITE\nversion: 0\n");
    const outside = resolve(canonicalRoot, "outside.txt");
    writeFileSync(outside, "unchanged");
    symlinkSync(outside, canonicalSuite.replace(/\.yaml$/, ".audit-notes.md"));

    expect(() => applySuiteAudit(canonicalRoot, canonicalSuite, genericNameReport(canonicalSuite)))
      .toThrow(/regular, single-link non-symlink/);
    expect(readFileSync(canonicalSuite, "utf8")).toBe("name: SUITE\nversion: 0\n");
    expect(readFileSync(outside, "utf8")).toBe("unchanged");
  });

  it("writes canonical audit fixes through the contained writer", () => {
    const root = freshRoot();
    const suitePath = resolve(root, "ax-arena", "benchmark", "daeb", "v1", "suite.yaml");
    mkdirSync(resolve(suitePath, ".."), { recursive: true });
    writeFileSync(suitePath, "name: SUITE\nversion: 0\n");

    const written = applySuiteAudit(root, suitePath, genericNameReport(suitePath));
    expect(written).toEqual([suitePath, suitePath.replace(/\.yaml$/, ".audit-notes.md")]);
    expect(readFileSync(suitePath, "utf8")).toMatch(/name: DAEB-1/);
    expect(readFileSync(written[1]!, "utf8")).toContain("Suite audit autofix notes");
  });
});
