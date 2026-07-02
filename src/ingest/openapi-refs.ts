export type Json = Record<string, unknown>;

export const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

const MAX_REF_DEPTH = 20;

/** Resolve a local `#/a/b/c` ref against the root document (cycle-guarded). */
export function resolveRef(root: Json, ref: string, seen = new Set<string>()): unknown {
  if (!ref.startsWith("#/") || seen.has(ref) || seen.size > MAX_REF_DEPTH) return undefined;
  seen.add(ref);
  let node: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node && typeof node === "object" && key in (node as object)) {
      node = (node as Json)[key];
    } else {
      return undefined;
    }
  }
  if (node && typeof node === "object" && typeof (node as Json).$ref === "string") {
    return resolveRef(root, (node as Json).$ref as string, seen);
  }
  return node;
}

/** Deref one node one level (returns the object, or undefined on a broken ref). */
export function deref(root: Json, node: unknown, seen = new Set<string>()): Json | undefined {
  if (!node || typeof node !== "object") return undefined;
  const obj = node as Json;
  if (typeof obj.$ref === "string") {
    const r = resolveRef(root, obj.$ref, seen);
    return r && typeof r === "object" ? (r as Json) : undefined;
  }
  return obj;
}

/** Collect every `$ref` string appearing anywhere under a node (bounded). */
export function collectRefs(node: unknown, out: string[] = [], depth = 0): string[] {
  if (!node || typeof node !== "object" || depth > MAX_REF_DEPTH) return out;
  if (Array.isArray(node)) {
    for (const v of node) collectRefs(v, out, depth + 1);
    return out;
  }
  for (const [k, v] of Object.entries(node as Json)) {
    if (k === "$ref" && typeof v === "string") out.push(v);
    else collectRefs(v, out, depth + 1);
  }
  return out;
}
