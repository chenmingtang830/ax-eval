import { afterEach, describe, expect, it, vi } from "vitest";
import { TargetPackSchema } from "../src/schemas.js";
import { verifyGeneratedPack } from "../src/generate/verify.js";

vi.mock("pg", () => ({
  Client: class {
    constructor(readonly _opts: { connectionString: string }) {}
    async connect() {}
    async end() {}
    async query(sql: string) {
      if (sql.includes("duplicate_probe")) {
        const error = new Error("duplicate key");
        Object.assign(error, { code: "23505" });
        throw error;
      }
      return { rows: [{ count: 1 }] };
    }
  },
}));

afterEach(() => {
  delete process.env.PROBE_SQL_URL;
});

describe("SQL verifier probes", () => {
  it("accepts an expected SQL conflict then performs the read-back", async () => {
    process.env.PROBE_SQL_URL = "postgres://user:pass@example.test/db";
    const pack = TargetPackSchema.parse({
      name: "probe",
      base_url: "https://api.example.test",
      sql_conn: { dialect: "postgres", connection_string_env: "PROBE_SQL_URL" },
      tasks: [{
        id: "integrity",
        title: "Integrity",
        allowed_surfaces: ["cli"],
        oracles: [{
          type: "roundtrip",
          sqlDialect: "postgres",
          sqlQuery: "SELECT 1 AS count",
          assertField: "0.count",
          expected: 1,
          probeSqlQuery: "INSERT duplicate_probe",
          probeAssertField: "code",
          probeExpected: "23505",
          probeExpectError: true,
        }],
      }],
    });

    const outcomes = await verifyGeneratedPack(
      pack,
      { profile: "test", surface: "cli", results: {} },
      {} as never,
      "cli",
    );

    expect(outcomes[0]?.success).toBe(true);
    expect(outcomes[0]?.oracleResults).toEqual([
      expect.objectContaining({ type: "verifier-probe", passed: true }),
      expect.objectContaining({ type: "roundtrip", passed: true }),
    ]);
  });
});
