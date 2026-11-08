# shellcheck shell=bash
# Shared helpers for workload scripts. Sourced, not executed.
# Callers set `set -eu` and `set -o pipefail` themselves.

# Run a command as root: directly when already root, through sudo otherwise.
as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

# Install apt packages for any of the given commands that are missing.
# Usage: ensure_cmd <command> <apt-package>
ensure_cmd() {
  if command -v "$1" >/dev/null 2>&1; then
    return 0
  fi
  echo "installing $2 (provides $1)"
  as_root apt-get update -qq
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "$2"
}

# Where setup puts toolchains and checkouts, and where work reads them from.
bench_dir() {
  printf '%s\n' "${BENCH_DIR:-${HOME:-/tmp}/bench}"
}
