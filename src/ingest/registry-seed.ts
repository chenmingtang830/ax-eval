import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { z } from "zod";
import { assertArtifactSegment } from "../generate/artifact-path.js";
import { loadOptionalYamlArtifact } from "../generate/artifact-yaml.js";
import { isPublicHttpUrl } from "../generate/public-url.js";

const RegistryCredentialSchema = z.object({
  type: z.string().optional(),
  label: z.string().optional(),
  generateUrl: z.string().optional(),
});

const RegistryAuthUseSchema = z.object({ id: z.string().optional() });

const RegistrySurfaceEntrySchema = z.object({
  type: z.string(),
  url: z.string().optional(),
  slug: z.string().optional(),
  name: z.string().optional(),
  docs: z.string().optional(),
  command: z.string().optional(),
  transports: z.array(z.string()).optional(),
  packages: z.array(z.object({
    registryType: z.string().optional(),
    identifier: z.string().optional(),
  })).optional(),
  basis: z.object({
    via: z.string().optional(),
    signal: z.string().optional(),
    evidence: z.array(z.string()).optional(),
  }).optional(),
  auth: z.object({
    status: z.string().optional(),
    entries: z.array(z.object({ use: z.array(RegistryAuthUseSchema).optional() })).optional(),
  }).optional(),
});

export const RegistrySurfaceDocumentSchema = z.object({
  domain: z.string().min(1),
  summary: z.string().optional(),
  detect: z.object({
    apiCatalog: z.object({
      rest: z.array(z.string()).optional(),
      openapi: z.array(z.string()).optional(),
      docs: z.array(z.string()).optional(),
      mcp: z.array(z.string()).optional(),
    }).optional(),
  }).optional(),
  credentials: z.record(z.string(), RegistryCredentialSchema).optional(),
  surfaces: z.array(RegistrySurfaceEntrySchema).default([]),
});

export type RegistrySurfaceDocument = z.infer<typeof RegistrySurfaceDocumentSchema>;

const PublicUrlSchema = z.string().max(2048).refine(isPublicHttpUrl, "must be a public HTTP URL");
const RegistryAuthRecommendationSchema = z.object({
  kind: z.enum(["none", "inherit", "token", "oauth_app", "unknown"]),
  credential_ref: z.string().regex(/^credential-[1-9][0-9]*$/).nullable(),
  requires_env_mapping: z.boolean(),
  acquisition_url: PublicUrlSchema.nullable(),
}).strict();

