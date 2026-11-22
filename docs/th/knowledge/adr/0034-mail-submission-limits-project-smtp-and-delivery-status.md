# ADR 0034: จำกัดอัตราการส่งบน submission, SMTP login ของโปรเจค และสถานะการส่งจาก mail log

[English](../../../en/knowledge/adr/0034-mail-submission-limits-project-smtp-and-delivery-status.md)


- Status: Accepted
- Date: 2026-11-23
- Amends: [ADR 0033](0033-mail-domains-apply-at-once-and-the-portal-reads-mailboxes.md) (การเปลี่ยนรหัสผ่าน mailbox ที่ระบุว่ายังไม่ได้ทำ) และ [ADR 0025](0025-port-aware-mail-host-provisioning.md) (configuration ของ Postfix และ Dovecot ที่ระบบสร้าง)

## บริบท

mail service รับข้อความจาก client ที่เข้าระบบแล้วได้ไม่จำกัด ให้ client ที่เข้าระบบใช้ envelope sender อะไรก็ได้ เปิดให้เข้าระบบได้ทั้งพอร์ต 25 และ submission และยังไม่มีทางเปลี่ยนรหัสผ่าน mailbox ดูว่าอีเมลที่ส่งไปถึงหรือไม่ หรือให้โปรเจคบน host ส่งอีเมลโดยไม่ต้องมี mailbox เต็มรูปแบบ

## การตัดสินใจ

### 1. จำกัดอัตราเฉพาะ submission

`master.cf` ที่ระบบสร้างใส่ anvil limits ของ Postfix ให้ service `submission` (587) ต่อ IP ของ client ต่อนาที (`anvil_rate_time_unit = 60s`):

| Parameter | ค่า |
| --- | --- |
| `smtpd_client_connection_count_limit` | 10 พร้อมกัน |
| `smtpd_client_connection_rate_limit` | 60 |
| `smtpd_client_auth_rate_limit` | 60 |
| `smtpd_client_message_rate_limit` | 60 |
| `smtpd_client_recipient_rate_limit` | 300 |
| `smtpd_recipient_limit` | 100 ผู้รับต่อข้อความ |

`smtpd_client_event_limit_exceptions` ถูกตั้งเป็นค่าว่างบน submission เพื่อให้ client บนเครื่องนี้ถูกจำกัดด้วย (ค่าเริ่มต้นยกเว้น `$mynetworks` ซึ่งรวม loopback) เมื่อเกิน Postfix ตอบรหัส 4xx ชั่วคราว ไม่มีการล็อกบัญชี

service `smtp` บนพอร์ต 25 (MX สาธารณะ หรือ listener บน loopback ที่ Portal ใช้ส่ง) ใช้ค่าเริ่มต้นของ Postfix ไม่มี anvil rate limit การชะลอ mail server ภายนอกแค่ทำให้เขาส่งช้าลง แต่ไม่มีเหตุผลที่ต้องชะลออีเมลขาเข้า และการส่งของ Portal เองไม่ได้รับผลกระทบ การเข้าระบบปิดทั้งระบบ (`smtpd_sasl_auth_enable = no` ใน `main.cf`) และเปิดเฉพาะ submission เพื่อไม่ให้ client เข้าระบบบนพอร์ต 25 เพื่อเลี่ยงขีดจำกัด หน้า Mail client settings ระบุเฉพาะ 587 สำหรับการส่งอยู่แล้ว

ขีดจำกัดนับต่อที่อยู่ IP ไม่ใช่ต่อ login เพราะ Postfix จำกัดต่อผู้ใช้ไม่ได้ถ้าไม่มี policy service ซึ่งไม่ได้ติดตั้ง ทุกโปรเจคบน host นี้เข้าถึง submission จากที่อยู่เดียวกันจึงใช้โควตาร่วมกัน

### 2. บังคับที่อยู่ผู้ส่งสำหรับ client ที่เข้าระบบ

`main.cf` ระบุ `smtpd_sender_login_maps = hash:/etc/postfix/hostmgr/sender-logins` และ submission ใช้ `smtpd_sender_restrictions=reject_authenticated_sender_login_mismatch` mailbox ส่งได้ในนามที่อยู่ของตัวเอง login ของโปรเจคส่งได้ในนาม From address เดียวของมัน helper สร้าง map นี้ใหม่จากไฟล์ผู้ใช้ของ Dovecot ไฟล์ login ของโปรเจค และ state ทุกครั้งที่ mailbox โดเมน login ของโปรเจค หรือ configuration เปลี่ยน client ที่ไม่ได้เข้าระบบไม่ได้รับผลกระทบ

