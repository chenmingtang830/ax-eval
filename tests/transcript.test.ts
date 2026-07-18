import { describe, expect, it } from "vitest";
import { observedToDiscovery, parseTranscriptContent } from "../src/harness/transcript.js";

const BASE = "https://app.asana.com/api/1.0";

function evt(content: unknown[]): string {
  return JSON.stringify({ role: "assistant", message: { content } });
}

/** A Codex `--json` event: `{type:"item.completed", item:{...}}`. */
function codexItem(item: Record<string, unknown>): string {
  return JSON.stringify({ type: "item.completed", item });
}

describe("transcript objective capture", () => {
  it("extracts searches, curl calls, auth, and doc fetches", () => {
    const text = [
      evt([{ type: "tool_use", name: "WebSearch", input: { search_term: "asana api docs" } }]),
      evt([
        {
          type: "tool_use",
          name: "Shell",
          input: {
            command:
              "curl -s --request POST --url 'https://app.asana.com/api/1.0/tasks' " +
              "-H 'authorization: Bearer $PAT' --data '{}'",
          },
        },
      ]),
      evt([{ type: "tool_use", name: "WebFetch", input: { url: "https://developers.asana.com/docs" } }]),
    ].join("\n");

    const run = parseTranscriptContent(text, { baseUrl: BASE });
    expect(run.searches).toEqual(["asana api docs"]);
    expect(run.apiCalls).toContainEqual({ method: "POST", path: "/tasks", host: "app.asana.com" });
    expect(run.sawBearer).toBe(true);
    expect(run.urlsFetched).toContain("https://developers.asana.com/docs");
    expect(observedToDiscovery(run).endpoint_used).toBe("POST /tasks");
  });

  it("recognizes Claude Code's `Bash` shell tool (not just `Shell`)", () => {
    // Claude Code's shell tool is named `Bash`; if the parser only matched
    // `Shell`, an API/curl run's calls would be invisible and discovery
    // (canonical/auth) undercounted. Regression guard.
    const text = evt([
      {
        type: "tool_use",
        name: "Bash",
        input: { command: `curl -X POST -H "Authorization: Bearer $PAT" ${BASE}/tasks -d '{}'` },
      },
    ]);
    const run = parseTranscriptContent(text, { baseUrl: BASE });
    expect(run.apiCalls).toContainEqual({ method: "POST", path: "/tasks", host: "app.asana.com" });
    expect(run.sawBearer).toBe(true);
  });

  it("extracts code-style calls (python urllib req helper, no curl)", () => {
    const text = evt([
      {
        type: "tool_use",
        name: "Shell",
        input: {
          command:
            'python3 - <<PY\nBASE="https://app.asana.com/api/1.0"\n' +
            'h={"Authorization":"Bearer "+PAT}\n' +
            'req("GET","/users/me")\nreq("POST","/tasks", body)\n' +
            "req('POST', '/projects/{p}/sections')\nPY",
        },
      },
    ]);
    const run = parseTranscriptContent(text, { baseUrl: BASE });
    expect(run.sawBearer).toBe(true);
    const sigs = run.apiCalls.map((c) => `${c.method} ${c.path}`);
    expect(sigs).toContain("GET /users/me");
    expect(sigs).toContain("POST /tasks");
    expect(sigs).toContain("POST /projects/{p}/sections");
    expect(observedToDiscovery(run).endpoint_used).toBe("POST /tasks");
  });

  it("treats curl to a non-API host as a doc fetch, not an API call", () => {
    const text = evt([
      {
        type: "tool_use",
        name: "Shell",
        input: { command: "curl -s 'https://developers.asana.com/reference/createtask'" },
      },
    ]);
    const run = parseTranscriptContent(text, { baseUrl: BASE });
    expect(run.apiCalls).toHaveLength(0);
    expect(run.urlsFetched).toContain("https://developers.asana.com/reference/createtask");
  });
});

