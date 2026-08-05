import type { NormalizedResult } from "ax-eval";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const NonBlank = z.string().min(1).refine((value) => value.trim().length > 0, "must not be blank");
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const NonNegativeFinite = z.number().nonnegative().finite();

export const ProviderModelRosterSchema = z.object({
  schema: z.literal("ax.provider-model-roster/v1"),
  roster_id: NonBlank,
  as_of: DateOnly,
  entries: z.array(z.object({
    harness: z.enum(["claude-code", "codex", "opencode"]),
    provider: NonBlank,
    model: NonBlank,
    effort: z.enum(["low", "medium", "high"]),
    role: z.enum(["production", "research"]),
    pricing_key: NonBlank,
  }).strict()).min(1),
}).strict().superRefine((roster, context) => {
  const identities = roster.entries.map((entry) =>
    JSON.stringify([entry.harness, entry.model, entry.effort]));
  if (new Set(identities).size !== identities.length) {
    context.addIssue({ code: "custom", path: ["entries"], message: "execution identities must be unique" });
  }
});
export type ProviderModelRoster = z.infer<typeof ProviderModelRosterSchema>;

export const PricingSnapshotSchema = z.object({
  schema: z.literal("ax.model-pricing-snapshot/v1"),
  snapshot_id: NonBlank,
  as_of: DateOnly,
  currency: z.literal("USD"),
  unit: z.literal("per_1m_tokens"),
  rates: z.array(z.object({
    pricing_key: NonBlank,
    provider: NonBlank,
    model: NonBlank,
    valid_from: DateOnly,
    valid_through: DateOnly.nullable(),
    input_accounting: z.enum([
      "cached_subset_of_input",
      "cache_read_and_write_subset_of_input",
      "cache_tokens_separate",
    ]),
    input_usd: NonNegativeFinite,
    cached_input_usd: NonNegativeFinite,
    cache_write_5m_usd: NonNegativeFinite,
    output_usd: NonNegativeFinite,
    source_url: z.string().url(),
    notes: z.array(NonBlank),
  }).strict()).min(1),
}).strict().superRefine((snapshot, context) => {
  const keys = snapshot.rates.map((rate) => rate.pricing_key);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: "custom", path: ["rates"], message: "pricing keys must be unique" });
  }
  for (const [index, rate] of snapshot.rates.entries()) {
    if (rate.valid_from > snapshot.as_of || (rate.valid_through !== null && snapshot.as_of > rate.valid_through)) {
      context.addIssue({
        code: "custom",
        path: ["rates", index],
        message: "snapshot date must fall inside the rate validity window",
      });
    }
  }
});
export type PricingSnapshot = z.infer<typeof PricingSnapshotSchema>;

export const ArenaRecordEconomicsSchema = z.object({
  product: NonBlank,
  surface: z.enum(["api", "cli", "sdk", "mcp"]),
  harness: NonBlank,
  provider: NonBlank.nullable(),
  model: NonBlank.nullable(),
  effort: z.enum(["low", "medium", "high"]).nullable(),
  pricing_key: NonBlank.nullable(),
  pricing_snapshot_id: NonBlank,
  status: z.enum(["priced", "unavailable"]),
  reason: NonBlank.nullable(),
  native_cost_usd: NonNegativeFinite.nullable(),
  estimated_cost_usd: NonNegativeFinite.nullable(),
  task_runs_passed: z.number().int().nonnegative(),
  task_runs_total: z.number().int().nonnegative(),
  cost_per_success_usd: NonNegativeFinite.nullable(),
  tokens: z.object({
    uncached_input: z.number().int().nonnegative(),
    cached_input: z.number().int().nonnegative(),
    cache_write_5m: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
  }).strict().nullable(),
}).strict();
export type ArenaRecordEconomics = z.infer<typeof ArenaRecordEconomicsSchema>;

export const ArenaEconomicsReportSchema = z.object({
  schema: z.literal("ax.arena-economics/v1"),
  roster_id: NonBlank,
  pricing_snapshot_id: NonBlank,
  pricing_as_of: DateOnly,
  currency: z.literal("USD"),
  cost_basis: z.literal("API list-price estimate; excludes subscriptions, credits, tool fees, long-context premiums, and regional multipliers"),
  cells: z.array(ArenaRecordEconomicsSchema),
}).strict();
export type ArenaEconomicsReport = z.infer<typeof ArenaEconomicsReportSchema>;

export function parseProviderModelRoster(text: string): ProviderModelRoster {
  return ProviderModelRosterSchema.parse(parseYaml(text));
}

export function parsePricingSnapshot(text: string): PricingSnapshot {
  return PricingSnapshotSchema.parse(parseYaml(text));
}

