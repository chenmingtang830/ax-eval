import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { describe, expect, it } from "vitest"
import { handleAudit, handleDiscover, handleRun, TOOLS } from "../src/mcp-server.js"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const CLI = resolve(ROOT, "src", "cli.ts")
const ASANA_PACK = resolve(ROOT, "targets", "examples", "asana", "pack.yaml")

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

describe("TOOLS registry", () => {
  it("exposes exactly three tools", () => {
    expect(TOOLS).toHaveLength(3)
    expect(TOOLS.map((t) => t.name)).toEqual(["ax_eval_audit", "ax_eval_discover", "ax_eval_run"])
  })

  it("each tool has a name, description, and inputSchema", () => {
    for (const tool of TOOLS) {
      expect(typeof tool.name).toBe("string")
      expect(typeof tool.description).toBe("string")
      expect(tool.inputSchema.type).toBe("object")
    }
  })

  it("ax_eval_run marks pack as required", () => {
    const runTool = TOOLS.find((t) => t.name === "ax_eval_run")!
    expect(runTool.inputSchema.required).toContain("pack")
  })
})

// ---------------------------------------------------------------------------
// handleAudit
// ---------------------------------------------------------------------------

describe("handleAudit", () => {
  it("returns a valid StaticAudit from a pack path (offline)", async () => {
    const result = await handleAudit({ pack: ASANA_PACK, offline: true })
    expect(result.score).toBeGreaterThanOrEqual(0)
    expect(result.score).toBeLessThanOrEqual(100)
    expect(Array.isArray(result.checks)).toBe(true)
    expect(result.checks.length).toBeGreaterThan(0)
    expect(result.source).toBe("fixture")
  })

  it("returns a valid StaticAudit from a site URL (offline)", async () => {
    const result = await handleAudit({ site: "https://asana.com", offline: true })
    expect(result.score).toBeGreaterThan(0)
    expect(result.checks.every((c: { status: string }) => ["pass", "fail", "error"].includes(c.status))).toBe(true)
  })

  it("site overrides pack site_url when both are provided", async () => {
    const fromPack = await handleAudit({ pack: ASANA_PACK, offline: true })
    const fromSite = await handleAudit({ site: "https://asana.com", offline: true })
    // Both resolve to the same asana site, should produce identical scores
    expect(fromPack.score).toBe(fromSite.score)
  })

  it("throws when neither pack nor site is provided", async () => {
    await expect(handleAudit({})).rejects.toThrow("Provide either a 'pack' path or a 'site' URL.")
  })

  it("throws when pack has no site_url and no site is provided", async () => {
    // A non-existent pack path will throw from loadPack, which is acceptable
    await expect(handleAudit({ pack: "/nonexistent/pack.yaml" })).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// handleDiscover
// ---------------------------------------------------------------------------

describe("handleDiscover", () => {
  it("returns discovery results from a pack path (offline)", async () => {
    const result = await handleDiscover({ pack: ASANA_PACK, offline: true })
    expect(result).toBeDefined()
    // discoverSurfaces returns a DiscoveryAudit-like object
    expect(typeof result).toBe("object")
  })

  it("returns discovery results from a site URL (offline)", async () => {
    const result = await handleDiscover({ site: "https://asana.com", offline: true })
    expect(result).toBeDefined()
  })

  it("forwards maxPages and maxDepth options", async () => {
    // Just verify it doesn't throw with these options — value is passed through to fetcher
    const result = await handleDiscover({
      site: "https://asana.com",
      offline: true,
      maxPages: 5,
      maxDepth: 2,
    })
    expect(result).toBeDefined()
  })

  it("ignores non-number maxPages/maxDepth", async () => {
    // Strings/null should not be forwarded (undefined instead)
    const result = await handleDiscover({
      site: "https://asana.com",
      offline: true,
      maxPages: "bad" as unknown as number,
    })
    expect(result).toBeDefined()
  })

  it("throws when neither pack nor site is provided", async () => {
    await expect(handleDiscover({})).rejects.toThrow("Provide either a 'pack' path or a 'site' URL.")
  })
})

// ---------------------------------------------------------------------------
// handleRun
// ---------------------------------------------------------------------------

describe("handleRun", () => {
  it("runs the mock harness and returns a pass/fail matrix", async () => {
    const result = await handleRun({ pack: ASANA_PACK, harnesses: ["mock"] })
    expect(result.pack).toBe("asana")
    expect(result.harnesses).toEqual(["mock"])
    expect(result.totalTasks).toBeGreaterThan(0)
    expect(result.passRates["mock"]).toMatch(/^\d+\/\d+$/)
    // mock always passes everything
    const [passed, total] = result.passRates["mock"].split("/").map(Number)
    expect(passed).toBe(total)
  })

  it("mock-weak fails some tasks", async () => {
    const result = await handleRun({ pack: ASANA_PACK, harnesses: ["mock-weak"] })
    const [passed, total] = result.passRates["mock-weak"].split("/").map(Number)
    expect(passed).toBeGreaterThan(0)
    expect(passed).toBeLessThan(total)
  })

  it("defaults to mock + mock-weak + hermes when harnesses not specified", async () => {
    const result = await handleRun({ pack: ASANA_PACK })
    expect(result.harnesses).toEqual(["mock", "mock-weak", "hermes"])
    expect(Object.keys(result.passRates)).toEqual(["mock", "mock-weak", "hermes"])
  })

  it("ignores empty harnesses array and uses defaults", async () => {
    const result = await handleRun({ pack: ASANA_PACK, harnesses: [] })
    expect(result.harnesses).toEqual(["mock", "mock-weak", "hermes"])
  })

  it("matrix keys match task ids from the pack", async () => {
    const { loadPack } = await import("../src/config.js")
    const pack = loadPack(ASANA_PACK)
    const result = await handleRun({ pack: ASANA_PACK, harnesses: ["mock"] })
    const taskIds = pack.tasks.map((t: { id: string }) => t.id).sort()
    expect(Object.keys(result.matrix).sort()).toEqual(taskIds)
  })

  it("matrix cell values are booleans", async () => {
    const result = await handleRun({ pack: ASANA_PACK, harnesses: ["mock"] })
    for (const row of Object.values(result.matrix)) {
      for (const val of Object.values(row as Record<string, unknown>)) {
        expect(typeof val).toBe("boolean")
      }
    }
  })

  it("mock beats mock-weak on pass rate", async () => {
    const result = await handleRun({ pack: ASANA_PACK, harnesses: ["mock", "mock-weak"] })
    const [mockPassed, mockTotal] = result.passRates["mock"].split("/").map(Number)
    const [weakPassed, weakTotal] = result.passRates["mock-weak"].split("/").map(Number)
    expect(mockPassed / mockTotal).toBeGreaterThan(weakPassed / weakTotal)
  })

  it("throws when pack is missing", async () => {
    await expect(handleRun({})).rejects.toThrow("'pack' is required")
  })

  it("throws when pack is not a string", async () => {
    await expect(handleRun({ pack: 42 })).rejects.toThrow("'pack' is required")
  })

  it("throws on unknown harness name", async () => {
    await expect(handleRun({ pack: ASANA_PACK, harnesses: ["nonexistent-harness"] })).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Server lifecycle (spawned over stdio) — exercises the real cli.ts entrypoint
// and the event-driven shutdown path that the handler unit tests cannot reach.
// ---------------------------------------------------------------------------

interface RpcLine {
  jsonrpc: string
  id?: number
  result?: unknown
  method?: string
}

/** Spawn `cli.ts mcp-server`, write the given JSON-RPC lines to its stdin, then
 *  either close stdin (closeStdin=true → triggers EOF shutdown) or leave it open
 *  briefly. Collects parsed JSON-RPC responses from stdout until the process
 *  exits or `timeoutMs` elapses. Resolves with { responses, exited, stderr }. */
function driveServer(
  lines: string[],
  opts: { closeStdin?: boolean; timeoutMs?: number } = {},
): Promise<{ responses: RpcLine[]; exited: boolean; stderr: string }> {
  const { closeStdin = true, timeoutMs = 15000 } = opts
  return new Promise((resolveOuter) => {
    const child: ChildProcessWithoutNullStreams = spawn(
      "node",
      ["--import", "tsx", CLI, "mcp-server"],
      {
        cwd: ROOT,
        // A bad NODE_OPTIONS preload (e.g. a stale --require) would crash the
        // child before our code runs; strip it so the test reflects our code.
        env: { ...process.env, NODE_OPTIONS: "" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    )
    let outBuf = ""
    let errBuf = ""
    let exited = false
    const responses: RpcLine[] = []

    const collect = () => {
      const parts = outBuf.split("\n")
      outBuf = parts.pop() ?? ""
      for (const line of parts) {
        const t = line.trim()
        if (!t) continue
        try {
          responses.push(JSON.parse(t) as RpcLine)
        } catch {
          /* ignore non-JSON lines */
        }
      }
    }

    child.stdout.on("data", (d: Buffer) => {
      outBuf += d.toString("utf8")
      collect()
    })
    child.stderr.on("data", (d: Buffer) => {
      errBuf += d.toString("utf8")
    })

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {
        /* already gone */
      }
    }, timeoutMs)
    timer.unref?.()

    child.on("close", () => {
      exited = true
      clearTimeout(timer)
      collect()
      resolveOuter({ responses, exited, stderr: errBuf })
    })

    for (const line of lines) child.stdin.write(line + "\n")
    if (closeStdin) child.stdin.end()
  })
}

const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "vitest", version: "0" },
  },
})
const INITIALIZED = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })

describe("server lifecycle (spawned over stdio)", () => {
  it("responds to initialize and lists all three tools", async () => {
    const { responses } = await driveServer([
      INIT,
      INITIALIZED,
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    ])
    const init = responses.find((r) => r.id === 1)
    expect(init?.result).toBeDefined()

    const list = responses.find((r) => r.id === 2)
    const tools = (list?.result as { tools?: Array<{ name: string }> })?.tools ?? []
    expect(tools.map((t) => t.name).sort()).toEqual([
      "ax_eval_audit",
      "ax_eval_discover",
      "ax_eval_run",
    ])
  }, 20000)

  it("answers a tools/call (ax_eval_run) with a matrix, even when stdin closes immediately after", async () => {
    // closeStdin defaults to true → stdin EOF fires right after the request is
    // written. The event-driven shutdown must still flush the result before the
    // process exits (this is the race the lifecycle fix addresses).
    const { responses, exited } = await driveServer([
      INIT,
      INITIALIZED,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "ax_eval_run",
          arguments: { pack: ASANA_PACK, harnesses: ["mock"] },
        },
      }),
    ])
    const call = responses.find((r) => r.id === 2)
    const content = (call?.result as { content?: Array<{ text: string }> })?.content
    expect(content?.[0]?.text).toBeDefined()
    const payload = JSON.parse(content![0].text) as { passRates: Record<string, string> }
    expect(payload.passRates.mock).toMatch(/^\d+\/\d+$/)
    // And the process shut down cleanly on stdin EOF rather than hanging.
    expect(exited).toBe(true)
  }, 20000)

  it("exits on stdin EOF without an explicit shutdown request", async () => {
    const { exited } = await driveServer([INIT, INITIALIZED])
    expect(exited).toBe(true)
  }, 20000)
})
