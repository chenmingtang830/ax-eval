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

export { loadDotenv, loadPack } from "./config.js";
export {
  describeRequiredEnv,
  resolveEnvTemplate,
  resolveScope,
  surfaceAuthStatus,
} from "./target/config.js";
export type {
  EnvRequirement,
  EnvSource,
  SurfaceAuthStatus,
} from "./target/config.js";
export { redactSensitiveText } from "./safety/redaction.js";
export {
  approvalPath,
  checkApproval,
  checkCellApproval,
  checkCommittedLegacyCellApproval,
  packContentHash,
  packFileContentHash,
  readApproval,
  writeApproval,
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
export { observedToTrace, parseTranscriptContent } from "./harness/transcript.js";
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
  LegacyOracleProvider,
  OracleProvider,
  OracleProviderRegistry,
  OracleVerifyContext,
  VersionedOracleProvider,
} from "./generate/oracle-provider.js";
export { verifyGeneratedPack } from "./generate/verify.js";
export { loadRequiredTrace } from "./generate/verify.js";
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
  ProviderProvenanceSchema,
  SandboxProvenanceSchema,
  ReviewedPackReferenceSchema,
} from "./cell/schema.js";
export type {
  EvaluationCell,
  NormalizedCellRecord,
  ReviewedPackReference,
} from "./cell/schema.js";
export { runCell, runCellWithRuntime } from "./cell/run.js";
export type {
  CellRuntimeDependencies,
  CredentialSource,
  RunCellOptions,
} from "./cell/run.js";
export type {
  ChildProcessSandbox,
  ChildSandboxInvocation,
  ChildSandboxProvenance,
  SandboxedChildInvocation,
} from "./harness/child-sandbox.js";
export {
  createHealthCheckProviderRegistry,
  createProvisioningProviderRegistry,
  createResetProviderRegistry,
  createRuntimeExtensionRegistry,
  createTargetAdapterRegistry,
  resolveRuntimeExtensions,
} from "./runtime/extensions.js";
export type {
  HealthCheckContext,
  HealthCheckEvidence,
  HealthCheckProvider,
  HealthCheckProviderRegistry,
  ProviderIdentity,
  ProviderReference,
  ProvisioningContext,
  ProvisioningEvidence,
  ProvisioningInspection,
  ProvisioningProvider,
  ProvisioningProviderRegistry,
  ResetContext,
  ResetEvidence,
  ResetPlan,
  ResetProvider,
  ResetProviderRegistry,
  ResolvedRuntimeExtensions,
  RuntimeExtensionInput,
  RuntimeExtensionKind,
  RuntimeExtensionRegistry,
  TargetAdapter,
  TargetAdapterRegistry,
  TargetDescriptor,
} from "./runtime/extensions.js";
export type {
  BlockedReason,
  NormalizedResult,
  NormalizedResultCell,
} from "./generate/record.js";

// Generic authoring schemas, extraction, and explicit-input transforms consumed
// by arena. Canonical DAEB paths and persistence live in the arena workspace.
export {
  SuiteSchema,
  SuiteTaskSchema,
  loadSuite,
  suitePromptFragment,
  validatePackAgainstSuite,
} from "./generate/suite.js";
export type { Suite, SuiteTask } from "./generate/suite.js";
export {
  extractJsonObjectWithRepair,
  invokeGenerator,
} from "./generate/harness.js";
export type {
  Effort,
  HarnessId,
  InvokeGeneratorOptions,
  RepairJsonOptions,
} from "./generate/harness.js";
export { mapSettledLimit } from "./generate/concurrency.js";
export {
  ResolveResultSchema,
  resolveVendor,
  resolveVendors,
  slugify,
} from "./generate/vendor-resolve.js";
export type {
  ResolveResult,
  ResolveVendorOptions,
} from "./generate/vendor-resolve.js";
export {
  CapabilityExtractResultSchema,
  LegacyCapabilityExtractSchema,
  buildCapabilityPrompt,
  extractCapabilities,
  extractCapabilitiesAll,
  normalizeSurfacesDocumented,
  normalizeLegacyCapabilityExtract,
} from "./generate/capability-extract.js";
export type {
  Capability,
  CapabilityExtractResult,
  CapabilityOutcome,
  ExtractCapabilitiesOptions,
  LegacyCapabilityExtract,
} from "./generate/capability-extract.js";
export {
  SurfaceExtractResultSchema,
  auditSurfaceExtract,
  extractSurfaces,
} from "./generate/surface-extract.js";
export type {
  ExtractSurfacesOptions,
  SurfaceExtractResult,
} from "./generate/surface-extract.js";
export {
  OracleCheckSchema,
  OracleExtractItemSchema,
  OracleExtractResultSchema,
  OracleExtractSurfaceIdSchema,
  OracleSqlDialectSchema,
  OracleVendorConfigSchema,
} from "./generate/oracle-extract-schema.js";
export type {
  OracleCheck,
  OracleExtractItem,
  OracleExtractResult,
  OracleExtractSurfaceId,
  OracleVendorConfig,
} from "./generate/oracle-extract-schema.js";
export {
  BehavioralMethodologySchema,
  CANONICAL_SURFACE_SCOPE,
  CapabilityEvidenceSchema,
  CapabilityInventoryEntrySchema,
  CapabilityInventorySchema,
  ConceptUniverseSchema,
  CoverageMatrixSchema,
  ExtractionContextSchema,
  ExtractionProvenanceSchema,
  FailureTaxonomySchema,
  GraderLedgerSchema,
  SelectionLedgerSchema,
  StaticAxMethodologySchema,
  SuiteMethodologySchema,
  SupportMatrixSchema,
  TraceReviewMemoSchema,
} from "./generate/methodology.js";
export type {
  CapabilityInventory,
  CapabilityInventoryEntry,
  ConceptUniverse,
  CoverageDecision,
  CoverageMatrix,
  FailureTaxonomy,
  GraderLedger,
  SelectionLedger,
  SuiteMethodology,
  SupportMatrix,
  TraceReviewMemo,
} from "./generate/methodology.js";
export {
  fetchRegistrySurface,
  registryOpenApiUrl,
  registryToSurfaceExtract,
  registryToVendorCard,
} from "./ingest/registry.js";
export type {
  FetchRegistryOptions,
  RegistryMapOptions,
  RegistrySurface,
} from "./ingest/registry.js";
export { fetchSpecSummary } from "./ingest/spec-summary.js";
export { NS_PLACEHOLDER, newRunId } from "./generate/pack.js";
export { probeHarness } from "./harness/probe.js";
export type { HarnessProbe } from "./harness/probe.js";
export { renderGeneratedSnapshot } from "./generate/snapshot.js";
export type { GeneratedReportSnapshot } from "./generate/snapshot.js";
export { REPORT_STYLE } from "./report-style.js";

export {
  auditCapabilityInventory,
} from "./generate/methodology.js";
