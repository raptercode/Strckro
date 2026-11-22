# Sourced by run.sh when UI=1. Uses run.sh's: dx, say, t, finish, fail, log, name, node_major, node_v, bun_v, DOMAIN, EMAIL.
# Runs the real installer WITHOUT --domain/--email inside the container, so strckro.sh starts the Setup UI,
# then drives that UI with curl exactly as a browser would, and finishes with the usual assert.sh checks.
# Test-only: the throwaway values below are for this container.
ui_port=8787
base="http://127.0.0.1:$ui_port"
jar=/root/ui-cookies
uicurl(){ dx curl -sS --max-time 60 -b "$jar" -c "$jar" "$@"; }
post(){ local path=$1; shift; uicurl -X POST -H "X-CSRF-Token: $csrf" -H 'Content-Type: application/json' "$@" "$base$path"; }
field(){ sed -n "s/.*\"$1\":\"\\([^\"]*\\)\".*/\\1/p"; }

say 'UI mode: negative - unsupported OS must be refused by the gate BEFORE any UI starts'
dx bash -c 'cp -a /etc/os-release /root/os-release.bak; rm -f /etc/os-release; printf "ID=alpine\nVERSION_ID=3.20\n" > /etc/os-release'
out=$(dx bash -c "cd /root/release && sudo bash ./strckro.sh --node-major=$node_major </dev/null" 2>&1); rc=$?
dx bash -c 'rm -f /etc/os-release; cp -a /root/os-release.bak /etc/os-release'
echo "$out" >>"$log"
if [[ $rc -ne 0 && $out == *'installer supports'* && $out != *'Setup UI is ready'* ]]; then t 'ui negative: OS gate runs before the UI' ok
else t "ui negative: OS gate (rc=$rc: $(tail -1 <<<"$out"))" bad; fi
out=$(dx bash -c "cd /root/release && sudo bash ./strckro.sh --no-ui --node-major=$node_major </dev/null" 2>&1); rc=$?
echo "$out" >>"$log"
if [[ $rc -ne 0 && $out == *FQDN* ]]; then t 'ui negative: --no-ui without --domain keeps the old error' ok
else t "ui negative: --no-ui (rc=$rc: $(tail -1 <<<"$out"))" bad; fi

say 'UI mode: starting the installer with no --domain/--email (stdin is /dev/null, as under curl | bash)'
dx bash -c ': > /root/ui-install.log'
docker exec -d "$name" bash -c "cd /root/release && exec sudo bash ./strckro.sh --node-major=$node_major </dev/null >/root/ui-install.log 2>&1" >>"$log" 2>&1
url=''
for _ in $(seq 1 180); do
  url=$(dx grep -o "http://127.0.0.1:$ui_port/?token=[A-Za-z0-9_-]*" /root/ui-install.log 2>/dev/null | head -1)
  [[ -n $url ]] && break; sleep 2
done
dx cat /root/ui-install.log >>"$log" 2>&1
if [[ -z $url ]]; then t 'ui: installer printed the tunnel URL with a token' bad; finish 1 FAIL; fi
t 'ui: installer printed the tunnel URL with a token' ok
ilog=$(dx cat /root/ui-install.log)
[[ $ilog == *"ssh -L $ui_port:127.0.0.1:$ui_port "* ]] && t 'ui: terminal shows the ssh -L command' ok || t 'ui: terminal shows the ssh -L command' bad
listen=$(dx ss -ltnH | awk -v p=":$ui_port" '$4 ~ p"$" {print $4}'); echo "listening on: $listen" >>"$log"
[[ $listen == "127.0.0.1:$ui_port" ]] && t 'ui: bound to 127.0.0.1 only' ok || t 'ui: bound to 127.0.0.1 only' bad
# The UI started before nginx/certbot were installed (the installer reaches those only in the real run).
dx bash -c '! command -v nginx >/dev/null' && t 'ui: running before nginx is installed' ok || t 'ui: running before nginx is installed' bad
dx bash -c "compgen -G '/opt/node-v*/bin/node' >/dev/null" && t 'ui: pinned Node provisioned for the UI' ok || t 'ui: pinned Node provisioned for the UI' bad

