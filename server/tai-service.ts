import crypto from "node:crypto";
import {
  buildTaiShipmentRequest,
  extractTaiShipmentId,
  loadEntryTotals,
  validateTaiLoadEntry,
  type LoadEntry,
  type LoadEntryAccessorial,
  type LoadEntryItem,
  type LoadEntryStop,
  type TaiValidationIssue,
} from "../shared/load-entry";
import {
  extractDateShort,
  mapTaiStatusToStage,
  type CarrierOption,
  type CustomerOption,
  type DispatchStage,
  type OpsShipment,
  type SavedFacility,
  type TaiInvoiceWebhookPayload,
  type TaiShipmentWebhookPayload,
} from "../shared/tai-webhook-schema";
import { broadcastOpsEvent } from "./events";
import { isPfdGatewayConfigured } from "./pfd-gateway";
import { store } from "./store";
import {
  haltTaiOnAuthFailure,
  isTaiAuthFailureStatus,
  isTaiAuthHalted,
  recordTaiPush,
  taiApiKey,
  type SupabaseInsertLike,
} from "./tai-push-log";
import {
  isNumericTaiShipmentId,
  isPendingReadBack,
  pollerConfigStatus,
  READ_BACK_PENDING_SAVE_MESSAGE,
  runPollerForAssignmentId,
  SAVE_WAIT_MS,
} from "./tai-writeback-poller";

export { isNumericTaiShipmentId };

export const DEFAULT_TAI_BASE_URL = "https://primaryfreightllc.taicloud.net";
export const TAI_SHIPMENTS_PATH = "/PublicApi/Shipping/v2/Shipments";
export const TAI_SHIPMENT_CHARGES_PATH = "/PublicApi/Shipping/v2/ShipmentCharges";
export const TAI_CARRIER_CHARGES_PATH = "/PublicApi/Shipping/v2/CarrierCharges";
export const TAI_TRACKING_PATH = "/PublicApi/Shipping/v2/Tracking";
export const TAI_REFERENCE_NUMBERS_PATH = "/PublicApi/Shipping/v2/ShipmentReferenceNumbers";
export const TAI_CUSTOMER_ADDRESSES_PATH = "/PublicApi/Customer/v2/Addresses";

export type EquipmentFamily =
  | "sprinter"
  | "box_truck"
  | "hotshot"
  | "drayage"
  | "tanker"
  | "double_drop"
  | "step_deck"
  | "flatbed"
  | "conestoga"
  | "power_only"
  | "reefer"
  | "dry_van"
  | "other";

/**
 * Normalizes TAI / user equipment strings into canonical rate-matching families.
 * Specific vehicle classes (`Sprinter Van`, `Straight/Box/City Truck`, `Flatbed`, and
 * `Tanker | Intermodal` / `Container | Flexibag` -> `drayage`) MUST be matched BEFORE
 * generic `| Reefer` or `Van` suffixes so e.g. `Sprinter Van | Reefer` or `Flatbed | Reefer Tri-Axle`
 * is never mis-bucketed into 53' Reefer.
 */
export function normalizeEquipmentFamily(rawEquipment: string | undefined | null): EquipmentFamily {
  const s = String(rawEquipment || "").trim();
  if (!s) return "other";
  if (/sprinter|cargo\s*van/i.test(s)) return "sprinter";
  if (/straight\s*truck|box\s*truck|city\s*truck/i.test(s)) return "box_truck";
  if (/hot\s*shot/i.test(s)) return "hotshot";
  if (/tanker\s*\|\s*intermodal|container\s*\|\s*flexibag|\bcontainer\b|\bdrayage\b|\bintermodal\b/i.test(s)) {
    return "drayage";
  }
  if (/\btanker\b/i.test(s)) return "tanker";
  if (/double\s*drop|low\s*boy|\brgn\b|landoll/i.test(s)) return "double_drop";
  if (/step\s*deck/i.test(s)) return "step_deck";
  if (/flatbed|super\s*b/i.test(s)) return "flatbed";
  if (/conestoga|curtain\s*side/i.test(s)) return "conestoga";
  if (/power\s*only|toter/i.test(s)) return "power_only";
  if (/reefer|refrigerated/i.test(s)) return "reefer";
  if (/\bvan\b/i.test(s)) return "dry_van";
  return "other";
}

export type FscScheduleType = "drayage" | "odfl" | "tl_per_mile";

export interface FscCalculationInput {
  dieselPrice: number;
  schedule?: FscScheduleType | "nickel" | "ltl_odfl" | "peg" | string;
  /** Optional peg price for TL per-mile FSC (must be > 0 and finite when provided). */
  pegPrice?: number;
  /** Optional MPG for TL per-mile FSC (defaults to 6.0, must be > 0 and finite). */
  mpg?: number;
  /** Optional nickel-schedule floor price (defaults to $1.20). */
  floor?: number;
  /** Optional nickel-schedule step size in dollars (defaults to $0.05). */
  step?: number;
  /** Optional base percentage at floor for nickel schedule (defaults to 8.0%). */
  basePercent?: number;
  /** Optional percentage increment per step for nickel schedule (defaults to 0.5%). */
  stepPercent?: number;
  /** Optional linehaul dollars or mileage to compute dollar FSC amount. */
  linehaulAmount?: number;
  miles?: number;
}

export type FscCalculationResult =
  | {
      ok: true;
      status: 200;
      schedule: FscScheduleType;
      dieselPrice: number;
      dieselMils: number;
      /** Decimal surcharge ratio for percentage schedules (e.g. 0.51 for 51.0%, 0.3182 for 31.82%). */
      rate?: number;
      /** Percentage surcharge for percentage schedules (e.g. 51.0 or 31.82). */
      percent?: number;
      formattedPercent?: string;
      steps?: number;
      fscPerMile?: number;
      pegPrice?: number;
      mpg?: number;
      fscAmount?: number;
    }
  | {
      ok: false;
      status: 400;
      message: string;
    };

/**
 * Exact integer-mils Fuel Surcharge (FSC) calculator:
 * - Nickel / Drayage schedule: `Math.floor((Math.round(d * 1000) - Math.round(floor * 1000)) / Math.round(step * 1000))`
 *   so exact 5-cent boundaries like `$5.50` never underflow via IEEE-754 float (`$5.50` -> `0.510` / `51.0%`, never `50.5%`).
 * - ODFL LTL/Container percentage schedule: uses `Math.round(d * 1000) / 10` exact cents (`$4.10` -> `410` cents -> `31.82%`).
 * - TL Per-Mile peg schedule: validates `pegPrice > 0 && Number.isFinite(pegPrice)` (rejecting NaN / <= 0 with 400).
 */
export function calculateFuelSurcharge(input: FscCalculationInput): FscCalculationResult {
  const d = Number(input.dieselPrice);
  if (!Number.isFinite(d) || d <= 0) {
    return { ok: false, status: 400, message: "dieselPrice must be a finite number greater than 0." };
  }

  if (input.pegPrice !== undefined) {
    const peg = Number(input.pegPrice);
    if (!Number.isFinite(peg) || peg <= 0) {
      return { ok: false, status: 400, message: "pegPrice must be a finite number greater than 0." };
    }
  }

  const rawSched = String(input.schedule || (input.pegPrice !== undefined ? "tl_per_mile" : "drayage"))
    .trim()
    .toLowerCase();

  const dMils = Math.round(d * 1000);

  if (rawSched === "tl_per_mile" || rawSched === "peg" || rawSched === "per_mile") {
    const pegPrice = input.pegPrice !== undefined ? Number(input.pegPrice) : 1.25;
    if (!Number.isFinite(pegPrice) || pegPrice <= 0) {
      return { ok: false, status: 400, message: "pegPrice must be a finite number greater than 0." };
    }
    const mpg = input.mpg !== undefined ? Number(input.mpg) : 6.0;
    if (!Number.isFinite(mpg) || mpg <= 0) {
      return { ok: false, status: 400, message: "mpg must be a finite number greater than 0." };
    }
    const pegMils = Math.round(pegPrice * 1000);
    const diffMils = Math.max(0, dMils - pegMils);
    const fscPerMile = Number((diffMils / (mpg * 1000)).toFixed(4));
    const miles = Number(input.miles) > 0 ? Number(input.miles) : 0;
    return {
      ok: true,
      status: 200,
      schedule: "tl_per_mile",
      dieselPrice: d,
      dieselMils: dMils,
      pegPrice,
      mpg,
      fscPerMile,
      ...(miles > 0 ? { fscAmount: Number((fscPerMile * miles).toFixed(2)) } : {}),
    };
  }

  if (rawSched === "odfl" || rawSched === "ltl_odfl" || rawSched === "ltl") {
    // Exact cents via Math.round(d * 1000) / 10 so $4.10 -> 410 cents (never 409.99999999999994 -> 409)
    const exactCents = Math.floor(Math.round(d * 1000) / 10);
    const rawPct = exactCents < 115 ? 0 : 5 + (exactCents - 115) / 11;
    const percent = Number((Math.round(rawPct * 100) / 100).toFixed(2));
    const rate = Number((percent / 100).toFixed(4));
    const linehaul = Number(input.linehaulAmount) > 0 ? Number(input.linehaulAmount) : 0;
    return {
      ok: true,
      status: 200,
      schedule: "odfl",
      dieselPrice: d,
      dieselMils: dMils,
      rate,
      percent,
      formattedPercent: `${percent.toFixed(2)}%`,
      ...(linehaul > 0 ? { fscAmount: Number(((linehaul * percent) / 100).toFixed(2)) } : {}),
    };
  }

  // Default: Exact integer-mils nickel / drayage schedule ($1.20 floor, $0.05 step, 8.0% base + 0.5% per step)
  const floor = input.floor !== undefined ? Number(input.floor) : 1.2;
  const step = input.step !== undefined ? Number(input.step) : 0.05;
  const basePercent = input.basePercent !== undefined ? Number(input.basePercent) : 8.0;
  const stepPercent = input.stepPercent !== undefined ? Number(input.stepPercent) : 0.5;
  if (!Number.isFinite(floor) || floor < 0 || !Number.isFinite(step) || step <= 0) {
    return { ok: false, status: 400, message: "floor (>= 0) and step (> 0) must be finite numbers." };
  }

  const floorMils = Math.round(floor * 1000);
  const stepMils = Math.round(step * 1000);
  if (stepMils <= 0) {
    return { ok: false, status: 400, message: "step must be at least $0.001 (1 mil)." };
  }

  let steps = 0;
  let percent = 0;
  if (dMils >= floorMils) {
    steps = Math.floor((dMils - floorMils) / stepMils);
    percent = Number((basePercent + steps * stepPercent).toFixed(2));
  }
  const rate = Number((percent / 100).toFixed(4));
  const linehaul = Number(input.linehaulAmount) > 0 ? Number(input.linehaulAmount) : 0;

  return {
    ok: true,
    status: 200,
    schedule: "drayage",
    dieselPrice: d,
    dieselMils: dMils,
    steps,
    rate,
    percent,
    formattedPercent: `${percent.toFixed(1)}%`,
    ...(linehaul > 0 ? { fscAmount: Number((linehaul * rate).toFixed(2)) } : {}),
  };
}

export interface ShipmentChargeBreakdown {
  linehaulSell: number;
  fuelSell: number;
  accessorialSell: number;
  linehaulBuy: number;
  fuelBuy: number;
  accessorialBuy: number;
}

const shipmentChargeBreakdowns = new Map<string, ShipmentChargeBreakdown>();

