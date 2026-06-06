/** Fetch an OpenAPI spec (live, with offline fixture fallback) and ingest it. */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseSpec, type IngestedSpec } from "./openapi.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(HERE, "..", "static", "fixtures");

export interface IngestOptions {
  /** Force offline: read the local fixture instead of the network. */
  offline?: boolean;
  timeoutMs?: number;
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
  url: string,
  opts: IngestOptions = {},
): Promise<{ text: string; source: string }> {
  if (!opts.offline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) return { text: await res.text(), source: url };
    } catch {
      /* fall through to fixture */
    }
  }
  const fx = fixtureFor(url);
  if (!fx) throw new Error(`could not fetch ${url} and no fixture available`);
  return { text: readFileSync(fx, "utf8"), source: `fixture:${fx}` };
}

export async function ingestFromUrl(url: string, opts: IngestOptions = {}): Promise<IngestedSpec> {
  const { text, source } = await fetchSpecText(url, opts);
  return parseSpec(text, source);
}
