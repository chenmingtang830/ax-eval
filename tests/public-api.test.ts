import { describe, expect, it } from "vitest";
import {
  BearerClient,
  INVOKE_HARNESS_IDS,
  NORMALIZED_RESULT_SCHEMA,
  SURFACE_IDS,
  TargetPackSchema,
  aggregateNormalizedResults,
  checkApproval,
  registerOracleProvider,
  verifyGeneratedPack,
} from "../src/index.js";

describe("public API", () => {
  it("exports the initial engine contracts without exposing private paths", () => {
    expect(TargetPackSchema).toBeDefined();
    expect(BearerClient).toBeTypeOf("function");
    expect(SURFACE_IDS).toEqual(["api", "cli", "sdk", "mcp"]);
    expect(INVOKE_HARNESS_IDS).toEqual(["claude-code", "codex"]);
    expect(NORMALIZED_RESULT_SCHEMA).toBe("ax.normalized-result/v1");
    expect(checkApproval).toBeTypeOf("function");
    expect(verifyGeneratedPack).toBeTypeOf("function");
    expect(registerOracleProvider).toBeTypeOf("function");
    expect(aggregateNormalizedResults).toBeTypeOf("function");
  });
});
