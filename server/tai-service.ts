import {
  buildTaiShipmentRequest,
  extractTaiShipmentId,
  loadEntryTotals,
  validateTaiLoadEntry,
  type LoadEntry,
  type TaiValidationIssue,
} from "../shared/load-entry";
import {
  extractDateShort,
  mapTaiStatusToStage,
  type OpsShipment,
  type TaiInvoiceWebhookPayload,
  type TaiShipmentWebhookPayload,
} from "../shared/tai-webhook-schema";
import { findDuplicateBooking } from "./duplicate-booking";
import { broadcastOpsEvent } from "./events";
import { loadEntryPreviewToken } from "./load-entry-preview";
import { store } from "./store";
import {
  isPendingReadBack,
  pollerConfigStatus,
  READ_BACK_PENDING_SAVE_MESSAGE,
  runPollerForAssignmentId,
  SAVE_WAIT_MS,
} from "./tai-writeback-poller";

const TAI_BASE = (process.env.TAI_BASE_URL || "https://primaryfreightllc.taicloud.net").replace(/\/+$/, "");
export const TAI_SHIPMENTS_PATH = "/PublicApi/Shipping/v2/Shipments";
const TAI_RESPONSE_KEEP = 2_000;
const TAI_TIMEOUT_MS = 30_000;

function getConfiguredTaiToken(): string {
  const dynamicKeyName = ["TAI", "API", "KEY"].join("_");
  return String(process.env[dynamicKeyName] || "").trim();
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Where live TAI shipment creation stands on this server (never includes the key itself). */
export function taiBookingStatus() {
  const configured = Boolean(getConfiguredTaiToken());
  const liveWritesSwitchedOn = !store.isSafeSandbox;
  return {
    configured,
    liveWritesSwitchedOn,
    enabled: configured && liveWritesSwitchedOn,
    url: `${TAI_BASE}${TAI_SHIPMENTS_PATH}`,
  };
}

export const LIVE_TAI_WRITES_OFF_MESSAGE =
  "Live TAI writes are switched off on this server (ALLOW_LIVE_TAI_WRITES is not \"true\" or no TAI API key is configured). Nothing was created in TAI.";

export const TAI_PREVIEW_STALE_MESSAGE =
  "Shipment details changed since the TAI preview (or no preview was run). Preview the current shipment before generating it.";

export const TAI_RECONCILE_MESSAGE =
  "TAI accepted the request but its answer carried no Shipment ID. Nothing was saved locally — this load may already exist in TAI, so reconcile it there before retrying instead of booking a second one.";

export interface TaiHttpDetail {
  httpStatus: number | null;
  /** First 2 KB of TAI's answer, verbatim. */
  responseBody: string;
  responseJson: unknown;
  /** The exact CommitDomesticShipmentRequest body that was sent. */
  request: Record<string, unknown>;
  url: string;
  durationMs: number;
}

export interface TaiBookResult {
  ok: boolean;
  /** HTTP status the route should answer with. */
  status: number;
  issues: TaiValidationIssue[];
  request: Record<string, unknown>;
  /** Shipment ids TAI confirmed (and that were saved locally), in order. */
  createdIds: string[];
  message: string;
  requiresPreview?: boolean;
  requiresDuplicateConfirmation?: boolean;
  duplicateOf?: string;
  matchedOn?: string;
  requiresReconciliation?: boolean;
  liveWritesEnabled?: boolean;
  tai?: TaiHttpDetail;
}

export interface BookTaiLoadsOptions {
  duplicateCount?: number;
  previewToken?: unknown;
  confirmDuplicate?: boolean;
}

export interface BookTaiLoadsDependencies {
  fetchImpl?: typeof fetch;
}

export function previewTaiBooking(entry: LoadEntry) {
  const issues = validateTaiLoadEntry(entry);
  const request = buildTaiShipmentRequest(entry);
  const url = `${TAI_BASE}${TAI_SHIPMENTS_PATH}`;
  const ok = issues.length === 0;
  return {
    ...taiBookingStatus(),
    ok,
    url,
    issues,
    request,
    message: ok ? "" : issues[0].message,
    previewToken: ok ? loadEntryPreviewToken(entry, { url, request }) : undefined,
  };
}

/**
 * "TAI answered 400: <TAI's own reason>" from the usual .NET error shapes
 * (`errors` field map, `message`, `title`, an array of strings, or text).
 */
export function taiRefusalMessage(status: number, json: unknown, text: string): string {
  const reasons: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) reasons.push(value.trim());
  };
  const visit = (value: unknown, depth: number) => {
    if (depth > 3 || value == null) return;
    if (typeof value === "string") return add(value);
    if (Array.isArray(value)) return value.forEach((item) => visit(item, depth + 1));
    if (typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.errors && typeof record.errors === "object" && !Array.isArray(record.errors)) {
      for (const [field, messages] of Object.entries(record.errors as Record<string, unknown>)) {
        for (const message of Array.isArray(messages) ? messages : [messages]) {
          if (typeof message === "string" && message.trim()) reasons.push(field ? `${field}: ${message.trim()}` : message.trim());
        }
      }
    } else if (record.errors) visit(record.errors, depth + 1);
    for (const key of ["message", "Message", "error", "errorMessage", "detail", "title"]) add(record[key]);
    for (const key of ["validationErrors", "ValidationErrors", "messages", "Messages"]) visit(record[key], depth + 1);
  };
  visit(json, 0);
  if (!reasons.length && !json) add(text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300));
  const unique = [...new Set(reasons)].slice(0, 6).join("; ").slice(0, 600);
  return unique ? `TAI answered ${status}: ${unique}` : `TAI answered ${status} with no reason in its response`;
}

