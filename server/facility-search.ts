import type { OpsShipment, SavedFacility } from "../shared/tai-webhook-schema";

export type FacilityCandidateSource =
  | "TAI Verified Facility"
  | "Google Maps Places"
  | "OpenStreetMap Places";

export interface FacilitySearchCandidate {
  id: string;
  companyName: string;
  streetAddress: string;
  city: string;
  state: string;
  zipCode: string;
  phone: string;
  source: FacilityCandidateSource;
  confidence: number;
  mapsUrl: string;
}

export interface FacilitySearchParams {
  query?: string;
  q?: string;
  companyName?: string;
  streetAddress?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  limit?: number;
}

export interface FacilitySearchResult {
  ok: true;
  query: string;
  googleEnabled: boolean;
  candidates: FacilitySearchCandidate[];
}

interface DirectoryFacility {
  id: string;
  companyName: string;
  aliases?: string[];
  streetAddress: string;
  city: string;
  state: string;
  zipCode: string;
  phone: string;
  source: FacilityCandidateSource;
}

const CURATED_INDUSTRIAL_DIRECTORY: DirectoryFacility[] = [
  {
    id: "curated-resco-greensboro-nc",
    companyName: "RESCO PRODUCTS INC",
    aliases: ["RESCO", "RESCO PRODUCTS", "RESCO PRODUCTS INC", "GREENSBORO NC"],
    streetAddress: "4521 NORTHLINE DR",
    city: "GREENSBORO",
    state: "NC",
    zipCode: "27409",
    phone: "",
    source: "TAI Verified Facility",
  },
  {
    id: "curated-resco-east-canton-oh",
    companyName: "Resco Products Inc",
    aliases: ["RESCO", "RESCO PRODUCTS", "RESCO PRODUCTS INC", "EAST CANTON OH"],
    streetAddress: "6878 Osnaburg Street Southeast",
    city: "East Canton",
    state: "OH",
    zipCode: "44730",
    phone: "(330) 488-1226",
    source: "Google Maps Places",
  },
  {
    id: "curated-resco-tarentum-pa",
    companyName: "Resco Products Inc",
    aliases: ["RESCO", "RESCO PRODUCTS", "RESCO PRODUCTS INC", "TARENTUM PA", "WORLDWIDE REFRACTORIES"],
    streetAddress: "6 Center St",
    city: "Tarentum",
    state: "PA",
    zipCode: "15084",
    phone: "(724) 224-8800",
    source: "Google Maps Places",
  },
  {
    id: "curated-resco-hammond-in",
    companyName: "Resco Products Inc",
    aliases: ["RESCO", "RESCO PRODUCTS", "RESCO PRODUCTS INC", "HAMMOND IN"],
    streetAddress: "5501 Kennedy Ave",
    city: "Hammond",
    state: "IN",
    zipCode: "46320",
    phone: "(219) 844-7830",
    source: "Google Maps Places",
  },
  {
    id: "curated-resco-piedmont-al",
    companyName: "Resco Products Inc",
    aliases: ["RESCO", "RESCO PRODUCTS", "RESCO PRODUCTS INC", "PIEDMONT AL"],
    streetAddress: "",
    city: "Piedmont",
    state: "AL",
    zipCode: "36272",
    phone: "",
    source: "Google Maps Places",
  },
  {
    id: "curated-larkin-lithonia-ga",
    companyName: "Larkin Refractory Solutions",
    aliases: ["LARKIN", "LARKIN REFRACTORY", "LITHONIA GA"],
    streetAddress: "2331 Varkel Way",
    city: "Lithonia",
    state: "GA",
    zipCode: "30058",
    phone: "(678) 336-7090",
    source: "TAI Verified Facility",
  },
  {
    id: "curated-larkin-zelienople-pa",
    companyName: "Larkin Refractory (Zelienople)",
    aliases: ["LARKIN", "LARKIN REFRACTORY", "LARKIN REFRACTORY SOLUTIONS", "ZELIENOPLE PA"],
    streetAddress: "300 Tomlinson Drive",
    city: "Zelienople",
    state: "PA",
    zipCode: "16063",
    phone: "",
    source: "TAI Verified Facility",
  },
  {
    id: "curated-ceramsource-beaver-falls-pa",
    companyName: "CeramSource, Inc.",
    aliases: ["CERAMSOURCE", "BEAVER FALLS PA"],
    streetAddress: "400 Enterprise Drive",
    city: "Beaver Falls",
    state: "PA",
    zipCode: "15010",
    phone: "(732) 257-5002",
    source: "TAI Verified Facility",
  },
  {
    id: "curated-mgmt-consulting-monongahela-pa",
    companyName: "Management & Consulting",
    aliases: ["MANAGEMENT AND CONSULTING", "MONONGAHELA PA"],
    streetAddress: "626 Riverview Rd.",
    city: "Monongahela",
    state: "PA",
    zipCode: "15063",
    phone: "(724) 258-5500",
    source: "TAI Verified Facility",
  },
  {
    id: "curated-imc-wilmington-ca",
    companyName: "IMC Wilmington Yard",
    aliases: ["IMC", "IMC LOGISTICS", "IMC PACIFIC", "WILMINGTON CA"],
    streetAddress: "1304 E Lomita Blvd",
    city: "Wilmington",
    state: "CA",
    zipCode: "90744",
    phone: "(424) 349-1113",
    source: "TAI Verified Facility",
  },
  {
    id: "curated-imc-memphis-tn",
    companyName: "IMC Memphis Depot",
    aliases: ["IMC", "IMC LOGISTICS", "MEMPHIS TN"],
    streetAddress: "5707 E Holmes Rd",
    city: "Memphis",
    state: "TN",
    zipCode: "38141",
    phone: "(901) 555-0140",
    source: "TAI Verified Facility",
  },
  {
    id: "curated-quality-sausage-dallas-tx",
    companyName: "QUALITY SAUSAGE COMPANY",
    aliases: ["QUALITY SAUSAGE", "QSC", "QSC DALLAS", "DALLAS TX"],
    streetAddress: "1925 LONE STAR DR",
    city: "DALLAS",
    state: "TX",
    zipCode: "75212",
    phone: "(214) 634-3400",
    source: "TAI Verified Facility",
  },
  {
    id: "curated-west-monroe-paper-la",
    companyName: "West Monroe Paper Mill",
    aliases: ["WEST MONROE PAPER", "WEST MONROE LA"],
    streetAddress: "810 Downing Pines Rd",
    city: "West Monroe",
    state: "LA",
    zipCode: "71292",
    phone: "(318) 362-2000",
    source: "TAI Verified Facility",
  },
];