### 3. เปลี่ยนรหัสผ่าน mailbox

helper operation `set-mailbox-password` (domain, local part, password) ใช้การ hash แบบเดียวกับ `create-mailbox` (`doveadm pw -s SHA512-CRYPT` ส่งรหัสผ่านและการยืนยันทาง stdin) และแทนที่เฉพาะช่อง hash ของบรรทัด mailbox นั้นใน `/etc/hostmgr/mail/users` โดยเขียนไฟล์ชื่อชั่วคราวแล้ว rename Portal ตรวจตาม policy เดียวกับการสร้างก่อน ไม่เก็บและไม่ log รหัสผ่าน audit บันทึกเฉพาะที่อยู่

### 4. สถานะการส่งจาก journald และสรุปคิวแบบนับจำนวน

`mail-delivery` (domain, local part, limit ≤ 100, hours ≤ 168) อ่านบรรทัดของ Postfix จาก journald: `journalctl --output=short-unix --since=@<epoch> --lines=50000` พร้อม identifier `-t postfix/<service>` ที่กำหนดตายตัว ใช้เวลาไม่เกิน 20 วินาทีและจำกัดความยาวบรรทัด `scripts/mail-delivery-log.mjs` แยกข้อมูลภายใน helper รายงานเฉพาะข้อความที่ envelope sender (บรรทัด `from=` ของ `qmgr`) เป็นที่อยู่ของ mailbox นั้น การส่งที่ไม่เห็นบรรทัดผู้ส่งจะถูกตัดทิ้ง แต่ละ record คือ `{ queueId, messageId, time, recipient, status, dsn, reasonCategory, reasonText }` ข้อความตอบกลับตัดเหลือ 200 ตัวอักษร ลบอักขระควบคุม และแทนที่อยู่อีเมลอื่นนอกจากผู้ส่งและผู้รับ บรรทัด log ดิบไม่ออกจาก helper และ Portal ตรวจคำตอบซ้ำก่อนส่งให้เบราว์เซอร์

เลือก journald แทน `/var/log/mail.log` เพราะมีในทุก host Ubuntu 24.04 ไม่ว่าจะติดตั้ง rsyslog หรือไม่ และจำกัดการอ่านได้ทั้งเวลาและจำนวนบรรทัด การจับคู่กับโฟลเดอร์ Sent ให้ฝั่งกล่องอีเมลทำ: record มี `Message-ID` ที่ Postfix log ไว้ ซึ่งตรงกับที่ Portal เขียนในสำเนา Sent

`mail-queue-summary` รัน `postqueue -j` และคืนจำนวนทั้งหมด จำนวนต่อคิว อายุของข้อความที่เก่าที่สุด และหมวดสาเหตุที่ค้าง 5 อันดับแรก ไม่มีที่อยู่อีเมลออกจาก helper

### 5. SMTP login ของโปรเจค

โปรเจคมี SASL login ได้หนึ่งชื่อ `smtp-<project slug>` ที่ส่งได้เฉพาะในนาม From address เดียวบนโดเมนที่ host ดูแล login ไม่มี "@" จึงไม่ตรงกับ mailbox ใด เก็บใน `/etc/hostmgr/mail/submission-users` ซึ่งเป็น passdb ตัวที่สองของ Dovecot ฐานข้อมูลผู้ใช้ (userdb) ของ Dovecot เปลี่ยนเป็นไฟล์ผู้ใช้ mailbox (`passwd-file` ซึ่งมี uid, gid และ home อยู่แล้ว) login ของโปรเจคจึงเข้าระบบกับ Postfix ได้ (Postfix ถามเฉพาะ passdb) แต่ไม่มีผู้ใช้สำหรับ IMAP หรือ LMTP และไม่มี Maildir

Portal บันทึก credential (โปรเจค, From address) ก่อน `create-submission-credential` รับเพียง project slug และรหัสผ่าน แล้วอ่าน From address จาก state ที่บันทึกไว้ และปฏิเสธถ้า `main.cf`, `master.cf` และไฟล์ Dovecot ของ host ยังไม่ใช่ configuration เวอร์ชันนี้ ไม่มีการตรวจผู้ส่ง หรือไม่มี submission listener `revoke-submission-credential` ลบ login ค่าเชื่อมต่อถูกเขียนลง environment ที่เข้ารหัสของโปรเจคเป็น `SMTP_HOST` (mail hostname), `SMTP_PORT` (587), `SMTP_USER`, `SMTP_PASS` และ `SMTP_FROM` มีผลใน deploy ครั้งถัดไป รหัสผ่านแสดงครั้งเดียวในคำตอบที่สร้าง การ revoke ลบโดเมน หรือลบโปรเจค จะลบ login และลบคีย์ `SMTP_*` ถ้า `SMTP_USER` ยังเป็น login นี้

