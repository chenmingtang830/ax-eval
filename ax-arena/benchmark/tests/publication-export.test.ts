import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runArenaCli, type CliIo } from "../src/cli.js";
import { buildArenaPublicationExport } from "../src/publication/export.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CORE_CLI = resolve(REPOSITORY_ROOT, "src", "cli.ts");
const TSX_LOADER = fileURLToPath(import.meta.resolve("tsx"));
const GENERATED_AT = new Date("2026-07-21T00:00:00.000Z");

function writeJson(path: string, value: unknown): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function record(input: {
  product: string;
  surface: "api" | "cli";
  harness: "codex" | "claude-code";
  rate: number;
  generatedAt: string;
  summaryKind?: "single" | "aggregate";
}): Record<string, unknown> {
  return {
    schema: "ax.normalized-result/v1",
    surface: input.surface,
    product: input.product,
    harness: input.harness,
    standard_set_version: "DAEB-1-v1",
    generated_at: input.generatedAt,
    tasks_total: 10,
    tasks_passed: input.rate * 10,
    pass_at_1: input.rate,
    pass_at_k: input.rate,
    attempts: 1,
    discovery_score: null,
    content_quality: null,
    profiles: ["high"],
    best_profile: "high",
    model: input.harness === "codex" ? "gpt-5.6-terra" : "claude-sonnet-5",
    harness_version_semver: input.harness === "codex" ? "1.2.3" : "2.3.4",
    summary_kind: input.summaryKind ?? "aggregate",
    trial_count: 3,
    mean_pass_rate: input.rate,
    task_consistency_at_3: input.rate,
    pass_3_tasks: input.rate * 10,
    pass_3_tasks_total: 10,
  };
}

function createBundle(root: string): string {
  const bundle = resolve(root, "bundle");
  const files: Record<string, unknown> = {
    "records/alpha-api-single.json": record({
      product: "alpha", surface: "api", harness: "codex", rate: 1,
      generatedAt: "2026-07-21T00:00:00.000Z", summaryKind: "single",
    }),
    "records/alpha-api-aggregate.json": record({
      product: "alpha", surface: "api", harness: "codex", rate: 0.8,
      generatedAt: "2026-07-20T00:00:00.000Z",
    }),
    "records/alpha-cli-aggregate.json": record({
      product: "alpha", surface: "cli", harness: "codex", rate: 0.6,
      generatedAt: "2026-07-20T00:00:00.000Z",
    }),
    "records/alpha-claude-api.json": record({
      product: "alpha", surface: "api", harness: "claude-code", rate: 0.7,
      generatedAt: "2026-07-20T00:00:00.000Z",
    }),
    "records/beta-api-aggregate.json": record({
      product: "beta", surface: "api", harness: "codex", rate: 0.9,
      generatedAt: "2026-07-20T00:00:00.000Z",
    }),
    "records/beta-cli-aggregate.json": record({
      product: "beta", surface: "cli", harness: "codex", rate: 0.7,
      generatedAt: "2026-07-20T00:00:00.000Z",
    }),
  };
  for (const [path, value] of Object.entries(files)) writeJson(resolve(bundle, path), value);
  writeJson(resolve(bundle, "snapshots/alpha.json"), {
    runs: [{
      profile: "high",
      harness: "codex",
      surface: "api",
      model: "gpt-5.6-terra",
      outcomes: [
        { taskId: "db-create", success: true, status: "pass" },
        { taskId: "db-query", success: false, status: "fail" },
      ],
      evidence: { results: ["run.json"], trace: ["run.trace.json"], transcript: "run.jsonl" },
    }],
  });
  mkdirSync(resolve(bundle, "reports"), { recursive: true });
  writeFileSync(resolve(bundle, "reports/alpha.html"), "<html>alpha</html>\n");
  mkdirSync(resolve(bundle, "suite"), { recursive: true });
  writeFileSync(resolve(bundle, "suite/daeb-1.yaml"), "name: DAEB-1\nversion: 1\n");
  writeFileSync(resolve(bundle, "methodology.md"), "# Methodology\n");
  writeFileSync(resolve(bundle, "competitive.html"), "<html>competitive</html>\n");
  writeJson(resolve(bundle, "manifest.json"), {
    schema: "ax.publication-bundle/v2",
    benchmark: "DAEB-1",
    category: "database",
    suite: "suite/daeb-1.yaml",
    suite_version: 1,
    expected_matrix: {
      surfaces: ["api", "cli"],
      harnesses: ["codex", "claude-code"],
      effort_profiles: ["high"],
      required_effort_profiles: ["high"],
      expected_cells: 6,
    },
    quality_gates: [{ id: "records", label: "Records", status: "pass", detail: "complete" }],
    layers: {
      static_ax: { description: "static", methodology_artifacts: ["methodology.md"] },
      behavioral: { description: "behavioral", methodology_artifacts: ["methodology.md"] },
    },
    vendors: [
      {
        slug: "alpha",
        artifacts: {
          normalized_records: [
            "records/alpha-api-single.json",
            "records/alpha-api-aggregate.json",
            "records/alpha-cli-aggregate.json",
            "records/alpha-claude-api.json",
          ],
          snapshots: ["snapshots/alpha.json"],
          report_htmls: ["reports/alpha.html"],
        },
      },
      {
        slug: "beta",
        artifacts: {
          normalized_records: ["records/beta-api-aggregate.json", "records/beta-cli-aggregate.json"],
          snapshots: [],
          report_htmls: [],
        },
      },
    ],
    competitive_report: "competitive.html",
  });
  return bundle;
}

