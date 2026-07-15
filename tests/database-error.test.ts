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
});
