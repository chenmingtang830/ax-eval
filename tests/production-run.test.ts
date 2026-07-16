import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultProductionRunRoot,
  loadNormalizedResult,
  productionAggregateDir,
  productionCellRoot,
  productionTrialDir,
  writeProductionAggregate,
} from "../src/generate/production-run.js";
import { NORMALIZED_RESULT_SCHEMA, type NormalizedResult } from "../src/generate/record.js";

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "ax-production-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function record(passAt1 = 1): NormalizedResult {
  return {
    schema: NORMALIZED_RESULT_SCHEMA,
    surface: "api",
    product: "acme",
    harness: "codex",
    standard_set_version: "suite-v1",
    generated_at: "2026-07-16T00:00:00.000Z",
    tasks_total: 2,
    tasks_passed: Math.round(passAt1 * 2),
    pass_at_1: passAt1,
    pass_at_k: passAt1,
    attempts: 1,
    discovery_score: null,
    content_quality: null,
    profiles: ["medium"],
    best_profile: "medium",
    model: "model-a",
    summary_kind: "single",
  };
}

function writeTrial(
  runRoot: string,
  trial: number,
  value = record(),
  cell: { vendor: string; surface: "api"; harness: string } = { vendor: "acme", surface: "api", harness: "codex" },
): { trial: number; normalized_record: string } {
  const dir = productionTrialDir(runRoot, cell.vendor, cell.surface, cell.harness, trial);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, "result.normalized.json");
  writeFileSync(path, JSON.stringify(value));
  return { trial, normalized_record: path };
}

describe("production artifact paths", () => {
  it("uses generic suite/vendor/surface/harness segments", () => {
    const root = freshDir();
    const runRoot = defaultProductionRunRoot(root, "suite-v1");
    expect(runRoot).toBe(resolve(root, "results", "runs", "suite-v1", "production"));
    expect(productionCellRoot(runRoot, "acme", "api", "codex")).toBe(resolve(runRoot, "acme", "api", "codex"));
    expect(productionTrialDir(runRoot, "acme", "api", "codex", 2)).toBe(resolve(runRoot, "acme", "api", "codex", "trial-2"));
    expect(productionAggregateDir(runRoot, "acme", "api", "codex")).toBe(resolve(runRoot, "acme", "api", "codex", "aggregate"));
  });

  it("rejects unsafe path segments and invalid trials", () => {
    const root = freshDir();
    expect(() => defaultProductionRunRoot(root, "../suite")).toThrow(/safe artifact/);
    expect(() => productionCellRoot(root, "../vendor", "api", "codex")).toThrow(/safe artifact/);
    expect(() => productionTrialDir(root, "acme", "api", "codex", 0)).toThrow(/positive integer/);
  });
});

