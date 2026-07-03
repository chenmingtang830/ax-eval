import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { homedir } from "node:os";
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

function productSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "target";
}

function copyCodexAuth(codexDir: string): void {
  // Reuse the operator's own `codex login` session instead of requiring a
  // separate OPENAI_API_KEY: codex CLI stores it in a plain file (unlike
  // claude-code, which is Keychain-based and doesn't transfer to a fresh
  // isolated HOME).
  const realAuthPath = resolve(homedir(), ".codex", "auth.json");
  if (!process.env.OPENAI_API_KEY && existsSync(realAuthPath)) {
    copyFileSync(realAuthPath, resolve(codexDir, "auth.json"));
  }
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
  bearerTokenEnvVar: string;
}): { home: string; configPath: string; serverName: string } {
  const mcp = opts.pack.surfaces?.mcp;
  if (!mcp?.server) throw new Error("Pack does not declare an MCP server URL");
  const serverName = productSlug(opts.pack.name.replace(/-generated$/, ""));
  const home = resolve(dirname(opts.paths.resultsPath), ".invoke-home", `${serverName}-codex-mcp`);
  const codexDir = resolve(home, ".codex");
  mkdirSync(codexDir, { recursive: true });
  copyCodexAuth(codexDir);
  const configPath = resolve(codexDir, "config.toml");
  const typeLine = mcp.transport === "http" ? `type = "http"\n` : "";
  const config =
    `check_for_update_on_startup = false\n\n` +
    `[mcp_servers.${serverName}]\n` +
    `url = ${tomlString(mcp.server)}\n` +
    typeLine +
    `bearer_token_env_var = ${tomlString(opts.bearerTokenEnvVar)}\n` +
    // Server-level blanket approval — without it codex's default approval
    // policy blocks MCP write calls waiting for interactive confirmation,
    // which a headless eval run can never provide ("cancelled by host").
    // Confirmed against a prior working config (results/runs/stripe-mcp-codex-ok).
    `require_approval = "never"\n` +
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

function writeCodexNoMcpHome(opts: {
  paths: InvokePaths;
  surface: SurfaceId;
}): { home: string; codexDir: string; configPath: string } {
  const stem = basename(opts.paths.resultsPath).replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/\.json$/, "");
  const home = resolve(dirname(opts.paths.resultsPath), ".invoke-home", `${stem}-codex-${opts.surface}-no-mcp`);
  const codexDir = resolve(home, ".codex");
  mkdirSync(codexDir, { recursive: true });
  copyCodexAuth(codexDir);
  const configPath = resolve(codexDir, "config.toml");
  writeFileSync(
    configPath,
    `check_for_update_on_startup = false\n` +
      // Non-MCP benchmark surfaces must not inherit the operator's personal or
      // corporate MCP servers. Those can be slow, unauthenticated, or product-
      // unrelated, and they turn API/CLI/SDK cells into config-noise tests.
      `mcp_servers = {}\n`,
  );
  return { home, codexDir, configPath };
}

function writeClaudeMcpHome(opts: {
  pack: TargetPack;
  paths: InvokePaths;
  cwd: string;
  bearerTokenEnvVar: string;
}): { home: string; configPath: string; headersHelperPath: string; serverName: string } {
  const mcp = opts.pack.surfaces?.mcp;
  if (!mcp?.server) throw new Error("Pack does not declare an MCP server URL");
  const serverName = productSlug(opts.pack.name.replace(/-generated$/, ""));
  const home = resolve(dirname(opts.paths.resultsPath), ".invoke-home", `${serverName}-claude-mcp`);
  const claudeDir = resolve(home, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  const headersHelperPath = resolve(claudeDir, `${serverName}-mcp-headers-helper.js`);
  writeSecretHeaderHelper(headersHelperPath, opts.bearerTokenEnvVar);

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

  // stdio servers (an npm package run locally, e.g. Neon's MCP server) need a
  // command/args entry, NOT a url — treating the package name as a URL (the
  // previous bug here) leaves claude-code unable to ever connect. `${VAR}`
  // in args is claude-code's own documented env-var interpolation, so the
  // token never needs to be written to disk in plaintext.
  const mcpServerEntry =
    mcp.transport === "stdio"
      ? { command: "npx", args: ["-y", mcp.server, "start", `\${${opts.bearerTokenEnvVar}}`] }
      : {
          type: mcp.transport === "http" ? "http" : "streamable-http",
          url: mcp.server,
          headersHelper: `node ${JSON.stringify(headersHelperPath)}`,
        };
  const configPath = resolve(home, ".claude.json");
  const config = {
    projects: {
      [opts.cwd]: {
        mcpServers: {
          [serverName]: mcpServerEntry,
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
  if (opts.surface !== "mcp") {
    if (opts.harness !== "codex") return { env: {} };
    const codex = writeCodexNoMcpHome({ paths: opts.paths, surface: opts.surface });
    return {
      env: {
        HOME: codex.home,
        CODEX_HOME: codex.codexDir,
      },
      meta: {
        codex_home: codex.home,
        codex_config: codex.configPath,
        mcp_provisioning: "disabled_for_non_mcp_surface",
      },
    };
  }
  const auth = opts.pack.surfaces?.mcp?.auth;
  if (!auth || auth.kind === "inherit") return { env: {} };

  const bearerToken = await exchangeRefreshToken(auth);
  const bearerTokenEnvVar = `AX_EVAL_MCP_BEARER_TOKEN_${productSlug(opts.pack.name.replace(/-generated$/, "")).toUpperCase()}`;
  const authMode = auth.kind === "oauth_app" ? "oauth_refresh_to_bearer" : "env_bearer_token";

  if (opts.harness === "codex") {
    const codex = writeCodexMcpHome({ pack: opts.pack, paths: opts.paths, cwd: opts.cwd, bearerTokenEnvVar });
    return {
      env: {
        HOME: codex.home,
        CODEX_HOME: resolve(codex.home, ".codex"),
        [bearerTokenEnvVar]: bearerToken,
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
        [bearerTokenEnvVar]: bearerToken,
      },
      meta: {
        mcp_provisioning: authMode,
        claude_home: claude.home,
        claude_config: claude.configPath,
        claude_headers_helper: claude.headersHelperPath,
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
