import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { SurfaceId } from "../surface/types.js";
import { tasksForSurface } from "../surface/index.js";
import type { TargetPack } from "../schemas.js";
import { namedFieldsFor } from "./executor.js";
import { resolveEnvTemplate } from "../target/config.js";
import { parseJsonWithRecovery } from "../util/json-parse.js";
import { redactSensitiveText as redactCommonSensitiveText } from "../safety/redaction.js";

export type InvokeHarnessId = "claude-code" | "codex";

export const INVOKE_HARNESS_IDS: readonly InvokeHarnessId[] = ["claude-code", "codex"];

export function isInvokeHarnessId(value: unknown): value is InvokeHarnessId {
  return typeof value === "string" && (INVOKE_HARNESS_IDS as readonly string[]).includes(value);
}

export interface InvokeDetection {
  ok: boolean;
  command: string;
  version?: string;
  reason?: "missing-harness" | "detect-failed";
  detail?: string;
}

export interface InvokePaths {
  promptPath: string;
  resultsPath: string;
  tracePath: string;
  stdoutPath: string;
  stderrPath: string;
  transcriptPath: string;
  metaPath: string;
  codexSchemaPath?: string;
}

export interface InvokeRunOptions {
  pack: TargetPack;
  harness: InvokeHarnessId;
  profile: string;
  surface: SurfaceId;
  ns: string;
  paths: InvokePaths;
  cwd: string;
  /** Optional model slug to pass to the harness CLI (`claude --model`,
   *  `codex -m`). When set, this is what the agent actually runs as; when
   *  omitted, the harness uses its own configured default and we record the
   *  model it reports back. */
  model?: string;
  /** Canonical effort level. Translated to each harness's native convention at
   *  invocation: codex → `-c model_reasoning_effort=<level>` (the GPT/o-series
   *  convention); claude-code → `--effort <level>` on modern Claude Code. */
  effort?: "low" | "medium" | "high";
  /** Hard wall-clock cap per attempt, in milliseconds. When a harness child
   *  exceeds it, it is killed and the attempt counts as a timeout failure
   *  (eligible for a retry). 0 / undefined disables the cap. */
  timeoutMs?: number;
  /** Optional early cap for runs that never take a tool/action. Once an action
   *  is observed, only the normal wall-clock timeout applies. */
  firstActionTimeoutMs?: number;
  /** How many times to retry a failed or timed-out invocation before giving up.
   *  Default 1 (one retry → up to two attempts total); 0 disables retries. A
   *  retry re-runs the same prompt from a clean slate (any partial results file
   *  is removed first). */
  retries?: number;
  /** Env overrides for the harness child process. Used for isolated per-cell
   *  MCP config, not for secrets printed to prompts. */
  env?: Record<string, string>;
  /** Use `env` as the complete child environment instead of merging the
   * parent process environment. The one-cell runtime enables this so a cell
   * cannot see unrelated target or harness credentials. */
  replaceEnv?: boolean;
  /** Non-secret provisioning metadata written to the invoke meta artifact. */
  provisioning?: Record<string, unknown>;
  /** Result of the already-required harness detection probe. Passing it through
   *  avoids a second `--version` call and makes the detected version durable. */
  harnessDetection?: InvokeDetection;
  /** Stable identifier shared by comparable runs from the same execution batch. */
  runBatchId?: string;
}

export interface InvokeHarnessMetrics {
  harness_version_raw: string | null;
  harness_version_semver: string | null;
  run_batch_id: string | null;
  /** Successful attempt wall time (or the final failed attempt when none pass). */
  duration_ms: number | null;
  /** Wall time consumed by every attempt, including failed retries. */
  total_duration_ms: number;
  /** Native harness-reported dollars. Codex is intentionally null. */
  cost_usd: number | null;
  /** Native token counters summed across every attempt. */
  token_usage: Record<string, number> | null;
  num_turns: number | null;
}

export interface InvokeAttemptMetrics {
  attempt: number;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  ok: boolean;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
  timeout_reason?: "wall" | "first-action";
  cost_usd: number | null;
  token_usage: Record<string, number> | null;
  num_turns: number | null;
  harness_duration_ms: number | null;
}

export type InvokeValidityStatus =
  | "valid"
  | "partial"
  | "runtime_timeout_no_action"
  | "runtime_timeout_partial"
  | "invoke_failed"
  | "results_json_invalid";

export interface InvokeRunResult {
  harness: InvokeHarnessId;
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  profile?: string;
  surface?: SurfaceId;
  requestedModel?: string;
  effort?: InvokeRunOptions["effort"];
  stdoutPath: string;
  stderrPath: string;
  transcriptPath: string;
  metaPath: string;
  resultsPath: string;
  tracePath: string;
  error?: string;
  /** Attempts actually made (1 = succeeded or no retry; 2 = retried once). */
  attempts?: number;
  /** True when the final attempt was killed by the timeout cap. */
  timedOut?: boolean;
  timeoutReason?: "wall" | "first-action";
  /** Wall-clock duration for the full harness invocation, including retries. */
  durationMs?: number;
  /** Runtime-validity diagnostics. No-action timeouts are harness/runtime
   *  validity failures, not product capability failures. */
  validity_status?: InvokeValidityStatus;
  first_action_latency_ms?: number | null;
  transcript_event_count?: number;
  action_occurred?: boolean;
  metrics?: InvokeHarnessMetrics;
  attempt_metrics?: InvokeAttemptMetrics[];
}

