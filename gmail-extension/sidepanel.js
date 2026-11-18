const PANEL_ORIGIN = "https://fivenines-ops.fly.dev";
const DEFAULT_PANEL_URL = "https://fivenines-ops.fly.dev/?panel=1";
const DASHBOARD_URL = "https://fivenines-ops.fly.dev/";
const GMAIL_ORIGIN = "https://mail.google.com";

const ALLOWED_STORAGE_KEYS = new Set(["pf_panel_zoom", "pf_ap_FilterQuery", "pf_ap_TaskConfig"]);
const MAX_STORAGE_VALUE_BYTES = 16384;

function sanitizeViewSlug(rawView) {
  if (typeof rawView !== "string") return "";
  const trimmed = rawView.trim();
  return /^[a-zA-Z0-9_-]{1,64}$/.test(trimmed) ? trimmed : "";
}

function buildPanelFrameUrl(searchString) {
  const url = new URL(DEFAULT_PANEL_URL);
  const params = new URLSearchParams(typeof searchString === "string" ? searchString : "");
  const view = sanitizeViewSlug(params.get("view"));
  if (view) {
    url.searchParams.set("view", view);
  }
  return url.toString();
}

function resolveSafeGmailTarget(payload) {
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

const frame = document.getElementById("toolkit-frame");
const reloadBtn = document.getElementById("btn-reload-frame");
const dashboardLink = document.getElementById("link-open-dashboard");

if (dashboardLink) {
  dashboardLink.setAttribute("href", DASHBOARD_URL);
}

if (frame) {
  const targetUrl = buildPanelFrameUrl(window.location?.search || "");
  if (frame.getAttribute("src") !== targetUrl) {
    frame.setAttribute("src", targetUrl);
    frame.src = targetUrl;
  }
}

if (reloadBtn && frame) {
  reloadBtn.addEventListener("click", () => {
    const currentSrc = frame.getAttribute("src") || frame.src || buildPanelFrameUrl(window.location?.search || "");
    frame.setAttribute("src", currentSrc);
    frame.src = currentSrc;
  });
}

function postToPanel(payload) {
  if (!frame || !frame.contentWindow) return;
  frame.contentWindow.postMessage(payload, PANEL_ORIGIN);
}

function sendRuntimeMessage(msg) {
  return new Promise((resolve) => {
    try {
      let settled = false;
      const finish = (reply) => {
        if (settled) return;
        settled = true;
        const runtimeErr = chrome?.runtime?.lastError?.message;
        if (runtimeErr && !reply) {
          resolve({ ok: false, error: runtimeErr });
          return;
        }
        resolve(reply || { ok: false, error: runtimeErr || "No response from extension service worker." });
      };
      const maybePromise = chrome.runtime.sendMessage(msg, (reply) => {
        finish(reply);
      });
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(finish).catch((err) => {
          finish({ ok: false, error: err?.message || "Extension runtime message failed." });
        });
      }
    } catch (err) {
      resolve({ ok: false, error: err?.message || "Extension runtime unavailable." });
    }
  });
}

function readAllowedStorage(keys) {
  for (const key of keys) {
    if (typeof key !== "string" || !ALLOWED_STORAGE_KEYS.has(key)) {
      return Promise.reject(new Error("disallowed_storage_key"));
    }
  }
  return new Promise((resolve, reject) => {
    try {
      let settled = false;
      const finish = (items, err) => {
        if (settled) return;
        settled = true;
        if (err) {
          reject(err);
          return;
        }
        resolve(items && typeof items === "object" ? items : {});
      };
      const maybePromise = chrome.storage.local.get(keys, (items) => {
        const lastErr = chrome?.runtime?.lastError;
        if (lastErr) {
          finish(null, new Error(lastErr.message || "storage_read_failed"));
          return;
        }
        finish(items || {}, null);
      });
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then((items) => finish(items || {}, null)).catch((err) => finish(null, err));
      }
    } catch (err) {
      reject(err);
    }
  });
}

