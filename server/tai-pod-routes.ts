import express from "express";
import type { Express, Request, RequestHandler, Response } from "express";
import { broadcastOpsEvent } from "./events";
import { store } from "./store";
import {
  MAX_POD_BYTES,
  podInputFromBase64Body,
  taiNumericShipmentId,
  uploadPodToTai,
  type PodFileInput,
  type PodUploadConfig,
  type PodUploadResult,
} from "./tai-pod-upload";

export const POD_UPLOAD_ROUTE = "/api/loads/:id/pod";

/** Resolved per request so tests and Fly secrets changes are picked up without a restart. */
export function podUploadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PodUploadConfig {
  const keyName = ["TAI", "API", "KEY"].join("_");
  return {
    baseUrl: (env.TAI_BASE_URL || "https://primaryfreightllc.taicloud.net").replace(/\/+$/, ""),
    credential: String(env[keyName] || "").trim(),
    enabled: env.ALLOW_LIVE_TAI_WRITES === "true",
  };
}

export interface PodUploadRouteOptions {
  fetchImpl?: typeof fetch;
  config?: () => PodUploadConfig;
  readBackDelayMs?: number;
}

/**
 * Accepts either the raw file bytes (`Content-Type: application/pdf|image/jpeg`, `?fileName=`)
 * or a small JSON body `{ fileName, mimeType, base64 }`. The dashboard and /gmail-panel both post
 * through this server route, so the TAI key never reaches a browser or the Gmail extension.
 */
function podInputFromRequest(req: Request): PodFileInput {
  if (Buffer.isBuffer(req.body)) {
    const rawName = Array.isArray(req.query.fileName) ? req.query.fileName[0] : req.query.fileName;
    return {
      fileName: typeof rawName === "string" ? rawName : undefined,
      mimeType: req.headers["content-type"],
      bytes: req.body,
    };
  }
  return podInputFromBase64Body(req.body);
}

export function statusCodeForPodResult(result: PodUploadResult): number {
  if (result.ok && result.status === "verified") return 201;
  switch (result.status) {
    case "invalid":
      return 400;
    case "unavailable":
      return 503;
    case "rejected":
      return 502;
    default:
      return 409;
  }
}

export function createPodUploadHandler(options: PodUploadRouteOptions = {}): RequestHandler {
  const fetchImpl = options.fetchImpl ?? fetch;
  const getConfig = options.config ?? (() => podUploadConfigFromEnv());

  return async (req: Request, res: Response) => {
    const requestedId = String(req.params.id ?? "").trim();
    if (taiNumericShipmentId(requestedId) === null) {
      res.status(400).json({ ok: false, status: "invalid", message: "A numeric TAI shipment ID is required to upload a POD." });
      return;
    }
    const shipment = store.shipments.find((x) => x.id === requestedId);
    if (!shipment) {
      res.status(404).json({ ok: false, status: "invalid", message: `Shipment #${requestedId} not found` });
      return;
    }

    let result: PodUploadResult;
    try {
      result = await uploadPodToTai(shipment.id, podInputFromRequest(req), getConfig(), fetchImpl, {
        readBackDelayMs: options.readBackDelayMs,
      });
    } catch (err) {
      // An unexpected exception might occur after TAI accepted the POST; do not invite a blind retry.
      console.error("[tai-pod] upload threw:", err instanceof Error ? err.message : err);
      res.status(409).json({
        ok: false,
        status: "needs_review",
        message: "The POD upload result is unknown. Check the shipment in TAI before trying again; POD status unchanged locally.",
      });
      return;
    }

    if (!(result.ok && result.status === "verified" && result.attachment)) {
      // Fail loudly and leave podCount / writebackState untouched: TAI did not confirm anything.
      res.status(statusCodeForPodResult(result)).json(result);
      return;
    }

    const verifiedCount = result.podCount ?? 1;
    shipment.podCount = verifiedCount;
    shipment.emailPodAvailable = false;
    shipment.writebackState = `✓ POD "${result.attachment.attachmentName}" verified in TAI (Document #${result.attachment.documentId} · read back via GET /PublicApi/Shipping/v2/Shipments/${shipment.id})`;
    store.kpis.emailPodReady = Math.max(0, store.kpis.emailPodReady - 1);
    for (const em of store.crucialEmails) {
      if (em.loadId === shipment.id && em.diffType === "missing_pod") em.applied = true;
    }
    store.webhookLogs.unshift({
      id: `pod-${Date.now()}`,
      timestamp: new Date().toISOString(),
      type: "DocumentAttachments",
      shipmentId: shipment.id,
      summary: `POD ${result.attachment.attachmentName} (Document #${result.attachment.documentId}) verified by TAI read-back`,
    });

    let mirrorStatus: "synced" | "pending" | "skipped" = "skipped";
    const sb = store.getSupabase();
    if (sb) {
      try {
        const { error } = await sb
          .from("shipments")
          .update({ pod_document_count: verifiedCount, updated_at: new Date().toISOString() })
          .eq("shipment_id", shipment.id);
        mirrorStatus = error ? "pending" : "synced";
        if (error) console.error("[tai-pod] Verified POD, but Supabase mirror failed:", error.message);
      } catch (err) {
        mirrorStatus = "pending";
        console.error("[tai-pod] Verified POD, but Supabase mirror threw:", err instanceof Error ? err.message : err);
      }
    }

    const uploader = req.staffUser?.email || "fivenines-ops";
    console.info(`[tai-pod] ${uploader} uploaded document ${result.documentId} on shipment ${shipment.id}; mirror=${mirrorStatus}`);
    broadcastOpsEvent("shipment_updated", { shipmentId: shipment.id });
    res.status(201).json({
      ...result,
      shipment,
      mirrorStatus,
      message:
        mirrorStatus === "pending"
          ? `${result.message} Supabase mirror is still pending; TAI is the source of record.`
          : result.message,
    });
  };
}

export function registerPodUploadRoute(app: Express, options: PodUploadRouteOptions = {}): void {
  app.post(
    POD_UPLOAD_ROUTE,
    express.raw({ type: ["application/pdf", "image/jpeg"], limit: MAX_POD_BYTES }),
    createPodUploadHandler(options),
  );
}
