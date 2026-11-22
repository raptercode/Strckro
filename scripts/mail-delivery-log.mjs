// Delivery state of sent mail, read from Postfix log lines, and a queue summary
// read from `postqueue -j`. Pure functions: the root helper feeds them lines and
// returns only the bounded, parsed result. A mail log names every mailbox's
// correspondents, so no raw line ever leaves this module, and a delivery report
// holds only messages whose envelope sender is the one mailbox asked about.

export const DELIVERY_STATUSES = Object.freeze(['sent', 'deferred', 'bounced', 'expired']);
export const REASON_CATEGORIES = Object.freeze([
  'delivered', 'recipient-unknown', 'mailbox-full', 'policy', 'spam', 'greylisted', 'rate-limited',
  'connection', 'dns', 'tls', 'message-too-large', 'expired', 'other'
]);
export const QUEUE_NAMES = Object.freeze(['active', 'deferred', 'hold', 'incoming', 'maildrop']);
export const DELIVERY_LIMIT_DEFAULT = 50;
export const DELIVERY_LIMIT_MAX = 100;
export const DELIVERY_HOURS_DEFAULT = 168;
export const DELIVERY_HOURS_MAX = 168;
// The helper asks journald for at most this many lines; a busier host shows a shorter window.
export const DELIVERY_LOG_LINES_MAX = 50_000;
export const REASON_TEXT_MAX = 200;
export const QUEUE_MESSAGES_MAX = 100_000;
const LINE_MAX = 4096;
const QUEUE_LINE_MAX = 256 * 1024;
const TRACKED_QUEUE_IDS_MAX = 20_000;
const RECORDS_TRACKED_MAX = 2_000;
const MESSAGE_ID_MAX = 250;
const ADDRESS = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@(?=.{1,253}$)(?:[a-z0-9-]{1,63}\.)+[a-z0-9-]{2,63}$/;
const ADDRESS_IN_TEXT = /[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+/g;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// <time> <host> postfix/<service>[pid]: <queue id>: <text>
// Time is `short-unix` (journalctl -o short-unix), ISO 8601 (rsyslog on Ubuntu 24.04,
// journalctl -o short-iso) or the traditional `Nov 20 09:15:02`.
const LINE = /^(\d{9,11}(?:\.\d{1,9})?|\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:?\d\d)|[A-Z][a-z]{2} {1,2}\d{1,2} \d\d:\d\d:\d\d) \S+ (postfix(?:\/[A-Za-z0-9._-]{1,32}){1,3})\[\d{1,10}\]: ([0-9A-Za-z]{5,20}): (.*)$/;

export function parseLogTime(stamp, now = Date.now()) {
  if (/^\d{9,11}(?:\.\d+)?$/.test(stamp)) return Math.round(Number(stamp) * 1000);
  const iso = stamp.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?)(Z|[+-]\d\d:?\d\d)$/);
  if (iso) return Date.parse(`${iso[1]}${iso[2] === 'Z' ? 'Z' : `${iso[2].slice(0, 3)}:${iso[2].slice(-2)}`}`);
  const legacy = stamp.match(/^([A-Z][a-z]{2}) {1,2}(\d{1,2}) (\d\d):(\d\d):(\d\d)$/);
  if (legacy && MONTHS.includes(legacy[1])) {
    const year = new Date(now).getFullYear();
    const at = (y) => new Date(y, MONTHS.indexOf(legacy[1]), Number(legacy[2]), Number(legacy[3]), Number(legacy[4]), Number(legacy[5])).getTime();
    // A traditional syslog stamp has no year: a date ahead of now is last year's.
    return at(year) > now + 24 * 60 * 60 * 1000 ? at(year - 1) : at(year);
  }
  return Number.NaN;
}

export function parsePostfixLogLine(line, now = Date.now()) {
  if (typeof line !== 'string' || line.length > LINE_MAX) return null;
  const match = line.match(LINE);
  if (!match) return null;
  const time = parseLogTime(match[1], now);
  if (!Number.isFinite(time)) return null;
  const service = match[2].split('/').pop();
  return { time, service, queueId: match[3], text: match[4] };
}

