import type { LoadEntry } from "@shared/load-entry";
import type { CrucialEmailItem, CustomerOption, OpsShipment } from "@shared/tai-webhook-schema";

export type PanelViewId =
  | "home"
  | "inbox"
  | "attention"
  | "dispatch"
  | "all-loads"
  | "rates"
  | "tools"
  | "tools-bol"
  | "quote-builder"
  | "pod"
  | "sales"
  | "build-load"
  | "check-email"
  | "ai-assistant"
  | "ap-tasks";

export const PANEL_VIEW_IDS: readonly PanelViewId[] = [
  "home",
  "inbox",
  "attention",
  "dispatch",
  "all-loads",
  "rates",
  "tools",
  "tools-bol",
  "quote-builder",
  "pod",
  "sales",
  "build-load",
  "check-email",
  "ai-assistant",
  "ap-tasks",
] as const;

export const PANEL_VIEW_LABELS: Record<PanelViewId, string> = {
  home: "Home",
  inbox: "Inbox",
  attention: "Attention",
  dispatch: "Dispatch",
  "all-loads": "All Loads",
  rates: "Rates",
  tools: "Tools & Permits",
  "tools-bol": "BOL Generator",
  "quote-builder": "Quote Builder",
  pod: "POD Files",
  sales: "Sales",
  "build-load": "Load Builder",
  "check-email": "Check against loads",
  "ai-assistant": "AI Assistant",
  "ap-tasks": "AP Emails",
};

const VIEW_ALIASES: Record<string, PanelViewId> = {
  builder: "build-load",
  "load-builder": "build-load",
  bol: "tools-bol",
  quote: "quote-builder",
  ai: "ai-assistant",
  ap: "ap-tasks",
};

/**
 * Extended shipment & email shapes compatible with both baseline and Phase 2 live Supabase fields.
 */
export type LiveOpsShipment = Omit<OpsShipment, "stage" | "rateconStatus"> & {
  stage: OpsShipment["stage"] | "Cancelled";
  rateconStatus: OpsShipment["rateconStatus"] | "Signed";
  taiRawStatus?: string;
  shipDateIso?: string;
  delivDateIso?: string;
  currentLocation?: string;
  driverPhone?: string;
  trailerNumber?: string;
  invoiceStatus?: string;
  carrierPayStatus?: string;
  podStatus?: string;
};

export type LiveCrucialEmail = Omit<CrucialEmailItem, "extractedFields"> & {
  messageId?: string;
  unread?: boolean;
  source?: "extension" | "ap_inbox" | "intake_draft" | "seed" | string;
  extractedFields?: {
    customer?: string;
    po?: string;
    customerPO?: string;
    rate?: number;
    sellRate?: number;
    buyRate?: number;
    origin?: string;
    dest?: string;
    destination?: string;
    equipment?: string;
    readyDate?: string;
    notes?: string;
  };
};

const CORP_SUFFIX_RE =
  /\b(incorporated|inc|llc|l\.l\.c\.|corp|corporation|co|company|ltd|limited|solutions|lp|llp|plc)\b/gi;

