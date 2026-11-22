// Mail: a mailbox reader (inbox, sent, compose) with domain, mailbox and server
// management beside it. First-time setup lives at /mail/setup.
import { h, link, icon, heading, panel, empty } from "../core/dom.js";
import {
  domainHealth,
  folderIcon,
  folderLabel,
  mailHref,
  mailLocation,
  mailShortcut,
} from "./mail/model.js";
import { wizard } from "./mail/setup.js";
import { domainsView, mailboxesView, serverView } from "./mail/manage.js";
import { createComposer, inboxView } from "./mail/client.js";

export { mailStepAvailable } from "./mail/model.js";

const REFRESH_MS = 30_000;

export async function mount(ctx) {
  return ctx.route.id === "mail-setup" ? wizard(ctx) : workspace(ctx);
}

async function workspace(ctx) {
  const data = await ctx.api.get("/api/mail", { ttl: 0, force: true });
  if (!ctx.active()) return;
  if (data.mail.configure?.status !== "configured") {
    ctx.root.replaceChildren(
      heading(
        "Mail",
        "รับ–ส่งอีเมลของโดเมนคุณจาก host นี้ และเปิดอ่านได้จากหน้านี้",
        link("Configure mail", "/mail/setup", "btn primary"),
      ),
      panel(
        "Set up mail on your infrastructure.",
        "ตรวจ connectivity ตั้ง hostname และวิธีส่ง แล้วเปิดใช้งาน service ครั้งเดียว",
        empty(
          "Mail service is not configured.",
          "หลังตั้งค่าเสร็จ หน้านี้จะเป็นกล่องอีเมล: อ่าน Inbox ดู Sent เขียนและตอบอีเมล รวมถึงเพิ่มหรือลบโดเมนได้ทันที",
          link("Start mail setup →", "/mail/setup", "btn primary"),
        ),
      ),
    );
    return;
  }

  // The mailbox is an app, not a page: it takes the viewport under the top bar.
  // The class lives on this screen's own root, and the attribute on the shared
  // container is removed by onDispose, so no other screen inherits the layout.
  const container = ctx.root.parentElement;
  ctx.root.classList.add("mail-fill");
  if (container) {
    container.dataset.fill = "mail";
    ctx.onDispose(() => {
      if (container.dataset.fill === "mail") delete container.dataset.fill;
    });
  }

  const side = h("aside", { class: "mail-side", "aria-label": "Mail" });
  const settingsHead = h("header", { class: "mail-settings-head" });
  const main = h("section", { class: "mail-main" });
  const app = h("div", { class: "mail-app", "data-mode": "mail" }, side, h("div", { class: "mail-stage" }, settingsHead, main));
  const ws = {
    ctx,
    data,
    main,
    folders: [],
    location: mailLocation(ctx.route.url),
    token: 0,
    // The open message has its own token: choosing another message must not
    // rebuild the list, only retire the reader that is still loading.
    readerToken: 0,
    tick: null,
    // Set while a message list is on screen and can swap its reader in place.
    listLive: false,
    select: null,
    reloadList: null,
    // Set by the message list: keyboard actions, delete-and-advance, and the
    // actions of the open message once it has loaded.
    keys: null,
    deleteById: null,
    readerActions: null,
    // A view checks this after every await: the reader may have moved on meanwhile.
    alive: (token) => ctx.active() && token === ws.token,
    readerAlive: (token, reader) => ws.alive(token) && reader === ws.readerToken,
    mailbox: () => {
      const boxes = ws.data.mail.mailboxes;
      return boxes.find((box) => box.id === ws.location.box) || boxes[0] || null;
    },
    refresh: async () => {
      ws.data = await ctx.api.get("/api/mail", { ttl: 0, force: true });
      sidebar();
    },
    show: (patch = {}, { replace = false } = {}) => {
      const next = { ...ws.location, ...patch };
      // Changing folder or mailbox starts at its newest message again.
      if ("folder" in patch || "box" in patch || "view" in patch)
        Object.assign(next, { offset: patch.offset || 0, message: patch.message || "" });
      if (next.view !== "inbox") Object.assign(next, { message: "" });
      // Opening or closing a message inside the same list keeps the list as it is.
      const inPlace =
        ws.listLive &&
        ws.location.view === "inbox" &&
        next.view === "inbox" &&
        ["box", "folder", "offset"].every((key) => next[key] === ws.location[key]);
      ws.location = next;
      ctx.locate(mailHref(next), { replace });
      if (inPlace) ws.select();
      else render();
    },
  };
  ws.sidebar = sidebar;
  ws.composer = createComposer(ws);

  const go = (patch) => (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    ws.show(patch);
  };
  const entry = (name, label, patch, { count, current, alert } = {}) => {
    const item = h(
      "a",
      { class: "mail-nav-item", href: mailHref({ ...ws.location, message: "", offset: 0, ...patch }), onclick: go(patch) },
      icon(name),
      h("span", {}, label),
      alert && h("i", { class: "mail-nav-alert", title: alert }),
      count > 0 && h("b", { class: "mail-nav-count" }, count > 999 ? "999+" : count),
    );
    if (current) item.setAttribute("aria-current", "page");
    return item;
  };

  const tab = (name, label, patch, { current, alert } = {}) => {
    const item = h(
      "a",
      { class: "mail-tab", href: mailHref({ ...ws.location, message: "", offset: 0, ...patch }), onclick: go(patch) },
      icon(name),
      h("span", {}, label),
      alert && h("i", { class: "mail-nav-alert", title: alert }),
    );
    if (current) item.setAttribute("aria-current", "page");
    return item;
  };

  let painted = "";
  function sidebar() {
    const mail = ws.data.mail;
    const { view, folder } = ws.location;
    const mailbox = ws.mailbox();
    const settings = view !== "inbox";
    app.dataset.mode = settings ? "settings" : "mail";
    const standard = ["INBOX", "Sent", "Drafts", "Junk", "Trash"];
    const known = new Map(ws.folders.map((item) => [item.id, item]));
    const folderIds = [...standard, ...ws.folders.map((item) => item.id).filter((id) => !standard.includes(id))];
    const unhealthy = mail.domains.filter((item) => domainHealth(item).id !== "ready").length;
    const alert = unhealthy ? `${unhealthy} โดเมนยังตั้ง DNS ไม่ครบ` : "";
    // Counts are refreshed in the background. Rebuilding identical links would
    // swallow a click that lands between a press and its release.
    const signature = JSON.stringify([view, folder, mailbox?.id, mail.mailboxes.map((box) => box.id), ws.folders, unhealthy]);
    if (signature === painted) return;
    painted = signature;
    side.replaceChildren(
      h(
        "button",
        {
          type: "button",
          class: "btn primary mail-compose-button",
          "aria-label": "Compose",
          disabled: !mailbox,
          onclick: () => ws.composer.open(),
        },
        icon("edit"),
        h("span", {}, "Compose"),
      ),
      mail.mailboxes.length > 1
        ? h(
            "select",
            {
              class: "mail-account",
              "aria-label": "Mailbox",
              onchange: (event) => ws.show({ view: "inbox", box: event.currentTarget.value, folder: "INBOX" }),
            },
            ...mail.mailboxes.map((box) =>
              h("option", { value: box.id, selected: box.id === mailbox?.id }, `${box.localPart}@${box.domain}`),
            ),
          )
        : mailbox && h("p", { class: "mail-account-name", title: "Mailbox" }, `${mailbox.localPart}@${mailbox.domain}`),
      h(
        "nav",
        { class: "mail-nav", "aria-label": "Folders" },
        ...folderIds.map((id) =>
          entry(folderIcon(id), folderLabel(id), { view: "inbox", folder: id }, {
            // Unread mail is what the reader acts on; Drafts shows how many are waiting.
            count: id === "Drafts" ? known.get(id)?.total : id === "Trash" ? 0 : known.get(id)?.unread,
            current: view === "inbox" && folder === id,
          }),
        ),
      ),
      h(
        "nav",
        { class: "mail-nav mail-nav-foot", "aria-label": "Settings" },
        entry("settings", "Mail settings", { view: "domains" }, { alert }),
      ),
    );
    settingsHead.replaceChildren(
      h(
        "a",
        {
          class: "btn ghost mail-back",
          href: mailHref({ ...ws.location, view: "inbox", message: "", offset: 0 }),
          onclick: go({ view: "inbox" }),
        },
        icon("back"),
        h("span", {}, "Back to mail"),
      ),
      h(
        "nav",
        { class: "mail-tabs", "aria-label": "Mail settings" },
        tab("globe", "Domains", { view: "domains" }, { current: view === "domains", alert }),
        tab("users", "Mailboxes", { view: "mailboxes" }, { current: view === "mailboxes" }),
        tab("server", "Server", { view: "server" }, { current: view === "server" }),
      ),
    );
  }

  function render() {
    ws.token += 1;
    ws.readerToken += 1;
    ws.tick = null;
    ws.listLive = false;
    ws.select = null;
    ws.reloadList = null;
    ws.keys = null;
    ws.deleteById = null;
    ws.readerActions = null;
    sidebar();
    const { view } = ws.location;
    if (view === "domains") domainsView(ws);
    else if (view === "mailboxes") mailboxesView(ws);
    else if (view === "server") serverView(ws);
    else void inboxView(ws);
  }

  // Keyboard shortcuts for the message list. One listener for the whole
  // workspace, removed with the screen; the list decides what each key does.
  const onKey = (event) => {
    if (!ws.keys || ws.location.view !== "inbox" || event.defaultPrevented) return;
    const action = mailShortcut(event);
    if (!action) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), .mail-compose")) return;
    if (document.querySelector("dialog[open]")) return;
    if (ws.keys(action)) event.preventDefault();
  };
  document.addEventListener("keydown", onKey);
  ctx.onDispose(() => document.removeEventListener("keydown", onKey));

  // The page heading is kept for assistive technology and the document title only.
  ctx.root.replaceChildren(h("h1", { class: "mail-title" }, "Mail"), app);
  render();
  // The unread count belongs in the sidebar on every view, not only on the inbox.
  if (ws.location.view !== "inbox" && ws.mailbox())
    void ctx.api
      .get(`/api/mail/mailboxes/${ws.mailbox().id}/folders`, { ttl: 0, force: true })
      .then((result) => {
        if (!ctx.active()) return;
        ws.folders = result.folders;
        sidebar();
      })
      .catch(() => {});
  ctx.poll(async () => {
    await ws.tick?.();
  }, REFRESH_MS);
}
