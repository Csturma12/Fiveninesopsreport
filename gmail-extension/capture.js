(() => {
  if (globalThis.__fiveninesCaptureReady) return;
  globalThis.__fiveninesCaptureReady = true;

  function isVisible(el) {
    if (!el || el.isConnected === false || el.hidden) return false;
    if (typeof el.getBoundingClientRect === "function") {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    return true;
  }

  function readText(el) {
    if (!el) return "";
    return String(el.innerText ?? el.textContent ?? "").trim();
  }

  function decodeSafe(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function inferMimeType(fileName, fallback) {
    const lower = String(fileName || "").toLowerCase();
    if (lower.endsWith(".pdf")) return "application/pdf";
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
    if (lower.endsWith(".webp")) return "image/webp";
    if (lower.endsWith(".gif")) return "image/gif";
    if (lower.endsWith(".csv")) return "text/csv";
    if (lower.endsWith(".txt")) return "text/plain";
    return fallback || "application/octet-stream";
  }

  function extensionForMime(mimeType) {
    const lower = String(mimeType || "").toLowerCase();
    if (lower.includes("pdf")) return "pdf";
    if (lower.includes("png")) return "png";
    if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
    if (lower.includes("webp")) return "webp";
    if (lower.includes("gif")) return "gif";
    if (lower.includes("csv")) return "csv";
    return "bin";
  }

  function parseDataUrl(raw) {
    if (typeof raw !== "string" || !raw.startsWith("data:")) return null;
    const commaIdx = raw.indexOf(",");
    if (commaIdx < 0) return null;
    const meta = raw.slice(5, commaIdx);
    const body = raw.slice(commaIdx + 1);
    const segments = meta.split(";");
    const mimeType = (segments[0] || "application/octet-stream").trim();
    const isBase64 = segments.some((s) => s.trim().toLowerCase() === "base64");
    return {
      mimeType,
      base64: isBase64 ? body : undefined,
      dataUrl: raw,
    };
  }

  function parseGmailDownloadUrlAttr(raw) {
    if (typeof raw !== "string" || !raw.trim()) return null;
    const firstColon = raw.indexOf(":");
    if (firstColon <= 0) return null;
    const secondColon = raw.indexOf(":", firstColon + 1);
    if (secondColon <= firstColon + 1) return null;
    const mimeType = raw.slice(0, firstColon).trim();
    const fileName = decodeSafe(raw.slice(firstColon + 1, secondColon).trim());
    const downloadUrl = raw.slice(secondColon + 1).trim();
    return { mimeType, fileName, downloadUrl };
  }

  function sanitizeDownloadUrl(rawUrl) {
    if (typeof rawUrl !== "string" || !rawUrl.trim()) return "";
    const trimmed = rawUrl.trim();
    if (trimmed.startsWith("data:") || trimmed.startsWith("blob:")) return trimmed;
    try {
      const parsed = new URL(trimmed, window.location.origin);
      if (
        parsed.protocol === "https:" &&
        (parsed.hostname === "mail.google.com" || parsed.hostname.endsWith(".googleusercontent.com"))
      ) {
        return parsed.toString();
      }
    } catch {
      return "";
    }
    return "";
  }

  function parseSizeBytes(sizeText, base64) {
    if (typeof base64 === "string" && base64.length > 0) {
      const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
      return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
    }
    const match = String(sizeText || "")
      .trim()
      .match(/^([\d.,]+)\s*(B|KB|MB|GB)\b/i);
    if (!match) return undefined;
    const num = Number.parseFloat(match[1].replace(/,/g, ""));
    if (!Number.isFinite(num)) return undefined;
    const unit = match[2].toUpperCase();
    if (unit === "GB") return Math.round(num * 1024 * 1024 * 1024);
    if (unit === "MB") return Math.round(num * 1024 * 1024);
    if (unit === "KB") return Math.round(num * 1024);
    return Math.round(num);
  }

  function extractAttachments(main) {
    const attachments = [];
    const seen = new Set();

    const addAttachment = (entry) => {
      const fileName = String(entry.fileName || "").trim();
      const downloadUrl = sanitizeDownloadUrl(entry.downloadUrl || "");
      const dataInfo = parseDataUrl(entry.dataUrl || (downloadUrl.startsWith("data:") ? downloadUrl : ""));
      if (!fileName && !dataInfo && !downloadUrl) return;

      const resolvedMime = inferMimeType(fileName, dataInfo?.mimeType || entry.mimeType);
      const resolvedName =
        fileName || `inline-attachment-${attachments.length + 1}.${extensionForMime(resolvedMime)}`;
      const dedupeKey = dataInfo?.dataUrl || downloadUrl || `${resolvedName}::${resolvedMime}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);

      const sizeBytes = parseSizeBytes(entry.sizeText, dataInfo?.base64);
      attachments.push({
        id: `att-${attachments.length + 1}`,
        filename: resolvedName,
        name: resolvedName,
        fileName: resolvedName,
        mimeType: resolvedMime,
        sizeText: entry.sizeText ? String(entry.sizeText).trim() : undefined,
        sizeBytes,
        downloadUrl: downloadUrl && !downloadUrl.startsWith("data:") ? downloadUrl : undefined,
        dataUrl: dataInfo?.dataUrl || undefined,
        dataBase64: dataInfo?.base64 || undefined,
        base64: dataInfo?.base64 || undefined,
        isInline: Boolean(entry.isInline),
      });
    };

    const downloadAttrNodes = [...main.querySelectorAll("[download_url]")];
    for (const node of downloadAttrNodes) {
      const parsed = parseGmailDownloadUrlAttr(node.getAttribute("download_url"));
      if (!parsed) continue;
      const sizeEl = node.querySelector?.(".SaH2Ve, .aYp");
      const inlineLink = node.querySelector?.('a[href^="data:"], img[src^="data:"]');
      const inlineData = inlineLink?.getAttribute("href") || inlineLink?.getAttribute("src") || "";
      addAttachment({
        fileName: parsed.fileName,
        mimeType: parsed.mimeType,
        downloadUrl: parsed.downloadUrl,
        dataUrl: inlineData,
        sizeText: readText(sizeEl),
        isInline: false,
      });
    }

    const chipNodes = [...main.querySelectorAll('.aZo, .aSH, a[download], [aria-label^="Attachment:" i]')];
    for (const chip of chipNodes) {
      if (chip.hasAttribute?.("download_url") || chip.closest?.("[download_url]")) continue;
      const nameNode = chip.querySelector?.(".aV3");
      const rawAria = chip.getAttribute?.("aria-label") || "";
      const ariaName = rawAria.replace(/^Attachment:\s*/i, "").trim();
      const fileName =
        readText(nameNode) ||
        (chip.getAttribute?.("download") || "").trim() ||
        ariaName ||
        (chip.getAttribute?.("data-tooltip") || "").trim();
      if (!fileName) continue;

      const anchor = chip.tagName === "A" ? chip : chip.querySelector?.("a[href]");
      const href = anchor?.getAttribute?.("href") || "";
      const sizeEl = chip.querySelector?.(".SaH2Ve, .aYp");
      addAttachment({
        fileName,
        mimeType: inferMimeType(fileName),
        downloadUrl: href,
        dataUrl: href.startsWith("data:") ? href : "",
        sizeText: readText(sizeEl),
        isInline: false,
      });
    }

    const inlineDataNodes = [
      ...main.querySelectorAll('.a3s img[src^="data:"], .a3s a[href^="data:"], embed[src^="data:"]'),
    ];
    for (const node of inlineDataNodes) {
      if (node.closest?.('[contenteditable="true"]')) continue;
      const rawData = node.getAttribute?.("src") || node.getAttribute?.("href") || "";
      if (!rawData.startsWith("data:")) continue;
      const label =
        (node.getAttribute?.("download") || "").trim() ||
        (node.getAttribute?.("alt") || "").trim() ||
        (node.getAttribute?.("title") || "").trim();
      addAttachment({
        fileName: label,
        dataUrl: rawData,
        isInline: true,
      });
    }

    return attachments;
  }

  function extractHexThreadId(raw) {
    const trimmed = String(raw || "").trim();
    return /^[0-9a-f]{15,16}$/i.test(trimmed) ? trimmed : "";
  }

  function buildGmailBasePrefix() {
    const origin = window.location?.origin || "https://mail.google.com";
    const pathname = window.location?.pathname || "/mail/u/0/";
    return `${origin}${pathname}`;
  }

  function captureInboxList() {
    const rows = [...document.querySelectorAll("tr.zA")].filter(isVisible);
    const items = [];
    const seen = new Set();
    const basePrefix = buildGmailBasePrefix();

    for (const row of rows) {
      if (items.length >= 40) break;

      const rawLegacy = (
        row.getAttribute?.("data-legacy-thread-id") ||
        row.querySelector?.("[data-legacy-thread-id]")?.getAttribute?.("data-legacy-thread-id") ||
        ""
      ).trim();
      const rawThreadAttr = (
        row.getAttribute?.("data-thread-id") ||
        row.querySelector?.("[data-thread-id]")?.getAttribute?.("data-thread-id") ||
        ""
      ).trim();
      const strippedThreadAttr = rawThreadAttr.replace(/^#?thread-[a-z]:/i, "").trim();

      const legacyHexId =
        extractHexThreadId(rawLegacy) ||
        (!/^#?thread-/i.test(rawThreadAttr) ? extractHexThreadId(strippedThreadAttr) : "");

      const threadId = legacyHexId || rawLegacy || strippedThreadAttr || "";

      const emailSpan = row.querySelector?.(".yW span[email], .yX span[email], span[email]");
      const senderEmail = (emailSpan?.getAttribute?.("email") || "").trim();
      const senderName = (
        emailSpan?.getAttribute?.("name") ||
        readText(emailSpan) ||
        readText(row.querySelector?.(".yW, .yX"))
      ).trim();
      const from =
        senderName && senderEmail && !senderName.includes(senderEmail)
          ? `${senderName} <${senderEmail}>`
          : senderEmail || senderName || "";

      const subject = readText(row.querySelector?.(".bog, .y6 span[id], .y6 span"));
      const rawSnippet = readText(row.querySelector?.(".y2"));
      const snippet = rawSnippet.replace(/^[\s\u00a0]*[-–—][\s\u00a0]*/, "").trim();

      const timeNode = row.querySelector?.(".xW.xY span[title], td.xW span[title], .xW span");
      const receivedAt = (
        timeNode?.getAttribute?.("title") ||
        readText(timeNode) ||
        new Date().toISOString()
      ).trim();

      const unread = Boolean(row.classList?.contains?.("zE"));

      if (!subject && !from && !snippet) continue;

      const permalink = legacyHexId
        ? `${basePrefix}#inbox/${legacyHexId}`
        : `${basePrefix}#search/${encodeURIComponent(subject || from)}`;

      const dedupeKey = threadId || `${subject}::${from}::${receivedAt}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      items.push({
        threadId: threadId || undefined,
        from,
        sender: senderEmail || from,
        senderName: senderName || undefined,
        subject,
        snippet,
        bodyText: snippet,
        receivedAt,
        timestamp: receivedAt,
        unread,
        permalink,
        source: "extension",
      });
    }

    return items;
  }

  function findMainThreadContainer() {
    const mains = [...document.querySelectorAll('[role="main"]')];
    return (
      mains.find(
        (el) =>
          isVisible(el) &&
          (el.querySelector("h2.hP") || el.querySelector("[data-message-id]") || el.querySelector(".a3s")),
      ) || document
    );
  }

  function captureOpenThread() {
    const main = findMainThreadContainer();

    const subjectEl = main.querySelector("h2.hP, [data-thread-perm-id] h2, h2[data-legacy-thread-id]");
    const subject = readText(subjectEl);

    const senderNodes = [...main.querySelectorAll('span[email], [data-hovercard-id*="@"]')].filter(isVisible);
    const lastSender = senderNodes[senderNodes.length - 1];
    const sender = (
      lastSender?.getAttribute("email") ||
      lastSender?.getAttribute("data-hovercard-id") ||
      ""
    ).trim();
    const senderName = (lastSender?.getAttribute("name") || readText(lastSender) || "").trim();

    const timeNodes = [...main.querySelectorAll("span.g3[title], span.g3, time[datetime], .gH span[title]")].filter(
      isVisible,
    );
    const lastTime = timeNodes[timeNodes.length - 1];
    const timestamp = (
      lastTime?.getAttribute("title") ||
      lastTime?.getAttribute("datetime") ||
      readText(lastTime) ||
      new Date().toISOString()
    ).trim();

    const msgNodes = [...main.querySelectorAll("[data-legacy-message-id], [data-message-id]")];
    const lastMsg = msgNodes[msgNodes.length - 1];
    const hashMatch = String(window.location?.hash || "").match(/\/([A-Za-z0-9_-]{8,})$/);
    const legacyThreadId = (
      subjectEl?.getAttribute?.("data-legacy-thread-id") ||
      main.querySelector?.("[data-legacy-thread-id]")?.getAttribute?.("data-legacy-thread-id") ||
      ""
    ).trim();
    const messageId = (
      lastMsg?.getAttribute("data-legacy-message-id") ||
      lastMsg?.getAttribute("data-message-id") ||
      legacyThreadId ||
      subjectEl?.getAttribute("data-thread-perm-id") ||
      (hashMatch ? hashMatch[1] : "")
    ).trim();

    const bodyNodes = [...main.querySelectorAll(".a3s.aiL, .a3s")].filter(
      (el) => isVisible(el) && !el.closest?.('[contenteditable="true"]'),
    );
    const joinedBodies = bodyNodes
      .map((n) => readText(n))
      .filter(Boolean)
      .join("\n\n---\n\n")
      .trim();

    const fallbackBody = !joinedBodies && subject ? readText(main).slice(0, 6000) : "";
    const attachments = extractAttachments(main);

    return {
      subject,
      sender,
      senderName,
      timestamp,
      threadId: legacyThreadId || extractHexThreadId(messageId) || undefined,
      messageId,
      bodyText: joinedBodies || fallbackBody,
      permalink: window.location.href,
      attachments,
      capturedAt: new Date().toISOString(),
    };
  }

  function collectCombinedInboxItems() {
    const listItems = captureInboxList();
    const open = captureOpenThread();
    const hasOpenThread = Boolean(open && (open.subject || open.bodyText));
    if (!hasOpenThread) {
      return listItems;
    }

    const basePrefix = buildGmailBasePrefix();
    const hashHexMatch = String(window.location?.hash || "").match(/\/([0-9a-f]{15,16})$/i);
    const legacyHexId =
      extractHexThreadId(open.threadId) ||
      extractHexThreadId(open.messageId) ||
      (hashHexMatch ? hashHexMatch[1] : "");

    const openPermalink = legacyHexId
      ? `${basePrefix}#inbox/${legacyHexId}`
      : typeof open.permalink === "string" &&
          open.permalink.startsWith("https://mail.google.com/") &&
          open.permalink.includes("#")
        ? open.permalink
        : `${basePrefix}#search/${encodeURIComponent(open.subject || open.sender || "")}`;

    const openFrom =
      open.senderName && open.sender && !open.senderName.includes(open.sender)
        ? `${open.senderName} <${open.sender}>`
        : open.sender || open.senderName || "";

    const openItem = {
      threadId: legacyHexId || open.threadId || open.messageId || undefined,
      messageId: open.messageId || undefined,
      from: openFrom,
      sender: open.sender || openFrom,
      senderName: open.senderName || undefined,
      subject: open.subject || "",
      snippet: String(open.bodyText || "").replace(/\s+/g, " ").trim().slice(0, 240),
      bodyText: open.bodyText || "",
      receivedAt: open.timestamp || open.capturedAt,
      timestamp: open.timestamp || open.capturedAt,
      unread: false,
      permalink: openPermalink,
      attachments: open.attachments || [],
      source: "extension",
    };

    const merged = [openItem];
    for (const rowItem of listItems) {
      if (merged.length >= 40) break;
      const sameById =
        openItem.threadId && rowItem.threadId && openItem.threadId === rowItem.threadId;
      const sameBySubject =
        openItem.subject &&
        rowItem.subject &&
        openItem.subject === rowItem.subject &&
        (!open.sender || rowItem.from.includes(open.sender));
      if (sameById || sameBySubject) {
        openItem.unread = rowItem.unread;
        if (!openItem.threadId && rowItem.threadId) openItem.threadId = rowItem.threadId;
        continue;
      }
      merged.push(rowItem);
    }

    return merged;
  }

  const AUTO_SYNC_MIN_INTERVAL_MS = 4000;
  let lastSyncedSignature = "";
  let lastSyncedAt = 0;
  let pendingSyncTimer = null;

  function computeInboxSignature(items) {
    return items
      .map((it) => `${it.threadId || it.subject}:${it.unread ? 1 : 0}:${(it.bodyText || "").length}`)
      .join("|");
  }

  function sendAutoSyncIfChanged(force) {
    pendingSyncTimer = null;
    const items = collectCombinedInboxItems();
    if (items.length === 0) return items;
    const signature = computeInboxSignature(items);
    if (!force && signature === lastSyncedSignature) return items;
    lastSyncedSignature = signature;
    lastSyncedAt = Date.now();
    try {
      const maybePromise = chrome.runtime.sendMessage({ type: "PF_AUTO_SYNC_INBOX", items });
      if (maybePromise && typeof maybePromise.catch === "function") {
        maybePromise.catch(() => {});
      }
    } catch {
      // Ignore invalidated extension runtime errors during reload
    }
    return items;
  }

  function scheduleDebouncedInboxSync(minDelayMs) {
    if (pendingSyncTimer !== null || typeof setTimeout !== "function") return;
    const elapsed = Date.now() - lastSyncedAt;
    const waitMs =
      lastSyncedAt === 0
        ? minDelayMs
        : Math.max(minDelayMs, AUTO_SYNC_MIN_INTERVAL_MS - elapsed);
    pendingSyncTimer = setTimeout(() => {
      sendAutoSyncIfChanged(false);
    }, waitMs);
  }

  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function sanitizeReplyHtml(rawHtml) {
    if (typeof DOMParser === "function") {
      const doc = new DOMParser().parseFromString(String(rawHtml || ""), "text/html");
      const blocked = doc.querySelectorAll("script, iframe, object, embed, link, meta, style, form");
      for (const node of blocked) node.remove();
      const all = doc.body.querySelectorAll("*");
      for (const el of all) {
        for (const attr of [...el.attributes]) {
          const name = attr.name.toLowerCase();
          const val = attr.value.trim().toLowerCase();
          if (name.startsWith("on") || ((name === "href" || name === "src") && val.startsWith("javascript:"))) {
            el.removeAttribute(attr.name);
          }
        }
      }
      return doc.body.innerHTML;
    }
    return escapeHtml(String(rawHtml || "").replace(/<[^>]*>/g, "")).replace(/\r?\n/g, "<br>");
  }

  function findComposeTextbox() {
    const editors = [...document.querySelectorAll('[role="textbox"][contenteditable="true"]')].filter(isVisible);
    if (editors.length === 0) return null;
    const bodyEditor = editors.find((el) => {
      const label = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("g_editable") || ""}`.toLowerCase();
      return label.includes("message body") || label.includes("reply") || label.includes("true");
    });
    return bodyEditor || editors[editors.length - 1];
  }

  function findReplyTriggerButton() {
    const candidates = [
      ...document.querySelectorAll('[role="button"], button, [role="link"]'),
    ].filter(isVisible);

    const exactReply = candidates.find((el) => {
      const aria = (el.getAttribute("aria-label") || "").trim();
      const tooltip = (el.getAttribute("data-tooltip") || "").trim();
      const text = readText(el);
      return (
        (/^reply\b/i.test(aria) && !/reply to all/i.test(aria)) ||
        (/^reply\b/i.test(tooltip) && !/reply to all/i.test(tooltip)) ||
        /^reply$/i.test(text)
      );
    });
    if (exactReply) return exactReply;

    return (
      candidates.find((el) => {
        const combined = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("data-tooltip") || ""} ${readText(el)}`;
        return /\breply\b/i.test(combined);
      }) || null
    );
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function dispatchEditorEvents(target) {
    const EventCtor = typeof Event === "function" ? Event : null;
    if (EventCtor && typeof target.dispatchEvent === "function") {
      target.dispatchEvent(new EventCtor("input", { bubbles: true, cancelable: true }));
      target.dispatchEvent(new EventCtor("change", { bubbles: true, cancelable: true }));
    }
  }

  async function insertIntoReply(payload) {
    const text = typeof payload?.text === "string" ? payload.text : "";
    const html = typeof payload?.html === "string" ? payload.html : "";
    const subject = typeof payload?.subject === "string" ? payload.subject.trim() : "";

    if (!text.trim() && !html.trim()) {
      return { ok: false, error: "Reply content cannot be empty." };
    }

    let editor = findComposeTextbox();
    if (!editor) {
      const replyBtn = findReplyTriggerButton();
      if (replyBtn && typeof replyBtn.click === "function") {
        replyBtn.click();
        for (let attempt = 0; attempt < 15; attempt += 1) {
          editor = findComposeTextbox();
          if (editor) break;
          await wait(80);
        }
      }
    }

    if (!editor) {
      return { ok: false, error: "Open a Gmail reply or compose box before inserting." };
    }

    editor.focus?.();

    const formattedHtml = html.trim()
      ? sanitizeReplyHtml(html)
      : escapeHtml(text).replace(/\r?\n/g, "<br>");

    const signatureOrQuote = editor.querySelector?.(".gmail_signature, .gmail_quote");
    if (signatureOrQuote && typeof document.createElement === "function" && editor.insertBefore) {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-pf-inserted", "true");
      wrapper.innerHTML = `${formattedHtml}<br><br>`;
      editor.insertBefore(wrapper, signatureOrQuote);
    } else {
      const existingHtml = String(editor.innerHTML || "").trim();
      editor.innerHTML = existingHtml ? `${formattedHtml}<br><br>${existingHtml}` : formattedHtml;
      if (typeof editor.textContent === "undefined" && text) {
        editor.textContent = text;
      }
    }

    dispatchEditorEvents(editor);

    if (subject) {
      const subjectInput = [...document.querySelectorAll('input[name="subjectbox"]')].find(isVisible);
      if (subjectInput && !String(subjectInput.value || "").trim()) {
        subjectInput.value = subject;
        dispatchEditorEvents(subjectInput);
      }
    }

    return { ok: true, message: "Inserted into Gmail reply" };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "PF_CAPTURE") {
      const payload = captureOpenThread();
      if (!payload.subject && !payload.bodyText && payload.attachments.length === 0) {
        sendResponse({ ok: false, error: "Open a Gmail conversation thread before capturing." });
        return false;
      }
      sendAutoSyncIfChanged(false);
      sendResponse({ ok: true, payload });
      return false;
    }

    if (message?.type === "PF_CAPTURE_INBOX") {
      const items = collectCombinedInboxItems();
      lastSyncedSignature = computeInboxSignature(items);
      lastSyncedAt = Date.now();
      sendResponse({ ok: true, payload: { items } });
      return false;
    }

    if (message?.type === "PF_CAPTURE_ATTACHMENTS") {
      const main = findMainThreadContainer();
      const attachments = extractAttachments(main);
      sendResponse({ ok: true, payload: { attachments } });
      return false;
    }

    if (message?.type === "PF_INSERT_REPLY") {
      insertIntoReply(message.payload || {})
        .then((res) => sendResponse(res))
        .catch((err) => {
          sendResponse({ ok: false, error: err?.message || "Failed to insert into Gmail reply." });
        });
      return true;
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
        const p = chrome.runtime.sendMessage({ type: "PF_GMAIL_THREAD_CHANGED", payload });
        if (p && typeof p.catch === "function") p.catch(() => {});
      }
      sendAutoSyncIfChanged(false);
    }, 350);
  };
  window.addEventListener("hashchange", notifyChange);

  if (typeof MutationObserver === "function" && (document.body || document.documentElement)) {
    const observer = new MutationObserver(() => {
      scheduleDebouncedInboxSync(AUTO_SYNC_MIN_INTERVAL_MS);
    });
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  scheduleDebouncedInboxSync(350);
})();
