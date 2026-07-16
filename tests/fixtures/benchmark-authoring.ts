import { composePack } from "../../src/generate/compose-pack.js";
import type { TaskExtractResult } from "../../src/generate/task-extract.js";
import { createCoverageAuditArtifacts } from "./coverage-authoring.js";
import {
  packAuthoringConfig,
  packAuthoringVendor,
} from "./pack-authoring.js";
import {
  createVendorSelectionLedger,
  vendorSelectionCapabilityExtract,
  vendorSelectionSurfaceExtract,
} from "./vendor-selection.js";
import { createCompletedTraceReview } from "./suite-authoring.js";

export async function createBenchmarkAuthoringArtifacts() {
  const coverage = await createCoverageAuditArtifacts();
  const tasks: TaskExtractResult = {
    vendor: packAuthoringVendor.vendor,
    slug: packAuthoringVendor.slug,
    suite_name: coverage.suite.name,
    suite_version: coverage.suite.version,
    extracted_at: "2026-07-16T00:03:00.000Z",
    extractor: "test",
    tasks: coverage.suite.tasks.map((task, index) => ({
      id: task.id,
      title: task.title,
      difficulty: task.difficulty,
      prompt: `Complete ${task.title.toLowerCase()} for ax_{ns}.`,
      allowed_surfaces: [...task.allowed_surfaces],
      na: false,
      na_reason: null,
      support_evidence: [{
        doc_url: `https://docs.acme.example/tasks/${task.id}`,
        quote: `POST /v1/tasks/${index + 1} performs ${task.title.toLowerCase()}.`,
      }],
      oracles: [{
        type: "roundtrip",
        readMethod: "GET",
        readPathTemplate: `/tasks/${index + 1}/{gid}`,
        assertField: "name",
        expected: `ax_task_${index + 1}_{ns}`,
        description: `${task.title} result exists.`,
      }],
    })),
  };
  const pack = composePack(
    packAuthoringVendor,
    coverage.suite,
    vendorSelectionSurfaceExtract,
    tasks,
    packAuthoringConfig,
    { now: () => new Date("2026-07-16T00:04:00.000Z") },
  );
  return {
    ...coverage,
    trace_review: createCompletedTraceReview(),
    ledger: createVendorSelectionLedger(),
    capabilities: vendorSelectionCapabilityExtract,
    surfaces: vendorSelectionSurfaceExtract,
    vendor: packAuthoringVendor,
    tasks,
    config: packAuthoringConfig,
    pack,
  };
}
