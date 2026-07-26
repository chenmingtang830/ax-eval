export {
  AuthSchema,
  DiscoverySpecSchema,
  GeneratorProvenanceSchema,
  McpSurfaceSchema,
  OracleSpecSchema,
  ScopeParamSchema,
  SdkSurfaceSchema,
  StaticScopeSchema,
  SurfaceAuthSchema,
  SurfaceConfigSchema,
  TargetPackSchema,
  TaskSchema,
  TraceConstraintSchema,
} from "./schemas.js";
export type {
  Auth,
  DiscoverySpec,
  GeneratorProvenance,
  McpSurface,
  OracleResult,
  OracleSpec,
  RunResult,
  ScopeParam,
  SdkSurface,
  StaticScope,
  SurfaceAuth,
  SurfaceConfig,
  TargetPack,
  Task,
  TraceConstraint,
} from "./schemas.js";

export { loadPack } from "./config.js";
export {
  approvalPath,
  checkApproval,
  checkCellApproval,
  packContentHash,
  packFileContentHash,
  readApproval,
} from "./generate/review.js";
export type { Approval } from "./generate/review.js";

export {
  SURFACE_IDS,
  isSurfaceId,
  taskExecutionSurfaces,
  taskSupportsSurface,
  tasksForSurface,
} from "./surface/types.js";
export type { SurfaceId } from "./surface/types.js";

export {
  INVOKE_HARNESS_IDS,
  isInvokeHarnessId,
} from "./harness/invoke.js";
export type { InvokeHarnessId } from "./harness/invoke.js";
export type { TraceStep } from "./harness/executor.js";
export type { ObservedRun } from "./harness/transcript.js";

export {
  BearerClient,
  HttpApiError,
} from "./http/client.js";
export type {
  ApiStyle,
  AuthScheme,
  BearerClientOptions,
} from "./http/client.js";

export type { DiscoveryResult } from "./generate/discovery.js";
export type { ProfileRun } from "./generate/report.js";

export {
  createOracleProviderRegistry,
  registerOracleProvider,
} from "./generate/oracle-provider.js";
export type {
  OracleProvider,
  OracleProviderRegistry,
  OracleVerifyContext,
} from "./generate/oracle-provider.js";
export { verifyGeneratedPack } from "./generate/verify.js";
export type {
  ExecutorResults,
  RoundtripOutcome,
  VerifyGeneratedPackOptions,
} from "./generate/verify.js";

export {
  NORMALIZED_RESULT_SCHEMA,
  aggregateNormalizedResults,
  buildBlockedResult,
  buildNormalizedResult,
  buildNormalizedResultCells,
  classifyTrialStabilityAt3,
  resultCellKey,
} from "./generate/record.js";

export {
  EVALUATION_CELL_SCHEMA,
  NORMALIZED_CELL_RECORD_SCHEMA,
  EvaluationCellSchema,
  NormalizedCellRecordSchema,
  ReviewedPackReferenceSchema,
} from "./cell/schema.js";
export type {
  EvaluationCell,
  NormalizedCellRecord,
  ReviewedPackReference,
} from "./cell/schema.js";
export { runCell } from "./cell/run.js";
export type {
  CredentialSource,
  RunCellOptions,
} from "./cell/run.js";
export type {
  BlockedReason,
  NormalizedResult,
  NormalizedResultCell,
} from "./generate/record.js";
