/**
 * Real TAI POD upload — ported from primary-freight-dashboard/server/tai-pod-upload.ts.
 *
 * Flow: validate bytes → GET /Shipments/{id} (preflight) → POST /DocumentAttachments (exactly once)
 * → GET /Shipments/{id} read-back until the new POD document is visible.
 *
 * A successful HTTP POST alone never means the POD is verified; only the read-back does.
 * The TAI key never leaves this process and is never echoed in a message.
 */

export const MAX_POD_BYTES = 10 * 1024 * 1024;
export const TAI_DOCUMENT_ATTACHMENTS_PATH = "/PublicApi/Shipping/v2/DocumentAttachments";

export type PodMimeType = "application/pdf" | "image/jpeg";

export type PodUploadStatus = "verified" | "invalid" | "unavailable" | "rejected" | "needs_review";

export interface TaiAttachment {
  attachmentName: string;
  attachmentUrl: string;
  attachmentType: string;
  documentId: number | null;
}

export interface PodUploadResult {
  ok: boolean;
  status: PodUploadStatus;
  message: string;
  documentId?: number;
  attachment?: Pick<TaiAttachment, "attachmentName" | "attachmentType" | "documentId">;
  /** POD-typed documents TAI reports on the shipment after read-back. */
  podCount?: number;
  documents?: TaiAttachment[];
}

export interface PodUploadConfig {
  baseUrl: string;
  credential: string;
  /** Mirrors ALLOW_LIVE_TAI_WRITES=true. When false nothing is sent to TAI. */
  enabled: boolean;
}

export interface PodFileInput {
  fileName: unknown;
  mimeType: unknown;
  bytes: unknown;
}

export interface ValidPod {
  shipmentId: string;
  fileName: string;
  mimeType: PodMimeType;
  bytes: Buffer;
}

export function taiNumericShipmentId(value: string): string | null {
  const trimmed = String(value || "").trim();
  return /^\d{1,12}$/.test(trimmed) ? trimmed : null;
}

const failure = (status: Exclude<PodUploadStatus, "verified">, message: string): PodUploadResult => ({
  ok: false,
  status,
  message,
});

export function isPodAttachment(attachment: Pick<TaiAttachment, "attachmentType" | "attachmentName">): boolean {
  return /pod|proof\s*of\s*delivery|delivery/i.test(`${attachment.attachmentType} ${attachment.attachmentName}`);
}

/** Validate bytes as well as the client's MIME claim; never load a client-supplied URL. */
export function validatePodUpload(
  shipmentId: string,
  input: PodFileInput,
): { ok: true; value: ValidPod } | { ok: false; result: PodUploadResult } {
  const id = taiNumericShipmentId(shipmentId);
  if (id === null) {
    return { ok: false, result: failure("invalid", "A numeric TAI shipment ID is required to upload a POD.") };
  }
  if (input.bytes === undefined && input.fileName === undefined) {
    return {
      ok: false,
      result: failure(
        "invalid",
        "No POD file received. Send the PDF/JPEG bytes with ?fileName= or a JSON body { fileName, mimeType, base64 }.",
      ),
    };
  }
  const fileName = typeof input.fileName === "string" ? input.fileName.trim() : "";
  if (!fileName || fileName.length > 255 || /[\\/\x00-\x1f\x7f<>:"|?*]/.test(fileName)) {
    return {
      ok: false,
      result: failure("invalid", "Use a file name without path or special characters (255 characters maximum)."),
    };
  }
  const mimeType = typeof input.mimeType === "string" ? input.mimeType.split(";")[0].trim().toLowerCase() : "";
  if (mimeType !== "application/pdf" && mimeType !== "image/jpeg") {
    return { ok: false, result: failure("invalid", "Only PDF and JPEG PODs are supported.") };
  }
  if (
    (mimeType === "application/pdf" && !/\.pdf$/i.test(fileName)) ||
    (mimeType === "image/jpeg" && !/\.jpe?g$/i.test(fileName))
  ) {
    return { ok: false, result: failure("invalid", "The file extension must match the PDF or JPEG type.") };
  }
  if (!Buffer.isBuffer(input.bytes) || input.bytes.length === 0 || input.bytes.length > MAX_POD_BYTES) {
    return { ok: false, result: failure("invalid", "The POD file is empty or exceeds 10 MB.") };
  }
  const bytes = input.bytes;
  const pdf = bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if ((mimeType === "application/pdf" && !pdf) || (mimeType === "image/jpeg" && !jpeg)) {
    return { ok: false, result: failure("invalid", "The file contents do not match its PDF or JPEG type.") };
  }
  return { ok: true, value: { shipmentId: id, fileName, mimeType, bytes } };
}

/** Decode a `{ fileName, mimeType, base64 }` JSON body (small uploads) into a PodFileInput. */
export function podInputFromBase64Body(body: unknown): PodFileInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { fileName: undefined, mimeType: undefined, bytes: undefined };
  }
  const input = body as Record<string, unknown>;
  const base64 = typeof input.base64 === "string" ? input.base64.trim() : "";
  const maxEncodedLength = Math.ceil(MAX_POD_BYTES / 3) * 4;
  const wellFormed =
    base64.length > 0 &&
    base64.length <= maxEncodedLength &&
    base64.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(base64);
  return {
    fileName: input.fileName,
    mimeType: input.mimeType,
    bytes: wellFormed ? Buffer.from(base64, "base64") : undefined,
  };
}

type ReadOutcome = { ok: true; attachments: TaiAttachment[]; httpStatus: number } | { ok: false; httpStatus: number };