Project SMTP ต้องมี submission listener สาธารณะ เพราะโปรเจคเชื่อมต่อ mail hostname ด้วย STARTTLS Portal บันทึกว่า helper เปิด listener ใดบ้าง และไม่สร้าง credential จนกว่าพอร์ต 587 เปิดและ configuration ถูก apply ด้วยเวอร์ชันนี้

### สิทธิ์

route ใหม่ทั้งหมดอยู่ใต้ `/api/mail` และใช้ได้เฉพาะ Master การเปลี่ยนแปลงต้องมี CSRF token การเปลี่ยนรหัสผ่าน การสร้างและ revoke credential ถูก audit โดยไม่มีความลับ การอ่านสถานะการส่งและคิวไม่ถูก audit เหมือนการอ่านอีเมล

## ผลที่ตามมา

- host เดิมได้ขีดจำกัด การตรวจผู้ส่ง และ userdb ใหม่ของ Dovecot เมื่อกด **Apply configuration again** ครั้งถัดไป ก่อนหน้านั้น Portal แจ้งว่า configuration เป็นเวอร์ชันเก่าและไม่สร้าง Project SMTP
- โปรแกรมอีเมลที่ส่งด้วย From address อื่นที่ไม่ใช่ mailbox ของตัวเองจะถูกปฏิเสธบน submission
- โปรแกรมอีเมลที่ตั้งให้ส่งทางพอร์ต 25 ด้วยรหัสผ่านจะใช้ไม่ได้ พอร์ตที่ระบุในเอกสารมีเพียง 587
- โปรเจคบน host นี้ใช้โควตาอัตราร่วมกัน โปรเจคที่ส่งมากอาจทำให้อีเมลของโปรเจคอื่นช้าลง
- process ใด ๆ บน host ยังส่งอีเมลให้ Postfix ที่ `127.0.0.1:25` ได้โดยไม่ต้องเข้าระบบ (loopback อยู่ใน `mynetworks` ซึ่ง Portal ใช้ส่ง) Project SMTP จำกัดสิ่งที่ login ทำได้ ไม่ได้จำกัดสิ่งที่ process บน host ทำได้
- helper มี module ใหม่ (`mail-delivery-log.mjs`) ที่ installer ต้องติดตั้ง การอัปเดตครั้งแรกมาเวอร์ชันนี้ต้องผ่าน `sudo strckro update` ตามปกติ

## การตรวจสอบ

มีเทสต์บนเครื่องพัฒนา: parser กับบรรทัด log จริงของ Postfix 3.8 (sent 250, deferred 421/451, bounced 550, expired, queue ID ที่ถูกใช้ซ้ำ, หลาย mailbox ปนกัน, ข้อความตอบกลับที่เป็นอันตราย) สรุปคิว configuration ที่สร้าง การตรวจ request ของ helper และ HTTP API ทั้งใน sandbox และกับ helper จำลอง ยังไม่ได้ตรวจบน host จริง สิ่งที่ต้องตรวจบน host:

- `postfix check` ยอมรับบรรทัดใหม่ใน `master.cf` รวมถึง `smtpd_client_event_limit_exceptions=` ที่เป็นค่าว่าง และ anvil นับขีดจำกัดแยกตาม service
- `reject_authenticated_sender_login_mismatch` ปฏิเสธ client ที่เข้าระบบแล้วแต่ sender ไม่อยู่ใน map และปล่อย null sender
- Dovecot ที่มี passdb แบบ `passwd-file` สองตัวและ userdb แบบ `passwd-file`: mailbox ยังเข้า IMAP และรับอีเมลทาง LMTP ได้ login ของโปรเจคเข้า Postfix SASL ได้แต่เข้า IMAP ไม่ได้
- บรรทัด log ของ Postfix ไปถึง journald ด้วย `SYSLOG_IDENTIFIER` แบบ `postfix/<service>` คำสั่ง `journalctl --output=short-unix --since=@N --lines=N -t …` ทำงานตามที่ใช้ และเมื่อไม่มีผลลัพธ์ exit 0 หรือ 1
- `postqueue -j` พิมพ์ JSON หนึ่ง object ต่อข้อความ มี `queue_name`, `arrival_time` และ `recipients[].delay_reason`
