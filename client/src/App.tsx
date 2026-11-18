import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import type { LoadEntry } from "@shared/load-entry";
import { isHiddenCustomer, type BootstrapPayload, type CrmLeadItem, type CrucialEmailItem, type OpsShipment } from "@shared/tai-webhook-schema";
import { buildGmailContainerSearchUrl } from "@shared/container-extractor";
import { POD_FILE_ACCEPT, podMimeTypeForFile } from "./lib/pod-file";
import { CompactLoadBuilder } from "./components/CompactLoadBuilder";
import { UnifiedDispatchView } from "./components/UnifiedDispatchView";
import { GmailToolkitPanel } from "./components/GmailToolkitPanel";
import { captureGmailInbox, openEmailInGmail } from "./components/panel/extensionBridge";
import { isStandalonePanelLocation, type LiveCrucialEmail } from "./components/panel/panelTypes";
import { SalesOpsCrmView } from "./components/SalesOpsCrmView";
import {
  Activity,
  Bot,
  CheckCircle2,
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
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Sun,
  Trash2,
  UserPlus,
  X,
  Zap,
} from "lucide-react";

function createDefaultBuilderEntry(): LoadEntry {
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  return {
    shipmentType: "Truckload",
    status: "Committed",
    customer: {
      name: "",
      taiOrganizationId: "",
    },
    references: {
      customerPO: "",
      bolNumber: "",
      invoiceRef: "",
      carrierProNumber: "",
      pickupNumber: "",
    },
    stops: [
      {
        stopType: "First Pickup",
        companyName: "",
        streetAddress: "",
        city: "",
        state: "",
        zipCode: "",
        country: "USA",
        contactName: "",
        phone: "",
        instructions: "",
        readyDate: today,
        timeOpen: "08:00",
        timeClose: "15:00",
        appointmentRequired: false,
        savedFacilityMatched: false,
      },
      {
        stopType: "Last Drop",
        companyName: "",
        streetAddress: "",
        city: "",
        state: "",
        zipCode: "",
        country: "USA",
        contactName: "",
        phone: "",
        instructions: "",
        readyDate: tomorrow,
        timeOpen: "09:00",
        timeClose: "16:00",
        appointmentRequired: false,
        savedFacilityMatched: false,
      },
    ],
    items: [
      {
        description: "General Freight",
        packagingType: "Pallet",
        handlingQuantity: 1,
        piecesTotal: 1,
        weightTotal: 0,
        hazardousMaterial: false,
        freightClass: "No Class",
        referenceNumber: "",
      },
    ],
    accessorials: [],
    equipment: {
      trailerSize: "Full",
      trailerType: "53 ft Van | Dry",
      equipmentLength: "53",
      mileage: 0,
      stackable: false,
    },
    pricing: {
      linehaulSell: 0,
      fuelSell: 0,
      linehaulBuy: 0,
      fuelBuy: 0,
    },
    carrier: {
      name: "",
      serviceLevel: "Normal",
    },
    specialInstructions: "",
    sendToTai: true,
  };
}

