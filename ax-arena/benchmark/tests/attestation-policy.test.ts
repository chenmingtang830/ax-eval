import { afterEach, describe, expect, it } from "vitest";
import {
  TrustedRunSubjectSchema,
  verifyBundledHostedAttestation,
} from "../src/publication/attestation.js";

const ENV = "AX_ARENA_APPROVED_SIGNER_SHA";
const original = process.env[ENV];

afterEach(() => {
  if (original === undefined) delete process.env[ENV];
  else process.env[ENV] = original;
});

function subject() {
  return TrustedRunSubjectSchema.parse({
    schema: "ax.arena-trusted-run-subject/v1",
    repository: "chenmingtang830/ax-eval",
    source_commit_sha: "a".repeat(40),
    protected_default_branch: "main",
    workflow: {
      ref: "chenmingtang830/ax-eval/.github/workflows/trusted-sandbox-records.yml@refs/heads/main",
      sha: "b".repeat(40),
      run_id: "123",
      run_attempt: "1",
      environment: "trusted-sandbox",
    },
    runtime: {
      lock_path: "ax-arena/benchmark/trusted-runtime/runtime-lock.json",
      lock_sha256: "c".repeat(64),
      container_digest: `sha256:${"d".repeat(64)}`,
      tools_tree_sha256: "e".repeat(64),
      manifest: { path: "runtime-manifest.json", sha256: "f".repeat(64) },
    },
    configuration: { path: "configuration.json", sha256: "1".repeat(64) },
    batch: {
      id: "batch-1",
      configuration_hash: "2".repeat(64),
      completed_cells: 1,
      manifest: { path: "batch.json", sha256: "3".repeat(64) },
      completion: { path: "batch-completion.json", sha256: "4".repeat(64) },
    },
    source_artifacts: [{
      path: "ax-arena/benchmark/daeb/v1/suite.yaml",
      sha256: "5".repeat(64),
    }],
  });
}

describe("hosted attestation signer policy", () => {
  it("requires an external approved signer SHA and rejects subject self-authorization", () => {
    const value = subject();
    delete process.env[ENV];
    expect(() => verifyBundledHostedAttestation(Buffer.from("{}\n"), Buffer.from("{}\n"), value))
      .toThrow(/requires external AX_ARENA_APPROVED_SIGNER_SHA/);
    process.env[ENV] = "9".repeat(40);
    expect(() => verifyBundledHostedAttestation(Buffer.from("{}\n"), Buffer.from("{}\n"), value))
      .toThrow(/not the externally approved workflow SHA/);
  });

  it("rejects noncanonical source artifact paths in the signed subject", () => {
    const value = { ...subject(), source_artifacts: [{ path: "ax-arena/benchmark/daeb/../payload", sha256: "5".repeat(64) }] };
    expect(() => TrustedRunSubjectSchema.parse(value)).toThrow(/canonical and contained/);
  });
});
