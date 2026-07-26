export const REQUIRED_DELEGATED_ARENA_COMMANDS = [
  "resolve-vendor",
  "import-registry",
  "extract-tasks",
  "compose-pack",
  "extract-surfaces",
  "extract-capabilities",
  "audit-extracts",
  "audit-suite",
  "synthesize-suite",
  "competitive",
  "publication-bundle",
  "export-publication",
  "daeb-low-pass",
  "daeb-production-rerun",
];

export function localArenaReleaseIssues(root, arena, mappings) {
  const issues = [];
  const coreRange = arena.dependencies?.[root.name];
  if (arena.private !== false) issues.push(`${arena.name} is still private`);
  if (arena.version !== root.version) issues.push(`${arena.name} must use release version ${root.version}`);
  if (coreRange !== root.version) issues.push(`${arena.name} must pin ${root.name}@${root.version}`);
  const delegated = new Set(Object.keys(mappings ?? {}));
  const missing = REQUIRED_DELEGATED_ARENA_COMMANDS.filter((command) => !delegated.has(command));
  if (missing.length) issues.push(`arena aliases have not all switched to delegation: ${missing.join(", ")}`);
  for (const [legacy, target] of Object.entries(mappings ?? {})) {
    if (!/^[a-z0-9-]+$/.test(legacy) || typeof target !== "string" || !/^[a-z0-9-]+$/.test(target)) {
      issues.push(`invalid explicit arena compatibility mapping for ${legacy}`);
    }
  }
  return issues;
}

export function assertArenaMappingsExecutable(mappings, executeTarget) {
  for (const target of new Set(Object.values(mappings))) {
    try {
      if (executeTarget(target) !== 0) throw new Error("non-zero exit status");
    } catch (error) {
      throw new Error(
        `mapped arena command ${target} is not executable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export async function assertPublicArenaPackage(
  arena,
  expectedCoreName,
  expectedCoreVersion,
  expectedIntegrity,
  fetchImpl = fetch,
) {
  const registryUrl = new URL(
    `${encodeURIComponent(arena.name)}/${encodeURIComponent(arena.version)}`,
    "https://registry.npmjs.org/",
  );
  let response;
  try {
    response = await fetchImpl(registryUrl, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new Error(
      `could not anonymously verify ${arena.name}@${arena.version} on the public npm registry: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new Error(`${arena.name}@${arena.version} is not anonymously available from the public npm registry (HTTP ${response.status})`);
  }
  const manifest = await response.json();
  if (manifest?.name !== arena.name || manifest?.version !== arena.version
    || manifest?.dependencies?.[expectedCoreName] !== expectedCoreVersion
    || manifest?.dist?.integrity !== expectedIntegrity
    || typeof manifest?.dist?.tarball !== "string") {
    throw new Error(`public npm manifest for ${arena.name}@${arena.version} is incomplete or does not match`);
  }
}
