/**
 * Surface extract: discover a vendor's CLI/SDK/MCP surfaces so exec-plan can
 * fan out --surface all instead of api-only.
 *
 * This is deliberately separate from oracle-extract: the round-trip oracle
 * NEVER changes per surface (verification always reads state back via the
 * REST/SQL data plane, regardless of how the agent created it — see
 * schemas.ts's SurfaceAuthSchema docstring). Surface declarations only
 * change how the AGENT is told to act, so this step doesn't touch the
 * already-verified oracles at all, and is comparatively low-risk to add.
 *
 * One grounded LLM call per vendor, same requireWebFetch discipline as the
 * rest of the pipeline.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { z } from "zod";
import { invokeHarness, extractJsonObject, type HarnessId, type Effort } from "./harness.js";
import type { ResolveResult } from "./vendor-resolve.js";

const SurfaceAuthExtractSchema = z.object({
  kind: z.enum(["inherit", "token", "oauth_app"]),
  token_env: z.string().nullish().transform((v) => v ?? undefined),
  instructions: z.string().nullish().transform((v) => v ?? undefined),
});

const CliExtractSchema = z.object({
  bin: z.string(),
  install: z.string().nullish().transform((v) => v ?? undefined),
  help: z.string().nullish().transform((v) => v ?? undefined),
  docs_url: z.string().nullish().transform((v) => v ?? undefined),
  auth: SurfaceAuthExtractSchema,
});

const SdkExtractSchema = z.object({
  package: z.string(),
  language: z.string(),
  install: z.string().nullish().transform((v) => v ?? undefined),
  reference_url: z.string().nullish().transform((v) => v ?? undefined),
  auth: SurfaceAuthExtractSchema,
});

const McpExtractSchema = z.object({
  server: z.string(),
  transport: z.enum(["stdio", "http"]),
  setup: z.string().nullish().transform((v) => v ?? undefined),
  docs_url: z.string().nullish().transform((v) => v ?? undefined),
  auth: SurfaceAuthExtractSchema,
});

const SurfaceExtractResultSchema = z.object({
  vendor: z.string(),
  slug: z.string(),
  extracted_at: z.string(),
  cli: CliExtractSchema.nullable(),
  sdk: SdkExtractSchema.nullable(),
  mcp: McpExtractSchema.nullable(),
});
export type SurfaceExtractResult = z.infer<typeof SurfaceExtractResultSchema>;

function buildSurfacePrompt(vendor: ResolveResult): string {
  return [
    `${vendor.vendor} (${vendor.category}).`,
    ``,
    `Before answering, WebFetch ${vendor.docs_url} and any linked CLI/SDK/MCP-specific pages. Ground every`,
    `answer in what you actually read — do not answer from memory alone (package names, binary names, and`,
    `MCP server commands change over time).`,
    ``,
    `Find, for ${vendor.vendor}:`,
    `- cli: an official command-line tool an agent could drive instead of raw HTTP. null if none exists.`,
    `  - bin: the binary name (e.g. "supabase")`,
    `  - install: how to install it (e.g. "npm install supabase --save-dev")`,
    `  - docs_url: CLI docs page`,
    `  - auth: how the CLI authenticates non-interactively (for a headless/CI run, NOT interactive login):`,
    `    "inherit" if it uses the SAME token as the REST API, "token" if it needs its own env var (give`,
    `    token_env, a SCREAMING_SNAKE_CASE name), "oauth_app" if only interactive OAuth login works headlessly`,
    `    (no env-var path at all).`,
    `- sdk: the official first-party SDK/client library for a common language (prefer Node/JS/TypeScript if`,
    `  multiple exist). null if none exists.`,
    `  - package: the package name (e.g. "@supabase/supabase-js")`,
    `  - language: e.g. "node"`,
    `  - reference_url: SDK reference docs page`,
    `  - auth: same kind/token_env convention as above — does the SDK use the same credential as the REST API?`,
    `- mcp: an official MCP server for this vendor. null if none exists.`,
    `  - server: the stdio launch command (e.g. "npx -y @supabase/mcp-server-supabase@latest") or the http URL`,
    `  - transport: "stdio" or "http"`,
    `  - docs_url: MCP setup docs page`,
    `  - auth: same kind/token_env convention — can a headless run authenticate with an env-var token, or is`,
    `    it OAuth-only?`,
    ``,
    `Return ONLY this JSON object, no commentary:`,
    `{`,
    `  "cli": {"bin": "...", "install": "...", "docs_url": "...", "auth": {"kind": "inherit"|"token"|"oauth_app", "token_env": "..." or null}} or null,`,
    `  "sdk": {"package": "...", "language": "...", "reference_url": "...", "auth": {...}} or null,`,
    `  "mcp": {"server": "...", "transport": "stdio"|"http", "docs_url": "...", "auth": {...}} or null`,
    `}`,
  ].join("\n");
}

export interface ExtractSurfacesOptions {
  harness?: HarnessId;
  model?: string;
  effort?: Effort;
}

const PER_CALL_TIMEOUT_MS = 8 * 60 * 1000;

/** Extract CLI/SDK/MCP surface declarations for a single vendor. */
export async function extractSurfaces(
  vendor: ResolveResult,
  opts: ExtractSurfacesOptions = {},
): Promise<SurfaceExtractResult> {
  const label = `${vendor.vendor}/surfaces`;
  const raw = await invokeHarness(buildSurfacePrompt(vendor), {
    harness: opts.harness ?? "claude-code",
    model: opts.model,
    effort: opts.effort,
    requireWebFetch: true,
    heartbeat: { everyMs: 30_000, label },
    timeoutMs: PER_CALL_TIMEOUT_MS,
  });
  const json = extractJsonObject(raw);
  const parsed = z
    .object({ cli: CliExtractSchema.nullable(), sdk: SdkExtractSchema.nullable(), mcp: McpExtractSchema.nullable() })
    .safeParse(JSON.parse(json));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
    throw new Error(`surface-extract for "${label}" returned non-conforming JSON: ${issues}\nRaw: ${json.slice(0, 2000)}`);
  }
  return SurfaceExtractResultSchema.parse({
    vendor: vendor.vendor,
    slug: vendor.slug,
    extracted_at: new Date().toISOString(),
    ...parsed.data,
  });
}

export function surfaceExtractPath(root: string, slug: string): string {
  return resolve(root, "targets", "extracts", slug, "surfaces.yaml");
}

export function writeSurfaceExtract(root: string, result: SurfaceExtractResult): string {
  const path = surfaceExtractPath(root, result.slug);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yamlStringify(result));
  return path;
}

export function loadSurfaceExtract(root: string, slug: string): SurfaceExtractResult | null {
  const path = surfaceExtractPath(root, slug);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const result = SurfaceExtractResultSchema.safeParse(yamlParse(raw));
  if (!result.success) {
    throw new Error(`surface-extract at ${path} is malformed: ${result.error.issues.map((i) => i.message).join("; ")}`);
  }
  return result.data;
}