// Sync spawn — used only for the quick `--version` detection probe.
type Spawn = (
  command: string,
  args: string[],
  options?: Parameters<typeof spawnSync>[2],
) => SpawnSyncReturns<Buffer>;

const DEFAULT_SPAWN: Spawn = (command, args, options) =>
  spawnSync(command, args, {
    ...options,
    encoding: "buffer",
    maxBuffer: 50 * 1024 * 1024,
  });

/** The outcome of a finished child process — the subset runInvokeHarness needs.
 *  (Same shape whether produced by sync spawnSync or the async runner.) */
export interface ProcResult {
  stdout: Buffer | string;
  stderr: Buffer | string;
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  /** True when the child was killed by the wall-clock timeout cap rather than
   *  exiting on its own. */
  timedOut?: boolean;
  timeoutReason?: "wall" | "first-action";
  firstActionLatencyMs?: number | null;
}

/** Async spawn — runs the harness without blocking the event loop, so multiple
 *  harness invocations can execute concurrently (the concurrency pool in
 *  exec-plan). Collects stdout/stderr and resolves when the process closes;
 *  never rejects (a spawn error resolves with `error` set, like spawnSync).
 *  An optional `timeoutMs` hard-caps the run: on expiry the child is sent
 *  SIGTERM (then SIGKILL after a short grace) and the result is flagged
 *  `timedOut` — this is what stops a wedged headless agent from hanging the
 *  whole matrix indefinitely. */
export type AsyncSpawn = (
  command: string,
  args: string[],
  cwd: string,
  opts?: {
    timeoutMs?: number;
    firstActionTimeoutMs?: number;
    env?: Record<string, string>;
    replaceEnv?: boolean;
    successPaths?: string[];
  },
) => Promise<ProcResult>;

export const DEFAULT_ASYNC_SPAWN: AsyncSpawn = (command, args, cwd, opts) =>
  new Promise<ProcResult>((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: opts?.replaceEnv ? (opts.env ?? {}) : opts?.env ? { ...process.env, ...opts.env } : process.env,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let timeoutReason: ProcResult["timeoutReason"] | undefined;
    let completedAfterOutputs = false;
    let killTimer: NodeJS.Timeout | undefined;
    let timer: NodeJS.Timeout | undefined;
    let firstActionTimer: NodeJS.Timeout | undefined;
    let outputPoll: NodeJS.Timeout | undefined;
    let outputReadyTimer: NodeJS.Timeout | undefined;
    let firstActionLatencyMs: number | null = null;
    const successPaths = opts?.successPaths?.filter(Boolean) ?? [];
    const outputsReady = () => successPaths.length > 0 && successPaths.every((p) => existsSync(p));
    const killChild = (signal: NodeJS.Signals) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          /* fall back to the direct child below */
        }
      }
      try {
        child.kill(signal);
      } catch {
        /* best effort */
      }
    };
    if (opts?.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        timeoutReason = "wall";
        killChild("SIGTERM");
        // If it ignores SIGTERM, hard-kill so the pool slot is freed.
        killTimer = setTimeout(() => killChild("SIGKILL"), 5000);
      }, opts.timeoutMs);
    }
    if (opts?.firstActionTimeoutMs && opts.firstActionTimeoutMs > 0) {
      firstActionTimer = setTimeout(() => {
        if (firstActionLatencyMs !== null || timedOut) return;
        timedOut = true;
        timeoutReason = "first-action";
        killChild("SIGTERM");
        killTimer = setTimeout(() => killChild("SIGKILL"), 5000);
      }, opts.firstActionTimeoutMs);
    }
    if (successPaths.length > 0) {
      outputPoll = setInterval(() => {
        if (!outputsReady()) {
          if (outputReadyTimer) {
            clearTimeout(outputReadyTimer);
            outputReadyTimer = undefined;
          }
          return;
        }
        if (outputReadyTimer) return;
        // Some wrapper CLIs keep helper processes alive briefly after the
        // required result artifacts have already been written. Once both files
        // exist, give the wrapper a short grace period, then terminate it so a
        // finished cell doesn't stall the serial matrix.
        outputReadyTimer = setTimeout(() => {
          if (timedOut || child.killed) return;
          completedAfterOutputs = true;
          killChild("SIGTERM");
          killTimer = setTimeout(() => killChild("SIGKILL"), 5000);
        }, 2000);
      }, 500);
    }
    const finish = (r: ProcResult) => {
      if (timer) clearTimeout(timer);
      if (firstActionTimer) clearTimeout(firstActionTimer);
      if (killTimer) clearTimeout(killTimer);
      if (outputPoll) clearInterval(outputPoll);
      if (outputReadyTimer) clearTimeout(outputReadyTimer);
      resolve({ ...r, firstActionLatencyMs, timeoutReason: r.timeoutReason ?? timeoutReason });
    };
    const observeAction = (d: Buffer) => {
      if (firstActionLatencyMs !== null) return;
      const s = d.toString("utf8");
      if (
        s.includes('"tool_use"') ||
        s.includes('"command_execution"') ||
        s.includes('"web_search"') ||
        s.includes('"Bash"') ||
        s.includes('"WebFetch"') ||
        s.includes('"WebSearch"')
      ) {
        firstActionLatencyMs = Date.now() - startedAt;
        if (firstActionTimer) {
          clearTimeout(firstActionTimer);
          firstActionTimer = undefined;
        }
      }
    };
    child.stdout?.on("data", (d: Buffer) => {
      out.push(d);
      observeAction(d);
    });
    child.stderr?.on("data", (d: Buffer) => err.push(d));
    child.on("error", (error) => finish({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), status: null, signal: null, error, timedOut, timeoutReason }));
    child.on("close", (status, signal) => {
      const afterOutputs = completedAfterOutputs && outputsReady();
      finish({
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
        status: afterOutputs ? 0 : status,
        signal: afterOutputs ? null : (signal ?? null),
        timedOut,
        timeoutReason,
      });
    });
  });

