import crypto from "node:crypto";
import type { Express, Request, Response, NextFunction } from "express";
import { isStaffGoogleIdentity } from "../shared/staff-domains";

export interface StaffUser {
  email: string;
  name: string;
  mode: "google_oauth" | "bearer_token" | "local_dev";
}

declare global {
  namespace Express {
    interface Request {
      staffUser?: StaffUser;
    }
  }
}

export const COOKIE_NAME = "fivenines_staff_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Server-only in-memory OAuth access token cache for Gmail API `/api/inbox/sync` (never sent to browser)
const staffGmailTokens = new Map<string, { accessToken: string; expiresAt: number }>();

export function setStaffGmailAccessToken(email: string, accessToken: string, expiresInSec = 3500): void {
  const key = String(email || "").trim().toLowerCase();
  if (!key || !accessToken) return;
  staffGmailTokens.set(key, {
    accessToken,
    expiresAt: Date.now() + Math.max(60, expiresInSec - 30) * 1000,
  });
}

export function getStaffGmailAccessToken(email: string | undefined | null): string | null {
  const key = String(email || "").trim().toLowerCase();
  if (!key) return null;
  const entry = staffGmailTokens.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    staffGmailTokens.delete(key);
    return null;
  }
  return entry.accessToken;
}

const PUBLIC_PATHS = new Set([
  "/healthz",
  "/api/webhooks/tai",
  "/api/webhooks/tai/shipment",
  "/api/webhooks/tai/invoice",
]);

export type AuthEnv = Partial<
  Record<
    "NODE_ENV" | "APP_BASE_URL" | "AUTH_DISABLED" | "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET" | "SESSION_SECRET",
    string | undefined
  >
>;

/** Env vars that must be present (non-blank) before the server will serve /api/* in production. */
export const REQUIRED_PRODUCTION_AUTH_ENV = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SESSION_SECRET"] as const;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  return LOOPBACK_HOSTS.has(h) || h.startsWith("127.");
}

/** True for loopback socket addresses (IPv4 127/8, IPv6 ::1, and IPv4-mapped ::ffff:127.x). */
export function isLoopbackAddress(address: string | undefined | null): boolean {
  if (!address) return false;
  const a = address.trim().toLowerCase().replace(/^::ffff:/, "");
  return a === "::1" || a.startsWith("127.");
}

/**
 * Production-like means either NODE_ENV=production (the Fly Docker image) or an
 * APP_BASE_URL that points somewhere other than loopback (e.g. https://fivenines-ops.fly.dev).
 * Any production-like deployment must fail closed on auth.
 */
export function isProductionEnv(env: AuthEnv = process.env): boolean {
  if (env.NODE_ENV === "production") return true;
  const base = env.APP_BASE_URL?.trim();
  if (!base) return false;
  try {
    return !isLoopbackHostname(new URL(base).hostname);
  } catch {
    // An unparseable APP_BASE_URL is not a loopback dev URL; treat it as production.
    return true;
  }
}

/** Names (never values) of required production auth env vars that are missing or blank. */
export function missingProductionAuthEnv(env: AuthEnv = process.env): string[] {
  return REQUIRED_PRODUCTION_AUTH_ENV.filter((name) => !env[name]?.trim());
}

/** True when running production-like and at least one required auth secret is absent. */
export function isProductionAuthMisconfigured(env: AuthEnv = process.env): boolean {
  return isProductionEnv(env) && missingProductionAuthEnv(env).length > 0;
}

/**
 * Boot-time guard: in production the server refuses to start without Google OAuth
 * credentials and a dedicated SESSION_SECRET. Logs the missing names only.
 */
export function assertProductionAuthConfig(env: AuthEnv = process.env): void {
  if (!isProductionEnv(env)) return;
  const missing = missingProductionAuthEnv(env);
  if (missing.length > 0) {
    console.error(
      `[auth] FATAL: production deployment is missing required auth env: ${missing.join(", ")}. ` +
        "Set these as Fly secrets (names only logged; values are never printed). Refusing to start.",
    );
    throw new Error(`Missing required production auth env: ${missing.join(", ")}`);
  }
  if (env.AUTH_DISABLED === "true") {
    console.warn("[auth] AUTH_DISABLED=true is ignored in production; Google Workspace sign-in is enforced.");
  }
}

let devSessionSecret: string | undefined;

/**
 * Session-signing secret. In production this is SESSION_SECRET and nothing else —
 * no fallback, no derivation from the Supabase service-role key. Outside production
 * a missing SESSION_SECRET falls back to a random per-process secret.
 */
