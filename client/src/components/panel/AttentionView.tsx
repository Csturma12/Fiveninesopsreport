import React, { useState } from "react";
import type { CrucialEmailItem, OpsShipment } from "@shared/tai-webhook-schema";
import { buildGmailContainerSearchUrl } from "@shared/container-extractor";
import { AlertTriangle, CheckCircle2, DollarSign, ExternalLink, FileWarning, Package, Search, Truck, Upload } from "lucide-react";
import { isApTaskResolved, type ApTaskRecord, type PanelViewId } from "./panelTypes";

interface AttentionViewProps {
  shipments: OpsShipment[];
  crucialEmails: CrucialEmailItem[];
  apTasks: ApTaskRecord[];
  onInspectLoad: (shipmentId: string, targetView?: "dispatch" | "all-loads") => void;
  onApplyEmailAction: (email: CrucialEmailItem) => Promise<void>;
  onUploadPod?: (shipmentId: string) => void;
  onExtractTenderToBuilder: () => void;
  onNavigate: (view: PanelViewId) => void;
}

type SectionFilter = "all" | "uncovered" | "mismatches" | "pods" | "containers" | "ap";

export const AttentionView: React.FC<AttentionViewProps> = ({
  shipments,
  crucialEmails,
  apTasks,
  onInspectLoad,
  onApplyEmailAction,
  onUploadPod,
  onExtractTenderToBuilder,
  onNavigate,
}) => {
  const [filter, setFilter] = useState<SectionFilter>("all");

  const uncoveredLoads = shipments.filter((s) => s.stage === "Needs truck" || !s.carrier.trim());
  const mismatchLoads = shipments.filter((s) => Boolean(s.mismatchNote) || (s.buy > 0 && s.sell < s.buy) || !s.po.trim());
  const mismatchEmails = crucialEmails.filter(
    (e) => !e.applied && (e.diffType === "rate_mismatch" || e.diffType === "missing_po"),
  );
  const missingPodLoads = shipments.filter((s) => s.stage === "Delivered" && s.podCount === 0);
  const missingPodEmails = crucialEmails.filter((e) => !e.applied && e.diffType === "missing_pod");
  const containerExceptions = shipments.filter(
    (s) =>
      Boolean(s.operationalNote) ||
      Boolean(s.containerEvents && s.containerEvents.some((ev) => ev.kind === "tonu" || ev.kind === "exception")),
  );
  const openApAndTenders = [
    ...apTasks.filter((t) => !isApTaskResolved(t.status)),
  ];
  const unbookedTenders = crucialEmails.filter((e) => !e.applied && e.diffType === "new_tender");

  const pills: Array<{ id: SectionFilter; label: string; count: number }> = [
    {
      id: "all",
      label: "All",
      count:
        uncoveredLoads.length +
        mismatchLoads.length +
        mismatchEmails.length +
        missingPodLoads.length +
        containerExceptions.length +
        openApAndTenders.length +
        unbookedTenders.length,
    },
    { id: "uncovered", label: "Uncovered", count: uncoveredLoads.length },
    { id: "mismatches", label: "Rate/TMS", count: mismatchLoads.length + mismatchEmails.length },
    { id: "pods", label: "Missing POD", count: missingPodLoads.length + missingPodEmails.length },
    { id: "containers", label: "TONU/Cntr", count: containerExceptions.length },
    { id: "ap", label: "AP & Tenders", count: openApAndTenders.length + unbookedTenders.length },
  ];

  return (
    <div className="space-y-2.5">
      {/* Filter Pills */}
      <div className="flex flex-wrap gap-1">
        {pills.map((p) => {
          const active = filter === p.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => setFilter(p.id)}
              className="px-2 py-1 rounded-full text-[10px] font-semibold inline-flex items-center gap-1"
              style={{
                background: active ? "var(--pf-action)" : "var(--pf-surface)",
                color: active ? "#ffffff" : "var(--pf-text-muted)",
                border: `1px solid ${active ? "var(--pf-action)" : "var(--pf-border)"}`,
              }}
            >
              <span>{p.label}</span>
              <span className="font-mono">{p.count}</span>
            </button>
          );
        })}
      </div>

      {/* SECTION 1: Uncovered Committed Loads */}
      {(filter === "all" || filter === "uncovered") && (
        <section
          className="p-2.5 rounded-xl space-y-1.5"
          style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
        >
          <div className="flex items-center justify-between text-[11px] font-bold">
            <span className="inline-flex items-center gap-1.5" style={{ color: "var(--pf-warning)" }}>
              <Truck size={12} /> 1. Uncovered Committed ({uncoveredLoads.length})
            </span>
            <button
              type="button"
              onClick={() => onNavigate("dispatch")}
              className="text-[10px] underline"
              style={{ color: "var(--pf-text-muted)" }}
            >
              Dispatch Board →
            </button>
          </div>
          {uncoveredLoads.length === 0 ? (
            <div className="text-[11px]" style={{ color: "var(--pf-text-muted)" }}>
              ✓ All committed shipments have assigned carriers.
            </div>
          ) : (
            uncoveredLoads.map((s) => (
              <div
                key={s.id}
                className="p-2 rounded-lg flex items-center justify-between gap-2 text-xs"
                style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono font-bold" style={{ color: "var(--pf-action)" }}>
                      #{s.id}
                    </span>
                    <span className="font-semibold truncate">{s.customer}</span>
                  </div>
                  <div className="text-[10px] truncate" style={{ color: "var(--pf-text-muted)" }}>
                    {s.origin} → {s.dest} · PU {s.shipDate} · {s.equip}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onInspectLoad(s.id, "dispatch")}
                  className="px-2 py-1 rounded text-[10px] font-bold shrink-0"
                  style={{ background: "var(--pf-warning-dim)", color: "var(--pf-warning)" }}
                >
                  Assign Truck
                </button>
              </div>
            ))
          )}
        </section>
      )}

      {/* SECTION 2: Rate & TMS Reference Mismatches */}
      {(filter === "all" || filter === "mismatches") && (
        <section
          className="p-2.5 rounded-xl space-y-1.5"
          style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
        >
          <div className="flex items-center justify-between text-[11px] font-bold">
            <span className="inline-flex items-center gap-1.5" style={{ color: "var(--pf-danger)" }}>
              <DollarSign size={12} /> 2. Rate / TMS Mismatches ({mismatchLoads.length + mismatchEmails.length})
            </span>
          </div>

          {mismatchEmails.map((em) => (
            <div
              key={em.id}
              className="p-2 rounded-lg space-y-1.5 text-xs"
              style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
            >
              <div className="flex items-center justify-between gap-1.5 text-[11px]">
                <button
                  type="button"
                  onClick={() => em.loadId !== "NEW" && onInspectLoad(em.loadId, "dispatch")}
                  className="font-mono font-bold hover:underline"
                  style={{ color: "var(--pf-action)" }}
                >
                  #{em.loadId} · {em.diffLabel}
                </button>
                <span className="font-mono font-bold" style={{ color: "var(--pf-primary)" }}>
                  {em.diffValue}
                </span>
              </div>
              <div className="text-[11px] truncate" style={{ color: "var(--pf-text-muted)" }}>
                {em.subject}
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void onApplyEmailAction(em)}
                  className="flex-1 py-1 px-2 rounded text-[10px] font-bold"
                  style={{ background: "var(--pf-action)", color: "#ffffff" }}
                >
                  {em.ctaLabel}
                </button>
                {em.loadId !== "NEW" && (
                  <button
                    type="button"
                    onClick={() => onInspectLoad(em.loadId, "dispatch")}
                    className="py-1 px-2 rounded text-[10px] font-medium"
                    style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
                  >
                    Inspect
                  </button>
                )}
              </div>
            </div>
          ))}

          {mismatchLoads.map((s) => (
            <div
              key={`mm-${s.id}`}
              className="p-2 rounded-lg flex items-center justify-between gap-2 text-xs"
              style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
            >
              <div className="min-w-0">
                <div className="font-mono font-bold text-[11px]" style={{ color: "var(--pf-action)" }}>
                  #{s.id} · {s.customer}
                </div>
                <div className="text-[10px]" style={{ color: "var(--pf-danger)" }}>
                  {s.mismatchNote || (!s.po.trim() ? "Missing Customer PO in TAI" : `Negative margin ($${s.sell} sell vs $${s.buy} buy)`)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onInspectLoad(s.id, "dispatch")}
                className="px-2 py-1 rounded text-[10px] font-semibold shrink-0"
                style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
              >
                Resolve
              </button>
            </div>
          ))}

          {mismatchLoads.length === 0 && mismatchEmails.length === 0 && (
            <div className="text-[11px]" style={{ color: "var(--pf-text-muted)" }}>
              ✓ Zero open rate or PO discrepancies.
            </div>
          )}
        </section>
      )}

      {/* SECTION 3: Missing PODs */}
      {(filter === "all" || filter === "pods") && (
        <section
          className="p-2.5 rounded-xl space-y-1.5"
          style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
        >
          <div className="flex items-center justify-between text-[11px] font-bold">
            <span className="inline-flex items-center gap-1.5" style={{ color: "var(--pf-danger)" }}>
              <FileWarning size={12} /> 3. Missing PODs ({missingPodLoads.length})
            </span>
          </div>
          {missingPodLoads.length === 0 ? (
            <div className="text-[11px]" style={{ color: "var(--pf-text-muted)" }}>
              ✓ All delivered loads have verified PODs in TAI.
            </div>
          ) : (
            missingPodLoads.map((s) => (
              <div
                key={`pod-${s.id}`}
                className="p-2 rounded-lg flex items-center justify-between gap-2 text-xs"
                style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono font-bold" style={{ color: "var(--pf-action)" }}>
                      #{s.id}
                    </span>
                    <span className="font-semibold truncate">{s.customer}</span>
                  </div>
                  <div className="text-[10px] truncate" style={{ color: "var(--pf-text-muted)" }}>
                    {s.origin} → {s.dest} · {s.carrier || "Carrier"} · {s.emailPodAvailable ? "📎 POD in Gmail" : "Awaiting carrier POD"}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {onUploadPod && (
                    <button
                      type="button"
                      onClick={() => onUploadPod(s.id)}
                      className="px-2 py-1 rounded text-[10px] font-bold inline-flex items-center gap-1"
                      style={{ background: "var(--pf-action)", color: "#ffffff" }}
                    >
                      <Upload size={10} /> Upload POD
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onInspectLoad(s.id, "dispatch")}
                    className="px-1.5 py-1 rounded text-[10px]"
                    style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
                  >
                    Open
                  </button>
                </div>
              </div>
            ))
          )}
        </section>
      )}

      {/* SECTION 4: Container / TONU Exceptions */}
      {(filter === "all" || filter === "containers") && (
        <section
          className="p-2.5 rounded-xl space-y-1.5"
          style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
        >
          <div className="flex items-center justify-between text-[11px] font-bold">
            <span className="inline-flex items-center gap-1.5" style={{ color: "var(--pf-warning)" }}>
              <AlertTriangle size={12} /> 4. Container / TONU Exceptions ({containerExceptions.length})
            </span>
          </div>
          {containerExceptions.length === 0 ? (
            <div className="text-[11px]" style={{ color: "var(--pf-text-muted)" }}>
              ✓ No active container holds or TONU alerts.
            </div>
          ) : (
            containerExceptions.map((s) => (
              <div
                key={`cntr-${s.id}`}
                className="p-2 rounded-lg space-y-1 text-xs"
                style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
              >
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono font-bold" style={{ color: "var(--pf-action)" }}>
                      #{s.id}
                    </span>
                    {s.containerNumber && (
                      <span
                        className="px-1.5 py-0.5 rounded font-mono text-[10px] font-semibold"
                        style={{ background: "var(--pf-info-dim)", color: "var(--pf-info)" }}
                      >
                        📦 {s.containerNumber}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {s.containerNumber && (
                      <a
                        href={buildGmailContainerSearchUrl(s.containerNumber, s.id)}
                        target="_blank"
                        rel="noreferrer"
                        className="px-1.5 py-0.5 rounded text-[10px] inline-flex items-center gap-0.5"
                        style={{ background: "var(--pf-surface)", color: "var(--pf-info)", border: "1px solid var(--pf-border)" }}
                      >
                        <Search size={9} /> Gmail
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => onInspectLoad(s.id, "dispatch")}
                      className="px-2 py-0.5 rounded text-[10px] font-semibold"
                      style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
                    >
                      Inspect
                    </button>
                  </div>
                </div>
                {s.operationalNote && (
                  <div className="text-[11px] font-medium" style={{ color: "var(--pf-warning)" }}>
                    {s.operationalNote}
                  </div>
                )}
              </div>
            ))
          )}
        </section>
      )}

      {/* SECTION 5: AP Load Checks & Unbooked Tenders */}
      {(filter === "all" || filter === "ap") && (
        <section
          className="p-2.5 rounded-xl space-y-1.5"
          style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
        >
          <div className="flex items-center justify-between text-[11px] font-bold">
            <span className="inline-flex items-center gap-1.5" style={{ color: "var(--pf-primary)" }}>
              <Package size={12} /> 5. AP Load Checks &amp; Tenders ({openApAndTenders.length + unbookedTenders.length})
            </span>
            <button
              type="button"
              onClick={() => onNavigate("ap-tasks")}
              className="text-[10px] underline"
              style={{ color: "var(--pf-text-muted)" }}
            >
              Open AP Queue →
            </button>
          </div>

          {unbookedTenders.map((em) => (
            <div
              key={em.id}
              className="p-2 rounded-lg flex items-center justify-between gap-2 text-xs"
              style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
            >
              <div className="min-w-0">
                <div className="font-mono text-[10px] font-bold" style={{ color: "var(--pf-action)" }}>
                  UNBOOKED CUSTOMER TENDER
                </div>
                <div className="text-[11px] font-semibold truncate">{em.subject}</div>
                <div className="text-[10px] truncate" style={{ color: "var(--pf-text-muted)" }}>
                  {em.from} · {em.diffValue}
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  onExtractTenderToBuilder();
                  onNavigate("build-load");
                }}
                className="px-2 py-1 rounded text-[10px] font-bold shrink-0"
                style={{ background: "var(--pf-action)", color: "#ffffff" }}
              >
                Extract → Builder
              </button>
            </div>
          ))}

          {openApAndTenders.map((task) => (
            <div
              key={task.id}
              className="p-2 rounded-lg flex items-center justify-between gap-2 text-xs"
              style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono font-bold text-[11px]" style={{ color: "var(--pf-action)" }}>
                    #{task.shipmentId || "UNMATCHED"}
                  </span>
                  <span className="font-semibold truncate">{task.carrierName || "Carrier"}</span>
                </div>
                <div className="text-[10px] truncate" style={{ color: "var(--pf-text-muted)" }}>
                  Inv {task.invoiceNumber || "—"} ·{" "}
                  {(Number(task.amount) || 0) > 0 ? `$${Number(task.amount).toLocaleString()}` : task.notes || "Check"} ·{" "}
                  {task.status}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onNavigate("ap-tasks")}
                className="px-2 py-1 rounded text-[10px] font-semibold shrink-0 inline-flex items-center gap-1"
                style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
              >
                <CheckCircle2 size={10} /> Check AP
              </button>
            </div>
          ))}

          {openApAndTenders.length === 0 && unbookedTenders.length === 0 && (
            <div className="text-[11px] flex items-center justify-between" style={{ color: "var(--pf-text-muted)" }}>
              <span>✓ No pending AP load checks or unbooked tenders.</span>
              <a
                href="https://mail.google.com/mail/u/0/#search/invoice+OR+tender"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 underline text-[10px]"
              >
                <ExternalLink size={10} /> Gmail
              </a>
            </div>
          )}
        </section>
      )}
    </div>
  );
};
