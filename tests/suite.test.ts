import { describe, expect, it } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadSuite, suitePromptFragment, validatePackAgainstSuite } from "../src/generate/suite.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DAEB1 = resolve(ROOT, "benchmarks", "daeb", "v1", "suite.yaml");

describe("canonical task suite", () => {
  it("loads and validates the shipped DAEB-1 suite", () => {
    const suite = loadSuite(DAEB1);
    expect(suite.name).toBe("DAEB-1");
    expect(suite.version).toBe(1);
    expect(suite.category).toBe("database");
    expect(suite.tasks).toHaveLength(10);
    expect(suite.methodology?.surface_scope).toEqual(["api", "cli"]);
    for (const task of suite.tasks) {
      expect(task.id).toMatch(/^db-T\d{2}-/);
      expect(["L1", "L2", "L3", "L4"]).toContain(task.difficulty);
      expect(task.allowed_surfaces).toEqual(["api", "cli"]);
      expect(task.allowed_surfaces).not.toContain("sdk");
      expect(task.allowed_surfaces).not.toContain("mcp");
      expect(task.intent.length).toBeGreaterThan(20);
      expect(task.oracle_hint.length).toBeGreaterThan(10);
    }
  });

  it("labels active suite sibling artifacts as DAEB-1 rather than SUITE", () => {
    for (const suffix of [
      "selection-ledger.yaml",
      "support-matrix.yaml",
      "grader-ledger.yaml",
      "failure-taxonomy.yaml",
      "trace-review.yaml",
    ]) {
      expect(readFileSync(resolve(ROOT, "benchmarks", "daeb", "v1", `suite.${suffix}`), "utf8"))
        .toMatch(/^benchmark: DAEB-1$/m);
    }
  });

  it("rejects a malformed suite", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "axarena-suite-"));
    const path = resolve(dir, "bad.yaml");
    writeFileSync(path, "name: bad\nversion: 1\ncategory: x\ntasks: []\n");
    expect(() => loadSuite(path)).toThrow(/Invalid suite/);
  });

  it("renders a prompt fragment that names every task id", () => {
    const suite = loadSuite(DAEB1);
    const fragment = suitePromptFragment(suite);
    expect(fragment).toMatch(/DAEB-1/);
    for (const task of suite.tasks) {
      expect(fragment).toContain(task.id);
      expect(fragment).toContain(task.difficulty);
    }
    expect(fragment).toMatch(/HARD OVERRIDE/);
    // Docs-only generate relies on this instruction so the LLM goes hunting
    // when the seed lacks resources.
    expect(fragment).toMatch(/WEB SEARCH AND WEB FETCH/);
  });

  it("validation passes when pack matches the suite exactly", () => {
    const suite = loadSuite(DAEB1);
    const matching = suite.tasks.map((t) => ({ id: t.id, title: t.title, difficulty: t.difficulty }));
    expect(validatePackAgainstSuite(matching, suite)).toEqual([]);
  });

  it("validation catches missing, extra, and divergent tasks", () => {
    const suite = loadSuite(DAEB1);
    const first = suite.tasks[0]!;
    const altDifficulty = (["L1", "L2", "L3", "L4"] as const).find((d) => d !== first.difficulty) ?? "L4";
    const broken = [
      // first task with wrong difficulty
      { id: first.id, title: first.title, difficulty: altDifficulty },
      // extra task not in the suite
      { id: "db-T99-bogus", title: "bogus", difficulty: "L1" as const },
      // all other tasks except the last one (so the last is missing)
      ...suite.tasks.slice(1, -1).map((t) => ({ id: t.id, title: t.title, difficulty: t.difficulty })),
    ];
    const errors = validatePackAgainstSuite(broken, suite);
    expect(errors.some((e) => /difficulty diverges/.test(e))).toBe(true);
    expect(errors.some((e) => /not in canonical suite/.test(e))).toBe(true);
    expect(errors.some((e) => /missing from the pack/.test(e))).toBe(true);
  });
});
