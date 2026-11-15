import React, { useState } from "react";
import type { LoadEntry } from "@shared/load-entry";
import type {
  CarrierOption,
  CrucialEmailItem,
  CustomerOption,
  OpsShipment,
  SavedFacility,
} from "@shared/tai-webhook-schema";
import { CompactLoadBuilder } from "./CompactLoadBuilder";
import { Send } from "lucide-react";

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
}) => {
  const [tab, setTab] = useState<"inbox" | "dispatch" | "builder" | "ai">("builder");
  const [activeEmailIdx, setActiveEmailIdx] = useState<number>(0);
  const [expandedId, setExpandedId] = useState<string | null>(shipments[0]?.id ?? null);
  const [aiInput, setAiInput] = useState("");

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
      <div className="flex-1 overflow-y-auto pf-scroll p-2.5 space-y-2.5">
        {tab === "inbox" && (
          <>
            {/* Open Gmail Thread Context Card */}
            {openEmail && (
              <div
                className="p-3 rounded-xl space-y-2"
                style={{ background: "var(--pf-surface)", border: "2px solid var(--pf-action)" }}
              >
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-bold uppercase tracking-wider" style={{ color: "var(--pf-action)" }}>
                    Open Gmail Thread
                  </span>
                  <span className="font-mono" style={{ color: "var(--pf-text-muted)" }}>
                    {openEmail.loadId === "NEW" ? "New Tender" : `#${openEmail.loadId}`}
                  </span>
                </div>
                <div className="text-xs font-semibold leading-snug">{openEmail.subject}</div>
                <div
                  className="p-2 rounded text-[11px] flex items-center justify-between gap-2"
                  style={{ background: "var(--pf-surface-raised)" }}
                >
                  <span>{openEmail.diffLabel}</span>
                  <strong className="font-mono" style={{ color: "var(--pf-primary)" }}>
                    {openEmail.diffValue}
                  </strong>
                </div>
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
                  className="w-full py-2 rounded-lg text-xs font-bold"
                  style={{ background: "var(--pf-action)", color: "#ffffff" }}
                >
                  {openEmail.applied ? "✓ Synced" : openEmail.ctaLabel}
                </button>
              </div>
            )}

            {/* Crucial Action Queue ONLY */}
            <div className="text-[11px] font-semibold uppercase tracking-wider pt-1" style={{ color: "var(--pf-text-muted)" }}>
              Crucial Action Emails Only ({crucialEmails.length})
            </div>
            <div className="space-y-1.5">
              {crucialEmails.map((em, i) => (
                <button
                  key={em.id}
                  type="button"
                  onClick={() => setActiveEmailIdx(i)}
                  className="w-full text-left p-2.5 rounded-lg space-y-0.5"
                  style={{
                    background: i === activeEmailIdx ? "var(--pf-surface-raised)" : "var(--pf-surface)",
                    border: `1px solid ${i === activeEmailIdx ? "var(--pf-primary)" : "var(--pf-border)"}`,
                  }}
                >
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-mono font-bold" style={{ color: "var(--pf-action)" }}>
                      {em.loadId === "NEW" ? "TENDER" : `#${em.loadId}`}
                    </span>
                    <span style={{ color: "var(--pf-text-subtle)" }}>{em.received}</span>
                  </div>
                  <div className="text-xs font-medium truncate">{em.subject}</div>
                  <div className="text-[11px]" style={{ color: em.applied ? "var(--pf-primary)" : "var(--pf-warning)" }}>
                    {em.applied ? "✓ Applied" : em.diffLabel}
                  </div>
                </button>
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
                      {s.stage} · {s.carrier || "Needs carrier"} · {totWt.toLocaleString()} lbs
                    </div>
                  </button>
                  {exp && (
                    <div
                      className="p-2.5 space-y-1.5 text-[11px]"
                      style={{ background: "var(--pf-surface-raised)", borderTop: "1px solid var(--pf-border)" }}
                    >
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
          <CompactLoadBuilder
            compact={true}
            entry={builderEntry}
            onChange={onBuilderChange}
            facilities={facilities}
            customers={customers}
            carriers={carriers}
            onBooked={(ids, msg) => {
              onBooked(ids, msg);
              setTab("dispatch");
              if (ids[0]) setExpandedId(ids[0]);
            }}
            onToast={onToast}
            onExtractSampleTender={onExtractTender}
          />
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
