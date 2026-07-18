/**
 * CLI help-quality audit: deterministic checks over a product CLI's help text.
 * This answers whether an agent can infer commands, flags, auth, and examples
 * from the same `--help` surface it is asked to inspect during execution.
 */
import { spawnSync } from "node:child_process";
import { REPORT_STYLE } from "../report-style.js";
import type { CliSurface } from "../schemas.js";

export type CliHelpQualityCategory =
  | "DESCRIPTION"
  | "COMMANDS"
  | "FLAGS"
  | "AUTH"
  | "EXAMPLES"
  | "DESTRUCTIVE";

export interface CliHelpFinding {
  category: CliHelpQualityCategory;
  evidence: string;
  suggestion: string;
}

export interface CliHelpQualityAudit {
  title: string;
  source: string;
  command: string;
  helpChars: number;
  totalFindings: number;
  byCategory: Record<CliHelpQualityCategory, number>;
  score: number;
  findings: CliHelpFinding[];
}

export interface CliHelpRunOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const CATEGORIES: CliHelpQualityCategory[] = [
  "DESCRIPTION",
  "COMMANDS",
  "FLAGS",
  "AUTH",
  "EXAMPLES",
  "DESTRUCTIVE",
];

const WEIGHTS: Record<CliHelpQualityCategory, number> = {
  DESCRIPTION: 2,
  COMMANDS: 3,
  FLAGS: 3,
  AUTH: 3,
  EXAMPLES: 2,
  DESTRUCTIVE: 2,
};

const TOTAL_WEIGHT = CATEGORIES.reduce((sum, c) => sum + WEIGHTS[c], 0);

function plain(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "").trim();
}

function hasDescription(text: string): boolean {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.some((line) =>
    line.length >= 25 &&
    !/^usage\b/i.test(line) &&
    !/^(options?|flags?|commands?|examples?)\s*:?$/i.test(line) &&
    /[a-z]/i.test(line),
  );
}

function sectionLines(text: string, heading: RegExp): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return [];
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(usage|commands?|subcommands?|available commands?|options?|flags?|examples?)\s*:?\s*$/i.test(line)) break;
    if (line.trim()) body.push(line);
  }
  return body;
}

function hasCommands(text: string): boolean {
  const commandRow = /^\s{2,}[a-z][\w:-]+(?:\s+[a-z][\w:-]+)?\s{2,}\S/i;
  return sectionLines(text, /^\s*(commands?|subcommands?|available commands?)\s*:?\s*$/i).some((line) => commandRow.test(line)) ||
    /(^|\n)\s{2,}[a-z][\w:-]+(?:\s+[a-z][\w:-]+)?\s{2,}\S/.test(text);
}

