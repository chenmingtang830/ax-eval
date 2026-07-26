import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  combinedResultPath,
  cleanupLowPassResults,
  daebFreshPackPath,
  daebVendorOrder,
  defaultLowPassRunRoot,
  lowPassSafetyIssues,
  loadLowPassResults,
  persistLowPassSurfaceOutcome,
  supportedLowPassSurfaces,
  upsertLowPassSurfaceRecord,
  writeFailureClassificationStub,
} from "../src/generate/low-pass.js";
import { GENERATED_REPORT_SNAPSHOT_SCHEMA, type GeneratedReportSnapshot } from "../src/generate/snapshot.js";
import { TargetPackSchema } from "../src/schemas.js";

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "ax-low-pass-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("daeb low-pass helpers", () => {
  it("returns the recommended DAEB vendor order", () => {
    expect(daebVendorOrder()).toEqual([
      "neon",
      "cockroachdb",
      "turso",
      "supabase",
      "insforge",
      "nile",
    ]);
  });

  it("filters to supported api/cli DAEB v1 surfaces with eligible tasks", () => {
    const pack = TargetPackSchema.parse({
      name: "demo",
      standard_set_version: "demo-v1",
      run_id: "gen",
      base_url: "https://api.example.test",
      surfaces: {
        cli: { bin: "democtl", auth: { kind: "token", token_env: "DEMO_TOKEN" } },
        sdk: { package: "@demo/sdk", auth: { kind: "token", token_env: "DEMO_TOKEN" } },
      },
      tasks: [
        { id: "api-task", difficulty: "L1", prompt: "api", allowed_surfaces: ["api"], oracles: [] },
        { id: "cli-task", difficulty: "L1", prompt: "cli", allowed_surfaces: ["cli"], oracles: [] },
        { id: "na-sdk", difficulty: "L1", prompt: "sdk", allowed_surfaces: [], oracles: [] },
      ],
    });
    expect(supportedLowPassSurfaces(pack)).toEqual(["api", "cli"]);
    expect(supportedLowPassSurfaces(pack, "cli")).toEqual(["cli"]);
    expect(supportedLowPassSurfaces(pack, undefined, ["api", "cli", "sdk"])).toEqual(["api", "cli"]);
  });

  it("computes the aggregated result path shape per surface", () => {
    expect(combinedResultPath("/tmp/demo", "codex", "low", "api")).toBe("/tmp/demo/run-codex-low.json");
    expect(combinedResultPath("/tmp/demo", "claude-code", "low", "sdk")).toBe("/tmp/demo/run-claude-code-low-sdk.json");
  });

  it("uses the dedicated DAEB low-pass run root when no explicit run-dir is provided", () => {
    expect(defaultLowPassRunRoot("/repo")).toBe("/repo/results/runs/daeb-low-pass");
    expect(defaultLowPassRunRoot("/repo", "results")).toBe("/repo/results/runs/daeb-low-pass");
    expect(defaultLowPassRunRoot("/repo", "tmp/custom-low-pass")).toBe("/repo/tmp/custom-low-pass");
  });

  it("derives a run-scoped fresh pack path for low-pass execution", () => {
    expect(daebFreshPackPath("/repo/results/runs/daeb-1-v3/low-pass", "convex", "/repo/ax-arena/benchmark/daeb/v1/suite.yaml"))
      .toBe("/repo/results/runs/daeb-1-v3/low-pass/convex/_compiled/suite.yaml");
  });

  it("halts a lane when invocation, result, cleanup, or verification safety is unconfirmed", () => {
    expect(lowPassSafetyIssues({
      invocationErrors: ["codex exited 1"],
      missingResultPaths: ["run-codex-medium.json"],
      cleanupSupported: false,
      cleanupMessage: "missing namespace",
      verifyError: "no snapshot",
      snapshotValid: false,
    })).toEqual([
      "invocation failed: codex exited 1",
      "missing result: run-codex-medium.json",
      "cleanup unconfirmed: missing namespace",
      "verification artifact invalid: no snapshot",
    ]);
    expect(lowPassSafetyIssues({
      invocationErrors: [],
      missingResultPaths: [],
      cleanupSupported: true,
      cleanupMessage: "deleted",
      snapshotValid: true,
    })).toEqual([]);
  });

  it("settles malformed results and reset failures instead of throwing before cleanup reporting", async () => {
    const loaded = loadLowPassResults(["valid.json", "malformed.json"], (path) => {
      if (path === "malformed.json") throw new Error("Unexpected end of JSON input");
      return { ns: "valid-ns" };
    });
    expect(loaded).toEqual([
      { path: "valid.json", result: { ns: "valid-ns" } },
      { path: "malformed.json", error: "Unexpected end of JSON input" },
    ]);

    const cleanup = await cleanupLowPassResults({
      loadedResults: loaded,
      missingResultPaths: ["missing.json"],
      skipReset: false,
      reset: async () => ({
        supported: true,
        message: "deleted valid-ns",
        deleted: ["one"],
        candidates: 1,
        errors: [],
      }),
    });
    expect(cleanup.performed).toBe(true);
    expect(cleanup.supported).toBe(false);
    expect(cleanup.message).toContain("deleted valid-ns");
    expect(cleanup.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("unreadable result malformed.json"),
      expect.stringContaining("missing result namespace for missing.json"),
    ]));
  });

  it("captures scope or reset exceptions and preserves explicit skip-reset behavior", async () => {
    const loaded = loadLowPassResults(["result.json"], () => ({ ns: "trial-ns" }));
    const failed = await cleanupLowPassResults({
      loadedResults: loaded,
      missingResultPaths: [],
      skipReset: false,
      reset: async () => { throw new Error("scope unavailable"); },
    });
    expect(failed.supported).toBe(false);
    expect(failed.errors).toEqual(["scope unavailable"]);

    const skipped = await cleanupLowPassResults({
      loadedResults: loaded,
      missingResultPaths: [],
      skipReset: true,
      reset: async () => { throw new Error("must not run"); },
    });
    expect(skipped).toEqual({ performed: false, supported: true, message: "skip-reset requested", errors: [] });
  });

  it("treats a loaded result without a namespace as unconfirmed cleanup", async () => {
    const cleanup = await cleanupLowPassResults({
      loadedResults: loadLowPassResults(["result.json"], () => ({})),
      missingResultPaths: [],
      skipReset: false,
      reset: async () => { throw new Error("must not run"); },
    });
    expect(cleanup.supported).toBe(false);
    expect(cleanup.errors).toEqual(["missing result namespace for result.json"]);
  });

  it("persists the surface manifest before returning corrupt-snapshot safety errors", () => {
    const dir = freshDir();
    const manifestPath = resolve(dir, "low-pass.manifest.json");
    const manifest = {
      schema: "ax.low-coverage-pass/v1" as const,
      suite: "/repo/ax-arena/benchmark/daeb/v1/suite.yaml",
      vendor: "neon",
      generated_at: "2026-07-17T00:00:00.000Z",
      harnesses: ["codex", "claude-code"],
      profile: "medium" as const,
      execution_mode: "task" as const,
      surfaces: [],
    };
    const record = {
      surface: "api" as const,
      run_dir: dir,
      result_paths: ["result.json"],
      html_report: "report.html",
      snapshot_path: "snapshot.json",
      classification_path: "failure-review.md",
      namespaces: ["trial-ns"],
      reset: { performed: true, supported: true, message: "deleted", errors: [] },
      verify_status: "failed" as const,
      verify_error: "snapshot unreadable",
    };
    const finalized = persistLowPassSurfaceOutcome({
      manifestPath,
      manifest,
      record,
      safety: {
        invocationErrors: [],
        missingResultPaths: [],
        cleanupSupported: true,
        cleanupMessage: "deleted",
        verifyError: "snapshot unreadable",
        snapshotValid: false,
      },
    });
    expect(JSON.parse(readFileSync(manifestPath, "utf8")).surfaces).toHaveLength(1);
    expect(finalized.unsafeReasons).toEqual(["verification artifact invalid: snapshot unreadable"]);
  });

  it("writes a human-review failure stub from a generated snapshot", () => {
    const dir = freshDir();
    const path = resolve(dir, "failure-review.md");
    const pack = TargetPackSchema.parse({
      name: "demo",
      standard_set_version: "demo-v1",
      run_id: "gen",
      base_url: "https://api.example.test",
      tasks: [
        { id: "t1", difficulty: "L1", prompt: "one", allowed_surfaces: ["api"], oracles: [] },
      ],
    });
    const snapshot: GeneratedReportSnapshot = {
      schema: GENERATED_REPORT_SNAPSHOT_SCHEMA,
      pack,
      harness: {
        host: "unknown",
        hostLabel: "Unknown",
        model: null,
        confidence: "none",
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        detectedAt: new Date().toISOString(),
        signals: [],
        suggestion: { profiles: ["medium"], matrix: false, reason: "test" },
      },
      warnings: [],
      runs: [
        {
          profile: "medium",
          harness: "codex",
          model: "gpt-5.5",
          surface: "api",
          outcomes: [
            {
              taskId: "t1",
              difficulty: "L1",
              profile: "medium",
              success: false,
              oracleResults: [{ type: "roundtrip", passed: false, detail: "no gid reported" }],
              error: "failed",
              na: false,
            },
          ],
          efficiency: { validity_status: "runtime_timeout_partial" },
          evidence: { results: ["run-codex-medium.json"], transcript: "run-codex-medium.transcript.jsonl" },
        },
      ],
    };
    writeFailureClassificationStub(snapshot, path, { vendor: "neon", surface: "api" });
    const text = readFileSync(path, "utf8");
    expect(text).toContain("vendor: neon");
    expect(text).toContain("validity_status: runtime_timeout_partial");
    expect(text).toContain("classification: agent-runtime-failure-needs-review");
    expect(text).toContain("t1");
    expect(text).toContain(path.replace("failure-review.md", "run-codex-medium.json"));
  });

  it("upserts medium-effort surface records without clobbering other surfaces", () => {
    const manifest = {
      schema: "ax.low-coverage-pass/v1" as const,
      suite: "/repo/ax-arena/benchmark/daeb/v1/suite.yaml",
      vendor: "neon",
      generated_at: "2026-07-04T00:00:00.000Z",
      harnesses: ["codex", "claude-code"],
      profile: "medium" as const,
      execution_mode: "task" as const,
      surfaces: [
        {
          surface: "cli" as const,
          run_dir: "/tmp/cli",
          result_paths: ["/tmp/cli/run.json"],
          html_report: "/tmp/cli/report.html",
          snapshot_path: "/tmp/cli/snapshot.json",
          classification_path: "/tmp/cli/failure-review.md",
          namespaces: ["cli-ns"],
        },
      ],
    };
    const next = upsertLowPassSurfaceRecord(manifest, {
      surface: "api",
      run_dir: "/tmp/api",
      result_paths: ["/tmp/api/run.json"],
      html_report: "/tmp/api/report.html",
      snapshot_path: "/tmp/api/snapshot.json",
      classification_path: "/tmp/api/failure-review.md",
      namespaces: ["api-ns"],
    });
    expect(next.surfaces.map((record) => record.surface)).toEqual(["api", "cli"]);

    const replaced = upsertLowPassSurfaceRecord(next, {
      surface: "cli",
      run_dir: "/tmp/cli-v2",
      result_paths: ["/tmp/cli-v2/run.json"],
      html_report: "/tmp/cli-v2/report.html",
      snapshot_path: "/tmp/cli-v2/snapshot.json",
      classification_path: "/tmp/cli-v2/failure-review.md",
      namespaces: ["cli-ns-2"],
    });
    expect(replaced.surfaces.map((record) => record.surface)).toEqual(["api", "cli"]);
    expect(replaced.surfaces.find((record) => record.surface === "cli")?.run_dir).toBe("/tmp/cli-v2");
  });
});
