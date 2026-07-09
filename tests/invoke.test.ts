import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TargetPackSchema, type TargetPack } from "../src/schemas.js";
import {
  DEFAULT_ASYNC_SPAWN,
  defaultInvokePaths,
  detectInvokeHarness,
  redactSensitiveText,
  runInvokeHarness,
  codexOutputSchema,
  type AsyncSpawn,
  type InvokeRunOptions,
} from "../src/harness/invoke.js";
import { buildExecutorPrompt } from "../src/harness/executor.js";
import { getProfile } from "../src/harness/profile.js";
import { getSurface } from "../src/surface/index.js";

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "ax-invoke-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function pack(): TargetPack {
  return TargetPackSchema.parse({
    name: "demo",
    standard_set_version: "demo-v1",
    run_id: "gen",
    base_url: "https://api.demo.test",
    tasks: [
      {
        id: "t1",
        prompt: "Create one thing.",
        allowed_surfaces: ["api"],
        oracles: [{ type: "roundtrip", readPathTemplate: "/things/{gid}", assertField: "name", expected: "x" }],
      },
    ],
  });
}

function spawnResult(overrides: Partial<ReturnType<typeof makeSpawnResult>> = {}) {
  return { ...makeSpawnResult(), ...overrides };
}

function makeSpawnResult() {
  return {
    pid: 123,
    output: [],
    stdout: Buffer.from("ok"),
    stderr: Buffer.from(""),
    status: 0,
    signal: null,
    error: undefined,
    timedOut: undefined,
    timeoutReason: undefined,
    firstActionLatencyMs: undefined,
  };
}

function opts(dir: string, harness: "claude-code" | "codex" = "claude-code"): InvokeRunOptions {
  const paths = defaultInvokePaths(dir, `${harness}-ceiling-api`, harness);
  writeFileSync(paths.promptPath, "Do the task and write files.");
  return {
    pack: pack(),
    harness,
    profile: "ceiling",
    surface: "api",
    ns: "gen-ceiling-abcd",
    paths,
    cwd: dir,
  };
}

describe("detectInvokeHarness", () => {
  it("reports a missing local harness without throwing", () => {
    const detected = detectInvokeHarness("claude-code", () => spawnResult({
      status: null,
      stdout: Buffer.from(""),
      error: Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }),
    }));
    expect(detected.ok).toBe(false);
    expect(detected.reason).toBe("missing-harness");
    expect(detected.command).toBe("claude");
  });

  it("captures a version string when the harness is available", () => {
    const detected = detectInvokeHarness("codex", () => spawnResult({ stdout: Buffer.from("codex 1.2.3\n") }));
    expect(detected.ok).toBe(true);
    expect(detected.version).toBe("codex 1.2.3");
  });
});

