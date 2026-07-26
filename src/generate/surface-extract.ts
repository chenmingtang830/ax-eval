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
import type { Effort, HarnessId } from "./harness.js";
import { invokeGenerator, extractJsonObjectWithRepair } from "./harness.js";
import type { ResolveResult } from "./vendor-resolve.js";
import { daebReadSurfacesPath, daebSurfacesPath, type DaebPathInput } from "./benchmark-paths.js";

const SURFACE_EXTRACT_SCHEMA_VERSION = "ax.surface-extract/v1" as const;

const SurfaceAuthExtractSchema = z.object({
  kind: z.enum(["inherit", "token", "oauth_app"]),
  token_env: z.string().nullish().transform((v) => v ?? undefined),
  token_env_aliases: z.array(z.string()).default([]),
  client_id_env: z.string().nullish().transform((v) => v ?? undefined),
  client_secret_env: z.string().nullish().transform((v) => v ?? undefined),
  refresh_token_env: z.string().nullish().transform((v) => v ?? undefined),
  token_url: z.string().url().nullish().transform((v) => v ?? undefined),
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
  schema: z.literal(SURFACE_EXTRACT_SCHEMA_VERSION).default(SURFACE_EXTRACT_SCHEMA_VERSION),
  vendor: z.string(),
  slug: z.string(),
  extracted_at: z.string(),
  extraction_context: z.object({
    mode: z.enum(["registry-seeded-grounded", "grounded-doc-crawl", "manual-review"]),
    harness: z.string().optional(),
    model: z.string().optional(),
    notes: z.string().optional(),
  }).optional(),
  audit_status: z.enum(["candidate", "reviewed", "needs-reextract"]).default("candidate"),
  audit_notes: z.array(z.string()).default([]),
  cli: CliExtractSchema.nullable(),
  sdk: SdkExtractSchema.nullable(),
  mcp: McpExtractSchema.nullable(),
});
export type SurfaceExtractResult = z.infer<typeof SurfaceExtractResultSchema>;

function priorHypothesisBlock(prior: SurfaceExtractResult): string {
  const lines = [
    `PRIOR HYPOTHESIS (from the integrations.sh registry — treat as UNVERIFIED). Verify each field`,
    `against the live docs and CORRECT anything wrong. Registry CLI package/binary names and auth prose`,
    `are frequently stale or mismatched (e.g. it may name the wrong npm package or paste an unrelated`,
    `OAuth blurb), so confirm the actual install command, binary name, and auth flow from the docs:`,
  ];
  if (prior.cli) {
    lines.push(`- cli: bin="${prior.cli.bin}", install="${prior.cli.install ?? ""}", auth.kind=${prior.cli.auth.kind}`);
  } else {
    lines.push(`- cli: (registry found none — confirm whether one exists)`);
  }
  if (prior.mcp) {
    lines.push(`- mcp: server="${prior.mcp.server}", transport=${prior.mcp.transport}, auth.kind=${prior.mcp.auth.kind}`);
  } else {
    lines.push(`- mcp: (registry found none — confirm whether one exists)`);
  }
  lines.push(``);
  return lines.join("\n");
}

function buildSurfacePrompt(vendor: ResolveResult, prior?: SurfaceExtractResult): string {
  return [
    `${vendor.vendor} (${vendor.category}).`,
    ``,
    `Before answering, WebFetch ${vendor.docs_url} and any linked CLI/SDK/MCP-specific pages. Ground every`,
    `answer in what you actually read — do not answer from memory alone (package names, binary names, and`,
    `MCP server commands change over time).`,
    ``,
    ...(prior ? [priorHypothesisBlock(prior)] : []),
    `Find, for ${vendor.vendor}:`,
    `- cli: an official command-line tool an agent could drive instead of raw HTTP. null if none exists.`,
    `  - bin: the binary name (e.g. "supabase")`,
    `  - install: how to install it (e.g. "npm install supabase --save-dev")`,
    `  - docs_url: CLI docs page`,
    `  - auth: how the CLI authenticates non-interactively (for a headless/CI run, NOT interactive login):`,
    `    "inherit" if it uses the SAME token as the REST API, "token" if it needs its own env var (give`,
    `    token_env, a SCREAMING_SNAKE_CASE name; token_env_aliases if the vendor supports equivalent env names),`,
    `    "oauth_app" if headless use needs OAuth app env vars (client_id_env, client_secret_env, refresh_token_env, token_url).`,
    `- sdk: the official first-party SDK/client library for a common language (prefer Node/JS/TypeScript if`,
    `  multiple exist). null if none exists.`,
    `  - package: the package name (e.g. "@supabase/supabase-js")`,
    `  - language: e.g. "node"`,
    `  - reference_url: SDK reference docs page`,
    `  - auth: same convention as above — does the SDK use the same credential as the REST API, a connection string,`,
    `    or a vendor-specific token?`,
    `- mcp: an official MCP server for this vendor. null if none exists.`,
    `  - server: the stdio launch command (e.g. "npx -y @supabase/mcp-server-supabase@latest") or the http URL`,
    `  - transport: "stdio" or "http"`,
    `  - docs_url: MCP setup docs page`,
    `  - auth: same convention — include all required env names for MCP setup (for example connection string plus`,
    `    service-account client id/secret), not just the first credential mentioned in the docs.`,
    ``,
    `Return ONLY this JSON object, no commentary:`,
    `{`,
    `  "cli": {"bin": "...", "install": "...", "docs_url": "...", "auth": {"kind": "inherit"|"token"|"oauth_app", "token_env": "..." or null, "token_env_aliases": [], "client_id_env": null, "client_secret_env": null, "refresh_token_env": null, "token_url": null, "instructions": "..." or null}} or null,`,
    `  "sdk": {"package": "...", "language": "...", "reference_url": "...", "auth": {...}} or null,`,
    `  "mcp": {"server": "...", "transport": "stdio"|"http", "docs_url": "...", "auth": {...}} or null`,
    `}`,
  ].join("\n");
}

