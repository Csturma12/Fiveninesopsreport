import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { LoadEntry } from "../shared/load-entry";
import { findDuplicateBooking } from "../server/duplicate-booking";
import { loadEntryPreviewToken } from "../server/load-entry-preview";
import { registerApiRoutes } from "../server/routes";
import { store } from "../server/store";
import {
  bookTaiLoads,
  LIVE_TAI_WRITES_OFF_MESSAGE,
  previewTaiBooking,
  TAI_SHIPMENTS_PATH,
  taiBookingStatus,
  taiRefusalMessage,
} from "../server/tai-service";

/**
 * Generate Load in TAI — server contract. No live TAI call is ever made:
 * the global fetch is replaced with a guard that throws on anything that is
 * not this test's own localhost express server, and every TAI-facing call is
 * given an explicit fake fetchImpl. The "live" path is exercised in-process
 * with a throwaway fake key; the real ALLOW_LIVE_TAI_WRITES / TAI key stay on Fly.
 */

const TAI_KEY_ENV = ["TAI", "API", "KEY"].join("_");
const FAKE_KEY = "test-only-fake-key-never-real";
const originalFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};

before(() => {
  for (const key of ["ALLOW_LIVE_TAI_WRITES", TAI_KEY_ENV, "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "TAI_BASE_URL"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) return originalFetch(input, init);
    throw new Error(`Test guard: refusing outbound fetch to ${url}`);
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  delete process.env.ALLOW_LIVE_TAI_WRITES;
  delete process.env[TAI_KEY_ENV];
});

function sampleEntry(): LoadEntry {
  return {
    shipmentType: "Truckload",
    status: "Committed",
    customer: { name: "CeramSource Spot", taiOrganizationId: "" },
    references: { customerPO: "PO-GEN-1", bolNumber: "BOL-GEN-1", invoiceRef: "", carrierProNumber: "", pickupNumber: "" },
    stops: [
      {
        stopType: "First Pickup",
        companyName: "CeramSource",
        streetAddress: "400 Enterprise Dr",
        city: "Beaver Falls",
        state: "PA",
        zipCode: "15010",
        country: "USA",
        contactName: "",
        phone: "",
        instructions: "",
        readyDate: "2026-11-18",
        timeOpen: "08:00",
        timeClose: "14:00",
        appointmentRequired: false,
      },
      {
        stopType: "Last Drop",
        companyName: "Larkin Refractory",
        streetAddress: "2331 Varkel Way",
        city: "Lithonia",
        state: "GA",
        zipCode: "30058",
        country: "USA",
        contactName: "",
        phone: "",
        instructions: "",
        readyDate: "2026-11-19",
        timeOpen: "07:00",
        timeClose: "10:00",
        appointmentRequired: true,
      },
    ],
    items: [
      {
        description: "Ceramic Fiber Blankets",
        packagingType: "Pallet",
        handlingQuantity: 6,
        piecesTotal: 6,
        weightTotal: 6644,
        hazardousMaterial: false,
        freightClass: "No Class",
        referenceNumber: "",
      },
    ],
    accessorials: [],
    equipment: { trailerSize: "Full", trailerType: "48 ft Flatbed | Tarp", equipmentLength: "48", mileage: 648, stackable: false },
    pricing: { linehaulSell: 2850, fuelSell: 0, linehaulBuy: 2300, fuelBuy: 0 },
    carrier: { name: "", serviceLevel: "Normal" },
    specialInstructions: "",
    sendToTai: true,
  };
}

function enableFakeLiveWrites() {
  process.env.ALLOW_LIVE_TAI_WRITES = "true";
  process.env[TAI_KEY_ENV] = FAKE_KEY;
}

/** A fake TAI: records every POST and answers with the given status/body. */
function fakeTai(status: number, body: string) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) || {})),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const neverCalled = (async () => {
  throw new Error("fetchImpl must not be called on this path");
}) as typeof fetch;

const storeIds = () => store.shipments.map((s) => s.id);