export const App: React.FC = () => {
  const [location, setLocation] = useLocation();
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [dockToolkit, setDockToolkit] = useState<boolean>(true);
  const [data, setData] = useState<BootstrapPayload | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedLoadId, setExpandedLoadId] = useState<string | null>(null);
  const [inboxFilter, setInboxFilter] = useState<string>("all");
  const [toast, setToast] = useState<string | null>(null);
  const [toastKind, setToastKind] = useState<"ok" | "error">("ok");
  const [builderEntry, setBuilderEntry] = useState<LoadEntry>(() => createDefaultBuilderEntry());
  const [reviewEmail, setReviewEmail] = useState<CrucialEmailItem | null>(null);
  const [reviewPoDraft, setReviewPoDraft] = useState("");
  const [reviewSellDraft, setReviewSellDraft] = useState("");
  const [reviewBuyDraft, setReviewBuyDraft] = useState("");
  const [reviewNoteDraft, setReviewNoteDraft] = useState("");
  const [reviewExtractedEntry, setReviewExtractedEntry] = useState<LoadEntry | null>(null);
  const [extractingModal, setExtractingModal] = useState(false);
  const [savingModalUpdate, setSavingModalUpdate] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [pasteEmailDraft, setPasteEmailDraft] = useState("");
  const [authGateUrl, setAuthGateUrl] = useState<string | null>(null);
  const [selectedAiEmailId, setSelectedAiEmailId] = useState<string>("none");
  const [aiSending, setAiSending] = useState(false);
  const [chatHistory, setChatHistory] = useState<Array<{ role: "user" | "assistant"; text: string }>>([
    {
      role: "assistant",
      text: "Connected to live TAI & Supabase operations data. Ask about any customer, carrier MC/setup status, uncovered shipments, historical lane runners, or attach an inbox email.",
    },
  ]);
  const [aiDraft, setAiDraft] = useState("");
  const [liveInboxItems, setLiveInboxItems] = useState<LiveCrucialEmail[]>([]);
  const [syncingInbox, setSyncingInbox] = useState(false);

  const showToast = useCallback((msg: string, kind: "ok" | "error" = "ok") => {
    setToastKind(kind);
    setToast(msg);
  }, []);

  const refreshInboxStream = useCallback(async () => {
    try {
      const res = await fetch("/api/inbox", { credentials: "include" });
      if (!res.ok) return;
      const json = (await res.json()) as { items?: LiveCrucialEmail[]; emails?: LiveCrucialEmail[] };
      const rows = json.items || json.emails;
      if (Array.isArray(rows)) {
        setLiveInboxItems(rows);
      }
    } catch {
      // Keep bootstrap inbox fallback
    }
  }, []);

  const refreshBootstrap = useCallback(async () => {
    const res = await fetch("/api/bootstrap", { credentials: "include" });
    if (res.status === 401) {
      const errJson = (await res.json().catch(() => ({}))) as { loginUrl?: string };
      const returnPath = `${window.location.pathname}${window.location.search}`;
      setAuthGateUrl(errJson.loginUrl || `/auth/google?returnTo=${encodeURIComponent(returnPath)}`);
      return;
    }
    setAuthGateUrl(null);
    const json = (await res.json()) as BootstrapPayload;
    if (json && Array.isArray(json.shipments)) {
      json.shipments = json.shipments.filter((s) => !isHiddenCustomer(s.customer));
    }
    if (json && Array.isArray(json.customers)) {
      json.customers = json.customers.filter((c) => !isHiddenCustomer(c.name));
    }
    setData(json);
  }, []);

  const handleSyncDashboardInbox = useCallback(async () => {
    setSyncingInbox(true);
    try {
      const cap = await captureGmailInbox();
      if (cap.ok && cap.items.length > 0) {
        await fetch("/api/inbox/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ items: cap.items }),
        }).catch(() => {});
      }
      let syncRes = await fetch("/api/inbox/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      if (syncRes.status === 404) {
        syncRes = await fetch("/api/inbox/sync-gmail", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
        });
      }
      const syncOut = (await syncRes.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        ingested?: number;
        count?: number;
      };
      await Promise.all([refreshInboxStream(), refreshBootstrap()]);
      const syncedCount = syncOut.ingested ?? syncOut.count ?? cap.items.length;
      showToast(
        syncOut.message ||
          (syncedCount > 0
            ? `Synced ${syncedCount} Gmail message(s) into Live Operations Inbox`
            : "Refreshed Live Gmail & Supabase Inbox stream"),
      );
    } catch (err) {
      showToast(`Inbox sync error: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setSyncingInbox(false);
    }
  }, [refreshBootstrap, refreshInboxStream, showToast]);

  useEffect(() => {
    void refreshBootstrap();
    void refreshInboxStream();
    const params = new URLSearchParams(window.location.search);
    const targetLoad = params.get("load");
    if (targetLoad) {
      setExpandedLoadId(targetLoad);
    }
  }, [refreshBootstrap, refreshInboxStream]);

  // Live SSE listener for Supabase Realtime, Inbound TAI Webhooks & Extension Inbox Sync
  useEffect(() => {
    if (authGateUrl) return;
    const es = new EventSource("/api/events");
    const onLiveUpdate = () => {
      refreshBootstrap().catch(() => {});
    };
    const onInboxUpdate = () => {
      refreshInboxStream().catch(() => {});
      refreshBootstrap().catch(() => {});
    };
    es.addEventListener("shipment_updated", onLiveUpdate);
    es.addEventListener("shipment_booked", onLiveUpdate);
    es.addEventListener("writeback_verified", onLiveUpdate);
    es.addEventListener("invoice_updated", onLiveUpdate);
    es.addEventListener("crm_updated", onLiveUpdate);
    es.addEventListener("inbox_updated", onInboxUpdate);
    return () => es.close();
  }, [authGateUrl, refreshBootstrap, refreshInboxStream]);

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

  // Streams the chosen file through the server (never the TAI key to the browser); only a TAI read-back marks it verified.
  const handleUploadPod = useCallback(
    async (shipmentId: string, file: File) => {
      const mimeType = podMimeTypeForFile(file);
      if (!mimeType) {
        showToast("Only PDF or JPEG POD files can be uploaded to TAI.", "error");
        return;
      }
      showToast(`Uploading ${file.name} to TAI for #${shipmentId}…`);
      let res: Response;
      try {
        res = await fetch(`/api/loads/${encodeURIComponent(shipmentId)}/pod?fileName=${encodeURIComponent(file.name)}`, {
          method: "POST",
          headers: { "Content-Type": mimeType },
          body: file,
        });
      } catch (err) {
        showToast(`POD upload failed before reaching the server: ${err instanceof Error ? err.message : String(err)}`, "error");
        return;
      }
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      const verified = res.ok && out.ok === true;
      showToast(
        out.message || (verified ? `POD verified in TAI on #${shipmentId}` : `POD upload failed (HTTP ${res.status})`),
        verified ? "ok" : "error",
      );
      if (verified) await refreshBootstrap();
    },
    [refreshBootstrap, showToast],
  );

  const podFileInputRef = useRef<HTMLInputElement | null>(null);
  const podFileTargetRef = useRef<string | null>(null);
  const promptPodUpload = useCallback((shipmentId: string) => {
    podFileTargetRef.current = shipmentId;
    podFileInputRef.current?.click();
  }, []);

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
    const out = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
    const pushed = res.ok && out.ok === true;
    showToast(out.message || (pushed ? "Pushed lead to SalesOps CRM" : `CRM push failed (HTTP ${res.status})`), pushed ? "ok" : "error");
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

  const runLiveEmailExtraction = useCallback(
    async (em: CrucialEmailItem, toastOnSuccess = false): Promise<LoadEntry | null> => {
      setExtractingModal(true);
      try {
        const res = await fetch("/api/extract-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            subject: em.subject,
            sender: em.from,
            bodyText: em.fullBody || em.body,
          }),
        });
        const out = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          entry?: LoadEntry;
          summary?: string;
        };
        if (res.ok && out.entry) {
          setReviewExtractedEntry(out.entry);
          setReviewPoDraft((prev) => prev || out.entry?.references.customerPO || "");
          setReviewSellDraft((prev) =>
            prev || (out.entry?.pricing.linehaulSell ? String(out.entry.pricing.linehaulSell) : ""),
          );
          setReviewBuyDraft((prev) =>
            prev || (out.entry?.pricing.linehaulBuy ? String(out.entry.pricing.linehaulBuy) : ""),
          );
          if (toastOnSuccess) {
            showToast(out.summary || `Extracted live load fields from "${em.subject}"`);
          }
          return out.entry;
        }
      } catch {
        // Keep extractedFields / email regex fallback
      } finally {
        setExtractingModal(false);
      }
      return null;
    },
    [showToast],
  );

  const openReviewModal = useCallback(
    (em: CrucialEmailItem) => {
      const liveEm = em as LiveCrucialEmail;
      const matched =
        em.loadId !== "NEW" ? data?.shipments.find((s) => s.id === em.loadId) : undefined;
      setReviewEmail(em);
      setReviewExtractedEntry(null);
      setReviewPoDraft(liveEm.extractedFields?.po || em.extractedPo || matched?.po || "");
      const sellCandidate = liveEm.extractedFields?.rate ?? em.extractedAmount ?? matched?.sell;
      setReviewSellDraft(sellCandidate !== undefined && sellCandidate > 0 ? String(sellCandidate) : "");
      setReviewBuyDraft(matched?.buy !== undefined && matched.buy > 0 ? String(matched.buy) : "");
      setReviewNoteDraft(em.operationalNote || matched?.operationalNote || "");
      void runLiveEmailExtraction(em, false);
    },
    [data?.shipments, runLiveEmailExtraction],
  );

  const handleExtractModalToBuilder = useCallback(
    async (em: CrucialEmailItem) => {
      let extracted = reviewExtractedEntry;
      if (!extracted) {
        extracted = await runLiveEmailExtraction(em, false);
      }
      const matched =
        em.loadId !== "NEW" ? data?.shipments.find((s) => s.id === em.loadId) : undefined;

      if (extracted) {
        const nextEntry: LoadEntry = {
          ...extracted,
          references: {
            ...extracted.references,
            customerPO: reviewPoDraft.trim() || extracted.references.customerPO || em.extractedPo || "",
          },
          pricing: {
            ...extracted.pricing,
            linehaulSell:
              Number(reviewSellDraft) > 0
                ? Number(reviewSellDraft)
                : extracted.pricing.linehaulSell,
            linehaulBuy:
              Number(reviewBuyDraft) > 0
                ? Number(reviewBuyDraft)
                : extracted.pricing.linehaulBuy,
          },
          specialInstructions:
            reviewNoteDraft.trim() || extracted.specialInstructions || em.operationalNote || "",
        };
        setBuilderEntry(nextEntry);
        setReviewEmail(null);
        setLocation("/load-builder");
        showToast(`Extracted "${em.subject}" into Compact Load Builder.`);
        return;
      }

      if (matched) {
        setBuilderEntry({
          shipmentType: "Truckload",
          status: "Committed",
          customer: { name: matched.customer, taiOrganizationId: matched.taiOrgId || "" },
          references: {
            customerPO: reviewPoDraft.trim() || em.extractedPo || matched.po || "",
            bolNumber: matched.bol || "",
            invoiceRef: em.extractedInvoice || matched.bol || "",
            carrierProNumber: matched.pro || "",
            pickupNumber: "",
          },
          stops: matched.stops.length >= 2 ? matched.stops : createDefaultBuilderEntry().stops,
          items: matched.commodities.length >= 1 ? matched.commodities : createDefaultBuilderEntry().items,
          accessorials: [],
          equipment: {
            trailerSize: matched.trailerSize || "Full",
            trailerType: matched.equip || "53 ft Van | Dry",
            equipmentLength: "53",
            mileage: matched.mileage || 0,
            stackable: false,
          },
          pricing: {
            linehaulSell: Number(reviewSellDraft) > 0 ? Number(reviewSellDraft) : matched.sell,
            fuelSell: 0,
            linehaulBuy: Number(reviewBuyDraft) > 0 ? Number(reviewBuyDraft) : matched.buy,
            fuelBuy: 0,
          },
          carrier: {
            name: em.extractedCarrier || matched.carrier || "",
            mcNumber: matched.mc || "",
            serviceLevel: "Normal",
          },
          specialInstructions: reviewNoteDraft.trim() || matched.operationalNote || "",
          sendToTai: true,
        });
        setReviewEmail(null);
        setLocation("/load-builder");
        showToast(`Loaded #${matched.id} with email updates into Compact Load Builder.`);
        return;
      }

      const fallbackEntry = createDefaultBuilderEntry();
      setBuilderEntry({
        ...fallbackEntry,
        references: {
          ...fallbackEntry.references,
          customerPO: reviewPoDraft.trim() || em.extractedPo || "",
        },
        pricing: {
          ...fallbackEntry.pricing,
          linehaulSell: Number(reviewSellDraft) || em.extractedAmount || 0,
          linehaulBuy: Number(reviewBuyDraft) || 0,
        },
        specialInstructions: reviewNoteDraft.trim() || em.operationalNote || em.body || "",
      });
      setReviewEmail(null);
      setLocation("/load-builder");
      showToast(`Extracted email details into Compact Load Builder.`);
    },
    [
      data?.shipments,
      extractMultiStopTender,
      reviewBuyDraft,
      reviewExtractedEntry,
      reviewNoteDraft,
      reviewPoDraft,
      reviewSellDraft,
      runLiveEmailExtraction,
      setLocation,
      showToast,
    ],
  );

  const handleApplyEmailAction = async (em: CrucialEmailItem) => {
    if (em.diffType === "new_tender" || em.loadId === "NEW") {
      await handleExtractModalToBuilder(em);
      return;
    }
    if (em.diffType === "missing_pod") {
      promptPodUpload(em.loadId);
      return;
    }
    const res = await fetch(`/api/inbox/${encodeURIComponent(em.id)}/apply`, {
      method: "POST",
      credentials: "include",
    });
    const out = (await res.json().catch(() => ({}))) as { message?: string };
    showToast(out.message || "Applied email diff");
    setReviewEmail((prev) => (prev && prev.id === em.id ? { ...prev, applied: true } : prev));
    await refreshBootstrap();
  };

  const handleApplyModalToLoadAndTai = async (em: CrucialEmailItem) => {
    if (em.loadId === "NEW") {
      await handleExtractModalToBuilder(em);
      return;
    }
    setSavingModalUpdate(true);
    try {
      const patchPayload: Record<string, unknown> = {
        pushToTai: true,
      };
      if (reviewPoDraft.trim()) patchPayload.po = reviewPoDraft.trim();
      if (reviewSellDraft.trim() !== "" && !Number.isNaN(Number(reviewSellDraft))) {
        patchPayload.sell = Number(reviewSellDraft);
      }
      if (reviewBuyDraft.trim() !== "" && !Number.isNaN(Number(reviewBuyDraft))) {
        patchPayload.buy = Number(reviewBuyDraft);
      }
      if (reviewNoteDraft.trim()) {
        patchPayload.operationalNote = reviewNoteDraft.trim();
      }

      const [patchRes, applyRes] = await Promise.all([
        fetch(`/api/loads/${encodeURIComponent(em.loadId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(patchPayload),
        }),
        fetch(`/api/inbox/${encodeURIComponent(em.id)}/apply`, {
          method: "POST",
          credentials: "include",
        }),
      ]);

      const patchJson = (await patchRes.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        taiWriteback?: { pushed?: boolean; message?: string };
      };
      const applyJson = (await applyRes.json().catch(() => ({}))) as { message?: string };

      const ok = patchRes.ok && patchJson.ok !== false;
      showToast(
        patchJson.taiWriteback?.message ||
          patchJson.message ||
          applyJson.message ||
          `Updated Load #${em.loadId} & pushed to TAI`,
        ok ? "ok" : "error",
      );
      setReviewEmail((prev) => (prev && prev.id === em.id ? { ...prev, applied: true } : prev));
      await refreshBootstrap();
    } catch (err) {
      showToast(
        `Failed to apply update to Load #${em.loadId}: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      setSavingModalUpdate(false);
    }
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
          customerPO: reviewPoDraft.trim() || em?.extractedPo || s.po || "",
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
          linehaulSell:
            Number(reviewSellDraft) > 0
              ? Number(reviewSellDraft)
              : em?.extractedAmount && em.extractedAmount > s.sell
              ? em.extractedAmount
              : s.sell,
          fuelSell: 0,
          linehaulBuy: Number(reviewBuyDraft) > 0 ? Number(reviewBuyDraft) : s.buy,
          fuelBuy: 0,
        },
        carrier: {
          name: em?.extractedCarrier || s.carrier || "",
          mcNumber: s.mc || "",
          serviceLevel: "Normal",
        },
        specialInstructions: reviewNoteDraft.trim() || s.operationalNote || "",
        sendToTai: true,
      });
      setReviewEmail(null);
      setLocation("/load-builder");
      showToast(`Loaded #${s.id} (${s.origin} → ${s.dest}) into Compact Builder.`);
    },
    [reviewBuyDraft, reviewNoteDraft, reviewPoDraft, reviewSellDraft, setLocation, showToast],
  );

  const mergedInboxEmails = useMemo<CrucialEmailItem[]>(() => {
    const byKey = new Map<string, CrucialEmailItem>();
    for (const item of liveInboxItems) {
      const k = item.threadId || item.id;
      byKey.set(k, item);
    }
    for (const item of data?.crucialEmails || []) {
      const k = item.threadId || item.id;
      if (!byKey.has(k)) {
        byKey.set(k, item);
      } else {
        const existing = byKey.get(k)!;
        byKey.set(k, {
          ...item,
          ...existing,
          applied: Boolean(existing.applied || item.applied),
        });
      }
    }
    return [...byKey.values()];
  }, [liveInboxItems, data?.crucialEmails]);

  const handleAskAi = async (
    q: string,
    explicitEmail?: { subject?: string; from?: string; body?: string } | null,
  ) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    const priorHistory = chatHistory.slice(-10);
    setChatHistory((prev) => [...prev, { role: "user", text: trimmed }]);

    let resolvedEmail: { subject?: string; from?: string; body?: string } | null = null;
    if (explicitEmail !== undefined) {
      resolvedEmail = explicitEmail;
    } else if (selectedAiEmailId !== "none") {
      const found =
        (reviewEmail && reviewEmail.id === selectedAiEmailId ? reviewEmail : null) ||
        mergedInboxEmails.find((e) => e.id === selectedAiEmailId) ||
        null;
      if (found) {
        resolvedEmail = {
          subject: found.subject,
          from: found.from,
          body: found.fullBody || found.body,
        };
      }
    } else if (reviewEmail) {
      resolvedEmail = {
        subject: reviewEmail.subject,
        from: reviewEmail.from,
        body: reviewEmail.fullBody || reviewEmail.body,
      };
    }

    setAiSending(true);
    try {
      let res = await fetch("/api/ai/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          question: trimmed,
          activeEmail: resolvedEmail,
          history: priorHistory,
        }),
      });
      if (res.status === 404) {
        res = await fetch("/api/assistant/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            question: trimmed,
            activeEmail: resolvedEmail,
            history: priorHistory,
          }),
        });
      }
      const out = (await res.json().catch(() => ({}))) as {
        answer?: string;
        message?: string;
        error?: string;
      };
      setChatHistory((prev) => [
        ...prev,
        {
          role: "assistant",
          text: out.answer || out.message || out.error || `AI request failed (HTTP ${res.status}).`,
        },
      ]);
    } catch (err) {
      setChatHistory((prev) => [
        ...prev,
        {
          role: "assistant",
          text: `Unable to reach TAI Copilot: ${err instanceof Error ? err.message : String(err)}`,
        },
      ]);
    } finally {
      setAiSending(false);
    }
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
          <div className="pf-brand-rule rounded overflow-hidden" />
          <div className="flex justify-center pt-1">
            <svg width="36" height="36" viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <rect width="32" height="32" rx="7" fill="#12345a" />
              <rect x="6" y="19" width="3" height="7" rx="1" fill="#ffffff" />
              <rect x="10.5" y="16" width="3" height="10" rx="1" fill="#ffffff" />
              <rect x="15" y="13" width="3" height="13" rx="1" fill="#ffffff" />
              <rect x="19.5" y="10" width="3" height="16" rx="1" fill="#ffffff" />
              <rect x="24" y="6" width="3" height="20" rx="1" fill="#21b975" />
            </svg>
          </div>
          <div className="font-bold text-lg tracking-tight">Five Nines Operations</div>
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

  const podFileInput = (
    <input
      ref={podFileInputRef}
      type="file"
      accept={POD_FILE_ACCEPT}
      className="hidden"
      aria-label="Choose POD file to upload to TAI"
      onChange={(e) => {
        const file = e.target.files?.[0];
        const target = podFileTargetRef.current;
        e.target.value = "";
        podFileTargetRef.current = null;
        if (file && target) void handleUploadPod(target, file);
      }}
    />
  );

  // Toast Banner (errors render red so a failed TAI write never looks like a success)
  const toastBanner = toast ? (
    <div
      role={toastKind === "error" ? "alert" : "status"}
      className="px-4 py-2 text-xs font-medium flex items-center justify-between gap-3 shrink-0"
      style={
        toastKind === "error"
          ? { background: "var(--pf-danger-dim)", color: "var(--pf-danger)", borderBottom: "1px solid var(--pf-danger)" }
          : { background: "var(--pf-primary-dim)", color: "var(--pf-primary-bright, #66d9a2)", borderBottom: "1px solid var(--pf-primary)" }
      }
    >
      <span>
        {toastKind === "error" ? "✕" : "✓"} {toast}
      </span>
      <button type="button" onClick={() => setToast(null)} className="underline opacity-80 hover:opacity-100">
        Dismiss
      </button>
    </div>
  ) : null;

  // Standalone Chrome Extension Side-Panel Route (/?panel=1 or /gmail-panel)
  if (isStandalonePanelLocation(location)) {
    return (
      <div data-theme="dark" className="tk-panel h-screen w-full overflow-hidden flex flex-col">
        {podFileInput}
        <div className="flex-1 min-h-0">
          <GmailToolkitPanel
            fullScreen
            shipments={data.shipments}
            crucialEmails={mergedInboxEmails}
            facilities={data.facilities}
            customers={data.customers}
            carriers={data.carriers}
            crmLeads={data.crmLeads}
            kpis={data.kpis}
            bootstrapUser={data.user}
            isLiveSync={!data.mode.safeSandbox}
            builderEntry={builderEntry}
            onBuilderChange={setBuilderEntry}
            onApplyEmailAction={handleApplyEmailAction}
            onUploadPod={promptPodUpload}
            onRefresh={refreshBootstrap}
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
      </div>
    );
  }

  const liveData = data as BootstrapPayload & {
    supabaseConnected?: boolean;
    supabaseError?: string | null;
    lastSyncAt?: string;
    counts?: {
      totalShipments: number;
      uncoveredCommitted: number;
      coveredCommitted: number;
      dispatched: number;
      inTransit: number;
      delivered: number;
      cancelled: number;
      customers: number;
      carriers: number;
      facilities: number;
    };
  };
  const sbConnected = liveData.supabaseConnected ?? data.mode.supabaseConnected;
  const sbError = liveData.supabaseError || null;
  const totalShipmentsCount = liveData.counts?.totalShipments ?? data.kpis.totalShipments ?? data.shipments.length;
  const uncoveredCommittedCount = liveData.counts?.uncoveredCommitted ?? data.kpis.uncoveredCommitted;
  const inTransitCount = liveData.counts?.inTransit ?? data.kpis.inTransitNow;
  const customersCount = liveData.counts?.customers ?? data.kpis.customersCount;

  const openActionsCount = mergedInboxEmails.filter((e) => !e.applied).length;
  const navItems = [
    { path: "/", label: "Live Ops Inbox", icon: Inbox, badge: openActionsCount },
    { path: "/dispatch", label: "Unified Dispatch", icon: Layers, badge: totalShipmentsCount.toLocaleString() },
    { path: "/load-builder", label: "Compact Builder", icon: PlusCircle, badge: "Fast" },
    { path: "/salesops", label: "SalesOps CRM", icon: Handshake, badge: data.crmLeads?.length ?? 0 },
    { path: "/ai-assistant", label: "TAI Copilot", icon: Bot, badge: null },
    { path: "/pod-billing", label: "POD & Webhooks", icon: FileCheck2, badge: data.kpis.emailPodReady },
  ];

  const filteredDashboardEmails = mergedInboxEmails.filter((e) => {
    if (inboxFilter === "all") return true;
    if (inboxFilter === "tenders") {
      return e.category === "tenders" || e.diffType === "new_tender" || e.loadId === "NEW";
    }
    if (inboxFilter === "diffs") {
      return e.category === "diffs" || (Boolean(e.loadId) && e.loadId !== "NEW" && e.category !== "pod");
    }
    if (inboxFilter === "pod") {
      return e.category === "pod" || e.diffType === "missing_pod";
    }
    return true;
  });

  return (
    <div data-theme={theme} className="pf-app min-h-screen flex flex-col">
      {podFileInput}
      {/* Five Nines Logistics Brand Rule (#12345a -> #1768b2 -> #21b975 -> #66d9a2) */}
      <div className="pf-brand-rule shrink-0" />

      {toastBanner}

      <div className="flex-1 flex min-h-0">
        {/* Left Consolidated Sidebar — Matched Deep Charcoal Canvas + fivenineslogistics.com Accents */}
        <aside
          className="w-56 shrink-0 flex flex-col justify-between p-3"
          style={{ background: "var(--pf-sidebar)", borderRight: "1px solid var(--pf-border)", color: "#f8fafc" }}
        >
          <div className="space-y-4">
            <div className="px-2 pt-1 pb-3" style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
              <div className="flex items-center gap-2.5">
                <svg width="28" height="28" viewBox="0 0 32 32" fill="none" className="shrink-0" aria-hidden="true">
                  <rect width="32" height="32" rx="7" fill="#12345a" />
                  <rect x="6" y="19" width="3" height="7" rx="1" fill="#ffffff" />
                  <rect x="10.5" y="16" width="3" height="10" rx="1" fill="#ffffff" />
                  <rect x="15" y="13" width="3" height="13" rx="1" fill="#ffffff" />
                  <rect x="19.5" y="10" width="3" height="16" rx="1" fill="#ffffff" />
                  <rect x="24" y="6" width="3" height="20" rx="1" fill="#21b975" />
                </svg>
                <div>
                  <div className="font-bold text-sm text-white tracking-tight">Five Nines Ops</div>
                  <div className="font-mono text-[10px]" style={{ color: "#66d9a2" }}>
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
                      background: active ? "rgba(23, 104, 178, 0.24)" : "transparent",
                      color: active ? "#ffffff" : "#c1d1e0",
                      border: active ? "1px solid #1768b2" : "1px solid transparent",
                    }}
                  >
                    <span className="inline-flex items-center gap-2">
                      <Icon size={14} style={{ color: active ? "#66d9a2" : undefined }} /> {it.label}
                    </span>
                    {it.badge !== null && (
                      <span
                        className="px-1.5 py-0.5 rounded-full font-mono text-[10px] font-semibold"
                        style={{
                          background: active ? "#21b975" : "rgba(255,255,255,0.1)",
                          color: active ? "#04130b" : "#ffffff",
                        }}
                      >
                        {it.badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>

            <div className="pt-3 space-y-1.5 text-xs" style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}>
              <div className="px-2 text-[10px] font-semibold uppercase tracking-wider" style={{ color: "#94a3b8" }}>
                Live Sync &amp; Poller
              </div>
              <div
                className="px-2 flex justify-between items-center gap-1"
                style={{ color: "#c1d1e0" }}
                title={sbError || (sbConnected ? `Connected to Supabase (${totalShipmentsCount.toLocaleString()} loads)` : "Seeded fallback")}
              >
                <span className="shrink-0">Supabase DB</span>
                <span
                  className="font-mono text-[10px] truncate"
                  style={{ color: sbConnected ? "#66d9a2" : sbError ? "#ff525a" : "#f5ae39" }}
                >
                  ● {sbConnected ? `Live (${totalShipmentsCount.toLocaleString()} loads)` : sbError ? "Offline / Error" : "Offline / Error"}
                </span>
              </div>
              <div className="px-2 flex justify-between" style={{ color: "#c1d1e0" }}>
                <span>Realtime Stream</span>
                <span className="font-mono text-[11px]" style={{ color: data.mode.realtimeSubscribed ? "#66d9a2" : "#94a3b8" }}>
                  ● {data.mode.realtimeSubscribed ? "Active" : "SSE Ready"}
                </span>
              </div>
              <div className="px-2 flex justify-between" style={{ color: "#c1d1e0" }}>
                <span>Write-Back Poller</span>
                <span className="font-mono text-[11px]" style={{ color: "#66d9a2" }}>
                  ● {data.mode.pollerEnabled ? `Local (${data.mode.pollerScope})` : "Shared Queue"}
                </span>
              </div>
            </div>
          </div>

          <div
            className="p-2.5 rounded-lg text-[11px] space-y-1"
            style={{ background: "#13171d", border: "1px solid #222933" }}
          >
            <div className="truncate font-mono text-[10px]" style={{ color: "#66d9a2" }}>
              {data.user?.email || "chriss@primarycompanies.com"}
            </div>
            <div className="flex justify-between font-mono">
              <span className="text-white">{totalShipmentsCount.toLocaleString()} loads</span>
              <span style={{ color: "#94a3b8" }}>{customersCount} cust</span>
            </div>
            <div style={{ color: "#94a3b8" }}>
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
                {theme === "dark" ? "Light (#F7F9FC)" : "Dark (#0B0E11)"}
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
            {/* ROUTE 1: LIVE GMAIL & SUPABASE INBOX FEEDING DIRECTLY INTO DASHBOARD */}
            {location === "/" && (
              <div className="space-y-4">
                {/* KPI Command Strip */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <div className="p-3.5 rounded-xl" style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}>
                    <div className="text-[11px]" style={{ color: "var(--pf-text-muted)" }}>Uncovered Committed</div>
                    <div className="text-xl font-bold font-mono mt-0.5" style={{ color: "var(--pf-warning)" }}>{uncoveredCommittedCount}</div>
                  </div>
                  <div className="p-3.5 rounded-xl" style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}>
                    <div className="text-[11px]" style={{ color: "var(--pf-text-muted)" }}>In Transit Now</div>
                    <div className="text-xl font-bold font-mono mt-0.5" style={{ color: "var(--pf-info)" }}>{inTransitCount}</div>
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
                    <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--pf-primary)" }}>
                      Live Gmail Extension &amp; Supabase Feed · Real-Time SSE Stream
                    </div>
                    <h1 className="text-xl font-semibold tracking-tight mt-0.5">Live Gmail Inbox &amp; 1-Click Load Extraction</h1>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={syncingInbox}
                      onClick={() => void handleSyncDashboardInbox()}
                      className="px-3 py-1.5 rounded-lg text-xs font-bold inline-flex items-center gap-1.5 transition-opacity disabled:opacity-60"
                      style={{ background: "var(--pf-primary)", color: "var(--pf-primary-fg)" }}
                    >
                      <RefreshCw size={12} className={syncingInbox ? "animate-spin" : ""} />
                      {syncingInbox ? "Syncing…" : "↻ Sync Gmail Inbox"}
                    </button>
                    <div className="flex flex-wrap gap-1.5">
                      {[
                        ["all", `All Live Inbox (${mergedInboxEmails.length})`],
                        ["tenders", "Unbooked Tenders"],
                        ["diffs", "Load & PO Updates"],
                        ["pod", "Missing PODs"],
                      ].map(([id, lbl]) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => setInboxFilter(id)}
                          className="px-3 py-1 rounded-full text-xs font-semibold transition-colors"
                          style={{
                            background: inboxFilter === id ? "var(--pf-action)" : "var(--pf-surface)",
                            color: inboxFilter === id ? "#ffffff" : "var(--pf-text-muted)",
                            border: `1px solid ${inboxFilter === id ? "var(--pf-action)" : "var(--pf-border)"}`,
                          }}
                        >
                          {lbl}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="grid lg:grid-cols-2 gap-3.5">
                  {filteredDashboardEmails.map((em) => {
                      const matchedLoad = em.loadId !== "NEW" ? data.shipments.find((s) => s.id === em.loadId) : undefined;
                      const liveEm = em as LiveCrucialEmail;
                      return (
                        <div
                          key={em.id}
                          onClick={() => openReviewModal(em)}
                          className="p-4 rounded-xl flex flex-col justify-between gap-3 cursor-pointer transition-all hover:border-[#1768b2]"
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
                                    void openEmailInGmail({
                                      permalink: em.permalink,
                                      threadId: em.threadId,
                                      messageId: liveEm.messageId,
                                      subject: em.subject,
                                      loadId: em.loadId,
                                    });
                                  }}
                                  className="px-1.5 py-0.5 rounded text-[10px] font-semibold inline-flex items-center gap-0.5 shrink-0 hover:opacity-85"
                                  style={{ background: "var(--pf-surface-raised)", color: "var(--pf-text)", border: "1px solid var(--pf-border)" }}
                                  title="Open thread in Gmail"
                                >
                                  Gmail <ExternalLink size={9} />
                                </button>
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
                              onClick={(e) => {
                                e.stopPropagation();
                                openReviewModal(em);
                              }}
                              className="p-2 rounded-lg text-xs flex items-center justify-between gap-2 cursor-pointer hover:opacity-90"
                              style={{ background: "var(--pf-surface-raised)" }}
                            >
                              <span className="truncate">{em.diffLabel}</span>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openReviewModal(em);
                                }}
                                className="px-2 py-0.5 rounded font-mono font-bold shrink-0 hover:underline"
                                style={{ background: "var(--pf-primary-dim)", color: "var(--pf-primary)" }}
                                title="Open Review Extraction & Load Modal"
                              >
                                {em.diffValue}
                              </button>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openReviewModal(em);
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
                onUploadPod={promptPodUpload}
                onSaveNote={handleSaveLoadNote}
                onDeleteLoad={handleDeleteLoad}
                onRefreshBootstrap={refreshBootstrap}
                counts={liveData.counts || null}
                onAskAi={(q) => {
                  void handleAskAi(q);
                  setLocation("/ai-assistant");
                }}
              />
            )}

            {/* ROUTE 3B: SALESOPS CRM */}
            {location === "/salesops" && (
              <SalesOpsCrmView
                leads={data.crmLeads || []}
                customers={data.customers}
                shipments={data.shipments}
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
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--pf-text-muted)" }}>
                      Grounded on Live Shipments ({totalShipmentsCount.toLocaleString()}), Carriers, Lanes &amp; Inbox Context
                    </div>
                    <h1 className="text-xl font-semibold tracking-tight mt-0.5">TAI Operations Copilot</h1>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <label htmlFor="ai-email-context-select" className="font-mono text-[11px]" style={{ color: "var(--pf-text-muted)" }}>
                      Email Context:
                    </label>
                    <select
                      id="ai-email-context-select"
                      value={selectedAiEmailId}
                      onChange={(e) => setSelectedAiEmailId(e.target.value)}
                      className="pf-input py-1 px-2.5 text-xs max-w-xs"
                    >
                      <option value="none">None — All Live Loads</option>
                      {mergedInboxEmails.map((em) => (
                        <option key={em.id} value={em.id}>
                          {em.loadId !== "NEW" ? `[#${em.loadId}] ` : "[TENDER] "}
                          {em.subject.slice(0, 48)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  {[
                    "Do we have any uncovered shipments for customer IMC Logistics?",
                    "Top historical lane runners for PA → GA flatbed?",
                    "Is carrier Just Drive Transport set up in TAI?",
                    "Which uncovered loads pick up first?",
                  ].map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      disabled={aiSending}
                      onClick={() => void handleAskAi(prompt)}
                      className="px-3 py-1.5 rounded-full text-xs font-medium disabled:opacity-50"
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
                      className="p-3 rounded-lg text-xs leading-relaxed whitespace-pre-wrap"
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
                  {aiSending && (
                    <div className="text-xs font-mono" style={{ color: "var(--pf-text-muted)" }}>
                      Querying live TAI / Supabase data…
                    </div>
                  )}
                  <div className="flex gap-2 pt-2">
                    <input
                      value={aiDraft}
                      onChange={(e) => setAiDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && aiDraft.trim() && !aiSending) {
                          void handleAskAi(aiDraft);
                          setAiDraft("");
                        }
                      }}
                      placeholder="Ask about any customer, carrier MC/setup, lane runners, or uncovered loads…"
                      className="pf-input flex-1"
                    />
                    <button
                      type="button"
                      disabled={aiSending}
                      onClick={() => {
                        if (aiDraft.trim()) {
                          void handleAskAi(aiDraft);
                          setAiDraft("");
                        }
                      }}
                      className="px-4 py-2 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
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

        {/* EMAIL & LOAD SIDE-BY-SIDE REVIEW EXTRACTION MODAL */}
        {reviewEmail && (() => {
          const liveReviewEm = reviewEmail as LiveCrucialEmail;
          const linkedLoad =
            reviewEmail.loadId !== "NEW"
              ? data.shipments.find((s) => s.id === reviewEmail.loadId)
              : undefined;
          const modalContainer = reviewEmail.containerNumber || linkedLoad?.containerNumber;
          const containerSearchUrl = modalContainer
            ? buildGmailContainerSearchUrl(modalContainer, reviewEmail.loadId, reviewEmail.subject)
            : null;
          const activeNote = linkedLoad?.operationalNote || reviewEmail.operationalNote;

          const ef = liveReviewEm.extractedFields || {};
          const extPick = reviewExtractedEntry?.stops[0];
          const extDrop =
            reviewExtractedEntry && reviewExtractedEntry.stops.length > 1
              ? reviewExtractedEntry.stops[reviewExtractedEntry.stops.length - 1]
              : undefined;
          const extractedCustomer =
            reviewExtractedEntry?.customer.name || ef.customer || linkedLoad?.customer || "—";
          const extractedPoVal =
            reviewPoDraft ||
            reviewExtractedEntry?.references.customerPO ||
            ef.po ||
            ef.customerPO ||
            reviewEmail.extractedPo ||
            "—";
          const extractedOrigin = extPick
            ? `${extPick.city}, ${extPick.state} ${extPick.zipCode}`.trim()
            : ef.origin || linkedLoad?.origin || "—";
          const extractedDest = extDrop
            ? `${extDrop.city}, ${extDrop.state} ${extDrop.zipCode}`.trim()
            : ef.destination || ef.dest || linkedLoad?.dest || "—";
          const extractedReadyDate =
            extPick?.readyDate || ef.readyDate || linkedLoad?.shipDate || "—";
          const extractedEquipment =
            reviewExtractedEntry?.equipment.trailerType || ef.equipment || linkedLoad?.equip || "—";
          const extractedSellVal =
            Number(reviewSellDraft) ||
            reviewExtractedEntry?.pricing.linehaulSell ||
            ef.rate ||
            ef.sellRate ||
            reviewEmail.extractedAmount ||
            0;

          return (
            <div
              onClick={() => setReviewEmail(null)}
              className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
            >
              <div
                onClick={(e) => e.stopPropagation()}
                className="max-w-5xl w-full max-h-[92vh] flex flex-col rounded-2xl overflow-hidden shadow-2xl"
                style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
              >
                <div className="pf-brand-rule shrink-0" />

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
                      <button
                        type="button"
                        onClick={() =>
                          void openEmailInGmail({
                            permalink: containerSearchUrl,
                            query: modalContainer || reviewEmail.subject,
                          })
                        }
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5"
                        style={{ background: "var(--pf-info-dim)", color: "var(--pf-info)", border: "1px solid var(--pf-border)" }}
                      >
                        <Search size={12} /> Search Container # in Gmail
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        void openEmailInGmail({
                          permalink: reviewEmail.permalink,
                          threadId: reviewEmail.threadId,
                          messageId: liveReviewEm.messageId,
                          subject: reviewEmail.subject,
                          loadId: reviewEmail.loadId,
                        })
                      }
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5"
                      style={{ background: "var(--pf-action)", color: "#ffffff" }}
                    >
                      <ExternalLink size={12} /> Open in Gmail
                    </button>
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
                  {/* Left 7 Columns: Extracted Fields Summary + Full Email Body + Container Timeline */}
                  <div className="lg:col-span-7 space-y-3">
                    {activeNote && (
                      <div
                        className="p-3 rounded-xl text-xs font-semibold"
                        style={{
                          background: "var(--pf-warning-dim)",
                          color: "var(--pf-warning)",
                          border: "1px solid var(--pf-warning)",
                        }}
                      >
                        {activeNote}
                      </div>
                    )}

                    {/* Structured Extracted Freight Fields Card */}
                    <div
                      className="p-3.5 rounded-xl space-y-2.5 text-xs"
                      style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-bold uppercase tracking-wider inline-flex items-center gap-1.5" style={{ color: "var(--pf-primary)" }}>
                          <Sparkles size={12} /> Extracted Email Freight Fields
                        </span>
                        <button
                          type="button"
                          disabled={extractingModal}
                          onClick={() => void runLiveEmailExtraction(reviewEmail, true)}
                          className="px-2.5 py-1 rounded-lg text-[11px] font-semibold inline-flex items-center gap-1"
                          style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
                        >
                          <RefreshCw size={11} className={extractingModal ? "animate-spin" : ""} />
                          {extractingModal ? "Extracting…" : "↻ Re-run Extraction"}
                        </button>
                      </div>

                      <div className="grid sm:grid-cols-2 gap-2 font-mono text-[11px]">
                        <div className="p-2 rounded-lg" style={{ background: "var(--pf-surface)" }}>
                          <div className="text-[10px]" style={{ color: "var(--pf-text-subtle)" }}>CUSTOMER</div>
                          <div className="font-semibold truncate">{extractedCustomer}</div>
                        </div>
                        <div className="p-2 rounded-lg" style={{ background: "var(--pf-surface)" }}>
                          <div className="text-[10px]" style={{ color: "var(--pf-text-subtle)" }}>CUSTOMER PO / INV</div>
                          <div className="font-bold" style={{ color: "var(--pf-primary)" }}>
                            {extractedPoVal}
                            {reviewEmail.extractedInvoice ? ` · Inv ${reviewEmail.extractedInvoice}` : ""}
                          </div>
                        </div>
                        <div className="p-2 rounded-lg" style={{ background: "var(--pf-surface)" }}>
                          <div className="text-[10px]" style={{ color: "var(--pf-text-subtle)" }}>ORIGIN → DESTINATION</div>
                          <div className="truncate">{extractedOrigin} → {extractedDest}</div>
                        </div>
                        <div className="p-2 rounded-lg" style={{ background: "var(--pf-surface)" }}>
                          <div className="text-[10px]" style={{ color: "var(--pf-text-subtle)" }}>READY DATE / EQUIP / RATE</div>
                          <div className="truncate">
                            {extractedReadyDate} · {extractedEquipment}
                            {extractedSellVal > 0 ? ` · $${extractedSellVal.toLocaleString()}` : ""}
                          </div>
                        </div>
                      </div>

                      {reviewEmail.attachments && reviewEmail.attachments.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-0.5">
                          {reviewEmail.attachments.map((att, idx) => (
                            <span
                              key={idx}
                              className="px-2.5 py-1 rounded-md font-mono text-[11px]"
                              style={{ background: "var(--pf-info-dim)", color: "var(--pf-info)" }}
                            >
                              📎 {att.filename || "attachment"}
                            </span>
                          ))}
                        </div>
                      )}
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

                  {/* Right 5 Columns: Side-by-Side Load Comparison + Editable PO/Sell/Note + 1-Click Actions */}
                  <div className="lg:col-span-5 space-y-3">
                    {linkedLoad ? (
                      <div
                        className="p-4 rounded-xl space-y-3"
                        style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-xs font-bold" style={{ color: "var(--pf-info)" }}>
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
                            <div className="text-[10px]" style={{ color: "var(--pf-text-subtle)" }}>DATES</div>
                            <div>{linkedLoad.shipDate} → {linkedLoad.delivDate}</div>
                          </div>
                          <div>
                            <div className="text-[10px]" style={{ color: "var(--pf-text-subtle)" }}>EQUIPMENT</div>
                            <div className="truncate">{linkedLoad.equip}</div>
                          </div>
                          <div>
                            <div className="text-[10px]" style={{ color: "var(--pf-text-subtle)" }}>CURRENT SELL / BUY</div>
                            <div>${linkedLoad.sell.toLocaleString()} / ${linkedLoad.buy.toLocaleString()}</div>
                          </div>
                          <div>
                            <div className="text-[10px]" style={{ color: "var(--pf-text-subtle)" }}>CARRIER / POD</div>
                            <div className="truncate">{linkedLoad.carrier || "Unassigned"} · {linkedLoad.podCount} POD</div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div
                        className="p-4 rounded-xl space-y-1.5"
                        style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
                      >
                        <div className="font-mono text-xs font-bold" style={{ color: "var(--pf-primary)" }}>
                          {reviewEmail.loadId === "NEW"
                            ? "UNBOOKED CUSTOMER TENDER"
                            : `MATCHED SHIPMENT #${reviewEmail.loadId}`}
                        </div>
                        <p className="text-xs leading-relaxed" style={{ color: "var(--pf-text-muted)" }}>
                          Review or edit the extracted PO, sell/buy rate, and operational note below, then extract into Compact Load Builder or apply straight to TAI.
                        </p>
                      </div>
                    )}

                    {/* Editable PO / Sell / Buy / Operational Note Inputs */}
                    <div
                      className="p-4 rounded-xl space-y-2.5 text-xs"
                      style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
                    >
                      <div className="text-[11px] font-bold uppercase tracking-wider" style={{ color: "var(--pf-text-muted)" }}>
                        Review &amp; Edit Extracted Update
                      </div>

                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <label className="block text-[10px] mb-1" style={{ color: "var(--pf-text-muted)" }}>
                            Customer PO #
                          </label>
                          <input
                            value={reviewPoDraft}
                            onChange={(e) => setReviewPoDraft(e.target.value)}
                            placeholder="PO #"
                            className="pf-input font-mono font-semibold"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] mb-1" style={{ color: "var(--pf-text-muted)" }}>
                            Sell ($)
                          </label>
                          <input
                            type="number"
                            value={reviewSellDraft}
                            onChange={(e) => setReviewSellDraft(e.target.value)}
                            placeholder="0"
                            className="pf-input font-mono font-bold"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] mb-1" style={{ color: "var(--pf-text-muted)" }}>
                            Buy ($)
                          </label>
                          <input
                            type="number"
                            value={reviewBuyDraft}
                            onChange={(e) => setReviewBuyDraft(e.target.value)}
                            placeholder="0"
                            className="pf-input font-mono font-semibold"
                          />
                        </div>
                      </div>

                      <div>
                        <label className="block text-[10px] mb-1" style={{ color: "var(--pf-text-muted)" }}>
                          Operational / Exception Note
                        </label>
                        <textarea
                          rows={2}
                          value={reviewNoteDraft}
                          onChange={(e) => setReviewNoteDraft(e.target.value)}
                          placeholder="Add PO update note, container exception, or carrier instructions…"
                          className="pf-input"
                        />
                      </div>

                      <div className="space-y-2 pt-1">
                        {reviewEmail.loadId !== "NEW" && (
                          <button
                            type="button"
                            disabled={savingModalUpdate}
                            onClick={() => void handleApplyModalToLoadAndTai(reviewEmail)}
                            className="w-full py-2 px-3 rounded-lg text-xs font-bold inline-flex items-center justify-center gap-1.5"
                            style={{ background: "var(--pf-primary)", color: "var(--pf-primary-fg)" }}
                          >
                            <CheckCircle2 size={13} />
                            {savingModalUpdate
                              ? "Pushing Update to TAI…"
                              : reviewEmail.applied
                              ? `✓ Re-Sync Update to Load #${reviewEmail.loadId} & TAI`
                              : `Apply Update to Load #${reviewEmail.loadId} & TAI`}
                          </button>
                        )}

                        <button
                          type="button"
                          disabled={extractingModal}
                          onClick={() => void handleExtractModalToBuilder(reviewEmail)}
                          className="w-full py-2 px-3 rounded-lg text-xs font-bold inline-flex items-center justify-center gap-1.5"
                          style={{ background: "var(--pf-action)", color: "#ffffff" }}
                        >
                          <PlusCircle size={13} /> Extract to Compact Builder
                        </button>

                        {reviewEmail.loadId !== "NEW" && (
                          <button
                            type="button"
                            onClick={() => {
                              const id = reviewEmail.loadId;
                              setReviewEmail(null);
                              setExpandedLoadId(id);
                              setSearchQuery(id);
                              setLocation("/dispatch");
                            }}
                            className="w-full py-2 px-3 rounded-lg text-xs font-semibold"
                            style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
                          >
                            ⇄ Open Load #{reviewEmail.loadId} in Unified Dispatch
                          </button>
                        )}
                      </div>
                    </div>
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
              crucialEmails={mergedInboxEmails}
              facilities={data.facilities}
              customers={data.customers}
              carriers={data.carriers}
              crmLeads={data.crmLeads}
              kpis={data.kpis}
              bootstrapUser={data.user}
              isLiveSync={!data.mode.safeSandbox}
              builderEntry={builderEntry}
              onBuilderChange={setBuilderEntry}
              onApplyEmailAction={handleApplyEmailAction}
              onUploadPod={promptPodUpload}
              onRefresh={refreshBootstrap}
              onOpenDashboardLoad={openLoadInDispatch}
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
