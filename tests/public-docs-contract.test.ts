import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

function document(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

describe("public behavior documentation", () => {
  it("documents harness diagnostics without making them scoring inputs", () => {
    const architecture = document("ARCHITECTURE.md");
    const skill = document("SKILL.md");
    expect(architecture).toContain("first-action startup timeout");
    expect(architecture).toMatch(/never change the\s+programmatic read-back score/);
    expect(skill).toContain("validity_status");
    expect(skill).toContain("diagnostics only");
  });

  it("documents aggregation, artifact, manifest, bundle, and cell contracts", () => {
    const readme = document("README.md");
    const architecture = document("ARCHITECTURE.md");
    expect(readme).toMatch(/aggregation\s+rejects mixed identities/);
    expect(readme).toMatch(/public cell export accepts only manifest-bound aggregate\s+records/);
    expect(architecture).toContain("Publication manifest v2 content-addresses");
    expect(architecture).toContain("production artifact writer");
    expect(architecture).toContain("Publication cell export accepts");
  });
});
