import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { z } from "zod";
import { assertArtifactSegment } from "./artifact-path.js";
import { loadOptionalYamlArtifact } from "./artifact-yaml.js";
import type { CapabilityExtractResult } from "./capability-extract.js";
import type { SuiteMethodology } from "./suite-methodology.js";
import { parseStructuredOutput, runStructuredGenerator, type StructuredGenerator } from "./structured-output.js";

const MemberSchema = z.object({
  member_id: z.string().min(1),
  vendor: z.string().min(1),
  slug: z.string().min(1),
  capability_name: z.string().min(1),
  title: z.string().min(1),
  family: z.string().min(1),
  description: z.string().min(1),
  evidence_urls: z.array(z.string().url()).min(1),
}).strict();

const SkillSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a kebab-case skill");

const ClusterSchema = z.object({
  concept_name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a kebab-case concept name"),
  title: z.string().min(1),
  skill: SkillSchema,
  family: z.string().min(1),
  member_ids: z.array(z.string().min(1)).min(1).refine(
    (ids) => new Set(ids).size === ids.length,
    "cluster member ids must be unique",
  ),
}).strict();

const GeneratedClusterSchema = ClusterSchema.omit({ skill: true });

export const ConceptUniverseSchema = z.object({
  category: z.string().min(1),
  generated_at: z.string().datetime(),
  method: z.enum(["deterministic", "grounded-generator"]),
  vendor_count: z.number().int().positive(),
  members: z.array(MemberSchema).min(1),
  clusters: z.array(ClusterSchema.extend({
    vendor_coverage: z.number().min(0).max(1),
  })).min(1),
}).strict().superRefine((universe, context) => {
  const members = new Map(universe.members.map((member) => [member.member_id, member]));
  if (members.size !== universe.members.length) {
    context.addIssue({ code: "custom", path: ["members"], message: "member ids must be unique" });
  }
  const actualVendorCount = new Set(universe.members.map((member) => member.slug)).size;
  if (universe.vendor_count !== actualVendorCount) {
    context.addIssue({ code: "custom", path: ["vendor_count"], message: `must equal ${actualVendorCount}` });
  }
  const assigned = new Set<string>();
  const conceptNames = new Set<string>();
  for (const [clusterIndex, cluster] of universe.clusters.entries()) {
    if (conceptNames.has(cluster.concept_name)) {
      context.addIssue({ code: "custom", path: ["clusters", clusterIndex, "concept_name"], message: "concept names must be unique" });
    }
    conceptNames.add(cluster.concept_name);
    const coveredVendors = new Set<string>();
    for (const memberId of cluster.member_ids) {
      const member = members.get(memberId);
      if (!member) {
        context.addIssue({ code: "custom", path: ["clusters", clusterIndex, "member_ids"], message: `unknown member ${memberId}` });
        continue;
      }
      if (assigned.has(memberId)) {
        context.addIssue({ code: "custom", path: ["clusters", clusterIndex, "member_ids"], message: `member ${memberId} is assigned more than once` });
      }
      assigned.add(memberId);
      coveredVendors.add(member.slug);
    }
    const expectedCoverage = coveredVendors.size / universe.vendor_count;
    if (Math.abs(cluster.vendor_coverage - expectedCoverage) > Number.EPSILON) {
      context.addIssue({ code: "custom", path: ["clusters", clusterIndex, "vendor_coverage"], message: `must equal ${expectedCoverage}` });
    }
  }
  const omitted = [...members.keys()].filter((memberId) => !assigned.has(memberId));
  if (omitted.length > 0) context.addIssue({ code: "custom", path: ["clusters"], message: `omitted members [${omitted.join(", ")}]` });
});

export type ConceptUniverse = z.infer<typeof ConceptUniverseSchema>;

