import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { hashPassword } from '../src/auth.mjs';
import { PERMISSION_PRESETS } from '../src/access.mjs';
import { authorizeRequest } from '../src/authorization.mjs';
import { projectStatus, pipelineStages, isOff, stopConfirmation, operationLabel } from '../public/ui/core/model.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start, login, request } from './support/server.mjs';

// Helper functions run in a separate vm realm; compare plain JSON, not realm-bound objects.
const plain = (value) => JSON.parse(JSON.stringify(value));

const releaseId = 'd22189ce-59a8-48fc-9b11-526ea43dce39';
const helperSource = await readFile(new URL('../scripts/hostmgr-deploy-helper.mjs', import.meta.url), 'utf8');
const fn = (name) => helperSource.match(new RegExp(`async function ${name}\\([^]*?\\n\\}`))[0];

// ---------------------------------------------------------------- helper

function helperHarness({ project = {}, target = `/releases/${releaseId}`, unit = true, healthy = true } = {}) {
  const calls = [];
  const context = {
    loadProject: async () => ({ runtime: 'node', serviceType: 'web', port: 3000, healthCheckEnabled: false, deployment: { state: 'active', activeReleaseId: releaseId }, ...project }),
    validateReleaseId() {},
    projectIdentity: (slug) => ({ current: '/current', releases: '/releases', unitFile: '/units/x.service', service: `hostmgr-project-${slug}.service` }),
    readlink: async () => target,
    exists: async () => unit,
    join: (...parts) => parts.join('/'),
    run: async (command, args, options) => { calls.push([command, Array.from(args)]); return ''; },
    runDockerCompose: async (_project, root, args, options) => { calls.push(['docker-compose', root, Array.from(args)]); return ''; },
    checkWorkerProcess: async () => { calls.push(['process-stability']); },
    healthCheck: async () => { calls.push(['health']); return healthy; },
    delay: async () => {},
    Date,
    HelperError: Error
  };
  const stop = vm.runInNewContext(`(${fn('stopProject')})`, context);
  const startProject = vm.runInNewContext(`(${fn('startProject')})`, context);
  return { calls, stop, start: startProject };
}

test('helper dispatches stop-project and start-project by slug only', () => {
  assert.match(helperSource, /request\.operation === 'stop-project'\) return stopProject\(request\.slug\);/);
  assert.match(helperSource, /request\.operation === 'start-project'\) return startProject\(request\.slug\);/);
  for (const name of ['stopProject', 'startProject']) {
    const source = fn(name);
    assert.ok(!/\brequest\b|\.unit\b|\.service\b\s*=/.test(source.replace(/identity\.service/g, '')), `${name} must not read a unit name from the caller`);
  }
});

test('stop disables and stops only the slug-derived systemd unit', async () => {
  const { calls, stop } = helperHarness();
  assert.deepEqual(plain(await stop('fixture')), { state: 'off' });
  assert.deepEqual(calls, [['/usr/bin/systemctl', ['disable', '--now', 'hostmgr-project-fixture.service']]]);
});

test('stop is idempotent: repeating it issues the same single command and still reports off', async () => {
  const { calls, stop } = helperHarness();
  await stop('fixture');
  await stop('fixture');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
});

