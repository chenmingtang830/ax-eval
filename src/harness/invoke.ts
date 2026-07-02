import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { SurfaceId } from "../surface/types.js";
import { tasksForSurface } from "../surface/index.js";
import type { TargetPack } from "../schemas.js";

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
   *  convention); claude-code applies effort at the prompt level (no CLI knob),
   *  so this is informational there. */
  effort?: "low" | "medium" | "high";
  /** Hard wall-clock cap per attempt, in milliseconds. When a harness child
   *  exceeds it, it is killed and the attempt counts as a timeout failure
   *  (eligible for a retry). 0 / undefined disables the cap. */
  timeoutMs?: number;
  /** How many times to retry a failed or timed-out invocation before giving up.
   *  Default 1 (one retry → up to two attempts total); 0 disables retries. A
   *  retry re-runs the same prompt from a clean slate (any partial results file
   *  is removed first). */
  retries?: number;
  /** Env overrides for the harness child process. Used for isolated per-cell
   *  MCP config, not for secrets printed to prompts. */
  env?: Record<string, string>;
  /** Non-secret provisioning metadata written to the invoke meta artifact. */
  provisioning?: Record<string, unknown>;
}

export interface InvokeRunResult {
  harness: InvokeHarnessId;
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
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

function defaultHarnessHome(harness: string, hint: string): string {
  const base = resolve(tmpdir(), "ax-eval-homes");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(resolve(base, `${harness}-${hint}-`));
}

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
  opts?: { timeoutMs?: number; env?: Record<string, string>; successPaths?: string[] },
) => Promise<ProcResult>;

export const DEFAULT_ASYNC_SPAWN: AsyncSpawn = (command, args, cwd, opts) =>
  new Promise<ProcResult>((resolve) => {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: opts?.env ? { ...process.env, ...opts.env } : process.env,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let completedAfterOutputs = false;
    let killTimer: NodeJS.Timeout | undefined;
    let timer: NodeJS.Timeout | undefined;
    let outputPoll: NodeJS.Timeout | undefined;
    let outputReadyTimer: NodeJS.Timeout | undefined;
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
        killChild("SIGTERM");
        // If it ignores SIGTERM, hard-kill so the pool slot is freed.
        killTimer = setTimeout(() => killChild("SIGKILL"), 5000);
      }, opts.timeoutMs);
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
      if (killTimer) clearTimeout(killTimer);
      if (outputPoll) clearInterval(outputPoll);
      if (outputReadyTimer) clearTimeout(outputReadyTimer);
      resolve(r);
    };
    child.stdout?.on("data", (d: Buffer) => out.push(d));
    child.stderr?.on("data", (d: Buffer) => err.push(d));
    child.on("error", (error) => finish({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), status: null, signal: null, error, timedOut }));
    child.on("close", (status, signal) => {
      const afterOutputs = completedAfterOutputs && outputsReady();
      finish({
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
        status: afterOutputs ? 0 : status,
        signal: afterOutputs ? null : (signal ?? null),
        timedOut,
      });
    });
  });

function commandFor(id: InvokeHarnessId): string {
  return id === "claude-code" ? "claude" : "codex";
}

function text(buf: Buffer | string | null | undefined): string {
  if (!buf) return "";
  return Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
}

