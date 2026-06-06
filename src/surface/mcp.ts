/**
 * MCP surface — the agent must operate the product through its Model Context
 * Protocol server's tools, NOT raw HTTP. "Discovery" is `tools/list` + reading
 * each tool's name/description/input schema: the server is self-describing, so a
 * good MCP surface needs no web search at all. Verification is still the API
 * read-back oracle (we confirm world state independently of how it was created).
 */
import type { Surface } from "./types.js";
import { DISCOVERY_HEADER, productName } from "./types.js";

export const mcpSurface: Surface = {
  id: "mcp",
  subject: "MCP tools",
  actionUnit: "MCP tool actions",
  setupBlock: (pack) => {
    const m = pack.surfaces?.mcp;
    if (!m) return [];
    const lines = [
      `=== SURFACE: MCP ===`,
      `You must operate ${productName(pack)} through its Model Context Protocol (MCP) server's tools, NOT raw HTTP/curl.`,
    ];
    if (m.setup) lines.push(`Server setup: ${m.setup}`);
    lines.push(`Server: ${m.server} (transport: ${m.transport}).`, ``);
    return lines;
  },
  discoveryBlock: (pack) => {
    const product = productName(pack);
    return [
      DISCOVERY_HEADER,
      `Before doing ANY task, discover what the ${product} MCP server can do. You are NOT told`,
      `which tools exist or what arguments they take.`,
      `- List the server's tools (tools/list) and read each tool's name, description, and input schema.`,
      `- Determine: which tool creates each resource and the exact arguments it needs.`,
      `- Rely ONLY on the tool schemas/descriptions the server exposes — do NOT guess from memory.`,
      `- Everything you do in Phase 1 MUST use the tools you discovered here.`,
      ``,
    ];
  },
  actionGuidance: () => "Call the MCP server's tools for every action (not raw curl).",
  resultsHints: {
    base: "<the MCP server you connected to>",
    endpoint: "<the MCP tool you used to create, e.g. `create_task`>",
    auth: "<how the server was authenticated / configured>",
  },
};
