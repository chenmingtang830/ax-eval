import { describe, expect, it } from "vitest";
import { auditCoverageArtifacts } from "../src/generate/coverage-audit.js";
import { createCoverageAuditArtifacts } from "./fixtures/coverage-authoring.js";

describe("auditCoverageArtifacts", () => {
  it("accepts artifacts derived from one reviewed universe and methodology", async () => {
    const input = await createCoverageAuditArtifacts();
    input.selection.selected[0] = {
      rationale: input.selection.selected[0]!.rationale,
      vendor_coverage: input.selection.selected[0]!.vendor_coverage,
      family: input.selection.selected[0]!.family,
      skill: input.selection.selected[0]!.skill,
      title: input.selection.selected[0]!.title,
      concept_name: input.selection.selected[0]!.concept_name,
    };
    expect(auditCoverageArtifacts(input)).toEqual([]);
  });

  it("detects persisted selection policy drift", async () => {
    const input = await createCoverageAuditArtifacts();
    input.selection.selected[0] = { ...input.selection.selected[0]!, title: "Changed title" };
    expect(auditCoverageArtifacts(input)).toEqual([
      expect.objectContaining({ code: "coverage_selection_policy_drift" }),
    ]);
  });

  it("detects persisted matrix decision drift", async () => {
    const input = await createCoverageAuditArtifacts();
    input.matrix.decisions = input.matrix.decisions.slice(1);
    expect(auditCoverageArtifacts(input)).toEqual([
      expect.objectContaining({ code: "coverage_matrix_decision_drift" }),
    ]);
  });

  it("reports category drift without duplicating it as content drift", async () => {
    const input = await createCoverageAuditArtifacts();
    input.selection.category = "search";
    input.matrix.category = "search";
    expect(auditCoverageArtifacts(input).map((finding) => finding.code)).toEqual([
      "coverage_selection_category_drift",
      "coverage_matrix_category_drift",
    ]);
  });

  it("fails closed when methodology and universe no longer compose", async () => {
    const input = await createCoverageAuditArtifacts();
    const firstCluster = input.universe.clusters[0]!;
    input.methodology = {
      ...input.methodology,
      capability_families: input.methodology.capability_families.filter((family) => family !== firstCluster.family),
      target_task_count: 3,
    };
    expect(auditCoverageArtifacts(input)).toEqual([
      expect.objectContaining({
        code: "coverage_family_scope_drift",
        concept_name: firstCluster.concept_name,
        family: firstCluster.family,
      }),
      expect.objectContaining({ code: "coverage_selection_policy_unresolvable" }),
    ]);
  });
});
