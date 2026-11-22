import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DELIVERY_LIMIT_MAX, REASON_TEXT_MAX, classifyDeliveryReason, createDeliveryCollector, createQueueSummary,
  normalizeDeliveryReport, normalizeQueueSummary, parseLogTime, parsePostfixLogLine, sanitizeReasonText
} from '../scripts/mail-delivery-log.mjs';

const T0 = Date.parse('2026-11-20T09:15:00Z') / 1000;
// journalctl -o short-unix, as the helper reads it.
const at = (seconds, rest) => `${(T0 + seconds).toFixed(6)} mail ${rest}`;

// Realistic Postfix 3.8 lines: two messages from hello@, one from another mailbox
// on the same host, a reused queue ID, a greylisting retry, a bounce and an expiry.
const LOG = [
  at(0, 'postfix/cleanup[2211]: 4F1A2B3C4D: message-id=<m1@example.test>'),
  at(0, 'postfix/qmgr[1100]: 4F1A2B3C4D: from=<hello@example.test>, size=1532, nrcpt=3 (queue active)'),
  at(2, 'postfix/smtp[2213]: 4F1A2B3C4D: to=<ana@example.net>, relay=mx.example.net[203.0.113.5]:25, delay=1.2, delays=0.1/0/0.6/0.5, dsn=2.0.0, status=sent (250 2.0.0 OK 1700000000 x1si123 - gsmtp)'),
  at(3, 'postfix/smtp[2214]: 4F1A2B3C4D: to=<bo@example.org>, relay=mx.example.org[198.51.100.7]:25, delay=3, delays=0.1/0/1/2, dsn=4.7.1, status=deferred (host mx.example.org[198.51.100.7] said: 451 4.7.1 Greylisted, please try again later (in reply to RCPT TO command))'),
  at(4, 'postfix/smtp[2215]: 4F1A2B3C4D: to=<nobody@example.com>, relay=mx.example.com[192.0.2.1]:25, delay=4, delays=0.1/0/2/2, dsn=5.1.1, status=bounced (host mx.example.com[192.0.2.1] said: 550 5.1.1 <nobody@example.com>: Recipient address rejected: User unknown in virtual mailbox table (in reply to RCPT TO command))'),
  at(5, 'postfix/bounce[2216]: 4F1A2B3C4D: sender non-delivery notification: 5B2C3D4E5F'),
  // Another mailbox's message, interleaved: it must never appear in hello@'s report.
  at(6, 'postfix/cleanup[2211]: 6C3D4E5F60: message-id=<other@example.test>'),
  at(6, 'postfix/qmgr[1100]: 6C3D4E5F60: from=<support@example.test>, size=900, nrcpt=1 (queue active)'),
  at(7, 'postfix/smtp[2217]: 6C3D4E5F60: to=<secret-customer@example.net>, relay=mx.example.net[203.0.113.5]:25, delay=1, delays=0/0/0.5/0.5, dsn=2.0.0, status=sent (250 2.0.0 OK)'),
  at(8, 'postfix/qmgr[1100]: 6C3D4E5F60: removed'),
  // The greylisted recipient is delivered on retry: its record becomes sent.
  at(600, 'postfix/smtp[2300]: 4F1A2B3C4D: to=<bo@example.org>, relay=mx.example.org[198.51.100.7]:25, delay=600, delays=597/0/1/2, dsn=2.0.0, status=sent (250 2.0.0 Ok: queued as ABC)'),
  at(601, 'postfix/qmgr[1100]: 4F1A2B3C4D: removed'),
  // The queue ID is reused by support@: the old sender must not carry over.
  at(700, 'postfix/cleanup[2400]: 4F1A2B3C4D: message-id=<reuse@example.test>'),
  at(700, 'postfix/qmgr[1100]: 4F1A2B3C4D: from=<support@example.test>, size=100, nrcpt=1 (queue active)'),
  at(701, 'postfix/smtp[2401]: 4F1A2B3C4D: to=<private@example.net>, relay=none, delay=1, delays=0/0/1/0, dsn=4.4.1, status=deferred (connect to mx.example.net[203.0.113.5]:25: Connection timed out)'),
  // hello@ again: a 421 rate limit, then the message expires.
  at(800, 'postfix/cleanup[2500]: 7D4E5F6071: message-id=<m2@example.test>'),
  at(800, 'postfix/qmgr[1100]: 7D4E5F6071: from=<Hello@Example.test>, size=2000, nrcpt=1 (queue active)'),
  at(801, 'postfix/smtp[2501]: 7D4E5F6071: to=<cy@example.biz>, orig_to=<alias@example.biz>, relay=mx.example.biz[192.0.2.9]:25, delay=1, delays=0/0/0.5/0.5, dsn=4.7.0, status=deferred (host mx.example.biz[192.0.2.9] said: 421 4.7.0 Too many connections from your IP, try again later (in reply to end of DATA command))'),
  at(900, 'postfix/qmgr[1100]: 7D4E5F6071: from=<hello@example.test>, status=expired, returned to sender'),
  at(901, 'postfix/qmgr[1100]: 7D4E5F6071: removed'),
  // Local delivery through Dovecot LMTP, ISO time stamp from rsyslog.
  '2026-11-20T09:31:00.123456+00:00 mail postfix/cleanup[2600]: 8E5F607182: message-id=<m3@example.test>',
  '2026-11-20T09:31:00.200000+00:00 mail postfix/qmgr[1100]: 8E5F607182: from=<hello@example.test>, size=700, nrcpt=1 (queue active)',
  '2026-11-20T09:31:01+0000 mail postfix/lmtp[2601]: 8E5F607182: to=<support@example.test>, relay=mail.example.test[private/dovecot-lmtp], delay=0.1, delays=0/0/0/0.1, dsn=2.0.0, status=sent (250 2.0.0 <support@example.test> 2kR3Fq Saved)'
];

