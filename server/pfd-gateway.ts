import { Readable } from "node:stream";
import type { Express, Request, Response } from "express";
import { PFD_API_PREFIXES } from "../shared/pfd-endpoints";

/**
 * Primary Freight Dashboard gateway.
 *
 * Every staff API on the primary-freight-dashboard Fly app is reachable from
 * this app at `/api/pfd/<path>`, which forwards to `<PFD_BASE_URL>/api/<path>`.
 * The dashboard keeps its data in a SQLite file on its own Fly volume, so the
 * endpoints are served by the dashboard itself rather than copied here.
 *
 * Trust model: this app has already verified the staff Google identity (the
 * auth middleware sets req.staffUser and 401s unauthenticated /api/* calls).
 * The gateway sends a shared secret (`PFD_GATEWAY_TOKEN`, the same value set on
 * both Fly apps) plus the acting staff email. The browser's cookies and
 * Authorization header are never forwarded.
 */

export const PFD_GATEWAY_MOUNT = "/api/pfd";
export const PFD_TOKEN_HEADER = "x-ops-gateway-token";
export const PFD_ACTING_USER_HEADER = "x-ops-acting-user";
export const PFD_ACTING_NAME_HEADER = "x-ops-acting-name";
export const MIN_GATEWAY_TOKEN_LENGTH = 32;

/** Request headers copied to the dashboard. Everything else is dropped. */
const FORWARDED_REQUEST_HEADERS = ["accept", "accept-language", "content-type", "if-none-match", "last-event-id"];
/** Response headers copied back to the browser. Cache-Control is not copied: staff data stays no-store. */
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-disposition",
  "etag",
  "last-modified",
  "x-shipments-version",
];

export interface PfdGatewayConfig {
  baseUrl: string;
  token: string;
  timeoutMs: number;
}

export type PfdGatewayConfigResult =
  | { ok: true; config: PfdGatewayConfig }
  | { ok: false; missing: string[]; problems: string[] };

export function readPfdGatewayConfig(env: NodeJS.ProcessEnv = process.env): PfdGatewayConfigResult {
  const baseUrl = String(env.PFD_BASE_URL || "").trim().replace(/\/+$/, "");
  const token = String(env.PFD_GATEWAY_TOKEN || "").trim();
  const missing: string[] = [];
  const problems: string[] = [];
  if (!baseUrl) missing.push("PFD_BASE_URL");
  if (!token) missing.push("PFD_GATEWAY_TOKEN");
  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") problems.push("PFD_BASE_URL must be http(s)");
      // Plain http is only acceptable on Fly's private network or localhost.
      if (
        url.protocol === "http:" &&
        !/\.(internal|flycast)$/.test(url.hostname) &&
        !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
      ) {
        problems.push("PFD_BASE_URL must use https outside Fly's private network");
      }
    } catch {
      problems.push("PFD_BASE_URL is not a valid URL");
    }
  }
  if (token && token.length < MIN_GATEWAY_TOKEN_LENGTH) {
    problems.push(`PFD_GATEWAY_TOKEN must be at least ${MIN_GATEWAY_TOKEN_LENGTH} characters`);
  }
  if (missing.length || problems.length) return { ok: false, missing, problems };
  const configuredTimeoutMs = Number(env.PFD_GATEWAY_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
      ? Math.min(configuredTimeoutMs, 2_147_483_647)
      : 60_000;
  return { ok: true, config: { baseUrl, token, timeoutMs } };
}

/**
 * Maps the part after `/api/pfd/` to the dashboard path. Returns null for
 * anything that could escape `/api/` (dot segments, encoded slashes, schemes).
 */
export function upstreamApiPath(rest: string): string | null {
  if (!rest || rest.length > 2048) return null;
  if (/[\\\r\n\0]/.test(rest)) return null;
  if (/%2f|%5c|%2e/i.test(rest)) return null;
  const segments = rest.split("/");
  if (segments.some((s) => s === "." || s === ".." || s === "")) return null;
  return `/api/${rest}`;
}

export function isKnownPfdApiPath(apiPath: string): boolean {
  return PFD_API_PREFIXES.some((prefix) => apiPath === prefix || apiPath.startsWith(`${prefix}/`));
}

function forwardableIdentity(req: Request): { email: string; name: string } | null {
  const user = req.staffUser;
  if (!user?.email) return null;
  // The local-dev placeholder is not a verified identity; never vouch for it in production.
  if (user.mode === "local_dev" && process.env.NODE_ENV === "production") return null;
  return { email: user.email.trim().toLowerCase(), name: user.name || user.email };
}

export interface RegisterPfdGatewayOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export function registerPfdGateway(app: Express, options: RegisterPfdGatewayOptions = {}): void {
  const env = options.env ?? process.env;
  const doFetch = options.fetchImpl ?? fetch;