function detectWith(command: string, spawn: Spawn): InvokeDetection {
  const tempHome = command === "claude" ? defaultHarnessHome("claude", "detect") : undefined;
  const env = tempHome ? { ...process.env, HOME: tempHome } : undefined;
  try {
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
  } finally {
    if (tempHome) {
      try { rmSync(tempHome, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

export function detectInvokeHarness(id: InvokeHarnessId, spawn: Spawn = DEFAULT_SPAWN): InvokeDetection {
  return detectWith(commandFor(id), spawn);
}

function taskResultKeys(task: TargetPack["tasks"][number]): string[] {
  const keys = new Set<string>(["gid"]);
  const scan = (template: string | undefined) => {
    if (!template) return;
    for (const match of template.matchAll(/\{([^}]+)\}/g)) {
      const key = match[1];
      if (key && key !== "gid") keys.add(key);
    }
  };
  scan(task.create_path);
  for (const oracle of task.oracles) scan(oracle.readPathTemplate);
  return [...keys];
}

function codexOutputSchema(pack: TargetPack, profile: string, surface: SurfaceId, ns: string): object {
  // OpenAI strict structured-output (codex `--output-schema`) requires EVERY
  // object to set `additionalProperties: false` and list ALL its properties in
  // `required`. A permissive (`additionalProperties: true`) or partially-required
  // object 400s with `invalid_json_schema` before the agent does anything — so the
  // discovery sub-object is fully specified rather than left free-form.
  const tasks = tasksForSurface(pack, surface);
  const taskProps = Object.fromEntries(tasks.map((t) => [t.id, {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(
      taskResultKeys(t).map((key) => [key, { anyOf: [{ type: "string" }, { type: "null" }] }]),
    ),
    required: taskResultKeys(t),
  }]));
  const strArray = { type: "array", items: { type: "string" } };
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      profile: { type: "string" },
      ns: { type: "string" },
      surface: { type: "string" },
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
    // stream-json emits the full event stream (assistant tool_use, tool_result,
    // …) to stdout, ending with a `type:result` line — so the transcript carries
    // REAL tool events for --observe discovery scoring, not just a summary blob.
    // Print mode requires --verbose for stream-json. (Claude Code has no
    // reasoning-effort CLI knob, so effort is applied at the prompt level.)
    return {
      command: "claude",
      args: ["-p", prompt, "--output-format", "stream-json", "--verbose", ...modelArgs],
    };
  }
  if (!opts.paths.codexSchemaPath) {
    throw new Error("codex invocation requires codexSchemaPath");
  }
  writeFileSync(
    opts.paths.codexSchemaPath,
    JSON.stringify(codexOutputSchema(opts.pack, `${id}:${opts.profile}`, opts.surface, opts.ns), null, 2),
  );
  const modelArgs = opts.model ? ["-m", opts.model] : [];
  // Codex/GPT convention: reasoning effort is a model config knob, passed via -c.
  const effortArgs = opts.effort ? ["-c", `model_reasoning_effort=${opts.effort}`] : [];
  // Invoked eval runs are fully non-interactive. Codex's exec path reads
  // approval policy from config-style `-c` overrides, not the interactive TUI
  // flag shape. If we leave the default in place, remote MCP write-tool calls
  // can collapse into "user cancelled MCP tool call" in headless runs.
  const approvalArgs = ["-c", 'approval_policy="never"'];
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
    command: "codex",
    args: [
      ...approvalArgs,
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

function stampResultFile(opts: InvokeRunOptions): void {
  if (!existsSync(opts.paths.resultsPath)) return;
  const parsed = JSON.parse(readFileSync(opts.paths.resultsPath, "utf8")) as Record<string, unknown>;
  parsed.harness = opts.harness;
  parsed.profile = String(parsed.profile ?? opts.profile);
  parsed.surface = opts.surface;
  parsed.ns = parsed.ns ?? opts.ns;
  // Ground-truth model: what the harness reported running > what we requested.
  // Never the hardcoded profile default — that's the bug we're fixing. Codex
  // doesn't carry the model in its output, so fall back to its stderr banner.
  const bannerModel = opts.harness === "codex" ? modelFromCodexBanner(opts.paths.stderrPath) : undefined;
  parsed.model = detectRanModel(opts.paths.stdoutPath) ?? bannerModel ?? opts.model ?? parsed.model ?? null;
  writeFileSync(opts.paths.resultsPath, JSON.stringify(parsed, null, 2));
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
  const childEnv = { ...(opts.env ?? {}) };
  let tempHome: string | undefined;
  if (opts.harness === "claude-code" && !childEnv.HOME) {
    tempHome = defaultHarnessHome("claude", opts.profile);
    childEnv.HOME = tempHome;
  }
  try {
    while (attempt < maxAttempts) {
      attempt += 1;
      res = await spawnAsync(command, args, opts.cwd, {
        timeoutMs: opts.timeoutMs,
        env: childEnv,
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
      if (ok || attempt >= maxAttempts) break;
      // Failed and a retry is left: drop any partial results file so the next
      // attempt is scored on its own output, not stale leftovers.
      if (existsSync(opts.paths.resultsPath)) {
        try { rmSync(opts.paths.resultsPath); } catch { /* best effort */ }
      }
    }
  } finally {
    if (tempHome) {
      try { rmSync(tempHome, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
  writeFileSync(opts.paths.stdoutPath, stdout);
  writeFileSync(opts.paths.stderrPath, stderr);
  // Keep a single transcript file path for verify --observe / report evidence.
  // If a harness emits structured JSONL later, this path can hold it directly.
  writeFileSync(opts.paths.transcriptPath, stdout || stderr);

  const exitCode = res.status ?? null;
  const signal = res.signal ?? null;
  const timedOut = res.timedOut ?? false;
  const error = res.error?.message
    ?? (timedOut ? `harness ${opts.harness} timed out after ${Math.round((opts.timeoutMs ?? 0) / 1000)}s (${attempt} attempt${attempt === 1 ? "" : "s"})` : undefined);
  if (existsSync(opts.paths.resultsPath)) {
    stampResultFile(opts);
  } else {
    const reason = error ?? `harness ${opts.harness} exited ${exitCode ?? signal ?? "unknown"} before writing ${opts.paths.resultsPath}`;
    writeFailureArtifacts(opts, reason);
  }

  const exitLabel = exitCode ?? (signal ?? "unknown");
  const meta: InvokeRunResult = {
    harness: opts.harness,
    ok,
    exitCode,
    signal,
    attempts: attempt,
    timedOut,
    stdoutPath: opts.paths.stdoutPath,
    stderrPath: opts.paths.stderrPath,
    transcriptPath: opts.paths.transcriptPath,
    metaPath: opts.paths.metaPath,
    resultsPath: opts.paths.resultsPath,
    tracePath: opts.paths.tracePath,
    error: ok ? undefined : (error ?? stderr.trim()) || `exit ${exitLabel}`,
  };
  writeFileSync(
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
