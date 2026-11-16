/**
 * ISO 6346 container number extractor & operational exception synthesizer
 * for IMC / Intermodal / Drayage email correlation.
 */

const CONTAINER_REGEX = /\b([A-Z]{3}[UJZ])\s*-?\s*(\d{6})\s*-?\s*(\d)\b/gi;

export function formatContainerCompact(raw: string): string {
  return String(raw || "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
}

export function formatContainerHyphenated(raw: string): string {
  const compact = formatContainerCompact(raw);
  if (/^[A-Z]{3}[UJZ]\d{7}$/.test(compact)) {
    return `${compact.slice(0, 10)}-${compact.slice(10)}`;
  }
  return String(raw || "").trim().toUpperCase();
}

export function sameContainerNumber(a?: string | null, b?: string | null): boolean {
  const ca = formatContainerCompact(a || "");
  const cb = formatContainerCompact(b || "");
  return Boolean(ca && cb && ca === cb);
}

export function extractContainerNumbers(text: string): string[] {
  const found = new Set<string>();
  const src = String(text || "");
  for (const match of src.matchAll(CONTAINER_REGEX)) {
    const canonical = `${match[1].toUpperCase()}${match[2]}-${match[3]}`;
    found.add(canonical);
  }
  return Array.from(found);
}

export function extractContainerVariants(text: string): Array<{ hyphenated: string; compact: string }> {
  return extractContainerNumbers(text).map((hyphenated) => ({
    hyphenated,
    compact: formatContainerCompact(hyphenated),
  }));
}

export function buildGmailContainerSearchUrl(
  containerNumber?: string,
  shipmentId?: string,
  subject?: string,
): string {
  const terms: string[] = [];
  if (containerNumber && formatContainerCompact(containerNumber)) {
    const hyphenated = formatContainerHyphenated(containerNumber);
    const compact = formatContainerCompact(containerNumber);
    terms.push(`"${hyphenated}"`, `"${compact}"`);
  }
  if (shipmentId && shipmentId !== "NEW" && /^\d+$/.test(shipmentId.trim())) {
    terms.push(`"${shipmentId.trim()}"`);
  }
  if (terms.length === 0 && subject) {
    terms.push(subject.trim());
  }
  return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(terms.join(" OR ") || "freight")}`;
}

export interface ContainerExceptionSummary {
  hasTonu: boolean;
  hasEquipmentIssue: boolean;
  hasHoldOrDemurrage: boolean;
  note: string | null;
}

export function synthesizeContainerExceptionNote(texts: Array<string | null | undefined>): ContainerExceptionSummary {
  const combined = texts
    .map((t) => String(t || "").trim())
    .filter(Boolean)
    .join("\n");

  if (!combined) {
    return { hasTonu: false, hasEquipmentIssue: false, hasHoldOrDemurrage: false, note: null };
  }

  const hasTonu = /\btonu\b|truck\s+order\s+not\s+used|carrier\s+confirmation\s+tonu/i.test(combined);
  const hasForklift = /forklift/i.test(combined);
  const hasEquipmentIssue =
    hasForklift ||
    /crane|went\s+down|Down\b|broke\s+down|waiting\s+(?:on|for).*repair|repaired|did\s*n['o]?t\s+pick\s*up|unable\s+to\s+(?:load|pick\s*up)/i.test(
      combined,
    );
  const hasHoldOrDemurrage =
    /customs\s+hold|freight\s+hold|demurrage|per\s+diem|last\s+free\s+day|\blfd\b|detention/i.test(combined);

  if (hasTonu && hasEquipmentIssue) {
    const detail = hasForklift
      ? "Forklift went down at facility — paid TONU and waiting for forklift to be repaired before rescheduling pickup."
      : "Equipment issue prevented pickup — TONU paid; waiting for facility repair/release to reschedule.";
    return {
      hasTonu,
      hasEquipmentIssue,
      hasHoldOrDemurrage,
      note: `⚠ TONU PAID · DID NOT PICK UP: ${detail}`,
    };
  }

  if (hasTonu) {
    return {
      hasTonu,
      hasEquipmentIssue,
      hasHoldOrDemurrage,
      note: "⚠ TONU ISSUE DETECTED IN EMAIL THREAD — review Carrier Confirmation TONU before dispatching another truck.",
    };
  }

  if (hasEquipmentIssue) {
    return {
      hasTonu,
      hasEquipmentIssue,
      hasHoldOrDemurrage,
      note: hasForklift
        ? "⚠ PICKUP DELAYED: Forklift breakdown reported at shipper — waiting on repair."
        : "⚠ PICKUP EXCEPTION: Equipment/loading issue reported in container emails.",
    };
  }

  if (hasHoldOrDemurrage) {
    return {
      hasTonu,
      hasEquipmentIssue,
      hasHoldOrDemurrage,
      note: "⚠ CONTAINER ALERT: Hold / LFD / Detention mentioned in container emails — verify terminal release.",
    };
  }

  return { hasTonu, hasEquipmentIssue, hasHoldOrDemurrage, note: null };
}
