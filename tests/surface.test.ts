import { describe, expect, it } from "vitest";
import {
  availableSurfaces,
  getSurface,
  resolveSurfaceSelection,
  tasksForSurface,
} from "../src/surface/index.js";
import { buildExecutorPrompt } from "../src/harness/executor.js";
import { getProfile } from "../src/harness/profile.js";
import { TargetPackSchema } from "../src/schemas.js";

const base = {
  name: "demo",
  run_id: "2026-06-06-demo",
  base_url: "https://api.demo.test",
  discovery: { product: "Demo" },
  tasks: [
    {
      id: "l1-thing",
      difficulty: "L1",
      prompt: `Create a thing named "AX probe {ns}".`,
      allowed_surfaces: ["api"],
      oracles: [{ type: "roundtrip", readPathTemplate: "/things/{gid}", assertField: "name", expected: "AX probe {ns}" }],
    },
  ],
};

const apiOnly = TargetPackSchema.parse(base);

const multi = TargetPackSchema.parse({
  ...base,
  tasks: [
    ...base.tasks,
    {
      id: "l2-mcp-only",
      difficulty: "L2",
      prompt: `Create an MCP-only thing named "AX probe MCP {ns}".`,
      allowed_surfaces: ["mcp", "docs"],
      oracles: [{ type: "roundtrip", readPathTemplate: "/things/{gid}", assertField: "name", expected: "AX probe MCP {ns}" }],
    },
  ],
  surfaces: {
    cli: { bin: "demo", install: "npm i -g @demo/cli" },
    sdk: { package: "@demo/sdk", language: "node" },
    mcp: { server: "npx", args: ["-y", "@demo/mcp"], transport: "stdio" },
  },
});

function promptFor(surfaceId: string, pack = multi): string {
  return buildExecutorPrompt({
    pack,
    profile: getProfile("floor"),
    ns: "demo-floor-ab12",
    resultsPath: "results/run.json",
    tracePath: "results/run.trace.json",
    surface: getSurface(surfaceId),
  });
}

describe("surface registry", () => {
  it("api is always available; declared surfaces are added", () => {
    expect(availableSurfaces(apiOnly)).toEqual(["api"]);
    expect(availableSurfaces(multi)).toEqual(["api", "cli", "sdk", "mcp"]);
  });

  it("getSurface throws on an unknown id", () => {
    expect(() => getSurface("ftp")).toThrow(/unknown surface/);
  });

  it("resolveSurfaceSelection expands 'all' and validates a single id", () => {
    expect(resolveSurfaceSelection(multi, "all")).toEqual(["api", "cli", "sdk", "mcp"]);
    expect(resolveSurfaceSelection(multi, "cli")).toEqual(["cli"]);
    // cli isn't declared on the api-only pack → rejected.
    expect(() => resolveSurfaceSelection(apiOnly, "cli")).toThrow(/not declared/);
    // api is always selectable.
    expect(resolveSurfaceSelection(apiOnly, "api")).toEqual(["api"]);
  });

  it("can narrow a task bank to the selected execution surface", () => {
    expect(tasksForSurface(multi, "api").map((t) => t.id)).toEqual(["l1-thing"]);
    expect(tasksForSurface(multi, "mcp").map((t) => t.id)).toEqual(["l2-mcp-only"]);
  });
});

describe("surface-parameterized executor prompt", () => {
  it("api surface is unchanged (web discovery + curl + tags surface)", () => {
    const p = promptFor("api", apiOnly);
    expect(p).toContain("the demo API");
    expect(p).toMatch(/Use WEB SEARCH/);
    expect(p).toContain("Use curl or a small script.");
    expect(p).toContain('"surface": "api"');
    expect(p).toMatch(/~40 API actions/);
  });

  it("cli surface drives the binary, inspects --help, and installs", () => {
    const p = promptFor("cli");
    expect(p).toContain("SURFACE: CLI");
    expect(p).toContain("npm i -g @demo/cli");
    expect(p).toContain("`demo --help`");
    expect(p).toContain("Use the `demo` CLI");
    expect(p).toContain('"surface": "cli"');
    expect(p).not.toContain("Use curl or a small script.");
  });

  it("sdk surface installs + calls the package", () => {
    const p = promptFor("sdk");
    expect(p).toContain("SURFACE: SDK");
    expect(p).toContain("@demo/sdk");
    expect(p).toContain("Install and call the `@demo/sdk` SDK");
    expect(p).toContain('"surface": "sdk"');
  });

  it("mcp surface lists tools and uses the server", () => {
    const p = promptFor("mcp");
    expect(p).toContain("SURFACE: MCP");
    expect(p).toContain("tools/list");
    expect(p).toContain("Call the MCP server's tools");
    expect(p).toContain('"surface": "mcp"');
    expect(p).toContain("l2-mcp-only");
    expect(p).not.toContain("l1-thing");
  });

  it("never leaks {ns} for any surface", () => {
    for (const s of ["api", "cli", "sdk", "mcp"]) {
      expect(promptFor(s)).not.toContain("{ns}");
    }
  });
});
