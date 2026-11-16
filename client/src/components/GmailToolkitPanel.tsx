import React, { useEffect, useState } from "react";
import type { LoadEntry } from "@shared/load-entry";
import type {
  CarrierOption,
  CrucialEmailItem,
  CustomerOption,
  OpsShipment,
  SavedFacility,
} from "@shared/tai-webhook-schema";
import { CompactLoadBuilder } from "./CompactLoadBuilder";
import { buildGmailContainerSearchUrl } from "@shared/container-extractor";
import { ClipboardPaste, ExternalLink, Search, Send, Sparkles, Trash2, UserPlus } from "lucide-react";

interface GmailToolkitPanelProps {
  shipments: OpsShipment[];
  crucialEmails: CrucialEmailItem[];
  facilities: SavedFacility[];
  customers: CustomerOption[];
  carriers: CarrierOption[];
  builderEntry: LoadEntry;
  onBuilderChange: (next: LoadEntry) => void;
  onApplyEmailAction: (email: CrucialEmailItem) => Promise<void>;
  onBooked: (ids: string[], msg: string) => void;
  onToast: (msg: string) => void;
  onExtractTender: () => void;
  chatHistory: Array<{ role: "user" | "assistant"; text: string }>;
  onAskAi: (q: string) => Promise<void>;
  onDeleteEmail?: (id: string) => Promise<void>;
  onSaveToCrm?: (email: CrucialEmailItem) => Promise<void>;
}

