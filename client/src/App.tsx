import React, { useCallback, useEffect, useState } from "react";
import { useLocation } from "wouter";
import type { LoadEntry } from "@shared/load-entry";
import type { BootstrapPayload, CrucialEmailItem } from "@shared/tai-webhook-schema";
import { CompactLoadBuilder } from "./components/CompactLoadBuilder";
import { UnifiedDispatchView } from "./components/UnifiedDispatchView";
import { GmailToolkitPanel } from "./components/GmailToolkitPanel";
import {
  Activity,
  Bot,
  FileCheck2,
  Inbox,
  Layers,
  Moon,
  PanelRight,
  PlusCircle,
  Search,
  Send,
  Sun,
  Zap,
} from "lucide-react";

function createDefaultBuilderEntry(): LoadEntry {
  return {
    shipmentType: "Truckload",
    status: "Committed",
    customer: {
      name: "LARKIN REFRACTORY SOLUTIONS",
      taiOrganizationId: "698049",
    },
    references: {
      customerPO: "42705",
      bolNumber: "42705",
      invoiceRef: "42705",
      carrierProNumber: "",
      pickupNumber: "",
    },
    stops: [
      {
        stopType: "First Pickup",
        companyName: "CeramSource, Inc.",
        streetAddress: "400 Enterprise Drive",
        city: "Beaver Falls",
        state: "PA",
        zipCode: "15010",
        country: "USA",
        contactName: "Dock",
        phone: "(732) 257-5002",
        instructions: "",
        readyDate: "2026-11-16",
        timeOpen: "08:00",
        timeClose: "14:00",
        appointmentRequired: false,
        savedFacilityMatched: true,
      },
      {
        stopType: "Last Drop",
        companyName: "Larkin Refractory Solutions",
        streetAddress: "2331 Varkel Way",
        city: "Lithonia",
        state: "GA",
        zipCode: "30058",
        country: "USA",
        contactName: "Receiving",
        phone: "(678) 336-7090",
        instructions: "",
        readyDate: "2026-11-17",
        timeOpen: "07:00",
        timeClose: "10:00",
        appointmentRequired: true,
        savedFacilityMatched: true,
      },
    ],
    items: [
      {
        description: "Refractory Ceramic Fiber Blankets & Castables",
        packagingType: "Pallet",
        handlingQuantity: 22,
        piecesTotal: 22,
        weightTotal: 38644,
        hazardousMaterial: false,
        freightClass: "No Class",
        referenceNumber: "PO 42705",
      },
    ],
    accessorials: [{ scope: "pickup", code: "TARP", name: "Tarp Fee", sell: 150, buy: 100 }],
    equipment: {
      trailerSize: "Full",
      trailerType: "48 ft Flatbed | Tarp",
      equipmentLength: "48",
      mileage: 648,
      stackable: false,
    },
    pricing: {
      linehaulSell: 3050,
      fuelSell: 0,
      linehaulBuy: 2450,
      fuelBuy: 0,
    },
    carrier: {
      name: "",
      serviceLevel: "Normal",
    },
    specialInstructions: "8ft Tarps Required | Call 1 hr Prior | MacroPoint Tracking",
    sendToTai: true,
  };
}

