# Web ที่ไม่ผูกโดเมน และ Worker ภายใน

[English](../../en/how-to/internal-services-and-workers.md) · [สารบัญ](../README-index.md)

เลือกประเภทงานในขั้นแรกของ **สร้างโปรเจค** แล้วเลือก repository/runtime ในขั้นถัดไป

| ประเภท | พอร์ต | โดเมน | การตรวจหลัง deploy |
| --- | --- | --- | --- |
| Web / API | ระบุเองหรือเลือกพอร์ตว่างอัตโนมัติ | ไม่บังคับ เพิ่มภายหลังได้ | HTTP candidate health ตาม config แล้ว activate service |
| Worker / งานเบื้องหลัง | ไม่มีพอร์ตที่ Portal กำหนดหรือจอง | ไม่มี | Build/source preflight แล้วตรวจ process บน host หลัง activate |

## Web แบบไม่ผูกโดเมน

สร้างโปรเจค Web ตามปกติและเว้นรายการ domain ว่างไว้ การ deploy ไม่ต้องขอ certificate หรือสร้าง Nginx route ของโปรเจคนี้ ถ้ามี managed route เดิมแล้วลบ domain สุดท้าย Portal จะถอด route นั้นและตรวจ/reload Nginx อย่างเป็น transaction; service ยังใช้พอร์ตของแอป

การเข้าจากภายนอกผ่าน IP:port ขึ้นอยู่กับ bind address ของแอปและ firewall ของ host การไม่มี domain ไม่ได้เปิดพอร์ตสาธารณะให้โดยอัตโนมัติ หากแอป bind ที่ loopback ต้องใช้บริการภายในเครื่องหรือช่องทางเข้าถึงที่จัดไว้เอง เมื่อเพิ่ม domain ภายหลังจึงใช้ Nginx/TLS flow ตามปกติ

## Worker ที่ไม่มีพอร์ต

Worker รองรับ **Node.js, Bun, Go และ Python script** สำหรับ process ที่รันต่อเนื่อง เช่น queue consumer ตัว Portal ไม่บังคับ PORT/HOST และไม่ใส่ `Environment=PORT` ใน systemd unit ผู้ใช้ยังตั้ง ENV ของแอปเองได้ รวมถึง PORT/HOST ถ้าแอปต้องใช้ แต่ Portal ไม่ตรวจ HTTP หรือจัดการ domain ให้ Worker

Node/Bun ใช้ named start script เดิม เช่น package.json:

```json
{ "scripts": { "start": "node worker.mjs" } }
```

Go เริ่ม binary ที่ build แล้ว ส่วน Python ต้องเลือก `script` และไฟล์ entry ภายใน source Worker อาจไม่มี user ENV เลยก็ได้; Portal สร้าง environment file ว่างที่มี permissions จำกัดให้ตาม contract

รอบนี้ยังไม่รองรับ Worker ของ PHP, Docker Compose หรือ Python ASGI/WSGI และไม่ใช่ตัวจัดตาราง cron/one-shot jobs แอปที่ทำงานแล้วจบเองจะไม่ผ่าน readiness ของ long-running Worker

## Lifecycle และ rollback

1. ติดตั้ง dependencies/build และตรวจ source โดย **ไม่รัน start process ของ candidate** เพื่อไม่ให้ consumer รุ่นเก่ากับ candidate รับงานพร้อมกัน Build script/installer ยังคงเป็นโค้ดของ trusted repository
2. ก่อนสลับรุ่น helper เก็บ unit, environment file, release link และ service state เดิม แล้วหยุด worker เก่าก่อนเปลี่ยน live files
3. เริ่ม process ใหม่และตรวจ running PID เดิมโดยไม่มี crash/restart ตลอดช่วง 5 วินาที ถ้าออกหรือ restart ระหว่างนี้ activation ล้ม
4. หาก activation ล้ม ต้องหยุด process ใหม่ก่อน restore รุ่นเดิมและตรวจ process ที่กู้กลับมา ถ้าหยุดหรือกู้ไม่ได้ ระบบรายงาน recovery failure ให้ตรวจ host ไม่แสดงว่ากู้สำเร็จ

มีช่วงหยุดสั้น ๆ ระหว่างสลับ Worker แอปควรรองรับ SIGTERM และจัดการงานค้างเอง Process stability ไม่ยืนยันว่าเชื่อม queue ได้หรืองานธุรกิจสำเร็จ และ rollback ไม่ย้อน side effects ของงานที่ทำไปแล้ว ดู runtime logs และระบบ queue ของแอปประกอบ

ประเภท Web/Worker เปลี่ยนไม่ได้หลังมี release ใด ๆ รวมถึง release ที่ failed; runtime ของ Worker ก็ล็อกเช่นกัน หากต้องเปลี่ยนให้สร้างโปรเจคใหม่ start script/typed Python settings ของ release ถูกใช้เมื่อ rollback

สิทธิ์องค์กร, ENV read/write, deployment queue, audit และ maintenance exclusion ยังตรวจตาม contract เดิม การตรวจ local/Docker และไฟล์ unit ไม่แทนการทดสอบ actual systemd/helper/reboot บน host ดู [acceptance record](../knowledge/plans/v1-acceptance-record.md) ก่อนประกาศ go live

## ปิดและเปิดแอปอีกครั้ง

เปิดแอป แท็บ **Deploy** แล้วกด **Turn off** Portal ขอให้ยืนยัน จากนั้นรัน `systemctl disable --now` กับ unit ของโปรเจคนั้นเอง (โปรเจค Docker Compose ใช้ `docker compose down` โดยไม่ลบ volume หรือ image) ใช้ได้ทั้ง web service และ worker และต้องมีสิทธิ์เดียวกับ Restart

- **ปิดแล้วปิดต่อ** unit ถูก disable แอปจึงไม่กลับมาหลังรีบูต release, ENV, persistent storage, service account และ Nginx config ไม่ถูกแตะ
- **โดเมนตอบ 502** โดเมนยังตั้งค่าไว้และ Nginx ยังให้บริการอยู่ เมื่อไม่มี process ฟังอยู่ Nginx ตอบ 502 ไม่มีหน้า maintenance
- **สถานะ** แอปแสดง badge **Off** (สีกลาง ไม่ใช่ *Needs attention*) ในรายการ ภาพรวม และ pipeline track ที่ช่อง **Serving** เป็น *off*
- **ปฏิเสธ deploy ขณะปิด** Create release, rollback และ Restart ตอบว่า *Project is turned off* และไม่เปลี่ยนอะไร auto deploy บันทึกผลล่าสุดเป็น *blocked* และไม่สร้าง release ต้องเปิดแอปก่อน การลบแอปยังทำได้
- **Turn on** enable และ start release ที่ active อยู่ แล้วตรวจ process และ HTTP health เหมือน Restart ถ้าตรวจไม่ผ่านแอปยังถูกมองว่าปิดอยู่ และข้อความให้ดู log ของโปรเจค

API: `POST /api/projects/<slug>/stop` (body `{"confirm": true}`) และ `POST /api/projects/<slug>/start` ใช้ session, CSRF token และสิทธิ์ *deploy.start* เหมือน Restart; token ของ `skctl` เรียกไม่ได้ โปรเจคต้องมี active release ก่อนจึงปิด/เปิดได้ ใน demo mode ทั้งสองคำสั่งเป็นการจำลอง ดู [ADR 0035](../knowledge/adr/0035-owner-can-turn-a-project-off-and-on.md)
