import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TargetPackSchema, type TargetPack } from "../src/schemas.js";
import { defaultInvokePaths } from "../src/harness/invoke.js";
import { provisionHarnessForSurface } from "../src/harness/mcp-provision.js";

const dirs: string[] = [];
const oldEnv = { ...process.env };

function freshDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "ax-mcp-provision-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...oldEnv };
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function pack(): TargetPack {
  return TargetPackSchema.parse({
    name: "asana-generated",
    auth: { type: "bearer", env: "ASANA_PAT" },
    base_url: "https://app.asana.com/api/1.0",
    surfaces: {
      mcp: {
        server: "https://mcp.asana.com/v2/mcp",
        transport: "http",
        tool_approval_mode: {
          create_task: "approve",
        },
        auth: {
          kind: "oauth_app",
          token_env_aliases: [],
          client_id_env: "ASANA_MCP_CLIENT_ID",
          client_secret_env: "ASANA_MCP_CLIENT_SECRET",
          refresh_token_env: "ASANA_MCP_REFRESH_TOKEN",
          token_url: "https://app.asana.com/-/oauth_token",
        },
      },
    },
    tasks: [
      {
        id: "t1",
        prompt: "Create one task.",
        oracles: [{ type: "roundtrip", readPathTemplate: "/tasks/{gid}", assertField: "name", expected: "x" }],
      },
    ],
  });
}

function tursoCliPack(): TargetPack {
  return TargetPackSchema.parse({
    name: "turso",
    auth: { type: "bearer", env: "TURSO_DATABASE_AUTH_TOKEN" },
    base_url: "https://${TURSO_SANDBOX_DATABASE}-${TURSO_ORG}.turso.io",
    surfaces: {
      cli: {
        bin: "turso",
        install: "Install the official Turso CLI from the Turso CLI documentation.",
        help: "turso --help",
        docs_url: "https://docs.turso.tech/cli",
        auth: {
          kind: "token",
          token_env: "TURSO_DATABASE_AUTH_TOKEN",
          token_env_aliases: [],
        },
      },
    },
    tasks: [
      {
        id: "t1",
        prompt: "Run one CLI task.",
        allowed_surfaces: ["cli"],
        oracles: [{ type: "roundtrip", readPathTemplate: "/v2/pipeline", assertField: "results.0", expected: "x" }],
      },
    ],
  });
}

