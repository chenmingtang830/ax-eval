import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "src", "cli.ts");
const PACK = resolve(ROOT, "targets", "asana", "pack.yaml");

/** Run the CLI via tsx; return { code, out } (stdout+stderr merged). */
function runCli(args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  try {
    const out = execFileSync("npx", ["tsx", CLI, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        ASANA_PAT: "test-token",
        ASANA_SANDBOX_PROJECT_GID: "123",
        ...env,
      },
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

describe("exec-plan --surface fan-out", () => {
  const dirs: string[] = [];
  function freshDir(): string {
    const d = mkdtempSync(resolve(tmpdir(), "ax-fanout-"));
    dirs.push(d);
    return d;
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("`--surface all` fans out over auth-runnable surfaces with isolated ns + tagged files", () => {
    const dir = freshDir();
    const { code, out } = runCli(
      [
        "exec-plan", "--pack", PACK, "--skip-review", "--surface", "all", "--harness", "floor", "--attempts", "1", "--run-dir", dir,
      ],
      // Hermetic: explicitly clear the MCP OAuth creds so a developer's populated
      // .env can't leak in and make the OAuth-only surface look runnable. Empty
      // strings count as "set in process.env", so loadDotenv won't override them.
      { ASANA_MCP_CLIENT_ID: "", ASANA_MCP_CLIENT_SECRET: "", ASANA_MCP_REFRESH_TOKEN: "" },
    );
    expect(code).toBe(0);
    // asana declares sdk + mcp; api is always present. sdk inherits the PAT
    // (runnable); mcp is OAuth-only, so it's auth-blocked rather than prompted.
    expect(out).toContain("surface=api");
    expect(out).toContain("surface=sdk");
    expect(out).toContain("surface=mcp");
    const files = readdirSync(dir).sort();
    // A prompt per runnable surface, surface-tagged so they never collide.
    expect(files).toContain("prompt-floor-api.txt");
    expect(files).toContain("prompt-floor-sdk.txt");
    // The OAuth-only MCP surface emits a blocked cube cell instead of a prompt.
    expect(files).not.toContain("prompt-floor-mcp.txt");
    expect(files).toContain("run-mcp-blocked.normalized.json");
    expect(out).toContain("surface=mcp → BLOCKED (requires-oauth)");
    // Namespaces are surface-scoped so concurrent surfaces don't clobber the live product.
    expect(out).toMatch(/ns=gen-api-floor-/);
    expect(out).toMatch(/ns=gen-sdk-floor-/);
  });

  it("a single declared surface tags its artifacts; the default api surface keeps legacy paths", () => {
    const sdkDir = freshDir();
    const sdk = runCli(["exec-plan", "--pack", PACK, "--skip-review", "--surface", "sdk", "--harness", "floor", "--attempts", "1", "--run-dir", sdkDir]);
    expect(sdk.code).toBe(0);
    expect(readdirSync(sdkDir)).toContain("prompt-floor-sdk.txt");

    const apiDir = freshDir();
    const api = runCli(["exec-plan", "--pack", PACK, "--skip-review", "--harness", "floor", "--attempts", "1", "--run-dir", apiDir]);
    expect(api.code).toBe(0);
    // Default (api-only) run is byte-for-byte the legacy layout — no surface suffix.
    expect(readdirSync(apiDir)).toContain("prompt-floor.txt");
  });

  it("refuses a surface the pack does not declare, naming what is available", () => {
    const dir = freshDir();
    const { code, out } = runCli(["exec-plan", "--pack", PACK, "--skip-review", "--surface", "cli", "--run-dir", dir]);
    expect(code).toBe(1);
    expect(out).toContain("surface 'cli' is not declared");
    expect(out).toContain("declared: api, sdk, mcp");
  });

  it("rejects an unknown --surface value before doing any work", () => {
    const { code, out } = runCli(["exec-plan", "--pack", PACK, "--skip-review", "--surface", "graphql"]);
    expect(code).toBe(1);
    expect(out).toContain("--surface must be one of api|cli|sdk|mcp|all");
  });

  it("`--invoke` runs a local harness CLI and stamps the result with the harness id", () => {
    const dir = freshDir();
    const binDir = freshDir();
    const fakeClaude = resolve(binDir, "claude");
    writeFileSync(
      fakeClaude,
      `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("claude fake-test");
  process.exit(0);
}
const prompt = args[args.indexOf("-p") + 1] || "";
const resultPath = /Write (\\S+run-[^\\s]+\\.json) with EXACTLY/.exec(prompt)?.[1];
const tracePath = /write (\\S+run-[^\\s]+\\.trace\\.json) as/.exec(prompt)?.[1];
if (!resultPath || !tracePath) {
  console.error("missing paths");
  process.exit(1);
}
fs.writeFileSync(resultPath, JSON.stringify({
  profile: "floor",
  ns: "fake-ns",
  surface: "api",
  discovery: { base_url_found: "", searches: [], urls_visited: [], endpoint_used: "", auth_scheme_found: "", notes: "" },
  results: {}
}, null, 2));
fs.writeFileSync(tracePath, "[]");
console.log(JSON.stringify({ ok: true }));
`,
    );
    chmodSync(fakeClaude, 0o755);

    const { code, out } = runCli(
      [
        "exec-plan", "--pack", PACK, "--skip-review", "--invoke", "--harness", "claude-code",
        "--profile", "floor", "--attempts", "1", "--run-dir", dir,
      ],
      { PATH: `${binDir}:${process.env.PATH ?? ""}` },
    );

    expect(code).toBe(0);
    expect(out).toContain("claude-code/API/floor"); // per-job progress label in the concurrency pool
    expect(out).toContain("Verify invoked runs:");
    expect(out).toContain("--harness claude-code");
    const files = readdirSync(dir).sort();
    expect(files).toContain("prompt-claude-code-floor.txt");
    expect(files).toContain("run-claude-code-floor.json");
    expect(files).toContain("run-claude-code-floor.trace.json");
    expect(files).toContain("run-claude-code-floor.transcript.jsonl");
    const executor = JSON.parse(readFileSync(resolve(dir, "run-claude-code-floor.json"), "utf8"));
    expect(executor.harness).toBe("claude-code");
    expect(executor.profile).toBe("floor");
  });

  it("runs multiple configs through the concurrency pool (parallel by default)", () => {
    const dir = freshDir();
    const binDir = freshDir();
    const fakeClaude = resolve(binDir, "claude");
    writeFileSync(
      fakeClaude,
      `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("claude fake-test"); process.exit(0); }
const prompt = args[args.indexOf("-p") + 1] || "";
const resultPath = /Write (\\S+run-[^\\s]+\\.json) with EXACTLY/.exec(prompt)?.[1];
const tracePath = /write (\\S+run-[^\\s]+\\.trace\\.json) as/.exec(prompt)?.[1];
fs.writeFileSync(resultPath, JSON.stringify({ profile: "x", ns: "n", surface: "api", discovery: {}, results: {} }));
fs.writeFileSync(tracePath, "[]");
console.log(JSON.stringify({ ok: true }));
`,
    );
    chmodSync(fakeClaude, 0o755);
    const { code, out } = runCli(
      [
        "exec-plan", "--pack", PACK, "--skip-review", "--invoke", "--harness", "claude-code",
        "--profile", "low", "--profile", "high", "--attempts", "1", "--run-dir", dir,
      ],
      { PATH: `${binDir}:${process.env.PATH ?? ""}` },
    );
    expect(code).toBe(0);
    // Two configs (low + high) ran via the pool — both files exist, and the pool
    // announces its concurrency.
    expect(out).toContain("at concurrency=2");
    const files = readdirSync(dir).sort();
    expect(files).toContain("run-claude-code-low.json");
    expect(files).toContain("run-claude-code-high.json");
  });
});
