/**
 * API surface — the reference adapter. Its output is byte-for-byte identical to
 * the original hard-coded executor flow (cold-start web discovery → curl/code),
 * so refactoring the executor onto the Surface layer is a pure no-op for `api`.
 */
import type { Surface } from "./types.js";
import { productName } from "./types.js";

export const apiSurface: Surface = {
  id: "api",
  subject: "API",
  actionUnit: "API actions",
  setupBlock: () => [],
  discoveryBlock: (pack) => {
    const product = productName(pack);
    return [
      `=== PHASE 0 — DISCOVERY (cold start, scored) ===`,
      `Before doing ANY task, work out how to use ${product}'s API. You are NOT given the`,
      `base URL, any endpoint, the request/response shape, or a documentation link.`,
      `- Use WEB SEARCH to find ${product}'s official developer documentation.`,
      `- From it, determine: the API base URL, how to authenticate (the exact header/scheme`,
      `  for the token in .env), the request/response envelope, and how to create resources.`,
      `- Do NOT guess from memory; actually search and open pages, as a real agent would.`,
      `- Everything you do in Phase 1 MUST use what you discover here. If you discover the`,
      `  wrong thing, do not silently fall back to prior knowledge — let it play out.`,
      ``,
    ];
  },
  actionGuidance: () => "Use curl or a small script.",
  resultsHints: {
    base: "<the API base URL you discovered>",
    endpoint: "<the create call you discovered, e.g. METHOD /path>",
    auth: "<how you authenticated, e.g. the header/scheme you used>",
  },
};
