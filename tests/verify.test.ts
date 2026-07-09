import { describe, expect, it } from "vitest";
import { parseJsonWithRecovery } from "../src/generate/verify.js";

describe("parseJsonWithRecovery", () => {
  it("recovers agent-authored JSON strings with invalid shell-style single-quote escapes", () => {
    const parsed = parseJsonWithRecovery<{ discovery: { endpoint_used: string } }>(
      `{
        "discovery": {
          "endpoint_used": "psql -c 'SELECT '\\''ok'\\'';'"
        }
      }`,
    );
    expect(parsed.discovery.endpoint_used).toBe(`psql -c 'SELECT '''ok''';'`);
  });

  it("keeps rejecting unrelated malformed JSON", () => {
    expect(() => parseJsonWithRecovery("{ nope")).toThrow();
  });
});
