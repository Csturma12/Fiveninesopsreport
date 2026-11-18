import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { deriveRateconStatus, mapTaiStatusToStage } from "../shared/tai-webhook-schema";
import { setStaffGmailAccessToken } from "../server/auth";
import { registerApiRoutes, type RegisterApiRoutesOptions } from "../server/routes";
import {
  buildValidGmailPermalink,
  mapSupabaseShipmentRow,
  normalizeCompanyIdentity,
  store,
} from "../server/store";
import { clearTaiPushLogs, resetTaiAuthHalt } from "../server/tai-push-log";

const FIXTURE_CRED = "fixture-phase2-tai-cred-7741";

async function withServer(
  options: RegisterApiRoutesOptions & { staffEmail?: string } = {},
  run: (baseUrl: string) => Promise<void>,
) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    req.staffUser = {
      email: options.staffEmail ?? "chriss@primarycompanies.com",
      name: "Chris Sturma",
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

test("mapTaiStatusToStage and deriveRateconStatus handle Covered Committed, Cancelled, Out for Delivery, and Not Sent", () => {
  assert.equal(mapTaiStatusToStage("Committed", "FOX CARRIERS"), "Assigned");
  assert.equal(mapTaiStatusToStage("Committed", ""), "Needs truck");
  assert.equal(mapTaiStatusToStage("Booked", "EVANS DELIVERY"), "Assigned");
  assert.equal(mapTaiStatusToStage("Ready", "ROXOR INC"), "Assigned");
  assert.equal(mapTaiStatusToStage("Dispatched", ""), "Assigned");
  assert.equal(mapTaiStatusToStage("Cancelled", "ANY CARRIER"), "Cancelled");
  assert.equal(mapTaiStatusToStage("Canceled", "ANY CARRIER"), "Cancelled");
  assert.equal(mapTaiStatusToStage("Out for Delivery", "TRUCKLINE"), "In transit");
  assert.equal(mapTaiStatusToStage("In Transit", "ROXOR"), "In transit");
  assert.equal(mapTaiStatusToStage("Delivered", "FOX"), "Delivered");

  // Explicit "Not Sent" must NEVER be overwritten just because carrier_name is populated
  assert.equal(deriveRateconStatus({ ratecon_status: "Not Sent", carrier_name: "FOX CARRIERS" }), "Not Sent");
  assert.equal(deriveRateconStatus({ ratecon_status: "Signed", carrier_name: "FOX CARRIERS" }), "Signed");
  assert.equal(deriveRateconStatus({ ratecon_status: "Drafted", carrier_name: "FOX CARRIERS" }), "Drafted");
  assert.equal(
    deriveRateconStatus({ ratecon_status: "", status: "Committed", tai_raw_status: "Booked", carrier_name: "FOX" }),
    "Not Sent",
  );
  assert.equal(deriveRateconStatus({ ratecon_status: "", status: "Dispatched", carrier_name: "FOX" }), "Sent");

  // mapSupabaseShipmentRow maps covered Committed -> Assigned, Cancelled -> Cancelled, and pod_status=found -> podCount >= 1
  const coveredRow = mapSupabaseShipmentRow({
    shipment_id: "132799001",
    status: "Committed",
    tai_raw_status: "Booked",
    customer_name: "IMC LOGISTICS",
    carrier_name: "FOX CARRIERS",
    ratecon_status: "Not Sent",
    pod_status: "none",
    pod_document_count: 0,
    from_city: "HOUSTON",
    from_state: "TX",
    to_city: "MEMPHIS",
    to_state: "TN",
    ship_date: "2026-11-20",
    sell: 2200,
    buy: 1800,
  });
  assert.equal(coveredRow.stage, "Assigned");
  assert.equal(coveredRow.rateconStatus, "Not Sent");
  assert.equal(coveredRow.podCount, 0);

  const deliveredPodFound = mapSupabaseShipmentRow({
    shipment_id: "132799002",
    status: "Delivered",
    customer_name: "AXIS INDUSTRIES",
    carrier_name: "FOX CARRIERS",
    pod_status: "found",
    pod_document_count: 0,
  });
  assert.equal(deliveredPodFound.stage, "Delivered");
  assert.equal(deliveredPodFound.podCount, 1);

  const cancelledRow = mapSupabaseShipmentRow({
    shipment_id: "132799003",
    status: "Cancelled",
    tai_raw_status: "Canceled",
    customer_name: "IMC LOGISTICS",
    carrier_name: "",
  });
  assert.equal(cancelledRow.stage, "Cancelled");
});

test("SalesOps CRM strips and blocks existing TAI customers regardless of INC/LLC/SOLUTIONS suffixes", async () => {
  assert.equal(normalizeCompanyIdentity("Larkin Refractory Solutions, Inc."), "larkin refractory");
  assert.equal(normalizeCompanyIdentity("LARKIN REFRACTORY LLC"), "larkin refractory");
  assert.equal(store.isExistingCustomer("Larkin Refractory, Inc.").existing, true);
  assert.equal(store.isExistingCustomer("IMC Logistics, LLC").existing, true);
  assert.equal(store.isExistingCustomer("Odyssey Intermodal Corp.").existing, true);

  await withServer({}, async (baseUrl) => {
    const blockedRes = await fetch(`${baseUrl}/api/crm/leads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        company: "Larkin Refractory, Inc.",
        contact: "Ops",
        email: "ops@larkin.example",
      }),
    });
    assert.equal(blockedRes.status, 409);
    const blockedBody = (await blockedRes.json()) as { ok: boolean; blockedExistingCustomer?: boolean };
    assert.equal(blockedBody.ok, false);
    assert.equal(blockedBody.blockedExistingCustomer, true);

    const netNewRes = await fetch(`${baseUrl}/api/crm/leads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        company: "Brazosport Precision Forging LLC",
        contact: "shipping@brazosforging.example",
        location: "Freeport, TX",
      }),
    });
    assert.equal(netNewRes.status, 200);
    const netNewJson = (await netNewRes.json()) as { ok: boolean; lead: { id: string } };
    assert.equal(netNewJson.ok, true);
    store.deleteCrmLead(netNewJson.lead.id);
  });
});

