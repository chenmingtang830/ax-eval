import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { TargetPackSchema, type GeneratorProvenance, type TargetPack } from "../schemas.js";

export interface GeneratorHarnessConfig {
  harness: string;
  model?: string;
  effort?: "low" | "medium" | "high";
  timeoutMs?: number;
}

export interface AuthorPackWithLlmOptions {
  product: string;
  spec: unknown;
  seed: TargetPack;
  provenance: GeneratorProvenance;
  harness: GeneratorHarnessConfig;
  authoringHints?: string[];
}

export interface AuthoringValidationResult {
  errors: string[];
}

function surfaceTaskCounts(pack: TargetPack): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const task of pack.tasks) {
    for (const surface of task.allowed_surfaces) {
      counts.set(surface, (counts.get(surface) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function taskSummary(pack: TargetPack): unknown {
  return pack.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    difficulty: t.difficulty,
    prompt: t.prompt,
    allowed_surfaces: t.allowed_surfaces,
    oracles: t.oracles,
    trace: t.trace ?? [],
  }));
}

function buildPromptHeader(product: string, seed: TargetPack): string[] {
  const counts = surfaceTaskCounts(seed).map(([surface, count]) => `  - ${surface}: ${count}`).join("\n");
  return [
    `You are the ax-eval pack generator for ${product}.`,
    "",
    "Create one product-quality TargetPack JSON object. Return ONLY valid JSON: no markdown, no commentary.",
    "",
    "Generation model:",
    "- ax-eval code owns hard constraints, schema validity, and review-gate behavior.",
    "- Your job is fuzzy planning: choose better tasks, improve prompts, preserve surface-aware realism, and extract auth/discovery details from the provided inputs.",
    "- Do not weaken the seed's surface coverage or metadata fidelity.",
    "",
    "Minimum per-surface coverage to preserve from the seed:",
    counts || "  - api: 0",
    "",
    "Hard requirements:",
    "- Preserve the target product, auth env names, base URL, surfaces, docs URLs, and discovery shape unless the seed is clearly wrong.",
    "- Preserve or improve the seed's task coverage for each declared execution surface.",
    "- Include L1, L2, L3, and L4 tasks, with at least one L4 task.",
    "- Prompts must be goal-level: do not hand the agent a curl command or exact endpoint implementation steps.",
    "- Every task must have at least one programmatic oracle.",
    "- For stateless search/read APIs, use roundtrip POST read-back oracles where appropriate, with readMethod/readPathTemplate/readBodyTemplate.",
    "- For URL assertions, prefer matchMode:\"url\" and include expectedAny aliases for canonical-equivalent, versioned, anchor, or redirect URLs that should count as the same correct source.",
    "- Do not include secrets or secret values. Use only env-var names.",
    "- Keep generated_by/generator fields if present; the CLI will normalize provenance after validation.",
  ];
}

export function buildGeneratorPrompt(product: string, spec: unknown, seed: TargetPack, authoringHints: string[] = []): string {
  const specSummary = JSON.stringify({
    source: (spec as { source?: unknown }).source,
    title: (spec as { title?: unknown }).title,
    baseUrl: (spec as { baseUrl?: unknown }).baseUrl,
    auth: (spec as { auth?: unknown }).auth,
    constantHeaders: (spec as { constantHeaders?: unknown }).constantHeaders,
    resources: (spec as { resources?: unknown }).resources,
  }, null, 2);
  const seedJson = JSON.stringify({
    ...seed,
    tasks: taskSummary(seed),
  }, null, 2);
  const hints = authoringHints.length
    ? ["", "Preset guidance:", ...authoringHints.map((hint) => `- ${hint}`)]
    : [];
  return [
    ...buildPromptHeader(product, seed),
    ...hints,
    "",
    "Ingested spec summary:",
    specSummary,
    "",
    "Seed pack JSON to improve or preserve:",
    seedJson,
  ].join("\n");
}

function buildRepairPrompt(
  product: string,
  spec: unknown,
  seed: TargetPack,
  attempted: TargetPack,
  validation: AuthoringValidationResult,
  authoringHints: string[] = [],
): string {
  const attemptedJson = JSON.stringify({ ...attempted, tasks: taskSummary(attempted) }, null, 2);
  const repairHints = validation.errors.map((error) => `- ${error}`);
  return [
    buildGeneratorPrompt(product, spec, seed, authoringHints),
    "",
    "The previous draft failed programmatic validation. Repair it without weakening the seed.",
    "Validation errors:",
    ...repairHints,
    "",
    "Previous invalid draft:",
    attemptedJson,
  ].join("\n");
}

export function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return extractJsonObject(fenced[1]);
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  throw new Error("generator harness did not return a JSON object");
}

export function normalizeHarnessText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.result === "string") return parsed.result;
    if (typeof parsed.message === "string") return parsed.message;
    if (typeof parsed.output === "string") return parsed.output;
  } catch {
    // Plain JSON pack or plain text; extractJsonObject handles both.
  }
  return trimmed;
}

function takeFixturePath(): string | undefined {
  const sequence = process.env.AX_EVAL_GENERATOR_FIXTURE_SEQUENCE?.trim();
  if (sequence) {
    const parts = sequence.split(",").map((part) => part.trim()).filter(Boolean);
    const [current, ...rest] = parts;
    if (rest.length) process.env.AX_EVAL_GENERATOR_FIXTURE_SEQUENCE = rest.join(",");
    else delete process.env.AX_EVAL_GENERATOR_FIXTURE_SEQUENCE;
    return current;
  }
  return process.env.AX_EVAL_GENERATOR_FIXTURE;
}

