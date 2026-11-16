const KNOWN_ZIPS: Record<string, { city: string; state: string }> = {
  "15010": { city: "Beaver Falls", state: "PA" },
  "15063": { city: "Monongahela", state: "PA" },
  "16063": { city: "Zelienople", state: "PA" },
  "30058": { city: "Lithonia", state: "GA" },
  "30253": { city: "McDonough", state: "GA" },
  "90744": { city: "Wilmington", state: "CA" },
  "38141": { city: "Memphis", state: "TN" },
  "07114": { city: "Newark", state: "NJ" },
  "43612": { city: "Toledo", state: "OH" },
  "60428": { city: "Markham", state: "IL" },
  "70730": { city: "Ethel", state: "LA" },
  "85043": { city: "Phoenix", state: "AZ" },
  "71291": { city: "West Monroe", state: "LA" },
  "71292": { city: "West Monroe", state: "LA" },
  "29405": { city: "North Charleston", state: "SC" },
  "77001": { city: "Houston", state: "TX" },
  "77013": { city: "Houston", state: "TX" },
  "75201": { city: "Dallas", state: "TX" },
  "60601": { city: "Chicago", state: "IL" },
  "30301": { city: "Atlanta", state: "GA" },
  "79927": { city: "El Paso", state: "TX" },
  "72202": { city: "Little Rock", state: "AR" },
};

const CITY_STATE_ZIPS: Record<string, string> = {};
for (const [zip, loc] of Object.entries(KNOWN_ZIPS)) {
  const key = `${loc.city.toUpperCase()}|${loc.state.toUpperCase()}`;
  if (!CITY_STATE_ZIPS[key]) CITY_STATE_ZIPS[key] = zip;
}

export function lookupZipCityState(zip: string): { city: string; state: string } | null {
  const clean = String(zip || "").trim().slice(0, 5);
  return KNOWN_ZIPS[clean] ?? null;
}

export function lookupCityStateZip(city: string, state: string): string {
  const key = `${String(city || "").trim().toUpperCase()}|${String(state || "").trim().toUpperCase()}`;
  return CITY_STATE_ZIPS[key] ?? "";
}