describe("redactSensitiveText", () => {
  it("redacts common credential shapes while preserving env-var names", () => {
    // Assemble Neon/Sentry-shaped fixtures at runtime so secret scanners do not
    // flag contiguous credential-looking literals in source.
    const neonHead = ["napi_", "1l1uah8v9netldvmvzu7164ebe9"].join("");
    const neonTail = "51zlk8qr6j1jey0yf5elo1fojz1ubjrpra6j7";
    const neonKey = `${neonHead}${neonTail}`;
    const sentryPublic = ["3bbe57a973254129", "bcb93e47dc0cc46f"].join("");
    const sentryHost = ["o343074", ".ingest.sentry.io/2052166"].join("");
    const raw = [
      "DATABASE_URL=postgresql://user:pass@example.test:5432/db",
      "SUPABASE_ACCESS_TOKEN=sbp_abcdefghijklmnopqrstuvwxyz",
      `neonctl help default --api-key ${neonKey}`,
      `wrapped neon default [default: "${neonHead}\n                    ${neonTail}"]`,
      `json escaped neon default [default: \\"${neonHead}\\n                    ${neonTail}\\"]`,
      `partially redacted wrapped neon default [default: "<redacted-token>\n                    ${neonTail}"]`,
      `partially redacted escaped neon default [default: \\"<redacted-token>\\n                    ${neonTail}\\"]`,
      "ASANA_PAT=2/123/abc:def",
      "CONVEX_DEPLOY_KEY=preview:team:project|eyJaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
      "JWT=eyJaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc",
      "MONGODB_URI=mongodb+srv://user:pass@example.mongodb.net/db",
      `sentry dsn https://${sentryPublic}@${sentryHost}`,
      "\"dsn\":\"https://publickey@example.com/project\"",
      "package @supabase/postgrest-js should stay readable",
    ].join("\n");

    const redacted = redactSensitiveText(raw);
    expect(redacted).toContain("DATABASE_URL=<redacted>");
    expect(redacted).toContain("SUPABASE_ACCESS_TOKEN=<redacted>");
    expect(redacted).toContain("ASANA_PAT=<redacted>");
    expect(redacted).toContain("CONVEX_DEPLOY_KEY=<redacted>");
    expect(redacted).toContain("Authorization: Bearer <redacted>");
    expect(redacted).toContain("JWT=<redacted>");
    expect(redacted).toContain("MONGODB_URI=<redacted>");
    expect(redacted).toContain(`https://<redacted>@${sentryHost}`);
    expect(redacted).toContain("\"dsn\":\"<redacted>\"");
    expect(redacted).not.toContain("user:pass");
    expect(redacted).not.toContain("sbp_abcdefghijklmnopqrstuvwxyz");
    expect(redacted).not.toContain(neonKey);
    expect(redacted).not.toContain(neonTail);
    expect(redacted).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(redacted).not.toContain(sentryPublic);
    expect(redacted).toContain("@supabase/postgrest-js");
  });
});

