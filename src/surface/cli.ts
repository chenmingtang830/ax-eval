/**
 * CLI surface — the agent must drive the product's official command-line tool
 * instead of raw HTTP. "Discovery" here is inspecting `--help` / man pages (and,
 * if needed, the official CLI docs), which is the authoritative source for how an
 * agent learns a CLI. This is the highest-value surface (token-efficient, proven
 * effective for agents), so it ships first after the abstraction.
 */
import type { Surface } from "./types.js";
import { DISCOVERY_HEADER, productName } from "./types.js";

export const cliSurface: Surface = {
  id: "cli",
  subject: "command-line interface (CLI)",
  actionUnit: "CLI command actions",
  setupBlock: (pack) => {
    const c = pack.surfaces?.cli;
    if (!c) return [];
    const lines = [
      `=== SURFACE: CLI ===`,
      `You must operate ${productName(pack)} through its official command-line tool, NOT raw HTTP/curl.`,
    ];
    if (c.install) lines.push(`Install it if it isn't present: ${c.install}`);
    lines.push(`The CLI binary is \`${c.bin}\`.`, ``);
    return lines;
  },
  discoveryBlock: (pack) => {
    const product = productName(pack);
    const c = pack.surfaces?.cli;
    const help = c?.help || `${c?.bin ?? "the-cli"} --help`;
    return [
      DISCOVERY_HEADER,
      `Before doing ANY task, work out how to drive ${product} from its CLI. You are NOT`,
      `given the exact subcommands, flags, or how to authenticate the CLI.`,
      `- Run \`${help}\` (and \`<subcommand> --help\`), and/or WEB SEARCH ${product}'s official CLI docs.`,
      `- Determine: how to authenticate the CLI with the credential in .env, and the exact`,
      `  subcommand + flags to create each resource.`,
      `- Do NOT guess from memory; actually inspect --help output / open the official docs.`,
      `- Everything you do in Phase 1 MUST use what you discover here.`,
      ``,
    ];
  },
  actionGuidance: (pack) => `Use the \`${pack.surfaces?.cli?.bin ?? "product"}\` CLI for every action (not raw curl).`,
  resultsHints: {
    base: "<the CLI binary + version you used>",
    endpoint: "<the CLI command you used to create, e.g. `asana task create`>",
    auth: "<how you authenticated the CLI, e.g. an env var or a login subcommand>",
  },
};
