import { TAI_SNAPSHOT_ACCESSORIALS } from "./tai-accessorial-catalog";

export type AccessorialScope = "pickup" | "delivery" | "shipment";

const NAMES: Record<AccessorialScope, string[]> = {
  pickup: [
    "Airport PU", "Appointment", "CFS Pickup", "Construction Site", "Grocery Warehouse", "Hazardous Material",
    "Inside Pickup", "Inventory Management", "Liftgate", "Limited Access Pickup", "Military Base", "Mine Site Pickup",
    "Notification", "Protect from Freezing", "Ramps", "Residential", "Saturday Pickup", "Tarp Fee", "Team Transit",
  ],
  delivery: [
    "Airport DEL", "Appointment", "CFS", "Construction Site", "Driver Assist", "Expedited Delivery", "Grocery Warehouse",
    "Inside Delivery", "Liftgate", "Limited Access Delivery", "Lumper Fee", "Mall Delivery", "Military Base",
    "Mine Site Delivery", "Night Gate Fee", "Notification", "Over Length - 8ft but less than 12ft",
    "Over Length - 12ft but less than 16ft", "Over Length - 16ft but less than 20ft", "Over Length - 20ft to max",
    "Pallet Jack", "Protect from Freezing", "Ramps", "Residential", "Residential - Appointment Forward Air",
    "Sort and Seg", "Stop Charge",
  ],
  shipment: [
    "ACH Fee", "Additional Freight", "Additional Stop Fee", "Air Pressure Wash", "Chassis Fee", "Comcheck",
    "Correction of Terms", "Crating & Material", "Credit Card Fee", "Customs Goods Duties", "Detention", "Diversion",
    "Document Fee", "Dry Run", "Escrow Late Fee", "Ferry Services", "Fuel Surcharge", "Guaranteed Delivery",
    "Hand Unloading", "Handling Fee", "Import Customs Clearance", "Inspection Fee", "Labeling", "Labor", "Late Fee",
    "Layover", "Minimum Charge", "Overheight", "Overwidth", "Pallet Exchange", "Pallet Fee", "Pallet In", "Pallet Jack",
    "Pallet Out", "Palletized Shrink Wrap", "Pallets", "Prepull", "Re-Class", "Reconsignment", "Redelivery Charge",
    "Reweigh", "Sort and Segregation", "Storage", "Storage Fee", "Sunday Pickup", "TONU", "Tracking Fee",
    "Tracking Service Not Used", "Trash Disposal", "Warehouse Fees", "Weekend Return", "Weekend Service",
  ],
};

const CODE_BY_NAME: Record<string, string> = {
  "tarp fee": "TARP",
  liftgate: "LFT",
  detention: "DET",
  layover: "LAY",
  "lumper fee": "LUM",
  "inside pickup": "INS",
  "inside delivery": "INS",
  residential: "RES",
  appointment: "APPT",
  "limited access pickup": "LTD",
  "limited access delivery": "LTD",
  "additional stop fee": "STOP",
  "stop charge": "STOP",
  tonu: "TONU",
  "tracking fee": "SNS",
  "hazardous material": "HAZ",
  "team transit": "TEAM",
};

export interface AccessorialOption {
  key: string;
  scope: AccessorialScope;
  code: string;
  name: string;
}

export const SCOPE_LABEL: Record<AccessorialScope, string> = {
  pickup: "Pickup",
  delivery: "Delivery",
  shipment: "Shipment",
};

const SCOPE_ORDER: AccessorialScope[] = ["pickup", "delivery", "shipment"];

export const ACCESSORIAL_OPTIONS: AccessorialOption[] = SCOPE_ORDER.flatMap((scope) =>
  NAMES[scope].map((name) => ({
    key: `${scope}:${name}`,
    scope,
    code: CODE_BY_NAME[name.toLowerCase()] ?? "CUSTOM",
    name,
  })),
);

