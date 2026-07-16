import { describe, expect, it } from "vitest";
import { TaskSchema, TargetPackSchema } from "../src/schemas.js";

describe("TaskSchema", () => {
  it("falls back title to id when title is omitted", () => {
    const t = TaskSchema.parse({ id: "create-task", prompt: "do it" });
    expect(t.title).toBe("create-task");
    expect(t.oracles).toEqual([]);
  });

  it("keeps an explicit title", () => {
    const t = TaskSchema.parse({ id: "x", title: "Create a task" });
    expect(t.title).toBe("Create a task");
  });

  it("a minimal pack with title-less tasks loads", () => {
    const pack = TargetPackSchema.parse({
      name: "mini",
      tasks: [{ id: "only-id", oracles: [{ type: "exists", path: "a.b" }] }],
    });
    expect(pack.tasks[0]!.title).toBe("only-id");
    expect(pack.site_url).toBe("");
  });
});

describe("MCP surface schema", () => {
  it("defaults argv and rejects opaque stdio shell commands", () => {
    const pack = TargetPackSchema.parse({
      name: "stdio",
      surfaces: { mcp: { server: "npx", transport: "stdio" } },
      tasks: [],
    });
    expect(pack.surfaces?.mcp?.args).toEqual([]);
    expect(() => TargetPackSchema.parse({
      name: "bad-stdio",
      surfaces: { mcp: { server: "npx -y @acme/mcp", transport: "stdio" } },
      tasks: [],
    })).toThrow(/single executable name/);
  });

  it("rejects argv on HTTP and OAuth app auth on stdio", () => {
    expect(() => TargetPackSchema.parse({
      name: "bad-http",
      surfaces: { mcp: { server: "https://mcp.example.test", transport: "http", args: ["--bad"] } },
      tasks: [],
    })).toThrow(/must not declare args/);
    expect(() => TargetPackSchema.parse({
      name: "bad-stdio-auth",
      surfaces: { mcp: { server: "acme-mcp", transport: "stdio", auth: { kind: "oauth_app" } } },
      tasks: [],
    })).toThrow(/inherit or token auth/);
  });
});
