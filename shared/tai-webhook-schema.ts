import type { LoadEntryItem, LoadEntryStop } from "./load-entry";

export type ShipmentStage = "Needs truck" | "Assigned" | "In transit" | "Delivered" | "Cancelled";
export type DispatchStage = ShipmentStage;

export type RateconStatus = "Not Sent" | "Drafted" | "Sent" | "Signed";

/**
 * Customers explicitly hidden from operational dashboards, panel, and search (e.g. Quality Sausage).
 */
export function isHiddenCustomer(name: string | null | undefined): boolean {
  if (!name) return false;
  const n = String(name).toLowerCase().replace(/[^a-z0-9]/g, "");
  return n.includes("qualitysausage") || n.includes("qualitysaus") || n === "qsc";
}

export interface ContainerEventItem {
  id: string;
  timestamp: string;
  from: string;
  subject: string;
  summary: string;
  kind: "tonu" | "exception" | "email" | "status";
  permalink?: string;
}

export interface OpsShipment {
  id: string;
  customer: string;
  taiOrgId?: string;
  origin: string;
  dest: string;
  stops: LoadEntryStop[];
  commodities: LoadEntryItem[];
  accessorials: string[];
  stage: ShipmentStage;
  rawStatus: string;
  taiRawStatus?: string;
  carrier: string;
  mc: string;
  po: string;
  bol: string;
  pro: string;
  containerNumber?: string;
  operationalNote?: string;
  containerEvents?: ContainerEventItem[];
  shipDate: string;
  delivDate: string;
  shipDateIso?: string;
  delivDateIso?: string;
  equip: string;
  trailerSize: "Full" | "Partial";
  mileage: number;
  sell: number;
  buy: number;
  podCount: number;
  podStatus?: string;
  emailPodAvailable: boolean;
  rateconStatus: RateconStatus;
  writebackState: string;
  location: string;
  currentLocation?: string;
  driverPhone?: string;
  trailerNumber?: string;
  mismatchNote?: string;
  invoiceStatus?: string;
  carrierPayStatus?: string;
  lastAgentAction?: {
    agent: string;
    action: string;
    at: string;
    summary: string;
  };
}

export interface ExtractedEmailFields {
  customerPO?: string;
  sellRate?: number;
  buyRate?: number;
  origin?: string;
  dest?: string;
  equipment?: string;
  readyDate?: string;
  notes?: string;
}

export interface CrucialEmailItem {
  id: string;
  category: "tenders" | "diffs" | "pod";
  subject: string;
  from: string;
  senderName?: string;
  received: string;
  loadId: string; // 'NEW' for unbooked tenders
  diffType: "new_tender" | "missing_po" | "rate_mismatch" | "missing_pod";
  diffLabel: string;
  diffValue: string;
  ctaLabel: string;
  body: string;
  fullBody?: string;
  threadId?: string;
  messageId?: string;
  unread?: boolean;
  source?: "extension" | "ap_inbox" | "intake_draft" | "seed";
  permalink?: string;
  containerNumber?: string;
  operationalNote?: string;
  extractedPo?: string;
  extractedAmount?: number;
  extractedCarrier?: string;
  extractedInvoice?: string;
  extractedFields?: ExtractedEmailFields;
  attachments?: Array<{ filename?: string; mimeType?: string }>;
  applied?: boolean;
}

export interface SavedFacility {
  id: string;
  label: string;
  companyName: string;
  streetAddress: string;
  city: string;
  state: string;
  zipCode: string;
  contactName: string;
  phone: string;
  email?: string;
}

export interface CarrierOption {
  name: string;
  mc: string;
  dot: string;
  scac: string;
  taiMasterId: string;
  insuranceStatus: string;
  insuranceExpiry?: string;
  contactName?: string;
  phone?: string;
  email?: string;
  laneNote?: string;
  avgBuy?: number;
}

export interface CustomerOption {
  name: string;
  taiOrgId: string;
  city: string;
  state: string;
  contactName?: string;
  phone?: string;
  email?: string;
}

export type CrmLeadStage = "New" | "Researching" | "Contacted" | "Qualified" | "Converted";
export type CrmLeadSource = "Manual" | "Clay" | "ImportYeti" | "Gmail" | "Quote";

export interface CrmLeadItem {
  id: string;
  company: string;
  contact: string;
  email: string;
  phone: string;
  location: string;
  source: CrmLeadSource;
  sourceUrl?: string;
  status: CrmLeadStage;
  owner: string;
  followUp: string;
  evidence: string;
  estimatedLanes?: string;
  pushedToVercelCrm?: boolean;
  capturedAt: string;
  updatedAt: string;
}

export interface OpsKpis {
  totalShipments: number;
  loads30d: number;
  rev30d: number;
  buy30d: number;
  pickedUp7d: number;
  delivered7d: number;
  uncoveredCommitted: number;
  inTransitNow: number;
  missingPodDelivered: number;
  emailPodReady: number;
  openApTasks: number;
  tmsMismatches: number;
  customersCount: number;
  facilitiesCount: number;
  carriersCount: number;
}

export interface WebhookEventLog {
  id: string;
  timestamp: string;
  type:
    | "ShipmentDetailUpdateUrl"
    | "InvoiceCreateWithShipmentUrl"
    | "CarrierWriteBackPoller"
    | "SupabaseRealtime"
    | "DocumentAttachments";
  shipmentId: string;
  summary: string;
}

export interface BootstrapCounts {
  totalShipments: number;
  uncoveredCommitted: number;
  coveredCommitted: number;
  dispatched: number;
  inTransit: number;
  delivered: number;
  cancelled: number;
  customers: number;
  carriers: number;
  facilities: number;
}

