export const MAIL_INBOUND_PORTS = Object.freeze([25, 587, 993]);

// Raised whenever the generated main.cf, master.cf or Dovecot file gains something
// another feature depends on. Version 2: submission rate limits, SASL only on
// submission, sender-login enforcement and the project submission passdb.
export const MAIL_CONFIG_VERSION = 2;
export const MAIL_CONFIG_MARKER = `# Strckro mail configuration version ${MAIL_CONFIG_VERSION}`;
export const MAIL_SENDER_LOGINS_MAP = '/etc/postfix/hostmgr/sender-logins';
export const MAIL_SUBMISSION_USERS_FILE = '/etc/hostmgr/mail/submission-users';

// Postfix anvil limits for authenticated submission (port 587), per client IP
// address and per minute (anvil_rate_time_unit = 60s). A client over a limit gets
// a temporary 4xx reply and may retry; nothing is locked out. Inbound MX on port 25
// keeps Postfix defaults so a burst from a real mail server is never refused.
export const MAIL_SUBMISSION_LIMITS = Object.freeze({
  connectionCount: 10,
  connectionRate: 60,
  authRate: 60,
  messageRate: 60,
  recipientRate: 300,
  recipientsPerMessage: 100
});

// ── Helper request validation ────────────────────────────────────────────────
// The root helper takes structured fields only. These checks are pure so the
// rules can be tested without a host; the helper turns MailRequestError into
// its own static error message.
export class MailRequestError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.name = 'MailRequestError';
    this.code = code;
  }
}

export function assertOnlyFields(request, allowed) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new MailRequestError('Invalid helper request.');
  const extra = Object.keys(request).filter((key) => !allowed.includes(key));
  if (extra.length) throw new MailRequestError('Helper request has unexpected fields.');
}

// Same limits the helper has always applied when a mailbox is created. The Portal
// applies its stronger policy (upper, lower, digit, symbol) before it asks.
export function validateMailboxPassword(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 512 || /[\r\n\0]/.test(value)) throw new MailRequestError('Mailbox password is invalid.');
  return value;
}

export function validateMailProjectSlug(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,62}$/.test(value)) throw new MailRequestError('Project is invalid.');
  return value;
}

// A project's SASL login never contains "@", so it can never be a mailbox login
// and never matches the mailbox passdb that comes first.
export function submissionLogin(projectSlug) {
  return `smtp-${validateMailProjectSlug(projectSlug)}`;
}

export function boundedInteger(value, { min, max, fallback, label = 'Value' }) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new MailRequestError(`${label} is out of range.`);
  return value;
}

// `doveadm pw -s SHA512-CRYPT` output: the scheme, then a crypt(3) string with no
// separator a passwd-file line could be split on.
export function validDovecotHash(value) {
  return typeof value === 'string' && /^\{SHA512-CRYPT\}\$6\$[A-Za-z0-9./$=]+$/.test(value) && value.length <= 300;
}

/**
 * Replace the password field of one passwd-file line, keeping every other field.
 * Returns null when the address has no line.
 */
export function replacePasswdHash(content, login, hash) {
  if (!validDovecotHash(hash)) throw new MailRequestError('Mailbox password could not be secured.');
  const lines = String(content ?? '').split('\n').filter(Boolean);
  const index = lines.findIndex((line) => line.split(':', 1)[0] === login);
  if (index < 0) return null;
  const fields = lines[index].split(':');
  fields[1] = hash;
  lines[index] = fields.join(':');
  return `${lines.join('\n')}\n`;
}

/**
 * smtpd_sender_login_maps: each address and the SASL logins allowed to use it as
 * the envelope sender. A mailbox owns its own address; a project credential owns
 * the one From address it was created for. Several owners share one line.
 */