export const GmailToolkitPanel: React.FC<GmailToolkitPanelProps> = ({
  shipments,
  crucialEmails,
  facilities,
  customers,
  carriers,
  builderEntry,
  onBuilderChange,
  onApplyEmailAction,
  onBooked,
  onToast,
  onExtractTender,
  chatHistory,
  onAskAi,
  onDeleteEmail,
  onSaveToCrm,
}) => {
  const [tab, setTab] = useState<"inbox" | "dispatch" | "builder" | "ai">("builder");
  const [activeEmailIdx, setActiveEmailIdx] = useState<number>(0);
  const [expandedId, setExpandedId] = useState<string | null>(shipments[0]?.id ?? null);
  const [aiInput, setAiInput] = useState("");
  const [liveSubject, setLiveSubject] = useState<string>("");
  const [showPasteBox, setShowPasteBox] = useState<boolean>(false);
  const [pasteEmailText, setPasteEmailText] = useState<string>("");
  const [extracting, setExtracting] = useState<boolean>(false);
  const [alternateEquip, setAlternateEquip] = useState<string[]>([]);
  const [panelNotice, setPanelNotice] = useState<string>("");

  const notify = (msg: string) => {
    setPanelNotice(msg);
    onToast(msg);
  };

  const extractEmailToBuilder = async (payload: { subject?: string; sender?: string; bodyText: string }) => {
    setExtracting(true);
    try {
      const res = await fetch("/api/extract-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const out = await res.json();
      if (!out.ok || !out.entry) {
        notify(out.message || "Could not extract load from email");
        return;
      }
      onBuilderChange(out.entry);
      setAlternateEquip(Array.isArray(out.alternateEquipment) ? out.alternateEquipment : []);
      setTab("builder");
      setShowPasteBox(false);
      notify(out.summary || "Extracted open email into Compact Builder");
    } finally {
      setExtracting(false);
    }
  };

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (window.parent !== window && event.source !== window.parent) return;
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "FIVENINES_GMAIL_CONTEXT" && data.payload?.subject) {
        setLiveSubject(String(data.payload.subject));
      }
      if (data.type === "FIVENINES_GMAIL_CAPTURED") {
        if (!data.ok || !data.payload) {
          setShowPasteBox(true);
          notify(data.error || "No open Gmail thread detected — paste email text below.");
          return;
        }
        if (data.payload.subject) setLiveSubject(String(data.payload.subject));
        void extractEmailToBuilder({
          subject: data.payload.subject,
          sender: data.payload.sender,
          bodyText: data.payload.bodyText || "",
        });
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const requestOpenGmailCapture = () => {
    if (window.parent !== window) {
      const requestId = `cap-${Date.now()}`;
      window.parent.postMessage({ type: "FIVENINES_CAPTURE_GMAIL_REQ", requestId }, "*");
      notify("Reading open Gmail conversation…");
    } else {
      setShowPasteBox((v) => !v);
      notify("Paste Gmail tender text below to extract directly into TAI fields.");
    }
  };

  const openEmail = crucialEmails[activeEmailIdx] || crucialEmails[0];
  const openCount = crucialEmails.filter((e) => !e.applied).length;

  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ background: "var(--pf-bg)" }}>
      {/* Masthead */}
      <div style={{ background: "var(--pf-masthead)", color: "#ffffff", borderBottom: "1px solid var(--pf-border)" }}>
        <div className="pf-brand-rule">
          <div style={{ background: "#1D2C5E" }} />
          <div style={{ background: "#682C87" }} />
          <div style={{ background: "#D52A3B" }} />
          <div style={{ background: "#F0641E" }} />
          <div style={{ background: "#F5B841" }} />
        </div>
        <div className="px-3 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span
              className="w-5 h-5 rounded flex items-center justify-center font-bold text-[10px]"
              style={{ background: "#F0641E" }}
            >
              PF
            </span>
            <span className="font-serif font-bold text-xs">Freight Toolkit · Compact</span>
          </div>
          <span
            className="font-mono text-[10px] px-2 py-0.5 rounded-full"
            style={{ background: "rgba(62,191,130,0.2)", color: "#3EBF82" }}
          >
            ● TAI Sync
          </span>
        </div>

        {/* 4 Paper Tabs */}
        <div className="px-2 pb-1.5 grid grid-cols-4 gap-1 text-[11px]">
          {(
            [
              ["inbox", `Inbox (${openCount})`],
              ["dispatch", "Dispatch"],
              ["builder", "+ Builder"],
              ["ai", "✦ Copilot"],
            ] as const
          ).map(([id, label]) => {
            const active = tab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className="py-1 rounded font-semibold transition-all"
                style={{
                  background: active ? "rgba(240,100,30,0.24)" : "transparent",
                  color: active ? "#ffffff" : "rgba(255,255,255,0.68)",
                  border: active ? "1px solid rgba(240,100,30,0.55)" : "1px solid transparent",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Body */}
      {panelNotice && (
        <div
          className="px-2.5 py-1.5 text-[11px] flex items-center justify-between gap-2 shrink-0"
          style={{ background: "#163528", color: "#8ce6b8", borderBottom: "1px solid #255943" }}
        >
          <span className="truncate">✓ {panelNotice}</span>
          <button type="button" onClick={() => setPanelNotice("")} className="underline shrink-0">
            ×
          </button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto pf-scroll p-2.5 space-y-2.5">
        {tab === "inbox" && (
          <>
            {/* Open Gmail Thread Context Card */}
            {openEmail && (
              <div
                className="p-3 rounded-xl space-y-2"
                style={{ background: "var(--pf-surface)", border: "2px solid var(--pf-action)" }}
              >
                <div className="flex items-center justify-between text-[11px] gap-2">
                  <span className="font-bold uppercase tracking-wider" style={{ color: "var(--pf-action)" }}>
                    Selected Email &amp; Load
                  </span>
                  <div className="flex items-center gap-2">
                    {openEmail.containerNumber && (
                      <a
                        href={buildGmailContainerSearchUrl(openEmail.containerNumber, openEmail.loadId)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 hover:underline font-mono"
                        style={{ color: "var(--pf-info)" }}
                        title="Search all emails mentioning this container #"
                      >
                        <Search size={10} /> {openEmail.containerNumber}
                      </a>
                    )}
                    <a
                      href={
                        openEmail.permalink ||
                        `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(
                          openEmail.loadId !== "NEW" ? openEmail.loadId : openEmail.subject,
                        )}`
                      }
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 hover:underline"
                      style={{ color: "var(--pf-primary)" }}
                    >
                      <ExternalLink size={11} /> Gmail
                    </a>
                    <span className="font-mono" style={{ color: "var(--pf-text-muted)" }}>
                      {openEmail.loadId === "NEW" ? "New Tender" : `#${openEmail.loadId}`}
                    </span>
                    {onDeleteEmail && (
                      <button
                        type="button"
                        onClick={() => onDeleteEmail(openEmail.id)}
                        className="p-1 rounded"
                        style={{ background: "var(--pf-danger-dim)", color: "var(--pf-danger)" }}
                        title="Delete email tile"
                      >
                        <Trash2 size={11} />
                      </button>
                    )}
                  </div>
                </div>

                <div className="text-xs font-semibold leading-snug">{openEmail.subject}</div>
                <div className="text-[11px]" style={{ color: "var(--pf-text-subtle)" }}>
                  {openEmail.senderName || openEmail.from} · {openEmail.received}
                </div>

                {openEmail.operationalNote && (
                  <div
                    className="p-2 rounded text-[11px] font-semibold"
                    style={{ background: "var(--pf-warning-dim)", color: "var(--pf-warning)" }}
                  >
                    {openEmail.operationalNote}
                  </div>
                )}

                <div
                  className="p-2 rounded text-[11px] leading-relaxed whitespace-pre-wrap max-h-36 overflow-y-auto pf-scroll"
                  style={{ background: "var(--pf-bg)", border: "1px solid var(--pf-border)", color: "var(--pf-text-muted)" }}
                >
                  {openEmail.fullBody || openEmail.body}
                </div>

                <div
                  className="p-2 rounded text-[11px] flex items-center justify-between gap-2"
                  style={{ background: "var(--pf-surface-raised)" }}
                >
                  <span className="truncate">{openEmail.diffLabel}</span>
                  <strong className="font-mono shrink-0" style={{ color: "var(--pf-primary)" }}>
                    {openEmail.diffValue}
                  </strong>
                </div>

                <div className="flex gap-1.5 flex-wrap">
                  {openEmail.loadId !== "NEW" && (
                    <button
                      type="button"
                      onClick={() => {
                        setExpandedId(openEmail.loadId);
                        setTab("dispatch");
                      }}
                      className="px-2 py-2 rounded-lg text-[11px] font-semibold shrink-0"
                      style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
                    >
                      View Load #{openEmail.loadId}
                    </button>
                  )}
                  {onSaveToCrm && (
                    <button
                      type="button"
                      onClick={() => onSaveToCrm(openEmail)}
                      className="px-2 py-2 rounded-lg text-[11px] font-semibold inline-flex items-center gap-1 shrink-0"
                      style={{ background: "var(--pf-primary-dim)", color: "var(--pf-primary)" }}
                      title="Add sender to SalesOps CRM"
                    >
                      <UserPlus size={11} /> + CRM
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={async () => {
                      if (openEmail.diffType === "new_tender") {
                        onExtractTender();
                        setTab("builder");
                      } else {
                        await onApplyEmailAction(openEmail);
                      }
                    }}
                    className="flex-1 py-2 px-2.5 rounded-lg text-xs font-bold truncate"
                    style={{ background: "var(--pf-action)", color: "#ffffff" }}
                  >
                    {openEmail.applied ? "✓ Synced" : openEmail.ctaLabel}
                  </button>
                </div>
              </div>
            )}

            {/* Crucial Action Queue ONLY */}
            <div className="text-[11px] font-semibold uppercase tracking-wider pt-1" style={{ color: "var(--pf-text-muted)" }}>
              Crucial Action Emails Only ({crucialEmails.length})
            </div>
            <div className="space-y-1.5">
              {crucialEmails.map((em, i) => (
                <div
                  key={em.id}
                  onClick={() => setActiveEmailIdx(i)}
                  className="cursor-pointer w-full text-left p-2.5 rounded-lg space-y-0.5"
                  style={{
                    background: i === activeEmailIdx ? "var(--pf-surface-raised)" : "var(--pf-surface)",
                    border: `1px solid ${i === activeEmailIdx ? "var(--pf-primary)" : "var(--pf-border)"}`,
                  }}
                >
                  <div className="flex items-center justify-between text-[11px] gap-2">
                    <span className="font-mono font-bold" style={{ color: "var(--pf-action)" }}>
                      {em.loadId === "NEW" ? "TENDER" : `#${em.loadId}`}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <span style={{ color: "var(--pf-text-subtle)" }}>{em.received}</span>
                      {onDeleteEmail && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteEmail(em.id);
                          }}
                          className="p-0.5 rounded hover:opacity-80"
                          style={{ background: "var(--pf-danger-dim)", color: "var(--pf-danger)" }}
                          title="Delete email tile"
                        >
                          <Trash2 size={10} />
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="text-xs font-medium truncate">{em.subject}</div>
                  <div className="text-[11px]" style={{ color: em.applied ? "var(--pf-primary)" : "var(--pf-warning)" }}>
                    {em.applied ? "✓ Applied" : em.diffLabel}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {tab === "dispatch" && (
          <div className="space-y-2">
            {shipments.map((s) => {
              const exp = expandedId === s.id;
              const totWt = s.commodities.reduce((a, c) => a + c.weightTotal, 0);
              return (
                <div
                  key={s.id}
                  className="rounded-lg overflow-hidden"
                  style={{
                    background: "var(--pf-surface)",
                    border: `1px solid ${exp ? "var(--pf-action)" : "var(--pf-border)"}`,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setExpandedId(exp ? null : s.id)}
                    className="w-full text-left p-2.5 space-y-1"
                  >
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-mono font-bold" style={{ color: "var(--pf-action)" }}>
                        {exp ? "▼" : "▶"} #{s.id}
                      </span>
                      <span className="font-mono font-semibold">${s.sell.toLocaleString()}</span>
                    </div>
                    <div className="text-xs font-semibold truncate">
                      {s.origin} → {s.dest}
                    </div>
                    <div className="text-[11px]" style={{ color: "var(--pf-text-muted)" }}>
                      {s.containerNumber ? `📦 ${s.containerNumber} · ` : ""}{s.stage} · {s.carrier || "Needs carrier"} · {totWt.toLocaleString()} lbs
                    </div>
                  </button>
                  {exp && (
                    <div
                      className="p-2.5 space-y-1.5 text-[11px]"
                      style={{ background: "var(--pf-surface-raised)", borderTop: "1px solid var(--pf-border)" }}
                    >
                      {s.operationalNote && (
                        <div className="p-1.5 rounded font-semibold" style={{ background: "var(--pf-warning-dim)", color: "var(--pf-warning)" }}>
                          {s.operationalNote}
                        </div>
                      )}
                      {s.stops.map((st, idx) => (
                        <div key={idx}>
                          <strong>{st.stopType}:</strong> {st.companyName} ({st.city}, {st.state}{" "}
                          <span className="font-mono">{st.zipCode}</span>)
                        </div>
                      ))}
                      <div>
                        <strong>Items:</strong>{" "}
                        {s.commodities.map((c) => `${c.piecesTotal} ${c.packagingType} ${c.description}`).join("; ")}
                      </div>
                      <div className="font-mono" style={{ color: "var(--pf-primary)" }}>
                        {s.writebackState}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {tab === "builder" && (
          <div className="space-y-2">
            {/* Live Gmail Thread Capture & Quick Email Paste */}
            <div
              className="p-2 rounded-lg space-y-1.5"
              style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
            >
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={extracting}
                  onClick={requestOpenGmailCapture}
                  className="flex-1 py-1.5 px-2.5 rounded text-[11px] font-bold inline-flex items-center justify-center gap-1"
                  style={{ background: "var(--pf-action)", color: "#ffffff" }}
                >
                  <Sparkles size={11} /> {extracting ? "Extracting…" : "Capture Open Gmail"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowPasteBox((v) => !v)}
                  className="py-1.5 px-2.5 rounded text-[11px] font-medium inline-flex items-center gap-1"
                  style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
                  title="Paste email or tender text manually"
                >
                  <ClipboardPaste size={11} /> Paste
                </button>
              </div>
              {liveSubject && (
                <div className="text-[10px] truncate" style={{ color: "var(--pf-primary)" }}>
                  📧 Open Thread: {liveSubject}
                </div>
              )}
              {alternateEquip.length > 0 && (
                <div className="flex items-center gap-1 flex-wrap pt-0.5">
                  <span className="text-[10px]" style={{ color: "var(--pf-text-muted)" }}>
                    Alt Equip:
                  </span>
                  {alternateEquip.slice(0, 3).map((eq) => (
                    <button
                      key={eq}
                      type="button"
                      onClick={() =>
                        onBuilderChange({
                          ...builderEntry,
                          equipment: { ...builderEntry.equipment, trailerType: eq },
                        })
                      }
                      className="px-1.5 py-0.5 rounded text-[10px]"
                      style={{
                        background:
                          builderEntry.equipment.trailerType === eq ? "var(--pf-primary-dim)" : "var(--pf-surface-raised)",
                        color: builderEntry.equipment.trailerType === eq ? "var(--pf-primary)" : "var(--pf-text-muted)",
                        border: "1px solid var(--pf-border)",
                      }}
                    >
                      {eq}
                    </button>
                  ))}
                </div>
              )}
              {showPasteBox && (
                <div className="space-y-1.5 pt-1">
                  <textarea
                    rows={3}
                    value={pasteEmailText}
                    onChange={(e) => setPasteEmailText(e.target.value)}
                    placeholder="Paste Gmail tender email here (pickup, delivery, weight, tarps/conestoga)…"
                    className="pf-input w-full text-[11px]"
                  />
                  <button
                    type="button"
                    disabled={extracting || !pasteEmailText.trim()}
                    onClick={() => extractEmailToBuilder({ subject: liveSubject, bodyText: pasteEmailText })}
                    className="w-full py-1.5 rounded text-[11px] font-bold"
                    style={{ background: "var(--pf-primary)", color: "var(--pf-primary-fg)" }}
                  >
                    Extract Pasted Email → Compact Builder
                  </button>
                </div>
              )}
            </div>

            <CompactLoadBuilder
              compact={true}
              entry={builderEntry}
              onChange={onBuilderChange}
              facilities={facilities}
              customers={customers}
              carriers={carriers}
              onBooked={(ids, msg) => {
                notify(msg);
                onBooked(ids, msg);
                setTab("dispatch");
                if (ids[0]) setExpandedId(ids[0]);
              }}
              onToast={notify}
              onExtractSampleTender={onExtractTender}
            />
          </div>
        )}

        {tab === "ai" && (
          <div className="space-y-2.5">
            <div className="flex flex-wrap gap-1">
              {["PA→GA lane runners", "TAI webhook health", "Status 132738007"].map((chip) => (
                <button
                  key={chip}
                  type="button"
                  onClick={() => onAskAi(chip)}
                  className="px-2 py-1 rounded-full text-[11px]"
                  style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
                >
                  {chip}
                </button>
              ))}
            </div>
            <div className="space-y-2">
              {chatHistory.map((m, i) => (
                <div
                  key={i}
                  className="p-2.5 rounded-lg text-xs"
                  style={{
                    background: m.role === "user" ? "var(--pf-surface-raised)" : "var(--pf-surface)",
                    border: "1px solid var(--pf-border)",
                  }}
                >
                  {m.text}
                </div>
              ))}
            </div>
            <div className="flex gap-1.5">
              <input
                value={aiInput}
                onChange={(e) => setAiInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && aiInput.trim()) {
                    onAskAi(aiInput);
                    setAiInput("");
                  }
                }}
                placeholder="Ask carrier MC, load #, margin…"
                className="pf-input flex-1"
              />
              <button
                type="button"
                onClick={() => {
                  if (aiInput.trim()) {
                    onAskAi(aiInput);
                    setAiInput("");
                  }
                }}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold"
                style={{ background: "var(--pf-primary)", color: "var(--pf-primary-fg)" }}
              >
                <Send size={13} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
