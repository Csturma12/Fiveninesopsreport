chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

async function findGmailTab() {
  const activeGmail = await chrome.tabs.query({
    active: true,
    currentWindow: true,
    url: "https://mail.google.com/*",
  });
  if (activeGmail.length > 0 && activeGmail[0]?.id) return activeGmail[0];

  const anyGmail = await chrome.tabs.query({ url: "https://mail.google.com/*" });
  return anyGmail[0] || null;
}

async function captureFromTab(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "PF_CAPTURE" });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["capture.js"],
    });
    return await chrome.tabs.sendMessage(tabId, { type: "PF_CAPTURE" });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "CAPTURE_ACTIVE_GMAIL") {
    (async () => {
      const tab = await findGmailTab();
      if (!tab?.id) {
        sendResponse({ ok: false, error: "Open a Gmail email thread first." });
        return;
      }
      const res = await captureFromTab(tab.id);
      sendResponse(res || { ok: false, error: "No open email found in Gmail tab." });
    })().catch((err) => {
      sendResponse({ ok: false, error: err?.message || "Failed to capture Gmail thread." });
    });
    return true;
  }
  return false;
});
