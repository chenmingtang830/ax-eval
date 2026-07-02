import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { automationGeneratedAt, discoverAutomationTarget, selectSmokeTasks } from "../src/automation.js";
import type { TargetPack } from "../src/schemas.js";

const pack: TargetPack = {
  name: "demo",
  version: "0",
  standard_set_version: "gen-test",
  generated_by: "deterministic@no-model",
  auth_method: "pat",
  base_url: "https://api.example.test",
  site_url: "https://docs.example.test",
  docs_urls: [],
  tasks: [
    {
      id: "gen-l1-docs",
      title: "L1 docs",
      prompt: "Create a doc.",
      difficulty: "L1",
      allowed_surfaces: ["api", "docs"],
      create_path: "/docs",
      depends_on: [],
      trace: [],
      oracles: [{ type: "roundtrip", readPathTemplate: "/docs/{gid}", assertField: "name", expected: "x" }],
    },
    {
      id: "gen-l2-docs-pages",
      title: "L2 page",
      prompt: "Create a page under a doc.",
      difficulty: "L2",
      allowed_surfaces: ["api", "docs"],
      create_path: "/docs/{docId}/pages",
      depends_on: ["docs"],
      trace: [],
      oracles: [{ type: "roundtrip", readPathTemplate: "/docs/{docId}/pages/{gid}", assertField: "name", expected: "x" }],
    },
    {
      id: "gen-l3-docs-goal",
      title: "L3 goal",
      prompt: "Figure out what to create.",
      difficulty: "L3",
      allowed_surfaces: ["api", "docs"],
      create_path: "/docs",
      depends_on: [],
      trace: [],
      oracles: [{ type: "roundtrip", readPathTemplate: "/docs/{gid}", assertField: "name", expected: "x" }],
    },
    {
      id: "gen-l4-docs-lifecycle",
      title: "L4 lifecycle",
      prompt: "Create then rename a doc.",
      difficulty: "L4",
      allowed_surfaces: ["api", "docs"],
      create_path: "/docs",
      depends_on: [],
      trace: [],
      oracles: [{ type: "roundtrip", readPathTemplate: "/docs/{gid}", assertField: "name", expected: "x" }],
    },
    {
      id: "gen-l4-pages-lifecycle",
      title: "L4 nested lifecycle",
      prompt: "Create then rename a page under a doc.",
      difficulty: "L4",
      allowed_surfaces: ["api", "docs"],
      create_path: "/docs/{docId}/pages",
      depends_on: ["docs"],
      trace: [],
      oracles: [{ type: "roundtrip", readPathTemplate: "/docs/{docId}/pages/{gid}", assertField: "name", expected: "x" }],
    },
    {
      id: "gen-l4-export",
      title: "L4 export",
      prompt: "Start an export job.",
      difficulty: "L4",
      allowed_surfaces: ["api", "docs"],
      create_path: "/docs/{docId}/pages/{pageId}/export",
      depends_on: ["docs"],
      trace: [{ type: "required_call", method: "POST", path: "/docs/{docId}/pages/{pageId}/export", description: "start export" }],
      oracles: [{ type: "roundtrip", readPathTemplate: "/docs/{docId}/pages/{pageId}/export/{gid}", assertField: "status", expected: "complete" }],
    },
  ],
};

describe("selectSmokeTasks", () => {
  it("keeps a stable cross-difficulty smoke subset and skips brittle async tasks", () => {
    const selected = selectSmokeTasks(pack);
    expect(selected.tasks.map((t) => t.id)).toEqual([
      "gen-l1-docs",
      "gen-l2-docs-pages",
      "gen-l3-docs-goal",
      "gen-l4-docs-lifecycle",
    ]);
    expect(selected.skipped).toEqual(
      expect.arrayContaining([
        { taskId: "gen-l4-pages-lifecycle", reason: "nested lifecycle tasks are too brittle for the initial smoke gate" },
        { taskId: "gen-l4-export", reason: "async/export-style flow is poor smoke-gate material" },
      ]),
    );
  });
});

describe("discoverAutomationTarget", () => {
  const dirs: string[] = [];
  const originalPath = process.env.PATH;

  function freshDir(): string {
    const dir = mkdtempSync(resolve(tmpdir(), "ax-auto-discovery-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    process.env.PATH = originalPath;
    delete process.env.AX_EVAL_AUTOMATION_NOW;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("unwraps claude-style result envelopes during discovery", async () => {
    const dir = freshDir();
    const binDir = resolve(dir, "bin");
    const docsPath = resolve(dir, "docs.html");
    const specPath = resolve(dir, "openapi.json");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(docsPath, "<html>widget docs</html>");
    writeFileSync(specPath, JSON.stringify({ openapi: "3.0.0", paths: {} }));
    writeFileSync(resolve(binDir, "claude"), `#!/usr/bin/env node
console.log(JSON.stringify({
  type: "result",
  session_id: "session-1",
  result: JSON.stringify({
    site_url: ${JSON.stringify(docsPath)},
    docs_urls: [${JSON.stringify(docsPath)}],
    openapi_url: ${JSON.stringify(specPath)},
    auth_notes: ["Bring an API key"],
    surface_notes: ["API only"]
  })
}));
`);
    chmodSync(resolve(binDir, "claude"), 0o755);
    process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;

    const discovery = await discoverAutomationTarget(
      { company: "Widget", harness: "claude-code" },
      { mode: "fixture" },
    );

    expect(discovery.site_url).toBe(docsPath);
    expect(discovery.docs_urls).toEqual([docsPath]);
    expect(discovery.openapi_url).toBe(specPath);
    expect(discovery.confidence).toBe("high");
  });

  it("times out a hung discovery harness and falls back to guesses", async () => {
    const dir = freshDir();
    const binDir = resolve(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(resolve(binDir, "claude"), `#!/usr/bin/env node
setTimeout(() => {
  console.log("too late");
}, 1000);
`);
    chmodSync(resolve(binDir, "claude"), 0o755);
    process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;

    const discovery = await discoverAutomationTarget(
      { company: "Widget", harness: "claude-code" },
      { mode: "fixture", timeoutMs: 50 },
    );

    expect(discovery.source).toBe("guesses");
    expect(discovery.confidence).toBe("low");
  });

  it("can freeze the manifest timestamp for deterministic tests", () => {
    process.env.AX_EVAL_AUTOMATION_NOW = "2026-06-29T00:00:00.000Z";
    expect(automationGeneratedAt()).toBe("2026-06-29T00:00:00.000Z");
  });
});
