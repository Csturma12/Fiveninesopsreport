import React, { useRef, useState } from "react";
import type { CarrierOption, OpsShipment } from "@shared/tai-webhook-schema";
import { POD_FILE_ACCEPT, podMimeTypeForFile } from "../../lib/pod-file";
import {
  CheckCircle2,
  ExternalLink,
  FileText,
  MapPin,
  Printer,
  Reply,
  Save,
  Upload,
} from "lucide-react";
import { insertGmailReply } from "./extensionBridge";
import { panelFetchJson, type PanelApiContext } from "./panelApi";
import { openPrintableHtmlWindow, type LiveOpsShipment } from "./panelTypes";

interface DispatchBoardViewProps {
  shipments: OpsShipment[];
  carriers: CarrierOption[];
  expandedId: string | null;
  onExpandChange: (id: string | null) => void;
  apiCtx?: PanelApiContext;
  onRefresh: () => Promise<void>;
  onToast: (msg: string, kind?: "ok" | "error") => void;
  onUploadPod?: (shipmentId: string) => void;
  onOpenBol: (shipmentId: string) => void;
  onOpenDashboardLoad?: (shipmentId: string) => void;
  isLiveSync?: boolean;
}

type StageBucket = "All" | "Needs truck" | "Assigned" | "In transit" | "Delivered" | "Cancelled";

const STAGE_BUCKETS: StageBucket[] = [
  "All",
  "Needs truck",
  "Assigned",
  "In transit",
  "Delivered",
  "Cancelled",
];

function isLoadCancelled(s: LiveOpsShipment): boolean {
  return s.stage === "Cancelled" || /cancel/i.test(String(s.rawStatus || ""));
}

function shortCityState(loc: string): string {
  return loc.replace(/\s+\d{5}(-\d{4})?$/, "").replace(/,/g, "").trim();
}

function stagePillPalette(stage: LiveOpsShipment["stage"], rawStatus: string, hasCarrier: boolean): { label: string; bg: string; fg: string } {
  const raw = String(rawStatus || "").toLowerCase();
  if (stage === "Cancelled" || raw.includes("cancel")) {
    return { label: "Cancelled", bg: "#33181c", fg: "#f87171" };
  }
  if (raw.includes("picked")) {
    return { label: "Picked up", bg: "#142d22", fg: "#21b975" };
  }
  if (stage === "Needs truck" && !hasCarrier) {
    return { label: "Needs truck", bg: "#2c2216", fg: "#d89b3c" };
  }
  if (stage === "Assigned" || (stage === "Needs truck" && hasCarrier)) {
    return { label: "Assigned", bg: "#18263a", fg: "#6ca0dc" };
  }
  if (stage === "In transit") {
    return { label: "In transit", bg: "#18263a", fg: "#6ca0dc" };
  }
  return { label: "Delivered", bg: "#142d22", fg: "#21b975" };
}

