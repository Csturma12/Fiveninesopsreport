/**
 * Verified Google Workspace staff domains & owner-only gate for Five Nines Ops
 * and live TAI bookings / write-backs.
 */
export const STAFF_GOOGLE_DOMAINS = [
  "primarycompanies.com",
  "shipfivenines.com",
  "fiveninesfreight.com",
] as const;

/** Default owner-only allowlist while testing live side-by-side before Jan 1 rollout. */
export const DEFAULT_ALLOWED_OWNER_EMAILS = [
  "chriss@primarycompanies.com",
  "chris@shipfivenines.com",
  "chris@fiveninesfreight.com",
] as const;

export function staffEmailDomain(email: unknown): string | undefined {
  const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
  const match = /^[^@\s]+@([a-z0-9.-]+)$/.exec(normalized);
  return match && (STAFF_GOOGLE_DOMAINS as readonly string[]).includes(match[1])
    ? match[1]
    : undefined;
}

/**
 * Checks whether an address is permitted on this instance. By default only
 * Chris's owner addresses are allowed; additional staff addresses (or "*" to
 * open to all verified staff domains) can be supplied via ALLOWED_STAFF_EMAILS.
 */
export function isAllowedOwnerEmail(email: unknown, envAllowlist?: string): boolean {
  const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!normalized || !normalized.includes("@")) return false;

  const rawList =
    envAllowlist !== undefined
      ? envAllowlist
      : typeof process !== "undefined"
      ? process.env?.ALLOWED_STAFF_EMAILS
      : undefined;

  const trimmed = String(rawList || "").trim();
  if (trimmed === "*") return true;

  const extras = trimmed
    ? trimmed
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : [];

  return (
    (DEFAULT_ALLOWED_OWNER_EMAILS as readonly string[]).includes(normalized) ||
    extras.includes(normalized)
  );
}

export function isStaffGoogleIdentity(
  email: unknown,
  hostedDomain?: unknown,
  envAllowlist?: string,
): boolean {
  const domain = staffEmailDomain(email);
  if (!domain) return false;
  if (typeof hostedDomain === "string" && hostedDomain.trim()) {
    if (hostedDomain.trim().toLowerCase() !== domain) return false;
  }
  return isAllowedOwnerEmail(email, envAllowlist);
}
