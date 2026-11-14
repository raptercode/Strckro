#!/usr/bin/env bash
# Run the real Strckro installer inside a systemd-booted container.
# Usage: test/matrix/run.sh <os> <arch> <node-major>
#   os: ubuntu:22.04 | ubuntu:24.04 | ubuntu:25.04 | debian:12 | debian:13   (any docker image with apt)
#   arch: amd64 | arm64 (arm64 needs QEMU/binfmt; skipped with exit 2 when unavailable)
# Env: KEEP=1 keep the container; REBUILD=1 rebuild image; SOURCE=worktree|head (default worktree);
#      DOMAIN (default portal.matrix.test).
# Exit: 0 PASS, 1 FAIL, 2 SKIP (arch unavailable), 3 GATE (installer refuses this OS by design).
# Everything created is named strckro-matrix-*. Other Docker objects are never touched.
set -uo pipefail
os=${1:?usage: run.sh <os> <arch> <node-major>}; arch=${2:?arch}; node_major=${3:?node-major}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd); repo=$(cd "$here/../.." && pwd)
DOMAIN=${DOMAIN:-portal.matrix.test}; EMAIL=${EMAIL:-admin@matrix.test}; SOURCE=${SOURCE:-worktree}
slug=${os//[:\/]/-}; tag="$slug-$arch"; image="strckro-matrix-$tag"
name="strckro-matrix-$tag-n$node_major-$$"
logdir=$here/logs; mkdir -p "$logdir"; log="$logdir/$tag-n$node_major.log"; : > "$log"
export MSYS_NO_PATHCONV=1   # Git Bash on Windows must not rewrite /paths passed to docker
say(){ echo "[$(date +%H:%M:%S)] $*" | tee -a "$log"; }
wp(){ if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf "%s" "$1"; fi; }
dx(){ docker exec "$name" "$@"; }
finish(){ local rc=$1 status=$2; echo "$status" > "$logdir/$tag-n$node_major.result"; say "RESULT $status"; exit "$rc"; }
cleanup(){ [[ "${KEEP:-0}" == 1 ]] || docker rm -f -v "$name" >/dev/null 2>&1; rm -f "${tarball:-/nonexistent}"; }
trap cleanup EXIT

# --- arch support (QEMU/binfmt) ---
case $arch in
  amd64) ;;
  arm64) if [[ "$(uname -m)" != aarch64 ]] && ! docker run --rm --privileged tonistiigi/binfmt 2>/dev/null | grep -q '"aarch64"'; then
           say 'arm64 emulation (binfmt aarch64) not available; skipping'; finish 2 SKIP; fi ;;
  *) say "unknown arch $arch"; finish 1 FAIL ;;
esac

# --- image ---
if [[ "${REBUILD:-0}" == 1 ]] || ! docker image inspect "$image" >/dev/null 2>&1; then
  say "building $image (base $os, linux/$arch)"
  docker build --platform "linux/$arch" --build-arg "BASE=$os" -t "$image" "$(wp "$here")" >>"$log" 2>&1 || { say 'image build failed (see log)'; finish 1 FAIL; }
fi

# --- release tarball from the worktree ---
tarball=$(mktemp "${TMPDIR:-/tmp}/strckro-matrix-release.XXXXXX")
cd "$repo" || exit 1
if [[ $SOURCE == head ]]; then git archive HEAD -o "$tarball"
else git ls-files -z --cached --deduplicate | tar --null -T - --ignore-failed-read -cf "$tarball" 2>>"$log"; fi
sh_src=$(tar -xOf "$tarball" strckro.sh)
cr=$(printf '\r')
if [[ $sh_src == *"$cr"* ]]; then say 'strckro.sh has CRLF line endings; refusing'; finish 1 FAIL; fi
bun_v=$(sed -n "s/^BUN_VERSION='\(.*\)'/\1/p" <<<"$sh_src")
if [[ $node_major == 24 ]]; then node_v=$(sed -n "s/^NODE_VERSION='\(.*\)'/\1/p" <<<"$sh_src")
else node_v=$(sed -n "s/^ *$node_major) NODE_PIN_VERSION='\([^']*\)'.*/\1/p" <<<"$sh_src"); fi
say "pins from installer: node=$node_v bun=$bun_v"

