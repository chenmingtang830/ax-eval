import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TargetPackSchema } from "../src/schemas.js";
import {
  describeRequiredEnv,
  hasRequiredEnv,
  resolveScope,
  resolveToken,
  TargetConfigError,
} from "../src/target/config.js";

const ENV_KEYS = [
  "ASANA_PAT",
  "ASANA_VERIFY_PAT",
  "ASANA_SANDBOX_PROJECT_GID",
  "ASANA_SANDBOX_WORKSPACE_GID",
  "TARGET_KEY",
  "TARGET_VERIFY",
  "TARGET_REPO",
  "TARGET_HOST",
  "TARGET_DATABASE_URL",
  "TARGET_MONGO_URL",
  "STRIPE_API_KEY",
  "STRIPE_TOKEN",
];

function pack(overrides: Record<string, unknown> = {}) {
  return TargetPackSchema.parse({ name: "t", base_url: "https://api.example.test", ...overrides });
}

describe("target config (generic auth + sandbox_scope)", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("resolves the declared credential, preferring verify_env", () => {
    process.env.TARGET_KEY = "agent-key";
    process.env.TARGET_VERIFY = "oracle-key";
    const p = pack({ auth: { type: "bearer", env: "TARGET_KEY", verify_env: "TARGET_VERIFY" } });
    expect(resolveToken(p)).toBe("oracle-key");
    delete process.env.TARGET_VERIFY;
    expect(resolveToken(p)).toBe("agent-key");
  });

  it("falls back to legacy Asana vars when no auth declared", () => {
    process.env.ASANA_PAT = "legacy";
    expect(resolveToken(pack())).toBe("legacy");
  });

  it("throws a helpful error when the credential is missing", () => {
    const p = pack({ auth: { type: "bearer", env: "TARGET_KEY" } });
    expect(() => resolveToken(p)).toThrow(TargetConfigError);
    expect(() => resolveToken(p)).toThrow(/TARGET_KEY/);
  });

  it("accepts declared auth env aliases", () => {
    process.env.STRIPE_TOKEN = "legacy-stripe";
    const p = pack({ auth: { type: "bearer", env: "STRIPE_API_KEY", env_aliases: ["STRIPE_TOKEN"] } });
    expect(resolveToken(p)).toBe("legacy-stripe");
    expect(describeRequiredEnv(p).find((r) => r.env === "STRIPE_API_KEY")?.set).toBe(true);
  });

  it("accepts built-in env aliases for legacy Stripe packs", () => {
    process.env.STRIPE_API_KEY = "canonical-stripe";
    const p = pack({ auth: { type: "bearer", env: "STRIPE_TOKEN" } });
    expect(resolveToken(p)).toBe("canonical-stripe");
  });

  it("extracts a scope id from a pasted URL via url_pattern", () => {
    process.env.ASANA_SANDBOX_PROJECT_GID = "https://app.asana.com/0/1234567890/list/9";
    const p = pack({
      sandbox_scope: [
        { name: "project_gid", env: "ASANA_SANDBOX_PROJECT_GID", url_pattern: "/0/(\\d+)" },
      ],
    });
    expect(resolveScope(p)).toEqual({ project_gid: "1234567890" });
  });

  it("throws on a missing required scope but skips optional ones", () => {
    const p = pack({
      sandbox_scope: [
        { name: "repo", env: "TARGET_REPO", required: true, instructions: "make a throwaway repo" },
        { name: "org", env: "TARGET_ORG", required: false },
      ],
    });
    expect(() => resolveScope(p)).toThrow(/TARGET_REPO/);
    process.env.TARGET_REPO = "octo/sandbox";
    expect(resolveScope(p)).toEqual({ repo: "octo/sandbox" });
  });

  it("describes required env and reports presence", () => {
    process.env.TARGET_KEY = "k";
    const p = pack({
      auth: { type: "bearer", env: "TARGET_KEY" },
      sandbox_scope: [{ name: "repo", env: "TARGET_REPO", required: true }],
    });
    const reqs = describeRequiredEnv(p);
    expect(reqs.find((r) => r.env === "TARGET_KEY")?.set).toBe(true);
    expect(reqs.find((r) => r.env === "TARGET_REPO")?.set).toBe(false);
    expect(hasRequiredEnv(p)).toBe(false);
    process.env.TARGET_REPO = "x/y";
    expect(hasRequiredEnv(p)).toBe(true);
  });

  it("includes URL template variables in required env", () => {
    process.env.TARGET_KEY = "k";
    const p = pack({
      base_url: "https://${TARGET_HOST}.example.test",
      auth: { type: "bearer", env: "TARGET_KEY" },
    });
    const reqs = describeRequiredEnv(p);
    expect(reqs.find((r) => r.env === "TARGET_HOST")?.role).toBe("env_template");
    expect(hasRequiredEnv(p)).toBe(false);
    process.env.TARGET_HOST = "sandbox";
    expect(hasRequiredEnv(p)).toBe(true);
  });

  it("includes SQL verifier connection strings in required env", () => {
    process.env.TARGET_KEY = "k";
    const p = pack({
      auth: { type: "bearer", env: "TARGET_KEY" },
      sql_conn: { dialect: "postgres", connection_string_env: "TARGET_DATABASE_URL" },
    });
    const reqs = describeRequiredEnv(p);
    expect(reqs.find((r) => r.env === "TARGET_DATABASE_URL")?.role).toBe("sql_conn");
    expect(hasRequiredEnv(p)).toBe(false);
    process.env.TARGET_DATABASE_URL = "postgres://example";
    expect(hasRequiredEnv(p)).toBe(true);
  });

  it("includes Mongo verifier connection strings in required env", () => {
    process.env.TARGET_KEY = "k";
    const p = pack({
      auth: { type: "none", env: "TARGET_KEY" },
      mongo_conn: { connection_string_env: "TARGET_MONGO_URL" },
    });
    const reqs = describeRequiredEnv(p);
    expect(reqs.find((r) => r.env === "TARGET_MONGO_URL")?.role).toBe("mongo_conn");
    expect(hasRequiredEnv(p)).toBe(false);
    process.env.TARGET_MONGO_URL = "mongodb+srv://example";
    expect(hasRequiredEnv(p)).toBe(true);
  });
});
