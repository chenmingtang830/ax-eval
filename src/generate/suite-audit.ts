import type { CoverageSelection } from "./coverage.js";
import { missingDifficultyLevels, type DifficultyLevel } from "./difficulty.js";
import type { Suite } from "./suite.js";

export interface SuiteAuditInput {
  suite: Suite;
  selection: CoverageSelection | null;
}

export interface SuiteAuditFinding {
  severity: "error" | "warn";
  code:
    | "methodology_missing"
    | "coverage_selection_missing"
    | "generic_suite_name"
    | "missing_difficulty"
    | "namespace_placeholder_missing"
    | "task_surface_scope_drift"
    | "selection_category_drift"
    | "selection_target_drift"
    | "selection_task_drift";
  message: string;
  task_id?: string;
  concept_name?: string;
  difficulty?: DifficultyLevel;
}

function normalizedSurfaces(values: readonly string[]): string[] {
  return [...values].sort();
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function selectionTaskFindings(suite: Suite, selection: CoverageSelection): SuiteAuditFinding[] {
  const findings: SuiteAuditFinding[] = [];
  for (const [index, concept] of selection.selected.entries()) {
    const task = suite.tasks[index];
    if (!task) continue;
    const matches = task.title === concept.title
      && task.skill === concept.family
      && task.id.endsWith(`-${concept.concept_name}`);
    if (!matches) {
      findings.push({
        severity: "error",
        code: "selection_task_drift",
        message: `Suite task ${task.id} does not match selected concept ${concept.concept_name}`,
        task_id: task.id,
        concept_name: concept.concept_name,
      });
    }
  }
  return findings;
}

export function auditSuite(input: SuiteAuditInput): SuiteAuditFinding[] {
  const findings: SuiteAuditFinding[] = [];
  const { suite, selection } = input;
  if (!suite.methodology) {
    findings.push({
      severity: "error",
      code: "methodology_missing",
      message: "Canonical suite is missing its reviewed methodology",
    });
  }
  if (!selection) {
    findings.push({
      severity: "error",
      code: "coverage_selection_missing",
      message: "Canonical suite is missing its reviewed coverage selection",
    });
  }
  if (/^suite$/i.test(suite.name)) {
    findings.push({
      severity: "error",
      code: "generic_suite_name",
      message: "Canonical suite name must identify the benchmark rather than use a generic placeholder",
    });
  }
  if (suite.tasks.length >= 4) {
    for (const difficulty of missingDifficultyLevels(suite.tasks)) {
      findings.push({
        severity: "warn",
        code: "missing_difficulty",
        message: `Canonical suite has no selected task at difficulty ${difficulty}`,
        difficulty,
      });
    }
  }
  const expectedSurfaces = suite.methodology
    ? normalizedSurfaces(suite.methodology.surface_scope)
    : null;
  for (const task of suite.tasks) {
    if (!task.intent.includes("{ns}")) {
      findings.push({
        severity: "error",
        code: "namespace_placeholder_missing",
        message: `Suite task ${task.id} intent is missing the required {ns} placeholder`,
        task_id: task.id,
      });
    }
    if (expectedSurfaces && !arraysEqual(normalizedSurfaces(task.allowed_surfaces), expectedSurfaces)) {
      findings.push({
        severity: "error",
        code: "task_surface_scope_drift",
        message: `Suite task ${task.id} surfaces differ from the methodology surface scope`,
        task_id: task.id,
      });
    }
  }
  if (!selection) return findings;
  if (selection.category !== suite.category) {
    findings.push({
      severity: "error",
      code: "selection_category_drift",
      message: `Coverage selection category ${selection.category} differs from suite category ${suite.category}`,
    });
  }
  const expectedTarget = suite.methodology?.target_task_count ?? suite.tasks.length;
  if (selection.target_task_count !== expectedTarget || selection.selected.length !== suite.tasks.length) {
    findings.push({
      severity: "error",
      code: "selection_target_drift",
      message: "Coverage selection target or selected concept count differs from the canonical suite",
    });
  }
  findings.push(...selectionTaskFindings(suite, selection));
  return findings;
}
