/**
 * Objective capture of a profile's run from the harness sub-agent transcript.
 *
 * The executor's `run-*.json` discovery funnel and `run-*.trace.json` are
 * self-reported (the agent writes them because the prompt asks it to). The
 * harness, however, keeps an objective event log of the sub-agent: the model's
 * reasoning plus every tool call with its real inputs — WebSearch queries, the
 * actual curl commands (method + URL + body), and file reads/writes. It does
 * NOT capture tool *results* (HTTP status, bodies), so this reconstructs WHAT
 * the agent did, not WHAT came back (outcomes stay verified by live readback).
 *
 * Parsing this lets discovery be scored from observed behavior instead of the
 * agent's narration — e.g. it reveals a profile that *claimed* to read the docs
 * but objectively only ran one search and went straight to the API.
 *
 * Caveat: the transcript JSONL is a harness-internal format, not a stable API;
 * treat this as best-effort and keep the self-report as a labeled fallback.
 */
import { readFileSync } from "node:fs";
import type { DiscoveryResult } from "../generate/discovery.js";
import type { SurfaceId } from "../surface/types.js";
import type { TraceStep } from "./executor.js";

export interface ApiCall {
  method: string;
  /** Path relative to the API base (base prefix stripped), e.g. "/tasks". */
  path: string;
  /** Full host of the called URL (to tell API vs docs domains apart). */
  host: string;
}

export interface ObservedRun {
  /** WebSearch queries, in order. */
  searches: string[];
  /** Doc/page fetches (WebFetch / open_resource / curl to a non-API host). */
  urlsFetched: string[];
  /** Every API call issued via curl. */
  apiCalls: ApiCall[];
  /** Files the agent wrote. */
  filesWritten: string[];
  /** Whether any command sent an `Authorization: Bearer` header. */
  sawBearer: boolean;
  /** Vendor-CLI invocations (when an `opts.cliBin` is provided), in order. Each
   *  is the binary + its args as the agent ran it, e.g. "asana task create …". */
  cliCommands: string[];
  /** Whether the agent inspected the CLI's `--help` / `man` (CLI-surface
   *  authoritative discovery — the analogue of opening the docs site). */
  cliHelpInspected: boolean;
  /** SDK usage signals (when an `opts.sdkPackage` is provided): an import/require
   *  of the package, and any `<pkg>.method(` calls observed in scripts. */
  sdkUsage: string[];
  /** MCP signals (when an `opts.mcpServer` is provided): a `tools/list` listing
   *  and each MCP tool the agent invoked (server.tool), in order. */
  mcpToolCalls: string[];
  /** Whether the agent enumerated the MCP server's tools (tools/list — the
   *  MCP-surface authoritative discovery source). */
  mcpToolsListed: boolean;
}

const FETCH_TOOLS = new Set(["WebFetch", "open_resource", "Fetch"]);

const HTTP_METHODS = "GET|POST|PUT|PATCH|DELETE";

/** Escape a string for safe interpolation into a RegExp (bins/packages can
 *  contain regex-special chars, e.g. "@scope/pkg" or "gh-cli"). */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pull vendor-CLI invocations of `bin` out of a shell command string. Matches the
 * binary as a whole word at a command boundary (start, after `&&`/`;`/`|`, or
 * after `npx [-y]`), and captures the rest of that pipeline segment as the args.
 */
function extractCliCommands(cmd: string, bin: string): string[] {
  const out: string[] = [];
  const re = new RegExp(
    `(?:^|[;&|]|\\bnpx\\s+(?:-y\\s+)?)\\s*(${escapeRe(bin)}\\b[^;&|\\n]*)`,
    "g",
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) {
    const call = (m[1] ?? "").trim();
    if (call) out.push(call);
  }
  return out;
}

/** True if the command inspects the CLI's help (a `--help`/`-h` flag, a `help`
 *  subcommand, or a `man <bin>`) — the CLI-surface discovery signal. */
function inspectsCliHelp(cmd: string, bin: string): boolean {
  const b = escapeRe(bin);
  return (
    new RegExp(`\\b${b}\\b[^;&|\\n]*(?:--help|\\s-h\\b|\\bhelp\\b)`).test(cmd) ||
    new RegExp(`\\bman\\s+${b}\\b`).test(cmd)
  );
}

