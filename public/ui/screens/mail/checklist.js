// Pure rules of the mail setup checklist: no DOM, so they run in tests as they do in the browser.
// Each row maps to one step of the old wizard, and `mailStepAvailable` still decides what is gated.
import { deliveryLabel } from "./parts.js";
import { domainHealth, mailStepAvailable } from "./model.js";

// Rows in dependency order. `step` is the number the old wizard used (`?step=`).
export const SETUP_ROWS = [
  { id: "ports", step: 1, title: "Connectivity" },
  { id: "identity", step: 2, title: "Identity" },
  { id: "delivery", step: 4, title: "Delivery mode" },
  { id: "dns", step: 3, title: "DNS records" },
  { id: "activate", step: 5, title: "Activate on host" },
  { id: "mailbox", step: 6, title: "First mailbox" },
  { id: "test", step: 7, title: "Send a test" },
];

// `?row=dns` or the old `?step=3` both name a row.
export function setupRowFromSearch(params) {
  const id = params.get("row");
  if (SETUP_ROWS.some((row) => row.id === id)) return id;
  const step = Number(params.get("step"));
  return SETUP_ROWS.find((row) => row.step === step)?.id || null;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const titleOf = (id) => SETUP_ROWS.find((row) => row.id === id).title;

// The first earlier requirement that is missing, for the "blocked by" line.
function blockedBy(id, mail) {
  const identity = () =>
    !mail.hostname
      ? ["identity", "Save the mail hostname first."]
      : !mail.domains?.length
        ? ["identity", "Add a mail domain first."]
        : null;
  const needs = {
    delivery: [identity],
    dns: [identity],
    activate: [identity, () => (!mail.outboundMode ? ["delivery", "Choose a delivery mode first."] : null)],
    mailbox: [() => (mail.configure?.status !== "configured" ? ["activate", "Activate the mail service first."] : null)],
    test: [
      () => (mail.configure?.status !== "configured" ? ["activate", "Activate the mail service first."] : null),
      () => (!mail.mailboxes?.length ? ["mailbox", "Create a mailbox first."] : null),
    ],
  }[id] || [];
  for (const need of needs) {
    const missing = need();
    if (missing) return `Blocked by ${titleOf(missing[0])}. ${missing[1]}`;
  }
  return "Blocked by an earlier row.";
}

function evaluate(id, mail, arrived) {
  const report = mail.readiness;
  if (id === "ports") {
    const open = (report?.outbound?.ports || []).filter((item) => item.status === "open");
    const shut = (report?.inbound?.ports || []).filter((item) => item.status === "blocked");
    if (!report?.checkedAt && !report?.outbound && !report?.inbound)
      return ["action", "Not checked yet"];
    if (!open.length) return ["action", "No outbound SMTP port is open"];
    if (shut.length) return ["action", `Inbound blocked on ${shut.map((item) => item.port).join(", ")}`];
    return ["ready", `Outbound open on ${open.map((item) => item.port).join(", ")}`];
  }
  if (id === "identity") {
    if (!mail.hostname) return ["action", "No mail hostname yet"];
    const domains = mail.domains?.length || 0;
    if (!domains) return ["action", `${mail.hostname} · no domain yet`];
    const needsPtr = mail.outboundMode === "direct" && mail.ptr?.status !== "verified";
    return [
      needsPtr ? "action" : "ready",
      `${mail.hostname} · ${plural(domains, "domain")}${needsPtr ? " · PTR not verified" : ""}`,
    ];
  }
  if (id === "delivery") {
    if (!mail.outboundMode) return ["action", "Not chosen yet"];
    if (mail.outboundMode !== "direct" && !mail.relay?.host)
      return ["action", `${deliveryLabel(mail.outboundMode)} · relay host missing`];
    return ["ready", deliveryLabel(mail.outboundMode)];
  }
  if (id === "dns") {
    const entries = mail.domains || [];
    if (!entries.length) return ["action", "No domain yet"];
    const unready = entries
      .map((entry) => [entry.domain, domainHealth(entry)])
      .filter(([, health]) => health.id !== "ready");
    if (!unready.length) return ["ready", `All records verified for ${plural(entries.length, "domain")}`];
    return ["action", unready.map(([domain, health]) => `${domain} ${health.id === "pending" ? "not checked" : health.label}`).join(" · ")];
  }
  if (id === "activate") {
    if (mail.configure?.status === "configured") return ["ready", "Configured on this host"];
    return ["action", "Not activated yet"];
  }
  if (id === "mailbox") {
    const boxes = mail.mailboxes || [];
    if (!boxes.length) return ["action", "No mailbox yet"];
    const first = `${boxes[0].localPart}@${boxes[0].domain}`;
    return ["ready", boxes.length > 1 ? `${first} +${boxes.length - 1}` : first];
  }
  if (arrived) return ["ready", "Arrived in Inbox"];
  const last = mail.lastTest;
  if (!last) return ["action", "No test sent yet"];
  return [last.status === "passed" ? "ready" : "action", `Last test ${last.status}: ${last.from} → ${last.to}`];
}

/**
 * The rows with their state: `ready`, `action` (needs the operator) or `blocked`
 * (an earlier row has to come first). A row is blocked exactly when the old
 * wizard step was unavailable.
 */
export function setupChecklist(mail, { arrived = false } = {}) {
  const rows = SETUP_ROWS.map((row) => {
    if (!mailStepAvailable(row.step, mail))
      return { ...row, state: "blocked", summary: "Waiting for an earlier row", blocker: blockedBy(row.id, mail) };
    const [state, summary] = evaluate(row.id, mail, arrived);
    return { ...row, state, summary, blocker: "" };
  });
  return {
    rows,
    ready: rows.filter((row) => row.state === "ready").length,
    total: rows.length,
    firstAction: rows.find((row) => row.state === "action")?.id || null,
  };
}
