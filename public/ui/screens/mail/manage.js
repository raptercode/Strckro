// Mail management views: domains, mailboxes and the server itself.
import {
  h,
  link,
  icon,
  button,
  submit,
  field,
  form,
  panel,
  empty,
  badge,
  copy,
  when,
} from "../../core/dom.js";
import {
  DNS_KINDS,
  dnsCheckDue,
  dnsStatus,
  domainHealth,
  generatePassword,
} from "./model.js";
import { dnsRecords, portReadout, deliveryLabel } from "./parts.js";
import { secretReveal } from "../../core/overlays.js";

const DNS_RECHECK_MS = 90_000;

/**
 * Domains. Adding one is a single step: the Portal stores it, tells a running
 * mail service about it, and then keeps checking its DNS records by itself.
 * Nothing here waits for a manual check or for the service to be activated again.
 */
export function domainsView(ws) {
  const { ctx } = ws;
  const token = ws.token;
  const open = new Set();
  const checking = new Set();
  const list = h("div", { class: "domain-list" });
  const count = h("small", { class: "collection-count" });

  const check = async (domain, background = true) => {
    if (checking.has(domain)) return;
    checking.add(domain);
    paint();
    try {
      const data = await ctx.api.post(
        `/api/mail/domains/${encodeURIComponent(domain)}/dns-check`,
        { record: "all", background },
      );
      if (ws.alive(token)) ws.data = data;
    } finally {
      checking.delete(domain);
      if (ws.alive(token)) {
        ws.sidebar();
        paint();
      }
    }
  };
  // One domain at a time, quietly: a resolver that is slow or down is not the owner's problem to dismiss.
  const checkDue = async (stale) => {
    for (const entry of [...ws.data.mail.domains]) {
      if (!ws.alive(token)) return;
      if (!ws.data.mail.hostname || !dnsCheckDue(entry, Date.now(), stale)) continue;
      await check(entry.domain).catch(() => {});
    }
  };

  const remove = async (entry) => {
    const boxes = entry.mailboxCount || 0;
    const accepted = await ctx.confirm(
      `ลบโดเมน ${entry.domain}?`,
      boxes
        ? `mailbox ${boxes} กล่องของโดเมนนี้จะถูกลบออกจากระบบด้วย และจะรับ–ส่งอีเมลไม่ได้อีก ไฟล์อีเมลเดิมยังอยู่บน host`
        : "host จะหยุดรับอีเมลของโดเมนนี้ทันที ไม่ต้องตั้งค่า service ใหม่",
      "ลบโดเมน",
      boxes ? entry.domain : undefined,
    );
    if (!accepted) return;
    ws.data = await ctx.api.delete(
      `/api/mail/domains/${encodeURIComponent(entry.domain)}${boxes ? "?force=true" : ""}`,
    );
    open.delete(entry.domain);
    ws.sidebar();
    paint();
    ctx.toast(`ลบ ${entry.domain} แล้ว`);
  };

  function item(entry) {
    const health = domainHealth(entry);
    const busy = checking.has(entry.domain);
    const lastChecked = DNS_KINDS.map((kind) => entry.dns?.[kind]?.checkedAt)
      .filter(Boolean)
      .sort()
      .pop();
    const details = h(
      "details",
      {
        class: "domain-item",
        "data-domain": entry.domain,
        open: open.has(entry.domain),
        ontoggle: (event) => {
          if (event.currentTarget.open) open.add(entry.domain);
          else open.delete(entry.domain);
        },
      },
      h(
        "summary",
        {},
        h(
          "span",
          { class: "domain-name" },
          h("strong", {}, entry.domain),
          h(
            "small",
            {},
            `${entry.mailboxCount || 0} mailbox · เพิ่มเมื่อ `,
            when(entry.createdAt),
          ),
        ),
        h(
          "span",
          { class: "domain-dns" },
          ...DNS_KINDS.map((kind) => {
            const status = dnsStatus(entry.dns?.[kind]);
            return h(
              "span",
              { class: `dns-pill ${status.tone}`, title: `${kind.toUpperCase()}: ${status.label}` },
              kind.toUpperCase(),
            );
          }),
        ),
        busy ? badge("กำลังตรวจ DNS", "pending") : badge(health.label, health.tone),
      ),
      h(
        "div",
        { class: "domain-body" },
        h(
          "p",
          { class: health.id === "ready" ? "notice" : "notice warning" },
          health.id === "ready"
            ? "DNS ครบทุก record โดเมนนี้รับและส่งอีเมลได้เต็มที่"
            : "โดเมนนี้ใช้งานบน host ได้แล้ว เพิ่ม records ด้านล่างที่ผู้ให้บริการ DNS เพื่อให้อีเมลเข้า–ออกได้จริงและไม่ตกสแปม ระบบจะตรวจซ้ำให้เองโดยไม่ต้องกดอะไร",
        ),
        dnsRecords(entry),
        h(
          "div",
          { class: "actions spread" },
          h(
            "small",
            {},
            lastChecked ? ["ตรวจ DNS ล่าสุด ", when(lastChecked)] : "ยังไม่เคยตรวจ DNS",
          ),
          h(
            "div",
            { class: "actions" },
            button("ตรวจ DNS ตอนนี้", () => check(entry.domain, false), "small", {
              disabled: busy || !ws.data.mail.hostname,
            }),
            button("ลบโดเมน", () => remove(entry), "danger small"),
          ),
        ),
      ),
    );
    return details;
  }

  let painted = "";
  function paint() {
    const domains = ws.data.mail.domains;
    // DNS is re-checked in the background: rebuild the rows only when something changed.
    const signature = JSON.stringify([domains, [...checking], ws.data.mail.hostname]);
    if (signature === painted) return;
    painted = signature;
    count.textContent = `${domains.length} / ${ws.data.maxDomains} domains`;
    list.replaceChildren(
      ...(domains.length
        ? domains.map(item)
        : [
            empty(
              "ยังไม่มีโดเมน",
              "เพิ่มโดเมนแรกจากช่องด้านบน ที่อยู่อีเมลของโดเมนนั้นจะสร้างได้ทันที",
            ),
          ]),
    );
  }

  const full = () => ws.data.mail.domains.length >= ws.data.maxDomains;
  const addButton = submit("Add domain");
  const addForm = form(
    async (values, el) => {
      const domain = values.domain.trim().toLowerCase();
      ws.data = await ctx.api.post("/api/mail/domains", { domain });
      el.reset();
      open.add(domain);
      addButton.disabled = full();
      ws.sidebar();
      paint();
      ctx.toast(`เพิ่ม ${domain} แล้ว ใช้งานบน host ได้ทันที`);
      void check(domain).catch(() => {});
    },
    h(
      "div",
      { class: "inline-form" },
      field("Domain", "domain", {
        required: true,
        placeholder: ws.data.suggestions?.domains?.[0] || "example.com",
        autocomplete: "off",
        spellcheck: false,
        inputMode: "url",
      }),
      addButton,
    ),
    h(
      "small",
      {},
      "เพิ่มแล้วใช้ได้เลย ไม่ต้องรอตรวจ DNS และไม่ต้อง activate mail service ใหม่",
    ),
  );
  addButton.disabled = full();

  ws.main.replaceChildren(
    h(
      "section",
      { class: "panel" },
      h(
        "header",
        { class: "panel-head" },
        h(
          "div",
          {},
          h("h2", {}, "Mail domains"),
          h("p", {}, "โดเมนที่ host นี้รับ–ส่งอีเมลให้ แต่ละโดเมนมี DNS records ของตัวเอง"),
        ),
        count,
      ),
      addForm,
      list,
    ),
  );
  paint();
  void checkDue(6 * 60 * 60 * 1000);
  let last = Date.now();
  ws.tick = () => {
    // Only records that are not verified yet are worth asking again this often.
    if (Date.now() - last < DNS_RECHECK_MS) return;
    last = Date.now();
    return checkDue(Number.POSITIVE_INFINITY);
  };
}