function collect(lines, options = {}) {
  const collector = createDeliveryCollector({ sender: 'hello@example.test', since: 0, limit: 50, now: (T0 + 3600) * 1000, ...options });
  for (const line of lines) collector.push(line);
  return collector.result();
}

test('a delivery report lists only the asking mailbox, newest first, with the latest state per recipient', () => {
  const { records, truncated } = collect(LOG);
  assert.equal(truncated, false);
  assert.deepEqual(records.map((item) => [item.queueId, item.recipient, item.status, item.dsn, item.reasonCategory]), [
    ['8E5F607182', 'support@example.test', 'sent', '2.0.0', 'delivered'],
    ['7D4E5F6071', 'cy@example.biz', 'expired', '4.7.0', 'rate-limited'],
    ['4F1A2B3C4D', 'bo@example.org', 'sent', '2.0.0', 'delivered'],
    ['4F1A2B3C4D', 'nobody@example.com', 'bounced', '5.1.1', 'recipient-unknown'],
    ['4F1A2B3C4D', 'ana@example.net', 'sent', '2.0.0', 'delivered']
  ]);
  assert.equal(records[0].messageId, '<m3@example.test>');
  assert.equal(records[0].time, '2026-11-20T09:31:01.000Z');
  assert.equal(records[2].messageId, '<m1@example.test>');
  assert.match(records[3].reasonText, /^host mx\.example\.com\[192\.0\.2\.1\] said: 550 5\.1\.1 <nobody@example\.com>: Recipient address rejected/);
  const text = JSON.stringify(records);
  for (const leaked of ['secret-customer', 'private@example.net', 'other@example.test', 'reuse@example.test', 'support@example.test>: from']) assert.ok(!text.includes(leaked), `report must not contain ${leaked}`);
});

