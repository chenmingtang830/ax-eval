/**
 * Generic sandbox teardown for pass@k hygiene.
 *
 * Repeated live runs leave probe resources behind (every generated resource is
 * named `AX probe <type> <ns>`), which contaminates later runs. `reset` lists
 * those candidate resources in the pack's declared sandbox scope and deletes
 * them. The framework is target-agnostic (resolve scope → list → match `{ns}`
 * naming convention → delete); reliable listing/deletion is target-specific, so
 * a per-target resetter is registered. Asana is the concrete reference; targets
 * without a resetter fail GRACEFULLY (a clear message, never a throw).
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
   *  every probe-named resource in scope is a candidate. */
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
  /** False when no resetter is registered for the target. */
  supported: boolean;
  message: string;
  /** Ids deleted (or that would be, under dryRun). */
  deleted: string[];
  /** Probe resources matched in scope. */
  candidates: number;
  errors: string[];
}

/** A probe resource is one whose name carries the AX prefix; when an ns is
 *  given it must also belong to that namespace. */
function isProbeName(name: unknown, ns?: string): boolean {
  if (typeof name !== "string" || !name.startsWith(PROBE_PREFIX)) return false;
  return ns ? name.includes(ns) : true;
}

/** Pick the scope value for a logical container, preferring a key that mentions
 *  the hint (e.g. "project"), else the first declared scope value. */
function containerId(scope: Record<string, string>, hint: string): string | undefined {
  const key = Object.keys(scope).find((k) => k.toLowerCase().includes(hint));
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
  opts: ResetOptions,
) => Promise<ResetWork>;

/**
 * Asana reference: tasks are the sandbox-contained resource, listable under the
 * throwaway project the scope names. List them, keep AX-probe names, DELETE each.
 */
const asanaReset: Resetter = async (_pack, client, scope, opts) => {
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
  const candidates = (Array.isArray(tasks) ? tasks : []).filter((t) => t.gid && isProbeName(t.name, opts.ns));
  const maxCandidates = opts.maxCandidates ?? 100;
  if (candidates.length > maxCandidates) {
    return {
      deleted: [],
      candidates: candidates.length,
      errors: [`refusing reset: ${candidates.length} candidates exceeds the safety limit of ${maxCandidates}`],
    };
  }
  const deleted: string[] = [];
  const errors: string[] = [];
  for (const t of candidates) {
    if (opts.dryRun) {
      deleted.push(t.gid!);
      continue;
    }
    try {
      await client.del(`/tasks/${t.gid}`);
      deleted.push(t.gid!);
    } catch (err) {
      errors.push(redactSensitiveText(`delete /tasks/${t.gid}: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
  return { deleted, candidates: candidates.length, errors };
};

/** Per-target resetters, keyed by pack name. */
const RESETTERS: Record<string, Resetter> = {
  asana: asanaReset,
  "asana-generated": asanaReset,
};

/**
 * Resolve the target's resetter and run it. Returns `supported: false` (not a
 * throw) for targets whose listing/deletion isn't expressible yet, so callers
 * can degrade gracefully.
 */
export async function resetPack(
  pack: TargetPack,
  client: ResetClient,
  scope: Record<string, string>,
  opts: ResetOptions = {},
): Promise<ResetResult> {
  const resetter = RESETTERS[pack.name];
  if (!resetter) {
    return {
      supported: false,
      message:
        `No reset strategy for "${pack.name}" — sandbox listing/deletion isn't expressible yet for this target. ` +
        `Delete probe resources (named "${PROBE_PREFIX} …") manually.`,
      deleted: [],
      candidates: 0,
      errors: [],
    };
  }
  const ns = opts.ns?.trim() || undefined;
  if (ns && !/^[A-Za-z0-9._-]+$/.test(ns)) {
    return {
      supported: true,
      message: `Reset ${pack.name}: refused an invalid namespace.`,
      deleted: [],
      candidates: 0,
      errors: ["namespace may contain only letters, numbers, dot, underscore, and hyphen"],
    };
  }
  if (!opts.dryRun && !ns && !opts.allowAllNamespaces) {
    return {
      supported: true,
      message: `Reset ${pack.name}: refused destructive reset without an explicit namespace.`,
      deleted: [],
      candidates: 0,
      errors: ["pass --ns <token> to delete one run, or use --dry-run to inventory all probe resources"],
    };
  }
  const resetOptions = { ...opts, ns };
  const { deleted, candidates, errors } = await resetter(pack, client, scope, resetOptions);
  const verb = opts.dryRun ? "would delete" : "deleted";
  return {
    supported: true,
    message: `Reset ${pack.name}: ${verb} ${deleted.length}/${candidates} probe resource(s)${
      ns ? ` in namespace "${ns}"` : ""
    }.`,
    deleted,
    candidates,
    errors,
  };
}
