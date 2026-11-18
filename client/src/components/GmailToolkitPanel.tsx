import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { LoadEntry } from "@shared/load-entry";
import type {
  CarrierOption,
  CrmLeadItem,
  CrucialEmailItem,
  CustomerOption,
  OpsKpis,
  OpsShipment,
  SavedFacility,
} from "@shared/tai-webhook-schema";
import { AllLoadsView } from "./panel/AllLoadsView";
import { AttentionView } from "./panel/AttentionView";
import { BolGeneratorView } from "./panel/BolGeneratorView";
import { DispatchBoardView } from "./panel/DispatchBoardView";
import { AiAssistantView, ApEmailsView, CheckEmailView } from "./panel/EmailAndAiViews";
import {
  captureGmailThread,
  getPanelPref,
  setPanelPref,
  subscribeGmailThreadContext,
  type CapturedGmailThread,
} from "./panel/extensionBridge";
import { HomeLauncherView } from "./panel/HomeLauncherView";
import { LoadBuilderPanelView } from "./panel/LoadBuilderPanelView";
import { fetchPanelSession, panelFetchJson, type PanelApiContext } from "./panel/panelApi";
import {
  clampPanelZoom,
  isApTaskResolved,
  normalizeApTaskRecord,
  parsePanelViewParam,
  syncPanelUrlView,
  type ApTaskRecord,
  type PanelKnowledgeRule,
  type PanelSavedDraft,
  type PanelSessionInfo,
  type PanelViewId,
  type QuoteDraftState,
} from "./panel/panelTypes";
import { PanelTopBar } from "./panel/PanelTopBar";
import { PodFilesView } from "./panel/PodFilesView";
import { QuoteBuilderView } from "./panel/QuoteBuilderView";
import { RatesView } from "./panel/RatesView";
import { SalesPanelView } from "./panel/SalesPanelView";
import { ToolsView } from "./panel/ToolsView";

export interface GmailToolkitPanelProps {
  fullScreen?: boolean;
  shipments: OpsShipment[];
  crucialEmails: CrucialEmailItem[];
  facilities: SavedFacility[];
  customers: CustomerOption[];
  carriers: CarrierOption[];
  crmLeads?: CrmLeadItem[];
  kpis?: OpsKpis | null;
  bootstrapUser?: { email: string; name: string; mode?: string } | null;
  isLiveSync?: boolean;
  builderEntry: LoadEntry;
  onBuilderChange: (next: LoadEntry) => void;
  onApplyEmailAction: (email: CrucialEmailItem) => Promise<void>;
  onBooked: (ids: string[], msg: string) => void;
  onToast: (msg: string, kind?: "ok" | "error") => void;
  onExtractTender: () => void;
  chatHistory: Array<{ role: "user" | "assistant"; text: string }>;
  onAskAi: (q: string) => Promise<void>;
  onDeleteEmail?: (id: string) => Promise<void>;
  onSaveToCrm?: (email: CrucialEmailItem) => Promise<void>;
  /** Opens the host's file picker; the POD is streamed through the server to TAI (key stays server-side). */
  onUploadPod?: (shipmentId: string) => void;
  onRefresh?: () => Promise<void>;
  onOpenDashboardLoad?: (shipmentId: string) => void;
}

function createInitialQuoteState(entry: LoadEntry): QuoteDraftState {
  const pick = entry.stops[0];
  const drop = entry.stops[entry.stops.length - 1];
  const validDate = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  return {
    customerName: entry.customer.name || "Larkin Refractory Solutions",
    contactEmail: entry.customer.email || "",
    origin: pick ? `${pick.city}, ${pick.state} ${pick.zipCode}`.trim() : "Beaver Falls, PA 15010",
    destination: drop ? `${drop.city}, ${drop.state} ${drop.zipCode}`.trim() : "Lithonia, GA 30058",
    equipmentType: entry.equipment.trailerType || "48 ft Flatbed | Tarp",
    estMiles: entry.equipment.mileage || 648,
    linehaulRate: entry.pricing.linehaulSell || 3050,
    fuelSurcharge: entry.pricing.fuelSell || 0,
    accessorials: entry.accessorials.map((a, idx) => ({
      id: `init-acc-${idx}`,
      name: a.name,
      amount: a.sell || 0,
    })),
    transitNote: "Next-day / 2-day direct FTL transit",
    validUntil: validDate,
    equipmentNotes: entry.specialInstructions || "Includes 8ft tarps | 2 hrs free load/unload",
  };
}

