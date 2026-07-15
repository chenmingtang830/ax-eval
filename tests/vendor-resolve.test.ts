import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildVendorResolvePrompt,
  loadVendorCard,
  resolveVendors,
  slugify,
  vendorCardPath,
  writeVendorCard,
} from "../src/generate/vendor-resolve.js";

describe("vendor resolution", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("requires grounded official-documentation research in the prompt", () => {
    const prompt = buildVendorResolvePrompt(["AcmeDB"], "database");
    expect(prompt).toMatch(/web search/i);
    expect(prompt).toMatch(/official vendor pages/i);
    expect(prompt).toContain("AcmeDB");
  });

  it("preserves requested ordering and rejects missing or extra vendors", async () => {
    const generate = async () => JSON.stringify([
      { vendor: "SecondDB", site_url: "https://second.example", docs_url: "https://second.example/docs" },
      { vendor: "FirstDB", site_url: "https://first.example", docs_url: "https://first.example/docs" },
    ]);
    const results = await resolveVendors(["FirstDB", "SecondDB"], "database", {
      generate,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(results.map((result) => result.vendor)).toEqual(["FirstDB", "SecondDB"]);
    await expect(resolveVendors(["FirstDB"], "database", { generate })).rejects.toThrow(/extra/);
  });

  it("rejects credential-bearing and private-network URLs", async () => {
    await expect(resolveVendors(["UnsafeDB"], "database", {
      generate: async () => JSON.stringify([
        { vendor: "UnsafeDB", site_url: "https://user@example.invalid", docs_url: "http://127.0.0.1/docs" },
      ]),
    })).rejects.toThrow(/public http/);
  });

  it("round-trips validated cards with atomic writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "ax-vendor-"));
    roots.push(root);
    const [result] = await resolveVendors(["MongoDB Atlas"], "database", {
      generate: async () => JSON.stringify([
        { vendor: "MongoDB Atlas", site_url: "https://mongodb.com", docs_url: "https://mongodb.com/docs" },
      ]),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(slugify("MongoDB Atlas")).toBe("mongodb-atlas");
    const path = writeVendorCard(root, result!);
    expect(path).toBe(vendorCardPath(root, "mongodb-atlas"));
    expect(existsSync(path)).toBe(true);
    expect(loadVendorCard(root, "mongodb-atlas")).toEqual(result);
  });
});