export function mailboxesView(ws) {
  const { ctx } = ws;
  const mail = ws.data.mail;
  const rows = h("div", { class: "mailbox-list" });

  const remove = async (mailbox) => {
    const address = `${mailbox.localPart}@${mailbox.domain}`;
    if (
      !(await ctx.confirm(
        "ลบ mailbox?",
        `${address} จะรับ–ส่งและเข้าใช้งานไม่ได้อีก ไฟล์อีเมลเดิมยังอยู่บน host`,
        "ลบ mailbox",
        address,
      ))
    )
      return;
    await ctx.api.delete(`/api/mail/mailboxes/${mailbox.id}`);
    await ws.refresh();
    mailboxesView(ws);
    ctx.toast(`ลบ ${address} แล้ว`);
  };

  // Same policy and generator as creating a mailbox. The Portal keeps no password.
  const changePassword = (mailbox) => {
    const address = `${mailbox.localPart}@${mailbox.domain}`;
    const d = ctx.dialog(`Change password · ${address}`);
    const next = field("New password", "password", {
      type: "password",
      required: true,
      minLength: 12,
      autocomplete: "new-password",
      hint: "อย่างน้อย 12 ตัวอักษร มีตัวพิมพ์ใหญ่ เล็ก ตัวเลข และสัญลักษณ์ โปรแกรมอีเมลที่ใช้รหัสเดิมต้องเข้าระบบใหม่",
    });
    d.body.append(
      form(
        async (values) => {
          await ctx.api.post(`/api/mail/mailboxes/${mailbox.id}/password`, {
            password: values.password,
          });
          next.control.value = "";
          await d.close(true);
          ctx.toast(`เปลี่ยนรหัสผ่านของ ${address} แล้ว`);
        },
        next,
        h(
          "div",
          { class: "actions spread" },
          button(
            "Generate & copy",
            async () => {
              next.control.type = "text";
              next.control.value = generatePassword();
              await copy(next.control.value);
            },
            "small",
          ),
          submit("Change password"),
        ),
      ),
    );
    d.onClosed = () => {
      next.control.value = "";
    };
  };

  rows.append(
    ...(mail.mailboxes.length
      ? mail.mailboxes.map((mailbox) => {
          const address = `${mailbox.localPart}@${mailbox.domain}`;
          return h(
            "div",
            { class: "list-row" },
            h(
              "div",
              {},
              h("strong", {}, address),
              h("small", {}, mailbox.displayName || "ไม่มีชื่อที่แสดง", " · สร้างเมื่อ ", when(mailbox.createdAt)),
            ),
            h(
              "div",
              { class: "actions" },
              button("Open inbox", () => ws.show({ view: "inbox", box: mailbox.id, folder: "INBOX", offset: 0, message: "" }), "small"),
              button("Change password", () => changePassword(mailbox), "small"),
              button(icon("copy"), () => copy(address), "icon", { "aria-label": `คัดลอก ${address}`, title: "คัดลอกที่อยู่" }),
              button(icon("trash"), () => remove(mailbox), "icon", { "aria-label": `ลบ ${address}`, title: "ลบ mailbox" }),
            ),
          );
        })
      : [empty("ยังไม่มี mailbox", "สร้าง mailbox แรกจากแบบฟอร์มด้านข้าง")]),
  );

  const password = field("Password", "password", {
    type: "password",
    required: true,
    minLength: 12,
    autocomplete: "new-password",
    hint: "อย่างน้อย 12 ตัวอักษร ใช้เข้า IMAP / SMTP จากโปรแกรมอีเมล ระบบไม่เก็บและไม่แสดงค่านี้อีก",
  });
  const create = mail.domains.length
    ? form(
        async (values, el) => {
          const result = await ctx.api.post("/api/mail/mailboxes", {
            localPart: values.localPart.trim(),
            domain: values.domain,
            displayName: values.displayName.trim(),
            password: values.password,
          });
          el.reset();
          password.control.type = "password";
          await ws.refresh();
          mailboxesView(ws);
          ctx.toast(`สร้าง ${result.mailbox.localPart}@${result.mailbox.domain} แล้ว`);
        },
        h(
          "div",
          { class: "address-field" },
          field("Address", "localPart", {
            required: true,
            placeholder: "hello",
            autocomplete: "off",
            spellcheck: false,
          }),
          h("span", { "aria-hidden": "true" }, "@"),
          field("Domain", "domain", {
            choices: mail.domains.map((entry) => entry.domain),
            required: true,
          }),
        ),
        field("Display name", "displayName", {
          placeholder: "ชื่อที่ผู้รับเห็น เช่น Support Team",
          maxLength: 100,
        }),
        password,
        h(
          "div",
          { class: "actions spread" },
          button(
            "Generate & copy",
            async () => {
              password.control.type = "text";
              password.control.value = generatePassword();
              await copy(password.control.value);
            },
            "small",
          ),
          submit("Create mailbox"),
        ),
      )
    : empty(
        "เพิ่มโดเมนก่อน",
        "mailbox ต้องอยู่ใต้โดเมนที่ host นี้ดูแล",
        button("ไปที่ Domains", () => ws.show({ view: "domains" }), "primary"),
      );

  ws.tick = null;
  ws.main.replaceChildren(
    h(
      "div",
      { class: "split" },
      panel(
        "Mailboxes",
        "ที่อยู่อีเมลบน host นี้ เปิดอ่านได้จากหน้านี้หรือจากโปรแกรมอีเมลผ่าน IMAP",
        rows,
      ),
      panel("New mailbox", "สร้างแล้วรับ–ส่งได้ทันที", create),
    ),
  );
}

