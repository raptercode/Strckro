import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createSetupServer, validateSettings, generatePassword, stripAnsi, redact, hostAllowed, localPublicAddresses, COOKIE_NAME, STEP_IDS
} from '../scripts/setup-ui.mjs';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const bashAvailable = spawnSync(bash, ['--version']).status === 0;
const read = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8').then((text) => text.replaceAll('\r\n', '\n'));

// A stand-in installer: reads the "owner password" from stdin like strckro.sh, prints step markers, and
// deliberately echoes the password so the tests can prove it is redacted from everything streamed.
const FAKE_INSTALLER = `
import { readFileSync } from 'node:fs';
const password = readFileSync(0, 'utf8').split('\\n')[0];
const args = process.argv.slice(2);
const domain = args.find((a) => a.startsWith('--domain=')).slice(9);
console.log('ARGS ' + args.join(' '));
console.log('\\u001b[32mSTRCKRO_STEP: packages\\u001b[0m'.replace(/\\u001b\\[[0-9;]*m/g, ''));
console.log('STRCKRO_STEP: node');
console.log('leaked? ' + password);
process.stderr.write('stderr leaked? ' + password.slice(0, 8) + password.slice(8) + '\\n');
console.log('\\u001b[31mcolour\\u001b[0m line');
if (domain === 'slow.example.com') await new Promise((resolve) => setTimeout(resolve, 1500));
if (domain.startsWith('fail')) {
  console.log('STRCKRO_STEP: nginx');
  console.error('ERROR: nginx -t failed');
  console.error('Installation failed; restoring Strckro files from /var/backups/x');
  console.error('Package installation and a successfully issued TLS certificate are not rolled back automatically.');
  process.exit(1);
}
console.log('STRCKRO_STEP: verify');
console.log('Installed securely at https://' + domain);
`;

async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'setup-ui-'));
  const script = join(dir, 'fake-installer.mjs');
  await writeFile(script, FAKE_INSTALLER);
  const exits = [];
  const ctl = createSetupServer({
    installer: { command: process.execPath, args: [script] },
    installerCwd: dir,
    envFile: join(dir, 'missing.env'),
    preflight: async () => [{ id: 'os', status: 'pass', detail: 'ubuntu 24.04' }],
    checkDns: async (domain) => ({ domain, resolves: true, addresses: ['203.0.113.7'], serverAddresses: [], matchesServer: false }),
    onExit: (code) => exits.push(code),
    ...options
  });
  const { port, token } = await ctl.start({ port: 0 });
  t.after(async () => { ctl.shutdown(1); await rm(dir, { recursive: true, force: true }); });
  return { ctl, port, token, exits, dir };
}

function request(port, { method = 'GET', path = '/', headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ agent: false, host: '127.0.0.1', port, method, path, headers: { Host: host ?? `127.0.0.1:${port}`, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function login(port, token) {
  const res = await request(port, { path: `/?token=${encodeURIComponent(token)}` });
  assert.equal(res.status, 302);
  const cookie = res.headers['set-cookie'][0].split(';')[0];
  const session = await request(port, { path: '/api/session', headers: { Cookie: cookie } });
  assert.equal(session.status, 200);
  const { csrf } = session.json();
  const post = (path, body) => request(port, { method: 'POST', path, body: body ?? {}, headers: { Cookie: cookie, 'X-CSRF-Token': csrf } });
  const get = (path) => request(port, { path, headers: { Cookie: cookie } });
  return { cookie, csrf, post, get };
}

function readEvents(port, cookie, until, ms = 8000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/events', headers: { Host: `127.0.0.1:${port}`, Cookie: cookie } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      const timer = setTimeout(() => { req.destroy(); reject(new Error(`no ${until} event: ${text.slice(-400)}`)); }, ms);
      res.on('data', (chunk) => {
        text += chunk;
        if (text.includes(until)) { clearTimeout(timer); req.destroy(); resolve(text); }
      });
    });
    req.on('error', (error) => { if (error.code !== 'ECONNRESET') reject(error); });
    req.end();
  });
}

const GOOD = { domain: 'portal.example.com', email: 'admin@example.com', nodeMajor: '24' };