test('deferred, bounced and expired states come from the matching Postfix lines', () => {
  const lines = [
    at(0, 'postfix/qmgr[1]: A1B2C3D4E5: from=<hello@example.test>, size=1, nrcpt=4 (queue active)'),
    at(1, 'postfix/smtp[2]: A1B2C3D4E5: to=<a@example.net>, relay=none, delay=1, delays=0/0/1/0, dsn=4.4.1, status=deferred (connect to mx.example.net[203.0.113.5]:25: Connection timed out)'),
    at(2, 'postfix/smtp[2]: A1B2C3D4E5: to=<b@example.net>, relay=mx.example.net[203.0.113.5]:25, delay=1, delays=0/0/1/0, dsn=4.2.2, status=deferred (host mx.example.net[203.0.113.5] said: 452 4.2.2 Mailbox full (in reply to RCPT TO command))'),
    at(3, 'postfix/smtp[2]: A1B2C3D4E5: to=<c@example.net>, relay=mx.example.net[203.0.113.5]:25, delay=1, delays=0/0/1/0, dsn=5.7.1, status=bounced (host mx.example.net[203.0.113.5] said: 550 5.7.1 Message rejected as spam by Content Filtering (in reply to end of DATA command))'),
    at(4, 'postfix/smtp[2]: A1B2C3D4E5: to=<d@example.nowhere>, relay=none, delay=1, delays=0/0/1/0, dsn=5.4.4, status=bounced (Host or domain name not found. Name service error for name=example.nowhere type=A: Host not found)'),
    at(5, 'postfix/qmgr[1]: B1B2C3D4E5: from=<hello@example.test>, status=expired, returned to sender')
  ];
  const records = collect(lines).records;
  const byRecipient = Object.fromEntries(records.map((item) => [item.recipient ?? '(none)', item]));
  assert.equal(byRecipient['a@example.net'].reasonCategory, 'connection');
  assert.equal(byRecipient['b@example.net'].reasonCategory, 'mailbox-full');
  assert.equal(byRecipient['c@example.net'].reasonCategory, 'spam');
  assert.equal(byRecipient['d@example.nowhere'].reasonCategory, 'dns');
  // An expiry with no recipient line in the window still reports the message.
  assert.deepEqual({ ...byRecipient['(none)'], time: undefined }, { queueId: 'B1B2C3D4E5', messageId: null, time: undefined, recipient: null, status: 'expired', dsn: null, reasonCategory: 'expired', reasonText: 'The message stayed in the queue too long and was returned to the sender.' });
});

test('the report window, the record limit and the line cap are enforced', () => {
  const since = (T0 + 500) * 1000;
  assert.deepEqual(collect(LOG, { since }).records.map((item) => item.queueId), ['8E5F607182', '7D4E5F6071'], 'a delivery whose sender line is outside the window is not guessed');
  assert.equal(collect(LOG, { limit: 2 }).records.length, 2);
  const many = [at(0, 'postfix/qmgr[1]: C1C2C3C4C5: from=<hello@example.test>, size=1, nrcpt=5000 (queue active)')];
  for (let index = 0; index < 5000; index += 1) many.push(at(1, `postfix/smtp[2]: C1C2C3C4C5: to=<u${index}@example.net>, relay=x[192.0.2.1]:25, delay=1, delays=0/0/0/1, dsn=2.0.0, status=sent (250 ok)`));
  const result = collect(many, { limit: DELIVERY_LIMIT_MAX });
  assert.equal(result.records.length, DELIVERY_LIMIT_MAX);
  assert.throws(() => createDeliveryCollector({ sender: 'not an address' }), /Sender/);
});

test('hostile and malformed log lines are ignored or neutralised', () => {
  const hostile = [
    at(0, 'postfix/qmgr[1]: D1D2D3D4D5: from=<hello@example.test>, size=1, nrcpt=1 (queue active)'),
    // A remote server echoes other addresses and control characters into its reply.
    at(1, `postfix/smtp[2]: D1D2D3D4D5: to=<x@example.net>, relay=mx[192.0.2.1]:25, delay=1, delays=0/0/0/1, dsn=5.0.0, status=bounced (host mx said: 550 contact ceo@victim.example or admin@example.org\u001b[31m ${'A'.repeat(500)} (in reply to RCPT TO command))`),
    // A forged line without a queue ID, a line over the length cap, and junk.
    at(2, 'postfix/smtp[2]: to=<y@example.net>, status=sent (250 ok)'),
    at(3, `postfix/smtp[2]: D1D2D3D4D5: to=<z@example.net>, status=sent (${'x'.repeat(5000)})`),
    'garbage', '', '0 x postfix/smtp[1]: ../../etc: to=<a@b.c>, status=sent',
    at(4, 'postfix/smtp[2]: D1D2D3D4D5: to=<bad address@example.net>, relay=x, dsn=2.0.0, status=sent (250 ok)')
  ];
  const records = collect(hostile).records;
  assert.equal(records.length, 2);
  const bounced = records.find((item) => item.status === 'bounced');
  assert.ok(bounced.reasonText.length <= REASON_TEXT_MAX);
  assert.doesNotMatch(bounced.reasonText, /ceo@victim|admin@example\.org|\u001b/);
  assert.match(bounced.reasonText, /<address>/);
  assert.equal(records.find((item) => item.status === 'sent').recipient, null, 'an unparseable recipient is not passed on');
  assert.equal(parsePostfixLogLine('x'.repeat(5000)), null);
  assert.equal(parsePostfixLogLine(42), null);
});

