import { isAbsolute, posix } from "node:path";
import { isSurfaceId, type SurfaceId } from "../surface/types.js";
import { assertArtifactSegment } from "./artifact-path.js";

export const PUBLICATION_MANIFEST_SCHEMA = "ax.publication-manifest/v1" as const;

export interface PublicationArtifactInput {
  id: string;
  path?: string;
  required: boolean;
}

export interface PublicationVendorExpectation {
  vendor: string;
  surfaces: SurfaceId[];
}

export interface PublicationCellInput {
  vendor: string;
  surface: SurfaceId;
  harness: string;
  profiles: string[];
  trial_count: number;
  aggregate_record: string;
}

export interface PublicationQualityGate {
  id: "required-artifacts" | "expected-matrix" | "required-profiles" | "required-trials";
  status: "pass" | "fail";
  detail: string;
}

export interface PublicationManifest {
  schema: typeof PUBLICATION_MANIFEST_SCHEMA;
  benchmark: string;
  category: string;
  suite_version: number;
  generated_at: string;
  publication_readiness: "publication_ready" | "draft";
  expected_matrix: {
    vendors: PublicationVendorExpectation[];
    harnesses: string[];
    required_profiles: string[];
    required_trial_count: number;
    expected_cells: number;
  };
  artifacts: Array<PublicationArtifactInput & { path?: string }>;
  cells: PublicationCellInput[];
  quality_gates: PublicationQualityGate[];
  missing_required_artifacts: string[];
}

function uniqueSegments(values: readonly string[], label: string): string[] {
  const validated = values.map((value) => assertArtifactSegment(value, label));
  if (new Set(validated).size !== validated.length) throw new Error(`${label} values must be unique`);
  return validated;
}

function portableRelativePath(path: string, label: string): string {
  if (isAbsolute(path) || path.includes("\\")) throw new Error(`${label} must be a portable relative path`);
  const normalized = posix.normalize(path);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized !== path) {
    throw new Error(`${label} must be a portable relative path`);
  }
  return normalized;
}

function cellKey(cell: Pick<PublicationCellInput, "vendor" | "surface" | "harness">): string {
  return `${cell.vendor}/${cell.surface}/${cell.harness}`;
}