test('stop never removes files, Nginx configuration, accounts or ENV', async () => {
  const source = fn('stopProject');
  for (const forbidden of [/\brm\(/, /unlink/, /removeManagedNginx/, /nginx/i, /daemon-reload/, /userdel/, /applyDomains/, /environmentFile/, /releases\b.*recursive/, /'-v'/, /--volumes/, /--rmi/]) assert.ok(!forbidden.test(source), String(forbidden));
  const { calls, stop } = helperHarness({ project: { runtime: 'docker-compose', composeFile: 'compose.yaml', composeService: 'web' } });
  assert.deepEqual(plain(await stop('fixture')), { state: 'off' });
  assert.deepEqual(calls, [['docker-compose', `/releases/${releaseId}`, ['down', '--remove-orphans']]]);
  const flat = calls.flat(2).join(' ');
  assert.ok(!/(^| )(-v|--volumes|--rmi|rm)( |$)/.test(flat));
});

test('stop does nothing for a project that was never activated and refuses during a deployment', async () => {
  const idle = helperHarness({ unit: false });
  assert.deepEqual(plain(await idle.stop('fixture')), { state: 'off' });
  assert.deepEqual(idle.calls, []);
  const busy = helperHarness({ project: { deployment: { state: 'deploying', activeReleaseId: releaseId } } });
  await assert.rejects(busy.stop('fixture'), /deployment operation/);
  assert.deepEqual(busy.calls, []);
});

test('start enables and starts the unit of the active release, then checks the process', async () => {
  const { calls, start: run } = helperHarness();
  assert.deepEqual(plain(await run('fixture')), { state: 'active', releaseId });
  assert.deepEqual(calls, [
    ['/usr/bin/systemctl', ['enable', 'hostmgr-project-fixture.service']],
    ['/usr/bin/systemctl', ['start', 'hostmgr-project-fixture.service']],
    ['process-stability']
  ]);
});

test('start runs the same HTTP health check as restart and fails when it never passes', async () => {
  const ok = helperHarness({ project: { healthCheckEnabled: true, healthCheckPath: '/up' } });
  assert.equal((await ok.start('fixture')).state, 'active');
  assert.ok(ok.calls.some(([name]) => name === 'health'));
  const worker = helperHarness({ project: { serviceType: 'worker', port: null, healthCheckEnabled: true } });
  await worker.start('fixture');
  assert.ok(!worker.calls.some(([name]) => name === 'health'));
  const failing = helperHarness({ project: { healthCheckEnabled: true }, healthy: false });
  const realNow = Date.now;
  let tick = 0;
  Date.now = () => (tick += 20_000);
  try { await assert.rejects(failing.start('fixture'), /health check/); }
  finally { Date.now = realNow; }
});

test('start is refused without an active release, with a mismatched release or during a deployment', async () => {
  for (const [options, message] of [
    [{ project: { deployment: { state: 'idle', activeReleaseId: null } } }, /no active release/],
    [{ target: '/releases/other' }, /does not match/],
    [{ project: { deployment: { state: 'rolling_back', activeReleaseId: releaseId } } }, /deployment operation/]
  ]) {
    const { calls, start: run } = helperHarness(options);
    await assert.rejects(run('fixture'), message);
    assert.deepEqual(calls, []);
  }
});

test('start brings a Compose project up without rebuilding or removing anything', async () => {
  const { calls, start: run } = helperHarness({ project: { runtime: 'docker-compose', composeFile: 'compose.yaml', composeService: 'web' } });
  assert.deepEqual(plain(await run('fixture')), { state: 'active', releaseId });
  assert.deepEqual(calls, [['docker-compose', `/releases/${releaseId}`, ['up', '--detach', '--remove-orphans']]]);
});

test('the helper itself refuses restart and activation while the project is off, and reports off', async () => {
  assert.match(fn('restartProject'), /service\?\.enabled === false\) throw new HelperError\('The project is turned off/);
  assert.match(fn('activateProject'), /service\?\.enabled === false\) throw new HelperError\('The project is turned off/);
  const status = vm.runInNewContext(`(${fn('projectRuntimeStatus')})`, {
    loadProject: async () => ({ serviceType: 'web', runtime: 'node', service: { enabled: false } }),
    projectIdentity: () => ({}), run: async () => assert.fail('off must not probe systemd'), HelperError: Error
  });
  assert.deepEqual(plain(await status('fixture')), { state: 'off' });
  const restart = vm.runInNewContext(`(${fn('restartProject')})`, {
    loadProject: async () => ({ runtime: 'node', service: { enabled: false }, deployment: { state: 'active', activeReleaseId: releaseId } }),
    validateReleaseId() {}, run: async () => assert.fail('restart must not run while off'), HelperError: Error
  });
  await assert.rejects(restart('fixture', releaseId), /turned off/);
});

// ---------------------------------------------------------------- portal routes

async function fixture(t, helper, options = {}) {
  const previous = process.env.HOSTMGR_DEPLOY_HELPER_SOCKET;
  process.env.HOSTMGR_DEPLOY_HELPER_SOCKET = '/fixture-power.sock';
  const result = await start({ mode: 'host', autoSyncPollingEnabled: false, projectRestartHelper: helper, projectRuntimeProbe: async () => ({ state: 'active' }), ...options });
  t.after(async () => { await result.app.close(); if (previous === undefined) delete process.env.HOSTMGR_DEPLOY_HELPER_SOCKET; else process.env.HOSTMGR_DEPLOY_HELPER_SOCKET = previous; });
  await result.app.store.update(state => state.projects.push({
    name: 'Power fixture', slug: 'power-fixture', runtime: 'node', port: 3000,
    sync: { status: 'synced', revision: 'deployed-commit' },
    domains: { hosts: ['power.example.test'], activeHosts: ['power.example.test'], syncedAt: '2026-01-01T00:00:00.000Z' },
    environment: { keys: ['NODE_ENV'], encryptedContent: { private: 'saved' } },
    deployment: { state: 'active', activeReleaseId: releaseId, previousReleaseId: null, releases: [{ id: releaseId, status: 'active', revision: 'deployed-commit' }] }
  }));
  return { ...result, headers: await login(result.base) };
}
const stopBody = { confirm: true };

test('stop records the intentional off state, audits it, and touches nothing else on the project', async t => {
  const messages = [];
  const { app, base, headers } = await fixture(t, async (_socket, message) => { messages.push(message); return { ok: true, state: 'off' }; });
  const before = structuredClone(app.store.snapshot().projects[0]);
  const result = await request(base, '/api/projects/power-fixture/stop', headers, 'POST', stopBody);
  assert.equal(result.status, 200);
  assert.deepEqual(messages, [{ operation: 'stop-project', slug: 'power-fixture' }]);
  const project = app.store.snapshot().projects[0];
  assert.equal(project.service.enabled, false);
  assert.ok(Date.parse(project.service.stoppedAt));
  assert.equal(project.runtimeOperation.kind, 'stop');
  assert.equal(project.runtimeOperation.status, 'succeeded');
  assert.deepEqual(project.deployment, before.deployment);
  assert.deepEqual(project.domains, before.domains);
  assert.deepEqual(project.environment, before.environment);
  assert.equal(app.store.snapshot().jobs.length, 0);
  assert.deepEqual(result.body.project.service.enabled, false);
  assert.ok(app.store.snapshot().audit.some(event => event.action === 'project.stop' && event.outcome === 'success' && event.target === 'power-fixture'));
  assert.ok(app.store.snapshot().audit.some(event => event.action === 'project.stop' && event.outcome === 'started'));
});

test('while off the project list reports off without asking the host, and start turns it back on', async t => {
  let probed = 0;
  const helper = async (_socket, message) => (message.operation === 'stop-project' ? { ok: true, state: 'off' } : { ok: true, state: 'active', releaseId });
  const { app, base, headers } = await fixture(t, helper, { projectRuntimeProbe: async () => { probed++; return { state: 'down' }; } });
  assert.equal((await request(base, '/api/projects', headers)).body.projects[0].runtimeStatus.state, 'down');
  probed = 0;
  await request(base, '/api/projects/power-fixture/stop', headers, 'POST', stopBody);
  const listed = (await request(base, '/api/projects', headers)).body.projects[0];
  assert.equal(listed.runtimeStatus.state, 'off');
  assert.equal(probed, 0);
  const started = await request(base, '/api/projects/power-fixture/start', headers, 'POST', {});
  assert.equal(started.status, 200);
  assert.equal(app.store.snapshot().projects[0].service.enabled, true);
  assert.ok(app.store.snapshot().projects[0].service.startedAt);
  assert.equal(app.store.snapshot().projects[0].runtimeOperation.kind, 'start');
  assert.ok(app.store.snapshot().audit.some(event => event.action === 'project.start' && event.outcome === 'success'));
});

test('stop requires confirmation, an active release, a current release id and an idle project', async t => {
  const { app, base, headers } = await fixture(t, async () => ({ ok: true, state: 'off' }));
  const stop = (body) => request(base, '/api/projects/power-fixture/stop', headers, 'POST', body);
  assert.equal((await stop({})).status, 400);
  assert.equal((await stop({ confirm: true, releaseId: 'stale-release' })).status, 400);
  await app.store.update(state => { state.jobs.push({ id: randomUUID(), kind: 'deploy', projectSlug: 'power-fixture', status: 'running', createdAt: new Date().toISOString() }); });
  assert.equal((await stop(stopBody)).status, 400);
  await app.store.update(state => { state.jobs = []; state.projects[0].deployment.activeReleaseId = null; });
  assert.equal((await stop(stopBody)).status, 400);
  assert.equal(app.store.snapshot().projects[0].service, undefined);
});

test('start is refused when the project has no active release and never reaches the helper', async t => {
  const { app, base, headers } = await fixture(t, async () => assert.fail('helper must not run'));
  await app.store.update(state => { state.projects[0].deployment.activeReleaseId = null; });
  const result = await request(base, '/api/projects/power-fixture/start', headers, 'POST', {});
  assert.equal(result.status, 400);
  assert.match(result.body.error, /no active release/);
  assert.equal(app.store.snapshot().projects[0].service, undefined);
});

test('stop and start are idempotent: repeating either converges and keeps the same state', async t => {
  const calls = [];
  const { app, base, headers } = await fixture(t, async (_socket, message) => { calls.push(message.operation); return message.operation === 'stop-project' ? { ok: true, state: 'off' } : { ok: true, state: 'active', releaseId }; });
  assert.equal((await request(base, '/api/projects/power-fixture/stop', headers, 'POST', stopBody)).status, 200);
  assert.equal((await request(base, '/api/projects/power-fixture/stop', headers, 'POST', stopBody)).status, 200);
  assert.equal(app.store.snapshot().projects[0].service.enabled, false);
  assert.equal((await request(base, '/api/projects/power-fixture/start', headers, 'POST', {})).status, 200);
  assert.equal((await request(base, '/api/projects/power-fixture/start', headers, 'POST', {})).status, 200);
  assert.equal(app.store.snapshot().projects[0].service.enabled, true);
  assert.deepEqual(calls, ['stop-project', 'stop-project', 'start-project', 'start-project']);
});

test('a helper failure keeps the previous state, is visible, and does not leak helper output', async t => {
  const { app, base, headers } = await fixture(t, async () => ({ ok: false, error: 'private-fixture-secret', buildOutput: 'private-fixture-secret' }));
  const stopped = await request(base, '/api/projects/power-fixture/stop', headers, 'POST', stopBody);
  assert.equal(stopped.status, 422);
  assert.equal(stopped.body.project.runtimeOperation.status, 'failed');
  assert.equal(app.store.snapshot().projects[0].service, undefined);
  assert.ok(!JSON.stringify(stopped.body).includes('private-fixture-secret'));
  await app.store.update(state => { state.projects[0].service = { enabled: false, stoppedAt: '2026-01-01T00:00:00.000Z' }; });
  const started = await request(base, '/api/projects/power-fixture/start', headers, 'POST', {});
  assert.equal(started.status, 422);
  assert.equal(app.store.snapshot().projects[0].service.enabled, false, 'a failed start leaves the project off');
  assert.ok(!JSON.stringify(started.body).includes('private-fixture-secret'));
  assert.ok(app.store.snapshot().audit.some(event => event.action === 'project.start' && event.outcome === 'failure'));
});

test('a start that the helper does not confirm for the active release is a failure', async t => {
  const { app, base, headers } = await fixture(t, async () => ({ ok: true, state: 'active', releaseId: 'another-release' }));
  await app.store.update(state => { state.projects[0].service = { enabled: false, stoppedAt: '2026-01-01T00:00:00.000Z' }; });
  assert.equal((await request(base, '/api/projects/power-fixture/start', headers, 'POST', {})).status, 422);
  assert.equal(app.store.snapshot().projects[0].service.enabled, false);
});

test('while off, restart, manual deploy and rollback are refused with a clear message and change nothing', async t => {
  const { app, base, headers } = await fixture(t, async (_socket, message) => (message.operation === 'stop-project' ? { ok: true, state: 'off' } : assert.fail('helper must not run for ' + message.operation)));
  await request(base, '/api/projects/power-fixture/stop', headers, 'POST', stopBody);
  const before = structuredClone(app.store.snapshot().projects[0].deployment);
  for (const [action, body] of [['restart', { confirm: true }], ['deploy', {}], ['rollback', {}]]) {
    const result = await request(base, `/api/projects/power-fixture/${action}`, headers, 'POST', body);
    assert.equal(result.status, 400, action);
    assert.match(result.body.error, /turned off/, action);
  }
  assert.deepEqual(app.store.snapshot().projects[0].deployment, before);
  assert.equal(app.store.snapshot().jobs.length, 0);
});

test('while off, deletion still works', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'power-projects-'));
  const { app, base } = await start({ projectRoot });
  t.after(() => app.close());
  const headers = await login(base);
  await app.store.update(state => state.projects.push({ name: 'Doomed', slug: 'doomed-power', runtime: 'node', port: 3000, deployment: { state: 'active', activeReleaseId: releaseId, releases: [{ id: releaseId, status: 'active', revision: 'x' }] } }));
  assert.equal((await request(base, '/api/projects/doomed-power/stop', headers, 'POST', stopBody)).status, 200);
  assert.equal(app.store.snapshot().projects[0].service.enabled, false);
  assert.equal((await request(base, '/api/projects/doomed-power', headers, 'DELETE', {})).status, 200);
  assert.equal(app.store.snapshot().projects.length, 0);
});

