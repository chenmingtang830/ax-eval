import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { extractJsonObject, normalizeHarnessText } from "./generate/authoring.js";
import { Fetcher, type FetcherOptions } from "./static/fetcher.js";
import type { TargetPack, Task } from "./schemas.js";
import { describeRequiredEnv, surfaceAuthStatus, type EnvRequirement, type SurfaceAuthStatus } from "./target/config.js";
import { resolveSurfaceSelection } from "./surface/index.js";

export interface AutomationDiscoveryInput {
  company: string;
  site?: string;
  docs?: string[];
  openapi?: string;
  graphql?: string;
  harness: string;
  offline?: boolean;
}

export interface AutomationManifest {
  schema: "ax.automation-manifest/v1";
  company: string;
  slug: string;
  run_dir: string;
  generated_at: string;
  discovery: {
    source: "explicit" | "fixture" | "harness" | "guesses";
    confidence: "high" | "medium" | "low";
    site_url?: string;
    docs_urls: string[];
    openapi_url?: string;
    graphql_url?: string;
    auth_notes: string[];
    surface_notes: string[];
    warnings: string[];
  };
  artifacts: Record<string, string>;
  next_steps: string[];
}

export interface SmokeTaskSelection {
  tasks: Task[];
  skipped: Array<{ taskId: string; reason: string }>;
}

interface RawDiscoveryCandidate {
  site_url?: string;
  docs_urls?: string[];
  openapi_url?: string;
  graphql_url?: string;
  auth_notes?: string[];
  surface_notes?: string[];
}

export function slugifyAutomationName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "target";
}

function unique(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v && v.trim())).map((v) => v.trim()))];
}

function isHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeRawCandidate(raw: unknown): RawDiscoveryCandidate {
  const obj = raw as Record<string, unknown>;
  return {
    site_url: typeof obj.site_url === "string" ? obj.site_url : undefined,
    docs_urls: Array.isArray(obj.docs_urls) ? obj.docs_urls.filter((v): v is string => typeof v === "string") : [],
    openapi_url: typeof obj.openapi_url === "string" ? obj.openapi_url : undefined,
    graphql_url: typeof obj.graphql_url === "string" ? obj.graphql_url : undefined,
    auth_notes: Array.isArray(obj.auth_notes) ? obj.auth_notes.filter((v): v is string => typeof v === "string") : [],
    surface_notes: Array.isArray(obj.surface_notes) ? obj.surface_notes.filter((v): v is string => typeof v === "string") : [],
  };
}

function readFixtureCandidate(): RawDiscoveryCandidate | null {
  const path = process.env.AX_EVAL_AUTOMATION_DISCOVERY_FIXTURE;
  if (!path) return null;
  return normalizeRawCandidate(JSON.parse(readFileSync(path, "utf8")));
}

function buildDiscoveryPrompt(company: string): string {
  return [
    `Find ${company}'s official developer documentation and API machine-readable specs.`,
    "",
    "Return ONLY a JSON object with this exact shape:",
    "{",
    "  \"site_url\": \"https://official developer or docs root\",",
    "  \"docs_urls\": [\"https://official docs pages\"],",
    "  \"openapi_url\": \"https://official OpenAPI JSON/YAML URL, if any\",",
    "  \"graphql_url\": \"https://official GraphQL endpoint or schema URL, if any\",",
    "  \"auth_notes\": [\"short notes about API keys, OAuth, workspace ids, sandbox setup\"],",
    "  \"surface_notes\": [\"short notes about API, CLI, SDK, MCP availability\"]",
    "}",
    "",
    "Use only official company-owned documentation. Do not use Exa or any Exa API.",
  ].join("\n");
}

