import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "src", "cli.ts");

/** Run the CLI via tsx; return { code, out } (stdout+stderr merged). */
function runCli(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync("npx", ["tsx", CLI, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

describe("cli arg handling", () => {
  it("an unknown command prints usage with exit 2 (not a flag error)", () => {
    const { code, out } = runCli(["frobnicate", "--offlne"]);
    expect(code).toBe(2);
    expect(out).toContain("usage: ax-eval");
    expect(out).not.toContain("unknown flag");
  });

  it("a value-flag with no value errors clearly, not with a low-level path error", () => {
    const { code, out } = runCli(["run", "--pack"]);
    expect(code).toBe(1);
    expect(out).toContain("--pack requires a value");
    expect(out).not.toContain("ERR_INVALID_ARG_TYPE");
  });

  it("audit --offline produces a readiness score", () => {
    const { code, out } = runCli(["audit", "--offline"]);
    expect(code).toBe(0);
    expect(out).toContain("Agent-readiness score");
  });
});
