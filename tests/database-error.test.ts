import { describe, expect, it } from "vitest";
import { safeDatabaseError } from "../src/generate/database-error.js";

describe("database error redaction", () => {
  it("removes exact connection strings and URI credentials", () => {
    const connection = ["driver://", "user", ":", "password", "@example.invalid/database"].join("");
    expect(safeDatabaseError(new Error(`failed to connect to ${connection}`), connection).message)
      .toBe("failed to connect to <redacted-connection>");
    const embedded = ["failed at driver://", "user", ":", "password", "@example.invalid"].join("");
    expect(safeDatabaseError(new Error(embedded), "different-value").message)
      .toBe("failed at driver://<redacted>@example.invalid");
  });

  it("preserves non-secret SQL error classification fields", () => {
    const source = Object.assign(new Error("permission denied"), {
      code: "42501",
      errno: 1142,
      sqlState: "42000",
    });
    expect(safeDatabaseError(source, "driver://localhost/test", "query")).toMatchObject({
      message: "permission denied",
      code: "42501",
      errno: 1142,
      sqlState: "42000",
      phase: "query",
    });
  });
});
