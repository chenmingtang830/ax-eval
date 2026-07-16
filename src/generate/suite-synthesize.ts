import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { z } from "zod";
import { assertArtifactSegment } from "./artifact-path.js";
import {
  ConceptUniverseSchema,
  CoverageSelectionSchema,
  type ConceptUniverse,
  type CoverageSelection,
} from "./coverage.js";
import { loadSuite, SuiteSchema, type Suite } from "./suite.js";
import { SuiteMethodologySchema, type SuiteMethodology } from "./suite-methodology.js";
import { parseStructuredOutput, runStructuredGenerator, type StructuredGenerator } from "./structured-output.js";

const GeneratedDraftSchema = z.object({
  concept_name: z.string().min(1),
  difficulty: z.enum(["L1", "L2", "L3", "L4"]),
  intent: z.string().min(1),
  oracle_hint: z.string().min(1),
  na_examples: z.array(z.string().min(1)).default([]),
}).strict();

const GeneratedDraftsSchema = z.object({
  tasks: z.array(GeneratedDraftSchema).min(1),
}).strict();

type GeneratedDraft = z.infer<typeof GeneratedDraftSchema>;

const SECRET_LITERAL_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~-]{20,}\b/i,
  /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s/:@]+:[^\s@]+@/i,
];

function assertNoSecretLiterals(drafts: readonly GeneratedDraft[]): void {
  const serialized = JSON.stringify(drafts);
  if (SECRET_LITERAL_PATTERNS.some((pattern) => pattern.test(serialized))) {
    throw new Error("suite synthesis returned embedded credential material");
  }
}

function assertVendorNeutral(drafts: readonly GeneratedDraft[], universe: ConceptUniverse): void {
  const vendorNames = [...new Set(universe.members.map((member) => member.vendor.toLowerCase()))];
  for (const draft of drafts) {
    const taskText = [draft.intent, ...draft.na_examples].join("\n").toLowerCase();
    if (/https?:\/\//i.test(taskText)) throw new Error(`suite task ${draft.concept_name} contains a vendor-specific URL`);
    const vendorName = vendorNames.find((vendor) => vendor.length >= 4 && taskText.includes(vendor));
    if (vendorName) throw new Error(`suite task ${draft.concept_name} names vendor ${vendorName}`);
  }
}

function categoryPrefix(category: string): string {
  if (category === "database") return "db";
  return category.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 8) || "task";
}

function databaseDraft(conceptName: string, family: string): Omit<GeneratedDraft, "concept_name"> {
  const resource = `ax_${conceptName.replace(/-/g, "_")}_{ns}`;
  if (family === "data-definition") return {
    difficulty: "L1",
    intent: `Create a documented data container named ${resource} with deterministic id and status fields.`,
    oracle_hint: "Read the live schema or collection metadata and assert the container and required fields exist.",
    na_examples: ["The product exposes no user-managed schema or collection primitive."],
  };
  if (family === "writes") return {
    difficulty: "L1",
    intent: `Create ${resource} and write records including the marker ax_marker_{ns}.`,
    oracle_hint: "Read live rows or documents and assert the marker record and expected values exist.",
    na_examples: ["The product is read-only and exposes no persistent write operation."],
  };
  if (family === "reads") return {
    difficulty: "L2",
    intent: `Create and populate ${resource}, then perform a filtered read that returns only the active marker ax_marker_{ns}.`,
    oracle_hint: "Run an independent filtered read and assert the exact marker and result count.",
    na_examples: ["The product cannot filter or query persisted records."],
  };
  if (family === "integrity") return {
    difficulty: "L2",
    intent: `Create ${resource} with a documented integrity rule that protects a deterministic marker field.`,
    oracle_hint: "Inspect live schema metadata and assert the required, unique, or validation rule is present.",
    na_examples: ["The product documents no integrity or validation mechanism."],
  };
  if (family === "access-control") return {
    difficulty: "L3",
    intent: `Create ${resource} and configure a least-privilege read-only role or policy named ax_reader_{ns}.`,
    oracle_hint: "Read live role or policy metadata and assert the scoped read permission exists without write permission.",
    na_examples: ["Access control is account-wide only and exposes no inspectable scoped role or policy."],
  };
  if (family === "migration") return {
    difficulty: "L3",
    intent: `Create ${resource} with a marker record, apply a tracked schema change adding priority, and preserve the marker.`,
    oracle_hint: "Inspect the changed schema and read the pre-existing marker to verify both migration and preservation.",
    na_examples: ["The product has no user-visible schema evolution mechanism."],
  };
  if (family === "operations") return {
    difficulty: "L3",
    intent: `Create ${resource} and complete the documented operational workflow for inspecting or exporting its state.`,
    oracle_hint: "Read live operation metadata or exported state and assert it references the deterministic resource.",
    na_examples: ["No inspectable operational workflow is documented for user-managed data."],
  };
  if (family === "recovery") return {
    difficulty: "L4",
    intent: `Create ${resource} with marker ax_marker_{ns}, take a documented backup or snapshot, change the marker state, and recover it.`,
    oracle_hint: "Read live restored state and assert the original marker value is present after recovery.",
    na_examples: ["The product documents no user-triggered backup, snapshot, or recovery mechanism."],
  };
  return {
    difficulty: "L2",
    intent: `Use the documented ${conceptName.replace(/-/g, " ")} capability on ${resource} and leave deterministic live state.`,
    oracle_hint: "Read the resulting live state independently and assert the documented outcome.",
    na_examples: ["Official documentation does not expose a verifiable implementation of this capability."],
  };
}

function deterministicDrafts(category: string, selection: CoverageSelection): GeneratedDraft[] {
  if (category !== "database") {
    throw new Error(`deterministic suite synthesis is not defined for category ${category}; inject a grounded generator`);
  }
  return selection.selected.map((concept) => ({
    concept_name: concept.concept_name,
    ...databaseDraft(concept.concept_name, concept.family),
  }));
}