test("preview issues a 64-hex previewToken bound to the entry + exact TAI request, and none when validation fails", () => {
  const entry = sampleEntry();
  const preview = previewTaiBooking(entry);
  assert.equal(preview.ok, true);
  assert.match(String(preview.previewToken), /^[a-f0-9]{64}$/);
  assert.equal(preview.url.endsWith(TAI_SHIPMENTS_PATH), true);
  assert.equal(preview.previewToken, loadEntryPreviewToken(entry, { url: preview.url, request: preview.request }));
  assert.equal(preview.enabled, false, "no key and no ALLOW_LIVE_TAI_WRITES in tests");
  assert.equal(TAI_KEY_ENV in preview, false);

  const edited = sampleEntry();
  edited.pricing.linehaulSell = 2900;
  assert.notEqual(previewTaiBooking(edited).previewToken, preview.previewToken);

  const invalid = sampleEntry();
  invalid.stops[0].zipCode = "";
  const blocked = previewTaiBooking(invalid);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.previewToken, undefined);
  assert.match(blocked.message, /origin zip code is required/i);
});

test("book refuses a missing or stale previewToken before touching TAI (409 requiresPreview)", async () => {
  enableFakeLiveWrites();
  const before = storeIds();
  const entry = sampleEntry();

  const missing = await bookTaiLoads(entry, { duplicateCount: 1 }, { fetchImpl: neverCalled });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 409);
  assert.equal(missing.requiresPreview, true);
  assert.deepEqual(missing.createdIds, []);

  const token = previewTaiBooking(entry).previewToken!;
  const edited = sampleEntry();
  edited.references.customerPO = "PO-EDITED-AFTER-PREVIEW";
  const stale = await bookTaiLoads(edited, { previewToken: token }, { fetchImpl: neverCalled });
  assert.equal(stale.ok, false);
  assert.equal(stale.status, 409);
  assert.equal(stale.requiresPreview, true);

  const garbage = await bookTaiLoads(entry, { previewToken: 12345 }, { fetchImpl: neverCalled });
  assert.equal(garbage.status, 409);
  assert.deepEqual(storeIds(), before);
});

test("validation failures answer 422 with the validator message and never call TAI", async () => {
  enableFakeLiveWrites();
  const entry = sampleEntry();
  entry.items[0].weightTotal = 0;
  const token = previewTaiBooking(sampleEntry()).previewToken!;
  const result = await bookTaiLoads(entry, { previewToken: token }, { fetchImpl: neverCalled });
  assert.equal(result.ok, false);
  assert.equal(result.status, 422);
  assert.match(result.message, /weight/i);
  assert.deepEqual(result.createdIds, []);
});

test("sandbox (ALLOW_LIVE_TAI_WRITES not true, or no key) refuses loudly and never returns a fake TAI id", async () => {
  const entry = sampleEntry();
  const token = previewTaiBooking(entry).previewToken!;
  const before = storeIds();

  const off = await bookTaiLoads(entry, { previewToken: token, confirmDuplicate: true }, { fetchImpl: neverCalled });
  assert.equal(off.ok, false);
  assert.equal(off.status, 503);
  assert.equal(off.liveWritesEnabled, false);
  assert.equal(off.message, LIVE_TAI_WRITES_OFF_MESSAGE);
  assert.deepEqual(off.createdIds, []);
  assert.equal(JSON.stringify(off).includes("1327425"), false, "no sandbox-minted TAI-looking id anywhere in the answer");

  process.env.ALLOW_LIVE_TAI_WRITES = "true";
  const noKey = await bookTaiLoads(entry, { previewToken: token, confirmDuplicate: true }, { fetchImpl: neverCalled });
  assert.equal(noKey.status, 503);
  assert.equal(taiBookingStatus().enabled, false);

  assert.deepEqual(storeIds(), before, "sandbox stored nothing as a TAI load");
});