export function runGeneratorHarness(prompt: string, harness: GeneratorHarnessConfig): string {
  const fixture = takeFixturePath();
  if (fixture) return readFileSync(fixture, "utf8");

  if (harness.harness === "codex") {
    const dir = mkdtempSync(resolve(tmpdir(), "ax-generator-"));
    const outPath = resolve(dir, "pack.json");
    const modelArgs = harness.model ? ["-m", harness.model] : [];
    const effortArgs = harness.effort ? ["-c", `model_reasoning_effort=${harness.effort}`] : [];
    const res = spawnSync("codex", [
      "exec",
      "--sandbox", "workspace-write",
      "-c", "sandbox_workspace_write.network_access=true",
      "--json",
      ...modelArgs,
      ...effortArgs,
      "--output-last-message", outPath,
      prompt,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      timeout: harness.timeoutMs ?? 120_000,
    });
    if (res.error || (res.status ?? 1) !== 0) {
      throw new Error(`generator harness codex failed: ${res.error?.message || res.stderr || `exit ${res.status}`}`);
    }
    return existsSync(outPath) ? readFileSync(outPath, "utf8") : res.stdout;
  }

  if (harness.harness === "claude-code") {
    const modelArgs = harness.model ? ["--model", harness.model] : [];
    const res = spawnSync("claude", ["-p", prompt, "--output-format", "json", ...modelArgs], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      timeout: harness.timeoutMs ?? 120_000,
    });
    if (res.error || (res.status ?? 1) !== 0) {
      throw new Error(`generator harness claude-code failed: ${res.error?.message || res.stderr || `exit ${res.status}`}`);
    }
    return normalizeHarnessText(res.stdout);
  }

  throw new Error(`generator harness ${harness.harness} cannot be invoked headlessly; pass --generator-harness codex|claude-code`);
}

export function validateGeneratedPack(seed: TargetPack, pack: TargetPack): AuthoringValidationResult {
  const errors: string[] = [];
  const packCounts = new Map(surfaceTaskCounts(pack));
  if (seed.base_url && pack.base_url !== seed.base_url) {
    errors.push(`base_url changed from ${seed.base_url} to ${pack.base_url ?? "<missing>"}`);
  }
  if (seed.site_url && pack.site_url !== seed.site_url) {
    errors.push(`site_url changed from ${seed.site_url} to ${pack.site_url ?? "<missing>"}`);
  }
  const seedDocs = new Set(seed.docs_urls ?? []);
  const packDocs = new Set(pack.docs_urls ?? []);
  for (const url of seedDocs) {
    if (!packDocs.has(url)) errors.push(`docs_urls is missing seed doc ${url}`);
  }
  if (!seed.auth || !pack.auth) {
    errors.push("auth metadata is missing");
  } else if (seed.auth.env !== pack.auth.env || seed.auth.type !== pack.auth.type || seed.auth.header !== pack.auth.header) {
    errors.push("auth metadata drifted from the seed");
  }
  const seedSurfaceKeys = Object.keys(seed.surfaces ?? {}).sort();
  const packSurfaceKeys = Object.keys(pack.surfaces ?? {}).sort();
  if (seedSurfaceKeys.join(",") !== packSurfaceKeys.join(",")) {
    errors.push(`declared surfaces changed from [${seedSurfaceKeys.join(", ")}] to [${packSurfaceKeys.join(", ")}]`);
  }
  const packDifficulties = new Set(pack.tasks.map((task) => task.difficulty));
  for (const difficulty of ["L1", "L2", "L3", "L4"] as const) {
    if (!packDifficulties.has(difficulty)) errors.push(`missing ${difficulty} coverage`);
  }
  for (const [surface, seedCount] of surfaceTaskCounts(seed)) {
    const packCount = packCounts.get(surface) ?? 0;
    if (packCount < seedCount) {
      errors.push(`surface ${surface} only has ${packCount} tasks but the seed had ${seedCount}`);
    }
  }
  for (const task of pack.tasks) {
    if (!task.oracles.length) errors.push(`task ${task.id} is missing programmatic oracles`);
  }
  return { errors };
}

function parsePackJson(raw: string, provenance: GeneratorProvenance): TargetPack {
  const parsed = JSON.parse(extractJsonObject(normalizeHarnessText(raw)));
  return TargetPackSchema.parse({
    ...parsed,
    generated_by: "llm-assisted",
    generator: provenance,
  });
}

export function authorPackWithLlm(opts: AuthorPackWithLlmOptions): TargetPack {
  const seedWithProvenance = { ...opts.seed, generated_by: "llm-assisted", generator: opts.provenance };
  const prompt = buildGeneratorPrompt(opts.product, opts.spec, seedWithProvenance, opts.authoringHints);
  const firstDraft = parsePackJson(runGeneratorHarness(prompt, opts.harness), opts.provenance);
  if (process.env.AX_EVAL_GENERATOR_FIXTURE && !process.env.AX_EVAL_GENERATOR_FIXTURE_SEQUENCE) {
    return firstDraft;
  }
  const validation = validateGeneratedPack(opts.seed, firstDraft);
  if (!validation.errors.length) return firstDraft;

  const repairPrompt = buildRepairPrompt(
    opts.product,
    opts.spec,
    seedWithProvenance,
    firstDraft,
    validation,
    opts.authoringHints,
  );
  const repaired = parsePackJson(runGeneratorHarness(repairPrompt, opts.harness), opts.provenance);
  const repairedValidation = validateGeneratedPack(opts.seed, repaired);
  if (repairedValidation.errors.length) {
    throw new Error(`generator draft failed validation after repair: ${repairedValidation.errors.join("; ")}`);
  }
  return repaired;
}
