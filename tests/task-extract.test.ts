import { describe, expect, it } from "vitest";
import { extractOracles } from "../src/generate/task-extract.js";
import { defaultSuiteMethodology } from "../src/generate/methodology.js";
import type { Suite } from "../src/generate/suite.js";
import type { ResolveResult } from "../src/generate/vendor-resolve.js";

describe("task extraction seeds", () => {
  it("uses deterministic database seeds before invoking generator authoring", async () => {
    const vendor: ResolveResult = {
      vendor: "Supabase",
      category: "database",
      slug: "supabase",
      discovered_at: "2026-01-01T00:00:00.000Z",
      resolver: { method: "llm-search", harness: "codex", model: "test", prompt_version: "test" },
      site_url: "https://supabase.com",
      docs_url: "https://supabase.com/docs",
      http_status: null,
    };
    const suite: Suite = {
      name: "DAEB-1-V3",
      version: 3,
      category: "database",
      methodology: defaultSuiteMethodology("database"),
      tasks: [{
        id: "db-T04-define-data-container",
        title: "T04: Create a logical data container",
        difficulty: "L1",
        skill: "define-data-container",
        intent: "Create `axarena_items_{ns}` with id and label.",
        oracle_hint: "Read back metadata.",
        allowed_surfaces: ["api", "sdk", "cli"],
        na_examples: [],
      }],
    };

    const result = await extractOracles(vendor, suite, {
      harness: "codex",
      effort: "low",
      supportMatrix: {
        schema: "ax.support-matrix/v1",
        benchmark: "DAEB-1-V3",
        category: "database",
        generated_at: "2026-01-01T00:00:00.000Z",
        entries: [
          { vendor: "Supabase", task_id: "db-T04-define-data-container", surface: "api", status: "supported", source_concept: "define-data-container" },
          { vendor: "Supabase", task_id: "db-T04-define-data-container", surface: "sdk", status: "supported", source_concept: "define-data-container" },
          { vendor: "Supabase", task_id: "db-T04-define-data-container", surface: "cli", status: "supported", source_concept: "define-data-container" },
        ],
      },
    });

    expect(result.vendor_config.sql_connection_env).toBe("SUPABASE_DB_URL");
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.checks[0]?.sql_query).toContain("information_schema.columns");
    expect(result.tasks[0]?.support_reference).toBe("supabase:db-T04-define-data-container:define-data-container");
  });

  it("quotes Postgres seeded identifiers that include the execution namespace", async () => {
    const vendor: ResolveResult = {
      vendor: "Supabase",
      category: "database",
      slug: "supabase",
      discovered_at: "2026-01-01T00:00:00.000Z",
      resolver: { method: "llm-search", harness: "codex", model: "test", prompt_version: "test" },
      site_url: "https://supabase.com",
      docs_url: "https://supabase.com/docs",
      http_status: null,
    };
    const suite: Suite = {
      name: "DAEB-1-V3",
      version: 3,
      category: "database",
      methodology: defaultSuiteMethodology("database"),
      tasks: [
        {
          id: "db-T02-backup-and-restore",
          title: "T02: Produce a recoverable backup artifact",
          difficulty: "L4",
          skill: "backup-and-restore",
          intent: "Create `axarena_backup_{ns}`.",
          oracle_hint: "Read back marker row.",
          allowed_surfaces: ["api", "sdk", "cli"],
          na_examples: [],
        },
        {
          id: "db-T07-query-records",
          title: "T07: Filter records",
          difficulty: "L1",
          skill: "query-records",
          intent: "Create `axarena_query_items_{ns}`.",
          oracle_hint: "Read back active rows.",
          allowed_surfaces: ["api", "sdk", "cli"],
          na_examples: [],
        },
      ],
    };

    const result = await extractOracles(vendor, suite, { harness: "codex", effort: "low" });
    const sql = result.tasks.flatMap((task) => task.checks.map((check) => check.sql_query ?? "")).join("\n");
    expect(sql).toContain('FROM "axarena_backup_{ns}"');
    expect(sql).toContain('FROM "axarena_query_items_{ns}"');
    expect(sql).not.toContain("FROM axarena_backup_{ns}");
    expect(sql).not.toContain("FROM axarena_query_items_{ns}");
  });

  it("uses a trigger-result table verifier for Turso server-side execution", async () => {
    const vendor: ResolveResult = {
      vendor: "Turso",
      category: "database",
      slug: "turso",
      discovered_at: "2026-01-01T00:00:00.000Z",
      resolver: { method: "llm-search", harness: "codex", model: "test", prompt_version: "test" },
      site_url: "https://turso.tech",
      docs_url: "https://docs.turso.tech",
      http_status: null,
    };
    const suite: Suite = {
      name: "DAEB-1-V3",
      version: 3,
      category: "database",
      methodology: defaultSuiteMethodology("database"),
      tasks: [{
        id: "db-T08-server-side-execution",
        title: "T08: Create and invoke a server-side routine",
        difficulty: "L3",
        skill: "server-side-execution",
        intent: "Create `axarena_echo_{ns}` that writes `axarena_ok_{ns}`.",
        oracle_hint: "Read back marker output.",
        allowed_surfaces: ["api", "sdk", "cli"],
        na_examples: [],
      }],
    };

    const result = await extractOracles(vendor, suite, { harness: "codex", effort: "low" });
    const check = result.tasks[0]?.checks[0];
    const sql = (check?.read_body_template as { requests?: Array<{ stmt?: { sql?: string } }> } | undefined)
      ?.requests?.[0]?.stmt?.sql;

    expect(sql).toContain('"{result_table}"');
    expect(sql).not.toContain("axarena_echo_{ns}\"()");
    expect(sql).toContain("WHERE value = 'axarena_ok_{ns}'");
    expect(sql).not.toContain(" OR ");
    expect(check?.expected).toBe("1");
  });

  it("verifies Convex action-backed tasks through /api/action", async () => {
    const vendor: ResolveResult = {
      vendor: "Convex",
      category: "database",
      slug: "convex",
      discovered_at: "2026-01-01T00:00:00.000Z",
      resolver: { method: "llm-search", harness: "codex", model: "test", prompt_version: "test" },
      site_url: "https://www.convex.dev",
      docs_url: "https://docs.convex.dev/home",
      http_status: null,
    };
    const suite: Suite = {
      name: "DAEB-1-V3",
      version: 3,
      category: "database",
      methodology: defaultSuiteMethodology("database"),
      tasks: [
        {
          id: "db-T08-server-side-execution",
          title: "T08: Create and invoke a server-side routine",
          difficulty: "L3",
          skill: "server-side-execution",
          intent: "Create `axarena_echo_{ns}`.",
          oracle_hint: "Read back marker output.",
          allowed_surfaces: ["api", "sdk", "cli"],
          na_examples: [],
        },
        {
          id: "db-T09-vector-search",
          title: "T09: Vector search",
          difficulty: "L2",
          skill: "vector-search",
          intent: "Rank `alpha_{ns}` first.",
          oracle_hint: "Read back top label.",
          allowed_surfaces: ["api", "sdk", "cli"],
          na_examples: [],
        },
      ],
    };

    const result = await extractOracles(vendor, suite, { harness: "codex", effort: "low" });
    const checks = result.tasks.map((task) => task.checks[0]);

    expect(checks.map((check) => check?.read_path_template)).toEqual(["/api/action", "/api/action"]);
    expect(checks[0]?.assert_field).toBe("value");
    expect(checks[1]?.assert_field).toBe("value.topLabel");
  });

  it("uses a short pack-level MongoDB database scope for Atlas seeds", async () => {
    const vendor: ResolveResult = {
      vendor: "MongoDB Atlas",
      category: "database",
      slug: "mongodb-atlas",
      discovered_at: "2026-01-01T00:00:00.000Z",
      resolver: { method: "llm-search", harness: "codex", model: "test", prompt_version: "test" },
      site_url: "https://www.mongodb.com",
      docs_url: "https://www.mongodb.com/docs/atlas/",
      http_status: null,
    };
    const suite: Suite = {
      name: "DAEB-1-V3",
      version: 3,
      category: "database",
      methodology: defaultSuiteMethodology("database"),
      tasks: [{
        id: "db-T04-define-data-container",
        title: "T04: Create a logical data container",
        difficulty: "L1",
        skill: "define-data-container",
        intent: "Create `axarena_items_{ns}`.",
        oracle_hint: "Read back collection metadata.",
        allowed_surfaces: ["api", "sdk", "cli"],
        na_examples: [],
      }],
    };

    const result = await extractOracles(vendor, suite, { harness: "codex", effort: "low" });

    expect(result.vendor_config.mongo_database).toBe("axarena_eval");
    expect(result.vendor_config.mongo_database?.length).toBeLessThanOrEqual(38);
    expect(result.tasks[0]?.checks[0]?.mongo_query?.database).toBe("");
  });

  it("verifies MongoDB schema tasks through collection metadata", async () => {
    const vendor: ResolveResult = {
      vendor: "MongoDB Atlas",
      category: "database",
      slug: "mongodb-atlas",
      discovered_at: "2026-01-01T00:00:00.000Z",
      resolver: { method: "llm-search", harness: "codex", model: "test", prompt_version: "test" },
      site_url: "https://www.mongodb.com",
      docs_url: "https://www.mongodb.com/docs/atlas/",
      http_status: null,
    };
    const suite: Suite = {
      name: "DAEB-1-V3",
      version: 3,
      category: "database",
      methodology: defaultSuiteMethodology("database"),
      tasks: [
        {
          id: "db-T05-evolve-schema",
          title: "T05: Apply a schema evolution",
          difficulty: "L3",
          skill: "evolve-schema",
          intent: "Add `status`.",
          oracle_hint: "Read back schema metadata.",
          allowed_surfaces: ["api", "sdk", "cli"],
          na_examples: [],
        },
        {
          id: "db-T06-inspect-schema",
          title: "T06: Inspect schema",
          difficulty: "L1",
          skill: "inspect-schema",
          intent: "Inspect `name` and `status`.",
          oracle_hint: "Read back schema metadata.",
          allowed_surfaces: ["api", "sdk", "cli"],
          na_examples: [],
        },
      ],
    };

    const result = await extractOracles(vendor, suite, { harness: "codex", effort: "low" });
    const checks = result.tasks.flatMap((task) => task.checks);

    expect(checks.map((check) => check.mongo_query?.operation)).toEqual(["listCollections", "listCollections", "listCollections"]);
    expect(checks.map((check) => check.assert_field)).toContain("0.options.validator.$jsonSchema.properties.status.bsonType");
    expect(checks.map((check) => check.assert_field)).toContain("0.options.validator.$jsonSchema.properties.name.bsonType");
  });
});