export function renderSenderLoginMap({ mailboxes = [], credentials = [] }) {
  const owners = new Map();
  const add = (address, login) => {
    if (!owners.has(address)) owners.set(address, new Set());
    owners.get(address).add(login);
  };
  for (const address of mailboxes) add(address, address);
  for (const credential of credentials) add(credential.from, credential.login);
  return renderMap([...owners].map(([address, logins]) => `${address} ${[...logins].sort().join(',')}`));
}

export function demoInboundMailReadiness() {
  return {
    scope: 'demo',
    checkedAt: new Date().toISOString(),
    externalReachability: 'unverified',
    ports: MAIL_INBOUND_PORTS.map((port) => ({ port, status: 'unknown', source: 'demo', detail: 'Demo mode does not inspect a host firewall.' }))
  };
}

export function buildMailPortPlan({ outboundMode, outbound, inbound }) {
  const requiredOutboundPort = outboundMode === 'direct' ? 25 : outboundMode === 'relay-587' ? 587 : outboundMode === 'relay-2525' ? 2525 : null;
  if (!requiredOutboundPort) throw new Error('Outbound mail mode is invalid.');
  if (!Array.isArray(outbound?.ports) || !outbound.ports.some((item) => Number(item?.port) === requiredOutboundPort && item.status === 'open')) {
    throw new Error(`Outbound SMTP port ${requiredOutboundPort} is not confirmed open. Run the mail readiness check again.`);
  }
  const allowed = (port) => Array.isArray(inbound?.ports) && inbound.ports.some((item) => Number(item?.port) === port && item.status === 'allowed');
  const smtp = allowed(25);
  const submission = allowed(587);
  const imaps = allowed(993);
  return {
    outboundPort: requiredOutboundPort,
    inbound: { smtp, submission, imaps },
    needsPublicCertificate: smtp || submission || imaps,
    externalReachability: inbound?.externalReachability === 'verified' ? 'verified' : 'unverified',
    disabledPorts: MAIL_INBOUND_PORTS.filter((port) => !allowed(port))
  };
}

export function renderPostfixMain({ hostname, domains, outboundMode, relay, plan, certificate = null, vmail = { uid: 5000, gid: 5000 } }) {
  const lines = [
    '# Managed by Dashboard Portal. Do not edit.',
    MAIL_CONFIG_MARKER,
    'compatibility_level = 3.6',
    `myhostname = ${hostname}`,
    'myorigin = /etc/mailname',
    'mydestination = localhost',
    `inet_interfaces = ${plan.inbound.smtp || plan.inbound.submission ? 'all' : 'loopback-only'}`,
    'inet_protocols = all',
    'mynetworks = 127.0.0.0/8 [::1]/128',
    'smtpd_relay_restrictions = permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination',
    'smtpd_recipient_restrictions = permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination',
    'smtpd_sasl_type = dovecot',
    'smtpd_sasl_path = private/auth',
    // Sign-in is offered on submission only (master.cf turns it on there), so an
    // authenticated client cannot use port 25 to step around the submission limits.
    'smtpd_sasl_auth_enable = no',
    'smtpd_sasl_security_options = noanonymous',
    // Who may use which envelope sender. Enforced on submission (master.cf), the
    // only service that accepts a sign-in.
    `smtpd_sender_login_maps = hash:${MAIL_SENDER_LOGINS_MAP}`,
    'anvil_rate_time_unit = 60s',
    'virtual_mailbox_domains = hash:/etc/postfix/hostmgr/domains',
    'virtual_mailbox_maps = hash:/etc/postfix/hostmgr/mailboxes',
    'virtual_mailbox_base = /var/vmail',
    `virtual_uid_maps = static:${vmail.uid}`,
    `virtual_gid_maps = static:${vmail.gid}`,
    'virtual_transport = lmtp:unix:private/dovecot-lmtp',
    'smtpd_milters = inet:127.0.0.1:8891',
    'non_smtpd_milters = inet:127.0.0.1:8891',
    'milter_default_action = accept',
    `smtp_tls_security_level = ${outboundMode === 'direct' ? 'may' : 'encrypt'}`
  ];
  if (certificate) {
    lines.push(`smtpd_tls_cert_file = ${certificate.fullchain}`, `smtpd_tls_key_file = ${certificate.privateKey}`, 'smtpd_tls_security_level = may');
  }
  if (outboundMode === 'direct') lines.push('relayhost =');
  else lines.push(
    `relayhost = [${relay.host}]:${relay.port}`,
    'smtp_sasl_auth_enable = yes',
    'smtp_sasl_password_maps = hash:/etc/hostmgr/mail/sasl_passwd',
    'smtp_sasl_security_options = noanonymous'
  );
  // Domains are added and removed without rewriting this file, so name the map
  // Postfix reads instead of a list that would go stale.
  lines.push(`# Virtual domains at configuration time: ${domains.join(', ')} (current list: /etc/postfix/hostmgr/domains)`, '');
  return lines.join('\n');
}

