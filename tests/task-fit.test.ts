import { describe, expect, it } from "vitest";
import { evaluateTaskFit, type TaskFitCapability, type TaskFitDefinition } from "../src/generate/task-fit.js";

const lifecycle: TaskFitDefinition = {
  id: "record-lifecycle",
  paths: [{
    id: "crud",
    requirements: [
      { id: "create" },
      { id: "update" },
      { id: "delete" },
    ],
  }],
};

function capability(
  id: string,
  satisfies: string[],
  surfaces: Array<"api" | "cli" | "sdk" | "mcp">,
  strength: "direct" | "summary_index" = "direct",
): TaskFitCapability {
  return { id, satisfies, evidence: [{ strength, surfaces }] };
}

describe("evaluateTaskFit", () => {
  it("requires every path requirement on one common surface", () => {
    const result = evaluateTaskFit(lifecycle, [
      capability("create-api", ["create"], ["api"]),
      capability("update-cli", ["update"], ["cli"]),
      capability("delete-cli", ["delete"], ["cli"]),
    ]);

    expect(result).toMatchObject({
      status: "insufficient",
      requirement_path: "crud",
      selected_surface: "cli",
      matched_requirements: ["update", "delete"],
      missing_requirements: ["create"],
      supported_surfaces: [],
    });
  });

  it("uses one compound capability for multiple requirements", () => {
    const result = evaluateTaskFit(lifecycle, [
      capability("api-crud", ["create", "update", "delete"], ["api"]),
      capability("api-create", ["create"], ["api"]),
    ]);

    expect(result.status).toBe("sufficient");
    expect(result.capability_bundle).toEqual(["api-crud"]);
  });

  it("requires direct evidence unless a requirement explicitly accepts another strength", () => {
    const summaryOnly = capability("summary", ["create"], ["api"], "summary_index");
    expect(evaluateTaskFit({ id: "create", paths: [{ id: "create", requirements: [{ id: "create" }] }] }, [summaryOnly]).status)
      .toBe("insufficient");

    const result = evaluateTaskFit({
      id: "create",
      paths: [{ id: "create", requirements: [{ id: "create", accepted_evidence_strengths: ["summary_index"] }] }],
    }, [summaryOnly]);
    expect(result.status).toBe("sufficient");
  });

  it("excludes deprecated and GUI-only candidates", () => {
    const result = evaluateTaskFit({ id: "create", paths: [{ id: "create", requirements: [{ id: "create" }] }] }, [
      { ...capability("deprecated-create", ["create"], ["api"]), status: "deprecated" },
      { ...capability("gui-create", ["create"], ["cli"]), status: "gui-only" },
    ]);

    expect(result.status).toBe("insufficient");
    expect(result.candidates).toEqual([
      { capability_id: "deprecated-create", status: "deprecated", matched_requirements: [], supported_surfaces: [] },
      { capability_id: "gui-create", status: "gui-only", matched_requirements: [], supported_surfaces: [] },
    ]);
  });

  it("uses stable path, surface, and capability tie-breaking", () => {
    const result = evaluateTaskFit({
      id: "read",
      paths: [
        { id: "preferred", requirements: [{ id: "read" }] },
        { id: "fallback", requirements: [{ id: "read" }] },
      ],
    }, [
      capability("z-read", ["read"], ["api", "cli"]),
      capability("a-read", ["read"], ["api", "cli"]),
    ], ["cli", "api"]);

    expect(result).toMatchObject({
      status: "sufficient",
      requirement_path: "preferred",
      selected_surface: "api",
      supported_surfaces: ["api", "cli"],
      capability_bundle: ["a-read"],
    });
  });

  it("honors an explicit surface scope", () => {
    const result = evaluateTaskFit({ id: "read", paths: [{ id: "read", requirements: [{ id: "read" }] }] }, [
      capability("api-read", ["read"], ["api"]),
      capability("sdk-read", ["read"], ["sdk"]),
    ], ["sdk"]);

    expect(result).toMatchObject({
      status: "sufficient",
      selected_surface: "sdk",
      supported_surfaces: ["sdk"],
      capability_bundle: ["sdk-read"],
    });
  });

  it("returns a deterministic empty-capability decision", () => {
    expect(evaluateTaskFit(lifecycle, [])).toMatchObject({
      status: "insufficient",
      requirement_path: "crud",
      selected_surface: "api",
      matched_requirements: [],
      missing_requirements: ["create", "update", "delete"],
      capability_bundle: [],
    });
  });

  it("rejects ambiguous definitions and capability inputs", () => {
    expect(() => evaluateTaskFit({
      id: "duplicate",
      paths: [{ id: "path", requirements: [{ id: "read" }, { id: "read" }] }],
    }, [])).toThrow("task fit requirement ids in path path must be unique");

    expect(() => evaluateTaskFit({ id: "read", paths: [{ id: "path", requirements: [{ id: "read" }] }] }, [
      capability("duplicate", ["read"], ["api"]),
      capability("duplicate", ["read"], ["cli"]),
    ])).toThrow("task fit capability ids must be unique");
  });
});
