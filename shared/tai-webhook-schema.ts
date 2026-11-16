import type { LoadEntryItem, LoadEntryStop } from "./load-entry";

export type DispatchStage = "Needs truck" | "Assigned" | "In transit" | "Delivered";

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
  stage: DispatchStage;
  rawStatus: string;
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
  equip: string;
  trailerSize: "Full" | "Partial";
  mileage: number;
  sell: number;
  buy: number;
  podCount: number;
  emailPodAvailable: boolean;
  rateconStatus: "Not Sent" | "Drafted" | "Sent";
  writebackState: string;
  location: string;
  mismatchNote?: string;
  invoiceStatus?: string;
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
  permalink?: string;
  containerNumber?: string;
  operationalNote?: string;
  extractedPo?: string;
  extractedAmount?: number;
  extractedCarrier?: string;
  extractedInvoice?: string;
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
}

export interface CarrierOption {
  name: string;
  mc: string;
  dot: string;
  scac: string;
  taiMasterId: string;
  insuranceStatus: string;
  laneNote?: string;
  avgBuy?: number;
}

export interface CustomerOption {
  name: string;
  taiOrgId: string;
  city: string;
  state: string;
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
  type: "ShipmentDetailUpdateUrl" | "InvoiceCreateWithShipmentUrl" | "CarrierWriteBackPoller" | "SupabaseRealtime";
  shipmentId: string;
  summary: string;
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

export function mapTaiStatusToStage(raw?: string): DispatchStage {
  const s = String(raw || "").toLowerCase();
  if (s.includes("deliver") || s.includes("complete") || s.includes("invoic")) return "Delivered";
  if (s.includes("transit") || s.includes("picked") || s.includes("out for")) return "In transit";
  if (s.includes("dispatch") || s.includes("assign") || s.includes("tender")) return "Assigned";
  return "Needs truck";
}

export function extractDateShort(iso?: string): string {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "TBD";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mi = Math.max(0, Math.min(11, Number(m[2]) - 1));
  return `${months[mi]} ${Number(m[3])}`;
}