export interface ExtractSurfacesOptions {
  harness?: HarnessId;
  model?: string;
  effort?: Effort;
  /** A prior surface extract (e.g. seeded from the integrations.sh registry) to
   *  verify/correct rather than derive from scratch. */
  prior?: SurfaceExtractResult;
}

const PER_CALL_TIMEOUT_MS = 8 * 60 * 1000;

/** Extract CLI/SDK/MCP surface declarations for a single vendor. */
export async function extractSurfaces(
  vendor: ResolveResult,
  opts: ExtractSurfacesOptions = {},
): Promise<SurfaceExtractResult> {
  const label = `${vendor.vendor}/surfaces`;
  const raw = await invokeGenerator(buildSurfacePrompt(vendor, opts.prior), {
    requireWebFetch: true,
    fallbackHarness: opts.harness ?? "claude-code",
    model: opts.model,
    effort: opts.effort,
    heartbeat: { everyMs: 30_000, label },
    timeoutMs: PER_CALL_TIMEOUT_MS,
  });
  const json = await extractJsonObjectWithRepair(raw, {
    fallbackHarness: opts.harness ?? "claude-code",
    model: opts.model,
    effort: opts.effort,
    label,
  });
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
    extraction_context: {
      mode: opts.prior ? "registry-seeded-grounded" : "grounded-doc-crawl",
      harness: opts.harness,
      model: opts.model,
      notes: opts.prior
        ? "Registry-seeded hypothesis corrected against live docs."
        : "Grounded doc-crawl surface candidate.",
    },
    audit_status: "candidate",
    audit_notes: ["Verify headless auth fields against vendor docs before publication."],
    ...parsed.data,
  });
}

export function surfaceExtractPath(root: DaebPathInput, slug: string): string {
  return daebSurfacesPath(root, slug);
}

const SURFACE_EXTRACT_HEADER = [
  "# Optional agent surface adapters for exec-plan (CLI / SDK / MCP only).",
  "# REST API is always the implicit default surface and is intentionally omitted here;",
  "# API auth and base URL come from the vendor oracle extract, not this file.",
  "",
].join("\n");

function surfaceAuthNotes(label: string, auth: z.infer<typeof SurfaceAuthExtractSchema> | undefined): string[] {
  if (!auth) return [];
  const notes: string[] = [];
  const instructions = auth.instructions?.toLowerCase() ?? "";
  if (auth.kind === "token" && !auth.token_env && !auth.client_id_env && !auth.client_secret_env && !auth.refresh_token_env) {
    notes.push(`${label} declares token auth but no headless credential env var.`);
  }
  if (auth.kind === "inherit" && /\boauth\b|browser|approve access|dynamic client registration|mcp client/.test(instructions)) {
    notes.push(`${label} inherit auth mentions OAuth/browser/MCP setup; verify it is not copied from another surface.`);
  }
  if ((auth.client_id_env || auth.client_secret_env) && !(auth.client_id_env && auth.client_secret_env)) {
    notes.push(`${label} OAuth/service-account auth names only one side of the client id/secret pair.`);
  }
  return notes;
}

export function auditSurfaceExtract(result: z.input<typeof SurfaceExtractResultSchema>): SurfaceExtractResult {
  const parsed = SurfaceExtractResultSchema.parse(result);
  const auditNotes = [
    ...(parsed.audit_notes ?? []),
    ...surfaceAuthNotes("cli", parsed.cli?.auth),
    ...surfaceAuthNotes("sdk", parsed.sdk?.auth),
    ...surfaceAuthNotes("mcp", parsed.mcp?.auth),
  ];
  return SurfaceExtractResultSchema.parse({
    ...parsed,
    schema: SURFACE_EXTRACT_SCHEMA_VERSION,
    audit_status: parsed.audit_status ?? "candidate",
    audit_notes: Array.from(new Set(auditNotes)),
  });
}

export function writeSurfaceExtract(root: DaebPathInput, result: SurfaceExtractResult): string {
  const path = surfaceExtractPath(root, result.slug);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${SURFACE_EXTRACT_HEADER}${yamlStringify(auditSurfaceExtract(result))}`);
  return path;
}

export function loadSurfaceExtract(root: DaebPathInput, slug: string): SurfaceExtractResult | null {
  const path = daebReadSurfacesPath(root, slug);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const result = SurfaceExtractResultSchema.safeParse(yamlParse(raw));
  if (!result.success) {
    throw new Error(`surface-extract at ${path} is malformed: ${result.error.issues.map((i) => i.message).join("; ")}`);
  }
  return result.data;
}
