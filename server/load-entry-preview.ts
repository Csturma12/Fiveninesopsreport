import { createHash } from "node:crypto";
import type { LoadEntry } from "../shared/load-entry";

/**
 * Binds a server preview to the exact entry, the CommitDomesticShipmentRequest
 * built from it, and the order Qty (`duplicateCount`) that will be generated.
 * POST /api/loads/book recomputes it and refuses when the caller's token no
 * longer matches, so an edit after the preview, a different Qty than was
 * previewed, or a book with no preview at all never reaches TAI unreviewed.
 *
 * This is a freshness binding, not an authorization credential: anyone who can
 * call /preview can obtain one. Authorization stays with the staff session.
 *
 * @param duplicateCount number of orders the book will create (1–10); Qty > 1
 *   suffixes the customer PO per order, so it changes what TAI receives.
 */
export function loadEntryPreviewToken(
  entry: LoadEntry,
  preview: { url: string; request: unknown },
  duplicateCount = 1,
): string {
  return createHash("sha256").update(JSON.stringify({ entry, duplicateCount, preview })).digest("hex");
}
