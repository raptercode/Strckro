import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { renderUnmatchedNginx } from '../scripts/nginx-edge.mjs';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const available = spawnSync(bash, ['--version']).status === 0;
const strckro = (await readFile(new URL('../strckro.sh', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const bootstrap = (await readFile(new URL('../install.sh', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');

// The OS and architecture gate of strckro.sh: from the first `case` on ID:VERSION_ID up to the DNS preflight.
const gate = strckro.slice(strckro.indexOf('case "${ID:-}:${VERSION_ID:-}" in'), strckro.indexOf('# DNS must already exist'));
// The same checks in the public bootstrap.
const bootstrapGate = bootstrap.slice(bootstrap.indexOf('case "${ID:-}:${VERSION_ID:-}" in'), bootstrap.indexOf('for tool in curl tar'));

const SUPPORTED = [['ubuntu', '22.04'], ['ubuntu', '24.04'], ['ubuntu', '25.04'], ['debian', '12'], ['debian', '13']];
const REJECTED = [['ubuntu', '20.04'], ['ubuntu', '23.10'], ['ubuntu', '26.04'], ['debian', '11'], ['debian', '14'], ['debian', ''], ['fedora', '40'], ['', '']];

function runGate(id, version, { dpkg = 'amd64', uname = 'x86_64', script = gate } = {}) {
  const input = [
    'set -euo pipefail',
    'die() { echo "$*" >&2; exit 1; }',
    `ID='${id}'; VERSION_ID='${version}'`,
    `dpkg() { echo '${dpkg}'; }`,
    `uname() { echo '${uname}'; }`,
    "BUN_SHA256_X64='x64sum'; BUN_SHA256_ARM64='arm64sum'",
    script,
    'echo "ARCH=${NODE_ARCH:-} BUN=${BUN_ARCHIVE_NAME:-} SHA=${BUN_SHA256:-}"'
  ].join('\n');
  return spawnSync(bash, ['-s'], { encoding: 'utf8', input });
}

test('installer accepts Ubuntu 22.04, 24.04, 25.04 and Debian 12, 13 on amd64 and arm64', { skip: !available }, () => {
  for (const [id, version] of SUPPORTED) {
    const amd64 = runGate(id, version);
    assert.equal(amd64.status, 0, `${id} ${version} amd64: ${amd64.stderr}`);
    assert.match(amd64.stdout, /ARCH=x64 BUN=bun-linux-x64-baseline SHA=x64sum/);
    const arm64 = runGate(id, version, { dpkg: 'arm64' });
    assert.equal(arm64.status, 0, `${id} ${version} arm64: ${arm64.stderr}`);
    assert.match(arm64.stdout, /ARCH=arm64 BUN=bun-linux-aarch64 SHA=arm64sum/);
  }
});

test('installer refuses other distributions, releases and CPU architectures with a clear message', { skip: !available }, () => {
  for (const [id, version] of REJECTED) {
    const result = runGate(id, version);
    assert.notEqual(result.status, 0, `${id} ${version} must be refused`);
    assert.match(result.stderr, /supports Ubuntu 22\.04, 24\.04 or 25\.04 and Debian 12 or 13 only/);
  }
  for (const arch of ['i386', 'armhf', 'riscv64', 'ppc64el']) {
    const result = runGate('debian', '12', { dpkg: arch });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /supports amd64 and arm64 only/);
  }
});

test('the public bootstrap gate accepts exactly the same hosts as the installer', { skip: !available }, () => {
  for (const [id, version] of SUPPORTED) {
    for (const uname of ['x86_64', 'aarch64']) {
      const result = runGate(id, version, { uname, script: bootstrapGate });
      assert.equal(result.status, 0, `${id} ${version} ${uname}: ${result.stderr}`);
    }
  }
  for (const [id, version] of REJECTED) assert.notEqual(runGate(id, version, { script: bootstrapGate }).status, 0, `${id} ${version} must be refused`);
  for (const uname of ['armv7l', 'i686', 'riscv64']) {
    const result = runGate('ubuntu', '24.04', { uname, script: bootstrapGate });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /amd64 and arm64 only/);
  }
});

test('the installer no longer hard-codes the amd64-only restriction anywhere', () => {
  assert.doesNotMatch(strckro, /amd64 only/);
  assert.doesNotMatch(bootstrap, /amd64 only|== 'x86_64' \]\]/);
  assert.doesNotMatch(strckro, /linux-x64\.tar\.xz|bun-linux-x64-baseline\/bun/);
});

test('Bun is pinned and verified per architecture with the matching extracted directory', () => {
  assert.match(strckro, /BUN_SHA256_X64='9d8a24292a7068090205daac0a5a223f5f69736f5287e37bf88d3b4031edc750'/);
  assert.match(strckro, /BUN_SHA256_ARM64='70bae41b3908b0a120e1e58c5c8af30e74afae3b8d11b0d3fdd8e787ddfb4b22'/);
  assert.match(strckro, /bun_archive="\$\{BUN_ARCHIVE_NAME\}\.zip"/);
  assert.match(strckro, /\$TMP_DIR\/bun\/\$\{BUN_ARCHIVE_NAME\}\/bun/);
  assert.match(strckro, /sha256sum --check --status \|\| die 'Bun archive checksum verification failed\.'/);
});

test('arm64 hosts get libatomic1, and the unmatched-host TLS fallback has what it needs', () => {
  assert.match(strckro, /"\$NODE_ARCH" == 'arm64'[^\n]*libatomic1|libatomic1/);
  assert.match(strckro, /apt-get install -y --no-install-recommends nginx certbot python3-certbot-nginx curl ca-certificates xz-utils unzip git openssl/);
});

test('Nginx without ssl_reject_handshake (1.18 on Ubuntu 22.04) gets a certificate-backed catch-all', () => {
  assert.match(strckro, /nginx -v 2>&1/);
  assert.match(strckro, /1\.19\.4/);
  assert.match(strckro, /return 444;/);
  assert.match(strckro, /UNMATCHED_TLS_DIR='\/etc\/hostmgr\/unmatched-tls'/);
  const modern = renderUnmatchedNginx('/srv/acme');
  assert.match(modern, /ssl_reject_handshake on;/);
  const legacy = renderUnmatchedNginx('/srv/acme', { legacyTlsDir: '/etc/hostmgr/unmatched-tls' });
  assert.doesNotMatch(legacy, /ssl_reject_handshake/);
  assert.match(legacy, /ssl_certificate \/etc\/hostmgr\/unmatched-tls\/cert\.pem;/);
  assert.match(legacy, /ssl_certificate_key \/etc\/hostmgr\/unmatched-tls\/key\.pem;/);
  assert.match(legacy, /listen 443 ssl default_server;[\s\S]*return 444;/);
  assert.match(legacy, /location \^~ \/\.well-known\/acme-challenge\//);
});
