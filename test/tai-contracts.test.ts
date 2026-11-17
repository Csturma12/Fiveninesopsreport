import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTaiShipmentRequest,
  loadEntryTotals,
  validateTaiLoadEntry,
  type LoadEntry,
} from "../shared/load-entry";
import { isAllowedOwnerEmail, isStaffGoogleIdentity } from "../shared/staff-domains";
import express from "express";
import type { AddressInfo } from "node:net";
import {
  handleTaiInvoiceWebhook,
  handleTaiShipmentWebhook,
  isWebhookSimulationEnabled,
  safeSecretEqual,
  verifyTaiWebhookAuth,
} from "../server/tai-service";
import { registerApiRoutes } from "../server/routes";
import { registerAuth } from "../server/auth";
import { isPendingReadBack } from "../server/tai-writeback-poller";
import { store } from "../server/store";
import {
  buildGmailContainerSearchUrl,
  extractContainerNumbers,
  formatContainerCompact,
  sameContainerNumber,
  synthesizeContainerExceptionNote,
} from "../shared/container-extractor";
import { extractLoadEntryFromEmail } from "../shared/email-extractor";
import {
  TAI_ACCESSORIAL_CATALOG,
  TAI_ACCESSORIAL_COUNT,
  searchTaiAccessorials,
} from "../shared/accessorial-options";
import { validateStateZipMatch } from "../shared/us-zip-ranges";
import { searchFacilityAndMapsCandidates } from "../server/facility-search";

function makeSampleEntry(): LoadEntry {
  return {
    shipmentType: "Truckload",
    status: "Committed",
    customer: { name: "Larkin Refractory", taiOrganizationId: "" },
    references: {
      customerPO: "42705",
      bolNumber: "42705",
      invoiceRef: "42705",
      carrierProNumber: "",
      pickupNumber: "",
    },
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
        readyDate: "2026-11-16",
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
        readyDate: "2026-11-17",
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
    accessorials: [{ scope: "pickup", code: "TARP", name: "Tarp Fee", sell: 150, buy: 100 }],
    equipment: {
      trailerSize: "Full",
      trailerType: "48 ft Flatbed | Tarp",
      equipmentLength: "48",
      mileage: 648,
      stackable: false,
    },
    pricing: { linehaulSell: 2850, fuelSell: 0, linehaulBuy: 2300, fuelBuy: 0 },
    carrier: { name: "", serviceLevel: "Normal" },
    specialInstructions: "8ft Tarps Required",
    sendToTai: true,
  };
}

test("unlinked TAI customer validates cleanly and omits customerId on CommitDomesticShipmentRequest", () => {
  const entry = makeSampleEntry();
  const issues = validateTaiLoadEntry(entry);
  assert.equal(issues.length, 0);

  const req = buildTaiShipmentRequest(entry);
  assert.equal("customerId" in req, false);
  assert.equal(req.trailerType, "48 ft Flatbed | Tarp");
  const totals = loadEntryTotals(entry);
  assert.equal(totals.totalSell, 3000);
  assert.equal(totals.totalBuy, 2400);
  assert.equal(totals.totalMargin, 600);
});

test("linked TAI customer emits numeric customerId", () => {
  const entry = makeSampleEntry();
  entry.customer.taiOrganizationId = "698049";
  const req = buildTaiShipmentRequest(entry);
  assert.equal(req.customerId, 698049);
});

test("missing Origin/Dest ZIP or missing Commodity Line 2 description/weight/pieces is caught pre-flight", () => {
  const entry = makeSampleEntry();
  entry.stops[0].zipCode = "";
  entry.stops[1].zipCode = "";
  entry.items.push({
    description: "",
    packagingType: "Pallet",
    handlingQuantity: 4,
    piecesTotal: 0,
    weightTotal: 0,
    hazardousMaterial: false,
    freightClass: "No Class",
    referenceNumber: "",
  });

  const issues = validateTaiLoadEntry(entry);
  const messages = issues.map((i) => i.message).join(" | ");
  assert.match(messages, /origin zip code is required/i);
  assert.match(messages, /destination zip code is required/i);
  assert.match(messages, /Commodity Line 2: Commodity must include a description/i);
  assert.match(messages, /Commodity Line 2: piece count must be at least 1/i);
});

