import React, { useRef, useState } from "react";
import { loadEntryTotals, type LoadEntry } from "@shared/load-entry";
import type { CarrierOption, CustomerOption, SavedFacility } from "@shared/tai-webhook-schema";
import {
  BookOpen,
  CheckCircle2,
  ClipboardPaste,
  FileUp,
  FolderOpen,
  Printer,
  Reply,
  Sparkles,
} from "lucide-react";
import { CompactLoadBuilder } from "../CompactLoadBuilder";
import {
  captureGmailAttachments,
  captureGmailThread,
  insertGmailReply,
  type CapturedGmailAttachment,
  type CapturedGmailThread,
} from "./extensionBridge";
import { panelFetchJson, type PanelApiContext } from "./panelApi";
import {
  openPrintableHtmlWindow,
  type PanelKnowledgeRule,
  type PanelSavedDraft,
  type PanelViewId,
} from "./panelTypes";

interface LoadBuilderPanelViewProps {
  compact?: boolean;
  entry: LoadEntry;
  onChange: (next: LoadEntry) => void;
  facilities: SavedFacility[];
  customers: CustomerOption[];
  carriers: CarrierOption[];
  savedDrafts: PanelSavedDraft[];
  knowledgeRules: PanelKnowledgeRule[];
  learnedCount: number;
  onRefreshMemory: () => Promise<void>;
  onRefreshBootstrap: () => Promise<void>;
  onBooked: (ids: string[], msg: string) => void;
  onToast: (msg: string, kind?: "ok" | "error") => void;
  onExtractSampleTender?: () => void;
  onNavigate: (view: PanelViewId) => void;
  liveThread: CapturedGmailThread | null;
  onThreadCaptured: (thread: CapturedGmailThread) => void;
  apiCtx?: PanelApiContext;
}

type IntakeMode = "ai-email" | "paste-manual" | "pdf-tender";
type DrawerKind = "none" | "learned" | "drafts" | "preview";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const base64 = result.includes(",") ? result.split(",")[1] || "" : result;
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error || new Error("Failed reading file"));
    reader.readAsDataURL(file);
  });
}