function hasFlags(text: string): boolean {
  const flagRow = /^\s{0,6}(?:-[a-zA-Z],\s*)?--[a-zA-Z0-9][\w-]*(?:[ =][A-Z<[][\w|<>\][=-]*)?\s{2,}\S/;
  return sectionLines(text, /^\s*(options?|flags?)\s*:?\s*$/i).some((line) => flagRow.test(line)) ||
    /(^|\n)\s{0,6}(?:-[a-zA-Z],\s*)?--[a-zA-Z0-9][\w-]*(?:[ =][A-Z<[][\w|<>\][=-]*)?\s{2,}\S/.test(text);
}

function hasAuth(text: string): boolean {
  return /\b(auth|login|token|api[-_ ]?key|credential|oauth|bearer|configure)\b/i.test(text) ||
    /\b[A-Z][A-Z0-9_]{2,}_(TOKEN|KEY|PAT|SECRET)\b/.test(text);
}

function hasExamples(text: string, bin: string): boolean {
  const escaped = bin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exampleLine = new RegExp(`^\\s*\\$?\\s*${escaped}\\s+\\S+`, "i");
  return sectionLines(text, /^\s*examples?\s*:?\s*$/i).some((line) => exampleLine.test(line)) ||
    text.split("\n").some((line) => /^\s*\$\s*/.test(line) && exampleLine.test(line));
}

function destructiveMentions(text: string): string[] {
  const matches = text.match(/\b(delete|remove|destroy|archive|purge)\b/gi) ?? [];
  return [...new Set(matches.map((m) => m.toLowerCase()))];
}

function destructiveIsLabeled(text: string): boolean {
  return /\b(confirm|irreversible|destructive|permanent|cannot be undone|danger|archive)\b/i.test(text);
}

function finding(category: CliHelpQualityCategory, evidence: string, suggestion: string): CliHelpFinding {
  return { category, evidence, suggestion: `[${category}] - ${suggestion}` };
}

export function auditCliHelpQuality(helpText: string, opts: { title?: string; source?: string; command?: string; bin?: string } = {}): CliHelpQualityAudit {
  const text = plain(helpText);
  const bin = opts.bin ?? opts.command?.split(/\s+/)[0] ?? "cli";
  const findings: CliHelpFinding[] = [];

  if (!hasDescription(text)) {
    findings.push(finding("DESCRIPTION", "Help output does not include a meaningful top-level description.", "Add a concise description of what the CLI operates on and when to use it."));
  }
  if (!hasCommands(text)) {
    findings.push(finding("COMMANDS", "Help output does not expose discoverable subcommands/actions.", "List available subcommands with one-line descriptions and point to nested help."));
  }
  if (!hasFlags(text)) {
    findings.push(finding("FLAGS", "Help output does not document flags/options with descriptions.", "Document required and optional flags, accepted values, and defaults."));
  }
  if (!hasAuth(text)) {
    findings.push(finding("AUTH", "Help output does not mention login, token, API-key, or credential setup.", "Document how to authenticate non-interactively, including env vars supported in CI."));
  }
  if (!hasExamples(text, bin)) {
    findings.push(finding("EXAMPLES", "Help output does not include concrete command examples.", "Add copy-pastable examples for common create/update/read workflows."));
  }
  const destructive = destructiveMentions(text);
  if (destructive.length && !destructiveIsLabeled(text)) {
    findings.push(finding("DESTRUCTIVE", `Destructive action(s) mentioned without clear side-effect language: ${destructive.join(", ")}.`, "Label destructive commands with confirmation/scope requirements and whether the operation is reversible."));
  }

  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<CliHelpQualityCategory, number>;
  for (const f of findings) byCategory[f.category] += 1;
  const lost = findings.reduce((sum, f) => sum + WEIGHTS[f.category], 0);

  return {
    title: opts.title ?? bin,
    source: opts.source ?? "help text",
    command: opts.command ?? `${bin} --help`,
    helpChars: text.length,
    totalFindings: findings.length,
    byCategory,
    score: Math.max(0, Math.round(100 * (1 - lost / TOTAL_WEIGHT))),
    findings,
  };
}

function splitCommand(command: string): string[] {
  const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return parts.map((part) => part.replace(/^(['"])(.*)\1$/, "$2"));
}

export function auditCliSurfaceQuality(surface: CliSurface, opts: CliHelpRunOptions = {}): CliHelpQualityAudit {
  const command = surface.help || `${surface.bin} --help`;
  const [bin, ...args] = splitCommand(command);
  if (!bin) throw new Error("CLI help command is empty");
  const res = spawnSync(bin, args, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: opts.timeoutMs ?? 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error) throw res.error;
  if ((res.status ?? 1) !== 0) {
    throw new Error(`${command} failed: ${res.stderr || `exit ${res.status}`}`);
  }
  const output = `${res.stdout ?? ""}${res.stderr ? `\n${res.stderr}` : ""}`;
  return auditCliHelpQuality(output, { title: surface.bin, source: command, command, bin: surface.bin });
}

function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export function renderCliHelpQualitySection(audit: CliHelpQualityAudit): string {
  const prevalence = Object.entries(audit.byCategory)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `<tr><td>${esc(c)}</td><td>${esc(n)}</td></tr>`)
    .join("");
  const rows = audit.findings.map((f) => `
    <details class="ax-endpoint">
      <summary><code class="ax-code">${esc(f.category)}</code></summary>
      <div class="ax-smell"><div class="ax-smell__head">${esc(f.evidence)}</div><p class="ax-smell__fix">${esc(f.suggestion)}</p></div>
    </details>`).join("");
  return `<section class="ax-section" id="cli-help-quality">
    <h2>CLI help quality</h2>
    <p class="ax-note">Score ${esc(audit.score)}/100 from <code class="ax-code">${esc(audit.command)}</code>. This checks whether the CLI help surface is self-describing enough for agents to choose commands, fill flags, authenticate, and avoid unsafe operations.</p>
    ${prevalence ? `<table class="ax-table"><thead><tr><th>Finding category</th><th>Count</th></tr></thead><tbody>${prevalence}</tbody></table>` : `<p class="ax-empty">No CLI help-quality findings.</p>`}
    ${rows}
  </section>`;
}

export function renderCliHelpQualityHtml(audit: CliHelpQualityAudit): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>CLI help quality — ${esc(audit.title)}</title><style>${REPORT_STYLE}</style></head><body><main class="ax-main">${renderCliHelpQualitySection(audit)}</main></body></html>`;
}
