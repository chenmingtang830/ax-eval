import { describe, expect, it } from "vitest";
import { auditSite } from "../src/static/audit.js";
import { CHECKS } from "../src/static/checks.js";
import { fixtureName } from "../src/static/fetcher.js";

describe("static audit (offline fixtures)", () => {
  it("scores the asana fixtures with a realistic profile", async () => {
    const audit = await auditSite("https://asana.com", { mode: "fixture" });
    expect(audit.source).toBe("fixture");
    // Some surfaces present in fixtures (llms.txt, openapi, robots+sitemap, auth),
    // some absent (AGENTS.md, MCP) → a partial, non-trivial score.
    expect(audit.score).toBeGreaterThan(0);
    expect(audit.score).toBeLessThan(100);
    expect(audit.checks.length).toBe(CHECKS.length);
    // In offline mode, missing fixtures are a genuine absence (fail), not errors.
    expect(audit.errored).toBe(0);
  });

  it("passes the surfaces that exist as fixtures", async () => {
    const audit = await auditSite("https://asana.com", { mode: "fixture" });
    const byId = Object.fromEntries(audit.checks.map((c) => [c.id, c.status]));
    expect(byId["llms-txt"]).toBe("pass");
    expect(byId["openapi"]).toBe("pass");
    expect(byId["robots-sitemap"]).toBe("pass");
    expect(byId["auth-discovery"]).toBe("pass");
    // No fixture for these → genuine absence.
    expect(byId["agents-md"]).toBe("fail");
    expect(byId["mcp-server"]).toBe("fail");
  });

  it("official-sdk passes from the fixture homepage", async () => {
    // The fixture homepage contains "Official SDKs" and "npm install asana".
    const audit = await auditSite("https://asana.com", { mode: "fixture" });
    const sdk = audit.checks.find((c) => c.id === "official-sdk")!;
    expect(sdk.status).toBe("pass");
  });

  it("a site with no fixtures fails every check (none errored, score 0)", async () => {
    const audit = await auditSite("https://nothing.example", { mode: "fixture" });
    expect(audit.score).toBe(0);
    expect(audit.checks.every((c) => c.status === "fail")).toBe(true);
    expect(audit.errored).toBe(0);
  });

  it("a network failure with no fixtures errors (not fails) and is excluded from score", async () => {
    // Live mode against an unresolvable host with no fixtures → every fetch
    // throws → status 0 → checks are "error", excluded from the denominator.
    const audit = await auditSite("https://no-such-host.invalid", {
      mode: "live",
      fallbackToFixture: false,
      timeoutMs: 2000,
    });
    expect(audit.errored).toBe(audit.checks.length);
    expect(audit.checks.every((c) => c.status === "error")).toBe(true);
    // No evaluable checks → score 0 but it reflects "unknown", and source is the
    // requested mode (no check decided).
    expect(audit.score).toBe(0);
  });

  it("fixtureName flattens a url, distinguishing root from a literal /index", () => {
    expect(fixtureName("https://asana.com/llms.txt")).toBe("asana.com_llms.txt");
    expect(fixtureName("https://asana.com/")).toBe("asana.com___root__");
    // The collision the old mapping had: root vs /index must differ now.
    expect(fixtureName("https://asana.com/")).not.toBe(fixtureName("https://asana.com/index"));
    // Query strings participate, so they don't collide.
    expect(fixtureName("https://x.com/a?b=1")).not.toBe(fixtureName("https://x.com/a?b=2"));
  });
});
