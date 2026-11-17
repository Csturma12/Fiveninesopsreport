import {
  normalizeTaiPackagingType,
  normalizeTaiServiceLevel,
  normalizeTaiTrailerType,
} from "./tai-booking-enums";
import type { AccessorialScope } from "./accessorial-options";
import { validateStateZipMatch } from "./us-zip-ranges";

export type TaiStopType = "First Pickup" | "Pick" | "Drop" | "Last Drop";

export interface LoadEntryStop {
  stopType: TaiStopType;
  companyName: string;
  streetAddress: string;
  streetAddressTwo?: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
  contactName: string;
  phone: string;
  email?: string;
  instructions: string;
  referenceNumber?: string;
  readyDate: string;      // YYYY-MM-DD
  timeOpen: string;       // HH:mm
  timeClose: string;      // HH:mm
  appointmentRequired: boolean;
  savedFacilityMatched?: boolean;
}

export interface LoadEntryItem {
  description: string;
  packagingType: string;
  handlingQuantity: number;
  piecesTotal: number;
  weightTotal: number;
  hazardousMaterial: boolean;
  freightClass: string;
  length?: number;
  width?: number;
  height?: number;
  referenceNumber: string; // Marks / line reference
}

export interface LoadEntryAccessorial {
  scope: AccessorialScope;
  code: string;
  name: string;
  sell: number;
  buy: number;
}

export interface LoadEntry {
  shipmentType: "Truckload" | "LTL" | "Intermodal" | "Drayage";
  status: "Quote" | "Committed";
  customer: {
    name: string;
    taiOrganizationId?: string; // Optional! Loads register in TAI even without a linked customer org ID.
    contactName?: string;
    email?: string;
  };
  references: {
    customerPO: string;
    bolNumber: string;
    invoiceRef: string;
    carrierProNumber: string;
    pickupNumber: string;
    driverName?: string;
    driverPhone?: string;
  };
  stops: LoadEntryStop[];
  items: LoadEntryItem[];
  accessorials: LoadEntryAccessorial[];
  equipment: {
    trailerSize: "Full" | "Partial";
    trailerType: string;
    equipmentLength: string;
    mileage: number;
    linearFeet?: number;
    stackable: boolean;
  };
  pricing: {
    linehaulSell: number;
    fuelSell: number;
    linehaulBuy: number;
    fuelBuy: number;
  };
  carrier: {
    name: string;
    scac?: string;
    mcNumber?: string;
    serviceLevel: string;
  };
  specialInstructions: string;
  sendToTai: boolean;
}

export interface TaiValidationIssue {
  field: string;
  message: string;
}

/**
 * Enforces every TAI Domestic Shipment registration requirement BEFORE sending to TAI
 * (matching TAI's required Origin/Dest ZIPs, Stop Facility/City/State/Date,
 * and Commodity Piece Count + Total Weight + Description on every line —
 * while keeping TAI Customer Organization ID strictly optional).
 */
export function validateTaiLoadEntry(entry: LoadEntry): TaiValidationIssue[] {
  const issues: TaiValidationIssue[] = [];

  if (!entry.stops || entry.stops.length < 2) {
    issues.push({ field: "stops", message: "At least 1 Pickup stop and 1 Delivery stop are required." });
  } else {
    entry.stops.forEach((st, idx) => {
      const role =
        idx === 0
          ? "Origin"
          : idx === entry.stops.length - 1
          ? "Destination"
          : `Stop ${idx + 1} (${st.stopType})`;
      if (!String(st.companyName || "").trim()) {
        issues.push({ field: `stops.${idx}.companyName`, message: `${role} company / facility name is required` });
      }
      if (!String(st.city || "").trim() || !String(st.state || "").trim()) {
        issues.push({ field: `stops.${idx}.city`, message: `${role} city and 2-letter state are required` });
      }
      if (!/^\d{5}(-\d{4})?$/.test(String(st.zipCode || "").trim())) {
        issues.push({ field: `stops.${idx}.zipCode`, message: `${role.toLowerCase()} zip code is required (5-digit US ZIP)` });
      } else if (String(st.state || "").trim()) {
        const check = validateStateZipMatch(st.state, st.zipCode);
        if (!check.valid && check.message) {
          issues.push({
            field: `stops.${idx}.zipCode`,
            message: `${role} ${check.message} — verify facility address/ZIP`,
          });
        }
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(st.readyDate || "").trim())) {
        issues.push({ field: `stops.${idx}.readyDate`, message: `${role} date (YYYY-MM-DD) is required` });
      }
    });
  }

  if (!entry.items || entry.items.length === 0) {
    issues.push({ field: "items", message: "commodities missing required fields: add at least 1 item to ship" });
  } else {
    const totalWt = entry.items.reduce((acc, it) => acc + (Number(it.weightTotal) || 0), 0);
    if (totalWt <= 0) {
      issues.push({ field: "items.weightTotal", message: "commodities missing required fields: -- total weight" });
    }
    entry.items.forEach((it, idx) => {
      if (!String(it.description || "").trim()) {
        issues.push({
          field: `items.${idx}.description`,
          message: `Commodity Line ${idx + 1}: Commodity must include a description.`,
        });
      }
      if ((Number(it.piecesTotal) || 0) <= 0) {
        issues.push({
          field: `items.${idx}.piecesTotal`,
          message: `Commodity Line ${idx + 1}: piece count must be at least 1.`,
        });
      }
      if ((Number(it.weightTotal) || 0) <= 0) {
        issues.push({
          field: `items.${idx}.weightTotal`,
          message: `Commodity Line ${idx + 1}: line weight (lbs) is required.`,
        });
      }
      if (!normalizeTaiPackagingType(it.packagingType)) {
        issues.push({
          field: `items.${idx}.packagingType`,
          message: `Commodity Line ${idx + 1}: unsupported TAI packaging type "${it.packagingType}".`,
        });
      }
    });
  }

  if (!normalizeTaiTrailerType(entry.equipment.trailerType)) {
    issues.push({
      field: "equipment.trailerType",
      message: `Canonical TAI Equipment Type is required (got "${entry.equipment.trailerType || "empty"}").`,
    });
  }

  return issues;
}