// AX_EVAL_CLAUDE_BIN / AX_EVAL_CODEX_BIN let callers bypass a PATH-shadowing
// wrapper (corp shims that inject env/behavior and break in isolated
// processes) — same escape hatch as generate/harness.ts's invokeHarness.
function commandFor(id: InvokeHarnessId): string {
  if (id === "claude-code") return process.env.AX_EVAL_CLAUDE_BIN || "claude";
  return process.env.AX_EVAL_CODEX_BIN || "codex";
}

function text(buf: Buffer | string | null | undefined): string {
  if (!buf) return "";
  return Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
}

const SECRET_ENV_NAME =
  /([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASS|PAT|DB_URL|DATABASE_URL|CONNECTION_STRING|URI|DSN|PRIVATE_KEY|JWT)[A-Z0-9_]*\s*=\s*)(["']?)[^\s"',}]+/gi;
const SECRET_JSON_FIELD =
  /(["']?(?:dsn|token|apiKey|api_key|secret|password|privateKey|private_key|accessToken|access_token)["']?\s*[:=]\s*)(["'])([^"']{12,})\2/gi;
const URL_USERINFO =
  /\b(https?:\/\/)[A-Za-z0-9._~%!$&'()*+,;=:-]{8,}@([A-Za-z0-9.-]+(?::\d+)?[^\s"'<>)]*)/gi;

/** Redact common credential shapes before writing harness artifacts. Recovery
 *  still uses raw in-memory stdout so structured result extraction remains
 *  lossless, but persisted logs/traces/meta must never carry live secrets. */
export function redactHarnessArtifactText(value: string): string {
  return redactCommonSensitiveText(value
    .replace(/\b(?:(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/)[^\s"'<>]+/gi, "<redacted-dsn>")
    .replace(URL_USERINFO, "$1<redacted>@$2")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g, "Bearer <redacted>")
    .replace(/\bnapi_[A-Za-z0-9_]*(?:(?:\\n|\s)+[A-Za-z0-9_]{8,})+/g, "<redacted-token>")
    .replace(/\bnapi_[A-Za-z0-9_]*(?:\s+[A-Za-z0-9_]{8,})+/g, "<redacted-token>")
    .replace(/\bnapi_[A-Za-z0-9_]{20,}/g, "<redacted-token>")
    .replace(/<redacted-token>(?:(?:\\n|\s)+[A-Za-z0-9_]{20,})/g, "<redacted-token>")
    .replace(/<redacted-token>\s+[A-Za-z0-9_]{20,}/g, "<redacted-token>")
    .replace(/\bsbp_[A-Za-z0-9_]{20,}/g, "<redacted-token>")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "<redacted-jwt>")
    .replace(SECRET_ENV_NAME, "$1$2<redacted>")
    .replace(SECRET_JSON_FIELD, "$1$2<redacted>$2"))
    .replace(/\[REDACTED\]/g, "<redacted>");
}

function writeRedactedFile(path: string, value: string): void {
  writeFileSync(path, redactHarnessArtifactText(value));
}

function redactFileIfExists(path: string): void {
  if (!existsSync(path)) return;
  writeRedactedFile(path, readFileSync(path, "utf8"));
}

function isInvokeHomePath(path: string): boolean {
  return path.split(/[\\/]/).includes(".invoke-home");
}

function redactInvokeHomeIfPresent(opts: InvokeRunOptions): void {
  const home = opts.env?.HOME;
  if (!home || !isInvokeHomePath(home) || !existsSync(home)) return;
  const visit = (path: string) => {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) visit(resolve(path, entry));
      return;
    }
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) return;
    try {
      const raw = readFileSync(path);
      if (raw.includes(0)) return;
      writeRedactedFile(path, raw.toString("utf8"));
    } catch {
      /* best effort: host CLI caches are evidence, not primary artifacts. */
    }
  };
  visit(home);
}

function detectWith(command: string, spawn: Spawn, env?: Record<string, string>): InvokeDetection {
  const res = spawn(command, ["--version"], { stdio: ["ignore", "pipe", "pipe"], env });
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      command,
      reason: code === "ENOENT" ? "missing-harness" : "detect-failed",
      detail: res.error.message,
    };
  }
  if ((res.status ?? 1) !== 0) {
    return {
      ok: false,
      command,
      reason: "detect-failed",
      detail: text(res.stderr) || `exit ${res.status}`,
    };
  }
  return { ok: true, command, version: (text(res.stdout) || text(res.stderr)).trim() };
}

export function detectInvokeHarness(
  id: InvokeHarnessId,
  spawn: Spawn = DEFAULT_SPAWN,
  env?: Record<string, string>,
  allowAmbientCommandOverride = true,
): InvokeDetection {
  const command = allowAmbientCommandOverride
    ? commandFor(id)
    : id === "claude-code" ? "claude" : "codex";
  return detectWith(command, spawn, env);
}

