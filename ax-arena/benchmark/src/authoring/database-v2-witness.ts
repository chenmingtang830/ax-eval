import type { TargetPack, SurfaceId } from "ax-eval";

export const DAEB_V2_SCHEMA = "ax.daeb-v2-witness-plan/v1" as const;
export const DAEB_V2_SUPPORT_SCHEMA = "ax.daeb-v2-support-matrix/v1" as const;

export type WitnessDisposition = "blocked" | "needs_witness" | "passed";
export type WitnessSurface = "api" | "cli";
export type V2WitnessMode = "all" | "cli-only";

/** One independently inspectable phase of a deterministic witness. */
export interface V2WitnessStageEvidence {
  status: "passed";
  command: string;
  artifact: string;
}

/**
 * Evidence required before a tuple may be promoted from inconclusive to
 * supported. Hashes bind the proof to the source pack and the actually loaded
 * bundle, while each phase makes cleanup and read-back auditable.
 */
export interface V2WitnessProof {
  setup: V2WitnessStageEvidence;
  mutation: V2WitnessStageEvidence;
  verify: V2WitnessStageEvidence;
  cleanup: V2WitnessStageEvidence;
  source_sha256: string;
  bundle_sha256: string;
}

export interface V2SurfaceContract {
  id: string;
  vendor: string;
  surface: WitnessSurface;
  endpoint_class: string;
  agent_credentials: string[];
  setup_mode: "sql_wire" | "http_admin" | "sql_http" | "not_applicable";
  verifier_mode: "independent_sql" | "same_http_surface" | "same_sql_http" | "not_applicable";
  cleanup_mode: "namespaced_sql" | "provider_reset" | "not_applicable";
  notes: string[];
}

export interface V2WitnessEntry {
  vendor: string;
  task_id: string;
  surface: WitnessSurface;
  contract_id: string;
  disposition: WitnessDisposition;
  reason: string;
  evidence: string[];
  proof?: V2WitnessProof;
}

export interface V2WitnessPlan {
  schema: typeof DAEB_V2_SCHEMA;
  benchmark: "axarena-database";
  version: 2;
  source_version: "daeb-1-v1";
  generated_at: string;
  status: "draft";
  mode: V2WitnessMode;
  task_source_status: "v1-intent+official-cli-doc-refresh+target-capability-exclusions";
  excluded_vendors: string[];
  contracts: V2SurfaceContract[];
  entries: V2WitnessEntry[];
}

export interface V2SupportMatrixEntry {
  vendor: string;
  task_id: string;
  surface: WitnessSurface;
  status: "unsupported" | "inconclusive" | "supported";
  source_concept: string;
  reason: string;
  witness_required: boolean;
}

export interface V2SupportMatrix {
  schema: typeof DAEB_V2_SUPPORT_SCHEMA;
  benchmark: "DAEB-2";
  category: "database";
  generated_at: string;
  mode: V2WitnessMode;
  task_source_status: "v1-intent+official-cli-doc-refresh+target-capability-exclusions";
  excluded_vendors: string[];
  entries: V2SupportMatrixEntry[];
}

export interface V2PackSnapshot {
  vendor: string;
  pack: Pick<TargetPack, "base_url" | "auth" | "sql_conn" | "tasks" | "surfaces">;
}