describe("runInvokeHarness", () => {
  it("runs a prompt, stores subprocess artifacts, and stamps the executor result with the harness id", async () => {
    const dir = freshDir();
    const run = opts(dir, "claude-code");
    // Async spawn mock — (command, args, cwd) => Promise<ProcResult>.
    const spawn = async (command: string, args: string[]) => {
      expect(command).toBe("claude");
      expect(args[0]).toBe("-p");
      writeFileSync(
        run.paths.resultsPath,
        JSON.stringify({
          profile: "ceiling",
          ns: run.ns,
          surface: "api",
          discovery: {},
          results: { t1: { gid: "gid-1" } },
        }),
      );
      writeFileSync(run.paths.tracePath, "[]");
      return spawnResult({ stdout: Buffer.from('{"summary":"done"}') });
    };

    const result = await runInvokeHarness(run, spawn);
    expect(result.ok).toBe(true);
    expect(readFileSync(run.paths.stdoutPath, "utf8")).toContain("done");
    expect(readFileSync(run.paths.transcriptPath, "utf8")).toContain("done");
    const executor = JSON.parse(readFileSync(run.paths.resultsPath, "utf8"));
    expect(executor.harness).toBe("claude-code");
    expect(executor.profile).toBe("ceiling");
  });

  it("passes pinned model and native effort to Claude Code", async () => {
    const dir = freshDir();
    const run = opts(dir, "claude-code");
    const spawn: AsyncSpawn = async (_command, args) => {
      expect(args).toContain("--model");
      expect(args).toContain("sonnet");
      expect(args).toContain("--effort");
      expect(args).toContain("low");
      writeFileSync(
        run.paths.resultsPath,
        JSON.stringify({
          profile: "low",
          ns: run.ns,
          surface: "api",
          discovery: {},
          results: { t1: { gid: "gid-1" } },
        }),
      );
      writeFileSync(run.paths.tracePath, "[]");
      return spawnResult({ stdout: Buffer.from('{"model":"claude-sonnet-5"}') });
    };

    const result = await runInvokeHarness({ ...run, profile: "low", model: "sonnet", effort: "low" }, spawn);
    expect(result.ok).toBe(true);
    const executor = JSON.parse(readFileSync(run.paths.resultsPath, "utf8"));
    expect(executor.model).toBe("claude-sonnet-5");
  });

  it("disables inherited MCP servers for non-MCP Codex invocations", async () => {
    const dir = freshDir();
    const run = opts(dir, "codex");
    const spawn: AsyncSpawn = async (_command, args) => {
      expect(args).toContain("-c");
      expect(args).toContain("mcp_servers={}");
      writeFileSync(
        run.paths.resultsPath,
        JSON.stringify({
          profile: "low",
          ns: run.ns,
          surface: "api",
          discovery: {},
          results: { t1: { gid: "gid-1" } },
        }),
      );
      writeFileSync(run.paths.tracePath, "[]");
      return spawnResult({ stdout: Buffer.from("{}"), stderr: Buffer.from("model: gpt-5.5\n") });
    };

    const result = await runInvokeHarness({ ...run, profile: "low", model: "gpt-5.5", effort: "low" }, spawn);
    expect(result.ok).toBe(true);
  });

  it("writes explainable failure artifacts when the harness exits before writing results", async () => {
    const dir = freshDir();
    const run = opts(dir, "codex");
    const result = await runInvokeHarness(
      run,
      async () => spawnResult({ status: 1, stdout: Buffer.from(""), stderr: Buffer.from("boom") }),
    );

    expect(result.ok).toBe(false);
    expect(existsSync(run.paths.resultsPath)).toBe(true);
    expect(existsSync(run.paths.tracePath)).toBe(true);
    expect(existsSync(run.paths.codexSchemaPath!)).toBe(true);
    const executor = JSON.parse(readFileSync(run.paths.resultsPath, "utf8"));
    expect(executor.harness).toBe("codex");
    expect(executor.profile).toBe("ceiling");
    expect(executor.results.t1.gid).toBeNull();
    expect(readFileSync(run.paths.stderrPath, "utf8")).toContain("boom");
  });

  it("normalizes placeholder discovery base URLs from declared env templates", async () => {
    const dir = freshDir();
    const run = opts(dir, "codex");
    const original = process.env.CONVEX_URL;
    process.env.CONVEX_URL = "preview-example-123.convex.cloud";
    try {
      const convexPack = TargetPackSchema.parse({
        name: "convex",
        standard_set_version: "demo-v1",
        run_id: "gen",
        base_url: "https://${CONVEX_URL}",
        tasks: [
          {
            id: "t1",
            prompt: "Create one thing.",
            allowed_surfaces: ["api"],
            oracles: [{ type: "roundtrip", readPathTemplate: "/things/{gid}", assertField: "name", expected: "x" }],
          },
        ],
      });
      const spawn: AsyncSpawn = async () => {
        writeFileSync(
          run.paths.resultsPath,
          JSON.stringify({
            profile: "ceiling",
            ns: run.ns,
            surface: "api",
            discovery: {
              base_url_found: "<CONVEX_URL>/api/{query|mutation|action}",
              searches: [],
              urls_visited: [],
              endpoint_used: "POST /api/query",
              auth_scheme_found: "Authorization: Convex <deploy_key>",
              notes: "placeholder-like base URL",
            },
            results: { t1: { gid: "gid-1" } },
          }),
        );
        writeFileSync(run.paths.tracePath, "[]");
        return spawnResult({ stdout: Buffer.from("{}"), stderr: Buffer.from("model: gpt-5.5\n") });
      };

      const result = await runInvokeHarness({ ...run, pack: convexPack }, spawn);
      expect(result.ok).toBe(true);
      const executor = JSON.parse(readFileSync(run.paths.resultsPath, "utf8"));
      expect(executor.discovery.base_url_found).toBe("https://preview-example-123.convex.cloud");
    } finally {
      if (original === undefined) delete process.env.CONVEX_URL;
      else process.env.CONVEX_URL = original;
    }
  });

  it("recovers agent-written result JSON with bare inner quotes instead of crashing", async () => {
    const dir = freshDir();
    const run = opts(dir, "claude-code");
    const malformed = `{
  "profile": "ceiling",
  "ns": "${run.ns}",
  "surface": "api",
  "discovery": {
    "base_url_found": "demo",
    "searches": [],
    "urls_visited": [],
    "endpoint_used": "tool \"quoted\" command",
    "auth_scheme_found": "token",
    "notes": "ok"
  },
  "results": { "t1": { "gid": "gid-1" } }
}`;
    const spawn: AsyncSpawn = async () => {
      writeFileSync(run.paths.resultsPath, malformed);
      writeFileSync(run.paths.tracePath, "[]");
      return spawnResult({ stdout: Buffer.from('{"model":"claude-sonnet-5"}') });
    };

    const result = await runInvokeHarness(run, spawn);
    expect(result.ok).toBe(true);
    const executor = JSON.parse(readFileSync(run.paths.resultsPath, "utf8"));
    expect(executor.discovery.endpoint_used).toBe('tool "quoted" command');
  });

  it("redacts harness stdout, transcript, trace, results, and meta artifacts", async () => {
    const dir = freshDir();
    const run = opts(dir, "codex");
    const secretDsn = "postgresql://user:pass@example.test:5432/db";
    const secretToken = "sbp_abcdefghijklmnopqrstuvwxyz";
    const secretJwt = "eyJaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc";
    const spawn: AsyncSpawn = async () => {
      writeFileSync(
        run.paths.resultsPath,
        JSON.stringify({
          profile: "ceiling",
          ns: run.ns,
          surface: "api",
          discovery: { notes: `used DATABASE_URL=${secretDsn}` },
          results: { t1: { gid: "gid-1" } },
        }),
      );
      writeFileSync(run.paths.tracePath, JSON.stringify([{ note: `token ${secretToken}` }]));
      return spawnResult({
        stdout: Buffer.from(`DATABASE_URL=${secretDsn}\nSUPABASE_ACCESS_TOKEN=${secretToken}\nJWT=${secretJwt}`),
        stderr: Buffer.from(`Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456\nmodel: gpt-test`),
      });
    };

    const result = await runInvokeHarness({ ...run, provisioning: { connection: secretDsn } }, spawn);
    expect(result.ok).toBe(true);
    for (const path of [
      run.paths.stdoutPath,
      run.paths.stderrPath,
      run.paths.transcriptPath,
      run.paths.resultsPath,
      run.paths.tracePath,
      run.paths.metaPath,
    ]) {
      const content = readFileSync(path, "utf8");
      expect(content).not.toContain(secretDsn);
      expect(content).not.toContain(secretToken);
      expect(content).not.toContain(secretJwt);
      expect(content).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
      expect(content).toContain("<redacted");
    }
  });

  it("redacts isolated invoke-home host CLI caches", async () => {
    const dir = freshDir();
    const run = opts(dir, "claude-code");
    const home = resolve(dir, ".invoke-home", "demo-claude");
    const cacheDir = resolve(home, ".claude", "projects", "demo");
    mkdirSync(cacheDir, { recursive: true });
    const cacheFile = resolve(cacheDir, "session.jsonl");
    const secretDsn = "postgresql://user:pass@example.test:5432/db";
    const spawn: AsyncSpawn = async () => {
      writeFileSync(cacheFile, `tool output DATABASE_URL=${secretDsn}\n`);
      writeFileSync(
        run.paths.resultsPath,
        JSON.stringify({ profile: "ceiling", ns: run.ns, surface: "api", discovery: {}, results: { t1: { gid: "g" } } }),
      );
      writeFileSync(run.paths.tracePath, "[]");
      return spawnResult({ stdout: Buffer.from("ok") });
    };

    const result = await runInvokeHarness({ ...run, env: { HOME: home } }, spawn);
    expect(result.ok).toBe(true);
    const content = readFileSync(cacheFile, "utf8");
    expect(content).toContain("DATABASE_URL=<redacted>");
    expect(content).not.toContain(secretDsn);
  });

  it("invokes codex exec with config-based approval disabled for non-interactive runs", async () => {
    const dir = freshDir();
    const run = opts(dir, "codex");
    let seenArgs: string[] = [];
    const spawn: AsyncSpawn = async (_command, args) => {
      seenArgs = args;
      writeFileSync(
        run.paths.resultsPath,
        JSON.stringify({ profile: "ceiling", ns: run.ns, surface: "api", discovery: {}, results: { t1: { gid: "g" } } }),
      );
      writeFileSync(run.paths.tracePath, "[]");
      return spawnResult({ stdout: Buffer.from('{"ok":true}') });
    };

    const result = await runInvokeHarness(run, spawn);
    expect(result.ok).toBe(true);
    expect(seenArgs).toContain("-c");
    expect(seenArgs).toContain('approval_policy="never"');
  });

  it("locks Codex structured output metadata to the current run and stamps empty partial metadata", async () => {
    const dir = freshDir();
    const run = opts(dir, "codex");
    const spawn: AsyncSpawn = async () => {
      writeFileSync(
        run.paths.resultsPath,
        JSON.stringify({
          profile: "",
          ns: "",
          surface: "",
          discovery: { notes: "partial progress message" },
          results: { t1: { gid: null } },
        }),
      );
      writeFileSync(run.paths.tracePath, "[]");
      return spawnResult({ stdout: Buffer.from('{"ok":true}'), stderr: Buffer.from("model: gpt-test\n") });
    };

    const result = await runInvokeHarness(run, spawn);
    expect(result.ok).toBe(true);
    const schema = JSON.parse(readFileSync(run.paths.codexSchemaPath!, "utf8"));
    expect(schema.properties.profile.enum).toEqual(["ceiling"]);
    expect(schema.properties.ns.enum).toEqual([run.ns]);
    expect(schema.properties.surface.enum).toEqual(["api"]);
    const executor = JSON.parse(readFileSync(run.paths.resultsPath, "utf8"));
    expect(executor.profile).toBe("ceiling");
    expect(executor.ns).toBe(run.ns);
    expect(executor.surface).toBe("api");
  });

  it("restricts the codex output schema to tasks that apply to the selected surface", async () => {
    const dir = freshDir();
    const surfacePack = TargetPackSchema.parse({
      ...pack(),
      tasks: [
        {
          id: "api-only",
          prompt: "Create one thing.",
          allowed_surfaces: ["api", "docs"],
          oracles: [{ type: "roundtrip", readPathTemplate: "/things/{gid}", assertField: "name", expected: "x" }],
        },
        {
          id: "mcp-only",
          prompt: "Create one thing through MCP.",
          allowed_surfaces: ["mcp", "docs"],
          oracles: [{ type: "roundtrip", readPathTemplate: "/things/{gid}", assertField: "name", expected: "y" }],
        },
      ],
    });
    const paths = defaultInvokePaths(dir, "codex-mcp", "codex");
    writeFileSync(paths.promptPath, "Do the task and write files.");
    const run: InvokeRunOptions = {
      pack: surfacePack,
      harness: "codex",
      profile: "ceiling",
      surface: "mcp",
      ns: "demo-high-mcp",
      paths,
      cwd: dir,
    };

    const spawn: AsyncSpawn = async () => {
      writeFileSync(
        run.paths.resultsPath,
        JSON.stringify({ profile: "ceiling", ns: run.ns, surface: "mcp", discovery: {}, results: { "mcp-only": { gid: "g" } } }),
      );
      writeFileSync(run.paths.tracePath, "[]");
      return spawnResult({ stdout: Buffer.from('{"ok":true}') });
    };

    const result = await runInvokeHarness(run, spawn);
    expect(result.ok).toBe(true);
    const schema = JSON.parse(readFileSync(paths.codexSchemaPath!, "utf8"));
    expect(Object.keys(schema.properties.results.properties)).toEqual(["mcp-only"]);
  });

  it("allows verifier-required self-report fields in Codex strict output schema and prompt shape", () => {
    const verifierPack = TargetPackSchema.parse({
      ...pack(),
      tasks: [{
        id: "needs-extra",
        prompt: "Create a stream and report its capture table.",
        allowed_surfaces: ["api"],
        oracles: [{
          type: "roundtrip",
          sqlDialect: "postgres",
          sqlQuery: "select count(*)::int as count from {capture_table}",
          assertField: "count",
          expected: 1,
        }],
      }],
    });

    const schema = codexOutputSchema(verifierPack, "codex:low", "api", "ns-1") as {
      properties: { results: { properties: Record<string, { properties: Record<string, unknown>; required: string[] }> } };
    };
    const taskSchema = schema.properties.results.properties["needs-extra"]!;
    expect(taskSchema.properties).toHaveProperty("gid");
    expect(taskSchema.properties).toHaveProperty("capture_table");
    expect(taskSchema.required).toEqual(["gid", "capture_table"]);

    const prompt = buildExecutorPrompt({
      pack: verifierPack,
      profile: getProfile("low"),
      ns: "ns-1",
      resultsPath: "results/run.json",
      tracePath: "results/run.trace.json",
      surface: getSurface("api"),
    });
    expect(prompt).toContain("(also self-report, alongside gid: `capture_table`)");
    expect(prompt).toContain('"needs-extra": {"gid": "<gid or null>", "capture_table": "<value or null>"}');
  });

  it("retries a failed invocation once, then succeeds on the second attempt", async () => {
    const dir = freshDir();
    const run = opts(dir, "claude-code");
    let calls = 0;
    const spawn: AsyncSpawn = async () => {
      calls += 1;
      if (calls === 1) {
        // First attempt crashes without writing a results file.
        return spawnResult({ status: 1, stdout: Buffer.from(""), stderr: Buffer.from("transient") });
      }
      writeFileSync(
        run.paths.resultsPath,
        JSON.stringify({ profile: "ceiling", ns: run.ns, surface: "api", discovery: {}, results: { t1: { gid: "g" } } }),
      );
      writeFileSync(run.paths.tracePath, "[]");
      return spawnResult({ stdout: Buffer.from('{"ok":true}') });
    };
    const result = await runInvokeHarness({ ...run, retries: 1 }, spawn);
    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it("passes the timeout cap to the spawn and records a timeout as a failure", async () => {
    const dir = freshDir();
    const run = opts(dir, "codex");
    let seenTimeout: number | undefined;
    let seenFirstActionTimeout: number | undefined;
    const spawn: AsyncSpawn = async (_command, _args, _cwd, spawnOpts) => {
      seenTimeout = spawnOpts?.timeoutMs;
      seenFirstActionTimeout = spawnOpts?.firstActionTimeoutMs;
      // Simulate the child being killed by the wall-clock cap (no results written).
      return spawnResult({ status: null, signal: "SIGTERM", timedOut: true, timeoutReason: "first-action", stdout: Buffer.from("") });
    };
    const result = await runInvokeHarness({ ...run, timeoutMs: 1000, firstActionTimeoutMs: 250, retries: 0, model: "sonnet" }, spawn);
    expect(seenTimeout).toBe(1000);
    expect(seenFirstActionTimeout).toBe(250);
    expect(result.timedOut).toBe(true);
    expect(result.timeoutReason).toBe("first-action");
    expect(result.validity_status).toBe("runtime_timeout_no_action");
    expect(result.action_occurred).toBe(false);
    expect(result.transcript_event_count).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(1);
    const executor = JSON.parse(readFileSync(run.paths.resultsPath, "utf8"));
    expect(executor.model).toBe("sonnet");
    expect(String(executor.discovery?.notes ?? "")).toMatch(/before first action/i);
    const meta = JSON.parse(readFileSync(run.paths.metaPath, "utf8"));
    expect(meta.validity_status).toBe("runtime_timeout_no_action");
    expect(meta.action_occurred).toBe(false);
  });

  it("records runtime_timeout_partial when a timed-out transcript contains an action", async () => {
    const dir = freshDir();
    const run = opts(dir, "codex");
    const stdout = JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", command: "democtl create thing" },
    });
    const result = await runInvokeHarness(
      { ...run, timeoutMs: 1000, retries: 0 },
      async () => spawnResult({ status: null, signal: "SIGTERM", timedOut: true, timeoutReason: "wall", stdout: Buffer.from(stdout) }),
    );

    expect(result.ok).toBe(false);
    expect(result.validity_status).toBe("runtime_timeout_partial");
    expect(result.action_occurred).toBe(true);
    expect(result.transcript_event_count).toBe(1);
    const meta = JSON.parse(readFileSync(run.paths.metaPath, "utf8"));
    expect(meta.validity_status).toBe("runtime_timeout_partial");
    expect(meta.action_occurred).toBe(true);
  });

  it("terminates a lingering wrapper once the required artifacts exist", async () => {
    const dir = freshDir();
    const resultsPath = resolve(dir, "result.json");
    const tracePath = resolve(dir, "trace.json");
    const started = Date.now();
    const result = await DEFAULT_ASYNC_SPAWN(
      "/bin/sh",
      [
        "-c",
        `node -e "const fs=require('fs'); fs.writeFileSync(${JSON.stringify(resultsPath)}, '{}'); fs.writeFileSync(${JSON.stringify(tracePath)}, '[]'); setTimeout(() => {}, 30000)" & wait`,
      ],
      dir,
      { timeoutMs: 60000, successPaths: [resultsPath, tracePath] },
    );

    expect(result.status).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(10000);
  });

  it("terminates a no-action child at the first-action timeout", async () => {
    const dir = freshDir();
    const started = Date.now();
    const result = await DEFAULT_ASYNC_SPAWN(
      "/bin/sh",
      ["-c", "node -e \"setTimeout(() => {}, 30000)\""],
      dir,
      { timeoutMs: 60000, firstActionTimeoutMs: 50 },
    );

    expect(result.timedOut).toBe(true);
    expect(result.timeoutReason).toBe("first-action");
    expect(result.firstActionLatencyMs).toBeNull();
    expect(Date.now() - started).toBeLessThan(10000);
  });

  it("recovers a Claude-written result file from the transcript and treats a completed run as successful", async () => {
    const dir = freshDir();
    const run = opts(dir, "claude-code");
    const transcript = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Write",
              input: {
                file_path: resolve(dir, run.paths.resultsPath),
                content: JSON.stringify({
                  profile: "ceiling",
                  ns: run.ns,
                  surface: "api",
                  discovery: { notes: "recovered" },
                  results: { t1: { gid: "gid-recovered" } },
                }),
              },
            },
            {
              type: "tool_use",
              name: "Write",
              input: {
                file_path: resolve(dir, run.paths.tracePath),
                content: JSON.stringify([{ step: 1, taskId: "t1", action: "create thing" }]),
              },
            },
          ],
        },
      }),
      JSON.stringify({ type: "result", subtype: "success", terminal_reason: "completed" }),
    ].join("\n");

    const result = await runInvokeHarness(
      { ...run, timeoutMs: 1000, retries: 0 },
      async () => spawnResult({ status: null, signal: "SIGTERM", timedOut: true, stdout: Buffer.from(transcript) }),
    );

    expect(result.ok).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.validity_status).toBe("runtime_timeout_partial");
    expect(result.action_occurred).toBe(true);
    expect(result.transcript_event_count).toBe(2);
    expect(JSON.parse(readFileSync(run.paths.resultsPath, "utf8")).results.t1.gid).toBe("gid-recovered");
    expect(JSON.parse(readFileSync(run.paths.tracePath, "utf8"))[0].action).toBe("create thing");
  });

  it("recovers a Codex agent-message result when the file is missing", async () => {
    const dir = freshDir();
    const run = opts(dir, "codex");
    const payload = {
      profile: "ceiling",
      ns: run.ns,
      surface: "api",
      discovery: { notes: "codex recovered" },
      results: { t1: { gid: "gid-codex" } },
    };
    const stdout = [
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify(payload),
        },
      }),
    ].join("\n");

    const result = await runInvokeHarness(
      run,
      async () => spawnResult({ status: 0, stdout: Buffer.from(stdout) }),
    );

    expect(result.ok).toBe(true);
    expect(JSON.parse(readFileSync(run.paths.resultsPath, "utf8")).results.t1.gid).toBe("gid-codex");
  });
});
