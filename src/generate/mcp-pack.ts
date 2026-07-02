/**
 * Generate an MCP-native pack from tools/list. This is intentionally heuristic:
 * it creates only tasks with a credible write tool + read-back tool pair.
 */
import type { IngestedMcp, IngestedMcpTool } from "../ingest/mcp.js";
import type { Auth, OracleSpec, Task, TargetPack } from "../schemas.js";
import { auditMcpToolQuality } from "../static/mcp-smells.js";
import { GENERATED_BY, newRunId, NS_PLACEHOLDER, packToYaml, probeValue } from "./pack.js";

type Json = Record<string, unknown>;

export interface GenerateMcpPackOptions {
  packName: string;
  product?: string;
  version?: string;
  standardSetVersion?: string;
  runId?: string;
  limit?: number;
  authEnv?: string;
  authType?: Auth["type"];
  generatedBy?: string;
}

function words(value: string): string[] {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !["tool", "api", "mcp"].includes(w));
}

function toolText(tool: IngestedMcpTool): string {
  return `${tool.name} ${tool.description}`.toLowerCase();
}

function isCreate(tool: IngestedMcpTool): boolean {
  return /\b(create|add|new|insert|make)\b/.test(toolText(tool));
}

function isRead(tool: IngestedMcpTool): boolean {
  return /\b(get|read|retrieve|fetch|lookup|find|show)\b/.test(toolText(tool));
}

function properties(schema: Json): Record<string, unknown> {
  return schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, unknown>
    : {};
}

function required(schema: Json): string[] {
  return Array.isArray(schema.required) ? schema.required.filter((v): v is string => typeof v === "string") : [];
}

function fieldType(schema: Json, field: string): string {
  const prop = properties(schema)[field];
  return prop && typeof prop === "object" && !Array.isArray(prop)
    ? String((prop as Json).type ?? "")
    : "";
}

function identityField(tool: IngestedMcpTool): string | null {
  const props = properties(tool.inputSchema);
  for (const key of ["name", "title", "label", "text", "summary"]) {
    if (key in props) return key;
  }
  return required(tool.inputSchema).find((key) => fieldType(tool.inputSchema, key) === "string") ?? null;
}

function idParam(tool: IngestedMcpTool): string | null {
  const req = required(tool.inputSchema);
  const props = Object.keys(properties(tool.inputSchema));
  return [...req, ...props].find((key) => /(^id$|_id$|Id$|gid|key$)/.test(key)) ?? null;
}

function resourceTokens(tool: IngestedMcpTool): string[] {
  return words(tool.name)
    .filter((w) => !["create", "add", "new", "insert", "make", "get", "read", "retrieve", "fetch", "lookup", "find", "show"].includes(w));
}

function singular(value: string): string {
  return value.replace(/ies$/i, "y").replace(/s$/i, "");
}

function resourceName(tool: IngestedMcpTool): string {
  const tokens = resourceTokens(tool);
  return singular(tokens[tokens.length - 1] ?? tool.name);
}

function sharedResourceScore(create: IngestedMcpTool, read: IngestedMcpTool): number {
  const c = new Set(resourceTokens(create).map(singular));
  const r = new Set(resourceTokens(read).map(singular));
  let score = 0;
  for (const token of c) if (r.has(token)) score += 1;
  return score;
}

function pairRead(create: IngestedMcpTool, reads: IngestedMcpTool[]): IngestedMcpTool | null {
  return [...reads]
    .filter((tool) => !!idParam(tool))
    .sort((a, b) => sharedResourceScore(create, b) - sharedResourceScore(create, a) || a.name.localeCompare(b.name))[0] ?? null;
}

function mcpOracle(read: IngestedMcpTool, idKey: string, assertField: string, expected: string): OracleSpec {
  return {
    type: "mcp_roundtrip",
    description: `call MCP tool ${read.name} and assert ${assertField}`,
    mcpTool: read.name,
    mcpArgsTemplate: { [idKey]: "{gid}" },
    assertField,
    expected,
  };
}

export function generateMcpPack(ingest: IngestedMcp, opts: GenerateMcpPackOptions): TargetPack {
  const limit = opts.limit ?? 3;
  const runId = opts.runId ?? newRunId();
  const creates = ingest.tools.filter(isCreate);
  const reads = ingest.tools.filter(isRead);
  const tasks: Task[] = [];

  for (const create of creates) {
    if (tasks.length >= limit) break;
    const field = identityField(create);
    if (!field) continue;
    const read = pairRead(create, reads);
    if (!read) continue;
    const key = idParam(read);
    if (!key) continue;
    const resource = resourceName(create);
    const val = probeValue(resource);
    tasks.push({
      id: `mcp-l1-${resource.replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase()}`,
      title: `L1: create a ${resource} through MCP`,
      difficulty: "L1",
      prompt:
        `Using only the MCP server tools, create one ${resource} with ${field} "${val}". ` +
        `Report the created id as gid.`,
      allowed_surfaces: ["mcp", "docs"],
      depends_on: [],
      trace: [],
      oracles: [mcpOracle(read, key, field, val)],
    });
  }

  const product = (opts.product ?? ingest.title.replace(/\s+MCP$/i, "").trim()) || opts.packName;
  const auth: Auth = {
    type: opts.authType ?? "none",
    env: opts.authEnv ?? "",
    env_aliases: [],
    verify_env_aliases: [],
  };

  return {
    name: opts.packName,
    version: opts.version ?? "0",
    standard_set_version: opts.standardSetVersion ?? `mcp-gen-${new Date().toISOString().slice(0, 10)}`,
    run_id: runId,
    generated_by: opts.generatedBy ?? `${GENERATED_BY}+mcp-tools`,
    auth_method: auth.type,
    api_style: "rest",
    auth,
    sandbox_scope: [],
    base_url: "",
    headers: {},
    site_url: "",
    openapi_url: "",
    docs_urls: [],
    mcp_tool_quality: auditMcpToolQuality(ingest),
    discovery: {
      product,
      goal:
        `You are about to operate ${product} through an MCP server. First list the ` +
        `server tools, read their descriptions and input schemas, then use the right tool for each task.`,
      official_domains: [],
      canonical_endpoint: creates[0]?.name ?? "",
      deprecated_markers: [],
      auth_scheme: "MCP transport authentication",
    },
    surfaces: {
      mcp: {
        server: ingest.server,
        transport: ingest.transport,
      },
    },
    tasks,
  };
}

export { packToYaml };
