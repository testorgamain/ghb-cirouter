#!/usr/bin/env bash
# The compared part: build the compiler, then run its test suite.
set -eu
set -o pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=../../bench/lib.sh
. "$here/../../bench/lib.sh"

dir=$(bench_dir)
# shellcheck disable=SC1091
. "$dir/node-env.sh"
cd "$dir/typescript"
rm -rf built
npx --no-install hereby local
npx --no-install hereby runtests-parallel --light=false --lint=false
