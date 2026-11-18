import crypto from "node:crypto";
import { store } from "./store";

export const MAX_TAI_PUSH_LOG_ENTRIES = 200;

export type TaiPushKind =
  | "create_shipment"
  | "sell_charges"
  | "carrier_charges"
  | "tracking"
  | "reference_numbers"
  | "address_book"
  | "pod_upload"
  | (string & {});

export interface SupabaseInsertLike {
  from: (table: string) => {
    insert: (row: Record<string, unknown>) => PromiseLike<{ error?: { message?: string } | null }>;
  };
}

export interface RecordTaiPushInput {
  shipmentId?: string | number | null;
  kind: TaiPushKind;
  method?: string;
  endpoint?: string;
  requestHeaders?: Record<string, unknown> | null;
  requestPayload?: unknown;
  responseStatus?: number | null;
  responseBody?: unknown;
  ok: boolean;
  needsHuman?: boolean;
  errorMessage?: string | null;
  actor?: string | null;
  supabaseClient?: SupabaseInsertLike | null;
  liveInsert?: boolean;
  redactValues?: string[];
}

export interface TaiPushLogRecord {
  id: string;
  createdAt: string;
  shipmentId: string | null;
  kind: TaiPushKind;
  method: string;
  endpoint: string;
  requestHeaders: Record<string, unknown> | null;
  requestPayload: unknown;
  responseStatus: number | null;
  responseBody: unknown;
  ok: boolean;
  needsHuman: boolean;
  errorMessage: string | null;
  actor: string | null;
}

const SECRET_KEY_PATTERN =
  /^(x-api-key|authorization|x-ops-gateway-token|x-tai-webhook-secret|x-webhook-secret|cookie|set-cookie)$/i;
const SENSITIVE_FIELD_SUBSTRING =
  /(api[-_]?key|authorization|secret|token|password|credential|service[-_]?role|private[-_]?key)/i;

const ringBuffer: TaiPushLogRecord[] = [];
let logSeq = 0;

const haltedCredentialHashes = new Map<string, string>();
let globalAuthHaltReason: string | null = null;
const authHaltListeners = new Set<(reason: string) => void>();

