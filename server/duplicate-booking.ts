import type { LoadEntry } from "../shared/load-entry";
import type { OpsShipment } from "../shared/tai-webhook-schema";

export interface DuplicateBooking {
  shipmentId: string;
  matchedOn: "shipper reference" | "customer PO";
  value: string;
}

const norm = (value: string | null | undefined) => String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * A load already known in TAI for the same customer with the same shipper
 * reference (BOL) or customer PO. Booking the same order twice is the easy
 * mistake when a load is built again instead of edited; the caller asks before
 * sending a second shipment. Only numeric (real TAI) ids count, cancelled loads
 * never count, and a blank reference never matches a blank reference.
 */
export function findDuplicateBooking(
  loads: Pick<OpsShipment, "id" | "customer" | "po" | "bol" | "rawStatus">[],
  entry: LoadEntry,
): DuplicateBooking | null {
  const customer = norm(entry.customer.name);
  const reference = norm(entry.references.bolNumber);
  const po = norm(entry.references.customerPO);
  if (!customer || (!reference && !po)) return null;

  for (const load of loads) {
    if (!/^\d+$/.test(String(load.id || ""))) continue;
    if (/cancel/i.test(String(load.rawStatus || ""))) continue;
    if (norm(load.customer) !== customer) continue;
    if (reference && norm(load.bol) === reference) {
      return { shipmentId: load.id, matchedOn: "shipper reference", value: String(load.bol).trim() };
    }
    if (po && norm(load.po) === po) {
      return { shipmentId: load.id, matchedOn: "customer PO", value: String(load.po).trim() };
    }
  }
  return null;
}
