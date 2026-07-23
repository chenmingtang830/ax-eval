import { describe, expect, it } from "vitest";
import { createOracleProviderRegistry } from "../src/generate/oracle-provider.js";
import { verifyGeneratedPack } from "../src/generate/verify.js";
import { TargetPackSchema } from "../src/schemas.js";

describe("database oracle provider boundary", () => {
  it("never executes SQL or Mongo declarations without an explicit provider", async () => {
    const pack = TargetPackSchema.parse({
      name: "database-boundary",
      base_url: "https://api.example.test",
      sql_conn: { dialect: "postgres", connection_string_env: "DATABASE_URL" },
      mongo_conn: { connection_string_env: "MONGO_URL", database: "sandbox" },
      tasks: [
        {
          id: "sql",
          title: "SQL",
          allowed_surfaces: ["cli"],
          oracles: [{
            type: "roundtrip",
            sqlQuery: "SELECT 1",
            assertField: "0.value",
            expected: 1,
          }],
        },
        {
          id: "mongo",
          title: "Mongo",
          allowed_surfaces: ["cli"],
          oracles: [{
            type: "roundtrip",
            mongoQuery: {
              database: "sandbox",
              collection: "items",
              operation: "count",
            },
            assertField: "count",
            expected: 1,
          }],
        },
      ],
    });

    const outcomes = await verifyGeneratedPack(
      pack,
      { profile: "test", surface: "cli", results: {} },
      {} as never,
      "cli",
      undefined,
      {
        env: {
          DATABASE_URL: "postgres://must-not-be-used.invalid/db",
          MONGO_URL: "mongodb://must-not-be-used.invalid/db",
        },
        oracleProviders: createOracleProviderRegistry(),
      },
    );

    expect(outcomes).toHaveLength(2);
    expect(outcomes.map((outcome) => outcome.success)).toEqual([false, false]);
    expect(outcomes.map((outcome) => outcome.oracleResults[0]?.detail)).toEqual([
      "oracle sqlQuery requires an explicit OracleProvider",
      "oracle mongoQuery requires an explicit OracleProvider",
    ]);
    expect(JSON.stringify(outcomes)).not.toContain("must-not-be-used");
  });
});
