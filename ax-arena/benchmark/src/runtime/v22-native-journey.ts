import { decodeTranscriptContent } from "ax-eval";
import { z } from "zod";

export const V22_TASK_ID = "db-J01-native-journey" as const;

const VendorSchema = z.object({
  display_name: z.string().min(1),
  base_pack: z.string().min(1),
  credential_envs: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).min(1),
  scope_envs: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).min(1),
  data_connection_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).nullable(),
  native_markers: z.array(z.string().min(1)).min(1),
  official_domains: z.array(z.string().min(1)).min(1),
}).strict();

export const V22NativeJourneySchema = z.object({
  schema: z.literal("ax.daeb-v2-2-native-journey/v1"),
  name: z.string().min(1),
  version: z.string().min(1),
  formal: z.literal(false),
  model: z.string().min(1),
  provider: z.string().min(1),
  harness: z.literal("pi"),
  trial: z.literal(1),
  task_id: z.literal(V22_TASK_ID),
  vendors: z.record(z.string(), VendorSchema),
  acceptance: z.object({
    oracle_defects: z.literal(0),
    route_mismatches: z.literal(0),
    unexplained_invalid_infra: z.literal(0),
    non_unanimous_stage_required: z.literal(true),
    differentiating_dimensions_required: z.number().int().positive(),
  }).strict(),
}).strict();

export type V22NativeJourney = z.infer<typeof V22NativeJourneySchema>;
export type V22Vendor = z.infer<typeof VendorSchema>;

export interface V22WorldState {
  connection_ok: boolean;
  total_rows: number | null;
  active_rows: number | null;
  alpha_rows: number | null;
  recovered_rows: number | null;
  primary_constraints: number | null;
  unique_constraints: number | null;
  error?: string;
}

export interface V22TranscriptEvidence {
  commands: number;
  searches: number;
  fetched_urls: number;
  transcript_invalid_lines: number;
  help_inspected: boolean;
  official_source_observed: boolean;
  native_entrypoint_observed: boolean;
  data_connection_env_observed: boolean;
  stale_target_attempted: boolean;
  discovery_mode: "direct-success" | "assisted-discovery" | "unresolved";
}

export interface V22StageScores {
  discovery: boolean;
  connect: boolean;
  operate: boolean;
  recovery: boolean;
}

export type V22CellStatus = "pass" | "fail" | "invalid-infra" | "invalid-route";

export function classifyV22CellStatus(input: {
  routeMismatch: boolean;
  invocation: { ok: boolean; validity_status: string | null } | null;
  cleanupSuccess: boolean;
  evidence: V22TranscriptEvidence | null;
  stages: V22StageScores;
}): V22CellStatus {
  if (input.routeMismatch) return "invalid-route";
  if (!input.cleanupSuccess || !input.invocation) return "invalid-infra";
  const agentAttempted = Boolean(input.evidence
    && (input.evidence.commands + input.evidence.searches + input.evidence.fetched_urls > 0));
  // A model that ran tools but did not emit the required result/trace artifact
  // did not complete the task. That is a failure, not retryable infrastructure.
  if (!input.invocation.ok || input.invocation.validity_status !== "valid") {
    return agentAttempted ? "fail" : "invalid-infra";
  }
  return Object.values(input.stages).every(Boolean) ? "pass" : "fail";
}

function containsAny(value: string, markers: readonly string[]): boolean {
  const normalized = value.toLowerCase();
  return markers.some((marker) => normalized.includes(marker.toLowerCase()));
}

