const ARTIFACT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertArtifactSegment(value: string, label: string): string {
  if (!ARTIFACT_SEGMENT.test(value)) {
    throw new Error(`${label} must be a safe artifact path segment`);
  }
  return value;
}
