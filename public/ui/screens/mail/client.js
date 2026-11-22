// The mailbox reader: folders, a message list, one open message and a compose window.
import { h, icon, button, empty, bytes, badge } from "../../core/dom.js";
import { reasonLabel } from "./manage.js";
import {
  MAIL_FILTERS,
  MAIL_PAGE_SIZE,
  MAIL_SHORTCUTS,
  filterMessages,
  folderLabel,
  folderShowsRecipients,
  formatMailDate,
  deliveryStatusLabel,
  deliverySummary,
  deliveryTone,
  formatMailDateLong,
  groupDelivery,
  hasRemoteContent,
  initials,
  linkify,
  mailHref,
  mailHtmlDocument,
  neighbourAfterRemoval,
  normaliseMessageId,
  personLabel,
  replyDraft,
} from "./model.js";

const messagePath = (mailbox, id, folder, action = "") =>
  `/api/mail/mailboxes/${mailbox.id}/messages/${encodeURIComponent(id)}${action}?folder=${encodeURIComponent(folder)}`;
const addressOf = (mailbox) => `${mailbox.localPart}@${mailbox.domain}`;
const people = (list) => (list || []).map(personLabel).join(", ");
const loading = (label) =>
  h("div", { class: "skeleton", role: "status" }, h("span"), h("span"), h("span"), h("p", {}, label));
const failure = (error, retry) =>
  empty("โหลดอีเมลไม่สำเร็จ", error.message, button("ลองอีกครั้ง", retry));

export function inboxView(ws) {
  const mailbox = ws.mailbox();
  if (!mailbox) {
    ws.tick = null;
    ws.main.replaceChildren(
      h(
        "section",
        { class: "panel" },
        empty(
          "ยังไม่มี mailbox",
          "สร้าง mailbox แรกเพื่อเริ่มรับ–ส่งอีเมลจากหน้านี้",
          button("Create a mailbox", () => ws.show({ view: "mailboxes" }), "primary"),
        ),
      ),
    );
    return;
  }
  return list(ws, mailbox);
}

async function refreshFolders(ws, mailbox, token) {
  const data = await ws.ctx.api.get(`/api/mail/mailboxes/${mailbox.id}/folders`, { ttl: 0, force: true });
  if (!ws.alive(token)) return;
  ws.folders = data.folders;
  ws.sidebar();
}

