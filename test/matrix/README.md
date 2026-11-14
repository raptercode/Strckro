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
