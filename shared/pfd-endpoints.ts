/**
 * API prefixes served by the Primary Freight Dashboard
 * (Csturma12/primary-freight-dashboard, freight-dashboard/server) that this
 * app exposes through the gateway at `/api/pfd/<prefix-without-/api>/...`.
 *
 * Inventory taken from the dashboard's main branch on 2026-11-17: ~156
 * app-level routes plus the freight, billing, portal-admin, agent-desk,
 * gmail-panel, shipment-toolkit and other routers (≈320 endpoints in total).
 *
 * Deliberately NOT exposed (blocked regardless of allowlist):
 *   /api/auth           dashboard session sign-in/out (this app has its own)
 *   /api/portal         customer portal; authenticates customers with their own
 *                       Supabase token, which the gateway never forwards
 *   /api/webhooks       TAI / Terminal49 machine webhooks with their own secrets
 *   /api/outlook/auth-* Microsoft OAuth sign-in/callback endpoints
 */
export const PFD_ALLOWED_PATH_PREFIXES = [
  "/api/addon-drafts",
  "/api/address-book",
  "/api/addresses",
  "/api/admin",
  "/api/agent-desk",
  "/api/assistant",
  "/api/attention",
  "/api/billing",
  "/api/carrier-matches",
  "/api/carriers",
  "/api/chat",
  "/api/containers",
  "/api/customer-tools",
  "/api/customers",
  "/api/dashboard",
  "/api/dat",
  "/api/dispatch",
  "/api/field-suggestions",
  "/api/freight",
  "/api/geocode",
  "/api/gmail-freight-toolkit",
  "/api/gmail-intake",
  "/api/gmail-native",
  "/api/gmail-panel",
  "/api/goals",
  "/api/gpa",
  "/api/health",
  "/api/integrations",
  "/api/lanes",
  "/api/load-drafts",
  "/api/loads",
  "/api/ops",
  "/api/outlook",
  "/api/port-houston",
  "/api/portal-admin",
  "/api/projects",
  "/api/quotes",
  "/api/ratecon",
  "/api/shipment-toolkit",
  "/api/shipments",
  "/api/stats",
  "/api/stuck-loads",
  "/api/table-preferences",
  "/api/tai",
  "/api/terminal49",
  "/api/tracking-sources",
  "/api/truckload-quotes",
] as const;

export const PFD_API_PREFIXES = PFD_ALLOWED_PATH_PREFIXES;
