/**
 * Keyless browser-to-extension postMessage bridge for the Gmail Side Panel iframe.
 * Never accesses extension APIs directly, never stores secrets or drafts, and strictly
 * restricts preference persistence to the 3 allowlisted UI keys.
 */

export type AllowedPanelPrefKey = "pf_panel_zoom" | "pf_ap_FilterQuery" | "pf_ap_TaskConfig";

export interface ApTaskConfigPref {
  autoMatchByPo: boolean;
  requirePodBeforeApproval: boolean;
  varianceThresholdUsd: number;
  defaultAssignee: string;
}

export interface PanelPrefValueMap {
  pf_panel_zoom: number;
  pf_ap_FilterQuery: string;
  pf_ap_TaskConfig: ApTaskConfigPref;
}

export const ALLOWED_PANEL_PREF_KEYS: ReadonlySet<AllowedPanelPrefKey> = new Set<AllowedPanelPrefKey>([
  "pf_panel_zoom",
  "pf_ap_FilterQuery",
  "pf_ap_TaskConfig",
]);

export interface CapturedGmailAttachment {
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  dataBase64?: string;
  downloadUrl?: string;
}

export interface CapturedGmailThread {
  subject: string;
  sender: string;
  timestamp: string;
  bodyText: string;
  permalink: string;
  messageId?: string;
  attachments: CapturedGmailAttachment[];
}

export interface CaptureThreadResult {
  ok: boolean;
  thread: CapturedGmailThread | null;
  outsideIframe?: boolean;
  error?: string;
}

export interface CaptureAttachmentsResult {
  ok: boolean;
  attachments: CapturedGmailAttachment[];
  outsideIframe?: boolean;
  error?: string;
}

export interface InsertGmailReplyInput {
  text: string;
  html?: string;
  subject?: string;
}

export interface InsertGmailReplyResult {
  ok: boolean;
  mode: "gmail" | "clipboard" | "none";
  message: string;
}

export function isInsideExtensionIframe(): boolean {
  try {
    return typeof window !== "undefined" && window.parent !== window;
  } catch {
    return true;
  }
}

function makeRequestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeAttachments(raw: unknown): CapturedGmailAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => ({
      filename: String(item.filename || item.fileName || item.name || "attachment"),
      mimeType: String(item.mimeType || item.type || "application/octet-stream"),
      sizeBytes: typeof item.sizeBytes === "number" ? item.sizeBytes : undefined,
      dataBase64: typeof item.dataBase64 === "string" ? item.dataBase64 : undefined,
      downloadUrl: typeof item.downloadUrl === "string" ? item.downloadUrl : undefined,
    }));
}

function normalizeThread(raw: unknown): CapturedGmailThread | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const subject = String(obj.subject || "").trim();
  const sender = String(obj.sender || obj.from || "").trim();
  const bodyText = String(obj.bodyText || obj.body || obj.text || "").trim();
  const timestamp = String(obj.timestamp || obj.received || "").trim();
  const permalink = String(obj.permalink || obj.url || "").trim();
  const messageId = obj.messageId ? String(obj.messageId) : undefined;
  const attachments = normalizeAttachments(obj.attachments);

  if (!subject && !bodyText && attachments.length === 0) return null;
  return {
    subject,
    sender,
    timestamp,
    bodyText,
    permalink,
    messageId,
    attachments,
  };
}

/**
 * Captures the open Gmail thread (subject, sender, timestamp, bodyText, permalink, attachments)
 * via PF_EXT_BRIDGE captureThread, while also accepting legacy FIVENINES_GMAIL_CAPTURED responses.
 */
export function captureGmailThread(timeoutMs = 4500): Promise<CaptureThreadResult> {
  if (!isInsideExtensionIframe()) {
    return Promise.resolve({
      ok: false,
      thread: null,
      outsideIframe: true,
      error: "Panel is running standalone outside Gmail — paste email text or pick an attachment below.",
    });
  }

  const requestId = makeRequestId("pf-cap");
  return new Promise<CaptureThreadResult>((resolve) => {
    let settled = false;
    const finish = (res: CaptureThreadResult) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
      resolve(res);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const data = event.data;
      if (!data || typeof data !== "object") return;

      const matchesBridge =
        data.type === "PF_EXT_BRIDGE_RES" &&
        data.action === "captureThread" &&
        (!data.requestId || data.requestId === requestId);
      const matchesLegacy =
        data.type === "FIVENINES_GMAIL_CAPTURED" && (!data.requestId || data.requestId === requestId);

      if (!matchesBridge && !matchesLegacy) return;

      const thread = normalizeThread(data.payload);
      if (!data.ok || !thread) {
        finish({
          ok: false,
          thread: null,
          error: String(data.error || "No open Gmail conversation detected."),
        });
        return;
      }
      finish({ ok: true, thread });
    };

    const timer = window.setTimeout(() => {
      // Try legacy capture message once before giving up if an older shell is loaded
      finish({
        ok: false,
        thread: null,
        error: "Timed out waiting for Gmail side-panel bridge — ensure a Gmail thread is open.",
      });
    }, timeoutMs);

    window.addEventListener("message", onMessage);
    window.parent.postMessage({ type: "PF_EXT_BRIDGE", action: "captureThread", requestId }, "*");
  });
}