const CONTRACTS: Record<string, Omit<V2SurfaceContract, "id" | "vendor">> = {
  "cockroachdb/cli": {
    surface: "cli",
    endpoint_class: "cockroach-sql-wire",
    agent_credentials: ["COCKROACH_CONNECTION_STRING"],
    setup_mode: "sql_wire",
    verifier_mode: "independent_sql",
    cleanup_mode: "namespaced_sql",
    notes: ["Requires an admin-capable disposable SQL user or admitted reset provider."],
  },
  "insforge/api": {
    surface: "api",
    endpoint_class: "insforge-admin-rest",
    agent_credentials: ["INSFORGE_API_KEY"],
    setup_mode: "http_admin",
    verifier_mode: "independent_sql",
    cleanup_mode: "provider_reset",
    notes: ["Must witness hosted table/schema endpoint shapes before row operations."],
  },
  "insforge/cli": {
    surface: "cli",
    endpoint_class: "postgres-sql-wire",
    agent_credentials: ["INSFORGE_CONNECTION_STRING"],
    setup_mode: "sql_wire",
    verifier_mode: "independent_sql",
    cleanup_mode: "namespaced_sql",
    notes: ["The v1 CLI adapter is psql against the disposable InsForge PostgreSQL data plane; management REST/API calls remain out of scope."],
  },
  "neon/api": {
    surface: "api",
    endpoint_class: "neon-management-rest",
    agent_credentials: ["NEON_API_KEY"],
    setup_mode: "not_applicable",
    verifier_mode: "not_applicable",
    cleanup_mode: "provider_reset",
    notes: ["A future Neon Data API contract must use a distinct endpoint and auth contract."],
  },
  "neon/cli": {
    surface: "cli",
    endpoint_class: "postgres-sql-wire",
    agent_credentials: ["NEON_DATABASE_URL"],
    setup_mode: "sql_wire",
    verifier_mode: "independent_sql",
    cleanup_mode: "namespaced_sql",
    notes: ["Management API credentials and SQL connection credentials are separate."],
  },
  "nile/cli": {
    surface: "cli",
    endpoint_class: "postgres-sql-wire",
    agent_credentials: ["NILE_DATABASE_URL"],
    setup_mode: "sql_wire",
    verifier_mode: "independent_sql",
    cleanup_mode: "namespaced_sql",
    notes: ["Preflight must prove NILE_DB matches the disposable database in the URL."],
  },
  "supabase/api": {
    surface: "api",
    endpoint_class: "supabase-postgrest-data-api",
    agent_credentials: ["SUPABASE_API_KEY"],
    setup_mode: "http_admin",
    verifier_mode: "independent_sql",
    cleanup_mode: "provider_reset",
    notes: ["PostgREST is not a general DDL, role, or policy provisioning surface."],
  },
  "supabase/cli": {
    surface: "cli",
    endpoint_class: "postgres-sql-wire",
    agent_credentials: ["SUPABASE_DB_URL"],
    setup_mode: "sql_wire",
    verifier_mode: "independent_sql",
    cleanup_mode: "namespaced_sql",
    notes: ["Control-plane PAT and project API key are not substitutes for DB URL."],
  },
  "turso/api": {
    surface: "api",
    endpoint_class: "turso-sql-over-http",
    agent_credentials: ["TURSO_DATABASE_AUTH_TOKEN"],
    setup_mode: "sql_http",
    verifier_mode: "same_sql_http",
    cleanup_mode: "namespaced_sql",
    notes: ["Organization-level token minting is not assumed for ordinary task cells."],
  },
  "turso/cli": {
    surface: "cli",
    endpoint_class: "turso-cli-and-sql-over-http",
    agent_credentials: ["TURSO_ORG_API_TOKEN", "TURSO_DATABASE_AUTH_TOKEN"],
    setup_mode: "sql_http",
    verifier_mode: "same_sql_http",
    cleanup_mode: "namespaced_sql",
    notes: ["T01 is excluded from the CLI-only candidate set until denied-token capability is separately witnessed."],
  },
};

const RECONSIDERED_TUPLES = [
  {
    vendor: "turso",
    task_id: "db-T03-inspect-schema",
    surface: "api" as const,
    reason: "v1 omitted this API tuple even though Turso SQL-over-HTTP can execute the schema oracle; require a fresh witness before admission",
  },
] as const;

// The July v1 extract treated InsForge schema inspection as API-only. The
// current official CLI documents `db tables` and `db query`, so this tuple is
// admitted into the CLI-only authoring candidate set pending an executable
// witness. This is an audit correction, not a claim that the task is already
// supported.
const CLI_RECONSIDERED_TUPLES = [
  {
    vendor: "insforge",
    task_id: "db-T03-inspect-schema",
    surface: "cli" as const,
    reason: "fresh official InsForge CLI docs now document db tables/db query schema inspection; v1 omitted this CLI tuple",
  },
] as const;

// This tuple is documented by Turso's current FTS reference, but the admitted
// remote sandbox exposes only SQLite FTS5: its CLI rejects `CREATE INDEX ...
// USING fts` and has no `fts_match` function. Keep unsupported CLI work out of
// the runnable denominator until the target is provisioned with the required
// experimental index_method capability.
const CLI_EXCLUDED_TUPLES = [
  {
    vendor: "turso",
    task_id: "db-T07-full-text-search",
    reason: "Turso sandbox CLI lacks the experimental index_method/fts_match capability required by the documented task",
  },
] as const;