describe("provisionHarnessForSurface", () => {
  it("writes an isolated no-MCP Codex home for non-MCP surfaces", async () => {
    const dir = freshDir();
    const paths = defaultInvokePaths(dir, "codex-low-api", "codex");
    const provisioning = await provisionHarnessForSurface({
      pack: pack(),
      harness: "codex",
      surface: "api",
      paths,
      cwd: "/repo",
    });

    expect(provisioning.env.HOME).toContain(".invoke-home");
    expect(provisioning.env.CODEX_HOME).toBe(resolve(provisioning.env.HOME!, ".codex"));
    expect(provisioning.meta?.mcp_provisioning).toBe("disabled_for_non_mcp_surface");

    const config = resolve(provisioning.env.CODEX_HOME!, "config.toml");
    expect(existsSync(config)).toBe(true);
    const text = readFileSync(config, "utf8");
    expect(text).toContain("mcp_servers = {}");
    expect(text).not.toContain("[mcp_servers.");
  });

  it("exchanges OAuth refresh token and writes an isolated Codex MCP config", async () => {
    const dir = freshDir();
    process.env.ASANA_MCP_CLIENT_ID = "client-id";
    process.env.ASANA_MCP_CLIENT_SECRET = "client-secret";
    process.env.ASANA_MCP_REFRESH_TOKEN = "refresh-token";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: "short-lived-access-token" }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const paths = defaultInvokePaths(dir, "codex-high-mcp", "codex");
    const provisioning = await provisionHarnessForSurface({
      pack: pack(),
      harness: "codex",
      surface: "mcp",
      paths,
      cwd: "/repo",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(provisioning.env.HOME).toContain(".invoke-home");
    expect(provisioning.env.CODEX_HOME).toBe(resolve(provisioning.env.HOME!, ".codex"));
    expect(provisioning.meta?.mcp_provisioning).toBe("oauth_refresh_to_bearer");

    const config = resolve(provisioning.env.CODEX_HOME!, "config.toml");
    expect(existsSync(config)).toBe(true);
    const text = readFileSync(config, "utf8");
    expect(text).toContain("[mcp_servers.asana]");
    expect(text).toContain('url = "https://mcp.asana.com/v2/mcp"');
    expect(text).toContain('bearer_token_env_var = "AX_EVAL_MCP_BEARER_TOKEN_ASANA"');
    expect(text).toContain("[mcp_servers.asana.tools.create_task]");
    expect(text).toContain('approval_mode = "approve"');
    expect(provisioning.env.AX_EVAL_MCP_BEARER_TOKEN_ASANA).toBe("short-lived-access-token");
    expect(text).not.toContain("short-lived-access-token");
    expect(text).not.toContain("refresh-token");
    expect(text).not.toContain("client-secret");
  });

  it("writes an isolated Claude MCP config with a header helper instead of embedding the token", async () => {
    const dir = freshDir();
    process.env.ASANA_MCP_CLIENT_ID = "client-id";
    process.env.ASANA_MCP_CLIENT_SECRET = "client-secret";
    process.env.ASANA_MCP_REFRESH_TOKEN = "refresh-token";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: "short-lived-access-token" }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const paths = defaultInvokePaths(dir, "claude-low-mcp", "claude-code");
    const provisioning = await provisionHarnessForSurface({
      pack: pack(),
      harness: "claude-code",
      surface: "mcp",
      paths,
      cwd: "/repo",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(provisioning.env.HOME).toContain(".invoke-home");
    expect(provisioning.env.AX_EVAL_MCP_BEARER_TOKEN_ASANA).toBe("short-lived-access-token");
    expect(provisioning.meta?.mcp_provisioning).toBe("oauth_refresh_to_bearer");

    const config = resolve(provisioning.env.HOME!, ".claude.json");
    expect(existsSync(config)).toBe(true);
    const configText = readFileSync(config, "utf8");
    expect(configText).toContain('"projects"');
    expect(configText).toContain('"/repo"');
    expect(configText).toContain('"mcpServers"');
    expect(configText).toContain('"asana"');
    expect(configText).toContain('"type": "http"');
    expect(configText).toContain('"url": "https://mcp.asana.com/v2/mcp"');
    expect(configText).toContain('"headersHelper": "node ');
    expect(configText).not.toContain("short-lived-access-token");
    expect(configText).not.toContain("refresh-token");
    expect(configText).not.toContain("client-secret");

    const helper = String(provisioning.meta?.claude_headers_helper ?? "");
    expect(helper).toContain(".claude/asana-mcp-headers-helper.js");
    expect(existsSync(helper)).toBe(true);
    const helperText = readFileSync(helper, "utf8");
    expect(helperText).toContain("AX_EVAL_MCP_BEARER_TOKEN_ASANA");
    expect(helperText).toContain('process.stdout.write(JSON.stringify({ Authorization: "Bearer " + token }))');
    expect(helperText).not.toContain("short-lived-access-token");

    const settings = resolve(provisioning.env.HOME!, ".claude/settings.json");
    expect(existsSync(settings)).toBe(true);
    expect(readFileSync(settings, "utf8")).toContain('"defaultMode": "bypassPermissions"');
  });

  it("writes stdio command and argv without interpreting a shell command", async () => {
    const dir = freshDir();
    process.env.DEMO_MCP_TOKEN = "stdio-secret";
    const stdioPack = TargetPackSchema.parse({
      name: "demo",
      auth: { type: "none", env: "" },
      base_url: "https://api.demo.test",
      surfaces: {
        mcp: {
          server: "npx",
          transport: "stdio",
          args: ["-y", "@demo/mcp"],
          auth: { kind: "token", token_env: "DEMO_MCP_TOKEN" },
        },
      },
      tasks: [],
    });
    const paths = defaultInvokePaths(dir, "codex-low-mcp", "codex");
    const provisioning = await provisionHarnessForSurface({
      pack: stdioPack,
      harness: "codex",
      surface: "mcp",
      paths,
      cwd: "/repo",
    });
    const config = readFileSync(resolve(provisioning.env.CODEX_HOME!, "config.toml"), "utf8");
    expect(config).toContain('command = "npx"');
    expect(config).toContain('args = ["-y", "@demo/mcp"]');
    expect(config).not.toContain("stdio-secret");
    expect(provisioning.env.DEMO_MCP_TOKEN).toBe("stdio-secret");
  });

  it("provisions inherited HTTP bearer auth instead of falling through to global config", async () => {
    const dir = freshDir();
    process.env.DEMO_API_TOKEN = "inherited-secret";
    const inheritedPack = TargetPackSchema.parse({
      name: "demo",
      auth: { type: "bearer", env: "DEMO_API_TOKEN" },
      base_url: "https://api.demo.test",
      surfaces: {
        mcp: {
          server: "https://mcp.demo.test/mcp",
          transport: "http",
          auth: { kind: "inherit" },
        },
      },
      tasks: [],
    });
    const paths = defaultInvokePaths(dir, "codex-low-mcp", "codex");
    const provisioning = await provisionHarnessForSurface({
      pack: inheritedPack,
      harness: "codex",
      surface: "mcp",
      paths,
      cwd: "/repo",
    });
    expect(provisioning.meta?.mcp_provisioning).toBe("inherited_env_bearer_token");
    expect(provisioning.env.AX_EVAL_MCP_BEARER_TOKEN_DEMO).toBe("inherited-secret");
    const config = readFileSync(resolve(provisioning.env.CODEX_HOME!, "config.toml"), "utf8");
    expect(config).toContain('url = "https://mcp.demo.test/mcp"');
    expect(config).toContain('bearer_token_env_var = "AX_EVAL_MCP_BEARER_TOKEN_DEMO"');
    expect(config).not.toContain("inherited-secret");
  });

  it("injects a shared preinstalled Turso CLI into non-MCP CLI surfaces", async () => {
    const dir = freshDir();
    const paths = defaultInvokePaths(dir, "claude-low-cli", "claude-code");
    const sharedHome = resolve(dir, ".invoke-home", "turso-cli-shared");
    const sharedBin = resolve(sharedHome, ".turso");
    mkdirSync(sharedBin, { recursive: true });
    writeFileSync(resolve(sharedBin, "turso"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const claudeProvisioning = await provisionHarnessForSurface({
      pack: tursoCliPack(),
      harness: "claude-code",
      surface: "cli",
      paths,
      cwd: "/repo",
    });
    expect(claudeProvisioning.env.PATH?.split(":")[0]).toBe(sharedBin);
    expect(claudeProvisioning.meta?.shared_cli_home).toBe(sharedHome);

    const codexPaths = defaultInvokePaths(dir, "codex-low-cli", "codex");
    const codexProvisioning = await provisionHarnessForSurface({
      pack: tursoCliPack(),
      harness: "codex",
      surface: "cli",
      paths: codexPaths,
      cwd: "/repo",
    });
    expect(codexProvisioning.env.PATH?.split(":")[0]).toBe(sharedBin);
    expect(codexProvisioning.env.HOME).toContain(".invoke-home");
    expect(codexProvisioning.meta?.shared_cli_binary).toBe(resolve(sharedBin, "turso"));
  });
});