export function codexOutputSchema(pack: TargetPack, profile: string, surface: SurfaceId, ns: string): object {
  // OpenAI strict structured-output (codex `--output-schema`) requires EVERY
  // object to set `additionalProperties: false` and list ALL its properties in
  // `required`. A permissive (`additionalProperties: true`) or partially-required
  // object 400s with `invalid_json_schema` before the agent does anything — so the
  // discovery sub-object is fully specified rather than left free-form.
  const tasks = tasksForSurface(pack, surface);
  const scalar = { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }] };
  const taskProps = Object.fromEntries(tasks.map((t) => {
    const extra = namedFieldsFor(t);
    return [t.id, {
      type: "object",
      additionalProperties: false,
      properties: {
        gid: { anyOf: [{ type: "string" }, { type: "null" }] },
        ...Object.fromEntries(extra.map((field) => [field, scalar])),
      },
      required: ["gid", ...extra],
    }];
  }));
  const strArray = { type: "array", items: { type: "string" } };
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      profile: { type: "string", enum: [profile] },
      ns: { type: "string", enum: [ns] },
      surface: { type: "string", enum: [surface] },
      discovery: {
        type: "object",
        additionalProperties: false,
        properties: {
          base_url_found: { type: "string" },
          searches: strArray,
          urls_visited: strArray,
          endpoint_used: { type: "string" },
          auth_scheme_found: { type: "string" },
          notes: { type: "string" },
        },
        required: ["base_url_found", "searches", "urls_visited", "endpoint_used", "auth_scheme_found", "notes"],
      },
      results: {
        type: "object",
        additionalProperties: false,
        properties: taskProps,
        required: tasks.map((t) => t.id),
      },
    },
    required: ["profile", "ns", "surface", "discovery", "results"],
  };
}

function buildInvocation(id: InvokeHarnessId, prompt: string, opts: InvokeRunOptions): { command: string; args: string[] } {
  if (id === "claude-code") {
    const modelArgs = opts.model ? ["--model", opts.model] : [];
    const effortArgs = opts.effort ? ["--effort", opts.effort] : [];
    // stream-json emits the full event stream (assistant tool_use, tool_result,
    // …) to stdout, ending with a `type:result` line — so the transcript carries
    // REAL tool events for --observe discovery scoring, not just a summary blob.
    // Print mode requires --verbose for stream-json.
    return {
      command: opts.harnessDetection?.command ?? commandFor("claude-code"),
      args: ["-p", prompt, "--output-format", "stream-json", "--verbose", ...modelArgs, ...effortArgs],
    };
  }
  if (!opts.paths.codexSchemaPath) {
    throw new Error("codex invocation requires codexSchemaPath");
  }
  writeFileSync(
    opts.paths.codexSchemaPath,
    JSON.stringify(codexOutputSchema(opts.pack, opts.profile, opts.surface, opts.ns), null, 2),
  );
  const modelArgs = opts.model ? ["-m", opts.model] : [];
  // Codex/GPT convention: reasoning effort is a model config knob, passed via -c.
  const effortArgs = opts.effort ? ["-c", `model_reasoning_effort=${opts.effort}`] : [];
  // Invoked eval runs are fully non-interactive. Codex's exec path reads
  // approval policy from config-style `-c` overrides, not the interactive TUI
  // flag shape. If we leave the default in place, remote MCP write-tool calls
  // can collapse into "user cancelled MCP tool call" in headless runs.
  const approvalArgs = ["-c", 'approval_policy="never"'];
  // Non-MCP benchmark surfaces should not inherit the operator's global MCP
  // servers. A broken unrelated MCP login can otherwise stall API/CLI/SDK cells
  // and turn the benchmark into a local-config test.
  const mcpArgs = opts.surface === "mcp" ? [] : ["-c", "mcp_servers={}"];
  // The eval REQUIRES outbound network (the agent calls the product's API / MCP
  // server and web-searches in discovery). codex's `workspace-write` sandbox
  // denies network by default (`network_access: false`) — every curl then fails
  // with "fetch failed; local shell network unavailable" and all gids come back
  // null. Enable it explicitly while keeping the filesystem sandbox intact.
  const networkArgs = ["-c", "sandbox_workspace_write.network_access=true"];
  // `--output-last-message <resultsPath>` writes codex's final (schema-shaped)
  // message straight to the results file, so we don't depend on the agent doing a
  // shell write of the exact path. `--json` streams events to stdout so the
  // transcript carries real tool calls for --observe discovery scoring.
  return {
    command: opts.harnessDetection?.command ?? commandFor("codex"),
    args: [
      ...approvalArgs,
      ...mcpArgs,
      "exec",
      "--sandbox", "workspace-write",
      ...networkArgs,
      "--json",
      ...modelArgs,
      ...effortArgs,
      "--output-schema", opts.paths.codexSchemaPath,
      "--output-last-message", opts.paths.resultsPath,
      prompt,
    ],
  };
}

/** Pull the model out of one parsed harness JSON object: prefer `modelUsage`
 *  (Claude Code), pick the model that did the most work; else a top-level
 *  `model` string (Codex). Returns undefined when neither is present. */