const US_CA_STATE_NAME_TO_CODE: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  "district of columbia": "DC",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "puerto rico": "PR",
  ontario: "ON",
  quebec: "QC",
  "british columbia": "BC",
  alberta: "AB",
  manitoba: "MB",
  saskatchewan: "SK",
  "nova scotia": "NS",
  "new brunswick": "NB",
};

const VALID_STATE_CODES = new Set(Object.values(US_CA_STATE_NAME_TO_CODE));

const ZIP_FIRST_DIGIT_STATES: Record<string, Set<string>> = {
  "0": new Set(["CT", "MA", "ME", "NH", "NJ", "PR", "RI", "VT"]),
  "1": new Set(["DE", "NY", "PA"]),
  "2": new Set(["DC", "MD", "NC", "SC", "VA", "WV"]),
  "3": new Set(["AL", "FL", "GA", "MS", "TN"]),
  "4": new Set(["IN", "KY", "MI", "OH"]),
  "5": new Set(["IA", "MN", "MT", "ND", "SD", "WI"]),
  "6": new Set(["IL", "KS", "MO", "NE"]),
  "7": new Set(["AR", "LA", "OK", "TX"]),
  "8": new Set(["AZ", "CO", "ID", "NM", "NV", "UT", "WY"]),
  "9": new Set(["AK", "CA", "HI", "OR", "WA"]),
};

const STREET_ABBREVS: Record<string, string> = {
  st: "street",
  str: "street",
  rd: "road",
  dr: "drive",
  ave: "avenue",
  av: "avenue",
  blvd: "boulevard",
  pkwy: "parkway",
  ln: "lane",
  ct: "court",
  hwy: "highway",
  cir: "circle",
  pl: "place",
  n: "north",
  s: "south",
  e: "east",
  w: "west",
  ne: "northeast",
  nw: "northwest",
  se: "southeast",
  sw: "southwest",
};

const GENERIC_COMPANY_TOKENS = new Set([
  "inc",
  "incorporated",
  "llc",
  "corp",
  "corporation",
  "co",
  "company",
  "ltd",
  "limited",
  "lp",
  "llp",
  "plc",
  "products",
  "solutions",
  "services",
  "logistics",
  "yard",
  "depot",
  "terminal",
  "plant",
  "warehouse",
  "distribution",
  "center",
  "the",
  "and",
]);

