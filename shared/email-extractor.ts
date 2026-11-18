import { extractContainerNumbers } from "./container-extractor";
import type { LoadEntry, LoadEntryItem, LoadEntryStop } from "./load-entry";
import type { CustomerOption, SavedFacility } from "./tai-webhook-schema";

export interface EmailExtractInput {
  subject?: string;
  sender?: string;
  senderName?: string;
  bodyText: string;
}

export interface EmailExtractResult {
  entry: LoadEntry;
  summary: string;
  alternateEquipment: string[];
  containerNumber?: string;
}

const KNOWN_CITY_STATE_ZIPS: Record<string, { streetAddress?: string; companyName?: string; zipCode: string }> = {
  "ZELIENOPLE|PA": { companyName: "Larkin Refractory (Zelienople)", streetAddress: "300 Tomlinson Drive", zipCode: "16063" },
  "BEAVER FALLS|PA": { companyName: "CeramSource, Inc.", streetAddress: "400 Enterprise Drive", zipCode: "15010" },
  "MONONGAHELA|PA": { companyName: "Management & Consulting", streetAddress: "626 Riverview Rd.", zipCode: "15063" },
  "LITHONIA|GA": { companyName: "Larkin Refractory Solutions", streetAddress: "2331 Varkel Way", zipCode: "30058" },
  "WEST MONROE|LA": { companyName: "West Monroe Paper Mill", streetAddress: "810 Downing Pines Rd", zipCode: "71292" },
  "WILMINGTON|CA": { companyName: "IMC Wilmington Yard", streetAddress: "1304 E Lomita Blvd", zipCode: "90744" },
  "MEMPHIS|TN": { companyName: "IMC Memphis Depot", streetAddress: "5707 E Holmes Rd", zipCode: "38141" },
  "ETHEL|LA": { zipCode: "70730" },
  "PHOENIX|AZ": { zipCode: "85043" },
  "NORTH CHARLESTON|SC": { zipCode: "29405" },
  "HOUSTON|TX": { zipCode: "77013" },
};

const VALID_STATES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY",
  "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND",
  "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
]);

function addDaysIso(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function parseIsoDateFromText(text: string, fallbackDaysAhead = 1): string {
  const iso = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];

  const slash = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}|\d{2}))?\b/);
  if (slash) {
    const mm = slash[1].padStart(2, "0");
    const dd = slash[2].padStart(2, "0");
    const rawYr = slash[3];
    const yr = rawYr ? (rawYr.length === 2 ? `20${rawYr}` : rawYr) : String(new Date().getFullYear());
    return `${yr}-${mm}-${dd}`;
  }

  if (/\btoday\b/i.test(text)) return addDaysIso(0);
  if (/\btomorrow\b/i.test(text)) return addDaysIso(1);
  return addDaysIso(fallbackDaysAhead);
}

