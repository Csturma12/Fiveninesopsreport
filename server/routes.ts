import crypto from "node:crypto";
import zlib from "node:zlib";
import type { Express, NextFunction, Request, Response } from "express";
import {
  extractContainerNumbers,
  sameContainerNumber,
  synthesizeContainerExceptionNote,
} from "../shared/container-extractor";
import { extractLoadEntryFromEmail } from "../shared/email-extractor";
import type { LoadEntry } from "../shared/load-entry";
import type { OpsShipment } from "../shared/tai-webhook-schema";
import { stateForZip } from "../shared/us-zip-ranges";
import { addSseClient, broadcastOpsEvent } from "./events";
import { getStaffGmailAccessToken } from "./auth";
import { searchFacilityAndMapsCandidates } from "./facility-search";
import { isPfdGatewayConfigured } from "./pfd-gateway";
import { store, type IngestEmailInput } from "./store";
import { registerPodUploadRoute } from "./tai-pod-routes";
import { getTaiPushLogs } from "./tai-push-log";
import {
  answerGroundedOpsQuestion,
  bookTaiLoads,
  calculateFuelSurcharge,
  decomposeShipmentLinehaulVsAllIn,
  enqueueCarrierWriteback,
  getTaiBookingStatus,
  handleTaiInvoiceWebhook,
  handleTaiShipmentWebhook,
  normalizeEquipmentFamily,
  normalizeIncomingLoadEntry,
  previewTaiBookingAsync,
  pushShipmentCheckCall,
  pushShipmentReferences,
  saveFacilityRecord,
  updateShipmentFull,
  updateShipmentRateconStatus,
  syncTaiInvoices,
  syncTaiInvoicesForShipment,
  verifyWebhookSecretIfConfigured,
  type BookTaiLoadsOptions,
  type DirectTaiHelperOptions,
  type GroundedAiOptions,
} from "./tai-service";