/** Builds a clickable Google Maps search URL from facility address parts. */
export function buildGoogleMapsUrl(parts: {
  companyName?: string;
  streetAddress?: string;
  city?: string;
  state?: string;
  zipCode?: string;
}): string {
  const joined = [
    parts.companyName,
    parts.streetAddress,
    parts.city,
    parts.state,
    parts.zipCode,
  ]
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(joined)}`;
}

function normalizeStateCode(raw?: string): string {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  const iso = trimmed.match(/^(?:US|CA)-([A-Za-z]{2})$/i);
  if (iso) return iso[1].toUpperCase();
  const upper = trimmed.toUpperCase();
  if (upper.length === 2 && VALID_STATE_CODES.has(upper)) return upper;
  return US_CA_STATE_NAME_TO_CODE[trimmed.toLowerCase()] || (upper.length === 2 ? upper : "");
}

function extractZip5(raw?: string): string {
  const s = String(raw || "").trim();
  const m = s.match(/\b(\d{5})(?:-\d{4})?\b/);
  if (m) return m[1];
  return s;
}

function normalizeText(raw?: string): string {
  return String(raw || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCompanyName(raw?: string): string {
  return String(raw || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(?:inc|incorporated|llc|l\.l\.c|corp|corporation|co|company|ltd|limited|lp|llp|plc)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeStreet(raw?: string): string {
  return normalizeText(raw)
    .split(" ")
    .filter(Boolean)
    .map((tok) => STREET_ABBREVS[tok] || tok)
    .join(" ");
}

function brandTokens(normalizedCompany: string): string[] {
  const all = normalizedCompany.split(" ").filter(Boolean);
  const specific = all.filter((t) => !GENERIC_COMPANY_TOKENS.has(t));
  return specific.length > 0 ? specific : all;
}

function isZipRoughlyCompatibleWithState(state: string, zip5: string): boolean {
  if (!state || !/^\d{5}$/.test(zip5)) return true;
  const statesForFirstDigit = ZIP_FIRST_DIGIT_STATES[zip5[0]];
  if (!statesForFirstDigit) return true;
  return statesForFirstDigit.has(state.toUpperCase());
}

function sourcePriority(source: FacilityCandidateSource): number {
  if (source === "TAI Verified Facility") return 3;
  if (source === "Google Maps Places") return 2;
  return 1;
}

function buildDirectoryPool(
  savedFacilities: SavedFacility[],
  shipments: OpsShipment[],
): DirectoryFacility[] {
  const rawPool: DirectoryFacility[] = [...CURATED_INDUSTRIAL_DIRECTORY];

  for (const fac of savedFacilities) {
    if (!fac || !String(fac.companyName || "").trim()) continue;
    rawPool.push({
      id: fac.id ? `saved-${fac.id}` : `saved-${normalizeCompanyName(fac.companyName)}-${extractZip5(fac.zipCode)}`,
      companyName: String(fac.companyName).trim(),
      streetAddress: String(fac.streetAddress || "").trim(),
      city: String(fac.city || "").trim(),
      state: normalizeStateCode(fac.state),
      zipCode: extractZip5(fac.zipCode),
      phone: String(fac.phone || "").trim(),
      source: "TAI Verified Facility",
    });
  }

  for (const shipment of shipments) {
    for (const [stopIdx, stop] of (shipment.stops || []).entries()) {
      const companyName = String(stop.companyName || "").trim();
      const streetAddress = String(stop.streetAddress || "").trim();
      const city = String(stop.city || "").trim();
      const state = normalizeStateCode(stop.state);
      const zipCode = extractZip5(stop.zipCode);
      if (!companyName || (!streetAddress && (!city || !state || !zipCode))) continue;
      if (!streetAddress && /^(?:shipper warehouse|consignee|customer)$/i.test(companyName)) continue;

      rawPool.push({
        id: `ship-${shipment.id}-stop-${stopIdx}`,
        companyName,
        streetAddress,
        city,
        state,
        zipCode,
        phone: String(stop.phone || "").trim(),
        source: "TAI Verified Facility",
      });
    }
  }

  return deduplicateDirectory(rawPool);
}

function sameLocationRecord(a: DirectoryFacility, b: DirectoryFacility): boolean {
  const aState = normalizeStateCode(a.state);
  const bState = normalizeStateCode(b.state);
  const aCity = normalizeText(a.city);
  const bCity = normalizeText(b.city);
  const aZip = extractZip5(a.zipCode);
  const bZip = extractZip5(b.zipCode);
  const aStreet = normalizeStreet(a.streetAddress);
  const bStreet = normalizeStreet(b.streetAddress);
  const aComp = normalizeCompanyName(a.companyName);
  const bComp = normalizeCompanyName(b.companyName);

  if (aState !== bState) return false;
  if (aStreet && bStreet) {
    if (aStreet === bStreet && (aCity === bCity || (aZip && aZip === bZip))) {
      const aBrand = brandTokens(aComp)[0];
      const bBrand = brandTokens(bComp)[0];
      return !aBrand || !bBrand || aBrand === bBrand || aComp.includes(bComp) || bComp.includes(aComp);
    }
    return false;
  }
  return aComp === bComp && aCity === bCity && aZip === bZip;
}

function mergeDirectoryPair(existing: DirectoryFacility, incoming: DirectoryFacility): DirectoryFacility {
  const preferIncoming =
    sourcePriority(incoming.source) > sourcePriority(existing.source) ||
    (sourcePriority(incoming.source) === sourcePriority(existing.source) &&
      Boolean(incoming.streetAddress) &&
      !existing.streetAddress);

  const primary = preferIncoming ? incoming : existing;
  const secondary = preferIncoming ? existing : incoming;

  const aliases = Array.from(
    new Set([...(existing.aliases || []), ...(incoming.aliases || [])].filter(Boolean)),
  );

  return {
    ...primary,
    streetAddress: primary.streetAddress || secondary.streetAddress,
    city: primary.city || secondary.city,
    state: primary.state || secondary.state,
    zipCode: primary.zipCode || secondary.zipCode,
    phone: primary.phone || secondary.phone,
    aliases: aliases.length > 0 ? aliases : undefined,
  };
}

function deduplicateDirectory(items: DirectoryFacility[]): DirectoryFacility[] {
  const out: DirectoryFacility[] = [];
  for (const item of items) {
    const idx = out.findIndex((existing) => sameLocationRecord(existing, item));
    if (idx >= 0) {
      out[idx] = mergeDirectoryPair(out[idx], item);
    } else {
      out.push(item);
    }
  }
  return out;
}

function assessCompanyMatch(
  queryCompany: string,
  cand: DirectoryFacility,
): "exact" | "strong" | "partial" | "none" {
  const qNorm = normalizeCompanyName(queryCompany);
  if (!qNorm) return "none";

  const cNorm = normalizeCompanyName(cand.companyName);
  const aliasNorms = (cand.aliases || []).map((a) => normalizeCompanyName(a)).filter(Boolean);

  if (cNorm === qNorm || aliasNorms.some((a) => a === qNorm)) {
    return "exact";
  }

  const qBrands = brandTokens(qNorm);
  const cBrands = brandTokens(cNorm);
  if (
    qBrands.length > 0 &&
    cBrands.length > 0 &&
    qBrands.length === cBrands.length &&
    qBrands.every((t, idx) => cBrands[idx] === t)
  ) {
    return "exact";
  }

  if (
    qNorm.length >= 3 &&
    (cNorm.startsWith(qNorm) ||
      qNorm.startsWith(cNorm) ||
      aliasNorms.some((a) => a === qNorm || a.startsWith(qNorm)) ||
      (qBrands.length >= 1 &&
        qBrands.every((tok) => cBrands.includes(tok) || aliasNorms.some((a) => a.split(" ").includes(tok)))))
  ) {
    return "strong";
  }

  if (qNorm.length >= 3 && (cNorm.includes(qNorm) || aliasNorms.some((a) => a.includes(qNorm)))) {
    return "partial";
  }

  return "none";
}

function tokenMatchesField(token: string, haystack: string, words: Set<string>): boolean {
  if (token.length <= 2) {
    return words.has(token);
  }
  return words.has(token) || haystack.includes(token);
}

function scoreLocalCandidate(
  cand: DirectoryFacility,
  params: {
    queryText: string;
    companyName: string;
    streetAddress: string;
    city: string;
    state: string;
    zipCode: string;
  },
): number {
  const { queryText, companyName, streetAddress, city, state, zipCode } = params;

  // Empty search returns default verified directory items
  if (!queryText && !companyName && !streetAddress && !city && !state && !zipCode) {
    return cand.source === "TAI Verified Facility" ? 85 : 80;
  }

  const cCity = normalizeText(cand.city);
  const cState = normalizeStateCode(cand.state);
  const cZip = extractZip5(cand.zipCode);
  const cStreet = normalizeStreet(cand.streetAddress);

  const qCity = normalizeText(city);
  const qState = normalizeStateCode(state);
  const qZip = extractZip5(zipCode);
  const qStreet = streetAddress.trim().length > 3 ? normalizeStreet(streetAddress) : "";

  const cityMatch = Boolean(qCity && cCity === qCity);
  const stateMatch = Boolean(qState && cState === qState);
  const zipMatch = Boolean(qZip && cZip && cZip === qZip);
  const streetMatch = Boolean(qStreet && cStreet && (cStreet === qStreet || cStreet.includes(qStreet) || qStreet.includes(cStreet)));

  // 1. Structured companyName matching (returns ALL plant locations for that company across states!)
  if (companyName) {
    const compTier = assessCompanyMatch(companyName, cand);
    if (compTier === "exact" || compTier === "strong") {
      if ((cityMatch && stateMatch) || (streetMatch && stateMatch) || (zipMatch && stateMatch)) {
        return 99;
      }
      if (stateMatch && !qCity) {
        return 97;
      }
      if (cityMatch && !qState) {
        return 96;
      }
      if (zipMatch && !qState) {
        return 95;
      }
      if (streetMatch) {
        return 94;
      }
      // Other-state plants for the same company stay visible below the active city/state match
      const base = compTier === "exact" ? 89 : 85;
      const verifiedBoost = cand.source === "TAI Verified Facility" ? 2 : 0;
      const detailBoost = cand.streetAddress && cand.phone ? 1 : 0;
      return Math.min(93, base + verifiedBoost + detailBoost);
    }

    if (compTier === "partial") {
      let score = 74;
      if (cityMatch && stateMatch) score = 93;
      else if (stateMatch) score = 84;
      return score;
    }
  }

  // 2. Free-text query matching (e.g. search box inside the matches card)
  if (queryText) {
    const tokens = normalizeText(queryText)
      .split(" ")
      .filter((t) => t && !["inc", "llc", "corp", "co", "usa"].includes(t));

    if (tokens.length > 0) {
      const fullHaystack = normalizeText(
        [cand.companyName, cand.streetAddress, cand.city, cand.state, cand.zipCode, ...(cand.aliases || [])].join(" "),
      );
      const words = new Set(fullHaystack.split(" ").filter(Boolean));
      const companyHaystack = normalizeCompanyName(cand.companyName);
      const companyWords = new Set(companyHaystack.split(" ").filter(Boolean));

      let matchedCount = 0;
      let companyTokenHits = 0;
      for (const tok of tokens) {
        if (tokenMatchesField(tok, fullHaystack, words)) {
          matchedCount++;
        }
        if (tokenMatchesField(tok, companyHaystack, companyWords)) {
          companyTokenHits++;
        }
      }

      const compTierFromQuery = assessCompanyMatch(queryText, cand);
      if (matchedCount === tokens.length) {
        return cand.source === "TAI Verified Facility" ? 99 : 97;
      }
      if (compTierFromQuery === "exact" || compTierFromQuery === "strong") {
        return 90 + (cand.source === "TAI Verified Facility" ? 2 : 0);
      }
      if (companyTokenHits >= 1 && matchedCount >= 1) {
        const ratio = matchedCount / tokens.length;
        if (ratio >= 0.5 || companyTokenHits >= 2 || (companyTokenHits === 1 && brandTokens(companyHaystack)[0] && tokens.includes(brandTokens(companyHaystack)[0]))) {
          return Math.round(78 + ratio * 16);
        }
      }
      if (tokens.length >= 2 && matchedCount >= Math.ceil(tokens.length * 0.7)) {
        return Math.round(74 + (matchedCount / tokens.length) * 16);
      }
    }
  }

  // 3. Address / location-only fallback when companyName didn't match (or was blank)
  if (streetMatch && (cityMatch || zipMatch || stateMatch)) return 95;
  if (zipMatch && cityMatch) return 90;
  if (zipMatch && (!qState || stateMatch)) return 84;
  if (cityMatch && stateMatch && !companyName) return 82;

  return 0;
}

function toSearchCandidate(item: DirectoryFacility, confidence: number): FacilitySearchCandidate {
  const state = normalizeStateCode(item.state);
  const zipCode = extractZip5(item.zipCode);
  return {
    id: item.id,
    companyName: item.companyName,
    streetAddress: item.streetAddress,
    city: item.city,
    state,
    zipCode,
    phone: item.phone,
    source: item.source,
    confidence,
    mapsUrl: buildGoogleMapsUrl({
      companyName: item.companyName,
      streetAddress: item.streetAddress,
      city: item.city,
      state,
      zipCode,
    }),
  };
}

function buildExternalSearchQuery(
  params: {
    queryText: string;
    companyName: string;
    streetAddress: string;
    city: string;
    state: string;
    zipCode: string;
  },
  pool: DirectoryFacility[],
): string {
  if (params.queryText) return params.queryText;

  const cleanState = normalizeStateCode(params.state);
  const cleanZip = extractZip5(params.zipCode);
  const rawStreet = params.streetAddress.trim();

  // Omit 1-3 character broken street fragments (e.g. "4") and streets copied from another state's plant
  let includeStreet = rawStreet.length > 3;
  if (includeStreet && cleanState) {
    const normStreet = normalizeStreet(rawStreet);
    const belongsToOtherStatePlant = pool.some(
      (f) =>
        f.streetAddress &&
        normalizeStreet(f.streetAddress) === normStreet &&
        normalizeStateCode(f.state) &&
        normalizeStateCode(f.state) !== cleanState,
    );
    if (belongsToOtherStatePlant) {
      includeStreet = false;
    }
  }

  // Omit ZIP when it clearly belongs to a different state than city/state
  const includeZip =
    Boolean(cleanZip) &&
    (!cleanState || isZipRoughlyCompatibleWithState(cleanState, cleanZip)) &&
    (!params.city || !cleanState || !params.companyName || isZipRoughlyCompatibleWithState(cleanState, cleanZip));

  return [
    params.companyName,
    includeStreet ? rawStreet : "",
    params.city,
    cleanState || params.state,
    includeZip ? cleanZip : "",
  ]
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .join(", ");
}

function parseFormattedUsAddress(formatted: string): {
  streetAddress: string;
  city: string;
  state: string;
  zipCode: string;
} {
  const parts = formatted
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length && /^(?:usa|united states|canada)$/i.test(parts[parts.length - 1])) {
    parts.pop();
  }
  let state = "";
  let zipCode = "";
  if (parts.length > 0) {
    const tail = parts[parts.length - 1];
    const m = tail.match(/^([A-Z]{2})\s+(\d{5}(?:-\d{4})?|[A-Z]\d[A-Z]\s?\d[A-Z]\d)$/i);
    if (m) {
      state = m[1].toUpperCase();
      zipCode = extractZip5(m[2]);
      parts.pop();
    } else if (/^[A-Z]{2}$/i.test(tail)) {
      state = tail.toUpperCase();
      parts.pop();
    }
  }
  const city = parts.length > 0 ? parts.pop() || "" : "";
  const streetAddress = parts.join(", ");
  return { streetAddress, city, state, zipCode };
}

interface GooglePlaceComponent {
  longText?: string;
  shortText?: string;
  types?: string[];
}

interface GooglePlaceItem {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  addressComponents?: GooglePlaceComponent[];
  nationalPhoneNumber?: string;
  types?: string[];
}

async function fetchGooglePlacesCandidates(
  searchText: string,
  apiKey: string,
  requestedCity: string,
  requestedState: string,
): Promise<FacilitySearchCandidate[]> {
  try {
    const resp = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.formattedAddress,places.addressComponents,places.nationalPhoneNumber,places.types",
      },
      body: JSON.stringify({
        textQuery: searchText,
        pageSize: 5,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as { places?: GooglePlaceItem[] };
    const places = Array.isArray(data.places) ? data.places : [];

    return places
      .map((place, idx): FacilitySearchCandidate | null => {
        const comps = Array.isArray(place.addressComponents) ? place.addressComponents : [];
        const pickComp = (typeList: string[], preferShort = false): string => {
          const hit = comps.find((c) => Array.isArray(c.types) && typeList.some((t) => c.types!.includes(t)));
          if (!hit) return "";
          return String((preferShort ? hit.shortText : hit.longText) || hit.longText || hit.shortText || "").trim();
        };

        const streetNumber = pickComp(["street_number"]);
        const route = pickComp(["route"]);
        const subpremise = pickComp(["subpremise"], true);
        let streetAddress = [streetNumber, route].filter(Boolean).join(" ").trim();
        if (streetAddress && subpremise) streetAddress = `${streetAddress} #${subpremise}`;

        let city = pickComp(["locality", "postal_town", "sublocality_level_1", "administrative_area_level_3"]);
        let state = normalizeStateCode(pickComp(["administrative_area_level_1"], true));
        let zipCode = extractZip5(pickComp(["postal_code"], true));

        if (place.formattedAddress && (!streetAddress || !city || !state || !zipCode)) {
          const parsed = parseFormattedUsAddress(place.formattedAddress);
          if (!streetAddress) streetAddress = parsed.streetAddress;
          if (!city) city = parsed.city;
          if (!state) state = parsed.state;
          if (!zipCode) zipCode = parsed.zipCode;
        }

        const companyName = String(place.displayName?.text || "").trim();
        if (!companyName && !streetAddress && !city) return null;

        const cityMatches = requestedCity && normalizeText(city) === normalizeText(requestedCity);
        const stateMatches = requestedState && state === requestedState;
        const confidence = cityMatches && stateMatches ? 97 : stateMatches ? 90 - idx : 85 - idx * 2;

        return {
          id: place.id ? `gmaps-${place.id}` : `gmaps-${idx}-${zipCode}`,
          companyName: companyName || `${city}, ${state}`.replace(/^,\s*/, ""),
          streetAddress,
          city,
          state,
          zipCode,
          phone: String(place.nationalPhoneNumber || "").trim(),
          source: "Google Maps Places",
          confidence: Math.max(60, Math.min(98, confidence)),
          mapsUrl: buildGoogleMapsUrl({ companyName, streetAddress, city, state, zipCode }),
        };
      })
      .filter((c): c is FacilitySearchCandidate => c !== null);
  } catch {
    return [];
  }
}

