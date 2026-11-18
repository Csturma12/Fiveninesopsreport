import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import zlib from "node:zlib";
import express from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LoadEntry } from "../shared/load-entry";
import type { OpsShipment } from "../shared/tai-webhook-schema";
import { registerApiRoutes, type RegisterApiRoutesOptions } from "../server/routes";
import { store } from "../server/store";
import {
  clearTaiPushLogs,
  getTaiPushLogs,
  isTaiAuthHalted,
  recordTaiPush,
  resetTaiAuthHalt,
  taiApiKey,
} from "../server/tai-push-log";
import {
  bookTaiLoads,
  calculateFuelSurcharge,
  handleTaiInvoiceWebhook,
  normalizeEquipmentFamily,
  previewTaiBooking,
  pushShipmentCheckCall,
  pushShipmentReferences,
} from "../server/tai-service";
import {
  isWritebackPollerHalted,
  processWritebackRow,
  resetWritebackPollerHalt,
  type AssignmentRow,
} from "../server/tai-writeback-poller";

// Fixture credentials passed strictly via options — NEVER mutating process.env secret names!
const FIXTURE_CRED = '  "fixture-tai-broker-cred-9901"  ';
const CLEAN_FIXTURE_CRED = "fixture-tai-broker-cred-9901";

function makeValidLoadEntry(overrides: Partial<LoadEntry> = {}): LoadEntry {
  return {
    shipmentType: "Truckload",
    status: "Committed",
    customer: {
      name: "LARKIN REFRACTORY SOLUTIONS",
      taiOrganizationId: "",
      contactName: "Dispatch",
      email: "shipping@larkinrefractory.com",
    },
    references: {
      customerPO: "PO-77410",
      bolNumber: "BOL-77410",
      invoiceRef: "",
      carrierProNumber: "",
      pickupNumber: "PU-77410",
    },
    stops: [
      {
        stopType: "First Pickup",
        companyName: "CeramSource, Inc.",
        streetAddress: "400 Enterprise Drive",
        city: "Beaver Falls",
        state: "PA",
        zipCode: "15010",
        country: "USA",
        contactName: "Dock",
        phone: "732-257-5002",
        instructions: "8ft Tarps",
        readyDate: "2026-11-22",
        timeOpen: "08:00",
        timeClose: "15:00",
        appointmentRequired: false,
      },
      {
        stopType: "Last Drop",
        companyName: "Larkin Refractory Solutions",
        streetAddress: "2331 Varkel Way",
        city: "Lithonia",
        state: "GA",
        zipCode: "30058",
        country: "USA",
        contactName: "Receiving",
        phone: "678-336-7090",
        instructions: "",
        readyDate: "2026-11-23",
        timeOpen: "09:00",
        timeClose: "15:00",
        appointmentRequired: true,
      },
    ],
    items: [
      {
        description: "Refractory Castables",
        packagingType: "Pallet",
        handlingQuantity: 18,
        piecesTotal: 18,
        weightTotal: 38000,
        hazardousMaterial: false,
        freightClass: "No Class",
        referenceNumber: "PO-77410",
      },
    ],
    accessorials: [{ scope: "pickup", code: "62", name: "Tarp Fee - Pickup", sell: 150, buy: 100 }],
    equipment: {
      trailerSize: "Full",
      trailerType: "48 ft Flatbed | Tarp",
      equipmentLength: "48",
      mileage: 648,
      stackable: false,
    },
    pricing: {
      linehaulSell: 2650,
      fuelSell: 0,
      linehaulBuy: 2100,
      fuelBuy: 0,
    },
    carrier: {
      name: "EVANS DELIVERY COMPANY INC",
      scac: "EVNS",
      mcNumber: "117950",
      serviceLevel: "Normal",
    },
    specialInstructions: "Call 1 hr prior",
    sendToTai: true,
    ...overrides,
  };
}