export const QUICK_ACCESSORIALS: Record<AccessorialScope, string[]> = {
  pickup: ["Tarp Fee", "Appointment", "Liftgate", "Construction Site", "Limited Access Pickup", "Inside Pickup", "Hazardous Material"],
  delivery: ["Appointment", "Liftgate", "Lumper Fee", "Driver Assist", "Inside Delivery", "Limited Access Delivery", "Residential"],
  shipment: ["Fuel Surcharge", "Tracking Fee", "Additional Stop Fee", "Detention", "Layover", "Overwidth", "TONU"],
};

export function searchAccessorials(query: string, exclude: ReadonlySet<string> = new Set(), limit = 10): AccessorialOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const scored: Array<[number, AccessorialOption]> = [];
  for (const option of ACCESSORIAL_OPTIONS) {
    if (exclude.has(option.key)) continue;
    const name = option.name.toLowerCase();
    const scope = SCOPE_LABEL[option.scope].toLowerCase();
    let score = -1;
    if (name.startsWith(needle)) score = 0;
    else if (name.split(/[\s-]+/).some((w) => w.startsWith(needle))) score = 1;
    else if (name.includes(needle) || `${scope} ${name}`.includes(needle)) score = 2;
    if (score >= 0) scored.push([score, option]);
  }
  return scored
    .sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name))
    .slice(0, limit)
    .map(([, opt]) => opt);
}

export interface TaiAccessorialCatalogItem {
  backOfficeId: number;
  code: string;
  name: string;
  baseName: string;
  scope: AccessorialScope;
}

function deriveTaiScope(name: string, category: string): AccessorialScope {
  const cat = category.trim().toLowerCase();
  if (cat === "pickup" || /\s*-\s*pickup$/i.test(name)) return "pickup";
  if (cat === "delivery" || /\s*-\s*delivery$/i.test(name)) return "delivery";
  return "shipment";
}

function deriveTaiBaseName(name: string, category: string): string {
  const suffix = ` - ${category}`;
  if (name.endsWith(suffix)) {
    return name.slice(0, -suffix.length).trim();
  }
  return name.replace(/\s*-\s*(Pickup|Delivery|Shipment|Rating|Accounting|Fuel|Lumper)$/i, "").trim();
}

export const TAI_ACCESSORIAL_CATALOG: TaiAccessorialCatalogItem[] = TAI_SNAPSHOT_ACCESSORIALS.map(
  ([backOfficeId, name, category]) => ({
    backOfficeId,
    code: String(backOfficeId),
    name,
    baseName: deriveTaiBaseName(name, category),
    scope: deriveTaiScope(name, category),
  }),
);

export const TAI_ACCESSORIAL_COUNT: number = TAI_ACCESSORIAL_CATALOG.length;

const POPULAR_TAI_IDS: readonly number[] = [
  62, 223,     // Tarp Fee (Pickup, Shipment)
  15, 38, 157, // Detention (Delivery, Pickup, Shipment)
  104,         // TONU
  408,         // Tracking Fee
  50, 28,      // Liftgate (Pickup, Delivery)
  46,          // Hazardous Material
  145,         // Pier Pass
  127,         // Chassis Fee
  27, 159,     // Layover (Delivery, Shipment)
  442,         // Stop Off
  16, 403,     // Lumper Fee
  41, 18,      // Appointment
  93,          // Fuel Surcharge
  101,         // Dry Run
  48, 26,      // Inside Pickup / Delivery
  55, 31,      // Residential
  146,         // Pre-Pull
  154,         // Scale Ticket
];

const POPULAR_TAI_RANK = new Map<number, number>(
  POPULAR_TAI_IDS.map((id, idx) => [id, idx]),
);

const CATALOG_BY_ID = new Map<number, TaiAccessorialCatalogItem>(
  TAI_ACCESSORIAL_CATALOG.map((item) => [item.backOfficeId, item]),
);

const DEFAULT_TAI_ORDER: TaiAccessorialCatalogItem[] = [
  ...POPULAR_TAI_IDS.map((id) => CATALOG_BY_ID.get(id)).filter(
    (item): item is TaiAccessorialCatalogItem => Boolean(item),
  ),
  ...TAI_ACCESSORIAL_CATALOG.filter((item) => !POPULAR_TAI_RANK.has(item.backOfficeId)),
];

