import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  CapabilityInventorySchema,
  SupportMatrixSchema,
  auditCapabilityInventory,
  coverageMatrixPath,
  defaultSuiteMethodology,
  loadSupportMatrix,
  methodologyPath,
  selectionLedgerPath,
  supportMatrixPath,
  traceReviewPath,
  writeCapabilityInventory,
  writeCoverageMatrix,
  writeFailureTaxonomy,
  writeGraderLedger,
  writeMethodology,
  writeSelectionLedger,
  writeSupportMatrix,
  writeTraceReview,
} from "../src/generate/methodology.js";
import { composePack } from "../src/generate/compose-pack.js";
import { applyDatabasePackPromptOverride } from "../src/generate/database-pack-overrides.js";
import { buildVerificationClientOptions } from "../src/generate/verification-client.js";
import { loadCapabilityExtract } from "../src/generate/capability-extract.js";
import { auditSurfaceExtract } from "../src/generate/surface-extract.js";
import { TargetPackSchema } from "../src/schemas.js";
import type { Suite } from "../src/generate/suite.js";

describe("suite methodology artifacts", () => {
  it("defaults canonical suite scope to api/sdk/cli", () => {
    const methodology = defaultSuiteMethodology("database");
    expect(methodology.surface_scope).toEqual(["api", "sdk", "cli"]);
    expect(methodology.static_ax.dimensions).toContain("discoverability");
    expect(methodology.behavioral.source_of_truth).toMatch(/world state/i);
  });

  it("writes capability inventory and support matrix artifacts", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ax-methodology-"));
    try {
      const inventoryPath = writeCapabilityInventory(dir, CapabilityInventorySchema.parse({
        vendor: "Acme",
        slug: "acme",
        category: "database",
        extracted_at: "2026-01-01T00:00:00.000Z",
        capabilities: [{
          capability_name: "schema-migration",
          title: "Schema migration",
          family: "migration",
          description: "Tracked schema changes.",
          resource_kind: "table",
          operation_kind: "migrate",
          surfaces_documented: ["api", "cli"],
          support_type: "native",
          evidence: [{ doc_url: "https://docs.example/migrate", quote: "Run tracked migrations." }],
          extraction_provenance: { source: "official-docs", extracted_at: "2026-01-01T00:00:00.000Z", extractor: "test" },
        }],
      }));
      expect(inventoryPath).toContain("capability-inventory.yaml");
      expect(readdirSync(resolve(dir, "benchmarks", "daeb", "v1", "extracts", "acme"))).not.toContain("capabilities.yaml");

      writeSupportMatrix(dir, "benchmarks/daeb/v1/suite.yaml", SupportMatrixSchema.parse({
        schema: "ax.support-matrix/v1",
        benchmark: "DEMO",
        category: "database",
        generated_at: "2026-01-01T00:00:00.000Z",
        entries: [{
          vendor: "Acme",
          task_id: "db-T01-schema-migration",
          surface: "api",
          status: "supported",
          source_concept: "schema-migration",
        }],
      }));
      expect(loadSupportMatrix(dir, "benchmarks/daeb/v1/suite.yaml")?.entries).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads legacy capabilities.yaml extracts and upgrades them to inventory shape", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ax-methodology-legacy-"));
    try {
      const extractDir = resolve(dir, "benchmarks", "daeb", "v1", "extracts", "acme");
      mkdirSync(extractDir, { recursive: true });
      writeFileSync(resolve(extractDir, "capabilities.yaml"), [
        "vendor: Acme",
        "slug: acme",
        "category: database",
        "extracted_at: 2026-01-01T00:00:00.000Z",
        "capabilities:",
        "  - name: row-level-security",
        "    title: Row-level security",
        "    description: Restrict row access by identity.",
        "    doc_url: https://docs.example/rls",
        "    doc_quote: Enable policies per row.",
        "",
      ].join("\n"));

      const loaded = loadCapabilityExtract(dir, "acme");
      expect(loaded?.capabilities).toHaveLength(1);
      expect(loaded?.capabilities[0]?.capability_name).toBe("row-level-security");
      expect(loaded?.capabilities[0]?.family).toBeUndefined();
      expect(loaded?.capabilities[0]?.evidence[0]?.doc_url).toBe("https://docs.example/rls");
      expect(readdirSync(extractDir)).toContain("capability-inventory.yaml");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("audits weak capability evidence before inventory publication", () => {
    const audited = auditCapabilityInventory(CapabilityInventorySchema.parse({
      vendor: "MongoDB Atlas",
      slug: "mongodb-atlas",
      category: "database",
      extracted_at: "2026-01-01T02:00:00.000Z",
      capabilities: [{
        capability_name: "document-insert",
        title: "Document insert",
        description: "Insert documents via the MongoDB driver.",
        resource_kind: "document",
        operation_kind: "create",
        surfaces_documented: ["api", "sdk"],
        support_type: "native",
        evidence: [{
          doc_url: "https://www.mongodb.com/docs/api/doc/atlas-admin-api-v2/",
          quote: "POST /api/atlas/v2/groups/{groupId}/clusters - Create One Cluster",
          note: "Cluster provisioning exposes a standard MongoDB connection string; insertOne is available via any MongoDB driver.",
        }],
        extraction_provenance: {
          source: "official-docs",
          extracted_at: "2026-01-01T00:00:00.000Z",
          extractor: "llm-capability-inventory-v1",
        },
      }, {
        capability_name: "view-creation",
        title: "View creation",
        description: "Create a view.",
        resource_kind: "view",
        operation_kind: "create",
        surfaces_documented: ["sdk", "cli"],
        support_type: "native",
        evidence: [{ doc_url: "https://docs.example/llms.txt", quote: "CREATE VIEW - Named queries" }],
        extraction_provenance: {
          source: "official-docs",
          extracted_at: "2026-01-01T02:00:00.000Z",
          extractor: "llm-capability-inventory-v1",
        },
      }],
    }));

    expect(audited.capabilities[0]?.surfaces_documented).toEqual(["sdk"]);
    expect(audited.capabilities[0]?.support_type).toBe("idiomatic-pattern");
    expect(audited.capabilities[0]?.evidence[0]?.strength).toBe("derived_from_connection_surface");
    expect(audited.capabilities[0]?.extraction_provenance.extracted_at).toBe("2026-01-01T02:00:00.000Z");
    expect(audited.capabilities[1]?.evidence[0]?.strength).toBe("summary_index");
    expect(audited.audit_notes.join("\n")).toMatch(/connection-derived data-plane/);
    expect(audited.audit_notes.join("\n")).toMatch(/summary-index evidence/);
  });

  it("audits suspicious surface auth before publication", () => {
    const audited = auditSurfaceExtract({
      vendor: "Neon",
      slug: "neon",
      extracted_at: "2026-01-01T00:00:00.000Z",
      cli: {
        bin: "neon",
        docs_url: "https://neon.com/docs/cli",
        auth: {
          kind: "inherit",
          token_env_aliases: [],
          instructions: "Point your MCP client at the server URL and approve access in the browser.",
        },
      },
      sdk: null,
      mcp: null,
    });

    expect(audited.schema).toBe("ax.surface-extract/v1");
    expect(audited.audit_notes.join("\n")).toMatch(/copied from another surface/);
  });

  it("compose-pack respects support matrix and keeps MCP out of canonical packs", () => {
    const suite: Suite = {
      name: "DEMO",
      version: 1,
      category: "database",
      methodology: defaultSuiteMethodology("database"),
      tasks: [{
        id: "db-T01-schema-migration",
        title: "T01: schema migration",
        difficulty: "L2",
        skill: "schema-migration",
        intent: "Do the migration.",
        oracle_hint: "Read it back.",
        allowed_surfaces: ["api", "sdk", "cli"],
        na_examples: [],
      }],
    };
    const pack = composePack(
      suite,
      { vendor: "Acme", slug: "acme", category: "database", docs_url: "https://docs.example", site_url: "https://example.com" },
      {
        vendor: "Acme",
        category: "database",
        slug: "acme",
        suite_name: "DEMO",
        extracted_at: "2026-01-01T00:00:00.000Z",
        vendor_config: { base_url: "https://api.example", auth_type: "bearer", auth_env: "ACME_TOKEN" },
        tasks: [{
          task_id: "db-T01-schema-migration",
          na: false,
          na_reason: undefined,
          na_surfaces: [],
          na_surfaces_reason: undefined,
          support_reference: "acme:db-T01-schema-migration:schema-migration",
          checks: [{
            read_method: "POST",
            read_path_template: "/migrations/read",
            read_body_template: { id: "{gid}", ns: "{ns}" },
            assert_field: "name",
            expected: "ok",
            description: "",
          }],
        }],
      },
      {
        surfaces: {
          vendor: "Acme",
          slug: "acme",
          extracted_at: "2026-01-01T00:00:00.000Z",
          cli: {
            bin: "acme",
            install: "npm install -g acme",
            help: "acme --help",
            docs_url: "https://docs.example/cli",
            auth: { kind: "inherit" },
          },
          sdk: null,
          mcp: null,
        },
        supportMatrix: {
          schema: "ax.support-matrix/v1",
          benchmark: "DEMO",
          category: "database",
          generated_at: "2026-01-01T00:00:00.000Z",
          entries: [
            { vendor: "Acme", task_id: "db-T01-schema-migration", surface: "api", status: "supported", source_concept: "schema-migration" },
            { vendor: "Acme", task_id: "db-T01-schema-migration", surface: "sdk", status: "unsupported", source_concept: "schema-migration" },
            { vendor: "Acme", task_id: "db-T01-schema-migration", surface: "cli", status: "supported", source_concept: "schema-migration" },
          ],
        },
      },
    );
    expect(pack.tasks[0]?.allowed_surfaces).toEqual(["api", "cli"]);
    expect(pack.tasks[0]?.allowed_surfaces).not.toContain("mcp");
    expect(pack.tasks[0]?.oracles[0]?.readBodyTemplate).toEqual({ id: "{gid}", ns: "{ns}" });
  });

  it("compose-pack keeps DAEB-style API/CLI suite scope even when support matrix retains SDK research entries", () => {
    const suite: Suite = {
      name: "DAEB-1-V3",
      version: 3,
      category: "database",
      methodology: {
        ...defaultSuiteMethodology("database"),
        surface_scope: ["api", "cli"],
      },
      tasks: [{
        id: "db-T04-define-data-container",
        title: "T04: create container",
        difficulty: "L1",
        skill: "define-data-container",
        intent: "Create a container.",
        oracle_hint: "Read it back.",
        allowed_surfaces: ["api", "sdk", "cli"],
        na_examples: [],
      }],
    };
    const pack = composePack(
      suite,
      { vendor: "Acme", slug: "acme", category: "database", docs_url: "https://docs.example", site_url: "https://example.com" },
      {
        vendor: "Acme",
        category: "database",
        slug: "acme",
        suite_name: "DAEB-1-V3",
        extracted_at: "2026-01-01T00:00:00.000Z",
        vendor_config: { base_url: "https://api.example", auth_type: "bearer", auth_env: "ACME_TOKEN" },
        tasks: [{
          task_id: "db-T04-define-data-container",
          na: false,
          support_reference: "acme:db-T04-define-data-container:define-data-container",
          checks: [{
            read_method: "GET",
            read_path_template: "/containers/{ns}",
            assert_field: "name",
            expected: "ok",
            description: "",
          }],
        }],
      },
      {
        surfaces: {
          vendor: "Acme",
          slug: "acme",
          extracted_at: "2026-01-01T00:00:00.000Z",
          cli: {
            bin: "acme",
            install: "npm install -g acme",
            help: "acme --help",
            docs_url: "https://docs.example/cli",
            auth: { kind: "inherit" },
          },
          sdk: {
            package: "@acme/sdk",
            language: "typescript",
            install: "npm install @acme/sdk",
            reference_url: "https://docs.example/sdk",
            auth: { kind: "token", token_env: "ACME_TOKEN" },
          },
          mcp: null,
        },
        supportMatrix: {
          schema: "ax.support-matrix/v1",
          benchmark: "DAEB-1-V3",
          category: "database",
          generated_at: "2026-01-01T00:00:00.000Z",
          entries: [
            { vendor: "Acme", task_id: "db-T04-define-data-container", surface: "api", status: "supported", source_concept: "define-data-container" },
            { vendor: "Acme", task_id: "db-T04-define-data-container", surface: "sdk", status: "supported", source_concept: "define-data-container" },
            { vendor: "Acme", task_id: "db-T04-define-data-container", surface: "cli", status: "supported", source_concept: "define-data-container" },
          ],
        },
      },
    );
    expect(pack.tasks[0]?.allowed_surfaces).toEqual(["api", "cli"]);
    expect(pack.surfaces?.sdk).toBeUndefined();
  });

  it("applies the hardened Insforge API adapter contract to database prompts", () => {
    const prompt = applyDatabasePackPromptOverride(
      { vendor: "Insforge", slug: "insforge", category: "database", docs_url: "https://docs.insforge.dev" },
      {
        id: "db-T10-write-records",
        title: "T10: write records",
        difficulty: "L1",
        skill: "write-records",
        intent: "Write one lifecycle.",
        oracle_hint: "Read it back.",
        allowed_surfaces: ["api"],
        na_examples: [],
      },
      "Write one lifecycle.",
    );

    expect(prompt).toContain("do not call user-session discovery endpoints such as `GET /api/auth/sessions/current`");
    expect(prompt).toContain("use the hosted type name `string` and do not use SQL names like `text`");
    expect(prompt).toContain("make it globally monotonic for the project");
  });

  it("compose-pack rejects non-API task surfaces without pack-level surface declarations", () => {
    const suite: Suite = {
      name: "DEMO",
      version: 1,
      category: "database",
      methodology: defaultSuiteMethodology("database"),
      tasks: [{
        id: "db-T01-schema-migration",
        title: "T01: schema migration",
        difficulty: "L2",
        skill: "schema-migration",
        intent: "Do the migration.",
        oracle_hint: "Read it back.",
        allowed_surfaces: ["cli"],
        na_examples: [],
      }],
    };

    expect(() =>
      composePack(
        suite,
        { vendor: "Acme", slug: "acme", category: "database", docs_url: "https://docs.example", site_url: "https://example.com" },
        {
          vendor: "Acme",
          category: "database",
          slug: "acme",
          suite_name: "DEMO",
          extracted_at: "2026-01-01T00:00:00.000Z",
          vendor_config: { base_url: "https://api.example", auth_type: "bearer", auth_env: "ACME_TOKEN" },
          tasks: [{
            task_id: "db-T01-schema-migration",
            na: false,
            checks: [{
              read_method: "POST",
              read_path_template: "/migrations/read",
              assert_field: "name",
              expected: "ok",
              description: "",
            }],
          }],
        },
      )
    ).toThrow(/missing surfaces\.cli/);
  });

  it("compose-pack omits declared surfaces that have zero eligible tasks", () => {
    const suite: Suite = {
      name: "DEMO",
      version: 1,
      category: "database",
      methodology: defaultSuiteMethodology("database"),
      tasks: [{
        id: "db-T04-define-data-container",
        title: "T04: create container",
        difficulty: "L1",
        skill: "define-data-container",
        intent: "Create a container.",
        oracle_hint: "Read it back.",
        allowed_surfaces: ["api", "sdk"],
        na_examples: [],
      }],
    };
    const pack = composePack(
      suite,
      { vendor: "Acme", slug: "acme", category: "database", docs_url: "https://docs.example", site_url: "https://example.com" },
      {
        vendor: "Acme",
        category: "database",
        slug: "acme",
        suite_name: "DEMO",
        extracted_at: "2026-01-01T00:00:00.000Z",
        vendor_config: { base_url: "https://api.example", auth_type: "bearer", auth_env: "ACME_TOKEN" },
        tasks: [{
          task_id: "db-T04-define-data-container",
          na: false,
          checks: [{
            read_method: "POST",
            read_path_template: "/containers/read",
            assert_field: "ok",
            expected: true,
            description: "",
          }],
        }],
      },
      {
        surfaces: {
          vendor: "Acme",
          slug: "acme",
          extracted_at: "2026-01-01T00:00:00.000Z",
          cli: null,
          sdk: {
            package: "@acme/sdk",
            language: "node",
            reference_url: "https://docs.example/sdk",
            auth: { kind: "inherit" },
          },
          mcp: null,
        },
        supportMatrix: {
          schema: "ax.support-matrix/v1",
          benchmark: "DEMO",
          category: "database",
          generated_at: "2026-01-01T00:00:00.000Z",
          entries: [
            { vendor: "Acme", task_id: "db-T04-define-data-container", surface: "api", status: "supported", source_concept: "define-data-container" },
            { vendor: "Acme", task_id: "db-T04-define-data-container", surface: "sdk", status: "unsupported", source_concept: "define-data-container" },
            { vendor: "Acme", task_id: "db-T04-define-data-container", surface: "cli", status: "unsupported", source_concept: "define-data-container" },
          ],
        },
      },
    );

    expect(pack.tasks[0]?.allowed_surfaces).toEqual(["api"]);
    expect(pack.surfaces?.sdk).toBeUndefined();
  });

  it("compose-pack applies a CockroachDB SQL-wire surface fallback", () => {
    const suite: Suite = {
      name: "DEMO",
      version: 1,
      category: "database",
      methodology: defaultSuiteMethodology("database"),
      tasks: [{
        id: "db-T04-define-data-container",
        title: "T04: create container",
        difficulty: "L1",
        skill: "define-data-container",
        intent: "Create the table.",
        oracle_hint: "Read it back.",
        allowed_surfaces: ["sdk", "cli"],
        na_examples: [],
      }],
    };
    const pack = composePack(
      suite,
      { vendor: "CockroachDB", slug: "cockroachdb", category: "database", docs_url: "https://www.cockroachlabs.com/docs/", site_url: "https://www.cockroachlabs.com" },
      {
        vendor: "CockroachDB",
        category: "database",
        slug: "cockroachdb",
        suite_name: "DEMO",
        extracted_at: "2026-01-01T00:00:00.000Z",
        vendor_config: {
          base_url: "https://cockroachlabs.cloud/api/v1",
          auth_type: "bearer",
          auth_env: "COCKROACH_API_KEY",
          sql_dialect: "postgres",
          sql_connection_env: "COCKROACH_CONNECTION_STRING",
        },
        tasks: [{
          task_id: "db-T04-define-data-container",
          na: false,
          checks: [{
            sql_dialect: "postgres",
            sql_query: "select 1 as count",
            assert_field: "0.count",
            expected: 1,
            description: "",
          }],
        }],
      },
    );

    expect(pack.surfaces?.sdk?.package).toBe("pg");
    expect(pack.surfaces?.sdk?.auth?.token_env).toBe("COCKROACH_CONNECTION_STRING");
    expect(pack.surfaces?.cli?.bin).toBe("psql");
    expect(pack.tasks[0]?.allowed_surfaces).toEqual(["sdk", "cli"]);
  });

  it("compose-pack includes Neon sandbox context so agents do not create fresh projects", () => {
    const suite: Suite = {
      name: "DEMO",
      version: 1,
      category: "database",
      methodology: defaultSuiteMethodology("database"),
      tasks: [{
        id: "db-T01-schema-migration",
        title: "T01: schema migration",
        difficulty: "L2",
        skill: "schema-migration",
        intent: "Do the migration.",
        oracle_hint: "Read it back.",
        allowed_surfaces: ["api"],
        na_examples: [],
      }],
    };
    const pack = composePack(
      suite,
      { vendor: "Neon", slug: "neon", category: "database", docs_url: "https://neon.com/docs", site_url: "https://neon.com" },
      {
        vendor: "Neon",
        category: "database",
        slug: "neon",
        suite_name: "DEMO",
        extracted_at: "2026-01-01T00:00:00.000Z",
        vendor_config: {
          base_url: "https://console.neon.tech/api/v2",
          auth_type: "bearer",
          auth_env: "NEON_API_KEY",
          sql_dialect: "postgres",
          sql_connection_env: "NEON_DATABASE_URL",
        },
        tasks: [{
          task_id: "db-T01-schema-migration",
          na: false,
          checks: [{
            sql_dialect: "postgres",
            sql_query: "select 1 as ok",
            assert_field: "0.ok",
            expected: 1,
            description: "",
          }],
        }],
      },
    );

    expect(pack.sandbox_scope.map((scope) => scope.env)).toEqual(["NEON_PROJECT_ID", "NEON_BRANCH_ID"]);
    expect(pack.sandbox_scope[0]?.instructions).toMatch(/instead of creating a new project/i);
    expect(pack.sandbox_scope[1]?.required).toBe(false);
  });

  it("isolates Convex identifier compatibility guidance to the database vendor pack", () => {
    const suite: Suite = {
      name: "DEMO",
      version: 1,
      category: "database",
      methodology: defaultSuiteMethodology("database"),
      tasks: [{
        id: "db-T04-define-data-container",
        title: "T04: create container",
        difficulty: "L1",
        skill: "define-data-container",
        intent: "Create `axarena_items_{ns}`.",
        oracle_hint: "Read it back.",
        allowed_surfaces: ["api"],
        na_examples: [],
      }],
    };
    const extract = {
      vendor: "Convex",
      category: "database",
      slug: "convex",
      suite_name: "DEMO",
      extracted_at: "2026-01-01T00:00:00.000Z",
      vendor_config: { base_url: "${CONVEX_URL}", auth_type: "bearer" as const, auth_env: "CONVEX_DEPLOY_KEY" },
      tasks: [{
        task_id: "db-T04-define-data-container",
        na: false,
        checks: [{
          read_method: "POST" as const,
          read_path_template: "/api/query",
          read_body_template: { path: "{items_schema_query_path}", args: {} },
          assert_field: "value.hasLabelField",
          expected: true,
          description: "",
        }],
      }],
    };

    const convexPack = composePack(
      suite,
      { vendor: "Convex", slug: "convex", category: "database", docs_url: "https://docs.convex.dev", site_url: "https://convex.dev" },
      extract,
    );
    const acmePack = composePack(
      suite,
      { vendor: "Acme", slug: "acme", category: "database", docs_url: "https://docs.example", site_url: "https://example.com" },
      { ...extract, vendor: "Acme", slug: "acme", vendor_config: { base_url: "https://api.example", auth_type: "bearer" as const, auth_env: "ACME_TOKEN" } },
    );

    expect(convexPack.tasks[0]?.prompt).toContain("Convex-specific database adapter note");
    expect(convexPack.tasks[0]?.prompt).toContain("replacing non-alphanumeric characters with underscores");
    expect(convexPack.tasks[0]?.prompt).toContain("Convex deployment/admin contract");
    expect(convexPack.tasks[0]?.prompt).toContain("convex deploy --preview-name <run-scoped-name>");
    expect(convexPack.tasks[0]?.prompt).toContain("stop guessing pre-existing mutation/action names");
    expect(convexPack.tasks[0]?.prompt).toContain("prefer reusing the existing local Convex project scaffold");
    expect(convexPack.tasks[0]?.prompt).toContain("not as a reason to run `npm install`");
    expect(convexPack.tasks[0]?.prompt).toContain("prefer that preview-deployment path by default");
    expect(convexPack.tasks[0]?.prompt).toContain("returns `{hasLabelField:boolean}`");
    expect(acmePack.tasks[0]?.prompt).not.toContain("Convex-specific database adapter note");
  });

  it("adds SQL identifier quoting guidance only to SQL-backed database packs", () => {
    const suite: Suite = {
      name: "DEMO",
      version: 1,
      category: "database",
      methodology: defaultSuiteMethodology("database"),
      tasks: [{
        id: "db-T04-define-data-container",
        title: "T04: create container",
        difficulty: "L1",
        skill: "define-data-container",
        intent: "Create `axarena_items_{ns}`.",
        oracle_hint: "Read it back.",
        allowed_surfaces: ["api"],
        na_examples: [],
      }],
    };
    const extract = {
      vendor: "Neon",
      category: "database",
      slug: "neon",
      suite_name: "DEMO",
      extracted_at: "2026-01-01T00:00:00.000Z",
      vendor_config: {
        base_url: "https://console.neon.tech/api/v2",
        auth_type: "bearer" as const,
        auth_env: "NEON_API_KEY",
        sql_dialect: "postgres" as const,
        sql_connection_env: "NEON_DATABASE_URL",
      },
      tasks: [{
        task_id: "db-T04-define-data-container",
        na: false,
        checks: [{
          sql_dialect: "postgres" as const,
          sql_query: "select 1 as count",
          assert_field: "0.count",
          expected: 1,
          description: "",
        }],
      }],
    };

    const neonPack = composePack(
      suite,
      { vendor: "Neon", slug: "neon", category: "database", docs_url: "https://neon.com/docs", site_url: "https://neon.com" },
      extract,
    );
    const mongoPack = composePack(
      suite,
      { vendor: "MongoDB Atlas", slug: "mongodb-atlas", category: "database", docs_url: "https://www.mongodb.com/docs/atlas", site_url: "https://www.mongodb.com/atlas" },
      {
        ...extract,
        vendor: "MongoDB Atlas",
        slug: "mongodb-atlas",
        vendor_config: {
          base_url: "https://cloud.mongodb.com/api/atlas/v2",
          auth_type: "bearer" as const,
          auth_env: "MONGODB_ATLAS_ADMIN_API_KEY",
          mongo_connection_env: "ATLAS_CONNECTION_STRING",
        },
      },
    );
    const convexPack = composePack(
      suite,
      { vendor: "Convex", slug: "convex", category: "database", docs_url: "https://docs.convex.dev", site_url: "https://convex.dev" },
      {
        ...extract,
        vendor: "Convex",
        slug: "convex",
        vendor_config: { base_url: "${CONVEX_URL}", auth_type: "bearer" as const, auth_env: "CONVEX_DEPLOY_KEY" },
      },
    );

    expect(neonPack.tasks[0]?.prompt).toContain("Database SQL identifier contract");
    expect(neonPack.tasks[0]?.prompt).toContain("double-quote table, function, policy, index, trigger");
    expect(neonPack.tasks[0]?.prompt).toContain("do not replace hyphens with underscores for SQL-backed vendors");
    expect(neonPack.tasks[0]?.prompt).toContain("Neon CLI contract");
    expect(neonPack.tasks[0]?.prompt).toContain("`--role-name <role>`");
    expect(neonPack.tasks[0]?.prompt).toContain("process.env.NEON_DATABASE_URL");
    expect(mongoPack.tasks[0]?.prompt).not.toContain("Database SQL identifier contract");
    expect(mongoPack.tasks[0]?.prompt).not.toContain("Neon CLI contract");
    expect(convexPack.tasks[0]?.prompt).not.toContain("Database SQL identifier contract");
    expect(convexPack.tasks[0]?.prompt).not.toContain("Neon CLI contract");
    expect(convexPack.tasks[0]?.prompt).toContain("Convex-specific database adapter note");
    expect(convexPack.tasks[0]?.prompt).toContain("Convex deployment/admin contract");
    expect(convexPack.tasks[0]?.prompt).toContain("deploy task-local public functions");
    expect(convexPack.tasks[0]?.prompt).toContain("prefer reusing the existing local Convex project scaffold");
    expect(convexPack.tasks[0]?.prompt).toContain("smoke-check them on the preview deployment");
  });

  it("adds zero-argument SQL routine guidance for SQL-backed server-side execution tasks", () => {
    const suite: Suite = {
      name: "DEMO",
      version: 1,
      category: "database",
      methodology: defaultSuiteMethodology("database"),
      tasks: [{
        id: "db-T08-server-side-execution",
        title: "T08: routine",
        difficulty: "L3",
        skill: "server-side-execution",
        intent: "Create `axarena_echo_{ns}`.",
        oracle_hint: "Read it back.",
        allowed_surfaces: ["api"],
        na_examples: [],
      }],
    };
    const extract = {
      vendor: "Neon",
      category: "database",
      slug: "neon",
      suite_name: "DEMO",
      extracted_at: "2026-01-01T00:00:00.000Z",
      vendor_config: {
        base_url: "https://console.neon.tech/api/v2",
        auth_type: "bearer" as const,
        auth_env: "NEON_API_KEY",
        sql_dialect: "postgres" as const,
        sql_connection_env: "NEON_DATABASE_URL",
      },
      tasks: [{
        task_id: "db-T08-server-side-execution",
        na: false,
        checks: [{
          sql_dialect: "postgres" as const,
          sql_query: "SELECT \"axarena_echo_{ns}\"() AS result",
          assert_field: "0.result",
          expected: "axarena_ok_{ns}",
          description: "",
        }],
      }],
    };

    const pack = composePack(
      suite,
      { vendor: "Neon", slug: "neon", category: "database", docs_url: "https://neon.com/docs", site_url: "https://neon.com" },
      extract,
    );

    expect(pack.tasks[0]?.prompt).toContain("SQL server-side routine contract");
    expect(pack.tasks[0]?.prompt).toContain("zero-argument routine");
    expect(pack.tasks[0]?.prompt).toContain("Do not rely on bind parameters inside `CREATE FUNCTION`");
    expect(pack.tasks[0]?.prompt).toContain("result table column named `value`");
  });

  it("adds exact SQL write-lifecycle postcondition guidance for SQL-backed T10 tasks", () => {
    const suite: Suite = {
      name: "DEMO",
      version: 1,
      category: "database",
      methodology: defaultSuiteMethodology("database"),
      tasks: [{
        id: "db-T10-write-records",
        title: "T10: write lifecycle",
        difficulty: "L1",
        skill: "write-records",
        intent: "Create, update, and delete marker records in `axarena_write_items_{ns}`.",
        oracle_hint: "Read it back.",
        allowed_surfaces: ["api"],
        na_examples: [],
      }],
    };
    const extract = {
      vendor: "Supabase",
      category: "database",
      slug: "supabase",
      suite_name: "DEMO",
      extracted_at: "2026-01-01T00:00:00.000Z",
      vendor_config: {
        base_url: "https://${SUPABASE_PROJECT_REF}.supabase.co",
        auth_type: "bearer" as const,
        auth_env: "SUPABASE_API_KEY",
        sql_dialect: "postgres" as const,
        sql_connection_env: "SUPABASE_DB_URL",
      },
      tasks: [{
        task_id: "db-T10-write-records",
        na: false,
        checks: [{
          sql_dialect: "postgres" as const,
          sql_query: "select 1 as count",
          assert_field: "0.count",
          expected: 1,
          description: "",
        }],
      }],
    };

    const supabasePack = composePack(
      suite,
      { vendor: "Supabase", slug: "supabase", category: "database", docs_url: "https://supabase.com/docs", site_url: "https://supabase.com" },
      extract,
    );
    const mongoPack = composePack(
      suite,
      { vendor: "MongoDB Atlas", slug: "mongodb-atlas", category: "database", docs_url: "https://www.mongodb.com/docs/atlas", site_url: "https://www.mongodb.com/atlas" },
      {
        ...extract,
        vendor: "MongoDB Atlas",
        slug: "mongodb-atlas",
        vendor_config: {
          base_url: "https://cloud.mongodb.com/api/atlas/v2",
          auth_type: "bearer" as const,
          auth_env: "MONGODB_ATLAS_ADMIN_API_KEY",
          mongo_connection_env: "ATLAS_CONNECTION_STRING",
        },
      },
    );

    expect(supabasePack.tasks[0]?.prompt).toContain("SQL write lifecycle contract");
    expect(supabasePack.tasks[0]?.prompt).toContain("one row labeled `final_{ns}`");
    expect(supabasePack.tasks[0]?.prompt).toContain("zero rows labeled `draft_{ns}`");
    expect(supabasePack.tasks[0]?.prompt).toContain("zero rows labeled `delete_me_{ns}`");
    expect(mongoPack.tasks[0]?.prompt).not.toContain("SQL write lifecycle contract");
  });

  it("adds MongoDB Atlas SDK task contracts for change streams and vector indexes", () => {
    const suite: Suite = {
      name: "DEMO",
      version: 1,
      category: "database",
      methodology: defaultSuiteMethodology("database"),
      tasks: [
        {
          id: "db-T03-change-data-capture",
          title: "T03: CDC",
          difficulty: "L4",
          skill: "change-data-capture",
          intent: "Capture one insert event.",
          oracle_hint: "Read it back.",
          allowed_surfaces: ["sdk"],
          na_examples: [],
        },
        {
          id: "db-T09-vector-search",
          title: "T09: vector",
          difficulty: "L2",
          skill: "vector-search",
          intent: "Run vector search.",
          oracle_hint: "Read it back.",
          allowed_surfaces: ["sdk"],
          na_examples: [],
        },
      ],
    };
    const extract = {
      vendor: "MongoDB Atlas",
      category: "database",
      slug: "mongodb-atlas",
      suite_name: "DEMO",
      extracted_at: "2026-01-01T00:00:00.000Z",
      vendor_config: {
        base_url: "https://cloud.mongodb.com/api/atlas/v2",
        auth_type: "bearer" as const,
        auth_env: "ATLAS_CONNECTION_STRING",
        mongo_connection_env: "ATLAS_CONNECTION_STRING",
      },
      tasks: [
        {
          task_id: "db-T03-change-data-capture",
          na: false,
          checks: [{
            mongo_query: {
              database: "",
              collection: "{capture_collection}",
              operation: "count" as const,
              filter: { row_label: "cdc_probe_{ns}" },
            },
            assert_field: "count",
            expected: 1,
            description: "",
          }],
        },
        {
          task_id: "db-T09-vector-search",
          na: false,
          checks: [{
            mongo_query: {
              database: "",
              collection: "axarena_vectors_{ns}",
              operation: "aggregate" as const,
              pipeline: [{ $project: { label: 1 } }],
            },
            assert_field: "0.label",
            expected: "alpha_{ns}",
            description: "",
          }],
        },
      ],
    };

    const pack = composePack(
      suite,
      { vendor: "MongoDB Atlas", slug: "mongodb-atlas", category: "database", docs_url: "https://www.mongodb.com/docs/atlas", site_url: "https://www.mongodb.com/atlas" },
      extract,
      {
        surfaces: {
          vendor: "MongoDB Atlas",
          slug: "mongodb-atlas",
          extracted_at: "2026-01-01T00:00:00.000Z",
          cli: null,
          sdk: {
            package: "mongodb",
            language: "node",
            reference_url: "https://www.mongodb.com/docs/drivers/node/current/",
            auth: { kind: "token", token_env: "ATLAS_CONNECTION_STRING" },
          },
          mcp: null,
        },
      },
    );

    expect(pack.tasks[0]?.prompt).toContain("MongoDB Atlas change-stream contract");
    expect(pack.tasks[0]?.prompt).toContain("open the change stream before inserting");
    expect(pack.tasks[1]?.prompt).toContain("MongoDB Atlas vector-search contract");
    expect(pack.tasks[1]?.prompt).toContain("do not enable Stable API strict mode");
    expect(pack.tasks[1]?.prompt).toContain("createSearchIndexes");
  });

  it("uses the agent-discovered Convex deployment and no auth for function read-back", () => {
    const pack = TargetPackSchema.parse({
      name: "convex",
      run_id: "2026-07-02-demo",
      base_url: "${CONVEX_URL}",
      auth: { type: "bearer", env: "CONVEX_DEPLOY_KEY", header: "Authorization" },
      tasks: [],
    });
    const opts = buildVerificationClientOptions(pack, {
      profile: "low",
      ns: "demo",
      surface: "api",
      discovery: {
        base_url_found: "https://preview-example-123.convex.cloud",
        searches: [],
        urls_visited: [],
        endpoint_used: "POST /api/query",
        auth_scheme_found: "public Convex function endpoint",
        notes: "",
      },
      results: {},
    });

    expect(opts.baseUrl).toBe("https://preview-example-123.convex.cloud");
    expect(opts.authScheme).toBe("none");
    expect(opts.token).toBe("");
    expect(opts.authHeader).toBeUndefined();
  });

  it("isolates Insforge API schema guidance to the database vendor pack", () => {
    const suite: Suite = {
      name: "DEMO",
      version: 1,
      category: "database",
      methodology: defaultSuiteMethodology("database"),
      tasks: [{
        id: "db-T04-define-data-container",
        title: "T04: create container",
        difficulty: "L1",
        skill: "define-data-container",
        intent: "Create `axarena_items_{ns}`.",
        oracle_hint: "Read it back.",
        allowed_surfaces: ["api"],
        na_examples: [],
      }],
    };
    const extract = {
      vendor: "Insforge",
      category: "database",
      slug: "insforge",
      suite_name: "DEMO",
      extracted_at: "2026-01-01T00:00:00.000Z",
      vendor_config: {
        base_url: "${INSFORGE_PROJECT_URL}",
        auth_type: "bearer" as const,
        auth_env: "INSFORGE_API_KEY",
        sql_dialect: "postgres" as const,
        sql_connection_env: "INSFORGE_CONNECTION_STRING",
      },
      tasks: [{
        task_id: "db-T04-define-data-container",
        na: false,
        checks: [{
          sql_dialect: "postgres" as const,
          sql_query: "select 1 as count",
          assert_field: "0.count",
          expected: 1,
          description: "",
        }],
      }],
    };

    const pack = composePack(
      suite,
      { vendor: "Insforge", slug: "insforge", category: "database", docs_url: "https://docs.insforge.dev", site_url: "https://insforge.dev" },
      extract,
    );

    expect(pack.tasks[0]?.prompt).toContain("Insforge-specific database adapter note");
    expect(pack.tasks[0]?.prompt).toContain("POST /api/database/tables");
    expect(pack.tasks[0]?.prompt).toContain("PATCH /api/database/tables/{tableName}/schema");
    expect(pack.tasks[0]?.prompt).toContain("columns: [{columnName, type, isNullable, isUnique}]");
    expect(pack.tasks[0]?.prompt).toContain("migration `name` lowercase");
    expect(pack.tasks[0]?.prompt).toContain("POST /api/database/rpc/{functionName}");
    expect(pack.tasks[0]?.prompt).toContain("Do not batch");
    expect(pack.tasks[0]?.prompt).toContain("security-parser rejection");
  });

  it("persists publication-grade methodology artifacts for both layers without coupling scores", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ax-methodology-pub-"));
    try {
      const suitePath = "benchmarks/daeb/v1/suite.yaml";
      const methodology = defaultSuiteMethodology("database");
      writeMethodology(dir, suitePath, methodology);
      writeCoverageMatrix(dir, suitePath, {
        schema: "ax.coverage-matrix/v1",
        category: "database",
        generated_at: "2026-01-01T00:00:00.000Z",
        concepts: [{
          concept_name: "schema-migration",
          title: "Schema migration",
          decisions: [{
            concept_name: "schema-migration",
            vendor: "Acme",
            status: "supported",
            source: "inventory",
            capability_name: "schema-migration",
            family: "migration",
            evidence: [{ doc_url: "https://docs.example/migrate", quote: "Run tracked migrations." }],
          }],
        }],
      });
      writeSelectionLedger(dir, suitePath, {
        schema: "ax.selection-ledger/v1",
        benchmark: "DEMO",
        category: "database",
        generated_at: "2026-01-01T00:00:00.000Z",
        methodology,
        entries: [{
          concept_name: "schema-migration",
          title: "Schema migration",
          family: "migration",
          proposed_difficulty: "L3",
          coverage_pct: 1,
          covered_vendors: ["Acme"],
          verifiable: true,
          selected_by_model: true,
          selected: true,
          rationale: "High coverage and deterministic read-back.",
        }],
      });
      writeSupportMatrix(dir, suitePath, {
        schema: "ax.support-matrix/v1",
        benchmark: "DEMO",
        category: "database",
        generated_at: "2026-01-01T00:00:00.000Z",
        entries: [
          { vendor: "Acme", task_id: "db-T01-schema-migration", surface: "api", status: "supported", source_concept: "schema-migration" },
          { vendor: "Acme", task_id: "db-T01-schema-migration", surface: "cli", status: "supported", source_concept: "schema-migration" },
          { vendor: "Acme", task_id: "db-T01-schema-migration", surface: "sdk", status: "unsupported", source_concept: "schema-migration" },
        ],
      });
      writeGraderLedger(dir, suitePath, {
        schema: "ax.grader-ledger/v1",
        benchmark: "DEMO",
        generated_at: "2026-01-01T00:00:00.000Z",
        tasks: [{
          task_id: "db-T01-schema-migration",
          outcome_graders: ["read-back-world-state"],
          trajectory_graders: ["transcript-review"],
          efficiency_metrics: ["turn_count"],
          human_calibration: ["grader-fairness-review"],
        }],
      });
      writeFailureTaxonomy(dir, suitePath, {
        schema: "ax.failure-taxonomy/v1",
        benchmark: "DEMO",
        generated_at: "2026-01-01T00:00:00.000Z",
        categories: [{ id: "agent-failure", label: "Agent failure", description: "Agent could not complete a supported task." }],
      });
      writeTraceReview(dir, suitePath, {
        schema: "ax.trace-review/v1",
        benchmark: "DEMO",
        generated_at: "2026-01-01T00:00:00.000Z",
        sample_size: 10,
        summary: "Review a fixed trace sample for every methodology revision.",
      });

      expect(methodologyPath(dir, suitePath)).toContain(".methodology.yaml");
      expect(coverageMatrixPath(dir, suitePath)).toContain(".coverage-matrix.yaml");
      expect(selectionLedgerPath(dir, suitePath)).toContain(".selection-ledger.yaml");
      expect(supportMatrixPath(dir, suitePath)).toContain(".support-matrix.yaml");
      expect(traceReviewPath(dir, suitePath)).toContain(".trace-review.yaml");
      expect(methodology.static_ax.notes[0]).toMatch(/never changes usability-suite pass rates/i);
      expect(methodology.behavioral.label).toBe("Usability Canonical Suite");
      expect(methodology.behavioral.notes[0]).toMatch(/usability-suite scoring/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
