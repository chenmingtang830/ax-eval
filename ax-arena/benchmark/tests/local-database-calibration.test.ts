import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LOCAL_DATABASE_CALIBRATION_SCHEMA,
  buildLocalDatabaseCalibrationManifest,
  exportLocalDatabaseCalibration,
  localDatabaseCalibrationCellKeys,
} from "../src/local-database-calibration.js";

describe("local database calibration export", () => {
  it("derives the exact 24-cell display matrix", () => {
    const keys = localDatabaseCalibrationCellKeys();
    expect(keys).toHaveLength(24);
    expect(keys.filter((key) => key.startsWith("supabase/api/")).length).toBe(2);
  });

  it("keeps local metadata and the full 24-cell display ledger", () => {
    const cells = Array.from({ length: 24 }, (_, index) => ({
      key: `vendor-${index}/api/codex/trial-1`,
      vendor: `vendor-${index}`,
      surface: "api" as const,
      harness: "codex" as const,
      model: "gpt-5.6-terra",
      trial: 1 as const,
      profile: "medium" as const,
      status: index === 0 ? "structural_na" as const : "completed" as const,
      tasks_total: index === 0 ? null : 1,
      tasks_passed: index === 0 ? null : 1,
      pass_at_1: index === 0 ? null : 1,
      total_duration_ms: index === 0 ? null : 10,
      cost_usd: null,
      cost_status: index === 0 ? "not_applicable" as const : "unknown" as const,
      cleanup_status: index === 0 ? "not_run" : "confirmed",
      reason: index === 0 ? "admitted provisioning blocker" : null,
      record_path: null,
      cleanup_path: null,
      evidence: null,
      task_results: [],
    }));
    const manifest = buildLocalDatabaseCalibrationManifest({
      sourceCommitSha: "a".repeat(40),
      generatedAt: "2026-08-10T00:00:00.000Z",
      budgetUsd: 50,
      cells,
      measuredCostUsd: 0,
    });
    expect(manifest.schema).toBe(LOCAL_DATABASE_CALIBRATION_SCHEMA);
    expect(manifest.publication_eligible).toBe(false);
    expect(manifest.trial_count).toBe(1);
    expect(manifest.profile).toBe("medium");
    expect(manifest.cells).toHaveLength(24);
    expect(manifest.cells.filter((cell) => cell.status === "structural_na")).toHaveLength(1);
  });

  it("rejects credential values in the sanitized export", () => {
    const root = mkdtempSync(resolve(tmpdir(), "axarena-local-export-"));
    try {
      const manifest = buildLocalDatabaseCalibrationManifest({
        sourceCommitSha: "b".repeat(40), generatedAt: "2026-08-10T00:00:00.000Z", budgetUsd: 50,
        cells: [], measuredCostUsd: 0,
      });
      expect(() => exportLocalDatabaseCalibration({
        root, exportDir: resolve(root, "export"), manifest,
        credentials: { OPENAI_API_KEY: "do-not-write-this" },
      })).not.toThrow();
      const output = readFileSync(resolve(root, "export/database-v1.json"), "utf8");
      expect(output).not.toContain("do-not-write-this");
      expect(existsSync(resolve(root, "export/database-v1.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
