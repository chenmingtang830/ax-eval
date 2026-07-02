export const PROBE_PREFIX = "AX probe";
export const NS_PLACEHOLDER = "{ns}";

/** Resolve a per-execution namespace: <genVersion>-<profile>-<shortRand>. */
export function resolveNs(runId: string, profile: string): string {
  const rand = Math.random().toString(36).slice(2, 6);
  const base = (runId || "gen").replace(/[^a-z0-9-]/gi, "");
  return `${base}-${profile}-${rand}`;
}

/** Substitute {ns} everywhere in a string. */
export function applyNs(text: string, ns: string): string {
  return text.split(NS_PLACEHOLDER).join(ns);
}

export function probeValue(resource: string): string {
  return `${PROBE_PREFIX} ${resource} ${NS_PLACEHOLDER}`;
}
