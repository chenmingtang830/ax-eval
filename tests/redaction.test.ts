import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "../src/safety/redaction.js";

describe("redactSensitiveText", () => {
  it("redacts common credential forms while preserving useful context", () => {
    const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "signaturevalue"].join(".");
    const token = ["napi", "examplecredential123"].join("_");
    const databaseUrl = `postgresql://${["dbuser", "dbpassword"].join(":")}@localhost:5432/app`;
    const authenticatedUrl = `https://${["user", "pass"].join(":")}@example.test/path`;
    const input = [
      `Authorization: Bearer ${["example", "bearer-token_123"].join(".")}`,
      `jwt=${jwt}`,
      `service_token=${token}`,
      '"client_secret":"super-sensitive-value"',
      databaseUrl,
      authenticatedUrl,
    ].join("\n");

    const output = redactSensitiveText(input);

    expect(output).not.toContain("example.bearer-token_123");
    expect(output).not.toContain(jwt);
    expect(output).not.toContain(token);
    expect(output).not.toContain("super-sensitive-value");
    expect(output).not.toContain("dbpassword");
    expect(output).not.toContain("user:pass");
    expect(output).toContain("Authorization: Bearer [REDACTED]");
    expect(output).toContain("postgresql://[REDACTED]@localhost:5432/app");
    expect(output).toContain("https://[REDACTED]@example.test/path");
  });

  it("leaves ordinary ids, URLs, and prose unchanged", () => {
    const input = "created task gid=12345 at https://example.test/tasks/12345";
    expect(redactSensitiveText(input)).toBe(input);
  });
});
