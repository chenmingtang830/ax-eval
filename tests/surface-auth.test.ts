import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TargetPackSchema, type TargetPack } from "../src/schemas.js";
import { describeRequiredEnv, resolveToken, surfaceAuthStatus } from "../src/target/config.js";
import { buildBlockedResult } from "../src/generate/record.js";
import { renderCompetitiveReport } from "../src/generate/report.js";

/** A minimal pack with one API credential + the three surfaces, each with a
 *  different auth kind, so one fixture exercises inherit / token / oauth_app. */
function fixturePack(): TargetPack {
  return TargetPackSchema.parse({
    name: "acme",
    auth: { type: "bearer", env: "ACME_TOKEN" },
    surfaces: {
      sdk: { package: "acme-sdk", auth: { kind: "inherit", token_env_aliases: [] } },
      cli: { bin: "acme", auth: { kind: "token", token_env: "ACME_CLI_TOKEN", token_env_aliases: [] } },
      mcp: {
        server: "https://mcp.acme.test/mcp",
        transport: "http",
        auth: {
          kind: "oauth_app",
          token_env_aliases: [],
          client_id_env: "ACME_MCP_CLIENT_ID",
          client_secret_env: "ACME_MCP_CLIENT_SECRET",
          refresh_token_env: "ACME_MCP_REFRESH_TOKEN",
          instructions: "register an oauth app",
        },
      },
    },
  });
}

const AUTH_ENVS = [
  "ACME_TOKEN",
  "ACME_CLI_TOKEN",
  "ACME_MCP_CLIENT_ID",
  "ACME_MCP_CLIENT_SECRET",
  "ACME_MCP_REFRESH_TOKEN",
];

describe("surfaceAuthStatus", () => {
  beforeEach(() => {
    for (const k of AUTH_ENVS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of AUTH_ENVS) delete process.env[k];
  });

  it("api inherits the top-level credential; blocked when unset", () => {
    const pack = fixturePack();
    expect(surfaceAuthStatus(pack, "api").blocked).toBe("missing-credential");
    process.env.ACME_TOKEN = "x";
    const s = surfaceAuthStatus(pack, "api");
    expect(s.blocked).toBeNull();
    expect(s.requirements.map((r) => r.env)).toEqual(["ACME_TOKEN"]);
  });

  it("inherit surface (sdk) reuses the api credential", () => {
    const pack = fixturePack();
    expect(surfaceAuthStatus(pack, "sdk").blocked).toBe("missing-credential");
    process.env.ACME_TOKEN = "x";
    expect(surfaceAuthStatus(pack, "sdk").blocked).toBeNull();
  });

  it("token surface (cli) needs its own token_env, not the api credential", () => {
    const pack = fixturePack();
    process.env.ACME_TOKEN = "x"; // api creds present, but cli has its own token
    const blocked = surfaceAuthStatus(pack, "cli");
    expect(blocked.blocked).toBe("missing-credential");
    expect(blocked.missing).toEqual(["ACME_CLI_TOKEN"]);
    process.env.ACME_CLI_TOKEN = "y";
    expect(surfaceAuthStatus(pack, "cli").blocked).toBeNull();
  });

  it("oauth_app surface (mcp) is requires-oauth until all three are set", () => {
    const pack = fixturePack();
    const s0 = surfaceAuthStatus(pack, "mcp");
    expect(s0.blocked).toBe("requires-oauth");
    expect(s0.missing).toEqual([
      "ACME_MCP_CLIENT_ID",
      "ACME_MCP_CLIENT_SECRET",
      "ACME_MCP_REFRESH_TOKEN",
    ]);
    expect(s0.instructions).toBe("register an oauth app");
    process.env.ACME_MCP_CLIENT_ID = "a";
    process.env.ACME_MCP_CLIENT_SECRET = "b";
    expect(surfaceAuthStatus(pack, "mcp").blocked).toBe("requires-oauth"); // still missing refresh
    process.env.ACME_MCP_REFRESH_TOKEN = "c";
    expect(surfaceAuthStatus(pack, "mcp").blocked).toBeNull();
  });

  it("a surface with no auth block defaults to inherit", () => {
    const pack = TargetPackSchema.parse({
      name: "acme",
      auth: { type: "bearer", env: "ACME_TOKEN" },
      surfaces: { sdk: { package: "acme-sdk" } },
    });
    expect(surfaceAuthStatus(pack, "sdk").kind).toBe("inherit");
    expect(surfaceAuthStatus(pack, "sdk").blocked).toBe("missing-credential");
  });

  it("auth:none packs do not require legacy API credentials for api or mcp surfaces", () => {
    const pack = TargetPackSchema.parse({
      name: "mcp-native",
      auth: { type: "none", env: "" },
      surfaces: { mcp: { server: "node fake-mcp.js", transport: "stdio" } },
    });
    expect(resolveToken(pack)).toBe("");
    expect(describeRequiredEnv(pack)).toEqual([]);
    expect(surfaceAuthStatus(pack, "api").blocked).toBeNull();
    expect(surfaceAuthStatus(pack, "mcp").blocked).toBeNull();
  });
});

describe("buildBlockedResult + report rendering", () => {
  it("emits a blocked cube cell with zeroed metrics", () => {
    const pack = fixturePack();
    const rec = buildBlockedResult(pack, "mcp", "cursor", "requires-oauth");
    expect(rec.blocked).toBe("requires-oauth");
    expect(rec.tasks_total).toBe(0);
    expect(rec.pass_at_1).toBe(0);
    expect(rec.discovery_score).toBeNull();
    expect(rec.product).toBe("acme");
  });

  it("renders blocked cells as a pill, never a 0%, and excludes them from best", () => {
    const real = {
      schema: "ax.normalized-result/v1" as const,
      surface: "api" as const,
      product: "acme",
      harness: "cursor",
      standard_set_version: "v1",
      generated_at: "2026-06-06T00:00:00Z",
      tasks_total: 4,
      tasks_passed: 4,
      pass_at_1: 1,
      pass_at_k: 1,
      attempts: 1,
      model: "host-default",
      discovery_score: 0.9,
      discoverability: 0.9,
      content_quality: 0.8,
      profiles: ["ceiling"],
      best_profile: "ceiling",
    };
    const blocked = buildBlockedResult(fixturePack(), "mcp", "cursor", "requires-oauth");
    const html = renderCompetitiveReport([real, blocked]);
    expect(html).toContain("ax-heat--blocked");
    expect(html).toContain("OAuth req&#39;d");
    // The real api cell still ranks/wins; the blocked cell carries no medal rank.
    expect(html).toContain("ax-row--best");
  });
});