export function renderPostfixMaster(plan) {
  const lines = ['# Managed by Dashboard Portal. Do not edit.', MAIL_CONFIG_MARKER];
  // Port 25 (public MX, or loopback for the Portal's own sending) keeps the main.cf
  // defaults: no anvil rate limits, so a real mail server delivering a burst is never
  // turned away, and no sign-in, so nobody authenticates here to avoid the limits below.
  if (plan.inbound.smtp) lines.push('smtp      inet  n       -       y       -       -       smtpd');
  // Direct egress and the Portal's local SMTP test do not require exposing
  // inbound SMTP. Keep this listener on loopback when public port 25 is not
  // permitted; it is deliberately not the public `smtp inet` service.
  else lines.push('127.0.0.1:25 inet n       -       y       -       -       smtpd');
  const limits = MAIL_SUBMISSION_LIMITS;
  if (plan.inbound.submission) lines.push(
    'submission inet n       -       y       -       -       smtpd',
    '  -o syslog_name=postfix/submission',
    '  -o smtpd_tls_security_level=encrypt',
    '  -o smtpd_tls_auth_only=yes',
    '  -o smtpd_sasl_auth_enable=yes',
    '  -o smtpd_client_restrictions=permit_sasl_authenticated,reject',
    '  -o smtpd_sender_restrictions=reject_authenticated_sender_login_mismatch',
    // Every submission client is limited, including one on this host (the default
    // exception list is $mynetworks, which would exempt loopback).
    '  -o smtpd_client_event_limit_exceptions=',
    `  -o smtpd_client_connection_count_limit=${limits.connectionCount}`,
    `  -o smtpd_client_connection_rate_limit=${limits.connectionRate}`,
    `  -o smtpd_client_auth_rate_limit=${limits.authRate}`,
    `  -o smtpd_client_message_rate_limit=${limits.messageRate}`,
    `  -o smtpd_client_recipient_rate_limit=${limits.recipientRate}`,
    `  -o smtpd_recipient_limit=${limits.recipientsPerMessage}`
  );
  lines.push(
    'pickup    unix  n       -       y       60      1       pickup',
    'cleanup   unix  n       -       y       -       0       cleanup',
    'qmgr      unix  n       -       n       300     1       qmgr',
    'tlsmgr    unix  -       -       y       1000?   1       tlsmgr',
    'rewrite   unix  -       -       y       -       -       trivial-rewrite',
    'bounce    unix  -       -       y       -       0       bounce',
    'defer     unix  -       -       y       -       0       bounce',
    'trace     unix  -       -       y       -       0       bounce',
    'verify    unix  -       -       y       -       1       verify',
    'flush     unix  n       -       y       1000?   0       flush',
    'proxymap  unix  -       -       n       -       -       proxymap',
    'proxywrite unix -       -       n       -       1       proxymap',
    'smtp      unix  -       -       y       -       -       smtp',
    'relay     unix  -       -       y       -       -       smtp',
    'showq     unix  n       -       y       -       -       showq',
    'error     unix  -       -       y       -       -       error',
    'retry     unix  -       -       y       -       -       error',
    'discard   unix  -       -       y       -       -       discard',
    'local     unix  -       n       n       -       -       local',
    'virtual   unix  -       n       n       -       -       virtual',
    'lmtp      unix  -       -       y       -       -       lmtp',
    'anvil     unix  -       -       y       -       1       anvil',
    'scache    unix  -       -       y       -       1       scache',
    ''
  );
  return lines.join('\n');
}

