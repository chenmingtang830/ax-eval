/**
 * Vendor resolve: given just a vendor name + category (e.g. "Supabase" /
 * "database"), call the LLM with a narrow prompt to discover the canonical
 * URLs / package names / MCP server / CLI binary that a vendor pack needs.
 * Verify each discovered URL is reachable (HEAD), then persist as a
 * committable `targets/vendors/<slug>.discovered.yaml` artifact.
 *
 * This is the entry point of the AXArena compose pipeline: it replaces
 * "human pastes docs URLs" with "tool finds them autonomously, human
 * reviews the result." The LLM output is schema-constrained (zod), the URL
 * verification is done in code, and the cache file is the single
 * reproducibility unit.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { z } from "zod";
import { invokeHarness, extractJsonObject, type HarnessId, type Effort } from "./harness.js";

/** Result of HEAD-probing a discovered URL. 401/403 still count as "exists"
 *  — auth-protected endpoints are legitimate and the verifier handles
 *  credentials at run time, not here. */
const UrlVerificationSchema = z.object({
  url: z.string(),
  ok: z.boolean(),
  status: z.number().nullable(),
  contentType: z.string().nullable(),
  note: z.string().optional(),
});
export type UrlVerification = z.infer<typeof UrlVerificationSchema>;

const ResolveResultSchema = z.object({
  vendor: z.string(),
  category: z.string(),
  /** Slug used for filenames: lowercase, hyphenated. */
  slug: z.string(),
  discovered_at: z.string(),
  resolver: z.object({
    harness: z.string(),
    model: z.string(),
    prompt_version: z.string(),
  }),
  site_url: z.string().nullable(),
  docs_urls: z.array(z.string()).default([]),
  openapi_url: z.string().nullable(),
  graphql_endpoint: z.string().nullable(),
  sdk_package: z.string().nullable(),
  sdk_language: z.string().nullable(),
  cli_bin: z.string().nullable(),
  cli_install: z.string().nullable(),
  mcp_url: z.string().nullable(),
  auth_scheme: z.string().nullable(),
  notes: z.array(z.string()).default([]),
  verification: z.record(z.string(), UrlVerificationSchema).default({}),
});
export type ResolveResult = z.infer<typeof ResolveResultSchema>;

/** The LLM is asked to return ONLY this nested object. Strict so a missing
 *  field is loud, not silently null. */
const LlmResolveSchema = z.object({
  site_url: z.string().nullable(),
  docs_urls: z.array(z.string()).max(8),
  openapi_url: z.string().nullable(),
  graphql_endpoint: z.string().nullable(),
  sdk_package: z.string().nullable(),
  sdk_language: z.string().nullable(),
  cli_bin: z.string().nullable(),
  cli_install: z.string().nullable(),
  mcp_url: z.string().nullable(),
  auth_scheme: z.string().nullable(),
  notes: z.array(z.string()).max(8).default([]),
});

export const PROMPT_VERSION = "vendor-resolve-v1";

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function buildResolvePrompt(vendor: string, category: string): string {
  return [
    `You are the AXArena vendor resolver. The benchmark is in the "${category}" category.`,
    `Resolve the canonical public URLs and package identifiers for the vendor "${vendor}" (a ${category} product).`,
    "",
    "Use WebSearch and WebFetch to find authoritative answers. The vendor name may be ambiguous —",
    `disambiguate using the category ("${category}").`,
    "",
    "Return ONLY a JSON object with EXACTLY these keys (use null for unknown, [] for empty arrays).",
    "Do not include any commentary, markdown, or extra fields:",
    "",
    "{",
    '  "site_url":          string|null,  // marketing/landing URL, e.g. "https://supabase.com"',
    '  "docs_urls":         string[],     // 1-3 most authoritative docs entry points (API reference,',
    "                                     //   getting started); avoid pricing/blog/community pages",
    '  "openapi_url":       string|null,  // raw OpenAPI/Swagger JSON or YAML; null if none public',
    '  "graphql_endpoint":  string|null,  // GraphQL API URL if applicable',
    '  "sdk_package":       string|null,  // canonical npm package name (TS/JS), e.g. "@supabase/supabase-js"',
    '  "sdk_language":      string|null,  // "node" | "python" | ... (the SDK language for sdk_package)',
    '  "cli_bin":           string|null,  // CLI binary name on $PATH, e.g. "supabase"',
    '  "cli_install":       string|null,  // install command, e.g. "brew install supabase/tap/supabase"',
    '  "mcp_url":           string|null,  // official MCP server URL (https or stdio command); null if none',
    '  "auth_scheme":       string|null,  // short description, e.g. "Bearer personal access token"',
    '  "notes":             string[]      // anything quirky the verifier should know (≤8 entries)',
    "}",
    "",
    "Constraints:",
    "- Prefer the vendor's official domain over docs aggregators.",
    "- Only include MCP if the vendor publishes a server officially (not a community fork).",
    "- For OpenAPI: if the docs page embeds the spec in Swagger UI HTML (no raw JSON endpoint),",
    "  return the Swagger UI URL and add a note about extraction. Do not invent a URL.",
    "- Output JSON ONLY. No prose, no markdown fences, no commentary.",
  ].join("\n");
}

