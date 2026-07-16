import { beforeEach, describe, expect, it, vi } from "vitest";

const pgMocks = vi.hoisted(() => ({
  connect: vi.fn(async () => undefined),
  query: vi.fn(async () => ({ rows: [] })),
  end: vi.fn(async () => undefined),
}));

vi.mock("pg", () => ({
  Client: class {
    connect = pgMocks.connect;
    query = pgMocks.query;
    end = pgMocks.end;
  },
}));

import { DatabaseCheckError } from "../src/generate/database-error.js";
import { assertReadOnlySql, renderSqlQuery, renderSqlRole, runSqlCheck } from "../src/generate/sql-verify.js";

describe("SQL verification safety", () => {
  beforeEach(() => {
    pgMocks.connect.mockReset().mockResolvedValue(undefined);
    pgMocks.query.mockReset().mockResolvedValue({ rows: [] });
    pgMocks.end.mockReset().mockResolvedValue(undefined);
  });

  it("accepts one read-only statement", () => {
    expect(() => assertReadOnlySql("SELECT count(*) FROM widgets;")).not.toThrow();
    expect(() => assertReadOnlySql("WITH visible AS (SELECT * FROM widgets) SELECT count(*) FROM visible")).not.toThrow();
  });

  it("rejects mutation and multiple statements", () => {
    expect(() => assertReadOnlySql("DELETE FROM widgets")).toThrow(/read-only|mutating/);
    expect(() => assertReadOnlySql("WITH removed AS (DELETE FROM widgets RETURNING *) SELECT * FROM removed"))
      .toThrow(/mutating/);
    expect(() => assertReadOnlySql("SELECT 1; DROP TABLE widgets")).toThrow(/one statement/);
    expect(() => assertReadOnlySql("SELECT nextval('widgets_seq')")).toThrow(/side-effecting/);
    expect(() => assertReadOnlySql("SELECT * FROM widgets FOR UPDATE")).toThrow(/row lock/);
    expect(() => assertReadOnlySql("SELECT * INTO copied_widgets FROM widgets")).toThrow(/mutating/);
  });

  it("rejects role and session-state changes explicitly", () => {
    expect(() => assertReadOnlySql("SET ROLE readonly_user")).toThrow(/session authorization or role state/);
    expect(() => assertReadOnlySql("RESET ROLE")).toThrow(/session authorization or role state/);
    expect(() => assertReadOnlySql("WITH visible AS (SELECT 1) SET SESSION AUTHORIZATION app_user"))
      .toThrow(/session authorization or role state/);
    expect(() => assertReadOnlySql("SELECT 'SET ROLE admin' AS example")).not.toThrow();
    expect(() => assertReadOnlySql("SELECT current_user")).not.toThrow();
  });

  it("renders only known, constrained template values", () => {
    expect(renderSqlQuery('SELECT count(*) FROM "ax_{ns}" WHERE id = \'{gid}\'', {
      ns: "run-ab12",
      gid: "item-1",
    })).toContain('"ax_run-ab12"');
    expect(() => renderSqlQuery("SELECT * FROM {table}", { ns: "run-ab12" })).toThrow(/unsupported/);
    expect(() => renderSqlQuery("SELECT * FROM widgets WHERE id = '{gid}'", { gid: "x'; DROP TABLE widgets--" }))
      .toThrow(/unsafe characters/);
  });

  it("renders only constrained verifier-controlled Postgres roles", () => {
    expect(renderSqlRole("restricted_{ns}", { ns: "run-ab12" })).toBe("restricted_run-ab12");
    expect(() => renderSqlRole("restricted_{other}", {})).toThrow(/unsupported/);
    expect(() => renderSqlRole("restricted role", {})).toThrow(/simple identifier/);
  });

  it("classifies role setup separately from the verifier query", async () => {
    pgMocks.query.mockImplementation(async (query: string) => {
      if (query.startsWith("SET LOCAL ROLE")) {
        throw Object.assign(new Error("permission denied"), { code: "42501" });
      }
      return { rows: [] };
    });

    await expect(runSqlCheck(
      { dialect: "postgres", connectionString: "postgres://localhost/test" },
      "SELECT secret FROM restricted_widgets",
      { role: "restricted_user" },
    )).rejects.toMatchObject<Partial<DatabaseCheckError>>({ phase: "role", code: "42501" });
  });

  it("classifies an executed query denial as a query-phase error", async () => {
    pgMocks.query.mockImplementation(async (query: string) => {
      if (query === "SELECT secret FROM restricted_widgets") {
        throw Object.assign(new Error("permission denied"), { code: "42501" });
      }
      return { rows: [] };
    });

    await expect(runSqlCheck(
      { dialect: "postgres", connectionString: "postgres://localhost/test" },
      "SELECT secret FROM restricted_widgets",
      { role: "restricted_user" },
    )).rejects.toMatchObject<Partial<DatabaseCheckError>>({ phase: "query", code: "42501" });
  });
});
