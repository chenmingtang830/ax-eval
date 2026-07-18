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

  it("excludes unsupported SDK tasks from the execution and scoring denominator", () => {
    const pack = TargetPackSchema.parse({
      ...base,
      surfaces: {
        sdk: { package: "@demo/sdk", language: "node" },
      },
      tasks: [
        {
          id: "schema-control-plane",
          difficulty: "L3",
          prompt: "Create schema through the API/control plane.",
          allowed_surfaces: ["api"],
          oracles: [{ type: "roundtrip", readPathTemplate: "/schema/{gid}", assertField: "ok", expected: true }],
        },
        {
          id: "data-plane-write",
          difficulty: "L1",
          prompt: "Write one record through the SDK.",
          allowed_surfaces: ["api", "sdk"],
          oracles: [{ type: "roundtrip", readPathTemplate: "/records/{gid}", assertField: "ok", expected: true }],
        },
      ],
    });

    expect(tasksForSurface(pack, "sdk").map((task) => task.id)).toEqual(["data-plane-write"]);
    expect(tasksForSurface(pack, "api").map((task) => task.id)).toEqual(["schema-control-plane", "data-plane-write"]);
  });

  it("treats an empty allowed_surfaces list as unsupported on every execution surface", () => {
    const pack = TargetPackSchema.parse({
      ...base,
      tasks: [
        {
          id: "unsupported-task",
          difficulty: "L2",
          prompt: "This task has no supported execution surface.",
          allowed_surfaces: [],
          oracles: [{ type: "roundtrip", readPathTemplate: "/x/{gid}", assertField: "ok", expected: true }],
        },
        {
          id: "api-task",
          difficulty: "L1",
          prompt: "This task is API-supported.",
          allowed_surfaces: ["api"],
          oracles: [{ type: "roundtrip", readPathTemplate: "/y/{gid}", assertField: "ok", expected: true }],
        },
      ],
    });

    expect(tasksForSurface(pack, "api").map((task) => task.id)).toEqual(["api-task"]);
    expect(tasksForSurface(pack, "sdk")).toEqual([]);
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

  it("credential block includes endpoint context and alternate surface credential names without verifier secrets", () => {
    const p = promptFor("api", TargetPackSchema.parse({
      ...base,
      base_url: "https://${PROJECT_REF}.example.test",
      auth: { type: "bearer", env: "API_TOKEN" },
      sql_conn: { dialect: "postgres", connection_string_env: "DATABASE_URL" },
      surfaces: {
        cli: { bin: "demo", auth: { kind: "token", token_env: "CLI_TOKEN" } },
      },
    }));
    expect(p).toContain("The harness has already loaded declared .env values into the child process environment.");
    expect(p).toContain("Use process.env.API_TOKEN for the credential.");
    expect(p).toContain("non-secret endpoint/context variable(s): PROJECT_REF");
    expect(p).toContain("use these values literally when constructing hosts or URLs");
    expect(p).toContain("Other declared sandbox credential env var(s), if the docs require them for this surface: CLI_TOKEN.");
    expect(p).not.toContain("Use the leading numeric/id portion");
    expect(p).not.toContain("DATABASE_URL");
    expect(p).not.toContain("Read .env");
  });

  it("does not inject legacy Asana credentials into generic no-auth packs", () => {
    const p = promptFor("api", apiOnly);
    expect(p).toContain("No credential env var is declared by this pack");
    expect(p).not.toContain("ASANA_PAT");
    expect(p).not.toContain("ASANA_SANDBOX_PROJECT_GID");
  });

  it("keeps legacy Asana credentials only for Asana packs without declared auth", () => {
    const p = promptFor("api", TargetPackSchema.parse({
      ...base,
      name: "asana",
      discovery: { product: "Asana" },
    }));
    expect(p).toContain("Use process.env.ASANA_PAT");
    expect(p).toContain("ASANA_SANDBOX_PROJECT_GID");
  });

  it("limits URL id extraction guidance to sandbox scope vars, not endpoint context vars", () => {
    const p = promptFor("api", TargetPackSchema.parse({
      ...base,
      base_url: "https://${DATABASE_NAME}-${ORG_SLUG}.example.test",
      auth: { type: "bearer", env: "API_TOKEN" },
      sandbox_scope: [{
        name: "project",
        env: "PROJECT_ID",
        required: true,
        instructions: "existing sandbox project",
      }],
    }));
    expect(p).toContain("DATABASE_NAME, ORG_SLUG; use these values literally");
    expect(p).toContain("For sandbox scope vars only, use the leading numeric/id portion");
    expect(p).toContain("do not split endpoint/context vars such as host, org, project-ref, or database names");
  });

  it("includes non-secret MongoDB database scope when a pack declares one", () => {
    const p = promptFor("api", TargetPackSchema.parse({
      ...base,
      auth: { type: "none", env: "ATLAS_CONNECTION_STRING" },
      mongo_conn: { connection_string_env: "ATLAS_CONNECTION_STRING", database: "axarena_eval" },
    }));
    expect(p).toContain('Use MongoDB database name "axarena_eval" for MongoDB data-plane work.');
  });

  it("tells agents not to clean up unrelated sandbox resources", () => {
    const p = promptFor("api", apiOnly);
    expect(p).toContain("Do not delete, reset, overwrite, or mutate pre-existing resources that were not created in this run.");
    expect(p).toContain("If a quota or sandbox limit blocks a task, record that task as failed instead of cleaning up unrelated resources.");
  });

  it("tells agents to continue remaining tasks after one task fails", () => {
    const p = buildExecutorPrompt({
      pack: TargetPackSchema.parse({
        ...base,
        tasks: [
          {
            id: "sdk-task",
            difficulty: "L2",
            prompt: `Create one SDK task named "AX SDK {ns}".`,
            allowed_surfaces: ["sdk"],
            oracles: [{ type: "roundtrip", readPathTemplate: "/things/{gid}", assertField: "name", expected: "AX SDK {ns}" }],
          },
        ],
        surfaces: {
          sdk: { package: "@demo/sdk", language: "node" },
        },
      }),
      profile: getProfile("floor"),
      ns: "demo-floor-ab12",
      resultsPath: "results/run.json",
      tracePath: "results/run.trace.json",
      surface: getSurface("sdk"),
    });
    expect(p).toContain("Treat tasks as independent best-effort attempts");
    expect(p).toContain("continue with the remaining tasks instead of aborting the whole run");
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
    expect(p).not.toContain("credential in .env");
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