export function loadEntryTotals(entry: Pick<LoadEntry, "pricing" | "accessorials" | "items">) {
  const linehaulSell = Number(entry.pricing.linehaulSell) || 0;
  const fuelSell = Number(entry.pricing.fuelSell) || 0;
  const linehaulBuy = Number(entry.pricing.linehaulBuy) || 0;
  const fuelBuy = Number(entry.pricing.fuelBuy) || 0;
  const accessorialSell = entry.accessorials.reduce((s, a) => s + (Number(a.sell) || 0), 0);
  const accessorialBuy = entry.accessorials.reduce((s, a) => s + (Number(a.buy) || 0), 0);
  const totalSell = linehaulSell + fuelSell + accessorialSell;
  const totalBuy = linehaulBuy + fuelBuy + accessorialBuy;
  const totalMargin = totalSell - totalBuy;
  const marginPct = totalSell > 0 ? Number(((totalMargin / totalSell) * 100).toFixed(1)) : 0;
  const totalWeight = entry.items.reduce((s, i) => s + (Number(i.weightTotal) || 0), 0);
  const totalPieces = entry.items.reduce((s, i) => s + (Number(i.piecesTotal) || 0), 0);
  const totalHandling = entry.items.reduce((s, i) => s + (Number(i.handlingQuantity) || 0), 0);

  return {
    linehaulSell,
    fuelSell,
    linehaulBuy,
    fuelBuy,
    accessorialSell,
    accessorialBuy,
    totalSell,
    totalBuy,
    totalMargin,
    marginPct,
    totalWeight,
    totalPieces,
    totalHandling,
  };
}

function taiStopType(stop: LoadEntryStop, index: number, total: number): TaiStopType {
  if (index === 0) return "First Pickup";
  if (index === total - 1) return "Last Drop";
  return stop.stopType === "First Pickup" ? "Pick" : stop.stopType === "Last Drop" ? "Drop" : stop.stopType;
}

function toTaiDateTime(date: string, time: string, fallbackTime: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const hhmm = /^\d{2}:\d{2}$/.test(time) ? time : fallbackTime;
  return `${date}T${hhmm}:00`;
}

function formatTaiAccessorialName(row: LoadEntryAccessorial): string {
  const rawName = String(row.name || "").trim();
  const scopeLabel = `${row.scope[0].toUpperCase()}${row.scope.slice(1)}`;
  if (!rawName) return scopeLabel;
  if (/\s*-\s*(?:Pickup|Delivery|Shipment|Rating|Accounting|Fuel|Lumper)$/i.test(rawName)) {
    return rawName;
  }
  return `${rawName} - ${scopeLabel}`;
}

/**
 * Builds the exact CommitDomesticShipmentRequest body for POST /PublicApi/Shipping/v2/Shipments.
 * Note: customerId is included ONLY when a numeric TAI Organization ID is linked;
 * unlinked customers cleanly omit customerId so TAI still books the load.
 */
