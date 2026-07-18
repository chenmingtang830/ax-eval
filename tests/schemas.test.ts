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
  it("requires stdio commands to separate executable and argv", () => {
    expect(() => TargetPackSchema.parse({
      name: "unsafe-stdio",
      surfaces: { mcp: { server: "npx -y @demo/mcp", transport: "stdio" } },
      tasks: [],
    })).toThrow(/single executable name/);
    expect(() => TargetPackSchema.parse({
      name: "safe-stdio",
      surfaces: { mcp: { server: "npx", transport: "stdio", args: ["-y", "@demo/mcp"] } },
      tasks: [],
    })).not.toThrow();
  });

  it("restricts inherited HTTP MCP auth to bearer or no-auth APIs", () => {
    expect(() => TargetPackSchema.parse({
      name: "api-key-http-mcp",
      auth: { type: "api-key", env: "API_KEY", header: "x-api-key" },
      surfaces: { mcp: { server: "https://mcp.example.test", transport: "http", auth: { kind: "inherit" } } },
      tasks: [],
    })).toThrow(/requires top-level bearer or none auth/);
  });
});
