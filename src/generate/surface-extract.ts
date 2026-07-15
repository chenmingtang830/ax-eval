import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { z } from "zod";
import { PublicHttpUrlSchema, urlUsesOfficialHost } from "./public-url.js";
import { parseStructuredOutput, runStructuredGenerator, type StructuredGenerator } from "./structured-output.js";
import type { ResolveResult } from "./vendor-resolve.js";

const EnvNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/, "must name an environment variable");
const SafeCommandSchema = z.string().min(1).refine(
  (value) => !/[\n\r;&|`<>$]/.test(value),
  "must not contain shell operators or expansion",
);
const SurfaceAuthSchema = z.object({
  kind: z.enum(["inherit", "token", "oauth_app"]),
  token_env: EnvNameSchema.nullable().optional(),
}).superRefine((auth, context) => {
  if (auth.kind === "token" && !auth.token_env) {
    context.addIssue({ code: "custom", path: ["token_env"], message: "token auth requires token_env" });
  }
  if (auth.kind !== "token" && auth.token_env) {
    context.addIssue({ code: "custom", path: ["token_env"], message: `${auth.kind} auth must not declare token_env` });
  }
});

const CliSchema = z.object({
  bin: z.string().regex(/^[A-Za-z0-9._-]+$/, "must be a binary name"),
  install: SafeCommandSchema,
  docs_url: PublicHttpUrlSchema,
  auth: SurfaceAuthSchema,
});
const SdkSchema = z.object({
  package: z.string().min(1),
  language: z.string().min(1),
  install: SafeCommandSchema.optional(),
  reference_url: PublicHttpUrlSchema,
  auth: SurfaceAuthSchema,
});
const McpSchema = z.object({
  server: SafeCommandSchema,
  transport: z.enum(["stdio", "http"]),
  docs_url: PublicHttpUrlSchema,
  auth: SurfaceAuthSchema,
}).superRefine((mcp, context) => {
  if (mcp.transport === "http" && !/^https?:\/\//i.test(mcp.server)) {
    context.addIssue({ code: "custom", path: ["server"], message: "http transport requires an HTTP URL" });
  }
  if (mcp.transport === "http" && !PublicHttpUrlSchema.safeParse(mcp.server).success) {
    context.addIssue({ code: "custom", path: ["server"], message: "MCP server must be a public URL" });
  }
});

const SurfaceExtractSchema = z.object({
  vendor: z.string().min(1),
  slug: z.string().min(1),
  extracted_at: z.string().datetime(),
  cli: CliSchema.nullable(),
  sdk: SdkSchema.nullable(),
  mcp: McpSchema.nullable(),
});

const GeneratedSurfacesSchema = SurfaceExtractSchema.pick({ cli: true, sdk: true, mcp: true });
export type SurfaceExtractResult = z.infer<typeof SurfaceExtractSchema>;

export function buildSurfacePrompt(vendor: ResolveResult): string {
  return [
    `Read official ${vendor.vendor} documentation starting at ${vendor.docs_url}.`,
    "Use web fetch/search; do not infer package names, binaries, commands, or authentication from memory.",
    "Return official CLI, SDK, and MCP surfaces, or null when no official surface is documented.",
    "For authentication use inherit, token with a SCREAMING_SNAKE_CASE token_env, or oauth_app.",
    "Return JSON only with keys cli, sdk, and mcp.",
  ].join("\n");
}

export async function extractSurfaces(
  vendor: ResolveResult,
  options: { generate?: StructuredGenerator; now?: () => Date } = {},
): Promise<SurfaceExtractResult> {
  if (!vendor.docs_url) throw new Error(`cannot extract surfaces for ${vendor.vendor}: docs_url is missing`);
  const generated = GeneratedSurfacesSchema.safeParse(
    parseStructuredOutput(await runStructuredGenerator(buildSurfacePrompt(vendor), options.generate)),
  );
  if (!generated.success) {
    throw new Error(`surface extract for ${vendor.vendor} is invalid: ${generated.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  const officialUrls = [vendor.docs_url, vendor.site_url];
  const citedUrls = [generated.data.cli?.docs_url, generated.data.sdk?.reference_url, generated.data.mcp?.docs_url]
    .filter((value): value is string => Boolean(value));
  for (const url of citedUrls) {
    if (!urlUsesOfficialHost(url, officialUrls)) throw new Error(`surface extract cites non-official host ${url}`);
  }
  if (generated.data.mcp?.transport === "http" && !urlUsesOfficialHost(generated.data.mcp.server, officialUrls)) {
    throw new Error(`surface extract cites non-official MCP server ${generated.data.mcp.server}`);
  }
  return SurfaceExtractSchema.parse({
    vendor: vendor.vendor,
    slug: vendor.slug,
    extracted_at: (options.now ?? (() => new Date()))().toISOString(),
    ...generated.data,
  });
}

export function surfaceExtractPath(root: string, slug: string): string {
  return resolve(root, "targets", "extracts", slug, "surfaces.yaml");
}

export function writeSurfaceExtract(root: string, result: SurfaceExtractResult): string {
  const path = surfaceExtractPath(root, result.slug);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, yamlStringify(SurfaceExtractSchema.parse(result)));
  renameSync(`${path}.tmp`, path);
  return path;
}

export function loadSurfaceExtract(root: string, slug: string): SurfaceExtractResult | null {
  const path = surfaceExtractPath(root, slug);
  if (!existsSync(path)) return null;
  const result = SurfaceExtractSchema.safeParse(yamlParse(readFileSync(path, "utf8")));
  if (!result.success) throw new Error(`surface extract at ${path} is malformed`);
  return result.data;
}