export function resolveSessionSecret(env: AuthEnv = process.env): string {
  const configured = env.SESSION_SECRET?.trim();
  if (configured) return configured;
  if (isProductionEnv(env)) {
    throw new Error("SESSION_SECRET is required in production (no fallback is permitted).");
  }
  if (!devSessionSecret) devSessionSecret = crypto.randomBytes(32).toString("hex");
  return devSessionSecret;
}

function sessionSecret(): string {
  return resolveSessionSecret();
}

export function isOAuthConfigured(env: AuthEnv = process.env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim());
}

/**
 * Whether unauthenticated /api/* requests are rejected. Always true in production;
 * AUTH_DISABLED=true and the "no OAuth configured" preview only apply to local dev.
 * main briefly made this opt-in via REQUIRE_OAUTH_LOGIN so the dashboard and the
 * MV3 extension would not 401 while redirect URIs were being updated. That flag is
 * not honored: a configured client id must not put production back on the preview user.
 */
export function isAuthEnforced(env: AuthEnv = process.env): boolean {
  if (isProductionEnv(env)) return true;
  if (env.AUTH_DISABLED === "true") return false;
  return isOAuthConfigured(env);
}

/**
 * Local-dev preview identity is only ever granted when the server is not
 * production-like AND the request arrived over a loopback socket.
 */
export function allowsLocalDevPreview(remoteAddress: string | undefined | null, env: AuthEnv = process.env): boolean {
  return !isAuthEnforced(env) && isLoopbackAddress(remoteAddress);
}

export function signSession(user: StaffUser): string {
  const payload = Buffer.from(
    JSON.stringify({ email: user.email, name: user.name, exp: Date.now() + SESSION_TTL_MS }),
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifySessionToken(token: string | undefined): StaffUser | null {
  if (!token || !token.includes(".")) return null;
  const [payload, sig] = token.split(".", 2);
  const expected = crypto.createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      email?: string;
      name?: string;
      exp?: number;
    };
    if (!parsed.exp || parsed.exp < Date.now() || !isStaffGoogleIdentity(parsed.email)) return null;
    return { email: parsed.email!, name: parsed.name || parsed.email!, mode: "google_oauth" };
  } catch {
    return null;
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) {
      try {
        out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
      }
    }
  }
  return out;
}