function runHarnessDiscovery(company: string, harness: string, timeoutMs = 30000): RawDiscoveryCandidate | null {
  const prompt = buildDiscoveryPrompt(company);
  if (harness === "codex") {
    const tempDir = mkdtempSync(resolve(tmpdir(), "ax-automation-discovery-"));
    try {
      const outPath = resolve(tempDir, "last-message.json");
      const res = spawnSync("codex", [
        "exec",
        "--sandbox", "workspace-write",
        "-c", "sandbox_workspace_write.network_access=true",
        "--json",
        "--output-last-message", outPath,
        prompt,
      ], { cwd: process.cwd(), encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: timeoutMs });
      if (res.error || (res.status ?? 1) !== 0) return null;
      const raw = existsSync(outPath) ? readFileSync(outPath, "utf8") : normalizeHarnessText(res.stdout);
      const parsed = JSON.parse(extractJsonObject(normalizeHarnessText(raw)));
      return normalizeRawCandidate(parsed);
    } catch {
      return null;
    } finally {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
  if (harness === "claude-code") {
    const res = spawnSync("claude", ["-p", prompt, "--output-format", "json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: timeoutMs,
    });
    if (res.error || (res.status ?? 1) !== 0) return null;
    try {
      const parsed = JSON.parse(extractJsonObject(normalizeHarnessText(res.stdout)));
      return normalizeRawCandidate(parsed);
    } catch {
      return null;
    }
  }
  return null;
}

function guessedUrls(company: string): RawDiscoveryCandidate {
  const slug = slugifyAutomationName(company).replace(/-/g, "");
  const roots = unique([
    `https://developers.${slug}.com`,
    `https://developer.${slug}.com`,
    `https://docs.${slug}.com`,
    `https://${slug}.com/developers`,
    `https://${slug}.com/docs`,
    `https://${slug}.com/api`,
  ]);
  return {
    site_url: roots[0],
    docs_urls: roots,
    openapi_url: `https://developers.${slug}.com/openapi.json`,
    auth_notes: [],
    surface_notes: [],
  };
}

async function urlOk(fetcher: Fetcher, url: string): Promise<boolean> {
  if (!isHttpUrl(url)) return existsSync(url);
  const r = await fetcher.get(url);
  return r.ok && r.body.trim().length > 0;
}

async function specOk(fetcher: Fetcher, url: string): Promise<boolean> {
  if (!isHttpUrl(url)) return existsSync(url);
  const r = await fetcher.get(url);
  return r.ok && /["']?(openapi|swagger)["']?\s*[:=]/i.test(r.body.slice(0, 20000));
}

function mergeCandidates(...candidates: RawDiscoveryCandidate[]): RawDiscoveryCandidate {
  return {
    site_url: candidates.find((c) => c.site_url)?.site_url,
    docs_urls: unique(candidates.flatMap((c) => c.docs_urls ?? [])),
    openapi_url: candidates.find((c) => c.openapi_url)?.openapi_url,
    graphql_url: candidates.find((c) => c.graphql_url)?.graphql_url,
    auth_notes: unique(candidates.flatMap((c) => c.auth_notes ?? [])),
    surface_notes: unique(candidates.flatMap((c) => c.surface_notes ?? [])),
  };
}

export async function discoverAutomationTarget(
  input: AutomationDiscoveryInput,
  opts: FetcherOptions = {},
): Promise<AutomationManifest["discovery"]> {
  const warnings: string[] = [];
  const explicit: RawDiscoveryCandidate = {
    site_url: input.site,
    docs_urls: input.docs ?? [],
    openapi_url: input.openapi,
    graphql_url: input.graphql,
    auth_notes: [],
    surface_notes: [],
  };
  let source: AutomationManifest["discovery"]["source"] = "explicit";
  let candidate = explicit;

  if (!candidate.openapi_url && !candidate.graphql_url) {
    const fixture = readFixtureCandidate();
    if (fixture) {
      source = "fixture";
      candidate = mergeCandidates(explicit, fixture);
    } else if (!input.offline) {
      const harnessCandidate = runHarnessDiscovery(input.company, input.harness, opts.timeoutMs);
      if (harnessCandidate) {
        source = "harness";
        candidate = mergeCandidates(explicit, harnessCandidate);
      } else {
        warnings.push(`Could not get official docs candidates from ${input.harness}; trying common official URL guesses.`);
        source = "guesses";
        candidate = mergeCandidates(explicit, guessedUrls(input.company));
      }
    } else {
      source = "guesses";
      candidate = mergeCandidates(explicit, guessedUrls(input.company));
    }
  }

  const fetcher = new Fetcher({ ...opts, mode: input.offline ? "fixture" : opts.mode });
  const siteCandidates = unique([candidate.site_url, ...(candidate.docs_urls ?? [])]);
  let siteUrl: string | undefined;
  for (const url of siteCandidates) {
    if (await urlOk(fetcher, url)) {
      siteUrl = url;
      break;
    }
  }
  const docsUrls: string[] = [];
  for (const url of candidate.docs_urls ?? []) {
    if (await urlOk(fetcher, url)) docsUrls.push(url);
  }
  let openapiUrl: string | undefined;
  if (candidate.openapi_url && await specOk(fetcher, candidate.openapi_url)) {
    openapiUrl = candidate.openapi_url;
  } else if (candidate.openapi_url) {
    warnings.push(`Rejected OpenAPI candidate because it did not validate as an OpenAPI document: ${candidate.openapi_url}`);
  }
  let graphqlUrl: string | undefined;
  if (candidate.graphql_url && (isHttpUrl(candidate.graphql_url) || existsSync(candidate.graphql_url))) {
    graphqlUrl = candidate.graphql_url;
  }

  const confidence: AutomationManifest["discovery"]["confidence"] =
    openapiUrl || graphqlUrl ? "high" : siteUrl || docsUrls.length ? "medium" : "low";

  return {
    source,
    confidence,
    site_url: siteUrl,
    docs_urls: docsUrls,
    openapi_url: openapiUrl,
    graphql_url: graphqlUrl,
    auth_notes: candidate.auth_notes ?? [],
    surface_notes: candidate.surface_notes ?? [],
    warnings,
  };
}

export function automationGeneratedAt(now = new Date()): string {
  const fixed = process.env.AX_EVAL_AUTOMATION_NOW?.trim();
  if (fixed) return fixed;
  return now.toISOString();
}

export function buildEnvChecklist(pack: TargetPack, surfaceArg: string | undefined): string {
  const reqs = describeRequiredEnv(pack);
  const statuses: SurfaceAuthStatus[] = surfaceArg ? resolveSurfaceSelection(pack, surfaceArg)
    .filter((s) => s !== "api")
    .map((s) => surfaceAuthStatus(pack, s))
    : [];
  const lines = [`Required configuration for ${pack.name}:`];
  const emitReq = (r: EnvRequirement) => {
    const flag = r.set ? "SET" : r.required ? "MISSING" : "optional";
    lines.push(`- ${flag}: ${r.env || "(unnamed env)"} (${r.role})${r.instructions ? ` — ${r.instructions}` : ""}`);
  };
  for (const r of reqs) emitReq(r);
  for (const s of statuses) {
    lines.push(``, `Surface ${s.surface} auth (${s.kind})${s.blocked ? ` — BLOCKED: ${s.blocked}` : ""}`);
    for (const r of s.requirements) emitReq(r);
    if (s.instructions) lines.push(`  ${s.instructions}`);
  }
  return lines.join("\n") + "\n";
}

export function hasMissingRequiredConfig(pack: TargetPack, surfaceArg: string | undefined): boolean {
  const missingTopLevel = describeRequiredEnv(pack).some((r) => r.required && !r.set);
  const missingSurface = surfaceArg ? resolveSurfaceSelection(pack, surfaceArg)
    .some((s) => s !== "api" && surfaceAuthStatus(pack, s).blocked)
    : false;
  return missingTopLevel || missingSurface;
}

export function writeAutomationManifest(path: string, manifest: AutomationManifest): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2));
}

