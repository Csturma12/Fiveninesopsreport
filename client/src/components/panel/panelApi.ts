import type { PanelSessionInfo } from "./panelTypes";

export interface PanelApiContext {
  expectedEmail?: string;
  csrfToken?: string;
  onAccountChanged?: (message: string) => void;
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function panelFetchJson<T = Record<string, unknown>>(
  url: string,
  init: RequestInit = {},
  ctx?: PanelApiContext,
): Promise<{ status: number; ok: boolean; data: T }> {
  const method = String(init.method || "GET").toUpperCase();
  const headers = new Headers(init.headers || {});

  if (init.body && typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (ctx?.expectedEmail) {
    headers.set("x-gmail-panel-expected-email", ctx.expectedEmail);
  }
  if (ctx?.csrfToken && MUTATING_METHODS.has(method)) {
    headers.set("x-csrf-token", ctx.csrfToken);
  }

  const res = await fetch(url, {
    ...init,
    method,
    headers,
    credentials: "include",
  });

  const parsed = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };

  if (res.status === 409 && parsed?.error === "toolkit_account_changed") {
    ctx?.onAccountChanged?.(
      parsed.message || "Signed-in Google Workspace account changed in another tab — please refresh session.",
    );
  }

  return {
    status: res.status,
    ok: res.ok,
    data: parsed,
  };
}

export async function fetchPanelSession(): Promise<PanelSessionInfo | null> {
  try {
    const res = await fetch("/api/gmail-panel/session", { credentials: "include" });
    if (!res.ok) return null;
    const json = (await res.json()) as PanelSessionInfo;
    return json;
  } catch {
    return null;
  }
}
