import { describe, expect, it } from "vitest";
import {
  BearerClient,
  EVALUATION_CELL_SCHEMA,
  EvaluationCellSchema,
  INVOKE_HARNESS_IDS,
  NORMALIZED_CELL_RECORD_SCHEMA,
  NORMALIZED_RESULT_SCHEMA,
  SURFACE_IDS,
  TargetPackSchema,
  aggregateNormalizedResults,
  checkApproval,
  checkCellApproval,
  checkCommittedLegacyCellApproval,
  createOracleProviderRegistry,
  createRuntimeExtensionRegistry,
  registerOracleProvider,
  renderGeneratedSnapshot,
  loadRequiredTrace,
  runCell,
  runCellWithRuntime,
  verifyGeneratedPack,
} from "../src/index.js";

describe("public API", () => {
  it("exports the initial engine contracts without exposing private paths", () => {
    expect(BearerClient).toBeTypeOf("function");
    expect(TargetPackSchema).toBeDefined();
    expect(BearerClient).toBeTypeOf("function");
    expect(SURFACE_IDS).toEqual(["api", "cli", "sdk", "mcp"]);
    expect(INVOKE_HARNESS_IDS).toEqual(["claude-code", "codex"]);
    expect(NORMALIZED_RESULT_SCHEMA).toBe("ax.normalized-result/v1");
    expect(EVALUATION_CELL_SCHEMA).toBe("ax.evaluation-cell/v1");
    expect(NORMALIZED_CELL_RECORD_SCHEMA).toBe("ax.normalized-cell-record/v1");
    expect(EvaluationCellSchema).toBeDefined();
    expect(checkApproval).toBeTypeOf("function");
    expect(checkCellApproval).toBeTypeOf("function");
    expect(checkCommittedLegacyCellApproval).toBeTypeOf("function");
    expect(verifyGeneratedPack).toBeTypeOf("function");
    expect(createOracleProviderRegistry).toBeTypeOf("function");
    expect(createRuntimeExtensionRegistry).toBeTypeOf("function");
    expect(registerOracleProvider).toBeTypeOf("function");
    expect(aggregateNormalizedResults).toBeTypeOf("function");
    expect(renderGeneratedSnapshot).toBeTypeOf("function");
    expect(loadRequiredTrace).toBeTypeOf("function");
    expect(runCell).toBeTypeOf("function");
    expect(runCellWithRuntime).toBeTypeOf("function");
  });
});
