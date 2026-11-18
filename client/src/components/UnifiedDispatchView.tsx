import React, { useCallback, useEffect, useMemo, useState } from "react";
import { isHiddenCustomer, type CarrierOption, type OpsShipment } from "@shared/tai-webhook-schema";
import {
  ArrowUpDown,
  ArrowUpRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  Pencil,
  Printer,
  RefreshCw,
  Reply,
  Search,
  Trash2,
  Truck,
  Upload,
  X,
} from "lucide-react";
import { insertGmailReply } from "./panel/extensionBridge";
import { openPrintableHtmlWindow, type LiveOpsShipment } from "./panel/panelTypes";

export interface UnifiedDispatchViewProps {
  shipments: OpsShipment[];
  carriers: CarrierOption[];
  searchQuery: string;
  expandedLoadId: string | null;
  onToggleExpand: (id: string) => void;
  onAssignCarrier: (shipmentId: string, carrierName: string, buyRate: number) => Promise<void>;
  /** Opens a file picker; the chosen PDF/JPEG is streamed through the server to TAI and verified by read-back. */
  onUploadPod: (shipmentId: string) => void;
  onSaveNote: (
    shipmentId: string,
    payload: { note?: string; pastedEmailText?: string; containerNumber?: string },
  ) => Promise<void>;
  onDeleteLoad: (shipmentId: string) => Promise<void>;
  onAskAi: (question: string) => void;
  onRefreshBootstrap?: () => Promise<void>;
  counts?: {
    totalShipments?: number;
    uncoveredCommitted?: number;
    coveredCommitted?: number;
    dispatched?: number;
    inTransit?: number;
    delivered?: number;
    cancelled?: number;
  } | null;
}

type FilterTabId =
  | "All"
  | "Needs Truck"
  | "Committed (Covered)"
  | "Dispatched"
  | "In Transit"
  | "Delivered"
  | "Cancelled";

type SortColumn = "shipDate" | "customerName" | "carrierName" | "sell" | "buy" | "margin";

const FILTER_TABS: FilterTabId[] = [
  "All",
  "Needs Truck",
  "Committed (Covered)",
  "Dispatched",
  "In Transit",
  "Delivered",
  "Cancelled",
];

function isRowCancelled(s: LiveOpsShipment): boolean {
  return (
    s.stage === "Cancelled" ||
    /cancel/i.test(String(s.rawStatus || "")) ||
    /cancel/i.test(String(s.taiRawStatus || ""))
  );
}

function isRowCovered(s: LiveOpsShipment): boolean {
  return Boolean(s.carrier && s.carrier.trim().length > 0);
}

function canonicalDisplayStatus(s: LiveOpsShipment): string {
  if (isRowCancelled(s)) return "Cancelled";
  const raw = String(s.rawStatus || "").trim();
  if (/deliver|complete|invoiced/i.test(raw) || s.stage === "Delivered") return "Delivered";
  if (/in\s*transit|picked|loaded|out\s*for/i.test(raw) || s.stage === "In transit") return "In Transit";
  if (/dispatch/i.test(raw)) return "Dispatched";
  if (/quote/i.test(raw)) return "Quote";
  if (isRowCovered(s) || s.stage === "Assigned") return "Assigned";
  return "Committed";
}

function matchesClientTab(s: LiveOpsShipment, tab: FilterTabId, viewMode: "all" | "active"): boolean {
  const cancelled = isRowCancelled(s);
  const status = canonicalDisplayStatus(s);
  const covered = isRowCovered(s);

  if (viewMode === "active" && (cancelled || status === "Delivered")) {
    if (tab === "All") return false;
  }

  switch (tab) {
    case "All":
      return true;
    case "Needs Truck":
      return !cancelled && status !== "Delivered" && status !== "In Transit" && status !== "Dispatched" && !covered;
    case "Committed (Covered)":
      return !cancelled && (status === "Assigned" || status === "Committed") && covered;
    case "Dispatched":
      return !cancelled && status === "Dispatched";
    case "In Transit":
      return !cancelled && status === "In Transit";
    case "Delivered":
      return !cancelled && status === "Delivered";
    case "Cancelled":
      return cancelled;
  }
}

function formatLaneUpper(origin: string, dest: string, stops?: LiveOpsShipment["stops"]): string {
  const cleanPart = (raw: string, fallbackCity?: string, fallbackState?: string) => {
    if (fallbackCity && fallbackState) {
      return `${fallbackCity.trim().toUpperCase()}, ${fallbackState.trim().toUpperCase()}`;
    }
    return String(raw || "TBD")
      .replace(/\s+\d{5}(-\d{4})?\b/g, "")
      .trim()
      .toUpperCase();
  };
  const first = stops?.[0];
  const last = stops && stops.length > 1 ? stops[stops.length - 1] : undefined;
  return `${cleanPart(origin, first?.city, first?.state)} → ${cleanPart(dest, last?.city, last?.state)}`;
}

function parseCityStatePair(raw: string, stop?: { city?: string; state?: string }): { city: string; state: string } {
  if (stop?.city || stop?.state) {
    return { city: stop.city || "", state: stop.state || "" };
  }
  const clean = String(raw || "").replace(/\s+\d{5}(-\d{4})?\b/g, "").trim();
  const parts = clean.split(",");
  return {
    city: (parts[0] || "").trim(),
    state: (parts[1] || "").trim().slice(0, 2).toUpperCase(),
  };
}

function statusPillStyle(statusLabel: string): React.CSSProperties {
  switch (statusLabel) {
    case "Committed":
      return {
        background: "var(--pf-warning-dim)",
        color: "var(--pf-warning)",
        border: "1px solid var(--pf-warning)",
      };
    case "Assigned":
    case "Dispatched":
      return {
        background: "var(--pf-info-dim)",
        color: "var(--pf-info)",
        border: "1px solid var(--pf-info)",
      };
    case "In Transit":
      return {
        background: "var(--pf-primary-dim)",
        color: "var(--pf-primary)",
        border: "1px solid var(--pf-primary)",
      };
    case "Delivered":
      return {
        background: "var(--pf-primary-dim)",
        color: "var(--pf-primary)",
        border: "1px solid var(--pf-border)",
      };
    case "Cancelled":
      return {
        background: "var(--pf-danger-dim)",
        color: "var(--pf-danger)",
        border: "1px solid var(--pf-danger)",
      };
    default:
      return {
        background: "var(--pf-surface-raised)",
        color: "var(--pf-text-muted)",
        border: "1px solid var(--pf-border)",
      };
  }
}

function nextRateconStatus(current: string): "Not Sent" | "Sent" | "Signed" {
  const norm = String(current || "Not Sent").toLowerCase();
  if (norm === "not sent" || norm === "drafted") return "Sent";
  if (norm === "sent") return "Signed";
  return "Not Sent";
}

function rateconBadgeConfig(status: string): { text: string; style: React.CSSProperties } {
  const norm = String(status || "Not Sent").toLowerCase();
  if (norm === "signed") {
    return {
      text: "✓ Signed",
      style: {
        background: "var(--pf-primary-dim)",
        color: "var(--pf-primary)",
        border: "1px solid var(--pf-primary)",
      },
    };
  }
  if (norm === "sent") {
    return {
      text: "✓ Sent",
      style: {
        background: "var(--pf-primary-dim)",
        color: "var(--pf-primary)",
        border: "1px solid var(--pf-border)",
      },
    };
  }
  if (norm === "drafted") {
    return {
      text: "Drafted",
      style: {
        background: "var(--pf-warning-dim)",
        color: "var(--pf-warning)",
        border: "1px solid var(--pf-warning)",
      },
    };
  }
  return {
    text: "○ Not Sent",
    style: {
      background: "var(--pf-danger-dim)",
      color: "var(--pf-danger)",
      border: "1px solid var(--pf-border)",
    },
  };
}

