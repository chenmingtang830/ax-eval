import { describe, expect, it } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadSuite, suitePromptFragment, validatePackAgainstSuite } from "../src/generate/suite.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DAEB1 = resolve(ROOT, "targets", "suites", "daeb-1.yaml");

describe("canonical task suite", () => {
  it("loads and validates the shipped DAEB-1 suite", () => {
    const suite = loadSuite(DAEB1);
    expect(suite.name).toBe("DAEB-1");
    expect(suite.version).toBe(1);
    expect(suite.category).toBe("database");
    expect(suite.tasks).toHaveLength(10);
    for (const task of suite.tasks) {
      expect(task.id).toMatch(/^db-T\d{2}-/);
      expect(["L1", "L2", "L3", "L4"]).toContain(task.difficulty);
      expect(task.intent.length).toBeGreaterThan(20);
      expect(task.oracle_hint.length).toBeGreaterThan(10);
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
  });

  it("validation passes when pack matches the suite exactly", () => {
    const suite = loadSuite(DAEB1);
    const matching = suite.tasks.map((t) => ({ id: t.id, title: t.title, difficulty: t.difficulty }));
    expect(validatePackAgainstSuite(matching, suite)).toEqual([]);
  });

  it("validation catches missing, extra, and divergent tasks", () => {
    const suite = loadSuite(DAEB1);
    const broken = [
      // first task with wrong difficulty
      { ...suite.tasks[0]!, difficulty: "L4" as const },
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