function writeAllowedStorage(toWrite) {
  const keys = Object.keys(toWrite);
  if (keys.length === 0) {
    return Promise.reject(new Error("disallowed_storage_key"));
  }
  for (const key of keys) {
    if (!ALLOWED_STORAGE_KEYS.has(key)) {
      return Promise.reject(new Error("disallowed_storage_key"));
    }
  }
  return new Promise((resolve, reject) => {
    try {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        if (err) {
          reject(err);
          return;
        }
        resolve();
      };
      const maybePromise = chrome.storage.local.set(toWrite, () => {
        const lastErr = chrome?.runtime?.lastError;
        if (lastErr) {
          finish(new Error(lastErr.message || "storage_write_failed"));
          return;
        }
        finish(null);
      });
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(() => finish(null)).catch((err) => finish(err));
      }
    } catch (err) {
      reject(err);
    }
  });
}

async function handleStorageGet(data, requestId) {
  const singleKey =
    typeof data.key === "string"
      ? data.key
      : data.payload && typeof data.payload.key === "string"
        ? data.payload.key
        : null;

  if (singleKey !== null) {
    if (!ALLOWED_STORAGE_KEYS.has(singleKey)) {
      return {
        type: "PF_EXT_BRIDGE_RES",
        action: "storageGet",
        requestId,
        ok: false,
        error: "disallowed_storage_key",
      };
    }
    try {
      const stored = await readAllowedStorage([singleKey]);
      const value = Object.prototype.hasOwnProperty.call(stored, singleKey) ? stored[singleKey] : null;
      return {
        type: "PF_EXT_BRIDGE_RES",
        action: "storageGet",
        requestId,
        ok: true,
        key: singleKey,
        value,
        values: { [singleKey]: value },
        payload: { key: singleKey, value, values: { [singleKey]: value }, [singleKey]: value },
      };
    } catch (err) {
      return {
        type: "PF_EXT_BRIDGE_RES",
        action: "storageGet",
        requestId,
        ok: false,
        error: err?.message || "storage_read_failed",
      };
    }
  }

  const keyList = Array.isArray(data.keys)
    ? data.keys
    : Array.isArray(data.payload?.keys)
      ? data.payload.keys
      : null;

  if (!keyList || keyList.length === 0 || keyList.some((k) => typeof k !== "string" || !ALLOWED_STORAGE_KEYS.has(k))) {
    return {
      type: "PF_EXT_BRIDGE_RES",
      action: "storageGet",
      requestId,
      ok: false,
      error: "disallowed_storage_key",
    };
  }

  try {
    const stored = await readAllowedStorage(keyList);
    const values = {};
    for (const k of keyList) {
      values[k] = Object.prototype.hasOwnProperty.call(stored, k) ? stored[k] : null;
    }
    return {
      type: "PF_EXT_BRIDGE_RES",
      action: "storageGet",
      requestId,
      ok: true,
      values,
      payload: { values, ...values },
    };
  } catch (err) {
    return {
      type: "PF_EXT_BRIDGE_RES",
      action: "storageGet",
      requestId,
      ok: false,
      error: err?.message || "storage_read_failed",
    };
  }
}