test("GET /api/loads paging, PATCH /api/loads/:id full edit w/ live TAI writeback, and PATCH /api/loads/:id/ratecon-status", async () => {
  resetTaiAuthHalt();
  clearTaiPushLogs();

  const seenTaiCalls: Array<{ method: string; url: string; body: unknown }> = [];

  await withServer(
    {
      bookingOptions: { billingWriteEnabled: true },
      helperOptions: {
        credential: FIXTURE_CRED,
        baseUrl: "https://tai.fixture.test",
        liveAllowed: true,
        writebackEnabled: true,
        liveInsertAudit: false,
        fetchImpl: async (url, init) => {
          seenTaiCalls.push({
            method: String(init?.method || "GET"),
            url: String(url),
            body: init?.body ? JSON.parse(String(init.body)) : null,
          });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      },
    },
    async (baseUrl) => {
      // 1. Paged GET /api/loads
      const listRes = await fetch(`${baseUrl}/api/loads?page=1&pageSize=2&status=Needs%20Truck`);
      assert.equal(listRes.status, 200);
      const listBody = (await listRes.json()) as {
        ok: boolean;
        items: Array<{ id: string; stage: string }>;
        total: number;
        statusCounts: Record<string, number>;
      };
      assert.equal(listBody.ok, true);
      assert.ok(listBody.total >= 1);
      assert.ok(listBody.items.every((i) => i.stage === "Needs truck"));
      assert.ok(typeof listBody.statusCounts["Needs Truck"] === "number");

      // 2. PATCH /api/loads/:id/ratecon-status
      const rcPatch = await fetch(`${baseUrl}/api/loads/132742212/ratecon-status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rateconStatus: "Signed" }),
      });
      assert.equal(rcPatch.status, 200);
      const rcJson = (await rcPatch.json()) as { ok: boolean; rateconStatus: string };
      assert.equal(rcJson.ok, true);
      assert.equal(rcJson.rateconStatus, "Signed");

      // 3. PATCH /api/loads/:id full edit pushes Sell, Carrier+Buy, References, and Tracking ("Canceled" 1 l)
      const target = store.shipments.find((s) => s.id === "132742212")!;
      const snap = structuredClone(target);
      try {
        const editRes = await fetch(`${baseUrl}/api/loads/132742212`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            carrier: "FOX CARRIERS",
            buy: 1925,
            sell: 2650,
            po: "PO-EDIT-901",
            status: "Cancelled",
            shipDate: "2026-11-25",
            pushToTai: true,
          }),
        });
        assert.equal(editRes.status, 200);
        const editJson = (await editRes.json()) as {
          ok: boolean;
          shipment: { stage: string; sell: number; buy: number; po: string; carrier: string };
          taiWriteback: {
            attempted: boolean;
            sellCharges?: { ok: boolean };
            carrierCharges?: { ok: boolean };
            references?: { ok: boolean };
            tracking?: { ok: boolean };
          };
        };
        assert.equal(editJson.ok, true);
        assert.equal(editJson.shipment.stage, "Cancelled");
        assert.equal(editJson.shipment.sell, 2650);
        assert.equal(editJson.shipment.buy, 1925);
        assert.equal(editJson.shipment.po, "PO-EDIT-901");
        assert.equal(editJson.taiWriteback.attempted, true);
        assert.equal(editJson.taiWriteback.sellCharges?.ok, true);
        assert.equal(editJson.taiWriteback.carrierCharges?.ok, true);
        assert.equal(editJson.taiWriteback.references?.ok, true);
        assert.equal(editJson.taiWriteback.tracking?.ok, true);

        const urls = seenTaiCalls.map((c) => c.url);
        assert.ok(urls.some((u) => u.endsWith("/PublicApi/Shipping/v2/ShipmentCharges")));
        assert.ok(urls.some((u) => u.endsWith("/PublicApi/Shipping/v2/CarrierCharges")));
        assert.ok(urls.some((u) => u.includes("/PublicApi/Shipping/v2/ShipmentReferenceNumbers?shipmentId=132742212")));
        const trackingCall = seenTaiCalls.find((c) => c.url.endsWith("/PublicApi/Shipping/v2/Tracking"));
        assert.ok(trackingCall);
        assert.equal(
          ((trackingCall.body as { trackingUpdate: { shipmentStatus: string } }).trackingUpdate).shipmentStatus,
          "Canceled",
        );
      } finally {
        Object.assign(target, snap);
      }
    },
  );
});

test("POST /api/inbox/ingest + /api/inbox/sync + buildValidGmailPermalink deduplicate, extract fields, and build valid Gmail URLs", async () => {
  assert.equal(
    buildValidGmailPermalink({ threadId: "1933f0a9c8b41e22", subject: "Tender" }),
    "https://mail.google.com/mail/u/0/#all/1933f0a9c8b41e22",
  );
  assert.equal(
    buildValidGmailPermalink({ threadId: "non-hex-id", subject: "PO 88412" }),
    "https://mail.google.com/mail/u/0/#search/PO%2088412",
  );

  setStaffGmailAccessToken("chriss@primarycompanies.com", "fixture-gmail-oauth-access-token", 300);

  await withServer(
    {
      gmailFetchImpl: async (url) => {
        const u = String(url);
        if (u.includes("/users/me/messages?")) {
          return new Response(
            JSON.stringify({ messages: [{ id: "1933f0a9c8b41e99", threadId: "1933f0a9c8b41e99" }] }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            id: "1933f0a9c8b41e99",
            threadId: "1933f0a9c8b41e99",
            snippet: "Please book PO #77123 from Beaver Falls, PA 15010 to Lithonia, GA 30058",
            labelIds: ["INBOX", "UNREAD"],
            payload: {
              headers: [
                { name: "Subject", value: "Gmail Sync Tender PO #77123" },
                { name: "From", value: "Larkin Shipping <shipping@larkinrefractory.com>" },
                { name: "Date", value: "Wed, 18 Nov 2026 07:00:00 GMT" },
              ],
              mimeType: "text/plain",
              body: {
                data: Buffer.from(
                  "Please book PO #77123 from 400 Enterprise Drive, Beaver Falls, PA 15010 to 2331 Varkel Way, Lithonia, GA 30058. 12 pallets, 30,000 lbs, 48 ft Flatbed, $2,950.",
                  "utf8",
                ).toString("base64url"),
              },
            },
          }),
          { status: 200 },
        );
      },
    },
    async (baseUrl) => {
      const ingestRes = await fetch(`${baseUrl}/api/inbox/ingest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "chrome-extension://abcdefghijklmnop",
        },
        body: JSON.stringify({
          items: [
            {
              threadId: "1933f0a9c8b41e22",
              from: "Larkin Ops <ops@larkinrefractory.com>",
              subject: "Load #132742212 PO #LR-99500",
              bodyText: "Please update Load #132742212 with Customer PO #LR-99500.",
              unread: true,
            },
            {
              threadId: "1933f0a9c8b41e22",
              from: "Larkin Ops <ops@larkinrefractory.com>",
              subject: "Load #132742212 PO #LR-99500",
              bodyText: "Please update Load #132742212 with Customer PO #LR-99500.",
              unread: false,
            },
          ],
        }),
      });
      assert.equal(ingestRes.status, 200);
      assert.equal(ingestRes.headers.get("access-control-allow-origin"), "chrome-extension://abcdefghijklmnop");
      const ingestJson = (await ingestRes.json()) as {
        ok: boolean;
        ingested: number;
        items: Array<{ threadId?: string; loadId: string; permalink?: string; extractedFields?: { customerPO?: string } }>;
      };
      assert.equal(ingestJson.ok, true);
      const matching = ingestJson.items.filter((i) => i.threadId === "1933f0a9c8b41e22");
      assert.equal(matching.length, 1, "duplicate threadId must be deduplicated");
      assert.equal(matching[0].loadId, "132742212");
      assert.equal(matching[0].extractedFields?.customerPO, "LR-99500");
      assert.equal(matching[0].permalink, "https://mail.google.com/mail/u/0/#all/1933f0a9c8b41e22");

      // Server-side OAuth /api/inbox/sync ingests live Gmail API messages
      const syncRes = await fetch(`${baseUrl}/api/inbox/sync`, { method: "POST" });
      assert.equal(syncRes.status, 200);
      const syncJson = (await syncRes.json()) as {
        ok: boolean;
        syncedGmailMessages: number;
        items: Array<{ threadId?: string; extractedFields?: { customerPO?: string; sellRate?: number } }>;
      };
      assert.equal(syncJson.ok, true);
      assert.equal(syncJson.syncedGmailMessages, 1);
      const syncedTender = syncJson.items.find((i) => i.threadId === "1933f0a9c8b41e99");
      assert.ok(syncedTender);
      assert.equal(syncedTender.extractedFields?.customerPO, "77123");
      assert.equal(syncedTender.extractedFields?.sellRate, 2950);
    },
  );
});

