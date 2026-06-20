/**
 * The review gate.
 *
 * Generated tasks + oracles (and, later, setup/reset) are executable intent that
 * may call a live product. Mutating packs run against a developer sandbox;
 * stateless/search packs may only read/query. Nothing may run un-reviewed: a
 * human must read the generated set and explicitly approve it. This is the
 * credibility + safety gate — no AI-approves-AI.
 *
 * Enforcement is content-addressed: approval records a hash of the reviewable
 * fields. If the pack changes after approval, the hash no longer matches and the
 * gate re-closes, so an edit can't sneak past a stale approval.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { OracleSpec, TargetPack, Task } from "../schemas.js";

/** Oracle confidence tier: T1 strong (round-trip), T2 weak
 *  (existence / 2xx), T3 curated (human-authored). We can only *derive* T1/T2
 *  from the spec; T3 is a label a human applies. */
export function oracleTier(o: OracleSpec): { tier: "T1" | "T2"; confidence: "high" | "low"; why: string } {
  if (o.type === "roundtrip") {
    return { tier: "T1", confidence: "high", why: "round-trips the created resource and asserts a field" };
  }
  if (o.type === "exists") {
    return { tier: "T2", confidence: "low", why: "existence-only — does not assert the created content" };
  }
  return { tier: "T2", confidence: "low", why: `'${o.type}' over reported state` };
}

/** Canonical JSON (sorted keys) so the hash is stable across load/serialize. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = canonical((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/** The subset of a pack a human is actually approving: what the agent will be
 *  told to do (tasks/prompts/surfaces), how success is judged (oracles), the
 *  discovery probe, and the credential/sandbox surface it will touch. */
function reviewableContent(pack: TargetPack): unknown {
  return canonical({
    standard_set_version: pack.standard_set_version,
    base_url: pack.base_url,
    auth: pack.auth ?? null,
    sandbox_scope: pack.sandbox_scope,
    discovery: pack.discovery ?? null,
    tasks: pack.tasks.map((t) => ({
      id: t.id,
      difficulty: t.difficulty,
      prompt: t.prompt,
      allowed_surfaces: t.allowed_surfaces,
      create_path: t.create_path ?? null,
      oracles: t.oracles,
    })),
  });
}

export function packContentHash(pack: TargetPack): string {
  return createHash("sha256").update(JSON.stringify(reviewableContent(pack))).digest("hex").slice(0, 16);
}

export interface Approval {
  standard_set_version: string;
  content_hash: string;
  approved_by: string;
  approved_at: string;
  task_count: number;
}

/** Sidecar lives next to the pack so it travels (and diffs) with it. */
export function approvalPath(packPath: string): string {
  return packPath.replace(/\.ya?ml$/i, "") + ".approval.json";
}

export function readApproval(packPath: string): Approval | null {
  const p = approvalPath(packPath);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Approval;
  } catch {
    return null;
  }
}

export function writeApproval(packPath: string, pack: TargetPack, approvedBy: string): Approval {
  const approval: Approval = {
    standard_set_version: pack.standard_set_version,
    content_hash: packContentHash(pack),
    approved_by: approvedBy,
    approved_at: new Date().toISOString(),
    task_count: pack.tasks.length,
  };
  writeFileSync(approvalPath(packPath), JSON.stringify(approval, null, 2) + "\n");
  return approval;
}

/** Whether this exact pack content has been approved. Returns a reason when not,
 *  so the CLI can tell "never reviewed" from "changed since approval". */
export function checkApproval(pack: TargetPack, packPath: string): { ok: boolean; reason?: string } {
  const approval = readApproval(packPath);
  if (!approval) return { ok: false, reason: "no approval on file — this pack has not been reviewed" };
  const hash = packContentHash(pack);
  if (approval.content_hash !== hash) {
    return {
      ok: false,
      reason: `pack changed since approval (approved ${approval.content_hash}, now ${hash}) — re-review required`,
    };
  }
  return { ok: true };
}

export interface PackQaIssue {
  taskId: string;
  severity: "warn";
  code: "free-choice-bound-oracle" | "prompt-oracle-resource-mismatch" | "surface-risk" | "ambiguous-reported-id";
  message: string;
}