test("inbound TAI ShipmentDetailUpdateUrl & InvoiceCreateWithShipmentUrl webhooks update shipment state", () => {
  const wh = handleTaiShipmentWebhook({
    shipmentId: "132738007",
    status: "In Transit",
    locationString: "Memphis, TN 38141",
    totalBuy: 6500,
  });
  assert.equal(wh.ok, true);
  assert.equal(wh.shipment?.stage, "In transit");

  const inv = handleTaiInvoiceWebhook({
    shipmentId: "132738007",
    invoiceNumber: "INV-99401",
    invoiceType: "AR",
    totalAmount: 6950,
  });
  assert.equal(inv.ok, true);
  assert.match(String(inv.shipment?.invoiceStatus), /INV-99401/);
});

test("staff gate allows Chris owner emails by default and blocks others unless in ALLOWED_STAFF_EMAILS", () => {
  assert.equal(isStaffGoogleIdentity("chriss@primarycompanies.com", "primarycompanies.com", ""), true);
  assert.equal(isStaffGoogleIdentity("chris@shipfivenines.com", "shipfivenines.com", ""), true);
  assert.equal(isStaffGoogleIdentity("other@primarycompanies.com", "primarycompanies.com", ""), false);
  assert.equal(isAllowedOwnerEmail("other@primarycompanies.com", "other@primarycompanies.com"), true);
  assert.equal(isStaffGoogleIdentity("other@primarycompanies.com", "primarycompanies.com", "*"), true);
  assert.equal(isStaffGoogleIdentity("stranger@gmail.com", "gmail.com", "*"), false);
  assert.equal(isStaffGoogleIdentity("chriss@primarycompanies.com", "evil.com", "*"), false);
});

test("pending read-back marker is detected so parked rows are re-read without re-sending PUT", () => {
  const marker = isPendingReadBack({
    awaitingReadBack: true,
    writeSentAt: "2026-11-15T18:00:00.000Z",
    readBackRounds: 2,
    writeResponse: { ok: true },
  });
  assert.ok(marker);
  assert.equal(marker.readBackRounds, 2);
  assert.equal(isPendingReadBack({ ok: true }), null);
});

const WEBHOOK_ENV_KEYS = [
  "NODE_ENV",
  "TAI_WEBHOOK_SECRET",
  "TAI_WEBHOOK_ALLOW_QUERY_SECRET",
  "TAI_WEBHOOK_SIMULATE_ENABLED",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "AUTH_DISABLED",
] as const;