async function handleStorageSet(data, requestId) {
  let entries = null;
  if (typeof data.key === "string") {
    entries = [[data.key, data.value]];
  } else if (
    data.payload &&
    typeof data.payload === "object" &&
    !Array.isArray(data.payload) &&
    typeof data.payload.key === "string"
  ) {
    entries = [[data.payload.key, data.payload.value]];
  } else if (data.items && typeof data.items === "object" && !Array.isArray(data.items)) {
    entries = Object.entries(data.items);
  } else if (data.payload?.items && typeof data.payload.items === "object" && !Array.isArray(data.payload.items)) {
    entries = Object.entries(data.payload.items);
  } else if (data.payload && typeof data.payload === "object" && !Array.isArray(data.payload)) {
    entries = Object.entries(data.payload);
  }

  if (!entries || entries.length === 0) {
    return {
      type: "PF_EXT_BRIDGE_RES",
      action: "storageSet",
      requestId,
      ok: false,
      error: "disallowed_storage_key",
    };
  }

  const toWrite = {};
  for (const [key, value] of entries) {
    if (typeof key !== "string" || !ALLOWED_STORAGE_KEYS.has(key)) {
      return {
        type: "PF_EXT_BRIDGE_RES",
        action: "storageSet",
        requestId,
        ok: false,
        error: "disallowed_storage_key",
      };
    }
    const serialized = JSON.stringify(value ?? null);
    if (serialized && serialized.length > MAX_STORAGE_VALUE_BYTES) {
      return {
        type: "PF_EXT_BRIDGE_RES",
        action: "storageSet",
        requestId,
        ok: false,
        error: "storage_value_too_large",
      };
    }
    toWrite[key] = value;
  }

  try {
    await writeAllowedStorage(toWrite);
    return {
      type: "PF_EXT_BRIDGE_RES",
      action: "storageSet",
      requestId,
      ok: true,
      payload: { saved: Object.keys(toWrite) },
    };
  } catch (err) {
    return {
      type: "PF_EXT_BRIDGE_RES",
      action: "storageSet",
      requestId,
      ok: false,
      error: err?.message || "storage_write_failed",
    };
  }
}

async function handleBridgeMessage(data) {
  const action = typeof data.action === "string" ? data.action : "";
  const requestId = data.requestId;

  switch (action) {
    case "captureThread": {
      const reply = await sendRuntimeMessage({ type: "PF_BG_CAPTURE_THREAD" });
      if (!reply?.ok) {
        return {
          type: "PF_EXT_BRIDGE_RES",
          action: "captureThread",
          requestId,
          ok: false,
          payload: null,
          error: reply?.error || "Failed to capture Gmail thread.",
        };
      }
      return {
        type: "PF_EXT_BRIDGE_RES",
        action: "captureThread",
        requestId,
        ok: true,
        payload: reply.payload || null,
      };
    }

    case "captureInbox": {
      const reply = await sendRuntimeMessage({ type: "PF_BG_CAPTURE_INBOX" });
      const items = Array.isArray(reply?.payload?.items)
        ? reply.payload.items
        : Array.isArray(reply?.items)
          ? reply.items
          : [];
      if (!reply?.ok) {
        return {
          type: "PF_EXT_BRIDGE_RES",
          action: "captureInbox",
          requestId,
          ok: false,
          payload: { items: [] },
          error: reply?.error || "Failed to capture Gmail inbox.",
        };
      }
      return {
        type: "PF_EXT_BRIDGE_RES",
        action: "captureInbox",
        requestId,
        ok: true,
        payload: { items },
      };
    }

    case "openGmailThread": {
      const rawPayload =
        data.payload && typeof data.payload === "object"
          ? data.payload
          : {
              url: data.url,
              permalink: data.permalink,
              threadId: data.threadId,
              messageId: data.messageId,
              query: data.query,
              subject: data.subject,
            };
      const resolved = resolveSafeGmailTarget(rawPayload);
      if (!resolved.ok) {
        return {
          type: "PF_EXT_BRIDGE_RES",
          action: "openGmailThread",
          requestId,
          ok: false,
          error: resolved.error || "invalid_gmail_origin",
        };
      }
      const reply = await sendRuntimeMessage({
        type: "PF_BG_OPEN_GMAIL_THREAD",
        payload: { ...rawPayload, url: resolved.url },
      });
      if (!reply?.ok) {
        return {
          type: "PF_EXT_BRIDGE_RES",
          action: "openGmailThread",
          requestId,
          ok: false,
          error: reply?.error || "Failed to open Gmail thread.",
        };
      }
      return {
        type: "PF_EXT_BRIDGE_RES",
        action: "openGmailThread",
        requestId,
        ok: true,
      };
    }

    case "captureAttachments": {
      const reply = await sendRuntimeMessage({ type: "PF_BG_CAPTURE_ATTACHMENTS" });
      const attachments = Array.isArray(reply?.payload?.attachments)
        ? reply.payload.attachments
        : Array.isArray(reply?.attachments)
          ? reply.attachments
          : [];
      if (!reply?.ok) {
        return {
          type: "PF_EXT_BRIDGE_RES",
          action: "captureAttachments",
          requestId,
          ok: false,
          payload: { attachments: [] },
          error: reply?.error || "Failed to capture Gmail attachments.",
        };
      }
      return {
        type: "PF_EXT_BRIDGE_RES",
        action: "captureAttachments",
        requestId,
        ok: true,
        payload: { attachments },
      };
    }

    case "insertReply": {
      const rawPayload =
        data.payload && typeof data.payload === "object"
          ? data.payload
          : { text: data.text, html: data.html, subject: data.subject };
      const reply = await sendRuntimeMessage({
        type: "PF_BG_INSERT_REPLY",
        payload: {
          text: typeof rawPayload.text === "string" ? rawPayload.text : "",
          html: typeof rawPayload.html === "string" ? rawPayload.html : undefined,
          subject: typeof rawPayload.subject === "string" ? rawPayload.subject : undefined,
        },
      });
      if (!reply?.ok) {
        return {
          type: "PF_EXT_BRIDGE_RES",
          action: "insertReply",
          requestId,
          ok: false,
          error: reply?.error || "Failed to insert into Gmail reply.",
        };
      }
      const message = reply.message || "Inserted into Gmail reply";
      return {
        type: "PF_EXT_BRIDGE_RES",
        action: "insertReply",
        requestId,
        ok: true,
        message,
        payload: { inserted: true, message },
      };
    }

    case "storageGet":
      return handleStorageGet(data, requestId);

    case "storageSet":
      return handleStorageSet(data, requestId);

    default:
      return {
        type: "PF_EXT_BRIDGE_RES",
        action,
        requestId,
        ok: false,
        error: "unsupported_bridge_action",
      };
  }
}