interface NominatimAddress {
  house_number?: string;
  road?: string;
  city?: string;
  town?: string;
  village?: string;
  hamlet?: string;
  municipality?: string;
  suburb?: string;
  state?: string;
  postcode?: string;
  amenity?: string;
  building?: string;
  industrial?: string;
  commercial?: string;
  warehouse?: string;
  office?: string;
  shop?: string;
  [key: string]: string | undefined;
}

interface NominatimPlaceItem {
  place_id?: number | string;
  name?: string;
  display_name?: string;
  address?: NominatimAddress;
}

async function fetchNominatimCandidates(
  searchText: string,
  fallbackCompany: string,
  requestedCity: string,
  requestedState: string,
): Promise<FacilitySearchCandidate[]> {
  try {
    const url =
      `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&countrycodes=us,ca&limit=5&q=` +
      encodeURIComponent(searchText);
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "FiveNinesOps/2.1",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(4_000),
    });
    if (!resp.ok) return [];
    const items = (await resp.json()) as NominatimPlaceItem[];
    if (!Array.isArray(items)) return [];

    return items
      .map((item, idx): FacilitySearchCandidate | null => {
        const addr = item.address || {};
        const houseNumber = String(addr.house_number || "").trim();
        const road = String(addr.road || "").trim();
        const streetAddress = [houseNumber, road].filter(Boolean).join(" ").trim();
        const city = String(
          addr.city || addr.town || addr.village || addr.hamlet || addr.municipality || addr.suburb || "",
        ).trim();

        const isoEntry = Object.entries(addr).find(([k]) => k.toUpperCase().startsWith("ISO3166-2"));
        const state = normalizeStateCode(isoEntry?.[1] || addr.state);
        const zipCode = extractZip5(addr.postcode);

        const rawName = String(item.name || "").trim();
        const tagName = String(
          addr.amenity || addr.building || addr.industrial || addr.commercial || addr.warehouse || addr.office || addr.shop || "",
        ).trim();
        const firstDisplaySegment = String(item.display_name || "")
          .split(",")[0]
          ?.trim();
        const usableDisplaySegment =
          firstDisplaySegment && firstDisplaySegment !== houseNumber && firstDisplaySegment !== road
            ? firstDisplaySegment
            : "";

        const companyName =
          (rawName && rawName !== houseNumber && rawName !== road ? rawName : "") ||
          tagName ||
          fallbackCompany ||
          usableDisplaySegment ||
          `${city}, ${state}`.replace(/^,\s*/, "");

        if (!streetAddress && !city && !zipCode) return null;

        const cityMatches = requestedCity && normalizeText(city) === normalizeText(requestedCity);
        const stateMatches = requestedState && state === requestedState;
        const confidence = cityMatches && stateMatches ? 88 - idx * 2 : 80 - idx * 3;

        return {
          id: `osm-${item.place_id ?? idx}`,
          companyName,
          streetAddress,
          city,
          state,
          zipCode,
          phone: "",
          source: "OpenStreetMap Places",
          confidence: Math.max(55, Math.min(92, confidence)),
          mapsUrl: buildGoogleMapsUrl({ companyName, streetAddress, city, state, zipCode }),
        };
      })
      .filter((c): c is FacilitySearchCandidate => c !== null);
  } catch {
    return [];
  }
}