export interface PanelDraftRecord {
  id: string;
  title: string;
  source: "ai_email" | "manual" | "attachment" | string;
  subject?: string;
  sender?: string;
  notes?: string;
  entry: LoadEntry;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PanelKnowledgeRule {
  id: string;
  scope: "customer" | "lane" | "facility";
  customerName: string;
  lane: string;
  ruleText: string;
  equipment?: string;
  instructions?: string;
  status: "approved" | "proposed";
  createdBy: string;
  createdAt: string;
}

export interface PanelApTask {
  id: string;
  shipmentId: string;
  customer: string;
  carrier: string;
  category: "invoice" | "pod" | "rate_discrepancy" | "tonu" | "po" | "general";
  subject: string;
  from: string;
  amount?: number;
  invoiceNumber?: string;
  status: "open" | "in_review" | "resolved";
  notes: string;
  receivedAt: string;
  permalink?: string;
}

const panelDrafts: PanelDraftRecord[] = [];
const panelKnowledgeRules: PanelKnowledgeRule[] = [];
let apTasksInitialized = false;
const panelApTasks: PanelApTask[] = [];

function ensureSeededApTasks(): PanelApTask[] {
  if (apTasksInitialized) return panelApTasks;
  apTasksInitialized = true;
  for (const em of store.crucialEmails) {
    if (em.category === "tenders") continue;
    const ship = store.shipments.find((s) => s.id === em.loadId);
    const isTonu = /\btonu\b/i.test(`${em.subject} ${em.operationalNote || ""}`);
    panelApTasks.push({
      id: `ap-${em.id}`,
      shipmentId: em.loadId,
      customer: ship?.customer || "Primary Freight Customer",
      carrier: em.extractedCarrier || ship?.carrier || "Pending Carrier",
      category: isTonu
        ? "tonu"
        : em.diffType === "missing_pod"
        ? "pod"
        : em.diffType === "missing_po"
        ? "po"
        : "rate_discrepancy",
      subject: em.subject,
      from: em.from,
      ...(em.extractedAmount ? { amount: em.extractedAmount } : {}),
      ...(em.extractedInvoice ? { invoiceNumber: em.extractedInvoice } : {}),
      status: em.applied ? "resolved" : "open",
      notes: em.operationalNote || em.diffLabel,
      receivedAt: em.received,
      permalink: em.permalink,
    });
  }
  return panelApTasks;
}

function escapeHtml(raw: unknown): string {
  return String(raw ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function generateCsrfToken(email: string | undefined, env: NodeJS.ProcessEnv): string {
  const secret = env.SESSION_SECRET?.trim() || "fivenines-panel-csrf-v2";
  const subject = String(email || "anonymous").trim().toLowerCase();
  return crypto.createHmac("sha256", secret).update(`csrf:${subject}`).digest("hex").slice(0, 32);
}

function buildBolDocument(s: OpsShipment) {
  const shipper = s.stops[0];
  const consignee = s.stops[s.stops.length - 1];
  const totalWeight = s.commodities.reduce((sum, c) => sum + (Number(c.weightTotal) || 0), 0);
  const totalPieces = s.commodities.reduce((sum, c) => sum + (Number(c.piecesTotal) || 0), 0);
  const bolNumber = s.bol || s.po || `BOL-${s.id}`;
  const instructions = s.stops
    .map((st) => st.instructions)
    .filter(Boolean)
    .join(" | ");

  const fields = {
    shipmentId: s.id,
    bolNumber,
    customerPO: s.po || "",
    proNumber: s.pro || "",
    customer: s.customer,
    carrier: s.carrier || "TBD",
    mcNumber: s.mc || "",
    equipment: s.equip,
    shipDate: shipper?.readyDate || s.shipDate,
    deliveryDate: consignee?.readyDate || s.delivDate,
    shipper: shipper
      ? {
          companyName: shipper.companyName,
          streetAddress: shipper.streetAddress,
          city: shipper.city,
          state: shipper.state,
          zipCode: shipper.zipCode,
          contactName: shipper.contactName,
          phone: shipper.phone,
        }
      : null,
    consignee: consignee
      ? {
          companyName: consignee.companyName,
          streetAddress: consignee.streetAddress,
          city: consignee.city,
          state: consignee.state,
          zipCode: consignee.zipCode,
          contactName: consignee.contactName,
          phone: consignee.phone,
        }
      : null,
    stops: s.stops,
    commodities: s.commodities,
    accessorials: s.accessorials,
    totalWeight,
    totalPieces,
    specialInstructions: instructions,
  };

  const summaryText = [
    `STRAIGHT BILL OF LADING — Load #${s.id} (BOL #${bolNumber})`,
    `Customer: ${s.customer}${s.po ? ` · PO #${s.po}` : ""}`,
    `Carrier: ${s.carrier || "TBD"}${s.mc ? ` (MC ${s.mc})` : ""} · Equipment: ${s.equip}`,
    shipper
      ? `Shipper: ${shipper.companyName}, ${shipper.streetAddress ? `${shipper.streetAddress}, ` : ""}${shipper.city}, ${shipper.state} ${shipper.zipCode} (${shipper.readyDate} ${shipper.timeOpen}–${shipper.timeClose})`
      : `Origin: ${s.origin}`,
    consignee
      ? `Consignee: ${consignee.companyName}, ${consignee.streetAddress ? `${consignee.streetAddress}, ` : ""}${consignee.city}, ${consignee.state} ${consignee.zipCode} (${consignee.readyDate} ${consignee.timeOpen}–${consignee.timeClose})`
      : `Destination: ${s.dest}`,
    `Freight: ${totalPieces} pcs · ${totalWeight.toLocaleString()} lbs — ${s.commodities.map((c) => c.description).join("; ")}`,
    ...(instructions ? [`Instructions: ${instructions}`] : []),
  ].join("\n");

  const commodityRows = s.commodities
    .map(
      (c) => `<tr>
        <td>${escapeHtml(c.piecesTotal)} ${escapeHtml(c.packagingType)}</td>
        <td>${escapeHtml(c.description)}${c.hazardousMaterial ? " <strong>(HAZMAT)</strong>" : ""}</td>
        <td>${escapeHtml(Number(c.weightTotal || 0).toLocaleString())} lbs</td>
        <td>${escapeHtml(c.freightClass || "No Class")}</td>
        <td>${escapeHtml(c.referenceNumber || "—")}</td>
      </tr>`,
    )
    .join("");

  const printableHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>BOL #${escapeHtml(bolNumber)} — Load #${escapeHtml(s.id)}</title>
  <style>
    body { font-family: Arial, sans-serif; color: #111; margin: 24px; font-size: 12px; }
    h1 { margin: 0 0 4px; font-size: 18px; }
    .meta { margin-bottom: 14px; color: #444; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px; }
    .box { border: 1px solid #333; padding: 10px; border-radius: 4px; }
    .box h3 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #555; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
    th, td { border: 1px solid #333; padding: 6px 8px; text-align: left; }
    th { background: #f3f4f6; font-size: 11px; text-transform: uppercase; }
    .sigs { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-top: 24px; }
    .sig { border-top: 1px solid #111; padding-top: 6px; font-size: 11px; }
  </style>
</head>
<body>
  <h1>STRAIGHT BILL OF LADING — SHORT FORM</h1>
  <div class="meta">
    <strong>TAI Shipment #:</strong> ${escapeHtml(s.id)} &nbsp;|&nbsp;
    <strong>BOL #:</strong> ${escapeHtml(bolNumber)} &nbsp;|&nbsp;
    <strong>Customer PO:</strong> ${escapeHtml(s.po || "—")} &nbsp;|&nbsp;
    <strong>Equipment:</strong> ${escapeHtml(s.equip)}
  </div>
  <div class="grid">
    <div class="box">
      <h3>Shipper (Origin)</h3>
      <div><strong>${escapeHtml(shipper?.companyName || s.customer)}</strong></div>
      <div>${escapeHtml(shipper?.streetAddress || "")}</div>
      <div>${escapeHtml(shipper ? `${shipper.city}, ${shipper.state} ${shipper.zipCode}` : s.origin)}</div>
      <div>Ready: ${escapeHtml(shipper?.readyDate || s.shipDate)} ${escapeHtml(shipper ? `${shipper.timeOpen}–${shipper.timeClose}` : "")}</div>
    </div>
    <div class="box">
      <h3>Consignee (Destination)</h3>
      <div><strong>${escapeHtml(consignee?.companyName || "Consignee")}</strong></div>
      <div>${escapeHtml(consignee?.streetAddress || "")}</div>
      <div>${escapeHtml(consignee ? `${consignee.city}, ${consignee.state} ${consignee.zipCode}` : s.dest)}</div>
      <div>Delivery: ${escapeHtml(consignee?.readyDate || s.delivDate)} ${escapeHtml(consignee ? `${consignee.timeOpen}–${consignee.timeClose}` : "")}</div>
    </div>
  </div>
  <div class="box" style="margin-bottom:14px;">
    <h3>Carrier &amp; Special Instructions</h3>
    <div><strong>Carrier:</strong> ${escapeHtml(s.carrier || "TBD")} ${s.mc ? `(MC ${escapeHtml(s.mc)})` : ""} &nbsp;|&nbsp; <strong>PRO #:</strong> ${escapeHtml(s.pro || "—")}</div>
    <div><strong>Instructions:</strong> ${escapeHtml(instructions || s.accessorials.join(", ") || "Standard Care")}</div>
  </div>
  <table>
    <thead>
      <tr><th>Handling / Units</th><th>Commodity Description</th><th>Weight</th><th>Class</th><th>Marks / Ref</th></tr>
    </thead>
    <tbody>${commodityRows}</tbody>
  </table>
  <div class="sigs">
    <div class="sig">Shipper Signature / Date</div>
    <div class="sig">Driver / Carrier Signature / Date</div>
    <div class="sig">Consignee Receipt Signature / Date</div>
  </div>
</body>
</html>`;

  return { ok: true as const, shipmentId: s.id, fields, summaryText, printableHtml };
}

function buildRateconDocument(s: OpsShipment) {
  const totalWeight = s.commodities.reduce((sum, c) => sum + (Number(c.weightTotal) || 0), 0);
  const totalPieces = s.commodities.reduce((sum, c) => sum + (Number(c.piecesTotal) || 0), 0);

  const fields = {
    shipmentId: s.id,
    customer: s.customer,
    carrier: s.carrier || "TBD Carrier",
    mcNumber: s.mc || "",
    po: s.po || "",
    bol: s.bol || "",
    pro: s.pro || "",
    equipment: s.equip,
    mileage: s.mileage,
    buyRate: s.buy,
    accessorials: s.accessorials,
    stops: s.stops,
    commodities: s.commodities,
    totalWeight,
    totalPieces,
    rateconStatus: s.rateconStatus,
  };

  const stopLines = s.stops.map(
    (st, i) =>
      `  Stop ${i + 1} (${st.stopType}): ${st.companyName}, ${st.streetAddress ? `${st.streetAddress}, ` : ""}${st.city}, ${st.state} ${st.zipCode} · ${st.readyDate} (${st.timeOpen}–${st.timeClose})${st.instructions ? ` [${st.instructions}]` : ""}`,
  );

  const summaryText = [
    `CARRIER RATE CONFIRMATION — Load #${s.id}`,
    `Broker: Primary Freight / Five Nines Operations`,
    `Carrier: ${s.carrier || "TBD Carrier"}${s.mc ? ` (MC #${s.mc})` : ""}`,
    `Agreed All-In Carrier Rate: $${Number(s.buy || 0).toLocaleString()} USD`,
    `Equipment: ${s.equip}${s.mileage > 0 ? ` · Est. ${s.mileage.toLocaleString()} mi` : ""}`,
    `References: PO ${s.po || "—"} · BOL ${s.bol || "—"}`,
    `Stops:`,
    ...stopLines,
    `Commodity: ${totalPieces} pcs · ${totalWeight.toLocaleString()} lbs — ${s.commodities.map((c) => c.description).join("; ")}`,
    ...(s.accessorials.length > 0 ? [`Accessorials / Requirements: ${s.accessorials.join(", ")}`] : []),
    `Please reply to confirm acceptance and send signed POD upon delivery referencing Load #${s.id}.`,
  ].join("\n");

  const stopRows = s.stops
    .map(
      (st, idx) => `<tr>
        <td>#${idx + 1} ${escapeHtml(st.stopType)}</td>
        <td><strong>${escapeHtml(st.companyName)}</strong><br/>${escapeHtml(st.streetAddress)}<br/>${escapeHtml(`${st.city}, ${st.state} ${st.zipCode}`)}</td>
        <td>${escapeHtml(st.readyDate)}<br/>${escapeHtml(`${st.timeOpen}–${st.timeClose}`)}${st.appointmentRequired ? " (APPT)" : ""}</td>
        <td>${escapeHtml(st.instructions || "—")}</td>
      </tr>`,
    )
    .join("");

  const printableHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Rate Confirmation — Load #${escapeHtml(s.id)}</title>
  <style>
    body { font-family: Arial, sans-serif; color: #111; margin: 24px; font-size: 12px; }
    .hdr { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1D2C5E; padding-bottom: 10px; margin-bottom: 14px; }
    h1 { margin: 0; font-size: 18px; color: #1D2C5E; }
    .rate-pill { font-size: 16px; font-weight: bold; background: #eef6f0; border: 1px solid #2b7a4b; padding: 8px 12px; border-radius: 6px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
    th, td { border: 1px solid #333; padding: 6px 8px; text-align: left; vertical-align: top; }
    th { background: #f3f4f6; font-size: 11px; text-transform: uppercase; }
    .sig { margin-top: 24px; border-top: 1px solid #111; padding-top: 8px; display: flex; justify-content: space-between; }
  </style>
</head>
<body>
  <div class="hdr">
    <div>
      <h1>CARRIER RATE CONFIRMATION</h1>
      <div><strong>Primary Freight / Five Nines Operations</strong></div>
      <div>Load #: <strong>${escapeHtml(s.id)}</strong> &nbsp;|&nbsp; PO: ${escapeHtml(s.po || "—")} &nbsp;|&nbsp; BOL: ${escapeHtml(s.bol || "—")}</div>
    </div>
    <div class="rate-pill">Total Carrier Pay: $${escapeHtml(Number(s.buy || 0).toLocaleString())}</div>
  </div>
  <p><strong>Carrier:</strong> ${escapeHtml(s.carrier || "TBD Carrier")} ${s.mc ? `(MC #${escapeHtml(s.mc)})` : ""} &nbsp;|&nbsp; <strong>Equipment:</strong> ${escapeHtml(s.equip)} ${s.mileage > 0 ? `&nbsp;|&nbsp; <strong>Miles:</strong> ${escapeHtml(s.mileage)}` : ""}</p>
  <table>
    <thead><tr><th>Stop</th><th>Facility &amp; Address</th><th>Date / Window</th><th>Instructions</th></tr></thead>
    <tbody>${stopRows}</tbody>
  </table>
  <p><strong>Freight:</strong> ${escapeHtml(totalPieces)} pcs · ${escapeHtml(totalWeight.toLocaleString())} lbs — ${escapeHtml(s.commodities.map((c) => c.description).join("; "))}</p>
  <p><strong>Required Accessorials:</strong> ${escapeHtml(s.accessorials.join(", ") || "Standard")}</p>
  <div class="sig">
    <span>Carrier Authorized Signature: ___________________________</span>
    <span>Driver Name &amp; Cell: ___________________________</span>
  </div>
</body>
</html>`;

  return { ok: true as const, shipmentId: s.id, fields, summaryText, printableHtml };
}

function estimateHistoricalLaneRates(raw: Record<string, unknown>) {
  // Strictly historical TAI shipment estimator — useDatLane is ALWAYS hardcoded false (ZERO DAT calls).
  if (raw.pegPrice !== undefined && raw.pegPrice !== null && raw.pegPrice !== "") {
    const pegCheck = Number(raw.pegPrice);
    if (!Number.isFinite(pegCheck) || pegCheck <= 0) {
      return {
        ok: false as const,
        status: 400 as const,
        useDatLane: false as const,
        message: "pegPrice must be a finite number greater than 0.",
      };
    }
  }

  const origZip = String(raw.originZip || raw.fromZip || "").trim().slice(0, 5);
  const destZip = String(raw.destZip || raw.toZip || "").trim().slice(0, 5);
  const origState = (
    String(raw.originState || raw.fromState || "").trim().toUpperCase() ||
    (origZip ? stateForZip(origZip) || "" : "")
  ).slice(0, 2);
  const destState = (
    String(raw.destState || raw.toState || "").trim().toUpperCase() ||
    (destZip ? stateForZip(destZip) || "" : "")
  ).slice(0, 2);
  const rawEquip = String(raw.equipment || raw.trailerType || "").trim();
  const equipmentFamily = normalizeEquipmentFamily(rawEquip);
  const requestedMiles = Number(raw.mileage || raw.estMiles) || 0;

  const pricedShipments = store.shipments.filter((s) => s.sell > 0 || s.buy > 0);

  const scored = pricedShipments.map((s) => {
    const sOrigState = (s.stops[0]?.state || s.origin.split(",")[1]?.trim().slice(0, 2) || "").toUpperCase();
    const sDestState = (
      s.stops[s.stops.length - 1]?.state ||
      s.dest.split(",")[1]?.trim().slice(0, 2) ||
      ""
    ).toUpperCase();
    const sOrigZip = (s.stops[0]?.zipCode || "").slice(0, 3);
    const sDestZip = (s.stops[s.stops.length - 1]?.zipCode || "").slice(0, 3);
    const shipFamily = normalizeEquipmentFamily(s.equip);

    let score = 0;
    if (origState && sOrigState === origState) score += 4;
    if (destState && sDestState === destState) score += 4;
    if (origZip.length >= 3 && sOrigZip === origZip.slice(0, 3)) score += 3;
    if (destZip.length >= 3 && sDestZip === destZip.slice(0, 3)) score += 3;
    if (equipmentFamily !== "other" && shipFamily === equipmentFamily) score += 4;
    return {
      shipment: s,
      shipFamily,
      score,
      exactStateMatch: Boolean(origState && destState && sOrigState === origState && sDestState === destState),
      familyMatch: equipmentFamily === "other" || shipFamily === equipmentFamily,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  const exactLaneAndEquip = scored.filter((x) => x.exactStateMatch && x.familyMatch);
  const exactLaneHits = exactLaneAndEquip.length > 0 ? exactLaneAndEquip : scored.filter((x) => x.exactStateMatch);
  const familyMatchedPool = scored.filter((x) => x.score > 0 && x.familyMatch);
  const pool =
    exactLaneHits.length > 0
      ? exactLaneHits.map((x) => x.shipment)
      : familyMatchedPool.length > 0
      ? familyMatchedPool.map((x) => x.shipment)
      : scored.filter((x) => x.score > 0).map((x) => x.shipment);
  const activePool = pool.length > 0 ? pool : pricedShipments;

  const milesSamples = activePool.map((s) => s.mileage).filter((m) => m > 0);
  const estMiles = Math.max(
    1,
    requestedMiles > 0
      ? Math.round(requestedMiles)
      : milesSamples.length > 0
      ? Math.round(milesSamples.reduce((a, b) => a + b, 0) / milesSamples.length)
      : 650,
  );

  // Decompose EVERY shipment into pure base linehaul vs accessorials/fuel so linehaulPerMile is NEVER contaminated!
  const decomposedPool = activePool.map((s) => ({
    shipment: s,
    breakdown: decomposeShipmentLinehaulVsAllIn(s),
  }));

  const linehaulSellSamples = decomposedPool
    .map(({ shipment: s, breakdown }) => {
      const baseLh = breakdown.linehaulSell;
      if (baseLh > 0) {
        if (s.mileage > 100 && estMiles > 100 && exactLaneHits.length === 0) {
          const rpm = Math.min(6.2, Math.max(1.85, baseLh / s.mileage));
          return Math.round(rpm * estMiles);
        }
        return baseLh;
      }
      return breakdown.linehaulBuy > 0 ? Math.round(breakdown.linehaulBuy * 1.18) : 0;
    })
    .filter((v) => v > 0)
    .sort((a, b) => a - b);

  const allInSellSamples = decomposedPool
    .map(({ shipment: s, breakdown }) => {
      if (breakdown.allInSell > 0) {
        if (s.mileage > 100 && estMiles > 100 && exactLaneHits.length === 0) {
          const rpm = Math.min(6.8, Math.max(2.05, breakdown.allInSell / s.mileage));
          return Math.round(rpm * estMiles);
        }
        return breakdown.allInSell;
      }
      return breakdown.allInBuy > 0 ? Math.round(breakdown.allInBuy * 1.18) : 0;
    })
    .filter((v) => v > 0)
    .sort((a, b) => a - b);

  const linehaulBuySamples = decomposedPool
    .map(({ shipment: s, breakdown }) => {
      const baseBuy = breakdown.linehaulBuy;
      if (baseBuy > 0) {
        if (s.mileage > 100 && estMiles > 100 && exactLaneHits.length === 0) {
          const rpm = Math.min(5.5, Math.max(1.55, baseBuy / s.mileage));
          return Math.round(rpm * estMiles);
        }
        return baseBuy;
      }
      return breakdown.linehaulSell > 0 ? Math.round(breakdown.linehaulSell * 0.82) : 0;
    })
    .filter((v) => v > 0)
    .sort((a, b) => a - b);

  const avgLinehaulSell =
    linehaulSellSamples.length > 0
      ? Math.round(linehaulSellSamples.reduce((a, b) => a + b, 0) / linehaulSellSamples.length)
      : Math.max(900, Math.round(estMiles * 3.15));
  const linehaulTargetSell = Math.round(avgLinehaulSell / 25) * 25;

  const avgAllInSell =
    allInSellSamples.length > 0
      ? Math.round(allInSellSamples.reduce((a, b) => a + b, 0) / allInSellSamples.length)
      : linehaulTargetSell;
  const allInTargetSell = Math.max(linehaulTargetSell, Math.round(avgAllInSell / 25) * 25);

  const targetSell = linehaulTargetSell;
  const lowSell =
    linehaulSellSamples.length >= 2
      ? Math.min(linehaulSellSamples[0], Math.round(targetSell * 0.92))
      : Math.round((targetSell * 0.91) / 25) * 25;
  const highSell =
    linehaulSellSamples.length >= 2
      ? Math.max(linehaulSellSamples[linehaulSellSamples.length - 1], Math.round(targetSell * 1.1))
      : Math.round((targetSell * 1.12) / 25) * 25;

  const rawBuy =
    linehaulBuySamples.length > 0
      ? Math.round(linehaulBuySamples.reduce((a, b) => a + b, 0) / linehaulBuySamples.length)
      : Math.round(targetSell * 0.82);
  const targetBuy = Math.min(Math.round(targetSell * 0.92), Math.round(rawBuy / 25) * 25);

  const linehaulPerMile = Number((linehaulTargetSell / estMiles).toFixed(2));
  const allInPerMile = Number((allInTargetSell / estMiles).toFixed(2));

  let fscResult: ReturnType<typeof calculateFuelSurcharge> | undefined;
  if (raw.dieselPrice !== undefined && raw.dieselPrice !== null && raw.dieselPrice !== "") {
    fscResult = calculateFuelSurcharge({
      dieselPrice: Number(raw.dieselPrice),
      schedule: typeof raw.fscSchedule === "string" ? raw.fscSchedule : equipmentFamily === "drayage" ? "drayage" : undefined,
      ...(raw.pegPrice !== undefined ? { pegPrice: Number(raw.pegPrice) } : {}),
      ...(raw.mpg !== undefined ? { mpg: Number(raw.mpg) } : {}),
      linehaulAmount: linehaulTargetSell,
      miles: estMiles,
    });
    if (!fscResult.ok) {
      return {
        ok: false as const,
        status: 400 as const,
        useDatLane: false as const,
        message: fscResult.message,
      };
    }
  }

  const recentMatches = decomposedPool.slice(0, 8).map(({ shipment: s, breakdown }) => ({
    id: s.id,
    customer: s.customer,
    origin: s.origin,
    dest: s.dest,
    equip: s.equip,
    equipmentFamily: normalizeEquipmentFamily(s.equip),
    shipDate: s.shipDate,
    mileage: s.mileage,
    sell: s.sell,
    buy: s.buy,
    linehaulSell: breakdown.linehaulSell,
    accessorialAndFuelSell: breakdown.accessorialAndFuelSell,
    allInSell: breakdown.allInSell,
    carrier: s.carrier || "Unassigned",
  }));

  return {
    ok: true as const,
    status: 200 as const,
    useDatLane: false as const,
    comparisonBasis: "linehaul_only" as const,
    equipmentFamily,
    sampleSize: pool.length,
    lowSell,
    targetSell,
    highSell,
    targetBuy,
    linehaulTargetSell,
    allInTargetSell,
    linehaulPerMile,
    allInPerMile,
    estMiles,
    ...(fscResult && fscResult.ok ? { fsc: fscResult } : {}),
    recentMatches,
  };
}

function extractReadableTextFromAttachment(bytes: Buffer, mimeType: string, fileName: string): string {
  const lowerMime = mimeType.toLowerCase();
  if (lowerMime.startsWith("text/") || /\.(txt|csv|eml|html?)$/i.test(fileName)) {
    return bytes.toString("utf8").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }

  // Pure-Node PDF text stream extractor (supports uncompressed & /FlateDecode PDF streams)
  if (lowerMime === "application/pdf" || bytes.subarray(0, 5).toString("ascii") === "%PDF-") {
    const rawLatin = bytes.toString("latin1");
    const chunks: string[] = [];

    const decodePdfStringLiteral = (s: string) =>
      s
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, " ")
        .replace(/\\t/g, " ")
        .replace(/\\\(/g, "(")
        .replace(/\\\)/g, ")")
        .replace(/\\\\/g, "\\");

    const collectTjStrings = (content: string) => {
      const matches = content.matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*Tj/g);
      for (const m of matches) {
        const cleaned = decodePdfStringLiteral(m[1]).trim();
        if (cleaned) chunks.push(cleaned);
      }
      const tjArrays = content.matchAll(/\[([^\]]+)\]\s*TJ/g);
      for (const arrMatch of tjArrays) {
        const parts: string[] = [];
        for (const sub of arrMatch[1].matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)/g)) {
          parts.push(decodePdfStringLiteral(sub[1]));
        }
        const joined = parts.join("").trim();
        if (joined) chunks.push(joined);
      }
    };

    collectTjStrings(rawLatin);

    // Also inspect compressed streams via Node zlib
    const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let match: RegExpExecArray | null;
    while ((match = streamRegex.exec(rawLatin)) !== null) {
      const streamBytes = Buffer.from(match[1], "latin1");
      if (streamBytes.length === 0 || streamBytes.length > 2 * 1024 * 1024) continue;
      try {
        const inflated = zlib.inflateSync(streamBytes).toString("latin1");
        collectTjStrings(inflated);
      } catch {
        // not a zlib-compressed text stream
      }
    }

    if (chunks.length > 0) {
      return chunks.join(" ").replace(/\s+/g, " ").trim();
    }

    // Fallback printable ASCII runs from PDF metadata/annotations
    const asciiRuns = rawLatin
      .match(/[A-Za-z0-9#,.:/@()\- ]{6,}/g)
      ?.filter((line) => !/^(obj|endobj|stream|endstream|xref|trailer)/i.test(line.trim()))
      .slice(0, 60);
    if (asciiRuns && asciiRuns.length > 0) {
      return asciiRuns.join("\n").trim();
    }
  }

  return `Attachment uploaded: ${fileName || "tender-document"} (${mimeType || "binary"}, ${bytes.length.toLocaleString()} bytes). Review or paste tender details below to confirm extraction.`;
}

export interface RegisterApiRoutesOptions {
  env?: NodeJS.ProcessEnv;
  bookingOptions?: Partial<BookTaiLoadsOptions>;
  helperOptions?: Partial<DirectTaiHelperOptions>;
  aiOptions?: GroundedAiOptions;
  gmailFetchImpl?: typeof fetch;
}

interface GmailApiPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number };
  parts?: GmailApiPart[];
}

function decodeGmailBase64Url(data: string | undefined): string {
  if (!data) return "";
  try {
    return Buffer.from(data, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

function extractGmailBodyAndAttachments(payload: GmailApiPart | undefined): {
  bodyText: string;
  attachments: Array<{ filename: string; mimeType?: string }>;
} {
  let plain = "";
  let html = "";
  const attachments: Array<{ filename: string; mimeType?: string }> = [];

  const walk = (part: GmailApiPart | undefined) => {
    if (!part) return;
    const mime = String(part.mimeType || "").toLowerCase();
    if (part.filename && String(part.filename).trim()) {
      attachments.push({ filename: String(part.filename).trim(), mimeType: part.mimeType });
    }
    if (mime === "text/plain" && part.body?.data && !plain) {
      plain = decodeGmailBase64Url(part.body.data);
    } else if (mime === "text/html" && part.body?.data && !html) {
      html = decodeGmailBase64Url(part.body.data);
    }
    if (Array.isArray(part.parts)) {
      for (const child of part.parts) walk(child);
    }
  };
  walk(payload);

  const bodyText =
    plain.trim() ||
    html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  return { bodyText, attachments };
}

async function fetchLiveGmailMessages(
  accessToken: string,
  doFetch: typeof fetch = fetch,
): Promise<IngestEmailInput[]> {
  const listResp = await doFetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=25&q=in%3Ainbox",
    {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    },
  );
  if (!listResp.ok) return [];
  const listJson = (await listResp.json()) as { messages?: Array<{ id?: string; threadId?: string }> };
  const refs = (listJson.messages || []).slice(0, 25);
  if (refs.length === 0) return [];

  const fetched = await Promise.all(
    refs.map(async (ref): Promise<IngestEmailInput | null> => {
      if (!ref.id) return null;
      try {
        const msgResp = await doFetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(ref.id)}?format=full`,
          {
            headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!msgResp.ok) return null;
        const msg = (await msgResp.json()) as {
          id?: string;
          threadId?: string;
          snippet?: string;
          labelIds?: string[];
          payload?: GmailApiPart & { headers?: Array<{ name?: string; value?: string }> };
        };
        const headers = msg.payload?.headers || [];
        const getHdr = (name: string) =>
          headers.find((h) => String(h.name || "").toLowerCase() === name.toLowerCase())?.value || "";
        const subject = getHdr("Subject");
        const from = getHdr("From");
        const dateHdr = getHdr("Date");
        const { bodyText, attachments } = extractGmailBodyAndAttachments(msg.payload);
        return {
          messageId: msg.id,
          threadId: msg.threadId || ref.threadId,
          from,
          subject,
          snippet: msg.snippet || "",
          bodyText: bodyText || msg.snippet || "",
          receivedAt: dateHdr ? dateHdr.slice(0, 22) : "Recent",
          unread: Array.isArray(msg.labelIds) ? msg.labelIds.includes("UNREAD") : false,
          permalink: msg.threadId ? `https://mail.google.com/mail/u/0/#inbox/${msg.threadId}` : undefined,
          attachments,
        };
      } catch {
        return null;
      }
    }),
  );

  return fetched.filter((x): x is IngestEmailInput => x !== null);
}

export function registerApiRoutes(app: Express, options: RegisterApiRoutesOptions = {}): void {
  const env = options.env ?? process.env;

  // Enforce x-gmail-panel-expected-email account drift check on /api/panel/* and /api/gmail-panel/*
  const enforceExpectedPanelEmail = (req: Request, res: Response, next: NextFunction) => {
    const rawExpected = req.headers["x-gmail-panel-expected-email"];
    const expected = String(Array.isArray(rawExpected) ? rawExpected[0] : rawExpected || "")
      .trim()
      .toLowerCase();
    const signedIn = String(req.staffUser?.email || "")
      .trim()
      .toLowerCase();
    if (expected && signedIn && expected !== signedIn) {
      res.status(409).json({
        ok: false,
        error: "toolkit_account_changed",
        expectedEmail: expected,
        actualEmail: signedIn,
        message: `Gmail panel expected ${expected}, but session is signed in as ${signedIn}.`,
      });
      return;
    }
    next();
  };

  app.use("/api/panel", enforceExpectedPanelEmail);
  app.use("/api/gmail-panel", enforceExpectedPanelEmail);

  // Fly.io unauthenticated liveness endpoint
  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ ok: true, service: "fivenines-ops", ts: new Date().toISOString() });
  });

  // Server-Sent Events stream for instant Supabase Realtime & TAI Webhook updates
  app.get("/api/events", (_req: Request, res: Response) => {
    addSseClient(res);
  });

  app.get("/api/bootstrap", async (req: Request, res: Response) => {
    const forceRefresh = req.query.refresh === "1" || req.query.refresh === "true";
    const data = await store.getBootstrap(req.staffUser || null, { forceRefresh });
    res.setHeader("Cache-Control", "no-store");
    res.json(data);
  });

  // Gmail Panel Session & CSRF endpoint
  app.get("/api/gmail-panel/session", (req: Request, res: Response) => {
    const user = req.staffUser
      ? {
          email: req.staffUser.email,
          name: req.staffUser.name,
          displayName: req.staffUser.name,
          mode: req.staffUser.mode,
        }
      : null;
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      user,
      oauthEnabled: Boolean(env.GOOGLE_CLIENT_ID?.trim()),
      gatewayConfigured: isPfdGatewayConfigured(env),
      csrfToken: generateCsrfToken(user?.email, env),
    });
  });

  // TAI Booking Status & Redacted Push Diagnostics
  app.get("/api/tai/booking/status", (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(
      getTaiBookingStatus({
        env,
        credential: options.bookingOptions?.credential,
        liveAllowed: options.bookingOptions?.liveAllowed,
      }),
    );
  });

  app.get("/api/tai/push-log", (req: Request, res: Response) => {
    const limit = Number(req.query.limit) || 50;
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, logs: getTaiPushLogs(limit) });
  });

  const handleFacilitySearch = async (req: Request, res: Response) => {
    try {
      const src = (req.method === "GET" ? req.query : req.body) as Record<string, unknown> | undefined;
      const str = (key: string): string => {
        const raw = src?.[key];
        const v = Array.isArray(raw) ? raw[0] : raw;
        return typeof v === "string" ? v.trim() : v != null ? String(v).trim() : "";
      };
      const rawLimit = Number(Array.isArray(src?.limit) ? src?.limit[0] : src?.limit);
      const result = await searchFacilityAndMapsCandidates(
        {
          query: str("query") || str("q"),
          companyName: str("companyName") || str("company"),
          streetAddress: str("streetAddress") || str("address"),
          city: str("city"),
          state: str("state"),
          zipCode: str("zipCode") || str("zip"),
          limit: Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined,
        },
        store.facilities,
        store.shipments,
      );
      res.json(result);
    } catch (err) {
      res.status(500).json({
        ok: false,
        message: err instanceof Error ? err.message : "Facility search failed",
      });
    }
  };

  app.get("/api/facilities/search", handleFacilitySearch);
  app.post("/api/facilities/search", handleFacilitySearch);

  app.post("/api/facilities/save", async (req: Request, res: Response) => {
    const actor = req.staffUser?.email || "fivenines-ops";
    const result = await saveFacilityRecord(req.body || {}, {
      ...options.helperOptions,
      actor,
    });
    res.status(result.status).json(result);
  });

  app.post("/api/extract-email", (req: Request, res: Response) => {
    const bodyText = String(req.body?.bodyText || req.body?.text || "").trim();
    const subject = String(req.body?.subject || "").trim();
    const sender = String(req.body?.sender || req.body?.from || "").trim();
    if (!bodyText && !subject) {
      res.status(400).json({ ok: false, message: "Paste email text or open a Gmail thread first." });
      return;
    }
    const result = extractLoadEntryFromEmail(
      { subject, sender, bodyText },
      store.customers,
      store.facilities,
    );
    res.json({ ok: true, ...result });
  });

  // Guarded Load Preview (resolves customerId/carrierMasterId + deterministic 64-char sha256 previewToken)
  app.post("/api/loads/preview", async (req: Request, res: Response) => {
    const entry = normalizeIncomingLoadEntry(req.body);
    if (!entry) {
      res.status(400).json({ ok: false, message: "LoadEntry payload is required." });
      return;
    }
    const result = await previewTaiBookingAsync(entry, {
      customers: options.bookingOptions?.customers,
      carriers: options.bookingOptions?.carriers,
      supabaseClient: options.bookingOptions?.supabaseClient,
      baseUrl: options.bookingOptions?.baseUrl,
    });
    res.json(result);
  });

  // Guarded 3-Step TAI Booking (previewToken check + 409 duplicate guard + Shipments -> ShipmentCharges -> CarrierCharges)
  const handleBookLoad = async (req: Request, res: Response, successStatus: number) => {
    const entry = normalizeIncomingLoadEntry(req.body);
    if (!entry) {
      res.status(400).json({ ok: false, message: "LoadEntry payload is required." });
      return;
    }
    const bodyObj = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    const previewToken = typeof bodyObj.previewToken === "string" ? bodyObj.previewToken : undefined;
    const confirmDuplicate = bodyObj.confirmDuplicate === true;
    const duplicateCount = Number(bodyObj.duplicateCount) || 1;
    const actor = req.staffUser?.email ? `fivenines-ops:${req.staffUser.email}` : "fivenines-ops";

    const result = await bookTaiLoads(entry, {
      ...options.bookingOptions,
      duplicateCount,
      previewToken,
      confirmDuplicate,
      actor,
    });
    res.status(result.ok ? successStatus : result.status).json(result);
  };

  // Server-Paged All Loads Endpoint (12,572+ Supabase rows when live, deterministic fallback offline)
  app.get("/api/loads", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const pageResult = await store.queryShipmentsPage({
      page: Number(req.query.page) || 1,
      pageSize: Number(req.query.pageSize) || 100,
      status: typeof req.query.status === "string" ? req.query.status : undefined,
      view: typeof req.query.view === "string" ? req.query.view : undefined,
      search:
        typeof req.query.search === "string"
          ? req.query.search
          : typeof req.query.q === "string"
          ? req.query.q
          : undefined,
      sortBy:
        typeof req.query.sortBy === "string"
          ? req.query.sortBy
          : typeof req.query.sortKey === "string"
          ? req.query.sortKey
          : undefined,
      sortDir: typeof req.query.sortDir === "string" ? req.query.sortDir : undefined,
    });
    res.json(pageResult);
  });

  app.post("/api/loads", (req: Request, res: Response) => {
    void handleBookLoad(req, res, 201);
  });

  app.post("/api/loads/book", (req: Request, res: Response) => {
    void handleBookLoad(req, res, 200);
  });

  // Full Edit Shipment w/ Guarded Live TAI Write-Back (ShipmentCharges, CarrierCharges, References, Tracking)
  const handleEditShipment = async (req: Request, res: Response) => {
    const actor = req.staffUser?.email ? `fivenines-ops:${req.staffUser.email}` : "fivenines-ops";
    const result = await updateShipmentFull(String(req.params.id), req.body || {}, {
      ...options.helperOptions,
      billingWriteEnabled: options.bookingOptions?.billingWriteEnabled,
      actor,
    });
    res.status(result.status).json(result);
  };
  app.patch("/api/loads/:id", handleEditShipment);
  app.put("/api/loads/:id", handleEditShipment);

  // Click-to-cycle / explicit RateCon status update ("Not Sent" | "Drafted" | "Sent" | "Signed")
  app.patch("/api/loads/:id/ratecon-status", async (req: Request, res: Response) => {
    const actor = req.staffUser?.email || "ops-desk";
    const result = await updateShipmentRateconStatus(String(req.params.id), req.body?.rateconStatus, actor);
    res.status(result.status).json(result);
  });

  app.post("/api/loads/:id/writeback-carrier", async (req: Request, res: Response) => {
    const actor = req.staffUser?.email ? `fivenines-ops:${req.staffUser.email}` : "fivenines-ops";
    const result = await enqueueCarrierWriteback({
      shipmentId: String(req.params.id),
      carrierName: String(req.body?.carrierName || ""),
      buyRate: Number(req.body?.buyRate) || 0,
      requestedBy: actor,
    });
    res.status(result.status).json(result);
  });

  // Check Calls & Tracking Write-Back ("Canceled" spelled with one l)
  app.post("/api/loads/:id/check-call", async (req: Request, res: Response) => {
    const actor = req.staffUser?.email || "dispatch";
    const result = await pushShipmentCheckCall(String(req.params.id), req.body || {}, {
      ...options.helperOptions,
      actor,
    });
    res.status(result.status).json(result);
  });

  // Reference Numbers Update (local + bare-array PUT /PublicApi/Shipping/v2/ShipmentReferenceNumbers?shipmentId=...)
  app.post("/api/loads/:id/references", async (req: Request, res: Response) => {
    const actor = req.staffUser?.email || "dispatch";
    const result = await pushShipmentReferences(String(req.params.id), req.body || {}, {
      ...options.helperOptions,
      actor,
    });
    res.status(result.status).json(result);
  });

  // Hydrated Bill of Lading & Carrier Rate Confirmation Document Generators
  app.get("/api/loads/:id/bol", (req: Request, res: Response) => {
    const id = String(req.params.id || "").trim();
    const s = store.shipments.find((item) => item.id === id);
    if (!s) {
      res.status(404).json({ ok: false, message: `Shipment #${id} not found` });
      return;
    }
    res.json(buildBolDocument(s));
  });

  app.get("/api/loads/:id/ratecon", (req: Request, res: Response) => {
    const id = String(req.params.id || "").trim();
    const s = store.shipments.find((item) => item.id === id);
    if (!s) {
      res.status(404).json({ ok: false, message: `Shipment #${id} not found` });
      return;
    }
    res.json(buildRateconDocument(s));
  });

  // Historical Lane Pricing Estimator (useDatLane: false hardcoded — ZERO DAT calls)
  const handleRateEstimate = (req: Request, res: Response) => {
    const bodyObj = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    const out = estimateHistoricalLaneRates(bodyObj);
    res.status(out.status).json(out);
  };
  app.post("/api/rates/estimate", handleRateEstimate);
  app.post("/api/gmail-panel/quote/estimate", handleRateEstimate);

  // Exact Integer-Mils Fuel Surcharge (FSC) Calculator
  app.post("/api/rates/fsc", (req: Request, res: Response) => {
    const bodyObj = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    const hasPegKey = Object.prototype.hasOwnProperty.call(bodyObj, "pegPrice");
    const pegRaw = bodyObj.pegPrice;
    const parsedPeg =
      hasPegKey && pegRaw !== undefined
        ? pegRaw === null || pegRaw === ""
          ? Number.NaN
          : Number(pegRaw)
        : undefined;

    const result = calculateFuelSurcharge({
      dieselPrice: bodyObj.dieselPrice === null || bodyObj.dieselPrice === "" ? Number.NaN : Number(bodyObj.dieselPrice),
      schedule: typeof bodyObj.schedule === "string" ? bodyObj.schedule : undefined,
      ...(hasPegKey ? { pegPrice: parsedPeg } : {}),
      ...(bodyObj.mpg !== undefined ? { mpg: Number(bodyObj.mpg) } : {}),
      ...(bodyObj.floor !== undefined ? { floor: Number(bodyObj.floor) } : {}),
      ...(bodyObj.step !== undefined ? { step: Number(bodyObj.step) } : {}),
      ...(bodyObj.basePercent !== undefined ? { basePercent: Number(bodyObj.basePercent) } : {}),
      ...(bodyObj.stepPercent !== undefined ? { stepPercent: Number(bodyObj.stepPercent) } : {}),
      ...(bodyObj.linehaulAmount !== undefined ? { linehaulAmount: Number(bodyObj.linehaulAmount) } : {}),
      ...(bodyObj.miles !== undefined ? { miles: Number(bodyObj.miles) } : {}),
    });
    res.status(result.status).json(result);
  });

  // Real TAI POD upload (GET preflight → POST /DocumentAttachments → GET read-back). See tai-pod-routes.ts.
  registerPodUploadRoute(app);

  app.post("/api/loads/:id/sell", (req: Request, res: Response) => {
    const s = store.shipments.find((x) => x.id === req.params.id);
    if (!s) {
      res.status(404).json({ ok: false, message: "Shipment not found" });
      return;
    }
    const newSell = Math.max(0, Number(req.body?.sellRate) || 0);
    s.sell = newSell;
    delete s.mismatchNote;
    s.writebackState = `Local Sell updated to $${newSell.toLocaleString()} (TAI ShipmentCharges PUT gated on staff API permission)`;
    store.kpis.tmsMismatches = Math.max(0, store.kpis.tmsMismatches - 1);
    res.json({ ok: true, shipment: s, message: `Updated #${s.id} sell to $${newSell.toLocaleString()}` });
  });

  app.post("/api/loads/:id/note", async (req: Request, res: Response) => {
    const idOrContainer = String(req.params.id || "").trim();
    const s = store.shipments.find(
      (x) => x.id === idOrContainer || (x.containerNumber && sameContainerNumber(x.containerNumber, idOrContainer)),
    );
    if (!s) {
      res.status(404).json({ ok: false, message: `Shipment or container ${idOrContainer} not found` });
      return;
    }

    const explicitNote = String(req.body?.note || "").trim();
    const pastedEmailText = String(req.body?.pastedEmailText || "").trim();
    const explicitContainer = String(req.body?.containerNumber || "").trim();

    const detected = extractContainerNumbers(`${explicitContainer} ${pastedEmailText} ${explicitNote}`);
    if (detected[0]) {
      s.containerNumber = detected[0];
    }

    const synth = synthesizeContainerExceptionNote([pastedEmailText, explicitNote]);
    const finalNote = explicitNote || synth.note || pastedEmailText.slice(0, 280);
    if (finalNote) {
      s.operationalNote = finalNote;
    }

    if (pastedEmailText || explicitNote) {
      s.containerEvents = [
        {
          id: `note-${Date.now()}`,
          timestamp: new Date().toLocaleTimeString(),
          from: req.staffUser?.email || "ops-desk",
          subject: detected[0] ? `Container ${detected[0]} Update` : `Load #${s.id} Operational Note`,
          summary: explicitNote || synth.note || pastedEmailText.slice(0, 320),
          kind: synth.hasTonu ? "tonu" : "exception",
        },
        ...(s.containerEvents || []),
      ];
    }

    // Correlate matching email tiles too
    for (const em of store.crucialEmails) {
      if (
        em.loadId === s.id ||
        (s.containerNumber && em.containerNumber && sameContainerNumber(s.containerNumber, em.containerNumber))
      ) {
        if (s.containerNumber) em.containerNumber = s.containerNumber;
        if (s.operationalNote) em.operationalNote = s.operationalNote;
      }
    }

    const sb = store.getSupabase();
    if (!store.isSafeSandbox && sb && s.operationalNote) {
      await sb
        .from("shipments")
        .update({ notes: s.operationalNote, updated_at: new Date().toISOString() })
        .eq("shipment_id", s.id);
    }

    broadcastOpsEvent("shipment_updated", { shipmentId: s.id });
    res.json({
      ok: true,
      shipment: s,
      message: `Saved container/exception note on #${s.id}${s.containerNumber ? ` (${s.containerNumber})` : ""}`,
    });
  });

  app.delete("/api/loads/:id", (req: Request, res: Response) => {
    const id = String(req.params.id || "").trim();
    const removed = store.deleteShipment(id);
    if (!removed) {
      res.status(404).json({ ok: false, message: `Load #${id} not found` });
      return;
    }
    broadcastOpsEvent("shipment_updated", { deletedId: id });
    res.json({ ok: true, id, message: `Deleted load #${id}` });
  });

  // Live TAI Invoice Sync Endpoints
  app.post("/api/tai/invoices/sync", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const shipmentIds = Array.isArray(req.body?.shipmentIds)
      ? (req.body.shipmentIds as unknown[]).map((x) => String(x || "").trim()).filter(Boolean)
      : undefined;
    const limit = typeof req.body?.limit === "number" ? req.body.limit : undefined;
    const result = await syncTaiInvoices(shipmentIds, {
      limit,
      actor: req.staffUser?.email,
    });
    res.json(result);
  });

  app.post("/api/loads/:id/sync-invoice", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const sid = String(req.params.id || "").trim();
    const result = await syncTaiInvoicesForShipment(sid, {
      actor: req.staffUser?.email,
    });
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.get("/api/tai/invoices/:id", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const sid = String(req.params.id || "").trim();
    const result = await syncTaiInvoicesForShipment(sid, {
      actor: req.staffUser?.email,
    });
    res.status(result.ok ? 200 : 400).json(result);
  });

  // Live Gmail Inbox Stream & Extension Auto-Ingest Endpoints
  app.get("/api/inbox", (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const items = store.getInboxItems();
    res.json({
      ok: true,
      items,
      count: items.length,
      unreadCount: items.filter((i) => i.unread).length,
    });
  });

  app.post("/api/inbox/ingest", (req: Request, res: Response) => {
    const origin = req.headers.origin || "";
    if (origin.startsWith("chrome-extension://") || origin.startsWith("https://mail.google.com")) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    const rawBody = req.body;
    const rawItems: IngestEmailInput[] = Array.isArray(rawBody)
      ? rawBody
      : Array.isArray(rawBody?.items)
      ? rawBody.items
      : rawBody && typeof rawBody === "object"
      ? [rawBody as IngestEmailInput]
      : [];

    const out = store.ingestExtensionEmails(rawItems);
    res.json({
      ok: true,
      ingested: out.ingested,
      count: out.items.length,
      items: out.items,
    });
  });

  const handleInboxSync = async (req: Request, res: Response) => {
    if (store.isSupabaseConfigured) {
      await store.refreshFromSupabase();
    }
    const bearerHeader = String(req.headers.authorization || "");
    const bearerToken = bearerHeader.toLowerCase().startsWith("bearer ") ? bearerHeader.slice(7).trim() : "";
    const accessToken =
      getStaffGmailAccessToken(req.staffUser?.email) ||
      (bearerToken && bearerToken.split(".").length !== 3 ? bearerToken : null);

    let syncedGmailMessages = 0;
    if (accessToken) {
      const gmailItems = await fetchLiveGmailMessages(accessToken, options.gmailFetchImpl ?? fetch);
      if (gmailItems.length > 0) {
        const ingested = store.ingestExtensionEmails(gmailItems);
        syncedGmailMessages = ingested.ingested;
      }
    }

    const items = store.getInboxItems();
    broadcastOpsEvent("inbox_updated", { count: items.length, syncedGmailMessages });
    res.json({
      ok: true,
      items,
      count: items.length,
      syncedGmailMessages,
      oauthConnected: Boolean(accessToken),
      supabaseConnected: store.supabaseConnected,
      message: syncedGmailMessages > 0
        ? `Synced ${syncedGmailMessages} Gmail thread(s) into Five Nines Inbox.`
        : store.supabaseConnected
        ? `Refreshed ${items.length} live inbox item(s) from Supabase.`
        : `Loaded ${items.length} inbox item(s).`,
    });
  };
  app.post("/api/inbox/sync", handleInboxSync);
  app.post("/api/inbox/sync-gmail", handleInboxSync);

  app.delete("/api/inbox/:id", (req: Request, res: Response) => {
    const id = String(req.params.id || "").trim();
    const removed = store.dismissEmail(id);
    if (!removed) {
      res.status(404).json({ ok: false, message: "Email tile not found" });
      return;
    }
    broadcastOpsEvent("shipment_updated", { dismissedEmailId: id });
    res.json({ ok: true, id, message: "Deleted email tile from Crucial Inbox" });
  });

  // ============================================================================
  // GMAIL PANEL SUPPORT ROUTES (/api/panel/*)
  // ============================================================================
  app.get("/api/panel/drafts", (_req: Request, res: Response) => {
    res.json({ ok: true, drafts: panelDrafts });
  });

  app.post("/api/panel/drafts", (req: Request, res: Response) => {
    const entry = normalizeIncomingLoadEntry(req.body);
    if (!entry) {
      res.status(400).json({ ok: false, message: "Draft LoadEntry is required." });
      return;
    }
    const now = new Date().toISOString();
    const requestedId = typeof req.body?.id === "string" ? req.body.id.trim() : "";
    const origCity = entry.stops[0]?.city || "Origin";
    const destCity = entry.stops[entry.stops.length - 1]?.city || "Dest";
    const defaultTitle = `${entry.customer.name || "Spot"} · ${origCity} → ${destCity}${entry.references.customerPO ? ` (PO ${entry.references.customerPO})` : ""}`;
    const title = String(req.body?.title || defaultTitle).trim();
    const source = String(req.body?.source || "manual");

    const existingIdx = requestedId ? panelDrafts.findIndex((d) => d.id === requestedId) : -1;
    let saved: PanelDraftRecord;
    if (existingIdx >= 0) {
      saved = {
        ...panelDrafts[existingIdx],
        title,
        source,
        ...(req.body?.subject !== undefined ? { subject: String(req.body.subject) } : {}),
        ...(req.body?.sender !== undefined ? { sender: String(req.body.sender) } : {}),
        ...(req.body?.notes !== undefined ? { notes: String(req.body.notes) } : {}),
        entry,
        updatedAt: now,
      };
      panelDrafts[existingIdx] = saved;
    } else {
      saved = {
        id: requestedId || `draft-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        title,
        source,
        ...(req.body?.subject ? { subject: String(req.body.subject) } : {}),
        ...(req.body?.sender ? { sender: String(req.body.sender) } : {}),
        ...(req.body?.notes ? { notes: String(req.body.notes) } : {}),
        entry,
        createdBy: req.staffUser?.email || "ops-desk",
        createdAt: now,
        updatedAt: now,
      };
      panelDrafts.unshift(saved);
      if (panelDrafts.length > 50) panelDrafts.length = 50;
    }
    res.json({ ok: true, draft: saved, drafts: panelDrafts, message: `Saved draft "${saved.title}".` });
  });

  app.delete("/api/panel/drafts/:id", (req: Request, res: Response) => {
    const id = String(req.params.id || "").trim();
    const idx = panelDrafts.findIndex((d) => d.id === id);
    if (idx >= 0) panelDrafts.splice(idx, 1);
    res.json({ ok: true, drafts: panelDrafts });
  });

  app.get("/api/panel/knowledge", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      rules: panelKnowledgeRules,
      learnedCount: panelKnowledgeRules.length,
    });
  });

  app.post("/api/panel/knowledge", (req: Request, res: Response) => {
    const bodyObj = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    if (bodyObj.action === "delete" && typeof bodyObj.id === "string") {
      const idx = panelKnowledgeRules.findIndex((r) => r.id === bodyObj.id);
      if (idx >= 0) panelKnowledgeRules.splice(idx, 1);
      res.json({
        ok: true,
        rules: panelKnowledgeRules,
        learnedCount: panelKnowledgeRules.length,
        message: "Removed rule.",
      });
      return;
    }

    const entry = normalizeIncomingLoadEntry(bodyObj);
    let customerName = String(bodyObj.customerName || entry?.customer.name || "General").trim();
    let lane = String(bodyObj.lane || "").trim();
    let ruleText = String(bodyObj.ruleText || bodyObj.rule || "").trim();
    const scope =
      bodyObj.scope === "lane" || bodyObj.scope === "facility" ? bodyObj.scope : ("customer" as const);

    if (!lane && entry && entry.stops.length >= 2) {
      const first = entry.stops[0];
      const last = entry.stops[entry.stops.length - 1];
      lane = `${first.city || "?"}, ${first.state || "?"} → ${last.city || "?"}, ${last.state || "?"}`;
    }

    if (!ruleText && entry) {
      const parts = [
        `${customerName || "Customer"}`,
        lane ? `Lane ${lane}` : "",
        entry.equipment.trailerType ? `Equip: ${entry.equipment.trailerType}` : "",
        entry.specialInstructions ? `Notes: ${entry.specialInstructions}` : "",
      ].filter(Boolean);
      ruleText = parts.join(" · ");
    }

    if (!ruleText) {
      res.status(400).json({ ok: false, message: "Provide ruleText or a LoadEntry to learn from." });
      return;
    }

    const normRule = ruleText.toLowerCase().replace(/\s+/g, " ");
    let rule = panelKnowledgeRules.find((r) => r.ruleText.toLowerCase().replace(/\s+/g, " ") === normRule);
    if (!rule) {
      rule = {
        id: `know-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        scope,
        customerName: customerName || "General",
        lane,
        ruleText,
        ...(entry?.equipment.trailerType ? { equipment: entry.equipment.trailerType } : {}),
        ...(entry?.specialInstructions ? { instructions: entry.specialInstructions } : {}),
        status: "approved",
        createdBy: req.staffUser?.email || "ops-desk",
        createdAt: new Date().toISOString(),
      };
      panelKnowledgeRules.unshift(rule);
    }

    res.json({
      ok: true,
      rule,
      rules: panelKnowledgeRules,
      learnedCount: panelKnowledgeRules.length,
      message: `Learned rule (${panelKnowledgeRules.length} total): ${rule.ruleText}`,
    });
  });

  app.post("/api/panel/check-email", (req: Request, res: Response) => {
    const subject = String(req.body?.subject || "").trim();
    const sender = String(req.body?.sender || req.body?.from || "").trim();
    const bodyText = String(req.body?.bodyText || req.body?.text || "").trim();
    const combined = `${subject}\n${bodyText}`.trim();

    if (!combined) {
      res.status(400).json({ ok: false, message: "Provide email subject or bodyText to check against active loads." });
      return;
    }

    // Explicit tender / shipment cancellation detector (ignores policy boilerplate like "cancellation fee")
    const cancelMatch = combined.match(
      /\b(please\s+cancel|cancel\s+(?:this\s+)?(?:load|order|shipment|tender|pickup|truck)|(?:order|load|shipment|tender)\s+(?:is|has\s+been|was)\s+cancell?ed|do\s+not\s+ship|void\s+(?:this\s+)?(?:load|tender))\b/i,
    );
    const cancellation = {
      detected: Boolean(cancelMatch),
      severity: cancelMatch ? ("high" as const) : ("none" as const),
      reason: cancelMatch ? `Explicit cancellation phrase found: "${cancelMatch[0]}"` : null,
    };

    const containerNumbers = extractContainerNumbers(combined);
    const poMatch = combined.match(/(?:\bPO\b|\bP\.O\.\b|Purchase\s*Order)\s*#?:?\s*([A-Z0-9-]{3,24})/i);
    const extractedPo = poMatch ? poMatch[1].trim() : null;

    const extractedAmounts = Array.from(
      combined.matchAll(/\$\s?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,5})(?:\.\d{2})?/g),
      (m) => Number(m[1].replace(/,/g, "")),
    ).filter((n) => Number.isFinite(n) && n >= 100 && n <= 50_000);

    const matchedShipments = store.shipments.filter((s) => {
      if (s.id.length >= 5 && combined.includes(s.id)) return true;
      if (s.containerNumber && containerNumbers.some((cn) => sameContainerNumber(s.containerNumber, cn))) return true;
      if (s.po && s.po.length >= 4 && combined.toLowerCase().includes(s.po.toLowerCase())) return true;
      if (s.bol && s.bol.length >= 4 && combined.toLowerCase().includes(s.bol.toLowerCase())) return true;
      if (s.pro && s.pro.length >= 4 && combined.toLowerCase().includes(s.pro.toLowerCase())) return true;
      const custFirst = s.customer.split(/\s+/)[0]?.toLowerCase() || "";
      const origCity = s.stops[0]?.city?.toLowerCase() || "";
      const destCity = s.stops[s.stops.length - 1]?.city?.toLowerCase() || "";
      if (
        custFirst.length >= 4 &&
        origCity.length >= 3 &&
        destCity.length >= 3 &&
        `${sender} ${combined}`.toLowerCase().includes(custFirst) &&
        combined.toLowerCase().includes(origCity) &&
        combined.toLowerCase().includes(destCity)
      ) {
        return true;
      }
      return false;
    });

    const diffs: Array<{
      type: "cancellation" | "missing_po" | "po_mismatch" | "rate_diff" | "exception";
      shipmentId: string;
      currentValue?: string | number;
      emailValue?: string | number;
      summary: string;
    }> = [];

    const synth = synthesizeContainerExceptionNote([subject, bodyText]);

    for (const s of matchedShipments) {
      if (cancellation.detected) {
        diffs.push({
          type: "cancellation",
          shipmentId: s.id,
          currentValue: s.rawStatus,
          emailValue: "Canceled",
          summary: `Load #${s.id}: Cancellation requested in email ("${cancelMatch?.[0]}") — confirm & mark Canceled in TAI.`,
        });
      }
      if (extractedPo) {
        if (!s.po) {
          diffs.push({
            type: "missing_po",
            shipmentId: s.id,
            currentValue: "",
            emailValue: extractedPo,
            summary: `Load #${s.id} is missing Customer PO — email specifies PO #${extractedPo}.`,
          });
        } else if (s.po.toLowerCase() !== extractedPo.toLowerCase()) {
          diffs.push({
            type: "po_mismatch",
            shipmentId: s.id,
            currentValue: s.po,
            emailValue: extractedPo,
            summary: `Load #${s.id} PO mismatch: TAI has "${s.po}", email specifies "${extractedPo}".`,
          });
        }
      }
      for (const amt of extractedAmounts) {
        if (amt !== s.sell && amt !== s.buy) {
          diffs.push({
            type: "rate_diff",
            shipmentId: s.id,
            currentValue: `$${s.sell.toLocaleString()} sell / $${s.buy.toLocaleString()} buy`,
            emailValue: amt,
            summary: `Load #${s.id}: Email mentions $${amt.toLocaleString()} vs current $${s.sell.toLocaleString()} sell / $${s.buy.toLocaleString()} buy.`,
          });
          break;
        }
      }
      if (synth.hasTonu || synth.hasEquipmentIssue) {
        diffs.push({
          type: "exception",
          shipmentId: s.id,
          summary: synth.note || `Operational exception detected on Load #${s.id}.`,
        });
      }
    }

    const summary = cancellation.detected
      ? `⚠ Cancellation Alert: ${cancellation.reason}${matchedShipments[0] ? ` (Matched Load #${matchedShipments[0].id})` : ""}`
      : matchedShipments.length > 0
      ? `Matched ${matchedShipments.length} active load(s) (#${matchedShipments.map((m) => m.id).join(", #")}) with ${diffs.length} discrepancy alert(s).`
      : "No existing load matched — ready to extract as a new tender in Load Builder.";

    res.json({
      ok: true,
      matchedShipments,
      cancellation,
      diffs,
      extractedPo,
      extractedAmounts,
      containerNumbers,
      isNewTenderCandidate: matchedShipments.length === 0 && !cancellation.detected,
      summary,
    });
  });

  app.get("/api/panel/ap-tasks", (req: Request, res: Response) => {
    const tasks = ensureSeededApTasks();
    const q = String(req.query.q || "").trim().toLowerCase();
    const statusFilter = String(req.query.status || "").trim().toLowerCase();
    const filtered = tasks.filter((t) => {
      if (statusFilter && statusFilter !== "all" && t.status !== statusFilter) return false;
      if (!q) return true;
      return `${t.shipmentId} ${t.customer} ${t.carrier} ${t.subject} ${t.from} ${t.notes} ${t.invoiceNumber || ""}`
        .toLowerCase()
        .includes(q);
    });
    res.json({
      ok: true,
      tasks: filtered,
      openCount: tasks.filter((t) => t.status !== "resolved").length,
    });
  });

  app.post("/api/panel/ap-tasks", (req: Request, res: Response) => {
    const tasks = ensureSeededApTasks();
    const bodyObj = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;

    if (typeof bodyObj.id === "string" && bodyObj.id.trim()) {
      const target = tasks.find((t) => t.id === bodyObj.id);
      if (!target) {
        res.status(404).json({ ok: false, message: "AP task not found." });
        return;
      }
      if (bodyObj.status === "open" || bodyObj.status === "in_review" || bodyObj.status === "resolved") {
        target.status = bodyObj.status;
      } else if (bodyObj.action === "resolve") {
        target.status = "resolved";
      }
      if (typeof bodyObj.notes === "string") {
        target.notes = bodyObj.notes.trim();
      }
      res.json({
        ok: true,
        task: target,
        tasks,
        openCount: tasks.filter((t) => t.status !== "resolved").length,
        message: `Updated AP task (${target.status}).`,
      });
      return;
    }

    const subject = String(bodyObj.subject || "Carrier AP Email").trim();
    const from = String(bodyObj.from || bodyObj.sender || "carrier@example.com").trim();
    const bodyText = String(bodyObj.bodyText || bodyObj.notes || "").trim();
    const loadIdMatch = `${subject} ${bodyText}`.match(/\b(13\d{7}|\d{6,10})\b/);
    const shipmentId = String(bodyObj.shipmentId || loadIdMatch?.[1] || "NEW").trim();
    const ship = store.shipments.find((s) => s.id === shipmentId);
    const catRaw = String(bodyObj.category || "").toLowerCase();
    const category: PanelApTask["category"] =
      catRaw === "invoice" || catRaw === "pod" || catRaw === "rate_discrepancy" || catRaw === "tonu" || catRaw === "po"
        ? catRaw
        : /\bpod\b/i.test(`${subject} ${bodyText}`)
        ? "pod"
        : /\btonu\b/i.test(`${subject} ${bodyText}`)
        ? "tonu"
        : /\binvoice\b/i.test(`${subject} ${bodyText}`)
        ? "invoice"
        : "general";

    const created: PanelApTask = {
      id: `ap-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      shipmentId,
      customer: String(bodyObj.customer || ship?.customer || "Customer"),
      carrier: String(bodyObj.carrier || ship?.carrier || "Carrier"),
      category,
      subject,
      from,
      ...(Number(bodyObj.amount) > 0 ? { amount: Number(bodyObj.amount) } : {}),
      ...(bodyObj.invoiceNumber ? { invoiceNumber: String(bodyObj.invoiceNumber) } : {}),
      status: "open",
      notes: bodyText.slice(0, 280) || "Captured from Gmail AP collector",
      receivedAt: "Just now",
      ...(bodyObj.permalink ? { permalink: String(bodyObj.permalink) } : {}),
    };
    tasks.unshift(created);
    res.json({
      ok: true,
      task: created,
      tasks,
      openCount: tasks.filter((t) => t.status !== "resolved").length,
      message: `Added AP task for #${created.shipmentId}.`,
    });
  });