function buildFallbackRateCon(s: OpsShipment): { summaryText: string; printableHtml: string } {
  const totWt = s.commodities.reduce((sum, c) => sum + c.weightTotal, 0);
  const totPcs = s.commodities.reduce((sum, c) => sum + c.piecesTotal, 0);
  const summaryText = [
    `PRIMARY FREIGHT / FIVE NINES — CARRIER RATE CONFIRMATION`,
    `Load #: ${s.id} | Customer PO: ${s.po || "TBD"} | BOL: ${s.bol || "TBD"}`,
    `Carrier: ${s.carrier || "TBD"} ${s.mc ? `(MC ${s.mc})` : ""}`,
    `Equipment: ${s.equip} (${s.trailerSize}) | Weight: ${totWt.toLocaleString()} lbs (${totPcs} pcs)`,
    `Origin: ${s.origin} (PU ${s.shipDate})`,
    `Destination: ${s.dest} (DEL ${s.delivDate})`,
    `All-In Linehaul Pay: $${(s.buy || 0).toLocaleString()}`,
    s.operationalNote
      ? `Special Instructions: ${s.operationalNote}`
      : `Instructions: MacroPoint tracking & signed POD required within 24 hrs of delivery.`,
  ].join("\n");

  const stopsHtml = s.stops
    .map(
      (st, idx) =>
        `<tr><td>${idx + 1}. ${st.stopType}</td><td><strong>${st.companyName}</strong><br/>${st.streetAddress ? `${st.streetAddress}, ` : ""}${st.city}, ${st.state} ${st.zipCode}</td><td>${st.readyDate} (${st.timeOpen}–${st.timeClose})</td></tr>`,
    )
    .join("");

  const printableHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>RateCon #${s.id}</title>
  <style>body{font-family:system-ui,-apple-system,sans-serif;padding:28px;color:#111827;font-size:13px}
  h1{margin:0 0 4px;font-size:20px}table{width:100%;border-collapse:collapse;margin-top:14px}
  th,td{border:1px solid #cbd5e1;padding:8px;text-align:left}th{background:#f1f5f9;font-size:11px;text-transform:uppercase}
  .bar{height:4px;background:linear-gradient(90deg,#12345a 0%,#1768b2 48%,#21b975 82%,#66d9a2 100%);margin-bottom:16px}
  .box{background:#f8fafc;border:1px solid #cbd5e1;padding:12px;border-radius:8px;margin-top:12px}</style></head>
  <body><div class="bar"></div><h1>Carrier Rate Confirmation · Load #${s.id}</h1>
  <div>Five Nines / Primary Freight · PO: <strong>${s.po || "TBD"}</strong> · BOL: <strong>${s.bol || "TBD"}</strong></div>
  <div class="box"><strong>Carrier:</strong> ${s.carrier || "TBD"} ${s.mc ? `(MC ${s.mc})` : ""} &nbsp;|&nbsp;
  <strong>Equipment:</strong> ${s.equip} &nbsp;|&nbsp; <strong>Carrier Linehaul Pay:</strong> $${(s.buy || 0).toLocaleString()}</div>
  <table><thead><tr><th>Stop</th><th>Facility &amp; Address</th><th>Window</th></tr></thead><tbody>${stopsHtml}</tbody></table>
  <div class="box"><strong>Commodity:</strong> ${s.commodities.map((c) => `${c.piecesTotal} ${c.packagingType} ${c.description} (${c.weightTotal.toLocaleString()} lbs)`).join("; ")}<br/>
  <strong>Instructions:</strong> ${s.operationalNote || "Driver must accept MacroPoint tracking and submit clean signed POD upon delivery."}</div>
  <script>window.onload=()=>setTimeout(()=>window.print(),250);</script></body></html>`;

  return { summaryText, printableHtml };
}

export const DispatchBoardView: React.FC<DispatchBoardViewProps> = ({
  shipments,
  carriers,
  expandedId,
  onExpandChange,
  apiCtx,
  onRefresh,
  onToast,
  onUploadPod,
  onOpenBol,
  onOpenDashboardLoad,
  isLiveSync = false,
}) => {
  const [bucket, setBucket] = useState<StageBucket>("All");
  const [busyLoadId, setBusyLoadId] = useState<string | null>(null);

  const [checkStatus, setCheckStatus] = useState<Record<string, string>>({});
  const [checkLocation, setCheckLocation] = useState<Record<string, string>>({});
  const [checkEta, setCheckEta] = useState<Record<string, string>>({});
  const [checkNote, setCheckNote] = useState<Record<string, string>>({});

  const [refPo, setRefPo] = useState<Record<string, string>>({});
  const [refBol, setRefBol] = useState<Record<string, string>>({});
  const [refPro, setRefPro] = useState<Record<string, string>>({});

  const [carrierSel, setCarrierSel] = useState<Record<string, string>>({});
  const [buySel, setBuySel] = useState<Record<string, number>>({});
  const [sellSel, setSellSel] = useState<Record<string, number>>({});

  const localPodInputRef = useRef<HTMLInputElement | null>(null);
  const localPodTargetRef = useRef<string | null>(null);

  const visible = (shipments as LiveOpsShipment[]).filter((s) => {
    const cancelled = isLoadCancelled(s);
    const hasCarrier = Boolean(s.carrier && s.carrier.trim());
    if (bucket === "Cancelled") return cancelled;
    if (cancelled) return false;
    if (bucket === "All") return true;
    if (bucket === "Needs truck") return s.stage === "Needs truck" && !hasCarrier;
    if (bucket === "Assigned") return s.stage === "Assigned" || (s.stage === "Needs truck" && hasCarrier);
    return s.stage === bucket;
  });

  const cycleRateconStatus = async (s: LiveOpsShipment) => {
    const cur = String(s.rateconStatus || "Not Sent").toLowerCase();
    const next = cur === "not sent" || cur === "drafted" ? "Sent" : cur === "sent" ? "Signed" : "Not Sent";
    const { ok, data } = await panelFetchJson<{ ok?: boolean; message?: string }>(
      `/api/loads/${encodeURIComponent(s.id)}/ratecon-status`,
      {
        method: "PATCH",
        body: JSON.stringify({ rateconStatus: next }),
      },
      apiCtx,
    );
    onToast(data.message || `RateCon → ${next} on #${s.id}`, ok && data.ok !== false ? "ok" : "error");
    await onRefresh();
  };

  const submitFullShipmentEdit = async (s: LiveOpsShipment) => {
    setBusyLoadId(s.id);
    try {
      const carrier = carrierSel[s.id] ?? s.carrier;
      const buy = buySel[s.id] ?? s.buy;
      const sell = sellSel[s.id] ?? s.sell;
      const po = refPo[s.id] ?? s.po;
      const bol = refBol[s.id] ?? s.bol;
      const pro = refPro[s.id] ?? s.pro;
      const { ok, data } = await panelFetchJson<{ ok?: boolean; message?: string }>(
        `/api/loads/${encodeURIComponent(s.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            carrier,
            buy,
            sell,
            po,
            bol,
            pro,
            pushToTai: true,
          }),
        },
        apiCtx,
      );
      onToast(data.message || `Saved Load #${s.id} & synced live to TAI`, ok && data.ok !== false ? "ok" : "error");
      await onRefresh();
    } finally {
      setBusyLoadId(null);
    }
  };

  const submitCheckCall = async (s: OpsShipment) => {
    setBusyLoadId(s.id);
    try {
      const statusVal = checkStatus[s.id] ?? (s.stage === "Needs truck" ? "Dispatched" : s.rawStatus || "In Transit");
      const locVal = checkLocation[s.id] ?? s.location;
      const etaVal = checkEta[s.id] ?? "";
      const noteVal = checkNote[s.id] ?? "";
      const { ok, data } = await panelFetchJson<{ ok?: boolean; message?: string }>(
        `/api/loads/${encodeURIComponent(s.id)}/check-call`,
        {
          method: "POST",
          body: JSON.stringify({
            shipmentStatus: statusVal,
            status: statusVal,
            location: locVal,
            deliveryEstimatedDateTime: etaVal || undefined,
            note: noteVal,
          }),
        },
        apiCtx,
      );
      if (!ok || data.ok === false) {
        onToast(data.message || `Check call failed on #${s.id}`, "error");
        return;
      }
      onToast(data.message || `Logged check call on #${s.id} (${statusVal})`, "ok");
      setCheckNote((prev) => ({ ...prev, [s.id]: "" }));
      await onRefresh();
    } finally {
      setBusyLoadId(null);
    }
  };

  const submitReferenceEdits = async (s: OpsShipment) => {
    setBusyLoadId(s.id);
    try {
      const po = refPo[s.id] ?? s.po;
      const bol = refBol[s.id] ?? s.bol;
      const pro = refPro[s.id] ?? s.pro;
      const { ok, data } = await panelFetchJson<{ ok?: boolean; message?: string }>(
        `/api/loads/${encodeURIComponent(s.id)}/references`,
        {
          method: "POST",
          body: JSON.stringify({
            customerPO: po,
            po,
            bolNumber: bol,
            bol,
            proNumber: pro,
            pro,
          }),
        },
        apiCtx,
      );
      if (!ok || data.ok === false) {
        onToast(data.message || `Could not update references on #${s.id}`, "error");
        return;
      }
      onToast(data.message || `Updated references on #${s.id}`, "ok");
      await onRefresh();
    } finally {
      setBusyLoadId(null);
    }
  };

  const submitCarrierWriteback = async (s: OpsShipment) => {
    setBusyLoadId(s.id);
    try {
      const carrierName = carrierSel[s.id] ?? (s.carrier || carriers[0]?.name || "");
      const buyRate = buySel[s.id] ?? (s.buy || Math.max(850, s.sell - 400));
      const { ok, data } = await panelFetchJson<{ ok?: boolean; message?: string }>(
        `/api/loads/${encodeURIComponent(s.id)}/writeback-carrier`,
        {
          method: "POST",
          body: JSON.stringify({ carrierName, buyRate }),
        },
        apiCtx,
      );
      onToast(data.message || `Updated carrier on #${s.id}`, ok && data.ok !== false ? "ok" : "error");
      await onRefresh();
    } finally {
      setBusyLoadId(null);
    }
  };

  const fetchRateConDoc = async (s: OpsShipment) => {
    try {
      const { ok, data } = await panelFetchJson<{
        ok?: boolean;
        summaryText?: string;
        printableHtml?: string;
      }>(`/api/loads/${encodeURIComponent(s.id)}/ratecon`, { method: "GET" }, apiCtx);
      if (ok && data.ok !== false && (data.summaryText || data.printableHtml)) {
        const fb = buildFallbackRateCon(s);
        return {
          summaryText: data.summaryText || fb.summaryText,
          printableHtml: data.printableHtml || fb.printableHtml,
        };
      }
    } catch {
      // Fall back to local RateCon formatter
    }
    return buildFallbackRateCon(s);
  };

  const handlePrintRateCon = async (s: OpsShipment) => {
    const doc = await fetchRateConDoc(s);
    const opened = openPrintableHtmlWindow(`RateCon #${s.id}`, doc.printableHtml);
    onToast(opened ? `Opened printable RateCon for #${s.id}` : "Pop-up blocked — use Insert RateCon into Gmail Reply");
  };

  const handleInsertRateConReply = async (s: OpsShipment) => {
    const doc = await fetchRateConDoc(s);
    const res = await insertGmailReply({
      text: doc.summaryText,
      subject: `Rate Confirmation — Load #${s.id} (${s.origin} to ${s.dest})`,
    });
    onToast(res.message, res.ok ? "ok" : "error");
  };

  const triggerPodUpload = (shipmentId: string) => {
    if (onUploadPod) {
      onUploadPod(shipmentId);
      return;
    }
    localPodTargetRef.current = shipmentId;
    localPodInputRef.current?.click();
  };

  const handleLocalPodFile = async (shipmentId: string, file: File) => {
    const mime = podMimeTypeForFile(file);
    if (!mime) {
      onToast("Only PDF or JPEG POD files are accepted by TAI.", "error");
      return;
    }
    onToast(`Streaming ${file.name} to TAI for #${shipmentId}…`);
    const res = await fetch(
      `/api/loads/${encodeURIComponent(shipmentId)}/pod?fileName=${encodeURIComponent(file.name)}`,
      {
        method: "POST",
        headers: { "Content-Type": mime },
        body: file,
        credentials: "include",
      },
    );
    const out = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
    const verified = res.ok && out.ok === true;
    onToast(
      out.message || (verified ? `POD verified in TAI on #${shipmentId}` : `POD upload failed (HTTP ${res.status})`),
      verified ? "ok" : "error",
    );
    if (verified) await onRefresh();
  };

  const openDashboardForLoad = (shipmentId: string) => {
    if (onOpenDashboardLoad) {
      onOpenDashboardLoad(shipmentId);
      return;
    }
    window.open(`/dispatch?load=${encodeURIComponent(shipmentId)}`, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="space-y-3.5">
      <input
        ref={localPodInputRef}
        type="file"
        accept={POD_FILE_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          const id = localPodTargetRef.current;
          e.target.value = "";
          localPodTargetRef.current = null;
          if (f && id) void handleLocalPodFile(id, f);
        }}
      />

      {/* Dispatch Header matching Screenshot 2 */}
      <div className="flex items-baseline justify-between gap-2">
        <h1 className="text-[20px] font-bold text-white tracking-tight">Dispatch</h1>
        <span className="text-[11px]" style={{ color: "#6e7787" }}>
          {isLiveSync ? "Live TAI sync" : "Sandbox data"}
        </span>
      </div>

      {/* Rounded Pill Filter Row */}
      <div className="flex flex-wrap gap-1.5">
        {STAGE_BUCKETS.map((b) => {
          const active = bucket === b;
          return (
            <button
              key={b}
              type="button"
              onClick={() => setBucket(b)}
              className="px-3.5 py-1.5 rounded-full text-xs font-semibold transition-colors"
              style={
                active
                  ? {
                      background: "rgba(56, 201, 118, 0.14)",
                      color: "#21b975",
                      border: "1px solid rgba(56, 201, 118, 0.55)",
                    }
                  : {
                      background: "#131820",
                      color: "#d1d7e0",
                      border: "1px solid #242c38",
                    }
              }
            >
              {b}
            </button>
          );
        })}
      </div>

      {/* Clean Load Cards */}
      <div className="space-y-2.5">
        {visible.length === 0 ? (
          <div
            className="p-5 rounded-2xl text-center text-xs"
            style={{ background: "#131820", border: "1px solid #222936", color: "#8b95a5" }}
          >
            No shipments in stage &ldquo;{bucket}&rdquo;.
          </div>
        ) : (
          visible.map((s) => {
            const isExp = expandedId === s.id;
            const busy = busyLoadId === s.id;
            const pill = stagePillPalette(s.stage, s.rawStatus, Boolean(s.carrier && s.carrier.trim()));

            return (
              <div
                key={s.id}
                className="rounded-2xl overflow-hidden transition-colors"
                style={{
                  background: "#131820",
                  border: `1px solid ${isExp ? "#21b975" : "#222936"}`,
                }}
              >
                <button
                  type="button"
                  onClick={() => onExpandChange(isExp ? null : s.id)}
                  className="w-full text-left p-4 space-y-2 hover:bg-white/[0.02]"
                >
                  <div className="text-[13.5px] font-bold text-white leading-snug">
                    {s.customer} · {shortCityState(s.origin)} → {shortCityState(s.dest)}{" "}
                    <span className="font-mono font-normal text-[12.5px]" style={{ color: "#8b95a5" }}>
                      ({s.id})
                    </span>
                  </div>

                  <div className="flex items-center justify-between gap-2 flex-wrap text-xs">
                    <span style={{ color: "#8b95a5" }}>Pickup {s.shipDate}</span>

                    <div className="flex items-center gap-2">
                      <span
                        className="px-2 py-0.5 rounded-md text-[10px] font-semibold"
                        style={{
                          background:
                            s.rateconStatus === "Sent" || s.rateconStatus === "Signed"
                              ? "rgba(56,201,118,0.14)"
                              : "rgba(190,45,75,0.16)",
                          color:
                            s.rateconStatus === "Sent" || s.rateconStatus === "Signed" ? "#21b975" : "#f48fb1",
                        }}
                      >
                        RC: {s.rateconStatus || "Not Sent"}
                      </span>
                      <span
                        className="px-2.5 py-0.5 rounded-md text-[11px] font-semibold"
                        style={{ background: pill.bg, color: pill.fg }}
                      >
                        {pill.label}
                      </span>
                      <span
                        className="text-xs font-semibold truncate max-w-[140px]"
                        style={{ color: s.carrier ? "#f3f5f8" : "#d89b3c" }}
                      >
                        {s.carrier || "Needs carrier"}
                      </span>
                    </div>
                  </div>
                </button>

                {/* Inline Operational Drawer */}
                {isExp && (
                  <div
                    className="p-3.5 space-y-3 text-xs"
                    style={{ background: "#0f141b", borderTop: "1px solid #222936" }}
                  >
                    <div
                      className="p-2.5 rounded-xl text-[11px] space-y-1"
                      style={{ background: "#131820", border: "1px solid #222936" }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1 font-medium text-slate-200">
                          <MapPin size={11} style={{ color: "#6ca0dc" }} /> {s.location}
                        </span>
                        <button
                          type="button"
                          onClick={() => openDashboardForLoad(s.id)}
                          className="inline-flex items-center gap-1 text-[11px] font-semibold underline shrink-0"
                          style={{ color: "#21b975" }}
                        >
                          <ExternalLink size={11} /> Open in Dashboard
                        </button>
                      </div>
                      <div className="flex items-center justify-between gap-2 pt-0.5">
                        <span className="font-mono text-[10px]" style={{ color: "#8b95a5" }}>
                          Sell ${s.sell.toLocaleString()} · Buy ${s.buy.toLocaleString()} · {s.writebackState}
                        </span>
                        <button
                          type="button"
                          onClick={() => void cycleRateconStatus(s)}
                          className="px-2 py-0.5 rounded text-[10px] font-semibold shrink-0"
                          style={{ background: "#181f2a", border: "1px solid #262f3d", color: "#21b975" }}
                        >
                          RateCon: {s.rateconStatus || "Not Sent"} ↻
                        </button>
                      </div>
                    </div>

                    {/* Quick Document Actions */}
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => void handleInsertRateConReply(s)}
                        className="py-2 px-2.5 rounded-xl text-[11px] font-bold inline-flex items-center justify-center gap-1.5"
                        style={{ background: "#21b975", color: "#07130c" }}
                      >
                        <Reply size={12} /> RateCon → Gmail
                      </button>

                      <button
                        type="button"
                        onClick={() => void handlePrintRateCon(s)}
                        className="py-2 px-2.5 rounded-xl text-[11px] font-semibold inline-flex items-center justify-center gap-1.5"
                        style={{ background: "#161c26", border: "1px solid #262f3d", color: "#f3f5f8" }}
                      >
                        <Printer size={12} /> Print RateCon
                      </button>

                      <button
                        type="button"
                        onClick={() => triggerPodUpload(s.id)}
                        className="py-2 px-2.5 rounded-xl text-[11px] font-semibold inline-flex items-center justify-center gap-1.5"
                        style={{
                          background: s.podCount > 0 ? "rgba(56,201,118,0.14)" : "#161c26",
                          color: s.podCount > 0 ? "#21b975" : "#f3f5f8",
                          border: "1px solid #262f3d",
                        }}
                      >
                        {s.podCount > 0 ? <CheckCircle2 size={12} /> : <Upload size={12} />}
                        {s.podCount > 0 ? `POD (${s.podCount})` : "Upload POD"}
                      </button>

                      <button
                        type="button"
                        onClick={() => onOpenBol(s.id)}
                        className="py-2 px-2.5 rounded-xl text-[11px] font-semibold inline-flex items-center justify-center gap-1.5"
                        style={{ background: "#161c26", border: "1px solid #262f3d", color: "#f3f5f8" }}
                      >
                        <FileText size={12} /> BOL Sheet
                      </button>
                    </div>

                    {/* Inline Check Calls Form */}
                    <div
                      className="p-2.5 rounded-xl space-y-2"
                      style={{ background: "#131820", border: "1px solid #222936" }}
                    >
                      <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "#8b95a5" }}>
                        Check Call &amp; Tracking
                      </div>
                      <div className="grid grid-cols-12 gap-1.5">
                        <select
                          value={checkStatus[s.id] ?? (s.rawStatus || "In Transit")}
                          onChange={(e) => setCheckStatus({ ...checkStatus, [s.id]: e.target.value })}
                          className="pf-input col-span-5 text-[11px]"
                        >
                          <option value="Committed">Needs Truck</option>
                          <option value="Dispatched">Dispatched</option>
                          <option value="In Transit">In Transit</option>
                          <option value="Delivered">Delivered</option>
                          <option value="Canceled">Canceled</option>
                        </select>
                        <input
                          value={checkLocation[s.id] ?? s.location}
                          onChange={(e) => setCheckLocation({ ...checkLocation, [s.id]: e.target.value })}
                          placeholder="Current City, ST / GPS…"
                          className="pf-input col-span-7 text-[11px]"
                        />
                      </div>
                      <div className="grid grid-cols-12 gap-1.5">
                        <input
                          type="datetime-local"
                          value={checkEta[s.id] ?? ""}
                          onChange={(e) => setCheckEta({ ...checkEta, [s.id]: e.target.value })}
                          className="pf-input col-span-5 font-mono text-[10px]"
                        />
                        <input
                          value={checkNote[s.id] ?? ""}
                          onChange={(e) => setCheckNote({ ...checkNote, [s.id]: e.target.value })}
                          placeholder="Driver check-call / ETA note…"
                          className="pf-input col-span-7 text-[11px]"
                        />
                      </div>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void submitCheckCall(s)}
                        className="w-full py-1.5 rounded-xl text-[11px] font-bold"
                        style={{ background: "#21b975", color: "#07130c" }}
                      >
                        {busy ? "Saving…" : "Log Check Call"}
                      </button>
                    </div>

                    {/* Carrier, Sell & Buy Live Edit (PATCH /api/loads/:id) */}
                    <div
                      className="p-2.5 rounded-xl space-y-2"
                      style={{ background: "#131820", border: "1px solid #222936" }}
                    >
                      <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "#8b95a5" }}>
                        Edit Carrier, Sell &amp; Buy (Live TAI Sync)
                      </div>
                      <select
                        value={carrierSel[s.id] ?? (s.carrier || "")}
                        onChange={(e) => setCarrierSel({ ...carrierSel, [s.id]: e.target.value })}
                        className="pf-input text-[11px]"
                      >
                        <option value="">— Unassigned —</option>
                        {carriers.slice(0, 200).map((c) => (
                          <option key={`${c.name}-${c.taiMasterId || c.mc}`} value={c.name}>
                            {c.name} {c.mc ? `(MC ${c.mc})` : ""}
                          </option>
                        ))}
                      </select>
                      <div className="grid grid-cols-12 gap-1.5 items-center">
                        <input
                          type="number"
                          value={sellSel[s.id] ?? s.sell}
                          onChange={(e) => setSellSel({ ...sellSel, [s.id]: Number(e.target.value) || 0 })}
                          placeholder="Sell $"
                          title="Customer Sell ($)"
                          className="pf-input col-span-4 font-mono font-bold text-[11px]"
                        />
                        <input
                          type="number"
                          value={buySel[s.id] ?? s.buy}
                          onChange={(e) => setBuySel({ ...buySel, [s.id]: Number(e.target.value) || 0 })}
                          placeholder="Buy $"
                          title="Carrier Buy ($)"
                          className="pf-input col-span-4 font-mono font-bold text-[11px]"
                        />
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void submitFullShipmentEdit(s)}
                          className="col-span-4 py-1.5 rounded-lg text-[10.5px] font-bold"
                          style={{ background: "#21b975", color: "#07130c" }}
                        >
                          Save &amp; Sync
                        </button>
                      </div>
                    </div>

                    {/* Inline Reference Edits */}
                    <div
                      className="p-2.5 rounded-xl space-y-2"
                      style={{ background: "#131820", border: "1px solid #222936" }}
                    >
                      <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "#8b95a5" }}>
                        References (PO · BOL · PRO)
                      </div>
                      <div className="grid grid-cols-12 gap-1.5">
                        <input
                          value={refPo[s.id] ?? s.po}
                          onChange={(e) => setRefPo({ ...refPo, [s.id]: e.target.value })}
                          placeholder="PO #"
                          className="pf-input col-span-4 font-mono text-[11px]"
                        />
                        <input
                          value={refBol[s.id] ?? s.bol}
                          onChange={(e) => setRefBol({ ...refBol, [s.id]: e.target.value })}
                          placeholder="BOL #"
                          className="pf-input col-span-4 font-mono text-[11px]"
                        />
                        <input
                          value={refPro[s.id] ?? s.pro}
                          onChange={(e) => setRefPro({ ...refPro, [s.id]: e.target.value })}
                          placeholder="PRO #"
                          className="pf-input col-span-3 font-mono text-[11px]"
                        />
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void submitReferenceEdits(s)}
                          className="col-span-1 rounded-lg flex items-center justify-center"
                          style={{ background: "#161c26", border: "1px solid #262f3d" }}
                          title="Save references"
                        >
                          <Save size={12} />
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