function contractFor(vendor: string, surface: WitnessSurface): V2SurfaceContract {
  const key = `${vendor}/${surface}`;
  const base = CONTRACTS[key];
  if (base) return { id: key, vendor, ...base };
  return {
    id: key,
    vendor,
    surface,
    endpoint_class: "undocumented",
    agent_credentials: [],
    setup_mode: "not_applicable",
    verifier_mode: "not_applicable",
    cleanup_mode: "not_applicable",
    notes: ["No v2 surface contract has been admitted."],
  };
}

function promptUsesSqlWire(prompt: string): boolean {
  return /\bpsql\b|SQL wire|connection_string_env|process\.env\.[A-Z0-9_]+_URL/i.test(prompt);
}

function knownBlocker(vendor: string, surface: WitnessSurface, taskId: string, pack: V2PackSnapshot["pack"]): string | undefined {
  if (vendor === "supabase" && surface === "api") {
    return "PostgREST API cannot establish the required tables, roles, or policies from an empty state";
  }
  if (vendor === "neon" && surface === "api" && pack.tasks.some((task) => task.id === taskId && promptUsesSqlWire(task.prompt))) {
    return "task prompt requires SQL wire/psql while the frozen API contract is Neon management REST";
  }
  if (vendor === "turso" && taskId === "db-T01-access-control") {
    return "denied-token probe requires organization-level token minting not supplied by the ordinary cell credential";
  }
  return undefined;
}

export function buildV2WitnessPlan(
  snapshots: readonly V2PackSnapshot[],
  generatedAt: string,
  options: { mode?: V2WitnessMode } = {},
): V2WitnessPlan {
  const mode = options.mode ?? "all";
  const excludedVendors = mode === "cli-only" ? ["supabase"] : [];
  const scopedSnapshots = snapshots.filter(({ vendor }) => !excludedVendors.includes(vendor));
  const contracts = scopedSnapshots.flatMap(({ vendor }) =>
    (mode === "cli-only" ? ["cli"] as const : ["api", "cli"] as const)
      .map((surface) => contractFor(vendor, surface))
  );
  const entries: V2WitnessEntry[] = [];
  for (const { vendor, pack } of scopedSnapshots) {
    for (const task of pack.tasks) {
      for (const surface of task.allowed_surfaces as SurfaceId[]) {
        if (mode === "cli-only" && surface !== "cli") continue;
        if (mode === "cli-only" && surface === "cli" && CLI_EXCLUDED_TUPLES.some((excluded) => excluded.vendor === vendor && excluded.task_id === task.id)) continue;
        const contract = contractFor(vendor, surface as WitnessSurface);
        const blocker = knownBlocker(vendor, surface as WitnessSurface, task.id, pack);
        // The CLI-only benchmark is intentionally a runnable candidate set,
        // not a ledger of rejected tuples. Unsupported CLI tasks are removed
        // instead of becoming misleading N/A/failed cells.
        if (mode === "cli-only" && blocker) continue;
        entries.push({
          vendor,
          task_id: task.id,
          surface: surface as WitnessSurface,
          contract_id: contract.id,
          disposition: blocker ? "blocked" : "needs_witness",
          reason: blocker ?? "No deterministic executable witness has been admitted yet",
          evidence: [],
        });
      }
    }
  }
  // Fresh official-doc corrections may add a CLI tuple that the immutable v1
  // pack omitted. Keep this list explicit and small so a docs refresh cannot
  // silently broaden the benchmark.
  if (mode === "cli-only") {
    for (const reconsidered of CLI_RECONSIDERED_TUPLES) {
      const snapshot = scopedSnapshots.find(({ vendor }) => vendor === reconsidered.vendor);
      const task = snapshot?.pack.tasks.find(({ id }) => id === reconsidered.task_id);
      if (!task) continue;
      const key = `${reconsidered.vendor}/${reconsidered.task_id}/${reconsidered.surface}`;
      if (entries.some((entry) => `${entry.vendor}/${entry.task_id}/${entry.surface}` === key)) continue;
      const contract = contractFor(reconsidered.vendor, reconsidered.surface);
      entries.push({
        vendor: reconsidered.vendor,
        task_id: reconsidered.task_id,
        surface: reconsidered.surface,
        contract_id: contract.id,
        disposition: "needs_witness",
        reason: reconsidered.reason,
        evidence: [],
      });
    }
  }
  // Preserve v1 as an immutable source while allowing explicitly documented
  // audit corrections to enter v2 as witness candidates. This is intentionally
  // a small, reviewable list rather than a broad surface expansion.
  for (const reconsidered of RECONSIDERED_TUPLES) {
    if (mode === "cli-only") continue;
    const snapshot = scopedSnapshots.find(({ vendor }) => vendor === reconsidered.vendor);
    const task = snapshot?.pack.tasks.find(({ id }) => id === reconsidered.task_id);
    if (!task) continue;
    const key = `${reconsidered.vendor}/${reconsidered.task_id}/${reconsidered.surface}`;
    if (entries.some((entry) => `${entry.vendor}/${entry.task_id}/${entry.surface}` === key)) continue;
    const contract = contractFor(reconsidered.vendor, reconsidered.surface);
    entries.push({
      vendor: reconsidered.vendor,
      task_id: reconsidered.task_id,
      surface: reconsidered.surface,
      contract_id: contract.id,
      disposition: "needs_witness",
      reason: reconsidered.reason,
      evidence: [],
    });
  }
  return {
    schema: DAEB_V2_SCHEMA,
    benchmark: "axarena-database",
    version: 2,
    source_version: "daeb-1-v1",
    generated_at: generatedAt,
    status: "draft",
    mode,
    task_source_status: "v1-intent+official-cli-doc-refresh+target-capability-exclusions",
    excluded_vendors: excludedVendors,
    contracts,
    entries,
  };
}