  app.post("/api/panel/transcribe-attachment", (req: Request, res: Response) => {
    const fileName = String(req.body?.fileName || "tender.pdf").trim();
    const mimeType = String(req.body?.mimeType || "application/pdf").trim();
    const subject = String(req.body?.subject || fileName).trim();
    const sender = String(req.body?.sender || req.body?.from || "").trim();
    const providedTranscript = String(req.body?.transcript || req.body?.text || "").trim();
    const rawBase64 = String(req.body?.base64 || "").trim();

    let transcript = providedTranscript;
    if (!transcript && rawBase64) {
      const stripped = rawBase64.replace(/^data:[^;]+;base64,/i, "").trim();
      const bytes = Buffer.from(stripped, "base64");
      if (bytes.length > 12 * 1024 * 1024) {
        res.status(400).json({ ok: false, message: "Attachment exceeds 12 MB limit." });
        return;
      }
      transcript = extractReadableTextFromAttachment(bytes, mimeType, fileName);
    }

    if (!transcript) {
      res.status(400).json({ ok: false, message: "Provide a PDF/image base64 payload or transcript text." });
      return;
    }

    const extracted = extractLoadEntryFromEmail(
      { subject, sender, bodyText: transcript },
      store.customers,
      store.facilities,
    );

    res.json({
      ok: true,
      fileName,
      mimeType,
      transcript,
      confirmed: Boolean(req.body?.confirm),
      ...extracted,
      message: req.body?.confirm
        ? `Confirmed transcript and populated Load Builder (${extracted.summary})`
        : `Transcribed "${fileName}" — review transcript and confirm to populate Load Builder.`,
    });
  });