function modelFromJson(json: Record<string, unknown>): string | undefined {
  const usage = json.modelUsage as Record<string, unknown> | undefined;
  if (usage && typeof usage === "object") {
    // Pick the model that did the most work (highest output tokens), so a stray
    // sub-agent call doesn't mislabel the run.
    const ranked = Object.entries(usage).sort(
      (a, b) =>
        Number((b[1] as { outputTokens?: number })?.outputTokens ?? 0) -
        Number((a[1] as { outputTokens?: number })?.outputTokens ?? 0),
    );
    if (ranked[0]) return ranked[0][0];
  }
  if (typeof json.model === "string") return json.model;
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function addMetric(target: Record<string, number>, key: string, value: unknown): void {
  const n = finiteNumber(value);
  if (n !== undefined) target[key] = (target[key] ?? 0) + n;
}

function tokenUsageFrom(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const out: Record<string, number> = {};
  addMetric(out, "input_tokens", record.input_tokens ?? record.inputTokens);
  addMetric(out, "output_tokens", record.output_tokens ?? record.outputTokens);
  addMetric(out, "cached_input_tokens", record.cached_input_tokens ?? record.cachedInputTokens);
  addMetric(out, "cache_read_input_tokens", record.cache_read_input_tokens ?? record.cacheReadInputTokens);
  addMetric(out, "cache_creation_input_tokens", record.cache_creation_input_tokens ?? record.cacheCreationInputTokens);
  addMetric(out, "total_tokens", record.total_tokens ?? record.totalTokens);
  if (out.total_tokens === undefined && (out.input_tokens !== undefined || out.output_tokens !== undefined)) {
    out.total_tokens = (out.input_tokens ?? 0) + (out.output_tokens ?? 0);
  }
  return Object.keys(out).length ? out : null;
}

function mergeUsage(
  target: Record<string, number>,
  source: Record<string, number> | null | undefined,
): void {
  if (!source) return;
  for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + value;
}

function claudeUsage(json: Record<string, unknown>): Record<string, number> | null {
  const direct = tokenUsageFrom(json.usage);
  if (direct) return direct;
  const modelUsage = json.modelUsage;
  if (!modelUsage || typeof modelUsage !== "object" || Array.isArray(modelUsage)) return null;
  const total: Record<string, number> = {};
  for (const usage of Object.values(modelUsage as Record<string, unknown>)) mergeUsage(total, tokenUsageFrom(usage));
  return Object.keys(total).length ? total : null;
}

interface ParsedHarnessMetrics {
  model?: string;
  cost_usd: number | null;
  token_usage: Record<string, number> | null;
  num_turns: number | null;
  harness_duration_ms: number | null;
}

/** Parse each harness's native event shape once. Claude's final result carries
 *  cost, usage, duration and turns. Codex emits token usage on turn.completed
 *  but does not report dollars, so cost_usd remains explicitly null. */
function parseHarnessMetrics(harness: InvokeHarnessId, raw: string): ParsedHarnessMetrics {
  let model: string | undefined;
  let costUsd: number | null = null;
  let numTurns: number | null = null;
  let harnessDurationMs: number | null = null;
  const usage: Record<string, number> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    model = modelFromJson(event) ?? model;
    if (harness === "claude-code" && event.type === "result") {
      costUsd = finiteNumber(event.total_cost_usd) ?? costUsd;
      numTurns = finiteNumber(event.num_turns) ?? numTurns;
      harnessDurationMs = finiteNumber(event.duration_ms) ?? harnessDurationMs;
      mergeUsage(usage, claudeUsage(event));
    }
    if (harness === "codex" && event.type === "turn.completed") {
      mergeUsage(usage, tokenUsageFrom(event.usage));
    }
  }
  return {
    model,
    cost_usd: harness === "claude-code" ? costUsd : null,
    token_usage: Object.keys(usage).length ? usage : null,
    num_turns: numTurns,
    harness_duration_ms: harnessDurationMs,
  };
}

function semverFromVersion(raw: string | undefined): string | null {
  if (!raw) return null;
  return raw.match(/\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/)?.[1] ?? null;
}

function summarizeInvokeMetrics(opts: InvokeRunOptions, attempts: InvokeAttemptMetrics[]): InvokeHarnessMetrics {
  const selected = [...attempts].reverse().find((attempt) => attempt.ok) ?? attempts.at(-1);
  const tokenUsage: Record<string, number> = {};
  for (const attempt of attempts) mergeUsage(tokenUsage, attempt.token_usage);
  const costs = attempts.flatMap((attempt) => typeof attempt.cost_usd === "number" ? [attempt.cost_usd] : []);
  const turns = attempts.flatMap((attempt) => typeof attempt.num_turns === "number" ? [attempt.num_turns] : []);
  const rawVersion = opts.harnessDetection?.version?.trim() || null;
  return {
    harness_version_raw: rawVersion,
    harness_version_semver: semverFromVersion(rawVersion ?? undefined),
    run_batch_id: opts.runBatchId?.trim() || null,
    duration_ms: selected?.duration_ms ?? null,
    total_duration_ms: attempts.reduce((sum, attempt) => sum + attempt.duration_ms, 0),
    cost_usd: opts.harness === "claude-code" && costs.length ? costs.reduce((sum, value) => sum + value, 0) : null,
    token_usage: Object.keys(tokenUsage).length ? tokenUsage : null,
    num_turns: turns.length ? turns.reduce((sum, value) => sum + value, 0) : null,
  };
}

/** Read the model the harness ACTUALLY ran as out of its stdout, so the report
 *  records ground truth instead of a hardcoded profile label. Handles both
 *  shapes: a single JSON object (`--output-format json`, Codex), and NDJSON
 *  (`--output-format stream-json`) where the model lives on the final
 *  `type:result` line. Returns undefined when nothing parseable is found (we
 *  then fall back to the requested/profile model). */
