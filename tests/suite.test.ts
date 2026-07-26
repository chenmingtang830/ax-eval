import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SuiteSchema,
  loadSuite,
  suitePromptFragment,
  validatePackAgainstSuite,
  type Suite,
} from "../src/generate/suite.js";

function exampleSuite(): Suite {
  return SuiteSchema.parse({
    name: "EXAMPLE-1",
    version: 1,
    category: "crm",
    tasks: [{
      id: "crm-T01-create-contact",
      title: "Create a contact",
      difficulty: "L1",
      skill: "create-contact",
      intent: "Create a uniquely named contact inside the declared sandbox.",
      oracle_hint: "Read the contact back by its reported identifier.",
      allowed_surfaces: ["api", "sdk", "cli"],
      na_examples: [],
    }],
  });
}

describe("generic canonical suite contract", () => {
  it("loads valid suite YAML and rejects malformed input", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ax-suite-contract-"));
    try {
      const valid = resolve(dir, "suite.yaml");
      const invalid = resolve(dir, "invalid.yaml");
      writeFileSync(valid, [
        "name: EXAMPLE-1",
        "version: 1",
        "category: crm",
        "tasks:",
        "  - id: crm-T01-create-contact",
        "    title: Create a contact",
        "    difficulty: L1",
        "    skill: create-contact",
        "    intent: Create a uniquely named contact inside the declared sandbox.",
        "    oracle_hint: Read the contact back by its reported identifier.",
        "",
      ].join("\n"));
      writeFileSync(invalid, "name: invalid\nversion: 1\ncategory: crm\ntasks: []\n");
      expect(loadSuite(valid)).toMatchObject({ name: "EXAMPLE-1", category: "crm" });
      expect(() => loadSuite(invalid)).toThrow(/Invalid suite/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders the generic prompt constraints from explicit suite input", () => {
    const fragment = suitePromptFragment(exampleSuite());
    expect(fragment).toContain("EXAMPLE-1");
    expect(fragment).toContain("crm-T01-create-contact");
    expect(fragment).toContain("difficulty: L1");
    expect(fragment).toContain("HARD OVERRIDE");
    expect(fragment).toContain("WEB SEARCH AND WEB FETCH");
  });

  it("validates exact task identity without category policy", () => {
    const suite = exampleSuite();
    expect(validatePackAgainstSuite([{
      id: "crm-T01-create-contact",
      title: "Create a contact",
      difficulty: "L1",
    }], suite)).toEqual([]);

    const errors = validatePackAgainstSuite([
      {
        id: "crm-T01-create-contact",
        title: "Divergent title",
        difficulty: "L2",
      },
      {
        id: "crm-T99-extra",
        title: "Extra task",
        difficulty: "L2",
      },
    ], suite);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("title diverges"),
      expect.stringContaining("difficulty diverges"),
      expect.stringContaining("not in canonical suite"),
    ]));
    expect(validatePackAgainstSuite([], suite)).toEqual([
      expect.stringContaining("missing from the pack"),
    ]);
  });
});
