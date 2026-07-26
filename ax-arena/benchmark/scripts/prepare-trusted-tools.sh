#!/bin/sh
set -eu

: "${TRUSTED_CONTAINER_IMAGE:?trusted tool preparation requires TRUSTED_CONTAINER_IMAGE}"
: "${TRUSTED_NODE_VERSION:?trusted tool preparation requires TRUSTED_NODE_VERSION}"
: "${RUNTIME_MANIFEST_PATH:?trusted tool preparation requires RUNTIME_MANIFEST_PATH}"

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
repository_root=$(git rev-parse --show-toplevel)
trusted_sysroot=/opt/ax-arena-runtime/rootfs
trusted_node_bin=$trusted_sysroot/usr/local/bin
cd "$repository_root"

AX_ARENA_OCI_SYSROOT=$trusted_sysroot
GIT_CONFIG_COUNT=1
GIT_CONFIG_KEY_0=safe.directory
GIT_CONFIG_VALUE_0=$repository_root
export AX_ARENA_OCI_SYSROOT GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0

sh "$script_dir/prepare-trusted-sysroot.sh"
PATH="$trusted_node_bin:/usr/bin:/bin" "$trusted_node_bin/npm" ci --ignore-scripts
PATH="$trusted_node_bin:/usr/bin:/bin" "$trusted_node_bin/npm" run build
sudo --preserve-env=AX_ARENA_OCI_SYSROOT,RUNTIME_MANIFEST_PATH,GIT_CONFIG_COUNT,GIT_CONFIG_KEY_0,GIT_CONFIG_VALUE_0 \
  env PATH="$trusted_node_bin:/usr/bin:/bin" \
  "$trusted_node_bin/node" "$script_dir/prepare-trusted-runtime.mjs"
