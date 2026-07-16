import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CapabilityExtractResult } from "../src/generate/capability-extract.js";
import type { Suite } from "../src/generate/suite.js";
import type { SurfaceExtractResult } from "../src/generate/surface-extract.js";
import { extractTasks, loadTaskExtract, writeTaskExtract } from "../src/generate/task-extract.js";
import type { ResolveResult } from "../src/generate/vendor-resolve.js";

const vendor: ResolveResult = {
  vendor: "AcmeDB",
  slug: "acmedb",
  category: "database",
  discovered_at: "2026-01-01T00:00:00.000Z",
  resolver: { method: "grounded-generator", prompt_version: "test" },
  site_url: "https://acme.example",
  docs_url: "https://docs.acme.example",
};

const suite: Suite = {
  name: "db-core",
  version: 1,
  category: "database",
  tasks: [
    {
      id: "db-create",
      title: "Create a table",
      difficulty: "L1",
      skill: "data-definition",
      intent: "Create ax_items_{ns}.",
      oracle_hint: "Read table metadata.",
      allowed_surfaces: ["api", "cli"],
      na_examples: [],
    },
    {
      id: "db-recover",
      title: "Recover data",
      difficulty: "L4",
      skill: "recovery",
      intent: "Recover ax_items_{ns}.",
      oracle_hint: "Read recovered data.",
      allowed_surfaces: ["api"],
      na_examples: ["No recovery feature"],
    },
  ],
};

const capabilities: CapabilityExtractResult = {
  vendor: vendor.vendor,
  slug: vendor.slug,
  category: vendor.category,
  extracted_at: "2026-01-01T00:00:00.000Z",
  extraction_provenance: { source: "official-docs", extractor: "test" },
  capabilities: [{
    capability_name: "tables",
    title: "Tables",
    family: "data-definition",
    description: "Create tables.",
    resource_kind: "table",
    operation_kind: "create",
    surfaces_documented: ["api", "cli"],
    support_type: "native",
    evidence: [{ doc_url: "https://docs.acme.example/tables", quote: "Create tables." }],
  }],
};

const surfaces: SurfaceExtractResult = {
  vendor: vendor.vendor,
  slug: vendor.slug,
  extracted_at: "2026-01-01T00:00:00.000Z",
  cli: {
    bin: "acme",
    install: "npm install -g acme-cli",
    docs_url: "https://docs.acme.example/cli",
    auth: { kind: "inherit" },
  },
  sdk: null,
  mcp: null,
};

function generatedTasks(): object {
  return {
    tasks: [
      {
        id: "db-create",
        prompt: "Create ax_items_{ns} using official AcmeDB tooling.",
        allowed_surfaces: ["api", "cli"],
        na: false,
        na_reason: null,
        support_evidence: [{ doc_url: "https://docs.acme.example/tables", quote: "Create tables." }],
        oracles: [{
          type: "roundtrip",
          sqlDialect: "postgres",
          sqlQuery: "SELECT table_name FROM information_schema.tables WHERE table_name = 'ax_items_{ns}'",
          assertField: "table_name",
          expected: "ax_items_{ns}",
          description: "Table exists.",
        }],
      },
      {
        id: "db-recover",
        prompt: "",
        allowed_surfaces: ["api"],
        na: true,
        na_reason: "Official documentation does not expose point-in-time recovery.",
        support_evidence: [{ doc_url: "https://docs.acme.example/limits", quote: "Recovery is unavailable." }],
        oracles: [],
      },
    ],
  };
}

