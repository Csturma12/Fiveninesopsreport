import React, { useCallback, useEffect, useState } from "react";
import { useLocation } from "wouter";
import type { LoadEntry } from "@shared/load-entry";
import type { BootstrapPayload, CrmLeadItem, CrucialEmailItem, OpsShipment } from "@shared/tai-webhook-schema";
import { buildGmailContainerSearchUrl } from "@shared/container-extractor";
import { CompactLoadBuilder } from "./components/CompactLoadBuilder";
import { UnifiedDispatchView } from "./components/UnifiedDispatchView";
import { GmailToolkitPanel } from "./components/GmailToolkitPanel";
import { SalesOpsCrmView } from "./components/SalesOpsCrmView";
import {
  Activity,
  Bot,
  ExternalLink,
  FileCheck2,
  Handshake,
  Inbox,
  Layers,
  Mail,
  Moon,
  Package,
  PanelRight,
  PlusCircle,
  Search,
  Send,
  Sun,
  Trash2,
  UserPlus,
  X,
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
  const [reviewEmail, setReviewEmail] = useState<CrucialEmailItem | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [pasteEmailDraft, setPasteEmailDraft] = useState("");
  const [authGateUrl, setAuthGateUrl] = useState<string | null>(null);
  const [authUnavailableMessage, setAuthUnavailableMessage] = useState<string | null>(null);
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
    if (res.status === 503) {
      const errJson = (await res.json().catch(() => ({}))) as { message?: string };
      setAuthUnavailableMessage(errJson.message || "Server authentication is not configured.");
      setAuthGateUrl(null);
      return;
    }
    setAuthGateUrl(null);
    setAuthUnavailableMessage(null);
    const json = (await res.json()) as BootstrapPayload;
    setData(json);
  }, []);

  useEffect(() => {
    refreshBootstrap();
  }, [refreshBootstrap]);

  // Live SSE listener for Supabase Realtime & Inbound TAI Webhooks
  useEffect(() => {
    if (authGateUrl || authUnavailableMessage) return;
    const es = new EventSource("/api/events");
    const onLiveUpdate = () => {
      refreshBootstrap().catch(() => {});
    };
    es.addEventListener("shipment_updated", onLiveUpdate);
    es.addEventListener("shipment_booked", onLiveUpdate);
    es.addEventListener("writeback_verified", onLiveUpdate);
    es.addEventListener("invoice_updated", onLiveUpdate);
    es.addEventListener("crm_updated", onLiveUpdate);
    return () => es.close();
  }, [authGateUrl, authUnavailableMessage, refreshBootstrap]);

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

  const handleSaveLoadNote = async (
    shipmentId: string,
    payload: { note?: string; pastedEmailText?: string; containerNumber?: string },
  ) => {
    const res = await fetch(`/api/loads/${shipmentId}/note`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const out = await res.json();
    showToast(out.message || "Saved exception note");
    setNoteDraft("");
    setPasteEmailDraft("");
    await refreshBootstrap();
  };

  const handleDeleteInboxItem = async (emailId: string) => {
    const res = await fetch(`/api/inbox/${encodeURIComponent(emailId)}`, { method: "DELETE" });
    const out = await res.json();
    if (reviewEmail?.id === emailId) setReviewEmail(null);
    showToast(out.message || "Deleted email tile");
    await refreshBootstrap();
  };

  const handleDeleteLoad = async (shipmentId: string) => {
    const res = await fetch(`/api/loads/${encodeURIComponent(shipmentId)}`, { method: "DELETE" });
    const out = await res.json();
    if (expandedLoadId === shipmentId) setExpandedLoadId(null);
    showToast(out.message || `Deleted load #${shipmentId}`);
    await refreshBootstrap();
  };

  const handleAddCrmLead = async (payload: Partial<CrmLeadItem>) => {
    const res = await fetch("/api/crm/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const out = await res.json();
    showToast(out.message || "Added lead to SalesOps CRM");
    await refreshBootstrap();
  };

  const handleBulkImportCrmLeads = async (leads: Array<Partial<CrmLeadItem>>) => {
    const res = await fetch("/api/crm/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leads }),
    });
    const out = await res.json();
    showToast(out.message || "Imported leads into SalesOps CRM");
    await refreshBootstrap();
  };

  const handleUpdateCrmLead = async (id: string, patch: Partial<CrmLeadItem>) => {
    const res = await fetch(`/api/crm/leads/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const out = await res.json();
    showToast(out.message || "Updated lead");
    await refreshBootstrap();
  };

  const handleDeleteCrmLead = async (id: string) => {
    const res = await fetch(`/api/crm/leads/${encodeURIComponent(id)}`, { method: "DELETE" });
    const out = await res.json();
    showToast(out.message || "Deleted lead");
    await refreshBootstrap();
  };

  const handlePushCrmLead = async (id: string) => {
    const res = await fetch(`/api/crm/leads/${encodeURIComponent(id)}/push`, { method: "POST" });
    const out = await res.json();
    showToast(out.message || "Pushed lead to SalesOps CRM");
    await refreshBootstrap();
  };

  const handleSaveSenderToCrm = useCallback(
    async (em: CrucialEmailItem) => {
      const domainCompany = em.from.split("@")[1]?.split(".")[0]?.toUpperCase() || em.senderName || em.from;
      await handleAddCrmLead({
        company: em.senderName || domainCompany,
        contact: em.senderName || "",
        email: em.from,
        source: "Gmail",
        status: "New",
        evidence: `${em.subject} — ${em.body}`,
      });
    },
    [],
  );

  const buildLoadFromLead = useCallback(
    (lead: CrmLeadItem) => {
      setBuilderEntry({
        ...createDefaultBuilderEntry(),
        customer: {
          name: lead.company.toUpperCase(),
          taiOrganizationId: "",
          contactName: lead.contact,
          email: lead.email,
        },
        specialInstructions: lead.estimatedLanes || lead.evidence || "",
      });
      setLocation("/load-builder");
      showToast(`Prefilled Compact Load Builder for ${lead.company} (SalesOps Lead).`);
    },
    [setLocation, showToast],
  );

  const handleApplyEmailAction = async (em: CrucialEmailItem) => {
    if (em.diffType === "new_tender") {
      extractMultiStopTender();
      setReviewEmail(null);
      setLocation("/load-builder");
      return;
    }
    const res = await fetch(`/api/inbox/${em.id}/apply`, { method: "POST" });
    const out = await res.json();
    showToast(out.message || "Applied email diff");
    setReviewEmail((prev) => (prev && prev.id === em.id ? { ...prev, applied: true } : prev));
    await refreshBootstrap();
  };

  const openLoadInDispatch = useCallback(
    (loadId: string) => {
      setReviewEmail(null);
      setExpandedLoadId(loadId);
      setLocation("/dispatch");
    },
    [setLocation],
  );

  const loadShipmentIntoBuilder = useCallback(
    (s: OpsShipment, em?: CrucialEmailItem) => {
      setBuilderEntry({
        shipmentType: "Truckload",
        status: "Committed",
        customer: { name: s.customer, taiOrganizationId: s.taiOrgId || "" },
        references: {
          customerPO: em?.extractedPo || s.po || "",
          bolNumber: s.bol || "",
          invoiceRef: em?.extractedInvoice || s.bol || "",
          carrierProNumber: s.pro || "",
          pickupNumber: "",
        },
        stops: s.stops.length >= 2 ? s.stops : createDefaultBuilderEntry().stops,
        items: s.commodities.length >= 1 ? s.commodities : createDefaultBuilderEntry().items,
        accessorials: [],
        equipment: {
          trailerSize: s.trailerSize || "Full",
          trailerType: s.equip || "53 ft Van | Dry",
          equipmentLength: "53",
          mileage: s.mileage || 0,
          stackable: false,
        },
        pricing: {
          linehaulSell: em?.extractedAmount && em.extractedAmount > s.sell ? em.extractedAmount : s.sell,
          fuelSell: 0,
          linehaulBuy: s.buy,
          fuelBuy: 0,
        },
        carrier: {
          name: em?.extractedCarrier || s.carrier || "",
          mcNumber: s.mc || "",
          serviceLevel: "Normal",
        },
        specialInstructions: "",
        sendToTai: true,
      });
      setReviewEmail(null);
      setLocation("/load-builder");
      showToast(`Loaded #${s.id} (${s.origin} → ${s.dest}) into Compact Builder.`);
    },
    [setLocation, showToast],
  );

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

  if (authGateUrl || authUnavailableMessage) {
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
          {authGateUrl ? (
            <>
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
            </>
          ) : (
            <p className="text-xs leading-relaxed" style={{ color: "var(--pf-text-muted)" }}>
              {authUnavailableMessage}
            </p>
          )}
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
          onDeleteEmail={handleDeleteInboxItem}
          onSaveToCrm={handleSaveSenderToCrm}
        />
      </div>
    );
  }

  const openActionsCount = data.crucialEmails.filter((e) => !e.applied).length;
  const navItems = [
    { path: "/", label: "Crucial Inbox", icon: Inbox, badge: openActionsCount },
    { path: "/dispatch", label: "Unified Dispatch", icon: Layers, badge: data.shipments.length },
    { path: "/load-builder", label: "Compact Builder", icon: PlusCircle, badge: "Fast" },
    { path: "/salesops", label: "SalesOps CRM", icon: Handshake, badge: data.crmLeads?.length ?? 0 },
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
                    .map((em) => {
                      const matchedLoad = em.loadId !== "NEW" ? data.shipments.find((s) => s.id === em.loadId) : undefined;
                      return (
                        <div
                          key={em.id}
                          onClick={() => setReviewEmail(em)}
                          className="p-4 rounded-xl flex flex-col justify-between gap-3 cursor-pointer transition-all hover:border-[#F0641E]"
                          style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
                        >
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between gap-2 text-xs">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                {em.loadId === "NEW" ? (
                                  <span className="font-mono font-bold" style={{ color: "var(--pf-action)" }}>
                                    NEW TENDER
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      openLoadInDispatch(em.loadId);
                                    }}
                                    className="font-mono font-bold underline-offset-2 hover:underline inline-flex items-center gap-1"
                                    style={{ color: "var(--pf-action)" }}
                                    title={`Open Load #${em.loadId} in Unified Dispatch`}
                                  >
                                    <Package size={12} /> LOAD #{em.loadId}
                                  </button>
                                )}
                                {(em.containerNumber || matchedLoad?.containerNumber) && (
                                  <span
                                    className="font-mono text-[10px] px-1.5 py-0.5 rounded font-semibold"
                                    style={{ background: "var(--pf-info-dim)", color: "var(--pf-info)" }}
                                  >
                                    📦 {em.containerNumber || matchedLoad?.containerNumber}
                                  </span>
                                )}
                              </div>
                              <span className="inline-flex items-center gap-1.5 min-w-0">
                                <span className="truncate" style={{ color: "var(--pf-text-subtle)" }}>
                                  {em.from} · {em.received}
                                </span>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDeleteInboxItem(em.id);
                                  }}
                                  className="p-1 rounded shrink-0 hover:opacity-80"
                                  style={{ background: "var(--pf-danger-dim)", color: "var(--pf-danger)" }}
                                  title="Delete email tile"
                                >
                                  <Trash2 size={11} />
                                </button>
                              </span>
                            </div>
                            <div className="text-sm font-semibold leading-snug">{em.subject}</div>
                            {(em.operationalNote || matchedLoad?.operationalNote) && (
                              <div
                                className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold leading-snug"
                                style={{
                                  background: "var(--pf-warning-dim)",
                                  color: "var(--pf-warning)",
                                  border: "1px solid rgba(212,160,74,0.35)",
                                }}
                              >
                                {em.operationalNote || matchedLoad?.operationalNote}
                              </div>
                            )}
                            {matchedLoad && (
                              <div className="text-[11px] font-mono truncate" style={{ color: "var(--pf-primary)" }}>
                                {matchedLoad.customer} · {matchedLoad.origin} → {matchedLoad.dest} · {matchedLoad.stage}
                              </div>
                            )}
                            <p className="text-xs leading-relaxed line-clamp-3" style={{ color: "var(--pf-text-muted)" }}>
                              {em.body}
                            </p>
                          </div>

                          <div className="space-y-2">
                            <div
                              className="p-2 rounded-lg text-xs flex items-center justify-between gap-2"
                              style={{ background: "var(--pf-surface-raised)" }}
                            >
                              <span className="truncate">{em.diffLabel}</span>
                              <strong className="font-mono shrink-0" style={{ color: "var(--pf-primary)" }}>
                                {em.diffValue}
                              </strong>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setReviewEmail(em);
                                }}
                                className="py-2 px-2.5 rounded-lg text-xs font-semibold inline-flex items-center justify-center gap-1.5"
                                style={{
                                  background: "var(--pf-surface-raised)",
                                  color: "var(--pf-text)",
                                  border: "1px solid var(--pf-border)",
                                }}
                              >
                                <Mail size={12} /> Review Email &amp; Load
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleApplyEmailAction(em);
                                }}
                                className="py-2 px-2.5 rounded-lg text-xs font-bold truncate"
                                style={{
                                  background: em.applied ? "var(--pf-primary-dim)" : "var(--pf-action)",
                                  color: em.applied ? "var(--pf-primary)" : "#ffffff",
                                }}
                              >
                                {em.applied ? "✓ Synced" : em.ctaLabel}
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
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
                onSaveNote={handleSaveLoadNote}
                onDeleteLoad={handleDeleteLoad}
                onAskAi={(q) => {
                  handleAskAi(q);
                  setLocation("/ai-assistant");
                }}
              />
            )}

            {/* ROUTE 3B: SALESOPS CRM */}
            {location === "/salesops" && (
              <SalesOpsCrmView
                leads={data.crmLeads || []}
                crmWebhookUrl={data.crmWebhookUrl}
                onAddLead={handleAddCrmLead}
                onBulkImportLeads={handleBulkImportCrmLeads}
                onUpdateLead={handleUpdateCrmLead}
                onDeleteLead={handleDeleteCrmLead}
                onPushLead={handlePushCrmLead}
                onBuildLoadFromLead={buildLoadFromLead}
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

        {/* EMAIL & LOAD SIDE-BY-SIDE REVIEW MODAL */}
        {reviewEmail && (() => {
          const linkedLoad =
            reviewEmail.loadId !== "NEW"
              ? data.shipments.find((s) => s.id === reviewEmail.loadId)
              : undefined;
          const modalContainer = reviewEmail.containerNumber || linkedLoad?.containerNumber;
          const gmailUrl =
            reviewEmail.permalink ||
            `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(
              reviewEmail.loadId !== "NEW" ? reviewEmail.loadId : reviewEmail.subject,
            )}`;
          const containerSearchUrl = modalContainer
            ? buildGmailContainerSearchUrl(modalContainer, reviewEmail.loadId, reviewEmail.subject)
            : null;
          const activeNote = linkedLoad?.operationalNote || reviewEmail.operationalNote;

          return (
            <div
              onClick={() => setReviewEmail(null)}
              className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
            >
              <div
                onClick={(e) => e.stopPropagation()}
                className="max-w-5xl w-full max-h-[90vh] flex flex-col rounded-2xl overflow-hidden shadow-2xl"
                style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
              >
                <div className="pf-brand-rule shrink-0">
                  <div style={{ background: "#1D2C5E" }} />
                  <div style={{ background: "#682C87" }} />
                  <div style={{ background: "#D52A3B" }} />
                  <div style={{ background: "#F0641E" }} />
                  <div style={{ background: "#F5B841" }} />
                </div>

                <div
                  className="px-5 py-3 flex flex-wrap items-center justify-between gap-3 shrink-0"
                  style={{ borderBottom: "1px solid var(--pf-border)" }}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
                      <span
                        className="px-2 py-0.5 rounded font-bold"
                        style={{ background: "var(--pf-primary-dim)", color: "var(--pf-primary)" }}
                      >
                        {reviewEmail.loadId === "NEW" ? "NEW TENDER" : `LOAD #${reviewEmail.loadId}`}
                      </span>
                      {modalContainer && (
                        <span
                          className="px-2 py-0.5 rounded font-bold"
                          style={{ background: "var(--pf-info-dim)", color: "var(--pf-info)" }}
                        >
                          📦 {modalContainer}
                        </span>
                      )}
                      <span style={{ color: "var(--pf-text-muted)" }}>
                        {reviewEmail.senderName ? `${reviewEmail.senderName} <${reviewEmail.from}>` : reviewEmail.from} ·{" "}
                        {reviewEmail.received}
                      </span>
                    </div>
                    <h2 className="text-base font-semibold truncate mt-1">{reviewEmail.subject}</h2>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 flex-wrap">
                    {containerSearchUrl && (
                      <a
                        href={containerSearchUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5"
                        style={{ background: "var(--pf-info-dim)", color: "var(--pf-info)", border: "1px solid var(--pf-border)" }}
                      >
                        <Search size={12} /> Search Container # in Gmail
                      </a>
                    )}
                    <a
                      href={gmailUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5"
                      style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
                    >
                      <ExternalLink size={12} /> Open in Gmail
                    </a>
                    <button
                      type="button"
                      onClick={() => handleSaveSenderToCrm(reviewEmail)}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5"
                      style={{ background: "var(--pf-primary-dim)", color: "var(--pf-primary)" }}
                    >
                      <UserPlus size={12} /> Save to CRM
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteInboxItem(reviewEmail.id)}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5"
                      style={{ background: "var(--pf-danger-dim)", color: "var(--pf-danger)" }}
                    >
                      <Trash2 size={12} /> Delete Tile
                    </button>
                    <button
                      type="button"
                      onClick={() => setReviewEmail(null)}
                      className="p-1.5 rounded-lg"
                      style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
                      title="Close review modal"
                    >
                      <X size={15} />
                    </button>
                  </div>
                </div>

                <div className="p-5 grid lg:grid-cols-12 gap-4 overflow-y-auto pf-scroll">
                  {/* Left 7 Columns: Full Email Body & Container Events */}
                  <div className="lg:col-span-7 space-y-3">
                    {activeNote && (
                      <div
                        className="p-3 rounded-xl text-xs font-semibold"
                        style={{
                          background: "var(--pf-warning-dim)",
                          color: "var(--pf-warning)",
                          border: "1px solid rgba(212,160,74,0.4)",
                        }}
                      >
                        {activeNote}
                      </div>
                    )}

                    <div className="flex flex-wrap gap-2 text-xs font-mono">
                      {reviewEmail.extractedPo && (
                        <span className="px-2.5 py-1 rounded-md" style={{ background: "var(--pf-surface-raised)" }}>
                          PO: <strong style={{ color: "var(--pf-primary)" }}>{reviewEmail.extractedPo}</strong>
                        </span>
                      )}
                      {reviewEmail.extractedAmount && (
                        <span className="px-2.5 py-1 rounded-md" style={{ background: "var(--pf-surface-raised)" }}>
                          Rate: <strong style={{ color: "var(--pf-primary)" }}>${reviewEmail.extractedAmount.toLocaleString()}</strong>
                        </span>
                      )}
                      {reviewEmail.extractedCarrier && (
                        <span className="px-2.5 py-1 rounded-md" style={{ background: "var(--pf-surface-raised)" }}>
                          Carrier: <strong>{reviewEmail.extractedCarrier}</strong>
                        </span>
                      )}
                      {reviewEmail.extractedInvoice && (
                        <span className="px-2.5 py-1 rounded-md" style={{ background: "var(--pf-surface-raised)" }}>
                          Inv: <strong>{reviewEmail.extractedInvoice}</strong>
                        </span>
                      )}
                      {reviewEmail.attachments &&
                        reviewEmail.attachments.map((att, idx) => (
                          <span
                            key={idx}
                            className="px-2.5 py-1 rounded-md"
                            style={{ background: "var(--pf-info-dim)", color: "var(--pf-info)" }}
                          >
                            📎 {att.filename || "attachment"}
                          </span>
                        ))}
                    </div>

                    <div
                      className="p-4 rounded-xl text-xs leading-relaxed whitespace-pre-wrap max-h-[280px] overflow-y-auto pf-scroll"
                      style={{ background: "var(--pf-bg)", border: "1px solid var(--pf-border)" }}
                    >
                      {reviewEmail.fullBody || reviewEmail.body}
                    </div>

                    {/* Container Event Timeline */}
                    {linkedLoad?.containerEvents && linkedLoad.containerEvents.length > 0 && (
                      <div
                        className="p-3.5 rounded-xl space-y-2"
                        style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
                      >
                        <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--pf-text-muted)" }}>
                          All Correlated Events for {modalContainer ? `Container ${modalContainer}` : `Load #${linkedLoad.id}`} ({linkedLoad.containerEvents.length})
                        </div>
                        <div className="space-y-1.5">
                          {linkedLoad.containerEvents.map((ev) => (
                            <div
                              key={ev.id}
                              className="p-2.5 rounded-lg text-xs space-y-0.5"
                              style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span
                                  className="font-mono text-[10px] font-bold uppercase px-1.5 py-0.5 rounded"
                                  style={{
                                    background: ev.kind === "tonu" ? "var(--pf-danger-dim)" : "var(--pf-info-dim)",
                                    color: ev.kind === "tonu" ? "var(--pf-danger)" : "var(--pf-info)",
                                  }}
                                >
                                  {ev.kind}
                                </span>
                                <span className="font-mono text-[10px]" style={{ color: "var(--pf-text-subtle)" }}>
                                  {ev.from} · {ev.timestamp}
                                </span>
                              </div>
                              <div className="font-semibold">{ev.subject}</div>
                              <div style={{ color: "var(--pf-text-muted)" }}>{ev.summary}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Right 5 Columns: Linked Load Review + Inline Exception Note Editor */}
                  <div className="lg:col-span-5 space-y-3">
                    {linkedLoad ? (
                      <div
                        className="p-4 rounded-xl space-y-3"
                        style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-xs font-bold" style={{ color: "var(--pf-action)" }}>
                            LINKED LOAD #{linkedLoad.id}
                          </span>
                          <span
                            className="px-2 py-0.5 rounded-full text-[11px] font-semibold"
                            style={{ background: "var(--pf-info-dim)", color: "var(--pf-info)" }}
                          >
                            {linkedLoad.stage} · {linkedLoad.rawStatus}
                          </span>
                        </div>

                        <div>
                          <div className="text-sm font-semibold">{linkedLoad.customer}</div>
                          <div className="text-xs font-medium mt-0.5" style={{ color: "var(--pf-text-muted)" }}>
                            {linkedLoad.origin} → {linkedLoad.dest}
                          </div>
                        </div>

                        <div
                          className="p-2.5 rounded-lg grid grid-cols-2 gap-2 text-xs font-mono"
                          style={{ background: "var(--pf-surface)" }}
                        >
                          <div>
                            <div className="text-[10px]" style={{ color: "var(--pf-text-subtle)" }}>
                              DATES
                            </div>
                            <div>
                              {linkedLoad.shipDate} → {linkedLoad.delivDate}
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px]" style={{ color: "var(--pf-text-subtle)" }}>
                              EQUIPMENT / WT
                            </div>
                            <div className="truncate">{linkedLoad.equip}</div>
                          </div>
                          <div>
                            <div className="text-[10px]" style={{ color: "var(--pf-text-subtle)" }}>
                              SELL / BUY / MGN
                            </div>
                            <div>
                              ${linkedLoad.sell.toLocaleString()} / ${linkedLoad.buy.toLocaleString()}
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px]" style={{ color: "var(--pf-text-subtle)" }}>
                              CONTAINER / POD
                            </div>
                            <div>
                              {linkedLoad.containerNumber || linkedLoad.po || "—"} · {linkedLoad.podCount} POD
                            </div>
                          </div>
                        </div>

                        <div className="text-xs space-y-1">
                          <div>
                            <strong style={{ color: "var(--pf-text-muted)" }}>Carrier:</strong>{" "}
                            {linkedLoad.carrier || "Unassigned"}
                          </div>
                          <div>
                            <strong style={{ color: "var(--pf-text-muted)" }}>BOL / Ref:</strong>{" "}
                            <span className="font-mono">{linkedLoad.bol || "—"}</span>
                          </div>
                          <div>
                            <strong style={{ color: "var(--pf-text-muted)" }}>Location:</strong> {linkedLoad.location}
                          </div>
                          <div className="font-mono text-[11px]" style={{ color: "var(--pf-primary)" }}>
                            {linkedLoad.writebackState}
                          </div>
                        </div>

                        {/* Operational Note & Paste Container Email Extractor */}
                        <div className="p-2.5 rounded-lg space-y-2" style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}>
                          <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--pf-text-muted)" }}>
                            Operational Note / Paste Container Email
                          </div>
                          <textarea
                            rows={2}
                            value={pasteEmailDraft || noteDraft}
                            onChange={(e) => setPasteEmailDraft(e.target.value)}
                            placeholder="Paste email about CAAU724710-0 / forklift breakdown / TONU, or type an operational note…"
                            className="pf-input"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const txt = (pasteEmailDraft || noteDraft).trim();
                              if (!txt) return;
                              handleSaveLoadNote(linkedLoad.id, {
                                pastedEmailText: txt,
                                containerNumber: modalContainer || undefined,
                              });
                            }}
                            className="w-full py-1.5 px-2.5 rounded-lg text-xs font-semibold"
                            style={{ background: "var(--pf-primary)", color: "var(--pf-primary-fg)" }}
                          >
                            Extract Container # &amp; Save Exception Note
                          </button>
                        </div>

                        <div className="space-y-2 pt-1">
                          <button
                            type="button"
                            onClick={() => handleApplyEmailAction(reviewEmail)}
                            className="w-full py-2 px-3 rounded-lg text-xs font-bold"
                            style={{
                              background: reviewEmail.applied ? "var(--pf-primary-dim)" : "var(--pf-action)",
                              color: reviewEmail.applied ? "var(--pf-primary)" : "#ffffff",
                            }}
                          >
                            {reviewEmail.applied ? "✓ Email Update Synced" : reviewEmail.ctaLabel}
                          </button>
                          <button
                            type="button"
                            onClick={() => openLoadInDispatch(linkedLoad.id)}
                            className="w-full py-2 px-3 rounded-lg text-xs font-semibold"
                            style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
                          >
                            ⇄ Open Full Load #{linkedLoad.id} in Unified Dispatch
                          </button>
                          <button
                            type="button"
                            onClick={() => loadShipmentIntoBuilder(linkedLoad, reviewEmail)}
                            className="w-full py-2 px-3 rounded-lg text-xs font-semibold"
                            style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
                          >
                            + Copy Load to Compact Builder
                          </button>
                        </div>
                      </div>
                    ) : reviewEmail.loadId === "NEW" ? (
                      <div
                        className="p-4 rounded-xl space-y-3"
                        style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
                      >
                        <div className="font-mono text-xs font-bold" style={{ color: "var(--pf-action)" }}>
                          UNBOOKED CUSTOMER TENDER
                        </div>
                        <p className="text-xs leading-relaxed" style={{ color: "var(--pf-text-muted)" }}>
                          Ready to extract stops, origin/destination ZIPs, piece counts, weights, and commodity descriptions into the TAI Compact Load Builder.
                        </p>
                        <button
                          type="button"
                          onClick={() => handleApplyEmailAction(reviewEmail)}
                          className="w-full py-2 px-3 rounded-lg text-xs font-bold"
                          style={{ background: "var(--pf-action)", color: "#ffffff" }}
                        >
                          + Extract to Compact Load Builder
                        </button>
                      </div>
                    ) : (
                      <div
                        className="p-4 rounded-xl space-y-3"
                        style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
                      >
                        <div className="font-mono text-xs font-bold" style={{ color: "var(--pf-action)" }}>
                          LOAD #{reviewEmail.loadId}
                        </div>
                        <p className="text-xs" style={{ color: "var(--pf-text-muted)" }}>
                          Search this shipment in Unified Dispatch or apply the extracted update directly.
                        </p>
                        <button
                          type="button"
                          onClick={() => handleApplyEmailAction(reviewEmail)}
                          className="w-full py-2 px-3 rounded-lg text-xs font-bold"
                          style={{ background: "var(--pf-action)", color: "#ffffff" }}
                        >
                          {reviewEmail.applied ? "✓ Applied" : reviewEmail.ctaLabel}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const id = reviewEmail.loadId;
                            setReviewEmail(null);
                            setSearchQuery(id);
                            setLocation("/dispatch");
                          }}
                          className="w-full py-2 px-3 rounded-lg text-xs font-semibold"
                          style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
                        >
                          ↗ Search #{reviewEmail.loadId} in Unified Dispatch
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

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
              onDeleteEmail={handleDeleteInboxItem}
              onSaveToCrm={handleSaveSenderToCrm}
            />
          </div>
        )}
      </div>
    </div>
  );
};
