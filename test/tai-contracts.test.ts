import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTaiShipmentRequest,
  loadEntryTotals,
  validateTaiLoadEntry,
  type LoadEntry,
} from "../shared/load-entry";
import { handleTaiInvoiceWebhook, handleTaiShipmentWebhook } from "../server/tai-service";

function makeSampleEntry(): LoadEntry {
  return {
    shipmentType: "Truckload",
    status: "Committed",
    customer: { name: "Larkin Refractory", taiOrganizationId: "" }, // Unlinked customer!
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
