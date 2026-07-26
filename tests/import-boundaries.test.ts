import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findImportBoundaryViolations } from "../.github/verify-import-boundaries.mjs";

function fixture(): string {
  const root = mkdtempSync(resolve(tmpdir(), "ax-boundaries-"));
  mkdirSync(resolve(root, "src"), { recursive: true });
  mkdirSync(resolve(root, "ax-arena", "benchmark", "src"), { recursive: true });
  writeFileSync(resolve(root, "package.json"), JSON.stringify({
    exports: {
      ".": "./dist/index.js",
      "./schemas/evaluation-cell.v1.json": "./schemas/evaluation-cell.v1.json",
    },
  }));
  return root;
}

describe("import boundary verification", () => {
  it("allows core modules and public ax-eval imports from arena", () => {
    const root = fixture();
    writeFileSync(resolve(root, "src", "core.ts"), 'import "node:fs";\n');
    writeFileSync(resolve(root, "ax-arena", "benchmark", "src", "arena.ts"), [
      'import { runCell } from "ax-eval";',
      'import schema from "ax-eval/schemas/evaluation-cell.v1.json";',
      "void runCell; void schema;",
    ].join("\n"));
    expect(findImportBoundaryViolations(root)).toEqual([]);
  });

  it("rejects core imports of arena", () => {
    const root = fixture();
    writeFileSync(resolve(root, "src", "core.ts"), 'import "@ax-arena/benchmark";\n');
    expect(findImportBoundaryViolations(root)).toEqual([
      expect.stringContaining("core must not import arena"),
    ]);
  });

  it("rejects detached arena database packages in the core manifest", () => {
    const root = fixture();
    writeFileSync(resolve(root, "package.json"), JSON.stringify({
      exports: { ".": "./dist/index.js" },
      optionalDependencies: { "@neondatabase/serverless": "1.1.0" },
      peerDependencies: { supabase: "2.109.0" },
    }));
    expect(findImportBoundaryViolations(root)).toEqual([
      expect.stringContaining("@neondatabase/serverless"),
      expect.stringContaining("supabase"),
    ]);
  });

  it("rejects arena imports that escape the workspace or bypass public exports", () => {
    const root = fixture();
    const source = resolve(root, "ax-arena", "benchmark", "src", "arena.ts");
    writeFileSync(source, [
      'export * from "../../../../src/internal.js";',
      'const privateModule = import("ax-eval/src/config.js", { with: { type: "json" } });',
      'import privateApi = require("ax-eval/dist/private.js");',
      'type PrivateApi = import("ax-eval/src/private.js").PrivateApi;',
      "void privateModule; void privateApi; void (null as unknown as PrivateApi);",
    ].join("\n"));
    const violations = findImportBoundaryViolations(root);
    expect(violations).toHaveLength(4);
    expect(violations[0]).toContain("escapes its workspace");
    expect(violations[1]).toContain("public ax-eval export");
    expect(violations[2]).toContain("public ax-eval export");
    expect(violations[3]).toContain("public ax-eval export");
  });

  it("rejects symlinked source paths that could escape physical containment", () => {
    const root = fixture();
    writeFileSync(resolve(root, "src", "private.ts"), "export const privateValue = true;\n");
    symlinkSync(resolve(root, "src"), resolve(root, "ax-arena", "benchmark", "src", "linked"), "dir");
    expect(findImportBoundaryViolations(root)).toEqual([
      expect.stringContaining("source boundary scan rejects symlinks"),
    ]);
  });
});