test('overlapping mutations are blocked while stop is running', async t => {
  let finish;
  const { base, headers } = await fixture(t, () => new Promise(resolve => { finish = resolve; }));
  const pending = request(base, '/api/projects/power-fixture/stop', headers, 'POST', stopBody);
  for (let n = 0; !finish && n < 30; n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(finish);
  for (const action of ['restart', 'start', 'stop', 'deploy', 'rollback']) assert.equal((await request(base, `/api/projects/power-fixture/${action}`, headers, 'POST', { confirm: true })).status, 400, action);
  finish({ ok: true, state: 'off' });
  assert.equal((await pending).status, 200);
});

test('Portal startup marks an unfinished stop or start as unconfirmed and leaves the service flag alone', async t => {
  const first = await start({ autoSyncPollingEnabled: false });
  await first.app.store.update(state => state.projects.push({ slug: 'interrupted-stop', name: 'Interrupted', deployment: { state: 'active', activeReleaseId: releaseId }, runtimeOperation: { kind: 'stop', status: 'running', releaseId } }));
  await first.app.close();
  const second = await start({ dataPath: first.dataPath, autoSyncPollingEnabled: false });
  t.after(() => second.app.close());
  const project = second.app.store.snapshot().projects[0];
  assert.equal(project.runtimeOperation.status, 'failed');
  assert.match(project.runtimeOperation.detail, /turning the project off/);
  assert.equal(project.service, undefined);
  assert.ok(second.app.store.snapshot().audit.some(event => event.action === 'project.stop' && event.outcome === 'failure' && event.actor === 'system'));
});

test('auto-deploy is blocked while off: it records why, builds no release and starts nothing', async t => {
  let revision = 'a'.repeat(40);
  const { app, base } = await start({ autoSyncPollingEnabled: false, projectSyncer: async () => ({ status: 'synced', at: new Date().toISOString(), revision, detail: 'Repository checked.' }) });
  t.after(() => app.close());
  const headers = await login(base);
  const post = async (path, body = {}) => { const response = await request(base, path, headers, 'POST', body); assert.equal(response.status, 200, path); return response.body; };
  await post('/api/tools/git/install', { confirm: true });
  await post('/api/git-config', { name: 'Fixture', email: 'fixture@example.test' });
  const body = { name: 'Power auto', slug: 'power-auto', repository: 'https://github.com/example/power.git', branch: 'main', port: 3016, protocol: 'https' };
  await post('/api/projects/sync', body);
  await post('/api/projects/power-auto/environment', { content: 'NODE_ENV=production\n' });
  assert.equal((await post('/api/projects/power-auto/deploy')).activation, 'complete');
  await post('/api/projects/power-auto/auto-sync', { enabled: true });
  // Sandbox/demo mode simulates the toggle without any helper.
  assert.equal((await post('/api/projects/power-auto/stop', stopBody)).project.service.enabled, false);
  const releases = app.store.snapshot().projects[0].deployment.releases.length;
  revision = 'b'.repeat(40);
  const synced = await post('/api/projects/sync', body);
  assert.equal(synced.activation, 'blocked');
  const project = app.store.snapshot().projects[0];
  assert.equal(project.deployment.releases.length, releases);
  assert.equal(project.autoSync.lastResult.status, 'blocked');
  assert.match(project.autoSync.lastResult.detail, /turned off/);
  assert.equal(project.service.enabled, false);
  assert.equal(app.store.snapshot().jobs.length, 0);
  const manual = await request(base, '/api/projects/power-auto/deploy', headers, 'POST', {});
  assert.equal(manual.status, 400);
  assert.match(manual.body.error, /turned off/);
  assert.equal((await post('/api/projects/power-auto/start')).project.service.enabled, true);
  assert.equal((await post('/api/projects/power-auto/deploy')).activation, 'complete');
});

test('in demo and sandbox mode stop and start simulate and never call a helper', async t => {
  const { app, base } = await start({ projectRestartHelper: async () => assert.fail('helper must not run in demo mode') });
  t.after(() => app.close());
  const headers = await login(base);
  await app.store.update(state => state.projects.push({ name: 'Demo', slug: 'demo-power', runtime: 'node', port: 3000, deployment: { state: 'active', activeReleaseId: releaseId, releases: [{ id: releaseId, status: 'active', revision: 'x' }] } }));
  const stopped = await request(base, '/api/projects/demo-power/stop', headers, 'POST', stopBody);
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.project.service.enabled, false);
  assert.match(stopped.body.project.runtimeOperation.detail, /simulated/i);
  assert.equal((await request(base, '/api/projects')).status, 401);
  assert.equal((await request(base, '/api/projects', headers)).body.projects[0].runtimeStatus.state, 'off');
  assert.equal((await request(base, '/api/projects/demo-power/start', headers, 'POST', {})).body.project.service.enabled, true);
});

