# Strckro OS/arch install matrix

Runs the real `strckro.sh` from an extracted release dir inside systemd-booted Docker containers
(`sudo bash ./strckro.sh --domain=... --email=... --node-major=N`) and asserts the result.

## Usage

```bash
test/matrix/run.sh ubuntu:24.04 amd64 24      # one case: <os> <arch> <node-major>
test/matrix/matrix.sh                          # everything, max 3 in parallel, prints a table
test/matrix/matrix.sh -n 22 --os ubuntu:24.04,debian:12 --arch amd64
```

Env for `run.sh`: `KEEP=1` keep the container for debugging, `REBUILD=1` rebuild the image,
`SOURCE=head` use `git archive HEAD` instead of the working tree (default: tracked files of the
working tree, so uncommitted installer edits are tested), `DOMAIN` (default `portal.matrix.test`).

Exit codes: 0 PASS, 1 FAIL, 2 SKIP (arch emulation missing), 3 GATE (the installer refuses that OS
by design; this is reported, not counted as failure by `matrix.sh`). Logs and `.result` files are
written to `test/matrix/logs/` (git-ignored). Everything created is prefixed `strckro-matrix-`
(image `strckro-matrix-<os>-<arch>`, container `strckro-matrix-<os>-<arch>-n<N>-<pid>`); containers
are removed on exit, images are kept for reuse. No other Docker object is touched.

## What each case does

1. Build/reuse the image (`Dockerfile`: systemd, sudo, curl, iproute2, openssl; no Node, no nginx).
2. Boot with systemd as PID 1: `--privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock`.
   This works on Docker Desktop/WSL2 (cgroup v2). Do not add `--tmpfs /tmp`: it is mounted
   `noexec` and breaks the installer's Bun step (a real host has an executable /tmp).
3. Tar the tracked tree, copy it in, extract to `/root/release`.
4. Negative tests: fake `/etc/os-release` (`ID=alpine`) must hit the OS gate; `--domain=localhost`
   must be rejected as not an FQDN.
5. Install run 1 (fresh, no Node preinstalled; owner password is piped on stdin, a throwaway test
   value) then `assert.sh`: `systemctl is-active` for dashboard-portal / hostmgr-deploy-helper /
   nginx, `nginx -t`, loopback `:3100/api/health`, HTTPS health through nginx, HTTP->HTTPS 301,
   HSTS header, node and bun versions equal the pins read from `strckro.sh`, env file is
   `640 root:dashboardportal`, `strckro -v`.
6. Install run 2 (idempotent update, same arguments) and the same assertions.

## Test-only shims (never part of the product)

* `--add-host portal.matrix.test:127.0.0.1` maps the domain to loopback (no public DNS).
* `shims/certbot` is installed at `/usr/local/sbin/certbot`, ahead of the real apt-installed
  certbot. It creates a throwaway CA and a leaf certificate, trusts the CA system-wide (so the
  installer's plain `curl https://domain/...` verifies normally), rewrites the installer's port-80
  site into a 301 redirect plus a 443 TLS server with HSTS, and restarts nginx.
* **Real ACME is NOT exercised.** Let's Encrypt issuance, DNS-01/HTTP-01, certbot's own nginx
  plugin edits and renewal are untested here.

## Limitations

* Network is required inside the container: apt, nodejs.org and github.com (Bun).
* arm64 runs under QEMU user emulation (slow; systemd in emulation can be flaky). It is skipped
  automatically (SKIP) if `tonistiigi/binfmt` does not list `aarch64`; the harness never installs
  binfmt handlers itself.
* Containers share the host kernel: no real boot, kernel modules, firewall (ufw/nftables) or
  sysctl behaviour; `systemd-logind` and udev are masked.
* `--privileged` is used for simplicity; a container is not a security boundary for this test.
* Mail stack, project deploys and Cloudflare real-IP behaviour are not covered beyond the install.

## Known results and emulation limits (2026-11-15, Docker Desktop on WSL2)

Full matrix (Ubuntu 22.04/24.04/25.04, Debian 12/13 x amd64/arm64) with Node 24 and 26; Node 20 and 22 on amd64 only.
- amd64: every OS passes for Node 20, 22, 24 and 26.
- arm64 (QEMU user-mode emulation): passes everywhere except Debian 13, where the portal unit fails with
  `status=226/NAMESPACE`. Systemd mount-namespace sandboxing (`ReadOnlyPaths`, `ProtectSystem=strict`, sometimes
  `ReadWritePaths`) fails non-deterministically under QEMU on that image; the unit uses nothing unusual. Treat Debian 13
  arm64 as unverified until it runs on real arm64 hardware.
- Occasional `qemu: uncaught target signal 11` inside `dpkg` (libc-bin) is an emulator crash, not an installer bug; rerun.
- Fixed by this matrix: `nginx -t` failed on every arm64 case (32-byte `server_names_hash_bucket_size`).

## Setup UI case (`UI=1`)

```bash
UI=1 test/matrix/run.sh ubuntu:24.04 amd64 24
UI=1 test/matrix/run.sh debian:12 amd64 24
```

Runs `sudo bash ./strckro.sh --node-major=N </dev/null` with NO `--domain`/`--email` (stdin is not a terminal, as under
`curl | bash`), so `strckro.sh` starts the Setup UI. `ui-case.sh` then plays the browser with `curl` inside the container:
reads the token URL from the installer log, exchanges it for the cookie, checks auth (401 without cookie or with a wrong token,
421 for a foreign Host, 403 for a POST without CSRF), the page, preflight and DNS endpoints, rejects invalid settings (422),
POSTs `portal.matrix.test`, follows the SSE stream and polls the state until done, fetches the one-time installer password, and
then runs the same `assert.sh` checks. It also asserts: the page listens on 127.0.0.1 only, runs before nginx is installed, the
generated password is absent from the installer log, the SSE capture, the journal and the disk, is the one stored (base64) in
the env file, is not delivered twice, the setup server exits after "finish", and finally uses the password against the real
portal (`/api/bootstrap` with a wrong password gives 401, with the generated one creates the owner, then `/api/login` works).
Logs go to `logs/<os>-<arch>-n<N>-ui.log`. A real browser is not involved; page rendering is not covered.

## Upgrade case (1.1.5 -> current worktree)

```bash
test/matrix/upgrade-case.sh ubuntu:24.04 amd64 24     # other OS/arch: SKIP (exit 2), the 1.1.5 installer only supports Ubuntu 24.04 amd64
```

Installs the release commit `b9f8c1e` (`git archive`, package.json 1.1.5) with its own `strckro.sh`, bootstraps the owner through
`/api/bootstrap`, records state (hash of the `HOSTMGR_SECRET_KEY` line, env perms, sqlite, node/bun, nginx site hash), then runs the
NEW `strckro.sh` the way `strckro update` does (`--domain/--email/--node-major` read from the env file, `--no-ui`, no stdin) and checks:
services, `nginx -t`, health, replaced files, secret unchanged, owner login with the same credentials, perms, pins, hash-bucket
directive, catch-all behaviour, no Setup UI/port 8787, idempotent second run, `/etc/hostmgr` 0711 with the mail marker, a blank
`HOSTMGR_ACME_EMAIL` failing fast with the clear error while the host keeps serving, and `strckro -v` / `update --check`.
Not covered: the signed download path of `strckro update` itself, real ACME. Log: `logs/<os>-<arch>-n<N>-upgrade.log`.
