import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import type { TargetPack, SurfaceAuth } from "../schemas.js";
import type { SurfaceId } from "../surface/types.js";
import type { InvokeHarnessId, InvokePaths } from "./invoke.js";

export interface HarnessProvisioning {
  /** Environment overrides for the harness child process. */
  env: Record<string, string>;
  /** Non-secret metadata safe to persist in invoke meta artifacts. */
  meta?: Record<string, unknown>;
}

function env(
  name: string | undefined,
  source: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  return name ? source[name]?.trim() || undefined : undefined;
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

function copyCodexAuth(
  codexDir: string,
  source: Readonly<Record<string, string | undefined>> = process.env,
): void {
  // Reuse the operator's own `codex login` session instead of requiring a
  // separate OPENAI_API_KEY: codex CLI stores it in a plain file (unlike
  // claude-code, which is Keychain-based and doesn't transfer to a fresh
  // isolated HOME).
  const realAuthPath = resolve(homedir(), ".codex", "auth.json");
  if (!source.OPENAI_API_KEY && existsSync(realAuthPath)) {
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

async function exchangeRefreshToken(
  auth: SurfaceAuth,
  source: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> {
  if (auth.kind === "token") {
    const token = env(auth.token_env, source);
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
  const clientId = env(auth.client_id_env, source);
  const clientSecret = env(auth.client_secret_env, source);
  const refreshToken = env(auth.refresh_token_env, source);
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
    redirect: "error",
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
  env?: Readonly<Record<string, string | undefined>>;
  allowAmbientHarnessAuth?: boolean;
}): { home: string; configPath: string; serverName: string } {
  const mcp = opts.pack.surfaces?.mcp;
  if (!mcp?.server) throw new Error("Pack does not declare an MCP server");
  const serverName = productSlug(opts.pack.name.replace(/-generated$/, ""));
  const stem = basename(opts.paths.resultsPath).replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/\.json$/, "");
  const home = resolve(dirname(opts.paths.resultsPath), ".invoke-home", `${stem}-${serverName}-codex-mcp`);
  const codexDir = resolve(home, ".codex");
  rmSync(home, { recursive: true, force: true });
  mkdirSync(codexDir, { recursive: true });
  if (opts.allowAmbientHarnessAuth !== false) copyCodexAuth(codexDir, opts.env);
  const configPath = resolve(codexDir, "config.toml");
  const connection = mcp.transport === "stdio"
    ? (() => {
        const command = mcp.args.length === 0 && mcp.server === "exa-mcp-server" ? "npx" : mcp.server;
        const args = command === "npx" && mcp.server === "exa-mcp-server"
          ? ["-y", "exa-mcp-server"]
          : mcp.args;
        return `command = ${tomlString(command)}\nargs = ${tomlArray(args)}\n`;
      })()
    : `url = ${tomlString(mcp.server)}\ntype = "http"\n`;
  const authLine = opts.bearerTokenEnvVar
    ? `bearer_token_env_var = ${tomlString(opts.bearerTokenEnvVar)}\n`
    : "";
  const config =
    `check_for_update_on_startup = false\n\n` +
    `[mcp_servers.${serverName}]\n` +
    connection +
    authLine +
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
  env?: Readonly<Record<string, string | undefined>>;
  allowAmbientHarnessAuth?: boolean;
}): { home: string; codexDir: string; configPath: string } {
  const stem = basename(opts.paths.resultsPath).replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/\.json$/, "");
  const home = resolve(dirname(opts.paths.resultsPath), ".invoke-home", `${stem}-codex-${opts.surface}-no-mcp`);
  const codexDir = resolve(home, ".codex");
  rmSync(home, { recursive: true, force: true });
  mkdirSync(codexDir, { recursive: true });
  if (opts.allowAmbientHarnessAuth !== false) copyCodexAuth(codexDir, opts.env);
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
  bearerTokenEnvVar?: string;
}): { home: string; configPath: string; headersHelperPath?: string; serverName: string } {
  const mcp = opts.pack.surfaces?.mcp;
  if (!mcp?.server) throw new Error("Pack does not declare an MCP server");
  const serverName = productSlug(opts.pack.name.replace(/-generated$/, ""));
  const stem = basename(opts.paths.resultsPath).replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/\.json$/, "");
  const home = resolve(dirname(opts.paths.resultsPath), ".invoke-home", `${stem}-${serverName}-claude-mcp`);
  const claudeDir = resolve(home, ".claude");
  rmSync(home, { recursive: true, force: true });
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

  const mcpServerEntry = mcp.transport === "stdio"
    ? {
        type: "stdio",
        command: mcp.args.length === 0 && mcp.server === "exa-mcp-server" ? "npx" : mcp.server,
        args: mcp.args.length === 0 && mcp.server === "exa-mcp-server"
          ? ["-y", "exa-mcp-server"]
          : mcp.args,
      }
    : {
        type: "http",
        url: mcp.server,
        ...(headersHelperPath ? { headersHelper: `node ${JSON.stringify(headersHelperPath)}` } : {}),
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

function writeClaudeNoMcpHome(paths: InvokePaths): { home: string; configPath: string } {
  const stem = basename(paths.resultsPath).replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/\.json$/, "");
  const home = resolve(dirname(paths.resultsPath), ".invoke-home", `${stem}-claude-no-mcp`);
  const claudeDir = resolve(home, ".claude");
  rmSync(home, { recursive: true, force: true });
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(resolve(claudeDir, "settings.json"), `${JSON.stringify({
    permissions: { defaultMode: "bypassPermissions" },
  }, null, 2)}\n`, { mode: 0o600 });
  const configPath = resolve(home, ".claude.json");
  writeFileSync(configPath, `${JSON.stringify({ projects: {} }, null, 2)}\n`, { mode: 0o600 });
  return { home, configPath };
}

