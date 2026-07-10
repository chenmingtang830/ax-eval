import type { CapabilityExtractResult } from "./capability-extract.js";

type Capability = CapabilityExtractResult["capabilities"][number];
type Surface = "api" | "sdk" | "cli";

interface Requirement {
  id: string;
  patterns: RegExp[];
  exclude?: RegExp[];
  evidencePatterns?: RegExp[];
  excludeEvidence?: RegExp[];
  excludeSupportTypes?: Capability["support_type"][];
}

interface RequirementPath {
  id: string;
  requirements: Requirement[];
}

interface TaskFitDefinition {
  conceptName: string;
  paths: RequirementPath[];
}

export interface TaskFitCandidate {
  capability_name: string;
  matched_requirements: string[];
  fit_score: number;
  surfaces_documented: Surface[];
  surface_notes: string[];
  evidence: Capability["evidence"];
}

export interface DatabaseTaskFitResult {
  status: "sufficient" | "insufficient";
  requirement_path?: string;
  matched_requirements: string[];
  missing_requirements: string[];
  supported_surfaces: Surface[];
  capability_bundle: string[];
  candidates: TaskFitCandidate[];
  reason?: string;
}

const r = (
  id: string,
  patterns: RegExp[],
  exclude: RegExp[] = [],
  evidencePatterns: RegExp[] = [],
  excludeEvidence: RegExp[] = [],
  excludeSupportTypes: Capability["support_type"][] = [],
): Requirement => ({
  id,
  patterns,
  exclude,
  evidencePatterns,
  excludeEvidence,
  excludeSupportTypes,
});

