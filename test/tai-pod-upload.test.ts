import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createServer, type Server } from "node:http";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_POD_BYTES,
  podInputFromBase64Body,
  uploadPodToTai,
  validatePodUpload,
  type PodUploadConfig,
} from "../server/tai-pod-upload";
import { registerPodUploadRoute } from "../server/tai-pod-routes";
import { registerApiRoutes } from "../server/routes";
import { store } from "../server/store";

// No live TAI calls in tests: every fetch is injected or stubbed, and live writes stay disabled.
const config: PodUploadConfig = { baseUrl: "https://tai.example.test/", credential: "fixture-only", enabled: true };
const pdfBytes = Buffer.from("%PDF-1.7\n%%EOF");
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0xff, 0xd9]);
const pdf = { fileName: "signed-pod.pdf", mimeType: "application/pdf", bytes: pdfBytes };
const noFetch: typeof fetch = async () => {
  throw new Error("must not contact TAI");
};
const shipmentReply = (attachments: unknown[] = []) =>
  new Response(JSON.stringify({ attachments }), { status: 200, headers: { "content-type": "application/json" } });

type ListenResult = { server: Server; url: string };
async function listen(app: express.Express): Promise<ListenResult> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  return { server, url: `http://127.0.0.1:${address.port}` };
}
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

function withEnv(patch: Record<string, string | undefined>): () => void {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(patch)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

test("POD is verified only after a new matching TAI document appears on GET /Shipments read-back", async () => {
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  const replies = [
    shipmentReply([{ attachmentName: "signed-pod.pdf", attachmentType: "POD", documentId: 11 }]),
    new Response("{}", { status: 200 }),
    shipmentReply([
      { attachmentName: "signed-pod.pdf", attachmentType: "POD", documentId: 11 },
      { attachmentName: "signed-pod.pdf", attachmentType: "POD", documentId: 12 },
    ]),
  ];
  const result = await uploadPodToTai("131646656", pdf, config, async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    });
    return replies.shift()!;
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "verified");
  assert.equal(result.documentId, 12);
  assert.equal(result.podCount, 2);
  assert.match(result.message, /read back on GET \/Shipments\/131646656/);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["GET", "POST", "GET"],
  );
  assert.equal(calls[0].url, "https://tai.example.test/PublicApi/Shipping/v2/Shipments/131646656");
  assert.equal(calls[1].url, "https://tai.example.test/PublicApi/Shipping/v2/DocumentAttachments");
  assert.deepEqual(calls[1].body, {
    referenceNumbers: [{ referenceType: "Shipment Id", value: "131646656" }],
    file: pdfBytes.toString("base64"),
    fileName: "signed-pod.pdf",
    attachmentType: "POD",
    accessLevel: "Private",
  });
});

test("validation rejects bad ids, names, types, byte mismatches and oversized files before any TAI call", async () => {
  assert.equal(validatePodUpload("123", pdf).ok, true);
  assert.equal(validatePodUpload("123", { fileName: "signed.jpg", mimeType: "image/jpeg", bytes: jpegBytes }).ok, true);
  const invalid: Array<[string, Record<string, unknown>]> = [
    ["", pdf],
    ["local-123", pdf],
    ["123", { ...pdf, fileName: "../signed-pod.pdf" }],
    ["123", { ...pdf, fileName: "signed-pod.jpg" }],
    ["123", { ...pdf, mimeType: "image/jpeg" }],
    ["123", { ...pdf, mimeType: "image/png" }],
    ["123", { ...pdf, bytes: jpegBytes }],
    ["123", { ...pdf, bytes: Buffer.alloc(0) }],
    ["123", { ...pdf, bytes: "not-a-buffer" }],
    ["123", { ...pdf, bytes: Buffer.alloc(MAX_POD_BYTES + 1, 0x25) }],
  ];
  for (const [id, input] of invalid) {
    const result = await uploadPodToTai(id, input as typeof pdf, config, noFetch);
    assert.equal(result.ok, false, `${id} ${JSON.stringify(Object.keys(input))}`);
    assert.equal(result.status, "invalid");
  }
  const decoded = podInputFromBase64Body({ fileName: "a.pdf", mimeType: "application/pdf", base64: pdfBytes.toString("base64") });
  assert.ok(Buffer.isBuffer(decoded.bytes) && decoded.bytes.equals(pdfBytes));
  assert.equal(podInputFromBase64Body({ fileName: "a.pdf", mimeType: "application/pdf", base64: "data:x;base64,AAAA" }).bytes, undefined);
});

