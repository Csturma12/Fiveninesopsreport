import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type { StaffUser } from "../server/auth";
import {
  PFD_ACTING_USER_HEADER,
  PFD_TOKEN_HEADER,
  readPfdGatewayConfig,
  registerPfdGateway,
  upstreamApiPath,
} from "../server/pfd-gateway";
import { PFD_API_PREFIXES } from "../shared/pfd-endpoints";

const TOKEN = "t".repeat(48);

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function withHarness(
  opts: { user?: StaffUser | null; env?: Record<string, string>; upstream?: http.RequestListener },
  run: (ctx: { base: string; seen: Seen[] }) => Promise<void>,
) {
  const seen: Seen[] = [];
  const upstream = http.createServer(
    opts.upstream ??
      ((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
          if (req.url === "/healthz") return res.end("ok");
          res.setHeader("content-type", "application/json");
          res.setHeader("set-cookie", "pfih.sid=leak");
          res.end(JSON.stringify({ upstream: true, url: req.url }));
        });
      }),
  );
  const upstreamUrl = await listen(upstream);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const user = opts.user === undefined ? { email: "Chriss@PrimaryCompanies.com", name: "Chris", mode: "google_oauth" as const } : opts.user;
    if (user) req.staffUser = user;
    next();
  });
  registerPfdGateway(app, {
    env: { PFD_BASE_URL: upstreamUrl, PFD_GATEWAY_TOKEN: TOKEN, ...(opts.env ?? {}) },
  });
  const server = http.createServer(app);
  const base = await listen(server);
  try {
    await run({ base, seen });
  } finally {
    server.close();
    upstream.close();
  }
}

test("config requires base URL and a long token, and https off the private network", () => {
  assert.deepEqual(readPfdGatewayConfig({}), { ok: false, missing: ["PFD_BASE_URL", "PFD_GATEWAY_TOKEN"], problems: [] });
  const short = readPfdGatewayConfig({ PFD_BASE_URL: "https://x.fly.dev", PFD_GATEWAY_TOKEN: "abc" });
  assert.equal(short.ok, false);
  const plain = readPfdGatewayConfig({ PFD_BASE_URL: "http://example.com", PFD_GATEWAY_TOKEN: TOKEN });
  assert.equal(plain.ok, false);
  const internal = readPfdGatewayConfig({ PFD_BASE_URL: "http://primary-freight-dashboard.internal:5000/", PFD_GATEWAY_TOKEN: TOKEN });
  assert.ok(internal.ok && internal.config.baseUrl === "http://primary-freight-dashboard.internal:5000");
});

test("path mapping rejects traversal and encoded separators", () => {
  assert.equal(upstreamApiPath("shipments/12"), "/api/shipments/12");
  for (const bad of ["", "../auth/me", "shipments/../../x", "shipments/%2e%2e/x", "a%2Fb", "a//b", "a\\b"]) {
    assert.equal(upstreamApiPath(bad), null, bad);
  }
});

test("prefix catalogue excludes session, customer portal and webhook APIs", () => {
  for (const excluded of ["/api/auth", "/api/portal", "/api/webhooks"]) {
    assert.ok(!(PFD_API_PREFIXES as readonly string[]).includes(excluded), excluded);
  }
  assert.ok(PFD_API_PREFIXES.length >= 40);
});

test("unconfigured gateway answers 503 with the missing keys", async () => {
  await withHarness({ env: { PFD_BASE_URL: "", PFD_GATEWAY_TOKEN: "" } }, async ({ base, seen }) => {
    const res = await fetch(`${base}/api/pfd/shipments`);
    assert.equal(res.status, 503);
    assert.deepEqual((await res.json()).missing, ["PFD_BASE_URL", "PFD_GATEWAY_TOKEN"]);
    assert.equal(seen.length, 0);
  });
});

