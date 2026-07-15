import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSuite, suitePromptFragment, validatePackAgainstSuite } from "../src/generate/suite.js";

function writeSuite(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ax-suite-"));
  const path = join(dir, "suite.yaml");
  writeFileSync(path, content);
  return path;
}

const validSuite = `
name: Demo Suite
version: 1
category: database
tasks:
  - id: db-create
    title: Create data
    difficulty: L1
    skill: data-write
    intent: Create one record named demo_{ns}.
    oracle_hint: Read the record back by id.
    allowed_surfaces: [api, cli]
`;

describe("canonical suite contracts", () => {
  it("loads a valid suite and renders compatibility-safe authoring guidance", () => {
    const suite = loadSuite(writeSuite(validSuite));
    expect(suite.tasks).toHaveLength(1);
    const prompt = suitePromptFragment(suite);
    expect(prompt).toContain("db-create");
    expect(prompt).toContain("set `na: true`");
    expect(prompt).toContain("empty remains unrestricted");
  });

  it("rejects empty and duplicate task sets", () => {
    expect(() => loadSuite(writeSuite("name: Empty\nversion: 1\ncategory: database\ntasks: []\n"))).toThrow(/at least 1/);
    expect(() => loadSuite(writeSuite(`${validSuite}\n  - id: db-create\n    title: Duplicate\n    difficulty: L1\n    skill: data-write\n    intent: Duplicate record.\n    oracle_hint: Read it.\n`))).toThrow(/duplicate task id/);
  });

  it("reports missing, extra, duplicate, and divergent pack tasks", () => {
    const suite = loadSuite(writeSuite(validSuite));
    expect(validatePackAgainstSuite([
      { id: "db-create", title: "Wrong", difficulty: "L4" },
      { id: "db-create", title: "Wrong", difficulty: "L4" },
      { id: "extra", title: "Extra", difficulty: "L1" },
    ], suite)).toEqual(expect.arrayContaining([
      expect.stringMatching(/appears more than once/),
      expect.stringMatching(/title diverges/),
      expect.stringMatching(/difficulty diverges/),
      expect.stringMatching(/not in canonical suite/),
    ]));
  });
});