async function list(ws, mailbox) {
  const { ctx } = ws;
  const token = ws.token;
  const { folder, offset } = ws.location;
  const recipients = folderShowsRecipients(folder);
  const title = h("h2", {}, folderLabel(folder));
  const summary = h("small", {}, "กำลังโหลด…");
  const range = h("span", { class: "collection-count" });
  const older = button(icon("chevron"), () => ws.show({ offset: offset + MAIL_PAGE_SIZE }), "icon", { "aria-label": "อีเมลที่เก่ากว่า", title: "เก่ากว่า", disabled: true });
  const newer = button(icon("chevron-left"), () => ws.show({ offset: Math.max(0, offset - MAIL_PAGE_SIZE) }), "icon", { "aria-label": "อีเมลที่ใหม่กว่า", title: "ใหม่กว่า", disabled: offset === 0 });
  const rows = h("div", { class: "mail-list", role: "list", "aria-label": folderLabel(folder) });
  let page = null;
  // Delivery records for Sent, grouped by Message-ID. Null when unavailable.
  let delivery = null;
  const deliveryOf = (message) => deliverySummary(delivery?.get(normaliseMessageId(message.messageId)));
  let filter = MAIL_FILTERS.some(([id]) => id === ws.filter) ? ws.filter : "all";
  const filterNote = h("small", { class: "mail-filter-note", hidden: true });
  const chips = h(
    "div",
    { class: "mail-filter-chips", role: "group", "aria-label": "Filter messages" },
    ...MAIL_FILTERS.map(([id, label]) =>
      h(
        "button",
        {
          type: "button",
          class: "mail-filter",
          "data-filter": id,
          "aria-pressed": String(id === filter),
          onclick: () => {
            filter = ws.filter = id;
            for (const chip of chips.children) chip.setAttribute("aria-pressed", String(chip.dataset.filter === id));
            paint();
          },
        },
        label,
      ),
    ),
  );
  const keysHelp = h(
    "dl",
    { class: "mail-keys", id: "mail-keys-help", hidden: true },
    ...MAIL_SHORTCUTS.flatMap(([keys, what]) => [h("dt", {}, h("kbd", {}, keys)), h("dd", {}, what)]),
  );
  const keysToggle = h("button", {
    type: "button",
    class: "btn icon mail-keys-toggle",
    "aria-label": "Keyboard shortcuts",
    "aria-controls": "mail-keys-help",
    "aria-expanded": "false",
    title: MAIL_SHORTCUTS.map(([keys, what]) => `${keys}: ${what}`).join(" | "),
    onclick: () => {
      keysHelp.hidden = !keysHelp.hidden;
      keysToggle.setAttribute("aria-expanded", String(!keysHelp.hidden));
    },
  }, "?");

  const flag = async (message, changes) => {
    const result = await ctx.api.post(messagePath(mailbox, message.id, folder, "/flags"), changes);
    Object.assign(message, { seen: result.seen, flagged: result.flagged });
    paint();
    if ("seen" in changes) void refreshFolders(ws, mailbox, token).catch(() => {});
  };
  const trash = async (message) => {
    if (
      folder === "Trash" &&
      !(await ctx.confirm("ลบอีเมลถาวร?", "อีเมลใน Trash ที่ลบแล้วกู้คืนไม่ได้", "ลบถาวร"))
    )
      return;
    // Where to go once this one is gone, from the list as it is shown now.
    const shown = visible().map((item) => item.id);
    // The row stays until the server has confirmed: no optimistic delete.
    await ctx.api.delete(messagePath(mailbox, message.id, folder));
    ctx.toast(folder === "Trash" ? "ลบอีเมลถาวรแล้ว" : "ย้ายไป Trash แล้ว");
    if (!ws.alive(token)) return;
    // The deleted message must not stay open: the next one takes its place.
    if (ws.location.message === message.id)
      ws.show({ message: neighbourAfterRemoval(shown, message.id) }, { replace: true });
    await load();
  };
  const visible = () => (page ? filterMessages(page.messages, filter) : []);

  const row = (message) => {
    const who = recipients
      ? `ถึง: ${people(message.to) || "(ไม่มีผู้รับ)"}`
      : personLabel(message.from);
    const open = (event) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      ws.show({ message: message.id });
    };
    const current = ws.location.message === message.id;
    return h(
      "div",
      {
        class: "mail-row" + (message.seen ? "" : " unread") + (current ? " current" : ""),
        role: "listitem",
        "data-message": message.id,
      },
      button(icon("star"), () => flag(message, { flagged: !message.flagged }), "icon mail-star" + (message.flagged ? " on" : ""), {
        "aria-label": message.flagged ? "เอาดาวออก" : "ติดดาว",
        "aria-pressed": String(message.flagged),
      }),
      h(
        "a",
        {
          class: "mail-row-link",
          href: mailHref({ ...ws.location, message: message.id }),
          onclick: open,
          "aria-current": current ? "true" : null,
        },
        h("span", { class: "mail-row-who" }, who),
        h(
          "span",
          { class: "mail-row-text" },
          deliveryOf(message) && deliveryBadge(deliveryOf(message)),
          h("b", {}, message.subject || "(ไม่มีหัวข้อ)"),
          message.snippet && h("span", {}, ` — ${message.snippet}`),
        ),
        message.hasAttachments && h("span", { class: "mail-row-clip", title: "มีไฟล์แนบ" }, icon("clip")),
        h("time", { class: "mail-row-date", dateTime: message.date, title: formatMailDateLong(message.date) }, formatMailDate(message.date)),
      ),
      h(
        "div",
        { class: "mail-row-actions" },
        button(icon("mail"), () => flag(message, { seen: !message.seen }), "icon", {
          "aria-label": message.seen ? "ทำเครื่องหมายว่ายังไม่อ่าน" : "ทำเครื่องหมายว่าอ่านแล้ว",
          title: message.seen ? "ยังไม่อ่าน" : "อ่านแล้ว",
        }),
        button(icon("trash"), () => trash(message), "icon", { "aria-label": "ลบอีเมล", title: folder === "Trash" ? "ลบถาวร" : "ลบ" }),
      ),
    );
  };

  let painted = "";
  function paint() {
    if (!page) return;
    // The list reloads in the background; identical rows are left alone so a
    // click in progress is never lost to a rebuild.
    const signature = JSON.stringify([
      page,
      filter,
      page.messages.map((message) => deliveryOf(message)?.label || ""),
    ]);
    if (signature === painted) return;
    painted = signature;
    const first = page.total ? offset + 1 : 0;
    const last = Math.min(page.total, offset + page.messages.length);
    summary.textContent = page.total
      ? `${page.total.toLocaleString("th-TH")} ฉบับ${page.unread ? ` · ยังไม่อ่าน ${page.unread.toLocaleString("th-TH")}` : ""}`
      : "ว่าง";
    range.textContent = page.total ? `${first}–${last} จาก ${page.total}` : "";
    older.disabled = offset + MAIL_PAGE_SIZE >= page.total;
    const shown = visible();
    const moreThanThisPage = offset > 0 || offset + page.messages.length < page.total;
    filterNote.hidden = !(filter !== "all" && moreThanThisPage);
    filterNote.textContent = "Filter applies to this page only.";
    rows.replaceChildren(
      ...(shown.length
        ? shown.map(row)
        : page.messages.length
          ? [empty("No messages on this page match this filter.", "")]
          : [
            empty(
              `ไม่มีอีเมลใน ${folderLabel(folder)}`,
              folder === "INBOX"
                ? `อีเมลที่ส่งถึง ${addressOf(mailbox)} จะแสดงที่นี่`
                : folder === "Sent"
                  ? "อีเมลที่ส่งจากหน้านี้หรือจากโปรแกรมอีเมลจะแสดงที่นี่"
                  : "",
            ),
          ]),
    );
  }

  async function load(quiet = false) {
    try {
      const [, data, records] = await Promise.all([
        refreshFolders(ws, mailbox, token),
        ctx.api.get(
          `/api/mail/mailboxes/${mailbox.id}/messages?folder=${encodeURIComponent(folder)}&offset=${offset}&limit=${MAIL_PAGE_SIZE}`,
          { ttl: 0, force: true },
        ),
        // Sent only. Not for everyone (403) and not always available: no badges then.
        folder === "Sent"
          ? ctx.api
              .get(`/api/mail/mailboxes/${mailbox.id}/delivery?limit=100&hours=168`, { ttl: 0, force: true })
              .then((result) => result.records)
              .catch(() => null)
          : null,
      ]);
      if (!ws.alive(token)) return;
      delivery = records ? groupDelivery(records) : null;
      ws.delivery = delivery;
      ws.paintDelivery?.();
      // A page past the end (messages were deleted elsewhere) falls back to the first page.
      if (offset && !data.messages.length && data.total) return ws.show({ offset: 0 }, { replace: true });
      page = data;
      paint();
    } catch (error) {
      if (!ws.alive(token) || quiet) return;
      painted = "";
      rows.replaceChildren(failure(error, () => load()));
    }
  }

  const readerPane = h("section", { class: "mail-readerpane", "aria-label": "Message" });
  const split = h(
    "div",
    { class: "mail-split", "data-open": String(!!ws.location.message) },
    h(
      "section",
      { class: "mail-listpane", "aria-label": folderLabel(folder) },
      h(
        "header",
        { class: "mail-pane-head" },
        h("div", {}, title, summary),
        h(
          "div",
          { class: "actions" },
          range,
          newer,
          older,
          button(icon("refresh"), () => load(), "icon", { "aria-label": "โหลดอีเมลใหม่", title: "Refresh" }),
        ),
      ),
      h("div", { class: "mail-filter-bar" }, chips, filterNote, keysToggle),
      keysHelp,
      rows,
    ),
    readerPane,
  );
  // Choosing a message only swaps the reader and moves the current mark; the
  // list itself is neither rebuilt nor fetched again.
  const markCurrent = () => {
    for (const item of rows.querySelectorAll(".mail-row")) {
      const on = item.dataset.message === ws.location.message;
      item.classList.toggle("current", on);
      const anchor = item.querySelector(".mail-row-link");
      if (on) anchor.setAttribute("aria-current", "true");
      else anchor.removeAttribute("aria-current");
    }
  };
  ws.readerPane = readerPane;
  ws.reloadList = load;
  ws.select = () => {
    ws.readerToken += 1;
    ws.readerActions = null;
    ws.paintDelivery = null;
    split.dataset.open = String(!!ws.location.message);
    markCurrent();
    if (ws.location.message) void reader(ws, mailbox);
    else readerPane.replaceChildren(readerEmpty());
  };
  // Delete from the open message goes through the same path as the list, so the
  // next message opens instead of an empty pane.
  ws.deleteById = (id) => trash(page?.messages.find((item) => item.id === id) || { id });
  let deleting = false;
  // Called by the keyboard listener in mail.js. Returns true when it acted.
  ws.keys = (action) => {
    const shown = visible();
    const openId = ws.location.message;
    const current = page?.messages.find((item) => item.id === openId);
    const run = (work) =>
      void Promise.resolve(work).catch((error) =>
        ws.main.dispatchEvent(new CustomEvent("app-error", { bubbles: true, detail: error })),
      );
    switch (action) {
      case "compose":
        run(ws.composer.open());
        return true;
      case "next":
      case "prev": {
        if (!shown.length) return true;
        const at = shown.findIndex((item) => item.id === openId);
        const to = at < 0 ? shown[0] : shown[Math.min(shown.length - 1, Math.max(0, at + (action === "next" ? 1 : -1)))];
        if (to.id !== openId) {
          ws.show({ message: to.id });
          rows.querySelector(`[data-message="${CSS.escape(to.id)}"]`)?.scrollIntoView({ block: "nearest" });
        }
        return true;
      }
      case "reply":
      case "forward":
        if (ws.readerActions?.id !== openId || !openId) return false;
        run(ws.readerActions[action]());
        return true;
      case "star":
        if (!current) return false;
        run(flag(current, { flagged: !current.flagged }));
        return true;
      case "unread":
        if (!current) return false;
        run(
          flag(current, { seen: !current.seen }).then(() => {
            // Marking a message unread sends you back to the list, like the button does.
            if (!current.seen && ws.alive(token) && ws.location.message === current.id)
              ws.show({ message: "" }, { replace: true });
          }),
        );
        return true;
      case "delete":
        if (!current) return false;
        if (!deleting) {
          deleting = true;
          run(trash(current).finally(() => { deleting = false; }));
        }
        return true;
      case "close":
        if (!openId) return false;
        ws.show({ message: "" });
        void load(true);
        return true;
      default:
        return false;
    }
  };
  ws.main.replaceChildren(split);
  ws.listLive = true;
  rows.replaceChildren(loading("กำลังโหลดอีเมล…"));
  // New mail shows up by itself while the first page is open.
  ws.tick = offset === 0 ? () => load(true) : null;
  ws.select();
  await load();
}

