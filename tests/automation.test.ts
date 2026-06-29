import { describe, expect, it } from "vitest";
import { selectSmokeTasks } from "../src/automation.js";
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
