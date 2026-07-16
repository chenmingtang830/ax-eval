import { describe, expect, it } from "vitest";
import { detectWireSignals, gradeSurfaceHonesty } from "../src/generate/surface-honesty.js";

describe("surface honesty", () => {
  it("detects common database-wire channels without returning command text", () => {
    expect(detectWireSignals("psql $DATABASE_URL -c 'select 1'")).toEqual(["psql", "sql-env"]);
    expect(detectWireSignals("node -e \"const {Client}=require('pg'); new Client({connectionString:process.env.DB_URL})\"")).toEqual([
      "pg-driver",
      "sql-env",
    ]);
    expect(detectWireSignals("python -c 'import psycopg; psycopg.connect()'")).toEqual(["python-postgres"]);
    expect(detectWireSignals("connect('libsql://db.example') with @libsql/client")).toEqual(["libsql"]);
    expect(detectWireSignals("mysql://db.example/database")).toEqual(["sql-connection-url"]);
  });

  it("fails API cells that show only database-wire activity", () => {
    const grade = gradeSurfaceHonesty({
      surface: "api",
      expectedApiHosts: ["https://console.example.com/api/v1"],
      run: { wireSignals: ["psql"], observedHttpHosts: ["docs.example.com"] },
    });
    expect(grade).toMatchObject({
      status: "fail",
      passed: false,
      reason: "wire-only-api-cell",
      expectedApiHosts: ["console.example.com"],
      observedApiCalls: 0,
    });
  });

  it("passes when an exact expected API host is observed", () => {
    const grade = gradeSurfaceHonesty({
      surface: "api",
      expectedApiHosts: ["console.example.com", "api.example.com"],
      run: {
        wireSignals: ["sql-env", "sql-env"],
        observedHttpHosts: ["https://api.example.com/v1/projects", "API.EXAMPLE.COM."],
      },
    });
    expect(grade).toMatchObject({ status: "pass", reason: "api-host-observed", observedApiCalls: 2 });
    expect(grade.wireSignals).toEqual(["sql-env"]);
  });

  it("does not count sibling or attacker-controlled subdomains", () => {
    expect(gradeSurfaceHonesty({
      surface: "api",
      expectedApiHosts: ["api.example.com"],
      run: { wireSignals: ["psql"], observedHttpHosts: ["evil.api.example.com", "example.com"] },
    })).toMatchObject({ status: "fail", reason: "wire-only-api-cell", observedApiCalls: 0 });
  });

  it("fails closed when wire activity has no valid expected API host", () => {
    expect(gradeSurfaceHonesty({
      surface: "api",
      expectedApiHosts: ["${API_HOST}", "not a host"],
      run: { wireSignals: ["pg-driver"], observedHttpHosts: ["unrelated.example"] },
    })).toMatchObject({ status: "fail", reason: "expected-api-host-missing" });
  });

  it("does not apply the API-only policy to other declared surfaces", () => {
    expect(gradeSurfaceHonesty({
      surface: "cli",
      expectedApiHosts: ["api.example.com"],
      run: { wireSignals: ["psql"], observedHttpHosts: [] },
    })).toMatchObject({ status: "not_applicable", passed: true, reason: "non-api-surface" });
  });
});