const deliveryBadge = (summary) =>
  h("span", { class: `badge ${summary.tone} mail-delivery-badge`, title: "Delivery status" }, h("i"), summary.label);

// One line per recipient. Server text is put in as text nodes only.
const deliveryBlock = (records) => [
  h("small", {}, "Delivery"),
  h(
    "ul",
    { class: "mail-delivery-list" },
    ...records.map((record) =>
      h(
        "li",
        {},
        h("span", { class: `badge ${deliveryTone(record.status)}` }, h("i"), deliveryStatusLabel(record.status)),
        h("span", { class: "mail-delivery-who" }, record.recipient || "(unknown recipient)"),
        record.status !== "sent" &&
          h("span", { class: "muted" }, [reasonLabel(record.reasonCategory), record.reasonText ? ` · ${record.reasonText}` : ""].join("")),
        h("time", { class: "muted", dateTime: record.time }, formatMailDate(record.time)),
      ),
    ),
  ),
];

const readerEmpty = () =>
  h(
    "div",
    { class: "mail-reader-empty" },
    icon("mail"),
    h("p", {}, "Select a message to read it"),
  );

function messageBody(message, state, repaint) {
  if (message.html && state.mode === "html") {
    const frame = h("iframe", {
      class: "mail-frame",
      title: "เนื้อหาอีเมล",
      // No allow-scripts and no allow-same-origin: the sender's markup is inert and
      // has no access to this page. Links open in a new tab outside the sandbox.
      sandbox: "allow-popups allow-popups-to-escape-sandbox",
      referrerPolicy: "no-referrer",
      srcdoc: mailHtmlDocument(message.html, { images: state.images }),
    });
    return [
      hasRemoteContent(message.html) &&
        !state.images &&
        h(
          "p",
          { class: "notice mail-remote" },
          "รูปและเนื้อหาจากภายนอกถูกปิดไว้ เพื่อไม่ให้ผู้ส่งรู้ว่าคุณเปิดอ่าน ",
          button("แสดงรูป", () => { state.images = true; repaint(); }, "small"),
        ),
      h("div", { class: "mail-frame-card" }, frame),
    ];
  }
  const text = message.text || "";
  return h(
    "div",
    { class: "mail-text" },
    text
      ? linkify(text).map((part) =>
          part.href
            ? h("a", { href: part.href, target: "_blank", rel: "noopener noreferrer" }, part.text)
            : part.text,
        )
      : h("span", { class: "muted" }, "(อีเมลนี้ไม่มีข้อความ)"),
  );
}