test('log times: short-unix, ISO with or without a colon, and traditional syslog', () => {
  assert.equal(parseLogTime('1700000000.500000'), 1700000000500);
  assert.equal(parseLogTime('2026-11-20T16:15:02+07:00'), Date.parse('2026-11-20T09:15:02Z'));
  assert.equal(parseLogTime('2026-11-20T16:15:02.250+0700'), Date.parse('2026-11-20T09:15:02.250Z'));
  const now = new Date(2026, 0, 2, 12).getTime();
  assert.equal(new Date(parseLogTime('Dec 31 23:59:00', now)).getFullYear(), 2025, 'a date ahead of now belongs to last year');
  assert.equal(new Date(parseLogTime('Jan  2 08:00:00', now)).getDate(), 2);
  assert.ok(Number.isNaN(parseLogTime('yesterday')));
});

test('reason categories and sanitised text', () => {
  assert.equal(classifyDeliveryReason({ status: 'sent', dsn: '2.0.0', text: '' }), 'delivered');
  assert.equal(classifyDeliveryReason({ status: 'deferred', dsn: '4.7.1', text: '451 4.7.1 Greylisting in action' }), 'greylisted');
  assert.equal(classifyDeliveryReason({ status: 'bounced', dsn: '5.7.26', text: '550 5.7.26 Unauthenticated email is not accepted due to DMARC policy' }), 'policy');
  assert.equal(classifyDeliveryReason({ status: 'bounced', dsn: '5.3.4', text: '552 5.3.4 Message size exceeds fixed limit' }), 'message-too-large');
  assert.equal(classifyDeliveryReason({ status: 'deferred', dsn: '4.7.5', text: 'TLS is required, but was not offered by host' }), 'policy');
  assert.equal(classifyDeliveryReason({ status: 'deferred', dsn: '4.0.0', text: 'Cannot start TLS: handshake failure' }), 'tls');
  assert.equal(classifyDeliveryReason({ status: 'expired', dsn: null, text: '' }), 'expired');
  assert.equal(classifyDeliveryReason({ status: 'deferred', dsn: '4.0.0', text: 'something odd' }), 'other');
  assert.equal(sanitizeReasonText('a\r\nb\u0000c   d'), 'a b c d');
  assert.equal(sanitizeReasonText('to me@x.test and you@y.test', ['me@x.test']), 'to me@x.test and <address>');
  assert.equal([...sanitizeReasonText('ก'.repeat(400))].length, REASON_TEXT_MAX);
});

test('the queue summary returns counts and reason categories, never addresses', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  const summary = createQueueSummary({ now });
  const message = (queue, arrival, reasons) => JSON.stringify({ queue_name: queue, queue_id: 'ABCDEF1234', arrival_time: arrival, message_size: 100, forced_expire: false, sender: 'hello@example.test', recipients: reasons.map((reason, index) => ({ address: `secret${index}@example.net`, delay_reason: reason })) });
  summary.push(message('deferred', now / 1000 - 7200, ['connect to mx.example.net[203.0.113.5]:25: Connection timed out', 'host x said: 451 4.7.1 Greylisted']));
  summary.push(message('deferred', now / 1000 - 600, ['connect to mx.example.org[198.51.100.7]:25: Connection refused']));
  summary.push(message('active', now / 1000 - 5, [undefined]));
  summary.push('not json');
  summary.push('');
  summary.push(JSON.stringify({ queue_name: 'evil', arrival_time: 'soon' }));
  const result = summary.result();
  assert.deepEqual(result, {
    total: 5,
    byQueue: { active: 1, deferred: 2, hold: 0, incoming: 0, maildrop: 0 },
    oldestAgeSeconds: 7200,
    deferralReasons: [{ category: 'connection', count: 2 }, { category: 'greylisted', count: 1 }],
    truncated: true
  });
  assert.doesNotMatch(JSON.stringify(result), /@/);
});