// ---------------------------------------------------------------- authorization

const PASSWORD = 'Testing-Password-739!';

test('stop and start need a session, a CSRF token and the deploy permission', async t => {
  const calls = [];
  const { app, base, headers } = await fixture(t, async (_socket, message) => { calls.push(message.operation); return message.operation === 'stop-project' ? { ok: true, state: 'off' } : { ok: true, state: 'active', releaseId }; });
  const operator = randomUUID();
  const viewer = randomUUID();
  const organizationId = randomUUID();
  await app.store.update(state => {
    state.organizations.push({ id: organizationId, name: 'Alpha' });
    for (const [id, email, permissions] of [[operator, 'operator@example.test', PERMISSION_PRESETS.operator], [viewer, 'viewer@example.test', PERMISSION_PRESETS.viewer]]) {
      state.users.push({ id, email, password: hashPassword(PASSWORD), role: 'user', status: 'active', authVersion: 1 });
      state.memberships.push({ userId: id, organizationId, permissions: [...permissions] });
    }
    state.projects[0].organizationId = organizationId;
  });
  for (const action of ['stop', 'start']) {
    const path = `/api/projects/power-fixture/${action}`;
    assert.equal((await request(base, path, {}, 'POST', stopBody)).status, 401, `${action} anonymous`);
    assert.equal((await request(base, path, { cookie: headers.cookie, 'content-type': 'application/json' }, 'POST', stopBody)).status, 403, `${action} without CSRF`);
  }
  const viewerHeaders = await login(base, 'viewer@example.test', PASSWORD);
  for (const action of ['stop', 'start']) assert.equal((await request(base, `/api/projects/power-fixture/${action}`, viewerHeaders, 'POST', stopBody)).status, 403, `${action} viewer`);
  assert.deepEqual(calls, []);
  const operatorHeaders = await login(base, 'operator@example.test', PASSWORD);
  assert.equal((await request(base, '/api/projects/power-fixture/stop', operatorHeaders, 'POST', stopBody)).status, 200);
  assert.equal((await request(base, '/api/projects/power-fixture/start', operatorHeaders, 'POST', {})).status, 200);
  assert.deepEqual(calls, ['stop-project', 'start-project']);
});