/** HEAD-probe a URL with a short timeout. 401/403/302 still count as
 *  "exists" — they indicate a real endpoint guarded by auth/redirect. */
async function verifyUrl(url: string, timeoutMs = 8000): Promise<UrlVerification> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch(url, { method: "HEAD", signal: controller.signal });
    } catch {
      // Some servers reject HEAD; fall back to GET with no-store.
      res = await fetch(url, { method: "GET", signal: controller.signal, headers: { Range: "bytes=0-0" } });
    }
    clearTimeout(timer);
    const status = res.status;
    const ct = res.headers.get("content-type");
    const ok = status >= 200 && status < 500; // 2xx/3xx/4xx all signal "exists"; 5xx is server failure
    const note = status === 401 || status === 403
      ? "auth-protected (expected)"
      : status >= 300 && status < 400
        ? "redirect"
        : status >= 500
          ? "server error"
          : undefined;
    return UrlVerificationSchema.parse({ url, ok, status, contentType: ct, ...(note ? { note } : {}) });
  } catch (err) {
    clearTimeout(timer);
    return UrlVerificationSchema.parse({
      url,
      ok: false,
      status: null,
      contentType: null,
      note: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface ResolveVendorOptions {
  harness: HarnessId;
  model?: string;
  effort?: Effort;
  /** When set, skip verification — useful for unit tests with no network. */
  skipVerify?: boolean;
}

/** Run a vendor through the LLM resolver and URL verifier. Returns the
 *  fully-populated ResolveResult; does not write to disk. */
export async function resolveVendor(
  vendor: string,
  category: string,
  opts: ResolveVendorOptions,
): Promise<ResolveResult> {
  const prompt = buildResolvePrompt(vendor, category);
  const raw = invokeHarness(prompt, { harness: opts.harness, model: opts.model, effort: opts.effort });
  const json = extractJsonObject(raw);
  const parsed = LlmResolveSchema.safeParse(JSON.parse(json));
  if (!parsed.success) {
    throw new Error(
      `vendor-resolve for ${vendor}: LLM returned a non-conforming object: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  const data = parsed.data;

  const result: ResolveResult = {
    vendor,
    category,
    slug: slugify(vendor),
    discovered_at: new Date().toISOString(),
    resolver: {
      harness: opts.harness,
      model: opts.model ?? "host-default",
      prompt_version: PROMPT_VERSION,
    },
    site_url: data.site_url,
    docs_urls: data.docs_urls,
    openapi_url: data.openapi_url,
    graphql_endpoint: data.graphql_endpoint,
    sdk_package: data.sdk_package,
    sdk_language: data.sdk_language,
    cli_bin: data.cli_bin,
    cli_install: data.cli_install,
    mcp_url: data.mcp_url,
    auth_scheme: data.auth_scheme,
    notes: data.notes,
    verification: {},
  };

  if (!opts.skipVerify) {
    const toVerify: Array<[string, string]> = [];
    if (result.site_url) toVerify.push(["site_url", result.site_url]);
    for (const [i, u] of result.docs_urls.entries()) toVerify.push([`docs_urls[${i}]`, u]);
    if (result.openapi_url) toVerify.push(["openapi_url", result.openapi_url]);
    if (result.graphql_endpoint) toVerify.push(["graphql_endpoint", result.graphql_endpoint]);
    if (result.mcp_url) toVerify.push(["mcp_url", result.mcp_url]);
    const settled = await Promise.all(toVerify.map(([key, url]) => verifyUrl(url).then((v) => [key, v] as const)));
    for (const [key, v] of settled) result.verification[key] = v;
  }

  return result;
}

/** Path where a resolved vendor card is persisted. */
export function vendorCardPath(root: string, slug: string): string {
  return resolve(root, "targets", "vendors", `${slug}.discovered.yaml`);
}

/** Write a vendor card to disk as YAML, creating directories as needed. */
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
