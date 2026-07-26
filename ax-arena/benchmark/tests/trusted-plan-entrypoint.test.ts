import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const planner = resolve(process.cwd(), "scripts", "prepare-trusted-plan.ts");
const tsxLoader = fileURLToPath(import.meta.resolve("tsx"));

describe("credential-free trusted planner", () => {
  it("fails closed outside the reviewed GitHub Actions plan job", () => {
    const result = spawnSync(process.execPath, ["--import", tsxLoader, planner], {
      cwd: resolve(process.cwd(), "../.."),
      env: { PATH: process.env.PATH ?? "" },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("credential-free GitHub Actions plan job");
  });

  it("uses the built controller, committed runtime lock, and safe routing outputs only", () => {
    const source = readFileSync(planner, "utf8");
    expect(source).toContain('new URL("../dist/index.js", import.meta.url)');
    expect(source).toContain("await import(arenaRuntimeModule)");
    expect(source).not.toContain('await import("../src/');
    expect(source).toContain("readTrustedRuntime(root)");
    expect(source).toContain('requiredEnvironment("GITHUB_RUN_ATTEMPT")');
    expect(source).toContain("buildTrustedWorkflowDispatch");
    expect(source).toContain("configuration_sha256");
    expect(source).toContain("matrix: JSON.stringify(dispatch.matrix)");
    expect(source).not.toContain("credentials");
    expect(source).not.toContain("secrets");
  });
});