export function writeShareSummary(path: string, manifest: AutomationManifest, reportPath?: string): void {
  const lines = [
    `# ${manifest.company} Agent Usability Report`,
    "",
    `- Run directory: \`${manifest.run_dir}\``,
    `- Discovery confidence: ${manifest.discovery.confidence}`,
    `- Docs: ${manifest.discovery.docs_urls.length ? manifest.discovery.docs_urls.join(", ") : "(not found)"}`,
    `- Spec: ${manifest.discovery.openapi_url ?? manifest.discovery.graphql_url ?? "(not found)"}`,
    reportPath ? `- Report: \`${reportPath}\`` : undefined,
    "",
    "## Next Steps",
    ...manifest.next_steps.map((s) => `- ${s}`),
    "",
  ].filter((v): v is string => Boolean(v));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join("\n"));
}

export function defaultAutomationRunDir(company: string): string {
  return resolve("results", "runs", slugifyAutomationName(company));
}

function asyncLifecycleLike(task: Task): boolean {
  const hay = [
    task.id,
    task.title,
    task.prompt,
    task.create_path,
    ...task.trace.map((t) => `${t.method ?? ""} ${t.path ?? ""} ${t.description ?? ""}`),
    ...task.oracles.map((o) => `${o.readMethod ?? "GET"} ${o.readPathTemplate ?? ""} ${o.readQueryTemplate ?? ""}`),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return /export|mutation status|poll|requestid|request id|content export/.test(hay);
}

function nestedLifecycle(task: Task): boolean {
  return task.difficulty === "L4" && task.depends_on.length > 0 && /\{[^}]+\}/.test(task.create_path ?? "");
}

