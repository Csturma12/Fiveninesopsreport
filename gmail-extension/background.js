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