export function buildV22NativeJourneyPrompt(input: {
  vendor: V22Vendor;
  vendorSlug: string;
  namespace: string;
  resultsPath: string;
  tracePath: string;
}): string {
  const table = `axarena_native_journey_${input.namespace}`;
  const alpha = `alpha_${input.namespace}`;
  const beta = `beta_${input.namespace}`;
  const gamma = `gamma_${input.namespace}`;
  const recovered = `recovered_${input.namespace}`;
  const visibleEnvNames = [...new Set([...input.vendor.credential_envs, ...input.vendor.scope_envs])];
  return [
    `You are evaluating the native agent experience of ${input.vendor.display_name} from a cold terminal session.`,
    `Work only inside the existing benchmark sandbox and the current isolated working directory.`,
    ``,
    `You are given only these credential/scope environment-variable NAMES: ${visibleEnvNames.join(", ")}.`,
    `A harmless deliberately stale target hint is available as DAEB_NATIVE_STALE_TARGET.`,
    `Read only the specific environment variables you need inside a command or script. Never print, enumerate,`,
    `echo, log, or persist their values. Never read .env or credential files.`,
    ``,
    `Choose an official terminal-operable path yourself: a vendor CLI, documented HTTPS API, official SDK,`,
    `or documented database client. No binary, command, endpoint, or documentation URL is supplied.`,
    `Use official help/docs if needed. You may install an official tool in this isolated workspace.`,
    `Any controller-provisioned CLI authentication is non-interactive. Do not launch browser login, alter`,
    `persistent CLI configuration, create/link a project, or treat an unavailable control-plane login as`,
    `a reason to stop a documented authenticated data-plane path.`,
    `Never expand a credential into source code, a command literal, or an HTTP header: reference only its`,
    `environment-variable name at execution time. Do not reverse-engineer an SDK or guess undocumented HTTP`,
    `endpoints; when a control-plane path is unavailable, continue with a documented data-plane client.`,
    `Before mutating data, use a vendor-specific official entrypoint to identify or inspect the existing`,
    `sandbox scope. A generic SQL client alone is not discovery evidence.`,
    `Do not create, delete, reset, pause, or modify any project, organization, branch, database, user,`,
    `network rule, billing setting, or credential.`,
    ``,
    `Complete this single journey:`,
    `1. DISCOVER: identify a vendor-specific official entrypoint and the existing sandbox scope.`,
    `2. RECOVER: exactly once, use DAEB_NATIVE_STALE_TARGET in a read-only show/get/list/connect-style probe.`,
    `   Observe the failure, diagnose it, then recover to the real existing scope. Do not mutate the stale target.`,
    `3. CONNECT: establish a live authenticated data-plane connection to the real sandbox and read its`,
    `   current principal/database identity without printing credentials.`,
    `4. OPERATE: create exactly one relation named ${table}. Its declared contract is:`,
    `   id INTEGER PRIMARY KEY, marker TEXT UNIQUE NOT NULL, status TEXT NOT NULL.`,
    `   Insert exactly (1, ${alpha}, active), (2, ${beta}, active), and (3, ${gamma}, inactive).`,
    `   Attempt a fourth row with a different id but duplicate marker ${alpha}; the write must be rejected`,
    `   and the original three rows must remain. Then add recovery_note TEXT and set the alpha row to ${recovered}.`,
    `5. VERIFY: read back total rows, active rows, the alpha row, recovery_note, and declared constraints.`,
    `Do not clean up; the controller verifies first and removes only ${table} afterward.`,
    ``,
    `Write strict RFC 8259 JSON to ${input.resultsPath} with this shape:`,
    `{`,
    `  "profile":"pilot", "ns":${JSON.stringify(input.namespace)}, "surface":"cli",`,
    `  "discovery":{"base_url_found":"<chosen official entrypoint>","searches":[],"urls_visited":[],`,
    `    "endpoint_used":"<chosen path>","auth_scheme_found":"<env names only>","notes":"<brief>"},`,
    `  "results":{"${V22_TASK_ID}":{"gid":${JSON.stringify(table)},"chosen_surface":"<cli|api|sdk|sql-client>",`,
    `    "discover":"<pass|fail>","connect":"<pass|fail>","operate":"<pass|fail>","recover":"<pass|fail>"}}`,
    `}`,
    `Write ${input.tracePath} as a strict JSON array of every meaningful discovery and task action.`,
    `Each trace item must contain step, taskId, action, method, path, status (a non-negative integer), and note.`,
    `Use a unique strictly increasing positive step number for every trace item; never reuse a stage number.`,
    `Redact credentials and connection strings in both artifacts. Finish even when a stage fails: use gid null`,
    `and record the bounded failure instead of touching unrelated resources.`,
  ].join("\n");
}

export function analyzeV22Transcript(input: {
  transcript: string;
  vendor: V22Vendor;
  staleTarget: string;
  outcomePassed: boolean;
}): V22TranscriptEvidence {
  const decoded = decodeTranscriptContent(input.transcript, { harness: "pi" });
  const commands = decoded.events.filter((event) => event.kind === "command")
    .map((event) => event.kind === "command" ? event.command : "");
  const searches = decoded.events.filter((event) => event.kind === "search");
  const fetched = decoded.events.filter((event) => event.kind === "fetch")
    .map((event) => event.kind === "fetch" ? event.url : "");
  const joinedCommands = commands.join("\n");
  const commandUrls = [...joinedCommands.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((match) => match[0]!);
  const allUrls = [...fetched, ...commandUrls];
  const helpInspected = commands.some((command) =>
    /(?:--help|\s-h(?:\s|$)|\bhelp\b)/i.test(command)
    && containsAny(command, input.vendor.native_markers));
  const officialSourceObserved = helpInspected
    || allUrls.some((url) => containsAny(url, input.vendor.official_domains));
  const nativeEntrypointObserved = commands.some((command) => containsAny(command, input.vendor.native_markers));
  const dataConnectionEnvObserved = input.vendor.data_connection_env
    ? joinedCommands.includes(input.vendor.data_connection_env)
    : nativeEntrypointObserved;
  const rawStaleToolCallObserved = input.transcript.split(/\r?\n/).some((line) =>
    /"(?:type|item_type)"\s*:\s*"(?:tool_execution_start|command_execution)"/.test(line)
    && (line.includes("DAEB_NATIVE_STALE_TARGET") || line.includes(input.staleTarget)));
  const staleTargetAttempted = joinedCommands.includes("DAEB_NATIVE_STALE_TARGET")
    || joinedCommands.includes(input.staleTarget)
    || rawStaleToolCallObserved;
  return {
    commands: commands.length,
    searches: searches.length,
    fetched_urls: allUrls.length,
    transcript_invalid_lines: decoded.diagnostics.invalid,
    help_inspected: helpInspected,
    official_source_observed: officialSourceObserved,
    native_entrypoint_observed: nativeEntrypointObserved,
    data_connection_env_observed: dataConnectionEnvObserved,
    stale_target_attempted: staleTargetAttempted,
    discovery_mode: !input.outcomePassed
      ? "unresolved"
      : officialSourceObserved ? "assisted-discovery" : "direct-success",
  };
}

export function scoreV22Stages(
  evidence: V22TranscriptEvidence,
  world: V22WorldState,
): V22StageScores {
  const operate = world.connection_ok
    && world.total_rows === 3
    && world.active_rows === 2
    && world.alpha_rows === 1
    && world.recovered_rows === 1
    && (world.primary_constraints ?? 0) >= 1
    && (world.unique_constraints ?? 0) >= 1;
  return {
    discovery: evidence.native_entrypoint_observed && evidence.discovery_mode !== "unresolved",
    connect: world.connection_ok
      && (evidence.data_connection_env_observed || evidence.native_entrypoint_observed),
    operate,
    recovery: operate && evidence.stale_target_attempted,
  };
}
