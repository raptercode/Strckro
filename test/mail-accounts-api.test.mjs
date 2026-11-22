import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../src/auth.mjs';
import { SecretVault } from '../src/core.mjs';
import { MAIL_CONFIG_VERSION } from '../scripts/mail-host-config.mjs';
import { start, login, request } from './support/server.mjs';

const verified = () => ({ status: 'verified', checkedAt: new Date().toISOString(), detail: null });
const dnsStubs = {
  mailHostnameCheck: async () => ({ status: 'ok', proxied: false }),
  mailMxCheck: async () => verified(), mailSpfCheck: async () => verified(), mailDkimCheck: async () => verified(),
  mailDmarcCheck: async () => verified(), mailPtrCheck: async () => verified()
};
const vault = new SecretVault(Buffer.alloc(32, 7).toString('base64'));
const environmentOf = (app, slug) => {
  const project = app.store.snapshot().projects.find((item) => item.slug === slug);
  return project?.environment?.encryptedContent ? vault.decrypt(project.environment.encryptedContent) : '';
};

async function sandbox(t) {
  const { app, base } = await start({ ...dnsStubs });
  t.after(() => app.close());
  const headers = await login(base);
  const call = (method, path, body) => request(base, path, method === 'GET' ? { cookie: headers.cookie } : headers, method, method === 'GET' ? undefined : (body ?? {}));
  const post = async (path, body = {}, expected = 200) => {
    const result = await call('POST', path, body);
    assert.equal(result.status, expected, `${path} → ${result.status} ${JSON.stringify(result.body)}`);
    return result.body;
  };
  await post('/api/mail/hostname', { hostname: 'mail.example.test' });
  await post('/api/mail/domains', { domain: 'example.test' });
  await post('/api/mail/outbound-mode', { mode: 'direct' });
  await post('/api/tools/mail/install', { confirm: true });
  await post('/api/mail/configure', { confirm: true });
  const hello = (await post('/api/mail/mailboxes', { domain: 'example.test', localPart: 'hello', displayName: 'Hello', password: 'Mailbox-Pass-1!' }, 201)).mailbox;
  const support = (await post('/api/mail/mailboxes', { domain: 'example.test', localPart: 'support', displayName: 'Support', password: 'Mailbox-Pass-2!' }, 201)).mailbox;
  await app.store.update((state) => {
    state.projects.push({ name: 'Shop API', slug: 'shop-api', environment: { keys: ['NODE_ENV'], encryptedContent: vault.encrypt('# shop\nNODE_ENV=production\n') } });
    state.projects.push({ name: 'Blog', slug: 'blog' });
  });
  return { app, base, headers, call, post, hello, support };
}

async function asMember(app, base) {
  const organizationId = randomUUID();
  const userId = randomUUID();
  await app.store.update((state) => {
    state.organizations.push({ id: organizationId, name: 'Members' });
    state.users.push({ id: userId, email: 'member@example.test', password: hashPassword('Member-Test-Password-739!'), role: 'user', status: 'active', authVersion: 1 });
    state.memberships.push({ userId, organizationId, permissions: ['project.view', 'project.configure', 'env.read', 'env.write', 'logs.read', 'audit.read', 'domains.manage'] });
  });
  return login(base, 'member@example.test', 'Member-Test-Password-739!');
}

