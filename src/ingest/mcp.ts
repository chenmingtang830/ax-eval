/**
 * MCP ingest: inspect an MCP server's tool surface and persist a compact,
 * deterministic artifact that generation can turn into an MCP-only task pack.
 *
 * Supports three source forms:
 * - file path: JSON fixture or prior tools/list response
 * - http(s) URL: JSON-RPC initialize + tools/list over HTTP
 * - command string: minimal stdio JSON-RPC initialize + tools/list
 */
import { existsSync, readFileSync } from "node:fs";
import { listMcpHttpTools, listMcpStdioTools } from "../harness/mcp-json-rpc.js";

export const MCP_INGEST_SCHEMA = "ax.mcp-ingest/v1" as const;

export type McpTransport = "http" | "stdio";

export interface IngestedMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface IngestedMcp {
  schema: typeof MCP_INGEST_SCHEMA;
  source: string;
  title: string;
  server: string;
  transport: McpTransport;
  tools: IngestedMcpTool[];
}

type Json = Record<string, unknown>;

function isJsonObject(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeTool(raw: unknown): IngestedMcpTool | null {
  if (!isJsonObject(raw) || typeof raw.name !== "string") return null;
  const schema =
    isJsonObject(raw.inputSchema) ? raw.inputSchema :
    isJsonObject(raw.input_schema) ? raw.input_schema :
    {};
  return {
    name: raw.name,
    description: typeof raw.description === "string" ? raw.description : "",
    inputSchema: schema,
  };
}

export function parseMcpToolsPayload(payload: unknown, source: string, server = source): IngestedMcp {
  const root = isJsonObject(payload) ? payload : {};
  const result = isJsonObject(root.result) ? root.result : root;
  const rawTools =
    Array.isArray(result.tools) ? result.tools :
    Array.isArray(root.tools) ? root.tools :
    Array.isArray(payload) ? payload :
    [];
  const tools = rawTools.map(normalizeTool).filter((tool): tool is IngestedMcpTool => !!tool);
  const title =
    typeof root.title === "string" ? root.title :
    typeof result.title === "string" ? result.title :
    typeof root.name === "string" ? root.name :
    "MCP Target";
  const transport: McpTransport = /^https?:\/\//i.test(server) ? "http" : "stdio";
  return {
    schema: MCP_INGEST_SCHEMA,
    source,
    title,
    server,
    transport,
    tools,
  };
}

async function ingestHttp(url: string): Promise<IngestedMcp> {
  return parseMcpToolsPayload(await listMcpHttpTools(url), url, url);
}

async function ingestStdio(command: string, timeoutMs: number): Promise<IngestedMcp> {
  return parseMcpToolsPayload(await listMcpStdioTools(command, timeoutMs), command, command);
}

export async function ingestMcp(source: string, opts: { timeoutMs?: number } = {}): Promise<IngestedMcp> {
  if (existsSync(source)) {
    const parsed = JSON.parse(readFileSync(source, "utf8")) as unknown;
    return parseMcpToolsPayload(parsed, source, source);
  }
  if (/^https?:\/\//i.test(source)) return ingestHttp(source);
  return ingestStdio(source, opts.timeoutMs ?? 20000);
}

export function looksLikeMcpIngest(value: unknown): value is IngestedMcp {
  return isJsonObject(value) && value.schema === MCP_INGEST_SCHEMA && Array.isArray(value.tools);
}