test("ALLOW_LIVE_TAI_WRITES off, missing key, or failed preflight send nothing to TAI and fail loudly", async () => {
  const disabled = await uploadPodToTai("123", pdf, { ...config, enabled: false }, noFetch);
  assert.equal(disabled.status, "unavailable");
  assert.match(disabled.message, /ALLOW_LIVE_TAI_WRITES/);
  const noKey = await uploadPodToTai("123", pdf, { ...config, credential: "" }, noFetch);
  assert.equal(noKey.status, "unavailable");
  assert.match(noKey.message, /API key is not configured/);
  let calls = 0;
  const preflight = await uploadPodToTai("123", pdf, config, async () => {
    calls++;
    return new Response("not found", { status: 404 });
  });
  assert.equal(preflight.status, "unavailable");
  assert.match(preflight.message, /preflight GET .*HTTP 404/);
  assert.equal(calls, 1);
});

test("TAI 4xx/5xx, transport loss and invisible read-back fail closed without retrying the POST", async () => {
  let posts = 0;
  const rejected = await uploadPodToTai("123", pdf, config, async (_url, init) => {
    if (init?.method === "GET") return shipmentReply();
    posts++;
    return new Response(`staff unauthorized ${config.credential}`, { status: 403 });
  });
  assert.equal(rejected.status, "rejected");
  assert.equal(posts, 1);
  assert.ok(!rejected.message.includes(config.credential));

  posts = 0;
  const lost = await uploadPodToTai("123", pdf, config, async (_url, init) => {
    if (init?.method === "GET") return shipmentReply();
    posts++;
    throw new Error(config.credential);
  });
  assert.equal(lost.status, "needs_review");
  assert.equal(posts, 1);
  assert.ok(!lost.message.includes(config.credential));

  posts = 0;
  const serverError = await uploadPodToTai("123", pdf, config, async (_url, init) => {
    if (init?.method === "GET") return shipmentReply();
    posts++;
    return new Response("boom", { status: 500 });
  });
  assert.equal(serverError.status, "needs_review");
  assert.equal(posts, 1);

  posts = 0;
  const unverified = await uploadPodToTai(
    "123",
    pdf,
    config,
    async (_url, init) => {
      if (init?.method === "GET") return shipmentReply([{ attachmentName: "signed-pod.pdf", attachmentType: "POD", documentId: 11 }]);
      posts++;
      return new Response("{}", { status: 200 });
    },
    { readBackDelayMs: 0 },
  );
  assert.equal(unverified.status, "needs_review");
  assert.equal(unverified.ok, false);
  assert.equal(posts, 1);
});