function detectRanModel(stdoutPath: string): string | undefined {
  if (!existsSync(stdoutPath)) return undefined;
  const raw = readFileSync(stdoutPath, "utf8").trim();
  if (!raw) return undefined;
  // Fast path: the whole file is one JSON object.
  try {
    return modelFromJson(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    /* fall through to NDJSON scan */
  }
  // stream-json: scan lines, last detectable model wins (the result line carries
  // the authoritative modelUsage; assistant lines may also carry it).
  let found: string | undefined;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const m = modelFromJson(JSON.parse(t) as Record<string, unknown>);
      if (m) found = m;
    } catch {
      /* skip non-JSON lines */
    }
  }
  return found;
}

/** Codex prints its model in the run banner (to stderr): a line like
 *  `model: gpt-5.5`. Its `--json` event stream / output file don't expose it in a
 *  field, so this banner is the ground-truth source for codex runs. */
function modelFromCodexBanner(stderrPath: string): string | undefined {
  if (!existsSync(stderrPath)) return undefined;
  const m = readFileSync(stderrPath, "utf8").match(/^\s*model:\s*(\S+)/m);
  return m ? m[1] : undefined;
}

function stampResultFile(opts: InvokeRunOptions, metrics: InvokeHarnessMetrics): { ok: boolean; error?: string } {
  if (!existsSync(opts.paths.resultsPath)) return { ok: true };
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonWithRecovery<Record<string, unknown>>(readFileSync(opts.paths.resultsPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeFailureArtifacts(opts, `results JSON invalid (bare quotes / malformed): ${message}`);
    return { ok: false, error: message };
  }
  parsed.harness = opts.harness;
  parsed.profile = typeof parsed.profile === "string" && parsed.profile.trim() ? parsed.profile : opts.profile;
  parsed.surface = typeof parsed.surface === "string" && parsed.surface.trim() ? parsed.surface : opts.surface;
  parsed.ns = typeof parsed.ns === "string" && parsed.ns.trim() ? parsed.ns : opts.ns;
  // Ground-truth model: what the harness reported running > what we requested.
  // Never the hardcoded profile default — that's the bug we're fixing. Codex
  // doesn't carry the model in its output, so fall back to its stderr banner.
  const bannerModel = opts.harness === "codex" ? modelFromCodexBanner(opts.paths.stderrPath) : undefined;
  parsed.model = detectRanModel(opts.paths.stdoutPath) ?? bannerModel ?? opts.model ?? parsed.model ?? null;
  parsed.metrics = metrics;
  normalizeDiscoveryResult(parsed, opts.pack, opts.env);
  writeFileSync(opts.paths.resultsPath, JSON.stringify(parsed, null, 2));
  return { ok: true };
}

function looksLikeBaseUrlPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (/^https?:\/\/[^<>{}\s]+$/i.test(trimmed) && !/\$\{[A-Z0-9_]+\}/.test(trimmed)) return false;
  return /<[^>]+>|\{[^}]+\}|\$\{[A-Z0-9_]+\}|\bCONVEX_URL\b|\bdeployment URL\b/i.test(trimmed);
}

function normalizeDiscoveryResult(
  parsed: Record<string, unknown>,
  pack: TargetPack,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const discovery = parsed.discovery;
  if (!discovery || typeof discovery !== "object" || Array.isArray(discovery)) return;
  const record = discovery as Record<string, unknown>;
  const baseUrlFound = typeof record.base_url_found === "string" ? record.base_url_found : "";
  if (!looksLikeBaseUrlPlaceholder(baseUrlFound)) return;
  try {
    record.base_url_found = resolveEnvTemplate(pack.base_url, env);
  } catch {
    /* Leave the self-report unchanged when the template cannot be resolved. */
  }
}

function parseResultPayload(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.profile === "string" &&
      typeof parsed.ns === "string" &&
      typeof parsed.surface === "string" &&
      parsed.results &&
      typeof parsed.results === "object"
    ) {
      return parsed;
    }
  } catch {
    /* ignore invalid JSON */
  }
  return undefined;
}

function samePath(candidate: string | undefined, target: string, cwd: string): boolean {
  if (!candidate) return false;
  return resolve(cwd, candidate) === resolve(cwd, target);
}

function recoverClaudeWrite(stdout: string, targetPath: string, cwd: string): string | undefined {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as {
        type?: string;
        message?: {
          content?: Array<{
            type?: string;
            name?: string;
            input?: { file_path?: string; content?: string };
          }>;
        };
      };
      const content = parsed.message?.content ?? [];
      for (const block of content) {
        if (block?.type === "tool_use" && block?.name === "Write" && samePath(block.input?.file_path, targetPath, cwd)) {
          return typeof block.input?.content === "string" ? block.input.content : undefined;
        }
      }
    } catch {
      /* ignore non-JSON lines */
    }
  }
  return undefined;
}

function recoverCodexAgentMessage(stdout: string): string | undefined {
  let found: string | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as {
        type?: string;
        item?: { type?: string; text?: string };
      };
      if (parsed.type === "item.completed" && parsed.item?.type === "agent_message" && typeof parsed.item.text === "string") {
        if (parseResultPayload(parsed.item.text)) found = parsed.item.text;
      }
    } catch {
      /* ignore non-JSON lines */
    }
  }
  return found;
}

function recoverResultFile(opts: InvokeRunOptions, stdout: string): boolean {
  if (existsSync(opts.paths.resultsPath)) return true;
  const recovered =
    opts.harness === "claude-code"
      ? recoverClaudeWrite(stdout, opts.paths.resultsPath, opts.cwd)
      : recoverCodexAgentMessage(stdout);
  if (!recovered) return false;
  const parsed = parseResultPayload(recovered);
  if (!parsed) return false;
  writeFileSync(opts.paths.resultsPath, `${JSON.stringify(parsed, null, 2)}\n`);
  return true;
}

