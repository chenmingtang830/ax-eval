import { describe, expect, it } from "vitest";
import { observedToDiscovery, parseTranscriptContent } from "../src/harness/transcript.js";

const BASE = "https://app.asana.com/api/1.0";

function evt(content: unknown[]): string {
  return JSON.stringify({ role: "assistant", message: { content } });
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
});
