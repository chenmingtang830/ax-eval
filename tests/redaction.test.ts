import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "../src/safety/redaction.js";

describe("redactSensitiveText", () => {
  it("redacts common credential forms while preserving useful context", () => {
    const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "signaturevalue"].join(".");
    const token = ["napi", "examplecredential123"].join("_");
    const databaseUrl = `postgresql://${["dbuser", "dbpassword"].join(":")}@localhost:5432/app`;
    const input = [
      `Authorization: Bearer ${["example", "bearer-token_123"].join(".")}`,
      `jwt=${jwt}`,
      `service_token=${token}`,
      '"client_secret":"super-sensitive-value"',
      databaseUrl,
    ].join("\n");

    const output = redactSensitiveText(input);
    expect(output).not.toContain("example.bearer-token_123");
    expect(output).not.toContain(jwt);
    expect(output).not.toContain(token);
    expect(output).not.toContain("super-sensitive-value");
    expect(output).not.toContain("dbpassword");
  });

  it("leaves ordinary ids, URLs, and prose unchanged", () => {
    const input = "created task gid=12345 at https://example.test/tasks/12345";
    expect(redactSensitiveText(input)).toBe(input);
  });

  it("redacts API-key header syntax and basic authorization", () => {
    const input = [
      "x-api-key: exa_example_secret_123456",
      "apikey: supabase_example_secret_123456",
      "Authorization: Basic dXNlcjpwYXNz",
    ].join("\n");
    const output = redactSensitiveText(input);
    expect(output).not.toContain("exa_example_secret_123456");
    expect(output).not.toContain("supabase_example_secret_123456");
    expect(output).not.toContain("dXNlcjpwYXNz");
    expect(output).toContain("x-api-key: [REDACTED]");
    expect(output).toContain("Authorization: Basic [REDACTED]");
  });
});