  // ============================================================================
  // SALESOPS CRM ROUTES
  // ============================================================================
  // pushedToVercelCrm is only ever set true after the remote webhook returns 2xx; otherwise the lead is local-only.
  const pushLeadWebhook = async (
    lead: ReturnType<typeof store.addCrmLead>["lead"],
  ): Promise<{ pushedRemote: boolean; status: number; reason?: "not_configured" | "remote_failed" }> => {
    const secret = process.env.CRM_WEBHOOK_SECRET?.trim();
    if (!secret) {
      return { pushedRemote: false, status: 0, reason: "not_configured" };
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    };
    const bypass = process.env.CRM_VERCEL_BYPASS_SECRET?.trim();
    if (bypass) headers["x-vercel-protection-bypass"] = bypass;

    const resp = await fetch(store.getCrmWebhookUrl(), {
      method: "POST",
      headers,
      body: JSON.stringify({
        company_name: lead.company,
        contact_name: lead.contact || undefined,
        email: lead.email || undefined,
        phone: lead.phone || undefined,
        address: lead.location || undefined,
        notes: [lead.evidence, lead.estimatedLanes].filter(Boolean).join(" · ") || "Added from Five Nines Ops",
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (resp.ok) {
      store.updateCrmLead(lead.id, { pushedToVercelCrm: true });
      return { pushedRemote: true, status: resp.status };
    }
    return { pushedRemote: false, status: resp.status, reason: "remote_failed" };
  };

  app.post("/api/crm/leads", async (req: Request, res: Response) => {
    const rawList = Array.isArray(req.body?.leads) ? req.body.leads : [req.body];
    let added = 0;
    let duplicates = 0;
    let blockedExisting = 0;
    let lastBlockedMatch: string | undefined;
    let lastLead = null;

    for (const item of rawList) {
      if (!item || !String(item.company || "").trim()) continue;
      const result = store.addCrmLead({
        company: String(item.company || ""),
        contact: item.contact,
        email: item.email,
        phone: item.phone,
        location: item.location,
        source: item.source,
        sourceUrl: item.sourceUrl,
        status: item.status,
        owner: item.owner || req.staffUser?.name || "Chris Sturma",
        followUp: item.followUp,
        evidence: item.evidence,
        estimatedLanes: item.estimatedLanes,
      });
      if (result.blockedExistingCustomer) {
        blockedExisting++;
        lastBlockedMatch = result.matchedCustomer || String(item.company);
        continue;
      }
      lastLead = result.lead;
      if (result.duplicate) {
        duplicates++;
      } else {
        added++;
        if (process.env.CRM_WEBHOOK_SECRET?.trim()) {
          pushLeadWebhook(result.lead).catch(() => {});
        }
      }
    }

    if (!lastLead && blockedExisting > 0) {
      res.status(409).json({
        ok: false,
        blockedExistingCustomer: true,
        matchedCustomer: lastBlockedMatch,
        leads: store.crmLeads,
        message: `"${lastBlockedMatch}" is already an existing TAI customer — SalesOps CRM only tracks net-new prospects.`,
      });
      return;
    }

    if (!lastLead) {
      res.status(400).json({ ok: false, message: "Company name is required" });
      return;
    }

    broadcastOpsEvent("crm_updated", { added });
    res.json({
      ok: true,
      lead: lastLead,
      leads: store.crmLeads,
      added,
      duplicates,
      skippedExistingCustomers: blockedExisting,
      message:
        rawList.length > 1
          ? `Imported ${added} lead(s) (${duplicates} duplicate, ${blockedExisting} existing customer skipped).`
          : `Added ${lastLead.company} to SalesOps CRM.`,
    });
  });

  app.patch("/api/crm/leads/:id", (req: Request, res: Response) => {
    const updated = store.updateCrmLead(String(req.params.id), req.body || {});
    if (!updated) {
      res.status(404).json({ ok: false, message: "Lead not found" });
      return;
    }
    broadcastOpsEvent("crm_updated", { id: updated.id });
    res.json({ ok: true, lead: updated, message: `Updated ${updated.company} (${updated.status}).` });
  });

  app.delete("/api/crm/leads/:id", (req: Request, res: Response) => {
    const id = String(req.params.id || "").trim();
    const removed = store.deleteCrmLead(id);
    if (!removed) {
      res.status(404).json({ ok: false, message: "Lead not found" });
      return;
    }
    broadcastOpsEvent("crm_updated", { deletedId: id });
    res.json({ ok: true, id, message: "Deleted lead from SalesOps CRM." });
  });

  app.post("/api/crm/leads/:id/push", async (req: Request, res: Response) => {
    const lead = store.crmLeads.find((l) => l.id === req.params.id);
    if (!lead) {
      res.status(404).json({ ok: false, message: "Lead not found" });
      return;
    }
    try {
      const outcome = await pushLeadWebhook(lead);
      const current = store.crmLeads.find((l) => l.id === lead.id);
      if (outcome.pushedRemote) {
        broadcastOpsEvent("crm_updated", { id: lead.id });
        res.json({ ok: true, lead: current, pushedRemote: true, message: `Pushed ${lead.company} live to SalesOps Vercel CRM!` });
        return;
      }
      if (outcome.reason === "not_configured") {
        res.status(503).json({
          ok: false,
          lead: current,
          pushedRemote: false,
          message: `${lead.company} is saved locally only — CRM_WEBHOOK_SECRET is not configured on the server, so nothing was pushed to the Vercel CRM.`,
        });
        return;
      }
      res.status(502).json({
        ok: false,
        lead: current,
        pushedRemote: false,
        message: `${lead.company} is saved locally only — SalesOps Vercel CRM webhook returned HTTP ${outcome.status}.`,
      });
    } catch (err) {
      res.status(502).json({
        ok: false,
        lead: store.crmLeads.find((l) => l.id === lead.id),
        pushedRemote: false,
        message: `${lead.company} is saved locally only — SalesOps webhook push failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  app.post("/api/inbox/:id/apply", async (req: Request, res: Response) => {
    const item = store.crucialEmails.find((e) => e.id === req.params.id);
    if (!item) {
      res.status(404).json({ ok: false, message: "Action email not found" });
      return;
    }
    const s = item.loadId !== "NEW" ? store.shipments.find((x) => x.id === item.loadId) : undefined;
    const bodyObj = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    const hasExplicitOverrides =
      bodyObj.po !== undefined ||
      bodyObj.customerPO !== undefined ||
      bodyObj.sellRate !== undefined ||
      bodyObj.buyRate !== undefined ||
      bodyObj.note !== undefined ||
      bodyObj.operationalNote !== undefined;

    if (item.diffType === "missing_pod" && !hasExplicitOverrides) {
      // The server has no access to the Gmail attachment bytes, so nothing can be sent to TAI from here.
      // Never mark the POD as uploaded/verified without TAI confirming it: direct the user to the real upload.
      res.status(501).json({
        ok: false,
        action: "pod_upload_required",
        shipment: s,
        message: `POD not uploaded: download the attachment from Gmail and use "Upload POD" on Load #${item.loadId} (POST /api/loads/${item.loadId}/pod). Only a TAI read-back marks it verified.`,
      });
      return;
    }

    if (item.loadId === "NEW" || item.diffType === "new_tender") {
      const extracted = extractLoadEntryFromEmail(
        {
          subject: item.subject,
          sender: item.from,
          bodyText: item.fullBody || item.body,
        },
        store.customers,
        store.facilities,
      );
      item.applied = true;
      broadcastOpsEvent("inbox_updated", { appliedId: item.id });
      res.json({
        ok: true,
        action: "extract_tender",
        entry: extracted.entry,
        extractedFields: item.extractedFields,
        email: item,
        message: `Extracted tender from "${item.subject}" into Compact Load Builder`,
      });
      return;
    }

    const poOverride = String(bodyObj.po ?? bodyObj.customerPO ?? item.extractedFields?.customerPO ?? item.extractedPo ?? "").trim();
    const sellOverride = Number(bodyObj.sellRate ?? item.extractedFields?.sellRate ?? 0) || 0;
    const buyOverride = Number(bodyObj.buyRate ?? item.extractedFields?.buyRate ?? 0) || 0;
    const noteOverride = String(
      bodyObj.operationalNote ?? bodyObj.note ?? item.operationalNote ?? item.extractedFields?.notes ?? "",
    ).trim();

    if (hasExplicitOverrides && item.loadId !== "NEW") {
      const actor = req.staffUser?.email ? `fivenines-ops:${req.staffUser.email}` : "fivenines-ops";
      const updated = await updateShipmentFull(
        item.loadId,
        {
          ...(poOverride ? { po: poOverride } : {}),
          ...(sellOverride > 0 ? { sell: sellOverride } : {}),
          ...(buyOverride > 0 ? { buy: buyOverride } : {}),
          ...(noteOverride ? { operationalNote: noteOverride } : {}),
        },
        {
          ...options.helperOptions,
          billingWriteEnabled: options.bookingOptions?.billingWriteEnabled,
          actor,
        },
      );
      item.applied = true;
      broadcastOpsEvent("inbox_updated", { appliedId: item.id });
      res.status(updated.ok ? 200 : updated.status).json({
        ok: updated.ok,
        action: "email_fields_applied",
        shipment: updated.shipment,
        taiWriteback: updated.taiWriteback,
        email: item,
        message: updated.message,
      });
      return;
    }

    if (item.diffType === "missing_po" || (poOverride && (!s || !s.po))) {
      const poVal = poOverride || item.extractedPo || "";
      if (s && poVal) {
        await pushShipmentReferences(
          s.id,
          { po: poVal },
          { ...options.helperOptions, actor: req.staffUser?.email || "ops-desk" },
        );
      }
      item.applied = true;
      broadcastOpsEvent("inbox_updated", { appliedId: item.id });
      res.json({ ok: true, action: "po_updated", shipment: s, email: item, message: `Wrote PO ${poVal} to Load #${item.loadId}` });
      return;
    }

    if (item.diffType === "rate_mismatch") {
      if (item.operationalNote && !item.extractedAmount) {
        if (s) {
          if (item.containerNumber && !s.containerNumber) s.containerNumber = item.containerNumber;
          s.operationalNote = item.operationalNote;
          s.writebackState = `✓ Exception note synced (${s.containerNumber || s.id})`;
        }
        item.applied = true;
        broadcastOpsEvent("shipment_updated", { shipmentId: item.loadId });
        broadcastOpsEvent("inbox_updated", { appliedId: item.id });
        res.json({
          ok: true,
          action: "note_synced",
          shipment: s,
          email: item,
          message: `Synced container/TONU note onto Load #${item.loadId}`,
        });
        return;
      }
      const amt = item.extractedAmount && item.extractedAmount > 0 ? item.extractedAmount : sellOverride;
      if (s && amt > 0) {
        if (amt >= s.sell) s.sell = amt;
        else s.buy = amt;
        delete s.mismatchNote;
        if (item.operationalNote && !s.operationalNote) s.operationalNote = item.operationalNote;
        s.writebackState = `Rates synced from email ($${s.sell.toLocaleString()} sell / $${s.buy.toLocaleString()} buy)`;
      }
      item.applied = true;
      store.kpis.tmsMismatches = Math.max(0, store.kpis.tmsMismatches - 1);
      broadcastOpsEvent("shipment_updated", { shipmentId: item.loadId });
      broadcastOpsEvent("inbox_updated", { appliedId: item.id });
      res.json({
        ok: true,
        action: "sell_updated",
        shipment: s,
        email: item,
        message: `Updated rates on Load #${item.loadId}${amt > 0 ? ` ($${amt.toLocaleString()})` : ""}`,
      });
      return;
    }

    item.applied = true;
    broadcastOpsEvent("inbox_updated", { appliedId: item.id });
    res.json({ ok: true, action: "applied", shipment: s, email: item, message: `Applied update for #${item.loadId}` });
  });

  // Grounded Live AI Copilot / Assistant (zero hardcoded fake carriers or static counts)
  const handleAiAsk = async (req: Request, res: Response) => {
    const question = String(req.body?.question || req.body?.prompt || req.body?.q || "").trim();
    const activeEmail =
      req.body?.activeEmail && typeof req.body.activeEmail === "object"
        ? (req.body.activeEmail as Record<string, unknown>)
        : null;
    const history = Array.isArray(req.body?.history)
      ? (req.body.history as Array<{ role: string; text: string }>)
      : undefined;

    const out = await answerGroundedOpsQuestion({ question, activeEmail, history }, options.aiOptions);
    res.status(out.status).json(out);
  };
  app.post("/api/ai/ask", handleAiAsk);
  app.post("/api/assistant/ask", handleAiAsk);
  app.post("/api/copilot", handleAiAsk);

  // Canonical TAI Inbound Webhooks (both /shipment and root alias supported)
  const shipmentWebhookHandler = (req: Request, res: Response) => {
    if (!verifyWebhookSecretIfConfigured(req.headers, req.query.secret)) {
      res.status(401).json({ ok: false, message: "Invalid TAI webhook secret" });
      return;
    }
    const result = handleTaiShipmentWebhook(req.body || {}, req.headers);
    res.status(result.status).json(result);
  };
  app.post("/api/webhooks/tai", shipmentWebhookHandler);
  app.post("/api/webhooks/tai/shipment", shipmentWebhookHandler);

  app.post("/api/webhooks/tai/invoice", (req: Request, res: Response) => {
    if (!verifyWebhookSecretIfConfigured(req.headers, req.query.secret)) {
      res.status(401).json({ ok: false, message: "Invalid TAI webhook secret" });
      return;
    }
    const result = handleTaiInvoiceWebhook(req.body || {}, req.headers);
    res.status(result.status).json(result);
  });

  app.post("/api/webhooks/tai/simulate", (req: Request, res: Response) => {
    const kind = String(req.body?.kind || "gps");
    if (kind === "invoice") {
      const target = store.shipments[0];
      const out = handleTaiInvoiceWebhook({
        shipmentId: target.id,
        invoiceNumber: `INV-${Math.floor(10000 + Math.random() * 89999)}`,
        invoiceType: "AR",
        totalAmount: target.sell,
      });
      res.json({ ...out, message: `Simulated inbound TAI InvoiceCreateWithShipmentUrl on #${target.id}` });
      return;
    }
    const target = store.shipments.find((s) => s.id === "132738007") || store.shipments[0];
    const out = handleTaiShipmentWebhook({
      shipmentId: target.id,
      status: "In Transit",
      locationString: "I-40 E · Little Rock, AR 72202",
      totalBuy: target.buy || 2200,
    });
    res.json({ ...out, message: `Simulated inbound TAI ShipmentDetailUpdateUrl GPS update on #${target.id}` });
  });
}
