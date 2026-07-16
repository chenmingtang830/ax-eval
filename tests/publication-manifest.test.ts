import { describe, expect, it } from "vitest";
import { buildPublicationManifest } from "../src/generate/publication-manifest.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function completeManifest() {
  return buildPublicationManifest({
    benchmark: "Database Suite",
    category: "database",
    suiteVersion: 1,
    standardSetVersion: "suite-v1",
    vendors: [
      { vendor: "acme", surfaces: ["api", "cli"] },
      { vendor: "beta", surfaces: ["api"] },
    ],
    harnesses: ["codex", "claude-code"],
    requiredProfiles: ["medium"],
    requiredTrialCount: 3,
    artifacts: [
      { id: "suite", path: "suite/database.yaml", sha256: SHA_A, required: true },
      { id: "methodology", path: "suite/methodology.md", sha256: SHA_B, required: true },
      { id: "notes", required: false },
    ],
    cells: [
      { vendor: "beta", surface: "api", harness: "codex", profiles: ["medium"], trial_count: 3, aggregate_record: "vendors/beta/api/codex.json", aggregate_sha256: SHA_A },
      { vendor: "acme", surface: "cli", harness: "claude-code", profiles: ["medium"], trial_count: 3, aggregate_record: "vendors/acme/cli/claude-code.json", aggregate_sha256: SHA_A },
      { vendor: "acme", surface: "api", harness: "codex", profiles: ["medium"], trial_count: 3, aggregate_record: "vendors/acme/api/codex.json", aggregate_sha256: SHA_A },
      { vendor: "beta", surface: "api", harness: "claude-code", profiles: ["medium"], trial_count: 3, aggregate_record: "vendors/beta/api/claude-code.json", aggregate_sha256: SHA_A },
      { vendor: "acme", surface: "cli", harness: "codex", profiles: ["medium"], trial_count: 3, aggregate_record: "vendors/acme/cli/codex.json", aggregate_sha256: SHA_A },
      { vendor: "acme", surface: "api", harness: "claude-code", profiles: ["medium"], trial_count: 3, aggregate_record: "vendors/acme/api/claude-code.json", aggregate_sha256: SHA_A },
    ],
    now: () => new Date("2026-07-16T12:00:00.000Z"),
  });
}

describe("buildPublicationManifest", () => {
  it("builds a deterministic publication-ready manifest", () => {
    const manifest = completeManifest();
    expect(manifest.generated_at).toBe("2026-07-16T12:00:00.000Z");
    expect(manifest.publication_readiness).toBe("publication_ready");
    expect(manifest.schema).toBe("ax.publication-manifest/v2");
    expect(manifest.expected_matrix.expected_cells).toBe(6);
    expect(manifest.quality_gates.every((gate) => gate.status === "pass")).toBe(true);
    expect(manifest.cells.map((cell) => `${cell.vendor}/${cell.surface}/${cell.harness}`)).toEqual([
      "acme/api/claude-code",
      "acme/api/codex",
      "acme/cli/claude-code",
      "acme/cli/codex",
      "beta/api/claude-code",
      "beta/api/codex",
    ]);
  });

  it("keeps incomplete publication inputs as an explainable draft", () => {
    const manifest = buildPublicationManifest({
      benchmark: "Database Suite",
      category: "database",
      suiteVersion: 1,
      standardSetVersion: "suite-v1",
      vendors: [{ vendor: "acme", surfaces: ["api"] }],
      harnesses: ["codex", "claude-code"],
      requiredProfiles: ["medium"],
      requiredTrialCount: 3,
      artifacts: [
        { id: "suite", required: true },
        { id: "notes", required: false },
      ],
      cells: [
        { vendor: "acme", surface: "api", harness: "codex", profiles: ["low"], trial_count: 2, aggregate_record: "vendors/acme/api/codex.json" },
      ],
      now: () => new Date("2026-07-16T12:00:00.000Z"),
    });

    expect(manifest.publication_readiness).toBe("draft");
    expect(manifest.missing_required_artifacts).toEqual(["suite"]);
    expect(manifest.quality_gates).toEqual([
      expect.objectContaining({ id: "required-artifacts", status: "fail" }),
      expect.objectContaining({ id: "content-digests", status: "fail" }),
      expect.objectContaining({ id: "expected-matrix", status: "fail", detail: expect.stringContaining("acme/api/claude-code") }),
      expect.objectContaining({ id: "required-profiles", status: "fail" }),
      expect.objectContaining({ id: "required-trials", status: "fail" }),
    ]);
  });

  it("rejects duplicate, unexpected, and unsafe inputs", () => {
    const base = {
      benchmark: "Database Suite",
      category: "database",
      suiteVersion: 1,
      standardSetVersion: "suite-v1",
      vendors: [{ vendor: "acme", surfaces: ["api" as const] }],
      harnesses: ["codex"],
      requiredProfiles: ["medium"],
      requiredTrialCount: 3,
      artifacts: [{ id: "suite", path: "suite/database.yaml", sha256: SHA_A, required: true }],
      cells: [{ vendor: "acme", surface: "api" as const, harness: "codex", profiles: ["medium"], trial_count: 3, aggregate_record: "vendors/acme/api/codex.json", aggregate_sha256: SHA_A }],
    };
    expect(() => buildPublicationManifest({ ...base, harnesses: ["codex", "codex"] })).toThrow(/harness values must be unique/);
    expect(() => buildPublicationManifest({ ...base, artifacts: [{ id: "suite", path: "../suite.yaml", required: true }] })).toThrow(/portable relative path/);
    expect(() => buildPublicationManifest({ ...base, artifacts: [{ id: "suite", path: "suite.yaml", sha256: "bad", required: true }] })).toThrow(/SHA-256/);
    expect(() => buildPublicationManifest({ ...base, artifacts: [{ id: "suite", sha256: SHA_A, required: true }] })).toThrow(/requires a path/);
    expect(() => buildPublicationManifest({ ...base, cells: [...base.cells, ...base.cells] })).toThrow(/appears more than once/);
    expect(() => buildPublicationManifest({
      ...base,
      cells: [{ ...base.cells[0]!, harness: "other" }],
    })).toThrow(/not in the expected matrix/);
    expect(() => buildPublicationManifest({
      ...base,
      vendors: [{ vendor: "acme", surfaces: ["web" as "api"] }],
    })).toThrow(/invalid surface/);
  });
});
