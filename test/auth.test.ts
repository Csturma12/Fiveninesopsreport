import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import {
  COOKIE_NAME,
  REQUIRED_PRODUCTION_AUTH_ENV,
  allowsLocalDevPreview,
  assertProductionAuthConfig,
  isAuthEnforced,
  isLoopbackAddress,
  isProductionAuthMisconfigured,
  isProductionEnv,
  missingProductionAuthEnv,
  registerAuth,
  resolveSessionSecret,
  signSession,
  verifySessionToken,
} from "../server/auth";

const AUTH_ENV_KEYS = [
  "NODE_ENV",
  "APP_BASE_URL",
  "AUTH_DISABLED",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "SESSION_SECRET",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ALLOWED_STAFF_EMAILS",
] as const;

const originalEnv: Record<string, string | undefined> = {};
for (const key of AUTH_ENV_KEYS) originalEnv[key] = process.env[key];

function setEnv(values: Partial<Record<(typeof AUTH_ENV_KEYS)[number], string>>): void {
  for (const key of AUTH_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key] = value;
  }
}

const FLY_URL = "https://fivenines-ops.fly.dev";
const LOCAL_URL = "http://127.0.0.1:5090";
const PROD_SECRETS = {
  GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  SESSION_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

beforeEach(() => setEnv({}));
after(() => {
  for (const key of AUTH_ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

/** Boots a minimal app with the real auth middleware and a sample protected route on loopback. */
async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });
  registerAuth(app);
  app.get("/api/bootstrap", (req, res) => {
    res.json({ user: req.staffUser || null });
  });
  app.post("/api/webhooks/tai/shipment", (req, res) => {
    res.json({ ok: true, publicRoute: true, user: req.staffUser || null });
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("isProductionEnv: NODE_ENV=production or a non-loopback APP_BASE_URL is production-like", () => {
  assert.equal(isProductionEnv({ NODE_ENV: "production" }), true);
  assert.equal(isProductionEnv({ APP_BASE_URL: FLY_URL }), true);
  assert.equal(isProductionEnv({ APP_BASE_URL: "https://ops.example.com" }), true);
  assert.equal(isProductionEnv({ APP_BASE_URL: "not a url" }), true);
  assert.equal(isProductionEnv({ APP_BASE_URL: LOCAL_URL }), false);
  assert.equal(isProductionEnv({ APP_BASE_URL: "http://localhost:5090" }), false);
  assert.equal(isProductionEnv({ NODE_ENV: "development", APP_BASE_URL: LOCAL_URL }), false);
  assert.equal(isProductionEnv({}), false);
});

test("missingProductionAuthEnv reports names only and assertProductionAuthConfig throws in prod", () => {
  assert.deepEqual(missingProductionAuthEnv({ NODE_ENV: "production" }), [...REQUIRED_PRODUCTION_AUTH_ENV]);
  assert.deepEqual(
    missingProductionAuthEnv({ NODE_ENV: "production", GOOGLE_CLIENT_ID: "x", GOOGLE_CLIENT_SECRET: "  " }),
    ["GOOGLE_CLIENT_SECRET", "SESSION_SECRET"],
  );
  assert.deepEqual(missingProductionAuthEnv({ NODE_ENV: "production", ...PROD_SECRETS }), []);

  const secretValue = "super-secret-value-that-must-not-leak";
  const originalError = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  try {
    assert.throws(
      () => assertProductionAuthConfig({ NODE_ENV: "production", GOOGLE_CLIENT_ID: secretValue }),
      /Missing required production auth env: GOOGLE_CLIENT_SECRET, SESSION_SECRET/,
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0], /GOOGLE_CLIENT_SECRET, SESSION_SECRET/);
  assert.equal(logged[0].includes(secretValue), false);

  assert.doesNotThrow(() => assertProductionAuthConfig({ NODE_ENV: "production", ...PROD_SECRETS }));
  assert.doesNotThrow(() => assertProductionAuthConfig({ APP_BASE_URL: LOCAL_URL }));
  assert.equal(isProductionAuthMisconfigured({ APP_BASE_URL: FLY_URL }), true);
  assert.equal(isProductionAuthMisconfigured({ APP_BASE_URL: FLY_URL, ...PROD_SECRETS }), false);
  assert.equal(isProductionAuthMisconfigured({ APP_BASE_URL: LOCAL_URL }), false);
});

test("resolveSessionSecret: prod requires SESSION_SECRET; never derives from the service-role key", () => {
  assert.throws(() => resolveSessionSecret({ NODE_ENV: "production" }), /SESSION_SECRET is required in production/);
  assert.throws(() => resolveSessionSecret({ APP_BASE_URL: FLY_URL, SESSION_SECRET: "   " }), /SESSION_SECRET/);
  assert.equal(resolveSessionSecret({ NODE_ENV: "production", SESSION_SECRET: " abc " }), "abc");

  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  const devSecret = resolveSessionSecret({ APP_BASE_URL: LOCAL_URL });
  assert.ok(devSecret.length >= 32);
  assert.equal(devSecret, resolveSessionSecret({ APP_BASE_URL: LOCAL_URL }));
  const legacyDerived = crypto.createHash("sha256").update("service-role-key").digest("hex");
  assert.notEqual(devSecret, legacyDerived);
  assert.notEqual(devSecret, crypto.createHash("sha256").update("fivenines-dev-secret").digest("hex"));
});

test("isAuthEnforced: AUTH_DISABLED=true and missing OAuth only relax auth outside production", () => {
  assert.equal(isAuthEnforced({ NODE_ENV: "production" }), true);
  assert.equal(isAuthEnforced({ NODE_ENV: "production", AUTH_DISABLED: "true" }), true);
  assert.equal(isAuthEnforced({ APP_BASE_URL: FLY_URL, AUTH_DISABLED: "true" }), true);
  assert.equal(isAuthEnforced({ APP_BASE_URL: LOCAL_URL }), false);
  assert.equal(isAuthEnforced({ APP_BASE_URL: LOCAL_URL, AUTH_DISABLED: "true", ...PROD_SECRETS }), false);
  assert.equal(isAuthEnforced({ APP_BASE_URL: LOCAL_URL, ...PROD_SECRETS }), true);
});

test("local dev preview requires non-production AND a loopback socket", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("10.0.0.5"), false);
  assert.equal(isLoopbackAddress("172.19.0.3"), false);
  assert.equal(isLoopbackAddress(undefined), false);

  const dev = { APP_BASE_URL: LOCAL_URL };
  assert.equal(allowsLocalDevPreview("127.0.0.1", dev), true);
  assert.equal(allowsLocalDevPreview("10.0.0.5", dev), false);
  assert.equal(allowsLocalDevPreview("127.0.0.1", { NODE_ENV: "production" }), false);
  assert.equal(allowsLocalDevPreview("127.0.0.1", { APP_BASE_URL: FLY_URL, AUTH_DISABLED: "true" }), false);
});

test("prod-like env without OAuth or SESSION_SECRET: /api/* is 503, no Chris local_dev user, /healthz open", async () => {
  setEnv({ NODE_ENV: "production", APP_BASE_URL: FLY_URL, AUTH_DISABLED: "true" });
  await withServer(async (base) => {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);

    const bootstrap = await fetch(`${base}/api/bootstrap`);
    assert.equal(bootstrap.status, 503);
    const body = (await bootstrap.json()) as { authenticated?: boolean; user?: unknown };
    assert.equal(body.authenticated, false);
    assert.equal(body.user, undefined);
    assert.equal(JSON.stringify(body).includes("chriss@primarycompanies.com"), false);

    const me = await fetch(`${base}/api/me`);
    assert.equal(me.status, 503);
    assert.equal(((await me.json()) as { authenticated?: boolean }).authenticated, false);

    const webhook = await fetch(`${base}/api/webhooks/tai/shipment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(webhook.status, 200);
  });
});

test("prod-like env with secrets: unauthenticated /api/* is 401, /api/me reports authenticated:false, AUTH_DISABLED ignored", async () => {
  setEnv({ NODE_ENV: "production", APP_BASE_URL: FLY_URL, AUTH_DISABLED: "true", ...PROD_SECRETS });
  await withServer(async (base) => {
    const bootstrap = await fetch(`${base}/api/bootstrap`);
    assert.equal(bootstrap.status, 401);
    const body = (await bootstrap.json()) as { authenticated?: boolean; loginUrl?: string };
    assert.equal(body.authenticated, false);
    assert.match(String(body.loginUrl), /^\/auth\/google\?returnTo=/);

    const me = await fetch(`${base}/api/me`);
    assert.equal(me.status, 200);
    const meBody = (await me.json()) as { authenticated?: boolean; oauthEnabled?: boolean };
    assert.equal(meBody.authenticated, false);
    assert.equal(meBody.oauthEnabled, true);

    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);

    const webhook = await fetch(`${base}/api/webhooks/tai/shipment`, { method: "POST" });
    assert.equal(webhook.status, 200);
  });
});

test("prod-like env with secrets: a session signed with SESSION_SECRET authenticates; wrong secret does not", async () => {
  setEnv({ NODE_ENV: "production", APP_BASE_URL: FLY_URL, ...PROD_SECRETS });
  const token = signSession({ email: "chriss@primarycompanies.com", name: "Chris", mode: "google_oauth" });
  assert.equal(verifySessionToken(token)?.email, "chriss@primarycompanies.com");

  await withServer(async (base) => {
    const ok = await fetch(`${base}/api/bootstrap`, { headers: { Cookie: `${COOKIE_NAME}=${encodeURIComponent(token)}` } });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { user?: { email: string; mode: string } };
    assert.equal(body.user?.email, "chriss@primarycompanies.com");
    assert.equal(body.user?.mode, "google_oauth");

    process.env.SESSION_SECRET = "a-different-secret-that-did-not-sign-the-cookie";
    const rejected = await fetch(`${base}/api/bootstrap`, {
      headers: { Cookie: `${COOKIE_NAME}=${encodeURIComponent(token)}` },
    });
    assert.equal(rejected.status, 401);
  });
});

test("local dev on loopback without OAuth still gets the local_dev preview user", async () => {
  setEnv({ APP_BASE_URL: LOCAL_URL });
  await withServer(async (base) => {
    const bootstrap = await fetch(`${base}/api/bootstrap`);
    assert.equal(bootstrap.status, 200);
    const body = (await bootstrap.json()) as { user?: { email: string; mode: string } };
    assert.equal(body.user?.mode, "local_dev");
    assert.equal(body.user?.email, "chriss@primarycompanies.com");

    const me = await fetch(`${base}/api/me`);
    const meBody = (await me.json()) as { authenticated?: boolean; authEnforced?: boolean };
    assert.equal(meBody.authenticated, true);
    assert.equal(meBody.authEnforced, false);
  });
});