export interface BootstrapPayload {
  mode: {
    safeSandbox: boolean;
    supabaseConnected: boolean;
    realtimeSubscribed: boolean;
    taiConfigured: boolean;
    pollerEnabled: boolean;
    pollerScope: string;
  };
  supabaseConnected?: boolean;
  supabaseError?: string | null;
  lastSyncAt?: string;
  counts?: BootstrapCounts;
  user?: {
    email: string;
    name: string;
    mode: string;
  } | null;
  kpis: OpsKpis;
  shipments: OpsShipment[];
  crucialEmails: CrucialEmailItem[];
  facilities: SavedFacility[];
  carriers: CarrierOption[];
  customers: CustomerOption[];
  crmLeads: CrmLeadItem[];
  crmWebhookUrl: string;
  webhookLogs: WebhookEventLog[];
}

export interface TaiShipmentWebhookPayload {
  shipmentId: number | string;
  status?: string;
  customer?: { name?: string; billToOrganizationId?: number | string | null };
  carrierList?: Array<{
    name?: string;
    scac?: string | null;
    mcNumber?: string | null;
    dotNumber?: string | null;
    carrierMasterId?: number | string | null;
  }>;
  totalBuy?: number;
  totalSell?: number;
  mileage?: number;
  trailerType?: string;
  driverCellPhoneNumber?: string;
  shipmentReferenceNumbers?: Array<{ referenceType?: string; value?: string }>;
  stops?: Array<{
    companyName?: string;
    streetAddress?: string;
    city?: string;
    state?: string;
    zipCode?: string;
    stopType?: string;
    appointmentReadyDateTime?: string;
    estimatedReadyDateTime?: string;
  }>;
  commodities?: Array<{
    description?: string;
    packagingType?: string;
    handlingQuantity?: number;
    piecesTotal?: number;
    weightTotal?: number;
    hazardousMaterial?: boolean;
  }>;
  locationString?: string;
  attachments?: Array<{ documentType?: string; fileName?: string }>;
  pickupReadyDateTime?: string;
  PickupReadyDateTime?: string;
  deliveryEstimatedDateTime?: string;
  DeliveryEstimatedDateTime?: string;
}

export interface TaiInvoiceWebhookPayload {
  invoiceId?: number | string;
  invoiceNumber?: string;
  shipmentId: number | string;
  totalAmount?: number;
  invoiceType?: "AR" | "AP" | string;
  status?: string;
}

/**
 * Canonical operational stage mapper aligned with `primary-freight-dashboard/shared/load-stages.ts`:
 * - Cancelled / Canceled loads NEVER fall through to "Needs truck".
 * - Out for Delivery / At Delivery / Picked Up / In Transit -> "In transit".
 * - Delivered / Complete / Invoiced / Billed -> "Delivered".
 * - Dispatched / Covered / Assigned OR Committed/Booked/Ready with an assigned carrier -> "Assigned".
 * - Uncovered Committed / Quote -> "Needs truck".
 */
export function mapTaiStatusToStage(rawStatus?: string, carrierName?: string): ShipmentStage {
  const raw = String(rawStatus ?? "").trim();
  if (/cancel/i.test(raw)) return "Cancelled";
  if (/in\s*transit|picked|loaded|out\s*for\s*delivery|at\s*delivery|en\s*route/i.test(raw)) {
    return "In transit";
  }
  if (/deliver|complete|invoiced|billed/i.test(raw)) return "Delivered";
  const hasCarrier = Boolean(carrierName && String(carrierName).trim());
  if (
    /dispatched|covered|assigned/i.test(raw) ||
    (hasCarrier && /committed|booked|ready|open|pending/i.test(raw || "Committed"))
  ) {
    return "Assigned";
  }
  return "Needs truck";
}

const SENT_TAI_STATUSES = new Set([
  "sent",
  "dispatched",
  "in transit",
  "out for delivery",
  "delivered",
  "complete",
  "completed",
]);

/**
 * Derives RateCon status without ever overwriting an explicit `"Not Sent"` just because `carrier` is populated.
 */
export function deriveRateconStatus(row: Record<string, unknown> | null | undefined): RateconStatus {
  if (!row) return "Not Sent";
  const explicit = String(row.ratecon_status ?? row.rateconStatus ?? "").trim();
  if (explicit) {
    if (/^not\s*sent$/i.test(explicit) || /^unsent$/i.test(explicit)) return "Not Sent";
    if (/^signed$/i.test(explicit)) return "Signed";
    if (/^drafted$/i.test(explicit)) return "Drafted";
    if (/^sent$/i.test(explicit)) return "Sent";
  }

  const taiCarrierConf = String(
    row.ratecon_tai_carrier_confirmation ?? row.rateconTaiCarrierConfirmation ?? "",
  ).trim();
  if (/^true$/i.test(taiCarrierConf)) return "Sent";
  if (/^false$/i.test(taiCarrierConf)) return "Not Sent";

  const taiRaw = String(row.tai_raw_status ?? row.taiRawStatus ?? "").trim().toLowerCase();
  if (taiRaw && SENT_TAI_STATUSES.has(taiRaw)) return "Sent";
  if (taiRaw === "ready" || taiRaw === "committed" || taiRaw === "booked" || taiRaw === "quote" || taiRaw === "quoted") {
    return "Not Sent";
  }

  const collapsed = String(row.status ?? row.rawStatus ?? "").trim().toLowerCase();
  if (collapsed === "dispatched" || collapsed === "in transit" || collapsed === "delivered" || collapsed === "complete") {
    return "Sent";
  }
  return "Not Sent";
}

export function extractDateShort(iso?: string): string {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "TBD";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mi = Math.max(0, Math.min(11, Number(m[2]) - 1));
  return `${months[mi]} ${Number(m[3])}`;
}
