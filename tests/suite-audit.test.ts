import { describe, expect, it } from "vitest";
import type { CoverageSelection } from "../src/generate/coverage.js";
import { defaultSuiteMethodology } from "../src/generate/suite-methodology.js";
import { auditSuite } from "../src/generate/suite-audit.js";
import type { Suite } from "../src/generate/suite.js";

const concepts = [
  { concept_name: "create-record", title: "Create a record", family: "writes", difficulty: "L1" as const },
  { concept_name: "query-records", title: "Query records", family: "reads", difficulty: "L2" as const },
  { concept_name: "access-control", title: "Configure access", family: "access-control", difficulty: "L3" as const },
  { concept_name: "backup-restore", title: "Restore data", family: "recovery", difficulty: "L4" as const },
];

function selection(selected = concepts): CoverageSelection {
  return {
    category: "database",
    generated_at: "2026-07-16T00:00:00.000Z",
    target_task_count: selected.length,
    selected: selected.map((concept) => ({
      concept_name: concept.concept_name,
      title: concept.title,
      family: concept.family,
      vendor_coverage: 1,
      rationale: "Meets reviewed coverage policy.",
    })),
    excluded: [],
  };
}

function suite(): Suite {
  const methodology = defaultSuiteMethodology("database", concepts.length);
  return {
    name: "database-eval",
    version: 1,
    category: "database",
    methodology,
    tasks: concepts.map((concept, index) => ({
      id: `db-T${String(index + 1).padStart(2, "0")}-${concept.concept_name}`,
      title: concept.title,
      difficulty: concept.difficulty,
      skill: concept.family,
      intent: `Complete ${concept.title.toLowerCase()} for ax_{ns}.`,
      oracle_hint: "Read live state back independently.",
      allowed_surfaces: [...methodology.surface_scope],
      na_examples: [],
    })),
  };
}

describe("auditSuite", () => {
  it("accepts a methodology-aligned selected suite", () => {
    expect(auditSuite({ suite: suite(), selection: selection() })).toEqual([]);
  });

  it("requires reviewed methodology and coverage selection artifacts", () => {
    const candidate = { ...suite(), methodology: undefined };
    expect(auditSuite({ suite: candidate, selection: null }).map((finding) => finding.code)).toEqual([
      "methodology_missing",
      "coverage_selection_missing",
    ]);
  });

  it("flags generic naming and missing difficulty tiers", () => {
    const candidate = suite();
    candidate.name = "SUITE";
    candidate.tasks = candidate.tasks.map((task) => ({ ...task, difficulty: "L1" }));
    expect(auditSuite({ suite: candidate, selection: selection() }).map((finding) => finding.code)).toEqual([
      "generic_suite_name",
      "missing_difficulty",
      "missing_difficulty",
      "missing_difficulty",
    ]);
  });

  it("requires namespace-safe intent and methodology surface scope", () => {
    const candidate = suite();
    candidate.tasks[0] = {
      ...candidate.tasks[0]!,
      intent: "Create a record.",
      allowed_surfaces: ["api"],
    };
    expect(auditSuite({ suite: candidate, selection: selection() }).map((finding) => finding.code)).toEqual([
      "namespace_placeholder_missing",
      "task_surface_scope_drift",
    ]);
  });

  it("detects category and target disagreement across selection artifacts", () => {
    const candidateSelection = selection(concepts.slice(0, 3));
    candidateSelection.category = "search";
    expect(auditSuite({ suite: suite(), selection: candidateSelection }).map((finding) => finding.code)).toEqual([
      "selection_category_drift",
      "selection_target_drift",
    ]);
  });

  it("detects selected concept to task mapping drift", () => {
    const candidate = suite();
    candidate.tasks[1] = { ...candidate.tasks[1]!, title: "Changed title" };
    expect(auditSuite({ suite: candidate, selection: selection() }))
      .toEqual([expect.objectContaining({ code: "selection_task_drift", task_id: candidate.tasks[1]!.id })]);
  });
});