test("TAI 4xx/5xx returns ok:false 502 with TAI's own status and body; nothing is stored", async () => {
  enableFakeLiveWrites();
  const entry = sampleEntry();
  const token = previewTaiBooking(entry).previewToken!;
  const before = storeIds();
  const tai = fakeTai(400, '{"errors":{"customerId":["customerId is required"]},"title":"One or more validation errors occurred."}');

  const result = await bookTaiLoads(entry, { previewToken: token, confirmDuplicate: true }, { fetchImpl: tai.fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
  assert.equal(result.tai?.httpStatus, 400);
  assert.match(result.tai?.responseBody ?? "", /customerId is required/);
  assert.match(result.message, /^TAI answered 400: customerId: customerId is required/);
  assert.deepEqual(result.createdIds, []);
  assert.deepEqual(storeIds(), before);

  assert.equal(tai.calls.length, 1);
  assert.equal(tai.calls[0].url.endsWith(TAI_SHIPMENTS_PATH), true);
  assert.equal(tai.calls[0].headers["x-api-key"], FAKE_KEY, "key goes on the server-side request only");
  assert.equal((tai.calls[0].body as { shipmentType: string }).shipmentType, "Truckload");

  const down = await bookTaiLoads(entry, { previewToken: token, confirmDuplicate: true }, {
    fetchImpl: (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch,
  });
  assert.equal(down.ok, false);
  assert.equal(down.status, 502);
  assert.match(down.message, /TAI unreachable: ECONNRESET/);
  assert.deepEqual(storeIds(), before);
});

test("TAI 200 without a shipment id is a 409 requiresReconciliation — no invented id, nothing stored", async () => {
  enableFakeLiveWrites();
  const entry = sampleEntry();
  const token = previewTaiBooking(entry).previewToken!;
  const before = storeIds();

  for (const body of ["{}", "", '{"status":"Accepted"}']) {
    const tai = fakeTai(200, body);
    const result = await bookTaiLoads(entry, { previewToken: token, confirmDuplicate: true }, { fetchImpl: tai.fetchImpl });
    assert.equal(result.ok, false, `body=${JSON.stringify(body)}`);
    assert.equal(result.status, 409);
    assert.equal(result.requiresReconciliation, true);
    assert.deepEqual(result.createdIds, []);
    assert.equal(result.tai?.httpStatus, 200);
    assert.match(result.message, /no Shipment ID/);
    assert.equal(/\b1327\d{5}\b/.test(JSON.stringify(result.createdIds)), false);
  }
  assert.deepEqual(storeIds(), before);
});

test("TAI 2xx with a shipment id is the only path that records a load, under TAI's id", async () => {
  enableFakeLiveWrites();
  const entry = sampleEntry();
  entry.references.customerPO = "PO-LIVE-OK";
  entry.references.bolNumber = "BOL-LIVE-OK";
  const token = previewTaiBooking(entry).previewToken!;
  const tai = fakeTai(201, '{"shipmentId":132799001}');

  const result = await bookTaiLoads(entry, { previewToken: token }, { fetchImpl: tai.fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.deepEqual(result.createdIds, ["132799001"]);
  assert.match(result.message, /#132799001/);

  const stored = store.shipments.find((s) => s.id === "132799001");
  assert.ok(stored);
  assert.equal(stored.customer, "CeramSource Spot");
  assert.equal(stored.po, "PO-LIVE-OK");
  assert.match(stored.writebackState, /Generated live in TAI \(#132799001\)/);
  assert.equal(tai.calls.length, 1);
});

test("duplicate guard: same customer + PO/BOL already in TAI asks first (409) and books only with confirmDuplicate", async () => {
  enableFakeLiveWrites();
  const seeded = store.shipments.find((s) => s.id === "132742212");
  assert.ok(seeded, "seeded Larkin load present");
  const entry = sampleEntry();
  entry.customer.name = seeded.customer.toLowerCase();
  entry.references.customerPO = "";
  entry.references.bolNumber = ` ${seeded.bol} `;
  const token = previewTaiBooking(entry).previewToken!;

  const asked = await bookTaiLoads(entry, { previewToken: token }, { fetchImpl: neverCalled });
  assert.equal(asked.ok, false);
  assert.equal(asked.status, 409);
  assert.equal(asked.requiresDuplicateConfirmation, true);
  assert.equal(asked.duplicateOf, "132742212");
  assert.equal(asked.matchedOn, "shipper reference");
  assert.match(asked.message, /already booked in TAI/);
  assert.deepEqual(asked.createdIds, []);

  const tai = fakeTai(200, '"132799002"');
  const confirmed = await bookTaiLoads(entry, { previewToken: token, confirmDuplicate: true }, { fetchImpl: tai.fetchImpl });
  assert.equal(confirmed.ok, true);
  assert.deepEqual(confirmed.createdIds, ["132799002"]);
  assert.equal(tai.calls.length, 1);

  const byPo = sampleEntry();
  byPo.customer.name = "IMC LOGISTICS";
  byPo.references.customerPO = "CAIU9456544";
  byPo.references.bolNumber = "";
  assert.deepEqual(findDuplicateBooking(store.shipments, byPo), { shipmentId: "132738007", matchedOn: "customer PO", value: "CAIU9456544" });

  const blankRefs = sampleEntry();
  blankRefs.customer.name = "IMC LOGISTICS";
  blankRefs.references.customerPO = "";
  blankRefs.references.bolNumber = "";
  assert.equal(findDuplicateBooking(store.shipments, blankRefs), null, "blank references never match blank references");
});

test("multi-order generation stops at the first TAI failure and reports exactly what TAI confirmed", async () => {
  enableFakeLiveWrites();
  const entry = sampleEntry();
  entry.references.customerPO = "PO-MULTI";
  entry.references.bolNumber = "BOL-MULTI";
  const token = previewTaiBooking(entry).previewToken!;
  let n = 0;
  const fetchImpl = (async () => {
    n += 1;
    return n === 1
      ? new Response('{"id":132799010}', { status: 200 })
      : new Response('{"message":"Duplicate reference"}', { status: 409 });
  }) as typeof fetch;

  const result = await bookTaiLoads(entry, { previewToken: token, duplicateCount: 3 }, { fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
  assert.deepEqual(result.createdIds, ["132799010"]);
  assert.match(result.message, /TAI answered 409: Duplicate reference/);
  assert.match(result.message, /TAI did confirm 1 load\(s\) before this: #132799010/);
  assert.equal(n, 2, "no third attempt after a refusal");
  assert.ok(store.shipments.some((s) => s.id === "132799010" && s.po === "PO-MULTI-1"));
});

test("duplicate guard checks the suffixed per-order references a Qty > 1 batch will actually send", async () => {
  enableFakeLiveWrites();
  const entry = sampleEntry();
  entry.customer.name = "Batch Customer";
  entry.references.customerPO = "PO-BATCH";
  entry.references.bolNumber = "";
  const token = previewTaiBooking(entry).previewToken!;

  // First run: TAI confirms PO-BATCH-1, then refuses PO-BATCH-2 (partial batch).
  let n = 0;
  const first = await bookTaiLoads(entry, { previewToken: token, duplicateCount: 2 }, {
    fetchImpl: (async () => {
      n += 1;
      return n === 1
        ? new Response('{"shipmentId":132799020}', { status: 200 })
        : new Response('{"message":"boom"}', { status: 500 });
    }) as typeof fetch,
  });
  assert.equal(first.ok, false);
  assert.deepEqual(first.createdIds, ["132799020"]);
  assert.ok(store.shipments.some((s) => s.id === "132799020" && s.po === "PO-BATCH-1"));

  // Repeating the same batch must be caught against PO-BATCH-1, not the unsuffixed PO-BATCH.
  const repeat = await bookTaiLoads(entry, { previewToken: token, duplicateCount: 2 }, { fetchImpl: neverCalled });
  assert.equal(repeat.ok, false);
  assert.equal(repeat.status, 409);
  assert.equal(repeat.requiresDuplicateConfirmation, true);
  assert.equal(repeat.duplicateOf, "132799020");
  assert.match(repeat.message, /PO-BATCH-1/);

  // A single-order retry of the same PO is not a match (TAI holds PO-BATCH-1, not PO-BATCH).
  const single = await bookTaiLoads(entry, { previewToken: token, duplicateCount: 1 }, { fetchImpl: fakeTai(200, '{"id":132799021}').fetchImpl });
  assert.equal(single.ok, true);
});

test("concurrent bookings for the same customer are serialized: the second sees the first's TAI id and asks for confirmation", async () => {
  enableFakeLiveWrites();
  const entry = sampleEntry();
  entry.customer.name = "Race Customer";
  entry.references.customerPO = "PO-RACE";
  entry.references.bolNumber = "";
  const token = previewTaiBooking(entry).previewToken!;

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let posts = 0;
  const slowTai = (async () => {
    posts += 1;
    await gate;
    return new Response('{"shipmentId":132799030}', { status: 200 });
  }) as typeof fetch;

  const first = bookTaiLoads(entry, { previewToken: token }, { fetchImpl: slowTai });
  const second = bookTaiLoads(entry, { previewToken: token }, { fetchImpl: slowTai });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(posts, 1, "the second booking waits on the first instead of racing past the duplicate check");

  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.ok, true);
  assert.deepEqual(a.createdIds, ["132799030"]);
  assert.equal(b.ok, false);
  assert.equal(b.status, 409);
  assert.equal(b.requiresDuplicateConfirmation, true);
  assert.equal(b.duplicateOf, "132799030");
  assert.equal(posts, 1, "TAI received exactly one shipment");

  // A different customer is not blocked by the lock.
  const other = sampleEntry();
  other.customer.name = "Other Customer";
  other.references.customerPO = "PO-OTHER";
  const otherToken = previewTaiBooking(other).previewToken!;
  const result = await bookTaiLoads(other, { previewToken: otherToken }, { fetchImpl: fakeTai(200, '{"id":132799031}').fetchImpl });
  assert.equal(result.ok, true);
});

test("taiRefusalMessage surfaces TAI's own reason from the usual .NET shapes", () => {
  assert.equal(taiRefusalMessage(400, { errors: { "stops[0].zipCode": ["required"] } }, ""), "TAI answered 400: stops[0].zipCode: required");
  assert.equal(taiRefusalMessage(401, null, "<html><body>Unauthorized</body></html>"), "TAI answered 401: Unauthorized");
  assert.equal(taiRefusalMessage(500, {}, ""), "TAI answered 500 with no reason in its response");
});

test("HTTP routes: preview hands back the token; book maps refusals to 400/409/503 and never minted an id in sandbox", async () => {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  registerApiRoutes(app);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const before = storeIds();

  try {
    const status = await (await fetch(`${base}/api/tai/booking/status`)).json();
    assert.equal(status.enabled, false);
    assert.equal(JSON.stringify(status).includes(FAKE_KEY), false);

    assert.equal((await post("/api/loads/preview", {})).status, 400);
    assert.equal((await post("/api/loads/book", { entry: null })).status, 400);

    const entry = sampleEntry();
    const previewRes = await post("/api/loads/preview", { entry });
    assert.equal(previewRes.status, 200);
    const preview = await previewRes.json();
    assert.match(preview.previewToken, /^[a-f0-9]{64}$/);

    const invalid = sampleEntry();
    invalid.stops[1].zipCode = "";
    assert.equal((await post("/api/loads/preview", { entry: invalid })).status, 422);

    const noToken = await post("/api/loads/book", { entry, duplicateCount: 1 });
    assert.equal(noToken.status, 409);
    assert.equal((await noToken.json()).requiresPreview, true);

    const sandbox = await post("/api/loads/book", { entry, previewToken: preview.previewToken });
    assert.equal(sandbox.status, 503);
    const body = await sandbox.json();
    assert.equal(body.ok, false);
    assert.deepEqual(body.createdIds, []);
    assert.equal(body.message, LIVE_TAI_WRITES_OFF_MESSAGE);
    assert.deepEqual(storeIds(), before);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
