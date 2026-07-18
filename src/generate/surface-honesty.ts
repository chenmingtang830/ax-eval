/**
 * Trajectory surface-honesty: declared `api` cells must not pass solely via
 * SQL wire / node-pg SDK when no HTTP call to the pack API host was observed.
 */
import type { TargetPack } from "../schemas.js";
import type { SurfaceId } from "../surface/types.js";
import { resolveEnvTemplate } from "../target/config.js";

export interface SurfaceHonestyInput {
  wireSignals: string[];
  apiCalls: Array<{ host: string }>;
}

export interface SurfaceHonestyGrade {
  passed: boolean;
  detail: string;
  wireSignals: string[];
  controlPlaneCalls: number;
}

function packApiHost(pack: TargetPack): string {
  try {
    return new URL(resolveEnvTemplate(pack.base_url)).host.toLowerCase();
  } catch {
    try {
      return new URL(pack.base_url).host.toLowerCase();
    } catch {
      return "";
    }
  }
}

/** Detect SQL-wire / pg-client signals in a shell or script body. */
export function detectWireSignals(cmd: string): string[] {
  if (!cmd) return [];
  const hits: string[] = [];
  if (/\bpsql\b/i.test(cmd)) hits.push("psql");
  if (/\brequire\(['"]pg['"]\)|from ['"]pg['"]|import\s+.*\bfrom\s+['"]pg['"]/i.test(cmd)) hits.push("pg");
  if (/\b@libsql\/client\b|libsql:\/\//i.test(cmd)) hits.push("libsql");
  if (/\bprocess\.env\.[A-Z0-9_]*(?:DATABASE_URL|DB_URL|CONNECTION_STRING)\b/.test(cmd)) {
    hits.push("sql_env");
  }
  if (/\$[A-Z0-9_]*(?:DATABASE_URL|DB_URL|CONNECTION_STRING)\b/.test(cmd)) {
    hits.push("sql_env");
  }
  if (/\bnew\s+Client\s*\(|\.connect\s*\([^)]*(?:DATABASE_URL|CONNECTION_STRING|DB_URL)/i.test(cmd)) {
    hits.push("pg_client");
  }
  return [...new Set(hits)];
}

/**
 * For `api` surface only: fail when wire/SQL SDK signals are present and no
 * HTTP call hit the pack's API host. CLI/SDK/MCP cells are not gated here.
 */
export function gradeSurfaceHonesty(
  run: SurfaceHonestyInput,
  surface: SurfaceId,
  pack: TargetPack,
): SurfaceHonestyGrade {
  if (surface !== "api") {
    return {
      passed: true,
      detail: `surface=${surface}; honesty gate applies to api only`,
      wireSignals: run.wireSignals ?? [],
      controlPlaneCalls: 0,
    };
  }
  const host = packApiHost(pack);
  const wireSignals = [...(run.wireSignals ?? [])];
  const controlPlaneCalls = host
    ? run.apiCalls.filter((c) => c.host.toLowerCase() === host).length
    : run.apiCalls.length;
  if (wireSignals.length === 0) {
    return {
      passed: true,
      detail: "no SQL-wire / pg-SDK signals in transcript",
      wireSignals,
      controlPlaneCalls,
    };
  }
  if (controlPlaneCalls > 0) {
    return {
      passed: true,
      detail: `wire signals present (${wireSignals.join(",")}) but ${controlPlaneCalls} HTTP call(s) hit pack API host`,
      wireSignals,
      controlPlaneCalls,
    };
  }
  return {
    passed: false,
    detail:
      `declared api cell used SQL wire/SDK only (${wireSignals.join(",")}); ` +
      `no HTTP calls to pack API host${host ? ` ${host}` : ""}`,
    wireSignals,
    controlPlaneCalls,
  };
}