function withWebhookEnv<T>(overrides: Partial<Record<(typeof WEBHOOK_ENV_KEYS)[number], string | undefined>>, fn: () => T): T {
  const saved = Object.fromEntries(WEBHOOK_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const key of WEBHOOK_ENV_KEYS) {
    const next = key in overrides ? overrides[key] : undefined;
    if (next === undefined) delete process.env[key];
    else process.env[key] = next;
  }
  const restore = () => {
    for (const key of WEBHOOK_ENV_KEYS) {
      const prev = saved[key];
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  };
  try {
    const out = fn();
    if (out instanceof Promise) return out.finally(restore) as T;
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

const TEST_SECRET = "test-only-webhook-secret-0123456789abcdef";

test("safeSecretEqual is a constant-time compare with a length guard and rejects empty input", () => {
  assert.equal(safeSecretEqual(TEST_SECRET, TEST_SECRET), true);
  assert.equal(safeSecretEqual(TEST_SECRET.slice(0, -1), TEST_SECRET), false);
  assert.equal(safeSecretEqual(`${TEST_SECRET}x`, TEST_SECRET), false);
  assert.equal(safeSecretEqual("", ""), false);
  assert.equal(safeSecretEqual("", TEST_SECRET), false);
});

test("TAI webhook auth: unset secret is rejected 503 in production but open in local dev", () => {
  withWebhookEnv({ NODE_ENV: "production" }, () => {
    const out = verifyTaiWebhookAuth({});
    assert.equal(out.ok, false);
    assert.equal(!out.ok && out.status, 503);
    const withHeader = verifyTaiWebhookAuth({ authorization: `Bearer ${TEST_SECRET}` });
    assert.equal(withHeader.ok, false);
    assert.equal(!withHeader.ok && withHeader.status, 503);
  });
  withWebhookEnv({ NODE_ENV: "production", TAI_WEBHOOK_SECRET: "   " }, () => {
    const out = verifyTaiWebhookAuth({});
    assert.equal(!out.ok && out.status, 503);
  });
  withWebhookEnv({ NODE_ENV: "development" }, () => {
    const out = verifyTaiWebhookAuth({});
    assert.equal(out.ok, true);
    assert.equal(out.ok && out.mode, "open_dev");
  });
});

test("TAI webhook auth: configured secret requires a header match (constant-time), query string only behind flag", () => {
  withWebhookEnv({ NODE_ENV: "production", TAI_WEBHOOK_SECRET: TEST_SECRET }, () => {
    const missing = verifyTaiWebhookAuth({});
    assert.equal(!missing.ok && missing.status, 401);

    const wrong = verifyTaiWebhookAuth({ authorization: "Bearer nope" });
    assert.equal(!wrong.ok && wrong.status, 401);

    const wrongLengthMatch = verifyTaiWebhookAuth({ "x-tai-webhook-secret": TEST_SECRET.slice(0, -1) + "X" });
    assert.equal(!wrongLengthMatch.ok && wrongLengthMatch.status, 401);

    assert.equal(verifyTaiWebhookAuth({ authorization: `Bearer ${TEST_SECRET}` }).ok, true);
    assert.equal(verifyTaiWebhookAuth({ authorization: TEST_SECRET }).ok, true);
    assert.equal(verifyTaiWebhookAuth({ "x-tai-webhook-secret": TEST_SECRET }).ok, true);
    assert.equal(verifyTaiWebhookAuth({ "x-api-key": TEST_SECRET }).ok, true);
    assert.equal(verifyTaiWebhookAuth({ "x-tai-webhook-secret": [TEST_SECRET, "other"] }).ok, true);

    // Legacy query-string form is ignored unless explicitly enabled.
    const viaQuery = verifyTaiWebhookAuth({}, TEST_SECRET);
    assert.equal(!viaQuery.ok && viaQuery.status, 401);
  });
  withWebhookEnv({ NODE_ENV: "production", TAI_WEBHOOK_SECRET: TEST_SECRET, TAI_WEBHOOK_ALLOW_QUERY_SECRET: "true" }, () => {
    assert.equal(verifyTaiWebhookAuth({}, TEST_SECRET).ok, true);
    const wrongQuery = verifyTaiWebhookAuth({}, "nope");
    assert.equal(!wrongQuery.ok && wrongQuery.status, 401);
  });
});

test("webhook simulation is allowed outside production and only behind TAI_WEBHOOK_SIMULATE_ENABLED in production", () => {
  withWebhookEnv({ NODE_ENV: "development" }, () => assert.equal(isWebhookSimulationEnabled(), true));
  withWebhookEnv({ NODE_ENV: "production" }, () => assert.equal(isWebhookSimulationEnabled(), false));
  withWebhookEnv({ NODE_ENV: "production", TAI_WEBHOOK_SIMULATE_ENABLED: "true" }, () =>
    assert.equal(isWebhookSimulationEnabled(), true),
  );
});

test("HTTP: /api/webhooks/tai/* enforce the secret and /simulate is blocked in production", async () => {
  const app = express();
  app.use(express.json());
  registerApiRoutes(app);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, headers: Record<string, string>, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const shipmentBody = { shipmentId: "132738007", status: "Delivered", locationString: "Lithonia, GA 30058" };
  const invoiceBody = { shipmentId: "132738007", invoiceNumber: "INV-77001", invoiceType: "AR", totalAmount: 7000 };

  try {
    await withWebhookEnv({ NODE_ENV: "production" }, async () => {
      for (const path of ["/api/webhooks/tai", "/api/webhooks/tai/shipment", "/api/webhooks/tai/invoice"]) {
        const res = await post(path, { authorization: `Bearer ${TEST_SECRET}` }, path.endsWith("invoice") ? invoiceBody : shipmentBody);
        assert.equal(res.status, 503, `${path} must fail closed when TAI_WEBHOOK_SECRET is unset in production`);
      }
      const sim = await post("/api/webhooks/tai/simulate", {}, { kind: "gps" });
      assert.equal(sim.status, 403);
    });

    await withWebhookEnv({ NODE_ENV: "production", TAI_WEBHOOK_SECRET: TEST_SECRET }, async () => {
      assert.equal((await post("/api/webhooks/tai/shipment", {}, shipmentBody)).status, 401);
      assert.equal((await post("/api/webhooks/tai/shipment", { authorization: "Bearer wrong" }, shipmentBody)).status, 401);
      assert.equal((await post("/api/webhooks/tai/invoice", { "x-tai-webhook-secret": "wrong" }, invoiceBody)).status, 401);
      assert.equal((await post(`/api/webhooks/tai/shipment?secret=${TEST_SECRET}`, {}, shipmentBody)).status, 401);

      const okShipment = await post("/api/webhooks/tai/shipment", { authorization: `Bearer ${TEST_SECRET}` }, shipmentBody);
      assert.equal(okShipment.status, 200);
      const shipmentJson = (await okShipment.json()) as { ok: boolean; shipment?: { stage?: string } };
      assert.equal(shipmentJson.ok, true);
      assert.equal(shipmentJson.shipment?.stage, "Delivered");

      const okAlias = await post("/api/webhooks/tai", { "x-tai-webhook-secret": TEST_SECRET }, shipmentBody);
      assert.equal(okAlias.status, 200);

      const okInvoice = await post("/api/webhooks/tai/invoice", { "x-api-key": TEST_SECRET }, invoiceBody);
      assert.equal(okInvoice.status, 200);
      const invoiceJson = (await okInvoice.json()) as { ok: boolean; shipment?: { invoiceStatus?: string } };
      assert.match(String(invoiceJson.shipment?.invoiceStatus), /INV-77001/);

      const sim = await post("/api/webhooks/tai/simulate", {}, { kind: "gps" });
      assert.equal(sim.status, 403);
    });

    await withWebhookEnv({ NODE_ENV: "production", TAI_WEBHOOK_SECRET: TEST_SECRET, TAI_WEBHOOK_SIMULATE_ENABLED: "true" }, async () => {
      const sim = await post("/api/webhooks/tai/simulate", {}, { kind: "gps" });
      assert.equal(sim.status, 200);
    });

    await withWebhookEnv({ NODE_ENV: "test" }, async () => {
      const sim = await post("/api/webhooks/tai/simulate", {}, { kind: "invoice" });
      assert.equal(sim.status, 200);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("HTTP + staff auth: unsigned /simulate is 401 under OAuth enforcement even with TAI_WEBHOOK_SIMULATE_ENABLED=true", async () => {
  // Mirrors server/index.ts: registerAuth runs before registerApiRoutes, so /simulate must hit the
  // staff gate. If /simulate were ever added to PUBLIC_PATHS, the unsigned request below would get 200.
  const app = express();
  app.use(express.json());
  registerAuth(app);
  registerApiRoutes(app);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, headers: Record<string, string>, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  try {
    await withWebhookEnv(
      {
        NODE_ENV: "production",
        TAI_WEBHOOK_SECRET: TEST_SECRET,
        TAI_WEBHOOK_SIMULATE_ENABLED: "true",
        GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
        GOOGLE_CLIENT_SECRET: "test-client-secret",
      },
      async () => {
        for (const kind of ["gps", "invoice"]) {
          const sim = await post("/api/webhooks/tai/simulate", {}, { kind });
          assert.equal(sim.status, 401, `unsigned /simulate (${kind}) must require staff sign-in`);
          const json = (await sim.json()) as { authenticated?: boolean };
          assert.equal(json.authenticated, false);
        }

        // The TAI webhook secret is not a staff credential: it must not unlock /simulate.
        const simWithWebhookSecret = await post(
          "/api/webhooks/tai/simulate",
          { "x-tai-webhook-secret": TEST_SECRET },
          { kind: "gps" },
        );
        assert.equal(simWithWebhookSecret.status, 401);

        // The real webhook routes stay reachable without a staff session (secret-gated instead).
        const shipmentBody = { shipmentId: "132738007", status: "Delivered", locationString: "Lithonia, GA 30058" };
        assert.equal((await post("/api/webhooks/tai/shipment", {}, shipmentBody)).status, 401);
        const signed = await post("/api/webhooks/tai/shipment", { "x-tai-webhook-secret": TEST_SECRET }, shipmentBody);
        assert.equal(signed.status, 200);
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("container extractor correlates CAAU724710-0 / CAAU7247100 and synthesizes TONU forklift breakdown notes", () => {
  const extracted = extractContainerNumbers("Subject: IMC CAAU724710-0 — Shipment ID: 132702126");
  assert.deepEqual(extracted, ["CAAU724710-0"]);
  assert.equal(formatContainerCompact(extracted[0]), "CAAU7247100");
  assert.equal(sameContainerNumber("CAAU724710-0", "caau7247100"), true);

  const searchUrl = buildGmailContainerSearchUrl("CAAU724710-0", "132702126");
  assert.match(searchUrl, /CAAU724710-0/);
  assert.match(searchUrl, /CAAU7247100/);
  assert.match(searchUrl, /132702126/);

  const synth = synthesizeContainerExceptionNote([
    "Here is the Carrier Confirmation TONU for shipment 132702126",
    "This one didn't pickup because forklift went down, paid a TONU and waiting for the forklift to be repaired",
  ]);
  assert.equal(synth.hasTonu, true);
  assert.equal(synth.hasEquipmentIssue, true);
  assert.match(String(synth.note), /TONU PAID/i);
  assert.match(String(synth.note), /forklift/i);
});

test("SalesOps CRM CRUD and inbox/shipment delete operations persist cleanly on store", () => {
  const created = store.addCrmLead({
    company: "Test Foundry LLC",
    contact: "Alex Ops",
    email: "alex@testfoundry.com",
    location: "Birmingham, AL",
    source: "Manual",
    evidence: "Flatbed lanes",
  });
  assert.equal(created.duplicate, false);
  assert.ok(store.crmLeads.some((l) => l.id === created.lead.id));

  const updated = store.updateCrmLead(created.lead.id, { status: "Converted" });
  assert.equal(updated?.status, "Converted");
  assert.ok(store.customers.some((c) => c.name === "TEST FOUNDRY LLC"));

  assert.equal(store.deleteCrmLead(created.lead.id), true);
  assert.equal(store.crmLeads.some((l) => l.id === created.lead.id), false);

  const firstEmailId = store.crucialEmails[0]?.id;
  if (firstEmailId) {
    assert.equal(store.dismissEmail(firstEmailId), true);
    assert.equal(store.dismissedEmailIds.has(firstEmailId), true);
  }
});

test("email extractor parses Larkin Zelienople PA 16063 -> Lithonia GA 30058 4ft tarp tender with TAI-valid ZIPs", () => {
  const result = extractLoadEntryFromEmail(
    {
      subject: "Pickup tomorrow Zelienople PA to Lithonia GA",
      sender: "shipping@larkinrefractory.com",
      bodyText: [
        "Please book truck to pick up tomorrow at 300 Tomlinson Drive, Zelienople, PA 16063",
        "Deliver to Larkin Refractory Solutions, 2331 Varkel Way, Lithonia, GA 30058.",
        "16 pallets - refractory brick and Insulating Fire Brick, 45,727 lbs. PO P261110BD / P260914BD.",
        "Flatbed or Conestoga OK, if flatbed take 4' tarps.",
      ].join("\n"),
    },
    store.customers,
    store.facilities,
  );

  assert.equal(result.entry.customer.name, "LARKIN REFRACTORY SOLUTIONS");
  assert.equal(result.entry.customer.taiOrganizationId, "698049");
  assert.equal(result.entry.stops[0].city, "Zelienople");
  assert.equal(result.entry.stops[0].state, "PA");
  assert.equal(result.entry.stops[0].zipCode, "16063");
  assert.equal(result.entry.stops[1].city, "Lithonia");
  assert.equal(result.entry.stops[1].state, "GA");
  assert.equal(result.entry.stops[1].zipCode, "30058");
  assert.equal(result.entry.items[0].piecesTotal, 16);
  assert.equal(result.entry.items[0].weightTotal, 45727);
  assert.equal(result.entry.equipment.trailerType, "48 ft Flatbed | Tarp");
  assert.match(result.entry.specialInstructions, /4ft Tarps Required/i);
  assert.ok(result.alternateEquipment.includes("53 ft Conestoga / Curtain Side"));
  assert.equal(validateTaiLoadEntry(result.entry).length, 0);
});

test("TAI_ACCESSORIAL_CATALOG has 563 active charges excluding test IDs 348, 356, 496 and searches #223 and Pier Pass", () => {
  assert.equal(TAI_ACCESSORIAL_CATALOG.length, 563);
  assert.equal(TAI_ACCESSORIAL_COUNT, 563);

  const catalogIds = new Set(TAI_ACCESSORIAL_CATALOG.map((item) => item.backOfficeId));
  assert.equal(catalogIds.has(348), false);
  assert.equal(catalogIds.has(356), false);
  assert.equal(catalogIds.has(496), false);

  const byId = searchTaiAccessorials("223");
  assert.ok(byId.length >= 1);
  assert.equal(byId[0].backOfficeId, 223);
  assert.equal(byId[0].name, "Tarp Fee - Shipment");
  assert.equal(byId[0].scope, "shipment");

  const byPierPass = searchTaiAccessorials("Pier Pass");
  const pierPass = byPierPass.find((item) => item.backOfficeId === 145);
  assert.ok(pierPass);
  assert.equal(pierPass.name, "Pier Pass - Shipment");
  assert.equal(pierPass.scope, "shipment");
});

test("validateStateZipMatch and validateTaiLoadEntry catch East Canton OH vs Greensboro NC 27409 cross-state ZIP mismatch", () => {
  const mismatch = validateStateZipMatch("OH", "27409");
  assert.equal(mismatch.valid, false);
  assert.equal(mismatch.expectedState, "NC");
  assert.match(String(mismatch.message), /ZIP 27409 belongs to NC, not OH/i);

  const validOh = validateStateZipMatch("OH", "44730");
  assert.equal(validOh.valid, true);
  assert.equal(validOh.expectedState, "OH");

  const entry = makeSampleEntry();
  entry.stops[0] = {
    ...entry.stops[0],
    companyName: "RESCO PRODUCTS INC",
    streetAddress: "6878 Osnaburg Street Southeast",
    city: "East Canton",
    state: "OH",
    zipCode: "27409",
  };

  const blocked = validateTaiLoadEntry(entry);
  assert.ok(
    blocked.some(
      (issue) => issue.field === "stops.0.zipCode" && /27409 belongs to NC, not OH/i.test(issue.message),
    ),
  );

  entry.stops[0].zipCode = "44730";
  assert.equal(validateTaiLoadEntry(entry).length, 0);
});

test("searchFacilityAndMapsCandidates returns East Canton OH 44730 first and keeps Greensboro NC 27409 intact", async () => {
  const result = await searchFacilityAndMapsCandidates(
    { companyName: "RESCO PRODUCTS INC", city: "East Canton", state: "OH" },
    store.facilities,
  );
  assert.equal(result.ok, true);
  assert.ok(result.candidates.length >= 2);

  const eastCantonIdx = result.candidates.findIndex(
    (c) => c.city.toLowerCase() === "east canton" && c.state === "OH" && c.zipCode === "44730",
  );
  const greensboroIdx = result.candidates.findIndex(
    (c) => c.city.toLowerCase() === "greensboro" && c.state === "NC" && c.zipCode === "27409",
  );

  assert.equal(eastCantonIdx, 0);
  assert.ok(greensboroIdx > 0);
  assert.equal(result.candidates[eastCantonIdx].streetAddress, "6878 Osnaburg Street Southeast");
  assert.equal(result.candidates[eastCantonIdx].zipCode, "44730");
  assert.equal(result.candidates[greensboroIdx].streetAddress, "4521 NORTHLINE DR");
  assert.equal(result.candidates[greensboroIdx].zipCode, "27409");
});

test("buildTaiShipmentRequest prepends HAZMAT to pickup instructions when hazardousMaterial is true", () => {
  const entry = makeSampleEntry();
  entry.items[0].hazardousMaterial = true;
  entry.stops[0].instructions = "Check in at North Gate";
  entry.accessorials = [
    { scope: "shipment", code: "223", name: "Tarp Fee - Shipment", sell: 150, buy: 100 },
  ];

  const req = buildTaiShipmentRequest(entry);
  const stops = req.stops as Array<{ instructions?: string }>;
  assert.match(String(stops[0]?.instructions), /^HAZMAT \| Check in at North Gate \| 8ft Tarps Required$/);

  const accessorialCodes = req.accessorialCodes as Array<{ code: string; name: string }>;
  assert.deepEqual(accessorialCodes, [{ code: "223", name: "Tarp Fee - Shipment" }]);
});
