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

/** Map a URL to its fixture filename: the flattened host + path (root → _index).
 *  No extension is forced, so a URL ending in .txt/.json keeps its own. */
export function fixtureName(url: string): string {
  try {
    const u = new URL(url);
    const path = (u.pathname === "/" ? "/index" : u.pathname).replace(/\/+$/, "");
    return (u.host + path).replace(/[^a-zA-Z0-9._-]/g, "_");
  } catch {
    return url.replace(/[^a-zA-Z0-9._-]/g, "_");
  }
}

function readFixture(url: string): FetchResult {
  const file = resolve(FIXTURE_DIR, fixtureName(url));
  if (existsSync(file)) {
    return { status: 200, ok: true, body: readFileSync(file, "utf8"), headers: {}, source: "fixture" };
  }
  return { status: 404, ok: false, body: "", headers: {}, source: "fixture" };
}

export class Fetcher {
  readonly mode: "live" | "fixture";
  private readonly fallback: boolean;
  private readonly timeoutMs: number;
  /** Set to "fixture" if any request had to fall back, so the audit can label itself. */
  usedFixture = false;

  constructor(opts: FetcherOptions = {}) {
    this.mode = opts.mode ?? "live";
    this.fallback = opts.fallbackToFixture ?? true;
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  async get(url: string): Promise<FetchResult> {
    if (this.mode === "fixture") {
      const r = readFixture(url);
      this.usedFixture = true;
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
        const r = readFixture(url);
        if (r.body || r.status !== 404) {
          this.usedFixture = true;
          return r;
        }
      }
      return { status: 0, ok: false, body: "", headers: {}, source: "live" };
    }
  }
}
