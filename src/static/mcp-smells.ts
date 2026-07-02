/**
 * MCP tool-quality audit: deterministic checks over tools/list. This answers
 * whether the MCP surface is self-describing enough for an agent to use without
 * an OpenAPI-shaped fallback.
 */
import type { IngestedMcp, IngestedMcpTool } from "../ingest/mcp.js";
import { REPORT_STYLE } from "../report-style.js";

export type McpToolSmellCategory =
  | "DESCRIPTION"
  | "INPUT_SCHEMA"
  | "REQUIRED_FIELDS"
  | "READBACK"
  | "IDENTITY"
  | "DESTRUCTIVE";

export interface McpToolFinding {
  tool: string;
  category: McpToolSmellCategory;
  evidence: string;
  suggestion: string;
}

export interface McpToolQualityAudit {
  title: string;
  source: string;
  toolsAnalyzed: number;
  totalFindings: number;
  byCategory: Record<McpToolSmellCategory, number>;
  score: number;
  findings: McpToolFinding[];
}

const CATEGORIES: McpToolSmellCategory[] = [
  "DESCRIPTION",
  "INPUT_SCHEMA",
  "REQUIRED_FIELDS",
  "READBACK",
  "IDENTITY",
  "DESTRUCTIVE",
];

const WEIGHTS: Record<McpToolSmellCategory, number> = {
  DESCRIPTION: 2,
  INPUT_SCHEMA: 3,
  REQUIRED_FIELDS: 2,
  READBACK: 3,
  IDENTITY: 3,
  DESTRUCTIVE: 2,
};

type Json = Record<string, unknown>;

function props(tool: IngestedMcpTool): Record<string, unknown> {
  const p = tool.inputSchema.properties;
  return p && typeof p === "object" && !Array.isArray(p) ? p as Record<string, unknown> : {};
}

function required(tool: IngestedMcpTool): string[] {
  return Array.isArray(tool.inputSchema.required)
    ? tool.inputSchema.required.filter((v): v is string => typeof v === "string")
    : [];
}

function text(tool: IngestedMcpTool): string {
  return `${tool.name} ${tool.description}`.toLowerCase();
}

function isCreate(tool: IngestedMcpTool): boolean {
  return /\b(create|add|new|insert|make)\b/.test(text(tool));
}

function isRead(tool: IngestedMcpTool): boolean {
  return /\b(get|read|retrieve|fetch|lookup|find|show|list|search)\b/.test(text(tool));
}

function isDestructive(tool: IngestedMcpTool): boolean {
  return /\b(delete|remove|destroy|archive)\b/.test(text(tool));
}

function idLike(name: string): boolean {
  return /(^id$|_id$|Id$|gid|key$)/.test(name);
}

function identityLike(name: string): boolean {
  return /^(name|title|label|text|summary)$/i.test(name);
}

function resourceTokens(tool: IngestedMcpTool): Set<string> {
  return new Set(tool.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) =>
    w && !["create", "add", "new", "insert", "make", "get", "read", "retrieve", "fetch", "lookup", "find", "show", "list", "search", "delete", "remove", "archive"].includes(w)
  ).map((w) => w.replace(/ies$/, "y").replace(/s$/, "")));
}

function hasReadback(create: IngestedMcpTool, reads: IngestedMcpTool[]): boolean {
  const c = resourceTokens(create);
  return reads.some((read) => {
    const r = resourceTokens(read);
    return Object.keys(props(read)).some(idLike) && [...c].some((token) => r.has(token));
  });
}

function finding(tool: IngestedMcpTool, category: McpToolSmellCategory, evidence: string, suggestion: string): McpToolFinding {
  return { tool: tool.name, category, evidence, suggestion: `[${category}] - ${suggestion}` };
}

