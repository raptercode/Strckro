import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMailPortPlan, renderDovecotConfiguration, renderOpenDkimConfiguration, renderPostfixMain, renderPostfixMaster } from '../scripts/mail-host-config.mjs';

const outbound = { ports: [{ port: 25, status: 'open' }, { port: 587, status: 'open' }, { port: 2525, status: 'blocked' }] };

test('mail port plan only enables locally permitted inbound services', () => {
  const plan = buildMailPortPlan({
    outboundMode: 'relay-587',
    outbound,
    inbound: { externalReachability: 'unverified', ports: [{ port: 25, status: 'blocked' }, { port: 587, status: 'allowed' }, { port: 993, status: 'unknown' }] }
  });
  assert.equal(plan.outboundPort, 587);
  assert.deepEqual(plan.inbound, { smtp: false, submission: true, imaps: false });
  assert.deepEqual(plan.disabledPorts, [25, 993]);
  assert.throws(() => buildMailPortPlan({ outboundMode: 'direct', outbound: { ports: [{ port: 25, status: 'blocked' }] }, inbound: { ports: [] } }), /not confirmed open/);
});

test('mail templates never create SMTP or IMAPS listeners for blocked or unknown ports', () => {
  const plan = buildMailPortPlan({
    outboundMode: 'relay-587',
    outbound,
    inbound: { ports: [{ port: 25, status: 'blocked' }, { port: 587, status: 'unknown' }, { port: 993, status: 'blocked' }] }
  });
  const main = renderPostfixMain({ hostname: 'mail.example.test', domains: ['example.test'], outboundMode: 'relay-587', relay: { host: 'smtp.example.test', port: 587 }, plan });
  assert.match(main, /inet_interfaces = loopback-only/);
  assert.match(main, /reject_unauth_destination/);
  assert.doesNotMatch(renderPostfixMaster(plan), /^smtp\s+inet/m);
  assert.doesNotMatch(renderPostfixMaster(plan), /^submission\s+inet/m);
  assert.match(renderPostfixMaster(plan), /^127\.0\.0\.1:25 inet/m);
  assert.match(renderDovecotConfiguration({ plan }), /listen = 127\.0\.0\.1/);
});

test('OpenDKIM configuration matches the Ubuntu forking service contract', () => {
  const configuration = renderOpenDkimConfiguration();
  assert.match(configuration, /^UserID\s+opendkim$/m);
  assert.match(configuration, /^PidFile\s+\/run\/opendkim\/opendkim\.pid$/m);
});

test('submission carries the rate limits, sign-in and sender checks; port 25 keeps Postfix defaults', async () => {
  const { MAIL_CONFIG_MARKER, MAIL_SUBMISSION_LIMITS } = await import('../scripts/mail-host-config.mjs');
  const plan = buildMailPortPlan({ outboundMode: 'direct', outbound, inbound: { ports: [25, 587, 993].map((port) => ({ port, status: 'allowed' })) } });
  const master = renderPostfixMaster(plan);
  const main = renderPostfixMain({ hostname: 'mail.example.test', domains: ['example.test'], outboundMode: 'direct', plan });
  const services = master.split(/\n(?=\S)/);
  const submission = services.find((block) => block.startsWith('submission inet'));
  const smtp = services.find((block) => block.startsWith('smtp      inet'));
  for (const [name, value] of [
    ['smtpd_client_connection_count_limit', MAIL_SUBMISSION_LIMITS.connectionCount],
    ['smtpd_client_connection_rate_limit', MAIL_SUBMISSION_LIMITS.connectionRate],
    ['smtpd_client_auth_rate_limit', MAIL_SUBMISSION_LIMITS.authRate],
    ['smtpd_client_message_rate_limit', MAIL_SUBMISSION_LIMITS.messageRate],
    ['smtpd_client_recipient_rate_limit', MAIL_SUBMISSION_LIMITS.recipientRate],
    ['smtpd_recipient_limit', MAIL_SUBMISSION_LIMITS.recipientsPerMessage]
  ]) assert.match(submission, new RegExp(`^  -o ${name}=${value}$`, 'm'));
  assert.match(submission, /^  -o smtpd_client_event_limit_exceptions=$/m, 'loopback submission is limited too');
  assert.match(submission, /^  -o smtpd_sasl_auth_enable=yes$/m);
  assert.match(submission, /^  -o smtpd_sender_restrictions=reject_authenticated_sender_login_mismatch$/m);
  assert.match(submission, /^  -o smtpd_tls_auth_only=yes$/m);
  // Inbound MX: no anvil limits and no sign-in, so nothing can authenticate around the limits.
  assert.equal(smtp.trim(), 'smtp      inet  n       -       y       -       -       smtpd');
  assert.doesNotMatch(main, /smtpd_client_\w+_limit|smtpd_recipient_limit/);
  assert.match(main, /^smtpd_sasl_auth_enable = no$/m);
  assert.match(main, /^smtpd_sender_login_maps = hash:\/etc\/postfix\/hostmgr\/sender-logins$/m);
  assert.match(main, /^anvil_rate_time_unit = 60s$/m);
  for (const text of [main, master, renderDovecotConfiguration({ plan })]) assert.ok(text.split('\n').includes(MAIL_CONFIG_MARKER));
  // Every -o line stays one token: no whitespace inside a value.
  for (const line of master.split('\n').filter((item) => item.startsWith('  -o '))) assert.match(line, /^ {2}-o [a-z_]+=\S*$/);
});