describe("production aggregate writing", () => {
  it("writes an aggregate and manifest atomically", () => {
    const runRoot = freshDir();
    const trials = [
      writeTrial(runRoot, 1),
      writeTrial(runRoot, 2),
      writeTrial(runRoot, 3, record(0.5)),
    ];
    const manifest = writeProductionAggregate({
      runRoot,
      suiteName: "suite-v1",
      vendor: "acme",
      surface: "api",
      harness: "codex",
      trials,
      now: () => new Date("2026-07-16T12:00:00.000Z"),
    });

    const aggregatePath = resolve(runRoot, manifest.aggregate_record);
    const manifestPath = resolve(productionAggregateDir(runRoot, "acme", "api", "codex"), "aggregate-manifest.json");
    expect(existsSync(aggregatePath)).toBe(true);
    expect(existsSync(manifestPath)).toBe(true);
    expect(readdirSync(resolve(aggregatePath, "..")).some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(JSON.parse(readFileSync(aggregatePath, "utf8")).trial_values).toEqual([1, 1, 0.5]);
    expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toEqual(manifest);
    expect(manifest.generated_at).toBe("2026-07-16T12:00:00.000Z");
  });

  it("requires a complete, uniquely numbered trial cohort", () => {
    const runRoot = freshDir();
    const base = { runRoot, suiteName: "suite-v1", vendor: "acme", surface: "api" as const, harness: "codex" };
    expect(() => writeProductionAggregate({ ...base, trials: [] })).toThrow(/exactly 3/);
    expect(() => writeProductionAggregate({
      ...base,
      trials: [writeTrial(runRoot, 1), { ...writeTrial(runRoot, 2), trial: 1 }, writeTrial(runRoot, 3)],
    })).toThrow(/unique positive/);
    expect(() => writeProductionAggregate({
      ...base,
      trials: [writeTrial(runRoot, 1), writeTrial(runRoot, 2), { ...writeTrial(runRoot, 3), trial: 4 }],
    })).toThrow(/numbered 1 through 3/);
  });

  it("requires real source records inside the production run root", () => {
    const runRoot = freshDir();
    const outside = freshDir();
    const outsidePath = resolve(outside, "trial.normalized.json");
    writeFileSync(outsidePath, JSON.stringify(record()));
    const base = { runRoot, suiteName: "suite-v1", vendor: "acme", surface: "api" as const, harness: "codex" };
    expect(() => writeProductionAggregate({
      ...base,
      requiredTrialCount: 1,
      trials: [{ trial: 1, normalized_record: outsidePath }],
    })).toThrow(/inside its production trial directory/);
    expect(() => writeProductionAggregate({
      ...base,
      requiredTrialCount: 1,
      trials: [{ trial: 1, normalized_record: "missing.normalized.json" }],
    })).toThrow(/not found/);
  });

  it("rejects symlink escapes and records from the wrong trial directory", () => {
    const runRoot = freshDir();
    const outside = freshDir();
    const trialDir = productionTrialDir(runRoot, "acme", "api", "codex", 1);
    mkdirSync(trialDir, { recursive: true });
    const outsidePath = resolve(outside, "result.normalized.json");
    const linkedPath = resolve(trialDir, "result.normalized.json");
    writeFileSync(outsidePath, JSON.stringify(record()));
    symlinkSync(outsidePath, linkedPath);
    expect(() => writeProductionAggregate({
      runRoot,
      suiteName: "suite-v1",
      vendor: "acme",
      surface: "api",
      harness: "codex",
      requiredTrialCount: 1,
      trials: [{ trial: 1, normalized_record: linkedPath }],
    })).toThrow(/inside its production trial directory/);

    rmSync(linkedPath);
    const wrongTrial = writeTrial(runRoot, 2);
    expect(() => writeProductionAggregate({
      runRoot,
      suiteName: "suite-v1",
      vendor: "acme",
      surface: "api",
      harness: "codex",
      requiredTrialCount: 1,
      trials: [{ trial: 1, normalized_record: wrongTrial.normalized_record }],
    })).toThrow(/inside its production trial directory/);
  });

  it("binds manifest identity to the normalized records", () => {
    const runRoot = freshDir();
    const mismatchedVendor = writeTrial(runRoot, 1, record(), { vendor: "other", surface: "api", harness: "codex" });
    expect(() => writeProductionAggregate({
      runRoot,
      suiteName: "suite-v1",
      vendor: "other",
      surface: "api" as const,
      harness: "codex",
      requiredTrialCount: 1,
      trials: [mismatchedVendor],
    })).toThrow(/does not match record product/);

    const trial = writeTrial(runRoot, 1);
    expect(() => writeProductionAggregate({
      runRoot,
      suiteName: "suite-v2",
      vendor: "acme",
      surface: "api",
      harness: "codex",
      requiredTrialCount: 1,
      trials: [trial],
    })).toThrow(/does not match record standard_set_version/);
  });

  it("loads only normalized-result JSON", () => {
    const dir = freshDir();
    const valid = resolve(dir, "valid.json");
    const invalid = resolve(dir, "invalid.json");
    writeFileSync(valid, JSON.stringify(record()));
    writeFileSync(invalid, JSON.stringify({ schema: "other" }));
    expect(loadNormalizedResult(valid).product).toBe("acme");
    expect(() => loadNormalizedResult(invalid)).toThrow(/ax.normalized-result\/v1/);
    expect(() => loadNormalizedResult(resolve(dir, "missing.json"))).toThrow(/not found/);
  });
});
