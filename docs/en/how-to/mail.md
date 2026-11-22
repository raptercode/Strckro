# Mail: domains, mailboxes and the mailbox reader

[ภาษาไทย](../../th/how-to/mail.md)


Use this after the mail service has been configured once at `/mail/setup`. Everything here is for a Master account. The decisions behind it are in [ADR 0025](../knowledge/adr/0025-port-aware-mail-host-provisioning.md), [ADR 0033](../knowledge/adr/0033-mail-domains-apply-at-once-and-the-portal-reads-mailboxes.md) and [ADR 0034](../knowledge/adr/0034-mail-submission-limits-project-smtp-and-delivery-status.md).

## Read and send mail

Open **Mail**. It shows the Inbox of the first mailbox.

- Choose another mailbox from the list under **Compose** when the host has more than one.
- **Inbox**, **Sent**, **Drafts**, **Spam** and **Trash** are the same folders a mail client sees over IMAP. The number beside a folder is its unread mail.
- Open a message to read it. Opening marks it read. **Reply**, **Reply all** and **Forward** open the compose window with the original quoted.
- **Compose** opens a window at the bottom right. It stays open while you move between folders. A sent message is stored in **Sent**.
- Deleting moves a message to **Trash**. Deleting it from Trash erases it. **Restore** in Trash and **Not spam** in Spam move it back to the Inbox.
- The list refreshes every 30 seconds while the first page is open.

HTML mail is shown in an isolated frame. Pictures that load from the Internet are off, because loading them tells the sender you opened the message; choose **แสดงรูป** to load them for that message. Attachments are always downloaded, never opened in the Portal.

What the reader does not do yet: attach files to a new message, save drafts, search, or group a conversation.

## Add a domain

1. **Mail → Domains**.
2. Enter the domain and choose **Add domain**.

The domain works on the host immediately. You do not verify DNS first and you do not run **Activate** again. You can create mailboxes on it at once.

The domain opens with its four DNS records. Each row gives the type, the **Host / Name** and the **Value** with a copy button. Enter them at your DNS provider:

| Record | What it does |
| --- | --- |
| MX | Other servers deliver mail for the domain to this host. Without it nothing arrives. |
| SPF | Says this host may send for the domain. |
| DKIM | Lets receivers check the signature this host adds. |
| DMARC | Tells receivers what to do when SPF and DKIM fail. |

The Portal checks the records again by itself: when you add the domain, when you open the view, and every 90 seconds while a record is not yet correct. **ตรวจ DNS ตอนนี้** checks at once. Until all four are correct the domain shows `DNS n/4`; mail from it may be refused or marked as spam elsewhere, and mail to it does not arrive until MX is correct.

## Remove a domain

Open the domain and choose **ลบโดเมน**. The host stops accepting mail for it at once. A domain that still has mailboxes asks you to type its name; its mailboxes are removed from the Portal too. Mail files already stored under `/var/vmail` stay on the host.

## Mailboxes

**Mail → Mailboxes** lists every address. **New mailbox** needs the address, a domain and a password of at least 12 characters; **Generate & copy** makes one and copies it. The Portal does not keep the password and cannot show it again.

**Open inbox** goes to that mailbox in the reader. To use a mail client as well, see **Mail → Server → Mail client settings**; it lists only the ports the host firewall allows.

**Change password** sets a new password under the same rules as a new mailbox and offers **Generate & copy** too. Mail clients that use the old password have to sign in again. The Portal does not keep the password.

A mail client sends on port 587 only, with the full address as the user name, and only as that address. Each client address may open 10 connections at once and send 60 messages to 300 recipients a minute, at most 100 recipients per message. Over the limit the server asks the client to try again later; nothing is locked.

## Let a project send mail

**Mail → Server → Project SMTP** gives one project a login that may send only as one From address on a domain of this host. Choose the project, the address and the domain, then **Create credential**. The password is shown once. The Portal also writes `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_USER`, `SMTP_PASS` and `SMTP_FROM` into the project's environment; deploy the project to use them. The login has no mailbox and is limited like any other client.

It needs port 587 allowed in the firewall and the configuration applied with this version. **Revoke** removes the login and the `SMTP_*` values, unless you changed `SMTP_USER` yourself. Removing the domain or deleting the project revokes it too.

## Mail queue

**Mail → Server → Mail queue** shows how many messages wait, how many are deferred, how old the oldest is and the most common reasons, without any address. Delivery status of a mailbox's sent mail is read from the Postfix log for that mailbox only.

## When the service must be configured again

Only when the mail hostname, the delivery mode or the firewall policy of ports 25, 587 and 993 changes: **Mail → Server → Apply configuration again**. Adding and removing domains and mailboxes never needs it.

Once after updating to the version with submission limits: **Mail → Server** says the configuration is older until you apply it again. That turns on the limits and the sender check and makes Project SMTP available.

If a domain was added before this version and never activated a second time, adding or removing any domain, or **Apply configuration again**, writes it to the host.

## Limits and what is not proven

- The reader shows a message up to 30 MiB. Use a mail client for larger ones.
- A Master can read every mailbox of the host. Protect that account accordingly.
- The checks in **Connectivity** are local evidence only. A provider firewall can still block inbound mail; a real message from outside is the proof.
- This workflow is covered by automated tests and by a browser run against the local sandbox. It has not yet been accepted on a real host with Postfix, Dovecot and OpenDKIM.
