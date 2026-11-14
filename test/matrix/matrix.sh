#!/usr/bin/env bash
# Run the whole OS/arch matrix with bounded parallelism (max 3) and print a table.
# Usage: test/matrix/matrix.sh [-j N<=3] [-n NODE_MAJOR] [--arch amd64,arm64] [--os a,b,c]
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
jobs=3; node=24; archs=amd64,arm64; oses=ubuntu:22.04,ubuntu:24.04,ubuntu:25.04,debian:12,debian:13
while [[ $# -gt 0 ]]; do case $1 in -j) jobs=$2; shift 2;; -n) node=$2; shift 2;; --arch) archs=$2; shift 2;; --os) oses=$2; shift 2;; *) echo "bad arg $1" >&2; exit 64;; esac; done
(( jobs > 3 )) && jobs=3
cases=(); IFS=, read -ra A <<<"$archs"; IFS=, read -ra O <<<"$oses"
for a in "${A[@]}"; do for o in "${O[@]}"; do cases+=("$o $a"); done; done
rm -f "$here"/logs/*.result 2>/dev/null
export HERE_DIR=$here NODE_MAJOR=$node
printf '%s\n' "${cases[@]}" | xargs -P "$jobs" -L1 bash -c 'bash "$HERE_DIR/run.sh" "$0" "$1" "$NODE_MAJOR" >/dev/null 2>&1; true'
printf '\n%-14s %-6s %-5s %s\n' OS ARCH NODE RESULT; rc=0
for c in "${cases[@]}"; do
  set -- $c; f="$here/logs/${1//[:\/]/-}-$2-n$node.result"; r=$(cat "$f" 2>/dev/null || echo NORESULT)
  printf '%-14s %-6s %-5s %s\n' "$1" "$2" "$node" "$r"
  [[ $r == PASS || $r == SKIP || $r == GATE ]] || rc=1
done
echo 'PASS ok | FAIL failed | GATE installer refuses this OS by design | SKIP arch emulation unavailable'
echo "logs: $here/logs/"; exit $rc
