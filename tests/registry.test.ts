import { describe, expect, it } from "vitest";
import {
  fetchRegistrySurface,
  registryToVendorCard,
  registryToSurfaceExtract,
  registryOpenApiUrl,
  type RegistrySurface,
} from "../src/ingest/registry.js";

// A trimmed but shape-accurate integrations.sh /api/{domain}/surface response,
// modeled on the live supabase.com document (kept as an offline fixture so the
// suite stays keyless/network-free).
const SUPABASE_FIXTURE = {
  version: 3,
  domain: "supabase.com",
  summary: "Supabase exposes a hosted Management REST API, a Data REST API, an MCP server, and the supabase CLI.",
  discoveredAt: "2026-07-03T04:18:29.014Z",
  detect: {
    apiCatalog: {
      rest: ["https://api.supabase.com/v1"],
      openapi: ["https://api.supabase.com/api/v1-json"],
      docs: ["https://api.supabase.com/api/v1"],
      mcp: [],
    },
  },
  credentials: {
    supabase_pat: {
      type: "bearer",
      label: "Supabase personal access token",
      generateUrl: "https://supabase.com/dashboard/account/tokens",
      setup: "Create a personal access token in the dashboard, or run `supabase login`.",
      acquisition: "manual",
    },
    supabase_mcp_oauth: {
      type: "oauth2",
      label: "OAuth 2.0",
      setup: "Point your MCP client at the server URL and approve access in the browser.",
    },
  },
  surfaces: [
    {
      type: "http",
      url: "https://api.supabase.com/v1",
      slug: "supabase-management-api",
      name: "Supabase Management API",
      docs: "https://supabase.com/docs/reference/api/introduction",
      basis: { via: "discovered", evidence: ["https://api.supabase.com/api/v1"] },
      auth: {
        status: "required",
        entries: [{ use: [{ id: "supabase_pat", mechanics: { source: "http", in: "header", headerName: "Authorization", scheme: "Bearer" } }] }],
      },
    },
    {
      type: "mcp",
      url: "https://mcp.supabase.com/mcp",
      transports: ["streamable-http"],
      slug: "supabase",
      name: "Supabase MCP Server",
      docs: "https://supabase.com/docs/guides/ai-tools/mcp",
      basis: { via: "detected", signal: "mcp:initialize" },
      auth: { status: "required", entries: [{ use: [{ id: "supabase_mcp_oauth", mechanics: { source: "well-known" } }] }] },
    },
    {
      type: "cli",
      command: "supabase",
      packages: [{ registryType: "homebrew", identifier: "supabase/tap/supabase" }],
      slug: "supabase-2",
      name: "Supabase CLI",
      docs: "https://supabase.com/docs/reference/cli",
      basis: { via: "discovered", evidence: ["https://supabase.com/docs/reference/cli"] },
      auth: { status: "required", entries: [{ use: [{ id: "supabase_pat", mechanics: { source: "cli" } }] }] },
    },
  ],
} satisfies Record<string, unknown>;

function stubFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as Response) as unknown as typeof fetch;
}

describe("integrations.sh registry adapter", () => {
  it("fetches and validates a surface document", async () => {
    const surface = await fetchRegistrySurface("supabase.com", { fetchImpl: stubFetch(200, SUPABASE_FIXTURE) });
    expect(surface?.domain).toBe("supabase.com");
    expect(surface?.surfaces).toHaveLength(3);
  });

  it("returns null for a 404 (domain not in registry)", async () => {
    const surface = await fetchRegistrySurface("nope.example", { fetchImpl: stubFetch(404, "") });
    expect(surface).toBeNull();
  });

  it("returns null when the registry has no surfaces for a domain", async () => {
    const surface = await fetchRegistrySurface("empty.example", {
      fetchImpl: stubFetch(200, { domain: "empty.example", surfaces: [] }),
    });
    expect(surface).toBeNull();
  });

  it("maps a surface document to an ax-eval vendor card, honoring an explicit slug", () => {
    const card = registryToVendorCard(SUPABASE_FIXTURE as RegistrySurface, {
      category: "database",
      vendorName: "Supabase",
      slug: "supabase",
    });
    expect(card.slug).toBe("supabase");
    expect(card.category).toBe("database");
    expect(card.resolver.method).toBe("registry");
    expect(card.resolver.registry_domain).toBe("supabase.com");
    expect(card.site_url).toBe("https://supabase.com");
    expect(card.docs_url).toBe("https://api.supabase.com/api/v1");
  });

  it("maps CLI + MCP surfaces with correct auth kinds", () => {
    const extract = registryToSurfaceExtract(SUPABASE_FIXTURE as RegistrySurface, {
      category: "database",
      slug: "supabase",
    });
    // CLI shares the HTTP surface's credential (supabase_pat) → inherit.
    expect(extract.cli?.bin).toBe("supabase");
    expect(extract.cli?.install).toBe("brew install supabase/tap/supabase");
    expect(extract.cli?.auth.kind).toBe("inherit");
    // MCP uses an OAuth2 credential not shared with HTTP → oauth_app, http transport.
    expect(extract.mcp?.server).toBe("https://mcp.supabase.com/mcp");
    expect(extract.mcp?.transport).toBe("http");
    expect(extract.mcp?.auth.kind).toBe("oauth_app");
    // The registry has no SDK surface type; ax-eval defers SDK anyway.
    expect(extract.sdk).toBeNull();
  });

  it("derives a title-cased vendor name and slug from the domain by default", () => {
    const card = registryToVendorCard(
      { ...(SUPABASE_FIXTURE as RegistrySurface), domain: "planetscale.com" },
      { category: "database" },
    );
    expect(card.vendor).toBe("Planetscale");
    expect(card.slug).toBe("planetscale");
  });

  it("exposes the registry's OpenAPI spec URL for ingest", () => {
    expect(registryOpenApiUrl(SUPABASE_FIXTURE as RegistrySurface)).toBe("https://api.supabase.com/api/v1-json");
  });
});