function extractEquipment(combined: string): {
  trailerType: string;
  equipmentLength: string;
  alternates: string[];
  tarpNote: string;
} {
  const t = combined.toLowerCase();
  const has4ftTarp = /\b4\s*(?:'|ft|foot)\s*tarps?\b/i.test(t);
  const has8ftTarp = /\b8\s*(?:'|ft|foot)\s*tarps?\b/i.test(t);
  const hasTarp = has4ftTarp || has8ftTarp || /\btarp(?:s|ed|ing)?\b/i.test(t);
  const hasFlatbed = /\b(?:flatbed|flat\s*bed|fb)\b/i.test(t);
  const hasConestoga = /\b(?:conestoga|curtain\s*side|curtainside|roll\s*tite)\b/i.test(t);
  const tarpNote = has4ftTarp ? "4ft Tarps Required" : has8ftTarp ? "8ft Tarps Required" : hasTarp ? "Tarps Required" : "";

  if (hasFlatbed && hasConestoga) {
    // Email allows either flatbed (with tarps) or conestoga — prefer tarp flatbed if tarp specs given, and surface Conestoga as 1-click alternate
    const primary = hasTarp
      ? /\b53\b/.test(t)
        ? "53 ft Flatbed | Tarp"
        : "48 ft Flatbed | Tarp"
      : "53 ft Conestoga / Curtain Side";
    const alternates = [
      primary === "48 ft Flatbed | Tarp" ? "53 ft Conestoga / Curtain Side" : "48 ft Flatbed | Tarp",
      "48 ft Conestoga / Curtain Side",
      "53 ft Flatbed | Tarp",
      "53 ft Flatbed",
    ];
    return { trailerType: primary, equipmentLength: primary.startsWith("53") ? "53" : "48", alternates, tarpNote };
  }

  if (hasConestoga) {
    const primary = /\b48\b/.test(t) ? "48 ft Conestoga / Curtain Side" : "53 ft Conestoga / Curtain Side";
    return {
      trailerType: primary,
      equipmentLength: primary.startsWith("48") ? "48" : "53",
      alternates: ["48 ft Flatbed | Tarp", "53 ft Flatbed | Tarp", "48 ft Conestoga / Curtain Side", "53 ft Conestoga / Curtain Side"],
      tarpNote,
    };
  }

  if (hasFlatbed) {
    const is53 = /\b53\b/.test(t);
    const primary = hasTarp
      ? is53
        ? "53 ft Flatbed | Tarp"
        : "48 ft Flatbed | Tarp"
      : is53
      ? "53 ft Flatbed"
      : "48 ft Flatbed";
    return {
      trailerType: primary,
      equipmentLength: is53 ? "53" : "48",
      alternates: ["53 ft Flatbed | Tarp", "53 ft Conestoga / Curtain Side", "48 ft Flatbed", "53 ft Van | Dry"],
      tarpNote,
    };
  }

  if (/\b(?:step\s*deck|stepdeck|drop\s*deck)\b/i.test(t)) {
    const is48 = /\b48\b/.test(t);
    return {
      trailerType: is48 ? "48 ft Step Deck" : "53 ft Step Deck",
      equipmentLength: is48 ? "48" : "53",
      alternates: ["48 ft Flatbed | Tarp", "53 ft Double Drop"],
      tarpNote,
    };
  }

  if (/\b(?:reefer|refrigerated|temp\s*controlled)\b/i.test(t)) {
    return {
      trailerType: "53 ft Van | Reefer",
      equipmentLength: "53",
      alternates: ["53 ft Van | Dry"],
      tarpNote: "",
    };
  }

  if (/\bhot\s*shot\b/i.test(t)) {
    return {
      trailerType: "40 ft HotShot",
      equipmentLength: "40",
      alternates: ["48 ft Flatbed", "26 ft Straight Truck"],
      tarpNote,
    };
  }

  if (/\b(?:drayage|container|intermodal)\b/i.test(t)) {
    return {
      trailerType: /\bhigh\s*cube\b/i.test(t) ? "Container - High Cube" : "Container - Standard",
      equipmentLength: "40",
      alternates: ["Power Only", "53 ft Van | Dry"],
      tarpNote: "",
    };
  }

  return {
    trailerType: "53 ft Van | Dry",
    equipmentLength: "53",
    alternates: ["48 ft Flatbed | Tarp", "53 ft Conestoga / Curtain Side", "53 ft Van | Reefer"],
    tarpNote,
  };
}

interface ParsedStopCandidate {
  companyName: string;
  streetAddress: string;
  city: string;
  state: string;
  zipCode: string;
}

function extractAddressCandidates(
  text: string,
  facilities: SavedFacility[],
): ParsedStopCandidate[] {
  const candidates: ParsedStopCandidate[] = [];
  const seen = new Set<string>();

  // 1. Full street + city + state + zip matches (e.g. "300 Tomlinson Drive, Zelienople, PA 16063")
  const fullAddrRegex =
    /(?:([A-Za-z0-9][A-Za-z0-9 .,'&/-]{2,55}?)\s*(?:,|at|@|-|—|\n)\s*)?(\d{1,6}\s+[A-Za-z0-9 .#-]{3,50}?(?:Dr|Drive|Way|Rd|Road|St|Street|Ave|Avenue|Blvd|Boulevard|Pkwy|Parkway|Ln|Lane|Ct|Circle|Hwy|Industrial)[^,\n]*)[,\s]+([A-Za-z .'-]{2,30})[,\s]+([A-Z]{2})\s*,?\s*(\d{5})\b/gi;

  for (const m of text.matchAll(fullAddrRegex)) {
    const cleanedCompany = (m[1] || "")
      .replace(/^(?:pickup|pick\s*up|pick\s*\d+|drop|deliver(?:y)?(?:\s*to)?|shipper|consignee|stop\s*\d+|from|to)\s*:?\s*/i, "")
      .trim();
    const rawCompany =
      cleanedCompany.length >= 3 &&
      cleanedCompany.length <= 48 &&
      !/\b(?:please|tomorrow|today|need|quote|send|book|take|tarps?|flatbed|conestoga|hello|team|hi)\b/i.test(cleanedCompany)
        ? cleanedCompany
        : "";
    const streetAddress = (m[2] || "").trim().replace(/,$/, "");
    const city = (m[3] || "").trim();
    const state = (m[4] || "").toUpperCase();
    const zipCode = (m[5] || "").trim();
    if (!VALID_STATES.has(state)) continue;
    const key = `${city.toUpperCase()}|${state}|${zipCode}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const facHit = facilities.find(
      (f) => f.zipCode.startsWith(zipCode) && f.city.toUpperCase() === city.toUpperCase(),
    );
    const known = KNOWN_CITY_STATE_ZIPS[`${city.toUpperCase()}|${state}`];
    candidates.push({
      companyName: rawCompany || facHit?.companyName || known?.companyName || `${city}, ${state}`,
      streetAddress: streetAddress || facHit?.streetAddress || known?.streetAddress || "",
      city,
      state,
      zipCode,
    });
  }

  // 2. Fallback: "City, ST ZIP" or "City ST ZIP"
  const cityStateZipRegex = /\b([A-Za-z][A-Za-z .'-]{2,28})[,\s]+([A-Z]{2})\s+(\d{5})\b/g;
  for (const m of text.matchAll(cityStateZipRegex)) {
    const city = m[1].trim().replace(/^(?:in|to|from|at)\s+/i, "");
    const state = m[2].toUpperCase();
    const zipCode = m[3];
    if (!VALID_STATES.has(state)) continue;
    const key = `${city.toUpperCase()}|${state}|${zipCode}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const facHit = facilities.find((f) => f.zipCode.startsWith(zipCode));
    const known = KNOWN_CITY_STATE_ZIPS[`${city.toUpperCase()}|${state}`];
    candidates.push({
      companyName: facHit?.companyName || known?.companyName || `${city}, ${state}`,
      streetAddress: facHit?.streetAddress || known?.streetAddress || "",
      city,
      state,
      zipCode,
    });
  }

  // 3. Fallback: known city names like "Zelienople PA" -> "Lithonia GA"
  if (candidates.length < 2) {
    const cityOnlyRegex = /\b([A-Za-z][A-Za-z .'-]{2,26})[,\s]+([A-Z]{2})\b/g;
    for (const m of text.matchAll(cityOnlyRegex)) {
      const city = m[1].trim().replace(/^(?:from|to|in|at|into)\s+/i, "");
      const state = m[2].toUpperCase();
      if (!VALID_STATES.has(state)) continue;
      const known = KNOWN_CITY_STATE_ZIPS[`${city.toUpperCase()}|${state}`];
      const facHit = facilities.find(
        (f) => f.city.toUpperCase() === city.toUpperCase() && f.state.toUpperCase() === state,
      );
      const zipCode = facHit?.zipCode?.slice(0, 5) || known?.zipCode;
      if (!zipCode) continue;
      const key = `${city.toUpperCase()}|${state}|${zipCode}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        companyName: facHit?.companyName || known?.companyName || `${city}, ${state}`,
        streetAddress: facHit?.streetAddress || known?.streetAddress || "",
        city,
        state,
        zipCode,
      });
    }
  }

  return candidates;
}

function matchCustomer(
  combined: string,
  sender: string,
  customers: CustomerOption[],
): { name: string; taiOrganizationId: string } {
  const lower = combined.toLowerCase();
  const senderLower = sender.toLowerCase();

  for (const c of customers) {
    const clean = c.name.trim();
    if (clean.length < 3) continue;
    if (lower.includes(clean.toLowerCase())) {
      return { name: clean, taiOrganizationId: c.taiOrgId || "" };
    }
    const firstWord = clean.split(/[\s,]+/)[0]?.toLowerCase() || "";
    if (firstWord.length >= 5 && (senderLower.includes(firstWord) || lower.includes(firstWord))) {
      return { name: clean, taiOrganizationId: c.taiOrgId || "" };
    }
  }

  if (senderLower.includes("larkin") || lower.includes("larkin") || lower.includes("tomlinson") || lower.includes("varkel")) {
    return { name: "LARKIN REFRACTORY SOLUTIONS", taiOrganizationId: "698049" };
  }
  if (senderLower.includes("imc") || lower.includes("imc logistics")) {
    return { name: "IMC LOGISTICS", taiOrganizationId: "737173" };
  }
  return { name: "", taiOrganizationId: "" };
}

export function extractLoadEntryFromEmail(
  input: EmailExtractInput,
  customers: CustomerOption[] = [],
  facilities: SavedFacility[] = [],
): EmailExtractResult {
  const subject = String(input.subject || "").trim();
  const sender = String(input.sender || "").trim();
  const body = String(input.bodyText || "").trim();
  const combined = `${subject}\n${body}`;

  const customer = matchCustomer(combined, sender, customers);
  const candidates = extractAddressCandidates(combined, facilities);
  const equip = extractEquipment(combined);
  const containers = extractContainerNumbers(combined);

  // Extract PO / Ref #
  const poMatch =
    combined.match(/\bP26\d{4}[A-Z0-9]*(?:\s*\/\s*P26\d{4}[A-Z0-9]*)?/i) ||
    combined.match(/\b(?:Customer\s*PO|PO)\s*#?\s*:?\s*([A-Z0-9][A-Z0-9/_ -]{2,24})/i);
  const customerPO = poMatch ? (poMatch[1] || poMatch[0]).trim() : containers[0] || "";

  // Extract Weight in lbs
  const wtMatches = [...combined.matchAll(/(\d{1,3}(?:,\d{3})+|\d{4,6})\s*(?:lbs?|#|pounds?)\b/gi)];
  const totalWeight = wtMatches.reduce((acc, m) => acc + Number(m[1].replace(/,/g, "")), 0) || 40000;

  // Extract Pieces & Packaging
  const pkgMatch = combined.match(/\b(\d{1,4})\s+(pallets?|skids?|crates?|cartons?|boxes?|coils?|bundles?|drums?|containers?)\b/i);
  const piecesTotal = pkgMatch ? Math.max(1, Number(pkgMatch[1])) : 1;
  const rawPkg = (pkgMatch?.[2] || "Pallet").toLowerCase();
  const packagingType = rawPkg.startsWith("container")
    ? "Container"
    : rawPkg.startsWith("skid")
    ? "Skid"
    : rawPkg.startsWith("crate")
    ? "Crate"
    : rawPkg.startsWith("carton") || rawPkg.startsWith("box")
    ? "Carton"
    : rawPkg.startsWith("coil")
    ? "Coil"
    : rawPkg.startsWith("bundle")
    ? "Bundle"
    : "Pallet";

  // Extract Commodity Description
  let commodityDesc = "";
  const explicitCommMatch = combined.match(/(?:Commodity|Product|Material|Freight|Description)\s*[:=-]\s*([^\n.;]+)/i);
  const dashAfterPallets = combined.match(/\b\d{1,4}\s+(?:pallets?|skids?|crates?|cartons?)\s*[-–—of]+\s*([^\n.;]+(?:\band\b[^\n.;]+)?)/i);
  if (explicitCommMatch) {
    commodityDesc = explicitCommMatch[1].trim();
  } else if (dashAfterPallets) {
    commodityDesc = dashAfterPallets[1].trim();
  } else if (/refractory|fire\s*brick|castable|ceramic\s*fiber/i.test(combined)) {
    commodityDesc = "Refractory brick and Insulating Fire Brick";
  } else if (containers[0]) {
    commodityDesc = `Containerized Freight (${containers[0]})`;
  } else {
    commodityDesc = "General Freight";
  }

  // Extract Sell / Buy rate if stated
  const rateMatch = combined.match(/\b(?:quote|rate|sell|all[- ]in)\s*(?:at|of|:|\bis\b)?\s*\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/i);
  const linehaulSell = rateMatch ? Number(rateMatch[1].replace(/,/g, "")) : 0;

  // Build Ready/Delivery dates
  const puDate = parseIsoDateFromText(combined, 1);
  const delDate = addDaysIso(Math.max(2, puDate === addDaysIso(0) ? 1 : 2));

  const stops: LoadEntryStop[] =
    candidates.length >= 2
      ? candidates.map((c, idx) => ({
          stopType:
            idx === 0 ? "First Pickup" : idx === candidates.length - 1 ? "Last Drop" : "Pick",
          companyName: c.companyName,
          streetAddress: c.streetAddress,
          city: c.city,
          state: c.state,
          zipCode: c.zipCode,
          country: "USA",
          contactName: "",
          phone: "",
          instructions: idx === 0 && equip.tarpNote ? equip.tarpNote : "",
          readyDate: idx === candidates.length - 1 ? delDate : puDate,
          timeOpen: idx === 0 ? "08:00" : "09:00",
          timeClose: idx === 0 ? "15:00" : "16:00",
          appointmentRequired: false,
          savedFacilityMatched: Boolean(c.streetAddress),
        }))
      : [
          {
            stopType: "First Pickup",
            companyName: candidates[0]?.companyName || customer.name || "",
            streetAddress: candidates[0]?.streetAddress || "",
            city: candidates[0]?.city || "",
            state: candidates[0]?.state || "",
            zipCode: candidates[0]?.zipCode || "",
            country: "USA",
            contactName: "",
            phone: "",
            readyDate: puDate,
            timeOpen: "08:00",
            timeClose: "15:00",
            appointmentRequired: false,
            instructions: equip.tarpNote,
            savedFacilityMatched: Boolean(candidates[0]?.streetAddress),
          },
          {
            stopType: "Last Drop",
            companyName: candidates[1]?.companyName || "",
            streetAddress: candidates[1]?.streetAddress || "",
            city: candidates[1]?.city || "",
            state: candidates[1]?.state || "",
            zipCode: candidates[1]?.zipCode || "",
            country: "USA",
            contactName: "",
            phone: "",
            readyDate: delDate,
            timeOpen: "09:00",
            timeClose: "16:00",
            appointmentRequired: false,
            instructions: "",
            savedFacilityMatched: Boolean(candidates[1]?.streetAddress),
          },
        ];

  const items: LoadEntryItem[] = [
    {
      description: `${piecesTotal} ${packagingType.toLowerCase()}${piecesTotal > 1 ? "s" : ""} - ${commodityDesc}`,
      packagingType,
      handlingQuantity: piecesTotal,
      piecesTotal,
      weightTotal: totalWeight,
      hazardousMaterial: false,
      freightClass: "No Class",
      referenceNumber: customerPO,
    },
  ];

  const instructionsParts = [
    equip.tarpNote,
    /\bmacropoint\b/i.test(combined) ? "MacroPoint Tracking" : "",
    /\bcall\s*1\s*hr/i.test(combined) ? "Call 1 hr Prior" : "",
  ].filter(Boolean);

  const entry: LoadEntry = {
    shipmentType: /\b(?:drayage|container)\b/i.test(combined) ? "Drayage" : "Truckload",
    status: "Committed",
    customer,
    references: {
      customerPO,
      bolNumber: customerPO,
      invoiceRef: "",
      carrierProNumber: "",
      pickupNumber: "",
    },
    stops,
    items,
    accessorials: equip.tarpNote
      ? [{ scope: "pickup", code: "TARP", name: "Tarp Fee", sell: 0, buy: 0 }]
      : [],
    equipment: {
      trailerSize: "Full",
      trailerType: equip.trailerType,
      equipmentLength: equip.equipmentLength,
      mileage: 0,
      stackable: false,
    },
    pricing: {
      linehaulSell,
      fuelSell: 0,
      linehaulBuy: 0,
      fuelBuy: 0,
    },
    carrier: {
      name: "",
      serviceLevel: "Normal",
    },
    specialInstructions: instructionsParts.join(" | "),
    sendToTai: true,
  };

  const first = stops[0];
  const last = stops[stops.length - 1];
  const summary = `Extracted ${first.city}, ${first.state} ${first.zipCode} → ${last.city}, ${last.state} ${last.zipCode} (${equip.trailerType} · ${piecesTotal} ${packagingType} · ${totalWeight.toLocaleString()} lbs)`;

  return {
    entry,
    summary,
    alternateEquipment: equip.alternates,
    containerNumber: containers[0],
  };
}