function parse(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function withoutGeneratedAt(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutGeneratedAt);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    key === "generated_at" ? "<generated>" : withoutGeneratedAt(child),
  ]));
}

describe("arena publication export", () => {
  it("writes all seven indexes with legacy semantic parity and deterministic time", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "ax-arena-export-"));
    try {
      createBundle(root);
      const manifest = buildArenaPublicationExport({
        root,
        bundleDir: "bundle",
        outDir: "arena-out",
        generatedAt: GENERATED_AT,
      });
      expect(manifest.files).toHaveLength(7);
      for (const file of manifest.files) expect(existsSync(resolve(root, "arena-out", file.path))).toBe(true);
      const leaderboard = parse(resolve(root, "arena-out/leaderboard.json"));
      const codex = leaderboard.agents.find((agent: { harness: string }) => agent.harness === "codex");
      expect(codex.views.overall.rows.map((row: { vendor: string }) => row.vendor)).toEqual(["beta", "alpha"]);
      expect(codex.views.overall.rows.find((row: { vendor: string }) => row.vendor === "alpha").mean_pass_at_1).toBe(0.7);
      expect(parse(resolve(root, "arena-out/failures.json")).failures[0].task_id).toBe("db-query");
      expect(parse(resolve(root, "arena-out/tasks.json")).tasks).toHaveLength(2);
      expect(parse(resolve(root, "arena-out/cells.json")).generated_at).toBe(GENERATED_AT.toISOString());

      execFileSync(process.execPath, [
        "--import", TSX_LOADER, CORE_CLI,
        "export-publication", "--from", "bundle", "--out", "core-out",
      ], { cwd: root, stdio: "pipe" });
      for (const name of [...manifest.files.map((file) => file.path), "manifest.json"]) {
        expect(withoutGeneratedAt(parse(resolve(root, "arena-out", name))))
          .toEqual(withoutGeneratedAt(parse(resolve(root, "core-out", name))));
      }

      const stdout: string[] = [];
      const stderr: string[] = [];
      const io: CliIo = { stdout: (message) => stdout.push(message), stderr: (message) => stderr.push(message) };
      await expect(runArenaCli([
        "benchmark", "export-publication",
        "--from", "bundle",
        "--out", "cli-out",
        "--generated-at", GENERATED_AT.toISOString(),
      ], io, root)).resolves.toBe(0);
      expect(stderr).toEqual([]);
      expect(stdout[2]).toBe("7 export file(s) for DAEB-1.");
      expect(parse(resolve(root, "cli-out/manifest.json")).generated_at).toBe(GENERATED_AT.toISOString());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects traversal and absolute artifact paths without partial output", () => {
    for (const malicious of ["../escape.json", resolve(tmpdir(), "escape.json")]) {
      const root = mkdtempSync(resolve(tmpdir(), "ax-arena-export-path-"));
      try {
        createBundle(root);
        const manifestPath = resolve(root, "bundle/manifest.json");
        const manifest = parse(manifestPath);
        manifest.vendors[0].artifacts.normalized_records[0] = malicious;
        writeJson(manifestPath, manifest);
        expect(() => buildArenaPublicationExport({ root, bundleDir: "bundle", outDir: "out" }))
          .toThrow(/canonical contained relative path|escapes/);
        expect(existsSync(resolve(root, "out"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("rejects symlinked and invalid inputs before writing output", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ax-arena-export-symlink-"));
    try {
      createBundle(root);
      const recordPath = resolve(root, "bundle/records/alpha-api-single.json");
      const targetPath = resolve(root, "record-target.json");
      writeFileSync(targetPath, readFileSync(recordPath));
      unlinkSync(recordPath);
      symlinkSync(targetPath, recordPath);
      expect(() => buildArenaPublicationExport({ root, bundleDir: "bundle", outDir: "symlink-out" }))
        .toThrow(/symlink/);
      expect(existsSync(resolve(root, "symlink-out"))).toBe(false);

      rmSync(resolve(root, "bundle"), { recursive: true, force: true });
      createBundle(root);
      writeFileSync(resolve(root, "bundle/snapshots/alpha.json"), "{");
      expect(() => buildArenaPublicationExport({ root, bundleDir: "bundle", outDir: "invalid-out" }))
        .toThrow(/not valid JSON/);
      expect(existsSync(resolve(root, "invalid-out"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects oversized JSON and unsafe output directories", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ax-arena-export-bounds-"));
    try {
      createBundle(root);
      truncateSync(resolve(root, "bundle/records/alpha-api-single.json"), 16 * 1024 * 1024 + 1);
      expect(() => buildArenaPublicationExport({ root, bundleDir: "bundle", outDir: "oversized-out" }))
        .toThrow(/16 MiB/);
      expect(existsSync(resolve(root, "oversized-out"))).toBe(false);

      rmSync(resolve(root, "bundle"), { recursive: true, force: true });
      createBundle(root);
      mkdirSync(resolve(root, "existing-out"));
      expect(() => buildArenaPublicationExport({ root, bundleDir: "bundle", outDir: "existing-out" }))
        .toThrow(/must not already exist/);
      expect(() => buildArenaPublicationExport({ root, bundleDir: "bundle", outDir: "bundle/output" }))
        .toThrow(/must not overlap/);
      expect(() => buildArenaPublicationExport({ root, bundleDir: "bundle", outDir: "../outside" }))
        .toThrow(/repository root/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
