import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPack } from "../src/config.js";
import { composePack, writeComposedPack } from "../src/generate/compose-pack.js";
import type { PackComposeConfig } from "../src/generate/pack-compose-config.js";
import type { Suite } from "../src/generate/suite.js";
import type { SurfaceExtractResult } from "../src/generate/surface-extract.js";
import type { TaskExtractResult } from "../src/generate/task-extract.js";
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
  tasks: [{
    id: "db-create",
    title: "Create a table",
    difficulty: "L1",
    skill: "data-definition",
    intent: "Create ax_items_{ns}.",
    oracle_hint: "Read table metadata.",
    allowed_surfaces: ["api", "cli"],
    na_examples: [],
  }, {
    id: "db-recover",
    title: "Recover data",
    difficulty: "L4",
    skill: "recovery",
    intent: "Recover data.",
    oracle_hint: "Read restored data.",
    allowed_surfaces: ["api"],
    na_examples: [],
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

const taskExtract: TaskExtractResult = {
  vendor: vendor.vendor,
  slug: vendor.slug,
  suite_name: suite.name,
  suite_version: suite.version,
  extracted_at: "2026-01-01T00:00:00.000Z",
  extractor: "fixture",
  tasks: [{
    id: "db-create",
    title: "Create a table",
    difficulty: "L1",
    prompt: "Create ax_items_{ns}.",
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
  }, {
    id: "db-recover",
    title: "Recover data",
    difficulty: "L4",
    prompt: "",
    allowed_surfaces: ["api"],
    na: true,
    na_reason: "Recovery is not documented.",
    support_evidence: [{ doc_url: "https://docs.acme.example/limits", quote: "No recovery." }],
    oracles: [],
  }],
};

const config: PackComposeConfig = {
  base_url: "",
  api_style: "rest",
  auth: { type: "none", env: "", env_aliases: [], verify_env_aliases: [] },
  sandbox_scope: [],
  headers: { "X-API-Version": "2026-01-01" },
  sql_conn: { dialect: "postgres", connection_string_env: "ACME_DATABASE_URL" },
};

describe("pack composition", () => {
  it("composes a reviewed pack without embedding credentials", () => {
    const pack = composePack(vendor, suite, surfaces, taskExtract, config, {
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });
    expect(pack.standard_set_version).toBe("db-core-v1");
    expect(pack.run_id).toBe("20260102030405");
    expect(pack.sql_conn?.connection_string_env).toBe("ACME_DATABASE_URL");
    expect(pack.surfaces?.cli?.bin).toBe("acme");
    expect(pack.tasks[1]?.na_reason).toBe("Recovery is not documented.");
    expect(pack.tasks[0]?.support_evidence[0]?.doc_url).toBe("https://docs.acme.example/tables");
    expect(JSON.stringify(pack)).not.toMatch(/postgres(?:ql)?:\/\//i);
  });

  it("rejects missing verifier configuration", () => {
    expect(() => composePack(vendor, suite, surfaces, taskExtract, {
      ...config,
      sql_conn: undefined,
    })).toThrow(/requires sql_conn/);
  });

  it("composes REST verification only with an explicit public base URL", () => {
    const restExtract: TaskExtractResult = {
      ...taskExtract,
      tasks: taskExtract.tasks.map((task) => task.id === "db-create" ? {
        ...task,
        oracles: [{
          type: "roundtrip",
          readMethod: "GET",
          readPathTemplate: "/v1/tables/{gid}",
          assertField: "name",
          expected: "ax_items_{ns}",
          description: "Table exists.",
        }],
      } : task),
    };
    expect(() => composePack(vendor, suite, surfaces, restExtract, {
      ...config,
      sql_conn: undefined,
    })).toThrow(/requires base_url/);
    const pack = composePack(vendor, suite, surfaces, restExtract, {
      ...config,
      base_url: "https://api.acme.example/v1",
      sql_conn: undefined,
    });
    expect(pack.base_url).toBe("https://api.acme.example/v1");
    expect(pack.tasks[0]?.oracles[0]?.readPathTemplate).toBe("/v1/tables/{gid}");
  });

  it("rejects canonical and vendor drift even for typed inputs", () => {
    expect(() => composePack(vendor, suite, { ...surfaces, vendor: "OtherDB" }, taskExtract, config))
      .toThrow(/do not belong/);
    expect(() => composePack(vendor, suite, surfaces, {
      ...taskExtract,
      tasks: taskExtract.tasks.map((task) => task.id === "db-create" ? { ...task, title: "Changed" } : task),
    }, config)).toThrow(/diverges from canonical suite/);
  });

  it("writes a schema-valid frozen pack without creating an approval", () => {
    const pack = composePack(vendor, suite, surfaces, taskExtract, config, {
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });
    const root = mkdtempSync(join(tmpdir(), "ax-eval-compose-"));
    try {
      const path = writeComposedPack(root, pack, suite.name);
      expect(readFileSync(path, "utf8")).toContain("GENERATED — frozen standard_set");
      expect(loadPack(path)).toEqual(pack);
      expect(existsSync(path.replace(/\.yaml$/, ".approval.json"))).toBe(false);
      expect(existsSync(`${path}.tmp`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
