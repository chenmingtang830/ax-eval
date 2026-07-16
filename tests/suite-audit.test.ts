import { describe, expect, it } from "vitest";
import { auditSuite } from "../src/generate/suite-audit.js";
import {
  createSuiteAuditSelection,
  createSuiteAuditSuite,
  suiteAuditConcepts,
} from "./fixtures/suite-authoring.js";

describe("auditSuite", () => {
  it("accepts a methodology-aligned selected suite", () => {
    expect(auditSuite({ suite: createSuiteAuditSuite(), selection: createSuiteAuditSelection() })).toEqual([]);
  });

  it("requires reviewed methodology and coverage selection artifacts", () => {
    const candidate = { ...createSuiteAuditSuite(), methodology: undefined };
    expect(auditSuite({ suite: candidate, selection: null }).map((finding) => finding.code)).toEqual([
      "methodology_missing",
      "coverage_selection_missing",
    ]);
  });

  it("flags generic naming and missing difficulty tiers", () => {
    const candidate = createSuiteAuditSuite();
    candidate.name = "SUITE";
    candidate.tasks = candidate.tasks.map((task) => ({ ...task, difficulty: "L1" }));
    expect(auditSuite({ suite: candidate, selection: createSuiteAuditSelection() }).map((finding) => finding.code)).toEqual([
      "generic_suite_name",
      "missing_difficulty",
      "missing_difficulty",
      "missing_difficulty",
    ]);
  });

  it("requires namespace-safe intent and methodology surface scope", () => {
    const candidate = createSuiteAuditSuite();
    candidate.tasks[0] = {
      ...candidate.tasks[0]!,
      intent: "Create a record.",
      allowed_surfaces: ["api"],
    };
    expect(auditSuite({ suite: candidate, selection: createSuiteAuditSelection() }).map((finding) => finding.code)).toEqual([
      "namespace_placeholder_missing",
      "task_surface_scope_drift",
    ]);
  });

  it("detects category and target disagreement across selection artifacts", () => {
    const candidateSelection = createSuiteAuditSelection(suiteAuditConcepts.slice(0, 3));
    candidateSelection.category = "search";
    expect(auditSuite({ suite: createSuiteAuditSuite(), selection: candidateSelection }).map((finding) => finding.code)).toEqual([
      "selection_category_drift",
      "selection_target_drift",
    ]);
  });

  it("detects selected concept to task mapping drift", () => {
    const candidate = createSuiteAuditSuite();
    candidate.tasks[1] = { ...candidate.tasks[1]!, title: "Changed title" };
    expect(auditSuite({ suite: candidate, selection: createSuiteAuditSelection() }))
      .toEqual([expect.objectContaining({ code: "selection_task_drift", task_id: candidate.tasks[1]!.id })]);
  });
});
