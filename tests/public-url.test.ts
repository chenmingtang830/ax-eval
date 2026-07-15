import { describe, expect, it } from "vitest";
import { isPublicHttpUrl, urlUsesOfficialHost } from "../src/generate/public-url.js";

describe("public URL validation", () => {
  it("rejects local, private, credentialed, and non-http URLs", () => {
    expect(isPublicHttpUrl("http://localhost:3000")).toBe(false);
    expect(isPublicHttpUrl("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isPublicHttpUrl("http://[::ffff:127.0.0.1]")).toBe(false);
    expect(isPublicHttpUrl("https://user:secret@example.com")).toBe(false);
    expect(isPublicHttpUrl("file:///tmp/secret")).toBe(false);
  });

  it("accepts official hosts and their subdomains, but not parent domains", () => {
    expect(urlUsesOfficialHost("https://api.docs.acme.example/v1", ["https://docs.acme.example"])).toBe(true);
    expect(urlUsesOfficialHost("https://acme.example/docs", ["https://docs.acme.example"])).toBe(false);
  });
});
