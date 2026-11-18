import React, { useEffect, useState } from "react";
import type { LoadEntry } from "@shared/load-entry";
import type { OpsShipment } from "@shared/tai-webhook-schema";
import { Printer, RefreshCw, Reply } from "lucide-react";
import { insertGmailReply } from "./extensionBridge";
import { panelFetchJson, type PanelApiContext } from "./panelApi";
import { openPrintableHtmlWindow } from "./panelTypes";

interface BolGeneratorViewProps {
  shipments: OpsShipment[];
  builderEntry: LoadEntry;
  initialShipmentId?: string | null;
  apiCtx?: PanelApiContext;
  onToast: (msg: string, kind?: "ok" | "error") => void;
}

interface BolFields {
  bolNumber: string;
  poNumber: string;
  shipDate: string;
  carrierName: string;
  trailerType: string;
  shipperName: string;
  shipperAddress: string;
  shipperCityStateZip: string;
  shipperContact: string;
  consigneeName: string;
  consigneeAddress: string;
  consigneeCityStateZip: string;
  consigneeContact: string;
  commodityLines: string;
  totalPieces: number;
  totalWeightLbs: number;
  hazmat: boolean;
  specialInstructions: string;
}

function hydrateFromLoadEntry(entry: LoadEntry): BolFields {
  const pick = entry.stops[0];
  const drop = entry.stops[entry.stops.length - 1];
  return {
    bolNumber: entry.references.bolNumber || entry.references.customerPO || `BOL-${Date.now().toString().slice(-5)}`,
    poNumber: entry.references.customerPO || "",
    shipDate: pick?.readyDate || new Date().toISOString().slice(0, 10),
    carrierName: entry.carrier.name || "TBD",
    trailerType: entry.equipment.trailerType || "48 ft Flatbed",
    shipperName: pick?.companyName || "",
    shipperAddress: pick?.streetAddress || "",
    shipperCityStateZip: pick ? `${pick.city}, ${pick.state} ${pick.zipCode}`.trim() : "",
    shipperContact: [pick?.contactName, pick?.phone].filter(Boolean).join(" · "),
    consigneeName: drop?.companyName || "",
    consigneeAddress: drop?.streetAddress || "",
    consigneeCityStateZip: drop ? `${drop.city}, ${drop.state} ${drop.zipCode}`.trim() : "",
    consigneeContact: [drop?.contactName, drop?.phone].filter(Boolean).join(" · "),
    commodityLines: entry.items
      .map((it) => `${it.piecesTotal} ${it.packagingType} — ${it.description} (${it.weightTotal.toLocaleString()} lbs)`)
      .join("\n"),
    totalPieces: entry.items.reduce((s, i) => s + i.piecesTotal, 0),
    totalWeightLbs: entry.items.reduce((s, i) => s + i.weightTotal, 0),
    hazmat: entry.items.some((i) => Boolean(i.hazardousMaterial)),
    specialInstructions: entry.specialInstructions || "",
  };
}

function hydrateFromShipment(s: OpsShipment): BolFields {
  const pick = s.stops[0];
  const drop = s.stops[s.stops.length - 1];
  return {
    bolNumber: s.bol || s.po || s.id,
    poNumber: s.po || "",
    shipDate: pick?.readyDate || s.shipDate,
    carrierName: s.carrier || "TBD",
    trailerType: s.equip,
    shipperName: pick?.companyName || s.customer,
    shipperAddress: pick?.streetAddress || "",
    shipperCityStateZip: pick ? `${pick.city}, ${pick.state} ${pick.zipCode}` : s.origin,
    shipperContact: [pick?.contactName, pick?.phone].filter(Boolean).join(" · "),
    consigneeName: drop?.companyName || "Consignee",
    consigneeAddress: drop?.streetAddress || "",
    consigneeCityStateZip: drop ? `${drop.city}, ${drop.state} ${drop.zipCode}` : s.dest,
    consigneeContact: [drop?.contactName, drop?.phone].filter(Boolean).join(" · "),
    commodityLines: s.commodities
      .map((c) => `${c.piecesTotal} ${c.packagingType} — ${c.description} (${c.weightTotal.toLocaleString()} lbs)`)
      .join("\n"),
    totalPieces: s.commodities.reduce((sum, c) => sum + c.piecesTotal, 0),
    totalWeightLbs: s.commodities.reduce((sum, c) => sum + c.weightTotal, 0),
    hazmat: s.commodities.some((c) => Boolean(c.hazardousMaterial)),
    specialInstructions: s.operationalNote || "",
  };
}

