/**
 * The harness adapter interface.
 *
 * An adapter drives an agent to attempt a task and normalizes its I/O to a
 * RunResult. Concretely it produces a *world state* (what it believes it
 * changed) plus a trace; the runner scores that world with the task's oracles.
 * This keeps mock and live adapters interchangeable — oracles don't care
 * whether the world came from a fixture or a real API readback.
 */
import { evaluateAll } from "../oracles.js";
import type { RunResult, Task, TargetPack, World } from "../schemas.js";

export interface AttemptOutcome {
  world: World;
  trace: string[];
}

export type { Task, TargetPack, World } from "../schemas.js";

export abstract class HarnessAdapter {
  /** Stable name used in config and the matrix. */
  abstract readonly name: string;

  /** Whether real work needs credentials. Keyless adapters (mock, hermes-stub)
   *  are always runnable; the runner may skip key-requiring adapters when the
   *  credential is absent. */
  readonly requiresKey: boolean = false;

  /** Env var holding the credential, when requiresKey is true. */
  readonly keyEnv: string | null = null;

  /** A synthetic *control* that mirrors the oracle answer key (e.g. a perfect
   *  mock) rather than standing in for a real agent's competence. Excluded from
   *  the static×behavioral "gap", since a ceiling that passes by construction
   *  would erase the gap the product exists to show. */
  readonly synthetic: boolean = false;

  /**
   * Attempt the task. Must not throw for ordinary task failure (a failed
   * attempt is a legitimate result) — throw only on adapter/infra errors.
   */
  abstract attempt(task: Task, pack: TargetPack): Promise<AttemptOutcome>;

  /** Run a task and score it with the task's oracles. */
  async run(task: Task, pack: TargetPack): Promise<RunResult> {
    const start = performance.now();
    let world: World;
    let trace: string[];
    try {
      ({ world, trace } = await this.attempt(task, pack));
    } catch (err) {
      return {
        taskId: task.id,
        harness: this.name,
        success: false,
        oracleResults: [],
        trace: [],
        durationMs: performance.now() - start,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      };
    }
    const oracleResults = evaluateAll(task.oracles, world);
    const success = oracleResults.length > 0 && oracleResults.every((r) => r.passed);
    return {
      taskId: task.id,
      harness: this.name,
      success,
      oracleResults,
      trace,
      durationMs: performance.now() - start,
      error: null,
    };
  }
}
