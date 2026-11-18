import React, { useMemo, useState } from "react";
import type { LoadEntry } from "@shared/load-entry";
import { isHiddenCustomer, type OpsShipment } from "@shared/tai-webhook-schema";
import { ArrowUpRight, ChevronDown, ChevronRight, Copy, FileText, MapPin, Save, Search, Upload } from "lucide-react";
import { insertGmailReply } from "./extensionBridge";
import { panelFetchJson, type PanelApiContext } from "./panelApi";
import { shipmentToLoadEntry, type LiveOpsShipment, type PanelViewId } from "./panelTypes";

interface AllLoadsViewProps {
  shipments: OpsShipment[];
  universalQuery: string;
  expandedId: string | null;
  onExpandChange: (id: string | null) => void;
  apiCtx?: PanelApiContext;
  onRefresh: () => Promise<void>;
  onToast: (msg: string, kind?: "ok" | "error") => void;
  onUploadPod?: (shipmentId: string) => void;
  onOpenBol: (shipmentId: string) => void;
  onCopyToBuilder: (entry: LoadEntry) => void;
  onNavigate: (view: PanelViewId) => void;
}

export const AllLoadsView: React.FC<AllLoadsViewProps> = ({
  shipments,
  universalQuery,
  expandedId,
  onExpandChange,
  apiCtx,
  onRefresh,
  onToast,
  onUploadPod,
  onOpenBol,
  onCopyToBuilder,
  onNavigate,
}) => {
  const [localQuery, setLocalQuery] = useState("");
  const [stageFilter, setStageFilter] = useState<string>("All");
  const [equipFilter, setEquipFilter] = useState<string>("All");
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [editSell, setEditSell] = useState<Record<string, number>>({});
  const [editBuy, setEditBuy] = useState<Record<string, number>>({});
  const [editPo, setEditPo] = useState<Record<string, string>>({});

  const effectiveQuery = (localQuery || universalQuery).trim().toLowerCase();

  const filtered = useMemo(() => {
    return (shipments as LiveOpsShipment[]).filter((s) => {
      if (isHiddenCustomer(s.customer)) return false;
      const isCancelled = s.stage === "Cancelled" || /cancel/i.test(String(s.rawStatus || ""));
      if (stageFilter === "Cancelled") return isCancelled;
      if (stageFilter === "Needs truck" && (isCancelled || Boolean(s.carrier && s.carrier.trim()) || s.stage !== "Needs truck")) {
        return false;
      }
      if (stageFilter === "Missing POD" && !(s.stage === "Delivered" && s.podCount === 0)) return false;
      if (
        stageFilter !== "All" &&
        stageFilter !== "Missing POD" &&
        stageFilter !== "Needs truck" &&
        (isCancelled || s.stage !== stageFilter)
      ) {
        return false;
      }
      if (equipFilter !== "All" && !s.equip.toLowerCase().includes(equipFilter.toLowerCase())) return false;
      if (!effectiveQuery) return true;
      const hay = [
        s.id,
        s.customer,
        s.carrier,
        s.po,
        s.bol,
        s.pro,
        s.containerNumber || "",
        s.origin,
        s.dest,
        s.equip,
        s.operationalNote || "",
        ...s.stops.map((st) => `${st.companyName} ${st.city} ${st.state} ${st.zipCode}`),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(effectiveQuery);
    });
  }, [shipments, stageFilter, equipFilter, effectiveQuery]);

  const handleInlineEditSave = async (s: LiveOpsShipment) => {
    const { ok, data } = await panelFetchJson<{ ok?: boolean; message?: string }>(
      `/api/loads/${encodeURIComponent(s.id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          sell: editSell[s.id] ?? s.sell,
          buy: editBuy[s.id] ?? s.buy,
          po: editPo[s.id] ?? s.po,
          operationalNote: noteDrafts[s.id] ?? s.operationalNote ?? "",
          pushToTai: true,
        }),
      },
      apiCtx,
    );
    onToast(data.message || `Updated Load #${s.id}`, ok && data.ok !== false ? "ok" : "error");
    await onRefresh();
  };

  const handleSendRateCon = async (s: LiveOpsShipment) => {
    const { ok, data } = await panelFetchJson<{ summaryText?: string }>(
      `/api/loads/${encodeURIComponent(s.id)}/ratecon`,
      { method: "GET" },
      apiCtx,
    );
    const text =
      (ok && data.summaryText) ||
      `CARRIER RATE CONFIRMATION — Load #${s.id}\nCarrier: ${s.carrier || "TBD"}\nLane: ${s.origin} -> ${s.dest}\nCarrier Pay: $${(s.buy || 0).toLocaleString()}`;
    const replyRes = await insertGmailReply({
      text,
      subject: `Rate Confirmation — Load #${s.id}`,
    });
    await panelFetchJson(
      `/api/loads/${encodeURIComponent(s.id)}/ratecon-status`,
      { method: "PATCH", body: JSON.stringify({ rateconStatus: "Sent" }) },
      apiCtx,
    );
    onToast(replyRes.message);
    await onRefresh();
  };

  const saveLoadNote = async (s: OpsShipment) => {
    const note = (noteDrafts[s.id] ?? s.operationalNote ?? "").trim();
    if (!note) return;
    const { ok, data } = await panelFetchJson<{ ok?: boolean; message?: string }>(
      `/api/loads/${encodeURIComponent(s.id)}/note`,
      {
        method: "POST",
        body: JSON.stringify({ note, containerNumber: s.containerNumber }),
      },
      apiCtx,
    );
    onToast(data.message || `Saved note on #${s.id}`, ok && data.ok !== false ? "ok" : "error");
    await onRefresh();
  };

  const [syncingInvoices, setSyncingInvoices] = useState<boolean>(false);

  const handleSyncAllInvoices = async () => {
    setSyncingInvoices(true);
    try {
      const sids = filtered.map((s) => s.id).filter((id) => /^\d+$/.test(id)).slice(0, 25);
      const { ok, data } = await panelFetchJson<{ ok?: boolean; message?: string; synced?: number }>(
        "/api/tai/invoices/sync",
        {
          method: "POST",
          body: JSON.stringify({ shipmentIds: sids.length > 0 ? sids : undefined, limit: 25 }),
        },
        apiCtx,
      );
      onToast(data.message || "Synced invoices from TAI Accounting", ok ? "ok" : "error");
      await onRefresh();
    } catch {
      onToast("Failed to sync TAI invoices", "error");
    } finally {
      setSyncingInvoices(false);
    }
  };

  const handleSyncSingleInvoice = async (shipmentId: string) => {
    try {
      const { ok, data } = await panelFetchJson<{ ok?: boolean; message?: string }>(
        `/api/loads/${encodeURIComponent(shipmentId)}/sync-invoice`,
        { method: "POST" },
        apiCtx,
      );
      onToast(data.message || `Synced invoice for #${shipmentId}`, ok ? "ok" : "error");
      await onRefresh();
    } catch {
      onToast(`Failed to sync invoice for #${shipmentId}`, "error");
    }
  };

  return (
    <div className="space-y-2.5">
      {/* Directory Filter Controls */}
      <div
        className="p-2 rounded-xl space-y-1.5"
        style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
      >
        <div className="flex items-center gap-1.5">
          <Search size={12} style={{ color: "var(--pf-text-muted)" }} className="shrink-0" />
          <input
            value={localQuery}
            onChange={(e) => setLocalQuery(e.target.value)}
            placeholder={universalQuery ? `Filtered by "${universalQuery}" (or refine here)…` : "Filter directory by #, PO, BOL, ZIP, Customer, Carrier…"}
            className="pf-input text-[11px]"
          />
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <select value={stageFilter} onChange={(e) => setStageFilter(e.target.value)} className="pf-input text-[11px]">
            <option value="All">Stage: All ({shipments.length})</option>
            <option value="Needs truck">Needs truck</option>
            <option value="Assigned">Assigned</option>
            <option value="In transit">In transit</option>
            <option value="Delivered">Delivered</option>
            <option value="Missing POD">Missing POD</option>
            <option value="Cancelled">Cancelled</option>
          </select>
          <select value={equipFilter} onChange={(e) => setEquipFilter(e.target.value)} className="pf-input text-[11px]">
            <option value="All">Equipment: All</option>
            <option value="Flatbed">Flatbed</option>
            <option value="Step">Step Deck</option>
            <option value="Van">Dry Van</option>
            <option value="Conestoga">Conestoga</option>
            <option value="Reefer">Reefer</option>
          </select>
        </div>
      </div>

      <div className="flex items-center justify-between px-0.5 text-[10px] font-mono" style={{ color: "var(--pf-text-muted)" }}>
        <span>Showing {filtered.length} of {shipments.length} shipments</span>
        <button
          type="button"
          onClick={() => void handleSyncAllInvoices()}
          disabled={syncingInvoices}
          className="px-2 py-0.5 rounded text-[10px] font-bold inline-flex items-center gap-1 transition-opacity hover:opacity-85 disabled:opacity-50"
          style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)", color: "var(--pf-primary)" }}
          title="Sync live invoices from TAI Accounting API"
        >
          <FileText size={10} className={syncingInvoices ? "animate-spin" : ""} />
          {syncingInvoices ? "Syncing TAI…" : "Sync TAI Invoices"}
        </button>
      </div>

      {/* Expandable Full Load Directory */}
      <div className="space-y-1.5">
        {filtered.map((s) => {
          const isExp = expandedId === s.id;
          const totWt = s.commodities.reduce((sum, c) => sum + c.weightTotal, 0);
          const totPcs = s.commodities.reduce((sum, c) => sum + c.piecesTotal, 0);

          return (
            <div
              key={s.id}
              className="rounded-xl overflow-hidden"
              style={{
                background: "var(--pf-surface)",
                border: `1px solid ${isExp ? "var(--pf-action)" : "var(--pf-border)"}`,
              }}
            >
              <button
                type="button"
                onClick={() => onExpandChange(isExp ? null : s.id)}
                className="w-full text-left p-2.5 space-y-0.5 hover:opacity-95"
              >
                <div className="flex items-center justify-between gap-2 text-xs">
                  <div className="inline-flex items-center gap-1.5 font-mono font-bold" style={{ color: "var(--pf-action)" }}>
                    <span className="inline-flex items-center gap-0.5">
                      {isExp ? <ChevronDown size={13} /> : <ChevronRight size={13} />}#{s.id}
                    </span>
                    {s.lastAgentAction && (
                      <span
                        className="px-1 py-0.2 rounded text-[9px] font-mono font-bold"
                        style={{
                          background: s.lastAgentAction.agent.toLowerCase().includes("grok")
                            ? "rgba(168, 85, 247, 0.15)"
                            : "rgba(59, 130, 246, 0.15)",
                          color: s.lastAgentAction.agent.toLowerCase().includes("grok") ? "#c084fc" : "#60a5fa",
                          border: `1px solid ${
                            s.lastAgentAction.agent.toLowerCase().includes("grok")
                              ? "rgba(168, 85, 247, 0.4)"
                              : "rgba(59, 130, 246, 0.4)"
                          }`,
                        }}
                        title={`${s.lastAgentAction.agent}: ${s.lastAgentAction.summary || s.lastAgentAction.action}`}
                      >
                        {s.lastAgentAction.agent.toLowerCase().includes("grok") ? "🤖 Grok" : "🧠 Google"}
                      </span>
                    )}
                  </div>
                  <span
                    className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold"
                    style={{ background: "var(--pf-surface-raised)", color: "var(--pf-info)" }}
                  >
                    {s.stage}
                  </span>
                </div>
                <div className="text-xs font-semibold truncate">{s.customer}</div>
                <div className="text-[11px] truncate" style={{ color: "var(--pf-text-muted)" }}>
                  {s.origin} → {s.dest}
                </div>
                <div className="flex items-center justify-between text-[10px] font-mono pt-0.5" style={{ color: "var(--pf-text-subtle)" }}>
                  <span>PO: {s.po || "—"} · RC: {s.rateconStatus || "Not Sent"}</span>
                  <span style={{ color: "var(--pf-primary)" }}>
                    ${s.sell.toLocaleString()} / ${s.buy.toLocaleString()}
                  </span>
                </div>
              </button>

              {isExp && (
                <div
                  className="p-2.5 space-y-2 text-[11px]"
                  style={{ background: "var(--pf-surface-raised)", borderTop: "1px solid var(--pf-border)" }}
                >
                  {/* Tracking & Status */}
                  <div className="p-2 rounded-lg space-y-0.5" style={{ background: "var(--pf-surface)" }}>
                    <div className="flex items-center justify-between">
                      <span className="inline-flex items-center gap-1 font-semibold">
                        <MapPin size={11} style={{ color: "var(--pf-info)" }} /> {s.location}
                      </span>
                      <span className="font-mono text-[10px]" style={{ color: "var(--pf-text-muted)" }}>
                        {s.shipDate} → {s.delivDate}
                      </span>
                    </div>
                    <div className="font-mono text-[10px]" style={{ color: "var(--pf-primary)" }}>
                      {s.writebackState}
                    </div>
                    {s.invoiceStatus && (
                      <div className="font-mono text-[10px]" style={{ color: "var(--pf-warning)" }}>
                        {s.invoiceStatus}
                      </div>
                    )}
                  </div>

                  {/* Stops Detail */}
                  <div className="p-2 rounded-lg space-y-1" style={{ background: "var(--pf-surface)" }}>
                    <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "var(--pf-text-muted)" }}>
                      Stops ({s.stops.length})
                    </div>
                    {s.stops.map((st, idx) => (
                      <div key={idx} className="leading-snug">
                        <strong>{idx + 1}. {st.stopType}:</strong> {st.companyName} — {st.streetAddress ? `${st.streetAddress}, ` : ""}
                        {st.city}, {st.state} <span className="font-mono font-semibold">{st.zipCode}</span>{" "}
                        <span className="font-mono text-[10px]" style={{ color: "var(--pf-text-subtle)" }}>
                          ({st.readyDate} {st.timeOpen}–{st.timeClose})
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* Commodities Detail */}
                  <div className="p-2 rounded-lg space-y-1" style={{ background: "var(--pf-surface)" }}>
                    <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "var(--pf-text-muted)" }}>
                      Commodities ({totPcs} pcs · {totWt.toLocaleString()} lbs)
                    </div>
                    {s.commodities.map((c, idx) => (
                      <div key={idx} className="flex items-center justify-between gap-2">
                        <span className="truncate">{c.description}</span>
                        <span className="font-mono text-[10px] shrink-0" style={{ color: "var(--pf-text-muted)" }}>
                          {c.piecesTotal} {c.packagingType} · {c.weightTotal.toLocaleString()} lbs
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* Inline Edit PO / Sell / Buy + Note (PATCH /api/loads/:id) */}
                  <div className="grid grid-cols-3 gap-1.5">
                    <input
                      value={editPo[s.id] ?? s.po}
                      onChange={(e) => setEditPo({ ...editPo, [s.id]: e.target.value })}
                      placeholder="PO #"
                      className="pf-input font-mono text-[11px]"
                    />
                    <input
                      type="number"
                      value={editSell[s.id] ?? s.sell}
                      onChange={(e) => setEditSell({ ...editSell, [s.id]: Number(e.target.value) || 0 })}
                      placeholder="Sell $"
                      className="pf-input font-mono text-[11px]"
                    />
                    <input
                      type="number"
                      value={editBuy[s.id] ?? s.buy}
                      onChange={(e) => setEditBuy({ ...editBuy, [s.id]: Number(e.target.value) || 0 })}
                      placeholder="Buy $"
                      className="pf-input font-mono text-[11px]"
                    />
                  </div>

                  {/* Operational Note */}
                  <div className="flex items-center gap-1.5">
                    <input
                      value={noteDrafts[s.id] ?? s.operationalNote ?? ""}
                      onChange={(e) => setNoteDrafts({ ...noteDrafts, [s.id]: e.target.value })}
                      placeholder="Add or edit operational / tracking note…"
                      className="pf-input flex-1 text-[11px]"
                    />
                    <button
                      type="button"
                      onClick={() => void handleInlineEditSave(s)}
                      className="px-2.5 py-1.5 rounded text-[10px] font-bold inline-flex items-center gap-1 shrink-0"
                      style={{ background: "#21b975", color: "#07130c" }}
                    >
                      <Save size={11} /> Save &amp; Sync
                    </button>
                  </div>

                  {/* Quick Document & Navigation Actions */}
                  <div className="grid grid-cols-5 gap-1">
                    <button
                      type="button"
                      onClick={() => void handleSendRateCon(s)}
                      className="py-1.5 px-1 rounded text-[9.5px] font-semibold inline-flex items-center justify-center gap-0.5 truncate"
                      style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
                      title="Send Rate Confirmation"
                    >
                      <ArrowUpRight size={10} /> RC
                    </button>

                    <button
                      type="button"
                      onClick={() => onOpenBol(s.id)}
                      className="py-1.5 px-1 rounded text-[9.5px] font-semibold inline-flex items-center justify-center gap-0.5 truncate"
                      style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
                      title="Generate BOL"
                    >
                      <FileText size={10} /> BOL
                    </button>

                    {onUploadPod && (
                      <button
                        type="button"
                        onClick={() => onUploadPod(s.id)}
                        className="py-1.5 px-1 rounded text-[9.5px] font-semibold inline-flex items-center justify-center gap-0.5 truncate"
                        style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
                        title="Upload POD"
                      >
                        <Upload size={10} /> POD ({s.podCount})
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => void handleSyncSingleInvoice(s.id)}
                      className="py-1.5 px-1 rounded text-[9.5px] font-semibold inline-flex items-center justify-center gap-0.5 truncate"
                      style={{
                        background: "var(--pf-surface)",
                        border: "1px solid var(--pf-border)",
                        color: /paid/i.test(s.invoiceStatus || "") ? "var(--pf-primary)" : "var(--pf-text)",
                      }}
                      title="Sync live invoice from TAI Accounting"
                    >
                      <FileText size={10} /> Inv
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        onCopyToBuilder(shipmentToLoadEntry(s));
                        onNavigate("build-load");
                      }}
                      className="py-1.5 px-1 rounded text-[9.5px] font-semibold inline-flex items-center justify-center gap-0.5 truncate"
                      style={{ background: "var(--pf-primary-dim)", color: "var(--pf-primary)" }}
                      title="Clone load to Compact Builder"
                    >
                      <Copy size={10} /> Clone
                    </button>
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
