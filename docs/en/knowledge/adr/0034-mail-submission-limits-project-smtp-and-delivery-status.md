# ADR 0034: Submission limits, project SMTP logins and delivery status from the mail log

[ภาษาไทย](../../../th/knowledge/adr/0034-mail-submission-limits-project-smtp-and-delivery-status.md)


- Status: Accepted
- Date: 2026-11-23
- Amends: [ADR 0033](0033-mail-domains-apply-at-once-and-the-portal-reads-mailboxes.md) (mailbox password changes, which it listed as not built) and [ADR 0025](0025-port-aware-mail-host-provisioning.md) (the generated Postfix and Dovecot configuration)

## Context

The mail service accepted any number of messages from a signed-in client, let a signed-in client use any envelope sender, offered sign-in on port 25 as well as on submission, and gave no way to change a mailbox password, to see whether sent mail was delivered, or to let a project on this host send mail without a full mailbox.

## Decision

### 1. Rate limits on submission only

The generated `master.cf` gives the `submission` service (587) Postfix anvil limits, per client IP address and per minute (`anvil_rate_time_unit = 60s`):

| Parameter | Value |
| --- | --- |
| `smtpd_client_connection_count_limit` | 10 at once |
| `smtpd_client_connection_rate_limit` | 60 |
| `smtpd_client_auth_rate_limit` | 60 |
| `smtpd_client_message_rate_limit` | 60 |
| `smtpd_client_recipient_rate_limit` | 300 |
| `smtpd_recipient_limit` | 100 recipients per message |

`smtpd_client_event_limit_exceptions` is set empty on submission, so a client on this host is limited too (the default exempts `$mynetworks`, which includes loopback). Over a limit, Postfix answers with a temporary 4xx reply; nothing is locked out.

The `smtp` service on port 25 (public MX, or the loopback listener the Portal sends through) keeps Postfix defaults: no anvil rate limits. Throttling a remote mail server only defers its delivery, but there is no reason to slow inbound mail, and the Portal's own sending stays unaffected. Sign-in is turned off globally (`smtpd_sasl_auth_enable = no` in `main.cf`) and on only for submission, so a client cannot authenticate on port 25 to step around the limits. The mail client settings already listed only 587 for sending.

These are per client address, not per login: Postfix has no per-user rate limit without a policy service, and none is installed. Every project on this host reaches submission from the same address and shares one budget.

### 2. Sender addresses are enforced for signed-in clients

`main.cf` names `smtpd_sender_login_maps = hash:/etc/postfix/hostmgr/sender-logins`, and submission applies `smtpd_sender_restrictions=reject_authenticated_sender_login_mismatch`. A mailbox may send as its own address; a project login may send as its one From address. The map is rebuilt by the helper from the Dovecot user file, the project login file and the stored state whenever a mailbox, a domain, a project login or the configuration changes. Clients that did not sign in are not affected.

### 3. Mailbox password changes

A helper operation `set-mailbox-password` (domain, local part, password) uses the hashing of `create-mailbox` (`doveadm pw -s SHA512-CRYPT`, password and confirmation on stdin) and replaces only the hash field of that mailbox's line in `/etc/hostmgr/mail/users`, writing the file to a temporary name and renaming it. The Portal applies the creation policy first. The password is not stored or logged; the audit entry records the address.

### 4. Delivery status from journald, and a counts-only queue summary

`mail-delivery` (domain, local part, limit ≤ 100, hours ≤ 168) reads Postfix lines from journald: `journalctl --output=short-unix --since=@<epoch> --lines=50000` with fixed `-t postfix/<service>` identifiers, for at most 20 seconds and with a line-length guard. `scripts/mail-delivery-log.mjs` parses them in the helper. Only messages whose envelope sender (the `qmgr` `from=` line) is that mailbox's address are reported; a delivery whose sender line was not seen is dropped. Each record is `{ queueId, messageId, time, recipient, status, dsn, reasonCategory, reasonText }`, with the reply text cut to 200 characters, control characters removed and any address other than the sender and recipient replaced. Raw lines never leave the helper, and the Portal checks the answer again before the browser sees it.

