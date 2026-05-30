/**
 * Mock harness — a fake agent runtime for keyless, networkless runs.
 *
 * It synthesizes a world state directly from each task's oracle specs, so a run
 * is deterministic and scoreable without touching a real target. To make a
 * realistic "damning demo" matrix (agents succeed at different rates), a mock
 * can be told to `skip` some tasks (does nothing → oracles fail) or get them
 * `wrong` (writes an off value → equals/contains fail while exists passes).
 */
import { HarnessAdapter, type AttemptOutcome } from "./base.js";
import type { Task, TargetPack, World } from "../schemas.js";

function setPath(world: World, path: string, value: unknown): void {
  const parts = path.split(".");
  let node = world;
  for (const part of parts.slice(0, -1)) {
    if (typeof node[part] !== "object" || node[part] === null) node[part] = {};
    node = node[part] as World;
  }
  node[parts[parts.length - 1]!] = value;
}

export interface MockOptions {
  skip?: string[];
  wrong?: string[];
}

export class MockHarness extends HarnessAdapter {
  readonly name: string;
  readonly requiresKey = false;
  protected readonly skip: Set<string>;
  protected readonly wrong: Set<string>;

  constructor(name = "mock", opts: MockOptions = {}) {
    super();
    this.name = name;
    this.skip = new Set(opts.skip ?? []);
    this.wrong = new Set(opts.wrong ?? []);
  }

  async attempt(task: Task, _pack: TargetPack): Promise<AttemptOutcome> {
    const trace = [`[${this.name}] received task '${task.id}': ${task.title}`];

    if (this.skip.has(task.id)) {
      trace.push(`[${this.name}] gave up — produced no changes`);
      return { world: {}, trace };
    }

    const world: World = {};
    const wrong = this.wrong.has(task.id);
    for (const oracle of task.oracles) {
      if (!oracle.path) continue;
      if (oracle.type === "exists") {
        setPath(world, oracle.path, wrong ? "" : "<created>");
      } else if (oracle.type === "equals") {
        setPath(world, oracle.path, wrong ? "__incorrect__" : oracle.expected);
      } else if (oracle.type === "contains") {
        setPath(world, oracle.path, wrong ? [] : [oracle.value]);
      }
    }
    const verb = wrong ? "made plausible-but-wrong changes" : "completed the task";
    trace.push(`[${this.name}] ${verb}; reported world: ${JSON.stringify(world)}`);
    return { world, trace };
  }
}