test('settings are validated with the rules of strckro.sh', () => {
  assert.equal(validateSettings(GOOD).ok, true);
  assert.deepEqual(validateSettings({ ...GOOD, nodeMajor: 26 }).value.nodeMajor, '26');
  for (const domain of ['Portal.example.com', 'localhost', 'example', 'a..example.com', '-a.example.com', 'a.example.c', 'a.example.com\n', 'a b.example.com', `${'a'.repeat(64)}.example.com`, '', undefined, 5, null]) {
    assert.equal(validateSettings({ ...GOOD, domain }).ok, false, `domain ${JSON.stringify(domain)}`);
  }
  for (const email of ['admin', 'admin@example', '@example.com', 'a b@example.com', 'a@b@example.com', 'a@example.com\n', '', undefined]) {
    assert.equal(validateSettings({ ...GOOD, email }).ok, false, `email ${JSON.stringify(email)}`);
  }
  for (const nodeMajor of ['18', '21', '25', '240', '', undefined, '24; reboot']) {
    assert.equal(validateSettings({ ...GOOD, nodeMajor }).ok, false, `node ${JSON.stringify(nodeMajor)}`);
  }
  for (const major of ['20', '22', '24', '26']) assert.equal(validateSettings({ ...GOOD, nodeMajor: major }).ok, true);
  assert.deepEqual(Object.keys(validateSettings({ domain: 1, email: 2, nodeMajor: 3 }).errors).sort(), ['domain', 'email', 'nodeMajor']);
});

test('the JavaScript validation agrees with the shell regular expressions', { skip: !bashAvailable }, () => {
  const samples = ['portal.example.com', 'a.co', 'Portal.example.com', 'x_y.example.com', 'a.b.c.example.org', 'a.example.123', 'ex ample.com'];
  for (const sample of samples) {
    const shell = spawnSync(bash, ['-c', '[[ "$1" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$ ]]', 'x', sample]).status === 0;
    assert.equal(validateSettings({ ...GOOD, domain: sample }).ok, shell, sample);
  }
  for (const sample of ['a@b.co', 'a@b', 'a b@c.de', '@b.co', 'a@@b.co']) {
    const shell = spawnSync(bash, ['-c', '[[ "$1" =~ ^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$ ]]', 'x', sample]).status === 0;
    assert.equal(validateSettings({ ...GOOD, email: sample }).ok, shell, sample);
  }
});

test('the generated owner password is long, uses no ambiguous characters and is random', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const password = generatePassword();
    assert.ok(password.length >= 20);
    assert.match(password, /^[A-HJ-NP-Za-km-z2-9]+$/, 'no 0, O, 1, l or I');
    seen.add(password);
  }
  assert.equal(seen.size, 200);
});

test('ANSI sequences are stripped and secrets are redacted', () => {
  assert.equal(stripAnsi('\u001b[1;32mok\u001b[0m \u001b]0;title\u0007done\r'), 'ok done');
  assert.equal(redact('the pass is Abc123 and Abc123', ['Abc123']), 'the pass is ******** and ********');
  assert.equal(redact('nothing', [null, '']), 'nothing');
});

test('the Host header is allow-listed; public mode additionally accepts IP literals and the machine name', () => {
  for (const host of ['127.0.0.1:8787', 'localhost:8787', '[::1]:8787', '127.0.0.1', 'LOCALHOST:9']) assert.equal(hostAllowed(host), true, host);
  for (const host of ['evil.example.com', 'evil.example.com:8787', '192.0.2.10:8787', '127.0.0.1.evil.com', '', undefined, '127.0.0.1:8787/x', 'a b']) assert.equal(hostAllowed(host), false, String(host));
  assert.equal(hostAllowed('192.0.2.10:8787', { isPublic: true }), true);
  assert.equal(hostAllowed('[2001:db8::1]:8787', { isPublic: true }), true);
  assert.equal(hostAllowed('my-box:8787', { isPublic: true, hostname: 'my-box' }), true);
  assert.equal(hostAllowed('rebind.example.com:8787', { isPublic: true, hostname: 'my-box' }), false);
});

test('only public-looking interface addresses are offered as the server address hint', () => {
  const found = localPublicAddresses({
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    eth0: [{ address: '10.0.0.5', family: 'IPv4' }, { address: '203.0.113.9', family: 'IPv4' }, { address: 'fe80::1', family: 'IPv6' }, { address: '2001:db8::5', family: 'IPv6' }, { address: '192.168.1.2', family: 'IPv4' }, { address: '100.64.1.1', family: 'IPv4' }]
  });
  assert.deepEqual(found, ['203.0.113.9', '2001:db8::5']);
});

