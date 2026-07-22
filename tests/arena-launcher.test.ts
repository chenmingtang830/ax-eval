import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { arenaChildExitCode, resolveArenaLaunch } from "../src/arena-launcher.js";

describe("arena compatibility launcher", () => {
  it("invokes an installed arena package CLI through Node without a shell", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ax-arena-installed-launch-"));
    try {
      const packageJson = resolve(root, "node_modules", "@ax-arena", "benchmark", "package.json");
      const launch = resolveArenaLaunch("audit-suite", ["--help"], {
        sourceCli: resolve(root, "missing-source.ts"),
        installedPackageJson: packageJson,
        env: { TEST_MARKER: "present" },
      });
      expect(launch).toEqual({
        executable: process.execPath,
        args: [
          resolve(root, "node_modules", "@ax-arena", "benchmark", "dist", "cli.js"),
          "benchmark",
          "audit-suite",
          "--help",
        ],
        env: { TEST_MARKER: "present" },
      });
      mkdirSync(resolve(packageJson, "..", "dist"), { recursive: true });
      writeFileSync(
        resolve(packageJson, "..", "dist", "cli.js"),
        "process.stdout.write(JSON.stringify({args: process.argv.slice(2), marker: process.env.TEST_MARKER}));\n",
      );
      const child = spawnSync(launch.executable, launch.args, {
        env: launch.env,
        encoding: "utf8",
        shell: false,
      });
      expect(child.status).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({
        args: ["benchmark", "audit-suite", "--help"],
        marker: "present",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when neither trusted entrypoint can be resolved", () => {
    expect(() => resolveArenaLaunch("audit-suite", [], {
      sourceCli: resolve(tmpdir(), "missing-ax-arena-source.ts"),
    })).toThrow(/could not locate the installed @ax-arena\/benchmark package/);
  });

  it("preserves conventional signal-derived exit status", () => {
    expect(arenaChildExitCode(null, "SIGINT")).toBe(130);
    expect(arenaChildExitCode(null, "SIGTERM")).toBe(143);
    expect(arenaChildExitCode(7, null)).toBe(7);
  });
});
