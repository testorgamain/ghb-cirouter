#!/usr/bin/env bash
# Node build and tests of the TypeScript compiler repository: install a pinned
# Node, fetch the exact commit and install the locked dependencies.
set -eu
set -o pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=../../bench/lib.sh
. "$here/../../bench/lib.sh"

NODE_VERSION="22.23.4"
NODE_SHA256_X64="b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406"
NODE_SHA256_ARM64="f7a1e486dbc8b286847815b477d4fb5e9fb963ed4489c3e1588853d685f589f9"
TS_REPO="https://github.com/microsoft/TypeScript.git"
TS_TAG="v7.0.2"
TS_COMMIT="1e4744d68260a7cb91b62b12edc3f6a2187faaf1"

dir=$(bench_dir)
mkdir -p "$dir"

ensure_cmd curl curl
ensure_cmd git git
if [ ! -e /etc/ssl/certs/ca-certificates.crt ]; then
  ensure_cmd update-ca-certificates ca-certificates
fi

case "$(uname -m)" in
  x86_64)
    node_arch="x64"
    node_sha="$NODE_SHA256_X64"
    ;;
  aarch64 | arm64)
    node_arch="arm64"
    node_sha="$NODE_SHA256_ARM64"
    ;;
  *)
    echo "unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

tarball="node-v${NODE_VERSION}-linux-${node_arch}.tar.gz"
curl --proto '=https' --tlsv1.2 -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${tarball}" -o "$dir/$tarball"
echo "${node_sha}  $dir/$tarball" | sha256sum -c - >/dev/null
rm -rf "$dir/node"
mkdir -p "$dir/node"
tar -xzf "$dir/$tarball" -C "$dir/node" --strip-components=1
rm -f "$dir/$tarball"

# work.sh sources this file to find node.
cat >"$dir/node-env.sh" <<ENVEOF
export PATH="$dir/node/bin:\$PATH"
ENVEOF

src="$dir/typescript"
rm -rf "$src"
mkdir -p "$src"
git -C "$src" init -q
git -C "$src" remote add origin "$TS_REPO"
git -C "$src" fetch -q --depth 1 origin "$TS_COMMIT"
git -C "$src" checkout -q --detach FETCH_HEAD
head=$(git -C "$src" rev-parse HEAD)
if [ "$head" != "$TS_COMMIT" ]; then
  echo "TypeScript checkout is $head, expected $TS_COMMIT (tag $TS_TAG)" >&2
  exit 1
fi

# shellcheck disable=SC1091
. "$dir/node-env.sh"
cd "$src"
npm ci --no-audit --no-fund
echo "setup done: node $(node --version), npm $(npm --version), TypeScript $TS_TAG at $head"