test('the Portal re-checks a helper answer before it reaches the browser', () => {
  const report = normalizeDeliveryReport({
    truncated: true,
    records: [
      { queueId: 'A1B2C3D4E5', messageId: '<ok@example.test>', time: '2026-11-20T09:15:00Z', recipient: 'A@Example.net', status: 'sent', dsn: '2.0.0', reasonCategory: 'delivered', reasonText: '250 ok' },
      { queueId: '../etc', time: '2026-11-20T09:15:00Z', recipient: 'a@example.net', status: 'sent' },
      { queueId: 'A1B2C3D4E5', time: 'never', recipient: 'a@example.net', status: 'sent' },
      { queueId: 'A1B2C3D4E5', time: '2026-11-20T09:15:00Z', recipient: 'a@example.net', status: 'lost' },
      { queueId: 'A1B2C3D4E5', time: '2026-11-20T09:15:00Z', recipient: '<script>', status: 'sent' },
      { queueId: 'A1B2C3D4E5', messageId: '<a b>', time: '2026-11-20T09:15:00Z', recipient: null, status: 'expired', dsn: '9.9.9', reasonCategory: 'made-up', reasonText: 'x\u0007'.repeat(300) + 'leak@example.org' },
      null, 'string'
    ]
  });
  assert.equal(report.truncated, true);
  assert.equal(report.records.length, 2);
  assert.equal(report.records[0].recipient, 'a@example.net');
  assert.deepEqual({ messageId: report.records[1].messageId, dsn: report.records[1].dsn, reasonCategory: report.records[1].reasonCategory }, { messageId: null, dsn: null, reasonCategory: 'other' });
  assert.ok(report.records[1].reasonText.length <= REASON_TEXT_MAX);
  assert.equal(normalizeDeliveryReport({ records: Array.from({ length: 500 }, () => ({ queueId: 'A1B2C3D4E5', time: '2026-11-20T09:15:00Z', recipient: null, status: 'expired' })) }).records.length, DELIVERY_LIMIT_MAX);
  assert.deepEqual(normalizeQueueSummary({ total: -1, byQueue: { deferred: 2.5, active: 3, sender: 9 }, oldestAgeSeconds: 'old', deferralReasons: [{ category: 'connection', count: 2 }, { category: 'x@y.z', count: 1 }] }), {
    total: 0, byQueue: { active: 3, deferred: 0, hold: 0, incoming: 0, maildrop: 0 }, oldestAgeSeconds: null, deferralReasons: [{ category: 'connection', count: 2 }], truncated: false
  });
});

test('the helper reads delivery and queue state with fixed arguments and typed requests only', async () => {
  const { readFile } = await import('node:fs/promises');
  const helper = await readFile(new URL('../scripts/hostmgr-deploy-helper.mjs', import.meta.url), 'utf8');
  const body = (name) => helper.match(new RegExp(`async function ${name}\\(request\\) \\{[\\s\\S]*?\\n\\}`))?.[0] ?? '';
  for (const [name, fields] of [
    ['setMailboxPassword', "['operation', 'domain', 'localPart', 'password']"],
    ['mailDeliveryReport', "['operation', 'domain', 'localPart', 'limit', 'sinceHours']"],
    ['mailQueueSummary', "['operation']"],
    ['createSubmissionCredential', "['operation', 'projectSlug', 'password']"],
    ['revokeSubmissionCredential', "['operation', 'projectSlug']"]
  ]) assert.ok(body(name).includes(`assertOnlyFields(request, ${fields})`), `${name} rejects unknown fields`);
  const delivery = body('mailDeliveryReport');
  // Only a mailbox the Portal created, and its own address as the only sender filter.
  assert.match(delivery, /return mailboxOperation\(request, async \(\) => \{/);
  assert.match(delivery, /createDeliveryCollector\(\{ sender, since, limit, now \}\)/);
  const journal = delivery.match(/const args = (\[.*\]);/)?.[1] ?? '';
  assert.doesNotMatch(journal, /request\./, 'no request field reaches the journalctl arguments');
  assert.match(journal, /--since=@\$\{Math\.floor\(since \/ 1000\)\}/);
  assert.match(journal, /--lines=\$\{DELIVERY_LOG_LINES_MAX\}/);
  assert.match(delivery, /return \{ address: sender, since: new Date\(since\)\.toISOString\(\), records: report\.records, truncated: report\.truncated \};/);
  assert.match(body('mailQueueSummary'), /streamLines\('\/usr\/sbin\/postqueue', \['-j'\]/);
  assert.match(body('mailQueueSummary'), /return summary\.result\(\);/);
  // The From address and login come from the stored state, never from the request.
  const create = body('createSubmissionCredential');
  assert.match(create, /mail\.submissionCredentials\.find\(\(item\) => item\.projectSlug === projectSlug\)/);
  assert.match(create, /await assertSubmissionConfigurationActive\(\);/);
  assert.doesNotMatch(create, /request\.(?:from|login|localPart|domain)/);
  assert.match(body('revokeSubmissionCredential'), /const login = submissionLogin\(request\.projectSlug\);/);
});
