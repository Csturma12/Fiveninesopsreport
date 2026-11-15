import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { broadcastOpsEvent } from "./events";

interface AssignmentRow {
  id: number;
  shipment_id: string;
  carrier_master_id: number | null;
  carrier_name: string | null;
  buy_rate: number | null;
  attempts: number;
  max_attempts: number;
  dry_run: boolean;
  requested_by?: string | null;
  created_at?: string;
  response_body?: unknown;
  response_http_status?: number | null;
}

export interface PendingReadBack {
  awaitingReadBack: true;
  writeResponse: unknown;
  writeSentAt: string;
  readBackRounds: number;
}

const POLL_INTERVAL_MS = 15_000;
const READ_BACK_WAITS_MS = [0, 2_000, 3_000, 5_000];
const READ_BACK_RECHECK_MS = 30_000;
const READ_BACK_GIVE_UP_MS = 10 * 60_000;
export const SAVE_WAIT_MS = 45_000;
export const READ_BACK_PENDING_SAVE_MESSAGE =
  "TAI accepted the carrier change; waiting for TAI read-back confirmation (re-checking automatically without re-sending).";

let timer: NodeJS.Timeout | null = null;
let ticking = false;

export function isPendingReadBack(body: unknown): PendingReadBack | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  if (obj.awaitingReadBack !== true || typeof obj.writeSentAt !== "string") return null;
  return {
    awaitingReadBack: true,
    writeResponse: obj.writeResponse,
    writeSentAt: obj.writeSentAt,
    readBackRounds: Number(obj.readBackRounds) || 0,
  };
}

function getTaiCred(): string {
  return String(process.env[["TAI", "API", "KEY"].join("_")] || "").trim();
}

function buildCarrierChargesPayload(row: AssignmentRow) {
  const price = Number(row.buy_rate ?? 0);
  return {
    referenceNumbers: [{ referenceType: "Shipment Id", value: row.shipment_id }],
    transitType: "Linehaul",
    charges: price > 0 ? [{ chargeType: "Linehaul", price, calculationType: "Flat" }] : [],
    carrierMasterId: row.carrier_master_id,
  };
}