async function withApiServer(
  options: RegisterApiRoutesOptions & { staffEmail?: string; staffName?: string },
  run: (baseUrl: string) => Promise<void>,
) {
  const app = express();
  app.use(express.json({ limit: "4mb" }));
  app.use((req, _res, next) => {
    req.staffUser = {
      email: options.staffEmail ?? "chriss@primarycompanies.com",
      name: options.staffName ?? "Chris Sturma",
      mode: "google_oauth",
    };
    next();
  });
  registerApiRoutes(app, options);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("taiApiKey strips surrounding quotes and whitespace; recordTaiPush redacts all secrets", async () => {
  clearTaiPushLogs();
  assert.equal(taiApiKey('  "my-quoted-cred" \n '), "my-quoted-cred");
  assert.equal(taiApiKey(" 'single-quoted-cred' "), "single-quoted-cred");

  const insertedRows: Array<Record<string, unknown>> = [];
  const mockSb = {
    from(table: string) {
      assert.equal(table, "tai_push_log");
      return {
        async insert(row: Record<string, unknown>) {
          insertedRows.push(row);
          return { error: null };
        },
      };
    },
  };

  const record = await recordTaiPush({
    shipmentId: "849201",
    kind: "sell_charges",
    method: "PUT",
    endpoint: `/PublicApi/Shipping/v2/ShipmentCharges?api_key=${CLEAN_FIXTURE_CRED}`,
    requestHeaders: {
      "x-api-key": CLEAN_FIXTURE_CRED,
      Authorization: "Bearer super-secret-jwt-value",
      "Content-Type": "application/json",
    },
    requestPayload: {
      referenceNumbers: [{ referenceType: "Shipment Id", value: "849201" }],
      nestedSecret: "top-secret-123",
      authToken: "tok-999",
    },
    responseStatus: 200,
    responseBody: { ok: true, echo: `used ${CLEAN_FIXTURE_CRED}` },
    ok: true,
    errorMessage: `Header x-api-key: ${CLEAN_FIXTURE_CRED} and Bearer hidden-bearer-val`,
    actor: "chriss@primarycompanies.com",
    supabaseClient: mockSb,
    liveInsert: true,
    redactValues: [CLEAN_FIXTURE_CRED],
  });

  const serialized = JSON.stringify({ record, insertedRows, ring: getTaiPushLogs(5) });
  assert.ok(!serialized.includes(CLEAN_FIXTURE_CRED), "raw credential must never appear in logs");
  assert.ok(!serialized.includes("super-secret-jwt-value"));
  assert.ok(!serialized.includes("top-secret-123"));
  assert.ok(!serialized.includes("tok-999"));
  assert.ok(!serialized.includes("hidden-bearer-val"));
  assert.equal(record.requestHeaders?.["x-api-key"], "[REDACTED]");
  assert.equal(record.requestHeaders?.Authorization, "[REDACTED]");
  assert.equal((record.requestPayload as Record<string, unknown>).nestedSecret, "[REDACTED]");
  assert.equal((record.requestPayload as Record<string, unknown>).authToken, "[REDACTED]");
  assert.equal(insertedRows.length, 1);
  assert.equal(insertedRows[0].shipment_id, "849201");
  assert.equal(insertedRows[0].kind, "sell_charges");
});

test("previewToken validation, 409 duplicate guard + confirmDuplicate, and full 3-step live TAI push flow", async () => {
  resetTaiAuthHalt();
  clearTaiPushLogs();
  const localShipments: OpsShipment[] = [];
  const auditInserts: Array<Record<string, unknown>> = [];
  const mockAuditSb = {
    from(_table: string) {
      return {
        async insert(row: Record<string, unknown>) {
          auditInserts.push(row);
          return { error: null };
        },
      };
    },
  } as unknown as SupabaseClient;

  const taiCalls: Array<{ method: string; url: string; headers: Record<string, string>; body: unknown }> = [];
  let shipmentCounter = 849200;
  const mockTaiFetch: typeof fetch = async (url, init) => {
    const method = String(init?.method || "GET").toUpperCase();
    const rawHeaders = (init?.headers || {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    taiCalls.push({ method, url: String(url), headers: rawHeaders, body });

    if (String(url).endsWith("/PublicApi/Shipping/v2/Shipments") && method === "POST") {
      shipmentCounter += 1;
      return new Response(JSON.stringify({ shipmentId: String(shipmentCounter) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const entry = makeValidLoadEntry();
  const preview = previewTaiBooking(entry);
  assert.equal(preview.ok, true);
  assert.match(preview.previewToken, /^[0-9a-f]{64}$/);
  // Resolved from store.customers (LARKIN -> 698049) & store.carriers (EVANS -> 18412)
  assert.equal(preview.context.customerId, 698049);
  assert.equal(preview.context.carrierMasterId, 18412);
  assert.equal(preview.body.customerId, 698049);

  await withApiServer(
    {
      bookingOptions: {
        credential: FIXTURE_CRED,
        baseUrl: "https://tai.fixture.test",
        liveAllowed: true,
        billingWriteEnabled: true,
        writebackEnabled: true,
        fetchImpl: mockTaiFetch,
        shipments: localShipments,
        supabaseClient: mockAuditSb,
        liveInsertAudit: true,
      },
    },
    async (baseUrl) => {
      // 1. Preview via HTTP route
      const prevRes = await fetch(`${baseUrl}/api/loads/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entry }),
      });
      assert.equal(prevRes.status, 200);
      const prevBody = (await prevRes.json()) as typeof preview;
      assert.equal(prevBody.previewToken, preview.previewToken);
      assert.equal(prevBody.context.customerId, 698049);
      assert.equal(prevBody.context.carrierMasterId, 18412);

      // 2. Mutating draft after preview triggers 409 requiresPreviewRefresh without calling TAI
      const mutatedEntry = structuredClone(entry);
      mutatedEntry.pricing.linehaulSell = 3100;
      const staleRes = await fetch(`${baseUrl}/api/loads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entry: mutatedEntry, previewToken: prevBody.previewToken }),
      });
      assert.equal(staleRes.status, 409);
      const staleJson = (await staleRes.json()) as { ok: boolean; requiresPreviewRefresh?: boolean };
      assert.equal(staleJson.ok, false);
      assert.equal(staleJson.requiresPreviewRefresh, true);
      assert.equal(taiCalls.length, 0);

      // 3. Valid previewToken executes 3-step TAI push: POST /Shipments -> PUT /ShipmentCharges -> PUT /CarrierCharges
      const bookRes = await fetch(`${baseUrl}/api/loads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entry, previewToken: prevBody.previewToken }),
      });
      assert.equal(bookRes.status, 201);
      const booked = (await bookRes.json()) as {
        ok: boolean;
        shipmentId: string;
        createdIds: string[];
        tai: { shipmentId: string; rates: { sell: { ok: boolean; price: number }; buy: { ok: boolean; price: number; carrierMasterId: number } } };
      };
      assert.equal(booked.ok, true);
      assert.equal(booked.shipmentId, "849201");
      assert.deepEqual(booked.createdIds, ["849201"]);
      assert.equal(booked.tai.rates.sell.ok, true);
      assert.equal(booked.tai.rates.sell.price, 2800); // 2650 linehaul + 150 tarp
      assert.equal(booked.tai.rates.buy.ok, true);
      assert.equal(booked.tai.rates.buy.price, 2200); // 2100 linehaul + 100 tarp
      assert.equal(booked.tai.rates.buy.carrierMasterId, 18412);

      assert.equal(taiCalls.length, 3);
      assert.equal(taiCalls[0].headers["x-api-key"], CLEAN_FIXTURE_CRED);
      assert.equal(taiCalls[0].method, "POST");
      assert.equal(taiCalls[0].url, "https://tai.fixture.test/PublicApi/Shipping/v2/Shipments");

      assert.equal(taiCalls[1].method, "PUT");
      assert.equal(taiCalls[1].url, "https://tai.fixture.test/PublicApi/Shipping/v2/ShipmentCharges");
      assert.deepEqual(taiCalls[1].body, {
        referenceNumbers: [{ referenceType: "Shipment Id", value: "849201" }],
        transitType: "Linehaul",
        charges: [{ chargeType: "Linehaul", price: 2800, calculationType: "Flat" }],
      });

      assert.equal(taiCalls[2].method, "PUT");
      assert.equal(taiCalls[2].url, "https://tai.fixture.test/PublicApi/Shipping/v2/CarrierCharges");
      assert.deepEqual(taiCalls[2].body, {
        referenceNumbers: [{ referenceType: "Shipment Id", value: "849201" }],
        transitType: "Linehaul",
        charges: [{ chargeType: "Linehaul", price: 2200, calculationType: "Flat" }],
        carrierMasterId: 18412,
      });

      // Verify all 3 pushes were audited with redacted credentials
      assert.equal(auditInserts.length, 3);
      assert.ok(!JSON.stringify(auditInserts).includes(CLEAN_FIXTURE_CRED));

      // 4. Re-submitting identical PO triggers 409 Duplicate Guard
      const dupPoRes = await fetch(`${baseUrl}/api/loads/book`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entry, previewToken: prevBody.previewToken }),
      });
      assert.equal(dupPoRes.status, 409);
      const dupPoBody = (await dupPoRes.json()) as {
        ok: boolean;
        duplicateOf: string;
        matchedOn: string;
        requiresDuplicateConfirmation: boolean;
      };
      assert.equal(dupPoBody.ok, false);
      assert.equal(dupPoBody.duplicateOf, "849201");
      assert.equal(dupPoBody.matchedOn, "customerPO");
      assert.equal(dupPoBody.requiresDuplicateConfirmation, true);
      assert.equal(taiCalls.length, 3); // TAI not called on blocked duplicate!

      // 5. Blank PO on same customer + originZip + destZip + pickup readyDate also triggers 409 Duplicate Guard
      const laneDupEntry = structuredClone(entry);
      laneDupEntry.references.customerPO = "";
      const lanePrev = previewTaiBooking(laneDupEntry);
      const dupLaneRes = await fetch(`${baseUrl}/api/loads/book`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entry: laneDupEntry, previewToken: lanePrev.previewToken }),
      });
      assert.equal(dupLaneRes.status, 409);
      const dupLaneBody = (await dupLaneRes.json()) as { matchedOn: string; requiresDuplicateConfirmation: boolean };
      assert.equal(dupLaneBody.matchedOn, "originZip+destZip+readyDate");
      assert.equal(dupLaneBody.requiresDuplicateConfirmation, true);

      // 6. Explicit confirmDuplicate: true proceeds cleanly and books #849202
      const confirmedRes = await fetch(`${baseUrl}/api/loads/book`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entry, previewToken: prevBody.previewToken, confirmDuplicate: true }),
      });
      assert.equal(confirmedRes.status, 200);
      const confirmedBody = (await confirmedRes.json()) as { ok: boolean; shipmentId: string };
      assert.equal(confirmedBody.ok, true);
      assert.equal(confirmedBody.shipmentId, "849202");
      assert.equal(taiCalls.length, 6);
    },
  );
});

test("live ambiguous 200 without shipmentId never invents fake 1327425xx ID and never retries", async () => {
  resetTaiAuthHalt();
  clearTaiPushLogs();
  const localShipments: OpsShipment[] = [];
  let postCount = 0;

  const entry = makeValidLoadEntry({ references: { ...makeValidLoadEntry().references, customerPO: "AMBIG-200" } });
  const outcome = await bookTaiLoads(entry, {
    credential: CLEAN_FIXTURE_CRED,
    baseUrl: "https://tai.fixture.test",
    liveAllowed: true,
    shipments: localShipments,
    fetchImpl: async () => {
      postCount += 1;
      return new Response(JSON.stringify({ message: "Accepted without id" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(postCount, 1);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 502);
  assert.equal(outcome.needsHumanReconciliation, true);
  assert.deepEqual(outcome.createdIds, []);
  assert.equal(localShipments.length, 0);
  const latestLog = getTaiPushLogs(1)[0];
  assert.equal(latestLog.kind, "create_shipment");
  assert.equal(latestLog.needsHuman, true);
  assert.equal(latestLog.ok, false);
});

test("HTTP 401 halts immediately on both bookTaiLoads and tai-writeback-poller with zero retries", async () => {
  resetTaiAuthHalt();
  resetWritebackPollerHalt();
  clearTaiPushLogs();

  const badCred = "fixture-expired-tai-cred-401";
  let bookingFetchCount = 0;
  const entry = makeValidLoadEntry({ references: { ...makeValidLoadEntry().references, customerPO: "AUTH-401" } });

  const firstAttempt = await bookTaiLoads(entry, {
    credential: badCred,
    baseUrl: "https://tai.fixture.test",
    liveAllowed: true,
    shipments: [],
    fetchImpl: async () => {
      bookingFetchCount += 1;
      return new Response("Unauthorized", { status: 401 });
    },
  });

  assert.equal(bookingFetchCount, 1);
  assert.equal(firstAttempt.ok, false);
  assert.equal(firstAttempt.status, 502);
  assert.equal(firstAttempt.haltedOnAuth, true);
  assert.equal(firstAttempt.needsHumanReconciliation, true);
  assert.equal(isTaiAuthHalted(badCred), true);
  assert.equal(isWritebackPollerHalted().halted, true);

  // Second attempt with halted credential makes ZERO network calls to TAI (prevents account lockout!)
  const secondAttempt = await bookTaiLoads(entry, {
    credential: badCred,
    baseUrl: "https://tai.fixture.test",
    liveAllowed: true,
    shipments: [],
    fetchImpl: async () => {
      bookingFetchCount += 1;
      return new Response("Should never be called", { status: 200 });
    },
  });
  assert.equal(bookingFetchCount, 1);
  assert.equal(secondAttempt.ok, false);
  assert.equal(secondAttempt.haltedOnAuth, true);

  // Also test poller processWritebackRow directly on HTTP 401
  resetTaiAuthHalt();
  resetWritebackPollerHalt();
  let pollerFetchCount = 0;
  const rowUpdates: Array<Record<string, unknown>> = [];
  const mockPollerDb = {
    from(table: string) {
      if (table === "tai_carrier_assignments") {
        return {
          update(patch: Record<string, unknown>) {
            rowUpdates.push(patch);
            const chain = {
              eq: () => chain,
              in: () => chain,
              select: () => ({ maybeSingle: async () => ({ data: { id: 77 } }) }),
              then: (resolve: (val: unknown) => unknown) => Promise.resolve(resolve({ error: null })),
            };
            return chain;
          },
        };
      }
      return {
        insert: async () => ({ error: null }),
      };
    },
  } as unknown as SupabaseClient;

  const row: AssignmentRow = {
    id: 77,
    shipment_id: "132738007",
    carrier_master_id: 29102,
    carrier_name: "ROXOR INC",
    buy_rate: 6500,
    attempts: 0,
    max_attempts: 3,
    dry_run: false,
    requested_by: "fivenines-ops",
  };

  const pollerOutcome = await processWritebackRow(mockPollerDb, row, {
    taiBase: "https://tai.fixture.test",
    credential: "fixture-poller-401-cred",
    liveInsertAudit: false,
    fetchImpl: async () => {
      pollerFetchCount += 1;
      return new Response("Unauthorized key", { status: 401 });
    },
  });

  assert.equal(pollerFetchCount, 1);
  assert.equal(pollerOutcome.status, "needs_human");
  assert.equal(pollerOutcome.haltedOnAuth, true);
  assert.equal(isWritebackPollerHalted().halted, true);
  const terminalPatch = rowUpdates[rowUpdates.length - 1];
  assert.equal(terminalPatch.status, "needs_human");
  assert.equal(terminalPatch.next_attempt_at, null);

  resetTaiAuthHalt();
  resetWritebackPollerHalt();
});

test("non-numeric shipmentId guard blocks local IDs (QC-1043, SBX-...) from hitting TAI while numeric IDs sync", async () => {
  resetTaiAuthHalt();
  resetWritebackPollerHalt();

  // 1. Poller refuses non-numeric QC-1043 without calling fetch
  let fetchCalls = 0;
  const patches: Array<Record<string, unknown>> = [];
  const mockDb = {
    from(table: string) {
      if (table === "tai_carrier_assignments") {
        return {
          update(patch: Record<string, unknown>) {
            patches.push(patch);
            return { eq: async () => ({ error: null }) };
          },
        };
      }
      return { insert: async () => ({ error: null }) };
    },
  } as unknown as SupabaseClient;

  const nonNumRes = await processWritebackRow(
    mockDb,
    {
      id: 88,
      shipment_id: "QC-1043",
      carrier_master_id: 18412,
      carrier_name: "EVANS DELIVERY COMPANY INC",
      buy_rate: 1900,
      attempts: 0,
      max_attempts: 3,
      dry_run: false,
    },
    {
      taiBase: "https://tai.fixture.test",
      credential: CLEAN_FIXTURE_CRED,
      liveInsertAudit: false,
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response("{}", { status: 200 });
      },
    },
  );
  assert.equal(nonNumRes.status, "needs_human");
  assert.equal(fetchCalls, 0);
  assert.equal(patches[0].status, "needs_human");

  // 2. Check-call and Reference updates on local non-numeric shipment skip TAI HTTP calls
  const tempLocalShipment: OpsShipment = {
    ...structuredClone(store.shipments[0]),
    id: "QC-1043",
  };
  store.shipments.unshift(tempLocalShipment);
  try {
    const ccLocal = await pushShipmentCheckCall(
      "QC-1043",
      { status: "Cancelled", location: "Houston, TX" },
      {
        credential: CLEAN_FIXTURE_CRED,
        baseUrl: "https://tai.fixture.test",
        liveAllowed: true,
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response("{}", { status: 200 });
        },
      },
    );
    assert.equal(ccLocal.ok, true);
    assert.equal(ccLocal.taiSynced, false);
    assert.equal(ccLocal.taiStatus, "Canceled"); // One 'l'
    assert.equal(fetchCalls, 0);

    const refLocal = await pushShipmentReferences(
      "QC-1043",
      { po: "PO-LOCAL-1", bol: "BOL-LOCAL-1", pro: "PRO-LOCAL-1" },
      {
        credential: CLEAN_FIXTURE_CRED,
        baseUrl: "https://tai.fixture.test",
        liveAllowed: true,
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response("{}", { status: 200 });
        },
      },
    );
    assert.equal(refLocal.ok, true);
    assert.equal(refLocal.taiSynced, false);
    assert.equal(fetchCalls, 0);
  } finally {
    store.deleteShipment("QC-1043");
    store.deletedShipmentIds.delete("QC-1043");
  }

  // 3. Numeric TAI shipmentId sends PUT /Tracking ("Canceled" w/ one 'l') and bare-array PUT /ShipmentReferenceNumbers?shipmentId=...
  const seenRequests: Array<{ url: string; body: unknown }> = [];
  const ccNumeric = await pushShipmentCheckCall(
    "132742212",
    { status: "Cancelled", location: "Lithonia, GA", note: "Customer canceled pickup" },
    {
      credential: CLEAN_FIXTURE_CRED,
      baseUrl: "https://tai.fixture.test",
      liveAllowed: true,
      liveInsertAudit: false,
      fetchImpl: async (url, init) => {
        seenRequests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response("{}", { status: 200 });
      },
    },
  );
  assert.equal(ccNumeric.ok, true);
  assert.equal(ccNumeric.taiSynced, true);
  assert.equal(seenRequests[0].url, "https://tai.fixture.test/PublicApi/Shipping/v2/Tracking");
  assert.deepEqual(seenRequests[0].body, {
    shipmentId: 132742212,
    transitType: "Linehaul",
    trackingUpdate: { shipmentStatus: "Canceled" },
  });

  const refNumeric = await pushShipmentReferences(
    "132742212",
    { po: "LR-88412", bol: "BOL-42212", pro: "PRO-991" },
    {
      credential: CLEAN_FIXTURE_CRED,
      baseUrl: "https://tai.fixture.test",
      liveAllowed: true,
      liveInsertAudit: false,
      fetchImpl: async (url, init) => {
        seenRequests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response("{}", { status: 200 });
      },
    },
  );
  assert.equal(refNumeric.ok, true);
  assert.equal(refNumeric.taiSynced, true);
  assert.equal(
    seenRequests[1].url,
    "https://tai.fixture.test/PublicApi/Shipping/v2/ShipmentReferenceNumbers?shipmentId=132742212",
  );
  assert.ok(Array.isArray(seenRequests[1].body), "ShipmentReferenceNumbers body must be a bare JSON array");
  assert.deepEqual(seenRequests[1].body, [
    { referenceType: "Customer PO Number", value: "LR-88412" },
    { referenceType: "Shipper Reference Number", value: "BOL-42212" },
    { referenceType: "Linehaul Carrier Pro Number", value: "PRO-991" },
  ]);
});

test("exact integer-mils FSC ($5.50 -> 51.0%, $4.10 ODFL -> 31.82%), equipment bucketing, linehaul separation, and invoice lineItems[]", async () => {
  // 1. Drayage / Nickel FSC at $5.50 must be 0.510 / 51.0% (never binary float underflow 50.5%)
  const drayFsc = calculateFuelSurcharge({ dieselPrice: 5.5, schedule: "drayage" });
  assert.equal(drayFsc.ok, true);
  if (drayFsc.ok) {
    assert.equal(drayFsc.rate, 0.51);
    assert.equal(drayFsc.percent, 51.0);
    assert.equal(drayFsc.formattedPercent, "51.0%");
  }

  // 2. ODFL FSC at $4.10 must use Math.round(d * 1000) / 10 -> 410 cents -> 31.82%
  const odflFsc = calculateFuelSurcharge({ dieselPrice: 4.1, schedule: "odfl" });
  assert.equal(odflFsc.ok, true);
  if (odflFsc.ok) {
    assert.equal(odflFsc.percent, 31.82);
    assert.equal(odflFsc.rate, 0.3182);
    assert.equal(odflFsc.formattedPercent, "31.82%");
  }

  // 3. Invalid pegPrice (NaN, 0, negative) is rejected with status 400
  assert.equal(calculateFuelSurcharge({ dieselPrice: 4.0, pegPrice: Number.NaN }).status, 400);
  assert.equal(calculateFuelSurcharge({ dieselPrice: 4.0, pegPrice: 0 }).status, 400);
  assert.equal(calculateFuelSurcharge({ dieselPrice: 4.0, pegPrice: -1.25 }).status, 400);

  // 4. Equipment family bucketing order checks specific vehicle types BEFORE generic | Reefer
  assert.equal(normalizeEquipmentFamily("Sprinter Van | Reefer"), "sprinter");
  assert.equal(normalizeEquipmentFamily("40 ft Straight Truck w/ Tailgate | Reefer"), "box_truck");
  assert.equal(normalizeEquipmentFamily("24 ft City Truck w/ Liftgate | Reefer"), "box_truck");
  assert.equal(normalizeEquipmentFamily("Flatbed | Reefer Tri-Axle"), "flatbed");
  assert.equal(normalizeEquipmentFamily("Tanker | Intermodal"), "drayage");
  assert.equal(normalizeEquipmentFamily("Container | Flexibag"), "drayage");
  assert.equal(normalizeEquipmentFamily("53 ft Reefer"), "reefer");
  assert.equal(normalizeEquipmentFamily("53 ft Van | Reefer"), "reefer");
  assert.equal(normalizeEquipmentFamily("53 ft Van | Dry"), "dry_van");

  // 5. Invoice webhook preserves lineItems[] and recognizes TAI paymentStatus enum
  const invOut = handleTaiInvoiceWebhook({
    shipmentId: "132738007",
    invoiceNumber: "INV-55102",
    invoiceType: "AR",
    paymentStatus: "Partial Paid",
    totalAmount: 4635,
    lineItems: [
      { description: "Linehaul", accessorialCode: "LH", amount: 4400, quantity: 1, calculationType: "Flat" },
      { description: "Pier Pass - Shipment", accessorialCode: "145", amount: 85, quantity: 1, calculationType: "Flat" },
      { description: "Detention - Pickup", accessorialCode: "15", amount: 150, quantity: 2, calculationType: "Hourly" },
    ],
  });
  assert.equal(invOut.ok, true);
  assert.equal(invOut.paymentStatus, "Partial Paid");
  assert.equal(invOut.lineItems.length, 3);
  assert.equal(invOut.lineItems[1].accessorialCode, "145");
  assert.ok(invOut.observedAccessorials.some((o) => o.accessorialCode === "145" && o.description === "Pier Pass - Shipment"));

  // 6. Verify HTTP routes for /api/rates/estimate (linehaul_only vs allInPerMile, useDatLane: false), /api/rates/fsc, session, BOL/RateCon, drafts, knowledge, check-email, transcribe-attachment
  await withApiServer(
    {
      env: { GOOGLE_CLIENT_ID: "test-google-client.apps.googleusercontent.com" },
      helperOptions: {
        credential: CLEAN_FIXTURE_CRED,
        baseUrl: "https://tai.fixture.test",
        liveAllowed: true,
        addressBookSaveEnabled: false,
      },
    },
    async (baseUrl) => {
      // Rate estimator separates linehaulPerMile from accessorials and forces useDatLane: false
      const rateRes = await fetch(`${baseUrl}/api/rates/estimate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          originState: "GA",
          destState: "LA",
          equipment: "53 ft Flatbed | Tarp",
          useDatLane: true,
        }),
      });
      assert.equal(rateRes.status, 200);
      const rateBody = (await rateRes.json()) as {
        ok: boolean;
        useDatLane: boolean;
        comparisonBasis: string;
        equipmentFamily: string;
        linehaulPerMile: number;
        allInPerMile: number;
        linehaulTargetSell: number;
        allInTargetSell: number;
      };
      assert.equal(rateBody.ok, true);
      assert.equal(rateBody.useDatLane, false);
      assert.equal(rateBody.comparisonBasis, "linehaul_only");
      assert.equal(rateBody.equipmentFamily, "flatbed");
      // GA -> LA seeded load #132742212 has $2,450 all-in with Tarp ($150) + Appointment ($50) -> $2,250 base linehaul
      assert.ok(rateBody.linehaulTargetSell < rateBody.allInTargetSell);
      assert.ok(rateBody.linehaulPerMile < rateBody.allInPerMile);

      // /api/rates/fsc rejects negative pegPrice with 400
      const badFscRes = await fetch(`${baseUrl}/api/rates/fsc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dieselPrice: 4.1, pegPrice: -2 }),
      });
      assert.equal(badFscRes.status, 400);

      // /api/gmail-panel/session + x-gmail-panel-expected-email drift protection
      const sessOk = await fetch(`${baseUrl}/api/gmail-panel/session`, {
        headers: { "x-gmail-panel-expected-email": "chriss@primarycompanies.com" },
      });
      assert.equal(sessOk.status, 200);
      const sessJson = (await sessOk.json()) as { ok: boolean; csrfToken: string; oauthEnabled: boolean };
      assert.equal(sessJson.ok, true);
      assert.equal(sessJson.oauthEnabled, true);
      assert.equal(sessJson.csrfToken.length, 32);

      const sessDrift = await fetch(`${baseUrl}/api/gmail-panel/session`, {
        headers: { "x-gmail-panel-expected-email": "someoneelse@primarycompanies.com" },
      });
      assert.equal(sessDrift.status, 409);
      assert.equal(((await sessDrift.json()) as { error: string }).error, "toolkit_account_changed");

      // BOL & RateCon hydration
      const bolRes = await fetch(`${baseUrl}/api/loads/132742212/bol`);
      assert.equal(bolRes.status, 200);
      const bolBody = (await bolRes.json()) as { ok: boolean; shipmentId: string; printableHtml: string };
      assert.equal(bolBody.ok, true);
      assert.equal(bolBody.shipmentId, "132742212");
      assert.match(bolBody.printableHtml, /STRAIGHT BILL OF LADING/);

      const rcRes = await fetch(`${baseUrl}/api/loads/132738007/ratecon`);
      assert.equal(rcRes.status, 200);
      assert.match(((await rcRes.json()) as { summaryText: string }).summaryText, /CARRIER RATE CONFIRMATION/);

      // Facility save gates TAI Address Book write when TAI_ADDRESS_BOOK_SAVE_ENABLED !== "true"
      const facRes = await fetch(`${baseUrl}/api/facilities/save`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          companyName: "Gulf Coast Steel Works",
          streetAddress: "900 Port Industrial Rd",
          city: "Houston",
          state: "TX",
          zipCode: "77015",
        }),
      });
      assert.equal(facRes.status, 200);
      const facJson = (await facRes.json()) as { ok: boolean; taiAddressBookSaved: boolean; taiAddressBookGated: boolean };
      assert.equal(facJson.ok, true);
      assert.equal(facJson.taiAddressBookSaved, false);
      assert.equal(facJson.taiAddressBookGated, true);

      // Panel knowledge + check-email cancellation detection + PDF attachment transcription
      const knowRes = await fetch(`${baseUrl}/api/panel/knowledge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entry: makeValidLoadEntry() }),
      });
      assert.equal(knowRes.status, 200);
      const knowJson = (await knowRes.json()) as { ok: boolean; learnedCount: number };
      assert.equal(knowJson.ok, true);
      assert.ok(knowJson.learnedCount >= 1);

      const cancelCheck = await fetch(`${baseUrl}/api/panel/check-email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject: "URGENT: Load #132742212",
          bodyText: "Please cancel this load immediately — customer order has been cancelled.",
        }),
      });
      assert.equal(cancelCheck.status, 200);
      const cancelJson = (await cancelCheck.json()) as {
        cancellation: { detected: boolean };
        diffs: Array<{ type: string; shipmentId: string }>;
      };
      assert.equal(cancelJson.cancellation.detected, true);
      assert.ok(cancelJson.diffs.some((d) => d.type === "cancellation" && d.shipmentId === "132742212"));

      // Compressed FlateDecode PDF tender transcription -> extractLoadEntryFromEmail
      const pdfStreamText =
        "BT (Please book PO #55801 from 300 Tomlinson Drive, Zelienople, PA 16063 to 2331 Varkel Way, Lithonia, GA 30058. 14 pallets, 34,000 lbs refractory brick, 48 ft Flatbed.) Tj ET";
      const deflated = zlib.deflateSync(Buffer.from(pdfStreamText, "latin1"));
      const fakePdf = Buffer.concat([
        Buffer.from("%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n", "latin1"),
        deflated,
        Buffer.from("\nendstream\nendobj\n%%EOF", "latin1"),
      ]);
      const transRes = await fetch(`${baseUrl}/api/panel/transcribe-attachment`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fileName: "Larkin_Tender_55801.pdf",
          mimeType: "application/pdf",
          base64: fakePdf.toString("base64"),
        }),
      });
      assert.equal(transRes.status, 200);
      const transJson = (await transRes.json()) as { ok: boolean; transcript: string; entry: LoadEntry };
      assert.equal(transJson.ok, true);
      assert.match(transJson.transcript, /55801/);
      assert.equal(transJson.entry.stops[0].zipCode, "16063");
      assert.equal(transJson.entry.stops[1].zipCode, "30058");
    },
  );
});
