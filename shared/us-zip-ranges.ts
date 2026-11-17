/**
 * Authoritative USPS 3-digit ZIP prefix (005-999) to 2-letter US state/territory mapping
 * for catching cross-state stop address mismatches before booking in TAI.
 */

const ZIP3_STATE_RANGES: ReadonlyArray<readonly [number, number, string]> = [
  [5, 5, "NY"],     // Holtsville, NY (IRS)
  [6, 7, "PR"],     // Puerto Rico
  [8, 8, "VI"],     // U.S. Virgin Islands
  [9, 9, "PR"],     // Puerto Rico
  [10, 27, "MA"],   // Massachusetts
  [28, 29, "RI"],   // Rhode Island
  [30, 38, "NH"],   // New Hampshire
  [39, 49, "ME"],   // Maine
  [50, 54, "VT"],   // Vermont
  [55, 55, "MA"],   // Andover, MA (IRS)
  [56, 59, "VT"],   // Vermont
  [60, 69, "CT"],   // Connecticut
  [70, 89, "NJ"],   // New Jersey
  [90, 99, "AE"],   // Armed Forces Europe / Middle East / Africa / Canada
  [100, 149, "NY"], // New York
  [150, 196, "PA"], // Pennsylvania
  [197, 199, "DE"], // Delaware
  [200, 200, "DC"], // District of Columbia
  [201, 201, "VA"], // Northern Virginia (Dulles)
  [202, 205, "DC"], // District of Columbia
  [206, 219, "MD"], // Maryland
  [220, 246, "VA"], // Virginia
  [247, 268, "WV"], // West Virginia
  [270, 289, "NC"], // North Carolina
  [290, 299, "SC"], // South Carolina
  [300, 319, "GA"], // Georgia
  [320, 339, "FL"], // Florida
  [340, 340, "AA"], // Armed Forces Americas
  [341, 349, "FL"], // Florida
  [350, 369, "AL"], // Alabama
  [370, 385, "TN"], // Tennessee
  [386, 397, "MS"], // Mississippi
  [398, 399, "GA"], // Georgia (Southwest GA & Atlanta IRS)
  [400, 427, "KY"], // Kentucky
  [430, 459, "OH"], // Ohio
  [460, 479, "IN"], // Indiana
  [480, 499, "MI"], // Michigan
  [500, 528, "IA"], // Iowa
  [530, 549, "WI"], // Wisconsin
  [550, 567, "MN"], // Minnesota
  [569, 569, "DC"], // District of Columbia (Parcel Return)
  [570, 577, "SD"], // South Dakota
  [580, 588, "ND"], // North Dakota
  [590, 599, "MT"], // Montana
  [600, 629, "IL"], // Illinois
  [630, 658, "MO"], // Missouri
  [660, 679, "KS"], // Kansas
  [680, 693, "NE"], // Nebraska
  [700, 714, "LA"], // Louisiana
  [716, 729, "AR"], // Arkansas
  [730, 731, "OK"], // Oklahoma
  [733, 733, "TX"], // Austin, TX (IRS)
  [734, 749, "OK"], // Oklahoma
  [750, 799, "TX"], // Texas
  [800, 816, "CO"], // Colorado
  [820, 831, "WY"], // Wyoming
  [832, 838, "ID"], // Idaho
  [840, 847, "UT"], // Utah
  [850, 865, "AZ"], // Arizona
  [870, 884, "NM"], // New Mexico
  [885, 885, "TX"], // El Paso, TX
  [889, 898, "NV"], // Nevada
  [900, 961, "CA"], // California
  [962, 966, "AP"], // Armed Forces Pacific
  [967, 968, "HI"], // Hawaii
  [969, 969, "GU"], // Guam / Pacific Territories
  [970, 979, "OR"], // Oregon
  [980, 994, "WA"], // Washington
  [995, 999, "AK"], // Alaska
];

const EXACT_ZIP5_OVERRIDES: Readonly<Record<string, string>> = {
  "06390": "NY", // Fishers Island, NY
  "96799": "AS", // Pago Pago, American Samoa
};

const PREFIX_TO_STATE: Array<string | null> = Array.from({ length: 1000 }, () => null);
for (const [start, end, state] of ZIP3_STATE_RANGES) {
  for (let prefix = start; prefix <= end; prefix++) {
    PREFIX_TO_STATE[prefix] = state;
  }
}

/** Returns the canonical 2-letter US state/territory code for a US ZIP or 3-digit prefix, or null if unknown/non-US. */
export function stateForZip(zipCode: string): string | null {
  const trimmed = String(zipCode || "").trim();
  const match = trimmed.match(/^(\d{3})(?:\d{2}(?:-\d{4})?)?$/);
  if (!match) return null;
  if (trimmed.length >= 5) {
    const zip5 = trimmed.slice(0, 5);
    if (zip5 in EXACT_ZIP5_OVERRIDES) {
      return EXACT_ZIP5_OVERRIDES[zip5];
    }
  }
  const prefix = Number.parseInt(match[1], 10);
  if (prefix < 5 || prefix > 999) return null;
  return PREFIX_TO_STATE[prefix] ?? null;
}

/** Validates whether a 5-digit US ZIP code belongs to the given 2-letter US state code. */
export function validateStateZipMatch(
  state: string,
  zipCode: string,
): { valid: boolean; expectedState: string | null; message?: string } {
  const normalizedState = String(state || "").trim().toUpperCase();
  const zipMatch = String(zipCode || "").trim().match(/^(\d{5})(?:-\d{4})?$/);
  if (!normalizedState || !zipMatch) {
    return { valid: true, expectedState: null };
  }
  const zip5 = zipMatch[1];
  const expectedState = stateForZip(zip5);
  if (!expectedState) {
    return { valid: true, expectedState: null };
  }
  if (expectedState !== normalizedState) {
    return {
      valid: false,
      expectedState,
      message: `ZIP ${zip5} belongs to ${expectedState}, not ${normalizedState}`,
    };
  }
  return { valid: true, expectedState };
}