describe("transcript CLI-surface capture", () => {
  it("captures vendor-CLI invocations, --help discovery, and npx form", () => {
    const text = [
      evt([{ type: "tool_use", name: "Shell", input: { command: "asana --help" } }]),
      evt([{ type: "tool_use", name: "Shell", input: { command: "asana task create --name 'AX probe' && echo done" } }]),
      evt([{ type: "tool_use", name: "Shell", input: { command: "npx -y asana auth login" } }]),
    ].join("\n");
    const run = parseTranscriptContent(text, { cliBin: "asana" });
    expect(run.cliHelpInspected).toBe(true);
    expect(run.cliCommands).toContain("asana task create --name 'AX probe'");
    expect(run.cliCommands).toContain("asana auth login");
    // Surface-aware projection: endpoint_used is the first CLI command.
    expect(observedToDiscovery(run, undefined, "cli").endpoint_used).toBe("asana --help");
  });

  it("does not capture CLI commands when no bin is configured", () => {
    const text = evt([{ type: "tool_use", name: "Shell", input: { command: "asana task create" } }]);
    expect(parseTranscriptContent(text).cliCommands).toHaveLength(0);
  });
});

describe("transcript SDK-surface capture", () => {
  it("captures install + import of a scoped package (marker only when no bound call)", () => {
    const text = [
      evt([{ type: "tool_use", name: "Shell", input: { command: "npm i @linear/sdk" } }]),
      evt([
        {
          type: "tool_use",
          name: "Write",
          // `c` is never bound to the SDK import, so only the package marker counts.
          input: { path: "run.mjs", contents: 'import { LinearClient } from "@linear/sdk";\nawait c.createIssue({})' },
        },
      ]),
    ].join("\n");
    const run = parseTranscriptContent(text, { sdkPackage: "@linear/sdk" });
    expect(run.sdkUsage).toContain("@linear/sdk");
    expect(run.filesWritten).toContain("run.mjs");
    expect(observedToDiscovery(run, undefined, "sdk").endpoint_used).toBe("@linear/sdk");
  });

  it("captures the method-call chain when the client is bound to the import (JS)", () => {
    const text = evt([
      {
        type: "tool_use",
        name: "Write",
        input: {
          path: "run.mjs",
          contents:
            'import { LinearClient } from "@linear/sdk";\n' +
            'const client = new LinearClient({ apiKey: process.env.LINEAR_KEY });\n' +
            "await client.createIssue({ teamId, title });",
        },
      },
    ]);
    const run = parseTranscriptContent(text, { sdkPackage: "@linear/sdk" });
    expect(run.sdkUsage).toContain("@linear/sdk");
    expect(run.sdkUsage).toContain("client.createIssue");
    // Surface projection prefers the method chain over the bare package marker.
    expect(observedToDiscovery(run, undefined, "sdk").endpoint_used).toBe("client.createIssue");
  });

  it("captures a require() default binding + nested method chain", () => {
    const text = evt([
      {
        type: "tool_use",
        name: "Shell",
        input: {
          command:
            'node -e \'const Asana = require("asana"); const c = Asana.Client.create(); c.tasks.create({})\'',
        },
      },
    ]);
    const run = parseTranscriptContent(text, { sdkPackage: "asana" });
    expect(run.sdkUsage).toContain("asana");
    // `c` is bound from `Asana.Client.create()`, so `c.tasks.create` is captured.
    expect(run.sdkUsage).toContain("c.tasks.create");
  });

  it("captures a Python `from pkg import Client` binding + chain", () => {
    const text = evt([
      {
        type: "tool_use",
        name: "Write",
        input: {
          path: "run.py",
          contents:
            "from notion_client import Client\n" +
            "notion = Client(auth=token)\n" +
            "notion.pages.create(parent=p, properties=props)\n",
        },
      },
    ]);
    const run = parseTranscriptContent(text, { sdkPackage: "notion_client" });
    expect(run.sdkUsage).toContain("notion_client");
    expect(run.sdkUsage).toContain("notion.pages.create");
  });

  it("does not capture SDK usage when no package is configured", () => {
    const text = evt([
      { type: "tool_use", name: "Write", input: { path: "x.mjs", contents: 'import {C} from "@linear/sdk"' } },
    ]);
    expect(parseTranscriptContent(text).sdkUsage).toHaveLength(0);
  });
});