test("POST /api/loads/:id/pod never sets a verified status on missing id, sandbox mode, missing key or TAI failure", async (t) => {
  const restoreEnv = withEnv({ ALLOW_LIVE_TAI_WRITES: "false", TAI_API_KEY: undefined, CRM_WEBHOOK_SECRET: undefined });
  const realFetch = globalThis.fetch;
  globalThis.fetch = noFetch;
  t.after(() => {
    globalThis.fetch = realFetch;
    restoreEnv();
  });

  // The real registration from server/routes.ts (default env config, so sandbox mode must refuse).
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  registerApiRoutes(app);
  const { server, url } = await listen(app);
  t.after(() => close(server));

  const target = store.shipments.find((s) => s.id === "132647845")!;
  const beforeCount = target.podCount;
  const beforeState = target.writebackState;
  const beforeKpi = store.kpis.emailPodReady;
  // The test's own requests use the real fetch; the server under test only sees the throwing stub.
  const sendRaw = (id: string) =>
    realFetch(`${url}/api/loads/${id}/pod?fileName=signed-pod.pdf`, {
      method: "POST",
      headers: { "content-type": "application/pdf" },
      body: pdfBytes,
    });

  assert.equal((await sendRaw("local-id")).status, 400);
  assert.equal((await sendRaw("999999999")).status, 404);
  const sandbox = await sendRaw("132647845");
  assert.equal(sandbox.status, 503);
  const sandboxBody = (await sandbox.json()) as { ok: boolean; message: string };
  assert.equal(sandboxBody.ok, false);
  assert.match(sandboxBody.message, /ALLOW_LIVE_TAI_WRITES/);

  process.env.ALLOW_LIVE_TAI_WRITES = "true";
  const noKey = await sendRaw("132647845");
  assert.equal(noKey.status, 503);
  assert.match(((await noKey.json()) as { message: string }).message, /API key is not configured/);

  // Legacy bodyless POST (what the old fake route accepted) is now a loud 400.
  const bodyless = await realFetch(`${url}/api/loads/132647845/pod`, { method: "POST" });
  assert.equal(bodyless.status, 400);

  // Mocked TAI rejection through the route layer.
  const rejectedApp = express();
  rejectedApp.use(express.json({ limit: "2mb" }));
  registerPodUploadRoute(rejectedApp, {
    config: () => config,
    fetchImpl: async (_url, init) => (init?.method === "GET" ? shipmentReply() : new Response("nope", { status: 403 })),
  });
  const rejected = await listen(rejectedApp);
  t.after(() => close(rejected.server));
  const rej = await realFetch(`${rejected.url}/api/loads/132647845/pod?fileName=signed-pod.pdf`, {
    method: "POST",
    headers: { "content-type": "application/pdf" },
    body: pdfBytes,
  });
  assert.equal(rej.status, 502);
  assert.equal(((await rej.json()) as { status: string }).status, "rejected");

  assert.equal(target.podCount, beforeCount);
  assert.equal(target.writebackState, beforeState);
  assert.equal(store.kpis.emailPodReady, beforeKpi);
  assert.ok(!/POD .*verified/i.test(target.writebackState));
});

