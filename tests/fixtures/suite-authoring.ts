import type { CoverageSelection } from "../../src/generate/coverage.js";
import { defaultSuiteMethodology } from "../../src/generate/suite-methodology.js";
import type { Suite } from "../../src/generate/suite.js";

export const suiteAuditConcepts = [
  { concept_name: "create-record", title: "Create a record", family: "writes", difficulty: "L1" as const },
  { concept_name: "query-records", title: "Query records", family: "reads", difficulty: "L2" as const },
  { concept_name: "access-control", title: "Configure access", family: "access-control", difficulty: "L3" as const },
  { concept_name: "backup-restore", title: "Restore data", family: "recovery", difficulty: "L4" as const },
];

export function createSuiteAuditSelection(
  selected: readonly (typeof suiteAuditConcepts)[number][] = suiteAuditConcepts,
): CoverageSelection {
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

export function createSuiteAuditSuite(): Suite {
  const methodology = defaultSuiteMethodology("database", suiteAuditConcepts.length);
  return {
    name: "database-eval",
    version: 1,
    category: "database",
    methodology,
    tasks: suiteAuditConcepts.map((concept, index) => ({
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
