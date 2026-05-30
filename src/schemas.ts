/**
 * The four core schemas (skill-spec.md §3–6): Task, TargetPack, the harness
 * Adapter, and RunResult — plus the OracleSpec/OracleResult that make success
 * legible. Defined with zod so a target pack's YAML is validated on load.
 *
 * Adapters take a Task + TargetPack and return a RunResult. Oracles score the
 * "world state" an adapter reports, so mock and live adapters are interchangeable.
 */
import { z } from "zod";

/** A declarative check attached to a task. `type` selects the oracle impl;
 *  `path` addresses a value in the reported world state (dotted keys). */
export const OracleSpecSchema = z.object({
  type: z.string(),
  path: z.string().optional(),
  expected: z.unknown().optional(),
  value: z.unknown().optional(),
  description: z.string().default(""),
});
export type OracleSpec = z.infer<typeof OracleSpecSchema>;

/** A concrete goal an agent must achieve against the target. */
export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string().default(""),
  oracles: z.array(OracleSpecSchema).default([]),
});
export type Task = z.infer<typeof TaskSchema>;

/** Versioned bundle describing a target and its task set. */
export const TargetPackSchema = z.object({
  name: z.string(),
  version: z.coerce.string().default("0"),
  auth_method: z.string().default("none"),
  base_url: z.string().default(""),
  docs_urls: z.array(z.string()).default([]),
  tasks: z.array(TaskSchema).default([]),
});
export type TargetPack = z.infer<typeof TargetPackSchema>;

/** The outcome of evaluating a single oracle. */
export interface OracleResult {
  type: string;
  passed: boolean;
  detail: string;
}

/** The record of one task × harness run. */
export interface RunResult {
  taskId: string;
  harness: string;
  success: boolean;
  oracleResults: OracleResult[];
  trace: string[];
  durationMs: number;
  error: string | null;
}

/** Flat-ish reported world state; oracle paths resolve against nested objects. */
export type World = Record<string, unknown>;