export const GmailToolkitPanel: React.FC<GmailToolkitPanelProps> = ({
  fullScreen = false,
  shipments,
  crucialEmails,
  facilities,
  customers,
  carriers,
  crmLeads = [],
  kpis = null,
  bootstrapUser = null,
  isLiveSync = false,
  builderEntry,
  onBuilderChange,
  onApplyEmailAction,
  onBooked,
  onToast,
  onExtractTender,
  chatHistory,
  onAskAi,
  onUploadPod,
  onRefresh,
  onOpenDashboardLoad,
}) => {
  const [view, setView] = useState<PanelViewId>(() => parsePanelViewParam() || "home");
  const [universalQuery, setUniversalQuery] = useState<string>("");
  const [expandedLoadId, setExpandedLoadId] = useState<string | null>(shipments[0]?.id ?? null);
  const [bolTargetId, setBolTargetId] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number>(100);
  const [refreshing, setRefreshing] = useState<boolean>(false);

  const [session, setSession] = useState<PanelSessionInfo | null>(null);
  const [accountDriftWarning, setAccountDriftWarning] = useState<string | null>(null);
  const [taiPortalUrl, setTaiPortalUrl] = useState<string>("");

  const [liveThread, setLiveThread] = useState<CapturedGmailThread | null>(null);
  const [panelNotice, setPanelNotice] = useState<{ text: string; kind: "ok" | "error" } | null>(null);

  const [savedDrafts, setSavedDrafts] = useState<PanelSavedDraft[]>([]);
  const [knowledgeRules, setKnowledgeRules] = useState<PanelKnowledgeRule[]>([]);
  const [learnedCount, setLearnedCount] = useState<number>(0);
  const [apTasks, setApTasks] = useState<ApTaskRecord[]>([]);
  const [quoteDraft, setQuoteDraft] = useState<QuoteDraftState>(() => createInitialQuoteState(builderEntry));

  const notify = useCallback(
    (msg: string, kind: "ok" | "error" = "ok") => {
      setPanelNotice({ text: msg, kind });
      onToast(msg, kind);
    },
    [onToast],
  );

  const navigateView = useCallback(
    (next: PanelViewId) => {
      setView(next);
      syncPanelUrlView(next, fullScreen);
    },
    [fullScreen],
  );

  // Sync browser back/forward ?view= changes
  useEffect(() => {
    const onPopState = () => {
      const parsed = parsePanelViewParam();
      if (parsed) setView(parsed);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Hydrate persisted pf_panel_zoom preference
  useEffect(() => {
    let mounted = true;
    void (async () => {
      const savedZoom = await getPanelPref("pf_panel_zoom", 100);
      if (mounted) {
        setZoom(clampPanelZoom(savedZoom));
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const applyZoom = useCallback((nextRaw: number) => {
    const clamped = clampPanelZoom(nextRaw);
    setZoom(clamped);
    void setPanelPref("pf_panel_zoom", clamped);
  }, []);

  // Keyboard shortcuts: Ctrl+Plus, Ctrl+Minus, Ctrl+0
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        applyZoom(zoom + 5);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        applyZoom(zoom - 5);
      } else if (e.key === "0") {
        e.preventDefault();
        applyZoom(100);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [zoom, applyZoom]);

  const apiCtx = useMemo<PanelApiContext>(
    () => ({
      expectedEmail: session?.user?.email || bootstrapUser?.email,
      csrfToken: session?.csrfToken,
      onAccountChanged: (msg) => setAccountDriftWarning(msg),
    }),
    [session, bootstrapUser],
  );

  const loadPanelMemoryAndTasks = useCallback(async () => {
    try {
      const [sess, draftsRes, knowRes, apRes, taiStatusRes] = await Promise.all([
        fetchPanelSession(),
        panelFetchJson<{ ok?: boolean; drafts?: PanelSavedDraft[] }>("/api/panel/drafts", { method: "GET" }, apiCtx),
        panelFetchJson<{ ok?: boolean; rules?: PanelKnowledgeRule[]; learnedCount?: number }>(
          "/api/panel/knowledge",
          { method: "GET" },
          apiCtx,
        ),
        panelFetchJson<{ ok?: boolean; tasks?: Array<Record<string, unknown>> }>(
          "/api/panel/ap-tasks",
          { method: "GET" },
          apiCtx,
        ),
        panelFetchJson<{ ok?: boolean; baseUrl?: string }>("/api/tai/booking/status", { method: "GET" }, apiCtx),
      ]);

      if (sess) {
        setSession(sess);
        setAccountDriftWarning(null);
      }
      if (draftsRes.ok && Array.isArray(draftsRes.data.drafts)) {
        setSavedDrafts(draftsRes.data.drafts);
      }
      if (knowRes.ok) {
        const rules = Array.isArray(knowRes.data.rules) ? knowRes.data.rules : [];
        setKnowledgeRules(rules);
        setLearnedCount(typeof knowRes.data.learnedCount === "number" ? knowRes.data.learnedCount : rules.length);
      }
      if (apRes.ok && Array.isArray(apRes.data.tasks)) {
        setApTasks(apRes.data.tasks.map((t) => normalizeApTaskRecord(t, shipments)));
      }
      if (taiStatusRes.ok && typeof taiStatusRes.data.baseUrl === "string") {
        setTaiPortalUrl(taiStatusRes.data.baseUrl);
      }
    } catch {
      // Keep graceful local state when offline or warming up
    }
  }, [apiCtx, shipments]);

  useEffect(() => {
    void loadPanelMemoryAndTasks();
  }, []);

  // Subscribe to passive Gmail thread context notifications from extension wrapper
  useEffect(() => {
    return subscribeGmailThreadContext((ctx) => {
      setLiveThread((prev) => ({
        subject: ctx.subject ?? prev?.subject ?? "",
        sender: ctx.sender ?? prev?.sender ?? "",
        timestamp: ctx.timestamp ?? prev?.timestamp ?? "",
        bodyText: ctx.bodyText ?? prev?.bodyText ?? "",
        permalink: ctx.permalink ?? prev?.permalink ?? "",
        attachments: ctx.attachments ?? prev?.attachments ?? [],
      }));
    });
  }, []);

  const handleRefreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([onRefresh?.(), loadPanelMemoryAndTasks()]);
      notify("Refreshed live shipments, exceptions & staff session");
    } finally {
      setRefreshing(false);
    }
  }, [onRefresh, loadPanelMemoryAndTasks, notify]);

  const handleInspectLoad = useCallback(
    (shipmentId: string, targetView: "dispatch" | "all-loads" = "dispatch") => {
      setExpandedLoadId(shipmentId);
      navigateView(targetView);
    },
    [navigateView],
  );

  const handleQuickCaptureToBuilder = useCallback(async () => {
    const cap = await captureGmailThread();
    if (cap.ok && cap.thread) {
      setLiveThread(cap.thread);
      const { ok, data } = await panelFetchJson<{ ok?: boolean; entry?: LoadEntry; summary?: string }>(
        "/api/extract-email",
        {
          method: "POST",
          body: JSON.stringify({
            subject: cap.thread.subject,
            sender: cap.thread.sender,
            bodyText: cap.thread.bodyText,
          }),
        },
        apiCtx,
      );
      if (ok && data.entry) {
        onBuilderChange(data.entry);
        notify(data.summary || "Extracted open Gmail thread into Load Builder");
      }
    }
    navigateView("build-load");
  }, [apiCtx, navigateView, notify, onBuilderChange]);

  // Compute live Attention count across all 4 alert sections + AP load checks
  const attentionCount = useMemo(() => {
    const uncovered = shipments.filter((s) => s.stage === "Needs truck" || !s.carrier.trim()).length;
    const mismatches = shipments.filter((s) => Boolean(s.mismatchNote) || !s.po.trim()).length;
    const missingPods = shipments.filter((s) => s.stage === "Delivered" && s.podCount === 0).length;
    const containerAlerts = shipments.filter((s) => Boolean(s.operationalNote)).length;
    const unappliedEmails = crucialEmails.filter((e) => !e.applied).length;
    const openAp = apTasks.filter((t) => !isApTaskResolved(t.status)).length;
    return uncovered + mismatches + missingPods + containerAlerts + unappliedEmails + openAp;
  }, [shipments, crucialEmails, apTasks]);

  const openApCount = useMemo(
    () => apTasks.filter((t) => !isApTaskResolved(t.status)).length || (kpis?.openApTasks ?? 0),
    [apTasks, kpis],
  );

  return (
    <div
      data-theme="dark"
      className="tk-panel h-full w-full flex flex-col overflow-hidden"
    >
      <PanelTopBar
        view={view}
        onNavigate={navigateView}
        shipments={shipments}
        onInspectLoad={handleInspectLoad}
        universalQuery={universalQuery}
        onUniversalQueryChange={setUniversalQuery}
        zoom={zoom}
        onZoomStep={(delta) => applyZoom(zoom + delta)}
        onZoomReset={() => applyZoom(100)}
        refreshing={refreshing}
        onRefreshAll={() => void handleRefreshAll()}
        session={session}
        fallbackUser={bootstrapUser}
        attentionCount={attentionCount}
        openApCount={openApCount}
        liveThreadSubject={liveThread?.subject || ""}
        onQuickCaptureThread={() => void handleQuickCaptureToBuilder()}
      />

      {/* Cross-Tab Google Workspace Account Drift Warning */}
      {accountDriftWarning && (
        <div
          role="alert"
          className="px-3 py-2 text-[11px] flex items-center justify-between gap-2 shrink-0"
          style={{ background: "#3a1a1a", color: "#fca5a5", borderBottom: "1px solid #6b2a2a" }}
        >
          <span className="truncate">⚠ {accountDriftWarning}</span>
          <a href="/auth/google" className="underline font-bold shrink-0">
            Reconnect
          </a>
        </div>
      )}

      {/* Subtle Toast Strip inside Standalone Panel */}
      {fullScreen && panelNotice && (
        <div
          className="px-3 py-2 text-xs flex items-center justify-between gap-2 shrink-0"
          style={
            panelNotice.kind === "error"
              ? { background: "#2d1619", color: "#fca5a5", borderBottom: "1px solid #5c2429" }
              : { background: "#122b20", color: "#8ce6b8", borderBottom: "1px solid #21523b" }
          }
        >
          <span className="truncate">
            {panelNotice.kind === "error" ? "✕" : "✓"} {panelNotice.text}
          </span>
          <button type="button" onClick={() => setPanelNotice(null)} className="opacity-75 hover:opacity-100">
            ×
          </button>
        </div>
      )}

      {/* Zoom-Scaled Scrollable Workspace (reflows cleanly with zero horizontal overflow) */}
      <div
        className="flex-1 overflow-y-auto overflow-x-hidden pf-scroll px-3.5 py-3.5"
        style={{ zoom: zoom / 100 }}
      >
        <div className={fullScreen ? "max-w-2xl mx-auto w-full" : "w-full"}>
          {view === "home" && (
            <HomeLauncherView
              onNavigate={navigateView}
              attentionCount={attentionCount}
              shipments={shipments}
              customers={customers}
              facilities={facilities}
              kpis={kpis}
              taiPortalUrl={taiPortalUrl}
            />
          )}

          {view === "attention" && (
            <AttentionView
              shipments={shipments}
              crucialEmails={crucialEmails}
              apTasks={apTasks}
              onInspectLoad={handleInspectLoad}
              onApplyEmailAction={onApplyEmailAction}
              onUploadPod={onUploadPod}
              onExtractTenderToBuilder={onExtractTender}
              onNavigate={navigateView}
            />
          )}

          {view === "dispatch" && (
            <DispatchBoardView
              shipments={shipments}
              carriers={carriers}
              expandedId={expandedLoadId}
              onExpandChange={setExpandedLoadId}
              apiCtx={apiCtx}
              onRefresh={async () => {
                await onRefresh?.();
              }}
              onToast={notify}
              onUploadPod={onUploadPod}
              onOpenBol={(shipmentId) => {
                setBolTargetId(shipmentId);
                navigateView("tools-bol");
              }}
              onOpenDashboardLoad={onOpenDashboardLoad}
              isLiveSync={isLiveSync}
            />
          )}

          {view === "all-loads" && (
            <AllLoadsView
              shipments={shipments}
              universalQuery={universalQuery}
              expandedId={expandedLoadId}
              onExpandChange={setExpandedLoadId}
              apiCtx={apiCtx}
              onRefresh={async () => {
                await onRefresh?.();
              }}
              onToast={notify}
              onUploadPod={onUploadPod}
              onOpenBol={(shipmentId) => {
                setBolTargetId(shipmentId);
                navigateView("tools-bol");
              }}
              onCopyToBuilder={onBuilderChange}
              onNavigate={navigateView}
            />
          )}

          {view === "rates" && (
            <RatesView
              shipments={shipments}
              builderEntry={builderEntry}
              onBuilderChange={onBuilderChange}
              onSendToQuote={(patch) => setQuoteDraft((prev) => ({ ...prev, ...patch }))}
              onNavigate={navigateView}
              apiCtx={apiCtx}
              onToast={notify}
            />
          )}

          {view === "tools" && (
            <ToolsView
              builderEntry={builderEntry}
              onBuilderChange={onBuilderChange}
              onNavigate={navigateView}
              onToast={notify}
            />
          )}

          {view === "sales" && (
            <SalesPanelView
              leads={crmLeads}
              builderEntry={builderEntry}
              onBuilderChange={onBuilderChange}
              apiCtx={apiCtx}
              onRefresh={async () => {
                await onRefresh?.();
              }}
              onToast={notify}
              onNavigate={navigateView}
            />
          )}

          {view === "build-load" && (
            <LoadBuilderPanelView
              compact={!fullScreen}
              entry={builderEntry}
              onChange={onBuilderChange}
              facilities={facilities}
              customers={customers}
              carriers={carriers}
              savedDrafts={savedDrafts}
              knowledgeRules={knowledgeRules}
              learnedCount={learnedCount}
              onRefreshMemory={loadPanelMemoryAndTasks}
              onRefreshBootstrap={async () => {
                await onRefresh?.();
              }}
              onBooked={(ids, msg) => {
                notify(msg, "ok");
                onBooked(ids, msg);
                if (ids[0]) setExpandedLoadId(ids[0]);
                navigateView("dispatch");
              }}
              onToast={notify}
              onExtractSampleTender={onExtractTender}
              onNavigate={navigateView}
              liveThread={liveThread}
              onThreadCaptured={setLiveThread}
              apiCtx={apiCtx}
            />
          )}

          {view === "tools-bol" && (
            <BolGeneratorView
              shipments={shipments}
              builderEntry={builderEntry}
              initialShipmentId={bolTargetId}
              apiCtx={apiCtx}
              onToast={notify}
            />
          )}

          {view === "quote-builder" && (
            <QuoteBuilderView
              quote={quoteDraft}
              onQuoteChange={setQuoteDraft}
              builderEntry={builderEntry}
              onBuilderChange={onBuilderChange}
              onNavigate={navigateView}
              onToast={notify}
            />
          )}

          {view === "pod" && (
            <PodFilesView
              shipments={shipments}
              onUploadPod={onUploadPod}
              onRefresh={async () => {
                await onRefresh?.();
              }}
              onToast={notify}
              onInspectLoad={(id) => handleInspectLoad(id, "dispatch")}
            />
          )}

          {view === "check-email" && (
            <CheckEmailView
              shipments={shipments}
              crucialEmails={crucialEmails}
              liveThread={liveThread}
              onThreadCaptured={setLiveThread}
              onInspectLoad={handleInspectLoad}
              onNavigate={navigateView}
              apiCtx={apiCtx}
              onToast={notify}
            />
          )}

          {view === "ai-assistant" && (
            <AiAssistantView
              chatHistory={chatHistory}
              onAskAi={onAskAi}
              onToast={notify}
            />
          )}

          {view === "ap-tasks" && (
            <ApEmailsView
              tasks={apTasks}
              onRefreshTasks={loadPanelMemoryAndTasks}
              onInspectLoad={handleInspectLoad}
              apiCtx={apiCtx}
              onToast={notify}
            />
          )}
        </div>
      </div>
    </div>
  );
};
