import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

function stdioPack(auth: "inherit" | "token" = "inherit"): TargetPack {
  return TargetPackSchema.parse({
    name: "exa-generated",
    auth: { type: "api-key", env: "EXA_API_KEY" },
    base_url: "https://api.exa.ai",
    surfaces: {
      mcp: {
        server: "npx",
        transport: "stdio",
        args: ["-y", "exa-mcp-server"],
        auth: auth === "token"
          ? { kind: "token", token_env: "EXA_MCP_TOKEN", token_env_aliases: ["EXA_API_KEY"] }
          : { kind: "inherit" },
      },
    },
    tasks: [],
  });
}

describe("provisionHarnessForSurface", () => {
  it("writes a Codex stdio config with executable and argv", async () => {
    const dir = freshDir();
    process.env.EXA_API_KEY = "inherited-token";
    const paths = defaultInvokePaths(dir, "codex-high-mcp", "codex");
    const provisioning = await provisionHarnessForSurface({
      pack: stdioPack(),
      harness: "codex",
      surface: "mcp",
      paths,
      cwd: "/repo",
    });

    expect(provisioning.meta?.mcp_provisioning).toBe("stdio_inherit");
    expect(provisioning.env.EXA_API_KEY).toBe("inherited-token");
    const text = readFileSync(resolve(provisioning.env.CODEX_HOME!, "config.toml"), "utf8");
    expect(text).toContain('command = "npx"');
    expect(text).toContain('args = ["-y", "exa-mcp-server"]');
    expect(text).not.toContain("url =");
    expect(text).not.toContain("bearer_token_env_var");
  });

  it("writes a Claude stdio config without embedding token auth", async () => {
    const dir = freshDir();
    process.env.EXA_API_KEY = "secret-alias-token";
    const paths = defaultInvokePaths(dir, "claude-high-mcp", "claude-code");
    const provisioning = await provisionHarnessForSurface({
      pack: stdioPack("token"),
      harness: "claude-code",
      surface: "mcp",
      paths,
      cwd: "/repo",
    });

    expect(provisioning.meta?.mcp_provisioning).toBe("stdio_env_token");
    expect(provisioning.env.EXA_MCP_TOKEN).toBe("secret-alias-token");
    expect(provisioning.meta).not.toHaveProperty("claude_headers_helper");
    const configText = readFileSync(resolve(provisioning.env.HOME!, ".claude.json"), "utf8");
    expect(configText).toContain('"type": "stdio"');
    expect(configText).toContain('"command": "npx"');
    expect(configText).toContain('"-y"');
    expect(configText).toContain('"exa-mcp-server"');
    expect(configText).not.toContain('"url"');
    expect(configText).not.toContain("secret-alias-token");
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
});
