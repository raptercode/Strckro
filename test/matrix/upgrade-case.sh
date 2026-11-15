#!/usr/bin/env bash
# Upgrade case: a real Strckro 1.1.5 host (installed by ITS OWN installer, git commit b9f8c1e) is upgraded
# to the current worktree by running the new strckro.sh exactly like `strckro update` does
# (scripts/strckro-update.mjs: bash strckro.sh --domain=.. --email=.. --node-major=N --no-ui, values from the env file).
# Usage: test/matrix/upgrade-case.sh <os> <arch> [node-major, default 24]
# Only ubuntu:24.04 amd64 is meaningful (the 1.1.5 installer supports nothing else); other targets SKIP (exit 2).
# Env: KEEP=1 keep the container; REBUILD=1 rebuild the image; OLD_REF (default b9f8c1e); DOMAIN (default portal.matrix.test).
# Exit: 0 PASS, 1 FAIL, 2 SKIP. Everything created is named strckro-matrix-*; no other Docker object is touched.
set -uo pipefail
os=${1:?usage: upgrade-case.sh <os> <arch> [node-major]}; arch=${2:?arch}; node_major=${3:-24}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd); repo=$(cd "$here/../.." && pwd)
DOMAIN=${DOMAIN:-portal.matrix.test}; EMAIL=${EMAIL:-admin@matrix.test}; OLD_REF=${OLD_REF:-b9f8c1e}
slug=${os//[:\/]/-}; tag="$slug-$arch"; image="strckro-matrix-$tag"
name="strckro-matrix-$tag-n$node_major-upgrade-$$"
logdir=$here/logs; mkdir -p "$logdir"; log="$logdir/$tag-n$node_major-upgrade.log"; : > "$log"
export MSYS_NO_PATHCONV=1
say(){ echo "[$(date +%H:%M:%S)] $*" | tee -a "$log"; }
wp(){ if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf "%s" "$1"; fi; }
dx(){ docker exec "$name" "$@"; }
finish(){ echo "$2" > "$logdir/$tag-n$node_major-upgrade.result"; say "RESULT $2"; exit "$1"; }
cleanup(){ [[ "${KEEP:-0}" == 1 ]] || docker rm -f -v "$name" >/dev/null 2>&1; rm -f "${old_tar:-/nonexistent}" "${new_tar:-/nonexistent}"; }
trap cleanup EXIT
fail=0
t(){ if [[ $2 == ok ]]; then say "PASS $1"; else say "FAIL $1"; fail=1; fi; }
info(){ say "INFO $*"; }

if [[ $os != ubuntu:24.04 || $arch != amd64 ]]; then
  say "SKIP: the 1.1.5 installer only supports Ubuntu 24.04 amd64; the upgrade case cannot start from $os/$arch"; finish 2 SKIP
fi

# --- image (reused from the install matrix) ---
if [[ "${REBUILD:-0}" == 1 ]] || ! docker image inspect "$image" >/dev/null 2>&1; then
  say "building $image"
  docker build --platform "linux/$arch" --build-arg "BASE=$os" -t "$image" "$(wp "$here")" >>"$log" 2>&1 || { say 'image build failed'; finish 1 FAIL; }
fi

# --- tarballs: OLD from git, NEW from the tracked worktree files ---
cd "$repo" || exit 1
old_tar=$(mktemp "${TMPDIR:-/tmp}/strckro-matrix-old.XXXXXX"); new_tar=$(mktemp "${TMPDIR:-/tmp}/strckro-matrix-new.XXXXXX")
old_ver=$(git show "$OLD_REF:package.json" | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -1)
[[ $old_ver == 1.1.5 ]] || { say "OLD_REF $OLD_REF has package.json version '$old_ver', expected 1.1.5"; finish 1 FAIL; }
git archive "$OLD_REF" > "$old_tar"
git ls-files -z --cached --deduplicate | tar --null -T - --ignore-failed-read -cf "$new_tar" 2>>"$log"
new_ver=$(tar -xOf "$new_tar" package.json | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -1)
sh_src=$(tar -xOf "$new_tar" strckro.sh)
[[ $sh_src == *$'\r'* ]] && { say 'strckro.sh has CRLF line endings; refusing'; finish 1 FAIL; }
bun_v=$(sed -n "s/^BUN_VERSION='\(.*\)'/\1/p" <<<"$sh_src")
if [[ $node_major == 24 ]]; then node_v=$(sed -n "s/^NODE_VERSION='\(.*\)'/\1/p" <<<"$sh_src")
else node_v=$(sed -n "s/^ *$node_major) NODE_PIN_VERSION='\([^']*\)'.*/\1/p" <<<"$sh_src"); fi
say "old=$old_ver ($OLD_REF) new=$new_ver; NEW pins: node=$node_v bun=$bun_v"

# --- boot ---
say "starting $name"
docker run -d --name "$name" --platform "linux/$arch" --privileged --cgroupns=private \
  --tmpfs /run --tmpfs /run/lock --add-host "$DOMAIN:127.0.0.1" "$image" >>"$log" 2>&1 || { say 'container start failed'; finish 1 FAIL; }
state=''
for _ in $(seq 1 60); do state=$(dx systemctl is-system-running 2>/dev/null || true); [[ $state == running || $state == degraded ]] && break; sleep 2; done
[[ $state == running || $state == degraded ]] || { say "systemd did not boot (state=$state)"; finish 1 FAIL; }
say "systemd booted (state=$state)"
docker cp "$(wp "$old_tar")" "$name:/root/old.tar" >>"$log" 2>&1
docker cp "$(wp "$new_tar")" "$name:/root/new.tar" >>"$log" 2>&1
docker cp "$(wp "$here/assert.sh")" "$name:/root/assert.sh" >>"$log" 2>&1
dx bash -c 'mkdir -p /root/old /root/release && tar -xf /root/old.tar -C /root/old && tar -xf /root/new.tar -C /root/release && chmod +x /root/assert.sh' >>"$log" 2>&1 || { say 'copy failed'; finish 1 FAIL; }

H="https://$DOMAIN"
api(){ dx curl -sS --max-time 20 -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' "$@"; }
login_code(){ api -X POST -d "{\"email\":\"admin@matrix.test\",\"password\":\"$OWNER_PW\"}" "$H/api/login"; }
OWNER_PW='Matrix-Owner-Pass-9!x'; INST_PW='Matrix-Test-Pass-12345'
envf=/etc/dashboard-portal/dashboard-portal.env
snap(){ # label: record state worth preserving
  dx bash -c "
    echo secret_sha=\$(grep '^HOSTMGR_SECRET_KEY=' $envf | sha256sum | cut -d' ' -f1)
    echo env_perm=\$(stat -c '%a %U:%G' $envf)
    echo hostmgr_dir=\$(stat -c '%a %U:%G' /etc/hostmgr 2>/dev/null || echo missing)
    echo db=\$(stat -c '%s %U' /var/lib/dashboard-portal/state.sqlite 2>/dev/null || echo missing)
    echo node=\$(/usr/local/bin/node --version) bun=\$(/usr/local/bin/bun --version)
    echo site_sha=\$(cat /etc/nginx/sites-available/* 2>/dev/null | sha256sum | cut -d' ' -f1)
    echo limits=\$(grep -c server_names_hash_bucket_size /etc/nginx/conf.d/strckro-limits.conf 2>/dev/null)
    echo pkg=\$(sed -n 's/.*\"version\": *\"\\([^\"]*\\)\".*/\\1/p' /opt/dashboard-portal/package.json | head -1)
    echo server_sha=\$(cat /usr/local/lib/dashboard-portal/nginx-edge.mjs /usr/local/lib/dashboard-portal/hostmgr-deploy-helper.mjs 2>/dev/null | sha256sum | cut -d' ' -f1)
  " 2>&1
}
kv(){ sed -n "s/^$2=\\(.*\\)/\\1/p" <<<"$1" | head -1; }

# === 1. OLD install ===
say "step 1: install $old_ver with its OWN installer (password on stdin)"
out=$(dx bash -c "cd /root/old && printf '%s\n' '$INST_PW' | bash ./strckro.sh --domain=$DOMAIN --email=$EMAIL --node-major=$node_major" 2>&1); rc=$?; echo "$out" >>"$log"
if [[ $rc -ne 0 ]]; then t "old install (rc=$rc: $(grep -E '^ERROR' <<<"$out" | tail -1))" bad; finish 1 FAIL; fi
t "old $old_ver install" ok
dx /root/assert.sh "$DOMAIN" "$node_v" "$bun_v" dashboardportal 2>&1 | tee -a "$log" | grep -E '^(PASS|FAIL)' | sed 's/^/  old /'
[[ ${PIPESTATUS[0]} -eq 0 ]] || { say 'WARN: assert.sh on the OLD host reported failures (expected only if new-only pins/checks differ)'; }
[[ $(kv "$(snap)" pkg) == "$old_ver" ]] && t "old host reports package version $old_ver" ok || t 'old host version' bad

# === 2. state worth preserving ===
say 'step 2: create state on the old host (bootstrap owner, log in)'
code=$(api -X POST -d "{\"email\":\"admin@matrix.test\",\"password\":\"$OWNER_PW\",\"confirmPassword\":\"$OWNER_PW\",\"currentPassword\":\"$INST_PW\"}" "$H/api/bootstrap")
[[ $code == 200 ]] && t 'old: owner bootstrap (200)' ok || { t "old: owner bootstrap (got $code)" bad; finish 1 FAIL; }
[[ $(login_code) == 200 ]] && t 'old: owner login (200)' ok || t 'old: owner login' bad
dx bash -c "curl -sS --max-time 20 -c /root/old-cookies -H 'Content-Type: application/json' -d '{\"email\":\"admin@matrix.test\",\"password\":\"$OWNER_PW\"}' $H/api/login >/dev/null"
before=$(snap); echo "$before" | sed 's/^/  before /' | tee -a "$log"
echo "$before" >>"$log"

# === 3. upgrade exactly like `strckro update` ===
upd_cmd="set -a; . $envf; set +a; cd /root/release && exec timeout 1200 bash strckro.sh --domain=\$HOSTMGR_PORTAL_DOMAIN --email=\$HOSTMGR_ACME_EMAIL --node-major=\$HOSTMGR_NODE_MAJOR --no-ui </dev/null"
say "step 3: upgrade with the NEW strckro.sh (update path: flags from the env file, --no-ui, no stdin)"
out=$(dx bash -c "$upd_cmd" 2>&1); rc=$?; echo "$out" >>"$log"
[[ $rc -eq 0 ]] && t 'upgrade run (rc=0)' ok || { t "upgrade run (rc=$rc: $(grep -E '^ERROR' <<<"$out" | tail -1))" bad; finish 1 FAIL; }
[[ $out != *'Setup UI is ready'* ]] && t 'upgrade did not start the Setup UI' ok || t 'upgrade started the Setup UI' bad

post_asserts(){ # label
  dx /root/assert.sh "$DOMAIN" "$node_v" "$bun_v" dashboardportal 2>&1 | tee -a "$log" | grep -E '^(PASS|FAIL)' | sed "s/^/  $1 /"
  [[ ${PIPESTATUS[0]} -eq 0 ]] || fail=1
}
post_asserts upgraded
after=$(snap); echo "$after" | sed 's/^/  after  /' | tee -a "$log"
[[ $(kv "$after" pkg) == "$new_ver" ]] && t "version on host = new package.json ($new_ver)" ok || t "version on host ($(kv "$after" pkg) vs $new_ver)" bad
[[ $old_ver == "$new_ver" ]] && info "NOTE: old and new package.json versions are both $new_ver, so the version check cannot prove an upgrade; the hash of the installed nginx-edge.mjs + deploy helper (changed between the two releases) is compared instead"
[[ $(kv "$before" server_sha) != $(kv "$after" server_sha) ]] && t 'installed helper scripts were replaced (hash changed)' ok || t 'installed helper scripts replaced' bad
dx bash -c 'cd /root/release/scripts && for s in nginx-edge.mjs hostmgr-deploy-helper.mjs strckro-update.mjs; do cmp -s $s /usr/local/lib/dashboard-portal/$s || exit 1; done' && t 'installed helper scripts == new release (byte-identical)' ok || t 'installed helper scripts == new release' bad
dx test -f /opt/dashboard-portal/scripts/setup-ui.mjs && t 'new-only file setup-ui.mjs shipped in app root' ok || info 'setup-ui.mjs not in /opt/dashboard-portal/scripts (informational)'
http_unk=$(dx curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H 'Host: unknown.matrix.test' http://127.0.0.1/); [[ $http_unk == 404 ]] && t 'catch-all: unknown Host over HTTP -> 404' ok || t "catch-all HTTP unknown Host (got $http_unk)" bad
dx bash -c 'curl -sk --max-time 10 --resolve unknown.matrix.test:443:127.0.0.1 https://unknown.matrix.test/ >/dev/null 2>&1; r=$?; echo curl_rc=$r' >>"$log" 2>&1
dx bash -c 'curl -sk --max-time 10 --resolve unknown.matrix.test:443:127.0.0.1 https://unknown.matrix.test/ >/dev/null 2>&1; [ $? -ne 0 ]' && t 'catch-all: unknown SNI over HTTPS refused (reject handshake / 444)' ok || t 'catch-all HTTPS unknown SNI refused' bad
[[ $(kv "$before" secret_sha) == $(kv "$after" secret_sha) ]] && t 'HOSTMGR_SECRET_KEY unchanged (hash of env line)' ok || t 'HOSTMGR_SECRET_KEY unchanged' bad
[[ $(kv "$after" env_perm) == '640 root:dashboardportal' ]] && t 'env perms 640 root:dashboardportal' ok || t "env perms ($(kv "$after" env_perm))" bad
[[ $(kv "$after" db) != missing ]] && t "sqlite db present ($(kv "$after" db))" ok || t 'sqlite db present' bad
info "/etc/hostmgr mode: before=$(kv "$before" hostmgr_dir) after=$(kv "$after" hostmgr_dir)"
[[ $(kv "$after" hostmgr_dir) == 7[0-9][0-9]* || $(kv "$after" hostmgr_dir) == 7* || $(kv "$after" hostmgr_dir) == 755* ]] && t "/etc/hostmgr exists ($(kv "$after" hostmgr_dir))" ok || t "/etc/hostmgr ($(kv "$after" hostmgr_dir))" bad
info "nginx site hash: before=$(kv "$before" site_sha | cut -c1-12) after=$(kv "$after" site_sha | cut -c1-12)"
info "hash-bucket directive count before=$(kv "$before" limits) after=$(kv "$after" limits)"
dx grep -Eq '^server_names_hash_bucket_size [0-9]+;' /etc/nginx/conf.d/strckro-limits.conf && t 'hash-bucket directive present in strckro-limits.conf' ok || t 'hash-bucket directive present' bad
[[ $(login_code) == 200 ]] && t 'owner login with the SAME credentials still works' ok || t 'owner login after upgrade' bad
sc=$(dx curl -sS --max-time 20 -b /root/old-cookies -o /dev/null -w '%{http_code}' "$H/api/session")
info "pre-upgrade session cookie against /api/session after upgrade: HTTP $sc (200 = sessions survive; sessions are not required to)"
code=$(api -X POST -d "{\"email\":\"admin@matrix.test\",\"password\":\"wrong-password-xyz\"}" "$H/api/login"); [[ $code == 401 ]] && t 'wrong password still refused (401)' ok || t "wrong password (got $code)" bad
vv=$(dx curl -sS --max-time 10 "$H/api/health"); info "health body: $vv"
[[ $vv == *"v$(kv "$after" node | sed 's/^v//' | sed 's/ .*//')"* || $vv == *'"status":"ok"'* ]] && t 'health reports status ok' ok || t 'health body' bad
dx bash -c '! pgrep -f "[s]etup-ui.mjs" >/dev/null' && t 'no Setup UI process' ok || t 'no Setup UI process' bad
dx bash -c '! ss -ltnH | grep -q ":8787 "' && t 'nothing listening on 8787' ok || t 'nothing listening on 8787' bad
dx bash -c "systemctl is-active dashboard-portal hostmgr-deploy-helper nginx | sort -u | tr '\n' ' '" | grep -qx 'active ' && t 'all services active' ok || t 'all services active' bad

# === 3b. second update is idempotent ===
say 'step 3b: second update run (idempotent)'
out=$(dx bash -c "$upd_cmd" 2>&1); rc=$?; echo "$out" >>"$log"
[[ $rc -eq 0 ]] && t 'second update (rc=0)' ok || t "second update (rc=$rc: $(grep -E '^ERROR' <<<"$out" | tail -1))" bad
post_asserts second
again=$(snap)
[[ $(kv "$again" secret_sha) == $(kv "$before" secret_sha) ]] && t 'secret still unchanged after second update' ok || t 'secret after second update' bad
[[ $(kv "$again" site_sha) == $(kv "$after" site_sha) ]] && t 'nginx site content identical across the two updates' ok || info 'nginx site hash differs between update 1 and 2 (informational)'
[[ $(login_code) == 200 ]] && t 'owner login after second update' ok || t 'owner login after second update' bad

# === 3c. a host that already runs the mail stack keeps /etc/hostmgr at 0711 ===
say 'step 3c: mail-installed marker present -> /etc/hostmgr must stay 0711 after an update'
dx bash -c 'mkdir -p /etc/hostmgr/mail && touch /etc/hostmgr/mail/.portal-installed && chmod 0711 /etc/hostmgr'
out=$(dx bash -c "$upd_cmd" 2>&1); rc=$?; echo "$out" >>"$log"
[[ $rc -eq 0 ]] && t 'update with mail marker (rc=0)' ok || t "update with mail marker (rc=$rc: $(grep -E '^ERROR' <<<"$out" | tail -1))" bad
[[ $(kv "$(snap)" hostmgr_dir) == '711 root:root' ]] && t '/etc/hostmgr stays 0711 with the mail marker' ok || t "/etc/hostmgr with mail marker ($(kv "$(snap)" hostmgr_dir))" bad
dx bash -c 'rm -rf /etc/hostmgr/mail; chmod 0750 /etc/hostmgr'
out=$(dx bash -c "$upd_cmd" 2>&1); rc=$?; echo "$out" >>"$log"
[[ $rc -eq 0 && $(kv "$(snap)" hostmgr_dir) == '750 root:root' ]] && t '/etc/hostmgr back to 0750 without the marker' ok || t "/etc/hostmgr without marker (rc=$rc $(kv "$(snap)" hostmgr_dir))" bad

# === 4. legacy config: blank HOSTMGR_ACME_EMAIL ===
say 'step 4: legacy config - blank HOSTMGR_ACME_EMAIL, update must fail fast (no UI, no hang)'
dx bash -c "cp -a $envf /root/env.bak && sed -i 's/^HOSTMGR_ACME_EMAIL=.*/HOSTMGR_ACME_EMAIL=/' $envf && grep -c '^HOSTMGR_ACME_EMAIL=\$' $envf" >>"$log" 2>&1
out=$(dx bash -c "set -a; . $envf; set +a; cd /root/release && timeout 120 bash strckro.sh --domain=\$HOSTMGR_PORTAL_DOMAIN --email=\$HOSTMGR_ACME_EMAIL --node-major=\$HOSTMGR_NODE_MAJOR --no-ui </dev/null" 2>&1); rc=$?; echo "$out" >>"$log"
if [[ $rc -eq 124 ]]; then t 'blank email: command HUNG (timeout)' bad
elif [[ $rc -ne 0 && $out == *'A valid --email is required'* ]]; then t "blank email: fails fast with the clear error (rc=$rc)" ok
else t "blank email: unexpected (rc=$rc: $(tail -1 <<<"$out"))" bad; fi
[[ $out != *'Setup UI is ready'* ]] && t 'blank email: Setup UI not started' ok || t 'blank email: Setup UI started' bad
dx bash -c '! pgrep -f "[s]etup-ui.mjs" >/dev/null; ! ss -ltnH | grep -q ":8787 "' && t 'blank email: no UI process / port 8787' ok || t 'blank email: UI leftovers' bad
post_asserts blank-email
[[ $(login_code) == 200 ]] && t 'blank email: host still serves, owner login works' ok || t 'blank email: owner login' bad
dx bash -c "cp -a /root/env.bak $envf" && t 'env file restored' ok || t 'env file restored' bad
dx bash -c "stat -c '%a %U:%G' $envf" | grep -qx '640 root:dashboardportal' && t 'restored env perms 640 root:dashboardportal' ok || t 'restored env perms' bad
[[ $(kv "$(snap)" secret_sha) == $(kv "$before" secret_sha) ]] && t 'secret unchanged after the failed run' ok || t 'secret after failed run' bad

# === 5. CLI on the upgraded host ===
say 'step 5: strckro -v / update --check on the upgraded host'
out=$(dx timeout 60 strckro -v 2>&1); rc=$?; echo "$out" >>"$log"; info "strckro -v rc=$rc: $(head -3 <<<"$out" | tr '\n' '|')"
[[ $rc -eq 0 ]] && t 'strckro -v exits 0' ok || t "strckro -v (rc=$rc)" bad
out=$(dx timeout 90 strckro update --check 2>&1); rc=$?; echo "$out" >>"$log"
info "strckro update --check rc=$rc: $(head -3 <<<"$out" | tr '\n' '|')"
if [[ $rc -eq 124 ]]; then t 'update --check hung' bad
elif [[ $out == *Error:*at\ * || $out == *TypeError* || $out == *ReferenceError* || $out == *SyntaxError* || $out == *'Cannot find'* ]]; then t 'update --check crashed with a stack/module error' bad
else t "update --check did not crash (rc=$rc; a feed failure is acceptable)" ok; fi
out=$(dx timeout 60 strckro --help 2>&1); rc=$?; echo "$out" >>"$log"; [[ $rc -eq 0 ]] && t 'strckro --help exits 0' ok || t "strckro --help (rc=$rc)" bad

[[ $fail == 0 ]] && finish 0 PASS || finish 1 FAIL
