#!/bin/sh
set -eu

: "${TRUSTED_CONTAINER_IMAGE:?trusted sysroot preparation requires TRUSTED_CONTAINER_IMAGE}"
: "${TRUSTED_NODE_VERSION:?trusted sysroot preparation requires TRUSTED_NODE_VERSION}"

prefix="docker.io/library/node:$TRUSTED_NODE_VERSION-bookworm@sha256:"
digest=${TRUSTED_CONTAINER_IMAGE#"$prefix"}
case "$digest" in
  *[!0-9a-f]*|'') echo "trusted container must be an exact official Node Bookworm digest" >&2; exit 1 ;;
esac
if [ "${#digest}" -ne 64 ] || [ "$TRUSTED_CONTAINER_IMAGE" != "$prefix$digest" ]; then
  echo "trusted container must contain one full SHA-256 digest" >&2
  exit 1
fi

runtime_root=/opt/ax-arena-runtime
sysroot=$runtime_root/rootfs
if [ "${RUNNER_ENVIRONMENT:-github-hosted}" = "self-hosted" ] \
  && [ "${AX_ARENA_SELF_HOSTED_APPROVED:-}" != "true" ]; then
  echo "self-hosted trusted execution requires the approved ax-arena runner pool" >&2
  exit 1
fi

# Pulling the exact manifest digest revalidates Docker's content-addressed cache
# on every run. Self-hosted runners may reuse cached layers, never an unchecked
# extracted sysroot.
docker pull "$TRUSTED_CONTAINER_IMAGE"
if sudo test -L "$runtime_root"; then
  echo "refusing to replace a symlinked trusted runtime directory" >&2
  exit 1
fi
if sudo test -e "$runtime_root"; then
  if ! sudo test -f "$runtime_root/image-ref.txt" \
    || [ "$(sudo cat "$runtime_root/image-ref.txt")" != "$TRUSTED_CONTAINER_IMAGE" ]; then
    echo "refusing to replace an unrecognized trusted runtime directory" >&2
    exit 1
  fi
  sudo rm -rf "$runtime_root"
fi

container_id=
archive=
cleanup() {
  if [ -n "$container_id" ]; then
    docker rm --force "$container_id" >/dev/null 2>&1 || true
  fi
  if [ -n "$archive" ]; then
    rm -f "$archive"
  fi
}
trap cleanup EXIT INT TERM
archive=$(mktemp "${RUNNER_TEMP:-/tmp}/ax-arena-rootfs.XXXXXX.tar")
container_id=$(docker create --platform linux/amd64 "$TRUSTED_CONTAINER_IMAGE")

sudo install -o root -g root -m 0755 -d "$runtime_root" "$sysroot"
docker export --output "$archive" "$container_id"
sudo tar --extract --numeric-owner --file "$archive" --directory "$sysroot"
sudo chown -R root:root "$runtime_root"
sudo chmod -R go-w "$runtime_root"

actual=$(
  env -i PATH="$sysroot/usr/local/bin:$sysroot/usr/bin:$sysroot/bin" \
    "$sysroot/usr/local/bin/node" --version
)
if [ "$actual" != "v$TRUSTED_NODE_VERSION" ]; then
  echo "OCI sysroot Node version drifted: $actual" >&2
  exit 1
fi

printf '%s\n' "$TRUSTED_CONTAINER_IMAGE" | sudo tee "$runtime_root/image-ref.txt" >/dev/null
sudo chown root:root "$runtime_root/image-ref.txt"
sudo chmod 0444 "$runtime_root/image-ref.txt"
printf '%s\n' "$sysroot"