export function renderDovecotConfiguration({ plan, certificate = null, vmail = { uid: 5000, gid: 5000 } }) {
  const listen = plan.inbound.imaps ? '*': '127.0.0.1';
  const tls = certificate
    ? `ssl = required\nssl_cert = <${certificate.fullchain}\nssl_key = <${certificate.privateKey}`
    : 'ssl = no';
  // Project SMTP logins live in their own file and have no userdb entry: Postfix
  // SASL needs the passdb only, while an IMAP or LMTP session also needs the user
  // database, which lists mailboxes alone. So a project login can submit mail but
  // never opens or creates a mailbox.
  return `# Managed by Dashboard Portal. Do not edit.
${MAIL_CONFIG_MARKER}
protocols = imap lmtp
listen = ${listen}
${tls}
mail_location = maildir:/var/vmail/%d/%n/Maildir
first_valid_uid = ${vmail.uid}
last_valid_uid = ${vmail.uid}
auth_mechanisms = plain login
passdb {
  driver = passwd-file
  args = scheme=SHA512-CRYPT username_format=%u /etc/hostmgr/mail/users
}
passdb {
  driver = passwd-file
  args = scheme=SHA512-CRYPT username_format=%u ${MAIL_SUBMISSION_USERS_FILE}
}
userdb {
  driver = passwd-file
  args = username_format=%u /etc/hostmgr/mail/users
  default_fields = uid=${vmail.uid} gid=${vmail.gid} home=/var/vmail/%d/%n
}
service auth {
  unix_listener /var/spool/postfix/private/auth {
    mode = 0660
    user = postfix
    group = postfix
  }
}
service lmtp {
  unix_listener /var/spool/postfix/private/dovecot-lmtp {
    mode = 0600
    user = postfix
    group = postfix
  }
}
`;
}

export function renderOpenDkimConfiguration() {
  return `# Managed by Dashboard Portal. Do not edit.
Syslog                  yes
UMask                   007
UserID                  opendkim
PidFile                 /run/opendkim/opendkim.pid
Mode                    sv
Canonicalization        relaxed/simple
Socket                  inet:8891@127.0.0.1
KeyTable                refile:/etc/opendkim/KeyTable
SigningTable            refile:/etc/opendkim/SigningTable
ExternalIgnoreList      refile:/etc/opendkim/TrustedHosts
InternalHosts           refile:/etc/opendkim/TrustedHosts
`;
}

export function renderDkimTables(domains) {
  const active = domains.map((domain) => ({ domain: domain.domain, selector: domain.dkim?.selectors?.find((item) => item.state === 'active') ?? domain.dkim?.selectors?.[0] })).filter((item) => item.selector);
  return {
    keyTable: active.map(({ domain, selector }) => `${selector.selector}._domainkey.${domain} ${domain}:${selector.selector}:/etc/opendkim/keys/${domain}/${selector.selector}.private`).join('\n') + (active.length ? '\n' : ''),
    signingTable: active.map(({ domain, selector }) => `*@${domain} ${selector.selector}._domainkey.${domain}`).join('\n') + (active.length ? '\n' : ''),
    trustedHosts: ['127.0.0.1', '::1', ...active.map(({ domain }) => domain)].join('\n') + '\n'
  };
}

export function renderMap(entries) {
  return [...new Set(entries)].sort((left, right) => left.localeCompare(right)).join('\n') + (entries.length ? '\n' : '');
}