/**
 * Detect SDK usage of `pkg`. Returns, in order: the package marker `pkg` (when an
 * install/import is seen — proves the agent reached the SDK), followed by any
 * client method-call chains it then made (e.g. `client.tasks.create`). Method
 * calls are anchored to the binding the SDK was imported into so unrelated
 * `foo.bar()` calls don't count — best-effort across JS/TS and Python forms.
 */
function extractSdkUsage(cmd: string, pkg: string): string[] {
  const p = escapeRe(pkg);
  const installed =
    new RegExp(`\\b(?:pip\\s+install|pip3\\s+install|npm\\s+(?:i|install)|pnpm\\s+add|yarn\\s+add)\\b[^\\n]*\\b${p}\\b`).test(cmd);
  const out: string[] = [];

  // Collect the local bindings the SDK is imported into, so method chains can be
  // anchored to them. Covers: `import X from 'pkg'`, `const X = require('pkg')`,
  // `import {A,B} from 'pkg'`, `import pkg`/`import pkg as X`, `from pkg import A,B`.
  const bindings = new Set<string>();
  let imported = installed;
  const add = (name: string | undefined): void => {
    if (name && /^[A-Za-z_$][\w$]*$/.test(name)) bindings.add(name);
  };
  // JS/TS default + namespace import: import X from 'pkg' | import * as X from 'pkg'
  for (const m of cmd.matchAll(new RegExp(`import\\s+(?:\\*\\s+as\\s+)?([A-Za-z_$][\\w$]*)\\s+from\\s*['"]${p}['"]`, "g"))) {
    imported = true;
    add(m[1]);
  }
  // JS/TS named imports: import { A, B as C } from 'pkg'
  for (const m of cmd.matchAll(new RegExp(`import\\s*{([^}]*)}\\s*from\\s*['"]${p}['"]`, "g"))) {
    imported = true;
    for (const part of (m[1] ?? "").split(",")) add(part.split(/\s+as\s+/).pop()?.trim());
  }
  // CJS: const X = require('pkg')  |  const { A } = require('pkg')
  for (const m of cmd.matchAll(new RegExp(`(?:const|let|var)\\s+(?:{([^}]*)}|([A-Za-z_$][\\w$]*))\\s*=\\s*require\\(\\s*['"]${p}['"]`, "g"))) {
    imported = true;
    if (m[2]) add(m[2]);
    for (const part of (m[1] ?? "").split(",")) add(part.split(":").pop()?.trim());
  }
  // Python: import pkg [as X]  |  from pkg import A, B
  for (const m of cmd.matchAll(new RegExp(`\\bimport\\s+${p}(?:\\s+as\\s+([A-Za-z_$][\\w$]*))?`, "g"))) {
    imported = true;
    add(m[1] ?? pkg);
  }
  for (const m of cmd.matchAll(new RegExp(`\\bfrom\\s+${p}\\b\\s+import\\s+([^\\n]+)`, "g"))) {
    imported = true;
    for (const part of (m[1] ?? "").split(",")) add(part.split(/\s+as\s+/).pop()?.trim().replace(/[()]/g, ""));
  }
  // Variables constructed from an imported binding (`const c = new Client(`,
  // `c = Client(`, `c = Asana.Client.create(`) become bindings too, so a later
  // `c.tasks.create(` is captured. Allow a method chain in the constructor.
  for (const b of [...bindings]) {
    const bs = escapeRe(b);
    for (const m of cmd.matchAll(
      new RegExp(`(?:const|let|var)?\\s*([A-Za-z_$][\\w$]*)\\s*=\\s*(?:new\\s+)?${bs}(?:\\.[A-Za-z_$][\\w$]*)*\\s*\\(`, "g"),
    )) {
      add(m[1]);
    }
  }

  if (imported) out.push(pkg);
  // Method-call chains rooted at one of the bindings: `binding.a.b(` (≥1 hop).
  for (const b of bindings) {
    const bs = escapeRe(b);
    for (const m of cmd.matchAll(new RegExp(`\\b(${bs}(?:\\.[A-Za-z_$][\\w$]*)+)\\s*\\(`, "g"))) {
      const chain = m[1]!;
      if (chain.includes(".") && !out.includes(chain)) out.push(chain);
    }
  }
  return out;
}

/**
 * Pull literal API URLs out of curl invocations in one shell command string.
 * Returns full URLs (host kept) so API vs docs domains can be told apart.
 */