export function auditMcpToolQuality(ingest: IngestedMcp): McpToolQualityAudit {
  const findings: McpToolFinding[] = [];
  const reads = ingest.tools.filter(isRead);
  for (const tool of ingest.tools) {
    const p = props(tool);
    const req = required(tool);
    if (tool.description.trim().length < 20) {
      findings.push(finding(tool, "DESCRIPTION", "Tool description is missing or too brief.", "Describe what the tool does, side effects, returned ids, and when to use it."));
    }
    if (Object.keys(p).length === 0) {
      findings.push(finding(tool, "INPUT_SCHEMA", "Tool has no structured input properties.", "Expose a JSON schema with typed properties and examples for every argument."));
    }
    if (Object.keys(p).length > 0 && req.length === 0 && (isCreate(tool) || isDestructive(tool))) {
      findings.push(finding(tool, "REQUIRED_FIELDS", "Write/destructive tool declares no required fields.", "Mark required identifiers and content fields as required in the input schema."));
    }
    if (isCreate(tool) && !Object.keys(p).some(identityLike)) {
      findings.push(finding(tool, "IDENTITY", "Create tool has no obvious name/title/text field for a task oracle.", "Include a stable human-readable identity field such as name or title."));
    }
    if (isCreate(tool) && !hasReadback(tool, reads)) {
      findings.push(finding(tool, "READBACK", "No matching read/list tool with an id-like argument was found.", "Expose a get/list tool that can read back resources created by this tool."));
    }
    if (isDestructive(tool) && !/confirm|irreversible|archive|delete/i.test(tool.description)) {
      findings.push(finding(tool, "DESTRUCTIVE", "Destructive tool is not clearly labeled in its description.", "State the destructive side effect and required confirmation/scope."));
    }
  }

  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<McpToolSmellCategory, number>;
  for (const f of findings) byCategory[f.category] += 1;
  const totalWeight = CATEGORIES.reduce((sum, c) => sum + WEIGHTS[c], 0) * Math.max(ingest.tools.length, 1);
  const smellWeight = findings.reduce((sum, f) => sum + WEIGHTS[f.category], 0);
  return {
    title: ingest.title,
    source: ingest.source,
    toolsAnalyzed: ingest.tools.length,
    totalFindings: findings.length,
    byCategory,
    score: Math.max(0, Math.round(100 * (1 - smellWeight / totalWeight))),
    findings,
  };
}

function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export function renderMcpToolQualitySection(audit: McpToolQualityAudit): string {
  const top = Object.entries(audit.byCategory)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `<tr><td>${esc(c)}</td><td>${esc(n)}</td></tr>`)
    .join("");
  const rows = audit.findings.slice(0, 30).map((f) => `
    <details class="ax-endpoint">
      <summary><code class="ax-code">${esc(f.tool)}</code> <span class="ax-tags"><span class="ax-tag">${esc(f.category)}</span></span></summary>
      <div class="ax-smell"><div class="ax-smell__head">${esc(f.evidence)}</div><p class="ax-smell__fix">${esc(f.suggestion)}</p></div>
    </details>`).join("");
  return `<section class="ax-section" id="mcp-tool-quality">
    <h2>MCP tool quality</h2>
    <p class="ax-note">Score ${esc(audit.score)}/100 across ${esc(audit.toolsAnalyzed)} MCP tool(s). This checks whether <code class="ax-code">tools/list</code> is self-describing enough for agents to choose tools, fill arguments, and verify work through MCP read-back.</p>
    ${top ? `<table class="ax-table"><thead><tr><th>Finding category</th><th>Tools</th></tr></thead><tbody>${top}</tbody></table>` : `<p class="ax-empty">No MCP tool-quality findings.</p>`}
    ${rows}
  </section>`;
}

export function renderMcpToolQualityHtml(audit: McpToolQualityAudit): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>MCP tool quality — ${esc(audit.title)}</title><style>${REPORT_STYLE}</style></head><body><main class="ax-main">${renderMcpToolQualitySection(audit)}</main></body></html>`;
}