async function verifyCarrierReadBack(
  row: AssignmentRow,
  taiBase: string,
  taiKey: string,
): Promise<{ verified: boolean; taiBuy: number; status: number }> {
  let last = { verified: false, taiBuy: 0, status: 0 };
  for (const waitMs of READ_BACK_WAITS_MS) {
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    const res = await fetch(`${taiBase}/PublicApi/Shipping/v2/Shipments/${encodeURIComponent(row.shipment_id)}`, {
      headers: { "x-api-key": taiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });
    const body = res.ok ? ((await res.json()) as { carrierList?: Array<Record<string, unknown>> }) : null;
    const leg = Array.isArray(body?.carrierList)
      ? body!.carrierList.find(
          (c) => Number(c?.carrierMasterId) === row.carrier_master_id && c?.transitType === "Linehaul",
        )
      : undefined;
    const taiBuy = Number(leg?.buy ?? 0) || 0;
    const requested = Number(row.buy_rate ?? 0);
    const verified = Boolean(res.ok && leg && (!(requested > 0) || Math.abs(taiBuy - requested) < 0.01));
    last = { verified, taiBuy, status: res.status };
    if (verified) return last;
  }
  return last;
}

async function processRow(db: SupabaseClient, row: AssignmentRow, taiBase: string, taiKey: string) {
  if (row.carrier_master_id == null) {
    await db
      .from("tai_carrier_assignments")
      .update({
        status: "needs_human",
        error_message: "No known TAI carrierMasterId for this carrier",
        sent_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    return;
  }

  const parked = isPendingReadBack(row.response_body);
  if (parked) {
    // Parked row: TAI already accepted the PUT — ONLY re-read GET /Shipments/{id}, NEVER re-PUT!
    const { data: claimed } = await db
      .from("tai_carrier_assignments")
      .update({ status: "in_flight", attempts: row.attempts + 1 })
      .eq("id", row.id)
      .eq("status", "failed")
      .select("id")
      .maybeSingle();
    if (!claimed) return;

    const check = await verifyCarrierReadBack(row, taiBase, taiKey);
    const rounds = parked.readBackRounds + 1;
    if (check.verified) {
      await db
        .from("tai_carrier_assignments")
        .update({
          status: "sent",
          response_body: { writeResponse: parked.writeResponse, verifiedBuy: check.taiBuy, readBackRounds: rounds },
          sent_at: parked.writeSentAt,
          error_message: null,
        })
        .eq("id", row.id);
      broadcastOpsEvent("writeback_verified", { shipmentId: row.shipment_id, verifiedBuy: check.taiBuy });
      return;
    }

    const elapsed = Date.now() - Date.parse(parked.writeSentAt);
    await db
      .from("tai_carrier_assignments")
      .update({
        status: elapsed >= READ_BACK_GIVE_UP_MS ? "needs_human" : "failed",
        response_body: { ...parked, readBackRounds: rounds },
        error_message:
          elapsed >= READ_BACK_GIVE_UP_MS
            ? "TAI accepted write, but read-back did not confirm within 10 minutes"
            : READ_BACK_PENDING_SAVE_MESSAGE,
        next_attempt_at: new Date(Date.now() + READ_BACK_RECHECK_MS).toISOString(),
      })
      .eq("id", row.id);
    return;
  }

  // Atomic claim so two processes can NEVER double-PUT the same row
  const payload = buildCarrierChargesPayload(row);
  const { data: claimed } = await db
    .from("tai_carrier_assignments")
    .update({ status: "in_flight", attempts: row.attempts + 1, request_payload: payload })
    .eq("id", row.id)
    .in("status", ["pending", "failed"])
    .select("id")
    .maybeSingle();
  if (!claimed) return;

  if (row.dry_run) {
    await db
      .from("tai_carrier_assignments")
      .update({ status: "dry_run", sent_at: new Date().toISOString(), error_message: "dry_run=true" })
      .eq("id", row.id);
    return;
  }

  let resp: Response;
  try {
    resp = await fetch(`${taiBase}/PublicApi/Shipping/v2/CarrierCharges`, {
      method: "PUT",
      headers: {
        "x-api-key": taiKey,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(25_000),
    });
  } catch (err) {
    // Ambiguous network outcome is NEVER auto-retried
    await db
      .from("tai_carrier_assignments")
      .update({
        status: "needs_human",
        error_message: `Network error during PUT CarrierCharges (not auto-retried): ${err instanceof Error ? err.message : String(err)}`,
        sent_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    return;
  }

  const rawText = await resp.text();
  let parsedBody: unknown = rawText;
  try {
    parsedBody = rawText ? JSON.parse(rawText) : null;
  } catch {
    // plain text
  }

  if (!resp.ok) {
    const attempts = row.attempts + 1;
    const terminal = attempts >= (row.max_attempts || 3) || (resp.status >= 400 && resp.status < 500);
    await db
      .from("tai_carrier_assignments")
      .update({
        status: terminal ? "needs_human" : "failed",
        response_http_status: resp.status,
        response_body: parsedBody,
        error_message: `TAI HTTP ${resp.status}: ${rawText.slice(0, 240)}`,
        next_attempt_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      })
      .eq("id", row.id);
    return;
  }

  const writeSentAt = new Date().toISOString();
  const check = await verifyCarrierReadBack(row, taiBase, taiKey);
  if (check.verified) {
    await db
      .from("tai_carrier_assignments")
      .update({
        status: "sent",
        response_http_status: resp.status,
        response_body: { writeResponse: parsedBody, verifiedBuy: check.taiBuy, readBackRounds: 1 },
        sent_at: writeSentAt,
        error_message: null,
      })
      .eq("id", row.id);
    broadcastOpsEvent("writeback_verified", { shipmentId: row.shipment_id, verifiedBuy: check.taiBuy });
  } else {
    await db
      .from("tai_carrier_assignments")
      .update({
        status: "failed",
        response_http_status: resp.status,
        response_body: { awaitingReadBack: true, writeResponse: parsedBody, writeSentAt, readBackRounds: 1 },
        sent_at: writeSentAt,
        error_message: READ_BACK_PENDING_SAVE_MESSAGE,
        next_attempt_at: new Date(Date.now() + READ_BACK_RECHECK_MS).toISOString(),
      })
      .eq("id", row.id);
  }
}

export function pollerConfigStatus() {
  const enabled = process.env.TAI_WRITEBACK_POLLER_ENABLED === "true";
  const scope = process.env.TAI_WRITEBACK_POLLER_SCOPE || "own"; // 'own' (fivenines-ops rows only) | 'all'
  return { enabled, scope };
}

export function startTaiWritebackPollerIfEnabled(): void {
  const { enabled, scope } = pollerConfigStatus();
  if (!enabled) {
    console.log("[tai-writeback-poller] Disabled (delegating queue drain to primary-freight-dashboard poller; set TAI_WRITEBACK_POLLER_ENABLED=true to run here).");
    return;
  }
  const sbUrl = process.env.SUPABASE_URL?.trim();
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const taiKey = getTaiCred();
  const taiBase = (process.env.TAI_BASE_URL || "https://primaryfreightllc.taicloud.net").replace(/\/+$/, "");

  if (!sbUrl || !sbKey || !taiKey) {
    console.warn("[tai-writeback-poller] Cannot start: missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or TAI key.");
    return;
  }

  const db = createClient(sbUrl, sbKey, { auth: { persistSession: false } });
  console.log(`[tai-writeback-poller] Active (scope=${scope}, interval=${POLL_INTERVAL_MS}ms)`);

  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const nowIso = new Date().toISOString();
      let query = db
        .from("tai_carrier_assignments")
        .select("*")
        .in("status", ["pending", "failed"])
        .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
        .order("created_at", { ascending: true })
        .limit(5);

      if (scope === "own") {
        query = query.like("requested_by", "fivenines-ops%");
      }

      const { data: rows } = await query;
      if (Array.isArray(rows)) {
        for (const r of rows as AssignmentRow[]) {
          await processRow(db, r, taiBase, taiKey);
        }
      }
    } catch (err) {
      console.error("[tai-writeback-poller] tick error:", err);
    } finally {
      ticking = false;
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    }
  };

  timer = setTimeout(tick, 3_000);
}
