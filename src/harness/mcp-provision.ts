import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { TargetPack, SurfaceAuth } from "../schemas.js";
import type { SurfaceId } from "../surface/types.js";
import type { InvokeHarnessId, InvokePaths } from "./invoke.js";

export interface HarnessProvisioning {
  /** Environment overrides for the harness child process. */
  env: Record<string, string>;
  /** Non-secret metadata safe to persist in invoke meta artifacts. */
  meta?: Record<string, unknown>;
}

function env(name: string | undefined): string | undefined {
  return name ? process.env[name]?.trim() || undefined : undefined;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function productSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "target";
}

function writeSecretHeaderHelper(scriptPath: string, bearerTokenEnvVar: string): void {
  const script =
    `#!/usr/bin/env node\n` +
    `const token = process.env[${JSON.stringify(bearerTokenEnvVar)}]?.trim();\n` +
    `if (!token) {\n` +
    `  console.error("Missing MCP bearer token env ${bearerTokenEnvVar}");\n` +
    `  process.exit(1);\n` +
    `}\n` +
    `process.stdout.write(JSON.stringify({ Authorization: "Bearer " + token }));\n`;
  writeFileSync(scriptPath, script, { mode: 0o700 });
  try { chmodSync(scriptPath, 0o700); } catch { /* best effort */ }
}

async function exchangeRefreshToken(auth: SurfaceAuth): Promise<string> {
  if (auth.kind === "token") {
    const token = env(auth.token_env);
    if (!token) throw new Error(`Missing MCP token env ${auth.token_env}`);
    return token;
  }
  if (auth.kind !== "oauth_app") {
    throw new Error(`MCP auth kind ${auth.kind} does not need provisioning`);
  }
  const tokenUrl = auth.token_url;
  if (!tokenUrl) {
    throw new Error("MCP OAuth auth is missing token_url; cannot exchange refresh token headlessly");
  }
  const clientId = env(auth.client_id_env);
  const clientSecret = env(auth.client_secret_env);
  const refreshToken = env(auth.refresh_token_env);
  const missing = [
    clientId ? "" : auth.client_id_env,
    clientSecret ? "" : auth.client_secret_env,
    refreshToken ? "" : auth.refresh_token_env,
  ].filter(Boolean);
  if (missing.length) throw new Error(`Missing MCP OAuth env ${missing.join(", ")}`);

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId!,
    client_secret: clientSecret!,
    refresh_token: refreshToken!,
  });
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`MCP OAuth refresh exchange failed (${res.status})${detail ? `: ${detail.slice(0, 240)}` : ""}`);
  }
  const json = await res.json() as { access_token?: unknown };
  if (typeof json.access_token !== "string" || !json.access_token.trim()) {
    throw new Error("MCP OAuth refresh exchange did not return access_token");
  }
  return json.access_token;
}

function writeCodexMcpHome(opts: {
  pack: TargetPack;
  paths: InvokePaths;
  cwd: string;
  bearerTokenEnvVar?: string;
}): { home: string; configPath: string; serverName: string } {
  const mcp = opts.pack.surfaces?.mcp;
  if (!mcp?.server) throw new Error("Pack does not declare an MCP server");
  const serverName = productSlug(opts.pack.name.replace(/-generated$/, ""));
  const home = resolve(dirname(opts.paths.resultsPath), ".invoke-home", `${serverName}-codex-mcp`);
  const codexDir = resolve(home, ".codex");
  mkdirSync(codexDir, { recursive: true });
  const configPath = resolve(codexDir, "config.toml");
  const connection = mcp.transport === "stdio"
    ? `command = ${tomlString(mcp.server)}\nargs = ${tomlArray(mcp.args)}\n`
    : `url = ${tomlString(mcp.server)}\ntype = "http"\n`;
  const authLine = opts.bearerTokenEnvVar
    ? `bearer_token_env_var = ${tomlString(opts.bearerTokenEnvVar)}\n`
    : "";
  const config =
    `check_for_update_on_startup = false\n\n` +
    `[mcp_servers.${serverName}]\n` +
    connection +
    authLine +
    Object.entries(mcp.tool_approval_mode ?? {})
      .map(([toolName, mode]) => `\n[mcp_servers.${serverName}.tools.${toolName}]\napproval_mode = ${tomlString(mode)}\n`)
      .join("") +
    `\n` +
    `[projects.${tomlString(opts.cwd)}]\n` +
    `trust_level = "trusted"\n`;
  writeFileSync(configPath, config, { mode: 0o600 });
  try { chmodSync(configPath, 0o600); } catch { /* best effort */ }
  return { home, configPath, serverName };
}