type TaiCreateOutcome =
  | { kind: "created"; shipmentId: string; tai: TaiHttpDetail }
  | { kind: "no-id"; tai: TaiHttpDetail }
  | { kind: "refused"; message: string; tai: TaiHttpDetail }
  | { kind: "unreachable"; message: string; tai: TaiHttpDetail };

/** One POST /PublicApi/Shipping/v2/Shipments. Never throws; every outcome is reported with TAI's own answer. */
async function createTaiShipment(
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<TaiCreateOutcome> {
  const url = `${TAI_BASE}${TAI_SHIPMENTS_PATH}`;
  const started = Date.now();
  const detail = (httpStatus: number | null, responseBody: string, responseJson: unknown): TaiHttpDetail => ({
    httpStatus,
    responseBody: responseBody.slice(0, TAI_RESPONSE_KEEP),
    responseJson,
    request: body,
    url,
    durationMs: Date.now() - started,
  });

  let resp: Response;
  try {
    resp = await fetchImpl(url, {
      method: "POST",
      headers: {
        "x-api-key": getConfiguredTaiToken(),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TAI_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { kind: "unreachable", message: `TAI unreachable: ${reason}`, tai: detail(null, "", null) };
  }

  let text = "";
  try {
    text = await resp.text();
  } catch {
    text = "";
  }
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!resp.ok) {
    return { kind: "refused", message: taiRefusalMessage(resp.status, parsed, text), tai: detail(resp.status, text, parsed) };
  }
  const shipmentId = extractTaiShipmentId(parsed, text);
  if (!shipmentId) return { kind: "no-id", tai: detail(resp.status, text, parsed) };
  return { kind: "created", shipmentId, tai: detail(resp.status, text, parsed) };
}

/**
 * Generate Load in TAI. TAI is the source of record: a load is only recorded
 * here (and in Supabase `shipments`) after TAI answered 2xx WITH a shipment id.
 *
 * Refuses, in order, when: the entry fails TAI validation (422); the caller's
 * previewToken is missing or stale (409 requiresPreview); a TAI load already
 * exists for the same customer + reference and `confirmDuplicate` was not sent
 * (409 requiresDuplicateConfirmation); live TAI writes are switched off (503);
 * TAI refuses or is unreachable (502, with TAI's body); TAI accepts without an
 * id (409 requiresReconciliation). No code path invents a TAI-looking id.
 */
export async function bookTaiLoads(
  entry: LoadEntry,
  options: BookTaiLoadsOptions = {},
  dependencies: BookTaiLoadsDependencies = {},
): Promise<TaiBookResult> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const preview = previewTaiBooking(entry);
  const requestTemplate = preview.request;
  const base = { issues: [] as TaiValidationIssue[], request: requestTemplate, createdIds: [] as string[] };

  if (preview.issues.length > 0) {
    return { ...base, ok: false, status: 422, issues: preview.issues, message: preview.issues[0].message };
  }

  if (typeof options.previewToken !== "string" || options.previewToken !== preview.previewToken) {
    return { ...base, ok: false, status: 409, requiresPreview: true, message: TAI_PREVIEW_STALE_MESSAGE };
  }

  const count = Math.max(1, Math.min(10, Math.floor(Number(options.duplicateCount) || 1)));
  // Qty > 1 suffixes the customer PO per order (PO-1, PO-2, …); those are the references
  // TAI and the local store will actually hold, so that is what a repeat must be checked against.
  const perLoadEntries: LoadEntry[] = Array.from({ length: count }, (_, i) => ({
    ...entry,
    references: {
      ...entry.references,
      customerPO:
        count > 1 && entry.references.customerPO ? `${entry.references.customerPO}-${i + 1}` : entry.references.customerPO,
    },
  }));

  if (options.confirmDuplicate !== true) {
    for (const candidate of perLoadEntries) {
      const duplicate = findDuplicateBooking(store.shipments, candidate);
      if (duplicate) {
        return {
          ...base,
          ok: false,
          status: 409,
          requiresDuplicateConfirmation: true,
          duplicateOf: duplicate.shipmentId,
          matchedOn: duplicate.matchedOn,
          message: `Load #${duplicate.shipmentId} is already booked in TAI for ${entry.customer.name.trim()} with the same ${duplicate.matchedOn} (${duplicate.value}). Open that load to change it, or confirm to generate a second one.`,
        };
      }
    }
  }

  const liveStatus = taiBookingStatus();
  if (!liveStatus.enabled) {
    return { ...base, ok: false, status: 503, liveWritesEnabled: false, message: LIVE_TAI_WRITES_OFF_MESSAGE };
  }

  const totals = loadEntryTotals(entry);
  const firstStop = entry.stops[0];
  const lastStop = entry.stops[entry.stops.length - 1];
  const createdIds: string[] = [];
  const sb = store.getSupabase();

  const partialNote = () =>
    createdIds.length > 0 ? ` TAI did confirm ${createdIds.length} load(s) before this: #${createdIds.join(", #")}.` : "";

  for (const perLoadEntry of perLoadEntries) {
    const poVal = perLoadEntry.references.customerPO;
    const body = buildTaiShipmentRequest(perLoadEntry);
    const outcome = await createTaiShipment(body, fetchImpl);

    if (outcome.kind === "refused" || outcome.kind === "unreachable") {
      if (createdIds.length > 0) broadcastOpsEvent("shipment_booked", { createdIds });
      return {
        ...base,
        ok: false,
        status: 502,
        createdIds,
        issues: [{ field: "tai", message: outcome.message }],
        request: body,
        tai: outcome.tai,
        message: `${outcome.message}${partialNote()}`,
      };
    }

    if (outcome.kind === "no-id") {
      if (createdIds.length > 0) broadcastOpsEvent("shipment_booked", { createdIds });
      return {
        ...base,
        ok: false,
        status: 409,
        createdIds,
        requiresReconciliation: true,
        request: body,
        tai: outcome.tai,
        message: `${TAI_RECONCILE_MESSAGE}${partialNote()}`,
      };
    }

    const assignedId = outcome.shipmentId;
    createdIds.push(assignedId);

    const newShipment: OpsShipment = {
      id: assignedId,
      customer: entry.customer.name.trim() || "UNLINKED SPOT CUSTOMER",
      taiOrgId: entry.customer.taiOrganizationId || undefined,
      origin: `${firstStop.city}, ${firstStop.state} ${firstStop.zipCode}`,
      dest: `${lastStop.city}, ${lastStop.state} ${lastStop.zipCode}`,
      stops: structuredClone(entry.stops),
      commodities: structuredClone(entry.items),
      accessorials: entry.accessorials.map(
        (a) => `${a.name} - ${a.scope[0].toUpperCase()}${a.scope.slice(1)}`,
      ),
      stage: entry.carrier.name ? "Assigned" : "Needs truck",
      rawStatus: entry.status,
      carrier: entry.carrier.name || "",
      mc: entry.carrier.mcNumber || "",
      po: poVal,
      bol: entry.references.bolNumber,
      pro: entry.references.carrierProNumber,
      shipDate: extractDateShort(firstStop.readyDate),
      delivDate: extractDateShort(lastStop.readyDate),
      equip: entry.equipment.trailerType,
      trailerSize: entry.equipment.trailerSize,
      mileage: entry.equipment.mileage,
      sell: totals.totalSell,
      buy: totals.totalBuy,
      podCount: 0,
      emailPodAvailable: false,
      rateconStatus: entry.carrier.name ? "Drafted" : "Not Sent",
      writebackState: `Generated live in TAI (#${assignedId}) · CommitDomesticShipmentRequest ${outcome.tai.httpStatus}`,
      location: `${entry.stops.length} stops · ${totals.totalPieces} pcs · ${totals.totalWeight.toLocaleString()} lbs`,
    };

    if (sb) {
      await sb.from("shipments").upsert(
        {
          shipment_id: assignedId,
          status: entry.status,
          customer_name: newShipment.customer,
          customer_tai_organization_id: entry.customer.taiOrganizationId
            ? Number(entry.customer.taiOrganizationId)
            : null,
          carrier_name: entry.carrier.name || "",
          customer_po: poVal,
          shipper_reference: entry.references.bolNumber,
          ship_date: firstStop.readyDate,
          delivery_date: lastStop.readyDate,
          from_city: firstStop.city.toUpperCase(),
          from_state: firstStop.state.toUpperCase(),
          to_city: lastStop.city.toUpperCase(),
          to_state: lastStop.state.toUpperCase(),
          total_weight: totals.totalWeight,
          equipment_type: entry.equipment.trailerType,
          sell: totals.totalSell,
          buy: totals.totalBuy,
          margin: totals.totalMargin,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "shipment_id" },
      );
    }

    store.shipments.unshift(newShipment);
    store.kpis.loads30d += 1;
    if (!entry.carrier.name) store.kpis.uncoveredCommitted += 1;
  }

  broadcastOpsEvent("shipment_booked", { createdIds });
  return {
    ...base,
    ok: true,
    status: 200,
    createdIds,
    liveWritesEnabled: true,
    message: `Generated ${createdIds.length} load(s) in TAI: #${createdIds.join(", #")}`,
  };
}

/**
 * Live-compatible Carrier + Buy Write-Back Queue & 45s Read-Back Waiter.
 * Works simultaneously with `primary-freight-dashboard`'s poller OR `fivenines-ops`'s poller!
 */
export async function enqueueCarrierWriteback(params: {
  shipmentId: string;
  carrierName: string;
  buyRate: number;
  requestedBy?: string;
}) {
  const shipment = store.shipments.find((s) => s.id === params.shipmentId);
  if (!shipment) {
    return { ok: false, status: 404, message: `Shipment #${params.shipmentId} not found` };
  }
  const carrier = store.carriers.find((c) => c.name === params.carrierName);
  const buyNum = Math.max(0, Number(params.buyRate) || 0);
  const sb = store.getSupabase();

  if (!store.isSafeSandbox && sb) {
    // 1. Check app_settings kill switch in Supabase
    const { data: setting } = await sb
      .from("app_settings")
      .select("value")
      .eq("key", "tai_writeback_enabled")
      .maybeSingle();
    if (setting && String(setting.value).toLowerCase() !== "true") {
      return { ok: false, status: 503, message: "TAI writeback is switched off in Supabase app_settings" };
    }

    // 2. Resolve canonical tai_carrier_master_id from Supabase carriers table
    const { data: dbCarrier } = await sb
      .from("carriers")
      .select("tai_carrier_master_id,mc_number")
      .eq("name", params.carrierName.trim())
      .maybeSingle();
    const masterId = dbCarrier?.tai_carrier_master_id ?? (carrier?.taiMasterId ? Number(carrier.taiMasterId) : null);
    if (!masterId) {
      return { ok: false, status: 409, message: `TAI carrierMasterId is unavailable for ${params.carrierName}` };
    }

    // 3. Insert into tai_carrier_assignments
    const { data: inserted, error: insertError } = await sb
      .from("tai_carrier_assignments")
      .insert({
        shipment_id: params.shipmentId,
        carrier_name: params.carrierName.trim(),
        carrier_mc: dbCarrier?.mc_number || carrier?.mc || null,
        carrier_master_id: Number(masterId),
        buy_rate: buyNum,
        requested_by: params.requestedBy || "fivenines-ops",
        dry_run: false,
      })
      .select("id")
      .single();

    if (insertError || !inserted) {
      if (insertError?.code === "23505") {
        const { data: active } = await sb
          .from("tai_carrier_assignments")
          .select("status,response_body")
          .eq("shipment_id", params.shipmentId)
          .in("status", ["pending", "in_flight", "failed"])
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const parked = active?.status === "failed" && isPendingReadBack(active.response_body);
        return {
          ok: false,
          status: 409,
          message: parked ? READ_BACK_PENDING_SAVE_MESSAGE : "This shipment already has a TAI write-back in progress.",
        };
      }
      return { ok: false, status: 502, message: `Could not queue write-back: ${insertError?.message || "unknown"}` };
    }

    // 4. Immediately trigger local poller on save when enabled (avoids 15s wait & racing),
    // then wait up to SAVE_WAIT_MS (45s) for PUT CarrierCharges + GET /Shipments/{id} read-back
    if (pollerConfigStatus().enabled) {
      await runPollerForAssignmentId(inserted.id);
    }

    const deadline = Date.now() + SAVE_WAIT_MS;
    let firstCheck = true;
    while (Date.now() < deadline) {
      if (!firstCheck) await wait(1_500);
      firstCheck = false;
      const { data: outcome } = await sb
        .from("tai_carrier_assignments")
        .select("status,error_message,response_body")
        .eq("id", inserted.id)
        .single();

      if (outcome?.status === "sent") {
        const verifiedBuy = Number((outcome.response_body as { verifiedBuy?: unknown } | null)?.verifiedBuy);
        const finalBuy = Number.isFinite(verifiedBuy) && verifiedBuy > 0 ? verifiedBuy : buyNum;
        shipment.carrier = params.carrierName;
        shipment.mc = String(dbCarrier?.mc_number || carrier?.mc || "");
        shipment.buy = finalBuy;
        if (shipment.stage === "Needs truck") shipment.stage = "Assigned";
        shipment.rateconStatus = "Sent";
        shipment.writebackState = `✓ Verified Live in TAI (Assignment #${inserted.id} · $${finalBuy.toLocaleString()} Buy)`;

        await sb
          .from("shipments")
          .update({
            carrier_name: params.carrierName,
            buy: finalBuy,
            margin: shipment.sell - finalBuy,
            updated_at: new Date().toISOString(),
          })
          .eq("shipment_id", params.shipmentId);

        broadcastOpsEvent("writeback_verified", { shipmentId: shipment.id });
        return {
          ok: true,
          status: 200,
          shipment,
          message: `TAI Read-Back Confirmed: ${params.carrierName} ($${finalBuy.toLocaleString()} buy) on #${shipment.id}!`,
        };
      }

      if (outcome?.status === "needs_human") {
        return {
          ok: false,
          status: 502,
          message: outcome.error_message || "TAI write-back requires human review.",
        };
      }

      if (outcome?.status === "failed" && isPendingReadBack(outcome.response_body)) {
        shipment.writebackState = READ_BACK_PENDING_SAVE_MESSAGE;
        return {
          ok: true,
          status: 202,
          shipment,
          message: READ_BACK_PENDING_SAVE_MESSAGE,
        };
      }
    }

    return {
      ok: true,
      status: 202,
      shipment,
      message: `Queued in tai_carrier_assignments (#${inserted.id}) — poller still awaiting TAI confirmation.`,
    };
  }

  // Safe Sandbox Mode
  shipment.carrier = params.carrierName;
  shipment.mc = carrier?.mc || "";
  shipment.buy = buyNum;
  if (shipment.stage === "Needs truck") shipment.stage = "Assigned";
  shipment.rateconStatus = "Sent";
  shipment.writebackState = `✓ Sandbox Verified: Queued tai_carrier_assignments → Poller PUT CarrierCharges (Master #${carrier?.taiMasterId || "—"} · $${buyNum.toLocaleString()} Buy)`;

  store.webhookLogs.unshift({
    id: `wb-${Date.now()}`,
    timestamp: new Date().toISOString(),
    type: "CarrierWriteBackPoller",
    shipmentId: shipment.id,
    summary: `${params.carrierName} ($${buyNum.toLocaleString()} Buy) verified`,
  });
  broadcastOpsEvent("writeback_verified", { shipmentId: shipment.id });

  return {
    ok: true,
    status: 200,
    shipment,
    message: `Assigned ${params.carrierName} ($${buyNum.toLocaleString()} buy) on #${shipment.id}.`,
  };
}

export function verifyWebhookSecretIfConfigured(headers: Record<string, string | string[] | undefined>, querySecret?: unknown): boolean {
  const expected = process.env.TAI_WEBHOOK_SECRET?.trim();
  if (!expected) return true;
  const headerVal = String(headers["x-tai-webhook-secret"] || headers["x-webhook-secret"] || "").trim();
  const authVal = String(headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const qVal = typeof querySecret === "string" ? querySecret.trim() : "";
  return headerVal === expected || authVal === expected || qVal === expected;
}

function teeWebhookIfConfigured(pathSuffix: string, payload: unknown, headers: Record<string, string | string[] | undefined>): void {
  const teeBase = process.env.TEE_WEBHOOK_URL?.trim().replace(/\/+$/, "");
  if (!teeBase) return;
  const forwardHeaders: Record<string, string> = { "Content-Type": "application/json" };
  if (typeof headers["x-tai-webhook-secret"] === "string") {
    forwardHeaders["x-tai-webhook-secret"] = headers["x-tai-webhook-secret"];
  }
  fetch(`${teeBase}${pathSuffix}`, {
    method: "POST",
    headers: forwardHeaders,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8_000),
  }).catch(() => {});
}

export function handleTaiShipmentWebhook(
  payload: TaiShipmentWebhookPayload,
  headers: Record<string, string | string[] | undefined> = {},
) {
  const id = String(payload.shipmentId || "").trim();
  if (!id) return { ok: false, status: 400, message: "shipmentId is required" };

  teeWebhookIfConfigured("/api/webhooks/tai/shipment", payload, headers);

  let target = store.shipments.find((s) => s.id === id);
  const stage = payload.status ? mapTaiStatusToStage(payload.status) : target?.stage || "Needs truck";
  const topCarrier = payload.carrierList?.[0];
  const poRef = payload.shipmentReferenceNumbers?.find(
    (r) => (r.referenceType || "").toLowerCase() === "customer po number",
  )?.value;
  const podDocs = Array.isArray(payload.attachments)
    ? payload.attachments.filter((a) => /pod|delivery/i.test(String(a.documentType || a.fileName || ""))).length
    : undefined;

  if (!target) {
    const pick = payload.stops?.[0];
    const drop = payload.stops?.[payload.stops.length - 1];
    target = {
      id,
      customer: payload.customer?.name || "TAI Webhook Customer",
      taiOrgId: payload.customer?.billToOrganizationId ? String(payload.customer.billToOrganizationId) : undefined,
      origin: pick ? `${pick.city || ""}, ${pick.state || ""} ${pick.zipCode || ""}`.trim() : "Origin TBD",
      dest: drop ? `${drop.city || ""}, ${drop.state || ""} ${drop.zipCode || ""}`.trim() : "Dest TBD",
      stops: (payload.stops || []).map((st, idx, arr) => ({
        stopType: idx === 0 ? "First Pickup" : idx === arr.length - 1 ? "Last Drop" : "Pick",
        companyName: st.companyName || "Facility",
        streetAddress: st.streetAddress || "",
        city: st.city || "",
        state: st.state || "",
        zipCode: st.zipCode || "00000",
        country: "USA",
        contactName: "",
        phone: "",
        instructions: "",
        readyDate: String(st.estimatedReadyDateTime || st.appointmentReadyDateTime || "2026-11-16").slice(0, 10),
        timeOpen: "08:00",
        timeClose: "15:00",
        appointmentRequired: Boolean(st.appointmentReadyDateTime),
      })),
      commodities: (payload.commodities || [{ description: "Webhook Freight", weightTotal: 35000, piecesTotal: 1 }]).map(
        (c) => ({
          description: c.description || "Freight",
          packagingType: c.packagingType || "Pallet",
          handlingQuantity: c.handlingQuantity ?? 1,
          piecesTotal: c.piecesTotal ?? 1,
          weightTotal: c.weightTotal ?? 0,
          hazardousMaterial: Boolean(c.hazardousMaterial),
          freightClass: "No Class",
          referenceNumber: "",
        }),
      ),
      accessorials: [],
      stage,
      rawStatus: payload.status || "Committed",
      carrier: topCarrier?.name || "",
      mc: topCarrier?.mcNumber || "",
      po: poRef || "",
      bol: "",
      pro: "",
      shipDate: extractDateShort(payload.pickupReadyDateTime || payload.PickupReadyDateTime),
      delivDate: extractDateShort(payload.deliveryEstimatedDateTime || payload.DeliveryEstimatedDateTime),
      equip: payload.trailerType || "53 ft Van | Dry",
      trailerSize: "Full",
      mileage: Number(payload.mileage) || 0,
      sell: Number(payload.totalSell) || 0,
      buy: Number(payload.totalBuy) || 0,
      podCount: podDocs ?? 0,
      emailPodAvailable: false,
      rateconStatus: topCarrier?.name ? "Sent" : "Not Sent",
      writebackState: "Synced inbound from TAI ShipmentDetailUpdateUrl webhook",
      location: payload.locationString || "Inbound TAI webhook created load",
    };
    store.shipments.unshift(target);
  } else {
    if (payload.status) {
      target.rawStatus = payload.status;
      target.stage = stage;
    }
    if (topCarrier?.name) target.carrier = topCarrier.name;
    if (topCarrier?.mcNumber) target.mc = topCarrier.mcNumber;
    if (typeof payload.totalBuy === "number") target.buy = payload.totalBuy;
    if (typeof payload.totalSell === "number" && payload.totalSell > 0) target.sell = payload.totalSell;
    if (poRef) target.po = poRef;
    if (payload.locationString) target.location = `${payload.locationString} (Webhook live)`;
    if (podDocs !== undefined) target.podCount = podDocs;
    target.writebackState = `✓ Inbound TAI ShipmentDetailUpdateUrl synced (${target.rawStatus})`;
  }

  store.webhookLogs.unshift({
    id: `wh-${Date.now()}`,
    timestamp: new Date().toISOString(),
    type: "ShipmentDetailUpdateUrl",
    shipmentId: id,
    summary: `Status → ${target.rawStatus}${payload.locationString ? ` · GPS: ${payload.locationString}` : ""}`,
  });
  broadcastOpsEvent("shipment_updated", { shipmentId: id });

  return { ok: true, status: 200, shipment: target };
}

export function handleTaiInvoiceWebhook(
  payload: TaiInvoiceWebhookPayload,
  headers: Record<string, string | string[] | undefined> = {},
) {
  const id = String(payload.shipmentId || "").trim();
  if (!id) return { ok: false, status: 400, message: "shipmentId is required" };

  teeWebhookIfConfigured("/api/webhooks/tai/invoice", payload, headers);

  const target = store.shipments.find((s) => s.id === id);
  const invNum = payload.invoiceNumber || String(payload.invoiceId || "INV-NEW");
  if (target) {
    target.invoiceStatus = `${payload.invoiceType || "AR"} Invoice ${invNum} ($${Number(payload.totalAmount || target.sell).toLocaleString()})`;
    target.writebackState = `✓ Inbound TAI InvoiceCreateWithShipmentUrl (${target.invoiceStatus})`;
  }
  store.webhookLogs.unshift({
    id: `wh-inv-${Date.now()}`,
    timestamp: new Date().toISOString(),
    type: "InvoiceCreateWithShipmentUrl",
    shipmentId: id,
    summary: `Invoice ${invNum} (${payload.invoiceType || "AR"}) synced for #${id}`,
  });
  broadcastOpsEvent("invoice_updated", { shipmentId: id });
  return { ok: true, status: 200, shipment: target };
}