export const App: React.FC = () => {
  const [location, setLocation] = useLocation();
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [dockToolkit, setDockToolkit] = useState<boolean>(true);
  const [data, setData] = useState<BootstrapPayload | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedLoadId, setExpandedLoadId] = useState<string | null>("132738007");
  const [inboxFilter, setInboxFilter] = useState<string>("all");
  const [toast, setToast] = useState<string | null>(null);
  const [builderEntry, setBuilderEntry] = useState<LoadEntry>(() => createDefaultBuilderEntry());
  const [authGateUrl, setAuthGateUrl] = useState<string | null>(null);
  const [chatHistory, setChatHistory] = useState<Array<{ role: "user" | "assistant"; text: string }>>([
    {
      role: "assistant",
      text: "Ready! Ask about PA→GA historical lane runners, carrier MC/insurance, load status, or TAI webhook/write-back health.",
    },
  ]);
  const [aiDraft, setAiDraft] = useState("");

  const showToast = useCallback((msg: string) => {
    setToast(msg);
  }, []);

  const refreshBootstrap = useCallback(async () => {
    const res = await fetch("/api/bootstrap", { credentials: "include" });
    if (res.status === 401) {
      const errJson = (await res.json().catch(() => ({}))) as { loginUrl?: string };
      setAuthGateUrl(errJson.loginUrl || `/auth/google?returnTo=${encodeURIComponent(window.location.pathname)}`);
      return;
    }
    setAuthGateUrl(null);
    const json = (await res.json()) as BootstrapPayload;
    setData(json);
  }, []);

  useEffect(() => {
    refreshBootstrap();
  }, [refreshBootstrap]);

  // Live SSE listener for Supabase Realtime & Inbound TAI Webhooks
  useEffect(() => {
    if (authGateUrl) return;
    const es = new EventSource("/api/events");
    const onLiveUpdate = () => {
      refreshBootstrap().catch(() => {});
    };
    es.addEventListener("shipment_updated", onLiveUpdate);
    es.addEventListener("shipment_booked", onLiveUpdate);
    es.addEventListener("writeback_verified", onLiveUpdate);
    es.addEventListener("invoice_updated", onLiveUpdate);
    return () => es.close();
  }, [authGateUrl, refreshBootstrap]);

  const extractMultiStopTender = useCallback(() => {
    setBuilderEntry({
      ...createDefaultBuilderEntry(),
      stops: [
        {
          stopType: "First Pickup",
          companyName: "CeramSource, Inc.",
          streetAddress: "400 Enterprise Drive",
          city: "Beaver Falls",
          state: "PA",
          zipCode: "15010",
          country: "USA",
          contactName: "Dock",
          phone: "(732) 257-5002",
          instructions: "",
          readyDate: "2026-11-16",
          timeOpen: "08:00",
          timeClose: "14:00",
          appointmentRequired: false,
          savedFacilityMatched: true,
        },
        {
          stopType: "Pick",
          companyName: "Management & Consulting",
          streetAddress: "626 Riverview Rd.",
          city: "Monongahela",
          state: "PA",
          zipCode: "15063",
          country: "USA",
          contactName: "Dean Smith",
          phone: "(724) 258-5500",
          instructions: "",
          readyDate: "2026-11-16",
          timeOpen: "10:00",
          timeClose: "15:00",
          appointmentRequired: false,
          savedFacilityMatched: true,
        },
        {
          stopType: "Last Drop",
          companyName: "Larkin Refractory Solutions",
          streetAddress: "2331 Varkel Way",
          city: "Lithonia",
          state: "GA",
          zipCode: "30058",
          country: "USA",
          contactName: "Receiving",
          phone: "(678) 336-7090",
          instructions: "",
          readyDate: "2026-11-17",
          timeOpen: "07:00",
          timeClose: "10:00",
          appointmentRequired: true,
          savedFacilityMatched: true,
        },
      ],
      items: [
        {
          description: "Ceramic Fiber Refractory Blankets",
          packagingType: "Pallet",
          handlingQuantity: 6,
          piecesTotal: 6,
          weightTotal: 6644,
          hazardousMaterial: false,
          freightClass: "No Class",
          referenceNumber: "Stop 1",
        },
        {
          description: "High-Alumina Refractory Castables",
          packagingType: "Pallet",
          handlingQuantity: 16,
          piecesTotal: 16,
          weightTotal: 32000,
          hazardousMaterial: false,
          freightClass: "No Class",
          referenceNumber: "Stop 2",
        },
      ],
    });
    showToast("Extracted 2-Pickup + 1-Drop Tender (#42705) with ZIPs & 2 Commodity Lines into Compact Builder.");
  }, [showToast]);

  const handleAssignCarrier = async (shipmentId: string, carrierName: string, buyRate: number) => {
    const res = await fetch(`/api/loads/${shipmentId}/writeback-carrier`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ carrierName, buyRate }),
    });
    const out = await res.json();
    showToast(out.message || "Updated carrier write-back");
    await refreshBootstrap();
  };

  const handleUploadPod = async (shipmentId: string) => {
    const res = await fetch(`/api/loads/${shipmentId}/pod`, { method: "POST" });
    const out = await res.json();
    showToast(out.message || "Uploaded POD");
    await refreshBootstrap();
  };

  const handleApplyEmailAction = async (em: CrucialEmailItem) => {
    if (em.diffType === "new_tender") {
      extractMultiStopTender();
      setLocation("/load-builder");
      return;
    }
    const res = await fetch(`/api/inbox/${em.id}/apply`, { method: "POST" });
    const out = await res.json();
    showToast(out.message || "Applied email diff");
    await refreshBootstrap();
  };

  const handleAskAi = async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setChatHistory((prev) => [...prev, { role: "user", text: trimmed }]);
    const res = await fetch("/api/assistant/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: trimmed }),
    });
    const out = await res.json();
    setChatHistory((prev) => [...prev, { role: "assistant", text: out.answer }]);
  };

  const simulateWebhook = async (kind: "gps" | "invoice") => {
    const res = await fetch("/api/webhooks/tai/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind }),
    });
    const out = await res.json();
    showToast(out.message);
    await refreshBootstrap();
  };

  if (authGateUrl) {
    return (
      <div data-theme={theme} className="pf-app min-h-screen flex flex-col items-center justify-center p-6">
        <div
          className="max-w-sm w-full p-6 rounded-2xl space-y-4 text-center"
          style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
        >
          <div className="pf-brand-rule rounded overflow-hidden">
            <div style={{ background: "#1D2C5E" }} />
            <div style={{ background: "#682C87" }} />
            <div style={{ background: "#D52A3B" }} />
            <div style={{ background: "#F0641E" }} />
            <div style={{ background: "#F5B841" }} />
          </div>
          <div className="font-serif font-bold text-lg">Five Nines Operations</div>
          <p className="text-xs leading-relaxed" style={{ color: "var(--pf-text-muted)" }}>
            Sign in with your verified <code>@primarycompanies.com</code> or <code>@shipfivenines.com</code> Google Workspace account to access live shipments and TAI write-back.
          </p>
          <a
            href={authGateUrl}
            className="block w-full py-2.5 px-4 rounded-lg text-xs font-bold"
            style={{ background: "var(--pf-action)", color: "#ffffff" }}
          >
            Sign in with Google Workspace
          </a>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div data-theme={theme} className="pf-app min-h-screen flex items-center justify-center text-sm font-mono">
        Loading Five Nines Operations Platform…
      </div>
    );
  }

  // Standalone Chrome Extension Side-Panel Route (/gmail-panel)
  if (location.startsWith("/gmail-panel")) {
    return (
      <div data-theme={theme} className="pf-app h-screen w-full overflow-hidden">
        <GmailToolkitPanel
          shipments={data.shipments}
          crucialEmails={data.crucialEmails}
          facilities={data.facilities}
          customers={data.customers}
          carriers={data.carriers}
          builderEntry={builderEntry}
          onBuilderChange={setBuilderEntry}
          onApplyEmailAction={handleApplyEmailAction}
          onBooked={async (_ids, msg) => {
            showToast(msg);
            await refreshBootstrap();
          }}
          onToast={showToast}
          onExtractTender={extractMultiStopTender}
          chatHistory={chatHistory}
          onAskAi={handleAskAi}
        />
      </div>
    );
  }

  const openActionsCount = data.crucialEmails.filter((e) => !e.applied).length;
  const navItems = [
    { path: "/", label: "Crucial Inbox", icon: Inbox, badge: openActionsCount },
    { path: "/dispatch", label: "Unified Dispatch", icon: Layers, badge: data.shipments.length },
    { path: "/load-builder", label: "Compact Builder", icon: PlusCircle, badge: "Fast" },
    { path: "/ai-assistant", label: "TAI Copilot", icon: Bot, badge: null },
    { path: "/pod-billing", label: "POD & Webhooks", icon: FileCheck2, badge: data.kpis.emailPodReady },
  ];

  return (
    <div data-theme={theme} className="pf-app min-h-screen flex flex-col">
      {/* Top 5-Stroke Primary Freight Brand Rule */}
      <div className="pf-brand-rule shrink-0">
        <div style={{ background: "#1D2C5E" }} />
        <div style={{ background: "#682C87" }} />
        <div style={{ background: "#D52A3B" }} />
        <div style={{ background: "#F0641E" }} />
        <div style={{ background: "#F5B841" }} />
      </div>

      {/* Toast Banner */}
      {toast && (
        <div
          className="px-4 py-2 text-xs font-medium flex items-center justify-between gap-3 shrink-0"
          style={{ background: "#163528", color: "#8ce6b8", borderBottom: "1px solid #255943" }}
        >
          <span>✓ {toast}</span>
          <button type="button" onClick={() => setToast(null)} className="underline opacity-80 hover:opacity-100">
            Dismiss
          </button>
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        {/* Left Consolidated Sidebar */}
        <aside
          className="w-56 shrink-0 flex flex-col justify-between p-3"
          style={{ background: "var(--pf-sidebar)", borderRight: "1px solid var(--pf-border)", color: "#f2f0ea" }}
        >
          <div className="space-y-4">
            <div className="px-2 pt-1 pb-3" style={{ borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
              <div className="flex items-center gap-2.5">
                <div
                  className="w-7 h-7 rounded-md flex items-center justify-center font-bold text-xs"
                  style={{ background: "#F0641E", color: "#ffffff" }}
                >
                  59
                </div>
                <div>
                  <div className="font-serif font-bold text-sm text-white">Five Nines Ops</div>
                  <div className="font-mono text-[10px]" style={{ color: "#8e97a3" }}>
                    {data.mode.safeSandbox ? "SANDBOX · SAFE MODE" : "LIVE TAI SYNC"}
                  </div>
                </div>
              </div>
            </div>

            <nav className="space-y-1">
              {navItems.map((it) => {
                const Icon = it.icon;
                const active = location === it.path;
                return (
                  <button
                    key={it.path}
                    type="button"
                    onClick={() => setLocation(it.path)}
                    className="w-full px-2.5 py-2 rounded-lg text-xs font-medium flex items-center justify-between transition-all text-left"
                    style={{
                      background: active ? "rgba(240,100,30,0.22)" : "transparent",
                      color: active ? "#ffffff" : "#cbd5e1",
                      border: active ? "1px solid rgba(240,100,30,0.5)" : "1px solid transparent",
                    }}
                  >
                    <span className="inline-flex items-center gap-2">
                      <Icon size={14} /> {it.label}
                    </span>
                    {it.badge !== null && (
                      <span
                        className="px-1.5 py-0.5 rounded-full font-mono text-[10px] font-semibold"
                        style={{ background: "rgba(255,255,255,0.14)", color: "#ffffff" }}
                      >
                        {it.badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>

            <div className="pt-3 space-y-1.5 text-xs" style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}>
              <div className="px-2 text-[10px] font-semibold uppercase tracking-wider" style={{ color: "#8e97a3" }}>
                Live Sync &amp; Poller
              </div>
              <div className="px-2 flex justify-between" style={{ color: "#cbd5e1" }}>
                <span>Supabase DB</span>
                <span className="font-mono text-[11px]" style={{ color: data.mode.supabaseConnected ? "#3ebf82" : "#d4a04a" }}>
                  ● {data.mode.supabaseConnected ? "Live" : "Seeded"}
                </span>
              </div>
              <div className="px-2 flex justify-between" style={{ color: "#cbd5e1" }}>
                <span>Realtime Stream</span>
                <span className="font-mono text-[11px]" style={{ color: data.mode.realtimeSubscribed ? "#3ebf82" : "#8e97a3" }}>
                  ● {data.mode.realtimeSubscribed ? "Active" : "SSE Ready"}
                </span>
              </div>
              <div className="px-2 flex justify-between" style={{ color: "#cbd5e1" }}>
                <span>Write-Back Poller</span>
                <span className="font-mono text-[11px]" style={{ color: "#3ebf82" }}>
                  ● {data.mode.pollerEnabled ? `Local (${data.mode.pollerScope})` : "Shared Queue"}
                </span>
              </div>
            </div>
          </div>

          <div
            className="p-2.5 rounded-lg text-[11px] space-y-1"
            style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.09)" }}
          >
            <div className="truncate font-mono text-[10px]" style={{ color: "#3ebf82" }}>
              {data.user?.email || "chriss@primarycompanies.com"}
            </div>
            <div className="flex justify-between font-mono">
              <span className="text-white">{data.kpis.totalShipments.toLocaleString()} loads</span>
              <span style={{ color: "#8e97a3" }}>{data.kpis.customersCount} cust</span>
            </div>
            <div style={{ color: "#8e97a3" }}>
              30d Net: <strong className="text-white font-mono">${(data.kpis.rev30d - data.kpis.buy30d).toLocaleString()}</strong>
            </div>
          </div>
        </aside>

        {/* Center Main Workspace */}
        <div className="flex-1 flex flex-col min-w-0">
          <header
            className="px-5 py-2.5 flex flex-wrap items-center justify-between gap-3"
            style={{ background: "var(--pf-surface)", borderBottom: "1px solid var(--pf-border)" }}
          >
            <div className="flex items-center gap-2 flex-1 min-w-[240px] max-w-md px-3 py-1.5 rounded-lg" style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}>
              <Search size={14} style={{ color: "var(--pf-text-muted)" }} />
              <input
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  if (e.target.value && location !== "/dispatch") setLocation("/dispatch");
                }}
                placeholder="Search load #, PO, ZIP, customer, carrier…"
                className="bg-transparent border-0 outline-none text-xs w-full"
                style={{ color: "var(--pf-text)" }}
              />
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                className="px-2.5 py-1.5 rounded-lg text-xs font-medium inline-flex items-center gap-1.5"
                style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
              >
                {theme === "dark" ? <Sun size={13} /> : <Moon size={13} />}
                {theme === "dark" ? "Light (#F4F6FA)" : "Dark (#0F1217)"}
              </button>

              <button
                type="button"
                onClick={() => setDockToolkit(!dockToolkit)}
                className="px-2.5 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5"
                style={{
                  background: dockToolkit ? "var(--pf-primary-dim)" : "var(--pf-surface-raised)",
                  color: dockToolkit ? "var(--pf-primary)" : "var(--pf-text)",
                  border: `1px solid ${dockToolkit ? "var(--pf-primary)" : "var(--pf-border)"}`,
                }}
              >
                <PanelRight size={13} />
                {dockToolkit ? "Hide 410px Gmail Panel" : "Show 410px Gmail Panel"}
              </button>

              <button
                type="button"
                onClick={() => setLocation("/load-builder")}
                className="px-3 py-1.5 rounded-lg text-xs font-bold"
                style={{ background: "var(--pf-action)", color: "#ffffff" }}
              >
                + Build Load
              </button>
            </div>
          </header>

          <main className="flex-1 p-5 overflow-y-auto pf-scroll space-y-5">
            {/* ROUTE 1: CRUCIAL ACTION INBOX */}
            {location === "/" && (
              <div className="space-y-4">
                {/* KPI Command Strip */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <div className="p-3.5 rounded-xl" style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}>
                    <div className="text-[11px]" style={{ color: "var(--pf-text-muted)" }}>Uncovered Committed</div>
                    <div className="text-xl font-bold font-mono mt-0.5" style={{ color: "var(--pf-warning)" }}>{data.kpis.uncoveredCommitted}</div>
                  </div>
                  <div className="p-3.5 rounded-xl" style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}>
                    <div className="text-[11px]" style={{ color: "var(--pf-text-muted)" }}>In Transit Now</div>
                    <div className="text-xl font-bold font-mono mt-0.5" style={{ color: "var(--pf-info)" }}>{data.kpis.inTransitNow}</div>
                  </div>
                  <div className="p-3.5 rounded-xl" style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}>
                    <div className="text-[11px]" style={{ color: "var(--pf-text-muted)" }}>Gmail PODs Ready for TAI</div>
                    <div className="text-xl font-bold font-mono mt-0.5" style={{ color: "var(--pf-danger)" }}>{data.kpis.emailPodReady}</div>
                  </div>
                  <div className="p-3.5 rounded-xl" style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}>
                    <div className="text-[11px]" style={{ color: "var(--pf-text-muted)" }}>30d Gross Margin ({data.kpis.loads30d} loads)</div>
                    <div className="text-xl font-bold font-mono mt-0.5" style={{ color: "var(--pf-primary)" }}>
                      ${(data.kpis.rev30d - data.kpis.buy30d).toLocaleString()}
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--pf-action)" }}>
                      Crucial Emails ONLY · Zero General Inbox Clutter
                    </div>
                    <h1 className="text-xl font-semibold tracking-tight mt-0.5">Action Stream &amp; 1-Click Load Extraction</h1>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      ["all", "All Crucial"],
                      ["tenders", "Unbooked Tenders"],
                      ["diffs", "PO & Rate Diffs"],
                      ["pod", "Missing PODs"],
                    ].map(([id, lbl]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setInboxFilter(id)}
                        className="px-3 py-1 rounded-full text-xs font-medium"
                        style={{
                          background: inboxFilter === id ? "var(--pf-action)" : "var(--pf-surface)",
                          color: inboxFilter === id ? "#ffffff" : "var(--pf-text-muted)",
                          border: "1px solid var(--pf-border)",
                        }}
                      >
                        {lbl}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid lg:grid-cols-2 gap-3.5">
                  {data.crucialEmails
                    .filter((e) => inboxFilter === "all" || e.category === inboxFilter)
                    .map((em) => (
                      <div
                        key={em.id}
                        className="p-4 rounded-xl flex flex-col justify-between gap-3"
                        style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
                      >
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-mono font-bold" style={{ color: "var(--pf-action)" }}>
                              {em.loadId === "NEW" ? "NEW TENDER" : `LOAD #${em.loadId}`}
                            </span>
                            <span style={{ color: "var(--pf-text-subtle)" }}>
                              {em.from} · {em.received}
                            </span>
                          </div>
                          <div className="text-sm font-semibold">{em.subject}</div>
                          <p className="text-xs leading-relaxed" style={{ color: "var(--pf-text-muted)" }}>
                            {em.body}
                          </p>
                        </div>

                        <div className="space-y-2">
                          <div
                            className="p-2 rounded-lg text-xs flex items-center justify-between"
                            style={{ background: "var(--pf-surface-raised)" }}
                          >
                            <span>{em.diffLabel}</span>
                            <strong className="font-mono" style={{ color: "var(--pf-primary)" }}>
                              {em.diffValue}
                            </strong>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleApplyEmailAction(em)}
                            className="w-full py-2 rounded-lg text-xs font-bold"
                            style={{
                              background: em.applied ? "var(--pf-primary-dim)" : "var(--pf-action)",
                              color: em.applied ? "var(--pf-primary)" : "#ffffff",
                            }}
                          >
                            {em.applied ? "✓ Synced to Load" : em.ctaLabel}
                          </button>
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            )}

            {/* ROUTE 2: UNIFIED DISPATCH */}
            {location === "/dispatch" && (
              <UnifiedDispatchView
                shipments={data.shipments}
                carriers={data.carriers}
                searchQuery={searchQuery}
                expandedLoadId={expandedLoadId}
                onToggleExpand={(id) => setExpandedLoadId(expandedLoadId === id ? null : id)}
                onAssignCarrier={handleAssignCarrier}
                onUploadPod={handleUploadPod}
                onAskAi={(q) => {
                  handleAskAi(q);
                  setLocation("/ai-assistant");
                }}
              />
            )}

            {/* ROUTE 3: COMPACT TAI LOAD BUILDER */}
            {location === "/load-builder" && (
              <div className="max-w-4xl space-y-3">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--pf-text-muted)" }}>
                    Compact Layout · Zero Scroll Bloat · 100% TAI Domestic Shipment Valid
                  </div>
                  <h1 className="text-xl font-semibold tracking-tight mt-0.5">Compact TAI Load Builder &amp; Margin Calculator</h1>
                </div>
                <CompactLoadBuilder
                  compact={false}
                  entry={builderEntry}
                  onChange={setBuilderEntry}
                  facilities={data.facilities}
                  customers={data.customers}
                  carriers={data.carriers}
                  onBooked={async (ids, msg) => {
                    showToast(msg);
                    await refreshBootstrap();
                    if (ids[0]) setExpandedLoadId(ids[0]);
                    setLocation("/dispatch");
                  }}
                  onToast={showToast}
                  onExtractSampleTender={extractMultiStopTender}
                />
              </div>
            )}

            {/* ROUTE 4: TAI AI ASSISTANT */}
            {location === "/ai-assistant" && (
              <div className="max-w-3xl space-y-4">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--pf-text-muted)" }}>
                    Grounded on Shipments, Carriers, Lanes &amp; TAI Sync Status
                  </div>
                  <h1 className="text-xl font-semibold tracking-tight mt-0.5">TAI Operations Copilot</h1>
                </div>

                <div className="flex flex-wrap gap-2">
                  {[
                    "Top historical lane runners for PA → GA flatbed?",
                    "Check TAI webhook and Fly write-back poller health",
                    "Check status on load 132738007",
                  ].map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      onClick={() => handleAskAi(prompt)}
                      className="px-3 py-1.5 rounded-full text-xs font-medium"
                      style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
                    >
                      ✦ {prompt}
                    </button>
                  ))}
                </div>

                <div
                  className="p-4 rounded-xl space-y-3"
                  style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
                >
                  {chatHistory.map((m, i) => (
                    <div
                      key={i}
                      className="p-3 rounded-lg text-xs leading-relaxed"
                      style={{
                        background: m.role === "user" ? "var(--pf-surface-raised)" : "var(--pf-bg)",
                        border: "1px solid var(--pf-border)",
                      }}
                    >
                      <div className="text-[10px] font-mono uppercase mb-1" style={{ color: "var(--pf-text-subtle)" }}>
                        {m.role}
                      </div>
                      {m.text}
                    </div>
                  ))}
                  <div className="flex gap-2 pt-2">
                    <input
                      value={aiDraft}
                      onChange={(e) => setAiDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && aiDraft.trim()) {
                          handleAskAi(aiDraft);
                          setAiDraft("");
                        }
                      }}
                      placeholder="Ask anything about loads, carriers, lanes, or TAI webhooks…"
                      className="pf-input flex-1"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (aiDraft.trim()) {
                          handleAskAi(aiDraft);
                          setAiDraft("");
                        }
                      }}
                      className="px-4 py-2 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5"
                      style={{ background: "var(--pf-primary)", color: "var(--pf-primary-fg)" }}
                    >
                      <Send size={13} /> Ask
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ROUTE 5: POD, BILLING & TAI WEBHOOK MONITOR */}
            {location === "/pod-billing" && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--pf-text-muted)" }}>
                      Inbound Webhooks + Fly Write-Back Poller + POD Read-Back Verification
                    </div>
                    <h1 className="text-xl font-semibold tracking-tight mt-0.5">POD Recovery &amp; TAI Sync Monitor</h1>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => simulateWebhook("gps")}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5"
                      style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
                    >
                      <Zap size={13} style={{ color: "var(--pf-primary)" }} /> Simulate GPS Webhook
                    </button>
                    <button
                      type="button"
                      onClick={() => simulateWebhook("invoice")}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5"
                      style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
                    >
                      <Activity size={13} style={{ color: "var(--pf-action)" }} /> Simulate Invoice Webhook
                    </button>
                  </div>
                </div>

                <div className="p-4 rounded-xl space-y-2.5" style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}>
                  <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--pf-text-muted)" }}>
                    Recent TAI Webhook &amp; Write-Back Events
                  </div>
                  {data.webhookLogs.map((log) => (
                    <div
                      key={log.id}
                      className="p-2.5 rounded-lg flex flex-wrap items-center justify-between gap-2 text-xs"
                      style={{ background: "var(--pf-surface-raised)" }}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold" style={{ color: "var(--pf-primary)" }}>
                          [{log.type}]
                        </span>
                        <span className="font-mono" style={{ color: "var(--pf-action)" }}>
                          #{log.shipmentId}
                        </span>
                        <span>{log.summary}</span>
                      </div>
                      <span className="font-mono text-[11px]" style={{ color: "var(--pf-text-subtle)" }}>
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </main>
        </div>

        {/* DOCKABLE 410px SHARED-HOST GMAIL TOOLKIT PANEL */}
        {dockToolkit && (
          <div
            className="w-[410px] shrink-0 hidden xl:flex flex-col overflow-hidden"
            style={{ borderLeft: "1px solid var(--pf-border)" }}
          >
            <GmailToolkitPanel
              shipments={data.shipments}
              crucialEmails={data.crucialEmails}
              facilities={data.facilities}
              customers={data.customers}
              carriers={data.carriers}
              builderEntry={builderEntry}
              onBuilderChange={setBuilderEntry}
              onApplyEmailAction={handleApplyEmailAction}
              onBooked={async (_ids, msg) => {
                showToast(msg);
                await refreshBootstrap();
              }}
              onToast={showToast}
              onExtractTender={extractMultiStopTender}
              chatHistory={chatHistory}
              onAskAi={handleAskAi}
            />
          </div>
        )}
      </div>
    </div>
  );
};
