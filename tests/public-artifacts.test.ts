import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const EXAMPLE_HTML = [
  "examples/exa-cross-harness-cross-surface.html",
  "examples/linear-graphql-cross-surface-cross-harness.html",
  "examples/notion-four-surface-cross-harness.html",
  "examples/stripe-four-surface-cross-harness.html",
];

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

describe("public example artifacts", () => {
  it("does not publish live-run UUIDs or personal identifiers", () => {
    const leaks: string[] = [];
    for (const file of EXAMPLE_HTML) {
      const html = readFileSync(file, "utf8");
      if (UUID_RE.test(html)) leaks.push(`${file}: UUID`);
      if (/Richard Tang/i.test(html)) leaks.push(`${file}: personal name`);
      if (/ax-eval-testing/i.test(html)) leaks.push(`${file}: workspace slug`);
    }
    expect(leaks).toEqual([]);
  });
});