function buildFallbackRateConDoc(s: LiveOpsShipment): { summaryText: string; printableHtml: string } {
  const summaryText = [
    `PRIMARY FREIGHT / FIVE NINES — CARRIER RATE CONFIRMATION`,
    `Load #: ${s.id} | Customer PO: ${s.po || "TBD"} | BOL: ${s.bol || "TBD"}`,
    `Carrier: ${s.carrier || "TBD"} ${s.mc ? `(MC ${s.mc})` : ""}`,
    `Equipment: ${s.equip || "FTL"} | Ship Date: ${s.shipDate || "TBD"}`,
    `Lane: ${formatLaneUpper(s.origin, s.dest, s.stops)}`,
    `Carrier Linehaul Pay: $${(Number(s.buy) || 0).toLocaleString()}`,
    s.operationalNote
      ? `Instructions: ${s.operationalNote}`
      : `Instructions: MacroPoint tracking & clean signed POD required within 24 hrs of delivery.`,
  ].join("\n");

  const printableHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>RateCon #${s.id}</title>
  <style>body{font-family:system-ui,-apple-system,sans-serif;padding:28px;color:#12345a;font-size:13px}
  .bar{height:4px;background:linear-gradient(90deg,#12345a 0%,#1768b2 48%,#21b975 82%,#66d9a2 100%);margin-bottom:16px}
  .box{border:1px solid #dce5ee;padding:12px;border-radius:8px;margin-top:12px;background:#f7f9fc}</style></head>
  <body><div class="bar"></div><h2>Carrier Rate Confirmation · Load #${s.id}</h2>
  <div>Customer PO: <strong>${s.po || "—"}</strong> · BOL: <strong>${s.bol || "—"}</strong> · Ship Date: <strong>${s.shipDate || "TBD"}</strong></div>
  <div class="box"><strong>Carrier:</strong> ${s.carrier || "Unassigned"} ${s.mc ? `(MC ${s.mc})` : ""}<br/>
  <strong>Lane:</strong> ${formatLaneUpper(s.origin, s.dest, s.stops)}<br/>
  <strong>Equipment:</strong> ${s.equip || "FTL"} &nbsp;|&nbsp; <strong>All-In Carrier Pay:</strong> $${(Number(s.buy) || 0).toLocaleString()}</div>
  <div class="box"><strong>Instructions:</strong> ${s.operationalNote || "Driver must accept MacroPoint tracking and submit signed POD upon delivery."}</div>
  <script>window.onload=()=>setTimeout(()=>window.print(),250);</script></body></html>`;

  return { summaryText, printableHtml };
}

interface EditModalDraft {
  customer: string;
  status: string;
  rateconStatus: string;
  shipDate: string;
  delivDate: string;
  originCity: string;
  originState: string;
  destCity: string;
  destState: string;
  equip: string;
  carrier: string;
  sell: number;
  buy: number;
  po: string;
  bol: string;
  pro: string;
  currentLocation: string;
  driverPhone: string;
  operationalNote: string;
  pushToTai: boolean;
}

export const UnifiedDispatchView: React.FC<UnifiedDispatchViewProps> = ({
  shipments,
  carriers,
  searchQuery,
  onUploadPod,
  onDeleteLoad,
  onRefreshBootstrap,
  counts,
}) => {
  const [viewMode, setViewMode] = useState<"all" | "active">("all");
  const [activeTab, setActiveTab] = useState<FilterTabId>("All");
  const [localSearch, setLocalSearch] = useState<string>("");
  const [sortBy, setSortBy] = useState<SortColumn>("shipDate");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState<number>(1);
  const pageSize = 100;

  const [serverRows, setServerRows] = useState<LiveOpsShipment[] | null>(null);
  const [serverTotal, setServerTotal] = useState<number | null>(null);
  const [serverStatusCounts, setServerStatusCounts] = useState<Record<string, number>>({});
  const [loadingPage, setLoadingPage] = useState<boolean>(false);
  const [taiBaseUrl, setTaiBaseUrl] = useState<string>("");

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [statusFeedback, setStatusFeedback] = useState<{ msg: string; kind: "ok" | "error" } | null>(null);

  // Modals: Match Carrier, Send RateCon, Full Edit Shipment, Delete Confirm
  const [matchCarrierLoad, setMatchCarrierLoad] = useState<LiveOpsShipment | null>(null);
  const [matchCarrierQuery, setMatchCarrierQuery] = useState<string>("");
  const [matchCarrierSelected, setMatchCarrierSelected] = useState<string>("");
  const [matchCarrierBuy, setMatchCarrierBuy] = useState<number>(0);
  const [matchSaving, setMatchSaving] = useState<boolean>(false);

  const [rateconLoad, setRateconLoad] = useState<LiveOpsShipment | null>(null);
  const [rateconDoc, setRateconDoc] = useState<{ summaryText: string; printableHtml: string } | null>(null);
  const [rateconLoading, setRateconLoading] = useState<boolean>(false);

  const [editingLoad, setEditingLoad] = useState<LiveOpsShipment | null>(null);
  const [editDraft, setEditDraft] = useState<EditModalDraft | null>(null);
  const [editSaving, setEditSaving] = useState<boolean>(false);

  const [confirmDeleteLoad, setConfirmDeleteLoad] = useState<LiveOpsShipment | null>(null);

  const effectiveSearch = (localSearch || searchQuery).trim();

  const notify = (msg: string, kind: "ok" | "error" = "ok") => {
    setStatusFeedback({ msg, kind });
  };

  const [syncingInvoices, setSyncingInvoices] = useState<boolean>(false);

  const handleSyncTaiInvoices = async () => {
    setSyncingInvoices(true);
    try {
      const pageShipmentIds = (rowsToRender || []).map((r) => r.id).filter((id) => /^\d+$/.test(id));
      const res = await fetch("/api/tai/invoices/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          shipmentIds: pageShipmentIds.length > 0 ? pageShipmentIds : undefined,
          limit: 30,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; message?: string; synced?: number };
      notify(data.message || "Synced live invoices from TAI Accounting API.", data.ok ? "ok" : "error");
      await Promise.all([fetchServerLoads(), onRefreshBootstrap?.()]);
    } catch {
      notify("Failed to sync TAI invoices.", "error");
    } finally {
      setSyncingInvoices(false);
    }
  };

  const handleSyncSingleInvoice = async (shipmentId: string) => {
    try {
      const res = await fetch(`/api/loads/${shipmentId}/sync-invoice`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      notify(data.message || `Synced invoice for #${shipmentId}`, data.ok ? "ok" : "error");
      await Promise.all([fetchServerLoads(), onRefreshBootstrap?.()]);
    } catch {
      notify(`Failed to sync invoice for #${shipmentId}`, "error");
    }
  };

  useEffect(() => {
    fetch("/api/tai/booking/status", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { baseUrl?: string } | null) => {
        if (d?.baseUrl) setTaiBaseUrl(d.baseUrl.replace(/\/+$/, ""));
      })
      .catch(() => {});
  }, []);

  const fetchServerLoads = useCallback(async () => {
    setLoadingPage(true);
    try {
      const statusParam =
        activeTab === "All"
          ? ""
          : activeTab === "Needs Truck"
          ? "Needs truck"
          : activeTab === "Committed (Covered)"
          ? "Committed (Covered)"
          : activeTab;

      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        view: viewMode,
        sortBy,
        sortDir,
      });
      if (statusParam) params.set("status", statusParam);
      if (effectiveSearch) params.set("search", effectiveSearch);

      const res = await fetch(`/api/loads?${params.toString()}`, { credentials: "include" });
      if (!res.ok) {
        setServerRows(null);
        return;
      }
      const data = (await res.json()) as {
        ok?: boolean;
        items?: LiveOpsShipment[];
        shipments?: LiveOpsShipment[];
        total?: number;
        statusCounts?: Record<string, number>;
        counts?: Record<string, number>;
      };
      const items = data.items || data.shipments;
      if (data.ok !== false && Array.isArray(items)) {
        const nonHidden = items.filter((r) => !isHiddenCustomer(r.customer));
        // Defensive guard: never allow covered or cancelled loads under "Needs Truck"
        const guarded =
          activeTab === "Needs Truck"
            ? nonHidden.filter((r) => !isRowCancelled(r) && !isRowCovered(r))
            : activeTab === "Committed (Covered)"
            ? nonHidden.filter((r) => !isRowCancelled(r) && isRowCovered(r))
            : nonHidden;
        setServerRows(guarded);
        setServerTotal(typeof data.total === "number" ? data.total : guarded.length);
        const countsObj = data.statusCounts || data.counts;
        if (countsObj && typeof countsObj === "object") {
          setServerStatusCounts(countsObj);
        }
      }
    } catch {
      setServerRows(null);
    } finally {
      setLoadingPage(false);
    }
  }, [page, pageSize, viewMode, activeTab, effectiveSearch, sortBy, sortDir]);

  useEffect(() => {
    void fetchServerLoads();
  }, [fetchServerLoads, shipments]);

  // Reset to page 1 when filters/search change
  useEffect(() => {
    setPage(1);
  }, [viewMode, activeTab, effectiveSearch, sortBy, sortDir]);

  // Fallback client-side filtering & sorting while server page loads or in offline mode
  const fallbackRows = useMemo(() => {
    const base = (shipments as LiveOpsShipment[]).filter((s) => {
      if (isHiddenCustomer(s.customer)) return false;
      if (!matchesClientTab(s, activeTab, viewMode)) return false;
      if (!effectiveSearch) return true;
      const q = effectiveSearch.toLowerCase();
      return `${s.id} ${s.customer} ${s.origin} ${s.dest} ${s.carrier} ${s.po} ${s.bol} ${s.pro} ${s.containerNumber || ""}`
        .toLowerCase()
        .includes(q);
    });

    const dir = sortDir === "asc" ? 1 : -1;
    return [...base].sort((a, b) => {
      if (sortBy === "customerName") return a.customer.localeCompare(b.customer) * dir;
      if (sortBy === "carrierName") return (a.carrier || "").localeCompare(b.carrier || "") * dir;
      if (sortBy === "sell") return ((a.sell || 0) - (b.sell || 0)) * dir;
      if (sortBy === "buy") return ((a.buy || 0) - (b.buy || 0)) * dir;
      if (sortBy === "margin") return ((a.sell - a.buy) - (b.sell - b.buy)) * dir;
      const da = a.shipDateIso || a.stops?.[0]?.readyDate || a.shipDate || "";
      const db = b.shipDateIso || b.stops?.[0]?.readyDate || b.shipDate || "";
      return da.localeCompare(db) * dir;
    });
  }, [shipments, activeTab, viewMode, effectiveSearch, sortBy, sortDir]);

  const rowsToRender = serverRows !== null ? serverRows : fallbackRows.slice((page - 1) * pageSize, page * pageSize);
  const totalCount =
    serverTotal !== null
      ? serverTotal
      : activeTab === "All" && !effectiveSearch && counts?.totalShipments
      ? counts.totalShipments
      : fallbackRows.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  const tabCount = (tab: FilterTabId): number => {
    const sc = serverStatusCounts;
    if (tab === "All") {
      return sc.All ?? sc.all ?? sc.total ?? counts?.totalShipments ?? shipments.length;
    }
    if (tab === "Needs Truck") {
      return (
        sc["Needs Truck"] ??
        sc["Needs truck"] ??
        sc.uncoveredCommitted ??
        counts?.uncoveredCommitted ??
        (shipments as LiveOpsShipment[]).filter((s) => matchesClientTab(s, "Needs Truck", "all")).length
      );
    }
    if (tab === "Committed (Covered)") {
      return (
        sc["Committed (Covered)"] ??
        sc.coveredCommitted ??
        sc.Assigned ??
        counts?.coveredCommitted ??
        (shipments as LiveOpsShipment[]).filter((s) => matchesClientTab(s, "Committed (Covered)", "all")).length
      );
    }
    if (tab === "Dispatched") {
      return (
        sc.Dispatched ??
        sc.dispatched ??
        counts?.dispatched ??
        (shipments as LiveOpsShipment[]).filter((s) => matchesClientTab(s, "Dispatched", "all")).length
      );
    }
    if (tab === "In Transit") {
      return (
        sc["In Transit"] ??
        sc["In transit"] ??
        sc.inTransit ??
        counts?.inTransit ??
        (shipments as LiveOpsShipment[]).filter((s) => matchesClientTab(s, "In Transit", "all")).length
      );
    }
    if (tab === "Delivered") {
      return (
        sc.Delivered ??
        sc.delivered ??
        counts?.delivered ??
        (shipments as LiveOpsShipment[]).filter((s) => matchesClientTab(s, "Delivered", "all")).length
      );
    }
    return (
      sc.Cancelled ??
      sc.cancelled ??
      counts?.cancelled ??
      (shipments as LiveOpsShipment[]).filter((s) => isRowCancelled(s)).length
    );
  };

  const toggleSort = (col: SortColumn) => {
    if (sortBy === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(col);
      setSortDir(col === "customerName" || col === "carrierName" ? "asc" : "desc");
    }
  };

  const handleCycleRatecon = async (s: LiveOpsShipment) => {
    const nextStatus = nextRateconStatus(s.rateconStatus);
    try {
      const res = await fetch(`/api/loads/${encodeURIComponent(s.id)}/ratecon-status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ rateconStatus: nextStatus }),
      });
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (!res.ok || out.ok === false) {
        notify(out.message || `Could not update RateCon status on #${s.id}`, "error");
        return;
      }
      notify(out.message || `Load #${s.id} RateCon → ${nextStatus}`);
      await Promise.all([fetchServerLoads(), onRefreshBootstrap?.()]);
    } catch {
      notify(`Network error updating RateCon status on #${s.id}`, "error");
    }
  };

  const openEditModal = (s: LiveOpsShipment) => {
    const orig = parseCityStatePair(s.origin, s.stops?.[0]);
    const dest = parseCityStatePair(s.dest, s.stops && s.stops.length > 1 ? s.stops[s.stops.length - 1] : undefined);
    const isoShip = s.shipDateIso || s.stops?.[0]?.readyDate || "";
    const isoDeliv =
      s.delivDateIso || (s.stops && s.stops.length > 1 ? s.stops[s.stops.length - 1]?.readyDate : "") || "";

    const rawEditStatus = canonicalDisplayStatus(s);
    setEditingLoad(s);
    setEditDraft({
      customer: s.customer || "",
      status: rawEditStatus === "Assigned" ? "Committed" : rawEditStatus,
      rateconStatus: s.rateconStatus || "Not Sent",
      shipDate: /^\d{4}-\d{2}-\d{2}$/.test(isoShip) ? isoShip : "",
      delivDate: /^\d{4}-\d{2}-\d{2}$/.test(isoDeliv) ? isoDeliv : "",
      originCity: orig.city,
      originState: orig.state,
      destCity: dest.city,
      destState: dest.state,
      equip: s.equip || "53 ft Van | Dry",
      carrier: s.carrier || "",
      sell: Number(s.sell) || 0,
      buy: Number(s.buy) || 0,
      po: s.po || "",
      bol: s.bol || "",
      pro: s.pro || "",
      currentLocation: s.currentLocation || s.location || "",
      driverPhone: s.driverPhone || "",
      operationalNote: s.operationalNote || "",
      pushToTai: true,
    });
  };

  const submitEditModal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingLoad || !editDraft) return;
    setEditSaving(true);
    try {
      const res = await fetch(`/api/loads/${encodeURIComponent(editingLoad.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(editDraft),
      });
      const out = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        taiWriteback?: unknown;
      };
      if (!res.ok || out.ok === false) {
        notify(out.message || `Failed updating Load #${editingLoad.id}`, "error");
        return;
      }
      notify(out.message || `Saved Load #${editingLoad.id}${editDraft.pushToTai ? " & pushed live to TAI" : ""}`, "ok");
      setEditingLoad(null);
      setEditDraft(null);
      await Promise.all([fetchServerLoads(), onRefreshBootstrap?.()]);
    } finally {
      setEditSaving(false);
    }
  };

  const openMatchCarrierModal = (s: LiveOpsShipment) => {
    setMatchCarrierLoad(s);
    setMatchCarrierQuery("");
    setMatchCarrierSelected(s.carrier || "");
    setMatchCarrierBuy(s.buy > 0 ? s.buy : s.sell > 0 ? Math.max(600, Math.round(s.sell * 0.82)) : 0);
  };

  const laneRunnerSuggestions = useMemo(() => {
    if (!matchCarrierLoad) return [];
    const orig = parseCityStatePair(matchCarrierLoad.origin, matchCarrierLoad.stops?.[0]);
    const dest = parseCityStatePair(
      matchCarrierLoad.dest,
      matchCarrierLoad.stops && matchCarrierLoad.stops.length > 1
        ? matchCarrierLoad.stops[matchCarrierLoad.stops.length - 1]
        : undefined,
    );
    const countsByCarrier = new Map<string, { name: string; count: number; totalBuy: number }>();
    for (const sh of shipments) {
      if (!sh.carrier?.trim()) continue;
      const so = parseCityStatePair(sh.origin, sh.stops?.[0]);
      const sd = parseCityStatePair(
        sh.dest,
        sh.stops && sh.stops.length > 1 ? sh.stops[sh.stops.length - 1] : undefined,
      );
      if (orig.state && dest.state && so.state === orig.state && sd.state === dest.state) {
        const key = sh.carrier.trim().toUpperCase();
        const cur = countsByCarrier.get(key) || { name: sh.carrier.trim(), count: 0, totalBuy: 0 };
        cur.count += 1;
        cur.totalBuy += Number(sh.buy) || 0;
        countsByCarrier.set(key, cur);
      }
    }
    return [...countsByCarrier.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map((item) => ({
        name: item.name,
        runs: item.count,
        avgBuy: item.count > 0 ? Math.round(item.totalBuy / item.count) : 0,
      }));
  }, [matchCarrierLoad, shipments]);

  const filteredCarriers = useMemo(() => {
    const q = matchCarrierQuery.trim().toLowerCase();
    if (!q) return carriers.slice(0, 40);
    return carriers
      .filter((c) => `${c.name} ${c.mc} ${c.dot} ${c.scac}`.toLowerCase().includes(q))
      .slice(0, 50);
  }, [carriers, matchCarrierQuery]);

  const submitMatchCarrier = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!matchCarrierLoad || !matchCarrierSelected.trim()) return;
    setMatchSaving(true);
    try {
      const res = await fetch(`/api/loads/${encodeURIComponent(matchCarrierLoad.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          carrier: matchCarrierSelected.trim(),
          buy: Number(matchCarrierBuy) || 0,
          pushToTai: true,
        }),
      });
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (!res.ok || out.ok === false) {
        notify(out.message || `Could not assign carrier on #${matchCarrierLoad.id}`, "error");
        return;
      }
      notify(out.message || `Assigned ${matchCarrierSelected} on Load #${matchCarrierLoad.id}`, "ok");
      setMatchCarrierLoad(null);
      await Promise.all([fetchServerLoads(), onRefreshBootstrap?.()]);
    } finally {
      setMatchSaving(false);
    }
  };

  const openRateConModal = async (s: LiveOpsShipment) => {
    setRateconLoad(s);
    setRateconLoading(true);
    setRateconDoc(buildFallbackRateConDoc(s));
    try {
      const res = await fetch(`/api/loads/${encodeURIComponent(s.id)}/ratecon`, { credentials: "include" });
      if (res.ok) {
        const data = (await res.json()) as { summaryText?: string; printableHtml?: string };
        const fb = buildFallbackRateConDoc(s);
        setRateconDoc({
          summaryText: data.summaryText || fb.summaryText,
          printableHtml: data.printableHtml || fb.printableHtml,
        });
      }
    } catch {
      // Keep clean local RateCon preview
    } finally {
      setRateconLoading(false);
    }
  };

  const handleShipmentIdClick = (s: LiveOpsShipment) => {
    if (taiBaseUrl && /^\d+$/.test(s.id)) {
      window.open(`${taiBaseUrl}/ezView/ShipmentSummary.aspx?id=${encodeURIComponent(s.id)}`, "_blank", "noopener,noreferrer");
      return;
    }
    openEditModal(s);
  };

  return (
    <div className="space-y-4">
      {/* Five Nines Masthead Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--pf-action)" }}>
            Live TAI &amp; Supabase Directory · Direct Write-Back Enabled
          </div>
          <h1 className="text-xl font-semibold tracking-tight mt-0.5">Unified Dispatch &amp; All Loads</h1>
        </div>

        {/* Active/All Toggle + Search + Sort + Refresh + Pagination */}
        <div className="flex items-center gap-2 flex-wrap">
          <div
            className="inline-flex rounded-lg p-0.5 text-xs font-semibold"
            style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
          >
            <button
              type="button"
              onClick={() => setViewMode("active")}
              className="px-2.5 py-1 rounded-md transition-colors"
              style={
                viewMode === "active"
                  ? { background: "var(--pf-action)", color: "#ffffff" }
                  : { color: "var(--pf-text-muted)" }
              }
            >
              Active Dispatch
            </button>
            <button
              type="button"
              onClick={() => setViewMode("all")}
              className="px-2.5 py-1 rounded-md transition-colors"
              style={
                viewMode === "all"
                  ? { background: "var(--pf-action)", color: "#ffffff" }
                  : { color: "var(--pf-text-muted)" }
              }
            >
              All Loads
            </button>
          </div>

          <div
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg min-w-[240px]"
            style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
          >
            <Search size={13} style={{ color: "var(--pf-text-muted)" }} />
            <input
              value={localSearch}
              onChange={(e) => setLocalSearch(e.target.value)}
              placeholder={
                searchQuery
                  ? `Filtered by "${searchQuery}"…`
                  : "Filter Load #, Customer, Carrier, PO, City/ST…"
              }
              className="bg-transparent border-0 outline-none text-xs w-full"
              style={{ color: "var(--pf-text)" }}
            />
            {localSearch && (
              <button type="button" onClick={() => setLocalSearch("")} style={{ color: "var(--pf-text-muted)" }}>
                <X size={12} />
              </button>
            )}
          </div>

          <select
            value={`${sortBy}:${sortDir}`}
            onChange={(e) => {
              const [col, dir] = e.target.value.split(":") as [SortColumn, "asc" | "desc"];
              setSortBy(col);
              setSortDir(dir);
            }}
            className="pf-input !w-auto text-xs font-medium"
            title="Sort loads"
          >
            <option value="shipDate:desc">Sort: Ship Date (Newest)</option>
            <option value="shipDate:asc">Sort: Ship Date (Soonest)</option>
            <option value="customerName:asc">Sort: Customer (A–Z)</option>
            <option value="carrierName:asc">Sort: Carrier (A–Z)</option>
            <option value="sell:desc">Sort: Sell (High–Low)</option>
            <option value="buy:desc">Sort: Buy (High–Low)</option>
            <option value="margin:desc">Sort: Margin (High–Low)</option>
          </select>

          <button
            type="button"
            onClick={() => void fetchServerLoads()}
            className="px-2.5 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5"
            style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)", color: "var(--pf-text)" }}
            title="Refresh live loads"
          >
            <RefreshCw size={12} className={loadingPage ? "animate-spin" : ""} /> Refresh
          </button>

          <button
            type="button"
            onClick={() => void handleSyncTaiInvoices()}
            disabled={syncingInvoices}
            className="px-2.5 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 transition-opacity hover:opacity-90 disabled:opacity-50"
            style={{
              background: "var(--pf-surface)",
              border: "1px solid var(--pf-border)",
              color: "var(--pf-primary)",
            }}
            title="Sync live invoice statuses, payment statuses, and line items from TAI Accounting API"
          >
            <FileText size={12} className={syncingInvoices ? "animate-spin" : ""} />
            {syncingInvoices ? "Syncing TAI Invoices…" : "Sync TAI Invoices"}
          </button>

          <div
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-mono"
            style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)", color: "var(--pf-text)" }}
          >
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="p-0.5 disabled:opacity-35"
              title="Previous page"
            >
              <ChevronLeft size={14} />
            </button>
            <span>
              Page {page} of {totalPages.toLocaleString()} · {totalCount.toLocaleString()} loads
            </span>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="p-0.5 disabled:opacity-35"
              title="Next page"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* Status Filter Pills with Live Counts */}
      <div className="flex flex-wrap gap-1.5">
        {FILTER_TABS.map((tab) => {
          const active = activeTab === tab;
          const cnt = tabCount(tab);
          return (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className="px-3 py-1.5 rounded-full text-xs font-semibold inline-flex items-center gap-1.5 transition-all"
              style={
                active
                  ? {
                      background: "var(--pf-action)",
                      color: "#ffffff",
                      border: "1px solid var(--pf-action)",
                    }
                  : {
                      background: "var(--pf-surface)",
                      color: "var(--pf-text-muted)",
                      border: "1px solid var(--pf-border)",
                    }
              }
            >
              <span>{tab}</span>
              <span className="font-mono text-[11px] opacity-90">{cnt.toLocaleString()}</span>
            </button>
          );
        })}
      </div>

      {/* Inline Feedback Banner */}
      {statusFeedback && (
        <div
          className="px-3.5 py-2 rounded-xl text-xs font-medium flex items-center justify-between gap-2"
          style={
            statusFeedback.kind === "error"
              ? { background: "var(--pf-danger-dim)", color: "var(--pf-danger)", border: "1px solid var(--pf-danger)" }
              : { background: "var(--pf-primary-dim)", color: "var(--pf-primary)", border: "1px solid var(--pf-primary)" }
          }
        >
          <span>{statusFeedback.msg}</span>
          <button type="button" onClick={() => setStatusFeedback(null)} className="opacity-80 hover:opacity-100">
            ×
          </button>
        </div>
      )}

      {/* Five Nines Styled All-Loads Operations Table */}
      <div
        className="rounded-2xl overflow-hidden shadow-sm"
        style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)", color: "var(--pf-text)" }}
      >
        <div className="overflow-x-auto pf-scroll">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr
                className="text-[10.5px] font-semibold uppercase tracking-wider select-none"
                style={{
                  background: "var(--pf-surface-raised)",
                  borderBottom: "1px solid var(--pf-border)",
                  color: "var(--pf-text-muted)",
                }}
              >
                <th className="py-3 pl-3.5 pr-2 w-8">
                  <input
                    type="checkbox"
                    checked={rowsToRender.length > 0 && rowsToRender.every((r) => selectedIds.has(r.id))}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedIds(new Set(rowsToRender.map((r) => r.id)));
                      } else {
                        setSelectedIds(new Set());
                      }
                    }}
                    className="rounded"
                    aria-label="Select all visible loads"
                  />
                </th>
                <th className="py-3 px-2.5">
                  <button
                    type="button"
                    onClick={() => toggleSort("customerName")}
                    className="inline-flex items-center gap-1 hover:opacity-80"
                  >
                    Customer <ArrowUpDown size={10} />
                  </button>
                </th>
                <th className="py-3 px-2">Status</th>
                <th className="py-3 px-2">RateCon</th>
                <th className="py-3 px-2">
                  <button
                    type="button"
                    onClick={() => toggleSort("shipDate")}
                    className="inline-flex items-center gap-1 hover:opacity-80"
                  >
                    Ship Date <ArrowUpDown size={10} />
                  </button>
                </th>
                <th className="py-3 px-2">Load #</th>
                <th className="py-3 px-2.5">
                  <button
                    type="button"
                    onClick={() => toggleSort("carrierName")}
                    className="inline-flex items-center gap-1 hover:opacity-80"
                  >
                    Carrier <ArrowUpDown size={10} />
                  </button>
                </th>
                <th className="py-3 px-2.5">Lane</th>
                <th className="py-3 px-2 text-right">
                  <button
                    type="button"
                    onClick={() => toggleSort("sell")}
                    className="inline-flex items-center gap-1 hover:opacity-80 ml-auto"
                  >
                    Sell <ArrowUpDown size={10} />
                  </button>
                </th>
                <th className="py-3 px-2 text-right">
                  <button
                    type="button"
                    onClick={() => toggleSort("buy")}
                    className="inline-flex items-center gap-1 hover:opacity-80 ml-auto"
                  >
                    Buy <ArrowUpDown size={10} />
                  </button>
                </th>
                <th className="py-3 px-2 text-right">
                  <button
                    type="button"
                    onClick={() => toggleSort("margin")}
                    className="inline-flex items-center gap-1 hover:opacity-80 ml-auto"
                  >
                    Margin <ArrowUpDown size={10} />
                  </button>
                </th>
                <th className="py-3 pl-2 pr-3.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rowsToRender.length === 0 ? (
                <tr>
                  <td colSpan={12} className="py-10 text-center text-xs" style={{ color: "var(--pf-text-muted)" }}>
                    {loadingPage ? "Loading live shipments…" : "No shipments match the active filter."}
                  </td>
                </tr>
              ) : (
                rowsToRender.map((s) => {
                  const statusLabel = canonicalDisplayStatus(s);
                  const rc = rateconBadgeConfig(s.rateconStatus);
                  const covered = isRowCovered(s);
                  const sell = Math.round(Number(s.sell) || 0);
                  const buy = Math.round(Number(s.buy) || 0);
                  const margin = sell - buy;
                  const missingDate = !s.shipDate || s.shipDate === "TBD";
                  const laneStr = formatLaneUpper(s.origin, s.dest, s.stops);

                  return (
                    <tr
                      key={s.id}
                      className="transition-colors hover:bg-[var(--pf-surface-hover)]"
                      style={{ borderBottom: "1px solid var(--pf-border)" }}
                    >
                      {/* 1. Checkbox */}
                      <td className="py-3 pl-3.5 pr-2">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(s.id)}
                          onChange={(e) => {
                            const next = new Set(selectedIds);
                            if (e.target.checked) next.add(s.id);
                            else next.delete(s.id);
                            setSelectedIds(next);
                          }}
                          className="rounded"
                          aria-label={`Select load #${s.id}`}
                        />
                      </td>

                      {/* 2. Customer */}
                      <td
                        className="py-3 px-2.5 font-bold uppercase max-w-[180px] truncate"
                        style={{ color: "var(--pf-text)" }}
                        title={`${s.customer}${s.po ? ` · PO ${s.po}` : ""}`}
                      >
                        {s.customer || "UNLINKED CUSTOMER"}
                      </td>

                      {/* 3. Status Pill */}
                      <td className="py-3 px-2 whitespace-nowrap">
                        <span
                          className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold inline-block"
                          style={statusPillStyle(statusLabel)}
                        >
                          {statusLabel}
                        </span>
                      </td>

                      {/* 4. RateCon Badge (click cycles Not Sent -> Sent -> Signed) */}
                      <td className="py-3 px-2 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => void handleCycleRatecon(s)}
                          className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold inline-flex items-center gap-1 hover:opacity-85 transition-opacity"
                          style={rc.style}
                          title="Click to cycle RateCon status (Not Sent → Sent → Signed)"
                        >
                          <span>{rc.text}</span>
                          {covered && s.rateconStatus === "Not Sent" && <Truck size={10} className="opacity-80" />}
                        </button>
                      </td>

                      {/* 5. Ship Date */}
                      <td className="py-3 px-2 whitespace-nowrap font-semibold">
                        {missingDate ? (
                          <span
                            className="px-2 py-0.5 rounded text-[10.5px] font-medium"
                            style={{ background: "var(--pf-warning-dim)", color: "var(--pf-warning)" }}
                          >
                            Missing date
                          </span>
                        ) : (
                          <span style={{ color: "var(--pf-text)" }}>{s.shipDate}</span>
                        )}
                      </td>

                      {/* 6. Shipment ID (Load # ↗) */}
                      <td className="py-3 px-2 whitespace-nowrap font-mono">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleShipmentIdClick(s)}
                            className="inline-flex items-center gap-1 hover:underline font-bold"
                            style={{ color: "var(--pf-action)" }}
                            title={`Open Load #${s.id}`}
                          >
                            <span>{s.id}</span>
                            <ExternalLink size={11} className="opacity-85" />
                          </button>
                          {s.lastAgentAction && (
                            <span
                              className="px-1.5 py-0.5 rounded text-[9.5px] font-mono font-bold inline-flex items-center gap-0.5"
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
                              title={`${s.lastAgentAction.agent}: ${s.lastAgentAction.summary || s.lastAgentAction.action} (${s.lastAgentAction.at || "live"})`}
                            >
                              {s.lastAgentAction.agent.toLowerCase().includes("grok") ? "🤖 Grok" : "🧠 Google"}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* 7. Carrier / Match carriers */}
                      <td className="py-3 px-2.5 max-w-[185px] truncate">
                        {covered ? (
                          <button
                            type="button"
                            onClick={() => openMatchCarrierModal(s)}
                            className="font-semibold hover:underline truncate block max-w-full text-left"
                            style={{ color: "var(--pf-text)" }}
                            title={`${s.carrier}${s.mc ? ` (MC ${s.mc})` : ""} — click to reassign`}
                          >
                            {s.carrier}
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => openMatchCarrierModal(s)}
                            className="px-2.5 py-0.5 rounded-lg text-[11px] font-bold hover:opacity-90 transition-opacity"
                            style={{
                              background: "var(--pf-primary-dim)",
                              color: "var(--pf-primary)",
                              border: "1px solid var(--pf-primary)",
                            }}
                          >
                            Match carriers
                          </button>
                        )}
                      </td>

                      {/* 8. Lane */}
                      <td
                        className="py-3 px-2.5 text-[11px] font-mono tracking-tight max-w-[240px] truncate"
                        style={{ color: "var(--pf-text-muted)" }}
                        title={`${s.origin} → ${s.dest}`}
                      >
                        {laneStr}
                      </td>

                      {/* 9. Sell */}
                      <td
                        className="py-3 px-2 text-right font-mono font-bold whitespace-nowrap"
                        style={{ color: "var(--pf-text)" }}
                      >
                        ${sell.toLocaleString()}
                      </td>

                      {/* 10. Buy */}
                      <td
                        className="py-3 px-2 text-right font-mono font-semibold whitespace-nowrap"
                        style={{ color: buy > 0 ? "var(--pf-text)" : "var(--pf-text-subtle)" }}
                      >
                        ${buy.toLocaleString()}
                      </td>

                      {/* 11. Margin & Invoice Status */}
                      <td className="py-3 px-2 text-right whitespace-nowrap">
                        <div
                          className="font-mono font-bold"
                          style={{
                            color:
                              margin < 0
                                ? "var(--pf-danger)"
                                : covered && margin > 0
                                ? "var(--pf-primary)"
                                : "var(--pf-text)",
                          }}
                        >
                          {margin < 0 ? `-$${Math.abs(margin).toLocaleString()}` : `$${margin.toLocaleString()}`}
                        </div>
                        {s.invoiceStatus && (
                          <div
                            className="text-[9.5px] font-mono font-medium truncate max-w-[125px] ml-auto"
                            style={{
                              color: /paid/i.test(s.invoiceStatus)
                                ? "var(--pf-primary)"
                                : "var(--pf-warning, #f59e0b)",
                            }}
                            title={`TAI Invoice: ${s.invoiceStatus}`}
                          >
                            {s.invoiceStatus}
                          </div>
                        )}
                      </td>

                      {/* 12. Right-Hand Action Icons: Send RC (↗) · Edit (✎) · Sync Inv · Delete (🗑) */}
                      <td className="py-3 pl-2 pr-3.5 whitespace-nowrap text-right">
                        <div className="inline-flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => void openRateConModal(s)}
                            className="p-1.5 rounded-lg transition-opacity hover:opacity-85"
                            style={{
                              background: "var(--pf-primary-dim)",
                              color: "var(--pf-primary)",
                              border: "1px solid var(--pf-border)",
                            }}
                            title="Send / Generate Rate Confirmation"
                            aria-label={`Send Rate Confirmation for #${s.id}`}
                          >
                            <ArrowUpRight size={13} />
                          </button>

                          <button
                            type="button"
                            onClick={() => openEditModal(s)}
                            className="p-1.5 rounded-lg transition-opacity hover:opacity-85"
                            style={{
                              background: "var(--pf-surface-raised)",
                              color: "var(--pf-text)",
                              border: "1px solid var(--pf-border)",
                            }}
                            title="Edit Shipment (Live TAI Write-Back)"
                            aria-label={`Edit Shipment #${s.id}`}
                          >
                            <Pencil size={13} />
                          </button>

                          <button
                            type="button"
                            onClick={() => void handleSyncSingleInvoice(s.id)}
                            className="p-1.5 rounded-lg transition-opacity hover:opacity-85"
                            style={{
                              background: "var(--pf-surface-raised)",
                              color: /paid/i.test(s.invoiceStatus || "") ? "var(--pf-primary)" : "var(--pf-text)",
                              border: "1px solid var(--pf-border)",
                            }}
                            title={`Sync TAI Invoice for #${s.id}`}
                            aria-label={`Sync TAI Invoice for #${s.id}`}
                          >
                            <FileText size={13} />
                          </button>

                          <button
                            type="button"
                            onClick={() => setConfirmDeleteLoad(s)}
                            className="p-1.5 rounded-lg transition-opacity hover:opacity-85"
                            style={{
                              background: "var(--pf-danger-dim)",
                              color: "var(--pf-danger)",
                            }}
                            title={`Delete Shipment #${s.id}`}
                            aria-label={`Delete Shipment #${s.id}`}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* MODAL 1: MATCH & ASSIGN CARRIER MODAL */}
      {matchCarrierLoad && (
        <div
          onClick={() => !matchSaving && setMatchCarrierLoad(null)}
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={submitMatchCarrier}
            className="w-full max-w-lg rounded-2xl overflow-hidden shadow-2xl text-xs"
            style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)", color: "var(--pf-text)" }}
          >
            <div className="pf-brand-rule shrink-0" />

            <div className="p-5 space-y-4">
              <div className="flex items-center justify-between pb-2.5" style={{ borderBottom: "1px solid var(--pf-border)" }}>
                <div>
                  <h3 className="text-base font-bold">Match &amp; Assign Carrier · Load #{matchCarrierLoad.id}</h3>
                  <div className="text-[11px]" style={{ color: "var(--pf-text-muted)" }}>
                    {matchCarrierLoad.customer} · {formatLaneUpper(matchCarrierLoad.origin, matchCarrierLoad.dest, matchCarrierLoad.stops)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setMatchCarrierLoad(null)}
                  className="p-1.5 rounded-lg"
                  style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
                >
                  <X size={15} />
                </button>
              </div>

              {laneRunnerSuggestions.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[10.5px] font-semibold uppercase tracking-wider" style={{ color: "var(--pf-primary)" }}>
                    Historical Lane Runners on This Corridor
                  </div>
                  <div className="grid sm:grid-cols-2 gap-1.5">
                    {laneRunnerSuggestions.map((lr) => (
                      <button
                        key={lr.name}
                        type="button"
                        onClick={() => {
                          setMatchCarrierSelected(lr.name);
                          if (lr.avgBuy > 0) setMatchCarrierBuy(lr.avgBuy);
                        }}
                        className="p-2.5 rounded-xl text-left transition-colors"
                        style={{
                          background: matchCarrierSelected === lr.name ? "var(--pf-primary-dim)" : "var(--pf-surface-raised)",
                          border: `1px solid ${matchCarrierSelected === lr.name ? "var(--pf-primary)" : "var(--pf-border)"}`,
                        }}
                      >
                        <div className="font-bold truncate">{lr.name}</div>
                        <div className="text-[11px] font-mono" style={{ color: "var(--pf-text-muted)" }}>
                          {lr.runs} load{lr.runs > 1 ? "s" : ""}{lr.avgBuy > 0 ? ` · avg $${lr.avgBuy.toLocaleString()} buy` : ""}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <label className="block text-[11px] font-semibold" style={{ color: "var(--pf-text-muted)" }}>
                  Search All Live TAI Carriers ({carriers.length.toLocaleString()})
                </label>
                <input
                  value={matchCarrierQuery}
                  onChange={(e) => setMatchCarrierQuery(e.target.value)}
                  placeholder="Type carrier name, MC #, DOT #, or SCAC…"
                  className="pf-input"
                />
                <div
                  className="max-h-44 overflow-y-auto pf-scroll rounded-xl"
                  style={{ background: "var(--pf-bg)", border: "1px solid var(--pf-border)" }}
                >
                  {filteredCarriers.map((c) => {
                    const active = matchCarrierSelected === c.name;
                    return (
                      <button
                        key={`${c.name}-${c.taiMasterId || c.mc}`}
                        type="button"
                        onClick={() => {
                          setMatchCarrierSelected(c.name);
                          if (c.avgBuy && c.avgBuy > 0 && !matchCarrierBuy) setMatchCarrierBuy(c.avgBuy);
                        }}
                        className="w-full text-left px-3 py-2 flex items-center justify-between gap-2 hover:bg-[var(--pf-surface-hover)]"
                        style={{
                          borderBottom: "1px solid var(--pf-border)",
                          background: active ? "var(--pf-primary-dim)" : undefined,
                          color: active ? "var(--pf-primary)" : undefined,
                        }}
                      >
                        <div className="min-w-0">
                          <div className="font-semibold truncate">{c.name}</div>
                          <div className="text-[10.5px] font-mono" style={{ color: "var(--pf-text-muted)" }}>
                            {c.mc ? `MC ${c.mc}` : "MC —"} {c.taiMasterId ? `· TAI #${c.taiMasterId}` : ""}{" "}
                            {c.insuranceStatus ? `· ${c.insuranceStatus}` : ""}
                          </div>
                        </div>
                        {active && <CheckCircle2 size={14} />}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] mb-1" style={{ color: "var(--pf-text-muted)" }}>
                    Selected Carrier *
                  </label>
                  <input
                    required
                    value={matchCarrierSelected}
                    onChange={(e) => setMatchCarrierSelected(e.target.value)}
                    placeholder="Carrier name"
                    className="pf-input font-semibold"
                  />
                </div>
                <div>
                  <label className="block text-[11px] mb-1" style={{ color: "var(--pf-text-muted)" }}>
                    Linehaul Buy Rate ($) · Sell ${(Number(matchCarrierLoad.sell) || 0).toLocaleString()}
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={matchCarrierBuy || ""}
                    onChange={(e) => setMatchCarrierBuy(Number(e.target.value) || 0)}
                    placeholder="0"
                    className="pf-input font-mono font-bold"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2" style={{ borderTop: "1px solid var(--pf-border)" }}>
                <button
                  type="button"
                  onClick={() => setMatchCarrierLoad(null)}
                  className="px-3.5 py-2 rounded-xl font-medium"
                  style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={matchSaving || !matchCarrierSelected.trim()}
                  className="px-4 py-2 rounded-xl font-bold"
                  style={{ background: "var(--pf-primary)", color: "var(--pf-primary-fg)" }}
                >
                  {matchSaving ? "Assigning & Syncing TAI…" : "Assign Carrier & Sync Live to TAI"}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* MODAL 2: SEND / GENERATE RATE CONFIRMATION MODAL (↗ Send RC) */}
      {rateconLoad && rateconDoc && (
        <div
          onClick={() => setRateconLoad(null)}
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg rounded-2xl overflow-hidden shadow-2xl text-xs"
            style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)", color: "var(--pf-text)" }}
          >
            <div className="pf-brand-rule shrink-0" />

            <div className="p-5 space-y-4">
              <div className="flex items-center justify-between pb-2.5" style={{ borderBottom: "1px solid var(--pf-border)" }}>
                <div>
                  <h3 className="text-base font-bold">Rate Confirmation · Load #{rateconLoad.id}</h3>
                  <div className="text-[11px]" style={{ color: "var(--pf-text-muted)" }}>
                    Carrier: <strong>{rateconLoad.carrier || "Unassigned"}</strong> · Pay:{" "}
                    <strong>${(Number(rateconLoad.buy) || 0).toLocaleString()}</strong> · Current Status:{" "}
                    <strong>{rateconLoad.rateconStatus}</strong>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setRateconLoad(null)}
                  className="p-1.5 rounded-lg"
                  style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
                >
                  <X size={15} />
                </button>
              </div>

              <pre
                className="p-3.5 rounded-xl font-mono text-[11px] whitespace-pre-wrap max-h-60 overflow-y-auto pf-scroll"
                style={{ background: "var(--pf-bg)", border: "1px solid var(--pf-border)", color: "var(--pf-text)" }}
              >
                {rateconLoading ? "Hydrating Rate Confirmation from load…" : rateconDoc.summaryText}
              </pre>

              <div className="grid sm:grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const ok = openPrintableHtmlWindow(`RateCon #${rateconLoad.id}`, rateconDoc.printableHtml);
                    notify(ok ? `Opened printable RateCon PDF for #${rateconLoad.id}` : "Pop-up blocked — allow pop-ups", ok ? "ok" : "error");
                  }}
                  className="py-2 px-3 rounded-xl font-semibold inline-flex items-center justify-center gap-1.5"
                  style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
                >
                  <Printer size={13} /> Print / PDF
                </button>

                <button
                  type="button"
                  onClick={async () => {
                    const res = await insertGmailReply({
                      text: rateconDoc.summaryText,
                      subject: `Rate Confirmation — Load #${rateconLoad.id} (${formatLaneUpper(rateconLoad.origin, rateconLoad.dest, rateconLoad.stops)})`,
                    });
                    notify(res.message, res.ok ? "ok" : "error");
                  }}
                  className="py-2 px-3 rounded-xl font-semibold inline-flex items-center justify-center gap-1.5"
                  style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
                >
                  <Reply size={13} /> Insert in Gmail
                </button>

                <button
                  type="button"
                  onClick={async () => {
                    await fetch(`/api/loads/${encodeURIComponent(rateconLoad.id)}/ratecon-status`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      credentials: "include",
                      body: JSON.stringify({ rateconStatus: "Sent" }),
                    });
                    notify(`Marked RateCon Sent on Load #${rateconLoad.id}`);
                    setRateconLoad(null);
                    await Promise.all([fetchServerLoads(), onRefreshBootstrap?.()]);
                  }}
                  className="py-2 px-3 rounded-xl font-bold inline-flex items-center justify-center gap-1.5"
                  style={{ background: "var(--pf-primary)", color: "var(--pf-primary-fg)" }}
                >
                  <CheckCircle2 size={13} /> Mark RateCon Sent
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 3: COMPREHENSIVE EDIT SHIPMENT MODAL (✎ Live TAI Write-Back) */}
      {editingLoad && editDraft && (
        <div
          onClick={() => !editSaving && setEditingLoad(null)}
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={submitEditModal}
            className="w-full max-w-2xl max-h-[92vh] flex flex-col rounded-2xl overflow-hidden shadow-2xl text-xs"
            style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)", color: "var(--pf-text)" }}
          >
            <div className="pf-brand-rule shrink-0" />

            <div className="p-5 overflow-y-auto pf-scroll space-y-4">
              <div className="flex items-center justify-between pb-2.5" style={{ borderBottom: "1px solid var(--pf-border)" }}>
                <div>
                  <h3 className="text-base font-bold">Edit Shipment · Load #{editingLoad.id}</h3>
                  <div className="text-[11px]" style={{ color: "var(--pf-text-muted)" }}>
                    Updates database &amp; pushes charges, references, carrier &amp; tracking live to TAI
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onUploadPod(editingLoad.id)}
                    className="px-2.5 py-1.5 rounded-lg font-semibold inline-flex items-center gap-1"
                    style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
                  >
                    <Upload size={12} /> Upload POD ({editingLoad.podCount})
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingLoad(null)}
                    className="p-1.5 rounded-lg"
                    style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
                  >
                    <X size={15} />
                  </button>
                </div>
              </div>

              <div className="grid sm:grid-cols-3 gap-3">
                <div className="sm:col-span-1">
                  <label className="block text-[11px] mb-1" style={{ color: "var(--pf-text-muted)" }}>
                    Customer
                  </label>
                  <input
                    value={editDraft.customer}
                    onChange={(e) => setEditDraft({ ...editDraft, customer: e.target.value })}
                    className="pf-input font-semibold"
                  />
                </div>
                <div>
                  <label className="block text-[11px] mb-1" style={{ color: "var(--pf-text-muted)" }}>
                    Status
                  </label>
                  <select
                    value={editDraft.status}
                    onChange={(e) => setEditDraft({ ...editDraft, status: e.target.value })}
                    className="pf-input font-semibold"
                  >
                    <option value="Committed">Committed</option>
                    <option value="Dispatched">Dispatched</option>
                    <option value="In Transit">In Transit</option>
                    <option value="Delivered">Delivered</option>
                    <option value="Cancelled">Cancelled</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] mb-1" style={{ color: "var(--pf-text-muted)" }}>
                    RateCon Status
                  </label>
                  <select
                    value={editDraft.rateconStatus}
                    onChange={(e) => setEditDraft({ ...editDraft, rateconStatus: e.target.value })}
                    className="pf-input"
                  >
                    <option value="Not Sent">Not Sent</option>
                    <option value="Drafted">Drafted</option>
                    <option value="Sent">Sent</option>
                    <option value="Signed">Signed</option>
                  </select>
                </div>
              </div>

              <div className="grid sm:grid-cols-4 gap-2.5">
                <div>
                  <label className="block text-[11px] mb-1" style={{ color: "var(--pf-text-muted)" }}>
                    Ship Date
                  </label>
                  <input
                    type="date"
                    value={editDraft.shipDate}
                    onChange={(e) => setEditDraft({ ...editDraft, shipDate: e.target.value })}
                    className="pf-input font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] mb-1" style={{ color: "var(--pf-text-muted)" }}>
                    Delivery Date
                  </label>
                  <input
                    type="date"
                    value={editDraft.delivDate}
                    onChange={(e) => setEditDraft({ ...editDraft, delivDate: e.target.value })}
                    className="pf-input font-mono"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-[11px] mb-1" style={{ color: "var(--pf-text-muted)" }}>
                    Equipment
                  </label>
                  <input
                    value={editDraft.equip}
                    onChange={(e) => setEditDraft({ ...editDraft, equip: e.target.value })}
                    className="pf-input"
                  />
                </div>
              </div>

              <div className="grid sm:grid-cols-4 gap-2.5">
                <div className="sm:col-span-1">
                  <label className="block text-[11px] mb-1" style={{ color: "var(--pf-text-muted)" }}>
                    Origin City
                  </label>
                  <input
                    value={editDraft.originCity}
                    onChange={(e) => setEditDraft({ ...editDraft, originCity: e.target.value })}
                    className="pf-input"
                  />
                </div>
                <div>
                  <label className="block text-[11px] mb-1" style={{ color: "var(--pf-text-muted)" }}>
                    Origin ST
                  </label>
                  <input
                    maxLength={2}
                    value={editDraft.originState}
                    onChange={(e) => setEditDraft({ ...editDraft, originState: e.target.value.toUpperCase() })}
                    className="pf-input font-mono uppercase"
                  />
                </div>
                <div>
                  <label className="block text-[11px] mb-1" style={{ color: "var(--pf-text-muted)" }}>
                    Dest City
                  </label>
                  <input
                    value={editDraft.destCity}
                    onChange={(e) => setEditDraft({ ...editDraft, destCity: e.target.value })}
                    className="pf-input"
                  />
                </div>
                <div>
                  <label className="block text-[11px] mb-1" style={{ color: "var(--pf-text-muted)" }}>
                    Dest ST
                  </label>
                  <input
                    maxLength={2}
                    value={editDraft.destState}
                    onChange={(e) => setEditDraft({ ...editDraft, destState: e.target.value.toUpperCase() })}
                    className="pf-input font-mono uppercase"
                  />
                </div>
              </div>

              <div className="grid sm:grid-cols-12 gap-2.5 items-end">
                <div className="sm:col-span-6">
                  <label className="block text-[11px] mb-1" style={{ color: "var(--pf-text-muted)" }}>
                    Carrier (Live TAI Master Directory)
                  </label>
                  <input
                    list="udv-live-carriers"
                    value={editDraft.carrier}
                    onChange={(e) => setEditDraft({ ...editDraft, carrier: e.target.value })}
                    placeholder="Unassigned — type to search carriers"
                    className="pf-input font-semibold"
                  />
                  <datalist id="udv-live-carriers">
                    {carriers.slice(0, 300).map((c) => (
                      <option key={`${c.name}-${c.taiMasterId || c.mc}`} value={c.name}>
                        {c.mc ? `MC ${c.mc}` : ""}
                      </option>
                    ))}
                  </datalist>
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-[11px] mb-1" style={{ color: "var(--pf-text-muted)" }}>
                    Sell ($)
                  </label>
                  <input
                    type="number"
                    value={editDraft.sell || ""}
                    onChange={(e) => setEditDraft({ ...editDraft, sell: Number(e.target.value) || 0 })}
                    className="pf-input font-mono font-bold"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-[11px] mb-1" style={{ color: "var(--pf-text-muted)" }}>
                    Buy ($)
                  </label>
                  <input
                    type="number"
                    value={editDraft.buy || ""}
                    onChange={(e) => setEditDraft({ ...editDraft, buy: Number(e.target.value) || 0 })}
                    className="pf-input font-mono font-bold"
                  />
                </div>
                <div
                  className="sm:col-span-2 px-2.5 py-1.5 rounded-lg text-right font-mono"
                  style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
                >
                  <div className="text-[10px]" style={{ color: "var(--pf-text-muted)" }}>
                    Margin
                  </div>
                  <div
                    className="font-bold"
                    style={{ color: editDraft.sell - editDraft.buy >= 0 ? "var(--pf-primary)" : "var(--pf-danger)" }}
                  >
                    ${(editDraft.sell - editDraft.buy).toLocaleString()}
                  </div>
                </div>
              </div>

              <div className="grid sm:grid-cols-3 gap-2.5">
                <div>
                  <label className="block text-[11px] mb-1" style={{ color: "var(--pf-text-muted)" }}>
                    Customer PO #
                  </label>
                  <input
                    value={editDraft.po}
                    onChange={(e) => setEditDraft({ ...editDraft, po: e.target.value })}
                    className="pf-input font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] mb-1" style={{ color: "var(--pf-text-muted)" }}>
                    BOL / Shipper Ref
                  </label>
                  <input
                    value={editDraft.bol}
                    onChange={(e) => setEditDraft({ ...editDraft, bol: e.target.value })}
                    className="pf-input font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] mb-1" style={{ color: "var(--pf-text-muted)" }}>
                    Carrier PRO #
                  </label>
                  <input
                    value={editDraft.pro}
                    onChange={(e) => setEditDraft({ ...editDraft, pro: e.target.value })}
                    className="pf-input font-mono"
                  />
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[11px] mb-1" style={{ color: "var(--pf-text-muted)" }}>
                    Current Location / GPS
                  </label>
                  <input
                    value={editDraft.currentLocation}
                    onChange={(e) => setEditDraft({ ...editDraft, currentLocation: e.target.value })}
                    placeholder="City, ST / tracking update"
                    className="pf-input"
                  />
                </div>
                <div>
                  <label className="block text-[11px] mb-1" style={{ color: "var(--pf-text-muted)" }}>
                    Driver Phone
                  </label>
                  <input
                    value={editDraft.driverPhone}
                    onChange={(e) => setEditDraft({ ...editDraft, driverPhone: e.target.value })}
                    placeholder="(555) 000-0000"
                    className="pf-input font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] mb-1" style={{ color: "var(--pf-text-muted)" }}>
                  Operational Note / Exception Details
                </label>
                <textarea
                  rows={2}
                  value={editDraft.operationalNote}
                  onChange={(e) => setEditDraft({ ...editDraft, operationalNote: e.target.value })}
                  className="pf-input"
                />
              </div>

              <div
                className="flex flex-wrap items-center justify-between gap-3 pt-3"
                style={{ borderTop: "1px solid var(--pf-border)" }}
              >
                <label className="inline-flex items-center gap-2 cursor-pointer font-semibold" style={{ color: "var(--pf-primary)" }}>
                  <input
                    type="checkbox"
                    checked={editDraft.pushToTai}
                    onChange={(e) => setEditDraft({ ...editDraft, pushToTai: e.target.checked })}
                    className="rounded"
                  />
                  <span>Push changes live to TAI (Sell/Buy Charges, References &amp; Tracking)</span>
                </label>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setEditingLoad(null)}
                    className="px-3.5 py-2 rounded-xl font-medium"
                    style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={editSaving}
                    className="px-4 py-2 rounded-xl font-bold"
                    style={{ background: "var(--pf-action)", color: "#ffffff" }}
                  >
                    {editSaving ? "Saving & Syncing TAI…" : "Save Shipment Changes"}
                  </button>
                </div>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* MODAL 4: GUARDED DELETE CONFIRMATION */}
      {confirmDeleteLoad && (
        <div
          onClick={() => setConfirmDeleteLoad(null)}
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-2xl p-5 space-y-3 shadow-2xl text-xs"
            style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-danger)", color: "var(--pf-text)" }}
          >
            <h3 className="text-sm font-bold" style={{ color: "var(--pf-danger)" }}>
              Delete Load #{confirmDeleteLoad.id}?
            </h3>
            <p style={{ color: "var(--pf-text-muted)" }}>
              Remove <strong>{confirmDeleteLoad.customer}</strong> ({formatLaneUpper(confirmDeleteLoad.origin, confirmDeleteLoad.dest, confirmDeleteLoad.stops)}) from local dispatch?
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setConfirmDeleteLoad(null)}
                className="px-3 py-1.5 rounded-lg"
                style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  const id = confirmDeleteLoad.id;
                  setConfirmDeleteLoad(null);
                  await onDeleteLoad(id);
                  await fetchServerLoads();
                }}
                className="px-3.5 py-1.5 rounded-lg font-bold"
                style={{ background: "var(--pf-danger)", color: "#ffffff" }}
              >
                Confirm Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
