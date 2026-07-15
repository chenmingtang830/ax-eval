import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify as yamlStringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { buildAxArenaExport, buildPublicationBundle } from "../src/generate/publication.js";
import { loadSuite, type Suite } from "../src/generate/suite.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const VENDORS = ["neon", "cockroachdb", "turso", "supabase", "insforge", "nile"];
const HARNESSES = ["codex", "claude-code"];
const SURFACES = ["api", "cli"];
const ARTIFACT_SUFFIXES = [
  "methodology",
  "concept-universe",
  "coverage-matrix",
  "selection-ledger",
  "support-matrix",
  "grader-ledger",
  "failure-taxonomy",
  "trace-review",
];

type FixtureOptions = {
  vendors?: string[];
  supportedSurfaces?: (vendor: string, taskId: string) => string[];
  success?: (vendor: string, taskId: string, surface: string, harness: string, trial: number) => boolean;
  discovery?: (vendor: string) => number;
  blockedCell?: { vendor: string; surface: string; harness: string; reason: "missing-credential" };
  missingTrial?: { vendor: string; surface: string; harness: string; trial: number };
  hiddenDebugRecord?: boolean;
};

describe("publication bundle and AXArena export", () => {
  const dirs: string[] = [];

  function freshDir(prefix: string): string {
    const dir = mkdtempSync(resolve(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  function write(path: string, value: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
  }

  function fixtureSuite(root: string): { suite: Suite; suitePath: string } {
    const source = loadSuite(resolve(REPO_ROOT, "targets/suites/daeb-1-v3.yaml"));
    const suite: Suite = {
      ...source,
      name: "DAEB-1",
      version: 1,
      description: "Seven core task publication fixture.",
      methodology: source.methodology ? {
        ...source.methodology,
        target_task_count: 7,
        surface_scope: ["api", "cli"],
      } : undefined,
      tasks: source.tasks.slice(0, 7),
    };
    const suitePath = "targets/suites/daeb-1.yaml";
    write(resolve(root, suitePath), yamlStringify(suite));
    for (const suffix of ARTIFACT_SUFFIXES) {
      write(resolve(root, `targets/suites/daeb-1.${suffix}.yaml`), `schema: fixture-${suffix}\n`);
    }
    return { suite, suitePath };
  }

  function aggregateRecord(args: {
    vendor: string;
    surface: string;
    harness: string;
    discovery: number;
    blocked?: string;
  }): Record<string, unknown> {
    return {
      schema: "ax.normalized-result/v1",
      surface: args.surface,
      product: args.vendor,
      harness: args.harness,
      standard_set_version: "DAEB-1-v1",
      generated_at: "2026-07-13T00:00:00.000Z",
      tasks_total: 7,
      tasks_passed: 5,
      pass_at_1: 5 / 7,
      pass_at_k: 5 / 7,
      attempts: 1,
      discovery_score: args.discovery,
      content_quality: 0.8,
      profiles: ["medium"],
      best_profile: "medium",
      model: args.harness === "codex" ? "gpt-5.4" : "sonnet",
      latency_ms: 1200,
      tool_call_count: 5,
      token_usage: { input: 100, output: 50 },
      token_cost: 0.12,
      validity_status: "valid",
      first_action_latency_ms: 100,
      transcript_event_count: 12,
      action_occurred: true,
      summary_kind: "aggregate",
      trial_count: 3,
      trial_values: [5 / 7, 5 / 7, 5 / 7],
      mean_pass_rate: 5 / 7,
      range_pass_rate: { min: 5 / 7, max: 5 / 7 },
      pass_hat_3: (5 / 7) ** 3,
      task_consistency_at_3: 5 / 7,
      pass_all_3: 0,
      source_records: ["trial-1.json", "trial-2.json", "trial-3.json"],
      ...(args.blocked ? { blocked: args.blocked } : {}),
    };
  }

  function createFixture(options: FixtureOptions = {}): {
    root: string;
    suite: Suite;
    suitePath: string;
    runDir: string;
    bundleDir: string;
    exportDir: string;
    vendors: string[];
  } {
    const root = freshDir("ax-publication-fixture-");
    const { suite, suitePath } = fixtureSuite(root);
    const vendors = options.vendors ?? VENDORS;
    const runDir = "results/production";
    const bundleDir = "results/publication-bundle";
    const exportDir = "results/axarena-export";
    const supportedSurfaces = options.supportedSurfaces ?? (() => [...SURFACES]);
    const success = options.success ?? ((vendor, taskId, surface, harness, trial) =>
      (vendors.indexOf(vendor) + suite.tasks.indexOf(suite.tasks.find((task) => task.id === taskId)!) +
        SURFACES.indexOf(surface) + HARNESSES.indexOf(harness) + trial) % 4 !== 0);

    for (const vendor of vendors) {
      const packTasks = suite.tasks.map((task) => {
        const allowed = supportedSurfaces(vendor, task.id);
        return {
          id: task.id,
          title: task.title,
          prompt: task.intent,
          difficulty: task.difficulty,
          allowed_surfaces: allowed,
          na: allowed.length === 0,
          oracles: allowed.length ? [{ type: "roundtrip", expected: 1, description: "fixture verifier" }] : [],
        };
      });
      write(resolve(root, `targets/vendors/${vendor}.discovered.yaml`), `name: ${vendor}\nslug: ${vendor}\n`);
      write(resolve(root, `targets/extracts/${vendor}/daeb-1.yaml`), `vendor: ${vendor}\n`);
      write(resolve(root, `targets/packs/${vendor}/daeb-1.yaml`), yamlStringify({
        name: vendor,
        version: "1",
        standard_set_version: "DAEB-1-v1",
        run_id: "fixture",
        generated_by: "deterministic@no-model",
        auth_method: "none",
        base_url: `https://${vendor}.example`,
        tasks: packTasks,
      }));
      write(resolve(root, `targets/packs/${vendor}/daeb-1.approval.json`), JSON.stringify({ approved: true }));

      for (const surface of SURFACES) {
        for (const harness of HARNESSES) {
          const aggregateDir = resolve(root, runDir, vendor, surface, harness, "aggregate");
          const blocked = options.blockedCell?.vendor === vendor && options.blockedCell.surface === surface && options.blockedCell.harness === harness
            ? options.blockedCell.reason
            : undefined;
          write(resolve(aggregateDir, `${harness}.${surface}.aggregate.normalized.json`), JSON.stringify(aggregateRecord({
            vendor,
            surface,
            harness,
            discovery: options.discovery?.(vendor) ?? 0.75,
            blocked,
          }), null, 2));
          for (let trial = 1; trial <= 3; trial++) {
            if (options.missingTrial?.vendor === vendor && options.missingTrial.surface === surface &&
              options.missingTrial.harness === harness && options.missingTrial.trial === trial) continue;
            const trialDir = resolve(root, runDir, vendor, surface, harness, `trial-${trial}`);
            const outcomes = suite.tasks.map((task) => {
              const supported = supportedSurfaces(vendor, task.id).includes(surface);
              return {
                taskId: task.id,
                success: supported ? success(vendor, task.id, surface, harness, trial) : false,
                na: !supported,
                status: supported ? "scored" : "na",
              };
            });
            write(resolve(trialDir, "generated-eval.snapshot.json"), JSON.stringify({
              runs: [{ profile: "medium", harness, surface, model: harness === "codex" ? "gpt-5.4" : "sonnet", outcomes }],
            }, null, 2));
            write(resolve(trialDir, "generated-eval.html"), "<html><body>fixture report</body></html>\n");
          }
        }
      }
      if (options.hiddenDebugRecord) {
        write(resolve(root, runDir, vendor, "api", "codex", "trial-1", ".invoke-home", "debug.normalized.json"), JSON.stringify(
          aggregateRecord({ vendor, surface: "api", harness: "codex", discovery: 0 }),
        ));
      }
    }
    write(resolve(root, runDir, "competitive.html"), "<html><body>competitive fixture</body></html>\n");
    return { root, suite, suitePath, runDir, bundleDir, exportDir, vendors };
  }

  function buildFixture(options: FixtureOptions = {}) {
    const fixture = createFixture(options);
    const bundle = buildPublicationBundle({
      root: fixture.root,
      suite: fixture.suite,
      suitePath: fixture.suitePath,
      vendors: fixture.vendors,
      runDir: fixture.runDir,
      outDir: fixture.bundleDir,
      effortProfiles: ["medium"],
      requiredEffortProfiles: ["medium"],
      requiredTrialCount: 3,
    });
    return { fixture, bundle };
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("freezes a publication-ready six-vendor, seven-core-task production bundle", () => {
    const { bundle } = buildFixture();
    expect(bundle.publication_readiness).toBe("publication_ready");
    expect(bundle.vendors).toHaveLength(6);
    expect(bundle.expected_matrix).toMatchObject({
      surfaces: ["api", "cli"],
      harnesses: ["codex", "claude-code"],
      effort_profiles: ["medium"],
      required_effort_profiles: ["medium"],
      required_trial_count: 3,
    });
    expect(bundle.quality_gates.find((gate) => gate.id === "rankability")?.status).toBe("pass");
  });

  it("uses aggregate records and ignores harness-home debug artifacts", () => {
    const { bundle } = buildFixture({ hiddenDebugRecord: true });
    expect(bundle.publication_readiness).toBe("publication_ready");
    expect(bundle.vendors.flatMap((vendor) => vendor.artifacts.normalized_records).every((path) => path.includes("aggregate"))).toBe(true);
    expect(bundle.vendors.flatMap((vendor) => vendor.artifacts.normalized_records).some((path) => path.includes(".invoke-home"))).toBe(false);
  });

  it("keeps blocked or non-three-trial cells in draft", () => {
    const { bundle } = buildFixture({ blockedCell: { vendor: "neon", surface: "api", harness: "codex", reason: "missing-credential" } });
    expect(bundle.publication_readiness).toBe("draft");
    expect(bundle.quality_gates.find((gate) => gate.id === "rankability")?.status).toBe("fail");
  });

  it("exports v2 website data and ranks only the shared task-surface intersection", () => {
    const { fixture } = buildFixture({
      vendors: ["alpha", "beta", "gamma"],
      supportedSurfaces: (vendor, taskId) => vendor === "gamma" && taskId.endsWith("backup-and-restore") ? ["api"] : ["api", "cli"],
      success: (vendor, _taskId, _surface, _harness, trial) => vendor === "alpha" || (vendor === "beta" && trial < 3),
      discovery: (vendor) => vendor === "beta" ? 1 : 0.25,
    });
    const manifest = buildAxArenaExport({ root: fixture.root, bundleDir: fixture.bundleDir, outDir: fixture.exportDir });
    expect(manifest.schema).toBe("ax.axarena-export/v2");
    for (const file of manifest.files) expect(existsSync(resolve(fixture.root, fixture.exportDir, file.path))).toBe(true);

    const root = resolve(fixture.root, fixture.exportDir);
    const publication = JSON.parse(readFileSync(resolve(root, "publication.json"), "utf8"));
    const leaderboard = JSON.parse(readFileSync(resolve(root, "leaderboard.json"), "utf8"));
    const cells = JSON.parse(readFileSync(resolve(root, "cells.json"), "utf8"));
    const tasks = JSON.parse(readFileSync(resolve(root, "tasks.json"), "utf8"));
    expect(publication.schema).toBe("ax.axarena-publication/v1");
    expect(publication).toMatchObject({ benchmark: "axarena-database", display_name: "AXArena Database" });
    expect(manifest.benchmark).toBe("axarena-database");
    expect(leaderboard.schema).toBe("ax.axarena-leaderboard/v2");
    expect(leaderboard.benchmark).toBe("axarena-database");
    expect(leaderboard.ranking_method.discovery_affects_rank).toBe(false);
    expect(leaderboard.rows.map((row: { vendor: string }) => row.vendor)).toEqual(["alpha", "beta", "gamma"]);
    expect(leaderboard.rows[0]).toMatchObject({ rank: 1, intersection_score: 1, intersection_consistency_at_3: 1 });
    expect(leaderboard.rows[1].rank).toBe(2);
    expect(leaderboard.rows[1].discovery_score).toBe(1);
    expect(leaderboard.rows[2].applicability_coverage).toBeLessThan(1);
    expect(cells.schema).toBe("ax.axarena-cells/v2");
    expect(cells.cells[0]).toHaveProperty("task_consistency_at_3");
    expect(tasks.schema).toBe("ax.axarena-tasks/v2");
    expect(tasks.tasks).toHaveLength(7);
    expect(tasks.tasks.every((task: { kind: string }) => task.kind === "core")).toBe(true);
  });

  it("shares ranks on exact score and reliability ties regardless of discovery", () => {
    const { fixture } = buildFixture({
      vendors: ["alpha", "beta"],
      success: () => true,
      discovery: (vendor) => vendor === "alpha" ? 0 : 1,
    });
    buildAxArenaExport({ root: fixture.root, bundleDir: fixture.bundleDir, outDir: fixture.exportDir });
    const leaderboard = JSON.parse(readFileSync(resolve(fixture.root, fixture.exportDir, "leaderboard.json"), "utf8"));
    expect(leaderboard.rows.map((row: { rank: number }) => row.rank)).toEqual([1, 1]);
    expect(leaderboard.rows.map((row: { vendor: string }) => row.vendor)).toEqual(["alpha", "beta"]);
  });

  it("marks missing trial evidence incomplete and emits no rank for an empty intersection", () => {
    const incomplete = buildFixture({
      vendors: ["alpha", "beta"],
      missingTrial: { vendor: "alpha", surface: "api", harness: "codex", trial: 2 },
    }).fixture;
    buildAxArenaExport({ root: incomplete.root, bundleDir: incomplete.bundleDir, outDir: incomplete.exportDir });
    const incompleteLeaderboard = JSON.parse(readFileSync(resolve(incomplete.root, incomplete.exportDir, "leaderboard.json"), "utf8"));
    const incompletePublication = JSON.parse(readFileSync(resolve(incomplete.root, incomplete.exportDir, "publication.json"), "utf8"));
    expect(incompleteLeaderboard.rows.find((row: { vendor: string }) => row.vendor === "alpha")).toMatchObject({ rank: null, status: "incomplete" });
    expect(incompletePublication.publication_readiness).toBe("draft");

    const empty = buildFixture({
      vendors: ["one", "two"],
      supportedSurfaces: (vendor, taskId) => {
        const first = taskId.endsWith("access-control");
        return vendor === "one" ? (first ? ["api"] : []) : (!first ? ["cli"] : []);
      },
    }).fixture;
    buildAxArenaExport({ root: empty.root, bundleDir: empty.bundleDir, outDir: empty.exportDir });
    const emptyLeaderboard = JSON.parse(readFileSync(resolve(empty.root, empty.exportDir, "leaderboard.json"), "utf8"));
    expect(emptyLeaderboard.ranking_method.intersection_pairs).toEqual([]);
    expect(emptyLeaderboard.rows.every((row: { rank: number | null; status: string }) => row.rank === null && row.status === "not_comparable")).toBe(true);
  });
});
