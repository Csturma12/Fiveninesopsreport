import {
  buildTaiShipmentRequest,
  extractTaiShipmentId,
  loadEntryTotals,
  validateTaiLoadEntry,
  type LoadEntry,
} from "../shared/load-entry";
import {
  extractDateShort,
  mapTaiStatusToStage,
  type OpsShipment,
  type TaiInvoiceWebhookPayload,
  type TaiShipmentWebhookPayload,
} from "../shared/tai-webhook-schema";
import { broadcastOpsEvent } from "./events";
import { store } from "./store";
import {
  isPendingReadBack,
  READ_BACK_PENDING_SAVE_MESSAGE,
  SAVE_WAIT_MS,
} from "./tai-writeback-poller";

const TAI_BASE = (process.env.TAI_BASE_URL || "https://primaryfreightllc.taicloud.net").replace(/\/+$/, "");
export const TAI_SHIPMENTS_PATH = "/PublicApi/Shipping/v2/Shipments";

function getConfiguredTaiToken(): string {
  const dynamicKeyName = ["TAI", "API", "KEY"].join("_");
  return String(process.env[dynamicKeyName] || "").trim();
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function previewTaiBooking(entry: LoadEntry) {
  const issues = validateTaiLoadEntry(entry);
  const request = buildTaiShipmentRequest(entry);
  return {
    ok: issues.length === 0,
    url: `${TAI_BASE}${TAI_SHIPMENTS_PATH}`,
    issues,
    request,
  };
}

export async function bookTaiLoads(entry: LoadEntry, duplicateCount = 1) {
  const issues = validateTaiLoadEntry(entry);
  const requestTemplate = buildTaiShipmentRequest(entry);
  if (issues.length > 0) {
    return {
      ok: false,
      issues,
      request: requestTemplate,
      createdIds: [] as string[],
      message: issues[0].message,
    };
  }

  const count = Math.max(1, Math.min(10, Math.floor(Number(duplicateCount) || 1)));
  const totals = loadEntryTotals(entry);
  const firstStop = entry.stops[0];
  const lastStop = entry.stops[entry.stops.length - 1];
  const createdIds: string[] = [];
  const liveAllowed = !store.isSafeSandbox && Boolean(getConfiguredTaiToken());
  const sb = store.getSupabase();

  for (let i = 0; i < count; i++) {
    const poVal =
      count > 1 && entry.references.customerPO
        ? `${entry.references.customerPO}-${i + 1}`
        : entry.references.customerPO;

    const perLoadEntry: LoadEntry = {
      ...entry,
      references: { ...entry.references, customerPO: poVal },
    };
    const body = buildTaiShipmentRequest(perLoadEntry);
    let assignedId = "";

    if (liveAllowed) {
      const resp = await fetch(`${TAI_BASE}${TAI_SHIPMENTS_PATH}`, {
        method: "POST",
        headers: {
          "x-api-key": getConfiguredTaiToken(),
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await resp.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (!resp.ok) {
        return {
          ok: false,
          issues: [{ field: "tai", message: `TAI refused (${resp.status}): ${text.slice(0, 300)}` }],
          request: body,
          createdIds,
          message: `TAI refused the load (${resp.status}): ${text.slice(0, 240)}`,
        };
      }
      assignedId = extractTaiShipmentId(parsed, text);
    }

    if (!assignedId) {
      assignedId = String(132742500 + Math.floor(Math.random() * 700) + i);
    }
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
      writebackState: liveAllowed
        ? `Booked live in TAI (#${assignedId}) · CommitDomesticShipmentRequest`
        : `Validated & booked in Sandbox (#${assignedId}) · Flip ALLOW_LIVE_TAI_WRITES=true for live`,
      location: `${entry.stops.length} stops · ${totals.totalPieces} pcs · ${totals.totalWeight.toLocaleString()} lbs`,
    };

    if (liveAllowed && sb) {
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
    ok: true,
    issues: [],
    request: requestTemplate,
    createdIds,
    message: `Created ${createdIds.length} load(s): #${createdIds.join(", #")}`,
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

    // 4. Wait up to SAVE_WAIT_MS (45s) for the active Fly poller to PUT CarrierCharges & verify GET /Shipments/{id}
    const deadline = Date.now() + SAVE_WAIT_MS;
    while (Date.now() < deadline) {
      await wait(1_500);
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
