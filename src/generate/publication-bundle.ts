import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  assertPortablePublicationPath,
  PUBLICATION_MANIFEST_SCHEMA,
  type PublicationManifest,
} from "./publication-manifest.js";

export interface PublicationBundleFile {
  source_path: string;
  bundle_path: string;
}

function pathWithin(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);
  return Boolean(relativePath)
    && relativePath !== ".."
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath);
}

function pathWithinOrEqual(parent: string, child: string): boolean {
  return parent === child || pathWithin(parent, child);
}

function assertPublishablePath(path: string): string {
  const portable = assertPortablePublicationPath(path, "publication bundle path");
  const segments = portable.toLowerCase().split("/");
  if (segments.some((segment) =>
    segment === ".env"
    || segment.startsWith(".env.")
    || segment === ".invoke-home"
    || segment === ".codex"
    || segment === "credentials"
    || segment === "credentials.json"
    || segment === "secrets"
    || segment === "secrets.json"
    || segment === ".npmrc"
    || segment === ".pypirc"
    || segment.endsWith(".pem")
    || segment.endsWith(".key")
    || segment.endsWith(".p12")
    || segment.endsWith(".pfx")
  )) {
    throw new Error(`publication bundle path is not publishable: ${path}`);
  }
  return portable;
}

function declaredBundlePaths(manifest: PublicationManifest): string[] {
  const paths = [
    ...manifest.artifacts.flatMap((artifact) => artifact.path ? [assertPublishablePath(artifact.path)] : []),
    ...manifest.cells.map((cell) => assertPublishablePath(cell.aggregate_record)),
  ];
  if (paths.includes("manifest.json")) throw new Error("manifest.json is reserved for the publication manifest");
  if (new Set(paths).size !== paths.length) throw new Error("publication manifest declares duplicate bundle paths");
  return paths.sort();
}

function sourceFile(root: string, path: string): string {
  const portable = assertPortablePublicationPath(path, "publication source path");
  const requested = resolve(root, portable);
  if (!existsSync(requested)) throw new Error(`publication source file not found: ${path}`);
  const canonical = realpathSync(requested);
  if (!pathWithin(root, canonical) || !statSync(canonical).isFile()) {
    throw new Error(`publication source must be a file inside the source root: ${path}`);
  }
  return canonical;
}

export function materializePublicationBundle(options: {
  root: string;
  outDir: string;
  manifest: PublicationManifest;
  files: readonly PublicationBundleFile[];
}): string {
  if (options.manifest.schema !== PUBLICATION_MANIFEST_SCHEMA) {
    throw new Error(`publication manifest must use ${PUBLICATION_MANIFEST_SCHEMA}`);
  }
  const root = realpathSync(options.root);
  const outDir = assertPortablePublicationPath(options.outDir, "publication output directory");
  const outRoot = resolve(root, outDir);
  if (existsSync(outRoot)) throw new Error(`publication output already exists: ${outDir}`);

  const expectedPaths = declaredBundlePaths(options.manifest);
  const providedPaths = options.files.map((file) => assertPublishablePath(file.bundle_path));
  if (new Set(providedPaths).size !== providedPaths.length) {
    throw new Error("publication bundle files contain duplicate destination paths");
  }
  const missing = expectedPaths.filter((path) => !providedPaths.includes(path));
  const undeclared = providedPaths.filter((path) => !expectedPaths.includes(path));
  if (missing.length || undeclared.length) {
    throw new Error([
      missing.length ? `missing declared files: ${missing.join(", ")}` : "",
      undeclared.length ? `undeclared files: ${undeclared.join(", ")}` : "",
    ].filter(Boolean).join("; "));
  }

  const sources = options.files.map((file, index) => ({
    source: sourceFile(root, file.source_path),
    destination: providedPaths[index]!,
  }));
  const parent = dirname(outRoot);
  const nearestExistingParent = (() => {
    let candidate = parent;
    while (!existsSync(candidate)) candidate = dirname(candidate);
    return realpathSync(candidate);
  })();
  if (!pathWithinOrEqual(root, nearestExistingParent)) {
    throw new Error("publication output directory must stay inside the source root");
  }
  mkdirSync(parent, { recursive: true });
  if (!pathWithinOrEqual(root, realpathSync(parent))) {
    throw new Error("publication output directory must stay inside the source root");
  }

  const stagingRoot = resolve(parent, `.${basename(outRoot)}.${process.pid}.${randomUUID()}.tmp`);
  mkdirSync(stagingRoot);
  try {
    for (const file of sources) {
      const destination = resolve(stagingRoot, file.destination);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(file.source, destination);
    }
    writeFileSync(resolve(stagingRoot, "manifest.json"), `${JSON.stringify(options.manifest, null, 2)}\n`, { flag: "wx" });
    renameSync(stagingRoot, outRoot);
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
  return outRoot;
}
