export interface ChildSandboxInvocation {
  command: string;
  args: readonly string[];
  cwd: string;
}

export interface ChildSandboxProvenance {
  id: string;
  version: string;
  implementation_sha256: string;
  policy_sha256: string;
}

export interface SandboxedChildInvocation {
  command: string;
  args: string[];
  provenance: ChildSandboxProvenance;
}

/** Generic execution seam for a controller-owned child-process sandbox.
 * Product and benchmark policy stays out of ax-eval. */
export interface ChildProcessSandbox {
  wrap(invocation: ChildSandboxInvocation): SandboxedChildInvocation;
}
