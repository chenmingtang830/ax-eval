#!/usr/bin/env node
/**
 * `ax-eval` command-line entrypoint.
 *
 *   ax-eval run [--pack p] [--harness h]... [--out o] [--offline]  behavioral matrix + static gap
 *   ax-eval audit [--pack p | --site url] [--offline]              static (agent-readiness) audit only
 *   ax-eval report <results.json>                                  render a saved result file
 *   ax-eval list-harnesses                                         show registered harnesses
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { availableHarnesses } from "./adapters/registry.js";
import { loadDotenv, loadPack } from "./config.js";
import { render } from "./reporting.js";
import { run } from "./runner.js";
import { auditSite } from "./static/audit.js";
import { renderAudit, renderGap } from "./static/render.js";
import { loadReport, saveReport } from "./storage.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PACK = resolve(HERE, "..", "targets", "asana", "pack.yaml");

interface Parsed {
  pack: string;
  harness: string[];
  out: string;
  site: string;
  offline: boolean;
  _: string[];
}

function parseArgs(argv: string[]): Parsed {
  const p: Parsed = {
    pack: DEFAULT_PACK,
    harness: [],
    out: "results/last-run.json",
    site: "",
    offline: false,
    _: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pack") p.pack = argv[++i]!;
    else if (a === "--harness") p.harness.push(argv[++i]!);
    else if (a === "--out") p.out = argv[++i]!;
    else if (a === "--site") p.site = argv[++i]!;
    else if (a === "--offline") p.offline = true;
    else if (a!.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else p._.push(a!);
  }
  return p;
}

async function cmdRun(args: Parsed): Promise<number> {
  loadDotenv();
  const pack = loadPack(args.pack);
  const harnesses = args.harness.length ? args.harness : ["mock", "mock-weak", "hermes"];
  console.log(
    `Running ${pack.tasks.length} tasks × ${harnesses.length} harnesses ` +
      `on ${pack.name} v${pack.version}\n`,
  );
  const report = await run(pack, harnesses, { progress: true });
  saveReport(report, args.out);
  console.log(`\nSaved results → ${args.out}\n`);
  console.log(render(report));

  // Static (agent-readiness) audit next to the behavioral matrix — the "gap".
  if (pack.site_url) {
    const audit = await auditSite(pack.site_url, { mode: args.offline ? "fixture" : "live" });
    console.log("\n" + renderAudit(audit));
    console.log("\n" + renderGap(audit, report));
  }
  return 0;
}

async function cmdAudit(args: Parsed): Promise<number> {
  let site = args.site;
  if (!site) site = loadPack(args.pack).site_url;
  if (!site) throw new Error("no site to audit: pass --site <url> or use a pack with site_url");
  const audit = await auditSite(site, { mode: args.offline ? "fixture" : "live" });
  console.log(renderAudit(audit));
  return 0;
}

function cmdReport(args: Parsed): number {
  const path = args._[1];
  if (!path) throw new Error("usage: ax-eval report <results.json>");
  console.log(render(loadReport(path)));
  return 0;
}

function cmdList(): number {
  console.log("Registered harnesses:");
  for (const name of availableHarnesses()) console.log(`  ${name}`);
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args = parseArgs(argv);
  switch (command) {
    case "run":
      return cmdRun(args);
    case "audit":
      return cmdAudit(args);
    case "report":
      return cmdReport(args);
    case "list-harnesses":
      return cmdList();
    default:
      console.error("usage: ax-eval <run|audit|report|list-harnesses> [options]");
      return 2;
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