function compactAlphaNum(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function tokenMatchesItem(token: string, item: TaiAccessorialCatalogItem): boolean {
  const scopeTag = `[${item.scope}]`;
  if (token.startsWith("[")) {
    return token === scopeTag || (token.length >= 3 && scopeTag.startsWith(token));
  }
  const idStr = String(item.backOfficeId);
  const idToken = token.startsWith("#") ? token.slice(1).trim() : token;
  if (token.startsWith("#")) {
    return Boolean(idToken && /^\d+$/.test(idToken) && idStr.includes(idToken));
  }
  if (idToken && /^\d+$/.test(idToken) && idStr.includes(idToken)) {
    return true;
  }
  if (token === item.scope) {
    return true;
  }
  const nameLower = item.name.toLowerCase();
  if (nameLower.includes(token)) {
    return true;
  }
  if (token === "hazmat" && nameLower.includes("hazardous")) {
    return true;
  }
  const compactTok = compactAlphaNum(token);
  return compactTok.length >= 3 && compactAlphaNum(item.name).includes(compactTok);
}

function scoreTaiAccessorial(item: TaiAccessorialCatalogItem, needle: string): number {
  const scopeTag = `[${item.scope}]`;
  if (needle.startsWith("[")) {
    return needle === scopeTag || (needle.length >= 3 && scopeTag.startsWith(needle)) ? 7 : -1;
  }
  const idStr = String(item.backOfficeId);
  const idNeedle = needle.startsWith("#") ? needle.slice(1).trim() : needle;
  if (needle.startsWith("#")) {
    if (!idNeedle || !/^\d+$/.test(idNeedle) || !idStr.includes(idNeedle)) return -1;
    return idStr === idNeedle ? 0 : idStr.startsWith(idNeedle) ? 5 : 6;
  }

  const nameLower = item.name.toLowerCase();
  const baseLower = item.baseName.toLowerCase();

  if (idNeedle && /^\d+$/.test(idNeedle) && idStr === idNeedle) return 0;
  if (baseLower === needle || nameLower === needle) return 1;
  if (baseLower.startsWith(needle) || nameLower.startsWith(needle)) return 2;
  if (baseLower.split(/[\s/\-(),]+/).some((word) => word.startsWith(needle))) return 3;
  if (nameLower.includes(needle) || baseLower.includes(needle)) return 4;
  if (idNeedle && /^\d+$/.test(idNeedle) && idStr.includes(idNeedle)) {
    return idStr.startsWith(idNeedle) ? 5 : 6;
  }
  if (needle === item.scope || (needle.length >= 3 && item.scope.includes(needle))) return 7;

  const compactNeedle = compactAlphaNum(needle);
  if (compactNeedle.length >= 3 && compactAlphaNum(item.baseName).includes(compactNeedle)) {
    return 8;
  }
  if (needle === "hazmat" && nameLower.includes("hazardous")) {
    return 9;
  }

  const tokens = needle.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((tok) => tokenMatchesItem(tok, item))) {
    return 10;
  }

  return -1;
}

export function searchTaiAccessorials(query: string, limit = 80): TaiAccessorialCatalogItem[] {
  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 80;
  if (safeLimit === 0) return [];

  const needle = String(query || "").trim().toLowerCase();
  if (!needle) {
    return DEFAULT_TAI_ORDER.slice(0, safeLimit);
  }

  const scored: Array<{ score: number; item: TaiAccessorialCatalogItem }> = [];
  for (const item of TAI_ACCESSORIAL_CATALOG) {
    const score = scoreTaiAccessorial(item, needle);
    if (score >= 0) {
      scored.push({ score, item });
    }
  }

  return scored
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      const popA = POPULAR_TAI_RANK.get(a.item.backOfficeId) ?? Number.MAX_SAFE_INTEGER;
      const popB = POPULAR_TAI_RANK.get(b.item.backOfficeId) ?? Number.MAX_SAFE_INTEGER;
      if (popA !== popB) return popA - popB;
      return a.item.name.localeCompare(b.item.name) || a.item.backOfficeId - b.item.backOfficeId;
    })
    .slice(0, safeLimit)
    .map((entry) => entry.item);
}