function address(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return text.length <= 254 && ADDRESS.test(text) && !text.includes('..') ? text : null;
}

function field(text, name) {
  return text.match(new RegExp(`(?:^|, )${name}=<([^<>\\s]{0,300})>`))?.[1];
}

function dsnOf(text) {
  const dsn = text.match(/(?:^|, )dsn=([245]\.\d{1,3}\.\d{1,3})(?:,|$)/)?.[1];
  return dsn ?? null;
}

function messageIdOf(value) {
  const text = String(value ?? '').trim();
  return text.length <= MESSAGE_ID_MAX && /^<[^<>\s\0-\x1f\x7f]{1,248}>$/.test(text) ? text : null;
}

/**
 * Turn the free text a remote server or Postfix gave into something safe to show:
 * one line, no control characters, no addresses except this message's own sender and
 * recipient, at most 200 characters.
 */
export function sanitizeReasonText(text, keep = []) {
  const allowed = new Set(keep.filter(Boolean).map((item) => String(item).toLowerCase()));
  const clean = String(text ?? '')
    .replace(/[\0-\x1f\x7f-\x9f]+/g, ' ')
    .replace(ADDRESS_IN_TEXT, (found) => (allowed.has(found.toLowerCase()) ? found : '<address>'))
    .replace(/\s+/g, ' ')
    .trim();
  return [...clean].length > REASON_TEXT_MAX ? `${[...clean].slice(0, REASON_TEXT_MAX - 1).join('')}…` : clean;
}

/** A coarse, stable reason a user can act on. The full reply stays in reasonText. */
export function classifyDeliveryReason({ status, dsn, text }) {
  if (status === 'sent') return 'delivered';
  const reply = String(text ?? '').toLowerCase();
  const code = String(dsn ?? '');
  if (/greylist|grey-list|graylist/.test(reply)) return 'greylisted';
  if (/too many (?:connections|messages|recipients|errors)|rate limit|rate-limit|ratelimit|throttl|try again later|temporarily deferred|exceeded .{0,20}(?:rate|limit)/.test(reply) || /^4\.7\.0$/.test(code) && /\b421\b/.test(reply)) return 'rate-limited';
  if (/^[45]\.1\.[1236]$/.test(code) || /user unknown|unknown user|no such user|does not exist|unknown recipient|invalid recipient|no mailbox|mailbox unavailable/.test(reply)) return 'recipient-unknown';
  if (/^[45]\.2\.2$/.test(code) || /quota|mailbox full|over quota|insufficient storage/.test(reply)) return 'mailbox-full';
  if (/^[45]\.3\.4$/.test(code) || /message (?:size|too large|too big)|exceeds size/.test(reply)) return 'message-too-large';
  if (/spam|blocklist|blacklist|spamhaus|reputation|junk/.test(reply)) return 'spam';
  if (/^[45]\.7\.\d{1,3}$/.test(code) || /policy|spf|dkim|dmarc|not authorized|unauthenticated|access denied|relay(?:ing)? denied/.test(reply)) return 'policy';
  if (/host or domain name not found|name service error|no mx|mx record|domain not found|nxdomain|dns/.test(reply)) return 'dns';
  if (/\btls\b|starttls|certificate|ssl/.test(reply)) return 'tls';
  if (/connect to|connection (?:timed out|refused|reset)|lost connection|network is unreachable|no route to host|timed out|conversation with .{0,100} timed out/.test(reply) || /^4\.4\.\d{1,3}$/.test(code)) return 'connection';
  if (status === 'expired') return 'expired';
  return 'other';
}

function reasonOf(text) {
  const start = text.indexOf('(', text.search(/status=(?:sent|deferred|bounced)/));
  if (start < 0) return '';
  const end = text.lastIndexOf(')');
  return end > start ? text.slice(start + 1, end) : text.slice(start + 1);
}