const FREE_CHOICE_PATTERNS = [
  /\bchoose (?:an? )?(?:appropriate|right|suitable)\b/i,
  /\bdecide (?:the|an?)? ?(?:right|appropriate|suitable)\b/i,
  /\bchoose .*structure\b/i,
  /\bdecide .*object\b/i,
];

const RESOURCE_TERMS: Array<{ resource: string; labels: string[]; pattern: RegExp }> = [
  { resource: "pages", labels: ["page"], pattern: /\b(?:page|child page|note)\b/i },
  { resource: "databases", labels: ["database"], pattern: /\bdatabase\b/i },
  { resource: "data_sources", labels: ["data source"], pattern: /\bdata[- ]source\b/i },
  { resource: "comments", labels: ["comment"], pattern: /\bcomment\b/i },
  { resource: "views", labels: ["view"], pattern: /\bview\b/i },
];

function oracleResource(o: OracleSpec): string | undefined {
  const path = o.readPathTemplate ?? "";
  const m = path.match(/^\/v\d+\/([^/{?]+)/);
  return m?.[1];
}

function promptResources(task: Task): Set<string> {
  const out = new Set<string>();
  for (const r of RESOURCE_TERMS) {
    if (r.pattern.test(task.prompt)) out.add(r.resource);
  }
  return out;
}

function resourceLabel(resource: string | undefined): string {
  if (!resource) return "unknown resource";
  return RESOURCE_TERMS.find((r) => r.resource === resource)?.labels[0] ?? resource;
}

function isFreeChoicePrompt(task: Task): boolean {
  return FREE_CHOICE_PATTERNS.some((p) => p.test(task.prompt));
}

function allExecutionSurfaces(task: Task): boolean {
  return ["api", "cli", "sdk", "mcp"].every((s) => task.allowed_surfaces.includes(s));
}

function taskMentionsAdvancedNotionObjects(task: Task): boolean {
  return /\bdata[- ]source\b/i.test(task.prompt)
    || /\bview\b/i.test(task.prompt)
    || task.oracles.some((o) => /\/v\d+\/(?:data_sources|views)\//.test(o.readPathTemplate ?? ""));
}

function hasAmbiguousReportId(task: Task, resources: Set<string>): boolean {
  const prompt = task.prompt.toLowerCase();
  if (!/\breport (?:the )?(?:new |created )?.*\bid\b/.test(prompt)) return false;
  if (/\breport (?:the )?(?:new |created )?(?:page|child page|database|data[- ]source|comment|view|entry|item) id\b/.test(prompt)) {
    return false;
  }
  if (/\bnot the\b/.test(prompt) || /\bonly\b/.test(prompt)) return false;
  return resources.size > 1 && (/\bthen\b/.test(prompt) || /\band\b/.test(prompt));
}

/** Heuristic QA for generated/hand-authored packs. These checks are advisory:
 *  they catch prompt↔oracle contract smells before live runs, but do not close
 *  the approval gate because product surfaces use diverse terminology. */
export function packQaIssues(pack: TargetPack): PackQaIssue[] {
  const issues: PackQaIssue[] = [];
  for (const task of pack.tasks) {
    const resources = promptResources(task);
    const oracleResources = new Set(task.oracles.map(oracleResource).filter((r): r is string => !!r));
    const freeChoice = isFreeChoicePrompt(task);

    if (freeChoice && oracleResources.size === 1) {
      const only = [...oracleResources][0];
      issues.push({
        taskId: task.id,
        severity: "warn",
        code: "free-choice-bound-oracle",
        message:
          `Prompt lets the agent choose the object/structure, but all round-trip oracles read ` +
          `${resourceLabel(only)}. Make the prompt explicit or accept every valid structure.`,
      });
    }

    if (!freeChoice && resources.size > 0 && oracleResources.size > 0) {
      for (const r of oracleResources) {
        if (!resources.has(r)) {
          issues.push({
            taskId: task.id,
            severity: "warn",
            code: "prompt-oracle-resource-mismatch",
            message:
              `Prompt appears to ask for ${[...resources].map(resourceLabel).join(", ")}, ` +
              `but an oracle reads ${resourceLabel(r)}. Confirm the reported id and read-back endpoint match.`,
          });
        }
      }
    }

    if (allExecutionSurfaces(task) && taskMentionsAdvancedNotionObjects(task)) {
      issues.push({
        taskId: task.id,
        severity: "warn",
        code: "surface-risk",
        message:
          `Task is enabled on API/CLI/SDK/MCP and uses data source/view concepts. ` +
          `Confirm every declared surface can create and report the same resource id shape.`,
      });
    }

    if (hasAmbiguousReportId(task, resources)) {
      issues.push({
        taskId: task.id,
        severity: "warn",
        code: "ambiguous-reported-id",
        message:
          `Prompt mentions multiple resource types and asks to report an id. ` +
          `Specify exactly which id to report (for example child page id vs database id vs view id).`,
      });
    }
  }
  return issues;
}

/** Human-readable summary of what is being approved, grouped by difficulty and
 *  flagged by oracle tier so weak checks can't masquerade as strong ones. */
export function reviewSummary(pack: TargetPack): string {
  const lines: string[] = [];
  lines.push(`# Review — ${pack.name} (standard_set ${pack.standard_set_version || "unversioned"})`, "");
  const scoped = pack.sandbox_scope.length > 0;
  lines.push(
    scoped
      ? `Approving this set authorizes ${pack.tasks.length} task(s) to run live operations against the sandbox named by its credential/scope. Read every task + oracle before approving.`
      : `Approving this set authorizes ${pack.tasks.length} task(s) to call the live product with the declared credential. No sandbox scope is declared; read every task + oracle before approving.`,
    "",
  );

  lines.push("## Credential + sandbox surface (what it will touch)", "");
  if (pack.auth) {
    lines.push(`- auth: \`${pack.auth.type}\` via env \`${pack.auth.env}\`${pack.auth.verify_env ? ` (verify: \`${pack.auth.verify_env}\`)` : ""}`);
  } else {
    lines.push(`- auth: (legacy Asana env fallback)`);
  }
  if (pack.sandbox_scope.length === 0) {
    lines.push(`- sandbox_scope: none declared (a single account/key is the whole sandbox)`);
  } else {
    for (const s of pack.sandbox_scope) {
      lines.push(`- sandbox ${s.name}: env \`${s.env}\`${s.required ? "" : " (optional)"} — ${s.instructions || "(no instructions)"}`);
    }
  }
  lines.push("");

  const qa = packQaIssues(pack);
  lines.push("## Pack QA", "");
  if (qa.length === 0) {
    lines.push("- No prompt/oracle contract warnings detected.", "");
  } else {
    lines.push(
      `- ⚠ ${qa.length} warning(s). Review these before approving; they often mean the task prompt, oracle, difficulty, or allowed surfaces need tightening.`,
      "",
    );
    for (const issue of qa) {
      lines.push(`- [${issue.code}] \`${issue.taskId}\`: ${issue.message}`);
    }
    lines.push("");
  }

  // Tier tally so the reviewer sees the strong/weak mix at a glance.
  const tally: Record<string, number> = {};
  for (const t of pack.tasks) for (const o of t.oracles) tally[oracleTier(o).tier] = (tally[oracleTier(o).tier] ?? 0) + 1;
  lines.push(
    `## Tasks (${pack.tasks.length}) — oracles: ${Object.entries(tally).map(([k, v]) => `${v}×${k}`).join(", ") || "none"}`,
    "",
  );
  for (const t of pack.tasks) {
    lines.push(`### [${t.difficulty}] ${t.id}`);
    lines.push(`surfaces: \`${t.allowed_surfaces.join(", ") || "any"}\``);
    lines.push("```");
    lines.push(t.prompt.trim());
    lines.push("```");
    if (t.oracles.length === 0) {
      lines.push("- ⚠ NO ORACLE — success can't be verified; reject or add one.");
    }
    for (const o of t.oracles) {
      const { tier, confidence, why } = oracleTier(o);
      const aliases = o.expectedAny?.length ? ` (+${o.expectedAny.length} accepted alias${o.expectedAny.length === 1 ? "" : "es"})` : "";
      const mode = o.matchMode ? ` mode=${o.matchMode}` : "";
      const target = o.assertField ? ` assert \`${o.assertField}\`=${JSON.stringify(o.expected)}${aliases}${mode}` : "";
      lines.push(`- [${tier}/${confidence}] ${o.type}${target} — ${why}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
