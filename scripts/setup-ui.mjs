#!/usr/bin/env node
// Temporary web Setup UI for the Strckro host installer (node: builtins only, no dependencies).
//
// strckro.sh starts this when --domain/--email are not given (and --no-ui is not). It collects the
// settings, runs the REAL installer (`bash strckro.sh --domain=D --email=E --node-major=N --no-ui`),
// streams its progress and shows the result. It talks plain HTTP because TLS does not exist yet, so:
//   * it binds 127.0.0.1 unless --public is given (then only the token protects it);
//   * every request needs a random 256-bit token (URL token -> HttpOnly SameSite=Strict cookie);
//     POSTs also need a per-session CSRF header; the Host header is allow-listed; the CSP is strict;
//   * the owner password is NEVER typed in the browser: it is generated here, handed to the installer
//     on stdin exactly as the terminal path does, redacted from every stream, and shown once.
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The same rules as strckro.sh.
export const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const NODE_MAJORS = ['20', '22', '24', '26'];
export const STEP_IDS = ['packages', 'node', 'bun', 'files', 'services', 'nginx', 'tls', 'verify'];
export const COOKIE_NAME = 'strckro_setup';
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'; // no 0 O 1 l I
const ENV_FILE = '/etc/dashboard-portal/dashboard-portal.env';
const MAX_EVENTS = 5000;
const MAX_BODY = 4096;

export function validateSettings(input) {
  const errors = {};
  const domain = typeof input?.domain === 'string' ? input.domain : '';
  const email = typeof input?.email === 'string' ? input.email : '';
  const nodeMajor = typeof input?.nodeMajor === 'string' || typeof input?.nodeMajor === 'number' ? String(input.nodeMajor) : '';
  if (domain.length > 253 || !DOMAIN_RE.test(domain)) errors.domain = 'A lower-case fully qualified domain is required.';
  if (email.length > 254 || !EMAIL_RE.test(email)) errors.email = 'A valid email is required.';
  if (!NODE_MAJORS.includes(nodeMajor)) errors.nodeMajor = 'Node.js major must be 20, 22, 24 or 26.';
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { domain, email, nodeMajor } };
}

export function generatePassword(length = 24) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
  return out;
}

export function stripAnsi(text) {
  // CSI, OSC and other escape sequences, then stray control characters except tab.
  return text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b[@-Z\\-_]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

export function redact(text, secrets) {
  let out = text;
  for (const secret of secrets) if (secret) out = out.split(secret).join('********');
  return out;
}

function safeEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0) out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

function isPrivateV4(address) {
  const [a, b] = address.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

// Public-looking addresses of this host's own interfaces: an offline-safe hint, never a network lookup.
export function localPublicAddresses(interfaces = os.networkInterfaces()) {
  const found = [];
  for (const list of Object.values(interfaces)) {
    for (const item of list || []) {
      if (item.internal) continue;
      if (item.family === 'IPv4' && !isPrivateV4(item.address)) found.push(item.address);
      if (item.family === 'IPv6' && !/^(fe80|fc|fd|::1)/i.test(item.address)) found.push(item.address);
    }
  }
  return found;
}

export function hostAllowed(hostHeader, { isPublic = false, hostname = os.hostname() } = {}) {
  if (typeof hostHeader !== 'string' || !/^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d{1,5})?$/i.test(hostHeader)) return false;
  const name = hostHeader.replace(/:\d{1,5}$/, '').toLowerCase();
  if (name === '127.0.0.1' || name === 'localhost' || name === '[::1]') return true;
  if (!isPublic) return false;
  // Public mode: an IP literal cannot be a DNS-rebinding name; the machine's own hostname is fine too.
  return net.isIP(name.replace(/^\[|\]$/g, '')) !== 0 || name === String(hostname).toLowerCase();
}

function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (error) => resolve(error.code === 'EADDRINUSE' ? false : null));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '0.0.0.0');
  });
}

async function reach(url) {
  try {
    await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(6000), redirect: 'manual' });
    return true;
  } catch {
    return false;
  }
}

const SUPPORTED_OS = new Set(['ubuntu:22.04', 'ubuntu:24.04', 'ubuntu:25.04', 'debian:12', 'debian:13']);

