import { describe, expect, it } from "vitest";
import { parseJsonWithRecovery } from "../src/util/json-parse.js";

describe("parseJsonWithRecovery", () => {
  it("recovers shell-style single-quote escapes in agent-authored strings", () => {
    const parsed = parseJsonWithRecovery<{ command: string }>(
      `{ "command": "psql -c 'SELECT '\\''ok'\\'';'" }`,
    );
    expect(parsed.command).toBe("psql -c 'SELECT '''ok''';'");
  });

  it("keeps rejecting unrelated malformed JSON", () => {
    expect(() => parseJsonWithRecovery("{ nope")).toThrow();
  });

  it("rejects bare inner quotes instead of silently repairing them", () => {
    expect(() => parseJsonWithRecovery(`{ "command": "tool "quoted" command" }`)).toThrow();
  });
});
