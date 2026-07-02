export const DOTTED_MISSING = Symbol("dotted-missing");

export function resolveDottedPath(obj: unknown, path: string | undefined): unknown {
  if (!path) return DOTTED_MISSING;
  let node: unknown = obj;
  for (const part of path.split(".")) {
    if (node !== null && typeof node === "object" && part in (node as object)) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return DOTTED_MISSING;
    }
  }
  return node;
}
