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

function productSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "target";
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
  const configPath = resolve(codexDir, "config.toml");
  const typeLine = mcp.transport === "http" ? `type = "http"\n` : "";
  const config =
    `check_for_update_on_startup = false\n\n` +
    `[mcp_servers.${serverName}]\n` +
    `url = ${tomlString(mcp.server)}\n` +
    typeLine +
    `bearer_token_env_var = ${tomlString(opts.bearerTokenEnvVar)}\n\n` +
    `[projects.${tomlString(opts.cwd)}]\n` +
    `trust_level = "trusted"\n`;
  writeFileSync(configPath, config, { mode: 0o600 });
  try { chmodSync(configPath, 0o600); } catch { /* best effort */ }
  return { home, configPath, serverName };
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
  const auth = opts.pack.surfaces?.mcp?.auth;
  if (!auth || auth.kind === "inherit") return { env: {} };

  if (opts.harness !== "codex") {
    return {
      env: {},
      meta: {
        mcp_provisioning: "not-configured-for-harness",
        harness: opts.harness,
      },
    };
  }

  const bearerToken = await exchangeRefreshToken(auth);
  const bearerTokenEnvVar = `AX_EVAL_MCP_BEARER_TOKEN_${productSlug(opts.pack.name.replace(/-generated$/, "")).toUpperCase()}`;
  const codex = writeCodexMcpHome({ pack: opts.pack, paths: opts.paths, cwd: opts.cwd, bearerTokenEnvVar });
  return {
    env: {
      HOME: codex.home,
      CODEX_HOME: resolve(codex.home, ".codex"),
      [bearerTokenEnvVar]: bearerToken,
    },
    meta: {
      mcp_provisioning: auth.kind === "oauth_app" ? "oauth_refresh_to_bearer" : "env_bearer_token",
      codex_home: codex.home,
      codex_config: codex.configPath,
      mcp_server: codex.serverName,
    },
  };
}
