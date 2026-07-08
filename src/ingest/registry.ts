/**
 * integrations.sh registry adapter.
 *
 * integrations.sh (MIT, https://github.com/UsefulSoftwareCo/integrations) is a
 * public registry of integration *surfaces* — MCP / REST-OpenAPI / GraphQL /
 * CLI — for thousands of services, each mapped to the credential it needs and
 * how to acquire it. Its `GET /api/{domain}/surface` endpoint returns exactly
 * the discovery facts ax-eval otherwise pays an LLM to web-search for:
 * which surfaces exist, their endpoints/docs, and per-surface auth bindings.
 *
 * This adapter fetches that document and maps it onto ax-eval's existing
 * artifacts (vendor card + surface extract), so `import-registry` can seed the
 * authoring pipeline without a grounded discovery call. It is a *discovery*
 * accelerator only: the benchmark-grade capability inventory and the read-back
 * oracles remain ax-eval's own (grounded) work.
 *
 * Provenance is carried through faithfully: the registry tags every fact
 * `detected` (re-verifiable machine signal) or `discovered` (read from docs),
 * which is the same distinction ax-eval records elsewhere.
 */
import { z } from "zod";
import { slugify, type ResolveResult } from "../generate/vendor-resolve.js";
import type { SurfaceExtractResult } from "../generate/surface-extract.js";

export const REGISTRY_BASE_URL = "https://integrations.sh";

/** The subset of integrations.sh's surface document ax-eval consumes. The
 *  registry is v0.0.1 ("schema and routes may change"), so this is permissive:
 *  unknown fields pass through and most fields are optional. */
const RegistryCredentialSchema = z
  .object({
    type: z.string().optional(),
    label: z.string().optional(),
    generateUrl: z.string().optional(),
    setup: z.string().optional(),
    acquisition: z.string().optional(),
  })
  .passthrough();

const RegistryAuthUseSchema = z
  .object({
    id: z.string().optional(),
    mechanics: z
      .object({
        source: z.string().optional(),
        in: z.string().optional(),
        headerName: z.string().optional(),
        scheme: z.string().optional(),
      })
      .partial()
      .passthrough()
      .optional(),
  })
  .passthrough();

const RegistrySurfaceEntrySchema = z
  .object({
    type: z.string(),
    url: z.string().optional(),
    slug: z.string().optional(),
    name: z.string().optional(),
    docs: z.string().optional(),
    command: z.string().optional(),
    transports: z.array(z.string()).optional(),
    packages: z
      .array(z.object({ registryType: z.string().optional(), identifier: z.string().optional() }).passthrough())
      .optional(),
    basis: z
      .object({ via: z.string().optional(), signal: z.string().optional(), evidence: z.array(z.string()).optional() })
      .passthrough()
      .optional(),
    auth: z
      .object({
        status: z.string().optional(),
        entries: z.array(z.object({ use: z.array(RegistryAuthUseSchema).optional() }).passthrough()).optional(),
      })
      .passthrough()
      .optional(),
    variables: z.array(z.object({ name: z.string(), description: z.string().optional() }).passthrough()).optional(),
  })
  .passthrough();

export const RegistrySurfaceSchema = z
  .object({
    domain: z.string(),
    summary: z.string().optional(),
    description: z.string().optional(),
    discoveredAt: z.string().optional(),
    detect: z
      .object({
        apiCatalog: z
          .object({
            rest: z.array(z.string()).optional(),
            openapi: z.array(z.string()).optional(),
            docs: z.array(z.string()).optional(),
            mcp: z.array(z.string()).optional(),
          })
          .partial()
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    credentials: z.record(RegistryCredentialSchema).optional(),
    surfaces: z.array(RegistrySurfaceEntrySchema).default([]),
  })
  .passthrough();

export type RegistrySurface = z.infer<typeof RegistrySurfaceSchema>;
type RegistrySurfaceEntry = z.infer<typeof RegistrySurfaceEntrySchema>;

export interface FetchRegistryOptions {
  baseUrl?: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Fetch and validate a domain's surface document from integrations.sh. Returns
 *  null when the domain isn't in the registry (the endpoint returns an empty or
 *  surface-less body), so callers can fall back to grounded discovery. */
export async function fetchRegistrySurface(
  domain: string,
  opts: FetchRegistryOptions = {},
): Promise<RegistrySurface | null> {
  const base = opts.baseUrl ?? REGISTRY_BASE_URL;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await fetchImpl(`${base}/api/${encodeURIComponent(domain)}/surface`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      if (res.status === 404) return null;
      throw new Error(`integrations.sh returned ${res.status} for ${domain}`);
    }
    const json = (await res.json()) as unknown;
    const parsed = RegistrySurfaceSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(
        `integrations.sh surface for ${domain} did not match schema: ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; ")}`,
      );
    }
    if (!parsed.data.surfaces.length) return null;
    return parsed.data;
  } finally {
    clearTimeout(timer);
  }
}