function smokeTaskScore(task: Task): number {
  const difficultyScore: Record<Task["difficulty"], number> = {
    L1: 400,
    L2: 300,
    L3: 200,
    L4: 100,
  };
  const nestedCreate = /\{[^}]+\}/.test(task.create_path ?? "");
  const lifecyclePenalty = /lifecycle|rename|update/i.test(`${task.id} ${task.title} ${task.prompt}`) ? -35 : 0;
  return difficultyScore[task.difficulty]
    + (task.depends_on.length === 0 ? 30 : 10)
    + (!nestedCreate ? 25 : 0)
    + (task.oracles.some((o) => o.type === "roundtrip") ? 20 : -100)
    + lifecyclePenalty;
}

export function selectSmokeTasks(pack: TargetPack, maxTasks = 5): SmokeTaskSelection {
  const eligible: Task[] = [];
  const skipped: Array<{ taskId: string; reason: string }> = [];
  for (const task of pack.tasks) {
    if (!task.oracles.some((o) => o.type === "roundtrip")) {
      skipped.push({ taskId: task.id, reason: "no round-trip oracle" });
      continue;
    }
    if (asyncLifecycleLike(task)) {
      skipped.push({ taskId: task.id, reason: "async/export-style flow is poor smoke-gate material" });
      continue;
    }
    if (nestedLifecycle(task)) {
      skipped.push({ taskId: task.id, reason: "nested lifecycle tasks are too brittle for the initial smoke gate" });
      continue;
    }
    eligible.push(task);
  }
  const sorted = [...eligible].sort((a, b) => smokeTaskScore(b) - smokeTaskScore(a) || a.id.localeCompare(b.id));
  const selected: Task[] = [];
  const seen = new Set<string>();
  for (const difficulty of ["L1", "L2", "L3", "L4"] as const) {
    const match = sorted.find((task) => task.difficulty === difficulty && !seen.has(task.id));
    if (!match) continue;
    selected.push(match);
    seen.add(match.id);
    if (selected.length >= maxTasks) return { tasks: selected, skipped };
  }
  for (const task of sorted) {
    if (selected.length >= maxTasks) break;
    if (seen.has(task.id)) continue;
    selected.push(task);
    seen.add(task.id);
  }
  return { tasks: selected, skipped };
}
