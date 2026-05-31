import { describe, expect, it } from "vitest";
import { evaluate } from "../src/oracles.js";
import type { OracleSpec, World } from "../src/schemas.js";

const spec = (o: Partial<OracleSpec> & { type: string }): OracleSpec => ({
  description: "",
  ...o,
});

describe("oracles", () => {
  it("exists passes when present and fails when missing", () => {
    const world: World = { task: { gid: "123" } };
    expect(evaluate(spec({ type: "exists", path: "task.gid" }), world).passed).toBe(true);
    expect(evaluate(spec({ type: "exists", path: "task.missing" }), world).passed).toBe(false);
  });

  it("equals compares the resolved value", () => {
    const world: World = { task: { due_on: "2026-06-05" } };
    expect(
      evaluate(spec({ type: "equals", path: "task.due_on", expected: "2026-06-05" }), world).passed,
    ).toBe(true);
    expect(
      evaluate(spec({ type: "equals", path: "task.due_on", expected: "2026-01-01" }), world).passed,
    ).toBe(false);
  });

  it("equals fails on a missing path", () => {
    expect(evaluate(spec({ type: "equals", path: "task.x", expected: 1 }), {}).passed).toBe(false);
  });

  it("contains checks array membership", () => {
    const world: World = { task: { stories: ["hello world"] } };
    expect(
      evaluate(spec({ type: "contains", path: "task.stories", value: "hello world" }), world).passed,
    ).toBe(true);
    expect(
      evaluate(spec({ type: "contains", path: "task.stories", value: "nope" }), world).passed,
    ).toBe(false);
  });

  it("unknown oracle type fails gracefully", () => {
    const res = evaluate(spec({ type: "does-not-exist", path: "x" }), { x: 1 });
    expect(res.passed).toBe(false);
    expect(res.detail).toContain("unknown");
  });
});
