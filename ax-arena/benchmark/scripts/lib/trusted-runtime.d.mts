export interface TrustedToolPin {
  version: string;
  version_output?: string;
  archive_url?: string;
  archive_sha256?: string;
  executable_path: string;
  executable_sha256?: string;
  package?: string;
}

export interface TrustedRuntimeLock {
  schema: "ax.arena-trusted-runtime-lock/v1";
  platform: "linux/amd64";
  container: {
    image: string;
    digest: string;
    node_version: string;
  };
  harnesses: {
    package_lock_path: string;
    package_lock_sha256: string;
    codex: TrustedToolPin;
    claude_code: TrustedToolPin;
  };
  bubblewrap: TrustedToolPin;
  turso_cli: TrustedToolPin;
}

export function parseRuntimeLock(input: unknown): TrustedRuntimeLock;
export function readTrustedRuntime(root: string): {
  root: string;
  lockPath: string;
  lock: TrustedRuntimeLock;
  bytes: Buffer;
  sha256: string;
  harnessLockBytes: Buffer;
};