export async function runPreflight({ existing = false, osRelease = '/etc/os-release' } = {}) {
  const checks = [];
  const add = (id, status, detail) => checks.push({ id, status, detail });
  let release = {};
  try {
    for (const line of fs.readFileSync(osRelease, 'utf8').split('\n')) {
      const match = line.match(/^([A-Z_]+)=("?)(.*)\2$/);
      if (match) release[match[1]] = match[3];
    }
  } catch { release = {}; }
  const osName = `${release.ID || 'unknown'} ${release.VERSION_ID || ''}`.trim();
  add('os', SUPPORTED_OS.has(`${release.ID}:${release.VERSION_ID}`) ? 'pass' : 'fail', osName);
  add('arch', ['x64', 'arm64'].includes(process.arch) ? 'pass' : 'fail', process.arch === 'x64' ? 'amd64' : process.arch);
  add('root', typeof process.getuid === 'function' && process.getuid() === 0 ? 'pass' : 'fail', typeof process.getuid === 'function' ? `uid ${process.getuid()}` : 'unknown');
  const ramMb = Math.round(os.totalmem() / 1048576);
  add('ram', ramMb >= 900 ? 'pass' : ramMb >= 480 ? 'warn' : 'fail', `${ramMb} MB`);
  try {
    const stat = await fs.promises.statfs('/');
    const freeGb = (Number(stat.bavail) * Number(stat.bsize)) / 1073741824;
    add('disk', freeGb >= 4 ? 'pass' : freeGb >= 2 ? 'warn' : 'fail', `${freeGb.toFixed(1)} GB free`);
  } catch { add('disk', 'warn', 'unknown'); }
  for (const port of [80, 443, 3100]) {
    const free = await portFree(port);
    if (free === true) add(`port${port}`, 'pass', 'free');
    else if (free === false) add(`port${port}`, existing ? 'warn' : 'fail', existing ? 'in use (expected: the existing installation)' : 'in use by another program');
    else add(`port${port}`, 'warn', 'could not be tested');
  }
  const [nodejs, github] = await Promise.all([reach('https://nodejs.org/'), reach('https://github.com/')]);
  add('net-nodejs', nodejs ? 'pass' : 'fail', 'nodejs.org');
  add('net-github', github ? 'pass' : 'fail', 'github.com');
  return checks;
}

async function dnsCheck(domain) {
  let addresses = [];
  try {
    const result = await Promise.race([
      dns.lookup(domain, { all: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000).unref())
    ]);
    addresses = [...new Set(result.map((item) => item.address))];
  } catch { addresses = []; }
  const local = localPublicAddresses();
  return { domain, resolves: addresses.length > 0, addresses, serverAddresses: local, matchesServer: addresses.some((a) => local.includes(a)) };
}

export function createSetupServer(options = {}) {
  const {
    isPublic = false,
    installer = { command: 'bash', args: [path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'strckro.sh')] },
    installerCwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    envFile = ENV_FILE,
    idleMs = 30 * 60 * 1000,
    graceMs = 120 * 1000,
    defaultNodeMajor = '24',
    preflight = (ctx) => runPreflight(ctx),
    checkDns = dnsCheck,
    onExit = () => {},
    log = () => {}
  } = options;

  const token = crypto.randomBytes(32).toString('base64url');
  const sessionSecret = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(32).toString('base64url');
  const state = { phase: 'idle', steps: new Map(STEP_IDS.map((id) => [id, 'pending'])), settings: null, failure: null, existing: false, passwordIssued: false, domain: '' };
  const events = [];
  let seq = 0;
  let password = null;       // dropped from memory once shown
  let passwordShown = false;
  let child = null;
  let rolledBack = false;
  let lastErrorLine = '';
  let finished = false;
  let idleTimer = null;
  let graceTimer = null;
  let listenPort = 0;
  const clients = new Set();
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });

  const existsNow = () => fs.existsSync(envFile);
  const snapshotSteps = () => STEP_IDS.map((id) => ({ id, status: state.steps.get(id) }));
  const publicState = () => ({ phase: state.phase, steps: snapshotSteps(), failure: state.failure, existing: state.existing || existsNow(), settings: state.settings, lastSeq: seq });

  function emit(type, data) {
    seq += 1;
    const event = { id: seq, type, data };
    events.push(event);
    if (events.length > MAX_EVENTS) events.shift();
    for (const client of clients) writeEvent(client, event);
  }
  function writeEvent(res, event) {
    res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
  }

  function setStep(id, status) {
    state.steps.set(id, status);
    emit('step', { id, status });
  }
  function startStep(id) {
    if (!state.steps.has(id)) return;
    for (const [other, status] of state.steps) if (status === 'running') setStep(other, 'done');
    setStep(id, 'running');
  }

  function shutdown(code) {
    if (finished) return;
    finished = true;
    clearTimeout(idleTimer);
    clearTimeout(graceTimer);
    password = null;
    for (const client of clients) client.end();
    clients.clear();
    server.close();
    server.closeAllConnections?.();
    resolveDone(code);
    onExit(code);
  }

  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (state.phase === 'running') { armIdle(); return; }
      log('Setup UI idle timeout; exiting.');
      shutdown(1);
    }, idleMs);
    idleTimer.unref?.();
  }

  function handleLine(raw) {
    const line = redact(stripAnsi(raw), [password].filter(Boolean));
    if (!line.trim()) return;
    const marker = line.match(/^STRCKRO_STEP: ([a-z]+)\s*$/);
    if (marker) startStep(marker[1]);
    if (/^ERROR:/.test(line)) lastErrorLine = line;
    if (/^Installation failed; restoring Strckro files from /.test(line)) rolledBack = true;
    // Keep the last ERROR line, else the last line before the rollback chatter began.
    if (!rolledBack && (!lastErrorLine || !/^ERROR:/.test(lastErrorLine))) lastErrorLine = line;
    emit('log', { line });
  }

  function startInstall(settings) {
    state.phase = 'running';
    state.settings = settings;
    state.failure = null;
    state.domain = settings.domain;
    state.existing = existsNow();
    rolledBack = false;
    lastErrorLine = '';
    for (const id of STEP_IDS) state.steps.set(id, 'pending');
    events.length = 0;
    emit('phase', { phase: 'running' });
    for (const id of STEP_IDS) emit('step', { id, status: 'pending' });
    password = state.existing ? null : generatePassword();
    passwordShown = false;
    state.passwordIssued = Boolean(password);
    const args = [...installer.args, `--domain=${settings.domain}`, `--email=${settings.email}`, `--node-major=${settings.nodeMajor}`, '--no-ui'];
    const spawned = spawn(installer.command, args, { cwd: installerCwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } });
    child = spawned;
    spawned.stdin.on('error', () => {});
    // The terminal path reads the owner password from stdin; so does this one. Never an argument or env var.
    spawned.stdin.end(password ? `${password}\n` : '');
    let buffers = { out: '', err: '' };
    const feed = (key) => (chunk) => {
      buffers[key] += chunk.toString('utf8');
      const parts = buffers[key].split(/\r\n|\n|\r/);
      buffers[key] = parts.pop();
      for (const part of parts) handleLine(part);
    };
    spawned.stdout.on('data', feed('out'));
    spawned.stderr.on('data', feed('err'));
    spawned.on('error', (error) => { handleLine(`ERROR: could not start the installer: ${error.message}`); });
    spawned.on('close', (code, signal) => {
      for (const key of ['out', 'err']) if (buffers[key]) handleLine(buffers[key]);
      buffers = { out: '', err: '' };
      child = null;
      for (const [id, status] of state.steps) if (status === 'running') setStep(id, code === 0 ? 'done' : 'failed');
      if (code === 0) {
        state.phase = 'success';
        emit('phase', { phase: 'success' });
        if (password && process.stdout.isTTY && options.printPassword !== false) {
          process.stdout.write(`\nInstalled. Installer password (shown once, save it now; enter it when you first open the portal): ${password}\n`);
        }
        graceTimer = setTimeout(() => shutdown(0), Math.max(graceMs, 1000) * 5);
        graceTimer.unref?.();
      } else {
        state.phase = 'failed';
        state.failure = { code, signal: signal || null, line: lastErrorLine || 'The installer stopped unexpectedly.', rolledBack };
        emit('phase', { phase: 'failed', failure: state.failure });
      }
      armIdle();
    });
  }

  function send(res, status, body, headers = {}) {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    const payload = isJson ? JSON.stringify(body) : body;
    res.writeHead(status, {
      'Content-Type': isJson ? 'application/json; charset=utf-8' : (headers['Content-Type'] || 'text/plain; charset=utf-8'),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cross-Origin-Opener-Policy': 'same-origin',
      ...headers,
      ...(isJson ? { 'Content-Type': 'application/json; charset=utf-8' } : {})
    });
    res.end(payload);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) { reject(Object.assign(new Error('Body too large.'), { status: 413 })); req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (!chunks.length) { resolve({}); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('Invalid JSON.'), { status: 400 })); }
      });
      req.on('error', reject);
    });
  }

  async function route(req, res) {
    const host = req.headers.host;
    if (!hostAllowed(host, { isPublic })) { send(res, 421, { error: 'Unexpected Host header.' }); return; }
    const url = new URL(req.url, 'http://setup.invalid');
    armIdle();

    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('token')) {
      if (!safeEqual(url.searchParams.get('token'), token)) { send(res, 401, 'Invalid token.'); return; }
      send(res, 302, '', { Location: '/', 'Set-Cookie': `${COOKIE_NAME}=${sessionSecret}; HttpOnly; SameSite=Strict; Path=/` });
      return;
    }

    const cookie = parseCookies(req.headers.cookie)[COOKIE_NAME];
    const authed = typeof cookie === 'string' && cookie.length > 0 && safeEqual(cookie, sessionSecret);
    if (!authed) {
      if (url.pathname.startsWith('/api/')) send(res, 401, { error: 'Not authorised. Open the URL with the token printed in the terminal.' });
      else send(res, 401, 'Not authorised. Open the full URL, including ?token=, printed in the terminal.\n');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      const nonce = crypto.randomBytes(16).toString('base64');
      send(res, 200, PAGE.replaceAll('__NONCE__', nonce), {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/session') { send(res, 200, { csrf, defaultNodeMajor, serverAddresses: localPublicAddresses(), ...publicState() }); return; }
    if (req.method === 'GET' && url.pathname === '/api/state') { send(res, 200, publicState()); return; }
    if (req.method === 'GET' && url.pathname === '/api/preflight') { send(res, 200, { checks: await preflight({ existing: existsNow() }) }); return; }
    if (req.method === 'GET' && url.pathname === '/api/dns') {
      const domain = url.searchParams.get('domain') || '';
      if (!DOMAIN_RE.test(domain)) { send(res, 400, { error: 'A lower-case fully qualified domain is required.' }); return; }
      send(res, 200, await checkDns(domain));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
      res.write('retry: 3000\n\n');
      const last = Number(req.headers['last-event-id'] || url.searchParams.get('after') || 0) || 0;
      for (const event of events) if (event.id > last) writeEvent(res, event);
      clients.add(res);
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
      heartbeat.unref?.();
      req.on('close', () => { clearInterval(heartbeat); clients.delete(res); });
      return;
    }

    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://${host}`) { send(res, 403, { error: 'Cross-origin request refused.' }); return; }
      const sent = req.headers['x-csrf-token'];
      if (typeof sent !== 'string' || !safeEqual(sent, csrf)) { send(res, 403, { error: 'Missing or invalid CSRF token.' }); return; }
      const contentType = String(req.headers['content-type'] || '');
      if (req.headers['content-length'] !== '0' && req.headers['content-length'] !== undefined && !contentType.startsWith('application/json')) { send(res, 415, { error: 'JSON required.' }); return; }
      const body = await readBody(req);

      if (url.pathname === '/api/install') {
        if (state.phase === 'running') { send(res, 409, { error: 'An installation is already running.' }); return; }
        if (state.phase === 'success') { send(res, 409, { error: 'The installation already finished.' }); return; }
        const checked = validateSettings(body);
        if (!checked.ok) { send(res, 422, { error: 'Invalid settings.', errors: checked.errors }); return; }
        startInstall(checked.value);
        send(res, 202, { phase: 'running' });
        return;
      }
      if (url.pathname === '/api/result') {
        if (state.phase !== 'success') { send(res, 409, { error: 'The installation has not finished successfully.' }); return; }
        const reply = { domain: state.domain, url: `https://${state.domain}`, existing: !state.passwordIssued, password: null, passwordShown };
        if (password) {
          reply.password = password;
          password = null;
          passwordShown = true;
          reply.passwordShown = false;
          clearTimeout(graceTimer);
          graceTimer = setTimeout(() => shutdown(0), graceMs);
          graceTimer.unref?.();
        }
        send(res, 200, reply);
        return;
      }
      if (url.pathname === '/api/finish') {
        if (state.phase === 'running') { send(res, 409, { error: 'An installation is running.' }); return; }
        send(res, 200, { ok: true });
        setImmediate(() => shutdown(state.phase === 'success' ? 0 : 1));
        return;
      }
      send(res, 404, { error: 'Not found.' });
      return;
    }
    send(res, req.method === 'GET' ? 404 : 405, { error: 'Not found.' });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((error) => {
      if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : 'Internal error.' });
      else res.end();
    });
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 0; // SSE connections stay open

  function start({ port = 8787, host = isPublic ? '0.0.0.0' : '127.0.0.1' } = {}) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        listenPort = server.address().port;
        armIdle();
        resolve({ port: listenPort, host, token });
      });
    });
  }

  function interrupt() {
    if (child) {
      child.once('close', () => shutdown(130));
      child.kill('SIGTERM'); // strckro.sh traps TERM and rolls back
      setTimeout(() => shutdown(130), 60000).unref?.();
    } else shutdown(130);
  }

  return { server, token, csrf, sessionSecret, start, shutdown, interrupt, done, state, events, get port() { return listenPort; } };
}