export const CoverageMatrixSchema = z.object({
  category: z.string().min(1),
  generated_at: z.string().datetime(),
  decisions: z.array(z.object({
    vendor: z.string().min(1),
    slug: z.string().min(1),
    concept_name: z.string().min(1),
    status: z.enum(["supported", "unknown"]),
    evidence_urls: z.array(z.string().url()),
  }).strict()),
}).strict().superRefine((matrix, context) => {
  const seen = new Set<string>();
  for (const [index, decision] of matrix.decisions.entries()) {
    const key = `${decision.slug}:${decision.concept_name}`;
    if (seen.has(key)) context.addIssue({ code: "custom", path: ["decisions", index], message: `duplicate decision ${key}` });
    seen.add(key);
    if (decision.status === "supported" && decision.evidence_urls.length === 0) {
      context.addIssue({ code: "custom", path: ["decisions", index, "evidence_urls"], message: "supported decisions require evidence" });
    }
    if (decision.status === "unknown" && decision.evidence_urls.length > 0) {
      context.addIssue({ code: "custom", path: ["decisions", index, "evidence_urls"], message: "unknown decisions cannot claim support evidence" });
    }
  }
});

export type CoverageMatrix = z.infer<typeof CoverageMatrixSchema>;

export const CoverageSelectionSchema = z.object({
  category: z.string().min(1),
  generated_at: z.string().datetime(),
  target_task_count: z.number().int().positive(),
  selected: z.array(z.object({
    concept_name: z.string().min(1),
    title: z.string().min(1),
    skill: SkillSchema,
    family: z.string().min(1),
    vendor_coverage: z.number().min(0).max(1),
    rationale: z.string().min(1),
  }).strict()),
  excluded: z.array(z.object({
    concept_name: z.string().min(1),
    reason: z.enum(["below-coverage-floor", "family-diversity-cap", "target-reached"]),
  }).strict()),
}).strict().superRefine((selection, context) => {
  if (selection.selected.length !== selection.target_task_count) {
    context.addIssue({ code: "custom", path: ["selected"], message: "selected concepts must equal target_task_count" });
  }
});

export type CoverageSelection = z.infer<typeof CoverageSelectionSchema>;

function normalizedConceptName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "capability";
}

function capabilityMembers(extracts: readonly CapabilityExtractResult[]): z.infer<typeof MemberSchema>[] {
  const seenVendors = new Set<string>();
  const members: z.infer<typeof MemberSchema>[] = [];
  for (const extract of extracts) {
    if (extract.category !== extracts[0]?.category) throw new Error("capability extracts must use one category");
    if (seenVendors.has(extract.slug)) throw new Error(`duplicate capability extract for ${extract.slug}`);
    seenVendors.add(extract.slug);
    for (const capability of extract.capabilities) {
      members.push(MemberSchema.parse({
        member_id: `${extract.slug}:${capability.capability_name}`,
        vendor: extract.vendor,
        slug: extract.slug,
        capability_name: capability.capability_name,
        title: capability.title,
        family: capability.family,
        description: capability.description,
        evidence_urls: capability.evidence.map((evidence) => evidence.doc_url),
      }));
    }
  }
  const duplicateMember = members.find((member, index) => members.findIndex((candidate) => candidate.member_id === member.member_id) !== index);
  if (duplicateMember) throw new Error(`duplicate capability member ${duplicateMember.member_id}`);
  if (members.length === 0) throw new Error("concept universe requires at least one capability");
  return members;
}

function deterministicClusters(members: readonly z.infer<typeof MemberSchema>[]): z.infer<typeof ClusterSchema>[] {
  const groups = new Map<string, z.infer<typeof MemberSchema>[]>();
  for (const member of members) {
    const key = normalizedConceptName(member.capability_name);
    groups.set(key, [...(groups.get(key) ?? []), member]);
  }
  return [...groups.entries()].map(([conceptName, group]) => {
    const familyCounts = new Map<string, number>();
    for (const member of group) familyCounts.set(member.family, (familyCounts.get(member.family) ?? 0) + 1);
    const family = [...familyCounts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]![0];
    return {
      concept_name: conceptName,
      title: group[0]!.title,
      skill: conceptName,
      family,
      member_ids: group.map((member) => member.member_id),
    };
  });
}