export function estimateAccessorialDollarsFromLabels(labels: readonly string[]): { sell: number; buy: number } {
  let sell = 0;
  let buy = 0;
  for (const raw of labels) {
    const l = String(raw || "").toLowerCase();
    if (!l) continue;
    if (l.includes("tonu")) {
      sell += 250;
      buy += 250;
    } else if (l.includes("team")) {
      sell += 400;
      buy += 350;
    } else if (l.includes("layover")) {
      sell += 350;
      buy += 300;
    } else if (l.includes("hazmat") || l.includes("hazardous")) {
      sell += 250;
      buy += 200;
    } else if (l.includes("tarp")) {
      sell += 150;
      buy += 100;
    } else if (l.includes("detention")) {
      sell += 150;
      buy += 125;
    } else if (l.includes("liftgate") || l.includes("tailgate")) {
      sell += 125;
      buy += 100;
    } else if (l.includes("pier pass")) {
      sell += 85;
      buy += 85;
    } else if (l.includes("appointment")) {
      sell += 50;
      buy += 25;
    } else if (l.includes("tracking")) {
      sell += 25;
      buy += 0;
    } else {
      sell += 75;
      buy += 50;
    }
  }
  return { sell, buy };
}

/**
 * Separates base linehaul from accessorials & fuel so `linehaulPerMile` (`comparisonBasis: "linehaul_only"`)
 * is never contaminated with accessorial charges.
 */
export function decomposeShipmentLinehaulVsAllIn(s: OpsShipment): {
  linehaulSell: number;
  accessorialAndFuelSell: number;
  allInSell: number;
  linehaulBuy: number;
  accessorialAndFuelBuy: number;
  allInBuy: number;
} {
  const allInSell = Math.max(0, Number(s.sell) || 0);
  const allInBuy = Math.max(0, Number(s.buy) || 0);
  const recorded = shipmentChargeBreakdowns.get(s.id);
  if (recorded) {
    const accFuelSell = Math.min(allInSell, Math.max(0, recorded.fuelSell + recorded.accessorialSell));
    const accFuelBuy = Math.min(allInBuy, Math.max(0, recorded.fuelBuy + recorded.accessorialBuy));
    return {
      linehaulSell: Math.max(0, allInSell - accFuelSell),
      accessorialAndFuelSell: accFuelSell,
      allInSell,
      linehaulBuy: Math.max(0, allInBuy - accFuelBuy),
      accessorialAndFuelBuy: accFuelBuy,
      allInBuy,
    };
  }

  const est = estimateAccessorialDollarsFromLabels(s.accessorials || []);
  // Cap deducted accessorials so linehaul remains positive when allIn > 0 (unless TONU-only load)
  const isTonuOnly = allInSell === 0 || (s.accessorials || []).some((a) => /tonu/i.test(a) && allInBuy <= 350);
  const cappedSellDeduct = isTonuOnly ? Math.min(allInSell, est.sell) : Math.min(Math.round(allInSell * 0.35), est.sell);
  const cappedBuyDeduct = isTonuOnly ? Math.min(allInBuy, est.buy) : Math.min(Math.round(allInBuy * 0.35), est.buy);

  return {
    linehaulSell: Math.max(0, allInSell - cappedSellDeduct),
    accessorialAndFuelSell: cappedSellDeduct,
    allInSell,
    linehaulBuy: Math.max(0, allInBuy - cappedBuyDeduct),
    accessorialAndFuelBuy: cappedBuyDeduct,
    allInBuy,
  };
}