function mergeRemoteCandidates(
  local: FacilitySearchCandidate[],
  remote: FacilitySearchCandidate[],
): FacilitySearchCandidate[] {
  const merged = [...local];

  for (const r of remote) {
    const rStreet = normalizeStreet(r.streetAddress);
    const rCity = normalizeText(r.city);
    const rState = normalizeStateCode(r.state);
    const rZip = extractZip5(r.zipCode);
    const rComp = normalizeCompanyName(r.companyName);

    const dupIdx = merged.findIndex((existing) => {
      const eState = normalizeStateCode(existing.state);
      if (eState !== rState) return false;
      const eStreet = normalizeStreet(existing.streetAddress);
      const eCity = normalizeText(existing.city);
      const eZip = extractZip5(existing.zipCode);
      if (eStreet && rStreet && eStreet === rStreet && (eCity === rCity || (eZip && eZip === rZip))) {
        return true;
      }
      return normalizeCompanyName(existing.companyName) === rComp && eCity === rCity && eZip === rZip;
    });

    if (dupIdx >= 0) {
      if (!merged[dupIdx].phone && r.phone) {
        merged[dupIdx] = { ...merged[dupIdx], phone: r.phone };
      }
      if (!merged[dupIdx].streetAddress && r.streetAddress) {
        merged[dupIdx] = {
          ...merged[dupIdx],
          streetAddress: r.streetAddress,
          mapsUrl: buildGoogleMapsUrl({
            companyName: merged[dupIdx].companyName,
            streetAddress: r.streetAddress,
            city: merged[dupIdx].city,
            state: merged[dupIdx].state,
            zipCode: merged[dupIdx].zipCode,
          }),
        };
      }
    } else {
      merged.push(r);
    }
  }

  return merged;
}

