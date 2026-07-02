import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

describe("public example artifacts", () => {
  it("does not publish live-run UUIDs or personal identifiers", () => {
    const files = readdirSync("examples")
      .filter((file) => file.endsWith(".html"))
      .map((file) => `examples/${file}`);
    const leaks: string[] = [];
    for (const file of files) {
      const html = readFileSync(file, "utf8");
      if (UUID_RE.test(html)) leaks.push(`${file}: UUID`);
      if (/Richard Tang/i.test(html)) leaks.push(`${file}: personal name`);
      if (/ax-eval-testing/i.test(html)) leaks.push(`${file}: workspace slug`);
    }
    expect(files.length).toBeGreaterThan(0);
    expect(leaks).toEqual([]);
  });
});