function validateSelection(universe: ConceptUniverse, selection: CoverageSelection): void {
  if (universe.category !== selection.category) throw new Error("concept universe and selection categories differ");
  const clusters = new Map(universe.clusters.map((cluster) => [cluster.concept_name, cluster]));
  for (const concept of selection.selected) {
    const cluster = clusters.get(concept.concept_name);
    if (!cluster) throw new Error(`selection references unknown concept ${concept.concept_name}`);
    if (cluster.family !== concept.family || cluster.skill !== concept.skill || cluster.title !== concept.title) {
      throw new Error(`selection metadata drifted for concept ${concept.concept_name}`);
    }
  }
}

function validateDrafts(drafts: readonly GeneratedDraft[], selection: CoverageSelection): void {
  const expected = selection.selected.map((concept) => concept.concept_name);
  const seen = new Set<string>();
  for (const draft of drafts) {
    if (seen.has(draft.concept_name)) throw new Error(`suite synthesis returned duplicate concept ${draft.concept_name}`);
    seen.add(draft.concept_name);
    if (!expected.includes(draft.concept_name)) throw new Error(`suite synthesis returned extra concept ${draft.concept_name}`);
    if (!draft.intent.includes("{ns}")) throw new Error(`suite task ${draft.concept_name} dropped the required {ns} placeholder`);
    if (!/\b(?:read|query|inspect|fetch|assert|verify)\b/i.test(draft.oracle_hint)) {
      throw new Error(`suite task ${draft.concept_name} lacks an independent read-back oracle hint`);
    }
  }
  const missing = expected.filter((conceptName) => !seen.has(conceptName));
  if (missing.length > 0) throw new Error(`suite synthesis omitted concepts [${missing.join(", ")}]`);
  assertNoSecretLiterals(drafts);
}

export function buildSuiteSynthesisPrompt(
  suiteName: string,
  universe: ConceptUniverse,
  selection: CoverageSelection,
  methodology: SuiteMethodology,
): string {
  const membersById = new Map(universe.members.map((member) => [member.member_id, member]));
  const selectedEvidence = selection.selected.map((concept) => {
    const cluster = universe.clusters.find((candidate) => candidate.concept_name === concept.concept_name)!;
    return {
      ...concept,
      examples: cluster.member_ids.map((memberId) => {
        const member = membersById.get(memberId)!;
        return { title: member.title, description: member.description, evidence_urls: member.evidence_urls };
      }),
    };
  });
  return [
    `Draft the vendor-neutral canonical tasks for suite ${suiteName}.`,
    "Return exactly one task draft per selected concept, with no vendor names or vendor-specific endpoints.",
    "Every intent must use a literal {ns} placeholder and describe deterministic sandbox state.",
    "Every oracle_hint must describe independent live-state read-back, never executor self-report alone.",
    "Never include credentials, tokens, passwords, connection strings, or secret values.",
    `Difficulty rubric: ${JSON.stringify(methodology.difficulty_rubric)}.`,
    "Return JSON only with tasks containing concept_name, difficulty, intent, oracle_hint, and na_examples.",
    JSON.stringify(selectedEvidence, null, 2),
  ].join("\n\n");
}

export async function synthesizeSuite(
  suiteName: string,
  version: number,
  category: string,
  universe: ConceptUniverse,
  selection: CoverageSelection,
  methodology: SuiteMethodology,
  options: { generate?: StructuredGenerator } = {},
): Promise<Suite> {
  assertArtifactSegment(suiteName, "suite name");
  ConceptUniverseSchema.parse(universe);
  CoverageSelectionSchema.parse(selection);
  SuiteMethodologySchema.parse(methodology);
  validateSelection(universe, selection);
  if (selection.target_task_count !== methodology.target_task_count) {
    throw new Error("coverage selection target does not match suite methodology");
  }
  const drafts = options.generate
    ? GeneratedDraftsSchema.parse(parseStructuredOutput(
        await runStructuredGenerator(buildSuiteSynthesisPrompt(suiteName, universe, selection, methodology), options.generate),
      )).tasks
    : deterministicDrafts(category, selection);
  validateDrafts(drafts, selection);
  assertVendorNeutral(drafts, universe);
  const draftByConcept = new Map(drafts.map((draft) => [draft.concept_name, draft]));
  const prefix = categoryPrefix(category);
  return SuiteSchema.parse({
    name: suiteName,
    version,
    category,
    description: `Canonical ${category} benchmark synthesized from reviewed capability coverage.`,
    methodology,
    tasks: selection.selected.map((concept, index) => {
      const draft = draftByConcept.get(concept.concept_name)!;
      return {
        id: `${prefix}-T${String(index + 1).padStart(2, "0")}-${concept.concept_name}`,
        title: concept.title,
        difficulty: draft.difficulty,
        skill: concept.skill,
        intent: draft.intent,
        oracle_hint: draft.oracle_hint,
        allowed_surfaces: methodology.surface_scope,
        na_examples: draft.na_examples,
      };
    }),
  });
}

export function synthesizedSuitePath(root: string, suiteName: string): string {
  return resolve(root, "targets", "suites", `${assertArtifactSegment(suiteName, "suite name")}.yaml`);
}

export function writeSynthesizedSuite(root: string, suite: Suite): string {
  const path = synthesizedSuitePath(root, suite.name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, yamlStringify(SuiteSchema.parse(suite)));
  renameSync(`${path}.tmp`, path);
  return path;
}

export function loadSynthesizedSuite(root: string, suiteName: string): Suite {
  return loadSuite(synthesizedSuitePath(root, suiteName));
}