function parseArgs(argv) {
  const opts = { port: 8787, isPublic: false, installer: null, defaultNodeMajor: '24' };
  for (const arg of argv) {
    let match;
    if (arg === '--public') opts.isPublic = true;
    else if ((match = arg.match(/^--port=(\d{1,5})$/)) && Number(match[1]) >= 1 && Number(match[1]) <= 65535) opts.port = Number(match[1]);
    else if ((match = arg.match(/^--installer=(.+)$/))) opts.installer = match[1];
    else if ((match = arg.match(/^--default-node-major=(\d+)$/))) opts.defaultNodeMajor = match[1];
    else { process.stderr.write(`Unknown option: ${arg}\n`); process.exit(64); }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const installerPath = opts.installer ? path.resolve(opts.installer) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'strckro.sh');
  const ctl = createSetupServer({
    isPublic: opts.isPublic,
    installer: { command: 'bash', args: [installerPath] },
    installerCwd: path.dirname(installerPath),
    defaultNodeMajor: NODE_MAJORS.includes(opts.defaultNodeMajor) ? opts.defaultNodeMajor : '24',
    log: (line) => process.stdout.write(`${line}\n`)
  });
  let info;
  try { info = await ctl.start({ port: opts.port }); } catch (error) {
    process.stderr.write(`ERROR: the Setup UI could not listen on port ${opts.port}: ${error.message}\n`);
    process.exit(1);
  }
  const addresses = localPublicAddresses();
  const where = process.env.SSH_CONNECTION?.split(' ')[2] || addresses[0] || os.hostname();
  const out = (line = '') => process.stdout.write(`${line}\n`);
  out();
  out('Strckro Setup UI is ready.');
  if (opts.isPublic) {
    out();
    out('!!! WARNING: --ui-public is on. This page is served over plain HTTP, so everything you type and the');
    out('!!! install progress travel UNENCRYPTED. Only the secret token in the URL protects it. Use it only');
    out('!!! on a network you trust, and do not share or paste the URL anywhere.');
    out();
    out('Open (replace the address if this host is behind NAT):');
    out(`  http://${where}:${info.port}/?token=${info.token}`);
  } else {
    out();
    out('Nothing is exposed to the network: the page listens on 127.0.0.1 only. From YOUR computer run:');
    out(`  ssh -L ${info.port}:127.0.0.1:${info.port} ${process.env.SUDO_USER || 'user'}@${where}`);
    out('then open this address in your browser:');
    out(`  http://127.0.0.1:${info.port}/?token=${info.token}`);
  }
  out();
  out('The page closes itself after the installation, after 30 minutes without use, or on Ctrl+C.');
  out('Prefer the terminal? Run the installer again with --no-ui.');
  out();
  process.on('SIGINT', () => ctl.interrupt());
  process.on('SIGTERM', () => ctl.interrupt());
  process.exit(await ctl.done);
}