async function verifyGoogleBearerToken(bearer: string): Promise<StaffUser | null> {
  try {
    // Supports both Google OAuth ID tokens (id_token) and access tokens from Chrome identity API
    const endpoint = bearer.split(".").length === 3
      ? `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(bearer)}`
      : `https://www.googleapis.com/oauth2/v3/userinfo`;
    const resp = await fetch(endpoint, {
      headers: bearer.split(".").length === 3 ? {} : { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      email?: string;
      email_verified?: boolean | string;
      hd?: string;
      name?: string;
      aud?: string;
    };
    const verified = data.email_verified === true || data.email_verified === "true";
    if (!verified || !isStaffGoogleIdentity(data.email, data.hd)) return null;

    const allowedClientIds = String(process.env.GMAIL_FREIGHT_TOOLKIT_OAUTH_CLIENT_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (data.aud && allowedClientIds.length > 0 && !allowedClientIds.includes(data.aud)) {
      const webClientId = process.env.GOOGLE_CLIENT_ID?.trim();
      if (data.aud !== webClientId) return null;
    }
    return { email: data.email!.toLowerCase(), name: data.name || data.email!, mode: "bearer_token" };
  } catch {
    return null;
  }
}

function resolveAppOrigin(req: Request): string {
  const configured = process.env.APP_BASE_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0]?.trim() || req.protocol || "http";
  return `${proto}://${req.get("host")}`;
}

export function registerAuth(app: Express): void {
  // Redirect to Google Workspace OAuth
  app.get("/auth/google", (req: Request, res: Response) => {
    const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
    if (!clientId) {
      res.redirect("/");
      return;
    }
    const returnTo = typeof req.query.returnTo === "string" && req.query.returnTo.startsWith("/")
      ? req.query.returnTo
      : "/";
    const redirectUri = `${resolveAppOrigin(req)}/auth/google/callback`;
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      include_granted_scopes: "true",
      prompt: "select_account",
      state: returnTo,
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  });

  // Google OAuth callback
  app.get("/auth/google/callback", async (req: Request, res: Response) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" && req.query.state.startsWith("/") ? req.query.state : "/";
    const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
    if (!code || !clientId || !clientSecret) {
      res.status(400).send("Missing OAuth code or configuration.");
      return;
    }

    try {
      const redirectUri = `${resolveAppOrigin(req)}/auth/google/callback`;
      const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });
      const tokenJson = (await tokenResp.json()) as {
        id_token?: string;
        access_token?: string;
        expires_in?: number;
      };
      if (!tokenJson.id_token) {
        res.status(401).send("Google OAuth exchange failed.");
        return;
      }
      const user = await verifyGoogleBearerToken(tokenJson.id_token);
      if (!user) {
        res.status(403).send("Access is restricted to authorized Five Nines owner Google accounts during testing.");
        return;
      }

      if (tokenJson.access_token) {
        setStaffGmailAccessToken(user.email, tokenJson.access_token, Number(tokenJson.expires_in) || 3500);
      }

      const signed = signSession({ ...user, mode: "google_oauth" });
      const isHttps = resolveAppOrigin(req).startsWith("https://");
      const cookieParts = [
        `${COOKIE_NAME}=${encodeURIComponent(signed)}`,
        "Path=/",
        "HttpOnly",
        `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
        isHttps ? "SameSite=None; Secure; Partitioned" : "SameSite=Lax",
      ];
      res.setHeader("Set-Cookie", cookieParts.join("; "));
      res.redirect(state);
    } catch {
      res.status(500).send("OAuth callback error.");
    }
  });

  app.post("/auth/logout", (req: Request, res: Response) => {
    const isHttps = resolveAppOrigin(req).startsWith("https://");
    res.setHeader(
      "Set-Cookie",
      `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0; ${isHttps ? "SameSite=None; Secure; Partitioned" : "SameSite=Lax"}`,
    );
    res.json({ ok: true });
  });

  // Populate req.staffUser and gate /api/*. Fails closed in production.
  app.use(async (req: Request, res: Response, next: NextFunction) => {
    if (PUBLIC_PATHS.has(req.path)) return next();

    // Defense in depth: assertProductionAuthConfig() should already have refused to boot,
    // but if we are somehow serving production traffic without auth secrets, never
    // authenticate anyone and never fall through to a preview identity.
    if (isProductionAuthMisconfigured()) {
      if (req.path.startsWith("/api/")) {
        res.status(503).json({
          ok: false,
          authenticated: false,
          oauthEnabled: false,
          message: "Server authentication is not configured. Contact the administrator.",
        });
        return;
      }
      return next();
    }

    const cookies = parseCookies(req.headers.cookie);
    const cookieUser = verifySessionToken(cookies[COOKIE_NAME]);
    if (cookieUser) {
      req.staffUser = cookieUser;
      return next();
    }

    const authHeader = req.headers.authorization || "";
    if (authHeader.toLowerCase().startsWith("bearer ")) {
      const bearerUser = await verifyGoogleBearerToken(authHeader.slice(7).trim());
      if (bearerUser) {
        req.staffUser = bearerUser;
        return next();
      }
    }

    if (allowsLocalDevPreview(req.socket?.remoteAddress)) {
      req.staffUser = {
        email: "chriss@primarycompanies.com",
        name: "Chris Sturma",
        mode: "local_dev",
      };
      return next();
    }

    if (req.path === "/api/me") {
      res.json({
        authenticated: false,
        oauthSignedIn: false,
        oauthEnabled: isOAuthConfigured(),
        loginUrl: `/auth/google?returnTo=${encodeURIComponent(req.headers.referer || "/")}`,
      });
      return;
    }

    if (req.path.startsWith("/api/")) {
      res.status(401).json({
        ok: false,
        authenticated: false,
        loginUrl: `/auth/google?returnTo=${encodeURIComponent(req.headers.referer || "/")}`,
        message: "Sign in with your Primary Freight / Five Nines Google account to continue.",
      });
      return;
    }

    next();
  });

  app.get("/api/me", (req: Request, res: Response) => {
    const oauthSignedIn = Boolean(req.staffUser && req.staffUser.mode !== "local_dev");
    res.json({
      authenticated: Boolean(req.staffUser),
      oauthSignedIn,
      oauthEnabled: isOAuthConfigured(),
      authEnforced: isAuthEnforced(),
      loginUrl: `/auth/google?returnTo=${encodeURIComponent(req.headers.referer || "/")}`,
      user: req.staffUser || null,
    });
  });
}
