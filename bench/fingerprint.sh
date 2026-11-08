#!/usr/bin/env bash
# Print a JSON fingerprint of this machine on stdout.
# Sources, and only these: /proc/cpuinfo, /proc/meminfo, df, uname, /etc/os-release.
# A value that cannot be read is null, never 0 or an empty string.
set -eu
set -o pipefail

# Quote a string as JSON, or print null when it is empty. Control characters
# are dropped, backslash and double quote are escaped.
json_string() {
  if [ -z "$1" ]; then
    printf 'null'
    return
  fi
  printf '%s' "$1" | LC_ALL=C tr -d '\000-\037\177' | LC_ALL=C sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/^/"/' -e 's/$/"/'
}

# Print the number when it is a positive integer or decimal, otherwise null.
json_number() {
  case "$1" in
    '' | *[!0-9.]*) printf 'null' ;;
    *)
      if awk -v n="$1" 'BEGIN { exit !(n + 0 > 0) }'; then
        printf '%s' "$1"
      else
        printf 'null'
      fi
      ;;
  esac
}

cpu_model=""
vcpus=""
if [ -r /proc/cpuinfo ]; then
  cpu_model=$(awk -F': *' '/^model name/ { print $2; exit }' /proc/cpuinfo || true)
  vcpus=$(grep -c '^processor' /proc/cpuinfo || true)
fi

memory_mb=""
if [ -r /proc/meminfo ]; then
  memory_mb=$(awk '/^MemTotal:/ { printf "%d", $2 / 1024; exit }' /proc/meminfo || true)
fi

disk_gb=""
disk_kb=$(df -Pk / 2>/dev/null | awk 'NR == 2 { print $2 }' || true)
case "$disk_kb" in
  '' | *[!0-9]*) ;;
  *) disk_gb=$(awk -v k="$disk_kb" 'BEGIN { printf "%.1f", k / 1048576 }') ;;
esac

os=""
if [ -r /etc/os-release ]; then
  os=$(awk -F= '/^PRETTY_NAME=/ { gsub(/^"|"$/, "", $2); print $2; exit }' /etc/os-release || true)
fi

kernel=$(uname -r 2>/dev/null || true)

printf '{"cpuModel":%s,"vcpus":%s,"memoryMb":%s,"diskTotalGb":%s,"os":%s,"kernel":%s}\n' \
  "$(json_string "$cpu_model")" \
  "$(json_number "$vcpus")" \
  "$(json_number "$memory_mb")" \
  "$(json_number "$disk_gb")" \
  "$(json_string "$os")" \
  "$(json_string "$kernel")"
