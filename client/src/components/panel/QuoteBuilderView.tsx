import React from "react";
import type { LoadEntry } from "@shared/load-entry";
import { Plus, PlusCircle, Printer, Reply, X } from "lucide-react";
import { insertGmailReply } from "./extensionBridge";
import { openPrintableHtmlWindow, type PanelViewId, type QuoteDraftState } from "./panelTypes";

interface QuoteBuilderViewProps {
  quote: QuoteDraftState;
  onQuoteChange: (next: QuoteDraftState) => void;
  builderEntry: LoadEntry;
  onBuilderChange: (next: LoadEntry) => void;
  onNavigate: (view: PanelViewId) => void;
  onToast: (msg: string, kind?: "ok" | "error") => void;
}

const QUOTE_NOTE_CHIPS = [
  "2 hrs free load/unload ($75/hr detention after)",
  "Includes 8ft tarps",
  "Subject to truck availability",
  "MacroPoint GPS tracking included",
];

function buildFormattedQuote(q: QuoteDraftState) {
  const accTotal = q.accessorials.reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
  const allInTotal = (Number(q.linehaulRate) || 0) + (Number(q.fuelSurcharge) || 0) + accTotal;

  const accLines = q.accessorials
    .filter((a) => a.name.trim())
    .map((a) => `  • ${a.name}: $${(Number(a.amount) || 0).toLocaleString()}`);

  const text = [
    `FREIGHT RATE QUOTE — ${q.customerName || "VALUED CUSTOMER"}`,
    `Lane: ${q.origin || "Origin TBD"} → ${q.destination || "Destination TBD"}${q.estMiles > 0 ? ` (~${q.estMiles.toLocaleString()} mi)` : ""}`,
    `Equipment: ${q.equipmentType}`,
    ``,
    `Rate Breakdown:`,
    `  • Linehaul: $${(Number(q.linehaulRate) || 0).toLocaleString()}`,
    ...(q.fuelSurcharge > 0 ? [`  • Fuel Surcharge: $${Number(q.fuelSurcharge).toLocaleString()}`] : []),
    ...accLines,
    `Total All-In Rate: $${allInTotal.toLocaleString()}`,
    ``,
    q.transitNote ? `Transit: ${q.transitNote}` : "",
    q.validUntil ? `Quote Valid Through: ${q.validUntil}` : "",
    q.equipmentNotes ? `Terms & Equipment Notes: ${q.equipmentNotes}` : "",
    ``,
    `Reply to this email with your pickup date and PO # to lock in coverage.`,
    `— Five Nines / Primary Freight Operations`,
  ]
    .filter((line, idx, arr) => line !== "" || arr[idx - 1] !== "")
    .join("\n");

  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:13px;color:#111827;max-width:620px;border:1px solid #cbd5e1;border-radius:8px;overflow:hidden">
    <div style="height:4px;background:linear-gradient(90deg,#1D2C5E,#682C87,#D52A3B,#F0641E,#F5B841)"></div>
    <div style="padding:14px 16px">
      <div style="font-weight:700;font-size:15px;color:#1D2C5E">Freight Rate Quote · ${esc(q.customerName || "Customer")}</div>
      <div style="margin-top:4px;color:#475569"><strong>Lane:</strong> ${esc(q.origin)} &rarr; ${esc(q.destination)}${q.estMiles > 0 ? ` (${q.estMiles.toLocaleString()} mi)` : ""} &nbsp;|&nbsp; <strong>Equipment:</strong> ${esc(q.equipmentType)}</div>
      <table style="width:100%;border-collapse:collapse;margin-top:10px;font-size:12px">
        <tr><td style="padding:6px;border-bottom:1px solid #e2e8f0">Linehaul</td><td style="padding:6px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:600">$${(Number(q.linehaulRate) || 0).toLocaleString()}</td></tr>
        ${q.fuelSurcharge > 0 ? `<tr><td style="padding:6px;border-bottom:1px solid #e2e8f0">Fuel Surcharge</td><td style="padding:6px;border-bottom:1px solid #e2e8f0;text-align:right">$${Number(q.fuelSurcharge).toLocaleString()}</td></tr>` : ""}
        ${q.accessorials.filter((a) => a.name.trim()).map((a) => `<tr><td style="padding:6px;border-bottom:1px solid #e2e8f0">${esc(a.name)}</td><td style="padding:6px;border-bottom:1px solid #e2e8f0;text-align:right">$${(Number(a.amount) || 0).toLocaleString()}</td></tr>`).join("")}
        <tr style="background:#f8fafc"><td style="padding:8px 6px;font-weight:700">Total All-In Rate</td><td style="padding:8px 6px;text-align:right;font-weight:700;color:#16a34a;font-size:14px">$${allInTotal.toLocaleString()}</td></tr>
      </table>
      ${q.equipmentNotes ? `<div style="margin-top:10px;font-size:12px;color:#334155"><strong>Notes &amp; Terms:</strong> ${esc(q.equipmentNotes)}</div>` : ""}
      ${q.validUntil ? `<div style="margin-top:4px;font-size:11px;color:#64748b">Valid through ${esc(q.validUntil)} · ${esc(q.transitNote)}</div>` : ""}
    </div>
  </div>`;

  return { allInTotal, text, html };
}

export const QuoteBuilderView: React.FC<QuoteBuilderViewProps> = ({
  quote,
  onQuoteChange,
  builderEntry,
  onBuilderChange,
  onNavigate,
  onToast,
}) => {
  const formatted = buildFormattedQuote(quote);

  const addAccessorial = () => {
    onQuoteChange({
      ...quote,
      accessorials: [
        ...quote.accessorials,
        { id: `qa-${Date.now()}`, name: "Tarp Fee", amount: 150 },
      ],
    });
  };

  const updateAccessorial = (idx: number, patch: { name?: string; amount?: number }) => {
    onQuoteChange({
      ...quote,
      accessorials: quote.accessorials.map((a, i) => (i === idx ? { ...a, ...patch } : a)),
    });
  };

  const removeAccessorial = (idx: number) => {
    onQuoteChange({
      ...quote,
      accessorials: quote.accessorials.filter((_, i) => i !== idx),
    });
  };

  const handleInsertQuoteReply = async () => {
    const res = await insertGmailReply({
      text: formatted.text,
      html: formatted.html,
      subject: `Freight Rate Quote: ${quote.origin} to ${quote.destination} ($${formatted.allInTotal.toLocaleString()})`,
    });
    onToast(res.message, res.ok ? "ok" : "error");
  };

  const handlePrintQuote = () => {
    const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Quote ${quote.customerName}</title></head>
    <body style="padding:32px;background:#fff">${formatted.html}<script>window.onload=()=>setTimeout(()=>window.print(),250);</script></body></html>`;
    const ok = openPrintableHtmlWindow(`Quote — ${quote.customerName || "Customer"}`, doc);
    onToast(ok ? "Opened printable Customer Quote sheet" : "Pop-up blocked — use Insert Quote into Gmail Reply", ok ? "ok" : "error");
  };

  const handleConvertToLoad = () => {
    onBuilderChange({
      ...builderEntry,
      status: "Committed",
      customer: {
        ...builderEntry.customer,
        name: quote.customerName || builderEntry.customer.name,
        email: quote.contactEmail || builderEntry.customer.email,
      },
      equipment: {
        ...builderEntry.equipment,
        trailerType: quote.equipmentType || builderEntry.equipment.trailerType,
        mileage: quote.estMiles || builderEntry.equipment.mileage,
      },
      pricing: {
        ...builderEntry.pricing,
        linehaulSell: Number(quote.linehaulRate) || 0,
        fuelSell: Number(quote.fuelSurcharge) || 0,
      },
      accessorials: quote.accessorials
        .filter((a) => a.name.trim())
        .map((a) => ({
          scope: "shipment" as const,
          code: "CUSTOM",
          name: a.name,
          sell: Number(a.amount) || 0,
          buy: 0,
        })),
      specialInstructions: quote.equipmentNotes || builderEntry.specialInstructions,
    });
    onToast(`Converted $${formatted.allInTotal.toLocaleString()} quote into Load Builder`);
    onNavigate("build-load");
  };

  return (
    <div className="space-y-2.5">
      <div
        className="p-2.5 rounded-xl space-y-2 text-[11px]"
        style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
      >
        <div className="grid grid-cols-2 gap-1.5">
          <div>
            <label className="block text-[10px] mb-0.5" style={{ color: "var(--pf-text-muted)" }}>
              Customer Name
            </label>
            <input
              value={quote.customerName}
              onChange={(e) => onQuoteChange({ ...quote, customerName: e.target.value })}
              placeholder="Acme Metals Inc"
              className="pf-input font-semibold text-[11px]"
            />
          </div>
          <div>
            <label className="block text-[10px] mb-0.5" style={{ color: "var(--pf-text-muted)" }}>
              Customer Email
            </label>
            <input
              value={quote.contactEmail}
              onChange={(e) => onQuoteChange({ ...quote, contactEmail: e.target.value })}
              placeholder="shipping@customer.com"
              className="pf-input text-[11px]"
            />
          </div>
          <div>
            <label className="block text-[10px] mb-0.5" style={{ color: "var(--pf-text-muted)" }}>
              Origin (City, ST ZIP)
            </label>
            <input
              value={quote.origin}
              onChange={(e) => onQuoteChange({ ...quote, origin: e.target.value })}
              className="pf-input text-[11px]"
            />
          </div>
          <div>
            <label className="block text-[10px] mb-0.5" style={{ color: "var(--pf-text-muted)" }}>
              Destination (City, ST ZIP)
            </label>
            <input
              value={quote.destination}
              onChange={(e) => onQuoteChange({ ...quote, destination: e.target.value })}
              className="pf-input text-[11px]"
            />
          </div>
        </div>

        <div className="grid grid-cols-12 gap-1.5">
          <div className="col-span-5">
            <label className="block text-[10px] mb-0.5" style={{ color: "var(--pf-text-muted)" }}>
              Equipment
            </label>
            <input
              value={quote.equipmentType}
              onChange={(e) => onQuoteChange({ ...quote, equipmentType: e.target.value })}
              className="pf-input text-[11px]"
            />
          </div>
          <div className="col-span-4">
            <label className="block text-[10px] mb-0.5" style={{ color: "var(--pf-text-muted)" }}>
              Linehaul ($)
            </label>
            <input
              type="number"
              value={quote.linehaulRate || ""}
              onChange={(e) => onQuoteChange({ ...quote, linehaulRate: Number(e.target.value) || 0 })}
              className="pf-input font-mono font-bold text-[11px]"
            />
          </div>
          <div className="col-span-3">
            <label className="block text-[10px] mb-0.5" style={{ color: "var(--pf-text-muted)" }}>
              Fuel ($)
            </label>
            <input
              type="number"
              value={quote.fuelSurcharge || ""}
              onChange={(e) => onQuoteChange({ ...quote, fuelSurcharge: Number(e.target.value) || 0 })}
              className="pf-input font-mono text-[11px]"
            />
          </div>
        </div>

        {/* Accessorials */}
        <div className="space-y-1 pt-1" style={{ borderTop: "1px dashed var(--pf-border)" }}>
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "var(--pf-text-muted)" }}>
              Accessorial Charges
            </span>
            <button
              type="button"
              onClick={addAccessorial}
              className="px-1.5 py-0.5 rounded text-[10px] font-semibold inline-flex items-center gap-0.5"
              style={{ background: "var(--pf-primary-dim)", color: "var(--pf-primary)" }}
            >
              <Plus size={10} /> Add Charge
            </button>
          </div>
          {quote.accessorials.map((acc, idx) => (
            <div key={acc.id} className="flex items-center gap-1.5">
              <input
                value={acc.name}
                onChange={(e) => updateAccessorial(idx, { name: e.target.value })}
                placeholder="Charge description (e.g. 8ft Tarps)"
                className="pf-input flex-1 text-[11px]"
              />
              <input
                type="number"
                value={acc.amount || ""}
                onChange={(e) => updateAccessorial(idx, { amount: Number(e.target.value) || 0 })}
                placeholder="$"
                className="pf-input font-mono !w-[74px] text-right text-[11px]"
              />
              <button
                type="button"
                onClick={() => removeAccessorial(idx)}
                className="p-0.5"
                style={{ color: "var(--pf-danger)" }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>

        {/* Equipment & Terms Notes */}
        <div className="space-y-1">
          <input
            value={quote.equipmentNotes}
            onChange={(e) => onQuoteChange({ ...quote, equipmentNotes: e.target.value })}
            placeholder="Equipment notes, free time, detention, validity…"
            className="pf-input text-[11px]"
          />
          <div className="flex flex-wrap gap-1">
            {QUOTE_NOTE_CHIPS.map((chip) => (
              <button
                key={chip}
                type="button"
                onClick={() => {
                  if (!quote.equipmentNotes.includes(chip)) {
                    onQuoteChange({
                      ...quote,
                      equipmentNotes: quote.equipmentNotes ? `${quote.equipmentNotes} | ${chip}` : chip,
                    });
                  }
                }}
                className="px-1.5 py-0.5 rounded text-[10px]"
                style={{ background: "var(--pf-surface-raised)", color: "var(--pf-text-muted)" }}
              >
                + {chip}
              </button>
            ))}
          </div>
        </div>

        {/* Total All-In Strip */}
        <div
          className="p-2 rounded-lg flex items-center justify-between font-mono"
          style={{ background: "var(--pf-primary-dim)", border: "1px solid var(--pf-primary)" }}
        >
          <span className="text-xs font-semibold">Total All-In Customer Quote</span>
          <span className="text-sm font-bold" style={{ color: "var(--pf-primary)" }}>
            ${formatted.allInTotal.toLocaleString()}
          </span>
        </div>

        {/* Primary CTA: 1-Click Insert Quote into Gmail Reply */}
        <button
          type="button"
          onClick={() => void handleInsertQuoteReply()}
          className="w-full py-2 px-3 rounded-lg text-xs font-bold inline-flex items-center justify-center gap-1.5"
          style={{ background: "var(--pf-action)", color: "#ffffff" }}
        >
          <Reply size={13} /> Insert Quote into Gmail Reply
        </button>

        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            onClick={handlePrintQuote}
            className="py-1.5 px-2 rounded-lg text-[11px] font-semibold inline-flex items-center justify-center gap-1"
            style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
          >
            <Printer size={11} /> Print Quote PDF
          </button>
          <button
            type="button"
            onClick={handleConvertToLoad}
            className="py-1.5 px-2 rounded-lg text-[11px] font-semibold inline-flex items-center justify-center gap-1"
            style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
          >
            <PlusCircle size={11} /> Convert to Load
          </button>
        </div>
      </div>

      {/* Live Plaintext Preview */}
      <pre
        className="p-2.5 rounded-xl text-[10px] font-mono whitespace-pre-wrap leading-relaxed"
        style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)", color: "var(--pf-text-muted)" }}
      >
        {formatted.text}
      </pre>
    </div>
  );
};