function extractCurls(cmd: string): { method: string; url: string }[] {
  const out: { method: string; url: string }[] = [];
  // Split at each `curl` token; each segment holds that invocation's args.
  for (const seg of cmd.split(/\bcurl\b/).slice(1)) {
    const urlM =
      seg.match(/--url\s+(['"])([^'"]+)\1/) ||
      seg.match(/--url\s+(\S+)/) ||
      seg.match(/(https?:\/\/[^\s'"]+)/);
    if (!urlM) continue;
    const url = (urlM[2] ?? urlM[1] ?? "").replace(/['"]+$/, "");
    if (!/^https?:\/\//.test(url)) continue;
    const mM = seg.match(new RegExp(`(?:--request|-X)\\s+(['"]?)(${HTTP_METHODS})\\1`, "i"));
    out.push({ method: (mM?.[2] ?? "GET").toUpperCase(), url });
  }
  return out;
}

/**
 * Pull code-style API calls (method + relative path) out of any command body —
 * Python `req("POST","/tasks")`, Node `fetch(BASE+"/tasks",{method:"POST"})`,
 * `requests.post(".../tasks")`, etc. Agents don't always use curl, so this
 * captures the common `METHOD` literal immediately followed by a `/path` literal.
 */
function extractCodeCalls(cmd: string): ApiCall[] {
  const out: ApiCall[] = [];
  // "POST", "/tasks"  |  'POST','/projects/{x}/sections'  |  POST "/goals"
  const re = new RegExp(
    `\\b(${HTTP_METHODS})\\b['"]?\\s*[,(]?\\s*['"](/[A-Za-z0-9_{}$./?=&%-]+)['"]`,
    "gi",
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) {
    const path = ((m[2] ?? "").split("?")[0] ?? "").replace(/\/+$/, "") || "/";
    out.push({ method: m[1]!.toUpperCase(), path, host: "" });
  }
  return out;
}

/** Base path prefix to strip from API paths (e.g. "/api/1.0"), from base_url. */
function basePrefix(baseUrl: string | undefined): { host: string; prefix: string } {
  try {
    const u = new URL(baseUrl ?? "");
    return { host: u.host, prefix: u.pathname.replace(/\/+$/, "") };
  } catch {
    return { host: "", prefix: "" };
  }
}

export interface ParseOptions {
  /** API base URL — lets curl/code calls to the API host be told from doc fetches. */
  baseUrl?: string;
  /** CLI binary (from the cli surface) to recognize vendor-CLI invocations. */
  cliBin?: string;
  /** SDK package (from the sdk surface) to recognize install/import/usage. */
  sdkPackage?: string;
  /** MCP server id/URL (from the mcp surface) to scope which tool calls count. */
  mcpServer?: string;
}

export function parseTranscriptContent(text: string, opts: ParseOptions = {}): ObservedRun {
  const { host: apiHost, prefix } = basePrefix(opts.baseUrl);
  const run: ObservedRun = {
    searches: [],
    urlsFetched: [],
    apiCalls: [],
    filesWritten: [],
    sawBearer: false,
    cliCommands: [],
    cliHelpInspected: false,
    sdkUsage: [],
    mcpToolCalls: [],
    mcpToolsListed: false,
  };

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let evt: unknown;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    const content = (evt as { message?: { content?: unknown } })?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = part as { type?: string; name?: string; input?: Record<string, unknown> };
      if (p.type !== "tool_use" || !p.input) continue;
      const input = p.input;
      if (p.name === "WebSearch" && typeof input.search_term === "string") {
        run.searches.push(input.search_term);
      } else if (p.name && FETCH_TOOLS.has(p.name) && typeof input.url === "string") {
        run.urlsFetched.push(input.url);
      } else if (p.name === "CallMcpTool") {
        // An MCP tool invocation surfaces as a CallMcpTool tool_use. Scope to the
        // product's server when one is configured; otherwise record any MCP call.
        const server = typeof input.server === "string" ? input.server : "";
        const tool =
          (typeof input.toolName === "string" && input.toolName) ||
          (typeof input.tool === "string" && input.tool) ||
          "";
        if (!opts.mcpServer || !server || server.includes(opts.mcpServer) || opts.mcpServer.includes(server)) {
          run.mcpToolCalls.push([server, tool].filter(Boolean).join(".") || "(mcp tool)");
        }
      } else if ((p.name === "ListMcpResources" || /tools?[_/]?list/i.test(p.name ?? "")) && p.name !== "Shell") {
        run.mcpToolsListed = true;
      } else if (p.name === "Shell" || p.name === "Write" || p.name === "Edit") {
        if ((p.name === "Write" || p.name === "Edit") && typeof input.path === "string") {
          run.filesWritten.push(input.path);
        }
        // Scan both shell commands and any script the agent wrote (then ran).
        const cmd =
          (typeof input.command === "string" && input.command) ||
          (typeof input.contents === "string" && input.contents) ||
          (typeof input.new_string === "string" && input.new_string) ||
          "";
        if (!cmd) continue;
        // Matches both curl headers (`authorization: Bearer`) and code/JSON
        // forms (`"Authorization":"Bearer "`).
        if (/authorization["'\s]*:["'\s]*bearer/i.test(cmd)) run.sawBearer = true;
        // Strategy A: literal curl URLs.
        for (const { method, url } of extractCurls(cmd)) {
          let host = "";
          let path = url;
          try {
            const u = new URL(url);
            host = u.host;
            path = u.pathname;
          } catch {
            /* keep raw */
          }
          if (apiHost && host === apiHost) {
            if (prefix && path.startsWith(prefix)) path = path.slice(prefix.length) || "/";
            run.apiCalls.push({ method, path: path.replace(/\/+$/, "") || "/", host });
          } else {
            // A curl to a non-API host is a doc/page fetch in disguise.
            run.urlsFetched.push(url);
          }
        }
        // Strategy B: code-style calls (python/node), method + relative path.
        run.apiCalls.push(...extractCodeCalls(cmd));
        // Surface-specific signals (only when the surface declares an identifier).
        if (opts.cliBin) {
          run.cliCommands.push(...extractCliCommands(cmd, opts.cliBin));
          if (inspectsCliHelp(cmd, opts.cliBin)) run.cliHelpInspected = true;
        }
        if (opts.sdkPackage) run.sdkUsage.push(...extractSdkUsage(cmd, opts.sdkPackage));
        // A `tools/list` may also be issued as a raw shell/JSON-RPC line.
        if (/tools\/list/i.test(cmd)) run.mcpToolsListed = true;
      }
    }
  }
  return run;
}

export function parseTranscript(path: string, opts: ParseOptions = {}): ObservedRun {
  return parseTranscriptContent(readFileSync(path, "utf8"), opts);
}

/**
 * Project an ObservedRun into the DiscoveryResult shape `scoreDiscovery` expects,
 * so discovery can be scored from objective behavior. `endpoint_used` is the
 * "create action" appropriate to the surface (the first API POST, CLI command,
 * SDK usage, or MCP tool call); auth is inferred from a Bearer header.
 */
export function observedToDiscovery(run: ObservedRun, ns?: string, surface: SurfaceId = "api"): DiscoveryResult {
  let endpoint = "";
  // Did the agent inspect this surface's authoritative self-describing source?
  let inspectedLocal = false;
  if (surface === "cli") {
    endpoint = run.cliCommands[0] ?? "";
    inspectedLocal = run.cliHelpInspected;
  } else if (surface === "sdk") {
    // Prefer a real method-call chain (contains a ".") over the bare package
    // marker, so endpoint_used reads like `client.tasks.create`, not `@scope/pkg`.
    endpoint = run.sdkUsage.find((u) => u.includes(".")) ?? run.sdkUsage[0] ?? "";
    // The package marker is pushed only when an install/import was observed.
    inspectedLocal = run.sdkUsage.length > 0;
  } else if (surface === "mcp") {
    endpoint = run.mcpToolCalls[0] ?? "";
    inspectedLocal = run.mcpToolsListed;
  } else {
    const create = run.apiCalls.find((c) => c.method === "POST") ?? run.apiCalls[0];
    endpoint = create ? `${create.method} ${create.path}` : "";
  }
  return {
    ns,
    searches: run.searches,
    urls_visited: run.urlsFetched,
    endpoint_used: endpoint,
    auth_scheme_found: run.sawBearer ? "Authorization: Bearer <token>" : "",
    inspected_local_source: inspectedLocal,
    notes: "objective: reconstructed from harness transcript (no tool results captured)",
  };
}

/** Objective per-call trace (no status — the transcript omits tool results). */
export function observedToTrace(run: ObservedRun): TraceStep[] {
  return run.apiCalls.map((c, i) => ({
    step: i + 1,
    taskId: "observed",
    action: "api call (from transcript)",
    method: c.method,
    path: c.path,
  }));
}
