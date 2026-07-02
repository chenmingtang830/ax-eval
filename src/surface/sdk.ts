/**
 * SDK surface — the agent must install the product's official SDK and call its
 * methods rather than hitting HTTP directly. "Discovery" is the SDK reference /
 * README / type definitions: how an agent learns a client library.
 */
import type { Surface } from "./types.js";
import { DISCOVERY_HEADER, productName } from "./types.js";

export const sdkSurface: Surface = {
  id: "sdk",
  subject: "software development kit (SDK)",
  actionUnit: "SDK call actions",
  setupBlock: (pack) => {
    const s = pack.surfaces?.sdk;
    if (!s) return [];
    const lines = [
      `=== SURFACE: SDK ===`,
      `You must operate ${productName(pack)} through its official ${s.language} SDK, NOT raw HTTP/curl.`,
    ];
    lines.push(s.install ? `Install it: ${s.install}` : `Install the \`${s.package}\` package for ${s.language}.`);
    if (s.reference_url) lines.push(`SDK reference: ${s.reference_url}`);
    if (s.examples_url) lines.push(`SDK examples: ${s.examples_url}`);
    if (s.types_url) lines.push(`SDK types/signatures: ${s.types_url}`);
    lines.push(``);
    return lines;
  },
  discoveryBlock: (pack) => {
    const product = productName(pack);
    const s = pack.surfaces?.sdk;
    const pkg = s?.package ?? "the SDK";
    return [
      DISCOVERY_HEADER,
      `Before doing ANY task, work out how to use ${product}'s official ${s?.language ?? ""} SDK (\`${pkg}\`).`,
      `You are NOT given the client class, the method names, or how to authenticate the client.`,
      ...(s?.reference_url ? [`- Start from the SDK reference: ${s.reference_url}`] : []),
      ...(s?.examples_url ? [`- Use SDK examples/quickstart: ${s.examples_url}`] : []),
      ...(s?.types_url ? [`- Confirm method signatures/types here: ${s.types_url}`] : []),
      `- Read the SDK reference / README / type definitions, and/or WEB SEARCH the official docs.`,
      `- Determine: how to construct + authenticate the client from the credential in .env, and the`,
      `  exact methods to create each resource.`,
      `- Do NOT guess from memory; open the SDK reference and confirm the real method signatures.`,
      `- Everything you do in Phase 1 MUST use what you discover here.`,
      ``,
    ];
  },
  actionGuidance: (pack) =>
    `Install and call the \`${pack.surfaces?.sdk?.package ?? "product"}\` SDK for every action (not raw curl).`,
  resultsHints: {
    base: "<the SDK package + version you installed>",
    endpoint: "<the SDK method you used to create, e.g. `client.tasks.create`>",
    auth: "<how you constructed + authenticated the client>",
  },
};
