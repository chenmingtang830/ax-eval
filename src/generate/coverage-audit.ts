import { isDeepStrictEqual } from "node:util";
import {
  buildCoverageMatrix,
  selectCoverageConcepts,
  type ConceptUniverse,
  type CoverageMatrix,
  type CoverageSelection,
} from "./coverage.js";
import type { SuiteMethodology } from "./suite-methodology.js";

export interface CoverageAuditInput {
  universe: ConceptUniverse;
  selection: CoverageSelection;
  matrix: CoverageMatrix;
  methodology: SuiteMethodology;
}

export interface CoverageAuditFinding {
  severity: "error";
  code:
    | "coverage_family_scope_drift"
    | "coverage_selection_category_drift"
    | "coverage_selection_policy_unresolvable"
    | "coverage_selection_policy_drift"
    | "coverage_matrix_category_drift"
    | "coverage_matrix_decision_drift";
  message: string;
  concept_name?: string;
  family?: string;
}

export function auditCoverageArtifacts(input: CoverageAuditInput): CoverageAuditFinding[] {
  const { universe, selection, matrix, methodology } = input;
  const findings: CoverageAuditFinding[] = [];

  for (const cluster of universe.clusters) {
    if (!methodology.capability_families.includes(cluster.family)) {
      findings.push({
        severity: "error",
        code: "coverage_family_scope_drift",
        message: `Concept ${cluster.concept_name} uses family ${cluster.family}, which is absent from the methodology`,
        concept_name: cluster.concept_name,
        family: cluster.family,
      });
    }
  }

  if (selection.category !== universe.category) {
    findings.push({
      severity: "error",
      code: "coverage_selection_category_drift",
      message: `Coverage selection category ${selection.category} differs from universe category ${universe.category}`,
    });
  }
  try {
    const expectedSelection = selectCoverageConcepts(
      universe,
      methodology,
      () => new Date(selection.generated_at),
    );
    if (!isDeepStrictEqual(
      { ...selection, category: universe.category },
      expectedSelection,
    )) {
      findings.push({
        severity: "error",
        code: "coverage_selection_policy_drift",
        message: "Coverage selection differs from the reviewed coverage and family-diversity policy",
      });
    }
  } catch {
    findings.push({
      severity: "error",
      code: "coverage_selection_policy_unresolvable",
      message: "Coverage methodology cannot select its required task count from the persisted concept universe",
    });
  }

  if (matrix.category !== universe.category) {
    findings.push({
      severity: "error",
      code: "coverage_matrix_category_drift",
      message: `Coverage matrix category ${matrix.category} differs from universe category ${universe.category}`,
    });
  }
  const expectedMatrix = buildCoverageMatrix(universe, () => new Date(matrix.generated_at));
  if (!isDeepStrictEqual(
    { ...matrix, category: universe.category },
    expectedMatrix,
  )) {
    findings.push({
      severity: "error",
      code: "coverage_matrix_decision_drift",
      message: "Coverage matrix decisions differ from the persisted concept membership and evidence",
    });
  }

  return findings;
}
