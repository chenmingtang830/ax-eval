import {
  mkdirSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { TargetPackSchema, createDaebPathContext, type DaebPathInput } from "ax-eval";
import { describe, expect, it } from "vitest";
import {
  composedPackPath,
  writeComposedPack,
  writeComposedPackFileForTest,
} from "../src/authoring/compose-pack.js";

const pack = TargetPackSchema.parse({
  name: "acme",
  standard_set_version: "demo-v1",
  run_id: "demo",
  generated_by: "test",
  auth: { type: "none" },
  base_url: "https://example.invalid",
  tasks: [],
});

describe("arena pack composition paths", () => {
  it("writes only to the canonical DAEB pack tree", () => {
    const repositoryRoot = mkdtempSync(resolve(tmpdir(), "ax-compose-path-"));
    try {
      const paths = createDaebPathContext(repositoryRoot);
      const expected = resolve(
        repositoryRoot,
        "ax-arena/benchmark/daeb/v1/packs/acme/pack.yaml",
      );
      expect(composedPackPath(repositoryRoot, "acme", "DAEB-1")).toBe(expected);
      expect(composedPackPath(paths, "acme", "DAEB-1")).toBe(expected);
      expect(() => composedPackPath(paths, "../outside", "DAEB-1"))
        .toThrow(/single safe path segment/);
    } finally {
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("rejects a forged path context write root", () => {
    const repositoryRoot = mkdtempSync(resolve(tmpdir(), "ax-compose-context-"));
    const outside = mkdtempSync(resolve(tmpdir(), "ax-compose-outside-"));
    try {
      expect(() => composedPackPath({
        repositoryRoot,
        readRoot: resolve(repositoryRoot, "ax-arena/benchmark/daeb"),
        writeRoot: outside,
      } as unknown as DaebPathInput, "acme", "DAEB-1")).toThrow(/write root must be canonical/);
    } finally {
      rmSync(repositoryRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects symlink and hard-link aliases without modifying their targets", () => {
    for (const mode of ["ancestor", "leaf", "hard-link"] as const) {
      const repositoryRoot = mkdtempSync(resolve(tmpdir(), `ax-compose-${mode}-`));
      const outside = mkdtempSync(resolve(tmpdir(), `ax-compose-${mode}-outside-`));
      const outsidePack = resolve(outside, "outside-pack.yaml");
      writeFileSync(outsidePack, "outside remains unchanged\n");
      try {
        if (mode === "ancestor") {
          mkdirSync(resolve(repositoryRoot, "ax-arena", "benchmark"), { recursive: true });
          symlinkSync(outside, resolve(repositoryRoot, "ax-arena", "benchmark", "daeb"), "dir");
        } else if (mode === "leaf") {
          const packDir = resolve(repositoryRoot, "ax-arena/benchmark/daeb/v1/packs/acme");
          mkdirSync(packDir, { recursive: true });
          symlinkSync(outsidePack, resolve(packDir, "pack.yaml"));
        } else {
          const packDir = resolve(repositoryRoot, "ax-arena/benchmark/daeb/v1/packs/acme");
          mkdirSync(packDir, { recursive: true });
          linkSync(outsidePack, resolve(packDir, "pack.yaml"));
        }
        expect(() => writeComposedPack(repositoryRoot, "acme", "DAEB-1", pack))
          .toThrow(/symlink|single-link/);
        expect(readFileSync(outsidePack, "utf8")).toBe("outside remains unchanged\n");
      } finally {
        rmSync(repositoryRoot, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    }
  });

  it("keeps the canonical pack intact when a staged write fails", () => {
    const repositoryRoot = mkdtempSync(resolve(tmpdir(), "ax-compose-failed-write-"));
    try {
      const path = composedPackPath(repositoryRoot, "acme", "DAEB-1");
      mkdirSync(resolve(path, ".."), { recursive: true });
      writeFileSync(path, "original pack\n");
      expect(() => writeComposedPackFileForTest(path, repositoryRoot, "replacement pack\n", {
        write(descriptor) {
          writeFileSync(descriptor, "partial");
          throw new Error("injected write failure");
        },
      })).toThrow(/injected write failure/);
      expect(readFileSync(path, "utf8")).toBe("original pack\n");
      expect(readdirSync(resolve(path, "..")).filter((name) => name.includes(".tmp-"))).toEqual([]);
    } finally {
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("rejects parent substitution before creating the staged file without leaving output", () => {
    const repositoryRoot = mkdtempSync(resolve(tmpdir(), "ax-compose-parent-open-swap-"));
    try {
      const path = composedPackPath(repositoryRoot, "acme", "DAEB-1");
      const parent = resolve(path, "..");
      const displaced = `${parent}-displaced`;
      mkdirSync(parent, { recursive: true });
      writeFileSync(path, "original pack\n");
      expect(() => writeComposedPackFileForTest(path, repositoryRoot, "replacement pack\n", {
        beforeTempOpen() {
          renameSync(parent, displaced);
          mkdirSync(parent);
          writeFileSync(path, "replacement-parent sentinel\n");
        },
      })).toThrow(/parent changed during atomic write/);
      expect(readFileSync(path, "utf8")).toBe("replacement-parent sentinel\n");
      expect(readFileSync(resolve(displaced, "pack.yaml"), "utf8")).toBe("original pack\n");
      expect(readdirSync(parent).filter((name) => name.includes(".tmp-"))).toEqual([]);
    } finally {
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("rejects parent, leaf, and hard-link substitution before atomic installation", () => {
    for (const mode of ["parent", "leaf", "hard-link", "temp-hard-link"] as const) {
      const repositoryRoot = mkdtempSync(resolve(tmpdir(), `ax-compose-atomic-${mode}-`));
      const outside = mkdtempSync(resolve(tmpdir(), `ax-compose-atomic-${mode}-outside-`));
      try {
        const path = composedPackPath(repositoryRoot, "acme", "DAEB-1");
        const parent = resolve(path, "..");
        const displaced = `${parent}-displaced`;
        const saved = resolve(outside, "saved-pack.yaml");
        const outsideFile = resolve(outside, "outside.yaml");
        mkdirSync(parent, { recursive: true });
        writeFileSync(path, "original pack\n");
        writeFileSync(outsideFile, "outside remains unchanged\n");

        expect(() => writeComposedPackFileForTest(path, repositoryRoot, "replacement pack\n", {
          beforeCommit({ tempPath }) {
            if (mode === "parent") {
              renameSync(parent, displaced);
              mkdirSync(parent);
              writeFileSync(path, "replacement-parent sentinel\n");
            } else if (mode === "leaf") {
              renameSync(path, saved);
              writeFileSync(path, "replacement-leaf sentinel\n");
            } else if (mode === "hard-link") {
              renameSync(path, saved);
              linkSync(outsideFile, path);
            } else {
              linkSync(tempPath, resolve(outside, "temporary-alias.yaml"));
            }
          },
        })).toThrow(/changed during atomic write/);

        if (mode === "parent") {
          expect(readFileSync(path, "utf8")).toBe("replacement-parent sentinel\n");
          expect(readFileSync(resolve(displaced, "pack.yaml"), "utf8")).toBe("original pack\n");
        } else if (mode === "leaf") {
          expect(readFileSync(path, "utf8")).toBe("replacement-leaf sentinel\n");
          expect(readFileSync(saved, "utf8")).toBe("original pack\n");
        } else if (mode === "hard-link") {
          expect(readFileSync(path, "utf8")).toBe("outside remains unchanged\n");
          expect(readFileSync(saved, "utf8")).toBe("original pack\n");
          expect(readFileSync(outsideFile, "utf8")).toBe("outside remains unchanged\n");
        } else {
          expect(readFileSync(path, "utf8")).toBe("original pack\n");
        }
      } finally {
        rmSync(repositoryRoot, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    }
  });
});