test('a mailbox password is changed with the creation policy, and never stored or logged', async (t) => {
  const { app, base, headers, call, post, hello } = await sandbox(t);
  const path = `/api/mail/mailboxes/${hello.id}/password`;
  const changed = await post(path, { password: 'Another-Pass-9!' });
  assert.equal(changed.ok, true);
  assert.equal(changed.simulated, true);
  assert.ok(Date.parse(changed.passwordChangedAt));
  assert.equal(app.store.snapshot().mail.mailboxes.find((item) => item.id === hello.id).passwordChangedAt, changed.passwordChangedAt);
  const audit = app.store.snapshot().audit.find((event) => event.action === 'mail.mailbox_password');
  assert.deepEqual({ outcome: audit.outcome, target: audit.target }, { outcome: 'success', target: 'hello@example.test' });
  assert.ok(!JSON.stringify(app.store.snapshot()).includes('Another-Pass-9!'));

  for (const weak of ['short-1!A', 'alllowercase-pass-1', 'NoSymbolPassword12', 'Has Space-Pass-1!', 'x'.repeat(200), 42, null]) await post(path, { password: weak }, 400);
  await post(path, {}, 400);
  await post(path, { password: 'Another-Pass-9!', domain: 'evil.test' }, 400);
  await post(`/api/mail/mailboxes/${randomUUID()}/password`, { password: 'Another-Pass-9!' }, 404);
  assert.equal((await request(base, path, { cookie: headers.cookie, 'content-type': 'application/json' }, 'POST', { password: 'Another-Pass-9!' })).status, 403, 'needs the CSRF token');
  assert.equal((await request(base, path, { 'content-type': 'application/json' }, 'POST', { password: 'Another-Pass-9!' })).status, 401);
  const member = await asMember(app, base);
  assert.equal((await request(base, path, member, 'POST', { password: 'Another-Pass-9!' })).status, 403);
  assert.equal((await call('GET', path)).status, 404, 'there is no way to read a password back');
});

test('the sandbox reports simulated delivery states of the Sent folder and a counts-only queue', async (t) => {
  const { app, base, call, post, hello, support } = await sandbox(t);
  const first = await post(`/api/mail/mailboxes/${hello.id}/send`, { to: 'support@example.test, nobody@example.net', subject: 'One', text: 'x' });
  const second = await post(`/api/mail/mailboxes/${hello.id}/send`, { to: 'slow@example.org', cc: 'expire@example.com', subject: 'Two', text: 'y' });
  const delivery = await call('GET', `/api/mail/mailboxes/${hello.id}/delivery`);
  assert.equal(delivery.status, 200, JSON.stringify(delivery.body));
  assert.deepEqual(Object.keys(delivery.body).sort(), ['generatedAt', 'mailbox', 'records', 'simulated', 'since', 'truncated']);
  assert.deepEqual(delivery.body.mailbox, { id: hello.id, address: 'hello@example.test' });
  assert.equal(delivery.body.simulated, true);
  const byRecipient = Object.fromEntries(delivery.body.records.map((item) => [item.recipient, item]));
  assert.deepEqual(Object.keys(byRecipient).sort(), ['expire@example.com', 'nobody@example.net', 'slow@example.org', 'support@example.test']);
  assert.deepEqual([byRecipient['support@example.test'].status, byRecipient['nobody@example.net'].status, byRecipient['slow@example.org'].status, byRecipient['expire@example.com'].status], ['sent', 'bounced', 'deferred', 'expired']);
  assert.equal(byRecipient['support@example.test'].messageId, first.messageId, 'a record correlates with the Sent copy by Message-ID');
  assert.equal(byRecipient['slow@example.org'].messageId, second.messageId);
  for (const record of delivery.body.records) {
    assert.deepEqual(Object.keys(record).sort(), ['dsn', 'messageId', 'queueId', 'reasonCategory', 'reasonText', 'recipient', 'status', 'time']);
    assert.ok(record.reasonText.length <= 200);
  }
  // Another mailbox sees only what it sent itself.
  assert.deepEqual((await call('GET', `/api/mail/mailboxes/${support.id}/delivery`)).body.records, []);
  assert.equal((await call('GET', `/api/mail/mailboxes/${hello.id}/delivery?limit=1`)).body.records.length, 1);
  for (const query of ['limit=0', 'limit=101', 'limit=abc', 'limit=-1', 'hours=0', 'hours=169', 'hours=1e3', 'limit=1.5']) {
    assert.equal((await call('GET', `/api/mail/mailboxes/${hello.id}/delivery?${query}`)).status, 400, query);
  }
  assert.equal((await call('GET', `/api/mail/mailboxes/${randomUUID()}/delivery`)).status, 404);

  const queue = await call('GET', '/api/mail/queue');
  assert.equal(queue.status, 200);
  assert.deepEqual(Object.keys(queue.body).sort(), ['byQueue', 'deferralReasons', 'generatedAt', 'oldestAgeSeconds', 'simulated', 'total', 'truncated']);
  assert.equal(queue.body.total, 1);
  assert.equal(queue.body.byQueue.deferred, 1);
  assert.doesNotMatch(JSON.stringify(queue.body), /@/, 'the queue summary carries no address');

  assert.equal((await request(base, `/api/mail/mailboxes/${hello.id}/delivery`)).status, 401);
  const member = await asMember(app, base);
  assert.equal((await request(base, `/api/mail/mailboxes/${hello.id}/delivery`, member)).status, 403);
  assert.equal((await request(base, '/api/mail/queue', member)).status, 403);
});