/**
 * Searches curated multi-location industrial directory, saved TAI facilities,
 * historical shipment stops, and live Google Places (or OpenStreetMap Nominatim fallback).
 */
export async function searchFacilityAndMapsCandidates(
  params: FacilitySearchParams = {},
  savedFacilities: SavedFacility[] = [],
  shipments: OpsShipment[] = [],
): Promise<FacilitySearchResult> {
  const queryText = String(params.query || params.q || "").trim();
  const companyName = String(params.companyName || "").trim();
  const streetAddress = String(params.streetAddress || "").trim();
  const city = String(params.city || "").trim();
  const state = normalizeStateCode(params.state);
  const zipCode = extractZip5(params.zipCode);
  const limit = Math.max(1, Math.min(25, Number(params.limit) || 12));

  const googleApiKey = String(process.env.GOOGLE_MAPS_API_KEY || "").trim();
  const googleEnabled = Boolean(googleApiKey);

  const displayQuery =
    queryText ||
    [companyName, streetAddress, city, state || String(params.state || "").trim(), zipCode]
      .filter(Boolean)
      .join(", ");

  const pool = buildDirectoryPool(savedFacilities, shipments);

  const localCandidates = pool
    .map((item) => ({
      item,
      confidence: scoreLocalCandidate(item, {
        queryText,
        companyName,
        streetAddress,
        city,
        state,
        zipCode,
      }),
    }))
    .filter((entry) => entry.confidence > 0)
    .sort(
      (a, b) =>
        b.confidence - a.confidence ||
        sourcePriority(b.item.source) - sourcePriority(a.item.source) ||
        a.item.city.localeCompare(b.item.city),
    )
    .map((entry) => toSearchCandidate(entry.item, entry.confidence));

  const externalQuery = buildExternalSearchQuery(
    { queryText, companyName, streetAddress, city, state, zipCode },
    pool,
  );

  let combined = localCandidates;
  if (externalQuery) {
    if (googleEnabled) {
      const googleHits = await fetchGooglePlacesCandidates(externalQuery, googleApiKey, city, state);
      combined = mergeRemoteCandidates(localCandidates, googleHits);
    } else if (localCandidates.length < 3) {
      const osmHits = await fetchNominatimCandidates(externalQuery, companyName, city, state);
      combined = mergeRemoteCandidates(localCandidates, osmHits);
    }
  }

  combined.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      sourcePriority(b.source) - sourcePriority(a.source),
  );

  return {
    ok: true,
    query: displayQuery,
    googleEnabled,
    candidates: combined.slice(0, limit),
  };
}