describe("transcript MCP-surface capture", () => {
  it("captures tools/list and scoped MCP tool calls", () => {
    const text = [
      evt([{ type: "tool_use", name: "ListMcpResources", input: {} }]),
      evt([
        {
          type: "tool_use",
          name: "CallMcpTool",
          input: { server: "mcp.linear.app", toolName: "create_issue", arguments: {} },
        },
      ]),
    ].join("\n");
    const run = parseTranscriptContent(text, { mcpServer: "mcp.linear.app" });
    expect(run.mcpToolsListed).toBe(true);
    expect(run.mcpToolCalls).toContain("mcp.linear.app.create_issue");
    expect(observedToDiscovery(run, undefined, "mcp").endpoint_used).toBe("mcp.linear.app.create_issue");
  });

  it("ignores MCP calls to a different server when scoped", () => {
    const text = evt([
      { type: "tool_use", name: "CallMcpTool", input: { server: "user-datadog", toolName: "search" } },
    ]);
    const run = parseTranscriptContent(text, { mcpServer: "mcp.linear.app" });
    expect(run.mcpToolCalls).toHaveLength(0);
  });

  it("recognizes Claude Code's namespaced mcp__ tool names + ToolSearch listing", () => {
    // The real shape from a `claude -p --output-format stream-json` run: MCP
    // tools are invoked by their namespaced name, and ToolSearch enumerates them.
    const text = [
      evt([{ type: "tool_use", name: "ToolSearch", input: { query: "asana create task mcp" } }]),
      evt([{ type: "tool_use", name: "mcp__claude_ai_Asana__create_tasks", input: { tasks: [] } }]),
    ].join("\n");
    const run = parseTranscriptContent(text, { mcpServer: "https://mcp.asana.com/v2/mcp" });
    expect(run.mcpToolsListed).toBe(true); // ToolSearch with an mcp query = listing
    expect(run.mcpToolCalls).toContain("mcp__claude_ai_Asana__create_tasks");
    const disc = observedToDiscovery(run, undefined, "mcp");
    expect(disc.endpoint_used).toBe("mcp__claude_ai_Asana__create_tasks");
    expect(disc.inspected_local_source).toBe(true);
  });
});

describe("transcript Codex-surface capture (codex exec --json)", () => {
  it("parses codex item.completed events: web_search → searches/urls, command_execution → API calls", () => {
    // The real shape from `codex exec --json`: events are top-level
    // {type:"item.completed", item:{type:"web_search"|"command_execution", ...}}.
    const text = [
      codexItem({ id: "ws_1", type: "web_search", query: "Asana API create task authorization" }),
      codexItem({ id: "ws_2", type: "web_search", query: "https://developers.asana.com/reference/createtask" }),
      codexItem({
        id: "cmd_1",
        type: "command_execution",
        command: `curl -X POST -H "Authorization: Bearer $ASANA_PAT" ${BASE}/tasks`,
        exit_code: 0,
        status: "completed",
      }),
    ].join("\n");
    const run = parseTranscriptContent(text, { baseUrl: BASE });
    expect(run.searches).toContain("Asana API create task authorization");
    // A URL-shaped web_search is an opened page, not a search term.
    expect(run.urlsFetched).toContain("https://developers.asana.com/reference/createtask");
    expect(run.sawBearer).toBe(true);
    expect(run.apiCalls).toContainEqual({ method: "POST", path: "/tasks", host: "app.asana.com" });
    // Projected funnel: official docs reached + canonical create call + auth found.
    const disc = observedToDiscovery(run, undefined, "api");
    expect(disc.endpoint_used).toBe("POST /tasks");
    expect(disc.searches.length).toBeGreaterThan(0);
  });

  it("records SQL wire signals for surface-honesty grading", () => {
    const text = [
      codexItem({
        type: "command_execution",
        command: "psql \"$NEON_DATABASE_URL\" -c 'SELECT 1'",
        exit_code: 0,
        status: "completed",
      }),
    ].join("\n");
    const run = parseTranscriptContent(text);
    expect(run.wireSignals).toEqual(expect.arrayContaining(["psql", "sql_env"]));
  });
});
