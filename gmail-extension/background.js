const INGEST_ENDPOINT = "https://fivenines-ops.fly.dev/api/inbox/ingest";
const GMAIL_ORIGIN = "https://mail.google.com";

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

async function findGmailTab() {
  const activeCurrent = await chrome.tabs.query({
    active: true,
    currentWindow: true,
    url: "https://mail.google.com/*",
  });
  if (activeCurrent.length > 0 && activeCurrent[0]?.id) return activeCurrent[0];

  const existingCurrentWindow = await chrome.tabs.query({
    currentWindow: true,
    url: "https://mail.google.com/*",
  });
  if (existingCurrentWindow.length > 0 && existingCurrentWindow[0]?.id) return existingCurrentWindow[0];

  const activeAnyWindow = await chrome.tabs.query({
    active: true,
    url: "https://mail.google.com/*",
  });
  if (activeAnyWindow.length > 0 && activeAnyWindow[0]?.id) return activeAnyWindow[0];

  const anyGmail = await chrome.tabs.query({ url: "https://mail.google.com/*" });
  return anyGmail[0] || null;
}

async function sendToGmailTab(tabId, tabMessage) {
  try {
    return await chrome.tabs.sendMessage(tabId, tabMessage);
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["capture.js"],
    });
    return await chrome.tabs.sendMessage(tabId, tabMessage);
  }
}

async function runOnActiveGmail(tabMessage, fallbackError) {
  const tab = await findGmailTab();
  if (!tab?.id) {
    return { ok: false, error: "Open a Gmail email thread first." };
  }
  const res = await sendToGmailTab(tab.id, tabMessage);
  return res || { ok: false, error: fallbackError };
}

async function postInboxIngest(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: true, ingested: 0 };
  }
  if (typeof fetch !== "function") {
    return { ok: false, error: "fetch_unavailable" };
  }
  try {
    const res = await fetch(INGEST_ENDPOINT, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ items }),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `Inbox ingest returned HTTP ${res.status}` };
    }
    const body = await res.json().catch(() => ({}));
    return { ok: true, ingested: body?.ingested ?? items.length };
  } catch (err) {
    return { ok: false, error: err?.message || "Failed to sync Gmail inbox to Five Nines." };
  }
}

function resolveSafeGmailUrl(payload) {
  const data = payload && typeof payload === "object" ? payload : {};
  const rawUrl =
    typeof data.url === "string" && data.url.trim()
      ? data.url.trim()
      : typeof data.permalink === "string" && data.permalink.trim()
        ? data.permalink.trim()
        : "";

  if (rawUrl && rawUrl !== "#") {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { ok: false, error: "invalid_gmail_origin" };
    }
    if (parsed.protocol !== "https:" || parsed.origin !== GMAIL_ORIGIN) {
      return { ok: false, error: "invalid_gmail_origin" };
    }
    if (parsed.hash && parsed.hash !== "#") {
      return { ok: true, url: parsed.toString() };
    }
  }

  const rawThreadId = String(data.threadId || data.messageId || "")
    .trim()
    .replace(/^#?thread-[a-z]:/i, "");
  if (/^[0-9a-f]{15,16}$/i.test(rawThreadId) || /^FMfcgz[A-Za-z0-9_-]{10,}$/.test(rawThreadId)) {
    return { ok: true, url: `${GMAIL_ORIGIN}/mail/u/0/#inbox/${encodeURIComponent(rawThreadId)}` };
  }

  const query = String(data.query || data.subject || rawThreadId || "").trim();
  if (query) {
    return { ok: true, url: `${GMAIL_ORIGIN}/mail/u/0/#search/${encodeURIComponent(query)}` };
  }

  if (rawUrl && rawUrl !== "#") {
    return { ok: true, url: `${GMAIL_ORIGIN}/mail/u/0/#inbox` };
  }

  return { ok: false, error: "missing_gmail_target" };
}

async function openGmailThreadInTab(payload) {
  const resolved = resolveSafeGmailUrl(payload);
  if (!resolved.ok) {
    return resolved;
  }
  const targetUrl = resolved.url;
  const tab = await findGmailTab();
  if (tab?.id) {
    await chrome.tabs.update(tab.id, { url: targetUrl, active: true });
    return { ok: true, url: targetUrl, tabId: tab.id, created: false };
  }
  const created = await chrome.tabs.create({ url: targetUrl });
  return { ok: true, url: targetUrl, tabId: created?.id, created: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = message?.type;

  if (type === "CAPTURE_ACTIVE_GMAIL" || type === "PF_BG_CAPTURE_THREAD") {
    runOnActiveGmail({ type: "PF_CAPTURE" }, "No open email found in Gmail tab.")
      .then((res) => sendResponse(res))
      .catch((err) => {
        sendResponse({ ok: false, error: err?.message || "Failed to capture Gmail thread." });
      });
    return true;
  }

  if (type === "PF_AUTO_SYNC_INBOX") {
    const items = Array.isArray(message?.items) ? message.items : [];
    postInboxIngest(items)
      .then((res) => sendResponse(res))
      .catch((err) => {
        sendResponse({ ok: false, error: err?.message || "Failed to auto-sync inbox." });
      });
    return true;
  }

  if (type === "PF_BG_CAPTURE_INBOX") {
    (async () => {
      const res = await runOnActiveGmail(
        { type: "PF_CAPTURE_INBOX" },
        "Open Gmail (mail.google.com) to sync inbox threads.",
      );
      if (!res?.ok) {
        sendResponse(res);
        return;
      }
      const items = Array.isArray(res.payload?.items) ? res.payload.items : [];
      const ingestRes = await postInboxIngest(items);
      sendResponse({
        ok: true,
        ingested: ingestRes.ingested ?? items.length,
        ingestOk: ingestRes.ok,
        payload: { items },
      });
    })().catch((err) => {
      sendResponse({ ok: false, error: err?.message || "Failed to capture Gmail inbox." });
    });
    return true;
  }

  if (type === "PF_BG_OPEN_GMAIL_THREAD") {
    openGmailThreadInTab(message.payload || {})
      .then((res) => sendResponse(res))
      .catch((err) => {
        sendResponse({ ok: false, error: err?.message || "Failed to open Gmail thread." });
      });
    return true;
  }

  if (type === "PF_BG_CAPTURE_ATTACHMENTS") {
    runOnActiveGmail({ type: "PF_CAPTURE_ATTACHMENTS" }, "No attachments found in Gmail tab.")
      .then((res) => sendResponse(res))
      .catch((err) => {
        sendResponse({ ok: false, error: err?.message || "Failed to capture Gmail attachments." });
      });
    return true;
  }

  if (type === "PF_BG_INSERT_REPLY") {
    runOnActiveGmail(
      { type: "PF_INSERT_REPLY", payload: message.payload || {} },
      "Could not insert reply into Gmail compose box.",
    )
      .then((res) => sendResponse(res))
      .catch((err) => {
        sendResponse({ ok: false, error: err?.message || "Failed to insert into Gmail reply." });
      });
    return true;
  }

  return false;
});
