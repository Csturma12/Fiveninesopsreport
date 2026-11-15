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
