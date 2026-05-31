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