function resolveTaiBaseUrl(override?: string, env: NodeJS.ProcessEnv = process.env): string {
  return String(override || env.TAI_BASE_URL || DEFAULT_TAI_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function parsePositiveInt(raw: unknown): number | null {
  const s = String(raw ?? "").trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function normalizeNameKey(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Normalizes `{ entry: LoadEntry }` or top-level `LoadEntry` request bodies into a canonical `LoadEntry`,
 * gracefully supporting both `shared/load-entry.ts` and `PANEL_REDESIGN_SPEC.md` input shapes.
 */
export function normalizeIncomingLoadEntry(rawBody: unknown): LoadEntry | null {
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) return null;
  const wrapper = rawBody as Record<string, unknown>;
  const raw =
    wrapper.entry && typeof wrapper.entry === "object" && !Array.isArray(wrapper.entry)
      ? (wrapper.entry as Record<string, unknown>)
      : wrapper;

  if (!Array.isArray(raw.stops) && !Array.isArray(raw.items) && !raw.customer) {
    return null;
  }

  const rawCustomer = (raw.customer && typeof raw.customer === "object" ? raw.customer : {}) as Record<string, unknown>;
  const rawRefs = (raw.references && typeof raw.references === "object" ? raw.references : {}) as Record<string, unknown>;
  const rawEquip = (raw.equipment && typeof raw.equipment === "object" ? raw.equipment : {}) as Record<string, unknown>;
  const rawCarrier = (raw.carrier && typeof raw.carrier === "object" ? raw.carrier : {}) as Record<string, unknown>;
  const rawPricing = (raw.pricing && typeof raw.pricing === "object" ? raw.pricing : {}) as Record<string, unknown>;

  const stops: LoadEntryStop[] = Array.isArray(raw.stops)
    ? raw.stops.map((stRaw, idx, arr) => {
        const st = (stRaw && typeof stRaw === "object" ? stRaw : {}) as Record<string, unknown>;
        const readyDt = String(st.readyDate || st.readyDateTime || st.appointmentDateTime || "").trim();
        const closeDt = String(st.closeDateTime || st.appointmentEndDateTime || "").trim();
        const readyDate = readyDt.slice(0, 10);
        const parsedOpen = readyDt.includes("T") ? readyDt.split("T")[1]?.slice(0, 5) : "";
        const parsedClose = closeDt.includes("T") ? closeDt.split("T")[1]?.slice(0, 5) : "";
        const isPick = idx === 0 || String(st.stopType || "").toLowerCase().includes("pick");
        return {
          stopType:
            idx === 0
              ? "First Pickup"
              : idx === arr.length - 1
              ? "Last Drop"
              : st.stopType === "Drop"
              ? "Drop"
              : "Pick",
          companyName: String(st.companyName || ""),
          streetAddress: String(st.streetAddress || ""),
          ...(st.streetAddressTwo ? { streetAddressTwo: String(st.streetAddressTwo) } : {}),
          city: String(st.city || ""),
          state: String(st.state || ""),
          zipCode: String(st.zipCode || ""),
          country: String(st.country || "USA"),
          contactName: String(st.contactName || ""),
          phone: String(st.phone || ""),
          ...(st.email ? { email: String(st.email) } : {}),
          instructions: String(st.instructions || ""),
          ...(st.referenceNumber ? { referenceNumber: String(st.referenceNumber) } : {}),
          readyDate,
          timeOpen: String(st.timeOpen || parsedOpen || (isPick ? "08:00" : "09:00")),
          timeClose: String(st.timeClose || parsedClose || (isPick ? "15:00" : "16:00")),
          appointmentRequired:
            typeof st.appointmentRequired === "boolean"
              ? st.appointmentRequired
              : Boolean(st.appointmentDateTime),
          ...(typeof st.savedFacilityMatched === "boolean" ? { savedFacilityMatched: st.savedFacilityMatched } : {}),
        };
      })
    : [];

  const items: LoadEntryItem[] = Array.isArray(raw.items)
    ? raw.items.map((itRaw) => {
        const it = (itRaw && typeof itRaw === "object" ? itRaw : {}) as Record<string, unknown>;
        return {
          description: String(it.description || ""),
          packagingType: String(it.packagingType || "Pallet"),
          handlingQuantity: Number(it.handlingQuantity) || 0,
          piecesTotal: Number(it.piecesTotal) || 0,
          weightTotal: Number(it.weightTotal) || 0,
          hazardousMaterial: Boolean(it.hazardousMaterial),
          freightClass: String(it.freightClass || "No Class"),
          ...(Number(it.length) > 0 ? { length: Number(it.length) } : {}),
          ...(Number(it.width) > 0 ? { width: Number(it.width) } : {}),
          ...(Number(it.height) > 0 ? { height: Number(it.height) } : {}),
          referenceNumber: String(it.referenceNumber || ""),
        };
      })
    : [];

  const accessorials: LoadEntryAccessorial[] = Array.isArray(raw.accessorials)
    ? raw.accessorials.map((acRaw) => {
        const ac = (acRaw && typeof acRaw === "object" ? acRaw : {}) as Record<string, unknown>;
        const scope = ac.scope === "pickup" || ac.scope === "delivery" ? ac.scope : "shipment";
        return {
          scope,
          code: String(ac.code || "CUSTOM"),
          name: String(ac.name || "Accessorial"),
          sell: Number(ac.sell) || 0,
          buy: Number(ac.buy) || 0,
        };
      })
    : [];

  const linehaulSell =
    rawPricing.linehaulSell !== undefined
      ? Number(rawPricing.linehaulSell) || 0
      : Number(rawCarrier.sell) || 0;
  const fuelSell =
    rawPricing.fuelSell !== undefined
      ? Number(rawPricing.fuelSell) || 0
      : Number(rawCarrier.fuelSell) || 0;
  const linehaulBuy =
    rawPricing.linehaulBuy !== undefined
      ? Number(rawPricing.linehaulBuy) || 0
      : Number(rawCarrier.buy) || 0;
  const fuelBuy =
    rawPricing.fuelBuy !== undefined
      ? Number(rawPricing.fuelBuy) || 0
      : Number(rawCarrier.fuelBuy) || 0;

  const carrierWithOptionalMaster: LoadEntry["carrier"] & { taiCarrierMasterId?: string } = {
    name: String(rawCarrier.name || ""),
    ...(rawCarrier.scac ? { scac: String(rawCarrier.scac) } : {}),
    ...(rawCarrier.mcNumber ? { mcNumber: String(rawCarrier.mcNumber) } : {}),
    serviceLevel: String(rawCarrier.serviceLevel || "Normal"),
  };
  const masterIdFromCarrier = rawCarrier.taiCarrierMasterId ?? rawCarrier.carrierMasterId;
  if (masterIdFromCarrier != null && String(masterIdFromCarrier).trim() !== "") {
    carrierWithOptionalMaster.taiCarrierMasterId = String(masterIdFromCarrier).trim();
  }

  return {
    shipmentType:
      raw.shipmentType === "LTL" || raw.shipmentType === "Intermodal" || raw.shipmentType === "Drayage"
        ? raw.shipmentType
        : "Truckload",
    status: raw.status === "Quote" ? "Quote" : "Committed",
    customer: {
      name: String(rawCustomer.name || ""),
      taiOrganizationId:
        rawCustomer.taiOrganizationId != null ? String(rawCustomer.taiOrganizationId).trim() : "",
      ...(rawCustomer.contactName ? { contactName: String(rawCustomer.contactName) } : {}),
      ...(rawCustomer.email ? { email: String(rawCustomer.email) } : {}),
    },
    references: {
      customerPO: String(rawRefs.customerPO || ""),
      bolNumber: String(rawRefs.bolNumber || rawRefs.shipperReference || ""),
      invoiceRef: String(rawRefs.invoiceRef || ""),
      carrierProNumber: String(rawRefs.carrierProNumber || ""),
      pickupNumber: String(rawRefs.pickupNumber || ""),
      ...(rawRefs.driverName ? { driverName: String(rawRefs.driverName) } : {}),
      ...(rawRefs.driverPhone ? { driverPhone: String(rawRefs.driverPhone) } : {}),
    },
    stops,
    items,
    accessorials,
    equipment: {
      trailerSize: rawEquip.trailerSize === "Partial" ? "Partial" : "Full",
      trailerType: String(rawEquip.trailerType || ""),
      equipmentLength: String(rawEquip.equipmentLength || "53"),
      mileage: Number(rawEquip.mileage) || 0,
      ...(Number(rawEquip.linearFeet) > 0 ? { linearFeet: Number(rawEquip.linearFeet) } : {}),
      stackable: Boolean(rawEquip.stackable),
    },
    pricing: {
      linehaulSell,
      fuelSell,
      linehaulBuy,
      fuelBuy,
    },
    carrier: carrierWithOptionalMaster,
    specialInstructions: String(raw.specialInstructions || ""),
    sendToTai: raw.sendToTai !== false,
  };
}

export interface BookingContext {
  customerId: number | null;
  carrierMasterId: number | null;
  carrierScac?: string;
}

export interface ResolveContextOptions {
  customers?: CustomerOption[];
  carriers?: CarrierOption[];
  supabaseClient?: ReturnType<typeof store.getSupabase> | null;
  liveAllowed?: boolean;
}

export function resolveBookingContextSync(
  entry: LoadEntry,
  options: Pick<ResolveContextOptions, "customers" | "carriers"> = {},
): BookingContext {
  const customers = options.customers ?? store.customers;
  const carriers = options.carriers ?? store.carriers;

  let customerId = parsePositiveInt(entry.customer?.taiOrganizationId);
  if (customerId === null) {
    const custKey = normalizeNameKey(entry.customer?.name);
    if (custKey) {
      const matchedCustomer = customers.find((c) => normalizeNameKey(c.name) === custKey);
      if (matchedCustomer) {
        customerId = parsePositiveInt(matchedCustomer.taiOrgId);
      }
    }
  }

  const rawCarrier = entry.carrier as LoadEntry["carrier"] & {
    taiCarrierMasterId?: unknown;
    carrierMasterId?: unknown;
  };
  let carrierMasterId = parsePositiveInt(rawCarrier?.taiCarrierMasterId ?? rawCarrier?.carrierMasterId);
  let carrierScac = entry.carrier?.scac ? String(entry.carrier.scac).trim() : undefined;

  const carrierNameKey = normalizeNameKey(entry.carrier?.name);
  const carrierMc = String(entry.carrier?.mcNumber || "").trim();
  if (carrierMasterId === null && (carrierNameKey || carrierMc || carrierScac)) {
    const matchedCarrier = carriers.find((c) => {
      if (carrierNameKey && normalizeNameKey(c.name) === carrierNameKey) return true;
      if (carrierMc && c.mc && String(c.mc).trim() === carrierMc) return true;
      if (carrierScac && c.scac && String(c.scac).trim().toUpperCase() === carrierScac.toUpperCase()) return true;
      return false;
    });
    if (matchedCarrier) {
      carrierMasterId = parsePositiveInt(matchedCarrier.taiMasterId);
      if (!carrierScac && matchedCarrier.scac) {
        carrierScac = matchedCarrier.scac;
      }
    }
  }

  return { customerId, carrierMasterId, ...(carrierScac ? { carrierScac } : {}) };
}

export async function resolveBookingContext(
  entry: LoadEntry,
  options: ResolveContextOptions = {},
): Promise<BookingContext> {
  const resolved = resolveBookingContextSync(entry, options);
  const sb = options.supabaseClient !== undefined ? options.supabaseClient : !store.isSafeSandbox ? store.getSupabase() : null;
  if (!sb) return resolved;

  let { customerId, carrierMasterId } = resolved;
  const custName = String(entry.customer?.name || "").trim();
  if (customerId === null && custName) {
    try {
      const { data } = await sb
        .from("customers")
        .select("tai_organization_id")
        .ilike("name", custName)
        .limit(1)
        .maybeSingle();
      customerId = parsePositiveInt((data as { tai_organization_id?: unknown } | null)?.tai_organization_id);
    } catch {
      // ignore Supabase lookup errors
    }
  }

  const carrName = String(entry.carrier?.name || "").trim();
  if (carrierMasterId === null && carrName) {
    try {
      const { data } = await sb
        .from("carriers")
        .select("tai_carrier_master_id")
        .ilike("name", carrName)
        .limit(1)
        .maybeSingle();
      carrierMasterId = parsePositiveInt((data as { tai_carrier_master_id?: unknown } | null)?.tai_carrier_master_id);
    } catch {
      // ignore Supabase lookup errors
    }
  }

  return { ...resolved, customerId, carrierMasterId };
}

function hydrateEntryWithContext(entry: LoadEntry, context: BookingContext): LoadEntry {
  return {
    ...entry,
    customer: {
      ...entry.customer,
      taiOrganizationId:
        context.customerId !== null ? String(context.customerId) : entry.customer.taiOrganizationId || "",
    },
    carrier: {
      ...entry.carrier,
      ...(context.carrierScac && !entry.carrier.scac ? { scac: context.carrierScac } : {}),
    },
  };
}

/**
 * Computes a deterministic 64-character SHA-256 hex `previewToken` binding the exact TAI
 * `CommitDomesticShipmentRequest`, customer/carrier IDs, and sell/buy pricing totals.
 */
export function computeLoadPreviewToken(
  entry: LoadEntry,
  context: Pick<BookingContext, "customerId" | "carrierMasterId">,
): string {
  const hydrated = hydrateEntryWithContext(entry, context);
  const request = buildTaiShipmentRequest(hydrated);
  const totals = loadEntryTotals(hydrated);
  const canonical = {
    request,
    customerName: normalizeNameKey(hydrated.customer.name),
    carrierName: normalizeNameKey(hydrated.carrier.name),
    customerId: context.customerId ?? null,
    carrierMasterId: context.carrierMasterId ?? null,
    totals: {
      totalSell: totals.totalSell,
      totalBuy: totals.totalBuy,
      linehaulSell: totals.linehaulSell,
      fuelSell: totals.fuelSell,
      linehaulBuy: totals.linehaulBuy,
      fuelBuy: totals.fuelBuy,
    },
  };
  return crypto.createHash("sha256").update(stableStringify(canonical)).digest("hex");
}

export interface TaiBookingStatusOptions {
  env?: NodeJS.ProcessEnv;
  credential?: string;
  liveAllowed?: boolean;
}

export function getTaiBookingStatus(options: TaiBookingStatusOptions = {}) {
  const env = options.env ?? process.env;
  const cred = options.credential !== undefined ? taiApiKey(options.credential) : taiApiKey(env);
  const configured = Boolean(cred);
  const sandbox = options.liveAllowed !== undefined ? !options.liveAllowed : env.ALLOW_LIVE_TAI_WRITES !== "true";
  const enabled = Boolean(!sandbox && configured && !isTaiAuthHalted(cred));
  return {
    ok: true as const,
    configured,
    enabled,
    gatewayConfigured: isPfdGatewayConfigured(env),
    baseUrl: resolveTaiBaseUrl(undefined, env),
  };
}

export interface PreviewTaiBookingOptions extends ResolveContextOptions {
  baseUrl?: string;
}

export function previewTaiBooking(entry: LoadEntry, options: PreviewTaiBookingOptions = {}) {
  const context = resolveBookingContextSync(entry, options);
  const hydrated = hydrateEntryWithContext(entry, context);
  const issues = validateTaiLoadEntry(hydrated);
  const request = buildTaiShipmentRequest(hydrated);
  const previewToken = computeLoadPreviewToken(entry, context);
  const baseUrl = resolveTaiBaseUrl(options.baseUrl);
  return {
    ok: issues.length === 0,
    url: `${baseUrl}${TAI_SHIPMENTS_PATH}`,
    issues,
    request,
    body: request,
    previewToken,
    context: {
      customerId: context.customerId,
      carrierMasterId: context.carrierMasterId,
    },
  };
}

export async function previewTaiBookingAsync(entry: LoadEntry, options: PreviewTaiBookingOptions = {}) {
  const context = await resolveBookingContext(entry, options);
  const hydrated = hydrateEntryWithContext(entry, context);
  const issues = validateTaiLoadEntry(hydrated);
  const request = buildTaiShipmentRequest(hydrated);
  const previewToken = computeLoadPreviewToken(entry, context);
  const baseUrl = resolveTaiBaseUrl(options.baseUrl);
  return {
    ok: issues.length === 0,
    url: `${baseUrl}${TAI_SHIPMENTS_PATH}`,
    issues,
    request,
    body: request,
    previewToken,
    context: {
      customerId: context.customerId,
      carrierMasterId: context.carrierMasterId,
    },
  };
}

export interface DuplicateMatch {
  duplicateOf: string;
  matchedOn: "customerPO" | "originZip+destZip+readyDate";
  message: string;
}

function extractFiveDigitZip(raw: string | undefined): string {
  const m = String(raw || "").trim().match(/\b(\d{5})\b/);
  return m ? m[1] : "";
}

/**
 * Checks existing `shipments` for accidental duplicate bookings:
 * 1) Same customer + matching non-empty `customerPO`, OR
 * 2) Same customer + matching 5-digit origin ZIP + 5-digit destination ZIP + pickup `readyDate`.
 */
export function findDuplicateShipment(
  entry: LoadEntry,
  customerId: number | null,
  shipments: OpsShipment[] = store.shipments,
): DuplicateMatch | null {
  const entryCustName = normalizeNameKey(entry.customer?.name);
  const entryOrgStr = customerId !== null ? String(customerId) : String(entry.customer?.taiOrganizationId || "").trim();
  const entryPo = String(entry.references?.customerPO || "").trim();
  const originZip = extractFiveDigitZip(entry.stops?.[0]?.zipCode);
  const destZip = extractFiveDigitZip(entry.stops?.[entry.stops.length - 1]?.zipCode);
  const pickupDate = String(entry.stops?.[0]?.readyDate || "").trim().slice(0, 10);

  if (!entryCustName && !entryOrgStr) return null;

  for (const s of shipments) {
    const shipCustName = normalizeNameKey(s.customer);
    const shipOrgStr = String(s.taiOrgId || "").trim();
    const sameCustomerByOrg = Boolean(entryOrgStr && shipOrgStr && entryOrgStr === shipOrgStr);
    const sameCustomerByName = Boolean(entryCustName && shipCustName && entryCustName === shipCustName);
    if (!sameCustomerByOrg && !sameCustomerByName) continue;

    const shipPo = String(s.po || "").trim();
    if (entryPo.length > 0 && shipPo.length > 0 && entryPo.toLowerCase() === shipPo.toLowerCase()) {
      return {
        duplicateOf: s.id,
        matchedOn: "customerPO",
        message: `Duplicate booking guard: Load #${s.id} already exists for ${s.customer} with Customer PO "${entryPo}". Confirm duplicate to book anyway.`,
      };
    }

    const shipOriginZip =
      extractFiveDigitZip(s.stops?.[0]?.zipCode) || extractFiveDigitZip(s.origin);
    const shipDestZip =
      extractFiveDigitZip(s.stops?.[s.stops.length - 1]?.zipCode) || extractFiveDigitZip(s.dest);
    const shipPickupDate = String(s.stops?.[0]?.readyDate || "").trim().slice(0, 10);

    if (
      originZip &&
      destZip &&
      pickupDate &&
      shipOriginZip === originZip &&
      shipDestZip === destZip &&
      shipPickupDate === pickupDate
    ) {
      return {
        duplicateOf: s.id,
        matchedOn: "originZip+destZip+readyDate",
        message: `Duplicate booking guard: Load #${s.id} already exists for ${s.customer} on lane ${originZip} → ${destZip} (${pickupDate}). Confirm duplicate to book anyway.`,
      };
    }
  }

  return null;
}

export interface TaiChargePushResult {
  attempted: boolean;
  ok: boolean;
  status?: number | null;
  price: number;
  carrierMasterId?: number | null;
  needsHumanReconciliation?: boolean;
  haltedOnAuth?: boolean;
  skippedReason?: string;
  message?: string;
}

export interface BookTaiLoadsOptions extends ResolveContextOptions {
  duplicateCount?: number;
  previewToken?: string;
  confirmDuplicate?: boolean;
  actor?: string;
  credential?: string;
  baseUrl?: string;
  billingWriteEnabled?: boolean;
  writebackEnabled?: boolean;
  fetchImpl?: typeof fetch;
  shipments?: OpsShipment[];
  liveInsertAudit?: boolean;
}

export interface BookTaiLoadsResult {
  ok: boolean;
  status: number;
  shipmentId?: string;
  createdIds: string[];
  shipment?: OpsShipment;
  shipments?: OpsShipment[];
  tai?: {
    shipmentId: string;
    rates: {
      sell: TaiChargePushResult;
      buy: TaiChargePushResult;
    };
  };
  issues: TaiValidationIssue[];
  request: Record<string, unknown>;
  requiresPreviewRefresh?: boolean;
  duplicateOf?: string;
  matchedOn?: string;
  requiresDuplicateConfirmation?: boolean;
  needsHumanReconciliation?: boolean;
  haltedOnAuth?: boolean;
  message: string;
}

export async function bookTaiLoads(
  entry: LoadEntry,
  duplicateCountOrOptions: number | BookTaiLoadsOptions = 1,
): Promise<BookTaiLoadsResult> {
  const opts: BookTaiLoadsOptions =
    typeof duplicateCountOrOptions === "number"
      ? { duplicateCount: duplicateCountOrOptions }
      : duplicateCountOrOptions;

  const context = await resolveBookingContext(entry, opts);
  const hydratedEntry = hydrateEntryWithContext(entry, context);
  const expectedToken = computeLoadPreviewToken(entry, context);
  const requestTemplate = buildTaiShipmentRequest(hydratedEntry);

  if (typeof opts.previewToken === "string" && opts.previewToken.trim().length > 0) {
    if (opts.previewToken.trim() !== expectedToken) {
      return {
        ok: false,
        status: 409,
        requiresPreviewRefresh: true,
        issues: [],
        request: requestTemplate,
        createdIds: [],
        message: "Draft changed since preview — please re-preview before booking.",
      };
    }
  }

  const issues = validateTaiLoadEntry(hydratedEntry);
  if (issues.length > 0) {
    return {
      ok: false,
      status: 422,
      issues,
      request: requestTemplate,
      createdIds: [],
      message: issues[0].message,
    };
  }

  const targetShipments = opts.shipments ?? store.shipments;
  if (opts.confirmDuplicate !== true) {
    const duplicate = findDuplicateShipment(hydratedEntry, context.customerId, targetShipments);
    if (duplicate) {
      return {
        ok: false,
        status: 409,
        duplicateOf: duplicate.duplicateOf,
        matchedOn: duplicate.matchedOn,
        requiresDuplicateConfirmation: true,
        issues: [],
        request: requestTemplate,
        createdIds: [],
        message: duplicate.message,
      };
    }
  }

  const count = Math.max(1, Math.min(10, Math.floor(Number(opts.duplicateCount) || 1)));
  const totals = loadEntryTotals(hydratedEntry);
  const firstStop = hydratedEntry.stops[0];
  const lastStop = hydratedEntry.stops[hydratedEntry.stops.length - 1];
  const createdIds: string[] = [];
  const createdShipments: OpsShipment[] = [];

  const cred = opts.credential !== undefined ? taiApiKey(opts.credential) : taiApiKey();
  const liveAllowed =
    opts.liveAllowed !== undefined
      ? Boolean(opts.liveAllowed && cred)
      : Boolean(!store.isSafeSandbox && cred);
  const taiBase = resolveTaiBaseUrl(opts.baseUrl);
  const doFetch = opts.fetchImpl ?? fetch;
  const billingWriteEnabled =
    opts.billingWriteEnabled !== undefined
      ? opts.billingWriteEnabled
      : process.env.BILLING_TAI_WRITE_ENABLED !== "false";
  const writebackEnabled =
    opts.writebackEnabled !== undefined
      ? opts.writebackEnabled
      : process.env.TAI_WRITEBACK_ENABLED !== "false";
  const sb = opts.supabaseClient !== undefined ? opts.supabaseClient : store.getSupabase();
  const auditSb = sb as unknown as SupabaseInsertLike | null;
  const liveInsertAudit =
    opts.liveInsertAudit !== undefined ? opts.liveInsertAudit : Boolean(liveAllowed && auditSb);

  let lastSellResult: TaiChargePushResult = {
    attempted: false,
    ok: false,
    price: totals.totalSell,
    skippedReason: liveAllowed ? "not_applicable" : "sandbox_mode",
  };
  let lastBuyResult: TaiChargePushResult = {
    attempted: false,
    ok: false,
    price: totals.totalBuy,
    carrierMasterId: context.carrierMasterId,
    skippedReason: liveAllowed ? "not_applicable" : "sandbox_mode",
  };

  for (let i = 0; i < count; i++) {
    const poVal =
      count > 1 && hydratedEntry.references.customerPO
        ? `${hydratedEntry.references.customerPO}-${i + 1}`
        : hydratedEntry.references.customerPO;

    const perLoadEntry: LoadEntry = {
      ...hydratedEntry,
      references: { ...hydratedEntry.references, customerPO: poVal },
    };
    const body = buildTaiShipmentRequest(perLoadEntry);
    let assignedId = "";

    if (liveAllowed) {
      if (isTaiAuthHalted(cred)) {
        return {
          ok: false,
          status: 502,
          haltedOnAuth: true,
          needsHumanReconciliation: true,
          issues: [
            {
              field: "tai",
              message: "TAI pushes are halted following an HTTP 401/403 authentication failure to prevent account lockout.",
            },
          ],
          request: body,
          createdIds,
          message: "TAI pushes halted after HTTP 401/403 authentication error — check server TAI credential.",
        };
      }

      const reqHeaders = {
        "x-api-key": cred,
        Accept: "application/json",
        "Content-Type": "application/json",
      };

      let resp: Response;
      try {
        resp = await doFetch(`${taiBase}${TAI_SHIPMENTS_PATH}`, {
          method: "POST",
          headers: reqHeaders,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        const errMsg = `TAI POST /Shipments failed without response (never auto-retried): ${err instanceof Error ? err.message : String(err)}`;
        await recordTaiPush({
          shipmentId: null,
          kind: "create_shipment",
          method: "POST",
          endpoint: TAI_SHIPMENTS_PATH,
          requestHeaders: reqHeaders,
          requestPayload: body,
          responseStatus: null,
          responseBody: null,
          ok: false,
          needsHuman: true,
          errorMessage: errMsg,
          actor: opts.actor ?? null,
          supabaseClient: auditSb,
          liveInsert: liveInsertAudit,
          redactValues: [cred],
        });
        return {
          ok: false,
          status: 502,
          needsHumanReconciliation: true,
          issues: [{ field: "tai", message: errMsg }],
          request: body,
          createdIds,
          message: "TAI shipment creation timed out or lost connection — stopped without retry for human reconciliation.",
        };
      }

      const text = await resp.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }

      if (isTaiAuthFailureStatus(resp.status)) {
        const authMsg = `TAI HTTP ${resp.status} on POST /Shipments — halted immediately to prevent TAI account lockout.`;
        haltTaiOnAuthFailure(cred, authMsg);
        await recordTaiPush({
          shipmentId: null,
          kind: "create_shipment",
          method: "POST",
          endpoint: TAI_SHIPMENTS_PATH,
          requestHeaders: reqHeaders,
          requestPayload: body,
          responseStatus: resp.status,
          responseBody: parsed ?? text,
          ok: false,
          needsHuman: true,
          errorMessage: authMsg,
          actor: opts.actor ?? null,
          supabaseClient: auditSb,
          liveInsert: liveInsertAudit,
          redactValues: [cred],
        });
        return {
          ok: false,
          status: 502,
          haltedOnAuth: true,
          needsHumanReconciliation: true,
          issues: [{ field: "tai", message: authMsg }],
          request: body,
          createdIds,
          message: authMsg,
        };
      }

      if (!resp.ok) {
        const ambiguousServerError = resp.status >= 500 || resp.status === 408 || resp.status === 429;
        const cleanBodySnippet = text.slice(0, 240);
        const failMsg = `TAI refused the load (${resp.status})${cleanBodySnippet ? `: ${cleanBodySnippet}` : ""}`;
        await recordTaiPush({
          shipmentId: null,
          kind: "create_shipment",
          method: "POST",
          endpoint: TAI_SHIPMENTS_PATH,
          requestHeaders: reqHeaders,
          requestPayload: body,
          responseStatus: resp.status,
          responseBody: parsed ?? text,
          ok: false,
          needsHuman: ambiguousServerError,
          errorMessage: failMsg,
          actor: opts.actor ?? null,
          supabaseClient: auditSb,
          liveInsert: liveInsertAudit,
          redactValues: [cred],
        });
        return {
          ok: false,
          status: ambiguousServerError ? 502 : 422,
          ...(ambiguousServerError ? { needsHumanReconciliation: true } : {}),
          issues: [{ field: "tai", message: failMsg }],
          request: body,
          createdIds,
          message: failMsg,
        };
      }

      assignedId = extractTaiShipmentId(parsed, text);
      if (!assignedId) {
        // NEVER invent a fake 1327425xx ID in live mode and NEVER blind-retry!
        const ambigMsg =
          "TAI returned HTTP 200 on POST /Shipments without a parseable shipmentId — stopped without retry for human reconciliation.";
        await recordTaiPush({
          shipmentId: null,
          kind: "create_shipment",
          method: "POST",
          endpoint: TAI_SHIPMENTS_PATH,
          requestHeaders: reqHeaders,
          requestPayload: body,
          responseStatus: resp.status,
          responseBody: parsed ?? text,
          ok: false,
          needsHuman: true,
          errorMessage: ambigMsg,
          actor: opts.actor ?? null,
          supabaseClient: auditSb,
          liveInsert: liveInsertAudit,
          redactValues: [cred],
        });
        return {
          ok: false,
          status: 502,
          needsHumanReconciliation: true,
          issues: [{ field: "tai", message: ambigMsg }],
          request: body,
          createdIds,
          message: ambigMsg,
        };
      }

      void recordTaiPush({
        shipmentId: assignedId,
        kind: "create_shipment",
        method: "POST",
        endpoint: TAI_SHIPMENTS_PATH,
        requestHeaders: reqHeaders,
        requestPayload: body,
        responseStatus: resp.status,
        responseBody: parsed ?? text,
        ok: true,
        needsHuman: false,
        actor: opts.actor ?? null,
        supabaseClient: auditSb,
        liveInsert: liveInsertAudit,
        redactValues: [cred],
      });

      // Step 2: Push Customer Sell Rate (PUT /PublicApi/Shipping/v2/ShipmentCharges)
      if (totals.totalSell > 0 && billingWriteEnabled && isNumericTaiShipmentId(assignedId) && !isTaiAuthHalted(cred)) {
        const sellPayload = {
          referenceNumbers: [{ referenceType: "Shipment Id", value: String(assignedId) }],
          transitType: "Linehaul",
          charges: [{ chargeType: "Linehaul", price: totals.totalSell, calculationType: "Flat" }],
        };
        try {
          const sellResp = await doFetch(`${taiBase}${TAI_SHIPMENT_CHARGES_PATH}`, {
            method: "PUT",
            headers: reqHeaders,
            body: JSON.stringify(sellPayload),
            signal: AbortSignal.timeout(25_000),
          });
          const sellText = await sellResp.text();
          let sellParsed: unknown = sellText;
          try {
            sellParsed = sellText ? JSON.parse(sellText) : null;
          } catch {
            // plain text
          }
          if (isTaiAuthFailureStatus(sellResp.status)) {
            const haltMsg = `TAI HTTP ${sellResp.status} on PUT /ShipmentCharges — halted immediately.`;
            haltTaiOnAuthFailure(cred, haltMsg);
            lastSellResult = {
              attempted: true,
              ok: false,
              status: sellResp.status,
              price: totals.totalSell,
              needsHumanReconciliation: true,
              haltedOnAuth: true,
              message: haltMsg,
            };
          } else {
            lastSellResult = {
              attempted: true,
              ok: sellResp.ok,
              status: sellResp.status,
              price: totals.totalSell,
              ...(!sellResp.ok ? { needsHumanReconciliation: true } : {}),
              message: sellResp.ok
                ? `Customer sell ($${totals.totalSell.toLocaleString()}) pushed to TAI.`
                : `PUT /ShipmentCharges returned HTTP ${sellResp.status} (needs reconciliation).`,
            };
          }
          void recordTaiPush({
            shipmentId: assignedId,
            kind: "sell_charges",
            method: "PUT",
            endpoint: TAI_SHIPMENT_CHARGES_PATH,
            requestHeaders: reqHeaders,
            requestPayload: sellPayload,
            responseStatus: sellResp.status,
            responseBody: sellParsed,
            ok: sellResp.ok,
            needsHuman: !sellResp.ok,
            errorMessage: sellResp.ok ? null : lastSellResult.message ?? null,
            actor: opts.actor ?? null,
            supabaseClient: auditSb,
            liveInsert: liveInsertAudit,
            redactValues: [cred],
          });
        } catch (err) {
          const errMsg = `PUT /ShipmentCharges failed without response (not retried): ${err instanceof Error ? err.message : String(err)}`;
          lastSellResult = {
            attempted: true,
            ok: false,
            status: null,
            price: totals.totalSell,
            needsHumanReconciliation: true,
            message: errMsg,
          };
          void recordTaiPush({
            shipmentId: assignedId,
            kind: "sell_charges",
            method: "PUT",
            endpoint: TAI_SHIPMENT_CHARGES_PATH,
            requestHeaders: reqHeaders,
            requestPayload: sellPayload,
            responseStatus: null,
            responseBody: null,
            ok: false,
            needsHuman: true,
            errorMessage: errMsg,
            actor: opts.actor ?? null,
            supabaseClient: auditSb,
            liveInsert: liveInsertAudit,
            redactValues: [cred],
          });
        }
      } else {
        lastSellResult = {
          attempted: false,
          ok: false,
          price: totals.totalSell,
          skippedReason: !billingWriteEnabled
            ? "billing_write_disabled"
            : totals.totalSell <= 0
            ? "zero_sell_rate"
            : "auth_halted",
        };
      }

      // Step 3: Push Carrier Assignment & Buy Rate (PUT /PublicApi/Shipping/v2/CarrierCharges)
      if (
        totals.totalBuy > 0 &&
        context.carrierMasterId &&
        writebackEnabled &&
        isNumericTaiShipmentId(assignedId) &&
        !isTaiAuthHalted(cred)
      ) {
        const buyPayload = {
          referenceNumbers: [{ referenceType: "Shipment Id", value: String(assignedId) }],
          transitType: "Linehaul",
          charges: [{ chargeType: "Linehaul", price: totals.totalBuy, calculationType: "Flat" }],
          carrierMasterId: Number(context.carrierMasterId),
        };
        try {
          const buyResp = await doFetch(`${taiBase}${TAI_CARRIER_CHARGES_PATH}`, {
            method: "PUT",
            headers: reqHeaders,
            body: JSON.stringify(buyPayload),
            signal: AbortSignal.timeout(25_000),
          });
          const buyText = await buyResp.text();
          let buyParsed: unknown = buyText;
          try {
            buyParsed = buyText ? JSON.parse(buyText) : null;
          } catch {
            // plain text
          }
          if (isTaiAuthFailureStatus(buyResp.status)) {
            const haltMsg = `TAI HTTP ${buyResp.status} on PUT /CarrierCharges — halted immediately.`;
            haltTaiOnAuthFailure(cred, haltMsg);
            lastBuyResult = {
              attempted: true,
              ok: false,
              status: buyResp.status,
              price: totals.totalBuy,
              carrierMasterId: Number(context.carrierMasterId),
              needsHumanReconciliation: true,
              haltedOnAuth: true,
              message: haltMsg,
            };
          } else {
            lastBuyResult = {
              attempted: true,
              ok: buyResp.ok,
              status: buyResp.status,
              price: totals.totalBuy,
              carrierMasterId: Number(context.carrierMasterId),
              ...(!buyResp.ok ? { needsHumanReconciliation: true } : {}),
              message: buyResp.ok
                ? `Carrier buy ($${totals.totalBuy.toLocaleString()}) pushed to TAI (Master #${context.carrierMasterId}).`
                : `PUT /CarrierCharges returned HTTP ${buyResp.status} (needs reconciliation).`,
            };
          }
          void recordTaiPush({
            shipmentId: assignedId,
            kind: "carrier_charges",
            method: "PUT",
            endpoint: TAI_CARRIER_CHARGES_PATH,
            requestHeaders: reqHeaders,
            requestPayload: buyPayload,
            responseStatus: buyResp.status,
            responseBody: buyParsed,
            ok: buyResp.ok,
            needsHuman: !buyResp.ok,
            errorMessage: buyResp.ok ? null : lastBuyResult.message ?? null,
            actor: opts.actor ?? null,
            supabaseClient: auditSb,
            liveInsert: liveInsertAudit,
            redactValues: [cred],
          });
        } catch (err) {
          const errMsg = `PUT /CarrierCharges failed without response (not retried): ${err instanceof Error ? err.message : String(err)}`;
          lastBuyResult = {
            attempted: true,
            ok: false,
            status: null,
            price: totals.totalBuy,
            carrierMasterId: Number(context.carrierMasterId),
            needsHumanReconciliation: true,
            message: errMsg,
          };
          void recordTaiPush({
            shipmentId: assignedId,
            kind: "carrier_charges",
            method: "PUT",
            endpoint: TAI_CARRIER_CHARGES_PATH,
            requestHeaders: reqHeaders,
            requestPayload: buyPayload,
            responseStatus: null,
            responseBody: null,
            ok: false,
            needsHuman: true,
            errorMessage: errMsg,
            actor: opts.actor ?? null,
            supabaseClient: auditSb,
            liveInsert: liveInsertAudit,
            redactValues: [cred],
          });
        }
      } else {
        lastBuyResult = {
          attempted: false,
          ok: false,
          price: totals.totalBuy,
          carrierMasterId: context.carrierMasterId,
          skippedReason: !writebackEnabled
            ? "writeback_disabled"
            : !context.carrierMasterId
            ? "missing_carrier_master_id"
            : totals.totalBuy <= 0
            ? "zero_buy_rate"
            : "auth_halted",
        };
      }
    } else {
      // Clearly-labeled Sandbox ID when !liveAllowed
      assignedId = `SBX-${132742500 + Math.floor(Math.random() * 700) + i}`;
    }

    createdIds.push(assignedId);

    const sellSummary = lastSellResult.attempted
      ? lastSellResult.ok
        ? ` · Sell $${totals.totalSell.toLocaleString()} ✓`
        : " · Sell needs review"
      : "";
    const buySummary = lastBuyResult.attempted
      ? lastBuyResult.ok
        ? ` · Buy $${totals.totalBuy.toLocaleString()} ✓`
        : " · Buy needs review"
      : "";

    const newShipment: OpsShipment = {
      id: assignedId,
      customer: hydratedEntry.customer.name.trim() || "UNLINKED SPOT CUSTOMER",
      taiOrgId: hydratedEntry.customer.taiOrganizationId || undefined,
      origin: `${firstStop.city}, ${firstStop.state} ${firstStop.zipCode}`,
      dest: `${lastStop.city}, ${lastStop.state} ${lastStop.zipCode}`,
      stops: structuredClone(hydratedEntry.stops),
      commodities: structuredClone(hydratedEntry.items),
      accessorials: hydratedEntry.accessorials.map(
        (a) => `${a.name} - ${a.scope[0].toUpperCase()}${a.scope.slice(1)}`,
      ),
      stage: hydratedEntry.carrier.name ? "Assigned" : "Needs truck",
      rawStatus: hydratedEntry.status,
      carrier: hydratedEntry.carrier.name || "",
      mc: hydratedEntry.carrier.mcNumber || "",
      po: poVal,
      bol: hydratedEntry.references.bolNumber,
      pro: hydratedEntry.references.carrierProNumber,
      shipDate: extractDateShort(firstStop.readyDate),
      delivDate: extractDateShort(lastStop.readyDate),
      equip: hydratedEntry.equipment.trailerType,
      trailerSize: hydratedEntry.equipment.trailerSize,
      mileage: hydratedEntry.equipment.mileage,
      sell: totals.totalSell,
      buy: totals.totalBuy,
      podCount: 0,
      emailPodAvailable: false,
      rateconStatus: hydratedEntry.carrier.name ? "Drafted" : "Not Sent",
      writebackState: liveAllowed
        ? `Booked live in TAI (#${assignedId})${sellSummary}${buySummary}`
        : `Validated & booked in Sandbox (${assignedId})`,
      location: `${hydratedEntry.stops.length} stops · ${totals.totalPieces} pcs · ${totals.totalWeight.toLocaleString()} lbs`,
    };

    if (liveAllowed && sb && opts.shipments === undefined) {
      try {
        await sb.from("shipments").upsert(
          {
            shipment_id: assignedId,
            status: hydratedEntry.status,
            customer_name: newShipment.customer,
            customer_tai_organization_id: context.customerId,
            carrier_name: hydratedEntry.carrier.name || "",
            customer_po: poVal,
            shipper_reference: hydratedEntry.references.bolNumber,
            ship_date: firstStop.readyDate,
            delivery_date: lastStop.readyDate,
            from_city: firstStop.city.toUpperCase(),
            from_state: firstStop.state.toUpperCase(),
            to_city: lastStop.city.toUpperCase(),
            to_state: lastStop.state.toUpperCase(),
            total_weight: totals.totalWeight,
            equipment_type: hydratedEntry.equipment.trailerType,
            sell: totals.totalSell,
            buy: totals.totalBuy,
            margin: totals.totalMargin,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "shipment_id" },
        );
      } catch {
        // non-fatal local mirror warning
      }
    }

    targetShipments.unshift(newShipment);
    createdShipments.push(newShipment);
    shipmentChargeBreakdowns.set(assignedId, {
      linehaulSell: totals.linehaulSell,
      fuelSell: totals.fuelSell,
      accessorialSell: totals.accessorialSell,
      linehaulBuy: totals.linehaulBuy,
      fuelBuy: totals.fuelBuy,
      accessorialBuy: totals.accessorialBuy,
    });
    if (opts.shipments === undefined) {
      store.kpis.loads30d += 1;
      if (!hydratedEntry.carrier.name) store.kpis.uncoveredCommitted += 1;
    }
  }

  broadcastOpsEvent("shipment_booked", { createdIds });
  return {
    ok: true,
    status: 200,
    shipmentId: createdIds[0],
    createdIds,
    shipment: createdShipments[0],
    shipments: createdShipments,
    tai: {
      shipmentId: createdIds[0],
      rates: {
        sell: lastSellResult,
        buy: lastBuyResult,
      },
    },
    issues: [],
    request: requestTemplate,
    message: `Created ${createdIds.length} load(s): #${createdIds.join(", #")}`,
  };
}

/**
 * TAI spells `"Canceled"` with one `l` in Tracking updates (`PUT /PublicApi/Shipping/v2/Tracking`).
 */
export function normalizeTaiTrackingStatus(rawStatus: string): string {
  const trimmed = String(rawStatus || "").trim();
  if (!trimmed) return "In Transit";
  if (/^cancell?ed$/i.test(trimmed)) return "Canceled";
  const lower = trimmed.toLowerCase();
  if (lower === "needs truck") return "Committed";
  if (lower === "assigned") return "Dispatched";
  if (lower === "in transit") return "In Transit";
  if (lower === "delivered" || lower === "delivered / pod") return "Delivered";
  return trimmed.replace(/cancelled/gi, "Canceled");
}

export interface DirectTaiHelperOptions {
  credential?: string;
  baseUrl?: string;
  liveAllowed?: boolean;
  writebackEnabled?: boolean;
  addressBookSaveEnabled?: boolean;
  fetchImpl?: typeof fetch;
  actor?: string;
  supabaseClient?: ReturnType<typeof store.getSupabase> | null;
  liveInsertAudit?: boolean;
}

export async function pushShipmentCheckCall(
  shipmentId: string,
  params: {
    status?: string;
    stage?: string;
    location?: string;
    note?: string;
    operationalNote?: string;
    driverName?: string;
    driverPhone?: string;
    pickupReadyDateTime?: string;
    deliveryEstimatedDateTime?: string;
  },
  options: DirectTaiHelperOptions = {},
) {
  const s = store.shipments.find((item) => item.id === shipmentId);
  if (!s) {
    return { ok: false, status: 404, message: `Shipment #${shipmentId} not found` };
  }

  const incomingStatus = String(params.status || params.stage || s.rawStatus || "In Transit").trim();
  const taiStatus = normalizeTaiTrackingStatus(incomingStatus);
  const nextStage: DispatchStage =
    params.stage === "Needs truck" ||
    params.stage === "Assigned" ||
    params.stage === "In transit" ||
    params.stage === "Delivered"
      ? params.stage
      : mapTaiStatusToStage(taiStatus);

  const locText = String(params.location || "").trim();
  const noteText = String(params.operationalNote ?? params.note ?? "").trim();
  const driverSummary = [params.driverName, params.driverPhone].map((v) => String(v || "").trim()).filter(Boolean).join(" · ");

  s.rawStatus = taiStatus;
  s.stage = nextStage;
  if (locText) s.location = locText;
  if (noteText) s.operationalNote = noteText;

  const eventSummary = [locText, noteText, driverSummary ? `Driver: ${driverSummary}` : ""]
    .filter(Boolean)
    .join(" · ") || `Status updated to ${taiStatus}`;

  s.containerEvents = [
    {
      id: `cc-${Date.now()}`,
      timestamp: new Date().toLocaleTimeString(),
      from: options.actor || "dispatch",
      subject: `Check Call · ${taiStatus}`,
      summary: eventSummary,
      kind: "status",
    },
    ...(s.containerEvents || []),
  ];

  const cred = options.credential !== undefined ? taiApiKey(options.credential) : taiApiKey();
  const liveAllowed =
    options.liveAllowed !== undefined ? Boolean(options.liveAllowed && cred) : Boolean(!store.isSafeSandbox && cred);
  const writebackEnabled =
    options.writebackEnabled !== undefined ? options.writebackEnabled : process.env.TAI_WRITEBACK_ENABLED !== "false";
  const doFetch = options.fetchImpl ?? fetch;
  const taiBase = resolveTaiBaseUrl(options.baseUrl);
  const sb = options.supabaseClient !== undefined ? options.supabaseClient : store.getSupabase();
  const auditSb = sb as unknown as SupabaseInsertLike | null;

  let taiSynced = false;
  if (liveAllowed && writebackEnabled && isNumericTaiShipmentId(s.id) && !isTaiAuthHalted(cred)) {
    const trackingPayload = {
      shipmentId: Number(s.id),
      transitType: "Linehaul",
      trackingUpdate: {
        shipmentStatus: taiStatus,
        ...(params.pickupReadyDateTime ? { pickupReadyDateTime: params.pickupReadyDateTime } : {}),
        ...(params.deliveryEstimatedDateTime ? { deliveryEstimatedDateTime: params.deliveryEstimatedDateTime } : {}),
      },
    };
    const reqHeaders = {
      "x-api-key": cred,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    try {
      const resp = await doFetch(`${taiBase}${TAI_TRACKING_PATH}`, {
        method: "PUT",
        headers: reqHeaders,
        body: JSON.stringify(trackingPayload),
        signal: AbortSignal.timeout(20_000),
      });
      const respText = await resp.text();
      if (isTaiAuthFailureStatus(resp.status)) {
        haltTaiOnAuthFailure(cred, `TAI HTTP ${resp.status} on PUT /Tracking`);
      }
      taiSynced = resp.ok;
      void recordTaiPush({
        shipmentId: s.id,
        kind: "tracking",
        method: "PUT",
        endpoint: TAI_TRACKING_PATH,
        requestHeaders: reqHeaders,
        requestPayload: trackingPayload,
        responseStatus: resp.status,
        responseBody: respText,
        ok: resp.ok,
        needsHuman: !resp.ok,
        errorMessage: resp.ok ? null : `PUT /Tracking returned HTTP ${resp.status}`,
        actor: options.actor ?? null,
        supabaseClient: auditSb,
        liveInsert: options.liveInsertAudit ?? Boolean(liveAllowed && auditSb),
        redactValues: [cred],
      });
    } catch (err) {
      const errMsg = `PUT /Tracking failed without response: ${err instanceof Error ? err.message : String(err)}`;
      void recordTaiPush({
        shipmentId: s.id,
        kind: "tracking",
        method: "PUT",
        endpoint: TAI_TRACKING_PATH,
        requestHeaders: reqHeaders,
        requestPayload: trackingPayload,
        responseStatus: null,
        responseBody: null,
        ok: false,
        needsHuman: true,
        errorMessage: errMsg,
        actor: options.actor ?? null,
        supabaseClient: auditSb,
        liveInsert: options.liveInsertAudit ?? Boolean(liveAllowed && auditSb),
        redactValues: [cred],
      });
    }
  }

  s.writebackState = taiSynced
    ? `✓ Check call synced live to TAI Tracking (${taiStatus})`
    : `Check call logged (${taiStatus}${locText ? ` · ${locText}` : ""})`;

  if (!store.isSafeSandbox && sb) {
    try {
      await sb
        .from("shipments")
        .update({
          tai_raw_status: taiStatus,
          current_location: s.location,
          notes: s.operationalNote || null,
          updated_at: new Date().toISOString(),
        })
        .eq("shipment_id", s.id);
    } catch {
      // ignore local mirror error
    }
  }

  broadcastOpsEvent("shipment_updated", { shipmentId: s.id });
  return {
    ok: true,
    status: 200,
    shipment: s,
    taiStatus,
    taiSynced,
    message: `Logged check call on #${s.id} (${taiStatus}${locText ? ` · ${locText}` : ""})`,
  };
}

export async function pushShipmentReferences(
  shipmentId: string,
  params: {
    po?: string;
    customerPO?: string;
    bol?: string;
    bolNumber?: string;
    shipperReference?: string;
    pro?: string;
    carrierProNumber?: string;
    pickupNumber?: string;
    containerNumber?: string;
    references?: Array<{ referenceType: string; value: string }>;
  },
  options: DirectTaiHelperOptions = {},
) {
  const s = store.shipments.find((item) => item.id === shipmentId);
  if (!s) {
    return { ok: false, status: 404, message: `Shipment #${shipmentId} not found` };
  }

  const nextPo = params.po ?? params.customerPO;
  const nextBol = params.bol ?? params.bolNumber ?? params.shipperReference;
  const nextPro = params.pro ?? params.carrierProNumber;
  if (nextPo !== undefined) s.po = String(nextPo).trim();
  if (nextBol !== undefined) s.bol = String(nextBol).trim();
  if (nextPro !== undefined) s.pro = String(nextPro).trim();
  if (params.containerNumber !== undefined) {
    const cn = String(params.containerNumber).trim();
    if (cn) s.containerNumber = cn;
  }

  const refItems: Array<{ referenceType: string; value: string }> = [];
  if (Array.isArray(params.references) && params.references.length > 0) {
    for (const r of params.references) {
      if (r && String(r.referenceType || "").trim() && String(r.value || "").trim()) {
        refItems.push({ referenceType: String(r.referenceType).trim(), value: String(r.value).trim() });
      }
    }
  } else {
    if (s.po) refItems.push({ referenceType: "Customer PO Number", value: s.po });
    if (s.bol) refItems.push({ referenceType: "Shipper Reference Number", value: s.bol });
    if (s.pro) refItems.push({ referenceType: "Linehaul Carrier Pro Number", value: s.pro });
    if (params.pickupNumber && String(params.pickupNumber).trim()) {
      refItems.push({ referenceType: "Linehaul Pickup Number", value: String(params.pickupNumber).trim() });
    }
  }

  const cred = options.credential !== undefined ? taiApiKey(options.credential) : taiApiKey();
  const liveAllowed =
    options.liveAllowed !== undefined ? Boolean(options.liveAllowed && cred) : Boolean(!store.isSafeSandbox && cred);
  const writebackEnabled =
    options.writebackEnabled !== undefined ? options.writebackEnabled : process.env.TAI_WRITEBACK_ENABLED !== "false";
  const doFetch = options.fetchImpl ?? fetch;
  const taiBase = resolveTaiBaseUrl(options.baseUrl);
  const sb = options.supabaseClient !== undefined ? options.supabaseClient : store.getSupabase();
  const auditSb = sb as unknown as SupabaseInsertLike | null;

  let taiSynced = false;
  if (liveAllowed && writebackEnabled && isNumericTaiShipmentId(s.id) && refItems.length > 0 && !isTaiAuthHalted(cred)) {
    const endpoint = `${TAI_REFERENCE_NUMBERS_PATH}?shipmentId=${encodeURIComponent(s.id)}`;
    const reqHeaders = {
      "x-api-key": cred,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    try {
      const resp = await doFetch(`${taiBase}${endpoint}`, {
        method: "PUT",
        headers: reqHeaders,
        // TAI ShipmentReferenceNumbers requires a bare JSON array in the request body!
        body: JSON.stringify(refItems),
        signal: AbortSignal.timeout(20_000),
      });
      const respText = await resp.text();
      if (isTaiAuthFailureStatus(resp.status)) {
        haltTaiOnAuthFailure(cred, `TAI HTTP ${resp.status} on PUT /ShipmentReferenceNumbers`);
      }
      taiSynced = resp.ok;
      void recordTaiPush({
        shipmentId: s.id,
        kind: "reference_numbers",
        method: "PUT",
        endpoint,
        requestHeaders: reqHeaders,
        requestPayload: refItems,
        responseStatus: resp.status,
        responseBody: respText,
        ok: resp.ok,
        needsHuman: !resp.ok,
        errorMessage: resp.ok ? null : `PUT /ShipmentReferenceNumbers returned HTTP ${resp.status}`,
        actor: options.actor ?? null,
        supabaseClient: auditSb,
        liveInsert: options.liveInsertAudit ?? Boolean(liveAllowed && auditSb),
        redactValues: [cred],
      });
    } catch (err) {
      const errMsg = `PUT /ShipmentReferenceNumbers failed without response: ${err instanceof Error ? err.message : String(err)}`;
      void recordTaiPush({
        shipmentId: s.id,
        kind: "reference_numbers",
        method: "PUT",
        endpoint,
        requestHeaders: reqHeaders,
        requestPayload: refItems,
        responseStatus: null,
        responseBody: null,
        ok: false,
        needsHuman: true,
        errorMessage: errMsg,
        actor: options.actor ?? null,
        supabaseClient: auditSb,
        liveInsert: options.liveInsertAudit ?? Boolean(liveAllowed && auditSb),
        redactValues: [cred],
      });
    }
  }

  s.writebackState = taiSynced
    ? `✓ References synced live to TAI (PO: ${s.po || "—"} · BOL: ${s.bol || "—"} · PRO: ${s.pro || "—"})`
    : `References updated locally (PO: ${s.po || "—"} · BOL: ${s.bol || "—"} · PRO: ${s.pro || "—"})`;

  if (!store.isSafeSandbox && sb) {
    try {
      await sb
        .from("shipments")
        .update({
          customer_po: s.po,
          shipper_reference: s.bol,
          carrier_pro_number: s.pro,
          updated_at: new Date().toISOString(),
        })
        .eq("shipment_id", s.id);
    } catch {
      // ignore local mirror error
    }
  }

  broadcastOpsEvent("shipment_updated", { shipmentId: s.id });
  return {
    ok: true,
    status: 200,
    shipment: s,
    references: refItems,
    taiSynced,
    message: `Updated references on #${s.id}`,
  };
}

export async function saveFacilityRecord(
  params: {
    companyName?: string;
    streetAddress?: string;
    city?: string;
    state?: string;
    zipCode?: string;
    contactName?: string;
    phone?: string;
    customerOrganizationId?: string | number;
  },
  options: DirectTaiHelperOptions = {},
) {
  const companyName = String(params.companyName || "").trim();
  const streetAddress = String(params.streetAddress || "").trim();
  const city = String(params.city || "").trim();
  const state = String(params.state || "").trim().toUpperCase();
  const zipCode = String(params.zipCode || "").trim();
  const contactName = String(params.contactName || "").trim();
  const phone = String(params.phone || "").trim();

  if (!companyName || !city || !state || !/^\d{5}(-\d{4})?$/.test(zipCode)) {
    return {
      ok: false,
      status: 400,
      message: "Facility companyName, city, 2-letter state, and 5-digit zipCode are required.",
    };
  }

  const label = `${companyName} — ${city}, ${state} ${zipCode}`;
  const existingIdx = store.facilities.findIndex(
    (f) =>
      normalizeNameKey(f.companyName) === normalizeNameKey(companyName) &&
      normalizeNameKey(f.city) === normalizeNameKey(city) &&
      f.state.trim().toUpperCase() === state &&
      f.zipCode.trim().slice(0, 5) === zipCode.slice(0, 5),
  );

  let facility: SavedFacility;
  if (existingIdx >= 0) {
    facility = {
      ...store.facilities[existingIdx],
      label,
      companyName,
      streetAddress: streetAddress || store.facilities[existingIdx].streetAddress,
      city,
      state,
      zipCode,
      contactName: contactName || store.facilities[existingIdx].contactName,
      phone: phone || store.facilities[existingIdx].phone,
    };
    store.facilities[existingIdx] = facility;
  } else {
    facility = {
      id: `fac-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      label,
      companyName,
      streetAddress,
      city,
      state,
      zipCode,
      contactName,
      phone,
    };
    store.facilities.unshift(facility);
    store.kpis.facilitiesCount += 1;
  }

  const cred = options.credential !== undefined ? taiApiKey(options.credential) : taiApiKey();
  const liveAllowed =
    options.liveAllowed !== undefined ? Boolean(options.liveAllowed && cred) : Boolean(!store.isSafeSandbox && cred);
  const addressBookEnabled =
    options.addressBookSaveEnabled !== undefined
      ? options.addressBookSaveEnabled
      : process.env.TAI_ADDRESS_BOOK_SAVE_ENABLED === "true";
  const sb = options.supabaseClient !== undefined ? options.supabaseClient : store.getSupabase();
  const auditSb = sb as unknown as SupabaseInsertLike | null;
  const doFetch = options.fetchImpl ?? fetch;
  const taiBase = resolveTaiBaseUrl(options.baseUrl);

  if (!store.isSafeSandbox && sb) {
    try {
      await sb.from("facilities").insert({
        company_name: companyName,
        street_address: streetAddress,
        city,
        state,
        zip_code: zipCode,
        contact_name: contactName,
      });
    } catch {
      // ignore duplicate or schema difference
    }
  }

  let taiAddressBookSaved = false;
  if (liveAllowed && addressBookEnabled && !isTaiAuthHalted(cred)) {
    const orgId = parsePositiveInt(params.customerOrganizationId);
    const addrPayload = {
      ...(orgId !== null ? { customerId: orgId } : {}),
      companyName,
      streetAddress,
      city,
      state,
      zipCode,
      country: "USA",
      contactName: contactName || null,
      phone: phone || null,
    };
    const reqHeaders = {
      "x-api-key": cred,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    try {
      const resp = await doFetch(`${taiBase}${TAI_CUSTOMER_ADDRESSES_PATH}`, {
        method: "PUT",
        headers: reqHeaders,
        body: JSON.stringify(addrPayload),
        signal: AbortSignal.timeout(20_000),
      });
      const respText = await resp.text();
      if (isTaiAuthFailureStatus(resp.status)) {
        haltTaiOnAuthFailure(cred, `TAI HTTP ${resp.status} on PUT /Customer/v2/Addresses`);
      }
      taiAddressBookSaved = resp.ok;
      void recordTaiPush({
        shipmentId: null,
        kind: "address_book",
        method: "PUT",
        endpoint: TAI_CUSTOMER_ADDRESSES_PATH,
        requestHeaders: reqHeaders,
        requestPayload: addrPayload,
        responseStatus: resp.status,
        responseBody: respText,
        ok: resp.ok,
        needsHuman: !resp.ok,
        errorMessage: resp.ok ? null : `PUT /Customer/v2/Addresses returned HTTP ${resp.status}`,
        actor: options.actor ?? null,
        supabaseClient: auditSb,
        liveInsert: options.liveInsertAudit ?? Boolean(liveAllowed && auditSb),
        redactValues: [cred],
      });
    } catch (err) {
      void recordTaiPush({
        shipmentId: null,
        kind: "address_book",
        method: "PUT",
        endpoint: TAI_CUSTOMER_ADDRESSES_PATH,
        requestHeaders: reqHeaders,
        requestPayload: addrPayload,
        responseStatus: null,
        responseBody: null,
        ok: false,
        needsHuman: true,
        errorMessage: err instanceof Error ? err.message : String(err),
        actor: options.actor ?? null,
        supabaseClient: auditSb,
        liveInsert: options.liveInsertAudit ?? Boolean(liveAllowed && auditSb),
        redactValues: [cred],
      });
    }
  }

  return {
    ok: true,
    status: 200,
    facility,
    facilities: store.facilities,
    taiAddressBookSaved,
    taiAddressBookGated: !addressBookEnabled,
    message: taiAddressBookSaved
      ? `Saved ${companyName} (${city}, ${state} ${zipCode}) to Address Book & TAI!`
      : `Saved ${companyName} (${city}, ${state} ${zipCode}) to Saved Facilities.`,
  };
}

/**
 * Live-compatible Carrier + Buy Write-Back Queue & 45s Read-Back Waiter.
 * Works simultaneously with `primary-freight-dashboard`'s poller OR `fivenines-ops`'s poller!
 */
export async function enqueueCarrierWriteback(params: {
  shipmentId: string;
  carrierName: string;
  buyRate: number;
  requestedBy?: string;
}) {
  const shipment = store.shipments.find((s) => s.id === params.shipmentId);
  if (!shipment) {
    return { ok: false, status: 404, message: `Shipment #${params.shipmentId} not found` };
  }
  const carrier = store.carriers.find((c) => c.name === params.carrierName);
  const buyNum = Math.max(0, Number(params.buyRate) || 0);
  const sb = store.getSupabase();

  if (!store.isSafeSandbox && sb) {
    if (!isNumericTaiShipmentId(params.shipmentId)) {
      return {
        ok: false,
        status: 400,
        message: `Cannot queue live TAI write-back for non-numeric local shipmentId "${params.shipmentId}".`,
      };
    }
    // 1. Check app_settings kill switch in Supabase
    const { data: setting } = await sb
      .from("app_settings")
      .select("value")
      .eq("key", "tai_writeback_enabled")
      .maybeSingle();
    if (setting && String(setting.value).toLowerCase() !== "true") {
      return { ok: false, status: 503, message: "TAI writeback is switched off in Supabase app_settings" };
    }

    // 2. Resolve canonical tai_carrier_master_id from Supabase carriers table
    const { data: dbCarrier } = await sb
      .from("carriers")
      .select("tai_carrier_master_id,mc_number")
      .eq("name", params.carrierName.trim())
      .maybeSingle();
    const masterId = dbCarrier?.tai_carrier_master_id ?? (carrier?.taiMasterId ? Number(carrier.taiMasterId) : null);
    if (!masterId) {
      return { ok: false, status: 409, message: `TAI carrierMasterId is unavailable for ${params.carrierName}` };
    }

    // 3. Insert into tai_carrier_assignments
    const { data: inserted, error: insertError } = await sb
      .from("tai_carrier_assignments")
      .insert({
        shipment_id: params.shipmentId,
        carrier_name: params.carrierName.trim(),
        carrier_mc: dbCarrier?.mc_number || carrier?.mc || null,
        carrier_master_id: Number(masterId),
        buy_rate: buyNum,
        requested_by: params.requestedBy || "fivenines-ops",
        dry_run: false,
      })
      .select("id")
      .single();

    if (insertError || !inserted) {
      if (insertError?.code === "23505") {
        const { data: active } = await sb
          .from("tai_carrier_assignments")
          .select("status,response_body")
          .eq("shipment_id", params.shipmentId)
          .in("status", ["pending", "in_flight", "failed"])
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const parked = active?.status === "failed" && isPendingReadBack(active.response_body);
        return {
          ok: false,
          status: 409,
          message: parked ? READ_BACK_PENDING_SAVE_MESSAGE : "This shipment already has a TAI write-back in progress.",
        };
      }
      return { ok: false, status: 502, message: `Could not queue write-back: ${insertError?.message || "unknown"}` };
    }

    // 4. Immediately trigger local poller on save when enabled (avoids 15s wait & racing),
    // then wait up to SAVE_WAIT_MS (45s) for PUT CarrierCharges + GET /Shipments/{id} read-back
    if (pollerConfigStatus().enabled) {
      await runPollerForAssignmentId(inserted.id);
    }

    const deadline = Date.now() + SAVE_WAIT_MS;
    let firstCheck = true;
    while (Date.now() < deadline) {
      if (!firstCheck) await wait(1_500);
      firstCheck = false;
      const { data: outcome } = await sb
        .from("tai_carrier_assignments")
        .select("status,error_message,response_body")
        .eq("id", inserted.id)
        .single();

      if (outcome?.status === "sent") {
        const verifiedBuy = Number((outcome.response_body as { verifiedBuy?: unknown } | null)?.verifiedBuy);
        const finalBuy = Number.isFinite(verifiedBuy) && verifiedBuy > 0 ? verifiedBuy : buyNum;
        shipment.carrier = params.carrierName;
        shipment.mc = String(dbCarrier?.mc_number || carrier?.mc || "");
        shipment.buy = finalBuy;
        if (shipment.stage === "Needs truck") shipment.stage = "Assigned";
        shipment.rateconStatus = "Sent";
        shipment.writebackState = `✓ Verified Live in TAI (Assignment #${inserted.id} · $${finalBuy.toLocaleString()} Buy)`;

        await sb
          .from("shipments")
          .update({
            carrier_name: params.carrierName,
            buy: finalBuy,
            margin: shipment.sell - finalBuy,
            updated_at: new Date().toISOString(),
          })
          .eq("shipment_id", params.shipmentId);

        broadcastOpsEvent("writeback_verified", { shipmentId: shipment.id });
        return {
          ok: true,
          status: 200,
          shipment,
          message: `TAI Read-Back Confirmed: ${params.carrierName} ($${finalBuy.toLocaleString()} buy) on #${shipment.id}!`,
        };
      }

      if (outcome?.status === "needs_human") {
        return {
          ok: false,
          status: 502,
          message: outcome.error_message || "TAI write-back requires human review.",
        };
      }

      if (outcome?.status === "failed" && isPendingReadBack(outcome.response_body)) {
        shipment.writebackState = READ_BACK_PENDING_SAVE_MESSAGE;
        return {
          ok: true,
          status: 202,
          shipment,
          message: READ_BACK_PENDING_SAVE_MESSAGE,
        };
      }
    }

    return {
      ok: true,
      status: 202,
      shipment,
      message: `Queued in tai_carrier_assignments (#${inserted.id}) — poller still awaiting TAI confirmation.`,
    };
  }

  // Safe Sandbox Mode
  shipment.carrier = params.carrierName;
  shipment.mc = carrier?.mc || "";
  shipment.buy = buyNum;
  if (shipment.stage === "Needs truck") shipment.stage = "Assigned";
  shipment.rateconStatus = "Sent";
  shipment.writebackState = `✓ Sandbox Verified: Queued tai_carrier_assignments → Poller PUT CarrierCharges (Master #${carrier?.taiMasterId || "—"} · $${buyNum.toLocaleString()} Buy)`;

  store.webhookLogs.unshift({
    id: `wb-${Date.now()}`,
    timestamp: new Date().toISOString(),
    type: "CarrierWriteBackPoller",
    shipmentId: shipment.id,
    summary: `${params.carrierName} ($${buyNum.toLocaleString()} Buy) verified`,
  });
  broadcastOpsEvent("writeback_verified", { shipmentId: shipment.id });

  return {
    ok: true,
    status: 200,
    shipment,
    message: `Assigned ${params.carrierName} ($${buyNum.toLocaleString()} buy) on #${shipment.id}.`,
  };
}

export function verifyWebhookSecretIfConfigured(
  headers: Record<string, string | string[] | undefined>,
  querySecret?: unknown,
): boolean {
  const expected = process.env.TAI_WEBHOOK_SECRET?.trim();
  if (!expected) return true;
  const headerVal = String(headers["x-tai-webhook-secret"] || headers["x-webhook-secret"] || "").trim();
  const authVal = String(headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const qVal = typeof querySecret === "string" ? querySecret.trim() : "";
  return headerVal === expected || authVal === expected || qVal === expected;
}

function teeWebhookIfConfigured(
  pathSuffix: string,
  payload: unknown,
  headers: Record<string, string | string[] | undefined>,
): void {
  const teeBase = process.env.TEE_WEBHOOK_URL?.trim().replace(/\/+$/, "");
  if (!teeBase) return;
  const forwardHeaders: Record<string, string> = { "Content-Type": "application/json" };
  if (typeof headers["x-tai-webhook-secret"] === "string") {
    forwardHeaders["x-tai-webhook-secret"] = headers["x-tai-webhook-secret"];
  }
  fetch(`${teeBase}${pathSuffix}`, {
    method: "POST",
    headers: forwardHeaders,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8_000),
  }).catch(() => {});
}

export function handleTaiShipmentWebhook(
  payload: TaiShipmentWebhookPayload,
  headers: Record<string, string | string[] | undefined> = {},
) {
  const id = String(payload.shipmentId || "").trim();
  if (!id) return { ok: false, status: 400, message: "shipmentId is required" };

  teeWebhookIfConfigured("/api/webhooks/tai/shipment", payload, headers);

  let target = store.shipments.find((s) => s.id === id);
  const stage = payload.status ? mapTaiStatusToStage(payload.status) : target?.stage || "Needs truck";
  const topCarrier = payload.carrierList?.[0];
  const poRef = payload.shipmentReferenceNumbers?.find(
    (r) => (r.referenceType || "").toLowerCase() === "customer po number",
  )?.value;
  const podDocs = Array.isArray(payload.attachments)
    ? payload.attachments.filter((a) => /pod|delivery/i.test(String(a.documentType || a.fileName || ""))).length
    : undefined;

  if (!target) {
    const pick = payload.stops?.[0];
    const drop = payload.stops?.[payload.stops.length - 1];
    target = {
      id,
      customer: payload.customer?.name || "TAI Webhook Customer",
      taiOrgId: payload.customer?.billToOrganizationId ? String(payload.customer.billToOrganizationId) : undefined,
      origin: pick ? `${pick.city || ""}, ${pick.state || ""} ${pick.zipCode || ""}`.trim() : "Origin TBD",
      dest: drop ? `${drop.city || ""}, ${drop.state || ""} ${drop.zipCode || ""}`.trim() : "Dest TBD",
      stops: (payload.stops || []).map((st, idx, arr) => ({
        stopType: idx === 0 ? "First Pickup" : idx === arr.length - 1 ? "Last Drop" : "Pick",
        companyName: st.companyName || "Facility",
        streetAddress: st.streetAddress || "",
        city: st.city || "",
        state: st.state || "",
        zipCode: st.zipCode || "00000",
        country: "USA",
        contactName: "",
        phone: "",
        instructions: "",
        readyDate: String(st.estimatedReadyDateTime || st.appointmentReadyDateTime || "2026-11-16").slice(0, 10),
        timeOpen: "08:00",
        timeClose: "15:00",
        appointmentRequired: Boolean(st.appointmentReadyDateTime),
      })),
      commodities: (payload.commodities || [{ description: "Webhook Freight", weightTotal: 35000, piecesTotal: 1 }]).map(
        (c) => ({
          description: c.description || "Freight",
          packagingType: c.packagingType || "Pallet",
          handlingQuantity: c.handlingQuantity ?? 1,
          piecesTotal: c.piecesTotal ?? 1,
          weightTotal: c.weightTotal ?? 0,
          hazardousMaterial: Boolean(c.hazardousMaterial),
          freightClass: "No Class",
          referenceNumber: "",
        }),
      ),
      accessorials: [],
      stage,
      rawStatus: payload.status || "Committed",
      carrier: topCarrier?.name || "",
      mc: topCarrier?.mcNumber || "",
      po: poRef || "",
      bol: "",
      pro: "",
      shipDate: extractDateShort(payload.pickupReadyDateTime || payload.PickupReadyDateTime),
      delivDate: extractDateShort(payload.deliveryEstimatedDateTime || payload.DeliveryEstimatedDateTime),
      equip: payload.trailerType || "53 ft Van | Dry",
      trailerSize: "Full",
      mileage: Number(payload.mileage) || 0,
      sell: Number(payload.totalSell) || 0,
      buy: Number(payload.totalBuy) || 0,
      podCount: podDocs ?? 0,
      emailPodAvailable: false,
      rateconStatus: topCarrier?.name ? "Sent" : "Not Sent",
      writebackState: "Synced inbound from TAI ShipmentDetailUpdateUrl webhook",
      location: payload.locationString || "Inbound TAI webhook created load",
    };
    store.shipments.unshift(target);
  } else {
    if (payload.status) {
      target.rawStatus = payload.status;
      target.stage = stage;
    }
    if (topCarrier?.name) target.carrier = topCarrier.name;
    if (topCarrier?.mcNumber) target.mc = topCarrier.mcNumber;
    if (typeof payload.totalBuy === "number") target.buy = payload.totalBuy;
    if (typeof payload.totalSell === "number" && payload.totalSell > 0) target.sell = payload.totalSell;
    if (poRef) target.po = poRef;
    if (payload.locationString) target.location = `${payload.locationString} (Webhook live)`;
    if (podDocs !== undefined) target.podCount = podDocs;
    target.writebackState = `✓ Inbound TAI ShipmentDetailUpdateUrl synced (${target.rawStatus})`;
  }

  store.webhookLogs.unshift({
    id: `wh-${Date.now()}`,
    timestamp: new Date().toISOString(),
    type: "ShipmentDetailUpdateUrl",
    shipmentId: id,
    summary: `Status → ${target.rawStatus}${payload.locationString ? ` · GPS: ${payload.locationString}` : ""}`,
  });
  broadcastOpsEvent("shipment_updated", { shipmentId: id });

  return { ok: true, status: 200, shipment: target };
}

export const TAI_INVOICE_PAYMENT_STATUSES = [
  "Unpaid",
  "Partial Paid",
  "Over Paid",
  "Fully Paid",
  "Open",
  "All",
] as const;

export type TaiInvoicePaymentStatus = (typeof TAI_INVOICE_PAYMENT_STATUSES)[number];

export interface TaiInvoiceLineItemInput {
  description?: string | null;
  accessorialCode?: string | null;
  amount?: number | string | null;
  quantity?: number | string | null;
  calculationType?: string | null;
}

export interface NormalizedTaiInvoiceLineItem {
  description: string;
  accessorialCode: string;
  amount: number;
  quantity: number;
  calculationType: string;
}

export interface ExtendedTaiInvoiceWebhookPayload extends TaiInvoiceWebhookPayload {
  paymentStatus?: TaiInvoicePaymentStatus | string | null;
  lineItems?: TaiInvoiceLineItemInput[] | null;
}

export interface ObservedInvoiceAccessorial {
  accessorialCode: string;
  description: string;
  calculationType: string;
  lastSeenShipmentId: string;
  lastSeenAt: string;
  occurrences: number;
}

const observedInvoiceAccessorialMap = new Map<string, ObservedInvoiceAccessorial>();
const preservedInvoicesByShipment = new Map<
  string,
  {
    invoiceNumber: string;
    invoiceType: string;
    totalAmount: number;
    paymentStatus: TaiInvoicePaymentStatus | null;
    lineItems: NormalizedTaiInvoiceLineItem[];
    updatedAt: string;
  }
>();

export function normalizeTaiInvoicePaymentStatus(raw: unknown): TaiInvoicePaymentStatus | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  const hit = TAI_INVOICE_PAYMENT_STATUSES.find((v) => v.toLowerCase() === trimmed.toLowerCase());
  return hit ?? null;
}

export function getObservedInvoiceAccessorials(): ObservedInvoiceAccessorial[] {
  return Array.from(observedInvoiceAccessorialMap.values());
}

export function getPreservedInvoiceForShipment(shipmentId: string) {
  return preservedInvoicesByShipment.get(String(shipmentId || "").trim()) ?? null;
}

export function handleTaiInvoiceWebhook(
  payload: ExtendedTaiInvoiceWebhookPayload,
  headers: Record<string, string | string[] | undefined> = {},
) {
  const id = String(payload.shipmentId || "").trim();
  if (!id) return { ok: false, status: 400, message: "shipmentId is required" };

  teeWebhookIfConfigured("/api/webhooks/tai/invoice", payload, headers);

  const paymentStatus = normalizeTaiInvoicePaymentStatus(payload.paymentStatus ?? payload.status);
  const lineItems: NormalizedTaiInvoiceLineItem[] = Array.isArray(payload.lineItems)
    ? payload.lineItems
        .filter((li): li is TaiInvoiceLineItemInput => Boolean(li && typeof li === "object"))
        .map((li) => ({
          description: String(li.description ?? "").trim(),
          accessorialCode: String(li.accessorialCode ?? "").trim(),
          amount: Number(li.amount) || 0,
          quantity: li.quantity !== undefined && li.quantity !== null && String(li.quantity).trim() !== "" ? Number(li.quantity) || 1 : 1,
          calculationType: String(li.calculationType ?? "Flat").trim() || "Flat",
        }))
    : [];

  const nowIso = new Date().toISOString();
  for (const li of lineItems) {
    if (!li.accessorialCode && !li.description) continue;
    const dedupKey = `${li.accessorialCode.toUpperCase()}|${li.description.toLowerCase()}`;
    const existing = observedInvoiceAccessorialMap.get(dedupKey);
    if (existing) {
      existing.occurrences += 1;
      existing.lastSeenShipmentId = id;
      existing.lastSeenAt = nowIso;
      if (li.calculationType) existing.calculationType = li.calculationType;
    } else {
      observedInvoiceAccessorialMap.set(dedupKey, {
        accessorialCode: li.accessorialCode,
        description: li.description,
        calculationType: li.calculationType,
        lastSeenShipmentId: id,
        lastSeenAt: nowIso,
        occurrences: 1,
      });
    }
  }

  const target = store.shipments.find((s) => s.id === id);
  const invNum = payload.invoiceNumber || String(payload.invoiceId || "INV-NEW");
  const computedItemsTotal = lineItems.reduce((sum, li) => sum + li.amount, 0);
  const totalAmt =
    payload.totalAmount !== undefined
      ? Number(payload.totalAmount) || 0
      : computedItemsTotal > 0
      ? computedItemsTotal
      : target?.sell || 0;

  preservedInvoicesByShipment.set(id, {
    invoiceNumber: invNum,
    invoiceType: String(payload.invoiceType || "AR"),
    totalAmount: totalAmt,
    paymentStatus,
    lineItems,
    updatedAt: nowIso,
  });

  if (target) {
    const paySuffix = paymentStatus ? ` · ${paymentStatus}` : "";
    target.invoiceStatus = `${payload.invoiceType || "AR"} Invoice ${invNum} ($${totalAmt.toLocaleString()}${paySuffix})`;
    target.writebackState = `✓ Inbound TAI InvoiceCreateWithShipmentUrl (${target.invoiceStatus})`;

    for (const li of lineItems) {
      const label = li.description || li.accessorialCode;
      if (label && !/linehaul/i.test(label) && !target.accessorials.includes(label)) {
        target.accessorials.push(label);
      }
    }
  }
  store.webhookLogs.unshift({
    id: `wh-inv-${Date.now()}`,
    timestamp: nowIso,
    type: "InvoiceCreateWithShipmentUrl",
    shipmentId: id,
    summary: `Invoice ${invNum} (${payload.invoiceType || "AR"}${paymentStatus ? ` · ${paymentStatus}` : ""}${lineItems.length ? ` · ${lineItems.length} line items` : ""}) synced for #${id}`,
  });
  broadcastOpsEvent("invoice_updated", { shipmentId: id });
  return {
    ok: true,
    status: 200,
    shipment: target,
    paymentStatus,
    lineItems,
    observedAccessorials: getObservedInvoiceAccessorials(),
  };
}