export const RegistrySurfaceCandidateSchema = z.object({
  id: z.string().min(1).max(120),
  type: z.enum(["http", "graphql", "cli", "mcp", "sdk"]),
  name: z.string().max(120).nullable(),
  endpoint: PublicUrlSchema.nullable(),
  docs_url: PublicUrlSchema.nullable(),
  command: z.string().max(300).refine((value) => !/[\n\r;&|`<>$]/.test(value)).nullable(),
  packages: z.array(z.object({
    registry: z.string().min(1).max(40),
    identifier: z.string().min(1).max(200).regex(/^[A-Za-z0-9@/._+-]+$/),
  }).strict()).max(50),
  transport: z.enum(["http", "stdio"]).nullable(),
  auth: RegistryAuthRecommendationSchema,
  provenance: z.object({
    via: z.string().max(40).nullable(),
    signal: z.string().max(160).nullable(),
    evidence_urls: z.array(PublicUrlSchema).max(50),
  }).strict(),
  review_required: z.literal(true),
}).strict();

export const RegistryAuthoringSeedSchema = z.object({
  schema: z.literal("ax.registry-authoring-seed/v1"),
  domain: z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
  site_url: PublicUrlSchema,
  summary: z.string().max(500).nullable(),
  mapped_at: z.string().datetime(),
  openapi_urls: z.array(PublicUrlSchema).max(50),
  docs_urls: z.array(PublicUrlSchema).max(50),
  candidates: z.array(RegistrySurfaceCandidateSchema).max(500),
  warnings: z.array(z.string().max(500)).max(500),
}).strict().superRefine((seed, context) => {
  if (new URL(seed.site_url).hostname.toLowerCase() !== seed.domain) {
    context.addIssue({ code: "custom", path: ["site_url"], message: "must use the registry seed domain" });
  }
  const ids = new Set<string>();
  for (const [index, candidate] of seed.candidates.entries()) {
    if (ids.has(candidate.id)) {
      context.addIssue({ code: "custom", path: ["candidates", index, "id"], message: "candidate ids must be unique" });
    }
    ids.add(candidate.id);
  }
});

export type RegistryAuthRecommendation = z.infer<typeof RegistryAuthRecommendationSchema>;
export type RegistrySurfaceCandidate = z.infer<typeof RegistrySurfaceCandidateSchema>;
export type RegistryAuthoringSeed = z.infer<typeof RegistryAuthoringSeedSchema>;

function normalizeDomain(value: string): string {
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) {
    throw new Error("registry domain must be a public DNS name");
  }
  return domain;
}

function publicUrls(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).filter(isPublicHttpUrl))].sort();
}

function safeText(value: string | undefined, maxLength: number): string | null {
  if (!value?.trim()) return null;
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function credentialId(entry: z.infer<typeof RegistrySurfaceEntrySchema>, document: RegistrySurfaceDocument): string | null {
  const value = entry.auth?.entries?.[0]?.use?.[0]?.id?.trim();
  return value && value.length <= 120 && /^[A-Za-z0-9._:-]+$/.test(value) && document.credentials?.[value]
    ? value
    : null;
}

function httpCredentialIds(document: RegistrySurfaceDocument): Set<string> {
  return new Set(document.surfaces
    .filter((entry) => entry.type.toLowerCase() === "http")
    .flatMap((entry) => {
      const id = credentialId(entry, document);
      return id ? [id] : [];
    }));
}

function credentialAliases(document: RegistrySurfaceDocument): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const entry of document.surfaces) {
    const id = credentialId(entry, document);
    if (id && !aliases.has(id)) aliases.set(id, `credential-${aliases.size + 1}`);
  }
  return aliases;
}

function authRecommendation(
  entry: z.infer<typeof RegistrySurfaceEntrySchema>,
  document: RegistrySurfaceDocument,
  sharedHttpCredentials: Set<string>,
  aliases: Map<string, string>,
): RegistryAuthRecommendation {
  const id = credentialId(entry, document);
  const status = entry.auth?.status?.toLowerCase();
  if (!id) {
    return {
      kind: status === "none" || status === "not-required" ? "none" : "unknown",
      credential_ref: null,
      requires_env_mapping: false,
      acquisition_url: null,
    };
  }
  const credential = document.credentials?.[id];
  const acquisitionUrl = credential?.generateUrl && isPublicHttpUrl(credential.generateUrl)
    ? credential.generateUrl
    : null;
  const type = credential?.type?.toLowerCase() ?? "";
  const entryType = entry.type.toLowerCase();
  const kind = entryType !== "http" && sharedHttpCredentials.has(id)
    ? "inherit"
    : type.includes("oauth")
      ? "oauth_app"
      : "token";
  return RegistryAuthRecommendationSchema.parse({
    kind,
    credential_ref: aliases.get(id) ?? null,
    requires_env_mapping: kind === "token" || kind === "oauth_app",
    acquisition_url: acquisitionUrl,
  });
}

export function registryAuthoringSeedPath(root: string, slug: string): string {
  return resolve(root, "targets", "seeds", assertArtifactSegment(slug, "vendor slug"), "registry.yaml");
}

export function writeRegistryAuthoringSeed(root: string, slug: string, seed: RegistryAuthoringSeed): string {
  const path = registryAuthoringSeedPath(root, slug);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, yamlStringify(RegistryAuthoringSeedSchema.parse(seed)));
  renameSync(`${path}.tmp`, path);
  return path;
}

export function loadRegistryAuthoringSeed(root: string, slug: string): RegistryAuthoringSeed | null {
  return loadRegistryAuthoringSeedPath(registryAuthoringSeedPath(root, slug));
}

export function loadRegistryAuthoringSeedPath(path: string): RegistryAuthoringSeed | null {
  return loadOptionalYamlArtifact(path, RegistryAuthoringSeedSchema, "registry authoring seed");
}

function safeCommand(value: string | undefined): string | null {
  if (!value || value.length > 300 || /[\n\r;&|`<>$]/.test(value)) return null;
  return value.trim() || null;
}

function safePackages(entry: z.infer<typeof RegistrySurfaceEntrySchema>): Array<{ registry: string; identifier: string }> {
  return (entry.packages ?? []).flatMap((item) => {
    const registry = item.registryType?.trim().toLowerCase();
    const identifier = item.identifier?.trim();
    if (!registry || !identifier || !/^[A-Za-z0-9@/._+-]+$/.test(identifier)) return [];
    return [{ registry, identifier }];
  });
}

export function mapRegistryAuthoringSeed(
  input: unknown,
  options: { now?: () => Date } = {},
): RegistryAuthoringSeed {
  const document = RegistrySurfaceDocumentSchema.parse(input);
  const domain = normalizeDomain(document.domain);
  const warnings: string[] = [];
  const sharedHttpCredentials = httpCredentialIds(document);
  const aliases = credentialAliases(document);
  const candidates = document.surfaces.flatMap((entry, index): RegistrySurfaceCandidate[] => {
    const type = entry.type.toLowerCase();
    if (!(type === "http" || type === "graphql" || type === "cli" || type === "mcp" || type === "sdk")) {
      warnings.push(`surface ${index + 1} has an unsupported type`);
      return [];
    }
    const endpoint = entry.url && isPublicHttpUrl(entry.url) ? entry.url : null;
    const docsUrl = entry.docs && isPublicHttpUrl(entry.docs) ? entry.docs : null;
    const command = safeCommand(entry.command);
    if (entry.url && !endpoint) warnings.push(`surface ${index + 1} has an invalid public endpoint URL`);
    if (entry.docs && !docsUrl) warnings.push(`surface ${index + 1} has an invalid public docs URL`);
    if (entry.command && !command) warnings.push(`surface ${index + 1} has an unsafe command and requires manual review`);
    const evidenceUrls = publicUrls(entry.basis?.evidence);
    return [{
      id: `${type}:${index + 1}`,
      type,
      name: safeText(entry.name, 120),
      endpoint,
      docs_url: docsUrl,
      command,
      packages: safePackages(entry),
      transport: type === "mcp"
        ? endpoint ? "http" : command ? "stdio" : null
        : null,
      auth: authRecommendation(entry, document, sharedHttpCredentials, aliases),
      provenance: {
        via: safeText(entry.basis?.via, 40),
        signal: safeText(entry.basis?.signal, 160),
        evidence_urls: evidenceUrls,
      },
      review_required: true,
    }];
  });
  const catalog = document.detect?.apiCatalog;
  return RegistryAuthoringSeedSchema.parse({
    schema: "ax.registry-authoring-seed/v1",
    domain,
    site_url: `https://${domain}`,
    summary: safeText(document.summary, 500),
    mapped_at: (options.now ?? (() => new Date()))().toISOString(),
    openapi_urls: publicUrls(catalog?.openapi),
    docs_urls: publicUrls(catalog?.docs),
    candidates,
    warnings,
  });
}
