/** Fetch an OpenAPI spec (live, with offline fixture fallback) and ingest it. */
import { lookup } from "node:dns/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseSpec, type IngestedSpec } from "./openapi.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(HERE, "..", "static", "fixtures");

export interface IngestOptions {
  /** Force offline: read a local path or, when allowed, a bundled fixture. */
  offline?: boolean;
  timeoutMs?: number;
  /** Refuse bundled fixture fallback when the caller requires this exact source. */
  allowFixtureFallback?: boolean;
  /** Require explicit opt-in before reading a local source path. */
  allowLocalFiles?: boolean;
  /** Restrict live requests and every redirect to these official URL roots. */
  allowedRemoteRoots?: readonly string[];
  /** Resolve hosts before requesting and reject non-public network addresses. */
  rejectPrivateNetwork?: boolean;
  /** Maximum accepted source size in bytes. */
  maxBytes?: number;
  /** Test seam for deterministic DNS policy checks. */
  resolveHost?: (hostname: string) => Promise<readonly string[]>;
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isPublicIpAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%", 1)[0]!;
  const family = isIP(normalized);
  if (family === 4) return isPublicIpv4(normalized);
  if (family !== 6) return false;
  if (normalized === "::" || normalized === "::1") return false;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized)) return false;
  if (normalized.startsWith("ff") || normalized.startsWith("2001:db8:")) return false;
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mapped ? isPublicIpv4(mapped) : true;
}

function usesAllowedRemoteHost(value: string, roots: readonly string[]): boolean {
  const host = new URL(value).hostname.toLowerCase();
  return roots.some((root) => {
    const officialHost = new URL(root).hostname.toLowerCase();
    return host === officialHost || host.endsWith(`.${officialHost}`);
  });
}

async function assertRemoteSource(value: string, opts: IngestOptions): Promise<URL> {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`spec source must use http or https: ${value}`);
  if (url.username || url.password) throw new Error(`spec source cannot contain credentials: ${value}`);
  if (opts.allowedRemoteRoots && !usesAllowedRemoteHost(value, opts.allowedRemoteRoots)) {
    throw new Error(`spec source uses a non-official host: ${value}`);
  }
  if (!opts.rejectPrivateNetwork) return url;
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error(`spec source resolves to a private network host: ${value}`);
  }
  const addresses = isIP(hostname) === 0
    ? await (opts.resolveHost ?? (async (host) => (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address)))(hostname)
    : [hostname];
  if (addresses.length === 0 || addresses.some((address) => !isPublicIpAddress(address))) {
    throw new Error(`spec source resolves to a private or non-routable address: ${value}`);
  }
  return url;
}

async function readBoundedResponse(response: Response, maxBytes?: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (maxBytes && Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`spec source exceeds ${maxBytes} bytes`);
  }
  if (!response.body) {
    const text = await response.text();
    if (maxBytes && Buffer.byteLength(text) > maxBytes) throw new Error(`spec source exceeds ${maxBytes} bytes`);
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (maxBytes && total > maxBytes) {
      await reader.cancel();
      throw new Error(`spec source exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Map a spec URL to a bundled fixture filename (host_path flattened). */
function fixtureFor(url: string): string | null {
  try {
    const u = new URL(url);
    const flat = (u.host + u.pathname).replace(/[^a-zA-Z0-9._-]/g, "_");
    const candidate = resolve(FIXTURE_DIR, flat);
    if (existsSync(candidate)) return candidate;
  } catch {
    /* ignore */
  }
  // Generic local fallback used by the demo/tests.
  const demo = resolve(FIXTURE_DIR, "asana.com_openapi.json");
  return existsSync(demo) ? demo : null;
}

/** Fetch raw spec text (live, with offline fixture fallback). Returns the text
 *  plus its provenance so callers can parse it however they need (ingest into a
 *  CRUD model, or run the content-quality smell audit on the raw document). */
export async function fetchSpecText(
  source: string,
  opts: IngestOptions = {},
): Promise<{ text: string; source: string }> {
  if (existsSync(source)) {
    if (opts.allowLocalFiles === false) throw new Error(`local spec sources require explicit offline mode: ${source}`);
    const stat = statSync(source);
    if (!stat.isFile()) throw new Error(`local spec source must be a file: ${source}`);
    if (opts.maxBytes && stat.size > opts.maxBytes) throw new Error(`spec source exceeds ${opts.maxBytes} bytes`);
    return { text: readFileSync(source, "utf8"), source };
  }
  if (!opts.offline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20000);
    try {
      let current = await assertRemoteSource(source, opts);
      for (let redirects = 0; redirects <= 5; redirects++) {
        const res = await fetch(current, { signal: controller.signal, redirect: "manual" });
        const responseUrl = res.url || current.href;
        await assertRemoteSource(responseUrl, opts);
        if (res.status >= 300 && res.status < 400) {
          if (redirects === 5) throw new Error(`spec source exceeded redirect limit: ${source}`);
          const location = res.headers.get("location");
          if (!location) throw new Error(`spec source redirect is missing a location: ${responseUrl}`);
          current = await assertRemoteSource(new URL(location, current).href, opts);
          continue;
        }
        if (res.ok) return { text: await readBoundedResponse(res, opts.maxBytes), source: responseUrl };
        break;
      }
    } catch (error) {
      if (opts.allowFixtureFallback === false) {
        if (error instanceof Error && /^(?:spec source|local spec source)/.test(error.message)) throw error;
        throw new Error(`could not fetch exact spec source ${source}: ${error instanceof Error ? error.message : String(error)}`);
      }
      /* fall through to fixture */
    } finally {
      clearTimeout(timer);
    }
  }
  if (opts.allowFixtureFallback === false) {
    throw new Error(`could not fetch exact spec source ${source}`);
  }
  const fx = fixtureFor(source);
  if (!fx) throw new Error(`could not fetch ${source} and no fixture available`);
  return { text: readFileSync(fx, "utf8"), source: `fixture:${fx}` };
}

export async function ingestFromUrl(url: string, opts: IngestOptions = {}): Promise<IngestedSpec> {
  const { text, source } = await fetchSpecText(url, opts);
  return parseSpec(text, source);
}
