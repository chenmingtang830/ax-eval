/**
 * Surface adapters — the layer that turns AX eval from an API-only tester into a
 * multi-surface Agent Experience evaluator.
 *
 * The KEY INSIGHT: the task ("create a project named X") and the
 * oracle (read it back via the API, assert a field) are surface-independent. Only
 * two things change per surface:
 *   (a) how the agent is told to act     (curl vs CLI vs SDK vs MCP tools)
 *   (b) what "discovery" means           (docs site vs --help vs SDK ref vs tools/list)
 *
 * So a Surface is a small adapter the prompt builder + discovery scorer consult;
 * everything else (ingest, pack gen, namespace, pass@k, CI gate, trace diff, and
 * the read-back verify) is reused unchanged. `api` is the reference surface and
 * is byte-for-byte identical to the original hard-coded behavior.
 *
 * The primitives (Surface, SurfaceId, DISCOVERY_HEADER, productName) live in
 * ./types.ts so the adapters can import them without a cycle with this registry.
 */
import type { TargetPack } from "../schemas.js";
import type { Surface, SurfaceId } from "./types.js";
import { apiSurface } from "./api.js";
import { cliSurface } from "./cli.js";
import { sdkSurface } from "./sdk.js";
import { mcpSurface } from "./mcp.js";

export type { Surface, SurfaceId } from "./types.js";
export { DISCOVERY_HEADER, productName } from "./types.js";

export const SURFACES: Record<SurfaceId, Surface> = {
  api: apiSurface,
  cli: cliSurface,
  sdk: sdkSurface,
  mcp: mcpSurface,
};

/** Resolve a surface by id, throwing a helpful error for an unknown one. */
export function getSurface(id: string): Surface {
  const s = SURFACES[id as SurfaceId];
  if (!s) throw new Error(`unknown surface '${id}'; available: ${Object.keys(SURFACES).join(", ")}, all`);
  return s;
}

/**
 * The surfaces this pack actually supports. `api` is always present (every pack
 * has a base_url + auth); the others appear only when declared in `pack.surfaces`.
 * This is what `--surface all` fans out over.
 */
export function availableSurfaces(pack: TargetPack): SurfaceId[] {
  const out: SurfaceId[] = ["api"];
  if (pack.surfaces?.cli) out.push("cli");
  if (pack.surfaces?.sdk) out.push("sdk");
  if (pack.surfaces?.mcp) out.push("mcp");
  return out;
}

/** Resolve a `--surface` arg to the concrete list of surfaces to run. `all`
 *  expands to every surface the pack declares; a single id is validated against
 *  what the pack actually exposes. */
export function resolveSurfaceSelection(pack: TargetPack, arg: string): SurfaceId[] {
  if (arg === "all") return availableSurfaces(pack);
  const surface = getSurface(arg);
  if (surface.id !== "api" && !availableSurfaces(pack).includes(surface.id)) {
    throw new Error(
      `surface '${surface.id}' is not declared for ${pack.name}; add a 'surfaces.${surface.id}' block to the pack ` +
        `(declared: ${availableSurfaces(pack).join(", ")}).`,
    );
  }
  return [surface.id];
}
