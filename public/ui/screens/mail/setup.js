// Mail setup as one live checklist: connectivity → identity → delivery → DNS → activate → mailbox → test.
// Every row can be opened and re-checked at any time; a row is blocked exactly when the old wizard step was.
import {
  h,
  icon,
  link,
  button,
  submit,
  field,
  form,
  heading,
  panel,
  badge,
  when,
  track,
} from "../../core/dom.js";
import { domainHealth, mailHref, mailStepAvailable } from "./model.js";
import { dnsRecords, portReadout, deliveryLabel } from "./parts.js";
import { SETUP_ROWS, setupChecklist, setupRowFromSearch } from "./checklist.js";

const TEST_TONE = { passed: "success", simulated: "neutral", failed: "danger" };
const STATE_LABEL = {
  ready: "Ready",
  action: "Needs action",
  blocked: "Blocked",
  checking: "Checking…",
};
const ARRIVAL_WAIT_MS = 30_000;
const ARRIVAL_POLL_MS = 3_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function wizard(ctx) {
  let data = await ctx.api.get("/api/mail", { ttl: 0 });
  // The self-test is remembered for the page, not stored: it proves this session's delivery.
  const arrival = { status: "idle", address: "", detail: "", running: false };
  let renderArrival = null;
  const open = new Set();
  const busy = new Set();
  const dirtyForms = new Set();
  const rows = new Map();

  const model = () => setupChecklist(data.mail, { arrived: arrival.status === "arrived" });
  const rowModel = (id) => model().rows.find((row) => row.id === id);
  const stepOf = (id) => SETUP_ROWS.find((row) => row.id === id).step;
  // The same gate the wizard used: an action is refused while its step is unavailable.
  const gate = (id) => {
    if (!mailStepAvailable(stepOf(id), data.mail)) throw new Error(rowModel(id).blocker);
  };

  // ── Changes in the data that rows show ────────────────────────────────
  const syncDirty = () =>
    ctx.dirty([...dirtyForms].some((f) => f.isConnected));
  const watch = (f) => {
    f.addEventListener("input", () => {
      dirtyForms.add(f);
      syncDirty();
    });
    return f;
  };
  const clean = (f) => {
    dirtyForms.delete(f);
    syncDirty();
  };

  const slice = (id) => {
    const mail = data.mail;
    const names = (mail.domains || []).map((d) => [d.domain, d.mailboxCount]);
    return {
      ports: [mail.readiness],
      identity: [mail.hostname, names, mail.ptr, mail.outboundMode],
      delivery: [mail.outboundMode, mail.relay, mail.readiness?.outbound?.recommendation?.mode],
      dns: [mail.hostname, mail.domains],
      activate: [mail.hostname, names, mail.outboundMode, mail.configure, data.tool?.status],
      mailbox: [mail.mailboxes, names, mail.configure?.status],
      test: [mail.mailboxes, mail.lastTest],
    }[id];
  };
  const signature = (row) => JSON.stringify([row.state, row.summary, row.blocker, slice(row.id)]);

  const refresh = async (options) => {
    data = await ctx.api.get("/api/mail", { force: true, ttl: 0 });
    paint(options);
  };

  // `rebuild` names a row whose controls start again; `keep` names rows whose
  // controls stay as they are even though their summary changed.
  function paint({ rebuild = null, keep = [] } = {}) {
    const state = model();
    paintSummary(state);
    for (const row of state.rows) {
      const entry = rows.get(row.id);
      const shown = busy.has(row.id) ? "checking" : row.state;
      entry.el.dataset.state = shown;
      entry.sum.textContent = row.state === "blocked" ? row.blocker : row.summary;
      entry.label.textContent = STATE_LABEL[shown];
      const check = checks[row.id];
      if (entry.check) entry.check.hidden = !(check.available(data.mail) && row.state !== "blocked");
      const sig = signature(row);
      if (!open.has(row.id)) continue;
      if (keep.includes(row.id)) entry.built = sig;
      else if (rebuild === row.id || entry.built !== sig) build(entry, row, sig);
    }
    syncDirty();
  }

  function build(entry, row, sig) {
    entry.built = sig;
    entry.body.replaceChildren(
      row.state === "blocked"
        ? h("p", { class: "notice" }, row.blocker)
        : bodies[row.id](),
    );
  }

  const setOpen = (id, value) => {
    const entry = rows.get(id);
    if (value) open.add(id);
    else open.delete(id);
    entry.toggle.setAttribute("aria-expanded", String(value));
    entry.body.hidden = !value;
    if (value) {
      const row = rowModel(id);
      const sig = signature(row);
      if (entry.built !== sig) build(entry, row, sig);
    }
  };

  // ── Checks the server can run again ───────────────────────────────────
  const checks = {
    ports: {
      label: "connectivity",
      available: () => true,
      run: async () => {
        await ctx.api.post("/api/mail/readiness-check", {});
      },
    },
    identity: {
      label: "PTR / rDNS",
      available: (mail) => !!mail.hostname,
      run: async () => {
        await ctx.api.post("/api/mail/ptr-check", {});
      },
    },
    dns: {
      label: "DNS records",
      available: (mail) => mailStepAvailable(3, mail),
      run: async () => {
        for (const entry of data.mail.domains)
          await ctx.api.post(
            "/api/mail/domains/" + encodeURIComponent(entry.domain) + "/dns-check",
            { record: "all" },
          );
      },
    },
  };

  const checking = async (ids, work) => {
    for (const id of ids) busy.add(id);
    paint({ keep: [...ids] });
    try {
      return await work();
    } finally {
      for (const id of ids) busy.delete(id);
    }
  };
  const checkRow = async (id) => {
    if (!checks[id].available(data.mail)) return;
    gate(id);
    await checking([id], () => checks[id].run());
    await refresh();
    if (id === "ports") ctx.toast("ตรวจ connectivity แล้ว");
  };
  const recheckAll = async () => {
    const ids = Object.keys(checks).filter(
      (id) => checks[id].available(data.mail) && mailStepAvailable(stepOf(id), data.mail),
    );
    let failed = 0;
    await checking(ids, async () => {
      for (const id of ids) {
        try {
          await checks[id].run();
        } catch (error) {
          failed += 1;
          ctx.toast(`${SETUP_ROWS.find((row) => row.id === id).title}: ${error.message}`, true);
        }
      }
    });
    await refresh();
    if (!failed) ctx.toast("Checked " + ids.length + " items");
  };

  // Saves through an endpoint, then reads the state again. A refused step never reaches the server.
  const act = async (id, path, payload = {}, method = "post") => {
    gate(id);
    const result = await ctx.api[method](path, payload);
    await refresh({ rebuild: id });
    return result;
  };

  // ── Row bodies: the controls of the old wizard steps ──────────────────
  const bodies = {
    ports() {
      const report = data.mail.readiness;
      return h(
        "div",
        { class: "stack" },
        h(
          "p",
          { class: "muted" },
          "ตรวจ outbound SMTP 25/587/2525 และ inbound policy ก่อนเลือกวิธีส่งเมล",
        ),
        portReadout(report),
        report?.outbound?.recommendation &&
          h("p", { class: "notice" }, report.outbound.recommendation.summary),
      );
    },

    identity() {
      const mail = data.mail;
      const configured = mail.configure?.status === "configured";
      const domainSubmit = submit("Add domain");
      domainSubmit.disabled = !mail.hostname;
      const hostnameForm = watch(
        form(
          async (v) => {
            await ctx.api.post("/api/mail/hostname", { hostname: v.hostname.trim() });
            clean(hostnameForm);
            // Typing in the domain form below must survive this save.
            await refresh({ keep: ["identity"] });
            domainSubmit.disabled = false;
            ctx.toast("บันทึก hostname แล้ว");
          },
          field("Mail hostname", "hostname", {
            value: mail.hostname || data.suggestions?.hostname || "",
            required: true,
            placeholder: "mail.example.com",
            hint: "ใช้ A/AAAA record ชี้มายัง IP ของ host ไม่ใช้ CNAME ที่ถูก proxy",
          }),
          submit("Save hostname"),
        ),
      );
      const domainForm = watch(
        form(
          async (v) => {
            await act("identity", "/api/mail/domains", { domain: v.domain.trim() });
            ctx.toast("เพิ่ม mail domain แล้ว");
          },
          field("Domain", "domain", {
            required: true,
            placeholder: data.suggestions?.domains?.[0] || "example.com",
          }),
          !mail.hostname && h("small", {}, "บันทึก mail hostname ก่อนเพิ่ม domain"),
          domainSubmit,
        ),
      );
      return h(
        "div",
        { class: "stack" },
        hostnameForm,
        h(
          "div",
          { class: "actions" },
          badge(
            "PTR " + (mail.ptr?.status || "pending"),
            mail.ptr?.status === "verified" ? "success" : "neutral",
          ),
          h(
            "small",
            {},
            "PTR ตั้งที่ผู้ให้บริการ server ไม่ใช่ที่ DNS ของโดเมน จำเป็นเฉพาะการส่งแบบ Direct MX",
          ),
        ),
        h("hr", { class: "divider" }),
        h("h3", {}, "Mail domains"),
        h(
          "small",
          {},
          mail.domains.length + " / " + data.maxDomains + " domains",
          configured &&
            " · หลัง activate แล้ว เพิ่มหรือลบโดเมนได้จากหน้า Mail → Domains โดยไม่ต้องทำขั้นตอนนี้ซ้ำ",
        ),
        ...mail.domains.map((entry) =>
          h(
            "div",
            { class: "list-row" },
            h("strong", {}, entry.domain),
            button(
              "Remove",
              async () => {
                const boxes = entry.mailboxCount || 0;
                if (
                  await ctx.confirm(
                    "ลบ mail domain?",
                    boxes
                      ? `${entry.domain} และ mailbox ${boxes} กล่องของโดเมนนี้จะถูกลบออกจากระบบ`
                      : entry.domain,
                    "Remove",
                  )
                )
                  await act(
                    "identity",
                    "/api/mail/domains/" +
                      encodeURIComponent(entry.domain) +
                      (boxes ? "?force=true" : ""),
                    {},
                    "delete",
                  );
              },
              "danger small",
            ),
          ),
        ),
        domainForm,
      );
    },

    delivery() {
      const mail = data.mail;
      const report = mail.readiness;
      const mode = field("Delivery mode", "mode", {
        choices: [
          ["direct", "Direct MX — outbound port 25"],
          ["relay-587", "SMTP relay — port 587"],
          ["relay-2525", "SMTP relay — port 2525"],
        ],
        value: mail.outboundMode || report?.outbound?.recommendation?.mode || "relay-587",
      });
      const host = field("Relay host", "host", {
        value: mail.relay?.host || "",
        placeholder: "smtp.provider.com",
      });
      const port = field("Port", "port", {
        type: "number",
        min: 1,
        max: 65535,
        value: mail.relay?.port || 587,
      });
      const username = field("Relay username", "username", {
        value: mail.relay?.username || "",
        autocomplete: "off",
      });
      const password = field("Relay password", "password", {
        type: "password",
        autocomplete: "new-password",
        hint: mail.relay?.hasPassword
          ? "เว้นว่างเพื่อใช้รหัสผ่านเดิม"
          : "กรอก SMTP credential จาก provider",
      });
      const relay = h(
        "div",
        { class: "stack" },
        host,
        h("div", { class: "form-columns" }, port, username),
        password,
      );
      const visibility = () => {
        relay.hidden = mode.control.value === "direct";
        for (const input of relay.querySelectorAll("input"))
          input.disabled = relay.hidden;
      };
      mode.control.onchange = () => {
        if (!mail.relay?.port)
          port.control.value = mode.control.value === "relay-2525" ? 2525 : 587;
        visibility();
      };
      visibility();
      const f = watch(
        form(
          async (v) => {
            const payload = { mode: v.mode };
            if (v.mode !== "direct")
              payload.relay = {
                host: v.host,
                port: Number(v.port),
                username: v.username,
                password: v.password,
              };
            clean(f);
            await act("delivery", "/api/mail/outbound-mode", payload);
            ctx.toast("บันทึกโหมดส่งแล้ว");
          },
          mode,
          relay,
          h(
            "p",
            { class: "notice" },
            "ถ้า SMTP ทุกพอร์ตถูกบล็อค ใช้ HTTPS email API ภายนอกแทนการตั้ง mail relay บน host นี้",
          ),
          submit("Save delivery mode"),
        ),
      );
      return f;
    },

    dns() {
      return h(
        "div",
        { class: "stack" },
        h(
          "p",
          { class: "notice" },
          "คัดลอก records ไปที่ผู้ให้บริการ DNS โดยตั้ง TTL = Auto การ propagate อาจใช้เวลา ขั้นนี้ไม่บล็อกขั้นถัดไป: ไปต่อได้เลยแล้วระบบจะแสดงผลตรวจล่าสุดให้ในหน้า Mail → Domains",
        ),
        ...data.mail.domains.map((entry) => {
          const health = domainHealth(entry);
          return h(
            "section",
            { class: "panel" },
            h(
              "header",
              { class: "panel-head" },
              h("div", {}, h("h2", {}, entry.domain)),
              badge(health.label, health.tone),
            ),
            h(
              "div",
              { class: "panel-body stack" },
              dnsRecords(entry),
              button("Check this domain", async () => {
                await act(
                  "dns",
                  "/api/mail/domains/" + encodeURIComponent(entry.domain) + "/dns-check",
                  { record: "all" },
                );
              }),
            ),
          );
        }),
      );
    },

    activate() {
      const mail = data.mail;
      const configured = mail.configure?.status === "configured";
      const installed = data.tool?.status === "Installed";
      return h(
        "div",
        { class: "stack" },
        h(
          "p",
          { class: "notice warning" },
          "ขั้นนี้ติดตั้ง package เขียน configuration และเปิดพอร์ตบน host จริง ทำครั้งเดียว: หลังจากนี้การเพิ่มหรือลบโดเมนและ mailbox ไม่ต้อง activate ซ้ำ",
        ),
        h(
          "dl",
          { class: "key-values" },
          h("dt", {}, "Hostname"),
          h("dd", {}, mail.hostname),
          h("dt", {}, "Domains"),
          h("dd", {}, mail.domains.map((x) => x.domain).join(", ")),
          h("dt", {}, "Delivery"),
          h("dd", {}, deliveryLabel(mail.outboundMode)),
          mail.configure && h("dt", {}, "Status"),
          mail.configure &&
            h(
              "dd",
              {},
              badge("Configured", "success"),
              " ",
              when(mail.configure.at),
              mail.configure.detail && h("small", {}, " · ", mail.configure.detail),
            ),
        ),
        h(
          "div",
          { class: "actions" },
          badge(
            installed ? "Packages ready" : "Packages required",
            installed ? "success" : "neutral",
          ),
          !installed &&
            button(
              "Install mail packages",
              async () => {
                if (
                  await ctx.confirm(
                    "ติดตั้ง Mail packages?",
                    "ติดตั้ง Postfix, Dovecot และ OpenDKIM บนโฮสต์นี้",
                    "Install",
                  )
                )
                  await act("activate", "/api/tools/mail/install", { confirm: true });
              },
              "primary",
            ),
          button("Verify installed packages", async () =>
            act("activate", "/api/tools/mail/manual-verify", { confirm: true }),
          ),
        ),
        button(
          configured ? "Apply configuration again" : "Activate mail service",
          async () => {
            if (
              await ctx.confirm(
                "Activate mail service?",
                `ใช้ ${mail.hostname} และ ${mail.domains.length} domains ระบบจะเขียน config และเปิด service บน host`,
                "Activate",
              )
            ) {
              await act("activate", "/api/mail/configure", { confirm: true });
              ctx.toast("ตั้งค่า Mail service แล้ว");
            }
          },
          "primary",
        ),
      );
    },

    mailbox() {
      const mail = data.mail;
      const pass = field("Mailbox password", "password", {
        type: "password",
        required: true,
        minLength: 12,
        autocomplete: "new-password",
      });
      const f = watch(
        form(
          async (v) => {
            clean(f);
            await act("mailbox", "/api/mail/mailboxes", v);
            ctx.toast("สร้าง mailbox แล้ว");
          },
          h(
            "div",
            { class: "form-columns" },
            field("Local part", "localPart", { required: true, placeholder: "hello" }),
            field("Domain", "domain", {
              choices: mail.domains.map((x) => x.domain),
              required: true,
            }),
          ),
          field("Display name", "displayName"),
          pass,
          submit("Create mailbox"),
        ),
      );
      return h(
        "div",
        { class: "stack" },
        h(
          "p",
          { class: "muted" },
          "สร้าง mailbox สำหรับ IMAP/SMTP รหัสผ่านจะไม่แสดงค่าเดิมอีก",
        ),
        ...mail.mailboxes.map((m) =>
          h(
            "div",
            { class: "list-row" },
            h(
              "div",
              {},
              h("strong", {}, `${m.localPart}@${m.domain}`),
              h("small", {}, m.displayName || ""),
            ),
            button(
              "Delete",
              async () => {
                if (
                  await ctx.confirm(
                    "ลบ mailbox?",
                    `${m.localPart}@${m.domain} จะใช้งานไม่ได้`,
                    "Delete",
                  )
                )
                  await act("mailbox", "/api/mail/mailboxes/" + m.id, {}, "delete");
              },
              "danger small",
            ),
          ),
        ),
        f,
      );
    },

    test() {
      const mail = data.mail;
      const status = h("div", { class: "setup-arrival", role: "status" });
      const lastTest = h("div");
      const showLastTest = (last) => {
        data.mail.lastTest = last;
        lastTest.hidden = !last;
        lastTest.replaceChildren();
        if (!last) return;
        lastTest.append(
          panel(
            "Last test",
            `${last.from} → ${last.to}`,
            h(
              "div",
              { class: "panel-body actions" },
              badge(last.status, TEST_TONE[last.status] || "neutral"),
              h("small", {}, when(last.at), " · ", last.detail),
            ),
          ),
        );
      };
      showLastTest(mail.lastTest);
      renderArrival = () => {
        status.hidden = arrival.status === "idle";
        const parts = {
          sending: [badge("Sending…", "pending")],
          waiting: [
            badge("Waiting for it to arrive…", "pending"),
            h("small", {}, `Checking ${arrival.address} every few seconds, up to 30 seconds.`),
          ],
          arrived: [
            badge("Arrived in Inbox", "success"),
            h("small", {}, `${arrival.address} · ${arrival.detail}`),
          ],
          spam: [
            badge("Arrived in Spam", "warn"),
            h("small", {}, arrival.detail),
          ],
          failed: [badge("Did not arrive", "danger"), h("p", {}, arrival.detail)],
        }[arrival.status];
        status.replaceChildren(...(parts || []));
      };
      renderArrival();

      const mailboxes = mail.mailboxes;
      const pick = field("Mailbox", "selfMailbox", {
        choices: mailboxes.map((m) => [m.id, m.localPart + "@" + m.domain]),
      });
      pick.hidden = mailboxes.length < 2;

      const selfTest = async () => {
        if (arrival.running) return;
        gate("test");
        const box = mailboxes.find((m) => m.id === pick.control.value) || mailboxes[0];
        const address = `${box.localPart}@${box.domain}`;
        const token = `Strckro setup test ${Date.now().toString(36)}`;
        Object.assign(arrival, { running: true, status: "sending", address, detail: "" });
        renderArrival();
        const finish = (status, detail) => {
          Object.assign(arrival, { running: false, status, detail });
          renderArrival?.();
          paint({ keep: ["test"] });
        };
        try {
          await ctx.api.post(`/api/mail/mailboxes/${box.id}/send`, {
            to: address,
            subject: token,
            text: "This is a delivery test from Strckro mail setup. No reply is needed.",
          });
        } catch (error) {
          return finish(
            "failed",
            `The mail server did not accept the message: ${error.message} Check the delivery mode and relay credentials, and that the mail service is running.`,
          );
        }
        arrival.status = "waiting";
        renderArrival?.();
        const deadline = Date.now() + ARRIVAL_WAIT_MS;
        let lastError = "";
        while (ctx.active() && Date.now() < deadline) {
          await sleep(ARRIVAL_POLL_MS);
          if (!ctx.active()) return;
          for (const folder of ["INBOX", "Junk"]) {
            try {
              const page = await ctx.api.get(
                `/api/mail/mailboxes/${box.id}/messages?folder=${folder}&offset=0&limit=20`,
                { ttl: 0, force: true },
              );
              if ((page.messages || []).some((m) => m.subject === token)) {
                if (folder === "INBOX")
                  return finish("arrived", new Date().toLocaleTimeString("th-TH"));
                return finish(
                  "spam",
                  "Delivered, but filed as spam. Check the SPF, DKIM and DMARC records in DNS records.",
                );
              }
            } catch (error) {
              lastError = error.message;
            }
          }
        }
        if (!ctx.active()) return;
        finish(
          "failed",
          lastError
            ? `Could not read the mailbox: ${lastError}`
            : `Nothing arrived within 30 seconds. Check that the MX record for ${box.domain} points to ${mail.hostname} (DNS records), that the mail service is running (Mail → Server), and look in Spam.`,
        );
      };

      return h(
        "div",
        { class: "stack" },
        h(
          "p",
          { class: "muted" },
          "Sends a short message from the mailbox to itself, then waits up to 30 seconds for it to show up in the Inbox.",
        ),
        pick,
        h(
          "div",
          { class: "actions" },
          button("Send test to myself", selfTest, "primary"),
          link("Open the mailbox →", mailHref({ box: (mailboxes[0] || {}).id }), "btn"),
        ),
        status,
        h("hr", { class: "divider" }),
        h("h3", {}, "Send to another address"),
        h(
          "p",
          { class: "notice" },
          "การทดสอบนี้ส่งอีเมลจริงไปยังผู้รับที่ระบุ ใช้อีเมลของคุณเองเพื่อตรวจการรับส่ง",
        ),
        form(
          async (v) => {
            if (
              !(await ctx.confirm(
                "ส่งอีเมลทดสอบ?",
                `ส่งจาก mailbox ที่เลือกถึง ${v.to}`,
                "ส่งอีเมลทดสอบ",
              ))
            )
              return;
            gate("test");
            let result;
            try {
              result = await ctx.api.post("/api/mail/test/send", v);
            } catch (error) {
              if (error.status === 422) {
                await ctx.api
                  .get("/api/mail", { force: true, ttl: 0 })
                  .then((latest) => showLastTest(latest.mail.lastTest))
                  .catch(() => {});
              }
              throw error;
            }
            await refresh({ rebuild: "test" });
            ctx.toast(result.test?.detail || "ส่งคำขอทดสอบแล้ว");
          },
          field("Send from", "mailboxId", {
            choices: mailboxes.map((m) => [m.id, m.localPart + "@" + m.domain]),
            required: true,
          }),
          field("Send to", "to", {
            type: "email",
            required: true,
            placeholder: "you@example.com",
          }),
          submit("Send test email"),
        ),
        lastTest,
      );
    },
  };

  // ── Page ──────────────────────────────────────────────────────────────
  const stateText = h("strong", {});
  const note = h(
    "small",
    {},
    "ขั้น activate เปลี่ยนแปลง host จริง ส่วน DNS records เป็นหน้าที่ของผู้ให้บริการ DNS ระบบตรวจให้แต่ไม่แก้ให้",
  );
  const trackSlot = h("span", { class: "setup-track" });
  const summary = h(
    "section",
    { class: "setup-summary", "aria-label": "Mail setup status" },
    trackSlot,
    h("div", { class: "setup-count" }, stateText, note),
    button("Re-check all", recheckAll, "secondary", { "data-action": "recheck-all" }),
  );
  function paintSummary(state) {
    stateText.textContent = `${state.ready} of ${state.total} ready`;
    trackSlot.replaceChildren(
      track(
        state.rows.map((row) => ({
          label: row.title,
          detail: busy.has(row.id) ? STATE_LABEL.checking : STATE_LABEL[row.state],
          state: busy.has(row.id) ? "busy" : row.state === "ready" ? "ok" : "idle",
        })),
        { large: true },
      ),
    );
  }

  const list = h("div", { class: "setup-list" });
  for (const def of SETUP_ROWS) {
    const label = h("span", { class: "setup-state" });
    const sum = h("span", { class: "setup-sum" });
    const body = h("div", { class: "setup-body", id: `setup-${def.id}`, hidden: true });
    const toggle = h(
      "button",
      {
        type: "button",
        class: "setup-toggle",
        "aria-expanded": "false",
        "aria-controls": `setup-${def.id}`,
        onclick: () => setOpen(def.id, !open.has(def.id)),
      },
      h("i", { class: "led" }),
      h("span", { class: "setup-text" }, h("strong", {}, def.title), sum),
      label,
      icon("chevron"),
    );
    const check = checks[def.id]
      ? button("Check again", () => checkRow(def.id), "secondary small", {
          "aria-label": `Check again: ${checks[def.id].label}`,
        })
      : null;
    const el = h(
      "section",
      { class: "setup-row", "data-row": def.id },
      h("div", { class: "setup-head" }, toggle, check),
      body,
    );
    rows.set(def.id, { el, toggle, body, sum, label, check, built: null });
    list.append(el);
  }

  ctx.root.replaceChildren(
    heading(
      "Configure mail",
      "ตั้งแต่ตรวจพอร์ตจนถึง mailbox แรก ทุกขั้นที่บันทึกแล้วกลับมาทำต่อได้",
      link("Mail", "/mail", "btn secondary"),
    ),
    summary,
    list,
  );
  paint();
  // A deep link (?row=dns, or the old ?step=3) opens that row; otherwise the first one that needs the operator.
  const first = setupRowFromSearch(ctx.route.url.searchParams) || model().firstAction;
  if (first) setOpen(first, true);
}