const CHECK_TONE = { ok: "success", verified: "success", pending: "neutral" };

const REASON_LABEL = {
  delivered: "ส่งถึงแล้ว",
  "recipient-unknown": "ไม่มีผู้รับนี้",
  "mailbox-full": "กล่องผู้รับเต็ม",
  policy: "ถูกปฏิเสธตาม policy",
  spam: "ถูกมองว่าเป็นสแปม",
  greylisted: "Greylisting (ปลายทางให้ลองใหม่)",
  "rate-limited": "ปลายทางจำกัดอัตรา",
  connection: "เชื่อมต่อปลายทางไม่ได้",
  dns: "หา MX / DNS ปลายทางไม่เจอ",
  tls: "ปัญหา TLS",
  "message-too-large": "ข้อความใหญ่เกิน",
  expired: "ค้างในคิวนานเกินไป",
  other: "อื่น ๆ",
};

export const reasonLabel = (category) => REASON_LABEL[category] || category;

export function queueAge(seconds) {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds} วินาที`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} นาที`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)} ชั่วโมง`;
  return `${Math.round(seconds / 86400)} วัน`;
}

/** Counts only: no address ever reaches this card. */
function queueCard(ws, token) {
  const { ctx } = ws;
  const body = h("div", { class: "panel-body" }, h("p", { class: "muted" }, "กำลังอ่านคิว…"));
  const load = async () => {
    let queue;
    try {
      queue = await ctx.api.get("/api/mail/queue", { force: true });
    } catch (error) {
      if (ws.alive(token))
        body.replaceChildren(h("p", { class: "muted" }, error.message || "อ่านคิวไม่สำเร็จ"));
      return;
    }
    if (!ws.alive(token)) return;
    body.replaceChildren(
      h(
        "dl",
        { class: "key-values" },
        h("dt", {}, "รออยู่ในคิว"),
        h("dd", {}, String(queue.total), queue.simulated && h("small", {}, " · simulated")),
        h("dt", {}, "Deferred"),
        h("dd", {}, String(queue.byQueue?.deferred ?? 0)),
        h("dt", {}, "รายการที่เก่าที่สุด"),
        h("dd", {}, queueAge(queue.oldestAgeSeconds)),
        h("dt", {}, "สาเหตุที่ค้าง"),
        h(
          "dd",
          {},
          queue.deferralReasons?.length
            ? queue.deferralReasons.map((item) => badge(`${reasonLabel(item.category)} · ${item.count}`, "neutral"))
            : "—",
        ),
      ),
      queue.truncated && h("small", {}, "คิวใหญ่มาก ตัวเลขนับเพียงบางส่วน"),
      h("div", { class: "actions" }, button("Refresh", load, "small")),
    );
  };
  void load();
  return panel("Mail queue", "ข้อความที่ Postfix ยังส่งไม่สำเร็จ แสดงเป็นจำนวนเท่านั้น", body);
}

/**
 * Project SMTP: a login that may send only as one From address, written into the
 * project's environment as SMTP_HOST/PORT/USER/PASS/FROM. The password is shown once.
 */
function smtpCredentialsPanel(ws) {
  const { ctx } = ws;
  const mail = ws.data.mail;
  const credentials = mail.smtpCredentials || [];
  const projects = ws.data.projects || [];
  const projectName = (slug) => projects.find((item) => item.slug === slug)?.name || slug;
  const revoke = async (credential) => {
    if (
      !(await ctx.confirm(
        "ยกเลิก SMTP credential?",
        `${projectName(credential.projectSlug)} จะส่งอีเมลในนาม ${credential.from} ไม่ได้อีก ค่า SMTP_* ใน environment ของโปรเจคจะถูกลบ (มีผลใน deploy ครั้งถัดไป)`,
        "ยกเลิก credential",
      ))
    )
      return;
    await ctx.api.delete(`/api/mail/smtp-credentials/${credential.id}`);
    await ws.refresh();
    serverView(ws);
    ctx.toast("ยกเลิก SMTP credential แล้ว");
  };
  const rows = credentials.length
    ? credentials.map((credential) =>
        h(
          "div",
          { class: "list-row" },
          h(
            "div",
            {},
            h("strong", {}, projectName(credential.projectSlug)),
            h(
              "small",
              {},
              "ส่งในนาม ",
              h("code", {}, credential.from),
              " · login ",
              h("code", {}, credential.login),
              " · สร้างเมื่อ ",
              when(credential.createdAt),
            ),
          ),
          h("div", { class: "actions" }, button("Revoke", () => revoke(credential), "danger small")),
        ),
      )
    : [h("p", { class: "muted" }, "ยังไม่มีโปรเจคที่ส่งอีเมลผ่าน host นี้")];
  const available = projects.filter((project) => !credentials.some((item) => item.projectSlug === project.slug));
  let create;
  if (mail.smtpBlocked) create = h("p", { class: "notice warning" }, mail.smtpBlocked);
  else if (!available.length || !mail.domains.length)
    create = h("p", { class: "muted" }, mail.domains.length ? "ทุกโปรเจคมี credential แล้ว" : "เพิ่มโดเมนก่อน");
  else
    create = form(
      async (values) => {
        const result = await ctx.api.post("/api/mail/smtp-credentials", {
          projectSlug: values.projectSlug,
          localPart: values.localPart.trim(),
          domain: values.domain,
        });
        secretReveal(
          `SMTP สำหรับ ${projectName(result.credential.projectSlug)} — คัดลอกตอนนี้`,
          [
            `SMTP_HOST=${result.settings.host}`,
            `SMTP_PORT=${result.settings.port}`,
            `SMTP_USER=${result.settings.user}`,
            `SMTP_PASS=${result.password}`,
            `SMTP_FROM=${result.settings.from}`,
          ].join("\n"),
        );
        await ws.refresh();
        serverView(ws);
        ctx.toast("บันทึกค่า SMTP_* ใน environment ของโปรเจคแล้ว มีผลใน deploy ครั้งถัดไป");
      },
      field("Project", "projectSlug", {
        choices: available.map((project) => [project.slug, project.name || project.slug]),
        required: true,
      }),
      h(
        "div",
        { class: "address-field" },
        field("From address", "localPart", {
          required: true,
          placeholder: "noreply",
          autocomplete: "off",
          spellcheck: false,
        }),
        h("span", { "aria-hidden": "true" }, "@"),
        field("Domain", "domain", {
          choices: mail.domains.map((entry) => entry.domain),
          required: true,
        }),
      ),
      h(
        "small",
        {},
        "credential นี้ส่งได้เฉพาะในนามที่อยู่นี้ผ่านพอร์ต 587 ไม่มีกล่องรับอีเมล และอยู่ใต้ขีดจำกัดอัตราเดียวกับ mailbox",
      ),
      h("div", { class: "actions" }, submit("Create credential")),
    );
  return panel(
    "Project SMTP",
    "ให้โปรเจคส่งอีเมลผ่าน host นี้ ค่าเชื่อมต่อถูกเก็บแบบเข้ารหัสใน environment ของโปรเจค",
    h("div", { class: "panel-body stack" }, h("div", { class: "mailbox-list" }, ...rows), create),
  );
}

export function serverView(ws) {
  const { ctx } = ws;
  const token = ws.token;
  const mail = ws.data.mail;
  const limits = ws.data.submissionLimits;
  const allowed = (port) =>
    mail.readiness?.inbound?.ports?.some(
      (item) => Number(item.port) === port && item.status === "allowed",
    );
  const clientSettings = [
    allowed(993) && ["IMAP (อ่านเมล)", `${mail.hostname} · พอร์ต 993 · SSL/TLS`],
    allowed(587) && ["SMTP (ส่งเมล)", `${mail.hostname} · พอร์ต 587 · STARTTLS`],
  ].filter(Boolean);
  const apply = async () => {
    if (
      !(await ctx.confirm(
        "ตั้งค่า mail service อีกครั้ง?",
        "ใช้เมื่อเปลี่ยน hostname, วิธีส่ง หรือ policy ของพอร์ต ระบบจะเขียน configuration ใหม่และ restart Postfix / Dovecot / OpenDKIM การเพิ่มหรือลบโดเมนไม่ต้องทำขั้นนี้",
        "Apply",
      ))
    )
      return;
    ws.data = await ctx.api.post("/api/mail/configure", { confirm: true });
    serverView(ws);
    ctx.toast("ตั้งค่า Mail service แล้ว");
  };
  const recheck = async () => {
    await ctx.api.post("/api/mail/readiness-check");
    await ws.refresh();
    serverView(ws);
    ctx.toast("ตรวจ connectivity แล้ว");
  };
  const state = (record) =>
    badge(record?.status || "pending", CHECK_TONE[record?.status] || "warn");

  ws.tick = null;
  ws.main.replaceChildren(
    h(
      "div",
      { class: "stack" },
      panel(
        "Mail server",
        "ตัวตนของ SMTP server และวิธีส่งอีเมลออก",
        h(
          "dl",
          { class: "panel-body key-values" },
          h("dt", {}, "Mail hostname"),
          h("dd", {}, h("code", {}, mail.hostname), " ", state(mail.hostnameCheck)),
          h("dt", {}, "Delivery"),
          h("dd", {}, deliveryLabel(mail.outboundMode)),
          mail.outboundMode === "direct" && h("dt", {}, "PTR / rDNS"),
          mail.outboundMode === "direct" &&
            h("dd", {}, state(mail.ptr), mail.ptr?.detail && h("small", {}, " ", mail.ptr.detail)),
          mail.relay && h("dt", {}, "Relay"),
          mail.relay && h("dd", {}, h("code", {}, `${mail.relay.host}:${mail.relay.port}`)),
          h("dt", {}, "Configured"),
          h(
            "dd",
            {},
            when(mail.configure?.at),
            mail.configure?.detail && h("small", {}, " · ", mail.configure.detail),
          ),
        ),
        mail.configure &&
          !mail.configCurrent &&
          h(
            "p",
            { class: "panel-body notice warning" },
            "configuration บน host มาจากเวอร์ชันก่อน กด Apply configuration again เพื่อเปิดใช้การจำกัดอัตราการส่ง การตรวจที่อยู่ผู้ส่ง และ Project SMTP",
          ),
        h(
          "div",
          { class: "panel-body actions" },
          link("Open setup steps", "/mail/setup", "btn"),
          button("Apply configuration again", apply),
        ),
      ),
      panel(
        "Mail client settings",
        "ใช้ที่อยู่อีเมลเต็มเป็น username และรหัสผ่านของ mailbox นั้น",
        clientSettings.length
          ? h(
              "dl",
              { class: "panel-body key-values" },
              ...clientSettings.flatMap(([name, value]) => [
                h("dt", {}, name),
                h("dd", {}, h("code", {}, value)),
              ]),
              allowed(587) && limits && h("dt", {}, "ขีดจำกัดการส่ง"),
              allowed(587) &&
                limits &&
                h(
                  "dd",
                  {},
                  `ต่อ IP ต่อนาที: ${limits.messageRate} ข้อความ, ${limits.recipientRate} ผู้รับ, ${limits.connectionRate} การเชื่อมต่อ · สูงสุด ${limits.recipientsPerMessage} ผู้รับต่อข้อความ`,
                ),
            )
          : h(
              "p",
              { class: "panel-body muted" },
              "ยังไม่มีพอร์ตขาเข้าที่ firewall ของ host อนุญาต จึงเปิดอ่านได้จากหน้านี้เท่านั้น อนุญาตพอร์ต 993 / 587 ใน UFW แล้วตั้งค่า service อีกครั้งเพื่อใช้โปรแกรมอีเมล",
            ),
      ),
      panel(
        "Connectivity",
        "ผลตรวจพอร์ตล่าสุดที่ใช้ตัดสินว่าจะเปิด service ใดบ้าง",
        h("div", { class: "panel-body stack" }, portReadout(mail.readiness), button("Check again", recheck)),
      ),
      mail.configure && queueCard(ws, token),
      mail.configure && smtpCredentialsPanel(ws),
    ),
  );
}