function token(usage: Record<string, number> | null | undefined, key: string): number {
  const value = usage?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function hasToken(usage: Record<string, number> | null | undefined, key: string): boolean {
  const value = usage?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function taskRunCounts(record: NormalizedResult): { passed: number; total: number } {
  if (record.summary_kind === "aggregate" && record.trial_values?.length) {
    return {
      passed: record.trial_values.reduce((sum, rate) => sum + Math.round(rate * record.tasks_total), 0),
      total: record.tasks_total * record.trial_values.length,
    };
  }
  return { passed: record.tasks_passed, total: record.tasks_total };
}

export function estimateRecordEconomics(
  record: NormalizedResult,
  roster: ProviderModelRoster,
  pricing: PricingSnapshot,
): ArenaRecordEconomics {
  const counts = taskRunCounts(record);
  const rosterEntry = roster.entries.find((entry) =>
    entry.harness === record.harness && entry.model === record.model && entry.effort === record.effort);
  const rate = rosterEntry
    ? pricing.rates.find((candidate) => candidate.pricing_key === rosterEntry.pricing_key)
    : undefined;
  const base = {
    product: record.product,
    surface: record.surface,
    harness: record.harness,
    provider: rosterEntry?.provider ?? null,
    model: record.model,
    effort: record.effort,
    pricing_key: rosterEntry?.pricing_key ?? null,
    pricing_snapshot_id: pricing.snapshot_id,
    native_cost_usd: typeof record.cost_usd === "number" ? record.cost_usd : null,
    task_runs_passed: counts.passed,
    task_runs_total: counts.total,
  } as const;
  if (!rosterEntry) {
    return ArenaRecordEconomicsSchema.parse({
      ...base,
      status: "unavailable",
      reason: "execution identity is not present in the provider/model roster",
      estimated_cost_usd: null,
      cost_per_success_usd: null,
      tokens: null,
    });
  }
  if (!rate || rate.provider !== rosterEntry.provider || rate.model !== rosterEntry.model) {
    return ArenaRecordEconomicsSchema.parse({
      ...base,
      status: "unavailable",
      reason: "roster pricing key is missing or does not match provider/model",
      estimated_cost_usd: null,
      cost_per_success_usd: null,
      tokens: null,
    });
  }
  if (!record.token_usage) {
    return ArenaRecordEconomicsSchema.parse({
      ...base,
      status: "unavailable",
      reason: "normalized record has no token usage",
      estimated_cost_usd: null,
      cost_per_success_usd: null,
      tokens: null,
    });
  }
  const input = token(record.token_usage, "input_tokens");
  const cached = token(record.token_usage, "cached_input_tokens")
    || token(record.token_usage, "cache_read_input_tokens");
  const cacheWrite = token(record.token_usage, "cache_write_input_tokens")
    || token(record.token_usage, "cache_creation_input_tokens");
  if (rate.input_accounting === "cache_read_and_write_subset_of_input"
    && !hasToken(record.token_usage, "cache_write_input_tokens")
    && !hasToken(record.token_usage, "cache_creation_input_tokens")) {
    return ArenaRecordEconomicsSchema.parse({
      ...base,
      status: "unavailable",
      reason: "normalized record has no cache-write token usage required by the pricing snapshot",
      estimated_cost_usd: null,
      cost_per_success_usd: null,
      tokens: null,
    });
  }
  const uncached = rate.input_accounting === "cache_read_and_write_subset_of_input"
    ? Math.max(0, input - cached - cacheWrite)
    : rate.input_accounting === "cached_subset_of_input"
      ? Math.max(0, input - cached)
      : input;
  const output = token(record.token_usage, "output_tokens");
  const estimatedCost = (
    uncached * rate.input_usd
    + cached * rate.cached_input_usd
    + cacheWrite * rate.cache_write_5m_usd
    + output * rate.output_usd
  ) / 1_000_000;
  return ArenaRecordEconomicsSchema.parse({
    ...base,
    status: "priced",
    reason: null,
    estimated_cost_usd: estimatedCost,
    cost_per_success_usd: counts.passed > 0 ? estimatedCost / counts.passed : null,
    tokens: {
      uncached_input: uncached,
      cached_input: cached,
      cache_write_5m: cacheWrite,
      output,
    },
  });
}

export function buildArenaEconomicsReport(
  records: readonly NormalizedResult[],
  roster: ProviderModelRoster,
  pricing: PricingSnapshot,
): ArenaEconomicsReport {
  const cells = records.map((record) => estimateRecordEconomics(record, roster, pricing))
    .sort((left, right) => JSON.stringify([
      left.product,
      left.harness,
      left.model,
      left.effort,
      left.surface,
    ]).localeCompare(JSON.stringify([
      right.product,
      right.harness,
      right.model,
      right.effort,
      right.surface,
    ])));
  return ArenaEconomicsReportSchema.parse({
    schema: "ax.arena-economics/v1",
    roster_id: roster.roster_id,
    pricing_snapshot_id: pricing.snapshot_id,
    pricing_as_of: pricing.as_of,
    currency: pricing.currency,
    cost_basis: "API list-price estimate; excludes subscriptions, credits, tool fees, long-context premiums, and regional multipliers",
    cells,
  });
}