function createBlankManualEntry(): LoadEntry {
  const today = new Date().toISOString().slice(0, 10);
  return {
    shipmentType: "Truckload",
    status: "Committed",
    customer: { name: "", taiOrganizationId: "" },
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
        readyDate: today,
        timeOpen: "09:00",
        timeClose: "16:00",
        appointmentRequired: false,
      },
    ],
    items: [
      {
        description: "",
        packagingType: "Pallet",
        handlingQuantity: 1,
        piecesTotal: 1,
        weightTotal: 40000,
        hazardousMaterial: false,
        freightClass: "No Class",
        referenceNumber: "",
      },
    ],
    accessorials: [],
    equipment: {
      trailerSize: "Full",
      trailerType: "48 ft Flatbed",
      equipmentLength: "48",
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

function buildOrderConfirmationReply(entry: LoadEntry): { text: string; html: string } {
  const totals = loadEntryTotals(entry);
  const pick = entry.stops[0];
  const drop = entry.stops[entry.stops.length - 1];
  const text = [
    `ORDER CONFIRMATION — ${entry.customer.name || "CUSTOMER TENDER"}`,
    `PO #: ${entry.references.customerPO || "TBD"} | Equipment: ${entry.equipment.trailerType} (${entry.equipment.trailerSize})`,
    `Pickup: ${pick?.companyName || "TBD"} — ${pick?.city || ""}, ${pick?.state || ""} ${pick?.zipCode || ""} (${pick?.readyDate || "TBD"})`,
    `Delivery: ${drop?.companyName || "TBD"} — ${drop?.city || ""}, ${drop?.state || ""} ${drop?.zipCode || ""} (${drop?.readyDate || "TBD"})`,
    `Commodity: ${entry.items.map((i) => `${i.piecesTotal} ${i.packagingType} ${i.description} (${i.weightTotal.toLocaleString()} lbs)`).join("; ")}`,
    totals.totalSell > 0 ? `Confirmed Customer Rate: $${totals.totalSell.toLocaleString()}` : "",
    entry.specialInstructions ? `Instructions: ${entry.specialInstructions}` : "",
    `— Five Nines / Primary Freight Operations`,
  ]
    .filter(Boolean)
    .join("\n");

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Order Summary</title>
  <style>body{font-family:system-ui,-apple-system,sans-serif;padding:28px;font-size:13px;color:#0f172a}
  .bar{height:4px;background:linear-gradient(90deg,#12345a 0%,#1768b2 48%,#21b975 82%,#66d9a2 100%);margin-bottom:14px}
  .box{border:1px solid #cbd5e1;border-radius:8px;padding:12px;margin-top:10px}</style></head>
  <body><div class="bar"></div><h2>Order Confirmation · PO ${entry.references.customerPO || "TBD"}</h2>
  <div class="box"><strong>Customer:</strong> ${entry.customer.name || "Spot"} &nbsp;|&nbsp; <strong>Equipment:</strong> ${entry.equipment.trailerType} &nbsp;|&nbsp; <strong>Rate:</strong> $${totals.totalSell.toLocaleString()}</div>
  <div class="box"><strong>Pickup:</strong> ${pick?.companyName} (${pick?.city}, ${pick?.state} ${pick?.zipCode}) on ${pick?.readyDate}<br/>
  <strong>Delivery:</strong> ${drop?.companyName} (${drop?.city}, ${drop?.state} ${drop?.zipCode}) on ${drop?.readyDate}</div>
  <div class="box"><strong>Commodity (${totals.totalPieces} pcs / ${totals.totalWeight.toLocaleString()} lbs):</strong><br/>
  ${entry.items.map((i) => `${i.piecesTotal} ${i.packagingType} — ${i.description} (${i.weightTotal.toLocaleString()} lbs)`).join("<br/>")}</div>
  <script>window.onload=()=>setTimeout(()=>window.print(),250);</script></body></html>`;

  return { text, html };
}

export const LoadBuilderPanelView: React.FC<LoadBuilderPanelViewProps> = ({
  compact = true,
  entry,
  onChange,
  facilities,
  customers,
  carriers,
  savedDrafts,
  knowledgeRules,
  learnedCount,
  onRefreshMemory,
  onRefreshBootstrap,
  onBooked,
  onToast,
  onExtractSampleTender,
  onNavigate,
  liveThread,
  onThreadCaptured,
  apiCtx,
}) => {
  const [intakeMode, setIntakeMode] = useState<IntakeMode>("ai-email");
  const [showIntakePanel, setShowIntakePanel] = useState<boolean>(false);
  const [drawer, setDrawer] = useState<DrawerKind>("none");
  const [busy, setBusy] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [alternateEquip, setAlternateEquip] = useState<string[]>([]);
  const [triggerCreateSignal, setTriggerCreateSignal] = useState<number>(0);

  // Mode 3: PDF / Image Tender state (upload -> transcribe -> confirm -> populate)
  const tenderInputRef = useRef<HTMLInputElement | null>(null);
  const [capturedAtts, setCapturedAtts] = useState<CapturedGmailAttachment[]>([]);
  const [pendingTranscript, setPendingTranscript] = useState<string>("");
  const [pendingExtractedEntry, setPendingExtractedEntry] = useState<LoadEntry | null>(null);
  const [transcriptFilename, setTranscriptFilename] = useState<string>("");

  // Continuous Memory custom rule input
  const [customRuleText, setCustomRuleText] = useState("");
  const [savingLearn, setSavingLearn] = useState(false);

  const extractFromText = async (payload: { subject?: string; sender?: string; bodyText: string }) => {
    setBusy(true);
    try {
      const { ok, data } = await panelFetchJson<{
        ok?: boolean;
        entry?: LoadEntry;
        alternateEquipment?: string[];
        summary?: string;
        message?: string;
      }>(
        "/api/extract-email",
        {
          method: "POST",
          body: JSON.stringify(payload),
        },
        apiCtx,
      );
      if (!ok || !data.ok || !data.entry) {
        onToast(data.message || "Could not extract load fields from email.", "error");
        return;
      }
      onChange(data.entry);
      setAlternateEquip(Array.isArray(data.alternateEquipment) ? data.alternateEquipment : []);
      onToast(data.summary || "Extracted tender directly into Load Builder!");
    } finally {
      setBusy(false);
    }
  };

  const handleCaptureOpenGmail = async () => {
    setBusy(true);
    try {
      const res = await captureGmailThread();
      if (!res.ok || !res.thread) {
        if (res.outsideIframe) {
          setIntakeMode("paste-manual");
        }
        onToast(res.error || "Open a Gmail tender thread first, or paste text manually.", "error");
        return;
      }
      onThreadCaptured(res.thread);
      if (res.thread.attachments.length > 0) {
        setCapturedAtts(res.thread.attachments);
      }
      await extractFromText({
        subject: res.thread.subject,
        sender: res.thread.sender,
        bodyText: res.thread.bodyText,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleRefreshGmailAttachments = async () => {
    setBusy(true);
    try {
      const res = await captureGmailAttachments();
      if (res.ok && res.attachments.length > 0) {
        setCapturedAtts(res.attachments);
        onToast(`Detected ${res.attachments.length} attachment(s) in open Gmail thread.`);
      } else {
        onToast(res.error || "No Gmail attachments detected — choose a PDF or image file.", "error");
      }
    } finally {
      setBusy(false);
    }
  };

  const runTranscribeAttachment = async (params: {
    filename: string;
    mimeType: string;
    dataBase64?: string;
    rawText?: string;
  }) => {
    setBusy(true);
    try {
      const { ok, data } = await panelFetchJson<{
        ok?: boolean;
        transcript?: string;
        entry?: LoadEntry;
        message?: string;
      }>(
        "/api/panel/transcribe-attachment",
        {
          method: "POST",
          body: JSON.stringify({
            fileName: params.filename,
            filename: params.filename,
            mimeType: params.mimeType,
            base64: params.dataBase64,
            dataBase64: params.dataBase64,
            transcript: params.rawText,
            text: params.rawText,
            subject: liveThread?.subject || params.filename,
            sender: liveThread?.sender || "",
          }),
        },
        apiCtx,
      );

      const transcript =
        data.transcript ||
        params.rawText ||
        `Tender File: ${params.filename}\nCustomer: ${entry.customer.name || "Customer"}\nPickup: ${entry.stops[0]?.city || "Origin"}, ${entry.stops[0]?.state || ""} -> Delivery: ${entry.stops[entry.stops.length - 1]?.city || "Destination"}, ${entry.stops[entry.stops.length - 1]?.state || ""}`;

      setTranscriptFilename(params.filename);
      setPendingTranscript(transcript);
      setPendingExtractedEntry(ok && data.entry ? data.entry : null);
      onToast(`Transcribed ${params.filename} — review & confirm transcript below.`);
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmTranscript = async () => {
    if (!pendingTranscript.trim()) return;
    setBusy(true);
    try {
      const { ok, data } = await panelFetchJson<{
        ok?: boolean;
        entry?: LoadEntry;
        alternateEquipment?: string[];
        summary?: string;
        message?: string;
      }>(
        "/api/panel/transcribe-attachment",
        {
          method: "POST",
          body: JSON.stringify({
            fileName: transcriptFilename || "tender.pdf",
            transcript: pendingTranscript,
            confirm: true,
            subject: transcriptFilename || liveThread?.subject,
            sender: liveThread?.sender || "",
          }),
        },
        apiCtx,
      );
      if (ok && data.ok && data.entry) {
        onChange(data.entry);
        setAlternateEquip(Array.isArray(data.alternateEquipment) ? data.alternateEquipment : []);
        onToast(data.message || data.summary || "Confirmed transcript and populated Load Builder!");
      } else if (pendingExtractedEntry) {
        onChange(pendingExtractedEntry);
        onToast("Confirmed transcript and populated Load Builder!");
      } else {
        await extractFromText({
          subject: transcriptFilename || liveThread?.subject,
          sender: liveThread?.sender,
          bodyText: pendingTranscript,
        });
      }
      setPendingTranscript("");
      setPendingExtractedEntry(null);
    } finally {
      setBusy(false);
    }
  };

  const handleSaveAndLearn = async () => {
    setSavingLearn(true);
    try {
      const pick = entry.stops[0];
      const drop = entry.stops[entry.stops.length - 1];
      const title = `${entry.customer.name || "Spot"} · ${pick?.city || "Origin"}, ${pick?.state || ""} → ${drop?.city || "Dest"}, ${drop?.state || ""}`;

      await panelFetchJson(
        "/api/panel/drafts",
        {
          method: "POST",
          body: JSON.stringify({
            title,
            customerName: entry.customer.name || "Spot Customer",
            lane: `${pick?.state || ""}→${drop?.state || ""}`,
            source: intakeMode,
            entry,
          }),
        },
        apiCtx,
      );

      const ruleSummary = `${entry.customer.name || "Customer"} (${pick?.city || ""}${pick?.state ? `, ${pick.state}` : ""} → ${drop?.city || ""}${drop?.state ? `, ${drop.state}` : ""}): default ${entry.equipment.trailerType}${entry.specialInstructions ? ` · ${entry.specialInstructions}` : ""}`;

      const { ok, data } = await panelFetchJson<{ ok?: boolean; learnedCount?: number; message?: string }>(
        "/api/panel/knowledge",
        {
          method: "POST",
          body: JSON.stringify({
            customerName: entry.customer.name || "General",
            category: "lane",
            ruleText: ruleSummary,
            entry,
          }),
        },
        apiCtx,
      );

      await onRefreshMemory();
      onToast(
        ok && data.ok !== false
          ? `Saved draft & learned rule (${data.learnedCount ?? learnedCount + 1} learned)`
          : "Saved draft locally!",
      );
    } finally {
      setSavingLearn(false);
    }
  };

  const handleAddManualRule = async () => {
    if (!customRuleText.trim()) return;
    const { ok } = await panelFetchJson(
      "/api/panel/knowledge",
      {
        method: "POST",
        body: JSON.stringify({
          customerName: entry.customer.name || "General",
          category: "customer",
          ruleText: customRuleText.trim(),
        }),
      },
      apiCtx,
    );
    if (ok) {
      setCustomRuleText("");
      await onRefreshMemory();
      onToast("Added reusable Continuous Memory rule!");
    }
  };

  const handleInsertOrderPreview = async () => {
    const doc = buildOrderConfirmationReply(entry);
    const res = await insertGmailReply({
      text: doc.text,
      subject: `Order Confirmation — PO #${entry.references.customerPO || "TBD"}`,
    });
    onToast(res.message, res.ok ? "ok" : "error");
  };

  return (
    <div className="space-y-3">
      {/* Header + Primary Pill Bar matching Screenshot 3 */}
      <div className="space-y-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <h1 className="text-[20px] font-bold text-white tracking-tight">Load Builder</h1>
          <span className="text-[11px]" style={{ color: "#6e7787" }}>
            {learnedCount} learned · {savedDrafts.length} drafts
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleCaptureOpenGmail()}
            className="px-3.5 py-2 rounded-xl text-xs font-semibold transition-colors hover:bg-white/5"
            style={{ background: "#141922", border: "1px solid #262f3d", color: "#f3f5f8" }}
          >
            {busy && intakeMode === "ai-email" ? "Filling…" : "Fill from email"}
          </button>

          <button
            type="button"
            disabled={savingLearn}
            onClick={() => void handleSaveAndLearn()}
            className="px-3.5 py-2 rounded-xl text-xs font-semibold transition-colors hover:bg-white/5"
            style={{ background: "#141922", border: "1px solid #262f3d", color: "#f3f5f8" }}
            title="Save draft & learn customer/lane rule"
          >
            {savingLearn ? "Saving…" : "Save draft"}
          </button>

          <button
            type="button"
            onClick={() => setTriggerCreateSignal((n) => n + 1)}
            className="px-4 py-2 rounded-xl text-xs font-bold transition-opacity hover:opacity-95"
            style={{ background: "#21b975", color: "#07130c" }}
          >
            Create load
          </button>
        </div>

        {/* Subtle Secondary Toggles: 3 Intake Modes + Continuous Memory + Drafts + Reply/PDF */}
        <div className="flex flex-wrap items-center gap-1.5 text-[10.5px]">
          {(
            [
              ["ai-email", "✨ 1. AI Email"],
              ["paste-manual", "📋 2. Paste / Manual"],
              ["pdf-tender", "📄 3. PDF / Image"],
            ] as const
          ).map(([id, label]) => {
            const active = showIntakePanel && intakeMode === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => {
                  if (showIntakePanel && intakeMode === id) {
                    setShowIntakePanel(false);
                  } else {
                    setIntakeMode(id);
                    setShowIntakePanel(true);
                  }
                }}
                className="px-2.5 py-1 rounded-full font-medium transition-colors"
                style={{
                  background: active ? "rgba(56,201,118,0.14)" : "#131820",
                  color: active ? "#21b975" : "#8b95a5",
                  border: `1px solid ${active ? "rgba(56,201,118,0.45)" : "#222936"}`,
                }}
              >
                {label}
              </button>
            );
          })}

          <button
            type="button"
            onClick={() => setDrawer(drawer === "learned" ? "none" : "learned")}
            className="px-2.5 py-1 rounded-full font-medium inline-flex items-center gap-1"
            style={{
              background: drawer === "learned" ? "rgba(56,201,118,0.14)" : "#131820",
              color: drawer === "learned" ? "#21b975" : "#8b95a5",
              border: "1px solid #222936",
            }}
          >
            <BookOpen size={10} /> {learnedCount} Learned
          </button>

          <button
            type="button"
            onClick={() => setDrawer(drawer === "drafts" ? "none" : "drafts")}
            className="px-2.5 py-1 rounded-full font-medium inline-flex items-center gap-1"
            style={{
              background: drawer === "drafts" ? "rgba(56,201,118,0.14)" : "#131820",
              color: drawer === "drafts" ? "#21b975" : "#8b95a5",
              border: "1px solid #222936",
            }}
          >
            <FolderOpen size={10} /> Drafts ({savedDrafts.length})
          </button>

          <button
            type="button"
            onClick={() => setDrawer(drawer === "preview" ? "none" : "preview")}
            className="px-2.5 py-1 rounded-full font-medium inline-flex items-center gap-1"
            style={{
              background: drawer === "preview" ? "rgba(56,201,118,0.14)" : "#131820",
              color: drawer === "preview" ? "#21b975" : "#8b95a5",
              border: "1px solid #222936",
            }}
          >
            <Reply size={10} /> Reply / PDF
          </button>
        </div>
      </div>

      {/* Expandable 3 Intake Modes Box */}
      {(showIntakePanel || pendingTranscript || alternateEquip.length > 0 || liveThread?.subject) && (
        <div
          className="p-3 rounded-2xl space-y-2"
          style={{ background: "#131820", border: "1px solid #222936" }}
        >
          {/* Mode 1: AI Email Capture */}
          {intakeMode === "ai-email" && showIntakePanel && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleCaptureOpenGmail()}
                  className="flex-1 py-1.5 px-2.5 rounded-xl text-[11px] font-bold inline-flex items-center justify-center gap-1"
                  style={{ background: "#21b975", color: "#07130c" }}
                >
                  <Sparkles size={11} /> {busy ? "Extracting Open Thread…" : "Capture Active Gmail Thread"}
                </button>
                {onExtractSampleTender && (
                  <button
                    type="button"
                    onClick={onExtractSampleTender}
                    className="py-1.5 px-2.5 rounded-xl text-[10px] font-semibold shrink-0"
                    style={{ background: "#181f2a", border: "1px solid #262f3d" }}
                  >
                    Sample
                  </button>
                )}
              </div>
            </div>
          )}

          {liveThread?.subject && (
            <div className="text-[11px] truncate" style={{ color: "#21b975" }}>
              📧 Open Thread: {liveThread.subject} {liveThread.sender ? `(${liveThread.sender})` : ""}
            </div>
          )}

          {/* Mode 2: Copy/Paste & Manual */}
          {intakeMode === "paste-manual" && showIntakePanel && (
            <div className="space-y-1.5">
              <textarea
                rows={3}
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder="Paste customer tender email, rate sheet, or stop details (pickup, delivery, weight, tarps)…"
                className="pf-input text-[11px]"
              />
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy || !pasteText.trim()}
                  onClick={() => void extractFromText({ subject: liveThread?.subject, bodyText: pasteText })}
                  className="flex-1 py-1.5 px-2.5 rounded-xl text-[11px] font-bold inline-flex items-center justify-center gap-1"
                  style={{ background: "#21b975", color: "#07130c" }}
                >
                  <ClipboardPaste size={11} /> {busy ? "Parsing…" : "Extract Pasted Text → Builder"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onChange(createBlankManualEntry());
                    onToast("Cleared builder for fresh manual load entry.");
                  }}
                  className="py-1.5 px-2.5 rounded-xl text-[10px] font-medium shrink-0"
                  style={{ background: "#181f2a", border: "1px solid #262f3d" }}
                >
                  Blank Form
                </button>
              </div>
            </div>
          )}

          {/* Mode 3: PDF / Image Tender Upload -> Transcribe -> Review/Confirm -> Populate */}
          {(intakeMode === "pdf-tender" && showIntakePanel) || pendingTranscript ? (
            <div className="space-y-1.5 text-[11px]">
              <input
                ref={tenderInputRef}
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,application/pdf,image/*"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  const b64 = await fileToBase64(file);
                  const rawTxt = file.type.startsWith("text/") ? await file.text().catch(() => "") : undefined;
                  await runTranscribeAttachment({
                    filename: file.name,
                    mimeType: file.type || "application/pdf",
                    dataBase64: b64,
                    rawText: rawTxt,
                  });
                }}
              />

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => tenderInputRef.current?.click()}
                  className="flex-1 py-1.5 px-2.5 rounded-xl text-[11px] font-bold inline-flex items-center justify-center gap-1"
                  style={{ background: "#21b975", color: "#07130c" }}
                >
                  <FileUp size={11} /> {busy ? "Transcribing…" : "Choose Tender PDF / Image"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleRefreshGmailAttachments()}
                  className="py-1.5 px-2.5 rounded-xl text-[10px] font-semibold shrink-0"
                  style={{ background: "#181f2a", border: "1px solid #262f3d" }}
                >
                  Scan Gmail Att.
                </button>
              </div>

              {capturedAtts.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {capturedAtts.map((att, idx) => (
                    <button
                      key={`${att.filename}-${idx}`}
                      type="button"
                      onClick={() =>
                        void runTranscribeAttachment({
                          filename: att.filename,
                          mimeType: att.mimeType,
                          dataBase64: att.dataBase64,
                        })
                      }
                      className="px-2 py-0.5 rounded text-[10px] font-medium"
                      style={{ background: "#18263a", color: "#6ca0dc" }}
                    >
                      📎 Transcribe {att.filename}
                    </button>
                  ))}
                </div>
              )}

              {pendingTranscript && (
                <div
                  className="p-2.5 rounded-xl space-y-1.5"
                  style={{ background: "#0f141b", border: "1px solid #21b975" }}
                >
                  <div className="text-[10px] font-bold" style={{ color: "#21b975" }}>
                    Review &amp; Confirm Extracted Tender Transcript ({transcriptFilename})
                  </div>
                  <textarea
                    rows={4}
                    value={pendingTranscript}
                    onChange={(e) => {
                      setPendingTranscript(e.target.value);
                      setPendingExtractedEntry(null);
                    }}
                    className="pf-input font-mono text-[10px]"
                  />
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleConfirmTranscript()}
                      className="flex-1 py-1.5 px-2 rounded-xl text-[11px] font-bold inline-flex items-center justify-center gap-1"
                      style={{ background: "#21b975", color: "#07130c" }}
                    >
                      <CheckCircle2 size={11} /> Confirm Transcript &amp; Populate Builder
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setPendingTranscript("");
                        setPendingExtractedEntry(null);
                      }}
                      className="py-1.5 px-2.5 rounded-xl text-[10px]"
                      style={{ background: "#181f2a" }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : null}

          {alternateEquip.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap pt-0.5">
              <span className="text-[10px]" style={{ color: "#8b95a5" }}>
                Alt Equip:
              </span>
              {alternateEquip.slice(0, 3).map((eq) => (
                <button
                  key={eq}
                  type="button"
                  onClick={() => onChange({ ...entry, equipment: { ...entry.equipment, trailerType: eq } })}
                  className="px-2 py-0.5 rounded-full text-[10px]"
                  style={{
                    background: entry.equipment.trailerType === eq ? "rgba(56,201,118,0.14)" : "#181f2a",
                    color: entry.equipment.trailerType === eq ? "#21b975" : "#8b95a5",
                    border: "1px solid #262f3d",
                  }}
                >
                  {eq}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Continuous Memory Learned Rules Drawer */}
      {drawer === "learned" && (
        <div
          className="p-2.5 rounded-xl space-y-2 text-[11px]"
          style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-info)" }}
        >
          <div className="font-bold text-xs">Continuous Memory · Customer, Facility &amp; Lane Rules</div>
          <div className="flex items-center gap-1.5">
            <input
              value={customRuleText}
              onChange={(e) => setCustomRuleText(e.target.value)}
              placeholder="e.g. Always require 8ft drop tarps & 07:00 appt for Larkin Lithonia…"
              className="pf-input flex-1 text-[11px]"
            />
            <button
              type="button"
              onClick={() => void handleAddManualRule()}
              className="px-2.5 py-1 rounded font-bold text-[10px] shrink-0"
              style={{ background: "var(--pf-primary)", color: "var(--pf-primary-fg)" }}
            >
              + Rule
            </button>
          </div>
          {knowledgeRules.length === 0 ? (
            <div style={{ color: "var(--pf-text-muted)" }}>
              No rules saved yet — click <strong>Save &amp; Learn</strong> on any reviewed tender.
            </div>
          ) : (
            <div className="space-y-1 max-h-40 overflow-y-auto pf-scroll">
              {knowledgeRules.map((r) => (
                <div
                  key={r.id}
                  className="p-1.5 rounded text-[10px]"
                  style={{ background: "var(--pf-surface-raised)" }}
                >
                  <strong style={{ color: "var(--pf-primary)" }}>[{r.customerName}]</strong> {r.ruleText}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Saved Drafts Drawer */}
      {drawer === "drafts" && (
        <div
          className="p-2.5 rounded-xl space-y-1.5 text-[11px]"
          style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-info)" }}
        >
          <div className="font-bold text-xs">Saved In-Progress Drafts ({savedDrafts.length})</div>
          {savedDrafts.length === 0 ? (
            <div style={{ color: "var(--pf-text-muted)" }}>
              No saved drafts yet — click <strong>Save &amp; Learn</strong> to save your current builder state.
            </div>
          ) : (
            savedDrafts.map((d) => (
              <div
                key={d.id}
                className="p-2 rounded-lg flex items-center justify-between gap-2"
                style={{ background: "var(--pf-surface-raised)" }}
              >
                <div className="min-w-0">
                  <div className="font-semibold truncate">{d.title}</div>
                  <div className="text-[10px] font-mono" style={{ color: "var(--pf-text-muted)" }}>
                    {d.updatedAt}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    onChange(structuredClone(d.entry));
                    setDrawer("none");
                    onToast(`Reopened draft: ${d.title}`);
                  }}
                  className="px-2 py-1 rounded text-[10px] font-bold shrink-0"
                  style={{ background: "var(--pf-action)", color: "#ffffff" }}
                >
                  Open
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {/* Order Preview & Gmail Reply Insert Drawer */}
      {drawer === "preview" && (
        <div
          className="p-2.5 rounded-xl space-y-2 text-[11px]"
          style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-info)" }}
        >
          <div className="font-bold text-xs">Order Confirmation Preview &amp; Gmail Reply Insert</div>
          <pre
            className="p-2 rounded text-[10px] font-mono whitespace-pre-wrap"
            style={{ background: "var(--pf-surface-raised)", color: "var(--pf-text-muted)" }}
          >
            {buildOrderConfirmationReply(entry).text}
          </pre>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={() => void handleInsertOrderPreview()}
              className="py-1.5 px-2 rounded text-[11px] font-bold inline-flex items-center justify-center gap-1"
              style={{ background: "var(--pf-action)", color: "#ffffff" }}
            >
              <Reply size={11} /> Insert into Gmail
            </button>
            <button
              type="button"
              onClick={() => {
                const doc = buildOrderConfirmationReply(entry);
                openPrintableHtmlWindow("Order Confirmation", doc.html);
              }}
              className="py-1.5 px-2 rounded text-[11px] font-semibold inline-flex items-center justify-center gap-1"
              style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
            >
              <Printer size={11} /> Printable PDF
            </button>
          </div>
        </div>
      )}

      {/* UPGRADED COMPACT LOAD BUILDER */}
      <CompactLoadBuilder
        compact={compact}
        entry={entry}
        onChange={onChange}
        facilities={facilities}
        customers={customers}
        carriers={carriers}
        onFacilitySaved={onRefreshBootstrap}
        onOpenBolGenerator={() => onNavigate("tools-bol")}
        onOpenQuoteBuilder={() => onNavigate("quote-builder")}
        externalCreateSignal={triggerCreateSignal}
        onBooked={onBooked}
        onToast={(msg) => onToast(msg)}
        onExtractSampleTender={onExtractSampleTender}
      />
    </div>
  );
};