/**
 * Captures attachment metadata and any inline base64 payloads from the active Gmail thread.
 */
export function captureGmailAttachments(timeoutMs = 4500): Promise<CaptureAttachmentsResult> {
  if (!isInsideExtensionIframe()) {
    return Promise.resolve({
      ok: false,
      attachments: [],
      outsideIframe: true,
      error: "Standalone browser tab — upload a PDF or image file directly.",
    });
  }

  const requestId = makeRequestId("pf-att");
  return new Promise<CaptureAttachmentsResult>((resolve) => {
    let settled = false;
    const finish = (res: CaptureAttachmentsResult) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
      resolve(res);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (
        data.type === "PF_EXT_BRIDGE_RES" &&
        data.action === "captureAttachments" &&
        (!data.requestId || data.requestId === requestId)
      ) {
        const rawList = Array.isArray(data.payload)
          ? data.payload
          : (data.payload as { attachments?: unknown } | undefined)?.attachments;
        finish({
          ok: Boolean(data.ok),
          attachments: normalizeAttachments(rawList),
          error: data.error ? String(data.error) : undefined,
        });
      }
    };

    const timer = window.setTimeout(() => {
      finish({
        ok: false,
        attachments: [],
        error: "Timed out reading Gmail attachments — download and select the file directly.",
      });
    }, timeoutMs);

    window.addEventListener("message", onMessage);
    window.parent.postMessage({ type: "PF_EXT_BRIDGE", action: "captureAttachments", requestId }, "*");
  });
}

async function copyFallback(text: string): Promise<InsertGmailReplyResult> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return {
        ok: true,
        mode: "clipboard",
        message: "Copied reply text to clipboard (paste into Gmail compose).",
      };
    }
  } catch {
    // Ignore clipboard permission errors in restricted contexts
  }
  return {
    ok: false,
    mode: "none",
    message: "Unable to reach Gmail reply editor or clipboard.",
  };
}

/**
 * Inserts a formatted quote, rate confirmation, BOL summary, or order confirmation into Gmail's
 * active reply box. Cleanly falls back to copying text to the clipboard when outside Gmail.
 */
export async function insertGmailReply(payload: InsertGmailReplyInput, timeoutMs = 3500): Promise<InsertGmailReplyResult> {
  if (!isInsideExtensionIframe()) {
    return copyFallback(payload.text);
  }

  const requestId = makeRequestId("pf-reply");
  const bridgeOutcome = await new Promise<{ ok: boolean; message?: string }>((resolve) => {
    let settled = false;
    const finish = (val: { ok: boolean; message?: string }) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
      resolve(val);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (
        data.type === "PF_EXT_BRIDGE_RES" &&
        data.action === "insertReply" &&
        (!data.requestId || data.requestId === requestId)
      ) {
        finish({
          ok: Boolean(data.ok),
          message: data.message ? String(data.message) : data.error ? String(data.error) : undefined,
        });
      }
    };

    const timer = window.setTimeout(() => {
      finish({ ok: false });
    }, timeoutMs);

    window.addEventListener("message", onMessage);
    window.parent.postMessage(
      {
        type: "PF_EXT_BRIDGE",
        action: "insertReply",
        requestId,
        payload: {
          text: payload.text,
          html: payload.html,
          subject: payload.subject,
        },
      },
      "*",
    );
  });

  if (bridgeOutcome.ok) {
    return {
      ok: true,
      mode: "gmail",
      message: bridgeOutcome.message || "Inserted directly into open Gmail reply!",
    };
  }

  return copyFallback(payload.text);
}

function readLocalAllowedPref<K extends AllowedPanelPrefKey>(key: K): PanelPrefValueMap[K] | null {
  if (!ALLOWED_PANEL_PREF_KEYS.has(key)) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return null;
    if (key === "pf_panel_zoom") {
      const parsed = Number(raw);
      return (Number.isFinite(parsed) ? parsed : null) as PanelPrefValueMap[K] | null;
    }
    if (key === "pf_ap_FilterQuery") {
      return raw as PanelPrefValueMap[K];
    }
    if (key === "pf_ap_TaskConfig") {
      const parsed = JSON.parse(raw) as ApTaskConfigPref;
      return (parsed && typeof parsed === "object" ? parsed : null) as PanelPrefValueMap[K] | null;
    }
  } catch {
    return null;
  }
  return null;
}

function writeLocalAllowedPref<K extends AllowedPanelPrefKey>(key: K, value: PanelPrefValueMap[K]): void {
  if (!ALLOWED_PANEL_PREF_KEYS.has(key)) return;
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    window.localStorage.setItem(key, serialized);
  } catch {
    // Ignore private-browsing quota errors
  }
}

/**
 * Reads one of the 3 strictly allowlisted panel preferences from the parent extension shell
 * with a clean local fallback for those exact 3 preference keys only.
 */
