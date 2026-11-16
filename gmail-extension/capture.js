(() => {
  if (globalThis.__fiveninesCaptureReady) return;
  globalThis.__fiveninesCaptureReady = true;

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function captureOpenThread() {
    const main =
      [...document.querySelectorAll('[role="main"]')].find((el) => isVisible(el) && el.querySelector("h2.hP")) ||
      document;

    const subjectEl = main.querySelector("h2.hP");
    const subject = (subjectEl?.innerText || subjectEl?.textContent || "").trim();

    const senderNodes = [...main.querySelectorAll("span[email]")].filter(isVisible);
    const lastSender = senderNodes[senderNodes.length - 1];
    const sender = (lastSender?.getAttribute("email") || "").trim();
    const senderName = (lastSender?.getAttribute("name") || lastSender?.innerText || "").trim();

    const bodyNodes = [...main.querySelectorAll(".a3s.aiL, .a3s")].filter(
      (el) => isVisible(el) && !el.closest('[contenteditable="true"]'),
    );
    const bodyText = bodyNodes
      .map((n) => (n.innerText || n.textContent || "").trim())
      .filter(Boolean)
      .join("\n\n---\n\n")
      .trim();

    return {
      subject,
      sender,
      senderName,
      bodyText: bodyText || (main.innerText || "").slice(0, 6000),
      permalink: window.location.href,
      capturedAt: new Date().toISOString(),
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "PF_CAPTURE") {
      const payload = captureOpenThread();
      if (!payload.subject && !payload.bodyText) {
        sendResponse({ ok: false, error: "Open a Gmail conversation thread before capturing." });
        return false;
      }
      sendResponse({ ok: true, payload });
      return false;
    }
    return false;
  });

  let lastUrl = window.location.href;
  const notifyChange = () => {
    if (window.location.href === lastUrl) return;
    lastUrl = window.location.href;
    setTimeout(() => {
      const payload = captureOpenThread();
      if (payload.subject) {
        chrome.runtime.sendMessage({ type: "PF_GMAIL_THREAD_CHANGED", payload }).catch(() => {});
      }
    }, 350);
  };
  window.addEventListener("hashchange", notifyChange);
})();
