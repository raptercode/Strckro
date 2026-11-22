// Simulated delivery states for the local sandbox, where no Postfix runs. They are
// derived from the mailbox's real Sent folder so the interface can be exercised
// end to end: same shapes as a host, deterministic per recipient, marked simulated.
import { createHash } from 'node:crypto';
import { classifyDeliveryReason } from '../scripts/mail-delivery-log.mjs';

const OUTCOMES = [
  { status: 'deferred', dsn: '4.7.1', text: 'host mx.example.net[192.0.2.25] said: 451 4.7.1 Greylisted, please try again later (in reply to RCPT TO command)' },
  { status: 'deferred', dsn: '4.4.1', text: 'connect to mx.example.net[192.0.2.25]:25: Connection timed out' },
  { status: 'bounced', dsn: '5.1.1', text: 'host mx.example.net[192.0.2.25] said: 550 5.1.1 <{recipient}>: Recipient address rejected: User unknown (in reply to RCPT TO command)' },
  { status: 'expired', dsn: '4.4.1', text: 'connect to mx.example.net[192.0.2.25]:25: Connection timed out' }
];

function digest(value) {
  return createHash('sha256').update(String(value)).digest();
}

function outcomeFor(recipient, local) {
  if (local) return { status: 'sent', dsn: '2.0.0', text: `250 2.0.0 <${recipient}> Saved` };
  const [name] = recipient.split('@');
  if (/bounce|nobody|invalid/.test(name)) return OUTCOMES[2];
  if (/defer|slow|grey|gray/.test(name)) return OUTCOMES[0];
  if (/expire|old/.test(name)) return OUTCOMES[3];
  const roll = digest(recipient)[0] % 20;
  if (roll < 15) return { status: 'sent', dsn: '2.0.0', text: '250 2.0.0 OK queued as SIMULATED' };
  return OUTCOMES[[0, 1, 2, 2, 3][roll - 15]];
}

/**
 * `sent`: [{ messageId, time (ms), recipients: [address] }] newest first.
 * Returns records in the same shape as the helper's `mail-delivery` operation.
 */
export function simulateDeliveryRecords({ sent, localAddresses = [], limit = 50 }) {
  const local = new Set(localAddresses);
  const records = [];
  for (const message of sent) {
    const queueId = digest(message.messageId || message.time).toString('hex').slice(0, 10).toUpperCase();
    for (const recipient of message.recipients) {
      const outcome = outcomeFor(recipient, local.has(recipient));
      const delay = outcome.status === 'sent' ? 2_000 : outcome.status === 'expired' ? 5 * 24 * 60 * 60 * 1000 : 30 * 60 * 1000;
      records.push({
        queueId,
        messageId: message.messageId || null,
        time: new Date(Math.min(Date.now(), message.time + delay)).toISOString(),
        recipient,
        status: outcome.status,
        dsn: outcome.dsn,
        reasonCategory: classifyDeliveryReason({ status: outcome.status, dsn: outcome.dsn, text: outcome.text }),
        reasonText: outcome.text.replace('{recipient}', recipient)
      });
    }
  }
  return records.sort((left, right) => Date.parse(right.time) - Date.parse(left.time)).slice(0, limit);
}

/** A queue summary made of the simulated deferrals: counts only, like the host. */
export function simulateQueueSummary(records, now = Date.now()) {
  const waiting = new Map();
  for (const record of records) {
    if (record.status !== 'deferred') continue;
    const entry = waiting.get(record.queueId) ?? { time: Date.parse(record.time), reasons: new Set() };
    entry.reasons.add(record.reasonCategory);
    waiting.set(record.queueId, entry);
  }
  const reasons = new Map();
  let oldest = null;
  for (const entry of waiting.values()) {
    oldest = oldest === null ? entry.time : Math.min(oldest, entry.time);
    for (const reason of entry.reasons) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  return {
    total: waiting.size,
    byQueue: { active: 0, deferred: waiting.size, hold: 0, incoming: 0, maildrop: 0 },
    oldestAgeSeconds: oldest === null ? null : Math.max(0, Math.round((now - oldest) / 1000)),
    deferralReasons: [...reasons].map(([category, count]) => ({ category, count })).sort((left, right) => right.count - left.count || left.category.localeCompare(right.category)).slice(0, 5),
    truncated: false
  };
}
