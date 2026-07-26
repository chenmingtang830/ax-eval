import type { OracleSpec, OracleVerifyContext } from "ax-eval";

export function resolveDotted(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function resolveExpected(value: unknown, ns: string | undefined): unknown {
  return typeof value === "string" && ns
    ? value.split("{ns}").join(ns)
    : value;
}

export function expectedValues(oracle: OracleSpec, ns: string | undefined): unknown[] {
  return [oracle.expected, ...(oracle.expectedAny ?? [])]
    .map((value) => resolveExpected(value, ns));
}

export function probeExpectedValues(oracle: OracleSpec, ns: string | undefined): unknown[] {
  return [oracle.probeExpected, ...(oracle.probeExpectedAny ?? [])]
    .filter((value) => value !== undefined)
    .map((value) => resolveExpected(value, ns));
}

function normalizeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.toLowerCase();
    url.protocol = url.protocol.toLowerCase();
    let path = url.pathname.replace(/\/+$/, "");
    if (path.toLowerCase() === "/index.html" || path.toLowerCase() === "/overview.html") {
      path = path.replace(/\/[^/]+$/, "");
    }
    url.pathname = path || "/";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.trim().replace(/[#?].*$/, "").replace(/\/+$/, "");
  }
}

export function valuesMatch(
  actual: unknown,
  expected: readonly unknown[],
  mode: OracleSpec["matchMode"],
): boolean {
  if (mode === "url") {
    const normalizedActual = normalizeUrl(actual);
    return expected.some((candidate) =>
      normalizedActual !== null && normalizedActual === normalizeUrl(candidate));
  }
  return expected.some((candidate) => {
    if (actual === candidate) return true;
    if (typeof actual === "string" && typeof candidate === "number"
      && actual.trim() !== "" && Number(actual) === candidate) return true;
    if (typeof candidate === "string" && typeof actual === "number"
      && candidate.trim() !== "" && Number(candidate) === actual) return true;
    return false;
  });
}

export function expectedDetail(values: readonly unknown[]): string {
  return values.length === 1
    ? JSON.stringify(values[0])
    : `[${values.map((value) => JSON.stringify(value)).join(" | ")}]`;
}

export function errorMessageFromResult(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as { code?: unknown; message?: unknown; errno?: unknown; sqlState?: unknown };
  if (typeof record.message !== "string" || !record.message.trim()) return undefined;
  const prefix = [record.code, record.errno, record.sqlState]
    .filter((part): part is string | number => typeof part === "string" || typeof part === "number")
    .join("/");
  return prefix ? `${prefix}: ${record.message}` : record.message;
}

function resolveCredentialTemplates(
  text: string,
  credentials: OracleVerifyContext["credentials"],
): string {
  return text.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
    const value = credentials[name]?.trim();
    if (!value) throw new Error(`oracle template references \${${name}}, but that credential is unset`);
    return value;
  });
}

export function applyStringTemplates(
  value: string,
  ctx: OracleVerifyContext,
  includeGid = true,
): string {
  const withNs = resolveCredentialTemplates(
    ctx.ns ? value.split("{ns}").join(ctx.ns) : value,
    ctx.credentials,
  );
  return withNs.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (match, name: string) => {
    if (name === "ns") return ctx.ns ?? match;
    if (name === "gid") return includeGid ? (ctx.reported?.gid ?? match) : match;
    const reportedValue = ctx.reported?.[name];
    return typeof reportedValue === "string" ? reportedValue : match;
  });
}

export function applyOracleTemplates(value: unknown, ctx: OracleVerifyContext): unknown {
  if (typeof value === "string") return applyStringTemplates(value, ctx);
  if (Array.isArray(value)) return value.map((entry) => applyOracleTemplates(entry, ctx));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, applyOracleTemplates(entry, ctx)]));
  }
  return value;
}
