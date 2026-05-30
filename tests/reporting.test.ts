import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPack } from "../src/config.js";
import { render } from "../src/reporting.js";
import { run } from "../src/runner.js";
import { loadReport, saveReport } from "../src/storage.js";

const PACK = resolve(dirname(fileURLToPath(import.meta.url)), "..", "targets", "asana", "pack.yaml");

describe("reporting + storage", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "axeval-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("render contains the matrix and pass rates", async () => {
    const pack = loadPack(PACK);
    const report = await run(pack, ["mock", "mock-weak", "hermes"]);
    const text = render(report);
    expect(text).toContain("asana");
    expect(text).toContain("Pass rate by harness");
    expect(text).toContain("PASS");
    expect(text).toContain("FAIL");
    expect(text).toContain("mock-weak");
  });

  it("save + load round-trips", async () => {
    const pack = loadPack(PACK);
    const report = await run(pack, ["mock"]);
    const out = saveReport(report, join(dir, "r.json"));
    const payload = loadReport(out);
    expect(payload.pack).toBe("asana");
    expect(payload.results.length).toBe(pack.tasks.length);
  });
});
