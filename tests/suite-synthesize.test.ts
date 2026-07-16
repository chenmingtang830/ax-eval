import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ConceptUniverse, CoverageSelection } from "../src/generate/coverage.js";
import { defaultSuiteMethodology } from "../src/generate/suite-methodology.js";
import { loadSynthesizedSuite, synthesizeSuite, writeSynthesizedSuite } from "../src/generate/suite-synthesize.js";

const universe: ConceptUniverse = {
  category: "database",
  generated_at: "2026-01-01T00:00:00.000Z",
  method: "deterministic",
  vendor_count: 2,
  members: [{
    member_id: "alpha:create-table",
    vendor: "AlphaDB",
    slug: "alpha",
    capability_name: "create-table",
    title: "Create table",
    family: "data-definition",
    description: "Create a table.",
    evidence_urls: ["https://docs.alpha.example/tables"],
  }, {
    member_id: "beta:create-table",
    vendor: "BetaDB",
    slug: "beta",
    capability_name: "create-table",
    title: "Create table",
    family: "data-definition",
    description: "Create a table.",
    evidence_urls: ["https://docs.beta.example/tables"],
  }, {
    member_id: "alpha:filtered-read",
    vendor: "AlphaDB",
    slug: "alpha",
    capability_name: "filtered-read",
    title: "Filtered read",
    family: "reads",
    description: "Filter records.",
    evidence_urls: ["https://docs.alpha.example/queries"],
  }, {
    member_id: "beta:filtered-read",
    vendor: "BetaDB",
    slug: "beta",
    capability_name: "filtered-read",
    title: "Filtered read",
    family: "reads",
    description: "Filter records.",
    evidence_urls: ["https://docs.beta.example/queries"],
  }],
  clusters: [{
    concept_name: "create-table",
    title: "Create table",
    skill: "create-table",
    family: "data-definition",
    member_ids: ["alpha:create-table", "beta:create-table"],
    vendor_coverage: 1,
  }, {
    concept_name: "filtered-read",
    title: "Filtered read",
    skill: "filtered-read",
    family: "reads",
    member_ids: ["alpha:filtered-read", "beta:filtered-read"],
    vendor_coverage: 1,
  }],
};

const selection: CoverageSelection = {
  category: "database",
  generated_at: "2026-01-02T00:00:00.000Z",
  target_task_count: 2,
  selected: [{
    concept_name: "create-table",
    title: "Create table",
    skill: "create-table",
    family: "data-definition",
    vendor_coverage: 1,
    rationale: "Covered.",
  }, {
    concept_name: "filtered-read",
    title: "Filtered read",
    skill: "filtered-read",
    family: "reads",
    vendor_coverage: 1,
    rationale: "Covered.",
  }],
  excluded: [],
};

describe("suite synthesis", () => {
  it("builds deterministic vendor-neutral database tasks", async () => {
    const methodology = defaultSuiteMethodology("database", 2);
    const suite = await synthesizeSuite("daeb-1-v3", 3, "database", universe, selection, methodology);
    expect(suite.tasks.map((task) => task.id)).toEqual([
      "db-T01-create-table",
      "db-T02-filtered-read",
    ]);
    expect(suite.tasks.map((task) => task.skill)).toEqual(["create-table", "filtered-read"]);
    expect(suite.tasks.every((task) => task.intent.includes("{ns}"))).toBe(true);
    expect(suite.tasks.every((task) => task.allowed_surfaces.join(",") === "api,cli")).toBe(true);
  });

  it("uses the reviewed concept skill independently from its family", async () => {
    const independentUniverse: ConceptUniverse = {
      ...universe,
      clusters: universe.clusters.map((cluster, index) => index === 0
        ? { ...cluster, skill: "schema-authoring" }
        : cluster),
    };
    const independentSelection: CoverageSelection = {
      ...selection,
      selected: selection.selected.map((concept, index) => index === 0
        ? { ...concept, skill: "schema-authoring" }
        : concept),
    };
    const suite = await synthesizeSuite(
      "daeb-1-v3",
      3,
      "database",
      independentUniverse,
      independentSelection,
      defaultSuiteMethodology("database", 2),
    );

    expect(suite.tasks[0]!.skill).toBe("schema-authoring");
    expect(suite.tasks[0]!.skill).not.toBe(independentSelection.selected[0]!.family);
  });

  it("requires generated drafts to cover the exact selected concepts", async () => {
    const methodology = defaultSuiteMethodology("database", 2);
    await expect(synthesizeSuite("daeb-1-v3", 3, "database", universe, selection, methodology, {
      generate: async () => JSON.stringify({
        tasks: [{
          concept_name: "create-table",
          difficulty: "L1",
          intent: "Create ax_items_{ns}.",
          oracle_hint: "Read live schema metadata.",
          na_examples: [],
        }],
      }),
    })).rejects.toThrow(/omitted concepts/);
  });

  it("rejects embedded credential material in generated task text", async () => {
    const methodology = defaultSuiteMethodology("database", 2);
    const credential = ["Bearer", "abcdefghijklmnopqrstuvwxyz123456"].join(" ");
    await expect(synthesizeSuite("daeb-1-v3", 3, "database", universe, selection, methodology, {
      generate: async () => JSON.stringify({
        tasks: selection.selected.map((concept) => ({
          concept_name: concept.concept_name,
          difficulty: "L1",
          intent: `Create ax_items_{ns} using ${credential}.`,
          oracle_hint: "Read live state and assert the result.",
          na_examples: [],
        })),
      }),
    })).rejects.toThrow(/credential material/);
  });

  it("rejects vendor-specific canonical task text", async () => {
    const methodology = defaultSuiteMethodology("database", 2);
    await expect(synthesizeSuite("daeb-1-v3", 3, "database", universe, selection, methodology, {
      generate: async () => JSON.stringify({
        tasks: selection.selected.map((concept) => ({
          concept_name: concept.concept_name,
          difficulty: "L1",
          intent: `Use AlphaDB to create ax_items_{ns}.`,
          oracle_hint: "Read live state and assert the result.",
          na_examples: [],
        })),
      }),
    })).rejects.toThrow(/names vendor alphadb/);
  });

  it("writes and reloads a schema-valid canonical suite", async () => {
    const suite = await synthesizeSuite(
      "daeb-1-v3",
      3,
      "database",
      universe,
      selection,
      defaultSuiteMethodology("database", 2),
    );
    const root = mkdtempSync(join(tmpdir(), "ax-eval-suite-synthesis-"));
    try {
      writeSynthesizedSuite(root, suite);
      expect(loadSynthesizedSuite(root, suite.name)).toEqual(suite);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