test('CLI tokens cannot stop or start a project, and the portal maps both to the restart permission', async () => {
  const cli = await readFile(new URL('../src/cli-auth.mjs', import.meta.url), 'utf8');
  assert.ok(!/POST stop|POST start/.test(cli), 'skctl has no stop/start; they stay out of the CLI token allow-list');
  const authorization = await readFile(new URL('../src/authorization.mjs', import.meta.url), 'utf8');
  assert.match(authorization, /'POST restart': 'deploy\.start', 'POST stop': 'deploy\.start', 'POST start': 'deploy\.start'/);
});

// ---------------------------------------------------------------- UI model

const liveProject = { name: 'Fixture', sync: { status: 'synced' }, deployment: { state: 'active', activeReleaseId: releaseId, releases: [{ id: releaseId, status: 'active' }] } };

test('an off project is neutral in the badge and the pipeline track, never Needs attention', () => {
  assert.deepEqual(projectStatus(liveProject), { id: 'ready', label: 'Live', tone: 'success' });
  for (const extra of [{ service: { enabled: false } }, { runtimeStatus: { state: 'off' } }]) {
    const project = { ...liveProject, ...extra };
    assert.equal(isOff(project), true);
    assert.deepEqual(projectStatus(project), { id: 'off', label: 'Off', tone: 'neutral' });
    const serving = pipelineStages(project).find(stage => stage.key === 'serving');
    assert.deepEqual([serving.state, serving.detail], ['idle', 'off']);
  }
  // Off wins over a failure that the owner already caused or that predates it.
  assert.equal(projectStatus({ ...liveProject, service: { enabled: false }, runtimeStatus: { state: 'down' } }).id, 'off');
  // A project that is on keeps reporting a real outage.
  assert.equal(projectStatus({ ...liveProject, service: { enabled: true }, runtimeStatus: { state: 'down' } }).id, 'down');
  assert.equal(isOff({ ...liveProject, service: { enabled: true } }), false);
});