async function reader(ws, mailbox) {
  const { ctx } = ws;
  const token = ws.token;
  const { folder, message: id } = ws.location;
  const reading = ws.readerToken;
  const live = () => ws.readerAlive(token, reading);
  const back = (replace = false) => {
    ws.show({ message: "" }, { replace });
    // The list shows flags and rows that this message may have changed.
    void ws.reloadList?.(true);
  };
  const backButton = button([icon("back"), h("span", {}, folderLabel(folder))], () => back(), "ghost");
  const pane = h("div", { class: "mail-reader" }, loading("กำลังเปิดอีเมล…"));
  ws.readerPane.replaceChildren(h("header", { class: "mail-reader-bar" }, backButton), pane);
  let message;
  try {
    message = (await ctx.api.get(messagePath(mailbox, id, folder), { ttl: 0, force: true })).message;
  } catch (error) {
    if (!live()) return;
    pane.replaceChildren(
      error.status === 404
        ? empty("ไม่พบอีเมลนี้", "อาจถูกย้ายหรือลบจากโปรแกรมอีเมลอื่นแล้ว", button(`กลับไป ${folderLabel(folder)}`, () => back(true), "primary"))
        : failure(error, () => reader(ws, mailbox)),
    );
    return;
  }
  if (!live()) return;
  if (!message.seen)
    void ctx.api
      .post(messagePath(mailbox, id, folder, "/flags"), { seen: true })
      .then(() => ws.reloadList?.(true))
      .catch(() => {});

  const own = addressOf(mailbox);
  const compose = (mode) => ws.composer.open({ ...replyDraft(message, own, mode, folder), from: mailbox.id });
  const move = async (to, done) => {
    await ctx.api.post(messagePath(mailbox, id, folder, "/move"), { to });
    ctx.toast(done);
    back(true);
  };
  const remove = async () => {
    if (
      folder === "Trash" &&
      !(await ctx.confirm("ลบอีเมลถาวร?", "อีเมลใน Trash ที่ลบแล้วกู้คืนไม่ได้", "ลบถาวร"))
    )
      return;
    // The list owns deletion so the next message opens afterwards.
    if (ws.deleteById) return ws.deleteById(id);
    await ctx.api.delete(messagePath(mailbox, id, folder));
    ctx.toast(folder === "Trash" ? "ลบอีเมลถาวรแล้ว" : "ย้ายไป Trash แล้ว");
    back(true);
  };
  ws.readerActions = { id, reply: () => compose("reply"), forward: () => compose("forward") };
  const unread = async () => {
    await ctx.api.post(messagePath(mailbox, id, folder, "/flags"), { seen: false });
    back(true);
  };
  const state = { mode: message.html ? "html" : "text", images: false };
  const manyRecipients = (message.to?.length || 0) + (message.cc?.length || 0) > 1;
  const body = h("div", { class: "mail-body" });
  const deliverySlot = h("section", { class: "mail-delivery", "aria-label": "Delivery", hidden: true });
  if (folder === "Sent") {
    ws.paintDelivery = () => {
      const records = ws.delivery?.get(normaliseMessageId(message.messageId));
      deliverySlot.hidden = !records?.length;
      deliverySlot.replaceChildren(...(records?.length ? deliveryBlock(records) : []));
    };
    ws.paintDelivery();
  }
  const paintBody = () => body.replaceChildren(messageBody(message, state, paintBody));

  pane.replaceChildren(
    h(
      "header",
      { class: "mail-reader-head" },
      h("h2", { class: "mail-subject" }, message.subject || "(ไม่มีหัวข้อ)"),
      h(
        "div",
        { class: "actions" },
        button([icon("reply"), h("span", {}, "Reply")], () => compose("reply")),
        manyRecipients && button("Reply all", () => compose("reply-all")),
        button([icon("forward"), h("span", {}, "Forward")], () => compose("forward")),
        ["Trash", "Junk"].includes(folder) &&
          button(folder === "Junk" ? "Not spam" : "Restore", () => move("INBOX", "ย้ายกลับ Inbox แล้ว")),
        button(icon("mail"), unread, "icon", { "aria-label": "ทำเครื่องหมายว่ายังไม่อ่าน", title: "ยังไม่อ่าน" }),
        button(icon("trash"), remove, "icon", { "aria-label": "ลบอีเมล", title: folder === "Trash" ? "ลบถาวร" : "ลบ" }),
      ),
    ),
    h(
      "div",
      { class: "mail-meta" },
      h("span", { class: "mail-avatar", "aria-hidden": "true" }, initials(message.from)),
      h(
        "div",
        { class: "mail-meta-text" },
        h(
          "div",
          {},
          h("strong", {}, personLabel(message.from)),
          message.from?.name && message.from.address && h("span", { class: "muted" }, ` <${message.from.address}>`),
        ),
        h("small", {}, "ถึง ", people(message.to) || "(ไม่ระบุ)", message.cc?.length ? [" · สำเนาถึง ", people(message.cc)] : null),
      ),
      h("time", { class: "muted", dateTime: message.date }, formatMailDateLong(message.date)),
    ),
    message.html &&
      message.text &&
      h(
        "div",
        { class: "segmented mail-mode", role: "group", "aria-label": "รูปแบบการแสดงผล" },
        ...[["html", "ต้นฉบับ"], ["text", "ข้อความล้วน"]].map(([mode, label]) =>
          h(
            "button",
            {
              type: "button",
              "aria-pressed": String(state.mode === mode),
              onclick: (event) => {
                state.mode = mode;
                for (const item of event.currentTarget.parentNode.children)
                  item.setAttribute("aria-pressed", String(item === event.currentTarget));
                paintBody();
              },
            },
            label,
          ),
        ),
      ),
    deliverySlot,
    body,
    message.attachments?.length > 0 &&
      h(
        "div",
        { class: "mail-attachments" },
        h("small", {}, `ไฟล์แนบ ${message.attachments.length} ไฟล์`),
        h(
          "div",
          { class: "chips" },
          ...message.attachments.map((file) =>
            h(
              "a",
              {
                class: "mail-file",
                href: messagePath(mailbox, id, folder, `/attachments/${file.index}`),
                download: file.filename,
              },
              icon("clip"),
              h("span", {}, h("b", {}, file.filename), h("small", {}, bytes(file.size))),
              icon("download"),
            ),
          ),
        ),
      ),
  );
  paintBody();
}