  app.get(`${PFD_GATEWAY_MOUNT}/_status`, async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const result = readPfdGatewayConfig(env);
    if (!result.ok) {
      res.status(503).json({ ok: false, configured: false, missing: result.missing, problems: result.problems });
      return;
    }
    if (!forwardableIdentity(req)) {
      res.status(401).json({ ok: false, message: "Sign in to use the dashboard gateway." });
      return;
    }
    try {
      const upstream = await doFetch(`${result.config.baseUrl}/healthz`, {
        signal: AbortSignal.timeout(Math.min(result.config.timeoutMs, 10_000)),
      });
      await upstream.body?.cancel().catch(() => {});
      res.json({ ok: upstream.ok, configured: true, upstreamStatus: upstream.status, prefixes: PFD_API_PREFIXES.length });
    } catch (error) {
      res.status(502).json({ ok: false, configured: true, message: `Dashboard unreachable: ${(error as Error).message}` });
    }
  });

  app.get(`${PFD_GATEWAY_MOUNT}/_endpoints`, (_req: Request, res: Response) => {
    res.json({ mount: PFD_GATEWAY_MOUNT, upstreamPrefix: "/api", prefixes: PFD_API_PREFIXES });
  });

  app.all(`${PFD_GATEWAY_MOUNT}/{*rest}`, async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const result = readPfdGatewayConfig(env);
    if (!result.ok) {
      res.status(503).json({
        ok: false,
        message: "Primary Freight Dashboard gateway is not configured.",
        missing: result.missing,
        problems: result.problems,
      });
      return;
    }
    const identity = forwardableIdentity(req);
    if (!identity) {
      res.status(401).json({ ok: false, message: "Sign in to use the dashboard gateway." });
      return;
    }

    const rawRest = req.originalUrl.slice(PFD_GATEWAY_MOUNT.length + 1).split("?")[0] ?? "";
    const apiPath = upstreamApiPath(rawRest);
    if (!apiPath) {
      res.status(400).json({ ok: false, message: "Invalid dashboard path." });
      return;
    }
    if (!isKnownPfdApiPath(apiPath)) {
      res.status(404).json({ ok: false, message: `No dashboard endpoint under ${apiPath}.` });
      return;
    }

    const queryIndex = req.originalUrl.indexOf("?");
    const query = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : "";
    const target = `${result.config.baseUrl}${apiPath}${query}`;

    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
    headers.set(PFD_TOKEN_HEADER, result.config.token);
    headers.set(PFD_ACTING_USER_HEADER, identity.email);
    headers.set(PFD_ACTING_NAME_HEADER, encodeURIComponent(identity.name));

    const method = req.method.toUpperCase();
    let body: BodyInit | undefined;
    let duplex: "half" | undefined;
    if (method !== "GET" && method !== "HEAD") {
      if (req.body !== undefined && req.is("application/json")) {
        // express.json() already consumed the stream; re-serialise it.
        body = JSON.stringify(req.body);
        headers.set("content-type", "application/json");
      } else if (!req.readableEnded) {
        // Multipart uploads, CSV imports and other raw bodies stream straight through.
        body = Readable.toWeb(req) as unknown as BodyInit;
        duplex = "half";
        const length = req.headers["content-length"];
        if (typeof length === "string") headers.set("content-length", length);
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), result.config.timeoutMs);
    res.on("close", () => {
      if (!res.writableFinished) controller.abort(new Error("client closed"));
    });

    let upstream: globalThis.Response;
    try {
      upstream = await doFetch(target, {
        method,
        headers,
        body,
        redirect: "manual",
        signal: controller.signal,
        ...(duplex ? { duplex } : {}),
      } as RequestInit);
    } catch (error) {
      clearTimeout(timer);
      if (res.headersSent || res.destroyed) return;
      const timedOut = controller.signal.aborted && String(controller.signal.reason?.message) === "timeout";
      res.status(timedOut ? 504 : 502).json({
        ok: false,
        message: timedOut ? "Primary Freight Dashboard timed out." : "Primary Freight Dashboard is unreachable.",
      });
      return;
    }

    // The deadline bounds the wait for response headers. A confirmed event
    // stream is long-lived by design, so it is released only once it arrives.
    if (String(upstream.headers.get("content-type") || "").includes("text/event-stream")) clearTimeout(timer);

    res.status(upstream.status);
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    if (upstream.status >= 300 && upstream.status < 400 && upstream.status !== 304) {
      // Never bounce the browser to the dashboard's own sign-in pages.
      clearTimeout(timer);
      res.status(502).json({ ok: false, message: "Dashboard redirected the gateway request; check PFD_GATEWAY_TOKEN." });
      return;
    }
    if (!upstream.body || method === "HEAD" || upstream.status === 304) {
      clearTimeout(timer);
      res.end();
      return;
    }
    try {
      const stream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
      stream.on("error", () => res.destroy());
      stream.on("end", () => clearTimeout(timer));
      stream.pipe(res);
    } catch {
      clearTimeout(timer);
      res.end();
    }
  });
}
