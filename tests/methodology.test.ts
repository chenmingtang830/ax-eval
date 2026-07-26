import { describe, expect, it } from "vitest";
import { auditSurfaceExtract } from "../src/generate/surface-extract.js";

describe("suite methodology artifacts", () => {
  it("audits suspicious surface auth before publication", () => {
    const audited = auditSurfaceExtract({
      vendor: "Neon",
      slug: "neon",
      extracted_at: "2026-01-01T00:00:00.000Z",
      cli: {
        bin: "neon",
        docs_url: "https://neon.com/docs/cli",
        auth: {
          kind: "inherit",
          token_env_aliases: [],
          instructions: "Point your MCP client at the server URL and approve access in the browser.",
        },
      },
      sdk: null,
      mcp: null,
    });

    expect(audited.schema).toBe("ax.surface-extract/v1");
    expect(audited.audit_notes.join("\n")).toMatch(/copied from another surface/);
  });
});