/**
 * One compose window for the whole Mail workspace, docked like a chat window so
 * the list stays readable behind it. It survives moving between folders and
 * views; leaving Mail with unsent text asks first.
 */
export function createComposer(ws) {
  const { ctx } = ws;
  let node = null;
  let dirty = false;
  const close = () => {
    node?.remove();
    node = null;
    dirty = false;
    ctx.dirty(false);
  };
  const discard = async () => {
    if (dirty && !(await ctx.confirm("ทิ้งอีเมลที่เขียนไว้?", "ข้อความที่ยังไม่ได้ส่งจะหายไป", "ทิ้ง"))) return false;
    close();
    return true;
  };
  const open = async (draft = {}) => {
    const mailboxes = ws.data.mail.mailboxes;
    if (!mailboxes.length) return ws.show({ view: "mailboxes" });
    if (node) {
      if (!Object.keys(draft).length) return node.querySelector("textarea").focus();
      if (!(await discard())) return;
    }
    const input = (name, label, props = {}) =>
      h("label", { class: "compose-line" }, h("span", {}, label), h("input", { name, autocomplete: "off", spellcheck: false, ...props }));
    const from = h(
      "select",
      { name: "from", "aria-label": "From" },
      ...mailboxes.map((mailbox) =>
        h("option", { value: mailbox.id, selected: mailbox.id === (draft.from || ws.mailbox()?.id) }, addressOf(mailbox)),
      ),
    );
    const copies = h(
      "div",
      { hidden: !draft.cc },
      input("cc", "Cc", { value: draft.cc || "", placeholder: "คั่นหลายที่อยู่ด้วยจุลภาค" }),
      input("bcc", "Bcc", { placeholder: "ผู้รับที่ซ่อนจากคนอื่น" }),
    );
    const text = h("textarea", { name: "text", "aria-label": "Message", placeholder: "เขียนข้อความ…", value: draft.text || "" });
    const status = h("small", { class: "compose-status", role: "status" });
    const send = h("button", { type: "submit", class: "btn primary" }, icon("send"), "Send");
    const title = draft.inReplyTo ? "Reply" : draft.subject ? "Forward" : "New message";
    const form = h(
      "form",
      {
        class: "mail-compose",
        "aria-label": title,
        oninput: () => {
          dirty = true;
          ctx.dirty(true);
        },
        onsubmit: async (event) => {
          event.preventDefault();
          if (send.disabled) return;
          const values = Object.fromEntries(new FormData(form));
          send.disabled = true;
          send.setAttribute("aria-busy", "true");
          status.textContent = "กำลังส่ง…";
          status.classList.remove("error");
          try {
            const result = await ctx.api.post(`/api/mail/mailboxes/${values.from}/send`, {
              to: values.to,
              cc: values.cc,
              bcc: values.bcc,
              subject: values.subject,
              text: values.text,
              inReplyTo: draft.inReplyTo,
              references: draft.references,
              answered: draft.answered,
            });
            close();
            ctx.toast(result.status === "simulated" ? "Sandbox: บันทึกใน Sent แล้ว ไม่ได้ส่งออกจริง" : "ส่งอีเมลแล้ว");
            if (!result.savedToSent) ctx.toast("ส่งแล้ว แต่เก็บสำเนาใน Sent ไม่สำเร็จ", true);
            void ws.tick?.();
          } catch (error) {
            status.textContent = error.message;
            status.classList.add("error");
          } finally {
            send.disabled = false;
            send.removeAttribute("aria-busy");
          }
        },
      },
      h(
        "header",
        { class: "compose-head" },
        h("strong", {}, title),
        h(
          "div",
          { class: "actions" },
          button(icon("minus"), () => form.toggleAttribute("data-minimized"), "icon", { "aria-label": "ย่อหรือขยายหน้าต่างเขียนอีเมล" }),
          button(icon("expand"), () => {
            form.removeAttribute("data-minimized");
            form.toggleAttribute("data-expanded");
          }, "icon compose-expand", { "aria-label": "Expand compose window", title: "Expand" }),
          button(icon("close"), () => discard(), "icon", { "aria-label": "ปิดและทิ้งอีเมล" }),
        ),
      ),
      h(
        "div",
        { class: "compose-body" },
        h("label", { class: "compose-line" }, h("span", {}, "From"), from),
        h(
          "div",
          { class: "compose-to" },
          input("to", "To", { value: draft.to || "", required: !draft.cc, placeholder: "name@example.com" }),
          button("Cc Bcc", (el) => { copies.hidden = false; el.remove(); copies.querySelector("input").focus(); }, "ghost small", { hidden: !!draft.cc }),
        ),
        copies,
        input("subject", "Subject", { value: draft.subject || "", maxLength: 500, spellcheck: true }),
        text,
      ),
      h(
        "footer",
        { class: "compose-foot" },
        send,
        status,
        button(icon("trash"), () => discard(), "icon", { "aria-label": "ทิ้งอีเมล", title: "ทิ้ง" }),
      ),
    );
    node = form;
    ctx.root.append(form);
    // A reply starts above the quoted text; a new message starts at the recipient.
    if (draft.to) {
      text.focus();
      text.setSelectionRange(0, 0);
      text.scrollTop = 0;
    } else form.querySelector('input[name="to"]').focus();
  };
  return { open, close, isOpen: () => !!node };
}
