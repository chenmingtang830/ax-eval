import { describe, expect, it } from "vitest";
import {
  ExecutionPolicySchema,
  executionPolicyAllows,
  executionPolicyHash,
} from "../src/index.js";

describe("execution policy", () => {
  const shared = {
    schema: "ax.execution-policy/v1" as const,
    network: "shared" as const,
    tools: ["shell", "web_search"] as const,
  };

  it("requires a canonical, explicit tool list and hashes it stably", () => {
    const parsed = ExecutionPolicySchema.parse(shared);
    expect(executionPolicyAllows(parsed, "shell")).toBe(true);
    expect(executionPolicyAllows(parsed, "mcp")).toBe(false);
    expect(executionPolicyHash(parsed)).toMatch(/^[a-f0-9]{64}$/);
    expect(() => ExecutionPolicySchema.parse({ ...shared, tools: ["web_search", "shell"] })).toThrow(/canonically sorted/);
  });

  it("does not allow a web-search tool in an offline cell", () => {
    expect(() => ExecutionPolicySchema.parse({
      schema: "ax.execution-policy/v1",
      network: "none",
      tools: ["shell", "web_search"],
    })).toThrow(/network=none cannot expose web_search/);
  });
});
