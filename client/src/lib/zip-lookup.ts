const KNOWN_ZIPS: Record<string, { city: string; state: string }> = {
  "15010": { city: "Beaver Falls", state: "PA" },
  "15063": { city: "Monongahela", state: "PA" },
  "30058": { city: "Lithonia", state: "GA" },
  "90744": { city: "Wilmington", state: "CA" },
  "38141": { city: "Memphis", state: "TN" },
  "07114": { city: "Newark", state: "NJ" },
  "43612": { city: "Toledo", state: "OH" },
  "60428": { city: "Markham", state: "IL" },
  "70730": { city: "Ethel", state: "LA" },
  "85043": { city: "Phoenix", state: "AZ" },
  "71292": { city: "West Monroe", state: "LA" },
  "77001": { city: "Houston", state: "TX" },
  "75201": { city: "Dallas", state: "TX" },
  "60601": { city: "Chicago", state: "IL" },
  "30301": { city: "Atlanta", state: "GA" },
  "79927": { city: "El Paso", state: "TX" },
  "72202": { city: "Little Rock", state: "AR" },
};

export function lookupZipCityState(zip: string): { city: string; state: string } | null {
  const clean = String(zip || "").trim().slice(0, 5);
  return KNOWN_ZIPS[clean] ?? null;
}
