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

/** Map a spec URL to a bundled fixture filename (host_path flattened). Returns
 *  the path only if a URL-specific fixture exists; no generic fallback. */
function fixtureFor(url: string): string | null {
  try {
    const u = new URL(url);
    const flat = (u.host + u.pathname).replace(/[^a-zA-Z0-9._-]/g, "_");
    const candidate = resolve(FIXTURE_DIR, flat);
    if (existsSync(candidate)) return candidate;
  } catch {
    /* ignore */
  }
  return null;
}

/** Fetch raw spec text. Live mode fetches the URL and errors loudly on
 *  failure — we used to silently fall back to a generic Asana demo fixture
 *  on live-fetch failure, which masked broken URLs as successful ingests.
 *  Offline mode reads only a URL-specific fixture and errors if none exists. */
export async function fetchSpecText(
  url: string,
  opts: IngestOptions = {},
): Promise<{ text: string; source: string }> {
  if (!opts.offline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20000);
    let res: Response;
    try {
      res = await fetch(url, { signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      throw new Error(`fetch ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    clearTimeout(timer);
    if (!res.ok) throw new Error(`fetch ${url} returned ${res.status} ${res.statusText}`);
    return { text: await res.text(), source: url };
  }
  const fx = fixtureFor(url);
  if (!fx) throw new Error(`offline mode: no fixture for ${url} under ${FIXTURE_DIR}`);
  return { text: readFileSync(fx, "utf8"), source: `fixture:${fx}` };
}

export async function ingestFromUrl(url: string, opts: IngestOptions = {}): Promise<IngestedSpec> {
  const { text, source } = await fetchSpecText(url, opts);
  return parseSpec(text, source);
}
