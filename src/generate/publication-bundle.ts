import { createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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

function declaredBundleFiles(manifest: PublicationManifest): Array<{ path: string; sha256: string }> {
  const files = [
    ...manifest.artifacts.flatMap((artifact) => artifact.path ? [{
      path: assertPublishablePath(artifact.path),
      sha256: artifact.sha256,
    }] : []),
    ...manifest.cells.map((cell) => ({
      path: assertPublishablePath(cell.aggregate_record),
      sha256: cell.aggregate_sha256,
    })),
  ];
  const missingDigests = files.filter((file) => !file.sha256).map((file) => file.path);
  if (missingDigests.length) throw new Error(`publication manifest is missing SHA-256 digests: ${missingDigests.join(", ")}`);
  const paths = files.map((file) => file.path);
  if (paths.includes("manifest.json")) throw new Error("manifest.json is reserved for the publication manifest");
  if (new Set(paths).size !== paths.length) throw new Error("publication manifest declares duplicate bundle paths");
  return files.map((file) => {
    if (!/^[a-f0-9]{64}$/.test(file.sha256!)) {
      throw new Error(`publication manifest has an invalid SHA-256 digest for ${file.path}`);
    }
    return { path: file.path, sha256: file.sha256! };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function sha256File(path: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const descriptor = openSync(path, "r");
  try {
    let bytesRead = 0;
    while ((bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
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

  const expectedFiles = declaredBundleFiles(options.manifest);
  const expectedPaths = expectedFiles.map((file) => file.path);
  const expectedDigestByPath = new Map(expectedFiles.map((file) => [file.path, file.sha256]));
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
      const expectedSha256 = expectedDigestByPath.get(file.destination)!;
      const actualSha256 = sha256File(destination);
      if (actualSha256 !== expectedSha256) {
        throw new Error(`publication file digest mismatch for ${file.destination}: expected ${expectedSha256}, got ${actualSha256}`);
      }
    }
    writeFileSync(resolve(stagingRoot, "manifest.json"), `${JSON.stringify(options.manifest, null, 2)}\n`, { flag: "wx" });
    renameSync(stagingRoot, outRoot);
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
  return outRoot;
}