const DATABASE_TASK_FIT_DEFINITIONS: TaskFitDefinition[] = [
  {
    conceptName: "access-control",
    paths: [{
      id: "data-access-control",
      requirements: [r("data-access-control", [
        /\brow-level-security\b/,
        /\brow-level-access-control\b/,
        /\bfine-grained-access-control\b/,
        /\bfine-grained-permissions\b/,
        /\bscoped-auth-tokens\b/,
        /\bip-access-list\b/,
        /\bnetwork-access-(?:allow-rules|restriction)\b/,
        /\bip-allowlisting-and-private-networking\b/,
        /\bfunction-level-auth-checks\b/,
      ], [/\bcustom-roles\b/, /\bteam\b/, /\bidentity-scoped-access-tokens\b/], [], [/\bnot supported yet\b/])],
    }],
  },
  {
    conceptName: "backup-and-restore",
    paths: [{
      id: "artifact",
      requirements: [r("artifact", [
        /\bbackup\b/,
        /\brestore\b/,
        /\bpoint-in-time\b/,
        /\bsnapshot\b/,
        /\bexport\b/,
      ], [/\bblackout\b/], [], [], ["managed-surface"])],
    }],
  },
  {
    conceptName: "change-data-capture",
    paths: [{
      id: "database-change-feed",
      requirements: [r("database-change-feed", [
        /\bchange-data-capture\b/,
        /\blogical-replication\b/,
        /\bchange-streams?\b/,
        /\brealtime-postgres-changes\b/,
        /\brealtime-change-feeds?\b/,
        /\bmanaged-cdc-pipeline\b/,
        /\bchange-listen-endpoint\b/,
        /\breactive-query-subscriptions\b/,
      ], [/\bbroadcast\b/, /\bpresence\b/, /\bread-replicas?\b/])],
    }],
  },
  {
    conceptName: "evolve-schema",
    paths: [{
      id: "in-place-schema-change",
      requirements: [r("in-place-schema-change", [
        /\bschema-migration\b/,
        /\bschema-evolution\b/,
        /\balter-table\b/,
        /\bonline-data-migrations\b/,
        /\btracked-migration-files\b/,
        /\bfile-based-migrations\b/,
        /\bad-hoc-migration-execution\b/,
        /\bschema-alteration\b/,
        /\bmigration-execution-api\b/,
        /\bschema-validation\b/,
      ], [/\bschema-diff\b/, /\brelational-schema-migration\b/, /\bintrospection\b/])],
    }],
  },
  {
    conceptName: "query-records",
    paths: [{
      id: "filtered-read",
      requirements: [r("filtered-read", [
        /\bfiltered\b/,
        /\bdata-api-rest\b/,
        /\brest-data-api-crud\b/,
        /\bfiltered-document-queries\b/,
        /\bgraphql-query\b/,
        /\bjsonb-path-query\b/,
        /\bsql-table-and-row-operations\b/,
        /\bbaseline-sql-table-and-row-operations\b/,
        /\bstandard-postgres-tool-connectivity\b/,
        /\bpostgres-protocol-compatibility\b/,
      ], [/\btime-travel\b/, /\bhistorical\b/])],
    }],
  },
  {
    conceptName: "vector-search",
    paths: [{
      id: "similarity-search",
      requirements: [r("similarity-search", [
        /\bvector-search\b/,
        /\bvector-storage-and-similarity-search\b/,
        /\bvector-search-pgvector\b/,
        /\bpgvector\b/,
        /\bnearest-neighbou?rs?\b/,
        /\bsimilarity-search\b/,
      ], [/\bindex-management\b/, /\blist(?:ing)?\b/])],
    }],
  },
  {
    conceptName: "write-records",
    paths: [{
      id: "record-lifecycle",
      requirements: [
        r("create-record", [/\b(?:row|document)-insert\b/, /\brow-insert-update-delete\b/, /\bbulk-import\b/, /\brest-data-api-crud\b/, /\bcrud\b/, /\bsql-table-and-row-operations\b/]),
        r("update-record", [/\b(?:row|document)-(?:update|patch-update|replace|upsert)\b/, /\brow-insert-update-delete\b/, /\bupsert\b/, /\brest-data-api-crud\b/, /\bcrud\b/, /\bsql-table-and-row-operations\b/]),
        r("delete-record", [/\b(?:row|document)-delete\b/, /\brow-insert-update-delete\b/, /\brest-data-api-crud\b/, /\bcrud\b/, /\bsql-table-and-row-operations\b/]),
      ],
    }],
  },
  {
    conceptName: "data-integrity-and-transactions",
    paths: [
      {
        id: "constraint",
        requirements: [r("duplicate-rejection", [
          /\bprimary-key-constraint\b/,
          /\bunique-(?:index-)?constraints?\b/,
          /\bunique-constraint\b/,
          /\bintegrity-constraints\b/,
          /\bcolumn-level-constraints\b/,
          /\bintegrity-controls\b/,
          /\bschema-validation\b/,
          /\bupsert-conflict-resolution\b/,
          /\brow-upsert\b/,
          /\bbaseline-sql-table-and-row-operations\b/,
        ], [], [
          /\bunique(?:ness)?\b/,
          /\bduplicate\b/,
          /\bconstraint violations?\b/,
          /\bon conflict\b/,
        ], [/\brecommended\b/])],
      },
      {
        id: "atomic-check-and-write",
        requirements: [
          r("atomic-write", [/\btransactional-writes\b/, /\bconcurrent-write-transactions\b/]),
          r("conflict-query", [/\bfiltered-document-queries\b/, /\bfiltered-query\b/, /\bquery-by-index\b/]),
        ],
      },
    ],
  },
  {
    conceptName: "full-text-search",
    paths: [{
      id: "full-text-query",
      requirements: [r("full-text-query", [
        /\bfull-text-search\b/,
        /\bfull-text\b/,
        /\btsvector\b/,
        /\bbm25\b/,
        /\btext-search\b/,
      ], [/\bdeprecated\b/])],
    }],
  },
  {
    conceptName: "inspect-schema",
    paths: [{
      id: "schema-metadata",
      requirements: [r("schema-metadata", [
        /\bschema-introspection\b/,
        /\bcollection-introspection\b/,
        /\bget-table-schema\b/,
        /\bdatabase-object-introspection\b/,
        /\bsystem-table-introspection\b/,
        /\blist-tables\b/,
        /\bschema-diff-and-introspection\b/,
      ])],
    }],
  },
];

const DEFINITIONS_BY_CONCEPT = new Map(
  DATABASE_TASK_FIT_DEFINITIONS.map((definition) => [definition.conceptName, definition]),
);

function identity(capability: Capability): string {
  return `${capability.capability_name} ${capability.title}`.toLowerCase();
}

function matchScore(capability: Capability, requirement: Requirement): number {
  const haystack = identity(capability);
  if (requirement.excludeSupportTypes?.includes(capability.support_type)) return 0;
  if (requirement.exclude?.some((pattern) => pattern.test(haystack))) return 0;
  if (requirement.excludeEvidence?.length && capability.evidence.some((item) => {
    const evidenceText = `${item.quote} ${item.note ?? ""}`.toLowerCase();
    return requirement.excludeEvidence!.some((pattern) => pattern.test(evidenceText));
  })) return 0;
  const capabilityName = capability.capability_name.toLowerCase();
  const nameHit = requirement.patterns.some((pattern) => pattern.test(capabilityName));
  const identityHit = requirement.patterns.some((pattern) => pattern.test(haystack));
  if (!identityHit) return 0;
  if (requirement.evidencePatterns?.length) {
    const qualifyingEvidence = capability.evidence.filter((item) => {
      const evidenceText = `${item.quote} ${item.note ?? ""}`.toLowerCase();
      return requirement.evidencePatterns!.some((pattern) => pattern.test(evidenceText))
        && !requirement.excludeEvidence?.some((pattern) => pattern.test(evidenceText));
    });
    if (!qualifyingEvidence.length) return 0;
  }
  const directEvidence = capability.evidence.some((item) => item.strength === "direct") ? 2 : 0;
  return (nameHit ? 20 : 10) + directEvidence;
}

