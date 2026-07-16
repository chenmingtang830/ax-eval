import { describe, expect, it } from "vitest";
import { OracleSpecSchema, TargetPackSchema } from "../src/schemas.js";

describe("database verification contracts", () => {
  it("accepts declarative SQL and MongoDB read-back metadata", () => {
    expect(OracleSpecSchema.parse({
      type: "roundtrip",
      sqlDialect: "postgres",
      sqlQuery: "SELECT name FROM widgets WHERE id = '{gid}'",
    }).sqlDialect).toBe("postgres");

    expect(OracleSpecSchema.parse({
      type: "roundtrip",
      mongoQuery: {
        database: "sandbox",
        collection: "widgets",
        operation: "findOne",
        filter: { _id: "{gid}" },
      },
    }).mongoQuery?.operation).toBe("findOne");
  });

  it("rejects incomplete or mixed database oracle definitions", () => {
    expect(() => OracleSpecSchema.parse({ type: "roundtrip", sqlQuery: "SELECT 1" })).toThrow(/sqlDialect/);
    expect(() => OracleSpecSchema.parse({
      type: "roundtrip",
      sqlDialect: "postgres",
      sqlQuery: "SELECT 1",
      mongoQuery: {
        database: "sandbox",
        collection: "widgets",
        operation: "count",
      },
    })).toThrow(/both SQL and MongoDB/);
  });

  it("stores connection environment names rather than connection strings", () => {
    const pack = TargetPackSchema.parse({
      name: "database-target",
      auth: { type: "none" },
      sql_conn: { dialect: "postgres", connection_string_env: "DATABASE_URL" },
      mongo_conn: { connection_string_env: "MONGODB_URL", database: "sandbox" },
    });
    expect(pack.sql_conn?.connection_string_env).toBe("DATABASE_URL");
    expect(pack.mongo_conn?.connection_string_env).toBe("MONGODB_URL");
    expect(() => TargetPackSchema.parse({
      name: "unsafe-target",
      sql_conn: { dialect: "postgres", connection_string_env: "database-url" },
    })).toThrow(/environment variable/);
  });

  it("requires explicit HTTP statuses for expected-error oracles", () => {
    expect(() => TargetPackSchema.parse({
      name: "denial-target",
      tasks: [{
        id: "denial",
        prompt: "Confirm access is denied",
        oracles: [{
          type: "roundtrip",
          readPathTemplate: "/restricted/{gid}",
          assertField: "code",
          expected: "permission_denied",
          assertOutcome: "error",
        }],
      }],
    })).toThrow(/expectedHttpStatuses/);
  });

  it("keeps HTTP statuses and verifier-controlled roles on their supported database contracts", () => {
    expect(() => OracleSpecSchema.parse({
      type: "roundtrip",
      sqlDialect: "postgres",
      sqlQuery: "SELECT 1",
      assertOutcome: "error",
      expectedHttpStatuses: [403],
    })).toThrow(/cannot declare expectedHttpStatuses/);

    expect(() => OracleSpecSchema.parse({
      type: "roundtrip",
      sqlDialect: "mysql",
      sqlQuery: "SELECT 1",
      sqlRoleTemplate: "restricted_{ns}",
    })).toThrow(/postgres dialect/);
  });
});