/**
 * Feed Postfix log lines in time order with `push`; `result()` returns the newest
 * records for messages whose envelope sender is `sender`. A recipient's later state
 * replaces an earlier one (a deferral followed by a delivery shows as sent).
 * Memory stays bounded however many lines go in.
 */
export function createDeliveryCollector({ sender, since = 0, limit = DELIVERY_LIMIT_DEFAULT, now = Date.now() } = {}) {
  const owner = address(sender);
  if (!owner) throw new Error('Sender address is invalid.');
  const queues = new Map();
  const records = new Map();
  let serial = 0;
  let lines = 0;

  const track = (queueId) => {
    let entry = queues.get(queueId);
    if (!entry) {
      entry = { serial: ++serial, sender: null, messageId: null };
      queues.set(queueId, entry);
      if (queues.size > TRACKED_QUEUE_IDS_MAX) queues.delete(queues.keys().next().value);
    }
    return entry;
  };
  const keep = (key, record) => {
    records.delete(key);
    records.set(key, record);
    if (records.size > RECORDS_TRACKED_MAX) records.delete(records.keys().next().value);
  };

  function push(line) {
    lines += 1;
    const parsed = parsePostfixLogLine(line, now);
    if (!parsed || parsed.time < since) return;
    const { time, service, queueId, text } = parsed;
    if (service === 'cleanup' && text.startsWith('message-id=')) {
      // A new message on this queue ID starts here; a reused ID must not inherit the last sender.
      queues.delete(queueId);
      track(queueId).messageId = messageIdOf(text.slice('message-id='.length));
      return;
    }
    if (service === 'qmgr' && text === 'removed') { queues.delete(queueId); return; }
    if (service === 'qmgr' && text.startsWith('from=<')) {
      const entry = track(queueId);
      const from = field(text, 'from');
      if (/, status=expired(?:,|$)/.test(text)) {
        if (entry.sender !== owner && address(from) !== owner) return;
        entry.sender = owner;
        let found = false;
        for (const [key, record] of records) {
          if (!key.startsWith(`${entry.serial}\n`) || record.status !== 'deferred') continue;
          found = true;
          keep(key, { ...record, time, status: 'expired', reasonCategory: record.reasonCategory === 'other' ? 'expired' : record.reasonCategory });
        }
        if (!found) keep(`${entry.serial}\n`, { queueId, messageId: entry.messageId, time, recipient: null, status: 'expired', dsn: null, reasonCategory: 'expired', reasonText: 'The message stayed in the queue too long and was returned to the sender.' });
        return;
      }
      entry.sender = from === '' ? '' : address(from);
      return;
    }
    if (!text.startsWith('to=<')) return;
    const entry = queues.get(queueId);
    // Strict: a delivery whose envelope sender was not seen as this mailbox is not reported.
    if (!entry || entry.sender !== owner) return;
    const status = text.match(/, status=(sent|deferred|bounced)(?: |,|$)/)?.[1];
    if (!status) return;
    const recipient = address(field(text, 'to'));
    const dsn = dsnOf(text);
    const raw = reasonOf(text);
    keep(`${entry.serial}\n${recipient ?? ''}`, {
      queueId,
      messageId: entry.messageId,
      time,
      recipient,
      status,
      dsn,
      reasonCategory: classifyDeliveryReason({ status, dsn, text: raw }),
      reasonText: sanitizeReasonText(raw, [recipient, owner])
    });
  }

  function result() {
    const newest = [...records.values()].sort((left, right) => right.time - left.time).slice(0, limit);
    return {
      records: newest.map((record) => ({ ...record, time: new Date(record.time).toISOString() })),
      lines,
      truncated: lines >= DELIVERY_LOG_LINES_MAX
    };
  }

  return { push, result };
}

