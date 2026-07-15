import { afterEach, describe, expect, it } from "vitest";
import { TargetPackSchema } from "../src/schemas.js";
import { buildVerificationClientOptions } from "../src/generate/verification-client.js";

describe("verification client configuration", () => {
  const savedHost = process.env.TARGET_HOST;
  const savedToken = process.env.TARGET_TOKEN;

  afterEach(() => {
    if (savedHost === undefined) delete process.env.TARGET_HOST;
    else process.env.TARGET_HOST = savedHost;
    if (savedToken === undefined) delete process.env.TARGET_TOKEN;
    else process.env.TARGET_TOKEN = savedToken;
  });

  it("uses only pack-declared base URL templates and credential env names", () => {
    process.env.TARGET_HOST = "sandbox";
    process.env.TARGET_TOKEN = "test-token";
    const pack = TargetPackSchema.parse({
      name: "target",
      base_url: "https://${TARGET_HOST}.example.test",
      auth: { type: "bearer", env: "TARGET_TOKEN", extra_header: "X-Api-Key" },
    });
    expect(buildVerificationClientOptions(pack)).toEqual(expect.objectContaining({
      baseUrl: "https://sandbox.example.test",
      token: "test-token",
      extraAuthHeader: "X-Api-Key",
    }));
  });

  it("supports explicitly unauthenticated targets", () => {
    const pack = TargetPackSchema.parse({
      name: "public-target",
      base_url: "https://public.example.test",
      auth: { type: "none" },
    });
    expect(buildVerificationClientOptions(pack)).toEqual(expect.objectContaining({
      authScheme: "none",
      token: "",
    }));
  });
});
