/**
 * Minimal MCP JSON-RPC helpers for ingest and verification. This intentionally
 * stays transport-level so tests can use plain fixtures and fake servers.
 */
import { spawn } from "node:child_process";

type Json = Record<string, unknown>;

export function splitCommand(command: string): string[] {
  return command.match(/"[^"]+"|'[^']+'|\S+/g)?.map((part) => part.replace(/^(['"])(.*)\1$/, "$2")) ?? [];
}

function parseSseJson(text: string): string {
  return text.split(/\n/).find((line) => line.startsWith("data: "))?.slice(6) ?? "{}";
}

export async function postMcpJsonRpc(
  url: string,
  body: Json,
  opts: { sessionId?: string; headers?: Record<string, string> } = {},
): Promise<{ json: Json; sessionId?: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(opts.sessionId ? { "Mcp-Session-Id": opts.sessionId } : {}),
      ...(opts.headers ?? {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`MCP ${String(body.method ?? "request")} HTTP ${res.status}: ${text.slice(0, 240)}`);
  const raw = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? parseSseJson(text)
    : text || "{}";
  const json = JSON.parse(raw) as Json;
  return { json, sessionId: res.headers.get("mcp-session-id") ?? opts.sessionId };
}

export function mcpInitializeRequest(id = 1): Json {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "ax-eval", version: "0.0.0" },
    },
  };
}

export function mcpToolsListRequest(id = 2): Json {
  return { jsonrpc: "2.0", id, method: "tools/list", params: {} };
}

export function mcpToolsCallRequest(id: number, tool: string, args: unknown): Json {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: tool, arguments: args ?? {} },
  };
}

export async function callMcpHttpTool(
  url: string,
  tool: string,
  args: unknown,
  opts: { headers?: Record<string, string> } = {},
): Promise<Json> {
  const init = await postMcpJsonRpc(url, mcpInitializeRequest(1), { headers: opts.headers })
    .catch(() => ({ json: {}, sessionId: undefined }));
  const called = await postMcpJsonRpc(
    url,
    mcpToolsCallRequest(2, tool, args),
    { sessionId: init.sessionId, headers: opts.headers },
  );
  return called.json;
}

export async function listMcpHttpTools(url: string, opts: { headers?: Record<string, string> } = {}): Promise<Json> {
  const init = await postMcpJsonRpc(url, mcpInitializeRequest(1), { headers: opts.headers })
    .catch(() => ({ json: {}, sessionId: undefined }));
  return (await postMcpJsonRpc(url, mcpToolsListRequest(2), { sessionId: init.sessionId, headers: opts.headers })).json;
}

export async function requestMcpStdio(
  command: string,
  requests: Json[],
  waitForId: number,
  timeoutMs: number,
): Promise<Json> {
  const parts = splitCommand(command);
  if (!parts.length) throw new Error("empty MCP stdio command");
  const child = spawn(parts[0]!, parts.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
  const responses = new Map<number, Json>();
  let stdout = "";
  let stderr = "";
  const done = new Promise<Json>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`MCP stdio request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      for (;;) {
        const idx = stdout.indexOf("\n");
        if (idx === -1) break;
        const line = stdout.slice(0, idx).trim();
        stdout = stdout.slice(idx + 1);
        if (!line.startsWith("{")) continue;
        try {
          const msg = JSON.parse(line) as Json;
          if (typeof msg.id === "number") responses.set(msg.id, msg);
          const wanted = responses.get(waitForId);
          if (wanted) {
            clearTimeout(timer);
            resolve(wanted);
          }
        } catch {
          /* ignore non-protocol logs */
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      if (!responses.has(waitForId)) {
        clearTimeout(timer);
        reject(new Error(`MCP stdio command exited before response ${waitForId} (code ${code}): ${stderr.slice(0, 240)}`));
      }
    });
  });
  for (const request of requests) child.stdin.write(JSON.stringify(request) + "\n");
  try {
    return await done;
  } finally {
    child.kill("SIGTERM");
  }
}

export async function listMcpStdioTools(command: string, timeoutMs: number): Promise<Json> {
  return requestMcpStdio(command, [mcpInitializeRequest(1), mcpToolsListRequest(2)], 2, timeoutMs);
}

export async function callMcpStdioTool(command: string, tool: string, args: unknown, timeoutMs: number): Promise<Json> {
  return requestMcpStdio(command, [mcpInitializeRequest(1), mcpToolsCallRequest(2, tool, args)], 2, timeoutMs);
}
