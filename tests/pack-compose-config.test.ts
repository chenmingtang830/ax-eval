import { describe, expect, it } from "vitest";
import { parsePackComposeConfig } from "../src/generate/pack-compose-config.js";

const baseConfig = {
  base_url: "https://${ACME_HOST}/v1",
  api_style: "rest",
  auth: { type: "bearer", env: "ACME_TOKEN" },
  sandbox_scope: [],
  headers: { "X-API-Version": "2026-01-01" },
};

describe("pack composition config", () => {
  it("accepts URL templates and env-name-only credentials", () => {
    const config = parsePackComposeConfig(baseConfig);
    expect(config.base_url).toBe("https://${ACME_HOST}/v1");
    expect(config.auth.env).toBe("ACME_TOKEN");
  });

  it("rejects connection strings where env names are required", () => {
    expect(() => parsePackComposeConfig({
      ...baseConfig,
      sql_conn: { dialect: "postgres", connection_string_env: "postgres:" + "//user:pass@db.example" },
    })).toThrow(/environment variable/);
  });

  it("rejects secret-like literals and credential headers", () => {
    expect(() => parsePackComposeConfig({
      ...baseConfig,
      sandbox_scope: [{
        name: "project",
        env: "ACME_PROJECT",
        required: true,
        instructions: ["Use Bearer", "abcdefghijklmnopqrstuvwxyz123456"].join(" "),
      }],
    })).toThrow(/embedded credential material/);
    expect(() => parsePackComposeConfig({
      ...baseConfig,
      headers: { Authorization: "not-a-real-value" },
    })).toThrow(/credential/i);
  });

  it("rejects header injection and auth-header conflicts", () => {
    expect(() => parsePackComposeConfig({
      ...baseConfig,
      headers: { "X-API-Version": "2026-01-01\r\nX-Leak: value" },
    })).toThrow(/line breaks/);
    expect(() => parsePackComposeConfig({
      ...baseConfig,
      auth: { type: "api-key", env: "ACME_TOKEN", header: "X-Auth" },
      headers: { "X-Auth": "constant" },
    })).toThrow(/conflicts with auth/);
  });

  it("requires complete, env-name-only surface auth overrides", () => {
    expect(() => parsePackComposeConfig({
      ...baseConfig,
      surface_auth: { cli: { kind: "token", token_env: "not-an-env-name" } },
    })).toThrow(/environment variable/);
    expect(() => parsePackComposeConfig({
      ...baseConfig,
      surface_auth: { mcp: { kind: "oauth_app", client_id_env: "MCP_CLIENT_ID" } },
    })).toThrow(/requires client, refresh-token, and token URL/);
  });
});
