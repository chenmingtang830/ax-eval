/**
 * Vendor resolve: given just a vendor name (e.g. "Supabase"), find the
 * vendor's canonical site_url + root docs_url in a few seconds.
 *
 * Two-layer strategy:
 * 1. Pure-code: HEAD-probe common URL patterns in parallel
 *    (`<slug>.com/docs`, `docs.<slug>.com`, etc.). Returns the first 200.
 *    Most vendors resolve here, in ~2-3 seconds total.
 * 2. LLM fallback (single narrow question): only when code patterns fail
 *    — typically for brand/domain mismatches (CockroachDB ↔
 *    cockroachlabs.com, MongoDB Atlas ↔ mongodb.com/docs/atlas).
 *
 * This replaces the earlier 11-field structured discovery. Per-task
 * details (SDK package, MCP URL, oracle paths) move into compose-pack,
 * where they're discovered alongside the actual task implementation.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { z } from "zod";
import { invokeHarness, extractJsonObject, type HarnessId, type Effort } from "./harness.js";

const ResolveResultSchema = z.object({
  vendor: z.string(),
  category: z.string(),
  slug: z.string(),
  discovered_at: z.string(),
  resolver: z.object({
    method: z.enum(["pattern-probe", "llm-fallback"]),
    pattern_tried: z.array(z.string()).optional(),
    harness: z.string().optional(),
    model: z.string().optional(),
    prompt_version: z.string().optional(),
  }),
  site_url: z.string().nullable(),
  docs_url: z.string().nullable(),
  http_status: z.number().nullable(),
});
export type ResolveResult = z.infer<typeof ResolveResultSchema>;

const LlmFallbackSchema = z.object({
  site_url: z.string(),
  docs_url: z.string(),
});

export const PROMPT_VERSION = "vendor-resolve-v2";

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Common URL patterns we probe in parallel. Order matters only when
 *  multiple succeed — the FIRST matching candidate wins. */
export function candidatePatterns(vendor: string): string[] {
  const slug = slugify(vendor).replace(/-/g, "");
  // Most vendors use a single-word brand without hyphens, so strip them for
  // domain construction. `slug` is preserved for filenames only.
  return [
    `https://${slug}.com/docs`,
    `https://docs.${slug}.com`,
    `https://${slug}.dev/docs`,
    `https://docs.${slug}.dev`,
    `https://${slug}.io/docs`,
    `https://docs.${slug}.io`,
    `https://${slug}.tech/docs`,
    `https://docs.${slug}.tech`,
    `https://developers.${slug}.com`,
    `https://${slug}.com/documentation`,
  ];
}

interface ProbeResult {
  url: string;
  status: number | null;
  ok: boolean;
}

async function probeHead(url: string, timeoutMs = 6000): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch(url, { method: "HEAD", signal: controller.signal, redirect: "follow" });
    } catch {
      res = await fetch(url, { method: "GET", signal: controller.signal, redirect: "follow", headers: { Range: "bytes=0-0" } });
    }
    clearTimeout(timer);
    const status = res.status;
    // 2xx and 3xx (after following) count as a real docs page. 401/403 are
    // implausible for public docs roots so they don't count here (unlike for
    // API endpoints).
    return { url: res.url || url, status, ok: status >= 200 && status < 400 };
  } catch {
    clearTimeout(timer);
    return { url, status: null, ok: false };
  }
}

function buildLlmFallbackPrompt(vendor: string, category: string, tried: string[]): string {
  return [
    `You are the AXArena vendor resolver. None of these common URL patterns returned a 2xx/3xx for the ${category} product "${vendor}":`,
    "",
    ...tried.map((u) => `  - ${u}`),
    "",
    "Use WebSearch (one query) and WebFetch (at most one fetch) to find the canonical site and",
    `root documentation URL for "${vendor}" (a ${category} product — use that to disambiguate).`,
    "",
    "Return ONLY this JSON object, no commentary:",
    "{",
    '  "site_url": string,  // marketing/landing URL, e.g. "https://cockroachlabs.com"',
    '  "docs_url": string   // root docs URL, e.g. "https://www.cockroachlabs.com/docs"',
    "}",
  ].join("\n");
}

export interface ResolveVendorOptions {
  /** When LLM fallback is needed, the harness to invoke. */
  harness?: HarnessId;
  model?: string;
  effort?: Effort;
  /** Skip the LLM fallback entirely (offline / strict mode). */
  noLlmFallback?: boolean;
}

/** Resolve a vendor's site_url + docs_url. Returns a fully-populated
 *  ResolveResult on success; throws if no pattern probes hit AND LLM
 *  fallback is disabled or fails. */
export async function resolveVendor(
  vendor: string,
  category: string,
  opts: ResolveVendorOptions = {},
): Promise<ResolveResult> {
  const slug = slugify(vendor);
  const patterns = candidatePatterns(vendor);
  const probes = await Promise.all(patterns.map((u) => probeHead(u)));
  const hit = probes.find((p) => p.ok);
  if (hit) {
    return ResolveResultSchema.parse({
      vendor,
      category,
      slug,
      discovered_at: new Date().toISOString(),
      resolver: { method: "pattern-probe", pattern_tried: patterns },
      site_url: new URL(hit.url).origin,
      docs_url: hit.url,
      http_status: hit.status,
    });
  }

  if (opts.noLlmFallback) {
    throw new Error(
      `vendor-resolve: no URL pattern matched for "${vendor}" and LLM fallback is disabled.\n  Tried:\n${patterns.map((u) => `    - ${u}`).join("\n")}`,
    );
  }

  // LLM fallback.
  const harness = opts.harness ?? "claude-code";
  const prompt = buildLlmFallbackPrompt(vendor, category, patterns);
  const raw = invokeHarness(prompt, { harness, model: opts.model, effort: opts.effort });
  const parsed = LlmFallbackSchema.safeParse(JSON.parse(extractJsonObject(raw)));
  if (!parsed.success) {
    throw new Error(
      `vendor-resolve LLM fallback for "${vendor}" returned non-conforming JSON: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  // Quick verification that the LLM didn't hallucinate.
  const verify = await probeHead(parsed.data.docs_url);
  return ResolveResultSchema.parse({
    vendor,
    category,
    slug,
    discovered_at: new Date().toISOString(),
    resolver: {
      method: "llm-fallback",
      pattern_tried: patterns,
      harness,
      model: opts.model ?? "host-default",
      prompt_version: PROMPT_VERSION,
    },
    site_url: parsed.data.site_url,
    docs_url: parsed.data.docs_url,
    http_status: verify.status,
  });
}

/** Path where a resolved vendor card is persisted. */
export function vendorCardPath(root: string, slug: string): string {
  return resolve(root, "targets", "vendors", `${slug}.discovered.yaml`);
}

/** Write a vendor card to disk as YAML. */
export function writeVendorCard(root: string, result: ResolveResult): string {
  const path = vendorCardPath(root, result.slug);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yamlStringify(result));
  return path;
}

/** Load a previously-resolved vendor card. */
export function loadVendorCard(root: string, slug: string): ResolveResult | null {
  const path = vendorCardPath(root, slug);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const parsed = yamlParse(raw);
  const result = ResolveResultSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`vendor card at ${path} is malformed: ${result.error.issues.map((i) => i.message).join("; ")}`);
  }
  return result.data;
}