window.addEventListener("message", (event) => {
  if (event.origin !== PANEL_ORIGIN || event.source !== frame?.contentWindow) return;
  const data = event.data;
  if (!data || typeof data !== "object") return;

  if (data.type === "FIVENINES_CAPTURE_GMAIL_REQ") {
    sendRuntimeMessage({ type: "CAPTURE_ACTIVE_GMAIL" }).then((reply) => {
      const msg = {
        type: "FIVENINES_GMAIL_CAPTURED",
        requestId: data.requestId,
        ok: Boolean(reply?.ok),
        payload: reply?.ok ? reply.payload || null : null,
      };
      if (!reply?.ok) {
        msg.error = reply?.error || "Failed to capture Gmail thread.";
      }
      postToPanel(msg);
    });
    return;
  }

  if (data.type === "PF_EXT_BRIDGE") {
    handleBridgeMessage(data).then((response) => {
      postToPanel(response);
    });
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "PF_GMAIL_THREAD_CHANGED" && message.payload) {
    postToPanel({
      type: "FIVENINES_GMAIL_CONTEXT",
      payload: message.payload,
    });
    postToPanel({
      type: "PF_EXT_BRIDGE_EVENT",
      event: "threadChanged",
      payload: message.payload,
    });
    return;
  }

  if (message?.type === "PF_NAVIGATE_VIEW" && frame) {
    const view = sanitizeViewSlug(message.view);
    if (view) {
      const nextUrl = buildPanelFrameUrl(`?view=${encodeURIComponent(view)}`);
      frame.setAttribute("src", nextUrl);
      frame.src = nextUrl;
    }
  }
});