function renderBolPrintableHtml(f: BolFields): string {
  const esc = (v: string) =>
    v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const linesHtml = f.commodityLines
    .split(/\r?\n/)
    .filter(Boolean)
    .map((ln) => `<tr><td>${esc(ln)}</td></tr>`)
    .join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>BOL ${esc(f.bolNumber)}</title>
  <style>body{font-family:system-ui,-apple-system,sans-serif;padding:28px;color:#12345a;font-size:12px}
  .bar{height:4px;background:linear-gradient(90deg,#12345a 0%,#1768b2 48%,#21b975 82%,#66d9a2 100%);margin-bottom:14px}
  h1{margin:0;font-size:19px;letter-spacing:.02em}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}
  .box{border:1px solid #94a3b8;padding:10px;border-radius:6px}
  table{width:100%;border-collapse:collapse;margin-top:12px}th,td{border:1px solid #94a3b8;padding:8px;text-align:left}
  th{background:#f1f5f9;font-size:11px;text-transform:uppercase}.sig{margin-top:24px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px}
  .sig div{border-top:1px solid #334155;padding-top:6px;font-size:11px}</style></head>
  <body><div class="bar"></div>
  <div style="display:flex;justify-content:space-between;align-items:flex-start">
    <div><h1>STRAIGHT BILL OF LADING — SHORT FORM</h1><div>Third-Party Bill To: Primary Freight / Five Nines Logistics</div></div>
    <div style="text-align:right"><strong>BOL #:</strong> ${esc(f.bolNumber)}<br/><strong>Customer PO:</strong> ${esc(f.poNumber || "—")}<br/><strong>Ship Date:</strong> ${esc(f.shipDate)}</div>
  </div>
  <div class="grid">
    <div class="box"><strong>SHIPPER (ORIGIN)</strong><br/>${esc(f.shipperName)}<br/>${esc(f.shipperAddress)}<br/>${esc(f.shipperCityStateZip)}<br/>${esc(f.shipperContact)}</div>
    <div class="box"><strong>CONSIGNEE (DESTINATION)</strong><br/>${esc(f.consigneeName)}<br/>${esc(f.consigneeAddress)}<br/>${esc(f.consigneeCityStateZip)}<br/>${esc(f.consigneeContact)}</div>
  </div>
  <div class="box" style="margin-top:12px"><strong>Carrier:</strong> ${esc(f.carrierName)} &nbsp;|&nbsp; <strong>Equipment:</strong> ${esc(f.trailerType)} &nbsp;|&nbsp; <strong>Total Pieces:</strong> ${f.totalPieces} &nbsp;|&nbsp; <strong>Total Weight:</strong> ${f.totalWeightLbs.toLocaleString()} lbs &nbsp;|&nbsp; <strong>Hazmat:</strong> ${f.hazmat ? "YES (24hr Emergency Contact Required)" : "NO"}</div>
  <table><thead><tr><th>Packages, Commodity Description &amp; Weight</th></tr></thead><tbody>${linesHtml}</tbody></table>
  <div class="box" style="margin-top:12px"><strong>Special Instructions:</strong><br/>${esc(f.specialInstructions || "Driver to verify piece count and condition at loading.")}</div>
  <div class="sig"><div>Shipper Signature / Date</div><div>Driver / Carrier Signature / Date</div><div>Consignee Signature / Date &amp; Time</div></div>
  <script>window.onload=()=>setTimeout(()=>window.print(),250);</script></body></html>`;
}

function buildBolSummaryText(f: BolFields): string {
  return [
    `BILL OF LADING SUMMARY — BOL #${f.bolNumber}${f.poNumber ? ` (PO #${f.poNumber})` : ""}`,
    `Ship Date: ${f.shipDate} | Carrier: ${f.carrierName} | Equipment: ${f.trailerType}`,
    `Shipper: ${f.shipperName}, ${f.shipperAddress ? `${f.shipperAddress}, ` : ""}${f.shipperCityStateZip}`,
    `Consignee: ${f.consigneeName}, ${f.consigneeAddress ? `${f.consigneeAddress}, ` : ""}${f.consigneeCityStateZip}`,
    `Commodities (${f.totalPieces} pcs / ${f.totalWeightLbs.toLocaleString()} lbs${f.hazmat ? " · HAZMAT" : ""}):`,
    f.commodityLines,
    f.specialInstructions ? `Instructions: ${f.specialInstructions}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function mapServerBolFields(raw: Record<string, unknown>, prev: BolFields): BolFields {
  const shipperObj =
    raw.shipper && typeof raw.shipper === "object" ? (raw.shipper as Record<string, unknown>) : null;
  const consigneeObj =
    raw.consignee && typeof raw.consignee === "object" ? (raw.consignee as Record<string, unknown>) : null;
  const rawCommodities = Array.isArray(raw.commodities)
    ? (raw.commodities as Array<Record<string, unknown>>)
    : null;

  return {
    bolNumber: String(raw.bolNumber || prev.bolNumber),
    poNumber: String(raw.customerPO ?? raw.poNumber ?? prev.poNumber),
    shipDate: String(raw.shipDate || prev.shipDate),
    carrierName: String(raw.carrier ?? raw.carrierName ?? prev.carrierName),
    trailerType: String(raw.equipment ?? raw.trailerType ?? prev.trailerType),
    shipperName: shipperObj ? String(shipperObj.companyName || prev.shipperName) : String(raw.shipperName ?? prev.shipperName),
    shipperAddress: shipperObj ? String(shipperObj.streetAddress || "") : String(raw.shipperAddress ?? prev.shipperAddress),
    shipperCityStateZip: shipperObj
      ? `${shipperObj.city || ""}, ${shipperObj.state || ""} ${shipperObj.zipCode || ""}`.trim()
      : String(raw.shipperCityStateZip ?? prev.shipperCityStateZip),
    shipperContact: shipperObj
      ? [shipperObj.contactName, shipperObj.phone].filter(Boolean).map(String).join(" · ")
      : String(raw.shipperContact ?? prev.shipperContact),
    consigneeName: consigneeObj
      ? String(consigneeObj.companyName || prev.consigneeName)
      : String(raw.consigneeName ?? prev.consigneeName),
    consigneeAddress: consigneeObj
      ? String(consigneeObj.streetAddress || "")
      : String(raw.consigneeAddress ?? prev.consigneeAddress),
    consigneeCityStateZip: consigneeObj
      ? `${consigneeObj.city || ""}, ${consigneeObj.state || ""} ${consigneeObj.zipCode || ""}`.trim()
      : String(raw.consigneeCityStateZip ?? prev.consigneeCityStateZip),
    consigneeContact: consigneeObj
      ? [consigneeObj.contactName, consigneeObj.phone].filter(Boolean).map(String).join(" · ")
      : String(raw.consigneeContact ?? prev.consigneeContact),
    commodityLines: rawCommodities
      ? rawCommodities
          .map(
            (c) =>
              `${Number(c.piecesTotal) || 1} ${c.packagingType || "Pallet"} — ${c.description || "Freight"} (${(
                Number(c.weightTotal) || 0
              ).toLocaleString()} lbs)`,
          )
          .join("\n")
      : String(raw.commodityLines ?? prev.commodityLines),
    totalPieces: Number(raw.totalPieces ?? prev.totalPieces) || prev.totalPieces,
    totalWeightLbs: Number(raw.totalWeight ?? raw.totalWeightLbs ?? prev.totalWeightLbs) || prev.totalWeightLbs,
    hazmat: rawCommodities
      ? rawCommodities.some((c) => Boolean(c.hazardousMaterial))
      : Boolean(raw.hazmat ?? prev.hazmat),
    specialInstructions: String(raw.specialInstructions ?? prev.specialInstructions),
  };
}

export const BolGeneratorView: React.FC<BolGeneratorViewProps> = ({
  shipments,
  builderEntry,
  initialShipmentId,
  apiCtx,
  onToast,
}) => {
  const [selectedLoadId, setSelectedLoadId] = useState<string>(initialShipmentId || "");
  const [loading, setLoading] = useState(false);
  const [serverHtml, setServerHtml] = useState<string | null>(null);
  const [fields, setFields] = useState<BolFields>(() => {
    if (initialShipmentId) {
      const found = shipments.find((s) => s.id === initialShipmentId);
      if (found) return hydrateFromShipment(found);
    }
    return hydrateFromLoadEntry(builderEntry);
  });

  const hydrateFromServerOrLocal = async (shipmentId: string) => {
    setSelectedLoadId(shipmentId);
    setServerHtml(null);
    if (!shipmentId) {
      setFields(hydrateFromLoadEntry(builderEntry));
      return;
    }
    const localMatch = shipments.find((s) => s.id === shipmentId);
    if (localMatch) {
      setFields(hydrateFromShipment(localMatch));
    }
    setLoading(true);
    try {
      const { ok, data } = await panelFetchJson<{
        ok?: boolean;
        fields?: Record<string, unknown>;
        printableHtml?: string;
      }>(`/api/loads/${encodeURIComponent(shipmentId)}/bol`, { method: "GET" }, apiCtx);
      if (ok && data.ok !== false) {
        if (data.fields && typeof data.fields === "object") {
          setFields((prev) => mapServerBolFields(data.fields!, prev));
        }
        if (data.printableHtml) {
          setServerHtml(data.printableHtml);
        }
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (initialShipmentId) {
      void hydrateFromServerOrLocal(initialShipmentId);
    }
  }, [initialShipmentId]);

  const updateField = <K extends keyof BolFields>(key: K, val: BolFields[K]) => {
    setServerHtml(null); // User customized fields -> render fresh printable HTML
    setFields((prev) => ({ ...prev, [key]: val }));
  };

  const handleOpenPrintable = () => {
    const html = serverHtml || renderBolPrintableHtml(fields);
    const opened = openPrintableHtmlWindow(`BOL ${fields.bolNumber}`, html);
    onToast(opened ? `Opened printable BOL #${fields.bolNumber}` : "Pop-up blocked — allow pop-ups to print PDF", opened ? "ok" : "error");
  };

  const handleInsertIntoGmail = async () => {
    const text = buildBolSummaryText(fields);
    const res = await insertGmailReply({
      text,
      subject: `Bill of Lading — BOL #${fields.bolNumber}`,
    });
    onToast(res.message, res.ok ? "ok" : "error");
  };

  return (
    <div className="space-y-2.5">
      {/* Hydrate Selector */}
      <div
        className="p-2.5 rounded-xl space-y-1.5"
        style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
      >
        <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider" style={{ color: "var(--pf-text-muted)" }}>
          <span>Hydrate Bill of Lading From Load</span>
          {loading && <RefreshCw size={11} className="animate-spin" />}
        </div>
        <div className="flex items-center gap-1.5">
          <select
            value={selectedLoadId}
            onChange={(e) => void hydrateFromServerOrLocal(e.target.value)}
            className="pf-input flex-1 text-[11px]"
          >
            <option value="">⚡ Current Load Builder Draft</option>
            {shipments.map((s) => (
              <option key={s.id} value={s.id}>
                #{s.id} · {s.customer} ({s.origin} → {s.dest})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Editable BOL Fields */}
      <div
        className="p-2.5 rounded-xl space-y-2 text-[11px]"
        style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
      >
        <div className="grid grid-cols-3 gap-1.5">
          <div>
            <label className="block text-[10px] mb-0.5" style={{ color: "var(--pf-text-muted)" }}>
              BOL #
            </label>
            <input
              value={fields.bolNumber}
              onChange={(e) => updateField("bolNumber", e.target.value)}
              className="pf-input font-mono font-semibold text-[11px]"
            />
          </div>
          <div>
            <label className="block text-[10px] mb-0.5" style={{ color: "var(--pf-text-muted)" }}>
              Customer PO #
            </label>
            <input
              value={fields.poNumber}
              onChange={(e) => updateField("poNumber", e.target.value)}
              className="pf-input font-mono text-[11px]"
            />
          </div>
          <div>
            <label className="block text-[10px] mb-0.5" style={{ color: "var(--pf-text-muted)" }}>
              Ship Date
            </label>
            <input
              type="date"
              value={fields.shipDate}
              onChange={(e) => updateField("shipDate", e.target.value)}
              className="pf-input font-mono text-[11px]"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          <div className="p-2 rounded-lg space-y-1" style={{ background: "var(--pf-surface-raised)" }}>
            <div className="text-[10px] font-bold uppercase" style={{ color: "var(--pf-info)" }}>
              Shipper (Origin)
            </div>
            <input
              value={fields.shipperName}
              onChange={(e) => updateField("shipperName", e.target.value)}
              placeholder="Shipper Company"
              className="pf-input text-[11px] font-semibold"
            />
            <input
              value={fields.shipperAddress}
              onChange={(e) => updateField("shipperAddress", e.target.value)}
              placeholder="Street Address"
              className="pf-input text-[11px]"
            />
            <input
              value={fields.shipperCityStateZip}
              onChange={(e) => updateField("shipperCityStateZip", e.target.value)}
              placeholder="City, ST ZIP"
              className="pf-input text-[11px]"
            />
          </div>

          <div className="p-2 rounded-lg space-y-1" style={{ background: "var(--pf-surface-raised)" }}>
            <div className="text-[10px] font-bold uppercase" style={{ color: "var(--pf-primary)" }}>
              Consignee (Destination)
            </div>
            <input
              value={fields.consigneeName}
              onChange={(e) => updateField("consigneeName", e.target.value)}
              placeholder="Consignee Company"
              className="pf-input text-[11px] font-semibold"
            />
            <input
              value={fields.consigneeAddress}
              onChange={(e) => updateField("consigneeAddress", e.target.value)}
              placeholder="Street Address"
              className="pf-input text-[11px]"
            />
            <input
              value={fields.consigneeCityStateZip}
              onChange={(e) => updateField("consigneeCityStateZip", e.target.value)}
              placeholder="City, ST ZIP"
              className="pf-input text-[11px]"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          <input
            value={fields.carrierName}
            onChange={(e) => updateField("carrierName", e.target.value)}
            placeholder="Carrier Name"
            className="pf-input text-[11px]"
          />
          <input
            value={fields.trailerType}
            onChange={(e) => updateField("trailerType", e.target.value)}
            placeholder="Equipment / Trailer"
            className="pf-input text-[11px]"
          />
        </div>

        <div>
          <label className="block text-[10px] mb-0.5" style={{ color: "var(--pf-text-muted)" }}>
            Commodity Lines ({fields.totalPieces} pcs · {fields.totalWeightLbs.toLocaleString()} lbs)
          </label>
          <textarea
            rows={2}
            value={fields.commodityLines}
            onChange={(e) => updateField("commodityLines", e.target.value)}
            className="pf-input text-[11px]"
          />
        </div>

        <input
          value={fields.specialInstructions}
          onChange={(e) => updateField("specialInstructions", e.target.value)}
          placeholder="BOL Special Instructions (tarps, appointment, driver count…)"
          className="pf-input text-[11px]"
        />

        <div className="grid grid-cols-2 gap-1.5 pt-1">
          <button
            type="button"
            onClick={handleOpenPrintable}
            className="py-2 px-2.5 rounded-lg text-xs font-bold inline-flex items-center justify-center gap-1.5"
            style={{ background: "var(--pf-action)", color: "#ffffff" }}
          >
            <Printer size={12} /> Printable BOL PDF
          </button>
          <button
            type="button"
            onClick={() => void handleInsertIntoGmail()}
            className="py-2 px-2.5 rounded-lg text-xs font-bold inline-flex items-center justify-center gap-1.5"
            style={{ background: "var(--pf-primary)", color: "var(--pf-primary-fg)" }}
          >
            <Reply size={12} /> Insert into Gmail
          </button>
        </div>
      </div>
    </div>
  );
};