/** Counts only: how many messages wait, how old the oldest is, and why deferred ones wait. */
export function createQueueSummary({ now = Date.now() } = {}) {
  let total = 0;
  let parsed = 0;
  let truncated = false;
  let oldest = null;
  const byQueue = Object.fromEntries(QUEUE_NAMES.map((name) => [name, 0]));
  const reasons = new Map();

  function push(line) {
    if (typeof line !== 'string' || !line.trim()) return;
    total += 1;
    if (parsed >= QUEUE_MESSAGES_MAX || line.length > QUEUE_LINE_MAX) { truncated = true; return; }
    parsed += 1;
    let message;
    try { message = JSON.parse(line); } catch { truncated = true; return; }
    if (!message || typeof message !== 'object') return;
    if (QUEUE_NAMES.includes(message.queue_name)) byQueue[message.queue_name] += 1;
    if (Number.isFinite(message.arrival_time) && message.arrival_time > 0) oldest = oldest === null ? message.arrival_time : Math.min(oldest, message.arrival_time);
    if (message.queue_name !== 'deferred' || !Array.isArray(message.recipients)) return;
    const seen = new Set();
    for (const recipient of message.recipients.slice(0, 1000)) {
      const reason = typeof recipient?.delay_reason === 'string' ? recipient.delay_reason.slice(0, 2000) : '';
      const dsn = reason.match(/\b([45]\.\d{1,3}\.\d{1,3})\b/)?.[1] ?? null;
      seen.add(classifyDeliveryReason({ status: 'deferred', dsn, text: reason }));
    }
    for (const category of seen) reasons.set(category, (reasons.get(category) ?? 0) + 1);
  }

  function result() {
    return {
      total,
      byQueue,
      oldestAgeSeconds: oldest === null ? null : Math.max(0, Math.round(now / 1000 - oldest)),
      deferralReasons: [...reasons].map(([category, count]) => ({ category, count }))
        .sort((left, right) => right.count - left.count || left.category.localeCompare(right.category)).slice(0, 5),
      truncated
    };
  }

  return { push, result };
}

// The Portal checks a helper answer again before it reaches the browser: a fault in
// the helper must not become a way to pass arbitrary text or addresses through.
export function normalizeDeliveryReport(raw, { limit = DELIVERY_LIMIT_MAX } = {}) {
  const records = Array.isArray(raw?.records) ? raw.records.slice(0, Math.min(limit, DELIVERY_LIMIT_MAX)) : [];
  return {
    truncated: raw?.truncated === true,
    records: records.flatMap((record) => {
      if (!record || typeof record !== 'object') return [];
      const time = Date.parse(record.time);
      if (!Number.isFinite(time) || !DELIVERY_STATUSES.includes(record.status)) return [];
      if (typeof record.queueId !== 'string' || !/^[0-9A-Za-z]{5,20}$/.test(record.queueId)) return [];
      const recipient = record.recipient === null ? null : address(record.recipient);
      if (record.recipient !== null && !recipient) return [];
      return [{
        queueId: record.queueId,
        messageId: messageIdOf(record.messageId),
        time: new Date(time).toISOString(),
        recipient,
        status: record.status,
        dsn: typeof record.dsn === 'string' && /^[245]\.\d{1,3}\.\d{1,3}$/.test(record.dsn) ? record.dsn : null,
        reasonCategory: REASON_CATEGORIES.includes(record.reasonCategory) ? record.reasonCategory : 'other',
        reasonText: sanitizeReasonText(record.reasonText, [recipient])
      }];
    })
  };
}

export function normalizeQueueSummary(raw) {
  const count = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);
  return {
    total: count(raw?.total),
    byQueue: Object.fromEntries(QUEUE_NAMES.map((name) => [name, count(raw?.byQueue?.[name])])),
    oldestAgeSeconds: Number.isInteger(raw?.oldestAgeSeconds) && raw.oldestAgeSeconds >= 0 ? raw.oldestAgeSeconds : null,
    deferralReasons: (Array.isArray(raw?.deferralReasons) ? raw.deferralReasons : [])
      .filter((item) => REASON_CATEGORIES.includes(item?.category) && Number.isInteger(item?.count) && item.count > 0)
      .slice(0, 5)
      .map((item) => ({ category: item.category, count: item.count })),
    truncated: raw?.truncated === true
  };
}