function surfacesOfType(surface: RegistrySurface, type: string): RegistrySurfaceEntry[] {
  return surface.surfaces.filter((s) => s.type === type);
}

/** Credential ids referenced by any HTTP surface — used to decide whether a
 *  CLI/MCP surface shares the REST credential ("inherit") or needs its own. */
function httpCredentialIds(surface: RegistrySurface): Set<string> {
  const ids = new Set<string>();
  for (const s of surfacesOfType(surface, "http")) {
    for (const entry of s.auth?.entries ?? []) {
      for (const use of entry.use ?? []) if (use.id) ids.add(use.id);
    }
  }
  return ids;
}

function firstCredentialId(entry: RegistrySurfaceEntry): string | undefined {
  return entry.auth?.entries?.[0]?.use?.[0]?.id;
}

/** Map a registry surface's auth binding to ax-eval's surface-auth `kind`.
 *  - shares an HTTP surface's credential  → "inherit"
 *  - the credential is OAuth2             → "oauth_app"
 *  - otherwise (its own token)            → "token"
 *  token_env is intentionally left unset: the registry names credentials
 *  (e.g. "supabase_pat"), not the SCREAMING_SNAKE env var ax-eval's pack
 *  declares — that stays a pack/.env concern. Setup prose becomes instructions. */
function mapAuth(
  entry: RegistrySurfaceEntry,
  surface: RegistrySurface,
  sharedHttpIds: Set<string>,
): { kind: "inherit" | "token" | "oauth_app"; instructions?: string } {
  const credId = firstCredentialId(entry);
  if (!credId) return { kind: "inherit" };
  const cred = surface.credentials?.[credId];
  const instructions = cred?.setup ?? cred?.label;
  if (sharedHttpIds.has(credId)) return { kind: "inherit", instructions };
  if ((cred?.type ?? "").toLowerCase().includes("oauth")) return { kind: "oauth_app", instructions };
  return { kind: "token", instructions };
}

/** Best available launch string for an MCP surface: an http url, an explicit
 *  stdio command, or a synthesized `npx -y <pkg>` for an npm package. Returns
 *  undefined when the registry entry carries none of these. */
function mcpLaunch(entry: RegistrySurfaceEntry): string | undefined {
  if (entry.url) return entry.url;
  if (entry.command) return entry.command;
  const pkg = entry.packages?.[0];
  if (pkg?.identifier && pkg.registryType === "npm") return `npx -y ${pkg.identifier}`;
  return undefined;
}

function cliInstall(entry: RegistrySurfaceEntry): string | undefined {
  const pkg = entry.packages?.[0];
  if (!pkg?.identifier) return undefined;
  switch (pkg.registryType) {
    case "homebrew":
      return `brew install ${pkg.identifier}`;
    case "npm":
      return `npm install -g ${pkg.identifier}`;
    case "pypi":
      return `pip install ${pkg.identifier}`;
    case "cargo":
      return `cargo install ${pkg.identifier}`;
    default:
      return pkg.identifier;
  }
}