function validatePartition(
  clusters: readonly z.infer<typeof ClusterSchema>[],
  members: readonly z.infer<typeof MemberSchema>[],
  methodology: SuiteMethodology,
): void {
  const expected = new Set(members.map((member) => member.member_id));
  const assigned = new Set<string>();
  const conceptNames = new Set<string>();
  for (const cluster of clusters) {
    if (conceptNames.has(cluster.concept_name)) throw new Error(`duplicate concept ${cluster.concept_name}`);
    conceptNames.add(cluster.concept_name);
    if (!methodology.capability_families.includes(cluster.family)) {
      throw new Error(`concept ${cluster.concept_name} uses undeclared family ${cluster.family}`);
    }
    for (const memberId of cluster.member_ids) {
      if (!expected.has(memberId)) throw new Error(`concept ${cluster.concept_name} references unknown member ${memberId}`);
      if (assigned.has(memberId)) throw new Error(`capability member ${memberId} appears in more than one concept`);
      assigned.add(memberId);
    }
  }
  const missing = [...expected].filter((memberId) => !assigned.has(memberId));
  if (missing.length > 0) throw new Error(`concept clustering omitted members [${missing.join(", ")}]`);
}

export function buildCoverageMatrix(
  universe: ConceptUniverse,
  now: () => Date = () => new Date(),
): CoverageMatrix {
  const vendors = new Map<string, string>();
  for (const member of universe.members) vendors.set(member.slug, member.vendor);
  const membersById = new Map(universe.members.map((member) => [member.member_id, member]));
  return CoverageMatrixSchema.parse({
    category: universe.category,
    generated_at: now().toISOString(),
    decisions: universe.clusters.flatMap((cluster) => [...vendors].map(([slug, vendor]) => {
      const matching = cluster.member_ids.map((memberId) => membersById.get(memberId)!).filter((member) => member.slug === slug);
      return {
        vendor,
        slug,
        concept_name: cluster.concept_name,
        status: matching.length > 0 ? "supported" : "unknown",
        evidence_urls: [...new Set(matching.flatMap((member) => member.evidence_urls))],
      };
    })),
  });
}

export function buildCoveragePrompt(
  category: string,
  members: readonly z.infer<typeof MemberSchema>[],
  methodology: SuiteMethodology,
): string {
  return [
    `Cluster the official ${category} capability inventory into vendor-neutral benchmark concepts.`,
    "Return an exact partition: every member_id exactly once, with no invented or omitted members.",
    `Allowed capability families: ${methodology.capability_families.join(", ")}.`,
    "Use kebab-case concept_name values and concise vendor-neutral titles.",
    "Return JSON only with a top-level clusters array containing concept_name, title, family, and member_ids.",
    JSON.stringify(members, null, 2),
  ].join("\n\n");
}

export async function deriveConceptUniverse(
  category: string,
  extracts: readonly CapabilityExtractResult[],
  methodology: SuiteMethodology,
  options: { generate?: StructuredGenerator; now?: () => Date } = {},
): Promise<ConceptUniverse> {
  if (extracts.some((extract) => extract.category !== category)) {
    throw new Error(`capability extracts do not match category ${category}`);
  }
  const members = capabilityMembers(extracts);
  const generated = options.generate
    ? z.object({ clusters: z.array(GeneratedClusterSchema).min(1) }).strict().parse(parseStructuredOutput(
        await runStructuredGenerator(buildCoveragePrompt(category, members, methodology), options.generate),
      )).clusters.map((cluster) => ({ ...cluster, skill: cluster.concept_name }))
    : deterministicClusters(members);
  validatePartition(generated, members, methodology);
  const vendorCount = new Set(members.map((member) => member.slug)).size;
  const byId = new Map(members.map((member) => [member.member_id, member]));
  return ConceptUniverseSchema.parse({
    category,
    generated_at: (options.now ?? (() => new Date()))().toISOString(),
    method: options.generate ? "grounded-generator" : "deterministic",
    vendor_count: vendorCount,
    members,
    clusters: generated.map((cluster) => ({
      ...cluster,
      vendor_coverage: new Set(cluster.member_ids.map((memberId) => byId.get(memberId)!.slug)).size / vendorCount,
    })),
  });
}