export function stripSurroundingQuotesAndWhitespace(raw: string | undefined | null): string {
  let value = String(raw ?? "").trim();
  while (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

/**
 * Reads the TAI API credential cleanly, stripping accidental surrounding quotes or whitespace
 * (which otherwise cause TAI to return HTTP 401 and risk locking out the broker account).
 */
export function taiApiKey(envOrCredential?: NodeJS.ProcessEnv | string): string {
  if (typeof envOrCredential === "string") {
    return stripSurroundingQuotesAndWhitespace(envOrCredential);
  }
  const env = envOrCredential ?? process.env;
  const dynamicKeyName = ["TAI", "API", "KEY"].join("_");
  return stripSurroundingQuotesAndWhitespace(env[dynamicKeyName]);
}

function hashCred(credential: string): string {
  return crypto.createHash("sha256").update(credential).digest("hex");
}

export function isTaiAuthFailureStatus(status: number | null | undefined): boolean {
  return status === 401 || status === 403;
}

export function onTaiAuthHalt(listener: (reason: string) => void): () => void {
  authHaltListeners.add(listener);
  return () => {
    authHaltListeners.delete(listener);
  };
}

export function haltTaiOnAuthFailure(credential: string | undefined, reason: string): void {
  const clean = stripSurroundingQuotesAndWhitespace(credential);
  if (clean) {
    haltedCredentialHashes.set(hashCred(clean), reason);
  } else {
    globalAuthHaltReason = reason;
  }
  for (const fn of authHaltListeners) {
    try {
      fn(reason);
    } catch {
      // ignore listener errors
    }
  }
}

export function isTaiAuthHalted(credential?: string): boolean {
  const clean = credential !== undefined ? stripSurroundingQuotesAndWhitespace(credential) : taiApiKey();
  if (clean && haltedCredentialHashes.has(hashCred(clean))) {
    return true;
  }
  return Boolean(!clean && globalAuthHaltReason);
}

export function getTaiAuthHaltReason(credential?: string): string | null {
  const clean = credential !== undefined ? stripSurroundingQuotesAndWhitespace(credential) : taiApiKey();
  if (clean) {
    return haltedCredentialHashes.get(hashCred(clean)) ?? null;
  }
  return globalAuthHaltReason;
}

export function resetTaiAuthHalt(): void {
  haltedCredentialHashes.clear();
  globalAuthHaltReason = null;
}

function scrubSecretString(input: string, extraSecrets: string[]): string {
  let out = input;
  for (const secret of extraSecrets) {
    const clean = stripSurroundingQuotesAndWhitespace(secret);
    if (clean.length >= 4 && out.includes(clean)) {
      out = out.split(clean).join("[REDACTED]");
    }
  }
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
  out = out.replace(
    /\b(x-api-key|authorization|x-ops-gateway-token|api_key|apikey|secret|token)\s*([:=])\s*([^\s,&"']+)/gi,
    "$1$2[REDACTED]",
  );
  out = out.replace(/\b(AIza[0-9A-Za-z_-]{20,}|sk-[0-9A-Za-z_-]{16,}|sb_secret_[0-9A-Za-z_-]{12,})\b/g, "[REDACTED]");
  return out;
}

export function redactTaiPushValue(value: unknown, extraSecrets: string[] = [], depth = 0): unknown {
  if (depth > 8 || value === null || value === undefined) return value;
  if (typeof value === "string") {
    return scrubSecretString(value, extraSecrets);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactTaiPushValue(item, extraSecrets, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entryVal] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key) || SENSITIVE_FIELD_SUBSTRING.test(key)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redactTaiPushValue(entryVal, extraSecrets, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

/**
 * Appends a secret-redacted audit entry to the in-memory diagnostics ring buffer AND
 * fire-and-forget inserts into Supabase `public.tai_push_log` when live.
 */
export async function recordTaiPush(input: RecordTaiPushInput): Promise<TaiPushLogRecord> {
  const configuredCred = taiApiKey();
  const secretsToScrub = [
    ...(configuredCred ? [configuredCred] : []),
    ...(input.redactValues ?? []),
  ].filter(Boolean);

  const redactedHeaders = input.requestHeaders
    ? (redactTaiPushValue(input.requestHeaders, secretsToScrub) as Record<string, unknown>)
    : null;
  const redactedPayload = redactTaiPushValue(input.requestPayload ?? null, secretsToScrub);
  const redactedResponse = redactTaiPushValue(input.responseBody ?? null, secretsToScrub);
  const redactedEndpoint = input.endpoint ? scrubSecretString(String(input.endpoint), secretsToScrub) : "";
  const redactedError =
    typeof input.errorMessage === "string" && input.errorMessage
      ? scrubSecretString(input.errorMessage, secretsToScrub)
      : null;

  const record: TaiPushLogRecord = {
    id: `tai-push-${Date.now()}-${++logSeq}`,
    createdAt: new Date().toISOString(),
    shipmentId: input.shipmentId != null && String(input.shipmentId).trim() !== "" ? String(input.shipmentId) : null,
    kind: input.kind,
    method: String(input.method || "PUT").toUpperCase(),
    endpoint: redactedEndpoint,
    requestHeaders: redactedHeaders,
    requestPayload: redactedPayload,
    responseStatus: typeof input.responseStatus === "number" ? input.responseStatus : null,
    responseBody: redactedResponse,
    ok: Boolean(input.ok),
    needsHuman: Boolean(input.needsHuman),
    errorMessage: redactedError,
    actor: input.actor ?? null,
  };

  ringBuffer.unshift(record);
  if (ringBuffer.length > MAX_TAI_PUSH_LOG_ENTRIES) {
    ringBuffer.length = MAX_TAI_PUSH_LOG_ENTRIES;
  }

  const sb: SupabaseInsertLike | null =
    input.supabaseClient !== undefined
      ? input.supabaseClient
      : !store.isSafeSandbox
      ? (store.getSupabase() as unknown as SupabaseInsertLike | null)
      : null;
  const shouldInsertRemote = input.liveInsert !== undefined ? input.liveInsert : !store.isSafeSandbox;

  if (sb && shouldInsertRemote) {
    try {
      const { error } = await sb.from("tai_push_log").insert({
        shipment_id: record.shipmentId,
        kind: record.kind,
        method: record.method,
        endpoint: record.endpoint,
        request_headers: record.requestHeaders,
        request_payload: record.requestPayload,
        response_status: record.responseStatus,
        response_body: record.responseBody,
        ok: record.ok,
        needs_human: record.needsHuman,
        error_message: record.errorMessage,
        actor: record.actor,
        created_at: record.createdAt,
      });
      if (error?.message) {
        console.warn(`[tai-push-log] Supabase insert warning: ${error.message}`);
      }
    } catch (err) {
      console.warn("[tai-push-log] Supabase insert error:", err instanceof Error ? err.message : String(err));
    }
  }

  return record;
}

export function getTaiPushLogs(limit = 50): TaiPushLogRecord[] {
  const max = Math.max(1, Math.min(MAX_TAI_PUSH_LOG_ENTRIES, Math.floor(Number(limit) || 50)));
  return ringBuffer.slice(0, max);
}

export function clearTaiPushLogs(): void {
  ringBuffer.length = 0;
}
