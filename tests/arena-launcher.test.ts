import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { arenaChildExitCode, executeArenaLaunch, resolveArenaLaunch } from "../src/arena-launcher.js";

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

  it("preserves the signal status through the executed compatibility launch", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "ax-arena-signal-launch-"));
    try {
      const cli = resolve(root, "arena-signal.js");
      writeFileSync(cli, 'process.kill(process.pid, "SIGTERM");\n');
      let reraised: NodeJS.Signals | undefined;
      const status = await executeArenaLaunch({
        executable: process.execPath,
        args: [cli],
        env: process.env,
      }, {
        reraiseSignal: (signal) => { reraised = signal; },
      });
      expect(status).toBe(143);
      expect(reraised).toBe("SIGTERM");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("forwards parent cancellation to the arena child and re-raises it", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "ax-arena-forward-signal-"));
    const marker = resolve(root, "child-saw-signal");
    const childCli = resolve(root, "arena-child.mjs");
    const wrapperCli = resolve(root, "compatibility-wrapper.mjs");
    try {
      writeFileSync(childCli, [
        'import { writeFileSync } from "node:fs";',
        `const marker = ${JSON.stringify(marker)};`,
        'process.on("SIGTERM", () => {',
        '  writeFileSync(marker, "SIGTERM\\n");',
        '  process.removeAllListeners("SIGTERM");',
        '  process.kill(process.pid, "SIGTERM");',
        '});',
        'process.stdout.write("ready\\n");',
        'setInterval(() => {}, 1000);',
      ].join("\n"));
      writeFileSync(wrapperCli, [
        `import { executeArenaLaunch } from ${JSON.stringify(pathToFileURL(resolve("src/arena-launcher.ts")).href)};`,
        `await executeArenaLaunch({ executable: process.execPath, args: [${JSON.stringify(childCli)}], env: process.env });`,
      ].join("\n"));
      const wrapper = spawn(process.execPath, [
        "--import", fileURLToPath(import.meta.resolve("tsx")), wrapperCli,
      ], { stdio: ["ignore", "pipe", "pipe"] });
      await new Promise<void>((resolveReady, rejectReady) => {
        const timeout = setTimeout(() => rejectReady(new Error("arena child did not become ready")), 5_000);
        wrapper.once("error", rejectReady);
        wrapper.stdout.setEncoding("utf8");
        wrapper.stdout.on("data", (chunk: string) => {
          if (!chunk.includes("ready")) return;
          clearTimeout(timeout);
          resolveReady();
        });
      });
      wrapper.kill("SIGTERM");
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
        wrapper.once("close", (code, signal) => resolveExit({ code, signal }));
      });
      expect(result).toEqual({ code: null, signal: "SIGTERM" });
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});
