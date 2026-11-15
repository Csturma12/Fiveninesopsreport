/**
 * Canonical create-request enums from TAI Swagger v2:
 * CommitDomesticShipmentRequest and PublicAPICommodityV2.
 */

export const TAI_CREATE_TRAILER_TYPES = [
  "None",
  "Other",
  "Flatbed",
  "Refrigerated",
  "Van",
  "Sprinter Van | Dry",
  "Sprinter Van | Heat",
  "Sprinter Van | Reefer",
  "24 ft City Truck w/ Liftgate | Dry",
  "24 ft City Truck w/ Liftgate | Heat",
  "24 ft City Truck w/ Liftgate | Reefer",
  "28 ft City Truck w/ Liftgate | Dry",
  "28 ft City Truck w/ Liftgate | Heat",
  "28 ft City Truck w/ Liftgate | Reefer",
  "40 ft Straight Truck w/ Tailgate | Dry",
  "40 ft Straight Truck w/ Tailgate | Heat",
  "40 ft Straight Truck w/ Tailgate | Reefer",
  "48 ft Van | Dry",
  "48 ft Van | Heat",
  "48 ft Van | Reefer",
  "48 ft Van w/ Tailgate | Dry",
  "48 ft Van w/ Tailgate | Heat",
  "48 ft Van w/ Tailgate | Reefer",
  "53 ft Van | Dry Tandem",
  "53 ft Van | Dry Tandem w/ Liftgate",
  "53 ft Van | Dry Tandem Heat",
  "53 ft Van | Dry Tandem Reefer",
  "53 ft Van | Dry Tri-Axle",
  "53 ft Van | Heat Tri-Axle",
  "53 ft Van | Reefer Tri-Axle",
  "53 ft Van | Dry Quad-Axle",
  "53 ft Van | Heat Quad-Axle",
  "53 ft Van | Reefer Quad-Axle",
  "48 ft Flatbed",
  "48 ft Conestoga / Curtain Side",
  "53 ft Flatbed",
  "53 ft Conestoga / Curtain Side",
  "53 ft Super B",
  "53 ft Double Drop",
  "Low Boy / RG",
  "Power Only",
  "53 ft Van | Plate Trailer",
  "48 ft Step Deck",
  "53 ft Step Deck",
  "53 ft Van | Reefer",
  "Container - Standard",
  "Container - Heavy",
  "Container - OOG",
  "Container - Intermodal",
  "53 ft Van | Dry",
  "26 ft Straight Truck",
  "Van | Flatbed",
  "50 ft Flatbed",
  "50 ft Van | Dry",
  "53 ft Van | Air Ride",
  "32 ft HotShot",
  "36 ft HotShot",
  "40 ft HotShot",
  "24 ft Straight Truck",
  "48 ft Low Pro Step Deck",
  "53 ft Low Pro Step Deck",
  "48 ft Step Deck | Conestoga",
  "53 ft Step Deck | Conestoga",
  "48 ft Flatbed | Conestoga",
  "53 ft Flatbed | Conestoga",
  "Open Car Carrier",
  "Enclosed Car Carrier",
  "Tanker | Aluminum",
  "Tanker | Intermodal",
  "Tanker | Steel",
  "48 ft Dry Van | Reefer",
  "53 ft Dry Van | Reefer",
  "Hopper",
  "Dump",
  "12 ft Straight Truck",
  "48 ft Flatbed | Tarp",
  "50 ft Flatbed | Tarp",
  "53 ft Flatbed | Tarp",
  "Container - High Cube",
  "53 ft Reefer",
  "Livestock",
  "Vented | Van",
  "Toter",
  "Tanker | Fiberglass",
  "Tanker | Stainless Steel",
  "Tanker | Kosher",
  "Tanker | Multi-Compartment",
  "Tanker | Plastite-Lined",
  "Tanker | Pneumatic",
  "Tanker | Rubber-Lined",
  "Container | Flexibag",
  "Flatbed | Dry Tri-Axle",
  "Flatbed | Reefer Tri-Axle",
  "Flatbed | Maxi",
  "Landoll",
] as const;

