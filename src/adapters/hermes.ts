/**
 * Hermes harness — a planned additional harness (the synthetic/third-column
 * slot for cross-agent comparison).
 *
 * Provider and auth are still TBD, so this ships as a *keyless stub*: it runs
 * without credentials and produces a deterministic, middling competence profile,
 * purely so the Hermes column exists end-to-end. When the real runtime/auth is
 * decided, replace `attempt` with the live adapter and flip requiresKey/keyEnv.
 */
import { MockHarness, type MockOptions } from "./mock.js";
import type { AttemptOutcome, Task, TargetPack } from "./base.js";

export class HermesHarness extends MockHarness {
  /** When wired to the real provider, set these and drop the stub note. */
  readonly requiresKey = false;
  readonly keyEnv = "HERMES_API_KEY";
  readonly isStub = true;

  constructor(opts: MockOptions = {}) {
    super("hermes", opts);
  }

  async attempt(task: Task, pack: TargetPack): Promise<AttemptOutcome> {
    const { world, trace } = await super.attempt(task, pack);
    trace.unshift("[hermes] NOTE: keyless stub — provider/auth TBD; output is simulated");
    return { world, trace };
  }
}
