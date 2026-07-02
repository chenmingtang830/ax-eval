/**
 * Programmatic oracles: declarative checks over a run's reported world state.
 *
 * Oracles are pure and need no network, so they run identically in mock mode
 * (against fixtures) and against live API readback later. `path` uses dotted
 * keys (e.g. "task.due_on") resolved against nested objects.
 */
import { DOTTED_MISSING, resolveDottedPath } from "./dotted.js";
import type { OracleResult, OracleSpec, World } from "./schemas.js";

function resolve(world: World, path: string | undefined): unknown {
  return resolveDottedPath(world, path);
}

export type OracleFn = (spec: OracleSpec, world: World) => OracleResult;

export const ORACLES: Record<string, OracleFn> = {
  exists(spec, world) {
    const value = resolve(world, spec.path);
    const passed = value !== DOTTED_MISSING;
    return { type: "exists", passed, detail: `${spec.path} ${passed ? "present" : "missing"}` };
  },

  equals(spec, world) {
    const value = resolve(world, spec.path);
    if (value === DOTTED_MISSING) return { type: "equals", passed: false, detail: `${spec.path} missing` };
    const passed = deepEqual(value, spec.expected);
    return { type: "equals", passed, detail: `${spec.path}=${fmt(value)} expected=${fmt(spec.expected)}` };
  },

  contains(spec, world) {
    const value = resolve(world, spec.path);
    if (value === DOTTED_MISSING) return { type: "contains", passed: false, detail: `${spec.path} missing` };
    let passed = false;
    if (Array.isArray(value)) passed = value.some((v) => deepEqual(v, spec.value));
    else if (typeof value === "string") passed = value.includes(String(spec.value));
    return { type: "contains", passed, detail: `${fmt(spec.value)} in ${spec.path}=${fmt(value)}` };
  },
};

export function evaluate(spec: OracleSpec, world: World): OracleResult {
  const fn = ORACLES[spec.type];
  if (!fn) return { type: spec.type, passed: false, detail: `unknown oracle type ${spec.type}` };
  return fn(spec, world);
}

export function evaluateAll(specs: OracleSpec[], world: World): OracleResult[] {
  return specs.map((s) => evaluate(s, world));
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function fmt(v: unknown): string {
  return typeof v === "string" ? `'${v}'` : JSON.stringify(v);
}