// ---------------------------------------------------------------------------------------------
// The single page. Plain strings only (no template substitutions): String.raw keeps regex escapes.
const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="dark">
<title>Strckro Setup</title>
<style nonce="__NONCE__">
:root{--bg:#070d12;--panel:#0d1720;--panel2:#12212c;--line:#1f3341;--text:#e6f1ee;--mute:#93a8b0;--em:#10b981;--em2:#34d399;--warn:#f5b942;--bad:#f87171;--ok:#34d399;color-scheme:dark}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:radial-gradient(1200px 600px at 80% -10%,#0b2a24 0,transparent 60%),var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Thai","Noto Sans",sans-serif;min-height:100vh}
a{color:var(--em2)}
.skip{position:absolute;left:-999px;top:0;background:var(--em);color:#04120d;padding:.6rem 1rem;z-index:9}
.skip:focus{left:8px;top:8px}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px;max-width:760px;margin:0 auto}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:.02em;font-size:1.15rem}
.dot{width:14px;height:14px;border-radius:4px;background:linear-gradient(135deg,var(--em),var(--em2));box-shadow:0 0 16px #10b98166}
.lang{display:flex;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.lang button{background:transparent;color:var(--mute);border:0;padding:8px 14px;min-height:40px;cursor:pointer;font:inherit}
.lang button[aria-pressed=true]{background:var(--panel2);color:var(--em2)}
main{max-width:760px;margin:0 auto;padding:0 20px 56px}
.steps{display:flex;gap:6px;list-style:none;padding:0;margin:0 0 18px;flex-wrap:wrap}
.steps li{flex:1 1 90px;font-size:.78rem;color:var(--mute);border-top:3px solid var(--line);padding-top:6px}
.steps li[aria-current=step]{color:var(--em2);border-color:var(--em)}
.steps li.past{border-color:#0b6b4c;color:var(--text)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:22px}
h1{font-size:1.5rem;margin:0 0 6px}
h2{font-size:1.1rem;margin:22px 0 8px}
p{margin:.4rem 0 1rem}
.mute{color:var(--mute)}
label{display:block;font-weight:600;margin:16px 0 6px}
input,select{width:100%;min-height:46px;background:#08121a;color:var(--text);border:1px solid var(--line);border-radius:10px;padding:10px 12px;font:inherit}
input[aria-invalid=true]{border-color:var(--bad)}
.hint{font-size:.86rem;color:var(--mute);margin-top:6px;min-height:1.3em}
.err{color:var(--bad)}
button.btn{min-height:46px;border-radius:10px;border:1px solid var(--line);background:var(--panel2);color:var(--text);padding:10px 18px;font:inherit;font-weight:600;cursor:pointer}
button.primary{background:var(--em);border-color:var(--em);color:#04120d}
button.btn:disabled{opacity:.45;cursor:not-allowed}
.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px}
:focus-visible{outline:3px solid var(--em2);outline-offset:2px}
.checks{list-style:none;padding:0;margin:14px 0}
.checks li{display:flex;gap:10px;align-items:baseline;padding:8px 0;border-bottom:1px solid var(--line)}
.badge{flex:none;min-width:3.9rem;text-align:center;border-radius:999px;padding:1px 8px;font-size:.78rem;font-weight:700;border:1px solid}
.b-pass{color:var(--ok);border-color:var(--ok)}.b-warn{color:var(--warn);border-color:var(--warn)}.b-fail{color:var(--bad);border-color:var(--bad)}
.detail{color:var(--mute);margin-left:auto;text-align:right;font-size:.88rem;word-break:break-word}
dl{display:grid;grid-template-columns:max-content 1fr;gap:8px 18px;margin:12px 0}
dt{color:var(--mute)}dd{margin:0;word-break:break-all}
.plist{list-style:none;padding:0;margin:0 0 14px;display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
.plist li{border:1px solid var(--line);border-radius:10px;padding:8px 10px;font-size:.9rem;color:var(--mute)}
.plist li[data-s=running]{border-color:var(--em);color:var(--text)}
.plist li[data-s=done]{color:var(--ok)}
.plist li[data-s=failed]{border-color:var(--bad);color:var(--bad)}
pre.log{background:#050a0e;border:1px solid var(--line);border-radius:10px;padding:12px;max-height:46vh;overflow:auto;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word;margin:0}
.alert{border:1px solid var(--bad);background:#2a1215;border-radius:12px;padding:14px 16px;margin:14px 0}
.note{border:1px solid var(--warn);background:#2a2110;border-radius:12px;padding:12px 16px;margin:14px 0}
.pw{display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:#050a0e;border:1px solid var(--em);border-radius:12px;padding:14px;margin:10px 0}
.pw code{font:600 1.15rem ui-monospace,Menlo,Consolas,monospace;letter-spacing:.05em;word-break:break-all;flex:1 1 220px;user-select:all}
code{font-family:ui-monospace,Menlo,Consolas,monospace;background:#050a0e;padding:1px 6px;border-radius:6px}
[hidden]{display:none!important}
@media (prefers-reduced-motion:no-preference){.card{animation:in .25s ease-out}@keyframes in{from{opacity:0;transform:translateY(6px)}}}
@media (max-width:520px){.card{padding:16px}dl{grid-template-columns:1fr}.detail{margin-left:0;text-align:left}.checks li{flex-wrap:wrap}}
</style>
</head>
<body>
<a class="skip" href="#main" data-i18n="skip">Skip to content</a>
<header>
  <div class="brand"><span class="dot" aria-hidden="true"></span><span>Strckro <span class="mute" data-i18n="setup">Setup</span></span></div>
  <div class="lang" role="group" aria-label="Language">
    <button type="button" id="lang-en" aria-pressed="true" lang="en">EN</button>
    <button type="button" id="lang-th" aria-pressed="false" lang="th">ไทย</button>
  </div>
</header>
<main id="main" tabindex="-1">
  <ol class="steps" id="stepper" aria-label="Progress"></ol>
  <div id="app" aria-live="polite"></div>
  <noscript><div class="card">This setup page needs JavaScript. Run the installer again with --no-ui to use the terminal instead.</div></noscript>
</main>
<script nonce="__NONCE__">
(function () {
'use strict';
var I18N = {
 en: {
  skip:'Skip to content', setup:'Setup',
  s_welcome:'Check', s_settings:'Settings', s_review:'Review', s_install:'Install', s_done:'Done',
  w_title:'Welcome to the Strckro installer', w_lead:'This temporary page sets up Strckro on this server. It closes when the installation ends. It never asks you to type a password: a strong installer password is generated and shown once at the end.',
  w_checking:'Checking this server...', w_recheck:'Check again', w_next:'Continue', w_blocked:'Fix the failed checks, then check again.',
  st_pass:'OK', st_warn:'Warning', st_fail:'Failed',
  c_os:'Operating system', c_arch:'CPU architecture', c_root:'Running as root', c_ram:'Memory', c_disk:'Free disk space',
  c_port80:'Port 80 (HTTP, certificate challenge)', c_port443:'Port 443 (HTTPS)', c_port3100:'Port 3100 (portal, loopback)', 'c_net-nodejs':'Reach nodejs.org', 'c_net-github':'Reach github.com',
  e_title:'Settings', e_domain:'Portal domain', e_domain_help:'A lower-case fully qualified name, for example portal.example.com. Its DNS record must already point to this server.',
  e_email:'Email for TLS certificates', e_email_help:'Let’s Encrypt uses it for expiry notices.',
  e_node:'Node.js version for the portal', e_node_rec:'24 (Recommended)', e_node_eol:'20 (end of life)',
  e_back:'Back', e_next:'Review',
  d_checking:'Checking DNS...', d_none:'This name does not resolve yet. Create its A/AAAA record first; the installer stops if it cannot resolve it.',
  d_match:'Resolves to this server: ', d_other:'Resolves to: ', d_mismatch:' (this server’s own public addresses: ', d_nomatch:'does not match an address on this server; fine behind NAT or a proxy)', d_offline:'DNS check unavailable.', d_server:'This server’s public address: ',
  v_domain:'Enter a lower-case fully qualified domain.', v_email:'Enter a valid email address.',
  r_title:'Review', r_lead:'The installer will install Nginx, Certbot, the pinned Node.js and Bun runtimes and Strckro, then request a TLS certificate. If any step fails it restores the Strckro files it changed.', r_pw:'Installer password', r_pw_new:'Generated for you; shown once at the end', r_pw_existing:'Unchanged (existing installation)', r_start:'Start installation',
  i_title:'Installing', i_wait:'Please keep this page open. This usually takes a few minutes.', i_running:'Installation in progress...', i_log:'Installer output',
  p_packages:'Packages', p_node:'Node.js', p_bun:'Bun', p_files:'Application files', p_services:'Services', p_nginx:'Nginx', p_tls:'TLS certificate', p_verify:'HTTPS check',
  f_title:'Installation failed', f_line:'Failing line: ', f_rolled:'The installer rolled back the Strckro files it had changed. Installed packages and an already issued certificate are not removed.', f_norb:'It stopped before changing any Strckro files.', f_retry:'Retry', f_hint:'Fix the cause shown above, then retry. This page stays open for a while.',
  o_title:'Strckro is installed', o_open:'Open your portal', o_pw:'Installer password', o_copy:'Copy', o_copied:'Copied', o_once:'Shown once and never stored by this page. Save it now: you enter it when you first open the portal, to create the owner account with your own email and password.', o_gone:'The installer password was already shown. If you lost it and no owner exists yet, run: sudo strckro --reset-pwd', o_existing:'Your existing installer and owner passwords are unchanged.',
  o_next:'Next steps', o_n1:'Open the portal, enter the installer password above and create the owner account.', o_n2:'Command line help on the server:', o_n3:'Generate a new administrator password later:', o_close:'Close this page', o_closed:'You can close this page; the installer has stopped.',
  err_generic:'Something went wrong.', err_session:'The session expired. Reopen the URL with the token from the terminal.'
 },
 th: {
  skip:'ข้ามไปยังเนื้อหา', setup:'ตั้งค่า',
  s_welcome:'ตรวจสอบ', s_settings:'ตั้งค่า', s_review:'ทบทวน', s_install:'ติดตั้ง', s_done:'เสร็จสิ้น',
  w_title:'ยินดีต้อนรับสู่ตัวติดตั้ง Strckro', w_lead:'หน้านี้เป็นหน้าชั่วคราวสำหรับติดตั้ง Strckro บนเซิร์ฟเวอร์นี้ และจะปิดเมื่อการติดตั้งสิ้นสุด หน้านี้ไม่ขอรหัสผ่านจากคุณ ระบบจะสร้างรหัสผ่านที่แข็งแรงให้และแสดงเพียงครั้งเดียวตอนท้าย',
  w_checking:'กำลังตรวจสอบเซิร์ฟเวอร์...', w_recheck:'ตรวจสอบอีกครั้ง', w_next:'ดำเนินการต่อ', w_blocked:'แก้ไขรายการที่ไม่ผ่านแล้วตรวจสอบอีกครั้ง',
  st_pass:'ผ่าน', st_warn:'คำเตือน', st_fail:'ไม่ผ่าน',
  c_os:'ระบบปฏิบัติการ', c_arch:'สถาปัตยกรรม CPU', c_root:'รันด้วยสิทธิ์ root', c_ram:'หน่วยความจำ', c_disk:'พื้นที่ดิสก์ว่าง',
  c_port80:'พอร์ต 80 (HTTP สำหรับยืนยันใบรับรอง)', c_port443:'พอร์ต 443 (HTTPS)', c_port3100:'พอร์ต 3100 (พอร์ทัล, loopback)', 'c_net-nodejs':'เชื่อมต่อ nodejs.org', 'c_net-github':'เชื่อมต่อ github.com',
  e_title:'การตั้งค่า', e_domain:'โดเมนของพอร์ทัล', e_domain_help:'ชื่อโดเมนเต็มตัวพิมพ์เล็ก เช่น portal.example.com และ DNS ต้องชี้มาที่เซิร์ฟเวอร์นี้อยู่แล้ว',
  e_email:'อีเมลสำหรับใบรับรอง TLS', e_email_help:'Let’s Encrypt ใช้แจ้งเตือนก่อนใบรับรองหมดอายุ',
  e_node:'เวอร์ชัน Node.js ของพอร์ทัล', e_node_rec:'24 (แนะนำ)', e_node_eol:'20 (หมดอายุการสนับสนุน)',
  e_back:'ย้อนกลับ', e_next:'ทบทวน',
  d_checking:'กำลังตรวจสอบ DNS...', d_none:'ชื่อนี้ยังไม่ resolve กรุณาสร้างเรคคอร์ด A/AAAA ก่อน ตัวติดตั้งจะหยุดหากไม่สามารถ resolve ได้',
  d_match:'ชี้มาที่เซิร์ฟเวอร์นี้: ', d_other:'resolve เป็น: ', d_mismatch:' (ที่อยู่สาธารณะของเซิร์ฟเวอร์นี้: ', d_nomatch:'ไม่ตรงกับที่อยู่บนเซิร์ฟเวอร์นี้ ซึ่งปกติเมื่ออยู่หลัง NAT หรือพร็อกซี)', d_offline:'ไม่สามารถตรวจสอบ DNS ได้', d_server:'ที่อยู่สาธารณะของเซิร์ฟเวอร์นี้: ',
  v_domain:'กรอกโดเมนเต็มตัวพิมพ์เล็ก', v_email:'กรอกอีเมลให้ถูกต้อง',
  r_title:'ทบทวน', r_lead:'ตัวติดตั้งจะติดตั้ง Nginx, Certbot, Node.js และ Bun ตามเวอร์ชันที่กำหนด และ Strckro แล้วขอใบรับรอง TLS หากขั้นตอนใดล้มเหลวจะย้อนไฟล์ Strckro ที่แก้ไขกลับ', r_pw:'รหัสผ่านตัวติดตั้ง', r_pw_new:'สร้างให้อัตโนมัติ แสดงครั้งเดียวตอนท้าย', r_pw_existing:'ไม่เปลี่ยนแปลง (มีการติดตั้งอยู่แล้ว)', r_start:'เริ่มติดตั้ง',
  i_title:'กำลังติดตั้ง', i_wait:'กรุณาเปิดหน้านี้ไว้ ปกติใช้เวลาไม่กี่นาที', i_running:'กำลังติดตั้ง...', i_log:'ผลลัพธ์จากตัวติดตั้ง',
  p_packages:'แพ็กเกจ', p_node:'Node.js', p_bun:'Bun', p_files:'ไฟล์แอปพลิเคชัน', p_services:'เซอร์วิส', p_nginx:'Nginx', p_tls:'ใบรับรอง TLS', p_verify:'ตรวจสอบ HTTPS',
  f_title:'การติดตั้งล้มเหลว', f_line:'บรรทัดที่ล้มเหลว: ', f_rolled:'ตัวติดตั้งย้อนไฟล์ Strckro ที่แก้ไขกลับแล้ว แพ็กเกจที่ติดตั้งและใบรับรองที่ออกไปแล้วจะไม่ถูกลบ', f_norb:'หยุดก่อนแก้ไขไฟล์ Strckro ใด ๆ', f_retry:'ลองใหม่', f_hint:'แก้สาเหตุที่แสดงด้านบนแล้วลองใหม่ หน้านี้จะเปิดค้างไว้สักพัก',
  o_title:'ติดตั้ง Strckro เรียบร้อยแล้ว', o_open:'เปิดพอร์ทัลของคุณ', o_pw:'รหัสผ่านตัวติดตั้ง', o_copy:'คัดลอก', o_copied:'คัดลอกแล้ว', o_once:'แสดงเพียงครั้งเดียวและหน้านี้ไม่เก็บไว้ บันทึกไว้ทันที เพราะต้องกรอกเมื่อเปิดพอร์ทัลครั้งแรกเพื่อสร้างบัญชีเจ้าของด้วยอีเมลและรหัสผ่านของคุณเอง', o_gone:'แสดงรหัสผ่านตัวติดตั้งไปแล้ว หากทำหายและยังไม่มีบัญชีเจ้าของ ให้รัน: sudo strckro --reset-pwd', o_existing:'รหัสผ่านตัวติดตั้งและรหัสผ่านเจ้าของเดิมไม่เปลี่ยนแปลง',
  o_next:'ขั้นตอนถัดไป', o_n1:'เปิดพอร์ทัล กรอกรหัสผ่านตัวติดตั้งด้านบน และสร้างบัญชีเจ้าของ', o_n2:'วิธีใช้คำสั่งบนเซิร์ฟเวอร์:', o_n3:'สร้างรหัสผ่านผู้ดูแลใหม่ภายหลัง:', o_close:'ปิดหน้านี้', o_closed:'ปิดหน้านี้ได้ ตัวติดตั้งหยุดทำงานแล้ว',
  err_generic:'เกิดข้อผิดพลาด', err_session:'เซสชันหมดอายุ กรุณาเปิด URL พร้อมโทเค็นจากเทอร์มินัลอีกครั้ง'
 }
};
var VIEWS = ['welcome', 'settings', 'review', 'install', 'done'];
var STEPS = ['packages', 'node', 'bun', 'files', 'services', 'nginx', 'tls', 'verify'];
var DOMAIN_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
var lang = 'en', view = 'welcome', csrf = '', existing = false;
var settings = { domain: '', email: '', nodeMajor: '24' };
var checks = null, checking = false, dnsTimer = null, dnsSeq = 0, dnsInfo = null;
var steps = {}, logLines = [], failure = null, source = null, result = null, resultTried = false;
STEPS.forEach(function (id) { steps[id] = 'pending'; });
try { var saved = localStorage.getItem('strckro-setup-lang'); if (saved === 'th' || saved === 'en') lang = saved; else if ((navigator.language || '').slice(0, 2) === 'th') lang = 'th'; } catch (e) {}

function t(key) { return (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key; }
function h(tag, attrs) {
  var el = document.createElement(tag);
  if (attrs) Object.keys(attrs).forEach(function (k) {
    var v = attrs[k];
    if (v === false || v === null || v === undefined) return;
    if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v; else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : v);
  });
  for (var i = 2; i < arguments.length; i++) { var c = arguments[i]; if (c === null || c === undefined || c === false) continue; el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }
  return el;
}
function api(path, opts) {
  opts = opts || {};
  var headers = { 'X-CSRF-Token': csrf };
  if (opts.body) headers['Content-Type'] = 'application/json';
  return fetch(path, { method: opts.method || 'GET', credentials: 'same-origin', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined }).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (data) {
      if (!res.ok) { var err = new Error(data.error || res.statusText); err.status = res.status; err.data = data; throw err; }
      return data;
    });
  });
}
function applyLang() {
  document.documentElement.lang = lang;
  document.getElementById('lang-en').setAttribute('aria-pressed', String(lang === 'en'));
  document.getElementById('lang-th').setAttribute('aria-pressed', String(lang === 'th'));
  document.querySelectorAll('[data-i18n]').forEach(function (el) { el.textContent = t(el.getAttribute('data-i18n')); });
  render();
}
function setLang(next) { lang = next; try { localStorage.setItem('strckro-setup-lang', next); } catch (e) {} applyLang(); }
function go(next) { view = next; render(); var main = document.getElementById('main'); main.focus({ preventScroll: true }); window.scrollTo(0, 0); }

function renderStepper() {
  var list = document.getElementById('stepper');
  list.textContent = '';
  var index = VIEWS.indexOf(view);
  VIEWS.forEach(function (id, i) {
    var li = h('li', { class: i < index ? 'past' : '', text: t('s_' + id) });
    if (i === index) li.setAttribute('aria-current', 'step');
    list.appendChild(li);
  });
}

function viewWelcome() {
  var card = h('section', { class: 'card', 'aria-labelledby': 'ttl' }, h('h1', { id: 'ttl', text: t('w_title') }), h('p', { class: 'mute', text: t('w_lead') }));
  if (!checks) {
    card.appendChild(h('p', { role: 'status', text: t('w_checking') }));
    if (!checking) runChecks();
    return card;
  }
  var list = h('ul', { class: 'checks' });
  var failed = false;
  checks.forEach(function (c) {
    if (c.status === 'fail') failed = true;
    list.appendChild(h('li', null,
      h('span', { class: 'badge b-' + c.status, text: t('st_' + c.status) }),
      h('span', { text: t('c_' + c.id) }),
      h('span', { class: 'detail', text: c.detail || '' })));
  });
  card.appendChild(list);
  if (failed) card.appendChild(h('p', { class: 'err', role: 'alert', text: t('w_blocked') }));
  card.appendChild(h('div', { class: 'row' },
    h('button', { class: 'btn primary', type: 'button', disabled: failed, onclick: function () { go('settings'); } }, t('w_next')),
    h('button', { class: 'btn', type: 'button', onclick: function () { checks = null; render(); } }, t('w_recheck'))));
  return card;
}
function runChecks() {
  checking = true;
  api('/api/preflight').then(function (data) { checks = data.checks; }).catch(function (e) { fatal(e); checks = []; }).then(function () { checking = false; if (view === 'welcome') render(); });
}

function viewSettings() {
  var domain = h('input', { id: 'f-domain', type: 'text', value: settings.domain, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', inputmode: 'url', 'aria-describedby': 'h-domain', placeholder: 'portal.example.com' });
  var email = h('input', { id: 'f-email', type: 'email', value: settings.email, autocomplete: 'off', 'aria-describedby': 'h-email', placeholder: 'admin@example.com' });
  var node = h('select', { id: 'f-node' });
  [['20', t('e_node_eol')], ['22', '22'], ['24', t('e_node_rec')], ['26', '26']].forEach(function (o) { var opt = h('option', { value: o[0], text: o[1] }); if (o[0] === settings.nodeMajor) opt.selected = true; node.appendChild(opt); });
  var dnsBox = h('div', { id: 'h-domain', class: 'hint', 'aria-live': 'polite' });
  var emailBox = h('div', { id: 'h-email', class: 'hint', text: t('e_email_help') });
  var next = h('button', { class: 'btn primary', type: 'button' }, t('e_next'));
  function sync() {
    settings.domain = domain.value.trim().toLowerCase(); settings.email = email.value.trim(); settings.nodeMajor = node.value;
    next.disabled = !(DOMAIN_RE.test(settings.domain) && EMAIL_RE.test(settings.email));
  }
  function showDomain() {
    dnsBox.textContent = '';
    var valid = settings.domain === '' || DOMAIN_RE.test(settings.domain);
    domain.setAttribute('aria-invalid', String(!valid));
    if (!valid) { dnsBox.appendChild(h('span', { class: 'err', text: t('v_domain') })); return; }
    dnsBox.appendChild(document.createTextNode(t('e_domain_help')));
    if (dnsInfo && dnsInfo.domain === settings.domain) {
      dnsBox.appendChild(h('br'));
      if (dnsInfo.error) dnsBox.appendChild(document.createTextNode(t('d_offline')));
      else if (!dnsInfo.resolves) dnsBox.appendChild(h('span', { class: 'err', text: t('d_none') }));
      else if (dnsInfo.matchesServer) dnsBox.appendChild(h('span', { text: t('d_match') + dnsInfo.addresses.join(', ') }));
      else dnsBox.appendChild(document.createTextNode(t('d_other') + dnsInfo.addresses.join(', ') + (dnsInfo.serverAddresses.length ? t('d_mismatch') + dnsInfo.serverAddresses.join(', ') + '; ' + t('d_nomatch') : '')));
    } else if (settings.domain && dnsInfo === 'checking') dnsBox.appendChild(document.createTextNode(' ' + t('d_checking')));
    else if (settings.domain === '' && serverHint) dnsBox.appendChild(document.createTextNode(' ' + t('d_server') + serverHint));
  }
  function checkDns() {
    clearTimeout(dnsTimer);
    if (!DOMAIN_RE.test(settings.domain)) { dnsInfo = null; showDomain(); return; }
    dnsInfo = 'checking'; showDomain();
    var mine = ++dnsSeq, asked = settings.domain;
    dnsTimer = setTimeout(function () {
      api('/api/dns?domain=' + encodeURIComponent(asked)).then(function (data) { if (mine === dnsSeq) { dnsInfo = data; showDomain(); } }).catch(function () { if (mine === dnsSeq) { dnsInfo = { domain: asked, error: true }; showDomain(); } });
    }, 500);
  }
  domain.addEventListener('input', function () { sync(); checkDns(); showDomain(); });
  email.addEventListener('input', function () { sync(); var ok = settings.email === '' || EMAIL_RE.test(settings.email); email.setAttribute('aria-invalid', String(!ok)); emailBox.textContent = ok ? t('e_email_help') : t('v_email'); emailBox.className = ok ? 'hint' : 'hint err'; });
  node.addEventListener('change', sync);
  next.addEventListener('click', function () { sync(); go('review'); });
  var card = h('section', { class: 'card', 'aria-labelledby': 'ttl' }, h('h1', { id: 'ttl', text: t('e_title') }),
    h('label', { for: 'f-domain', text: t('e_domain') }), domain, dnsBox,
    h('label', { for: 'f-email', text: t('e_email') }), email, emailBox,
    h('label', { for: 'f-node', text: t('e_node') }), node,
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: function () { sync(); go('welcome'); } }, t('e_back')), next));
  sync(); showDomain();
  return card;
}
var serverHint = '';

function viewReview() {
  return h('section', { class: 'card', 'aria-labelledby': 'ttl' }, h('h1', { id: 'ttl', text: t('r_title') }), h('p', { class: 'mute', text: t('r_lead') }),
    h('dl', null,
      h('dt', { text: t('e_domain') }), h('dd', { text: settings.domain }),
      h('dt', { text: t('e_email') }), h('dd', { text: settings.email }),
      h('dt', { text: t('e_node') }), h('dd', { text: settings.nodeMajor }),
      h('dt', { text: t('r_pw') }), h('dd', { text: existing ? t('r_pw_existing') : t('r_pw_new') })),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: function () { go('settings'); } }, t('e_back')),
      h('button', { class: 'btn primary', type: 'button', onclick: startInstall }, t('r_start'))));
}
function startInstall() {
  logLines = []; failure = null; resetSteps();
  api('/api/install', { method: 'POST', body: settings }).then(function () { go('install'); openStream(0); }).catch(function (e) {
    if (e.status === 409) { go('install'); openStream(0); } else fatal(e);
  });
}
function resetSteps() { STEPS.forEach(function (id) { steps[id] = 'pending'; }); }

function openStream(after) {
  if (source) source.close();
  source = new EventSource('/api/events?after=' + after);
  source.addEventListener('log', function (ev) { var d = JSON.parse(ev.data); logLines.push(d.line); if (logLines.length > 3000) logLines.shift(); appendLog(d.line); });
  source.addEventListener('step', function (ev) { var d = JSON.parse(ev.data); steps[d.id] = d.status; paintSteps(); });
  source.addEventListener('phase', function (ev) {
    var d = JSON.parse(ev.data);
    if (d.phase === 'success') { source.close(); fetchResult(); }
    else if (d.phase === 'failed') { failure = d.failure; source.close(); if (view === 'install') render(); }
  });
}
function appendLog(line) {
  var pre = document.getElementById('log');
  if (!pre) return;
  var stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 24;
  pre.appendChild(document.createTextNode(line + '\n'));
  if (stick) pre.scrollTop = pre.scrollHeight;
}
function paintSteps() {
  var list = document.getElementById('plist');
  if (!list) return;
  STEPS.forEach(function (id) { var li = list.querySelector('[data-id="' + id + '"]'); if (li) li.setAttribute('data-s', steps[id]); });
}
function viewInstall() {
  var list = h('ul', { class: 'plist', id: 'plist' });
  STEPS.forEach(function (id) { list.appendChild(h('li', { 'data-id': id, 'data-s': steps[id] }, mark(steps[id]) + ' ' + t('p_' + id))); });
  var pre = h('pre', { class: 'log', id: 'log', tabindex: '0', role: 'log', 'aria-label': t('i_log') });
  pre.textContent = logLines.length ? logLines.join('\n') + '\n' : '';
  var card = h('section', { class: 'card', 'aria-labelledby': 'ttl' }, h('h1', { id: 'ttl', text: failure ? t('f_title') : t('i_title') }));
  if (failure) {
    card.appendChild(h('div', { class: 'alert', role: 'alert' },
      h('p', null, h('strong', { text: t('f_line') }), h('code', { text: failure.line })),
      h('p', { text: failure.rolledBack ? t('f_rolled') : t('f_norb') }),
      h('p', { class: 'mute', text: t('f_hint') })));
  } else card.appendChild(h('p', { class: 'mute', role: 'status', text: t('i_wait') }));
  card.appendChild(list); card.appendChild(pre);
  if (failure) card.appendChild(h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: function () { go('review'); } }, t('f_retry'))));
  setTimeout(function () { pre.scrollTop = pre.scrollHeight; }, 0);
  return card;
}
function mark(s) { return s === 'done' ? '✓' : s === 'running' ? '…' : s === 'failed' ? '✗' : '·'; }

function fetchResult() {
  resultTried = true;
  api('/api/result', { method: 'POST' }).then(function (data) { result = data; go('done'); }).catch(fatal);
}
function viewDone() {
  var r = result || {};
  var card = h('section', { class: 'card', 'aria-labelledby': 'ttl' }, h('h1', { id: 'ttl', text: t('o_title') }),
    h('p', null, h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer', text: r.url })));
  if (r.password) {
    var code = h('code', { id: 'pw', text: r.password });
    var status = h('span', { class: 'mute', role: 'status' });
    var copy = h('button', { class: 'btn', type: 'button', onclick: function () {
      var done = function () { status.textContent = t('o_copied'); };
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(r.password).then(done, function () { selectPw(code); });
      else selectPw(code);
    } }, t('o_copy'));
    card.appendChild(h('h2', { text: t('o_pw') }));
    card.appendChild(h('div', { class: 'pw' }, code, copy, status));
    card.appendChild(h('div', { class: 'note', role: 'note', text: t('o_once') }));
  } else if (r.existing) card.appendChild(h('p', { text: t('o_existing') }));
  else card.appendChild(h('div', { class: 'note', text: t('o_gone') }));
  card.appendChild(h('h2', { text: t('o_next') }));
  card.appendChild(h('ol', null, h('li', { text: t('o_n1') }), h('li', null, t('o_n2') + ' ', h('code', { text: 'sudo strckro -h' })), h('li', null, t('o_n3') + ' ', h('code', { text: 'sudo strckro --reset-pwd' }))));
  card.appendChild(h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: function () {
    api('/api/finish', { method: 'POST' }).catch(function () {}).then(function () { card.appendChild(h('p', { class: 'mute', role: 'status', text: t('o_closed') })); });
  } }, t('o_close'))));
  return card;
}
function selectPw(node) { var range = document.createRange(); range.selectNodeContents(node); var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range); }

