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
  LegacyOracleProvider,
  OracleProvider,
  OracleProviderRegistry,
  OracleVerifyContext,
  VersionedOracleProvider,
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
  ProviderProvenanceSchema,
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

// Supported authoring contracts consumed by the arena workspace. Policy-heavy
// DAEB modules themselves live in arena; a few runtime-shared compatibility
// seams remain below until the following stack slices move their callers.
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
  buildCapabilityPrompt,
  extractCapabilities,
  extractCapabilitiesAll,
  normalizeSurfacesDocumented,
} from "./generate/capability-extract.js";
export type {
  Capability,
  CapabilityExtractResult,
  CapabilityOutcome,
  ExtractCapabilitiesOptions,
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
  OracleExtractResultSchema,
} from "./generate/task-extract.js";
export type {
  ExtractOraclesOptions,
  ExtractOutcome,
  OracleCheck,
  OracleExtractItem,
  OracleExtractResult,
} from "./generate/task-extract.js";
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

// Transitional compatibility seams used while DAEB runtime/publication move
// in the following stack slices. Arena is their only in-repo consumer.
export {
  assertCanonicalDaebWritePath,
  createDaebPathContext,
  daebRepositoryRoot,
  daebRoot,
  daebReadCompiledPackPath,
  daebReadExtractsDir,
  daebReadSuitePath,
  daebReadVendorSelectionLedgerPath,
  daebReadVendorsDir,
  daebVendorExtractDir,
} from "./generate/benchmark-paths.js";
export type { DaebPathContext, DaebPathInput } from "./generate/benchmark-paths.js";
export {
  loadCapabilityExtract,
  writeCapabilityExtract,
} from "./generate/capability-extract.js";
export {
  loadSurfaceExtract,
  writeSurfaceExtract,
} from "./generate/surface-extract.js";
export {
  extractOracles,
  extractOraclesAll,
  loadOracleExtract,
  writeOracleExtract,
} from "./generate/task-extract.js";
export {
  loadVendorCard,
  writeVendorCard,
} from "./generate/vendor-resolve.js";
export {
  composePack,
  writeComposedPack,
} from "./generate/compose-pack.js";
export {
  auditCapabilityInventory,
  defaultSuiteMethodology,
  coverageMatrixPath,
  failureTaxonomyPath,
  graderLedgerPath,
  loadCoverageMatrix,
  loadCapabilityInventory,
  loadSelectionLedger,
  loadSupportMatrix,
  loadTraceReview,
  methodologyPath,
  selectionLedgerPath,
  supportMatrixPath,
  traceReviewPath,
  writeConceptUniverse,
  writeCapabilityInventory,
  writeCoverageMatrix,
  writeFailureTaxonomy,
  writeGraderLedger,
  writeMethodology,
  writeSelectionLedger,
  writeSupportMatrix,
  writeTraceReview,
} from "./generate/methodology.js";
