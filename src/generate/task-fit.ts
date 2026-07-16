import { isSurfaceId, SURFACE_IDS, type SurfaceId } from "../surface/types.js";
import { isEvidenceStrength, type EvidenceStrength } from "./evidence-strength.js";

const DEFAULT_ACCEPTED_EVIDENCE: readonly EvidenceStrength[] = ["direct"];

const CAPABILITY_STATUSES: readonly TaskFitCapabilityStatus[] = [
  "eligible",
  "deprecated",
  "gui-only",
  "unsupported",
  "unreviewed",
];

export type TaskFitCapabilityStatus =
  | "eligible"
  | "deprecated"
  | "gui-only"
  | "unsupported"
  | "unreviewed";

export interface TaskFitEvidence {
  strength: EvidenceStrength;
  surfaces: readonly SurfaceId[];
}

export interface TaskFitCapability {
  id: string;
  satisfies: readonly string[];
  evidence: readonly TaskFitEvidence[];
  status?: TaskFitCapabilityStatus;
}

export interface TaskFitRequirement {
  id: string;
  accepted_evidence_strengths?: readonly EvidenceStrength[];
}

export interface TaskFitPath {
  id: string;
  requirements: readonly TaskFitRequirement[];
}

export interface TaskFitDefinition {
  id: string;
  paths: readonly TaskFitPath[];
}

export interface TaskFitCandidate {
  capability_id: string;
  status: TaskFitCapabilityStatus;
  matched_requirements: string[];
  supported_surfaces: SurfaceId[];
}

export interface TaskFitResult {
  status: "sufficient" | "insufficient";
  requirement_path?: string;
  selected_surface?: SurfaceId;
  matched_requirements: string[];
  missing_requirements: string[];
  supported_surfaces: SurfaceId[];
  capability_bundle: string[];
  candidates: TaskFitCandidate[];
  reason?: string;
}

interface RequirementMatch {
  requirement: TaskFitRequirement;
  capabilityIds: string[];
}

interface PathAttempt {
  path: TaskFitPath;
  pathIndex: number;
  surface: SurfaceId;
  surfaceIndex: number;
  matches: RequirementMatch[];
  bundle: string[];
}

