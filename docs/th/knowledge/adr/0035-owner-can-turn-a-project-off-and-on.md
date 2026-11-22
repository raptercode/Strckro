# ADR 0035: เจ้าของปิดและเปิดโปรเจคได้

คู่มือภาษาไทยเรียบเรียงตามหัวข้อ ดูรายละเอียดต้นฉบับและตัวอย่างเพิ่มเติมใน [English](../../../en/knowledge/adr/0035-owner-can-turn-a-project-off-and-on.md)


- Status: Accepted
- Date: 2026-11-23

## บริบทและการตัดสินใจ

เดิมการหยุดแอปที่ deploy แล้วทำได้ทางเดียวคือลบ ซึ่งลบ release, ENV, storage และโดเมนไปด้วย ขอบเขตคือ service ต่อโปรเจคของแอปและ worker ไม่รวม mail, database และเครื่องมือของ host

- **ปิดแล้วปิดต่อ** `stop-project` รัน `systemctl disable --now hostmgr-project-<slug>.service` จึงปิดอยู่หลังรีบูตด้วย โปรเจค Docker Compose ไม่มี unit จึงใช้ `docker compose down --remove-orphans` (เฉพาะ container และ network ไม่ใช้ `-v` หรือ `--rmi`) ซึ่งไม่กลับมาหลังรีบูตไม่ว่า restart policy จะเป็นอะไร โปรเจคที่ไม่เคย activate ไม่มีอะไรให้หยุด
- **เปิดคือ release ที่ active** `start-project` ต้องมี active release ที่ `current` ชี้อยู่ แล้ว enable และ start unit (หรือ `docker compose up --detach` โดยไม่ build ใหม่) และตรวจ process/HTTP health เหมือน Restart คืน `{ state: "active", releaseId }` ส่วน `stop-project` คืน `{ state: "off" }`
- **คำขอแบบ typed ใช้ slug อย่างเดียว** ทั้งสอง operation รับแค่ `slug` ชื่อ unit หรือ Compose project สร้างจากมันด้วย `projectIdentity` เหมือน Restart การหยุดไม่ลบไฟล์ ENV storage service account โดเมน หรือ Nginx config และมีเทสต์ตรวจคำสั่งที่รัน
- **โดเมนไม่ถูกแตะและตอบ 502** ไม่มีหน้า maintenance เพราะต้องแก้ Nginx และมีสถานะที่สองให้ย้อน
- **สถานะ** Portal เก็บ `project.service = { enabled: false, stoppedAt }` หลัง helper ยืนยันการหยุด และ `{ enabled: true, startedAt }` หลังยืนยันการเปิด ไม่มี field แปลว่าเปิด เขียน flag หลัง host ยืนยันเท่านั้น คำสั่งที่ล้มจึงคงสถานะเดิมและเห็น `runtimeOperation` ที่ failed เรียกซ้ำได้อย่างปลอดภัยเพราะถาม host ใหม่ทุกครั้ง
- **ปฏิเสธ deploy ขณะปิด** manual deploy, rollback และ Restart ตอบ *Project is turned off* auto deploy บันทึก `blocked` ด้วยเหตุผลเดียวกันและไม่สร้าง release และ helper ปฏิเสธ `activate-project` กับ `restart-project` เป็นด่านที่สอง ทางเลือกคือ build และ activate โดยไม่ start ต้องมีโหมด "ไม่ start" ผ่าน activation transaction และ rollback ทั้งหมด และทิ้ง release ที่ยังไม่ผ่านตรวจไว้หลัง 502 การปฏิเสธง่ายกว่าและไม่อาจ start service โดยบังเอิญ การลบไม่เปลี่ยน
- **การแสดงสถานะ** Portal ตอบ runtime state `off` โดยไม่ถาม host และ helper ตอบ `off` สำหรับโปรเจคที่ติด flag UI แสดง badge **Off** สีกลาง ตัวกรอง *Off* และ *off* ที่ **Serving** ของ pipeline track ไม่นับเป็น *Needs attention*
- **สิทธิ์** `POST /api/projects/<slug>/stop` (body `{"confirm": true}`) และ `/start` ใช้ session, CSRF, สิทธิ์ `deploy.start`, ตัวกันงานซ้อนและ audit (`project.stop`, `project.start`) เหมือน Restart ไม่อยู่ใน allow-list ของ CLI token ทำงานใต้ maintenance lease เดิม ใน demo/sandbox Portal จำลองโดยไม่เรียก helper

## การใช้งานบันทึก

ปิดแล้วย้อนได้และเก็บทุก release ทุกไฟล์ รีบูต อัปเดต Portal หรือ installer ไม่ start โปรเจคที่ปิดเพราะ unit ยัง disable ผู้เข้าชมเห็น 502 ขณะปิด ระหว่าง stop/start การแก้อื่นของโปรเจคนั้นถูกปฏิเสธ ถ้า Portal เริ่มใหม่กลางทางจะทำเครื่องหมายว่ายืนยันผลไม่ได้และคง flag เดิม การเปิด Compose อีกครั้งสร้าง container ใหม่จาก release ที่ active state ใน container ที่ไม่อยู่ใน named volume จะหายเหมือน `down` ทั่วไป

ยังไม่ได้ทดสอบบน systemd หรือ Docker จริง สิ่งที่ต้องตรวจบน host: `systemctl is-enabled`/`is-active` หลังปิดและหลังรีบูต, `disable --now` กับ unit ที่ disable อยู่แล้วต้องสำเร็จ, `enable` + `start` หลัง `disable --now` คืน unit ได้โดยไม่ต้อง `daemon-reload`, Nginx ตอบ 502 และคง certificate, หน้าต่าง health 30 วินาทีกับแอปที่ช้า และ `docker compose down` แล้ว `up --detach` กับโปรเจคที่มี named volume