test('a project SMTP credential is shown once, written to the project environment and revoked cleanly', async (t) => {
  const { app, base, headers, call, post } = await sandbox(t);
  const view = (await call('GET', '/api/mail')).body;
  assert.equal(view.mail.smtpBlocked, null);
  assert.deepEqual(view.projects, [{ slug: 'shop-api', name: 'Shop API' }, { slug: 'blog', name: 'Blog' }]);
  assert.equal(view.submissionLimits.messageRate, 60);

  const created = await post('/api/mail/smtp-credentials', { projectSlug: 'shop-api', localPart: 'noreply', domain: 'example.test' }, 201);
  assert.match(created.password, /^[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(created.settings, { host: 'mail.example.test', port: 587, security: 'starttls', user: 'smtp-shop-api', from: 'noreply@example.test' });
  assert.deepEqual(created.environmentKeys, ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']);
  assert.deepEqual(Object.keys(created.credential).sort(), ['createdAt', 'from', 'id', 'login', 'projectSlug', 'simulated']);
  const environment = environmentOf(app, 'shop-api');
  assert.match(environment, /^# shop\nNODE_ENV=production\n/, 'the existing document is kept');
  for (const line of ['SMTP_HOST=mail.example.test', 'SMTP_PORT=587', 'SMTP_USER=smtp-shop-api', `SMTP_PASS=${created.password}`, 'SMTP_FROM=noreply@example.test']) assert.ok(environment.split('\n').includes(line), line);
  // Shown once: the state keeps it only inside the encrypted environment, and no listing returns it.
  assert.ok(!JSON.stringify(app.store.snapshot()).includes(created.password));
  assert.ok(!JSON.stringify((await call('GET', '/api/mail')).body).includes(created.password));
  assert.ok(!JSON.stringify(app.store.snapshot().audit).includes(created.password));
  assert.deepEqual((await call('GET', '/api/mail')).body.mail.smtpCredentials.map((item) => [item.projectSlug, item.from, item.login]), [['shop-api', 'noreply@example.test', 'smtp-shop-api']]);

  await post('/api/mail/smtp-credentials', { projectSlug: 'shop-api', localPart: 'other', domain: 'example.test' }, 400);
  for (const body of [
    { projectSlug: 'missing', localPart: 'noreply', domain: 'example.test' },
    { projectSlug: 'blog', localPart: 'noreply', domain: 'elsewhere.test' },
    { projectSlug: 'blog', localPart: 'no reply', domain: 'example.test' },
    { projectSlug: 'blog', localPart: 'a@b', domain: 'example.test' },
    { projectSlug: 'blog', localPart: 'noreply', domain: 'example.test', login: 'smtp-root' },
    { projectSlug: 'blog', localPart: 'noreply\r\nBcc', domain: 'example.test' },
    { projectSlug: ['blog'], localPart: 'noreply', domain: 'example.test' }
  ]) await post('/api/mail/smtp-credentials', body, 400);
  assert.equal((await request(base, '/api/mail/smtp-credentials', { cookie: headers.cookie, 'content-type': 'application/json' }, 'POST', { projectSlug: 'blog', localPart: 'x', domain: 'example.test' })).status, 403);
  const member = await asMember(app, base);
  assert.equal((await request(base, '/api/mail/smtp-credentials', member, 'POST', { projectSlug: 'blog', localPart: 'x', domain: 'example.test' })).status, 403);
  assert.equal((await request(base, `/api/mail/smtp-credentials/${created.credential.id}`, member, 'DELETE', {})).status, 403);

  const revoked = await call('DELETE', `/api/mail/smtp-credentials/${created.credential.id}`);
  assert.deepEqual(revoked.body, { ok: true, environmentCleared: true });
  assert.equal(environmentOf(app, 'shop-api'), '# shop\nNODE_ENV=production\n');
  assert.equal((await call('DELETE', `/api/mail/smtp-credentials/${created.credential.id}`)).status, 404);
  assert.deepEqual(app.store.snapshot().audit.filter((event) => event.action.startsWith('mail.smtp_credential')).map((event) => event.action), ['mail.smtp_credential_revoke', 'mail.smtp_credential_create']);

  // Values the owner changed by hand are not removed by a revoke.
  const again = await post('/api/mail/smtp-credentials', { projectSlug: 'blog', localPart: 'news', domain: 'example.test' }, 201);
  await app.store.update((state) => {
    const project = state.projects.find((item) => item.slug === 'blog');
    project.environment = { keys: ['SMTP_USER'], encryptedContent: vault.encrypt('SMTP_USER=someone-else\n') };
  });
  assert.deepEqual((await call('DELETE', `/api/mail/smtp-credentials/${again.credential.id}`)).body, { ok: true, environmentCleared: false });
  assert.equal(environmentOf(app, 'blog'), 'SMTP_USER=someone-else\n');
});

test('removing a mail domain or deleting the project removes its SMTP credential', async (t) => {
  const { app, call, post } = await sandbox(t);
  await post('/api/mail/domains', { domain: 'brand.test' });
  await post('/api/mail/smtp-credentials', { projectSlug: 'shop-api', localPart: 'noreply', domain: 'brand.test' }, 201);
  await post('/api/mail/smtp-credentials', { projectSlug: 'blog', localPart: 'news', domain: 'example.test' }, 201);
  assert.equal((await call('DELETE', '/api/mail/domains/brand.test')).status, 200);
  assert.deepEqual(app.store.snapshot().mail.submissionCredentials.map((item) => item.projectSlug), ['blog']);
  assert.doesNotMatch(environmentOf(app, 'shop-api'), /SMTP_/);
  assert.equal((await call('DELETE', '/api/projects/blog')).status, 200);
  assert.deepEqual(app.store.snapshot().mail.submissionCredentials, []);
});

// A real host: every change is one typed request to the root helper (a recorder here).
async function host(t, { reply = () => ({ ok: true }), configure = {} } = {}) {
  const requests = [];
  const started = await start({
    mode: 'host', autoSyncPollingEnabled: false, projectRuntimeProbe: async () => ({ state: 'active' }), ...dnsStubs,
    mailHelper: async (socketPath, helperRequest) => { requests.push(structuredClone(helperRequest)); return reply(helperRequest, started.app); },
    mailHelperSocket: '/run/test/helper.sock'
  });
  t.after(() => started.app.close());
  const headers = await login(started.base);
  const mailbox = { id: randomUUID(), domain: 'example.test', localPart: 'hello', displayName: 'Hello', createdAt: new Date().toISOString(), simulated: false };
  await started.app.store.update((state) => {
    state.tools.mail = { ...state.tools.mail, status: 'Installed', simulated: false };
    state.mail = {
      ...state.mail, hostname: 'mail.example.test', hostnameCheck: { status: 'ok' }, outboundMode: 'direct', relay: null, ptr: { status: 'verified' },
      configure: { status: 'configured', at: new Date().toISOString(), configVersion: MAIL_CONFIG_VERSION, inbound: { smtp: true, submission: true, imaps: true }, ...configure },
      domains: [{ domain: 'example.test', dkim: { selectors: [{ selector: 'portal2026', publicKey: 'AAAA', encryptedPrivateKey: null, state: 'active' }] }, dns: {}, createdAt: new Date().toISOString() }],
      mailboxes: [mailbox]
    };
    state.projects.push({ name: 'Shop API', slug: 'shop-api' });
  });
  const call = (method, path, body) => request(started.base, path, method === 'GET' ? { cookie: headers.cookie } : headers, method, method === 'GET' ? undefined : (body ?? {}));
  return { ...started, headers, requests, mailbox, call };
}

test('on a host the password, delivery and queue requests carry only typed fields', async (t) => {
  const hostile = {
    ok: true, address: 'hello@example.test', since: '2026-11-13T00:00:00.000Z', truncated: false,
    records: [
      { queueId: '4F1A2B3C4D', messageId: '<m1@example.test>', time: '2026-11-20T09:15:02.000Z', recipient: 'ana@example.net', status: 'sent', dsn: '2.0.0', reasonCategory: 'delivered', reasonText: '250 2.0.0 OK' },
      { queueId: 'raw log line', time: '2026-11-20T09:15:02.000Z', recipient: 'x@example.net', status: 'sent' },
      { queueId: '4F1A2B3C4E', time: '2026-11-20T09:16:00.000Z', recipient: 'b@example.net', status: 'deferred', dsn: '4.4.1', reasonCategory: 'connection', reasonText: 'other@victim.test said hi' }
    ],
    raw: 'Nov 20 postfix/smtp: to=<secret@example.net>'
  };
  const { requests, mailbox, call } = await host(t, {
    reply: (helperRequest) => {
      if (helperRequest.operation === 'mail-delivery') return hostile;
      if (helperRequest.operation === 'mail-queue-summary') return { ok: true, total: 3, byQueue: { deferred: 2, active: 1 }, oldestAgeSeconds: 3600, deferralReasons: [{ category: 'connection', count: 2 }], truncated: false, sample: 'secret@example.net' };
      return { ok: true };
    }
  });
  const password = await call('POST', `/api/mail/mailboxes/${mailbox.id}/password`, { password: 'Another-Pass-9!' });
  assert.equal(password.status, 200, JSON.stringify(password.body));
  assert.deepEqual(requests.at(-1), { operation: 'set-mailbox-password', domain: 'example.test', localPart: 'hello', password: 'Another-Pass-9!' });
  assert.equal(password.body.simulated, false);

  const delivery = await call('GET', `/api/mail/mailboxes/${mailbox.id}/delivery?limit=20&hours=24`);
  assert.equal(delivery.status, 200, JSON.stringify(delivery.body));
  assert.deepEqual(requests.at(-1), { operation: 'mail-delivery', domain: 'example.test', localPart: 'hello', limit: 20, sinceHours: 24 });
  assert.equal(delivery.body.simulated, false);
  assert.deepEqual(delivery.body.records.map((item) => item.queueId), ['4F1A2B3C4D', '4F1A2B3C4E'], 'a malformed helper record is dropped');
  assert.equal(delivery.body.records[1].reasonText, '<address> said hi');
  assert.doesNotMatch(JSON.stringify(delivery.body), /secret@|raw log/);

  const queue = await call('GET', '/api/mail/queue');
  assert.deepEqual(requests.at(-1), { operation: 'mail-queue-summary' });
  assert.deepEqual({ ...queue.body, generatedAt: undefined }, { generatedAt: undefined, simulated: false, total: 3, byQueue: { active: 1, deferred: 2, hold: 0, incoming: 0, maildrop: 0 }, oldestAgeSeconds: 3600, deferralReasons: [{ category: 'connection', count: 2 }], truncated: false });
});

test('on a host a refused password change is reported and audited without the password', async (t) => {
  const { app, mailbox, call } = await host(t, { reply: () => ({ ok: false, error: 'Mailbox was not found.', code: 'not_found' }) });
  const refused = await call('POST', `/api/mail/mailboxes/${mailbox.id}/password`, { password: 'Another-Pass-9!' });
  assert.equal(refused.status, 404);
  assert.deepEqual(app.store.snapshot().audit.filter((event) => event.action === 'mail.mailbox_password').map((event) => event.outcome), ['failure']);
  assert.ok(!JSON.stringify(app.store.snapshot()).includes('Another-Pass-9!'));
});

test('on a host the credential is stored before the helper is asked, and removed again if it refuses', async (t) => {
  let seenInState = null;
  const { app, requests, call } = await host(t, {
    reply: (helperRequest, application) => {
      if (helperRequest.operation === 'create-submission-credential') {
        seenInState = application.store.snapshot().mail.submissionCredentials.map((item) => ({ projectSlug: item.projectSlug, login: item.login, from: item.from, domain: item.domain, localPart: item.localPart }));
        return { ok: false, error: 'Apply the mail configuration again before creating project SMTP credentials.' };
      }
      return { ok: true };
    }
  });
  const refused = await call('POST', '/api/mail/smtp-credentials', { projectSlug: 'shop-api', localPart: 'noreply', domain: 'example.test' });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /Apply the mail configuration again/);
  assert.deepEqual(seenInState, [{ projectSlug: 'shop-api', login: 'smtp-shop-api', from: 'noreply@example.test', domain: 'example.test', localPart: 'noreply' }]);
  // The helper got the password and the project only: the From address comes from the state.
  assert.deepEqual(Object.keys(requests.at(-1)).sort(), ['operation', 'password', 'projectSlug']);
  assert.deepEqual(app.store.snapshot().mail.submissionCredentials, []);
  assert.equal(app.store.snapshot().projects.find((item) => item.slug === 'shop-api').environment, undefined);
});

test('on a host a credential is created and revoked through the helper', async (t) => {
  const { app, requests, call } = await host(t);
  const created = await call('POST', '/api/mail/smtp-credentials', { projectSlug: 'shop-api', localPart: 'noreply', domain: 'example.test' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(requests.at(-1), { operation: 'create-submission-credential', projectSlug: 'shop-api', password: created.body.password });
  assert.equal(created.body.credential.simulated, false);
  assert.match(environmentOf(app, 'shop-api'), /^SMTP_HOST=mail\.example\.test$/m);
  const revoked = await call('DELETE', `/api/mail/smtp-credentials/${created.body.credential.id}`);
  assert.equal(revoked.status, 200);
  assert.deepEqual(requests.at(-1), { operation: 'revoke-submission-credential', projectSlug: 'shop-api' });
  assert.doesNotMatch(environmentOf(app, 'shop-api'), /SMTP_/);
});

test('project SMTP waits for the current configuration and an open submission port', async (t) => {
  const outdated = await host(t, { configure: { configVersion: undefined } });
  const view = (await outdated.call('GET', '/api/mail')).body;
  assert.equal(view.mail.configCurrent, false);
  assert.match(view.mail.smtpBlocked, /Apply the mail configuration again/);
  assert.equal((await outdated.call('POST', '/api/mail/smtp-credentials', { projectSlug: 'shop-api', localPart: 'noreply', domain: 'example.test' })).status, 400);
  assert.equal(outdated.requests.length, 0);

  const closed = await host(t, { configure: { inbound: { smtp: true, submission: false, imaps: true } } });
  assert.match((await closed.call('GET', '/api/mail')).body.mail.smtpBlocked, /587/);
  assert.equal((await closed.call('POST', '/api/mail/smtp-credentials', { projectSlug: 'shop-api', localPart: 'noreply', domain: 'example.test' })).status, 400);

  // Applying the configuration records the version and the listeners the helper really opened.
  const applied = await host(t, { configure: { configVersion: undefined }, reply: (helperRequest) => (helperRequest.operation === 'configure-mail' ? { ok: true, inbound: { smtp: true, submission: true, imaps: false }, configVersion: MAIL_CONFIG_VERSION } : { ok: true }) });
  await applied.app.store.update((state) => { state.mail.readiness = { checkedAt: new Date().toISOString(), outbound: { ports: [25, 587, 2525].map((port) => ({ port, status: 'open' })) }, inbound: { ports: [25, 587, 993].map((port) => ({ port, status: 'allowed' })) } }; });
  const configured = await applied.call('POST', '/api/mail/configure', { confirm: true });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  assert.deepEqual({ version: configured.body.mail.configure.configVersion, inbound: configured.body.mail.configure.inbound, current: configured.body.mail.configCurrent, blocked: configured.body.mail.smtpBlocked }, { version: MAIL_CONFIG_VERSION, inbound: { smtp: true, submission: true, imaps: false }, current: true, blocked: null });
});
