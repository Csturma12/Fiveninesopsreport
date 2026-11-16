const PANEL_ORIGIN = "https://fivenines-ops.fly.dev";
const frame = document.getElementById("toolkit-frame");

window.addEventListener("message", (event) => {
  if (event.origin !== PANEL_ORIGIN || event.source !== frame?.contentWindow) return;
  const data = event.data;
  if (!data || data.type !== "FIVENINES_CAPTURE_GMAIL_REQ") return;

  chrome.runtime.sendMessage({ type: "CAPTURE_ACTIVE_GMAIL" }, (reply) => {
    const err = chrome.runtime.lastError?.message || reply?.error;
    frame?.contentWindow?.postMessage(
      {
        type: "FIVENINES_GMAIL_CAPTURED",
        requestId: data.requestId,
        ok: Boolean(reply?.ok),
        payload: reply?.payload || null,
        error: err || undefined,
      },
      PANEL_ORIGIN,
    );
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "PF_GMAIL_THREAD_CHANGED" && message.payload && frame?.contentWindow) {
    frame.contentWindow.postMessage(
      {
        type: "FIVENINES_GMAIL_CONTEXT",
        payload: message.payload,
      },
      PANEL_ORIGIN,
    );
  }
});
