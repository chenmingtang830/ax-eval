import { describe, expect, it } from "vitest";
import { generateMcpPack } from "../src/generate/mcp-pack.js";
import { renderGeneratedReport, type ProfileRun } from "../src/generate/report.js";
import type { McpToolQualityAudit } from "../src/static/mcp-smells.js";
import { TargetPackSchema } from "../src/schemas.js";
import type { IngestedMcp } from "../src/ingest/mcp.js";

const ingest: IngestedMcp = {
  schema: "ax.mcp-ingest/v1",
  source: "fixture",
  title: "Linear MCP",
  server: "https://mcp.linear.test/mcp",
  transport: "http",
  tools: [
    {
      name: "create_issue",
      description: "Create a new issue",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" }, description: { type: "string" } },
        required: ["title"],
      },
    },
    {
      name: "get_issue",
      description: "Retrieve an issue by issueId",
      inputSchema: {
        type: "object",
        properties: { issueId: { type: "string" } },
        required: ["issueId"],
      },
    },
    {
      name: "delete_issue",
      description: "Delete an issue",
      inputSchema: {
        type: "object",
        properties: { issueId: { type: "string" } },
        required: ["issueId"],
      },
    },
  ],
};

describe("MCP-native pack generation", () => {
  it("generates MCP-only tasks with MCP round-trip oracles", () => {
    const pack = generateMcpPack(ingest, {
      packName: "linear-mcp-generated",
      product: "Linear",
      runId: "2026-07-02-mcp",
    });

    expect(() => TargetPackSchema.parse(pack)).not.toThrow();
    expect(pack.surfaces?.mcp?.server).toBe("https://mcp.linear.test/mcp");
    expect(pack.tasks).toHaveLength(1);
    expect(pack.tasks[0]!.allowed_surfaces).toEqual(["mcp", "docs"]);
    expect(pack.tasks[0]!.prompt).toContain("Using only the MCP server tools");
    expect(pack.tasks[0]!.oracles[0]).toMatchObject({
      type: "mcp_roundtrip",
      mcpTool: "get_issue",
      mcpArgsTemplate: { issueId: "{gid}" },
      assertField: "title",
    });
    expect(pack.tasks[0]!.oracles[0]!.expected).toContain("{ns}");
    expect((pack.mcp_tool_quality as McpToolQualityAudit).score).toBeLessThan(100);
  });

  it("skips create tools when no read-back tool can verify them", () => {
    const pack = generateMcpPack({ ...ingest, tools: [ingest.tools[0]!] }, { packName: "x" });
    expect(pack.tasks).toEqual([]);
  });

  it("surfaces MCP tool quality in generated reports", () => {
    const pack = generateMcpPack(ingest, {
      packName: "linear-mcp-generated",
      product: "Linear",
      runId: "2026-07-02-mcp",
    });
    const run: ProfileRun = {
      profile: "high",
      harness: "codex",
      surface: "mcp",
      outcomes: [
        {
          taskId: pack.tasks[0]!.id,
          difficulty: "L1",
          profile: "high",
          success: true,
          oracleResults: [{ type: "mcp_roundtrip", passed: true, detail: "ok" }],
          error: null,
        },
      ],
    };
    const quality = pack.mcp_tool_quality as McpToolQualityAudit;
    const html = renderGeneratedReport(pack, [run], {
      site: "",
      mcpToolScore: quality.score,
      mcpToolQuality: quality,
    });
    expect(html).toContain("MCP tool quality");
    expect(html).toContain("tools/list");
    expect(html).toContain("Improve MCP tool-list quality");
  });
});