test('every request needs the token or the cookie it is exchanged for', async (t) => {
  const { port, token } = await setup(t);
  assert.equal((await request(port)).status, 401);
  assert.equal((await request(port, { path: '/api/session' })).status, 401);
  assert.equal((await request(port, { path: '/?token=wrong' })).status, 401);
  assert.equal((await request(port, { path: `/?token=${token}x` })).status, 401);
  assert.equal((await request(port, { path: '/api/state', headers: { Cookie: `${COOKIE_NAME}=nope` } })).status, 401);
  assert.equal((await request(port, { path: `/api/state?token=${token}` })).status, 401, 'the token is only honoured on / and is never a credential for the API');
  assert.equal((await request(port, { method: 'POST', path: '/api/install', body: GOOD })).status, 401);
  const exchange = await request(port, { path: `/?token=${token}` });
  assert.equal(exchange.status, 302);
  assert.equal(exchange.headers.location, '/');
  const cookie = exchange.headers['set-cookie'][0];
  assert.match(cookie, new RegExp(`^${COOKIE_NAME}=[A-Za-z0-9_-]{40,};`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.doesNotMatch(cookie, new RegExp(token), 'the cookie is not the URL token');
  assert.equal(token.length >= 43, true, '256-bit token, base64url');
  assert.equal((await request(port, { path: '/api/state', headers: { Cookie: cookie.split(';')[0] } })).status, 200);
});

test('the page is one self-contained document with a strict CSP and no CORS', async (t) => {
  const { port, token } = await setup(t);
  const { cookie } = await login(port, token);
  const page = await request(port, { path: '/', headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  const csp = page.headers['content-security-policy'];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-[^']+'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);
  assert.match(csp, /frame-ancestors 'none'/);
  const nonce = csp.match(/script-src 'nonce-([^']+)'/)[1];
  assert.ok(page.text.includes(`<script nonce="${nonce}">`));
  assert.equal(page.headers['access-control-allow-origin'], undefined);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.doesNotMatch(page.text, /\s(?:src|href)="https?:|url\(|@import|<link /i, 'no external assets, fonts or CDN');
  assert.doesNotMatch(page.text, /\son[a-z]+=/i, 'no inline event handlers (CSP)');
  assert.match(page.text, /id="lang-th"/);
  assert.match(page.text, /@media \(max-width:520px\)/);
  assert.match(page.text, /lang="en"/);
  const options = await request(port, { method: 'OPTIONS', path: '/api/install', headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(options.headers['access-control-allow-origin'], undefined);
  assert.ok([401, 405].includes(options.status));
});

test('a foreign Host header is refused even with valid credentials', async (t) => {
  const { port, token } = await setup(t);
  const { cookie } = await login(port, token);
  for (const host of ['evil.example.com', `evil.example.com:${port}`, '203.0.113.5']) {
    const res = await request(port, { path: '/api/state', headers: { Cookie: cookie }, host });
    assert.equal(res.status, 421, host);
    assert.equal((await request(port, { path: `/?token=${token}`, host })).status, 421, host);
  }
});

test('POSTs need the CSRF header, a same-origin Origin and valid JSON', async (t) => {
  const { port, token } = await setup(t);
  const { cookie, csrf, post } = await login(port, token);
  const bare = await request(port, { method: 'POST', path: '/api/install', body: GOOD, headers: { Cookie: cookie } });
  assert.equal(bare.status, 403);
  const wrong = await request(port, { method: 'POST', path: '/api/install', body: GOOD, headers: { Cookie: cookie, 'X-CSRF-Token': `${csrf}x` } });
  assert.equal(wrong.status, 403);
  const cross = await request(port, { method: 'POST', path: '/api/install', body: GOOD, headers: { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: 'http://evil.example.com' } });
  assert.equal(cross.status, 403);
  const text = await request(port, { method: 'POST', path: '/api/install', headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'text/plain' }, body: 'hello' });
  assert.equal(text.status, 415);
  const broken = await request(port, { method: 'POST', path: '/api/install', headers: { Cookie: cookie, 'X-CSRF-Token': csrf }, body: '{nope' });
  assert.equal(broken.status, 400);
  const invalid = await post('/api/install', { ...GOOD, domain: 'Not A Domain' });
  assert.equal(invalid.status, 422);
  assert.ok(invalid.json().errors.domain);
  const injected = await post('/api/install', { ...GOOD, email: 'a@b.co --evil', nodeMajor: '24' });
  assert.equal(injected.status, 422);
  assert.equal((await post('/api/nonsense')).status, 404);
});

test('an installation runs the installer with --no-ui and the password on stdin, never in output, and the page exits once', async (t) => {
  const { ctl, port, token, exits } = await setup(t, { graceMs: 200 });
  const { cookie, post, get } = await login(port, token);
  const start = await post('/api/install', GOOD);
  assert.equal(start.status, 202);
  const events = await readEvents(port, cookie, '"phase":"success"');
  const result = await post('/api/result');
  assert.equal(result.status, 200);
  const first = result.json();
  assert.equal(first.url, 'https://portal.example.com');
  assert.ok(first.password.length >= 20);
  assert.equal(first.existing, false);

  assert.match(events, /ARGS --domain=portal\.example\.com --email=admin@example\.com --node-major=24 --no-ui/);
  assert.ok(events.includes('leaked? ********'), 'the installer echoed the password; the stream shows it redacted');
  assert.ok(!events.includes(first.password), 'password absent from the event stream');
  assert.ok(!events.includes(first.password.slice(0, 8)), 'not even the first part (stderr line)');
  assert.ok(!(await get('/api/state')).text.includes(first.password));
  assert.ok(!JSON.stringify(ctl.events).includes(first.password), 'password absent from the stored log');
  assert.ok(!events.includes('\u001b'), 'ANSI stripped');
  assert.match(events, /colour line/);
  for (const id of ['packages', 'node', 'verify']) assert.match(events, new RegExp(`"id":"${id}","status":"running"`));
  assert.match(events, /"phase":"success"/);

  const again = (await post('/api/result')).json();
  assert.equal(again.password, null, 'shown once');
  assert.equal(again.passwordShown, true);
  assert.equal((await post('/api/install', GOOD)).status, 409, 'single use after success');
  assert.equal(await ctl.done, 0);
  assert.deepEqual(exits, [0]);
});

test('an explicit finish request stops the server', async (t) => {
  const { ctl, port, token } = await setup(t, { graceMs: 60000 });
  const { cookie, post } = await login(port, token);
  await post('/api/install', GOOD);
  await readEvents(port, cookie, '"phase":"success"');
  assert.equal((await post('/api/finish')).status, 200);
  assert.equal(await ctl.done, 0);
});

test('an existing installation keeps its owner password and is never handed a new one', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'setup-ui-env-'));
  const envFile = join(dir, 'dashboard-portal.env');
  await writeFile(envFile, 'HOSTMGR_PORTAL_DOMAIN=old.example.com\n');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { port, token } = await setup(t, { envFile, graceMs: 200 });
  const { cookie, post } = await login(port, token);
  await post('/api/install', GOOD);
  const events = await readEvents(port, cookie, '"phase":"success"');
  assert.match(events, /leaked\? (\n|")/, 'stdin carried no password');
  const result = (await post('/api/result')).json();
  assert.equal(result.password, null);
  assert.equal(result.existing, true);
});

test('a second installation is refused while one runs, and after one succeeded', async (t) => {
  const { port, token } = await setup(t, { graceMs: 5000 });
  const { cookie, post } = await login(port, token);
  assert.equal((await post('/api/install', { ...GOOD, domain: 'slow.example.com' })).status, 202);
  assert.equal((await post('/api/install', GOOD)).status, 409, 'refused while one runs');
  assert.equal((await post('/api/finish')).status, 409, 'cannot finish while running');
  await readEvents(port, cookie, '"phase":"success"');
  assert.equal((await post('/api/install', { ...GOOD, domain: 'fail.example.com' })).status, 409, 'finished successfully: no second install');
});

test('after a failure the page stays up for a retry and the failure names the line and the rollback', async (t) => {
  const { ctl, port, token, exits } = await setup(t);
  const { cookie, post, get } = await login(port, token);
  assert.equal((await post('/api/install', { ...GOOD, domain: 'fail.example.com' })).status, 202);
  await readEvents(port, cookie, '"phase":"failed"');
  const state = (await get('/api/state')).json();
  assert.equal(state.phase, 'failed');
  assert.equal(state.failure.line, 'ERROR: nginx -t failed');
  assert.equal(state.failure.rolledBack, true);
  assert.equal(state.steps.find((s) => s.id === 'nginx').status, 'failed');
  assert.equal(state.steps.find((s) => s.id === 'packages').status, 'done');
  assert.equal((await post('/api/result')).status, 409, 'no result, no password after a failure');
  assert.deepEqual(exits, [], 'still running: Retry is possible');
  const retry = await post('/api/install', GOOD);
  assert.equal(retry.status, 202);
  const events = await readEvents(port, cookie, '"phase":"success"');
  assert.ok(!events.includes('nginx -t failed'), 'the log is reset for the retry');
  assert.equal((await get('/api/state')).json().phase, 'success');
  ctl.shutdown(0);
});

test('the server exits after the idle timeout, but never in the middle of an installation', async (t) => {
  const idle = await setup(t, { idleMs: 150 });
  assert.equal(await idle.ctl.done, 1);
  const busy = await setup(t, { idleMs: 200, graceMs: 100 });
  const { cookie, post } = await login(busy.port, busy.token);
  await post('/api/install', { ...GOOD, domain: 'slow.example.com' });
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.deepEqual(busy.exits, [], 'idle timer ignores a running installation');
  await readEvents(busy.port, cookie, '"phase":"success"');
  busy.ctl.shutdown(0);
});

test('Ctrl+C stops the installer (so it rolls back) and the server exits with 130', async (t) => {
  const { ctl, port, token } = await setup(t);
  const { post } = await login(port, token);
  await post('/api/install', { ...GOOD, domain: 'slow.example.com' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  ctl.interrupt();
  assert.equal(await ctl.done, 130);
});

test('preflight and DNS checks are served to the page', async (t) => {
  const { port, token } = await setup(t);
  const { get } = await login(port, token);
  assert.deepEqual((await get('/api/preflight')).json().checks, [{ id: 'os', status: 'pass', detail: 'ubuntu 24.04' }]);
  assert.equal((await get('/api/dns?domain=portal.example.com')).json().resolves, true);
  assert.equal((await get('/api/dns?domain=BAD_NAME')).status, 400);
});

test('strckro.sh and install.sh wire up the Setup UI flags without breaking the flags-only path', async () => {
  const strckro = await read('strckro.sh');
  const bootstrap = await read('install.sh');
  for (const flag of ['--no-ui', '--ui-public', '--ui-port=*']) assert.ok(strckro.includes(flag), `strckro.sh handles ${flag}`);
  for (const flag of ['--no-ui', '--ui-public', '--ui-port', '--domain=*', '--email=*']) assert.ok(bootstrap.includes(flag), `install.sh handles ${flag}`);
  assert.match(strckro, /if \[\[ -z "\$DOMAIN" && -z "\$EMAIL" && "\$NO_UI" != true \]\]; then UI_MODE=true; fi/);
  assert.match(bootstrap, /if \[\[ "\$NO_UI" == true \|\| -n "\$DOMAIN" \|\| -n "\$EMAIL" \]\]; then UI=false; fi/);
  assert.match(bootstrap, /--no-ui <&3/, 'the terminal path still reads from the terminal and tells the installer not to start the UI');
  assert.match(bootstrap, /"\$\{INSTALLER_ARGS\[@\]\}" <\/dev\/null/, 'the UI path never reads the curl | bash script from stdin');
  const marks = [...strckro.matchAll(/^step ([a-z]+)$/gm)].map((m) => m[1]);
  assert.deepEqual(marks, STEP_IDS, 'strckro.sh marks every phase the page lists, in order');
  // OS/arch gates and the maintenance lock come before the UI starts; Node is provisioned by the existing helper.
  const ui = strckro.indexOf('run_setup_ui\n');
  assert.ok(strckro.indexOf('case "${ID:-}:${VERSION_ID:-}" in') < ui);
  assert.ok(strckro.indexOf("flock --exclusive --nonblock 9 || die 'Portal host operations") < ui);
  assert.ok(ui < strckro.indexOf('apt-get install -y --no-install-recommends nginx'), 'the UI starts before nginx and friends are installed');
  assert.match(strckro, /run_setup_ui\(\) \{[\s\S]*install_node_version "\$PORTAL_NODE_MAJOR"[\s\S]*setup-ui\.mjs/);
  assert.match(strckro, /--domain=portal\.example\.com --email=admin@example\.com\] \[--node-major=20\|22\|24\|26\] \[--no-ui\] \[--ui-public\] \[--ui-port=8787\]/);
});

test('shell syntax of the installers', { skip: !bashAvailable }, () => {
  for (const file of ['strckro.sh', 'install.sh']) {
    const result = spawnSync(bash, ['-n', file], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});
