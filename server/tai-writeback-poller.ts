import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { broadcastOpsEvent } from "./events";
import {
  haltTaiOnAuthFailure,
  isTaiAuthFailureStatus,
  isTaiAuthHalted,
  onTaiAuthHalt,
  recordTaiPush,
  taiApiKey,
  type SupabaseInsertLike,
} from "./tai-push-log";

export interface AssignmentRow {
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
let pollerHalted = false;
let pollerHaltReason: string | null = null;

export function stopTaiWritebackPoller(reason?: string): void {
  if (reason) {
    pollerHalted = true;
    pollerHaltReason = reason;
    console.error(`[tai-writeback-poller] HALTED: ${reason}`);
  }
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

export function isWritebackPollerHalted(): { halted: boolean; reason: string | null } {
  return { halted: pollerHalted, reason: pollerHaltReason };
}

export function resetWritebackPollerHalt(): void {
  pollerHalted = false;
  pollerHaltReason = null;
}

onTaiAuthHalt((reason) => {
  stopTaiWritebackPoller(reason);
});

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

async function logAuditEvent(
  db: SupabaseClient,
  row: AssignmentRow,
  event: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    const { error } = await db.from("tai_carrier_assignment_log").insert({
      assignment_id: row.id,
      shipment_id: row.shipment_id,
      event,
      ...extra,
    });
    if (error) {
      console.warn(`[tai-writeback-poller] could not write audit log for #${row.id}: ${error.message}`);
    }
  } catch (err) {
    console.warn("[tai-writeback-poller] audit log insert error:", err instanceof Error ? err.message : err);
  }
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

export function isNumericTaiShipmentId(shipmentId: unknown): boolean {
  return /^\d+$/.test(String(shipmentId ?? "").trim());
}

async function verifyCarrierReadBack(
  row: AssignmentRow,
  taiBase: string,
  taiKey: string,
  doFetch: typeof fetch = fetch,
  waitsMs: readonly number[] = READ_BACK_WAITS_MS,
): Promise<{ verified: boolean; taiBuy: number; status: number; authFailed?: boolean }> {
  if (!isNumericTaiShipmentId(row.shipment_id)) {
    return { verified: false, taiBuy: 0, status: 0 };
  }
  const cleanShipmentId = String(row.shipment_id).trim();
  let last: { verified: boolean; taiBuy: number; status: number; authFailed?: boolean } = {
    verified: false,
    taiBuy: 0,
    status: 0,
  };
  for (const waitMs of waitsMs) {
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    let res: Response;
    try {
      res = await doFetch(`${taiBase}/PublicApi/Shipping/v2/Shipments/${encodeURIComponent(cleanShipmentId)}`, {
        headers: { "x-api-key": taiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(12_000),
      });
    } catch {
      last = { verified: false, taiBuy: 0, status: 0 };
      continue;
    }
    if (isTaiAuthFailureStatus(res.status)) {
      // Stop immediately on 401/403 — never keep polling TAI with rejected credentials
      return { verified: false, taiBuy: 0, status: res.status, authFailed: true };
    }
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

export interface ProcessWritebackOptions {
  taiBase: string;
  credential: string;
  fetchImpl?: typeof fetch;
  readBackWaitsMs?: readonly number[];
  liveInsertAudit?: boolean;
}

export async function processWritebackRow(
  db: SupabaseClient,
  row: AssignmentRow,
  options: ProcessWritebackOptions,
): Promise<{ status: string; haltedOnAuth?: boolean; httpStatus?: number }> {
  const taiBase = options.taiBase.replace(/\/+$/, "");
  const taiKey = taiApiKey(options.credential);
  const doFetch = options.fetchImpl ?? fetch;
  const waitsMs = options.readBackWaitsMs ?? READ_BACK_WAITS_MS;

  if (isTaiAuthHalted(taiKey)) {
    const haltMsg = "TAI poller is halted due to a prior HTTP 401/403 authentication error.";
    await db
      .from("tai_carrier_assignments")
      .update({
        status: "needs_human",
        error_message: haltMsg,
        next_attempt_at: null,
      })
      .eq("id", row.id);
    return { status: "needs_human", haltedOnAuth: true };
  }

  if (!isNumericTaiShipmentId(row.shipment_id)) {
    const nonNumErr = `Refused TAI write-back: shipment_id "${row.shipment_id}" is not a numeric TAI Shipment ID`;
    await db
      .from("tai_carrier_assignments")
      .update({
        status: "needs_human",
        error_message: nonNumErr,
        sent_at: new Date().toISOString(),
        next_attempt_at: null,
      })
      .eq("id", row.id);
    await logAuditEvent(db, row, "failed_terminal", { error: nonNumErr });
    return { status: "needs_human" };
  }

  if (row.carrier_master_id == null) {
    await db
      .from("tai_carrier_assignments")
      .update({
        status: "needs_human",
        error_message: "No known TAI carrierMasterId for this carrier",
        sent_at: new Date().toISOString(),
        next_attempt_at: null,
      })
      .eq("id", row.id);
    return { status: "needs_human" };
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
    if (!claimed) return { status: "skipped" };

    const check = await verifyCarrierReadBack(row, taiBase, taiKey, doFetch, waitsMs);
    if (check.authFailed) {
      const authReason = `TAI HTTP ${check.status} on GET /Shipments/${row.shipment_id} — halted immediately to prevent TAI account lockout`;
      haltTaiOnAuthFailure(taiKey, authReason);
      await db
        .from("tai_carrier_assignments")
        .update({
          status: "needs_human",
          response_http_status: check.status,
          error_message: authReason,
          next_attempt_at: null,
        })
        .eq("id", row.id);
      await logAuditEvent(db, row, "halted_auth_failure", { http_status: check.status, error: authReason });
      return { status: "needs_human", haltedOnAuth: true, httpStatus: check.status };
    }

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
      await logAuditEvent(db, row, "sent", {
        http_status: row.response_http_status ?? 200,
        payload: buildCarrierChargesPayload(row),
      });
      broadcastOpsEvent("writeback_verified", { shipmentId: row.shipment_id, verifiedBuy: check.taiBuy });
      return { status: "sent", httpStatus: check.status };
    }

    const elapsed = Date.now() - Date.parse(parked.writeSentAt);
    const expired = elapsed >= READ_BACK_GIVE_UP_MS;
    const reason = expired
      ? "TAI accepted write, but read-back did not confirm within 10 minutes"
      : READ_BACK_PENDING_SAVE_MESSAGE;
    await db
      .from("tai_carrier_assignments")
      .update({
        status: expired ? "needs_human" : "failed",
        response_body: { ...parked, readBackRounds: rounds },
        error_message: reason,
        next_attempt_at: expired ? null : new Date(Date.now() + READ_BACK_RECHECK_MS).toISOString(),
      })
      .eq("id", row.id);
    await logAuditEvent(db, row, expired ? "failed_terminal" : "read_back_pending", { error: reason });
    return { status: expired ? "needs_human" : "failed" };
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
  if (!claimed) return { status: "skipped" };

  if (row.dry_run) {
    await db
      .from("tai_carrier_assignments")
      .update({ status: "dry_run", sent_at: new Date().toISOString(), error_message: "dry_run=true" })
      .eq("id", row.id);
    return { status: "dry_run" };
  }

  const reqHeaders = {
    "x-api-key": taiKey,
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  let resp: Response;
  try {
    resp = await doFetch(`${taiBase}/PublicApi/Shipping/v2/CarrierCharges`, {
      method: "PUT",
      headers: reqHeaders,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(25_000),
    });
  } catch (err) {
    // Ambiguous network outcome / timeout is NEVER auto-retried
    const errMsg = `Network error during PUT CarrierCharges (not auto-retried): ${err instanceof Error ? err.message : String(err)}`;
    await db
      .from("tai_carrier_assignments")
      .update({
        status: "needs_human",
        error_message: errMsg,
        sent_at: new Date().toISOString(),
        next_attempt_at: null,
      })
      .eq("id", row.id);
    await logAuditEvent(db, row, "failed_terminal", { error: errMsg });
    void recordTaiPush({
      shipmentId: row.shipment_id,
      kind: "carrier_charges",
      method: "PUT",
      endpoint: "/PublicApi/Shipping/v2/CarrierCharges",
      requestHeaders: reqHeaders,
      requestPayload: payload,
      responseStatus: null,
      responseBody: null,
      ok: false,
      needsHuman: true,
      errorMessage: errMsg,
      actor: row.requested_by ?? "poller",
      supabaseClient: db as unknown as SupabaseInsertLike,
      liveInsert: options.liveInsertAudit ?? true,
      redactValues: [taiKey],
    });
    return { status: "needs_human" };
  }

  const rawText = await resp.text();
  let parsedBody: unknown = rawText;
  try {
    parsedBody = rawText ? JSON.parse(rawText) : null;
  } catch {
    // plain text
  }

  if (isTaiAuthFailureStatus(resp.status)) {
    const authErr = `TAI HTTP ${resp.status} on PUT CarrierCharges — poller halted immediately to prevent TAI account lockout`;
    haltTaiOnAuthFailure(taiKey, authErr);
    await db
      .from("tai_carrier_assignments")
      .update({
        status: "needs_human",
        response_http_status: resp.status,
        response_body: parsedBody,
        error_message: authErr,
        next_attempt_at: null,
      })
      .eq("id", row.id);
    await logAuditEvent(db, row, "halted_auth_failure", {
      http_status: resp.status,
      error: authErr,
    });
    void recordTaiPush({
      shipmentId: row.shipment_id,
      kind: "carrier_charges",
      method: "PUT",
      endpoint: "/PublicApi/Shipping/v2/CarrierCharges",
      requestHeaders: reqHeaders,
      requestPayload: payload,
      responseStatus: resp.status,
      responseBody: parsedBody,
      ok: false,
      needsHuman: true,
      errorMessage: authErr,
      actor: row.requested_by ?? "poller",
      supabaseClient: db as unknown as SupabaseInsertLike,
      liveInsert: options.liveInsertAudit ?? true,
      redactValues: [taiKey],
    });
    return { status: "needs_human", haltedOnAuth: true, httpStatus: resp.status };
  }

  if (!resp.ok) {
    // Never blind-retry failed/ambiguous PUT CarrierCharges writes; mark needs_human for manual reconciliation.
    const errMsg = `TAI HTTP ${resp.status}: ${rawText.slice(0, 240)}`;
    await db
      .from("tai_carrier_assignments")
      .update({
        status: "needs_human",
        response_http_status: resp.status,
        response_body: parsedBody,
        error_message: errMsg,
        next_attempt_at: null,
      })
      .eq("id", row.id);
    await logAuditEvent(db, row, "failed_terminal", {
      http_status: resp.status,
      error: errMsg,
    });
    void recordTaiPush({
      shipmentId: row.shipment_id,
      kind: "carrier_charges",
      method: "PUT",
      endpoint: "/PublicApi/Shipping/v2/CarrierCharges",
      requestHeaders: reqHeaders,
      requestPayload: payload,
      responseStatus: resp.status,
      responseBody: parsedBody,
      ok: false,
      needsHuman: true,
      errorMessage: errMsg,
      actor: row.requested_by ?? "poller",
      supabaseClient: db as unknown as SupabaseInsertLike,
      liveInsert: options.liveInsertAudit ?? true,
      redactValues: [taiKey],
    });
    return { status: "needs_human", httpStatus: resp.status };
  }

  void recordTaiPush({
    shipmentId: row.shipment_id,
    kind: "carrier_charges",
    method: "PUT",
    endpoint: "/PublicApi/Shipping/v2/CarrierCharges",
    requestHeaders: reqHeaders,
    requestPayload: payload,
    responseStatus: resp.status,
    responseBody: parsedBody,
    ok: true,
    needsHuman: false,
    actor: row.requested_by ?? "poller",
    supabaseClient: db as unknown as SupabaseInsertLike,
    liveInsert: options.liveInsertAudit ?? true,
    redactValues: [taiKey],
  });

  const writeSentAt = new Date().toISOString();
  const check = await verifyCarrierReadBack(row, taiBase, taiKey, doFetch, waitsMs);
  if (check.authFailed) {
    const authErr = `TAI HTTP ${check.status} during CarrierCharges read-back — poller halted immediately`;
    haltTaiOnAuthFailure(taiKey, authErr);
    await db
      .from("tai_carrier_assignments")
      .update({
        status: "needs_human",
        response_http_status: check.status,
        response_body: { awaitingReadBack: true, writeResponse: parsedBody, writeSentAt, readBackRounds: 1 },
        sent_at: writeSentAt,
        error_message: authErr,
        next_attempt_at: null,
      })
      .eq("id", row.id);
    await logAuditEvent(db, row, "halted_auth_failure", { http_status: check.status, error: authErr });
    return { status: "needs_human", haltedOnAuth: true, httpStatus: check.status };
  }

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
    await logAuditEvent(db, row, "sent", { http_status: resp.status, payload });
    broadcastOpsEvent("writeback_verified", { shipmentId: row.shipment_id, verifiedBuy: check.taiBuy });
    return { status: "sent", httpStatus: resp.status };
  }

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
  await logAuditEvent(db, row, "read_back_pending", {
    http_status: resp.status,
    error: READ_BACK_PENDING_SAVE_MESSAGE,
  });
  return { status: "failed", httpStatus: resp.status };
}

export function pollerConfigStatus() {
  const enabled = process.env.TAI_WRITEBACK_POLLER_ENABLED !== "false" && !pollerHalted;
  const scope = process.env.TAI_WRITEBACK_POLLER_SCOPE || "own"; // 'own' (fivenines-ops rows only) | 'all'
  return { enabled, scope, halted: pollerHalted, haltReason: pollerHaltReason };
}

/**
 * Immediately processes a newly queued assignment on save so fivenines-ops claims
 * and sends its own write-backs right away without waiting for the 15s tick.
 */
export async function runPollerForAssignmentId(assignmentId: number): Promise<void> {
  if (!pollerConfigStatus().enabled) return;
  const sbUrl = process.env.SUPABASE_URL?.trim();
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const taiKey = taiApiKey();
  const taiBase = (process.env.TAI_BASE_URL || "https://primaryfreightllc.taicloud.net").replace(/\/+$/, "");
  if (!sbUrl || !sbKey || !taiKey || isTaiAuthHalted(taiKey)) return;

  try {
    const db = createClient(sbUrl, sbKey, { auth: { persistSession: false } });
    const { data: row } = await db
      .from("tai_carrier_assignments")
      .select("*")
      .eq("id", assignmentId)
      .in("status", ["pending", "failed"])
      .maybeSingle();
    if (row) {
      await processWritebackRow(db, row as AssignmentRow, { taiBase, credential: taiKey });
    }
  } catch (err) {
    console.error(
      `[tai-writeback-poller] immediate run failed for #${assignmentId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

export function startTaiWritebackPollerIfEnabled(): void {
  const { enabled, scope } = pollerConfigStatus();
  if (!enabled) {
    console.log("[tai-writeback-poller] Disabled via TAI_WRITEBACK_POLLER_ENABLED=false or auth halt.");
    return;
  }
  const sbUrl = process.env.SUPABASE_URL?.trim();
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const taiKey = taiApiKey();
  const taiBase = (process.env.TAI_BASE_URL || "https://primaryfreightllc.taicloud.net").replace(/\/+$/, "");

  if (!sbUrl || !sbKey || !taiKey) {
    console.warn("[tai-writeback-poller] Cannot start: missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or TAI key.");
    return;
  }

  const db = createClient(sbUrl, sbKey, { auth: { persistSession: false } });
  console.log(`[tai-writeback-poller] Active (scope=${scope}, interval=${POLL_INTERVAL_MS}ms)`);

  const tick = async () => {
    if (ticking || pollerHalted) return;
    ticking = true;
    try {
      const currentCred = taiApiKey();
      if (!currentCred || isTaiAuthHalted(currentCred)) {
        stopTaiWritebackPoller("Poller paused: TAI credential missing or halted.");
        return;
      }
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
          const outcome = await processWritebackRow(db, r, { taiBase, credential: currentCred });
          if (outcome.haltedOnAuth || pollerHalted) {
            return;
          }
        }
      }
    } catch (err) {
      console.error("[tai-writeback-poller] tick error:", err);
    } finally {
      ticking = false;
      if (!pollerHalted) {
        timer = setTimeout(tick, POLL_INTERVAL_MS);
      }
    }
  };

  timer = setTimeout(tick, 3_000);
}
