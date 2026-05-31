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
  });

  it("passes the surfaces that exist as fixtures", async () => {
    const audit = await auditSite("https://asana.com", { mode: "fixture" });
    const byId = Object.fromEntries(audit.checks.map((c) => [c.id, c.passed]));
    expect(byId["llms-txt"]).toBe(true);
    expect(byId["openapi"]).toBe(true);
    expect(byId["robots-sitemap"]).toBe(true);
    expect(byId["auth-discovery"]).toBe(true);
    // No fixture for these → absent.
    expect(byId["agents-md"]).toBe(false);
    expect(byId["mcp-server"]).toBe(false);
  });

  it("a site with no fixtures scores 0", async () => {
    const audit = await auditSite("https://nothing.example", { mode: "fixture" });
    expect(audit.score).toBe(0);
    expect(audit.checks.every((c) => !c.passed)).toBe(true);
  });

  it("fixtureName flattens a url to a filename", () => {
    expect(fixtureName("https://asana.com/llms.txt")).toBe("asana.com_llms.txt");
    expect(fixtureName("https://asana.com/")).toBe("asana.com_index");
  });
});