function assertIdentifier(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
  if (value !== value.trim()) throw new Error(`${label} must not contain surrounding whitespace`);
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`);
}

function validateDefinition(definition: TaskFitDefinition): void {
  assertIdentifier(definition.id, "task fit definition id");
  if (definition.paths.length === 0) throw new Error("task fit definition requires at least one path");
  assertUnique(definition.paths.map((path) => path.id), "task fit path ids");
  for (const path of definition.paths) {
    assertIdentifier(path.id, "task fit path id");
    if (path.requirements.length === 0) throw new Error(`task fit path ${path.id} requires at least one requirement`);
    assertUnique(path.requirements.map((requirement) => requirement.id), `task fit requirement ids in path ${path.id}`);
    for (const requirement of path.requirements) {
      assertIdentifier(requirement.id, "task fit requirement id");
      const accepted = requirement.accepted_evidence_strengths ?? DEFAULT_ACCEPTED_EVIDENCE;
      if (accepted.length === 0) throw new Error(`task fit requirement ${requirement.id} must accept at least one evidence strength`);
      assertUnique(accepted, `accepted evidence strengths for requirement ${requirement.id}`);
      if (accepted.some((strength) => !isEvidenceStrength(strength))) {
        throw new Error(`task fit requirement ${requirement.id} has an invalid evidence strength`);
      }
    }
  }
}

function validateCapabilities(capabilities: readonly TaskFitCapability[]): void {
  assertUnique(capabilities.map((capability) => capability.id), "task fit capability ids");
  for (const capability of capabilities) {
    assertIdentifier(capability.id, "task fit capability id");
    if (capability.status !== undefined && !CAPABILITY_STATUSES.includes(capability.status)) {
      throw new Error(`task fit capability ${capability.id} has an invalid status`);
    }
    assertUnique(capability.satisfies, `requirements satisfied by capability ${capability.id}`);
    for (const requirementId of capability.satisfies) assertIdentifier(requirementId, "satisfied requirement id");
    for (const evidence of capability.evidence) {
      if (!isEvidenceStrength(evidence.strength)) {
        throw new Error(`task fit capability ${capability.id} has an invalid evidence strength`);
      }
      if (evidence.surfaces.length === 0) {
        throw new Error(`task fit capability ${capability.id} evidence requires at least one surface`);
      }
      assertUnique(evidence.surfaces, `evidence surfaces for capability ${capability.id}`);
      if (evidence.surfaces.some((surface) => !isSurfaceId(surface))) {
        throw new Error(`task fit capability ${capability.id} has an invalid evidence surface`);
      }
    }
  }
}

function normalizedSurfaceScope(surfaceScope: readonly SurfaceId[] | undefined): SurfaceId[] {
  if (surfaceScope === undefined) return [...SURFACE_IDS];
  if (surfaceScope.length === 0) throw new Error("task fit surface scope requires at least one surface");
  assertUnique(surfaceScope, "task fit surface scope");
  if (surfaceScope.some((surface) => !isSurfaceId(surface))) throw new Error("task fit surface scope contains an invalid surface");
  return SURFACE_IDS.filter((surface) => surfaceScope.includes(surface));
}

function acceptedStrengths(requirement: TaskFitRequirement): readonly EvidenceStrength[] {
  return requirement.accepted_evidence_strengths ?? DEFAULT_ACCEPTED_EVIDENCE;
}

function capabilitySupports(
  capability: TaskFitCapability,
  requirement: TaskFitRequirement,
  surface: SurfaceId,
): boolean {
  if ((capability.status ?? "eligible") !== "eligible" || !capability.satisfies.includes(requirement.id)) return false;
  const accepted = acceptedStrengths(requirement);
  return capability.evidence.some((evidence) => accepted.includes(evidence.strength) && evidence.surfaces.includes(surface));
}

function chooseBundle(matches: readonly RequirementMatch[]): string[] {
  const uncovered = new Set(matches.filter((match) => match.capabilityIds.length > 0).map((match) => match.requirement.id));
  const selected: string[] = [];
  while (uncovered.size > 0) {
    const coverage = new Map<string, string[]>();
    for (const match of matches) {
      if (!uncovered.has(match.requirement.id)) continue;
      for (const capabilityId of match.capabilityIds) {
        const requirements = coverage.get(capabilityId) ?? [];
        requirements.push(match.requirement.id);
        coverage.set(capabilityId, requirements);
      }
    }
    const next = [...coverage.entries()].sort((left, right) => {
      const coverageDifference = right[1].length - left[1].length;
      return coverageDifference || left[0].localeCompare(right[0]);
    })[0];
    if (!next) break;
    selected.push(next[0]);
    for (const requirementId of next[1]) uncovered.delete(requirementId);
  }
  return selected;
}

function buildAttempts(
  definition: TaskFitDefinition,
  capabilities: readonly TaskFitCapability[],
  surfaces: readonly SurfaceId[],
): PathAttempt[] {
  return definition.paths.flatMap((path, pathIndex) => surfaces.map((surface, surfaceIndex) => {
    const matches = path.requirements.map((requirement) => ({
      requirement,
      capabilityIds: capabilities
        .filter((capability) => capabilitySupports(capability, requirement, surface))
        .map((capability) => capability.id)
        .sort(),
    }));
    return { path, pathIndex, surface, surfaceIndex, matches, bundle: chooseBundle(matches) };
  }));
}

function matchedRequirements(attempt: PathAttempt): string[] {
  return attempt.matches.filter((match) => match.capabilityIds.length > 0).map((match) => match.requirement.id);
}

function missingRequirements(attempt: PathAttempt): string[] {
  return attempt.matches.filter((match) => match.capabilityIds.length === 0).map((match) => match.requirement.id);
}

function candidateSummaries(
  definition: TaskFitDefinition,
  capabilities: readonly TaskFitCapability[],
  surfaces: readonly SurfaceId[],
): TaskFitCandidate[] {
  const requirements = definition.paths.flatMap((path) => path.requirements);
  return [...capabilities].sort((left, right) => left.id.localeCompare(right.id)).map((capability) => {
    const matched = new Set<string>();
    const supported = new Set<SurfaceId>();
    for (const requirement of requirements) {
      for (const surface of surfaces) {
        if (!capabilitySupports(capability, requirement, surface)) continue;
        matched.add(requirement.id);
        supported.add(surface);
      }
    }
    return {
      capability_id: capability.id,
      status: capability.status ?? "eligible",
      matched_requirements: [...matched].sort(),
      supported_surfaces: SURFACE_IDS.filter((surface) => supported.has(surface)),
    };
  });
}

export function evaluateTaskFit(
  definition: TaskFitDefinition,
  capabilities: readonly TaskFitCapability[],
  surfaceScope?: readonly SurfaceId[],
): TaskFitResult {
  validateDefinition(definition);
  validateCapabilities(capabilities);
  const surfaces = normalizedSurfaceScope(surfaceScope);
  const attempts = buildAttempts(definition, capabilities, surfaces);
  const candidates = candidateSummaries(definition, capabilities, surfaces);

  for (const path of definition.paths) {
    const successful = attempts.filter((attempt) => attempt.path.id === path.id && missingRequirements(attempt).length === 0);
    if (successful.length === 0) continue;
    successful.sort((left, right) => left.surfaceIndex - right.surfaceIndex);
    const selected = successful[0]!;
    return {
      status: "sufficient",
      requirement_path: path.id,
      selected_surface: selected.surface,
      matched_requirements: path.requirements.map((requirement) => requirement.id),
      missing_requirements: [],
      supported_surfaces: SURFACE_IDS.filter((surface) => successful.some((attempt) => attempt.surface === surface)),
      capability_bundle: selected.bundle,
      candidates,
    };
  }

  const closest = [...attempts].sort((left, right) => {
    const matchedDifference = matchedRequirements(right).length - matchedRequirements(left).length;
    return matchedDifference || left.pathIndex - right.pathIndex || left.surfaceIndex - right.surfaceIndex;
  })[0];
  return {
    status: "insufficient",
    requirement_path: closest?.path.id,
    selected_surface: closest?.surface,
    matched_requirements: closest ? matchedRequirements(closest) : [],
    missing_requirements: closest ? missingRequirements(closest) : [],
    supported_surfaces: [],
    capability_bundle: closest?.bundle ?? [],
    candidates,
    reason: "no requirement path is satisfied on one eligible surface",
  };
}