export function buildTaiShipmentRequest(entry: LoadEntry): Record<string, unknown> {
  const trailerType = normalizeTaiTrailerType(entry.equipment.trailerType) ?? entry.equipment.trailerType;
  const serviceLevel = normalizeTaiServiceLevel(entry.carrier.serviceLevel);
  const hasHazmat = (entry.items || []).some((item) => Boolean(item.hazardousMaterial));

  const stops = entry.stops.map((stop, idx) => {
    const type = taiStopType(stop, idx, entry.stops.length);
    const isPick = type.toLowerCase().includes("pick");
    const openDt = toTaiDateTime(stop.readyDate, stop.timeOpen, isPick ? "08:00" : "09:00");
    const closeDt = toTaiDateTime(stop.readyDate, stop.timeClose, isPick ? "15:00" : "16:00");
    const instructionParts = [stop.instructions, idx === 0 ? entry.specialInstructions : ""]
      .map((s) => String(s || "").trim())
      .filter(Boolean);
    if (idx === 0 && hasHazmat && !/hazmat/i.test(instructionParts.join(" | "))) {
      instructionParts.unshift("HAZMAT");
    }
    return {
      stopType: type,
      companyName: stop.companyName || null,
      streetAddress: stop.streetAddress || null,
      streetAddressTwo: stop.streetAddressTwo || null,
      city: (stop.city || "").toUpperCase(),
      state: (stop.state || "").toUpperCase(),
      zipCode: stop.zipCode || null,
      country: stop.country || "USA",
      contactName: stop.contactName || null,
      phone: stop.phone || null,
      email: stop.email || null,
      instructions: instructionParts.join(" | "),
      notes: null,
      referenceNumber: stop.referenceNumber || null,
      estimatedReadyDateTime: stop.appointmentRequired ? null : openDt,
      estimatedCloseDateTime: stop.appointmentRequired ? null : closeDt,
      appointmentReadyDateTime: stop.appointmentRequired ? openDt : null,
      appointmentCloseDateTime: stop.appointmentRequired ? closeDt : null,
      shipmentStopReferenceNumbers: [] as Array<{ referenceType: string; value: string }>,
    };
  });

  const commodities = entry.items.map((item) => ({
    description: item.description || null,
    piecesTotal: Number(item.piecesTotal) || 1,
    weightTotal: Number(item.weightTotal) || 0,
    freightClass: item.freightClass || "No Class",
    packagingType: normalizeTaiPackagingType(item.packagingType) ?? "Pallet",
    handlingQuantity: Number(item.handlingQuantity) || 0,
    hazardousMaterial: Boolean(item.hazardousMaterial),
    hazardClasses: [] as string[],
    nmfc: null,
    length: item.length && item.length > 0 ? item.length : null,
    width: item.width && item.width > 0 ? item.width : null,
    height: item.height && item.height > 0 ? item.height : null,
    referenceNumber: item.referenceNumber || null,
    shipmentCommodityReferenceNumbers: [] as Array<{ referenceType: string; value: string }>,
  }));

  const orgStr = String(entry.customer.taiOrganizationId || "").trim();
  const customerId = /^\d+$/.test(orgStr) ? Number(orgStr) : undefined;

  const refPairs: Array<[string, string | undefined]> = [
    ["Customer PO Number", entry.references.customerPO],
    ["Shipper Reference Number", entry.references.bolNumber],
    ["Load Release Number", entry.references.invoiceRef],
    ["Linehaul Carrier Pro Number", entry.references.carrierProNumber],
    ["Linehaul Pickup Number", entry.references.pickupNumber],
    ["Driver Name", entry.references.driverName],
    ["Driver Cell Phone Number", entry.references.driverPhone],
  ];
  const shipmentReferenceNumbers = refPairs
    .filter(([, val]) => String(val || "").trim().length > 0)
    .map(([referenceType, val]) => ({ referenceType, value: String(val).trim() }));

  const accessorialCodes = entry.accessorials.map((row) => ({
    code: row.code || "CUSTOM",
    name: formatTaiAccessorialName(row),
  }));

  const tariffs = entry.carrier.name
    ? [
        {
          tariffName: "Linehaul",
          transitLeg: "Linehaul",
          serviceLevel,
          ...(entry.carrier.scac ? { carrierSCAC: entry.carrier.scac } : {}),
        },
      ]
    : [];

  return {
    shipmentType: entry.shipmentType || "Truckload",
    isCommitted: entry.status !== "Quote",
    rateShipment: false,
    ...(customerId !== undefined ? { customerId } : {}),
    ...(entry.carrier.scac ? { carrierSCAC: entry.carrier.scac } : {}),
    serviceLevel,
    trailerSize: entry.equipment.trailerSize || "Full",
    trailerType,
    weightUnits: "lbs",
    dimensionUnits: "in",
    stackable: Boolean(entry.equipment.stackable),
    ...(entry.equipment.mileage > 0 ? { mileage: Math.round(entry.equipment.mileage) } : {}),
    driverCellPhoneNumber: entry.references.driverPhone || null,
    stops,
    commodities,
    shipmentReferenceNumbers,
    accessorialCodes,
    tariffs,
  };
}

export function extractTaiShipmentId(body: unknown, text = ""): string {
  const candidates: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (value == null || depth > 3) return;
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      candidates.push(String(value));
      return;
    }
    if (typeof value === "string" && /^\d{4,}$/.test(value.trim())) {
      candidates.push(value.trim());
      return;
    }
    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;
      for (const key of ["shipmentId", "ShipmentId", "id", "Id", "shipment", "data"]) {
        if (key in obj) visit(obj[key], depth + 1);
      }
    }
  };
  visit(body, 0);
  if (candidates.length > 0) return candidates[0];
  const rawMatch = String(text || "").trim().match(/^"?(\d{5,})"?$/);
  return rawMatch ? rawMatch[1] : "";
}
