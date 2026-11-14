#!/bin/bash
# Runs INSIDE the container after an install. Args: <domain> <node-version> <bun-version> <app-user>
# Prints "PASS <name>" / "FAIL <name>: detail"; exit status = number of failures.
domain=$1 node_v=$2 bun_v=$3 app_user=$4
fails=0
ok()   { echo "PASS $1"; }
bad()  { echo "FAIL $1: ${2:-}"; fails=$((fails+1)); }
check(){ local name=$1; shift; local out; if out=$("$@" 2>&1); then ok "$name"; else bad "$name" "$(printf '%s' "$out" | tail -3 | tr '\n' ' ')"; fi; }
for u in dashboard-portal hostmgr-deploy-helper nginx; do
  s=$(systemctl is-active "$u" 2>&1); [[ "$s" == active ]] && ok "systemd $u active" || bad "systemd $u active" "$s"
done
check 'nginx -t' nginx -t
check 'loopback health :3100' curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3100/api/health
check "https health via nginx ($domain)" curl --fail --silent --show-error --max-time 10 "https://$domain/api/health"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://$domain/api/health"); [[ "$code" == 301 ]] && ok 'http redirects to https (301)' || bad 'http redirects to https' "got $code"
hsts=$(curl -sI --max-time 10 "https://$domain/api/health" | tr -d '\r' | grep -i '^strict-transport-security' || true); [[ -n "$hsts" ]] && ok 'HSTS header present' || bad 'HSTS header present' 'missing'
v=$("/opt/node-v$node_v/bin/node" --version 2>&1); [[ "$v" == "v$node_v" ]] && ok "node pinned v$node_v" || bad "node pinned v$node_v" "$v"
v=$(/usr/local/bin/bun --version 2>&1); [[ "$v" == "$bun_v" ]] && ok "bun pinned $bun_v" || bad "bun pinned $bun_v" "$v"
f=/etc/dashboard-portal/dashboard-portal.env
p=$(stat -c '%a %U:%G' "$f" 2>&1); [[ "$p" == "640 root:$app_user" ]] && ok "perms $f 640 root:$app_user" || bad "perms $f" "$p"
check 'strckro -v' strckro -v
echo "ASSERT_FAILS=$fails"
exit "$fails"