function fatal(e) {
  var app = document.getElementById('app');
  app.textContent = '';
  app.appendChild(h('div', { class: 'alert', role: 'alert' }, h('p', { text: e && e.status === 401 ? t('err_session') : (e && e.message) || t('err_generic') })));
}
function render() {
  renderStepper();
  var app = document.getElementById('app');
  app.textContent = '';
  var node = view === 'welcome' ? viewWelcome() : view === 'settings' ? viewSettings() : view === 'review' ? viewReview() : view === 'install' ? viewInstall() : viewDone();
  app.appendChild(node);
}
document.getElementById('lang-en').addEventListener('click', function () { setLang('en'); });
document.getElementById('lang-th').addEventListener('click', function () { setLang('th'); });

api('/api/session').then(function (s) {
  csrf = s.csrf; existing = s.existing; serverHint = (s.serverAddresses || [])[0] || ''; settings.nodeMajor = s.defaultNodeMajor || '24';
  if (s.settings) settings = { domain: s.settings.domain, email: s.settings.email, nodeMajor: s.settings.nodeMajor };
  s.steps.forEach(function (st) { steps[st.id] = st.status; });
  applyLang();
  if (s.phase === 'running' || s.phase === 'failed') { failure = s.failure; go('install'); openStream(0); }
  else if (s.phase === 'success') { go('install'); openStream(0); }
}).catch(function (e) { applyLang(); fatal(e); });
})();
</script>
</body>
</html>
`;

// Last, so every binding above (the page included) is initialised before the server can answer.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
