import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TargetPackSchema } from "../src/schemas.js";
import {
  approvalPath,
  checkApproval,
  oracleTier,
  packQaIssues,
  packContentHash,
  reviewSummary,
  writeApproval,
} from "../src/generate/review.js";

function pack(overrides: Record<string, unknown> = {}) {
  return TargetPackSchema.parse({
    name: "t",
    standard_set_version: "v1",
    base_url: "https://api.example.test",
    tasks: [
      {
        id: "create-thing",
        difficulty: "L1",
        prompt: "Create a thing named {ns}",
        allowed_surfaces: ["docs", "api"],
        oracles: [{ type: "roundtrip", assertField: "name", expected: "x" }],
      },
    ],
    ...overrides,
  });
}

describe("review gate", () => {
  let dir: string;
  let packPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ax-review-"));
    packPath = join(dir, "generated.pack.yaml");
    writeFileSync(packPath, "name: t\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("derives T1/high for roundtrip and T2/low for weaker oracles", () => {
    expect(oracleTier({ type: "roundtrip" } as never).tier).toBe("T1");
    expect(oracleTier({ type: "roundtrip" } as never).confidence).toBe("high");
    expect(oracleTier({ type: "exists" } as never).tier).toBe("T2");
    expect(oracleTier({ type: "equals" } as never).confidence).toBe("low");
  });

  it("hash is stable across re-parse and changes with content", () => {
    const a = packContentHash(pack());
    const b = packContentHash(pack());
    expect(a).toBe(b);
    const c = packContentHash(pack({ tasks: [{ id: "x", prompt: "different", oracles: [] }] }));
    expect(c).not.toBe(a);
  });

  it("hashes verifier connections and execution-control fields", () => {
    const original = pack();
    const originalHash = packContentHash(original);
    const cases = [
      pack({ sql_conn: { dialect: "postgres", connection_string_env: "DATABASE_URL" } }),
      pack({ mongo_conn: { connection_string_env: "MONGODB_URL", database: "sandbox" } }),
      pack({ api_style: "graphql" }),
      pack({ headers: { "X-API-Version": "2026-01-01" } }),
      pack({ response_envelope: "data" }),
      pack({ surfaces: { cli: { bin: "acme", install: "npm install -g acme" } } }),
      pack({ tasks: [{ ...original.tasks[0], na: true }] }),
      pack({ tasks: [{ ...original.tasks[0], na: true, na_reason: "Unsupported by official docs." }] }),
      pack({ tasks: [{ ...original.tasks[0], depends_on: ["setup"] }] }),
      pack({ tasks: [{ ...original.tasks[0], trace: [{ type: "required_call", path: "/things" }] }] }),
    ];
    for (const changed of cases) {
      expect(packContentHash(changed)).not.toBe(originalHash);
    }
  });

  it("gate is closed until approved, then matches", () => {
    const p = pack();
    expect(checkApproval(p, packPath).ok).toBe(false);
    writeApproval(packPath, p, "tester");
    expect(checkApproval(p, packPath).ok).toBe(true);
  });

  it("re-closes the gate when the pack changes after approval", () => {
    const p = pack();
    writeApproval(packPath, p, "tester");
    const changed = pack({ tasks: [{ id: "create-thing", prompt: "now malicious rm -rf", oracles: [] }] });
    const status = checkApproval(changed, packPath);
    expect(status.ok).toBe(false);
    expect(status.reason).toMatch(/changed since approval/);
  });

  it("approval sidecar sits next to the pack", () => {
    expect(approvalPath("/x/generated.pack.yaml")).toBe("/x/generated.pack.approval.json");
  });

  it("summary flags a task with no oracle", () => {
    const md = reviewSummary(pack({ tasks: [{ id: "naked", prompt: "do it", oracles: [] }] }));
    expect(md).toMatch(/NO ORACLE/);
  });

  it("shows explicit N/A reasons without a false missing-oracle warning", () => {
    const md = reviewSummary(pack({
      tasks: [{ id: "unsupported", prompt: "", na: true, na_reason: "No official recovery surface.", oracles: [] }],
    }));
    expect(md).toContain("N/A: No official recovery surface.");
    expect(md).not.toMatch(/NO ORACLE/);
  });

  it("shows review-hashed execution surfaces and constants", () => {
    const md = reviewSummary(pack({
      headers: { "X-API-Version": "2026-01-01" },
      surfaces: { mcp: { server: "https://mcp.example.test", transport: "http" } },
    }));
    expect(md).toContain("X-API-Version: 2026-01-01");
    expect(md).toContain("MCP (http)");
    expect(md).toContain("https://mcp.example.test");
  });

  it("does not describe stateless packs as write operations", () => {
    const md = reviewSummary(pack({ sandbox_scope: [] }));
    expect(md).toMatch(/call the live product/);
    expect(md).not.toMatch(/write-ops/);
  });

  it("flags free-choice prompts with a tightly bound oracle resource", () => {
    const p = pack({
      tasks: [
        {
          id: "decisions-log",
          difficulty: "L3",
          prompt: "Choose an appropriate Notion structure called AX decisions {ns}. Report its id.",
          allowed_surfaces: ["api", "cli", "sdk", "mcp", "docs"],
          oracles: [
            {
              type: "roundtrip",
              readPathTemplate: "/v1/data_sources/{gid}",
              assertField: "title.0.plain_text",
              expected: "AX decisions {ns}",
            },
          ],
        },
      ],
    });
    const issues = packQaIssues(p);
    expect(issues.map((i) => i.code)).toContain("free-choice-bound-oracle");
    expect(reviewSummary(p)).toMatch(/Pack QA/);
  });

  it("flags prompt/oracle resource mismatches", () => {
    const p = pack({
      tasks: [
        {
          id: "database-read-as-data-source",
          prompt: "Create a Notion database titled AX decisions {ns}. Report the database id.",
          oracles: [
            {
              type: "roundtrip",
              readPathTemplate: "/v1/data_sources/{gid}",
              assertField: "title.0.plain_text",
              expected: "AX decisions {ns}",
            },
          ],
        },
      ],
    });
    expect(packQaIssues(p).map((i) => i.code)).toContain("prompt-oracle-resource-mismatch");
  });

  it("does not flag an explicit database prompt with a database oracle", () => {
    const p = pack({
      tasks: [
        {
          id: "decisions-log",
          prompt: "Create a Notion database titled AX decisions {ns}. Report the database id.",
          oracles: [
            {
              type: "roundtrip",
              readPathTemplate: "/v1/databases/{gid}",
              assertField: "title.0.plain_text",
              expected: "AX decisions {ns}",
            },
          ],
        },
      ],
    });
    expect(packQaIssues(p).map((i) => i.code)).not.toContain("free-choice-bound-oracle");
    expect(packQaIssues(p).map((i) => i.code)).not.toContain("prompt-oracle-resource-mismatch");
  });

  it("flags advanced data source/view tasks enabled on every surface", () => {
    const p = pack({
      tasks: [
        {
          id: "data-source-view",
          prompt: "Create a data source and add a table view named AX view {ns}. Report the view id.",
          allowed_surfaces: ["api", "cli", "sdk", "mcp"],
          oracles: [
            {
              type: "roundtrip",
              readPathTemplate: "/v1/views/{gid}",
              assertField: "name",
              expected: "AX view {ns}",
            },
          ],
        },
      ],
    });
    const codes = packQaIssues(p).map((i) => i.code);
    expect(codes).toContain("surface-risk");
    expect(codes).not.toContain("ambiguous-reported-id");
  });
});