# --- authentication ---
code=$(dx curl -s -o /dev/null -w '%{http_code}' "$base/api/state"); [[ $code == 401 ]] && t 'ui auth: no cookie -> 401' ok || t "ui auth: no cookie (got $code)" bad
code=$(dx curl -s -o /dev/null -w '%{http_code}' "$base/?token=wrong"); [[ $code == 401 ]] && t 'ui auth: wrong token -> 401' ok || t "ui auth: wrong token (got $code)" bad
code=$(dx curl -s -o /dev/null -w '%{http_code}' -c "$jar" "$url"); [[ $code == 302 ]] && t 'ui auth: token exchanged for cookie (302)' ok || t "ui auth: token exchange (got $code)" bad
dx grep -q HttpOnly "$jar" 2>/dev/null; [[ $(dx grep -c '#HttpOnly_' "$jar") -ge 1 ]] && t 'ui auth: cookie is HttpOnly' ok || t 'ui auth: cookie is HttpOnly' bad
code=$(uicurl -o /dev/null -w '%{http_code}' -H 'Host: evil.example.com' "$base/api/state"); [[ $code == 421 ]] && t 'ui auth: foreign Host header -> 421' ok || t "ui auth: foreign Host (got $code)" bad
csrf=$(uicurl "$base/api/session" | field csrf)
[[ -n $csrf ]] && t 'ui auth: session + CSRF token issued' ok || { t 'ui auth: session + CSRF token' bad; finish 1 FAIL; }
code=$(uicurl -X POST -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{}' "$base/api/install"); [[ $code == 403 ]] && t 'ui auth: POST without CSRF header -> 403' ok || t "ui auth: POST without CSRF (got $code)" bad
page=$(uicurl "$base/")
[[ $page == *'<title>Strckro Setup</title>'* && $page == *'id="lang-th"'* ]] && t 'ui: page served (bilingual switch present)' ok || t 'ui: page served' bad
pre=$(uicurl "$base/api/preflight"); echo "preflight: $pre" >>"$log"
if [[ $pre == *'"status":"fail"'* ]]; then t "ui: preflight has no failures ($(grep -o '"id":"[a-z0-9-]*","status":"fail"' <<<"$pre" | tr '\n' ' '))" bad; else t 'ui: preflight has no failures' ok; fi
dns=$(uicurl "$base/api/dns?domain=$DOMAIN"); [[ $dns == *'"resolves":true'* ]] && t 'ui: live DNS check resolves the domain' ok || t "ui: DNS check ($dns)" bad

# --- invalid input is rejected server-side, then the real install ---
code=$(post /api/install -o /dev/null -w '%{http_code}' -d '{"domain":"Bad Domain","email":"x","nodeMajor":"24"}'); [[ $code == 422 ]] && t 'ui: invalid settings -> 422' ok || t "ui: invalid settings (got $code)" bad
say "UI mode: POST settings domain=$DOMAIN node=$node_major"
code=$(post /api/install -o /dev/null -w '%{http_code}' -d "{\"domain\":\"$DOMAIN\",\"email\":\"$EMAIL\",\"nodeMajor\":\"$node_major\"}"); [[ $code == 202 ]] && t 'ui: install accepted (202)' ok || { t "ui: install accepted (got $code)" bad; finish 1 FAIL; }
code=$(post /api/install -o /dev/null -w '%{http_code}' -d "{\"domain\":\"$DOMAIN\",\"email\":\"$EMAIL\",\"nodeMajor\":\"$node_major\"}"); [[ $code == 409 ]] && t 'ui: second install while running -> 409' ok || t "ui: second install (got $code)" bad
docker exec -d "$name" bash -c "curl -sN -b $jar --max-time 1500 $base/api/events > /root/ui-events.txt 2>/dev/null"
phase=''
for _ in $(seq 1 240); do
  st=$(uicurl "$base/api/state" 2>/dev/null); phase=$(field phase <<<"$st")
  [[ $phase == success || $phase == failed ]] && break; sleep 5
done
sleep 2
dx cat /root/ui-install.log >>"$log" 2>&1
if [[ $phase != success ]]; then t "ui: installation finished (phase=${phase:-timeout}; failure: $(grep -o '"failure":{[^}]*}' <<<"$st"))" bad; finish 1 FAIL; fi
t 'ui: installation finished via the UI' ok
events=$(dx cat /root/ui-events.txt)
missing=''; for id in packages node bun files services nginx tls verify; do [[ $events == *"\"id\":\"$id\",\"status\":\"running\""* ]] || missing+=" $id"; done
[[ -z $missing ]] && t 'ui: SSE carried every step marker' ok || t "ui: SSE step markers missing:$missing" bad
[[ $events == *'"phase":"success"'* ]] && t 'ui: SSE carried the success phase' ok || t 'ui: SSE success phase' bad

# --- the generated password: delivered once, never logged ---
res=$(post /api/result -d '{}'); pw=$(field password <<<"$res")
if [[ ${#pw} -ge 20 ]]; then t "ui: one-time installer password delivered (${#pw} chars)" ok; else t "ui: password delivered ($res)" bad; finish 1 FAIL; fi
res2=$(post /api/result -d '{}'); [[ $res2 == *'"password":null'* ]] && t 'ui: password not delivered twice' ok || t 'ui: password not delivered twice' bad
for f in /root/ui-install.log /root/ui-events.txt; do
  dx grep -qF -- "$pw" "$f" && t "ui: password NOT in $f" bad || t "ui: password NOT in $f" ok
done
dx bash -c "journalctl --no-pager 2>/dev/null | grep -qF -- '$pw'" && t 'ui: password NOT in the journal' bad || t 'ui: password NOT in the journal' ok
dx bash -c "grep -rlF -- '$pw' /etc /var/log /root --exclude=ui-cookies 2>/dev/null | grep -v '^/root/ui-' | head -3" | grep -q . && t 'ui: password NOT on disk in the clear' bad || t 'ui: password NOT on disk in the clear' ok
stored=$(dx bash -c "sed -n 's/^HOSTMGR_ADMIN_PASSWORD_B64=//p' /etc/dashboard-portal/dashboard-portal.env | base64 -d")
[[ $stored == "$pw" ]] && t 'ui: installer used the generated password (matches the env file)' ok || t 'ui: env file holds the generated password' bad
code=$(post /api/finish -o /dev/null -w '%{http_code}' -d '{}'); [[ $code == 200 ]] && t 'ui: finish accepted' ok || t "ui: finish (got $code)" bad
gone=no; for _ in $(seq 1 15); do dx bash -c '! pgrep -f "[s]etup-ui.mjs" >/dev/null' && { gone=yes; break; }; sleep 1; done
[[ $gone == yes ]] && t 'ui: setup server exited after finish' ok || t 'ui: setup server exited after finish' bad
dx bash -c "! (exec 3<>/dev/tcp/127.0.0.1/$ui_port) 2>/dev/null" && t "ui: port $ui_port closed" ok || t "ui: port $ui_port closed" bad

# --- the same assertions as the flags-only run, then prove the password works against the real portal ---
dx /root/assert.sh "$DOMAIN" "$node_v" "$bun_v" dashboardportal 2>&1 | tee -a "$log" | grep -E '^(PASS|FAIL)' | sed 's/^/  ui-run /'
[[ ${PIPESTATUS[0]} -eq 0 ]] || fail=1
https(){ dx curl -sS --max-time 20 -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' "$@"; }
code=$(https -X POST -d "{\"email\":\"admin@matrix.test\",\"password\":\"Matrix-Owner-Pass-9!x\",\"confirmPassword\":\"Matrix-Owner-Pass-9!x\",\"currentPassword\":\"wrong-installer-password\"}" "https://$DOMAIN/api/bootstrap")
[[ $code == 401 ]] && t 'portal: wrong installer password refused (401)' ok || t "portal: wrong installer password (got $code)" bad
code=$(https -X POST -d "{\"email\":\"admin@matrix.test\",\"password\":\"Matrix-Owner-Pass-9!x\",\"confirmPassword\":\"Matrix-Owner-Pass-9!x\",\"currentPassword\":\"$pw\"}" "https://$DOMAIN/api/bootstrap")
[[ $code == 200 ]] && t 'portal: generated installer password creates the owner (200)' ok || t "portal: generated password bootstrap (got $code)" bad
code=$(https -X POST -d '{"email":"admin@matrix.test","password":"Matrix-Owner-Pass-9!x"}' "https://$DOMAIN/api/login")
[[ $code == 200 ]] && t 'portal: owner can log in' ok || t "portal: owner login (got $code)" bad

[[ $fail == 0 ]] && finish 0 PASS || finish 1 FAIL
