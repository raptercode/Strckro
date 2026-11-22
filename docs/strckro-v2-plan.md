# Strckro: v1 work now and the v2 plan

Status: proposal, 2026-11-23. Nothing here is decided until the owner says so.
English only on purpose (kept outside `docs/en` and `docs/th` so it needs no translation).

Sources: the v2 blueprint (`strckro_v2_rust_zero_ssh_architecture_blueprint.md`, not in this repo),
a review of the running preview, and a three-round debate between three models given fixed
lenses: **Operator** (runs their own Postfix/Dovecot), **Designer** (product and UX), **Skeptic**
(scope and security).

## 1. Verdict

1. **Do not do the blueprint as written.** It is a 9-week plan for what is 4 to 8 months of solo
   work, it never mentions mail, and its root boundary is weaker than the one v1 already has.
2. **Rust is not what users would notice.** "15 MB RAM" and "single static binary" are engineering
   stories. The product story in the blueprint is Zero-SSH: one-line install, a first-run flow and
   a stack store. Those do not need a rewrite to exist.
3. **Keep one product.** All three debaters named the same way this project dies: a solo developer
   holding a frozen v1 and an unfinished v2, with neither trustworthy.
4. **So v2 is a track, not a rewrite.** Finish and harden v1; make v1's behaviour testable from
   outside; then replace parts behind that test suite only where there is evidence it pays.

The debate did not settle whether any Rust should be written:

| | Position | Would change their mind |
|---|---|---|
| Operator | Stay on Node; port only the root helper to Rust, called by v1 | A Rust helper that passes v1's helper tests unchanged, mail ops included, in under 6 weeks |
| Designer | Strangler yes, full rewrite no; keep the vanilla SPA | State complexity in the UI actually hurting |
| Skeptic | Stay on Node; even the helper port buys users nothing and adds a second toolchain and a permanent wire protocol | A measured problem: install friction, or a Node supply-chain incident |

Recommendation: take the Operator's test as the gate. It is cheap to run, it produces evidence
either way, and it answers the Skeptic's objection with data instead of opinion.

## 2. Part A: work on v1 now

Everything in this part is either UI-only (the SPA is static and can be embedded in any future
backend unchanged) or hardening that a rewrite would need anyway.

### Done, uncommitted

- Mail opens as a full-height three-pane client (folder rail, list, reader). Domains, Mailboxes
  and Server moved behind "Mail settings" as tabs; `?view=` URLs still work. Compose docks
  bottom-right. Phone: one chip row, compose as a floating button, two-line rows.
- Files: `public/ui/screens/mail.js`, `public/ui/screens/mail/client.js`,
  `public/ui/css/screens.css`, `public/ui/core/dom.js`.
- Checked in the preview at 1440 px and 375 px, both themes; full suite 581 pass, 0 fail, 26
  skipped. Not exercised: send, reply, forward, the Mailboxes and Server tabs, mid-width layout.

### Known state of mail on a real host

- Outbound delivery works (owner-confirmed).
- Not confirmed: inbound, a deferral, a bounce.
- Not present in the generated Postfix config (grep of `scripts/mail-host-config.mjs`): any
  inbound SPF/DKIM/DMARC verifier, any spam filter, any send rate limit. OpenDKIM is wired as a
  signing milter only.

### Build order

Agreed by all three after rebuttals, except where marked.

1. **Finish real-host verification:** receive a message, observe one deferral and one bounce.
2. **Light theme fix** (owner request; see below).
3. **Setup as one live checklist** instead of the 7-step wizard: each item re-checks itself
   (ports, hostname, PTR, DNS), one copy button per DNS record, ending in "send a test message to
   yourself" and showing it arrive. Fold in one language per locale.
4. **Outbound rate limits** per mailbox and per project. Rate limits, not lockouts: a lockout
   lets an attacker lock out the real user.
5. **Delivery status on Sent** plus a read-only queue summary (count, oldest age, top deferral
   reasons). One typed helper op returning bounded parsed fields by queue ID. Never raw log lines:
   they contain other mailboxes' recipients.
