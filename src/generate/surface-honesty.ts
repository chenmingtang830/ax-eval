import type { SurfaceId } from "../surface/types.js";

export type WireSignal = "psql" | "pg-driver" | "python-postgres" | "libsql" | "sql-connection-url" | "sql-env";

export interface SurfaceHonestyInput {
  wireSignals: readonly WireSignal[];
  observedHttpHosts: readonly string[];
}

export interface SurfaceHonestyGrade {
  status: "pass" | "fail" | "not_applicable";
  passed: boolean;
  reason: "non-api-surface" | "no-wire-signals" | "api-host-observed" | "expected-api-host-missing" | "wire-only-api-cell";
  wireSignals: WireSignal[];
  expectedApiHosts: string[];
  observedApiCalls: number;
  detail: string;
}

function normalizeHost(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!hostname || /[%${}\s]/.test(hostname)) return null;
    if (hostname.startsWith("[") && hostname.endsWith("]")) {
      return /^[0-9a-f:[\].]+$/i.test(hostname) ? hostname : null;
    }
    const labels = hostname.split(".");
    if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
    return hostname;
  } catch {
    return null;
  }
}

export function detectWireSignals(command: string): WireSignal[] {
  if (!command) return [];
  const signals: WireSignal[] = [];
  if (/\bpsql\b/i.test(command)) signals.push("psql");
  if (/\brequire\(['"]pg['"]\)|\bfrom\s+['"]pg['"]|\bimport\s+.*\bfrom\s+['"]pg['"]|\bnew\s+(?:pg\.)?Client\s*\(/i.test(command)) {
    signals.push("pg-driver");
  }
  if (/\b(?:psycopg|psycopg2|asyncpg)\b/i.test(command)) signals.push("python-postgres");
  if (/\b@libsql\/client\b|\blibsql:\/\//i.test(command)) signals.push("libsql");
  if (/\b(?:postgres(?:ql)?|mysql|mariadb):\/\//i.test(command)) signals.push("sql-connection-url");
  if (/\bprocess\.env\.[A-Z0-9_]*(?:DATABASE_URL|DB_URL|CONNECTION_STRING)\b/.test(command)
    || /\$\{?[A-Z0-9_]*(?:DATABASE_URL|DB_URL|CONNECTION_STRING)\}?\b/.test(command)) {
    signals.push("sql-env");
  }
  return [...new Set(signals)];
}

export function gradeSurfaceHonesty(options: {
  surface: SurfaceId;
  expectedApiHosts: readonly string[];
  run: SurfaceHonestyInput;
}): SurfaceHonestyGrade {
  const wireSignals = [...new Set(options.run.wireSignals)].sort();
  const expectedApiHosts = [...new Set(options.expectedApiHosts.flatMap((host) => {
    const normalized = normalizeHost(host);
    return normalized ? [normalized] : [];
  }))].sort();
  if (options.surface !== "api") {
    return {
      status: "not_applicable",
      passed: true,
      reason: "non-api-surface",
      wireSignals,
      expectedApiHosts,
      observedApiCalls: 0,
      detail: `surface=${options.surface}; API channel honesty is not applicable`,
    };
  }
  if (wireSignals.length === 0) {
    return {
      status: "pass",
      passed: true,
      reason: "no-wire-signals",
      wireSignals,
      expectedApiHosts,
      observedApiCalls: 0,
      detail: "no SQL-wire or database-driver signals were observed",
    };
  }
  if (expectedApiHosts.length === 0) {
    return {
      status: "fail",
      passed: false,
      reason: "expected-api-host-missing",
      wireSignals,
      expectedApiHosts,
      observedApiCalls: 0,
      detail: "wire signals were observed, but no valid expected API host was configured",
    };
  }
  const observedHosts = options.run.observedHttpHosts.flatMap((host) => {
    const normalized = normalizeHost(host);
    return normalized ? [normalized] : [];
  });
  const observedApiCalls = observedHosts.filter((host) => expectedApiHosts.includes(host)).length;
  if (observedApiCalls > 0) {
    return {
      status: "pass",
      passed: true,
      reason: "api-host-observed",
      wireSignals,
      expectedApiHosts,
      observedApiCalls,
      detail: `${observedApiCalls} HTTP call(s) reached an expected API host despite wire signals`,
    };
  }
  return {
    status: "fail",
    passed: false,
    reason: "wire-only-api-cell",
    wireSignals,
    expectedApiHosts,
    observedApiCalls: 0,
    detail: "declared API cell showed database-wire activity without an HTTP call to an expected API host",
  };
}
