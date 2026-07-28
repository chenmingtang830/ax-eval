import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TargetPackSchema, type TargetPack } from "../src/schemas.js";
import { defaultInvokePaths } from "../src/harness/invoke.js";
import { openCodeManagedProgramData, provisionHarnessForSurface } from "../src/harness/mcp-provision.js";
import {
  findOpenCodeManagedConfig,
  isOpenCodeReservedChildEnv,
  openCodeManagedConfigCandidates,
} from "../src/harness/opencode.js";

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

function cliPack(): TargetPack {
  return TargetPackSchema.parse({
    name: "demo-cli",
    auth: { type: "none", env: "" },
    base_url: "https://api.demo.test",
    surfaces: {
      cli: {
        bin: "demo-cli",
        install: "Install the demo CLI.",
        help: "demo-cli --help",
        docs_url: "https://docs.demo.test/cli",
        auth: { kind: "inherit" },
      },
    },
    tasks: [
      {
        id: "t1",
        prompt: "Run one CLI task.",
        allowed_surfaces: ["cli"],
        oracles: [{ type: "roundtrip", readPathTemplate: "/items/{gid}", assertField: "id", expected: "x" }],
      },
    ],
  });
}

describe("provisionHarnessForSurface", () => {
  it("rejects an invoke-home root swapped to a symlink before provisioning", async () => {
    const dir = freshDir();
    const outside = freshDir();
    symlinkSync(outside, resolve(dir, ".invoke-home"));
    await expect(provisionHarnessForSurface({
      pack: cliPack(),
      harness: "codex",
      surface: "cli",
      paths: defaultInvokePaths(dir, "cell-cli", "codex"),
      cwd: dir,
      env: { PATH: "" },
      allowDownloads: false,
      allowAmbientHarnessAuth: false,
    })).rejects.toThrow(/\.invoke-home must be a real directory/);
  });

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

  it("isolates every OpenCode non-MCP run across config, data, cache, and state", async () => {
    const dir = freshDir();
    const first = await provisionHarnessForSurface({
      pack: pack(),
      harness: "opencode",
      surface: "api",
      paths: defaultInvokePaths(dir, "opencode-low-api", "opencode"),
      cwd: "/repo",
      env: {
        OPENCODE_CONFIG_DIR: "/ambient/opencode-config",
        XDG_DATA_HOME: "/ambient/opencode-data",
      },
      isolateWorkspace: true,
    });
    const second = await provisionHarnessForSurface({
      pack: cliPack(),
      harness: "opencode",
      surface: "cli",
      paths: defaultInvokePaths(dir, "opencode-low-cli", "opencode"),
      cwd: "/repo",
      isolateWorkspace: true,
    });
    for (const root of [first.meta?.opencode_work_root, second.meta?.opencode_work_root]) {
      if (typeof root === "string") dirs.push(root);
    }

    expect(first.env.HOME).toContain(".invoke-home");
    expect(first.env.HOME).not.toBe(second.env.HOME);
    for (const name of [
      "OPENCODE_CONFIG_DIR",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "XDG_STATE_HOME",
    ]) {
      expect(first.env[name]?.startsWith(`${first.env.HOME}/`)).toBe(true);
      expect(existsSync(first.env[name]!)).toBe(true);
    }
    expect(first.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
    expect(first.env.OPENCODE_DISABLE_CLAUDE_CODE).toBe("1");
    expect(first.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT).toBe("1");
    expect(first.env.OPENCODE_DISABLE_LSP_DOWNLOAD).toBe("1");
    expect(first.env.OPENCODE_DISABLE_AUTOUPDATE).toBe("1");
    expect(first.env.OPENCODE_ENABLE_EXA).toBe("1");
    expect(first.meta?.mcp_provisioning).toBe("disabled_for_non_mcp_surface");
    expect(first.meta?.opencode_work_dir).toEqual(expect.stringContaining("ax-eval-opencode-"));
    expect(first.meta?.opencode_work_dir).not.toContain("/repo");
    expect(existsSync(first.meta?.opencode_work_dir as string)).toBe(true);
    const config = JSON.parse(readFileSync(resolve(first.env.OPENCODE_CONFIG_DIR!, "opencode.json"), "utf8"));
    expect(config).toEqual({
      mcp: {},
      permission: { task: "deny" },
      share: "disabled",
      autoshare: false,
    });
    expect(JSON.stringify(first)).not.toContain("/ambient/opencode");
  });

  it("enumerates and fails closed on OpenCode managed config sources", () => {
    expect(openCodeManagedConfigCandidates({ platform: "linux" })).toEqual([
      "/etc/opencode/opencode.json",
      "/etc/opencode/opencode.jsonc",
    ]);
    const darwin = openCodeManagedConfigCandidates({ platform: "darwin", username: "eval-user" });
    expect(darwin).toContain("/Library/Application Support/opencode/opencode.json");
    expect(darwin).toContain("/Library/Managed Preferences/eval-user/ai.opencode.managed.plist");
    expect(darwin).toContain("/Library/Managed Preferences/ai.opencode.managed.plist");
    expect(findOpenCodeManagedConfig(
      { platform: "darwin", username: "eval-user" },
      (path) => path.endsWith("ai.opencode.managed.plist"),
    )).toHaveLength(2);
    expect(openCodeManagedConfigCandidates({
      platform: "win32",
      programData: "D:\\ManagedData",
    })).toContain("D:\\ManagedData/opencode/opencode.json");
    expect(openCodeManagedProgramData({ ProgramData: "D:\\ManagedData" })).toBe("D:\\ManagedData");
    expect(openCodeManagedProgramData({ PROGRAMDATA: "E:\\MachineData" })).toBe("E:\\MachineData");
    expect(openCodeManagedProgramData({}, { ProgramData: "F:\\HostPolicy" })).toBe("F:\\HostPolicy");
    expect(isOpenCodeReservedChildEnv("opencode_config_content")).toBe(true);
    expect(isOpenCodeReservedChildEnv("xdg_data_home")).toBe(true);
  });

  it("creates the OpenCode session home with owner-only permissions", async () => {
    const dir = freshDir();
    const provisioning = await provisionHarnessForSurface({
      pack: pack(),
      harness: "opencode",
      surface: "api",
      paths: defaultInvokePaths(dir, "opencode-low-api", "opencode"),
      cwd: "/repo",
      env: {},
    });
    expect(statSync(provisioning.env.HOME!).mode & 0o777).toBe(0o700);
  });

  it("exchanges OAuth and writes an isolated OpenCode remote MCP config without embedding secrets", async () => {
    const dir = freshDir();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: "short-lived-access-token" }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    const provisioning = await provisionHarnessForSurface({
      pack: pack(),
      harness: "opencode",
      surface: "mcp",
      paths: defaultInvokePaths(dir, "opencode-low-mcp", "opencode"),
      cwd: "/repo",
      env: {
        ASANA_MCP_CLIENT_ID: "client-id",
        ASANA_MCP_CLIENT_SECRET: "client-secret",
        ASANA_MCP_REFRESH_TOKEN: "refresh-token",
      },
      isolateWorkspace: true,
    });
    if (typeof provisioning.meta?.opencode_work_root === "string") {
      dirs.push(provisioning.meta.opencode_work_root);
    }

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(provisioning.meta).toMatchObject({
      mcp_provisioning: "oauth_refresh_to_bearer",
      mcp_server: "asana",
    });
    expect(provisioning.env.AX_EVAL_MCP_BEARER_TOKEN_ASANA).toBe("short-lived-access-token");
    expect(provisioning.env.OPENCODE_CONFIG_DIR).toContain(".invoke-home");
    expect(provisioning.meta?.opencode_work_dir).not.toContain("/repo");
    const config = JSON.parse(readFileSync(resolve(provisioning.env.OPENCODE_CONFIG_DIR!, "opencode.json"), "utf8"));
    expect(config.mcp.asana).toEqual({
      type: "remote",
      url: "https://mcp.asana.com/v2/mcp",
      enabled: true,
      headers: { Authorization: "Bearer {env:AX_EVAL_MCP_BEARER_TOKEN_ASANA}" },
    });
    expect(JSON.stringify(config)).not.toMatch(/short-lived-access-token|refresh-token|client-secret/);
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

    const openCode = await provisionHarnessForSurface({
      pack: stdioPack,
      harness: "opencode",
      surface: "mcp",
      paths: defaultInvokePaths(dir, "opencode-low-mcp", "opencode"),
      cwd: "/repo",
      env: { DEMO_MCP_TOKEN: "stdio-secret" },
    });
    const openCodeConfig = JSON.parse(readFileSync(
      resolve(openCode.env.OPENCODE_CONFIG_DIR!, "opencode.json"),
      "utf8",
    ));
    expect(openCodeConfig.mcp.demo).toEqual({
      type: "local",
      command: ["npx", "-y", "@demo/mcp"],
      enabled: true,
    });
    expect(JSON.stringify(openCodeConfig)).not.toContain("stdio-secret");
    expect(openCode.env.DEMO_MCP_TOKEN).toBe("stdio-secret");
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

  it("leaves product-specific CLI provisioning to runtime extensions", async () => {
    const dir = freshDir();
    const provisioning = await provisionHarnessForSurface({
      pack: cliPack(),
      harness: "codex",
      surface: "cli",
      paths: defaultInvokePaths(dir, "codex-low-cli", "codex"),
      cwd: "/repo",
      env: { PATH: "/controller-selected/bin" },
      allowDownloads: false,
      allowAmbientHarnessAuth: false,
    });
    expect(provisioning.env.PATH).toBeUndefined();
    expect(provisioning.env.HOME).toContain(".invoke-home");
    expect(provisioning.meta).not.toHaveProperty("shared_cli_home");
    expect(provisioning.meta).not.toHaveProperty("shared_cli_binary");
  });
});