export async function getPanelPref<K extends AllowedPanelPrefKey>(
  key: K,
  fallback: PanelPrefValueMap[K],
): Promise<PanelPrefValueMap[K]> {
  if (!ALLOWED_PANEL_PREF_KEYS.has(key)) {
    throw new Error(`Disallowed panel preference key: ${String(key)}`);
  }

  if (isInsideExtensionIframe()) {
    const requestId = makeRequestId("pf-sget");
    const remoteVal = await new Promise<unknown>((resolve) => {
      let settled = false;
      const finish = (val: unknown) => {
        if (settled) return;
        settled = true;
        window.removeEventListener("message", onMessage);
        window.clearTimeout(timer);
        resolve(val);
      };

      const onMessage = (event: MessageEvent) => {
        if (event.source !== window.parent) return;
        const data = event.data;
        if (!data || typeof data !== "object") return;
        if (
          data.type === "PF_EXT_BRIDGE_RES" &&
          data.action === "storageGet" &&
          (!data.requestId || data.requestId === requestId)
        ) {
          if (data.ok && data.value !== undefined && data.value !== null) {
            finish(data.value);
          } else if (data.ok && data.payload && typeof data.payload === "object" && key in data.payload) {
            finish((data.payload as Record<string, unknown>)[key]);
          } else {
            finish(undefined);
          }
        }
      };

      const timer = window.setTimeout(() => finish(undefined), 700);
      window.addEventListener("message", onMessage);
      window.parent.postMessage({ type: "PF_EXT_BRIDGE", action: "storageGet", requestId, key }, "*");
    });

    if (remoteVal !== undefined && remoteVal !== null) {
      if (key === "pf_panel_zoom") {
        const n = Number(remoteVal);
        if (Number.isFinite(n)) return n as PanelPrefValueMap[K];
      } else if (key === "pf_ap_FilterQuery" && typeof remoteVal === "string") {
        return remoteVal as PanelPrefValueMap[K];
      } else if (key === "pf_ap_TaskConfig") {
        if (typeof remoteVal === "object") return remoteVal as PanelPrefValueMap[K];
        if (typeof remoteVal === "string") {
          try {
            return JSON.parse(remoteVal) as PanelPrefValueMap[K];
          } catch {
            // Fall through to local fallback
          }
        }
      }
    }
  }

  return readLocalAllowedPref(key) ?? fallback;
}

/**
 * Persists one of the 3 strictly allowlisted panel preferences via the parent extension shell
 * plus local fallback for those exact 3 preference keys only.
 */
export async function setPanelPref<K extends AllowedPanelPrefKey>(
  key: K,
  value: PanelPrefValueMap[K],
): Promise<boolean> {
  if (!ALLOWED_PANEL_PREF_KEYS.has(key)) {
    throw new Error(`Disallowed panel preference key: ${String(key)}`);
  }

  writeLocalAllowedPref(key, value);

  if (!isInsideExtensionIframe()) {
    return true;
  }

  const requestId = makeRequestId("pf-sset");
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
      resolve(ok);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (
        data.type === "PF_EXT_BRIDGE_RES" &&
        data.action === "storageSet" &&
        (!data.requestId || data.requestId === requestId)
      ) {
        finish(Boolean(data.ok));
      }
    };

    const timer = window.setTimeout(() => finish(true), 700);
    window.addEventListener("message", onMessage);
    window.parent.postMessage(
      { type: "PF_EXT_BRIDGE", action: "storageSet", requestId, key, value, payload: { key, value } },
      "*",
    );
  });
}

/**
 * Subscribes to passive Gmail thread change notifications (FIVENINES_GMAIL_CONTEXT / PF_GMAIL_CONTEXT
 * / FIVENINES_GMAIL_CAPTURED) pushed by the MV3 side-panel wrapper as the user navigates threads.
 */
export function subscribeGmailThreadContext(
  onContext: (ctx: Partial<CapturedGmailThread>) => void,
): () => void {
  const handler = (event: MessageEvent) => {
    if (isInsideExtensionIframe() && event.source !== window.parent) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;

    if (
      (data.type === "FIVENINES_GMAIL_CONTEXT" || data.type === "PF_GMAIL_CONTEXT") &&
      data.payload &&
      typeof data.payload === "object"
    ) {
      const p = data.payload as Record<string, unknown>;
      onContext({
        subject: p.subject ? String(p.subject) : undefined,
        sender: p.sender || p.from ? String(p.sender || p.from) : undefined,
        timestamp: p.timestamp ? String(p.timestamp) : undefined,
        bodyText: p.bodyText ? String(p.bodyText) : undefined,
        permalink: p.permalink ? String(p.permalink) : undefined,
        attachments: normalizeAttachments(p.attachments),
      });
    }

    if (data.type === "FIVENINES_GMAIL_CAPTURED" && data.ok && data.payload) {
      const thread = normalizeThread(data.payload);
      if (thread) onContext(thread);
    }
  };

  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}