export const TAI_CREATE_PACKAGING_TYPES = [
  "Pallet",
  "Skid",
  "Crate",
  "Bundle",
  "Box",
  "Carton",
  "Container",
  "Drum",
  "Piece",
  "Roll",
  "Truckload",
  "Bags",
  "Totes",
  "Gaylords",
  "Racks",
  "Loose",
  "Barrel",
  "Basket",
  "Break Bulk",
  "Case",
  "Chest",
  "Cylinder",
  "Lift Van",
  "Package",
  "Reel",
  "Tube",
  "Unit",
  "Pails",
  "Wheels",
  "U-Box",
  "HalfPallets",
  "Cart",
  "A-Frame",
  "Hopper",
  "Vehicle",
  "Tubs",
  "Gallons",
  "Bales",
  "Cans",
  "Jerricans",
  "Stacks",
  "Bins",
  "Batteries",
] as const;

export const TAI_CREATE_SERVICE_LEVELS = [
  "Normal",
  "Standard",
  "Standard Truckload",
  "Partial",
  "Team Service",
  "Drayage",
  "Intermodal",
  "Accelerated",
  "Time-Critical",
  "Exclusive Use",
  "Guaranteed",
  "Same Day",
  "Next Day",
  "2nd Day",
] as const;

export type TaiTrailerType = (typeof TAI_CREATE_TRAILER_TYPES)[number];
export type TaiPackagingType = (typeof TAI_CREATE_PACKAGING_TYPES)[number];
export type TaiServiceLevel = (typeof TAI_CREATE_SERVICE_LEVELS)[number];

const TRAILER_ALIASES: Record<string, TaiTrailerType> = {
  "dry van": "53 ft Van | Dry",
  "53 dry van": "53 ft Van | Dry",
  "53' dry van": "53 ft Van | Dry",
  "van": "53 ft Van | Dry",
  "flatbed": "48 ft Flatbed",
  "48 flatbed": "48 ft Flatbed",
  "48ft flatbed": "48 ft Flatbed",
  "48ft flatbed tarped": "48 ft Flatbed | Tarp",
  "53ft flatbed tarped": "53 ft Flatbed | Tarp",
  "step deck": "48 ft Step Deck",
  "stepdeck": "48 ft Step Deck",
  "reefer": "53 ft Reefer",
  "hotshot": "40 ft HotShot",
  "hot shot": "40 ft HotShot",
  "sprinter": "Sprinter Van | Dry",
  "conestoga": "48 ft Conestoga / Curtain Side",
};

const PACKAGING_ALIASES: Record<string, TaiPackagingType> = {
  pallets: "Pallet",
  plt: "Pallet",
  plts: "Pallet",
  skids: "Skid",
  crates: "Crate",
  bundles: "Bundle",
  boxes: "Box",
  cartons: "Carton",
  drums: "Drum",
  pieces: "Piece",
  pcs: "Piece",
  rolls: "Roll",
  containers: "Container",
};

export function normalizeTaiTrailerType(raw: string): TaiTrailerType | null {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  const direct = TAI_CREATE_TRAILER_TYPES.find((v) => v.toLowerCase() === trimmed.toLowerCase());
  if (direct) return direct;
  return TRAILER_ALIASES[trimmed.toLowerCase()] ?? null;
}

export function normalizeTaiPackagingType(raw: string): TaiPackagingType | null {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "Pallet";
  const direct = TAI_CREATE_PACKAGING_TYPES.find((v) => v.toLowerCase() === trimmed.toLowerCase());
  if (direct) return direct;
  return PACKAGING_ALIASES[trimmed.toLowerCase()] ?? null;
}

export function normalizeTaiServiceLevel(raw: string): TaiServiceLevel {
  const trimmed = String(raw || "").trim();
  const direct = TAI_CREATE_SERVICE_LEVELS.find((v) => v.toLowerCase() === trimmed.toLowerCase());
  return direct ?? "Normal";
}