function effectiveSurfaces(capability: Capability): { surfaces: Surface[]; notes: string[] } {
  const surfaces = [...capability.surfaces_documented];
  const notes: string[] = [];
  const evidenceText = capability.evidence
    .map((item) => `${item.doc_url} ${item.quote}`)
    .join(" ")
    .toLowerCase();
  if (
    surfaces.includes("cli")
    && /mongodb\.com\/docs\/compass|mongodb compass|schema tab/.test(evidenceText)
    && !/\bmongosh\b|command[- ]line|atlas cli/.test(evidenceText)
  ) {
    surfaces.splice(surfaces.indexOf("cli"), 1);
    notes.push("Removed CLI attribution: cited evidence is MongoDB Compass GUI, not a command-line surface.");
  }
  return { surfaces, notes };
}

function candidateFor(
  capability: Capability,
  requirements: Requirement[],
): TaskFitCandidate | null {
  const scores = requirements
    .map((requirement) => ({ id: requirement.id, score: matchScore(capability, requirement) }))
    .filter((match) => match.score > 0);
  if (!scores.length) return null;
  const surfaceEvidence = effectiveSurfaces(capability);
  return {
    capability_name: capability.capability_name,
    matched_requirements: scores.map((match) => match.id),
    fit_score: scores.reduce((sum, match) => sum + match.score, 0),
    surfaces_documented: surfaceEvidence.surfaces,
    surface_notes: surfaceEvidence.notes,
    evidence: capability.evidence,
  };
}

function evaluatePath(
  path: RequirementPath,
  capabilities: Capability[],
  surfaceScope: Surface[],
): Omit<DatabaseTaskFitResult, "candidates"> {
  const candidates = capabilities
    .map((capability) => candidateFor(capability, path.requirements))
    .filter((candidate): candidate is TaskFitCandidate => candidate !== null)
    .sort((a, b) => b.fit_score - a.fit_score || a.capability_name.localeCompare(b.capability_name));
  const supportedSurfaces = surfaceScope.filter((surface) =>
    path.requirements.every((requirement) =>
      candidates.some((candidate) =>
        candidate.matched_requirements.includes(requirement.id)
        && candidate.surfaces_documented.includes(surface)
      )
    )
  );
  const selectedSurface = supportedSurfaces[0];
  const bundle = selectedSurface
    ? path.requirements.reduce<string[]>((selected, requirement) => {
      const candidate = candidates.find((item) =>
        item.matched_requirements.includes(requirement.id)
        && item.surfaces_documented.includes(selectedSurface)
      );
      if (candidate && !selected.includes(candidate.capability_name)) selected.push(candidate.capability_name);
      return selected;
    }, [])
    : [];
  const matched = path.requirements
    .filter((requirement) => candidates.some((candidate) => candidate.matched_requirements.includes(requirement.id)))
    .map((requirement) => requirement.id);
  const missing = path.requirements
    .filter((requirement) => !matched.includes(requirement.id))
    .map((requirement) => requirement.id);
  return {
    status: supportedSurfaces.length ? "sufficient" : "insufficient",
    requirement_path: path.id,
    matched_requirements: matched,
    missing_requirements: missing,
    supported_surfaces: supportedSurfaces,
    capability_bundle: bundle,
    reason: supportedSurfaces.length
      ? undefined
      : missing.length
        ? `missing task requirements: ${missing.join(", ")}`
        : `requirements are documented, but not together on benchmark surfaces ${surfaceScope.join("/")}`,
  };
}

export function hasDatabaseTaskFitDefinition(conceptName: string): boolean {
  return DEFINITIONS_BY_CONCEPT.has(conceptName);
}

export function evaluateDatabaseTaskFit(
  conceptName: string,
  capabilities: Capability[],
  surfaceScope: Surface[] = ["api", "cli"],
): DatabaseTaskFitResult | null {
  const definition = DEFINITIONS_BY_CONCEPT.get(conceptName);
  if (!definition) return null;
  const allRequirements = definition.paths.flatMap((path) => path.requirements);
  const candidates = capabilities
    .map((capability) => candidateFor(capability, allRequirements))
    .filter((candidate): candidate is TaskFitCandidate => candidate !== null)
    .sort((a, b) => b.fit_score - a.fit_score || a.capability_name.localeCompare(b.capability_name));
  const paths = definition.paths
    .map((path) => evaluatePath(path, capabilities, surfaceScope))
    .sort((a, b) =>
      Number(b.status === "sufficient") - Number(a.status === "sufficient")
      || b.supported_surfaces.length - a.supported_surfaces.length
      || b.matched_requirements.length - a.matched_requirements.length
    );
  const best = paths[0]!;
  return { ...best, candidates };
}