test("forwards GET with query, token and acting user, but never browser credentials", async () => {
  await withHarness({}, async ({ base, seen }) => {
    const res = await fetch(`${base}/api/pfd/shipments/active?limit=5&q=a%20b`, {
      headers: { cookie: "fivenines_staff_session=secret", authorization: "Bearer google-token", accept: "application/json" },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { upstream: true, url: "/api/shipments/active?limit=5&q=a%20b" });
    assert.equal(res.headers.get("set-cookie"), null);
    const [call] = seen;
    assert.equal(call.headers[PFD_TOKEN_HEADER], TOKEN);
    assert.equal(call.headers[PFD_ACTING_USER_HEADER], "chriss@primarycompanies.com");
    assert.equal(call.headers.cookie, undefined);
    assert.equal(call.headers.authorization, undefined);
  });
});

test("forwards JSON bodies and raw (CSV) bodies", async () => {
  await withHarness({}, async ({ base, seen }) => {
    const json = await fetch(`${base}/api/pfd/quotes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lane: "HOU-DAL", rate: 1200 }),
    });
    assert.equal(json.status, 200);
    assert.deepEqual(JSON.parse(seen[0].body), { lane: "HOU-DAL", rate: 1200 });

    const csv = await fetch(`${base}/api/pfd/carriers/import`, {
      method: "POST",
      headers: { "content-type": "text/csv" },
      body: "name,mc\nAcme,123\n",
    });
    assert.equal(csv.status, 200);
    assert.equal(seen[1].method, "POST");
    assert.equal(seen[1].body, "name,mc\nAcme,123\n");
    assert.equal(seen[1].headers["content-type"], "text/csv");

    const del = await fetch(`${base}/api/pfd/quotes/7`, { method: "DELETE" });
    assert.equal(del.status, 200);
    assert.equal(seen[2].method, "DELETE");
  });
});

test("rejects unknown prefixes, excluded APIs and traversal without calling upstream", async () => {
  await withHarness({}, async ({ base, seen }) => {
    assert.equal((await fetch(`${base}/api/pfd/auth/me`)).status, 404);
    assert.equal((await fetch(`${base}/api/pfd/webhooks/terminal49`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${base}/api/pfd/not-a-thing`)).status, 404);
    // fetch() normalises dot segments, so send the raw path the way a hostile client could.
    const rawStatus = await new Promise<number>((resolve, reject) => {
      const { hostname, port } = new URL(base);
      const req = http.request({ hostname, port, path: "/api/pfd/shipments/%2e%2e/auth/me" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(rawStatus, 400);
    assert.equal(seen.length, 0);
  });
});

test("requires a signed-in staff user, and refuses the local-dev placeholder in production", async () => {
  await withHarness({ user: null }, async ({ base, seen }) => {
    assert.equal((await fetch(`${base}/api/pfd/shipments`)).status, 401);
    assert.equal(seen.length, 0);
  });
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await withHarness({ user: { email: "chriss@primarycompanies.com", name: "Local", mode: "local_dev" } }, async ({ base, seen }) => {
      assert.equal((await fetch(`${base}/api/pfd/shipments`)).status, 401);
      assert.equal(seen.length, 0);
    });
  } finally {
    process.env.NODE_ENV = previous;
  }
});

test("upstream redirects become 502 instead of bouncing the browser to the dashboard sign-in", async () => {
  await withHarness(
    {
      upstream: (_req, res) => {
        res.statusCode = 302;
        res.setHeader("location", "/auth/google");
        res.end();
      },
    },
    async ({ base }) => {
      const res = await fetch(`${base}/api/pfd/shipments`, { redirect: "manual" });
      assert.equal(res.status, 502);
      assert.equal(res.headers.get("location"), null);
    },
  );
});

test("passes 304 Not Modified through for cached reads", async () => {
  await withHarness(
    {
      upstream: (req, res) => {
        if (req.headers["if-none-match"] === '"v1"') {
          res.statusCode = 304;
          res.setHeader("etag", '"v1"');
          return res.end();
        }
        res.end("{}");
      },
    },
    async ({ base }) => {
      const res = await fetch(`${base}/api/pfd/shipments`, { headers: { "if-none-match": '"v1"' } });
      assert.equal(res.status, 304);
      assert.equal(res.headers.get("etag"), '"v1"');
    },
  );
});

test("an event-stream request is still bounded by the timeout until the dashboard answers", async () => {
  await withHarness(
    { env: { PFD_GATEWAY_TIMEOUT_MS: "100" }, upstream: () => { /* never responds */ } },
    async ({ base }) => {
      const res = await fetch(`${base}/api/pfd/containers/alerts`, { headers: { accept: "text/event-stream" } });
      assert.equal(res.status, 504);
    },
  );
});

test("passes upstream status codes through and reports an unreachable dashboard as 502", async () => {
  await withHarness(
    {
      upstream: (_req, res) => {
        res.statusCode = 422;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ message: "bad lane" }));
      },
    },
    async ({ base }) => {
      const res = await fetch(`${base}/api/pfd/lanes/override`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(res.status, 422);
      assert.deepEqual(await res.json(), { message: "bad lane" });
    },
  );
  await withHarness({ env: { PFD_BASE_URL: "http://127.0.0.1:1" } }, async ({ base }) => {
    assert.equal((await fetch(`${base}/api/pfd/shipments`)).status, 502);
  });
});

test("status endpoint reports config and upstream health", async () => {
  await withHarness({}, async ({ base }) => {
    const res = await fetch(`${base}/api/pfd/_status`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.upstreamStatus, 200);
  });
});