export function validateV2WitnessPlan(plan: V2WitnessPlan): string[] {
  const errors: string[] = [];
  const contracts = new Set(plan.contracts.map((contract) => contract.id));
  const seen = new Set<string>();
  for (const entry of plan.entries) {
    const key = `${entry.vendor}/${entry.task_id}/${entry.surface}`;
    if (seen.has(key)) errors.push(`duplicate witness entry ${key}`);
    seen.add(key);
    if (!contracts.has(entry.contract_id)) errors.push(`${key} references missing contract ${entry.contract_id}`);
    if (!entry.reason.trim()) errors.push(`${key} has no disposition reason`);
    if (entry.disposition !== "passed") continue;
    if (entry.evidence.length === 0) errors.push(`${key} is passed without deterministic evidence`);
    const proof = entry.proof;
    if (!proof) {
      errors.push(`${key} is passed without setup/mutation/verify/cleanup proof`);
      continue;
    }
    for (const stage of ["setup", "mutation", "verify", "cleanup"] as const) {
      const evidence = proof[stage];
      if (evidence.status !== "passed" || !evidence.command.trim() || !evidence.artifact.trim()) {
        errors.push(`${key} has incomplete ${stage} witness evidence`);
      }
    }
    if (!/^[a-f0-9]{64}$/i.test(proof.source_sha256)) errors.push(`${key} has invalid source_sha256`);
    if (!/^[a-f0-9]{64}$/i.test(proof.bundle_sha256)) errors.push(`${key} has invalid bundle_sha256`);
  }
  return errors;
}

export function buildV2SupportMatrix(plan: V2WitnessPlan): V2SupportMatrix {
  return {
    schema: DAEB_V2_SUPPORT_SCHEMA,
    benchmark: "DAEB-2",
    category: "database",
    generated_at: plan.generated_at,
    mode: plan.mode,
    task_source_status: plan.task_source_status,
    excluded_vendors: plan.excluded_vendors,
    entries: plan.entries.map((entry) => ({
      vendor: entry.vendor,
      task_id: entry.task_id,
      surface: entry.surface,
      status: entry.disposition === "blocked" ? "unsupported" : entry.disposition === "passed" ? "supported" : "inconclusive",
      source_concept: entry.task_id.replace(/^db-T\d+-/, ""),
      reason: entry.reason,
      witness_required: entry.disposition === "needs_witness",
    })),
  };
}

export function v2SurfaceContract(vendor: string, surface: WitnessSurface): V2SurfaceContract {
  return contractFor(vendor, surface);
}
