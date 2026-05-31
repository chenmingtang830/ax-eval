/**
 * The fetcher used by static checks: real network first, offline fixtures as a
 * fallback so the audit (and its tests) run even with no connectivity.
 *
 * A "fixture" is a saved sample response. When `mode: "fixture"` (or the live
 * fetch fails and `fallbackToFixture` is on), we read from src/static/fixtures/
 * instead of the network. This keeps the keyless, networkless path working.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(HERE, "fixtures");

export interface FetchResult {
  /** HTTP status, or 0 if the request never completed. */
  status: number;
  ok: boolean;
  body: string;
  /** Lowercased response headers (empty for fixtures). */
  headers: Record<string, string>;
  /** Whether this came from the live network or a fixture file. */
  source: "live" | "fixture";
}

export interface FetcherOptions {
  mode?: "live" | "fixture";
  /** If a live fetch throws/times out, fall back to a fixture. Default true. */
  fallbackToFixture?: boolean;
  /** Per-request timeout in ms. Default 8000. */
  timeoutMs?: number;
}

/** Map a URL to its fixture filename: the flattened host + path. The root path
 *  uses a reserved `__root__` segment that can't collide with a real path (a
 *  literal "/index" would otherwise map to the same file). The query string is
 *  included so URLs differing only by query don't collide. No extension is
 *  forced, so a URL ending in .txt/.json keeps its own. */
export function fixtureName(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "/__root__" : u.pathname.replace(/\/+$/, "");
    return (u.host + path + u.search).replace(/[^a-zA-Z0-9._-]/g, "_");
  } catch {
    return url.replace(/[^a-zA-Z0-9._-]/g, "_");
  }
}

/** Read a fixture for `url`. Returns a 200 with body when the file exists, or a
 *  fixture-sourced 404 when it doesn't, plus a `found` flag so callers can tell
 *  "fixture present" from "fixture missing" without inspecting status/body. */
function readFixture(url: string): FetchResult & { found: boolean } {
  const file = resolve(FIXTURE_DIR, fixtureName(url));
  if (existsSync(file)) {
    return { status: 200, ok: true, body: readFileSync(file, "utf8"), headers: {}, source: "fixture", found: true };
  }
  return { status: 404, ok: false, body: "", headers: {}, source: "fixture", found: false };
}

export class Fetcher {
  readonly mode: "live" | "fixture";
  private readonly fallback: boolean;
  private readonly timeoutMs: number;

  constructor(opts: FetcherOptions = {}) {
    this.mode = opts.mode ?? "live";
    this.fallback = opts.fallbackToFixture ?? true;
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  async get(url: string): Promise<FetchResult> {
    if (this.mode === "fixture") {
      const { found: _f, ...r } = readFixture(url);
      return r;
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const resp = await fetch(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: { "user-agent": "ax-eval-static-audit/0.0.1" },
      });
      clearTimeout(timer);
      const headers: Record<string, string> = {};
      resp.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
      const body = await resp.text();
      return { status: resp.status, ok: resp.ok, body, headers, source: "live" };
    } catch (err) {
      if (this.fallback) {
        const { found, ...r } = readFixture(url);
        // Only treat a fixture as a real fallback when one actually exists;
        // otherwise report a network error (status 0) so the check can mark
        // itself "errored" rather than silently scoring the surface absent.
        if (found) return r;
      }
      return { status: 0, ok: false, body: "", headers: {}, source: "live" };
    }
  }
}