test("POST /api/loads/:id/pod sets a truthful verified status only after mocked TAI read-back confirms the document", async (t) => {
  const restoreEnv = withEnv({ SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined });
  t.after(restoreEnv);
  const target = store.shipments.find((s) => s.id === "132647845")!;
  target.podCount = 0;
  const beforeKpi = store.kpis.emailPodReady;
  const podEmail = store.crucialEmails.find((e) => e.loadId === "132647845" && e.diffType === "missing_pod");
  if (podEmail) podEmail.applied = false;

  let posts = 0;
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  registerPodUploadRoute(app, {
    config: () => config,
    readBackDelayMs: 0,
    fetchImpl: async (_url, init) => {
      if (init?.method === "POST") {
        posts++;
        return new Response("{}", { status: 200 });
      }
      return posts === 0
        ? shipmentReply()
        : shipmentReply([{ attachmentName: "POD_132647845_signed.pdf", attachmentType: "POD", documentId: 901 }]);
    },
  });
  const { server, url } = await listen(app);
  t.after(() => close(server));

  // JSON base64 path (small files) — the other transport the route accepts.
  const res = await fetch(`${url}/api/loads/132647845/pod`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fileName: "POD_132647845_signed.pdf", mimeType: "application/pdf", base64: pdfBytes.toString("base64") }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { ok: boolean; status: string; documentId: number; mirrorStatus: string; message: string };
  assert.equal(body.ok, true);
  assert.equal(body.status, "verified");
  assert.equal(body.documentId, 901);
  assert.equal(body.mirrorStatus, "skipped");
  assert.equal(posts, 1);
  assert.equal(target.podCount, 1);
  assert.match(target.writebackState, /Document #901/);
  assert.match(target.writebackState, /GET \/PublicApi\/Shipping\/v2\/Shipments\/132647845/);
  assert.equal(target.emailPodAvailable, false);
  assert.equal(store.kpis.emailPodReady, Math.max(0, beforeKpi - 1));
  if (podEmail) assert.equal(podEmail.applied, true);
  assert.equal(store.webhookLogs[0]?.type, "DocumentAttachments");
});

test("inbox missing_pod apply no longer fakes an upload: 501 and podCount unchanged", async (t) => {
  const app = express();
  app.use(express.json());
  registerApiRoutes(app);
  const { server, url } = await listen(app);
  t.after(() => close(server));
  const target = store.shipments.find((s) => s.id === "132647845")!;
  const before = { podCount: target.podCount, state: target.writebackState };
  const res = await fetch(`${url}/api/inbox/em-pod-132647845/apply`, { method: "POST" });
  assert.equal(res.status, 501);
  const body = (await res.json()) as { ok: boolean; action: string; message: string };
  assert.equal(body.ok, false);
  assert.equal(body.action, "pod_upload_required");
  assert.match(body.message, /POST \/api\/loads\/132647845\/pod/);
  assert.equal(target.podCount, before.podCount);
  assert.equal(target.writebackState, before.state);
});

test("CRM push flag stays false when CRM_WEBHOOK_SECRET is missing or the webhook fails; true only on remote 2xx", async (t) => {
  let remoteStatus = 500;
  const remote = express();
  remote.post("/api/webhooks/leads", (_req, res) => {
    res.status(remoteStatus).json({ ok: remoteStatus < 300 });
  });
  const remoteSrv = await listen(remote);
  t.after(() => close(remoteSrv.server));

  const restoreEnv = withEnv({ CRM_WEBHOOK_SECRET: undefined, CRM_LEADS_WEBHOOK_URL: `${remoteSrv.url}/api/webhooks/leads` });
  t.after(restoreEnv);

  const app = express();
  app.use(express.json());
  registerApiRoutes(app);
  const { server, url } = await listen(app);
  t.after(() => close(server));

  const created = store.addCrmLead({ company: "Webhook Flag Test Co", source: "Manual" });
  t.after(() => {
    store.deleteCrmLead(created.lead.id);
  });
  const push = () => fetch(`${url}/api/crm/leads/${created.lead.id}/push`, { method: "POST" });
  const flag = () => store.crmLeads.find((l) => l.id === created.lead.id)?.pushedToVercelCrm;

  const notConfigured = await push();
  assert.equal(notConfigured.status, 503);
  const ncBody = (await notConfigured.json()) as { ok: boolean; message: string };
  assert.equal(ncBody.ok, false);
  assert.match(ncBody.message, /saved locally only/i);
  assert.notEqual(flag(), true);

  process.env.CRM_WEBHOOK_SECRET = "test-secret";
  const failed = await push();
  assert.equal(failed.status, 502);
  const fBody = (await failed.json()) as { ok: boolean; message: string };
  assert.equal(fBody.ok, false);
  assert.match(fBody.message, /saved locally only.*HTTP 500/i);
  assert.notEqual(flag(), true);

  remoteStatus = 200;
  const okRes = await push();
  assert.equal(okRes.status, 200);
  assert.equal(((await okRes.json()) as { ok: boolean }).ok, true);
  assert.equal(flag(), true);
});

test("no TAI key material or direct TAI calls in client/ or gmail-extension/", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|html|json)$/.test(entry)) files.push(full);
    }
  };
  walk(path.join(root, "client"));
  walk(path.join(root, "gmail-extension"));
  assert.ok(files.length > 5);
  const forbidden = [/x-api-key/i, /TAI_API_KEY/, /taicloud\.net\/PublicApi/i, /DocumentAttachments/];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(text), `${path.relative(root, file)} matches ${pattern}`);
    }
  }
});