export function normalizeCompanyNameKey(raw?: string | null): string {
  if (!raw) return "";
  return String(raw)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(CORP_SUFFIX_RE, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function buildExistingCustomerSet(
  customers: CustomerOption[] = [],
  shipments: Array<{ customer?: string }> = [],
): Set<string> {
  const keys = new Set<string>();
  for (const c of customers) {
    const k = normalizeCompanyNameKey(c.name);
    if (k.length >= 2) keys.add(k);
  }
  for (const s of shipments) {
    const k = normalizeCompanyNameKey(s.customer);
    if (k.length >= 2 && k !== "unlinked spot customer" && k !== "tai webhook customer") {
      keys.add(k);
    }
  }
  return keys;
}

export function isKnownExistingCustomer(companyName: string | undefined, existingKeys: Set<string>): boolean {
  const key = normalizeCompanyNameKey(companyName);
  if (!key || key.length < 2) return false;
  return existingKeys.has(key);
}

export function parsePanelViewParam(searchStr?: string): PanelViewId | null {
  const rawSearch = searchStr !== undefined ? searchStr : typeof window !== "undefined" ? window.location.search : "";
  const params = new URLSearchParams(rawSearch);
  const raw = String(params.get("view") || "").trim().toLowerCase();
  if (!raw) return null;
  if ((PANEL_VIEW_IDS as readonly string[]).includes(raw)) {
    return raw as PanelViewId;
  }
  return VIEW_ALIASES[raw] ?? null;
}

export function isStandalonePanelLocation(pathname?: string, searchStr?: string): boolean {
  const path = pathname !== undefined ? pathname : typeof window !== "undefined" ? window.location.pathname : "";
  const search = searchStr !== undefined ? searchStr : typeof window !== "undefined" ? window.location.search : "";
  if (path.startsWith("/gmail-panel")) return true;
  const params = new URLSearchParams(search);
  return params.get("panel") === "1" || params.get("panel") === "true";
}

export function syncPanelUrlView(nextView: PanelViewId, fullScreen: boolean): void {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (fullScreen || url.searchParams.has("view") || url.searchParams.get("panel") === "1" || url.pathname.startsWith("/gmail-panel")) {
      url.searchParams.set("view", nextView);
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
  } catch {
    // Ignore history state errors inside restricted sandboxes
  }
}

export const MIN_PANEL_ZOOM = 75;
export const MAX_PANEL_ZOOM = 130;
export const PANEL_ZOOM_STEP = 5;

export function clampPanelZoom(val: number): number {
  if (!Number.isFinite(val)) return 100;
  const snapped = Math.round(val / PANEL_ZOOM_STEP) * PANEL_ZOOM_STEP;
  return Math.max(MIN_PANEL_ZOOM, Math.min(MAX_PANEL_ZOOM, snapped));
}

export interface PanelSessionInfo {
  ok: boolean;
  user: {
    email: string;
    name?: string;
    displayName?: string;
    mode?: string;
  } | null;
  oauthEnabled?: boolean;
  gatewayConfigured?: boolean;
  csrfToken?: string;
}

export interface QuoteAccessorialLine {
  id: string;
  name: string;
  amount: number;
}

export interface QuoteDraftState {
  customerName: string;
  contactEmail: string;
  origin: string;
  destination: string;
  equipmentType: string;
  estMiles: number;
  linehaulRate: number;
  fuelSurcharge: number;
  accessorials: QuoteAccessorialLine[];
  transitNote: string;
  validUntil: string;
  equipmentNotes: string;
}

export interface LaneRateEstimateResult {
  ok: boolean;
  useDatLane: false;
  comparisonBasis?: string;
  linehaulPerMile?: number;
  allInPerMile?: number;
  sampleSize: number;
  lowSell: number;
  targetSell: number;
  highSell: number;
  targetBuy: number;
  estMiles: number;
  recentMatches: Array<{
    id: string;
    customer: string;
    carrier: string;
    origin: string;
    dest: string;
    equip: string;
    sell: number;
    buy: number;
    shipDate?: string;
  }>;
}

export interface PanelSavedDraft {
  id: string;
  title: string;
  customerName: string;
  lane: string;
  updatedAt: string;
  source?: string;
  entry: LoadEntry;
}

export interface PanelKnowledgeRule {
  id: string;
  customerName: string;
  category: "customer" | "facility" | "lane" | "equipment";
  ruleText: string;
  createdAt: string;
}

export type ApTaskStatus =
  | "open"
  | "in_review"
  | "resolved"
  | "Pending Check"
  | "Variance Hold"
  | "Missing POD"
  | "Approved";

export interface ApTaskRecord {
  id: string;
  shipmentId: string;
  customer?: string;
  carrierName: string;
  category?: string;
  invoiceNumber: string;
  amount: number;
  hasAmount: boolean;
  expectedBuy?: number;
  varianceUsd?: number;
  podAttached: boolean;
  status: ApTaskStatus;
  notes?: string;
  subject: string;
  sender: string;
  receivedAt: string;
  permalink?: string;
}

export function isApTaskResolved(status: string | undefined): boolean {
  const norm = String(status || "").trim().toLowerCase();
  return norm === "resolved" || norm === "approved";
}

export function normalizeApTaskRecord(
  raw: Record<string, unknown>,
  shipments: OpsShipment[] = [],
): ApTaskRecord {
  const shipmentId = String(raw.shipmentId || "").trim();
  const matchingShipment = shipmentId ? shipments.find((s) => s.id === shipmentId) : undefined;
  const parsedAmount = Number(raw.amount);
  const hasAmount = Number.isFinite(parsedAmount) && parsedAmount > 0;
  const category = typeof raw.category === "string" ? raw.category : undefined;
  const podAttached =
    Boolean(raw.podAttached) ||
    category === "pod" ||
    Boolean(matchingShipment && matchingShipment.podCount > 0);

  return {
    id: String(raw.id || `ap-${Date.now()}`),
    shipmentId,
    customer: raw.customer ? String(raw.customer) : matchingShipment?.customer,
    carrierName: String(raw.carrierName || raw.carrier || matchingShipment?.carrier || "Carrier"),
    category,
    invoiceNumber: String(raw.invoiceNumber || "—"),
    amount: hasAmount ? parsedAmount : 0,
    hasAmount,
    expectedBuy: typeof raw.expectedBuy === "number" ? raw.expectedBuy : matchingShipment?.buy,
    varianceUsd: typeof raw.varianceUsd === "number" ? raw.varianceUsd : undefined,
    podAttached,
    status: (raw.status as ApTaskStatus) || "open",
    notes: raw.notes ? String(raw.notes) : undefined,
    subject: String(raw.subject || "Carrier AP Email"),
    sender: String(raw.sender || raw.from || ""),
    receivedAt: String(raw.receivedAt || ""),
    permalink: raw.permalink ? String(raw.permalink) : undefined,
  };
}

export function shipmentToLoadEntry(s: OpsShipment): LoadEntry {
  return {
    shipmentType: "Truckload",
    status: "Committed",
    customer: {
      name: s.customer,
      taiOrganizationId: s.taiOrgId || "",
    },
    references: {
      customerPO: s.po || "",
      bolNumber: s.bol || "",
      invoiceRef: s.bol || "",
      carrierProNumber: s.pro || "",
      pickupNumber: "",
    },
    stops:
      s.stops.length >= 2
        ? structuredClone(s.stops)
        : [
            {
              stopType: "First Pickup",
              companyName: s.customer || "Origin Facility",
              streetAddress: "",
              city: s.origin.split(",")[0]?.trim() || "Houston",
              state: s.origin.match(/\b([A-Z]{2})\b/)?.[1] || "TX",
              zipCode: s.origin.match(/\b(\d{5})\b/)?.[1] || "77001",
              country: "USA",
              contactName: "",
              phone: "",
              instructions: "",
              readyDate: new Date().toISOString().slice(0, 10),
              timeOpen: "08:00",
              timeClose: "15:00",
              appointmentRequired: false,
            },
            {
              stopType: "Last Drop",
              companyName: "Destination Facility",
              streetAddress: "",
              city: s.dest.split(",")[0]?.trim() || "Dallas",
              state: s.dest.match(/\b([A-Z]{2})\b/)?.[1] || "TX",
              zipCode: s.dest.match(/\b(\d{5})\b/)?.[1] || "75201",
              country: "USA",
              contactName: "",
              phone: "",
              instructions: "",
              readyDate: new Date().toISOString().slice(0, 10),
              timeOpen: "09:00",
              timeClose: "16:00",
              appointmentRequired: false,
            },
          ],
    items:
      s.commodities.length >= 1
        ? structuredClone(s.commodities)
        : [
            {
              description: "General Freight",
              packagingType: "Pallet",
              handlingQuantity: 1,
              piecesTotal: 1,
              weightTotal: 40000,
              hazardousMaterial: false,
              freightClass: "No Class",
              referenceNumber: s.po || "",
            },
          ],
    accessorials: [],
    equipment: {
      trailerSize: s.trailerSize || "Full",
      trailerType: s.equip || "48 ft Flatbed",
      equipmentLength: s.equip.includes("53") ? "53" : "48",
      mileage: s.mileage || 0,
      stackable: false,
    },
    pricing: {
      linehaulSell: s.sell || 0,
      fuelSell: 0,
      linehaulBuy: s.buy || 0,
      fuelBuy: 0,
    },
    carrier: {
      name: s.carrier || "",
      mcNumber: s.mc || "",
      serviceLevel: "Normal",
    },
    specialInstructions: s.operationalNote || "",
    sendToTai: true,
  };
}

export function openPrintableHtmlWindow(title: string, htmlDocument: string): boolean {
  if (typeof window === "undefined") return false;
  const w = window.open("", "_blank", "noopener,noreferrer,width=900,height=760");
  if (!w) return false;
  w.document.open();
  w.document.write(htmlDocument);
  w.document.title = title;
  w.document.close();
  window.setTimeout(() => {
    try {
      w.focus();
    } catch {
      // Ignore cross-frame focus restrictions
    }
  }, 120);
  return true;
}