test('turning off or on shows as in progress with its own label, and the confirmation names the domains and 502', () => {
  const stopping = { ...liveProject, runtimeOperation: { kind: 'stop', status: 'running' } };
  assert.equal(projectStatus(stopping).id, 'building');
  assert.equal(operationLabel(stopping), 'Turning off…');
  assert.equal(operationLabel({ ...liveProject, runtimeOperation: { kind: 'start', status: 'running' } }), 'Turning on…');
  const text = stopConfirmation({ ...liveProject, domains: { hosts: ['a.example.test', 'b.example.test'] } });
  assert.match(text, /a\.example\.test, b\.example\.test/);
  assert.match(text, /502/);
  assert.match(text, /reboot/);
  assert.match(stopConfirmation(liveProject), /502/);
});

test('the application sheet offers Turn off / Turn on and blocks release actions while off', async () => {
  const screen = await readFile(new URL('../public/ui/screens/release.js', import.meta.url), 'utf8');
  assert.match(screen, /"\/stop" : "\/start"/);
  assert.match(screen, /isOff\(p\) \? "Turn on" : "Turn off"/);
  assert.equal((screen.match(/"data-needs-on": "true"/g) ?? []).length, 2, 'Create release and Restart app are blocked while off');
  assert.match(screen, /stopConfirmation\(p\)/);
  const workspace = await readFile(new URL('../public/ui/screens/workspace.js', import.meta.url), 'utf8');
  assert.match(workspace, /\["off", "Off"\]/);
  assert.match(workspace, /off: 0/);
});
