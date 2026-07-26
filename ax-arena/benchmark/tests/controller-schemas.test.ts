import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { ArenaCellCleanupSchema } from "../src/controller/schemas.js";

function shippedSchema(): Record<string, unknown> {
  return JSON.parse(readFileSync(
    resolve(process.cwd(), "schemas", "arena-cell-cleanup.v1.json"),
    "utf8",
  ));
}

describe("arena cell cleanup schema", () => {
  it("ships a strict JSON schema for persisted cleanup evidence", () => {
    const schema = shippedSchema() as { additionalProperties: boolean; required: string[] };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(expect.arrayContaining([
      "schema",
      "cell_id",
      "record_path",
      "record_sha256",
      "status",
      "message",
      "errors",
    ]));
  });

  it("keeps the runtime contract strict", () => {
    const cleanup = ArenaCellCleanupSchema.parse({
      schema: "ax.arena-cell-cleanup/v1",
      cell_id: "cell-1",
      record_path: "/run/record.json",
      record_sha256: "0".repeat(64),
      generated_at: "2026-07-21T00:00:01.000Z",
      status: "skipped",
      message: "test",
      errors: [],
    });
    expect(cleanup.status).toBe("skipped");
    expect(ArenaCellCleanupSchema.safeParse({ ...cleanup, unknown: true }).success).toBe(false);
    expect(ArenaCellCleanupSchema.safeParse({ ...cleanup, cell_id: "   " }).success).toBe(false);
    expect(ArenaCellCleanupSchema.safeParse({ ...cleanup, record_sha256: "short" }).success).toBe(false);
  });

  it("rejects evidence-free confirmed cleanup in both runtime and published schemas", () => {
    const invalid = {
      schema: "ax.arena-cell-cleanup/v1",
      cell_id: "cell-1",
      record_path: "/run/record.json",
      record_sha256: "0".repeat(64),
      generated_at: "2026-07-21T00:00:01.000Z",
      status: "confirmed",
      message: "claimed cleanup",
      errors: [],
    };
    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);
    const validate = ajv.compile(shippedSchema());
    expect(ArenaCellCleanupSchema.safeParse(invalid).success).toBe(false);
    expect(validate(invalid)).toBe(false);

    const valid = {
      ...invalid,
      provider: { id: "reset", version: "1.0.0" },
      namespace: "cell-ns",
      plan: { summary: "one", resources: ["resource:cell-ns"] },
      evidence: {
        supported: true,
        message: "deleted",
        deleted: ["resource:cell-ns"],
        errors: [],
      },
    };
    expect(ArenaCellCleanupSchema.safeParse(valid).success).toBe(true);
    expect(validate(valid)).toBe(true);
    expect(ArenaCellCleanupSchema.safeParse({
      ...valid,
      evidence: { ...valid.evidence, deleted: ["resource:other"] },
    }).success).toBe(false);
  });
});