export function selectCoverageConcepts(
  universe: ConceptUniverse,
  methodology: SuiteMethodology,
  now: () => Date = () => new Date(),
): CoverageSelection {
  const selected: CoverageSelection["selected"] = [];
  const excluded: CoverageSelection["excluded"] = [];
  const familyCounts = new Map<string, number>();
  const ranked = [...universe.clusters].sort((left, right) =>
    right.vendor_coverage - left.vendor_coverage || left.concept_name.localeCompare(right.concept_name));
  for (const cluster of ranked) {
    if (cluster.vendor_coverage < methodology.min_vendor_coverage_pct) {
      excluded.push({ concept_name: cluster.concept_name, reason: "below-coverage-floor" });
      continue;
    }
    if ((familyCounts.get(cluster.family) ?? 0) >= methodology.family_diversity_cap) {
      excluded.push({ concept_name: cluster.concept_name, reason: "family-diversity-cap" });
      continue;
    }
    if (selected.length >= methodology.target_task_count) {
      excluded.push({ concept_name: cluster.concept_name, reason: "target-reached" });
      continue;
    }
    selected.push({
      concept_name: cluster.concept_name,
      title: cluster.title,
      skill: cluster.skill,
      family: cluster.family,
      vendor_coverage: cluster.vendor_coverage,
      rationale: `Meets ${(methodology.min_vendor_coverage_pct * 100).toFixed(0)}% coverage floor and family diversity policy.`,
    });
    familyCounts.set(cluster.family, (familyCounts.get(cluster.family) ?? 0) + 1);
  }
  if (selected.length !== methodology.target_task_count) {
    throw new Error(
      `coverage policy selected ${selected.length} concepts, but methodology requires ${methodology.target_task_count}; review the coverage floor, family cap, or source inventory`,
    );
  }
  return CoverageSelectionSchema.parse({
    category: universe.category,
    generated_at: now().toISOString(),
    target_task_count: methodology.target_task_count,
    selected,
    excluded,
  });
}

export function conceptUniversePath(root: string, suiteName: string): string {
  return resolve(root, "targets", "suites", `${assertArtifactSegment(suiteName, "suite name")}.concepts.yaml`);
}

export function coverageSelectionPath(root: string, suiteName: string): string {
  return resolve(root, "targets", "suites", `${assertArtifactSegment(suiteName, "suite name")}.selection.yaml`);
}

export function coverageMatrixPath(root: string, suiteName: string): string {
  return resolve(root, "targets", "suites", `${assertArtifactSegment(suiteName, "suite name")}.coverage.yaml`);
}

function writeArtifact(path: string, value: unknown): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, yamlStringify(value));
  renameSync(`${path}.tmp`, path);
  return path;
}

export function writeConceptUniverse(root: string, suiteName: string, universe: ConceptUniverse): string {
  return writeArtifact(conceptUniversePath(root, suiteName), ConceptUniverseSchema.parse(universe));
}

export function writeCoverageSelection(root: string, suiteName: string, selection: CoverageSelection): string {
  return writeArtifact(coverageSelectionPath(root, suiteName), CoverageSelectionSchema.parse(selection));
}

export function writeCoverageMatrix(root: string, suiteName: string, matrix: CoverageMatrix): string {
  return writeArtifact(coverageMatrixPath(root, suiteName), CoverageMatrixSchema.parse(matrix));
}

export function loadConceptUniverse(root: string, suiteName: string): ConceptUniverse | null {
  return loadConceptUniversePath(conceptUniversePath(root, suiteName));
}

export function loadCoverageSelection(root: string, suiteName: string): CoverageSelection | null {
  return loadCoverageSelectionPath(coverageSelectionPath(root, suiteName));
}

export function loadCoverageMatrix(root: string, suiteName: string): CoverageMatrix | null {
  return loadCoverageMatrixPath(coverageMatrixPath(root, suiteName));
}

export function loadConceptUniversePath(path: string): ConceptUniverse | null {
  return loadOptionalYamlArtifact(path, ConceptUniverseSchema, "concept universe");
}

export function loadCoverageSelectionPath(path: string): CoverageSelection | null {
  return loadOptionalYamlArtifact(path, CoverageSelectionSchema, "coverage selection");
}

export function loadCoverageMatrixPath(path: string): CoverageMatrix | null {
  return loadOptionalYamlArtifact(path, CoverageMatrixSchema, "coverage matrix");
}
