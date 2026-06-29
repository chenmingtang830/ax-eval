import type { TargetPack } from "../schemas.js";

export type GenerationSurfaceId = "api" | keyof NonNullable<TargetPack["surfaces"]>;

export interface SurfaceTaskPolicy {
  /** L1-style single-resource creation coverage. */
  simpleResources?: string[];
  /** L2-style parent/child workflow coverage. Every listed resource in the task must be covered. */
  nestedResources?: string[];
  /** L3 ambiguous-goal coverage. */
  goalResources?: string[];
  /** L4 lifecycle/update coverage. */
  lifecycleResources?: string[];
  /** Curated operation-task ids supported by this surface. */
  operationTaskIds?: string[];
}

export type SurfaceTaskPolicies = Partial<Record<GenerationSurfaceId, SurfaceTaskPolicy>>;

type TaskShape = "simple" | "nested" | "goal" | "lifecycle" | "operation";

function policyKey(shape: TaskShape): keyof SurfaceTaskPolicy {
  switch (shape) {
    case "simple":
      return "simpleResources";
    case "nested":
      return "nestedResources";
    case "goal":
      return "goalResources";
    case "lifecycle":
      return "lifecycleResources";
    case "operation":
      return "operationTaskIds";
  }
}

function normalized(values: string[] | undefined): Set<string> | null {
  if (!values) return null;
  return new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean));
}

export function declaredTaskAllowedSurfaces(surfaces: TargetPack["surfaces"] | undefined): string[] {
  const allowed = ["api", "docs"];
  if (surfaces?.cli) allowed.push("cli");
  if (surfaces?.sdk) allowed.push("sdk");
  if (surfaces?.mcp) allowed.push("mcp");
  return allowed;
}

export function taskAllowedSurfacesForResources(
  declared: string[],
  policies: SurfaceTaskPolicies | undefined,
  shape: Exclude<TaskShape, "operation">,
  resources: string[],
): string[] {
  const normalizedResources = resources.map((resource) => resource.trim().toLowerCase()).filter(Boolean);
  if (normalizedResources.length === 0 || !policies) return declared;
  return declared.filter((surface) => {
    const policy = policies[surface as GenerationSurfaceId];
    if (!policy) return true;
    const supported = normalized(policy[policyKey(shape)]);
    if (!supported) return true;
    return normalizedResources.every((resource) => supported.has(resource));
  });
}

export function taskAllowedSurfacesForOperation(
  declared: string[],
  policies: SurfaceTaskPolicies | undefined,
  taskId: string,
): string[] {
  if (!policies) return declared;
  const normalizedTaskId = taskId.trim().toLowerCase();
  return declared.filter((surface) => {
    const policy = policies[surface as GenerationSurfaceId];
    if (!policy) return true;
    const supported = normalized(policy.operationTaskIds);
    if (!supported) return true;
    return supported.has(normalizedTaskId);
  });
}
