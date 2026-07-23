/**
 * Compatibility sandbox teardown for generic HTTP targets.
 *
 * The reusable reset contract and safety rules remain in core. Database and
 * benchmark-target implementations are supplied through explicit ResetProvider
 * registries by ax-arena; this legacy helper retains only the public Asana
 * example behavior until the CLI compatibility window closes.
 */
import { PROBE_PREFIX } from "../generate/pack.js";
import type { TargetPack } from "../schemas.js";
import { redactSensitiveText } from "../safety/redaction.js";

/** The slice of the HTTP client a resetter needs (so tests stub it offline). */
export interface ResetClient {
  get<T = unknown>(path: string, query?: Record<string, string>): Promise<T>;
  del(path: string): Promise<void>;
}

export interface ResetOptions {
  /** Restrict deletion to names containing this namespace token; when unset,
   * every probe-named resource in scope is a candidate. */
  ns?: string;
  /** List + match but don't delete (preview). */
  dryRun?: boolean;
  /** Explicit programmatic override for deleting probe resources across every
   * namespace. The CLI intentionally does not expose this escape hatch. */
  allowAllNamespaces?: boolean;
  /** Refuse unexpectedly broad resets. Defaults to 100 matching resources. */
  maxCandidates?: number;
}

export interface ResetResult {
  /** False when no compatibility resetter is registered for the target. */
  supported: boolean;
  message: string;
  /** Ids deleted (or that would be, under dryRun). */
  deleted: string[];
  /** Probe resources matched in scope. */
  candidates: number;
  errors: string[];
}

function isProbeName(name: unknown, ns?: string): boolean {
  if (typeof name !== "string" || !name.startsWith(PROBE_PREFIX)) return false;
  return ns ? name.includes(ns) : true;
}

function containerId(scope: Record<string, string>, hint: string): string | undefined {
  const key = Object.keys(scope).find((candidate) => candidate.toLowerCase().includes(hint));
  return key ? scope[key] : Object.values(scope)[0];
}

interface ResetWork {
  deleted: string[];
  candidates: number;
  errors: string[];
}

type Resetter = (
  pack: TargetPack,
  client: ResetClient,
  scope: Record<string, string>,
  options: ResetOptions,
) => Promise<ResetWork>;

const asanaReset: Resetter = async (_pack, client, scope, options) => {
  const project = containerId(scope, "project");
  if (!project) {
    return { deleted: [], candidates: 0, errors: ["no sandbox project id in scope — cannot list tasks to reset"] };
  }
  let tasks: Array<{ gid?: string; name?: string }>;
  try {
    tasks = await client.get<Array<{ gid?: string; name?: string }>>(`/projects/${project}/tasks`, {
      opt_fields: "name",
    });
  } catch (error) {
    return {
      deleted: [],
      candidates: 0,
      errors: [redactSensitiveText(`list /projects/${project}/tasks: ${error instanceof Error ? error.message : String(error)}`)],
    };
  }
  const matches = (Array.isArray(tasks) ? tasks : [])
    .filter((task) => task.gid && isProbeName(task.name, options.ns));
  const maxCandidates = options.maxCandidates ?? 100;
  if (matches.length > maxCandidates) {
    return {
      deleted: [],
      candidates: matches.length,
      errors: [`refusing reset: ${matches.length} candidates exceeds the safety limit of ${maxCandidates}`],
    };
  }
  const deleted: string[] = [];
  const errors: string[] = [];
  for (const task of matches) {
    if (options.dryRun) {
      deleted.push(task.gid!);
      continue;
    }
    try {
      await client.del(`/tasks/${task.gid}`);
      deleted.push(task.gid!);
    } catch (error) {
      errors.push(redactSensitiveText(
        `delete /tasks/${task.gid}: ${error instanceof Error ? error.message : String(error)}`,
      ));
    }
  }
  return { deleted, candidates: matches.length, errors };
};

const RESETTERS: Readonly<Record<string, Resetter>> = Object.freeze({
  asana: asanaReset,
  "asana-generated": asanaReset,
});

export function hasCoreResetStrategy(pack: Pick<TargetPack, "name">): boolean {
  return RESETTERS[pack.name] !== undefined;
}

/**
 * Run a retained compatibility resetter. Target-specific database cleanup is
 * intentionally unavailable here and must be selected through an explicit
 * ResetProvider in the arena-owned cell lifecycle.
 */
export async function resetPack(
  pack: TargetPack,
  client: ResetClient | (() => ResetClient),
  scope: Record<string, string> | (() => Record<string, string>),
  options: ResetOptions = {},
): Promise<ResetResult> {
  const resetter = RESETTERS[pack.name];
  if (!resetter) {
    return {
      supported: false,
      message:
        `No core reset strategy for "${pack.name}". Target-specific cleanup requires an explicit ResetProvider; ` +
        `delete probe resources (named "${PROBE_PREFIX} …") manually when no provider is available.`,
      deleted: [],
      candidates: 0,
      errors: [],
    };
  }
  const ns = options.ns?.trim() || undefined;
  if (ns && !/^[A-Za-z0-9._-]+$/.test(ns)) {
    return {
      supported: true,
      message: `Reset ${pack.name}: refused an invalid namespace.`,
      deleted: [],
      candidates: 0,
      errors: ["namespace may contain only letters, numbers, dot, underscore, and hyphen"],
    };
  }
  if (!options.dryRun && !ns && !options.allowAllNamespaces) {
    return {
      supported: true,
      message: `Reset ${pack.name}: refused destructive reset without an explicit namespace.`,
      deleted: [],
      candidates: 0,
      errors: ["pass --ns <token> to delete one run, or use --dry-run to inventory all probe resources"],
    };
  }
  const resolvedClient = typeof client === "function" ? client() : client;
  const resolvedScope = typeof scope === "function" ? scope() : scope;
  const result = await resetter(pack, resolvedClient, resolvedScope, { ...options, ns });
  const verb = options.dryRun ? "would delete" : "deleted";
  return {
    supported: true,
    message: `Reset ${pack.name}: ${verb} ${result.deleted.length}/${result.candidates} probe resource(s)${
      ns ? ` in namespace "${ns}"` : ""
    }.`,
    ...result,
  };
}
