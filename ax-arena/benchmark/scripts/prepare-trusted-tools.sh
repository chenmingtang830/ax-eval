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
NPM_CONFIG_USERCONFIG=/dev/null
NPM_CONFIG_GLOBALCONFIG=$(mktemp "${RUNNER_TEMP:-/tmp}/ax-arena-global-npmrc.XXXXXX")
NPM_CONFIG_IGNORE_SCRIPTS=true
export AX_ARENA_OCI_SYSROOT GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0
export NPM_CONFIG_USERCONFIG NPM_CONFIG_GLOBALCONFIG NPM_CONFIG_IGNORE_SCRIPTS
unset NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH
cleanup() {
  rm -f "$NPM_CONFIG_GLOBALCONFIG"
}
trap cleanup EXIT INT TERM

sh "$script_dir/prepare-trusted-sysroot.sh"
env -i HOME="${HOME:-/tmp}" PATH="$trusted_node_bin:/usr/bin:/bin" \
  NPM_CONFIG_USERCONFIG=/dev/null NPM_CONFIG_GLOBALCONFIG="$NPM_CONFIG_GLOBALCONFIG" NPM_CONFIG_IGNORE_SCRIPTS=true \
  NPM_CONFIG_SCRIPT_SHELL=/bin/sh "$trusted_node_bin/npm" ci --ignore-scripts
env -i HOME="${HOME:-/tmp}" PATH="$trusted_node_bin:/usr/bin:/bin" \
  NPM_CONFIG_USERCONFIG=/dev/null NPM_CONFIG_GLOBALCONFIG="$NPM_CONFIG_GLOBALCONFIG" NPM_CONFIG_IGNORE_SCRIPTS=true \
  NPM_CONFIG_SCRIPT_SHELL=/bin/sh "$trusted_node_bin/npm" run build
sudo --preserve-env=AX_ARENA_OCI_SYSROOT,RUNTIME_MANIFEST_PATH,GIT_CONFIG_COUNT,GIT_CONFIG_KEY_0,GIT_CONFIG_VALUE_0,NPM_CONFIG_USERCONFIG,NPM_CONFIG_GLOBALCONFIG,NPM_CONFIG_IGNORE_SCRIPTS \
  env -u NODE_OPTIONS -u NODE_PATH -u LD_PRELOAD -u LD_LIBRARY_PATH \
  PATH="$trusted_node_bin:/usr/bin:/bin" \
  NPM_CONFIG_USERCONFIG=/dev/null NPM_CONFIG_GLOBALCONFIG="$NPM_CONFIG_GLOBALCONFIG" NPM_CONFIG_IGNORE_SCRIPTS=true \
  "$trusted_node_bin/node" "$script_dir/prepare-trusted-runtime.mjs"
