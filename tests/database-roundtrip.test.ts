import { describe, expect, it, vi } from "vitest";

const databaseMocks = vi.hoisted(() => ({
  runSqlCheck: vi.fn(async () => ({ count: 1 })),
  runMongoCheck: vi.fn(async () => ({ count: 2 })),
}));

vi.mock("../src/generate/sql-verify.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/generate/sql-verify.js")>(),
  resolveSqlConnection: vi.fn(() => ({ dialect: "postgres", connectionString: "driver://localhost/test" })),
  runSqlCheck: databaseMocks.runSqlCheck,
}));

vi.mock("../src/generate/mongo-verify.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/generate/mongo-verify.js")>(),
  resolveMongoConnection: vi.fn(() => ({ connectionString: "driver://localhost/test" })),
  runMongoCheck: databaseMocks.runMongoCheck,
}));

import { TargetPackSchema } from "../src/schemas.js";
import { DatabaseCheckError } from "../src/generate/database-error.js";
import { verifyGeneratedPack, type ExecutorResults } from "../src/generate/verify.js";
import type { BearerClient } from "../src/http/client.js";

const unusedClient = {} as BearerClient;

describe("database round-trip verification", () => {
  it("verifies SQL state without requiring an executor-reported credential", async () => {
    const pack = TargetPackSchema.parse({
      name: "sql-target",
      auth: { type: "none" },
      sql_conn: { dialect: "postgres", connection_string_env: "DATABASE_URL" },
      tasks: [{
        id: "sql-count",
        prompt: "Create one row",
        oracles: [{
          type: "roundtrip",
          sqlDialect: "postgres",
          sqlQuery: "SELECT count(*)::int AS count FROM widgets_{ns}",
          assertField: "count",
          expected: 1,
        }],
      }],
    });
    const executor: ExecutorResults = { profile: "floor", ns: "run-ab12", results: { "sql-count": {} } };
    const outcomes = await verifyGeneratedPack(pack, executor, unusedClient);
    expect(outcomes[0]?.success).toBe(true);
    expect(databaseMocks.runSqlCheck).toHaveBeenCalledWith(
      expect.objectContaining({ dialect: "postgres" }),
      "SELECT count(*)::int AS count FROM widgets_run-ab12",
    );
  });

  it("accepts an independently observed SQL denial code", async () => {
    const denied = new DatabaseCheckError("permission denied", { code: "42501", phase: "query" });
    databaseMocks.runSqlCheck.mockRejectedValueOnce(denied);
    const pack = TargetPackSchema.parse({
      name: "sql-target",
      auth: { type: "none" },
      sql_conn: { dialect: "postgres", connection_string_env: "DATABASE_URL" },
      tasks: [{
        id: "sql-denial",
        prompt: "Confirm the restricted identity cannot read the table",
        oracles: [{
          type: "roundtrip",
          sqlDialect: "postgres",
          sqlQuery: "SELECT secret FROM restricted_widgets_{ns}",
          assertOutcome: "error",
          assertField: "code",
          expected: "42501",
          sqlRoleTemplate: "restricted_{ns}",
        }],
      }],
    });
    const executor: ExecutorResults = { profile: "floor", ns: "run-ab12", results: { "sql-denial": {} } };
    const outcomes = await verifyGeneratedPack(pack, executor, unusedClient);
    expect(outcomes[0]?.success).toBe(true);
    expect(outcomes[0]?.oracleResults[0]?.detail).toContain("code=\"42501\"");
    expect(databaseMocks.runSqlCheck).toHaveBeenCalledWith(
      expect.objectContaining({ dialect: "postgres" }),
      "SELECT secret FROM restricted_widgets_run-ab12",
      { role: "restricted_run-ab12" },
    );
  });

  it("rejects a matching error code when assuming the verifier role fails", async () => {
    databaseMocks.runSqlCheck.mockRejectedValueOnce(
      new DatabaseCheckError("permission denied to set role", { code: "42501", phase: "role" }),
    );
    const pack = TargetPackSchema.parse({
      name: "sql-target",
      auth: { type: "none" },
      sql_conn: { dialect: "postgres", connection_string_env: "DATABASE_URL" },
      tasks: [{
        id: "sql-denial",
        prompt: "Confirm the restricted identity cannot read the table",
        oracles: [{
          type: "roundtrip",
          sqlDialect: "postgres",
          sqlQuery: "SELECT secret FROM restricted_widgets_{ns}",
          assertOutcome: "error",
          assertField: "code",
          expected: "42501",
          sqlRoleTemplate: "restricted_{ns}",
        }],
      }],
    });
    const executor: ExecutorResults = { profile: "floor", ns: "run-ab12", results: { "sql-denial": {} } };

    const outcomes = await verifyGeneratedPack(pack, executor, unusedClient);
    expect(outcomes[0]?.success).toBe(false);
    expect(outcomes[0]?.oracleResults[0]?.detail).toContain("phase=role");
  });

  it("verifies MongoDB state and excludes explicit N/A tasks", async () => {
    const pack = TargetPackSchema.parse({
      name: "mongo-target",
      auth: { type: "none" },
      mongo_conn: { connection_string_env: "MONGODB_URL" },
      tasks: [
        {
          id: "mongo-count",
          prompt: "Create two documents",
          oracles: [{
            type: "roundtrip",
            mongoQuery: { database: "sandbox", collection: "widgets_{ns}", operation: "count" },
            assertField: "count",
            expected: 2,
          }],
        },
        { id: "unsupported", prompt: "Unsupported task", na: true },
      ],
    });
    const executor: ExecutorResults = { profile: "floor", ns: "run-ab12", results: { "mongo-count": {} } };
    const outcomes = await verifyGeneratedPack(pack, executor, unusedClient);
    expect(outcomes.map((outcome) => outcome.taskId)).toEqual(["mongo-count"]);
    expect(outcomes[0]?.success).toBe(true);
  });
});