test('project logins can authenticate for SMTP but have no user database entry', () => {
  const plan = buildMailPortPlan({ outboundMode: 'direct', outbound, inbound: { ports: [25, 587, 993].map((port) => ({ port, status: 'allowed' })) } });
  const dovecot = renderDovecotConfiguration({ plan, vmail: { uid: 5000, gid: 5000 } });
  const passdbs = [...dovecot.matchAll(/passdb \{\n {2}driver = passwd-file\n {2}args = scheme=SHA512-CRYPT username_format=%u (\S+)\n\}/g)].map((match) => match[1]);
  assert.deepEqual(passdbs, ['/etc/hostmgr/mail/users', '/etc/hostmgr/mail/submission-users'], 'mailboxes are looked up first');
  assert.match(dovecot, /userdb \{\n {2}driver = passwd-file\n {2}args = username_format=%u \/etc\/hostmgr\/mail\/users\n/);
  assert.doesNotMatch(dovecot, /userdb[^}]*submission-users/);
  assert.doesNotMatch(dovecot, /driver = static/);
});

test('helper request validation for the new mail operations', async () => {
  const { MailRequestError, assertOnlyFields, boundedInteger, renderSenderLoginMap, replacePasswdHash, submissionLogin, validDovecotHash, validateMailProjectSlug, validateMailboxPassword } = await import('../scripts/mail-host-config.mjs');
  assert.doesNotThrow(() => assertOnlyFields({ operation: 'x', domain: 'a' }, ['operation', 'domain']));
  for (const hostile of [{ operation: 'x', path: '/etc/shadow' }, null, [], 'operation']) assert.throws(() => assertOnlyFields(hostile, ['operation']), MailRequestError);
  assert.equal(validateMailboxPassword('Twelve-chars-ok'), 'Twelve-chars-ok');
  for (const bad of ['short', 'x'.repeat(513), 'line\nbreak-password', 'nul\0password-x', 42, null]) assert.throws(() => validateMailboxPassword(bad), /Mailbox password is invalid/);
  assert.equal(submissionLogin('shop-api'), 'smtp-shop-api');
  for (const bad of ['Shop', '../etc', 'a b', '1abc', '', 'x'.repeat(64), 'a\nb', undefined]) assert.throws(() => validateMailProjectSlug(bad), /Project is invalid/);
  assert.equal(boundedInteger(undefined, { min: 1, max: 100, fallback: 50 }), 50);
  assert.equal(boundedInteger(7, { min: 1, max: 100, fallback: 50 }), 7);
  for (const bad of [0, 101, 1.5, '7', -1, Number.NaN]) assert.throws(() => boundedInteger(bad, { min: 1, max: 100, fallback: 50 }), /out of range/);

  const hash = '{SHA512-CRYPT}$6$abcdefgh$' + 'A'.repeat(86);
  assert.equal(validDovecotHash(hash), true);
  for (const bad of ['{PLAIN}secret', `${hash}:extra`, `${hash}\nevil:x`, '{SHA512-CRYPT}$6$ a', '']) assert.equal(validDovecotHash(bad), false);
  const users = 'hello@example.test:{SHA512-CRYPT}$6$old$old:5000:5000::/var/vmail/example.test/hello::\nsupport@example.test:{SHA512-CRYPT}$6$keep$keep:5000:5000::/var/vmail/example.test/support::\n';
  assert.equal(replacePasswdHash(users, 'hello@example.test', hash), `hello@example.test:${hash}:5000:5000::/var/vmail/example.test/hello::\nsupport@example.test:{SHA512-CRYPT}$6$keep$keep:5000:5000::/var/vmail/example.test/support::\n`);
  assert.equal(replacePasswdHash(users, 'nobody@example.test', hash), null);
  assert.equal(replacePasswdHash(users, 'hello', hash), null, 'a prefix is not an address');
  assert.throws(() => replacePasswdHash(users, 'hello@example.test', 'bad:hash'), /could not be secured/);

  assert.equal(renderSenderLoginMap({
    mailboxes: ['support@example.test', 'hello@example.test'],
    credentials: [{ from: 'noreply@example.test', login: 'smtp-shop' }, { from: 'hello@example.test', login: 'smtp-blog' }]
  }), 'hello@example.test hello@example.test,smtp-blog\nnoreply@example.test smtp-shop\nsupport@example.test support@example.test\n');
  assert.equal(renderSenderLoginMap({}), '');
});