export interface RegistryMapOptions {
  /** Display name for the vendor (defaults to a title-cased domain label). */
  vendorName?: string;
  /** ax-eval slug (defaults to slugify(vendorName)). Set explicitly when the
   *  canonical slug differs from the domain (e.g. mongodb.com → mongodb-atlas). */
  slug?: string;
  category: string;
}

function titleCase(text: string): string {
  return text.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function defaultVendorName(domain: string): string {
  return titleCase(domain.replace(/\.[a-z.]+$/i, ""));
}

/** Resolve the display name + ax-eval slug for a registry-sourced vendor.
 *  Precedence: explicit vendorName > explicit slug (title-cased) > domain label.
 *  Deriving the name from an explicit slug keeps the display name aligned with
 *  the canonical slug the caller chose (e.g. mongodb-atlas → "Mongodb Atlas")
 *  rather than the registry domain (mongodb.com → "Mongodb"). */
function nameAndSlug(domain: string, opts: RegistryMapOptions): { vendorName: string; slug: string } {
  if (opts.vendorName) return { vendorName: opts.vendorName, slug: opts.slug ?? slugify(opts.vendorName) };
  if (opts.slug) return { vendorName: titleCase(opts.slug), slug: opts.slug };
  const vendorName = defaultVendorName(domain);
  return { vendorName, slug: slugify(vendorName) };
}

/** Build an ax-eval vendor card from a registry surface document. */
export function registryToVendorCard(surface: RegistrySurface, opts: RegistryMapOptions): ResolveResult {
  const { vendorName, slug } = nameAndSlug(surface.domain, opts);
  const docsUrl =
    surface.detect?.apiCatalog?.docs?.[0] ??
    surface.surfaces.find((s) => s.docs)?.docs ??
    null;
  return {
    vendor: vendorName,
    category: opts.category,
    slug,
    discovered_at: surface.discoveredAt ?? new Date().toISOString(),
    resolver: { method: "registry", registry_domain: surface.domain },
    site_url: `https://${surface.domain}`,
    docs_url: docsUrl,
    http_status: null,
  };
}

/** Build an ax-eval surface extract (CLI/SDK/MCP) from a registry surface
 *  document. SDK is always null: the registry models SDKs as either the CLI or
 *  an HTTP surface, and ax-eval defers SDK as a benchmark surface anyway. */
export function registryToSurfaceExtract(surface: RegistrySurface, opts: RegistryMapOptions): SurfaceExtractResult {
  const { vendorName, slug } = nameAndSlug(surface.domain, opts);
  const sharedHttpIds = httpCredentialIds(surface);

  const cliEntry = surfacesOfType(surface, "cli")[0];
  const cli = cliEntry
    ? {
        bin: cliEntry.command ?? cliEntry.packages?.[0]?.identifier ?? slug,
        install: cliInstall(cliEntry),
        docs_url: cliEntry.docs,
        auth: mapAuth(cliEntry, surface, sharedHttpIds),
      }
    : null;

  const mcpEntry = surfacesOfType(surface, "mcp")[0];
  const mcpServer = mcpEntry ? mcpLaunch(mcpEntry) : undefined;
  // Only emit an MCP surface when the registry actually knows how to launch it.
  // Some entries are just `{type:"mcp", transports:["stdio"]}` with no url,
  // command, or package — an empty server string would break compose-pack.
  const mcp = mcpEntry && mcpServer
    ? {
        server: mcpServer,
        transport: (mcpEntry.transports ?? []).some((t) => t.includes("http")) || mcpServer.startsWith("http")
          ? ("http" as const)
          : ("stdio" as const),
        docs_url: mcpEntry.docs,
        auth: mapAuth(mcpEntry, surface, sharedHttpIds),
      }
    : null;

  return {
    vendor: vendorName,
    slug,
    extracted_at: new Date().toISOString(),
    cli,
    sdk: null,
    mcp,
  };
}

/** The first downloadable OpenAPI spec URL the registry knows for this domain,
 *  if any — the input for ax-eval's `ingest` step. */
export function registryOpenApiUrl(surface: RegistrySurface): string | undefined {
  return surface.detect?.apiCatalog?.openapi?.[0];
}
