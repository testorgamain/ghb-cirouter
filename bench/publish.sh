#!/usr/bin/env bash
# Commit the rows under <out>/results and the raw copies under <out>/raw to the
# `results` branch (an orphan branch, created on first use). Pushes only to
# refs/heads/results, never to main. The branch is append-only: a file that is
# already on the branch is never overwritten, so a rerun adds only what is new.
# Needs GITHUB_TOKEN and GITHUB_REPOSITORY in the environment.
set -eu
set -o pipefail

out=${1:?usage: publish.sh <out-dir>}
: "${GITHUB_TOKEN:?}"
: "${GITHUB_REPOSITORY:?}"

if [ ! -d "$out/results" ] && [ ! -d "$out/raw" ]; then
  echo "nothing to publish"
  exit 0
fi

# Pass the token as an HTTP header through git's environment config, so it is
# never on a command line or written to .git/config. The encoded form is not
# masked by default, so mask it.
basic=$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')
echo "::add-mask::$basic"
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0="http.https://github.com/.extraheader"
export GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $basic"

# The commit message names the run being published; only digits are accepted.
digits() { case "$1" in '' | *[!0-9]*) echo unknown ;; *) echo "$1" ;; esac; }
run_id=$(digits "${PUBLISH_RUN_ID:-${GITHUB_RUN_ID:-}}")
run_attempt=$(digits "${PUBLISH_RUN_ATTEMPT:-${GITHUB_RUN_ATTEMPT:-}}")

remote="https://github.com/${GITHUB_REPOSITORY}.git"
out=$(cd "$out" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# copy_new <from-dir> <to-dir>: copy each regular file that is not already in
# <to-dir>. An existing target is skipped, per file. Symlinks are not copied.
copy_new() {
  local from=$1 to=$2 rel
  while IFS= read -r -d '' rel; do
    if [ -e "$to/$rel" ] || [ -L "$to/$rel" ]; then
      echo "already on the branch, kept: ${to##*/}/$rel"
      continue
    fi
    mkdir -p "$(dirname "$to/$rel")"
    cp "$from/$rel" "$to/$rel"
  done < <(cd "$from" && find . -type f -print0)
}

for try in 1 2 3; do
  rm -rf "$work"
  mkdir -p "$work"
  git -C "$work" init -q
  git -C "$work" remote add origin "$remote"
  git -C "$work" config user.name "github-actions[bot]"
  git -C "$work" config user.email "41898282+github-actions[bot]@users.noreply.github.com"

  # exit 0 = branch exists, 2 = no such branch, anything else = a real error
  status=0
  git -C "$work" ls-remote --exit-code --heads origin results >/dev/null || status=$?
  case "$status" in
    0)
      git -C "$work" fetch -q --depth 1 origin results
      git -C "$work" checkout -q -B results FETCH_HEAD
      ;;
    2)
      git -C "$work" checkout -q --orphan results
      ;;
    *)
      echo "could not read the remote (git exit $status)" >&2
      exit 1
      ;;
  esac

  added=()
  for dir in results raw; do
    if [ -d "$out/$dir" ]; then
      mkdir -p "$work/$dir"
      copy_new "$out/$dir" "$work/$dir"
      added+=("$dir")
    fi
  done
  git -C "$work" add -- "${added[@]}"
  if git -C "$work" diff --cached --quiet; then
    echo "results branch already up to date"
    exit 0
  fi
  git -C "$work" commit -q -m "results: run ${run_id} attempt ${run_attempt}"
  if git -C "$work" push -q origin HEAD:refs/heads/results; then
    echo "pushed to the results branch"
    exit 0
  fi
  echo "push failed (try $try of 3), retrying" >&2
  # Wait briefly for a concurrent writer; bounded, not a loop on a condition.
  sleep $((try * 3))
done
echo "could not push to the results branch" >&2
exit 1
