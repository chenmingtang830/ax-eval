/**
 * Name-based harness registry. The runner discovers adapters by name; harness
 * selection is config-driven. v0 registers only keyless adapters so the matrix
 * runs with no credentials:
 *
 *   mock       — a competent agent (passes everything)
 *   mock-weak  — a weaker agent (skips/flubs several tasks)
 *   hermes     — keyless stub for the planned Hermes harness
 *
 * Real adapters (claude-code, codex) register here once implemented.
 */
import type { HarnessAdapter } from "./base.js";
import { HermesHarness } from "./hermes.js";
import { MockHarness } from "./mock.js";

// A factory per name so each run gets a fresh adapter instance.
const FACTORIES = new Map<string, () => HarnessAdapter>();

export function registerHarness(name: string, factory: () => HarnessAdapter): void {
  FACTORIES.set(name, factory);
}

export function availableHarnesses(): string[] {
  return [...FACTORIES.keys()].sort();
}

export function getHarness(name: string): HarnessAdapter {
  const factory = FACTORIES.get(name);
  if (!factory) {
    throw new Error(`unknown harness '${name}'; available: ${availableHarnesses().join(", ")}`);
  }
  return factory();
}

// --- default keyless registrations ---------------------------------------
registerHarness("mock", () => new MockHarness("mock"));
registerHarness(
  "mock-weak",
  () =>
    new MockHarness("mock-weak", {
      skip: ["asana-move-section", "asana-subtask"],
      wrong: ["asana-due-date"],
    }),
);
registerHarness("hermes", () => new HermesHarness({ wrong: ["asana-comment"] }));