test("grounded POST /api/ai/ask answers carrier, customer uncovered, and lane runner queries from real data with zero canned fakes", async () => {
  store.carriers.unshift({
    name: "JUST DRIVE TRANSPORT LLC",
    mc: "1455821",
    dot: "3911044",
    scac: "JDVT",
    taiMasterId: "64119",
    insuranceStatus: "Exp 2027-04-15",
  });

  try {
    await withServer({ aiOptions: { disableLlm: true } }, async (baseUrl) => {
      // 1. Carrier lookup ("just drive transport")
      const carrRes = await fetch(`${baseUrl}/api/ai/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "just drive transport" }),
      });
      assert.equal(carrRes.status, 200);
      const carrJson = (await carrRes.json()) as { ok: boolean; answer: string };
      assert.equal(carrJson.ok, true);
      assert.match(carrJson.answer, /JUST DRIVE TRANSPORT LLC/);
      assert.match(carrJson.answer, /#64119/);
      assert.match(carrJson.answer, /1455821/);
      assert.ok(!carrJson.answer.includes("Live Ops Summary: 380"));

      // Unknown carrier explicitly reports not found instead of inventing data
      const unknownRes = await fetch(`${baseUrl}/api/ai/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "nonexistent phantom freightways" }),
      });
      const unknownJson = (await unknownRes.json()) as { answer: string };
      assert.match(unknownJson.answer, /No matching carrier found/i);

      // 2. Customer uncovered lookup ("do we have any uncovered shipments for customer IMC Logistics")
      const custRes = await fetch(`${baseUrl}/api/ai/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "do we have any uncovered shipments for customer IMC Logistics" }),
      });
      assert.equal(custRes.status, 200);
      const custJson = (await custRes.json()) as { answer: string };
      assert.match(custJson.answer, /IMC LOGISTICS/i);
      assert.match(custJson.answer, /132702126/);

      // 3. Historical lane runners ("Top historical lane runners for LA → AZ flatbed?")
      const laneRes = await fetch(`${baseUrl}/api/ai/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "Top historical lane runners for LA → AZ flatbed?" }),
      });
      assert.equal(laneRes.status, 200);
      const laneJson = (await laneRes.json()) as { answer: string };
      assert.match(laneJson.answer, /FOX CARRIERS/);
      assert.ok(!laneJson.answer.includes("12 pickups, avg $2,350 buy"), "must never emit old hardcoded PA->GA string");

      // And PA -> GA with 0 covered PA->GA shipments in offline store truthfully reports 0 instead of fake EVANS string
      const emptyLaneRes = await fetch(`${baseUrl}/api/ai/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "Top historical lane runners for PA → GA flatbed?" }),
      });
      const emptyLaneJson = (await emptyLaneRes.json()) as { answer: string };
      assert.match(emptyLaneJson.answer, /0 historical covered shipments/i);
      assert.ok(!emptyLaneJson.answer.includes("EVANS DELIVERY COMPANY INC (MC 117950 · 12 pickups"));
    });
  } finally {
    store.carriers = store.carriers.filter((c) => c.name !== "JUST DRIVE TRANSPORT LLC");
  }
});
