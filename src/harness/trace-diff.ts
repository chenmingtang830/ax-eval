import type { TargetPack, Task, TraceConstraint } from "../schemas.js";
import type { TraceStep } from "./executor.js";
import type { SurfaceId } from "../surface/types.js";

export type TraceDiffKind =
  | "missing_call"
  | "extra_call"
  | "forbidden_call"
  | "order_mismatch"
  | "argument_mismatch";

export interface TraceDiff {
  kind: TraceDiffKind;
  taskId?: string;
  expected?: string;
  actual?: string;
  detail: string;
}

function normMethod(method: string | undefined): string | undefined {
  return method?.toUpperCase();
}

function normPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const clean = path.split("?")[0] ?? path;
  return clean.replace(/\/+$/, "") || "/";
}

function callLabel(method: string | undefined, path: string | undefined): string {
  return `${normMethod(method) ?? "*"} ${normPath(path) ?? "*"}`;
}

function stepMatches(step: TraceStep, c: TraceConstraint): boolean {
  if (c.taskId && step.taskId !== c.taskId) return false;
  if (c.method && normMethod(step.method) !== normMethod(c.method)) return false;
  if (c.path && normPath(step.path) !== normPath(c.path)) return false;
  return true;
}

function taskConstraints(task: Task, surface: SurfaceId): TraceConstraint[] {
  // Hand-authored constraints are honored on every surface.
  if (task.trace.length) return task.trace;
  if (!task.create_path) return [];
  // The auto-inferred constraint is a REST call (`POST <create_path>`). It only
  // describes the API surface — on cli/sdk/mcp the agent acts through a command /
  // SDK method / MCP tool, never that endpoint, so applying it would emit a false
  // `missing_call`. There, the round-trip oracle is the structural gate, so we
  // infer no REST constraint.
  if (surface !== "api") return [];
  return [
    {
      type: "required_call",
      taskId: task.id,
      method: "POST",
      path: task.create_path,
      description: "generated create call",
    },
  ];
}

function firstIndex(trace: TraceStep[], c: TraceConstraint): number {
  return trace.findIndex((s) => stepMatches(s, c));
}

function orderIndex(trace: TraceStep[], taskId: string | undefined): number {
  return trace.findIndex((s) => (taskId ? s.taskId === taskId : false));
}

export function diffTrace(pack: TargetPack, trace: TraceStep[], surface: SurfaceId = "api"): TraceDiff[] {
  const diffs: TraceDiff[] = [];
  const knownTaskIds = new Set(pack.tasks.map((t) => t.id));

  for (const task of pack.tasks) {
    for (const c of taskConstraints(task, surface)) {
      if (c.type === "required_call") {
        const idx = firstIndex(trace, c);
        if (idx !== -1) continue;

        const sameTaskMethod = trace.find(
          (s) => (!c.taskId || s.taskId === c.taskId) && (!c.method || normMethod(s.method) === normMethod(c.method)),
        );
        if (sameTaskMethod && c.path && normPath(sameTaskMethod.path) !== normPath(c.path)) {
          diffs.push({
            kind: "argument_mismatch",
            taskId: c.taskId ?? task.id,
            expected: callLabel(c.method, c.path),
            actual: callLabel(sameTaskMethod.method, sameTaskMethod.path),
            detail: `Expected ${callLabel(c.method, c.path)} but observed ${callLabel(
              sameTaskMethod.method,
              sameTaskMethod.path,
            )}.`,
          });
        } else {
          diffs.push({
            kind: "missing_call",
            taskId: c.taskId ?? task.id,
            expected: callLabel(c.method, c.path),
            detail: `Missing required call ${callLabel(c.method, c.path)}.`,
          });
        }
      } else if (c.type === "forbidden_call") {
        const idx = firstIndex(trace, c);
        if (idx !== -1) {
          const s = trace[idx]!;
          diffs.push({
            kind: "forbidden_call",
            taskId: c.taskId ?? s.taskId,
            expected: `no ${callLabel(c.method, c.path)}`,
            actual: callLabel(s.method, s.path),
            detail: `Observed forbidden call ${callLabel(s.method, s.path)}.`,
          });
        }
      } else if (c.type === "order") {
        const before = orderIndex(trace, c.before);
        const after = orderIndex(trace, c.after);
        if (before === -1 || after === -1) continue;
        if (before > after) {
          diffs.push({
            kind: "order_mismatch",
            taskId: task.id,
            expected: `${c.before} before ${c.after}`,
            actual: `${c.after} before ${c.before}`,
            detail: `Expected task ${c.before} before ${c.after}, but trace order was reversed.`,
          });
        }
      }
    }
  }

  for (const step of trace) {
    if (!step.method && !step.path) continue;
    if (step.taskId === "discovery" || step.taskId === "observed") continue;
    if (knownTaskIds.has(step.taskId)) continue;
    diffs.push({
      kind: "extra_call",
      taskId: step.taskId,
      actual: callLabel(step.method, step.path),
      detail: `Observed API call for unknown task id "${step.taskId}".`,
    });
  }

  return diffs;
}

export function renderTraceDiffs(diffs: TraceDiff[]): string {
  if (!diffs.length) return "Trace diff: PASS (no structural mismatches)";
  return [
    `Trace diff: FAIL (${diffs.length} mismatch${diffs.length === 1 ? "" : "es"})`,
    ...diffs.map((d) => {
      const task = d.taskId ? ` task=${d.taskId}` : "";
      const exp = d.expected ? ` expected=${d.expected}` : "";
      const act = d.actual ? ` actual=${d.actual}` : "";
      return `  - ${d.kind}${task}${exp}${act}: ${d.detail}`;
    }),
  ].join("\n");
}