function writeClaudeMcpHome(opts: {
  pack: TargetPack;
  paths: InvokePaths;
  cwd: string;
  bearerTokenEnvVar?: string;
}): { home: string; configPath: string; headersHelperPath?: string; serverName: string } {
  const mcp = opts.pack.surfaces?.mcp;
  if (!mcp?.server) throw new Error("Pack does not declare an MCP server");
  const serverName = productSlug(opts.pack.name.replace(/-generated$/, ""));
  const home = resolve(dirname(opts.paths.resultsPath), ".invoke-home", `${serverName}-claude-mcp`);
  const claudeDir = resolve(home, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  const headersHelperPath = opts.bearerTokenEnvVar
    ? resolve(claudeDir, `${serverName}-mcp-headers-helper.js`)
    : undefined;
  if (headersHelperPath && opts.bearerTokenEnvVar) {
    writeSecretHeaderHelper(headersHelperPath, opts.bearerTokenEnvVar);
  }

  // Invoked eval runs are fully headless. Without an explicit permission mode,
  // Claude will stop at the first remote MCP write and ask for approval instead
  // of exercising the surface. Keep this scoped to the isolated temp home.
  const settingsPath = resolve(claudeDir, "settings.json");
  const settings = {
    permissions: {
      defaultMode: "bypassPermissions",
    },
  };
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(settingsPath, 0o600); } catch { /* best effort */ }

  const configPath = resolve(home, ".claude.json");
  const serverConfig = mcp.transport === "stdio"
    ? {
        type: "stdio",
        command: mcp.server,
        args: mcp.args,
      }
    : {
        type: "http",
        url: mcp.server,
        ...(headersHelperPath ? { headersHelper: `node ${JSON.stringify(headersHelperPath)}` } : {}),
      };
  const config = {
    projects: {
      [opts.cwd]: {
        mcpServers: {
          [serverName]: serverConfig,
        },
      },
    },
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(configPath, 0o600); } catch { /* best effort */ }
  return { home, configPath, headersHelperPath, serverName };
}

/**
 * Provision an invoked harness with pack-declared MCP auth. This deliberately
 * avoids relying on a developer's already-authenticated global MCP session.
 */
export async function provisionHarnessForSurface(opts: {
  pack: TargetPack;
  harness: InvokeHarnessId;
  surface: SurfaceId;
  paths: InvokePaths;
  cwd: string;
}): Promise<HarnessProvisioning> {
  if (opts.surface !== "mcp") return { env: {} };
  const mcp = opts.pack.surfaces?.mcp;
  if (!mcp) return { env: {} };
  const auth = mcp.auth;

  let bearerToken: string | undefined;
  let bearerTokenEnvVar: string | undefined;
  let stdioTokenEnv: Record<string, string> = {};
  let authMode = "stdio_inherit";
  if (mcp.transport === "stdio") {
    if (auth?.kind === "oauth_app") {
      throw new Error("stdio MCP servers must use inherit or token auth");
    }
    if (auth?.kind === "token") {
      bearerToken = env(auth.token_env) ?? auth.token_env_aliases.map(env).find(Boolean);
      if (!bearerToken || !auth.token_env) throw new Error(`Missing MCP token env ${auth.token_env}`);
      stdioTokenEnv = { [auth.token_env]: bearerToken };
      authMode = "stdio_env_token";
    } else {
      const inheritedEnv = opts.pack.auth?.env;
      const inheritedToken = env(inheritedEnv) ?? (opts.pack.auth?.env_aliases ?? []).map(env).find(Boolean);
      if (inheritedEnv && inheritedToken) stdioTokenEnv = { [inheritedEnv]: inheritedToken };
    }
  } else if (!auth || auth.kind === "inherit") {
    const inheritedEnv = opts.pack.auth?.env;
    bearerToken = env(inheritedEnv) ?? (opts.pack.auth?.env_aliases ?? []).map(env).find(Boolean);
    if (bearerToken) {
      bearerTokenEnvVar = `AX_EVAL_MCP_BEARER_TOKEN_${productSlug(opts.pack.name.replace(/-generated$/, "")).toUpperCase()}`;
      authMode = "inherited_env_bearer_token";
    } else {
      authMode = "http_no_auth";
    }
  } else {
    bearerToken = await exchangeRefreshToken(auth);
    bearerTokenEnvVar = `AX_EVAL_MCP_BEARER_TOKEN_${productSlug(opts.pack.name.replace(/-generated$/, "")).toUpperCase()}`;
    authMode = auth.kind === "oauth_app" ? "oauth_refresh_to_bearer" : "env_bearer_token";
  }

  if (opts.harness === "codex") {
    const codex = writeCodexMcpHome({ pack: opts.pack, paths: opts.paths, cwd: opts.cwd, bearerTokenEnvVar });
    return {
      env: {
        HOME: codex.home,
        CODEX_HOME: resolve(codex.home, ".codex"),
        ...stdioTokenEnv,
        ...(bearerTokenEnvVar && bearerToken ? { [bearerTokenEnvVar]: bearerToken } : {}),
      },
      meta: {
        mcp_provisioning: authMode,
        codex_home: codex.home,
        codex_config: codex.configPath,
        mcp_server: codex.serverName,
      },
    };
  }

  if (opts.harness === "claude-code") {
    const claude = writeClaudeMcpHome({ pack: opts.pack, paths: opts.paths, cwd: opts.cwd, bearerTokenEnvVar });
    return {
      env: {
        HOME: claude.home,
        ...stdioTokenEnv,
        ...(bearerTokenEnvVar && bearerToken ? { [bearerTokenEnvVar]: bearerToken } : {}),
      },
      meta: {
        mcp_provisioning: authMode,
        claude_home: claude.home,
        claude_config: claude.configPath,
        ...(claude.headersHelperPath ? { claude_headers_helper: claude.headersHelperPath } : {}),
        mcp_server: claude.serverName,
      },
    };
  }

  return {
    env: {},
    meta: {
      mcp_provisioning: "not-configured-for-harness",
      harness: opts.harness,
    },
  };
}