describe("task extraction", () => {
  it("preserves the canonical task set and accepts explicit N/A", async () => {
    const generated = generatedTasks() as { tasks: unknown[] };
    generated.tasks.reverse();
    const result = await extractTasks(vendor, suite, capabilities, surfaces, {
      generate: async () => JSON.stringify(generated),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(result.tasks.map((task) => task.id)).toEqual(["db-create", "db-recover"]);
    expect(result.tasks[0]?.title).toBe("Create a table");
    expect(result.tasks[1]?.na).toBe(true);
  });

  it("rejects mutating verifier queries and unrelated evidence", async () => {
    const generated = generatedTasks() as { tasks: Array<Record<string, unknown>> };
    generated.tasks[0]!.oracles = [{
      type: "roundtrip",
      sqlDialect: "postgres",
      sqlQuery: "DELETE FROM ax_items",
      assertField: "count",
      expected: 0,
      description: "Unsafe.",
    }];
    await expect(extractTasks(vendor, suite, capabilities, surfaces, {
      generate: async () => JSON.stringify(generated),
    })).rejects.toThrow(/read-only|mutating/i);

    const offsite = generatedTasks() as { tasks: Array<Record<string, unknown>> };
    offsite.tasks[0]!.support_evidence = [{ doc_url: "https://unrelated.example/tables", quote: "Claim." }];
    await expect(extractTasks(vendor, suite, capabilities, surfaces, {
      generate: async () => JSON.stringify(offsite),
    })).rejects.toThrow(/non-official host/);
  });

  it("accepts a reviewed Postgres denial oracle with a deterministic role", async () => {
    const generated = generatedTasks() as { tasks: Array<Record<string, unknown>> };
    generated.tasks[0]!.oracles = [{
      type: "roundtrip",
      sqlDialect: "postgres",
      sqlQuery: "SELECT secret FROM restricted_items_{ns}",
      sqlRoleTemplate: "restricted_{ns}",
      assertOutcome: "error",
      assertField: "code",
      expected: "42501",
      description: "Restricted role is denied.",
    }];
    const result = await extractTasks(vendor, suite, capabilities, surfaces, {
      generate: async () => JSON.stringify(generated),
      now: () => new Date("2026-07-16T00:00:00.000Z"),
    });
    expect(result.tasks[0]?.oracles[0]).toMatchObject({
      assertOutcome: "error",
      sqlRoleTemplate: "restricted_{ns}",
    });
  });

  it("rejects task-set and surface drift", async () => {
    const generated = generatedTasks() as { tasks: Array<Record<string, unknown>> };
    generated.tasks.pop();
    await expect(extractTasks(vendor, suite, capabilities, surfaces, {
      generate: async () => JSON.stringify(generated),
    })).rejects.toThrow(/missing \[db-recover\]/);

    const unavailable = generatedTasks() as { tasks: Array<Record<string, unknown>> };
    unavailable.tasks[0]!.allowed_surfaces = ["sdk"];
    await expect(extractTasks(vendor, suite, capabilities, surfaces, {
      generate: async () => JSON.stringify(unavailable),
    })).rejects.toThrow(/unavailable surface sdk/);
  });

  it("rejects credential-reporting fields and incomplete assertions", async () => {
    const credentialField = generatedTasks() as { tasks: Array<Record<string, unknown>> };
    const oracle = (credentialField.tasks[0]!.oracles as Array<Record<string, unknown>>)[0]!;
    oracle.authField = "user_token";
    await expect(extractTasks(vendor, suite, capabilities, surfaces, {
      generate: async () => JSON.stringify(credentialField),
    })).rejects.toThrow(/unrecognized key|invalid/i);

    const missingExpected = generatedTasks() as { tasks: Array<Record<string, unknown>> };
    delete (missingExpected.tasks[0]!.oracles as Array<Record<string, unknown>>)[0]!.expected;
    await expect(extractTasks(vendor, suite, capabilities, surfaces, {
      generate: async () => JSON.stringify(missingExpected),
    })).rejects.toThrow(/required|invalid/i);
  });

  it("rejects mutating GraphQL verifier operations", async () => {
    const generated = generatedTasks() as { tasks: Array<Record<string, unknown>> };
    generated.tasks[0]!.oracles = [{
      type: "roundtrip",
      readQueryTemplate: "# verifier\nmutation DeleteItem { deleteItem(id: 1) }",
      assertField: "item.id",
      expected: "1",
      description: "Unsafe.",
    }];
    await expect(extractTasks(vendor, suite, capabilities, surfaces, {
      generate: async () => JSON.stringify(generated),
    })).rejects.toThrow(/read-only GraphQL query|invalid/i);
  });

  it("rejects generated MongoDB error-outcome oracles", async () => {
    const generated = generatedTasks() as { tasks: Array<Record<string, unknown>> };
    generated.tasks[0]!.oracles = [{
      type: "roundtrip",
      description: "restricted collection is denied",
      assertField: "code",
      expected: "permission_denied",
      assertOutcome: "error",
      mongoQuery: {
        database: "sandbox",
        collection: "restricted",
        operation: "findOne",
        filter: { _id: "{gid}" },
      },
    }];

    await expect(extractTasks(vendor, suite, capabilities, surfaces, {
      generate: async () => JSON.stringify(generated),
    })).rejects.toThrow(/MongoDB error outcomes are not supported|invalid/i);
  });

  it("writes and loads validated extracts atomically", async () => {
    const result = await extractTasks(vendor, suite, capabilities, surfaces, {
      generate: async () => JSON.stringify(generatedTasks()),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const root = mkdtempSync(join(tmpdir(), "ax-eval-task-extract-"));
    try {
      const path = writeTaskExtract(root, result);
      expect(existsSync(`${path}.tmp`)).toBe(false);
      expect(loadTaskExtract(root, vendor.slug, suite.name)).toEqual(result);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
