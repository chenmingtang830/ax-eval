import { describe, expect, it } from "vitest";
import {
  buildV2SupportMatrix,
  buildV2WitnessPlan,
  validateV2WitnessPlan,
  v2SurfaceContract,
} from "../src/authoring/database-v2-witness.js";
import { cockroachProductionTargetIssue } from "../src/authoring/database-v2-runner.js";

function snapshot(vendor: string, tasks: Array<{ id: string; prompt: string; allowed_surfaces: string[] }>) {
  return {
    vendor,
    pack: {
      base_url: "https://example.invalid",
      auth: { type: "bearer", env: "TOKEN" },
      sql_conn: undefined,
      surfaces: {},
      tasks,
    } as never,
  };
}

describe("DAEB v2 executable witness gate", () => {
  it("fails closed on a local or insecure Cockroach target for production", () => {
    expect(cockroachProductionTargetIssue("postgresql://root@localhost:26257/defaultdb?sslmode=disable"))
      .toMatch(/must not resolve to localhost/);
    expect(cockroachProductionTargetIssue("postgresql://root@127.0.0.1:26257/defaultdb?sslmode=verify-full"))
      .toMatch(/must not resolve to localhost/);
    expect(cockroachProductionTargetIssue("postgresql://root@cluster.example.com/defaultdb?sslmode=disable"))
      .toMatch(/must use TLS/);
    expect(cockroachProductionTargetIssue("postgresql://root@cluster.example.com/defaultdb?sslmode=verify-full"))
      .toBeUndefined();
  });

  it("blocks known surface contradictions and leaves other tuples inconclusive", () => {
    const plan = buildV2WitnessPlan([
      snapshot("supabase", [{ id: "db-T02-evolve-schema", prompt: "create table and alter table", allowed_surfaces: ["api"] }]),
      snapshot("neon", [{ id: "db-T04-query-records", prompt: "use psql with NEON_DATABASE_URL", allowed_surfaces: ["api"] }]),
      snapshot("nile", [{ id: "db-T03-inspect-schema", prompt: "inspect schema", allowed_surfaces: ["cli"] }]),
    ], "2026-08-12T00:00:00.000Z");
    expect(plan.entries.map((entry) => entry.disposition)).toEqual(["blocked", "blocked", "needs_witness"]);
    expect(validateV2WitnessPlan(plan)).toEqual([]);
    const support = buildV2SupportMatrix(plan);
    expect(support.entries.map((entry) => entry.status)).toEqual(["unsupported", "unsupported", "inconclusive"]);
    expect(support.entries.every((entry) => entry.status !== "supported")).toBe(true);
  });

  it("requires evidence before a tuple can become supported", () => {
    const plan = buildV2WitnessPlan([
      snapshot("turso", [{ id: "db-T03-inspect-schema", prompt: "inspect", allowed_surfaces: ["api"] }]),
    ], "2026-08-12T00:00:00.000Z");
    plan.entries[0]!.disposition = "passed";
    expect(validateV2WitnessPlan(plan)).toContain("turso/db-T03-inspect-schema/api is passed without deterministic evidence");
    expect(validateV2WitnessPlan(plan)).toContain("turso/db-T03-inspect-schema/api is passed without setup/mutation/verify/cleanup proof");
  });

  it("reconsiders the audited Turso API schema tuple without mutating v1", () => {
    const plan = buildV2WitnessPlan([
      snapshot("turso", [{ id: "db-T03-inspect-schema", prompt: "inspect", allowed_surfaces: ["cli"] }]),
    ], "2026-08-12T00:00:00.000Z");
    expect(plan.entries.map((entry) => `${entry.task_id}/${entry.surface}`)).toEqual([
      "db-T03-inspect-schema/cli",
      "db-T03-inspect-schema/api",
    ]);
    expect(plan.entries[1]!.reason).toContain("v1 omitted this API tuple");
  });

  it("admits support only with a complete hash-bound witness proof", () => {
    const plan = buildV2WitnessPlan([
      snapshot("nile", [{ id: "db-T03-inspect-schema", prompt: "inspect", allowed_surfaces: ["cli"] }]),
    ], "2026-08-12T00:00:00.000Z");
    const entry = plan.entries[0]!;
    entry.disposition = "passed";
    entry.evidence = ["results/witness/nile-T03.json"];
    entry.proof = {
      setup: { status: "passed", command: "setup", artifact: "setup.json" },
      mutation: { status: "passed", command: "mutation", artifact: "mutation.json" },
      verify: { status: "passed", command: "verify", artifact: "verify.json" },
      cleanup: { status: "passed", command: "cleanup", artifact: "cleanup.json" },
      source_sha256: "a".repeat(64),
      bundle_sha256: "b".repeat(64),
    };
    expect(validateV2WitnessPlan(plan)).toEqual([]);
    expect(buildV2SupportMatrix(plan).entries[0]!.status).toBe("supported");
  });

  it("builds the canonical CLI-only candidate set fail-closed", () => {
    const plan = buildV2WitnessPlan([
      snapshot("supabase", [{ id: "db-T02-evolve-schema", prompt: "alter table", allowed_surfaces: ["api", "cli"] }]),
      snapshot("turso", [
        { id: "db-T01-access-control", prompt: "denied token", allowed_surfaces: ["cli"] },
        { id: "db-T03-inspect-schema", prompt: "inspect", allowed_surfaces: ["api", "cli"] },
      ]),
    ], "2026-08-12T00:00:00.000Z", { mode: "cli-only" });
    expect(plan.mode).toBe("cli-only");
    expect(plan.excluded_vendors).toEqual(["supabase"]);
    expect(plan.contracts.every((contract) => contract.surface === "cli")).toBe(true);
    expect(plan.entries.map((entry) => `${entry.vendor}/${entry.task_id}/${entry.surface}`)).toEqual([
      "turso/db-T03-inspect-schema/cli",
    ]);
    expect(buildV2SupportMatrix(plan).entries.every((entry) => entry.status === "inconclusive")).toBe(true);
  });

  it("adds the fresh InsForge CLI schema-inspection tuple without mutating v1", () => {
    const plan = buildV2WitnessPlan([
      snapshot("insforge", [{ id: "db-T03-inspect-schema", prompt: "inspect", allowed_surfaces: ["api"] }]),
    ], "2026-08-12T00:00:00.000Z", { mode: "cli-only" });
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toMatchObject({
      vendor: "insforge",
      task_id: "db-T03-inspect-schema",
      surface: "cli",
      disposition: "needs_witness",
    });
    expect(plan.entries[0]!.reason).toContain("fresh official InsForge CLI docs");
  });

  it("keeps surface contracts explicit", () => {
    expect(v2SurfaceContract("supabase", "api")).toMatchObject({
      endpoint_class: "supabase-postgrest-data-api",
      setup_mode: "http_admin",
      agent_credentials: ["SUPABASE_API_KEY"],
    });
    expect(v2SurfaceContract("turso", "api").setup_mode).toBe("sql_http");
    expect(v2SurfaceContract("insforge", "cli")).toMatchObject({
      endpoint_class: "postgres-sql-wire",
      agent_credentials: ["INSFORGE_CONNECTION_STRING"],
      setup_mode: "sql_wire",
    });
  });

  it("excludes Turso full-text search when the admitted CLI target lacks index_method", () => {
    const plan = buildV2WitnessPlan([
      snapshot("turso", [
        { id: "db-T07-full-text-search", prompt: "full text", allowed_surfaces: ["cli"] },
        { id: "db-T06-write-records", prompt: "write", allowed_surfaces: ["cli"] },
      ]),
    ], "2026-08-12T00:00:00.000Z", { mode: "cli-only" });
    expect(plan.entries.map((entry) => entry.task_id)).toEqual(["db-T06-write-records"]);
  });
});
