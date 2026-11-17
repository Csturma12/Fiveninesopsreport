import { createHash } from "node:crypto";
import type { LoadEntry } from "../shared/load-entry";

/**
 * Binds a server preview to the exact entry + CommitDomesticShipmentRequest it
 * was computed from. POST /api/loads/book recomputes it and refuses when the
 * caller's token no longer matches, so an edit after the preview (or a book
 * with no preview at all) never reaches TAI unreviewed.
 *
 * This is a freshness binding, not an authorization credential: anyone who can
 * call /preview can obtain one. Authorization stays with the staff session.
 */
export function loadEntryPreviewToken(entry: LoadEntry, preview: { url: string; request: unknown }): string {
  return createHash("sha256").update(JSON.stringify({ entry, preview })).digest("hex");
}
