/**
 * Verified Google Workspace staff domains authorized to access Five Nines Ops
 * and perform live TAI bookings / write-backs.
 */
export const STAFF_GOOGLE_DOMAINS = [
  "primarycompanies.com",
  "shipfivenines.com",
  "fiveninesfreight.com",
] as const;

export function staffEmailDomain(email: unknown): string | undefined {
  const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
  const match = /^[^@\s]+@([a-z0-9.-]+)$/.exec(normalized);
  return match && (STAFF_GOOGLE_DOMAINS as readonly string[]).includes(match[1])
    ? match[1]
    : undefined;
}

export function isStaffGoogleIdentity(email: unknown, hostedDomain?: unknown): boolean {
  const domain = staffEmailDomain(email);
  if (!domain) return false;
  if (typeof hostedDomain === "string" && hostedDomain.trim()) {
    return hostedDomain.trim().toLowerCase() === domain;
  }
  return true;
}
