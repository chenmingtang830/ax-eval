#!/usr/bin/env node
/**
 * ax-eval MCP server — exposes the eval pipeline as native MCP tools so any
 * MCP-capable agent (Claude, Codex, Cursor, etc.) can run evals without
 * shelling out to the CLI.
 *
 * Tools:
 *   ax_eval_audit    — static agent-readiness audit (0–100 score + check list)
 *   ax_eval_discover — agent-style crawl discovery of surfaces
 *   ax_eval_run      — behavioral task matrix (pass/fail per task × harness)
 *
 * Usage (stdio transport):
 *   npx ax-eval mcp-server
 *
 * Claude Desktop config (~/.config/Claude/claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "ax-eval": { "command": "npx", "args": ["ax-eval", "mcp-server"] }
 *     }
 *   }
 *
 * Claude Code (.claude/settings.json):
 *   {
 *     "mcpServers": {
 *       "ax-eval": { "command": "npx", "args": ["ax-eval", "mcp-server"] }
 *     }
 *   }
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { loadDotenv, loadPack } from "./config.js"
import { run, matrix } from "./runner.js"
import { auditSite } from "./static/audit.js"
import { discoverSurfaces } from "./static/discover.js"

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const TOOLS = [
  {
    name: "ax_eval_audit",
    description:
      "Run a static agent-readiness audit against a target. Returns a 0–100 score and a list of " +
      "checks (llms.txt, OpenAPI spec, MCP server, SDK, auth, etc.). " +
      "Provide either a pack path (YAML from targets/examples/) or a site URL directly.",
    inputSchema: {
      type: "object" as const,
      properties: {
        pack: {
          type: "string",
          description:
            "Path to a target pack YAML file (e.g. targets/examples/exa/pack.yaml). " +
            "The site_url from the pack is used for the audit.",
        },
        site: {
          type: "string",
          description: "Direct site URL to audit (e.g. https://exa.ai). Overrides pack site_url.",
        },
        offline: {
          type: "boolean",
          description: "Use fixture data instead of live network requests. Default false.",
        },
      },
    },
  },
  {
    name: "ax_eval_discover",
    description:
      "Run an agent-style crawl discovery of a target's surfaces (API, SDK, MCP, docs, auth). " +
      "Simulates how a real agent discovers a product from a cold start by following links. " +
      "Provide either a pack path or a site URL.",
    inputSchema: {
      type: "object" as const,
      properties: {
        pack: {
          type: "string",
          description: "Path to a target pack YAML file.",
        },
        site: {
          type: "string",
          description: "Direct site URL to crawl.",
        },
        offline: {
          type: "boolean",
          description: "Use fixture data instead of live network requests. Default false.",
        },
        maxPages: {
          type: "number",
          description: "Maximum pages to crawl. Default 20.",
        },
        maxDepth: {
          type: "number",
          description: "Maximum crawl depth from the entry point. Default 3.",
        },
      },
    },
  },
  {
    name: "ax_eval_run",
    description:
      "Run the behavioral task matrix for a target pack: execute every task across each harness " +
      "and return a pass/fail matrix with per-harness pass rates. " +
      "In offline/mock mode no real API credentials are needed.",
    inputSchema: {
      type: "object" as const,
      required: ["pack"],
      properties: {
        pack: {
          type: "string",
          description: "Path to a target pack YAML file (e.g. targets/examples/exa/pack.yaml).",
        },
        harnesses: {
          type: "array",
          items: { type: "string" },
          description:
            "Harness names to run against. Defaults to ['mock', 'mock-weak', 'hermes']. " +
            "Use 'mock' for keyless offline testing — the harness list (not a flag) " +
            "controls whether the run is keyless.",
        },
      },
    },
  },
]

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

export async function handleAudit(input: Record<string, unknown>) {
  loadDotenv()
  let site = typeof input.site === "string" ? input.site : undefined
  if (!site && typeof input.pack === "string") {
    site = loadPack(input.pack).site_url
  }
  if (!site) throw new Error("Provide either a 'pack' path or a 'site' URL.")
  const offline = input.offline === true
  return auditSite(site, { mode: offline ? "fixture" : "live" })
}

export async function handleDiscover(input: Record<string, unknown>) {
  loadDotenv()
  let site = typeof input.site === "string" ? input.site : undefined
  if (!site && typeof input.pack === "string") {
    site = loadPack(input.pack).site_url
  }
  if (!site) throw new Error("Provide either a 'pack' path or a 'site' URL.")
  const offline = input.offline === true
  const maxPages = typeof input.maxPages === "number" ? input.maxPages : undefined
  const maxDepth = typeof input.maxDepth === "number" ? input.maxDepth : undefined
  return discoverSurfaces(site, { mode: offline ? "fixture" : "live", maxPages, maxDepth })
}

export async function handleRun(input: Record<string, unknown>) {
  if (typeof input.pack !== "string") {
    throw new Error("'pack' is required: path to a target pack YAML file.")
  }
  if (input.harnesses !== undefined && !Array.isArray(input.harnesses)) {
    throw new Error("'harnesses' must be an array of strings.")
  }
  if (Array.isArray(input.harnesses) && !input.harnesses.every((h) => typeof h === "string")) {
    throw new Error("'harnesses' must be an array of strings.")
  }
  loadDotenv()
  const pack = loadPack(input.pack)
  const harnesses =
    Array.isArray(input.harnesses) && input.harnesses.length
      ? (input.harnesses as string[])
      : ["mock", "mock-weak", "hermes"]
  const report = await run(pack, harnesses, { progress: false })
  const grid = matrix(report)

  const passRates: Record<string, string> = {}
  for (const h of report.harnesses) {
    const cells = report.results.filter((r) => r.harness === h)
    const passed = cells.filter((r) => r.success).length
    passRates[h] = `${passed}/${cells.length}`
  }

  return {
    pack: report.pack,
    packVersion: report.packVersion,
    harnesses: report.harnesses,
    passRates,
    matrix: grid,
    totalTasks: pack.tasks.length,
  }
}

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

export async function startMcpServer() {
  const server = new Server(
    { name: "ax-eval", version: "0.3.0" },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }))

  // Track in-flight tool calls. The SDK's close() aborts in-flight request
  // handlers rather than waiting for them, so closing while a slow ax_eval_run
  // is running would drop its result. We instead defer the close until the last
  // in-flight call completes (see closeIfIdle below) — event-driven, no polling
  // or arbitrary timeout. The handlers bound their own network/harness time, so
  // an in-flight call can't wedge shutdown forever.
  const inFlight = new Set<Promise<unknown>>()
  let shutdownRequested = false
  let closed = false
  let resolveShutdown!: () => void
  const shutdownComplete = new Promise<void>((resolve) => {
    resolveShutdown = resolve
  })

  // Close the transport once a shutdown has been requested AND no tool call is
  // still running. Invoked both when the shutdown signal arrives and when the
  // last in-flight request finishes — whichever happens second actually closes.
  const closeIfIdle = async () => {
    if (!shutdownRequested || inFlight.size > 0 || closed) return
    closed = true
    try {
      await server.close()
    } catch {
      /* best effort — we are exiting anyway */
    }
    resolveShutdown()
  }

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params
    const input = (args ?? {}) as Record<string, unknown>

    const work = (async () => {
      try {
        let result: unknown
        if (name === "ax_eval_audit") result = await handleAudit(input)
        else if (name === "ax_eval_discover") result = await handleDiscover(input)
        else if (name === "ax_eval_run") result = await handleRun(input)
        else throw new Error(`Unknown tool: ${name}`)

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        }
      }
    })()

    inFlight.add(work)
    try {
      return await work
    } finally {
      inFlight.delete(work)
      // If shutdown was requested mid-call, this completion triggers the
      // deferred close. Defer by a macrotask (setImmediate) so the SDK's own
      // ".then(send response)" microtask — which runs AFTER our handler resolves
      // — writes the result to stdout BEFORE close() aborts the request. Closing
      // synchronously here would abort the in-flight response and drop it.
      setImmediate(() => void closeIfIdle())
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)

  // Request shutdown: marks the intent, then closes immediately if idle, or lets
  // the last in-flight call's completion close it. Returns a promise that
  // resolves once the transport is actually closed. Idempotent.
  const requestShutdown = (): Promise<void> => {
    shutdownRequested = true
    void closeIfIdle()
    return shutdownComplete
  }

  // connect() resolves once the transport is wired up — it does NOT block for
  // the server's lifetime. Return the handles so the caller can keep the
  // process alive and trigger a graceful shutdown (the SDK does not exit or
  // close on stdin EOF by itself).
  return { server, transport, requestShutdown }
}