# --- boot ---
# --privileged + private cgroup namespace + tmpfs /run works on Docker Desktop (WSL2, cgroup v2).
say "starting $name"
docker run -d --name "$name" --platform "linux/$arch" --privileged --cgroupns=private \
  --tmpfs /run --tmpfs /run/lock --add-host "$DOMAIN:127.0.0.1" "$image" >>"$log" 2>&1 || { say 'container start failed'; finish 1 FAIL; }
state=''
for _ in $(seq 1 60); do state=$(dx systemctl is-system-running 2>/dev/null || true); [[ $state == running || $state == degraded ]] && break; sleep 2; done
[[ $state == running || $state == degraded ]] || { say "systemd did not boot (state=$state)"; docker logs "$name" 2>&1 | tail -20 >>"$log"; finish 1 FAIL; }
say "systemd booted (state=$state)"
docker cp "$(wp "$tarball")" "$name:/root/release.tar" >>"$log" 2>&1 && docker cp "$(wp "$here/assert.sh")" "$name:/root/assert.sh" >>"$log" 2>&1
dx bash -c 'mkdir -p /root/release && tar -xf /root/release.tar -C /root/release && chmod +x /root/assert.sh' >>"$log" 2>&1 || { say 'copy failed'; finish 1 FAIL; }
dx bash -c '! command -v node' >/dev/null 2>&1 || say 'WARN: node already present in base image'
# Fresh installs read the owner password from stdin (throwaway test value).
install_cmd="cd /root/release && printf '%s\n' 'Matrix-Test-Pass-12345' | sudo bash ./strckro.sh --domain=$DOMAIN --email=$EMAIL --node-major=$node_major"
fail=0
t(){ if [[ $2 == ok ]]; then say "PASS $1"; else say "FAIL $1"; fail=1; fi; }

# --- negative: unsupported OS gate (fake /etc/os-release) and bad domain ---
dx bash -c 'cp -a /etc/os-release /root/os-release.bak; rm -f /etc/os-release; printf "ID=alpine\nVERSION_ID=3.20\n" > /etc/os-release'
out=$(dx bash -c "$install_cmd" 2>&1); rc=$?
dx bash -c 'rm -f /etc/os-release; cp -a /root/os-release.bak /etc/os-release'
echo "$out" >>"$log"
if [[ $rc -ne 0 && $out == *'installer supports'* ]]; then t 'negative: unsupported OS rejected with gate message' ok
else t "negative: unsupported OS gate (rc=$rc: $(tail -1 <<<"$out"))" bad; fi
out=$(dx bash -c "cd /root/release && sudo bash ./strckro.sh --domain=localhost --email=$EMAIL --node-major=$node_major" 2>&1); rc=$?
echo "$out" >>"$log"
if [[ $rc -ne 0 && $out == *FQDN* ]]; then t 'negative: invalid domain rejected' ok
else t "negative: invalid domain (rc=$rc: $(tail -1 <<<"$out"))" bad; fi

# --- positive: fresh install (no Node preinstalled) ---
say 'install run 1 (fresh; no Node preinstalled)'
out=$(dx bash -c "$install_cmd" 2>&1); rc=$?; echo "$out" >>"$log"
if [[ $rc -ne 0 ]]; then
  if grep -q 'installer supports' <<<"$out"; then
    say 'installer OS gate rejected this OS (installer does not support it)'; [[ $fail == 0 ]] && finish 3 GATE || finish 1 FAIL
  fi
  t "install run 1 (rc=$rc: $(grep -E '^ERROR' <<<"$out" | tail -1))" bad; finish 1 FAIL
fi
t 'install run 1' ok
dx /root/assert.sh "$DOMAIN" "$node_v" "$bun_v" dashboardportal 2>&1 | tee -a "$log" | grep -E '^(PASS|FAIL)' | sed 's/^/  run1 /'
[[ ${PIPESTATUS[0]} -eq 0 ]] || fail=1

# --- idempotent second run ---
say 'install run 2 (idempotent update, same args)'
out=$(dx bash -c "$install_cmd" 2>&1); rc=$?; echo "$out" >>"$log"
if [[ $rc -eq 0 ]]; then t 'install run 2' ok; else t "install run 2 (rc=$rc: $(grep -E '^ERROR' <<<"$out" | tail -1))" bad; fi
dx /root/assert.sh "$DOMAIN" "$node_v" "$bun_v" dashboardportal 2>&1 | tee -a "$log" | grep -E '^(PASS|FAIL)' | sed 's/^/  run2 /'
[[ ${PIPESTATUS[0]} -eq 0 ]] || fail=1

[[ $fail == 0 ]] && finish 0 PASS || finish 1 FAIL
