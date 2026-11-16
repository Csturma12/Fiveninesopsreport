import React, { useState } from "react";
import type { CarrierOption, OpsShipment } from "@shared/tai-webhook-schema";
import { buildGmailContainerSearchUrl } from "@shared/container-extractor";
import { CheckCircle2, ChevronDown, ChevronRight, MapPin, Search, Upload } from "lucide-react";

interface UnifiedDispatchViewProps {
  shipments: OpsShipment[];
  carriers: CarrierOption[];
  searchQuery: string;
  expandedLoadId: string | null;
  onToggleExpand: (id: string) => void;
  onAssignCarrier: (shipmentId: string, carrierName: string, buyRate: number) => Promise<void>;
  onUploadPod: (shipmentId: string) => Promise<void>;
  onSaveNote: (
    shipmentId: string,
    payload: { note?: string; pastedEmailText?: string; containerNumber?: string },
  ) => Promise<void>;
  onAskAi: (question: string) => void;
}

const STAGES = ["All", "Needs truck", "Assigned", "In transit", "Delivered", "Missing POD"] as const;

export const UnifiedDispatchView: React.FC<UnifiedDispatchViewProps> = ({
  shipments,
  carriers,
  searchQuery,
  expandedLoadId,
  onToggleExpand,
  onAssignCarrier,
  onUploadPod,
  onSaveNote,
  onAskAi,
}) => {
  const [stageFilter, setStageFilter] = useState<string>("All");
  const [draftCarrier, setDraftCarrier] = useState<Record<string, string>>({});
  const [draftBuy, setDraftBuy] = useState<Record<string, number>>({});
  const [draftNotes, setDraftNotes] = useState<Record<string, string>>({});

  const filtered = shipments.filter((s) => {
    if (stageFilter === "Missing POD" && !(s.stage === "Delivered" && s.podCount === 0)) return false;
    if (stageFilter !== "All" && stageFilter !== "Missing POD" && s.stage !== stageFilter) return false;
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return `${s.id} ${s.customer} ${s.origin} ${s.dest} ${s.carrier} ${s.po} ${s.equip} ${s.containerNumber || ""} ${s.operationalNote || ""}`
      .toLowerCase()
      .includes(q);
  });

  const badgeStyle = (s: OpsShipment): React.CSSProperties => {
    if (s.stage === "Delivered" && s.podCount === 0) {
      return { background: "var(--pf-danger-dim)", color: "var(--pf-danger)", border: "1px solid rgba(226,75,74,0.35)" };
    }
    if (s.stage === "Needs truck") {
      return { background: "var(--pf-warning-dim)", color: "var(--pf-warning)", border: "1px solid rgba(212,160,74,0.35)" };
    }
    if (s.stage === "In transit" || s.stage === "Assigned") {
      return { background: "var(--pf-info-dim)", color: "var(--pf-info)", border: "1px solid rgba(107,143,191,0.35)" };
    }
    return { background: "var(--pf-primary-dim)", color: "var(--pf-primary)", border: "1px solid rgba(62,191,130,0.35)" };
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--pf-text-muted)" }}>
            Click Any Row → Expands 1 Load Inline with Full Stops, Commodities &amp; TAI Write-Back
          </div>
          <h1 className="text-xl font-semibold tracking-tight mt-0.5">Unified Dispatch</h1>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {STAGES.map((st) => {
            const active = stageFilter === st;
            return (
              <button
                key={st}
                type="button"
                onClick={() => setStageFilter(st)}
                className="px-3 py-1.5 rounded-full text-xs font-medium transition-all"
                style={{
                  background: active ? "var(--pf-primary-dim)" : "var(--pf-surface)",
                  color: active ? "var(--pf-primary)" : "var(--pf-text-muted)",
                  border: `1px solid ${active ? "var(--pf-primary)" : "var(--pf-border)"}`,
                }}
              >
                {st}
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-2.5">
        {filtered.map((s) => {
          const isExp = expandedLoadId === s.id;
          const margin = s.sell - s.buy;
          const totWt = s.commodities.reduce((a, c) => a + c.weightTotal, 0);
          const totPcs = s.commodities.reduce((a, c) => a + c.piecesTotal, 0);
          const selectedCarr = draftCarrier[s.id] ?? (s.carrier || carriers[0]?.name || "");
          const selectedBuy = draftBuy[s.id] ?? (s.buy || Math.max(900, s.sell - 450));

          return (
            <div
              key={s.id}
              className="rounded-xl overflow-hidden transition-all"
              style={{
                background: "var(--pf-surface)",
                border: `1px solid ${isExp ? "var(--pf-action)" : "var(--pf-border)"}`,
              }}
            >
              {/* Summary Row */}
              <div
                onClick={() => onToggleExpand(s.id)}
                className="cursor-pointer p-3.5 flex flex-wrap items-center justify-between gap-3 hover:opacity-95"
              >
                <div className="min-w-[250px] flex-1 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="inline-flex items-center gap-1 font-mono text-xs font-bold" style={{ color: "var(--pf-action)" }}>
                      {isExp ? <ChevronDown size={14} /> : <ChevronRight size={14} />}#{s.id}
                    </span>
                    <span className="text-sm font-semibold">
                      {s.customer} · {s.origin} → {s.dest}
                    </span>
                    {s.containerNumber && (
                      <span
                        className="font-mono text-[11px] px-2 py-0.5 rounded font-semibold"
                        style={{ background: "var(--pf-info-dim)", color: "var(--pf-info)" }}
                      >
                        📦 {s.containerNumber}
                      </span>
                    )}
                    {s.po ? (
                      <span
                        className="font-mono text-[11px] px-2 py-0.5 rounded"
                        style={{ background: "var(--pf-surface-raised)", color: "var(--pf-text-muted)" }}
                      >
                        PO {s.po}
                      </span>
                    ) : (
                      <span
                        className="text-[11px] px-2 py-0.5 rounded font-medium"
                        style={{ background: "var(--pf-warning-dim)", color: "var(--pf-warning)" }}
                      >
                        Missing PO
                      </span>
                    )}
                  </div>
                  <div className="text-xs flex flex-wrap items-center gap-2" style={{ color: "var(--pf-text-muted)" }}>
                    <span>PU {s.shipDate}</span>
                    <span>·</span>
                    <span>{s.equip}</span>
                    <span>·</span>
                    <span className="font-mono">
                      {totPcs} pcs / {totWt.toLocaleString()} lbs
                    </span>
                    <span>·</span>
                    <span className="inline-flex items-center gap-1">
                      <MapPin size={11} /> {s.location}
                    </span>
                  </div>
                  {s.operationalNote && (
                    <div
                      className="mt-1 px-2.5 py-1 rounded text-[11px] font-semibold inline-block"
                      style={{
                        background: "var(--pf-warning-dim)",
                        color: "var(--pf-warning)",
                        border: "1px solid rgba(212,160,74,0.35)",
                      }}
                    >
                      {s.operationalNote}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-4 shrink-0">
                  <span className="px-2.5 py-1 rounded-full text-xs font-medium" style={badgeStyle(s)}>
                    {s.stage === "Delivered" && s.podCount === 0 ? "Missing POD" : s.stage}
                  </span>
                  <div
                    className="w-44 text-xs font-medium truncate"
                    style={{ color: s.carrier ? "var(--pf-text)" : "var(--pf-warning)" }}
                  >
                    {s.carrier || "Needs carrier"}
                  </div>
                  <div className="w-28 text-right font-mono text-xs">
                    <div className="font-semibold">${s.sell.toLocaleString()} sell</div>
                    <div
                      style={{
                        color: s.buy === 0 ? "var(--pf-text-subtle)" : margin >= 0 ? "var(--pf-primary)" : "var(--pf-danger)",
                      }}
                    >
                      {s.buy === 0 ? "Buy TBD" : `${margin >= 0 ? "+" : "-"}$${Math.abs(margin).toLocaleString()} mgn`}
                    </div>
                  </div>
                </div>
              </div>

              {/* INLINE 1-LOAD FULL DETAIL EXPANSION */}
              {isExp && (
                <div
                  className="p-4 space-y-3.5"
                  style={{ background: "var(--pf-surface-raised)", borderTop: "1px solid var(--pf-border)" }}
                >
                  {s.operationalNote && (
                    <div
                      className="px-3.5 py-2 rounded-lg text-xs font-semibold flex flex-wrap items-center justify-between gap-2"
                      style={{
                        background: "var(--pf-warning-dim)",
                        color: "var(--pf-warning)",
                        border: "1px solid rgba(212,160,74,0.4)",
                      }}
                    >
                      <span>{s.operationalNote}</span>
                      {s.containerNumber && (
                        <a
                          href={buildGmailContainerSearchUrl(s.containerNumber, s.id)}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 underline font-mono"
                        >
                          <Search size={11} /> Search {s.containerNumber} in Gmail
                        </a>
                      )}
                    </div>
                  )}

                  <div
                    className="px-3 py-2 rounded-lg flex flex-wrap items-center justify-between gap-2 text-xs"
                    style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
                  >
                    <div>
                      <strong style={{ color: "var(--pf-primary)" }}>TAI Sync:</strong>{" "}
                      <span className="font-mono">{s.writebackState}</span>
                    </div>
                    <div className="font-mono" style={{ color: "var(--pf-text-muted)" }}>
                      {s.containerNumber ? `Container: ${s.containerNumber} · ` : ""}BOL: {s.bol || "—"} · PRO: {s.pro || "—"} · RateCon: {s.rateconStatus}
                      {s.invoiceStatus ? ` · ${s.invoiceStatus}` : ""}
                    </div>
                  </div>

                  <div className="grid lg:grid-cols-3 gap-3.5">
                    {/* Stops + ZIPs */}
                    <div
                      className="p-3 rounded-xl space-y-2"
                      style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
                    >
                      <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--pf-text-muted)" }}>
                        Stops ({s.stops.length}) &amp; ZIPs
                      </div>
                      {s.stops.map((st, i) => (
                        <div
                          key={i}
                          className="text-xs pb-1.5"
                          style={i < s.stops.length - 1 ? { borderBottom: "1px dashed var(--pf-border)" } : undefined}
                        >
                          <div className="font-semibold">
                            {i + 1}. {st.stopType}: {st.companyName}
                          </div>
                          <div style={{ color: "var(--pf-text-muted)" }}>
                            {st.streetAddress ? `${st.streetAddress}, ` : ""}
                            {st.city}, {st.state} <strong className="font-mono">{st.zipCode}</strong>
                          </div>
                          <div className="font-mono text-[11px]" style={{ color: "var(--pf-text-subtle)" }}>
                            {st.readyDate} ({st.timeOpen}–{st.timeClose})
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Commodities + Equipment */}
                    <div
                      className="p-3 rounded-xl space-y-2"
                      style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
                    >
                      <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--pf-text-muted)" }}>
                        Commodities &amp; Equipment
                      </div>
                      {s.commodities.map((c, ci) => (
                        <div key={ci} className="p-2 rounded text-xs space-y-0.5" style={{ background: "var(--pf-surface-raised)" }}>
                          <div className="font-semibold">{c.description}</div>
                          <div className="font-mono text-[11px]" style={{ color: "var(--pf-text-muted)" }}>
                            {c.piecesTotal} pcs ({c.packagingType}) · {c.weightTotal.toLocaleString()} lbs
                          </div>
                        </div>
                      ))}
                      <div className="text-xs" style={{ color: "var(--pf-text-muted)" }}>
                        <strong>Trailer:</strong> {s.trailerSize} · {s.equip} {s.mileage ? `· ${s.mileage} mi` : ""}
                      </div>
                      {s.accessorials.length > 0 && (
                        <div className="text-xs" style={{ color: "var(--pf-text-muted)" }}>
                          <strong>Accessorials:</strong> {s.accessorials.join(", ")}
                        </div>
                      )}
                    </div>

                    {/* Carrier + Buy Write-Back & POD */}
                    <div
                      className="p-3 rounded-xl space-y-2.5"
                      style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
                    >
                      <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--pf-text-muted)" }}>
                        TAI Carrier &amp; Buy Write-Back
                      </div>
                      <select
                        value={selectedCarr}
                        onChange={(e) => setDraftCarrier({ ...draftCarrier, [s.id]: e.target.value })}
                        className="pf-input"
                      >
                        {carriers.map((c) => (
                          <option key={c.name} value={c.name}>
                            {c.name} (MC {c.mc})
                          </option>
                        ))}
                      </select>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[11px] mb-0.5" style={{ color: "var(--pf-text-muted)" }}>
                            Linehaul Buy ($)
                          </label>
                          <input
                            type="number"
                            value={selectedBuy}
                            onChange={(e) => setDraftBuy({ ...draftBuy, [s.id]: Number(e.target.value) || 0 })}
                            className="pf-input font-mono font-bold"
                          />
                        </div>
                        <div className="flex items-end">
                          <button
                            type="button"
                            onClick={() => onAssignCarrier(s.id, selectedCarr, selectedBuy)}
                            className="w-full py-1.5 px-2 rounded-lg text-xs font-semibold"
                            style={{ background: "var(--pf-primary)", color: "var(--pf-primary-fg)" }}
                          >
                            Queue TAI Write
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => onUploadPod(s.id)}
                          className="py-1.5 px-2 rounded-lg text-xs font-medium inline-flex items-center justify-center gap-1"
                          style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
                        >
                          {s.podCount > 0 ? (
                            <>
                              <CheckCircle2 size={12} style={{ color: "var(--pf-primary)" }} /> POD ({s.podCount})
                            </>
                          ) : (
                            <>
                              <Upload size={12} /> Upload POD
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => onAskAi(`Check status and write-back on load ${s.id}`)}
                          className="py-1.5 px-2 rounded-lg text-xs font-medium"
                          style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
                        >
                          ✦ Ask Copilot
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Container Event History & Operational Note Box */}
                  <div
                    className="p-3 rounded-xl space-y-2.5"
                    style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--pf-text-muted)" }}>
                        Container Events &amp; Exception Note {s.containerNumber ? `(${s.containerNumber})` : ""}
                      </span>
                      {s.containerNumber && (
                        <a
                          href={buildGmailContainerSearchUrl(s.containerNumber, s.id)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[11px] font-mono inline-flex items-center gap-1 hover:underline"
                          style={{ color: "var(--pf-info)" }}
                        >
                          <Search size={11} /> Search All Container Emails in Gmail
                        </a>
                      )}
                    </div>

                    {s.containerEvents && s.containerEvents.length > 0 && (
                      <div className="space-y-1.5">
                        {s.containerEvents.map((ev) => (
                          <div key={ev.id} className="p-2 rounded text-xs" style={{ background: "var(--pf-surface-raised)" }}>
                            <div className="flex items-center justify-between gap-2 text-[11px] font-mono">
                              <strong style={{ color: ev.kind === "tonu" ? "var(--pf-danger)" : "var(--pf-primary)" }}>
                                [{ev.kind.toUpperCase()}] {ev.subject}
                              </strong>
                              <span style={{ color: "var(--pf-text-subtle)" }}>{ev.timestamp}</span>
                            </div>
                            <div style={{ color: "var(--pf-text-muted)" }}>{ev.summary}</div>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="flex gap-2">
                      <input
                        value={draftNotes[s.id] ?? s.operationalNote ?? ""}
                        onChange={(e) => setDraftNotes({ ...draftNotes, [s.id]: e.target.value })}
                        placeholder="Add/update TONU or equipment breakdown note (or paste container email)…"
                        className="pf-input flex-1"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          onSaveNote(s.id, {
                            pastedEmailText: draftNotes[s.id] ?? s.operationalNote ?? "",
                            containerNumber: s.containerNumber,
                          })
                        }
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold shrink-0"
                        style={{ background: "var(--pf-action)", color: "#ffffff" }}
                      >
                        Save Note
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