export function buildPublicationManifest(options: {
  benchmark: string;
  category: string;
  suiteVersion: number;
  vendors: readonly PublicationVendorExpectation[];
  harnesses: readonly string[];
  requiredProfiles: readonly string[];
  requiredTrialCount: number;
  artifacts: readonly PublicationArtifactInput[];
  cells: readonly PublicationCellInput[];
  now?: () => Date;
}): PublicationManifest {
  if (!options.benchmark.trim()) throw new Error("benchmark must not be empty");
  if (!options.category.trim()) throw new Error("category must not be empty");
  if (!Number.isInteger(options.suiteVersion) || options.suiteVersion < 1) {
    throw new Error("suite version must be a positive integer");
  }
  if (!Number.isInteger(options.requiredTrialCount) || options.requiredTrialCount < 1) {
    throw new Error("required trial count must be a positive integer");
  }
  if (options.vendors.length === 0) throw new Error("at least one publication vendor is required");
  const harnesses = uniqueSegments(options.harnesses, "harness");
  const requiredProfiles = uniqueSegments(options.requiredProfiles, "profile");
  if (harnesses.length === 0) throw new Error("at least one harness is required");

  const vendorNames = uniqueSegments(options.vendors.map((vendor) => vendor.vendor), "vendor slug");
  const vendors = options.vendors.map((vendor, index) => {
    if (vendor.surfaces.length === 0) throw new Error(`vendor ${vendor.vendor} must declare at least one surface`);
    if (vendor.surfaces.some((surface) => !isSurfaceId(surface))) {
      throw new Error(`vendor ${vendor.vendor} declares an invalid surface`);
    }
    if (new Set(vendor.surfaces).size !== vendor.surfaces.length) {
      throw new Error(`vendor ${vendor.vendor} surfaces must be unique`);
    }
    return { vendor: vendorNames[index]!, surfaces: [...vendor.surfaces] };
  });
  const expectedKeys = new Set(
    vendors.flatMap((vendor) => vendor.surfaces.flatMap((surface) =>
      harnesses.map((harness) => cellKey({ vendor: vendor.vendor, surface, harness })),
    )),
  );

  const artifactIds = uniqueSegments(options.artifacts.map((artifact) => artifact.id), "artifact id");
  const artifacts = options.artifacts.map((artifact, index) => ({
    id: artifactIds[index]!,
    required: artifact.required,
    ...(artifact.path ? { path: portableRelativePath(artifact.path, `artifact ${artifact.id} path`) } : {}),
  }));
  const missingRequiredArtifacts = artifacts
    .filter((artifact) => artifact.required && !artifact.path)
    .map((artifact) => artifact.id);

  const seenCells = new Set<string>();
  const cells = options.cells.map((cell) => {
    const vendor = assertArtifactSegment(cell.vendor, "vendor slug");
    const harness = assertArtifactSegment(cell.harness, "harness");
    if (!isSurfaceId(cell.surface)) throw new Error(`publication cell declares an invalid surface`);
    const key = cellKey({ vendor, surface: cell.surface, harness });
    if (!expectedKeys.has(key)) throw new Error(`publication cell ${key} is not in the expected matrix`);
    if (seenCells.has(key)) throw new Error(`publication cell ${key} appears more than once`);
    seenCells.add(key);
    if (!Number.isInteger(cell.trial_count) || cell.trial_count < 1) {
      throw new Error(`publication cell ${key} has an invalid trial count`);
    }
    return {
      vendor,
      surface: cell.surface,
      harness,
      profiles: uniqueSegments(cell.profiles, `profile for ${key}`),
      trial_count: cell.trial_count,
      aggregate_record: portableRelativePath(cell.aggregate_record, `aggregate record for ${key}`),
    };
  }).sort((left, right) => cellKey(left).localeCompare(cellKey(right)));

  const missingCells = [...expectedKeys].filter((key) => !seenCells.has(key)).sort();
  const cellsMissingProfiles = cells
    .filter((cell) => requiredProfiles.some((profile) => !cell.profiles.includes(profile)))
    .map(cellKey);
  const cellsMissingTrials = cells
    .filter((cell) => cell.trial_count < options.requiredTrialCount)
    .map(cellKey);
  const qualityGates: PublicationQualityGate[] = [
    {
      id: "required-artifacts",
      status: missingRequiredArtifacts.length === 0 ? "pass" : "fail",
      detail: missingRequiredArtifacts.length === 0
        ? "All required publication artifacts are present."
        : `Missing required artifacts: ${missingRequiredArtifacts.join(", ")}.`,
    },
    {
      id: "expected-matrix",
      status: missingCells.length === 0 ? "pass" : "fail",
      detail: missingCells.length === 0
        ? `All ${expectedKeys.size} expected cells are present.`
        : `Missing expected cells: ${missingCells.join(", ")}.`,
    },
    {
      id: "required-profiles",
      status: cellsMissingProfiles.length === 0 && missingCells.length === 0 ? "pass" : "fail",
      detail: cellsMissingProfiles.length === 0 && missingCells.length === 0
        ? "Every expected cell includes all required profiles."
        : `Cells missing required profile coverage: ${[...missingCells, ...cellsMissingProfiles].join(", ")}.`,
    },
    {
      id: "required-trials",
      status: cellsMissingTrials.length === 0 && missingCells.length === 0 ? "pass" : "fail",
      detail: cellsMissingTrials.length === 0 && missingCells.length === 0
        ? `Every expected cell has at least ${options.requiredTrialCount} trials.`
        : `Cells below the required trial count: ${[...missingCells, ...cellsMissingTrials].join(", ")}.`,
    },
  ];

  return {
    schema: PUBLICATION_MANIFEST_SCHEMA,
    benchmark: options.benchmark,
    category: options.category,
    suite_version: options.suiteVersion,
    generated_at: (options.now ?? (() => new Date()))().toISOString(),
    publication_readiness: qualityGates.every((gate) => gate.status === "pass") ? "publication_ready" : "draft",
    expected_matrix: {
      vendors,
      harnesses,
      required_profiles: requiredProfiles,
      required_trial_count: options.requiredTrialCount,
      expected_cells: expectedKeys.size,
    },
    artifacts,
    cells,
    quality_gates: qualityGates,
    missing_required_artifacts: missingRequiredArtifacts,
  };
}