function prependPath(dir: string, currentPath = process.env.PATH ?? ""): string {
  return currentPath ? `${dir}:${currentPath}` : dir;
}

function ensureTursoCli(
  paths: InvokePaths,
  source: Readonly<Record<string, string | undefined>> = process.env,
  allowDownloads = true,
): { home: string; binDir: string; binaryPath: string } {
  const sharedHome = resolve(dirname(paths.resultsPath), ".invoke-home", "turso-cli-shared");
  const binaryPath = resolve(sharedHome, ".turso", "turso");
  if (existsSync(binaryPath)) {
    return { home: sharedHome, binDir: dirname(binaryPath), binaryPath };
  }
  if (!allowDownloads) {
    const found = spawnSync("/usr/bin/which", ["turso"], {
      env: source as NodeJS.ProcessEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).stdout?.trim();
    if (found && existsSync(found)) {
      return { home: source.HOME ?? "", binDir: dirname(found), binaryPath: found };
    }
    throw new Error("automatic Turso CLI download is disabled for cell runs; install a pinned turso binary first");
  }
  rmSync(sharedHome, { recursive: true, force: true });
  mkdirSync(sharedHome, { recursive: true });
  const install = spawnSync("/bin/sh", ["-lc", "curl -sSfL https://get.tur.so/install.sh | bash"], {
    cwd: dirname(paths.resultsPath),
    env: {
      ...source,
      HOME: sharedHome,
      PATH: source.PATH ?? "",
    },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (install.status !== 0 || !existsSync(binaryPath)) {
    const detail = (install.stderr || install.stdout || `exit ${install.status ?? "unknown"}`).trim();
    throw new Error(`failed to provision shared Turso CLI: ${detail.slice(0, 500)}`);
  }
  return { home: sharedHome, binDir: dirname(binaryPath), binaryPath };
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
  env?: Readonly<Record<string, string | undefined>>;
  allowDownloads?: boolean;
  allowAmbientHarnessAuth?: boolean;
}): Promise<HarnessProvisioning> {
  const source = opts.env ?? process.env;
  const tursoCli =
    opts.surface === "cli" && opts.pack.name === "turso"
      ? ensureTursoCli(opts.paths, source, opts.allowDownloads !== false)
      : undefined;
  if (opts.surface !== "mcp") {
    if (opts.harness === "claude-code") {
      if (opts.allowAmbientHarnessAuth !== false) {
        return tursoCli
          ? {
              env: { PATH: prependPath(tursoCli.binDir, source.PATH) },
              meta: {
                shared_cli_home: tursoCli.home,
                shared_cli_binary: tursoCli.binaryPath,
              },
            }
          : { env: {} };
      }
      const claude = writeClaudeNoMcpHome(opts.paths);
      return {
        env: {
          HOME: claude.home,
          ...(tursoCli ? { PATH: prependPath(tursoCli.binDir, source.PATH) } : {}),
        },
        meta: {
          claude_home: claude.home,
          claude_config: claude.configPath,
          mcp_provisioning: "disabled_for_non_mcp_surface",
          ...(tursoCli
            ? { shared_cli_home: tursoCli.home, shared_cli_binary: tursoCli.binaryPath }
            : {}),
        },
      };
    }
    if (opts.harness !== "codex") {
      return tursoCli
        ? {
            env: {
              PATH: prependPath(tursoCli.binDir, source.PATH),
            },
            meta: {
              shared_cli_home: tursoCli.home,
              shared_cli_binary: tursoCli.binaryPath,
            },
          }
        : { env: {} };
    }
    const codex = writeCodexNoMcpHome({
      paths: opts.paths,
      surface: opts.surface,
      env: source,
      allowAmbientHarnessAuth: opts.allowAmbientHarnessAuth,
    });
    return {
      env: {
        HOME: codex.home,
        CODEX_HOME: codex.codexDir,
        ...(tursoCli ? { PATH: prependPath(tursoCli.binDir, source.PATH) } : {}),
      },
      meta: {
        codex_home: codex.home,
        codex_config: codex.configPath,
        mcp_provisioning: "disabled_for_non_mcp_surface",
        ...(tursoCli
          ? {
              shared_cli_home: tursoCli.home,
              shared_cli_binary: tursoCli.binaryPath,
            }
          : {}),
      },
    };
  }
  const mcp = opts.pack.surfaces?.mcp;
  if (!mcp) return { env: {} };
  const downloadLaunchers = new Set(["npx", "npm", "pnpm", "yarn", "bunx", "uvx"]);
  if (opts.allowDownloads === false && mcp.transport === "stdio" && downloadLaunchers.has(basename(mcp.server))) {
    throw new Error(`runtime package launcher ${mcp.server} is disabled for cell runs; declare a pinned preinstalled server command`);
  }
  if (
    opts.allowDownloads === false
    && mcp.transport === "stdio"
    && mcp.args.length === 0
    && mcp.server === "exa-mcp-server"
  ) {
    throw new Error("automatic npx MCP download is disabled for cell runs; declare a pinned preinstalled server command");
  }
  const auth = mcp.auth;
  let bearerToken: string | undefined;
  let bearerTokenEnvVar: string | undefined;
  let stdioTokenEnv: Record<string, string> = {};
  let authMode = "stdio_inherit";

  if (mcp.transport === "stdio") {
    if (auth?.kind === "oauth_app") throw new Error("stdio MCP servers must use inherit or token auth");
    if (auth?.kind === "token") {
      bearerToken = env(auth.token_env, source) ?? auth.token_env_aliases.map((name) => env(name, source)).find(Boolean);
      if (!bearerToken || !auth.token_env) throw new Error(`Missing MCP token env ${auth.token_env}`);
      stdioTokenEnv = { [auth.token_env]: bearerToken };
      authMode = "stdio_env_token";
    } else {
      const inheritedEnv = opts.pack.auth?.env;
      const inheritedToken = env(inheritedEnv, source)
        ?? (opts.pack.auth?.env_aliases ?? []).map((name) => env(name, source)).find(Boolean);
      if (inheritedEnv && inheritedToken) stdioTokenEnv = { [inheritedEnv]: inheritedToken };
    }
  } else if (!auth || auth.kind === "inherit") {
    const inheritedEnv = opts.pack.auth?.env;
    bearerToken = env(inheritedEnv, source)
      ?? (opts.pack.auth?.env_aliases ?? []).map((name) => env(name, source)).find(Boolean);
    if (bearerToken) {
      bearerTokenEnvVar = `AX_EVAL_MCP_BEARER_TOKEN_${productSlug(opts.pack.name.replace(/-generated$/, "")).toUpperCase()}`;
      authMode = "inherited_env_bearer_token";
    } else {
      authMode = "http_no_auth";
    }
  } else {
    bearerToken = await exchangeRefreshToken(auth, source);
    bearerTokenEnvVar = `AX_EVAL_MCP_BEARER_TOKEN_${productSlug(opts.pack.name.replace(/-generated$/, "")).toUpperCase()}`;
    authMode = auth.kind === "oauth_app" ? "oauth_refresh_to_bearer" : "env_bearer_token";
  }

  if (opts.harness === "codex") {
    const codex = writeCodexMcpHome({
      pack: opts.pack,
      paths: opts.paths,
      cwd: opts.cwd,
      bearerTokenEnvVar,
      env: source,
      allowAmbientHarnessAuth: opts.allowAmbientHarnessAuth,
    });
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