6. **Reader craft, client-only:** keyboard shortcuts (j/k, r, c, e, #), auto-advance after an
   action, filter chips over the loaded list, plain-text mail rendered in the theme, a paper-toned
   frame around HTML mail (styled from outside the iframe; the sandbox is not touched).
7. **Mailbox password change.**
8. **Per-project SMTP credentials** injected as ENV, revocable. Only after item 4.

### Rules agreed in the debate

- UI-only work may proceed at any time.
- Anything that adds a root helper op waits for item 1.
- Optimistic UI is fine for flags (read, star). Delete waits for the helper to acknowledge.

### Cut or deferred

- **Trust badges from `Authentication-Results`: cut as first proposed.** Nothing verifies inbound
  mail, so the header may be written by the sender. Only viable if the server verifies, stamps
  its own result and strips foreign copies.
- **Sender favicons: cut.** An outbound request to a domain the sender chose. Initials only.
- **Unified inbox, density modes, threading: deferred.** Low value at this mailbox count;
  threading needs an index.
- **Compose attachments: deferred.**

### Still disputed

- **Undo send.** Designer wants it. Skeptic: a browser-side delay loses mail when the tab closes;
  a server-side hold needs a queue, a timer and crash recovery. Operator: acceptable only if held
  in the portal before submission.
- **Server-side search and drafts.** Operator and Designer called each "one IMAP op". The helper
  reads Maildir files directly and does not speak IMAP, so that cost estimate is unproven. Start
  with client-side filtering.
- **Inbound spam filtering.** Operator: an inbox full of spam ends adoption. Others: rspamd is a
  second daemon plus tuning. Middle option: postscreen and a DNSBL, which is configuration only.

### Light theme

The glare is white on warm paper: `--card-raised` and `--field` are `#fff` on `--paper #efede4`,
with `--card #fbfaf5` between them, and lime `#d8ff70` fills read as neon on paper.

Proposed starting values for the light block of `public/ui/css/tokens.css` (to be tuned by eye in
the preview, not final):

| Token | Now | Proposed |
|---|---|---|
| `--paper` | `#efede4` | `#e9e6da` |
| `--paper-sunk` | `#e5e2d5` | `#dedacb` |
| `--card` | `#fbfaf5` | `#f6f3e8` |
| `--card-raised`, `--field` | `#fff` | `#fbf9f1` |
| `--rule` | `#dcd8ca` | `#d3cfbf` |
| `--ink` | `#111b16` | `#18241d` |

- Let rules carry structure instead of contrast between surfaces.
- Lime as a fill only on the primary button, with the `--signal-edge` border. Text and active
  states use `--signal-text`; selected rows use `--signal-wash`. No lime text on paper.
- Re-check `--ink-3 #75837a` against the new surfaces; it is near the 4.5:1 limit.

## 3. Part B: v2

### What the blueprint gets right

- Unprivileged web daemon, root helper on a Unix socket, peer-credential check, typed commands.
  v1 already has this shape.
- One-line install with no runtime to install first.
- Stack recipes compiled into the helper rather than accepted from the web side.
- Live install logs over SSE.
- Expiry that never stops customer sites.

### Mandatory changes

Security boundary (the blueprint is weaker than v1 here):

1. **No free-form strings to root.** `ApplyNginxVhost { config_content }` and
   `ManageSystemdUnit { unit_name }` let a compromised web daemon write nginx config or stop
   `ssh.service`. The helper takes structured parameters, renders config from its own templates,
   and derives unit names from IDs it owns. v1 already does this.
2. **Add-ons install by ID against a root-owned signed manifest.** Not a path and a SHA-256 both
   supplied by the caller.
3. **No `curl | bash` as root** (Composer, Bun, Docker recipes). Distro packages, or pinned
   versions with checksums in the signed manifest.
4. **Keep v1's helper limits** (16 KiB request, 512 KiB response).
5. **Setup over TLS or a local-only bind**, single-use token, never in a URL.
6. **Docker is root.** A Docker stack plus user-supplied Compose files gives project members
   root. Owner-only, with an explicit warning. Drop the "100% fault isolation" claim.

Scope:

7. **Remove from v2.0:** the add-on socket and reverse proxy, the MCP server, fleet, the licence
   system and the private registry. As drawn, any process that can reach `addons.sock` can
   register routes and receive authenticated user requests; an MCP server that controls the host
   is exposed to prompt injection from the logs and mail it reads. If MCP ever ships: read-only,
   per-tool scopes, human confirmation for changes. Licensing is plumbing for customers who do not
   exist yet.
8. **Add what is missing:** mail (absent from the blueprint, and v1's most distinctive feature),
   a migration path from a v1 host with live mailboxes, the SQLite schema, self-update with
   rollback.

Correctness and honesty:

9. Read stdout and stderr together; the sample can deadlock when stderr fills.
10. "Static binary" needs the musl target.
11. Ubuntu-only recipes (the PHP PPA): say so, as ADR 0001 and 0012 already do.
12. Replace the 9-week roadmap.

Product:

13. **Keep the vanilla SPA.** A framework means a toolchain and a rewrite of every screen for no
    visible change.
14. **First run asks "what do you want to host?"** (a site, an app, mail) and installs the stack
    implicitly, instead of profiles chosen before the user knows what they need.
15. **Install logs need a failure state:** plain-language cause, retry, copy diagnostics.

### What v1 has that must not be lost

- Typed helper ops with root-side rendering and size limits.
- The mail stack and its port 25/2525 detection.
- Health-checked deploys, auto-deploy, organisations and members.
- Persistent project storage (ADR 0032).
- 33 ADRs, about 600 tests, and the fixes from the 2026-11 security review.

### Proposed v2 track

1. **Conformance suite.** Turn each ADR and each security-review finding into a named black-box
   test over HTTP and the helper socket, independent of implementation language. Mark every ADR
   kept, superseded or dropped, in writing. Useful even if no Rust is ever written.
2. **Zero-SSH on v1.** Build the first-run flow and stack store on the current backend. v1 already
   has a privileged UI installer (ADR 0004) and selectable runtimes (ADR 0029). This delivers the
   blueprint's user-facing promise without a rewrite.
3. **The gate experiment.** Port the root helper to Rust against the conformance suite, time-boxed
   to 6 weeks, mail ops included. Pass: v1 switches to it and the next component is considered.
   Fail or overrun: stay on Node and stop.
4. **Only after 3 passes:** the web daemon, then the single-binary install.
5. **Add-ons and enterprise:** only when a real user asks for something the core cannot do.

## 4. Open decisions for the owner

1. Run the 6-week gate experiment, or stay on Node without it?
2. Undo send: server-side hold, or drop it?
3. Inbound spam: postscreen and DNSBL now, rspamd later, or nothing yet?
4. Is the open-core enterprise layer a real near-term goal, or parked?