function recoverTraceFile(opts: InvokeRunOptions, stdout: string): boolean {
  if (existsSync(opts.paths.tracePath)) return true;
  if (opts.harness !== "claude-code") return false;
  const recovered = recoverClaudeWrite(stdout, opts.paths.tracePath, opts.cwd);
  if (!recovered) return false;
  try {
    const parsed = JSON.parse(recovered);
    if (!Array.isArray(parsed)) return false;
    writeFileSync(opts.paths.tracePath, `${JSON.stringify(parsed, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

function transcriptShowsSuccess(harness: InvokeHarnessId, stdout: string): boolean {
  if (!stdout.trim()) return false;
  if (harness === "claude-code") {
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as { type?: string; subtype?: string; terminal_reason?: string };
        if (parsed.type === "result" && parsed.subtype === "success") return true;
      } catch {
        /* ignore */
      }
    }
    return false;
  }
  return false;
}

function transcriptRuntimeDiagnostics(raw: string, firstActionLatencyMs: number | null | undefined): {
  transcript_event_count: number;
  action_occurred: boolean;
  first_action_latency_ms: number | null;
} {
  let transcript_event_count = 0;
  let action_occurred = firstActionLatencyMs !== null && firstActionLatencyMs !== undefined;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      transcript_event_count += 1;
      const item = event.item as { type?: unknown } | undefined;
      if (event.type === "item.completed" && (item?.type === "web_search" || item?.type === "command_execution")) {
        action_occurred = true;
      }
      const message = event.message as { content?: unknown } | undefined;
      if (Array.isArray(message?.content) && message.content.some((block) =>
        block && typeof block === "object" && (block as { type?: unknown }).type === "tool_use"
      )) {
        action_occurred = true;
      }
    } catch {
      /* Plain stderr/stdout lines are not structured transcript events. */
    }
  }
  return {
    transcript_event_count,
    action_occurred,
    first_action_latency_ms: firstActionLatencyMs ?? null,
  };
}

function invokeValidityStatus(args: {
  ok: boolean;
  timedOut: boolean;
  actionOccurred: boolean;
  resultsExists: boolean;
  traceExists: boolean;
  error?: string;
}): InvokeValidityStatus {
  if (args.timedOut && !args.actionOccurred) return "runtime_timeout_no_action";
  if (args.timedOut && args.actionOccurred) return "runtime_timeout_partial";
  if (args.ok) return "valid";
  if (args.actionOccurred || args.resultsExists || args.traceExists) return "partial";
  if (args.error) return "invoke_failed";
  return "partial";
}

function writeFailureArtifacts(opts: InvokeRunOptions, message: string): void {
  const results = Object.fromEntries(tasksForSurface(opts.pack, opts.surface).map((t) => [t.id, { gid: null }]));
  writeFileSync(
    opts.paths.resultsPath,
    JSON.stringify(
      {
        profile: opts.profile,
        harness: opts.harness,
        ns: opts.ns,
        surface: opts.surface,
        discovery: {
          base_url_found: "",
          searches: [],
          urls_visited: [],
          endpoint_used: "",
          auth_scheme_found: "",
          notes: message,
        },
        results,
      },
      null,
      2,
    ),
  );
  writeFileSync(
    opts.paths.tracePath,
    JSON.stringify(
      [
        {
          step: 1,
          taskId: "discovery",
          action: "invoke harness",
          note: message,
        },
      ],
      null,
      2,
    ),
  );
}

export async function runInvokeHarness(
  opts: InvokeRunOptions,
  spawnAsync: AsyncSpawn = DEFAULT_ASYNC_SPAWN,
): Promise<InvokeRunResult> {
  const startedAt = Date.now();
  const prompt = readFileSync(opts.paths.promptPath, "utf8");
  const { command, args } = buildInvocation(opts.harness, prompt, opts);
  const maxAttempts = 1 + Math.max(0, opts.retries ?? 1);

  // Re-run on failure/timeout up to `retries` times. A clean attempt (exit 0 +
  // a results file written) breaks early; a hang (killed by the timeout cap) or
  // a crash retries from a clean slate. This is what keeps one wedged headless
  // agent (e.g. an MCP server stuck on an auth prompt) from stalling the matrix.
  let res!: ProcResult;
  let attempt = 0;
  let ok = false;
  let stdout = "";
  let stderr = "";
  const attemptMetrics: InvokeAttemptMetrics[] = [];
  while (attempt < maxAttempts) {
    attempt += 1;
    const attemptStarted = new Date();
    const attemptStartedMs = Date.now();
    res = await spawnAsync(command, args, opts.cwd, {
      timeoutMs: opts.timeoutMs,
      firstActionTimeoutMs: opts.firstActionTimeoutMs,
      env: opts.env,
      replaceEnv: opts.replaceEnv,
      successPaths: [opts.paths.resultsPath, opts.paths.tracePath],
    });
    stdout = text(res.stdout);
    stderr = text(res.stderr);
    recoverResultFile(opts, stdout);
    recoverTraceFile(opts, stdout);
    ok =
      !res.error &&
      existsSync(opts.paths.resultsPath) &&
      (((res.status ?? null) === 0) || transcriptShowsSuccess(opts.harness, stdout));
    const nativeMetrics = parseHarnessMetrics(opts.harness, stdout);
    const attemptFinished = new Date();
    attemptMetrics.push({
      attempt,
      started_at: attemptStarted.toISOString(),
      finished_at: attemptFinished.toISOString(),
      duration_ms: Date.now() - attemptStartedMs,
      ok,
      exit_code: res.status ?? null,
      signal: res.signal ?? null,
      timed_out: res.timedOut ?? false,
      timeout_reason: res.timeoutReason,
      cost_usd: nativeMetrics.cost_usd,
      token_usage: nativeMetrics.token_usage,
      num_turns: nativeMetrics.num_turns,
      harness_duration_ms: nativeMetrics.harness_duration_ms,
    });
    if (ok || attempt >= maxAttempts) break;
    // Failed and a retry is left: drop any partial results file so the next
    // attempt is scored on its own output, not stale leftovers.
    for (const path of [opts.paths.resultsPath, opts.paths.tracePath]) {
      if (!existsSync(path)) continue;
      try { rmSync(path); } catch { /* best effort */ }
    }
  }
  writeRedactedFile(opts.paths.stdoutPath, stdout);
  writeRedactedFile(opts.paths.stderrPath, stderr);
  // Keep a single transcript file path for verify --observe / report evidence.
  // If a harness emits structured JSONL later, this path can hold it directly.
  writeRedactedFile(opts.paths.transcriptPath, stdout || stderr);
  redactInvokeHomeIfPresent(opts);

  const exitCode = res.status ?? null;
  const signal = res.signal ?? null;
  const timedOut = res.timedOut ?? false;
  const timeoutReason = res.timeoutReason;
  const error = res.error?.message
    ?? (timedOut
      ? timeoutReason === "first-action"
        ? `harness ${opts.harness} timed out before first action after ${Math.round((opts.firstActionTimeoutMs ?? 0) / 1000)}s (${attempt} attempt${attempt === 1 ? "" : "s"})`
        : `harness ${opts.harness} timed out after ${Math.round((opts.timeoutMs ?? 0) / 1000)}s (${attempt} attempt${attempt === 1 ? "" : "s"})`
      : undefined);
  const metrics = summarizeInvokeMetrics(opts, attemptMetrics);
  let stamp: { ok: boolean; error?: string } = { ok: true };
  if (existsSync(opts.paths.resultsPath)) {
    stamp = stampResultFile(opts, metrics);
  } else {
    const reason = redactHarnessArtifactText(error ?? `harness ${opts.harness} exited ${exitCode ?? signal ?? "unknown"} before writing ${opts.paths.resultsPath}`);
    writeFailureArtifacts(opts, reason);
    stamp = stampResultFile(opts, metrics);
  }
  redactFileIfExists(opts.paths.resultsPath);
  redactFileIfExists(opts.paths.tracePath);

  const exitLabel = exitCode ?? (signal ?? "unknown");
  const durationMs = Date.now() - startedAt;
  const runtimeDiagnostics = transcriptRuntimeDiagnostics(stdout || stderr, res.firstActionLatencyMs);
  const stampFailed = stamp.ok === false;
  const finalOk = ok && !stampFailed;
  const validity_status = stampFailed
    ? "results_json_invalid"
    : invokeValidityStatus({
    ok: finalOk,
    timedOut,
    actionOccurred: runtimeDiagnostics.action_occurred,
    resultsExists: existsSync(opts.paths.resultsPath),
    traceExists: existsSync(opts.paths.tracePath),
    error: stamp.error ?? error,
  });
  const meta: InvokeRunResult = {
    harness: opts.harness,
    ok: finalOk,
    exitCode,
    signal,
    profile: opts.profile,
    surface: opts.surface,
    requestedModel: opts.model,
    effort: opts.effort,
    attempts: attempt,
    timedOut,
    timeoutReason,
    durationMs,
    validity_status,
    first_action_latency_ms: runtimeDiagnostics.first_action_latency_ms,
    transcript_event_count: runtimeDiagnostics.transcript_event_count,
    action_occurred: runtimeDiagnostics.action_occurred,
    metrics,
    attempt_metrics: attemptMetrics,
    stdoutPath: opts.paths.stdoutPath,
    stderrPath: opts.paths.stderrPath,
    transcriptPath: opts.paths.transcriptPath,
    metaPath: opts.paths.metaPath,
    resultsPath: opts.paths.resultsPath,
    tracePath: opts.paths.tracePath,
    error: ok ? undefined : redactHarnessArtifactText((error ?? stderr.trim()) || `exit ${exitLabel}`),
  };
  writeRedactedFile(
    opts.paths.metaPath,
    JSON.stringify({ ...meta, command, args, cwd: opts.cwd, promptPath: opts.paths.promptPath, provisioning: opts.provisioning }, null, 2),
  );
  return meta;
}

export function defaultInvokePaths(dir: string, stem: string, harness: InvokeHarnessId): InvokePaths {
  return {
    promptPath: `${dir}/prompt-${stem}.txt`,
    resultsPath: `${dir}/run-${stem}.json`,
    tracePath: `${dir}/run-${stem}.trace.json`,
    stdoutPath: `${dir}/run-${stem}.stdout.txt`,
    stderrPath: `${dir}/run-${stem}.stderr.txt`,
    transcriptPath: `${dir}/run-${stem}.transcript.jsonl`,
    metaPath: `${dir}/run-${stem}.invoke.json`,
    codexSchemaPath: harness === "codex" ? `${dirname(`${dir}/run-${stem}.json`)}/run-${stem}.schema.json` : undefined,
  };
}
