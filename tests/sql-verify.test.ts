import { describe, expect, it } from "vitest";
import { assertReadOnlySql, renderSqlQuery } from "../src/generate/sql-verify.js";

describe("SQL verification safety", () => {
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
});