journald was chosen over `/var/log/mail.log` because it exists on every Ubuntu 24.04 host whether or not rsyslog is installed, and it bounds the read by time and line count. Correlating with the Sent folder is left to the reader: a record carries the `Message-ID` that Postfix logged, which is the one the Portal wrote into the Sent copy.

`mail-queue-summary` runs `postqueue -j` and returns the total, the count per queue, the age of the oldest message and the five most frequent deferral reason categories. No address leaves the helper.

### 5. Project SMTP logins

A project may get one SASL login, `smtp-<project slug>`, that can send only as one From address on a managed domain. The login has no "@", so it never matches a mailbox. It lives in `/etc/hostmgr/mail/submission-users`, a second Dovecot passdb. Dovecot's user database becomes the mailbox user file (`passwd-file`, which already carries uid, gid and home), so a project login can sign in to Postfix (which asks the passdb only) but has no user for IMAP or LMTP and never gets a Maildir.

The Portal stores the credential (project, From address) first. `create-submission-credential` receives the project slug and the password only and reads the From address from the stored state; it refuses unless the host's `main.cf`, `master.cf` and Dovecot file carry this configuration version, the sender check and a submission listener. `revoke-submission-credential` removes the login. The settings are written into the project's encrypted environment as `SMTP_HOST` (the mail hostname), `SMTP_PORT` (587), `SMTP_USER`, `SMTP_PASS` and `SMTP_FROM`; they apply on the next deploy. The password is returned once in the response that creates it. Revoking, removing the domain or deleting the project removes the login, and the `SMTP_*` keys while `SMTP_USER` still names this login.

Project SMTP needs the public submission listener, because the project connects to the mail hostname with STARTTLS. The Portal records which listeners the helper opened and refuses a credential until 587 is open and the configuration has been applied with this version.

### Access

All new routes are under `/api/mail` and Master only; changes need the CSRF token. Password changes and credential creation and revocation are audited without secrets. Reading delivery status and the queue is not audited, like reading mail.

## Consequences

- Existing hosts get the limits, the sender check and the new Dovecot user database on the next **Apply configuration again**. Until then the Portal says the configuration is older and refuses project SMTP.
- A mailbox client that sends with a From address other than its own mailbox is now refused on submission.
- A mail client configured to send on port 25 with a password stops working; 587 was the only documented port.
- Projects on this host share one rate budget. A busy project can delay mail from another.
- Any process on this host can still hand mail to Postfix on `127.0.0.1:25` without signing in (loopback is in `mynetworks`, which the Portal uses to send). Project SMTP restricts what the login can do, not what a process on the host can do.
- The helper gains a module (`mail-delivery-log.mjs`) that the installer must ship: the first update to this version goes through `sudo strckro update` as usual.

## Verification

Covered by tests on a workstation: the log parser against realistic Postfix 3.8 lines (sent 250, deferred 421/451, bounced 550, expired, reused queue IDs, interleaved mailboxes, hostile replies), the queue summary, the generated configuration, the helper request checks, and the HTTP API in the sandbox and against a recording helper. Not verified on a real host, and to be checked there:

- `postfix check` accepts the new `master.cf` lines, including the empty `smtpd_client_event_limit_exceptions=`, and anvil applies the limits per service.
- `reject_authenticated_sender_login_mismatch` refuses a signed-in client whose sender is not in the map, and lets the null sender through.
- Dovecot with two `passwd-file` passdbs and a `passwd-file` userdb: mailboxes still sign in over IMAP and receive over LMTP; a project login signs in to Postfix SASL but not to IMAP.
- Postfix log lines reach journald with `SYSLOG_IDENTIFIER` `postfix/<service>`, `journalctl --output=short-unix --since=@N --lines=N -t …` behaves as used here, and an empty result exits 0 or 1.
- `postqueue -j` prints one JSON object per message with `queue_name`, `arrival_time` and `recipients[].delay_reason`.