export async function readTaiShipmentAttachments(
  shipmentId: string,
  config: PodUploadConfig,
  fetchImpl: typeof fetch,
): Promise<ReadOutcome> {
  try {
    const response = await fetchImpl(
      `${config.baseUrl.replace(/\/+$/, "")}/PublicApi/Shipping/v2/Shipments/${encodeURIComponent(shipmentId)}`,
      {
        method: "GET",
        headers: { "x-api-key": config.credential, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) return { ok: false, httpStatus: response.status };
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, httpStatus: response.status };
    const attachments = (body as { attachments?: unknown }).attachments;
    if (attachments === undefined || attachments === null) return { ok: true, attachments: [], httpStatus: response.status };
    if (!Array.isArray(attachments)) return { ok: false, httpStatus: response.status };
    return {
      ok: true,
      httpStatus: response.status,
      attachments: attachments
        .filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
        .map((item) => ({
          attachmentName: typeof item.attachmentName === "string" ? item.attachmentName : "",
          attachmentUrl: typeof item.attachmentUrl === "string" ? item.attachmentUrl : "",
          attachmentType: typeof item.attachmentType === "string" ? item.attachmentType : "",
          documentId:
            typeof item.documentId === "number" && Number.isSafeInteger(item.documentId) ? item.documentId : null,
        })),
    };
  } catch {
    return { ok: false, httpStatus: 0 };
  }
}

/**
 * One non-retried TAI write, bracketed by GETs. Swagger declares `file` as a string without
 * documenting its encoding; base64 is the current integration assumption (same as primary-freight-dashboard).
 */
export async function uploadPodToTai(
  shipmentId: string,
  input: PodFileInput,
  config: PodUploadConfig,
  fetchImpl: typeof fetch = fetch,
  options: { readBackDelayMs?: number } = {},
): Promise<PodUploadResult> {
  const validated = validatePodUpload(shipmentId, input);
  if (!validated.ok) return validated.result;
  if (!config.enabled) {
    return failure(
      "unavailable",
      "Live TAI writes are disabled (ALLOW_LIVE_TAI_WRITES is not \"true\"). Nothing was sent to TAI; POD status unchanged.",
    );
  }
  if (!config.credential) {
    return failure("unavailable", "TAI API key is not configured on the server. Nothing was sent to TAI; POD status unchanged.");
  }
  const { fileName, bytes } = validated.value;
  const id = validated.value.shipmentId;

  const before = await readTaiShipmentAttachments(id, config, fetchImpl);
  if (!before.ok) {
    return failure(
      "unavailable",
      `TAI preflight GET /Shipments/${id} failed${before.httpStatus ? ` (HTTP ${before.httpStatus})` : ""}. Nothing was sent; POD status unchanged.`,
    );
  }
  const priorIds = new Set(
    before.attachments.map((a) => a.documentId).filter((docId): docId is number => docId !== null),
  );

  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl.replace(/\/+$/, "")}${TAI_DOCUMENT_ATTACHMENTS_PATH}`, {
      method: "POST",
      headers: { "x-api-key": config.credential, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        referenceNumbers: [{ referenceType: "Shipment Id", value: id }],
        file: bytes.toString("base64"),
        fileName,
        attachmentType: "POD",
        accessLevel: "Private",
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    // A timeout or lost response can occur after TAI committed the document.
    return failure("needs_review", "TAI's upload outcome is unknown (no response). Check the shipment in TAI before trying again.");
  }
  if (!response.ok) {
    if (response.status >= 500 || [408, 409, 429].includes(response.status)) {
      return failure(
        "needs_review",
        `TAI returned HTTP ${response.status} on POST /DocumentAttachments; the upload may or may not have been saved. Check TAI before trying again.`,
      );
    }
    return failure(
      "rejected",
      `TAI rejected the POD upload (HTTP ${response.status}). Confirm the API key has document-upload access with your TAI administrator. POD status unchanged.`,
    );
  }

  let lastRead: ReadOutcome = { ok: false, httpStatus: 0 };
  for (let attempt = 0; attempt < 3; attempt++) {
    // TAI may save a document before its shipment GET includes the attachment.
    // Only the safe GET is repeated; the POST above is sent exactly once.
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, options.readBackDelayMs ?? 750));
    lastRead = await readTaiShipmentAttachments(id, config, fetchImpl);
    if (!lastRead.ok) continue;
    const attachment = lastRead.attachments.find(
      (item) =>
        item.attachmentType.trim().toUpperCase() === "POD" &&
        item.attachmentName.trim().toLowerCase() === fileName.toLowerCase() &&
        item.documentId !== null &&
        !priorIds.has(item.documentId),
    );
    if (!attachment || attachment.documentId === null) continue;
    const podDocs = lastRead.attachments.filter(isPodAttachment);
    return {
      ok: true,
      status: "verified",
      message: `POD "${attachment.attachmentName}" uploaded to TAI and read back on GET /Shipments/${id} (Document #${attachment.documentId}).`,
      documentId: attachment.documentId,
      attachment: {
        attachmentName: attachment.attachmentName,
        attachmentType: attachment.attachmentType,
        documentId: attachment.documentId,
      },
      podCount: Math.max(1, podDocs.length),
      documents: lastRead.attachments,
    };
  }
  return lastRead.ok
    ? failure(
        "needs_review",
        "TAI accepted the upload, but the new POD is not yet visible on GET /Shipments. Check TAI before trying again; POD status unchanged locally.",
      )
    : failure(
        "needs_review",
        "TAI accepted the upload, but the shipment could not be read back. Check TAI before trying again; POD status unchanged locally.",
      );
}
