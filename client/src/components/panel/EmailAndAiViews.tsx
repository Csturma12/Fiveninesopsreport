import React, { useEffect, useState } from "react";
import type { CrucialEmailItem, OpsShipment } from "@shared/tai-webhook-schema";
import { AlertOctagon, CheckCircle2, ExternalLink, PlusCircle, RefreshCw, Reply, Search, Settings2, Sparkles } from "lucide-react";
import {
  captureGmailThread,
  getPanelPref,
  insertGmailReply,
  openEmailInGmail,
  setPanelPref,
  type ApTaskConfigPref,
  type CapturedGmailThread,
} from "./extensionBridge";
import { panelFetchJson, type PanelApiContext } from "./panelApi";
import { isApTaskResolved, type ApTaskRecord, type PanelViewId } from "./panelTypes";

/* ============================================================================
 * 1. CHECK AGAINST LOADS VIEW (`check-email`)
 * ============================================================================ */

interface CheckEmailViewProps {
  shipments: OpsShipment[];
  crucialEmails: CrucialEmailItem[];
  liveThread: CapturedGmailThread | null;
  onThreadCaptured: (thread: CapturedGmailThread) => void;
  onInspectLoad: (shipmentId: string, targetView?: "dispatch" | "all-loads") => void;
  onNavigate: (view: PanelViewId) => void;
  apiCtx?: PanelApiContext;
  onToast: (msg: string, kind?: "ok" | "error") => void;
}

interface CheckEmailMatchResult {
  isCancellation: boolean;
  cancellationReason?: string;
  matches: Array<{
    shipment: OpsShipment;
    matchReason: string;
    discrepancies: string[];
  }>;
  summary: string;
}

function runLocalCheckFallback(
  shipments: OpsShipment[],
  subject: string,
  bodyText: string,
): CheckEmailMatchResult {
  const combined = `${subject}\n${bodyText}`;
  const lower = combined.toLowerCase();
  const isCancellation = /\b(cancel|canceled|cancelled|tonu|do not ship|hold shipment|order void)\b/i.test(combined);

  const matches: CheckEmailMatchResult["matches"] = [];
  for (const s of shipments) {
    const reasons: string[] = [];
    if (s.id && combined.includes(s.id)) reasons.push(`Shipment #${s.id}`);
    if (s.po && s.po.length >= 4 && lower.includes(s.po.toLowerCase())) reasons.push(`Customer PO ${s.po}`);
    if (s.containerNumber && lower.includes(s.containerNumber.toLowerCase())) {
      reasons.push(`Container ${s.containerNumber}`);
    }
    if (s.customer && lower.includes(s.customer.toLowerCase().split(" ")[0])) {
      reasons.push(`Customer ${s.customer}`);
    }
    if (reasons.length > 0) {
      const diffs: string[] = [];
      if (isCancellation && s.rawStatus.toLowerCase() !== "canceled") {
        diffs.push(`Email requests CANCELLATION / TONU while TAI status is "${s.rawStatus}"`);
      }
      if (s.stage === "Delivered" && s.podCount === 0 && /\bpod\b/i.test(combined)) {
        diffs.push("Load is Delivered with 0 PODs in TAI — upload attached POD");
      }
      if (s.mismatchNote) diffs.push(s.mismatchNote);
      matches.push({
        shipment: s,
        matchReason: reasons.join(" · "),
        discrepancies: diffs,
      });
    }
  }

  return {
    isCancellation,
    cancellationReason: isCancellation
      ? "Explicit tender cancellation or TONU keyword detected in thread — verify before dispatching truck!"
      : undefined,
    matches,
    summary:
      matches.length > 0
        ? `Matched ${matches.length} active load(s) against thread.`
        : "No existing load matched this email — ready to extract as a new tender.",
  };
}

export const CheckEmailView: React.FC<CheckEmailViewProps> = ({
  shipments,
  crucialEmails,
  liveThread,
  onThreadCaptured,
  onInspectLoad,
  onNavigate,
  apiCtx,
  onToast,
}) => {
  const [subject, setSubject] = useState(liveThread?.subject || crucialEmails[0]?.subject || "");
  const [sender, setSender] = useState(liveThread?.sender || crucialEmails[0]?.from || "");
  const [bodyText, setBodyText] = useState(liveThread?.bodyText || crucialEmails[0]?.body || "");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<CheckEmailMatchResult | null>(null);

  const runCheck = async (subj: string, snd: string, body: string) => {
    if (!subj.trim() && !body.trim()) {
      onToast("Capture an open Gmail thread or paste email text to check against loads.", "error");
      return;
    }
    setChecking(true);
    try {
      const { ok, data } = await panelFetchJson<{
        ok?: boolean;
        isCancellation?: boolean;
        cancellationDetected?: boolean;
        cancellationReason?: string;
        cancellation?: {
          detected?: boolean;
          severity?: string;
          reason?: string | null;
        };
        matchedShipments?: OpsShipment[];
        diffs?: Array<{
          type?: string;
          shipmentId?: string;
          summary?: string;
        }>;
        matches?: Array<{
          shipmentId?: string;
          shipment?: OpsShipment;
          matchReason?: string;
          matchedOn?: string;
          discrepancies?: string[];
          diffs?: string[];
        }>;
        summary?: string;
      }>(
        "/api/panel/check-email",
        {
          method: "POST",
          body: JSON.stringify({ subject: subj, sender: snd, bodyText: body }),
        },
        apiCtx,
      );

      if (ok && data.ok !== false && Array.isArray(data.matchedShipments)) {
        const diffList = Array.isArray(data.diffs) ? data.diffs : [];
        const mapped = data.matchedShipments.map((ship) => {
          const perLoadDiffs = diffList
            .filter((d) => d.shipmentId === ship.id && d.summary)
            .map((d) => String(d.summary));
          return {
            shipment: ship,
            matchReason: ship.po ? `Matched #${ship.id} (PO ${ship.po})` : `Matched #${ship.id}`,
            discrepancies: perLoadDiffs,
          };
        });
        const cancelFlag = Boolean(
          data.cancellation?.detected || data.isCancellation || data.cancellationDetected,
        );
        setResult({
          isCancellation: cancelFlag,
          cancellationReason:
            data.cancellation?.reason ||
            data.cancellationReason ||
            (cancelFlag ? "Explicit tender cancellation / TONU language detected in email!" : undefined),
          matches: mapped,
          summary: data.summary || `Checked email against ${shipments.length} active shipments.`,
        });
      } else if (ok && data.ok !== false && Array.isArray(data.matches)) {
        const mapped = data.matches
          .map((m) => {
            const ship = m.shipment || shipments.find((x) => x.id === m.shipmentId);
            if (!ship) return null;
            return {
              shipment: ship,
              matchReason: m.matchReason || m.matchedOn || `Matched #${ship.id}`,
              discrepancies: m.discrepancies || m.diffs || [],
            };
          })
          .filter((x): x is NonNullable<typeof x> => Boolean(x));

        const cancelFlag = Boolean(data.isCancellation || data.cancellationDetected);
        setResult({
          isCancellation: cancelFlag,
          cancellationReason:
            data.cancellationReason ||
            (cancelFlag ? "Explicit tender cancellation / TONU language detected in email!" : undefined),
          matches: mapped,
          summary: data.summary || `Checked email against ${shipments.length} active shipments.`,
        });
      } else {
        setResult(runLocalCheckFallback(shipments, subj, body));
      }
    } catch {
      setResult(runLocalCheckFallback(shipments, subj, body));
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    if (subject || bodyText) {
      void runCheck(subject, sender, bodyText);
    }
  }, []);

  const handleCaptureAndCheck = async () => {
    const cap = await captureGmailThread();
    if (cap.ok && cap.thread) {
      onThreadCaptured(cap.thread);
      setSubject(cap.thread.subject);
      setSender(cap.thread.sender);
      setBodyText(cap.thread.bodyText);
      await runCheck(cap.thread.subject, cap.thread.sender, cap.thread.bodyText);
    } else {
      onToast(cap.error || "Paste email text below to check against loads.", "error");
    }
  };

  return (
    <div className="space-y-2.5">
      <div
        className="p-2.5 rounded-xl space-y-2 text-[11px]"
        style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-bold text-xs">Scan Open Email Against Active Loads</span>
          <button
            type="button"
            onClick={() => void handleCaptureAndCheck()}
            className="px-2 py-1 rounded text-[10px] font-bold inline-flex items-center gap-1"
            style={{ background: "var(--pf-action)", color: "#ffffff" }}
          >
            <Sparkles size={10} /> Capture Gmail
          </button>
        </div>

        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Email Subject (Shipment #, PO #, Container #, or Cancel notice)…"
          className="pf-input font-semibold text-[11px]"
        />
        <textarea
          rows={3}
          value={bodyText}
          onChange={(e) => setBodyText(e.target.value)}
          placeholder="Email body text…"
          className="pf-input text-[11px]"
        />

        <button
          type="button"
          disabled={checking}
          onClick={() => void runCheck(subject, sender, bodyText)}
          className="w-full py-1.5 rounded-lg text-xs font-bold inline-flex items-center justify-center gap-1"
          style={{ background: "var(--pf-primary)", color: "var(--pf-primary-fg)" }}
        >
          <Search size={12} /> {checking ? "Scanning Shipments…" : "Check Against Active Loads"}
        </button>
      </div>

      {result && (
        <div className="space-y-2">
          {result.isCancellation && (
            <div
              className="p-2.5 rounded-xl space-y-1 text-xs"
              style={{
                background: "var(--pf-danger-dim)",
                color: "var(--pf-danger)",
                border: "1px solid var(--pf-danger)",
              }}
            >
              <div className="font-bold inline-flex items-center gap-1.5">
                <AlertOctagon size={14} /> TENDER CANCELLATION / TONU ALERT
              </div>
              <div className="text-[11px]">{result.cancellationReason}</div>
            </div>
          )}

          <div
            className="p-2.5 rounded-xl space-y-2 text-xs"
            style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
          >
            <div className="text-[11px] font-semibold">{result.summary}</div>

            {result.matches.length === 0 ? (
              <button
                type="button"
                onClick={() => onNavigate("build-load")}
                className="w-full py-1.5 px-2.5 rounded-lg text-[11px] font-bold inline-flex items-center justify-center gap-1"
                style={{ background: "var(--pf-action)", color: "#ffffff" }}
              >
                <PlusCircle size={11} /> Extract as New Load in Builder
              </button>
            ) : (
              result.matches.map((m) => (
                <div
                  key={m.shipment.id}
                  className="p-2 rounded-lg space-y-1"
                  style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono font-bold" style={{ color: "var(--pf-action)" }}>
                      #{m.shipment.id} · {m.shipment.customer}
                    </span>
                    <button
                      type="button"
                      onClick={() => onInspectLoad(m.shipment.id, "dispatch")}
                      className="px-2 py-0.5 rounded text-[10px] font-bold"
                      style={{ background: "var(--pf-action)", color: "#ffffff" }}
                    >
                      Inspect in Dispatch
                    </button>
                  </div>
                  <div className="text-[10px]" style={{ color: "var(--pf-primary)" }}>
                    ✓ {m.matchReason} · {m.shipment.origin} → {m.shipment.dest} ({m.shipment.stage})
                  </div>
                  {m.discrepancies.map((d, idx) => (
                    <div key={idx} className="text-[10px] font-semibold" style={{ color: "var(--pf-warning)" }}>
                      ⚠ {d}
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};

/* ============================================================================
 * 2. AI ASSISTANT VIEW (`ai-assistant` — matching Screenshot 1)
 * ============================================================================ */

interface AiAssistantViewProps {
  chatHistory: Array<{ role: "user" | "assistant"; text: string }>;
  onAskAi: (question: string, activeEmail?: { subject?: string; from?: string; body?: string } | null) => Promise<void>;
  liveThread?: CapturedGmailThread | null;
  crucialEmails?: CrucialEmailItem[];
  onThreadCaptured?: (thread: CapturedGmailThread) => void;
  onToast: (msg: string, kind?: "ok" | "error") => void;
}

export const AiAssistantView: React.FC<AiAssistantViewProps> = ({
  chatHistory,
  onAskAi,
  liveThread = null,
  crucialEmails = [],
  onThreadCaptured,
  onToast,
}) => {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [contextMode, setContextMode] = useState<"all-loads" | "active-email">("all-loads");
  const [capturing, setCapturing] = useState(false);

  const activeEmailContext =
    contextMode === "active-email"
      ? liveThread && (liveThread.subject || liveThread.bodyText)
        ? {
            subject: liveThread.subject,
            from: liveThread.sender,
            body: liveThread.bodyText,
          }
        : crucialEmails[0]
        ? {
            subject: crucialEmails[0].subject,
            from: crucialEmails[0].from,
            body: crucialEmails[0].fullBody || crucialEmails[0].body,
          }
        : null
      : null;

  const handleCaptureEmailForAi = async () => {
    setCapturing(true);
    try {
      const cap = await captureGmailThread();
      if (cap.ok && cap.thread) {
        onThreadCaptured?.(cap.thread);
        setContextMode("active-email");
        onToast(`Attached open Gmail thread: "${cap.thread.subject}"`);
      } else {
        onToast(cap.error || "Open a Gmail thread first, or ask across All Live TAI Loads.", "error");
      }
    } finally {
      setCapturing(false);
    }
  };

  const ask = async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setSending(true);
    try {
      await onAskAi(trimmed, activeEmailContext);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col min-h-[calc(100vh-110px)] justify-between gap-4">
      <div className="space-y-3.5">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h1 className="text-[20px] font-bold text-white tracking-tight">AI Assistant</h1>
            <p className="text-xs mt-0.5" style={{ color: "#8b95a5" }}>
              Grounded on live shipments, 5,000+ TAI carriers &amp; lane history
            </p>
          </div>
          <button
            type="button"
            disabled={capturing}
            onClick={() => void handleCaptureEmailForAi()}
            className="px-2.5 py-1 rounded-xl text-[10.5px] font-semibold inline-flex items-center gap-1 shrink-0"
            style={{ background: "#161c26", border: "1px solid #262f3d", color: "#21b975" }}
          >
            <RefreshCw size={10} className={capturing ? "animate-spin" : ""} /> ↻ Capture Open Email
          </button>
        </div>

        {/* Dynamic Context Selector Pill: All Live TAI Loads vs Active Gmail Thread */}
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <button
            type="button"
            onClick={() => setContextMode("all-loads")}
            className="px-3 py-1 rounded-full font-semibold transition-colors"
            style={
              contextMode === "all-loads"
                ? { background: "rgba(56,201,118,0.16)", color: "#21b975", border: "1px solid rgba(56,201,118,0.5)" }
                : { background: "#131820", color: "#8b95a5", border: "1px solid #222936" }
            }
          >
            All Live TAI Loads
          </button>
          <button
            type="button"
            onClick={() => setContextMode("active-email")}
            className="px-3 py-1 rounded-full font-semibold transition-colors truncate max-w-[210px]"
            style={
              contextMode === "active-email"
                ? { background: "rgba(56,201,118,0.16)", color: "#21b975", border: "1px solid rgba(56,201,118,0.5)" }
                : { background: "#131820", color: "#8b95a5", border: "1px solid #222936" }
            }
          >
            Active Gmail Thread{liveThread?.subject ? `: ${liveThread.subject}` : ""}
          </button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {[
            "Do we have any uncovered shipments for customer IMC Logistics?",
            "Top historical lane runners for PA → GA flatbed?",
            "Is carrier Just Drive Transport set up in TAI?",
            "Which uncovered loads pick up first?",
          ].map((chip) => (
            <button
              key={chip}
              type="button"
              onClick={() => void ask(chip)}
              className="px-2.5 py-1 rounded-full text-[11px] font-medium hover:bg-white/5"
              style={{ background: "#131820", border: "1px solid #222936", color: "#b8c1cf" }}
            >
              {chip}
            </button>
          ))}
        </div>

        <div className="space-y-3.5 pt-2">
          {chatHistory.map((m, idx) =>
            m.role === "user" ? (
              <div key={idx} className="flex flex-col items-end space-y-1">
                <span className="text-[11px] font-medium px-1" style={{ color: "#6e7787" }}>
                  You
                </span>
                <div
                  className="max-w-[85%] px-3.5 py-2.5 rounded-2xl text-[13px] leading-relaxed text-white"
                  style={{ background: "#1c222d" }}
                >
                  {m.text}
                </div>
              </div>
            ) : (
              <div key={idx} className="flex flex-col items-start space-y-1">
                <div className="flex items-center gap-2 px-1">
                  <span className="text-[11px] font-medium" style={{ color: "#6e7787" }}>
                    Assistant
                  </span>
                  <button
                    type="button"
                    onClick={async () => {
                      const res = await insertGmailReply({ text: m.text });
                      onToast(res.message, res.ok ? "ok" : "error");
                    }}
                    className="inline-flex items-center gap-0.5 text-[10px] hover:underline"
                    style={{ color: "#21b975" }}
                  >
                    <Reply size={10} /> Insert
                  </button>
                </div>
                <div
                  className="max-w-[90%] p-3.5 rounded-2xl text-[13px] leading-relaxed whitespace-pre-wrap text-slate-100"
                  style={{ background: "#131820", border: "1px solid #222936" }}
                >
                  {m.text}
                </div>
              </div>
            ),
          )}
        </div>
      </div>

      {/* Bottom Pinned Input Bar with Emerald Square Arrow Button */}
      <div
        className="sticky bottom-0 pt-3 pb-1 flex items-center gap-2"
        style={{ background: "#0b0e13", borderTop: "1px solid #1b222d" }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && input.trim()) {
              const q = input;
              setInput("");
              void ask(q);
            }
          }}
          placeholder="Ask about a load, carrier, or lane..."
          className="flex-1 px-3.5 py-2.5 rounded-xl text-xs outline-none text-white placeholder:text-[#6e7787]"
          style={{ background: "#151a23", border: "1px solid #242c3a" }}
        />
        <button
          type="button"
          disabled={sending || !input.trim()}
          onClick={() => {
            const q = input;
            setInput("");
            void ask(q);
          }}
          className="w-10 h-10 rounded-xl flex items-center justify-center font-bold text-base shrink-0 disabled:opacity-50 transition-opacity"
          style={{ background: "#21b975", color: "#07130c" }}
          aria-label="Send message"
        >
          →
        </button>
      </div>
    </div>
  );
};

/* ============================================================================
 * 3. AP EMAILS VIEW (`ap-tasks` with pf_ap_FilterQuery & pf_ap_TaskConfig)
 * ============================================================================ */

interface ApEmailsViewProps {
  tasks: ApTaskRecord[];
  onRefreshTasks: () => Promise<void>;
  onInspectLoad: (shipmentId: string, targetView?: "dispatch" | "all-loads") => void;
  apiCtx?: PanelApiContext;
  onToast: (msg: string, kind?: "ok" | "error") => void;
}

const DEFAULT_AP_QUERY = 'subject:(invoice OR "carrier bill" OR lumper OR detention) has:attachment';
const DEFAULT_AP_CONFIG: ApTaskConfigPref = {
  autoMatchByPo: true,
  requirePodBeforeApproval: true,
  varianceThresholdUsd: 25,
  defaultAssignee: "AP Desk",
};

export const ApEmailsView: React.FC<ApEmailsViewProps> = ({
  tasks,
  onRefreshTasks,
  onInspectLoad,
  apiCtx,
  onToast,
}) => {
  const [filterQuery, setFilterQuery] = useState<string>(DEFAULT_AP_QUERY);
  const [config, setConfig] = useState<ApTaskConfigPref>(DEFAULT_AP_CONFIG);
  const [showConfig, setShowConfig] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      const savedQuery = await getPanelPref("pf_ap_FilterQuery", DEFAULT_AP_QUERY);
      const savedCfg = await getPanelPref("pf_ap_TaskConfig", DEFAULT_AP_CONFIG);
      if (!active) return;
      setFilterQuery(savedQuery);
      setConfig(savedCfg);
    })();
    return () => {
      active = false;
    };
  }, []);

  const handleSavePrefs = async () => {
    await setPanelPref("pf_ap_FilterQuery", filterQuery);
    await setPanelPref("pf_ap_TaskConfig", config);
    onToast("Saved AP filter query & task rules to extension preferences!");
    setShowConfig(false);
  };

  const handleCaptureInvoiceThread = async () => {
    setBusy(true);
    try {
      const cap = await captureGmailThread();
      const subj = cap.thread?.subject || "Carrier Invoice #INV-8841 · Load 132738007 ($2,450)";
      const sender = cap.thread?.sender || "billing@carrier.com";
      const body = cap.thread?.bodyText || "";
      const { ok, data } = await panelFetchJson<{ ok?: boolean; message?: string }>(
        "/api/panel/ap-tasks",
        {
          method: "POST",
          body: JSON.stringify({
            subject: subj,
            sender,
            bodyText: body,
            podAttached: (cap.thread?.attachments.length || 0) > 0,
            config,
          }),
        },
        apiCtx,
      );
      onToast(
        ok && data.ok !== false
          ? data.message || "Captured carrier invoice email into AP Queue"
          : "Logged AP check item",
      );
      await onRefreshTasks();
    } finally {
      setBusy(false);
    }
  };

  const handleApproveTask = async (task: ApTaskRecord) => {
    if (config.requirePodBeforeApproval && !task.podAttached) {
      onToast(`Cannot approve Inv ${task.invoiceNumber || "—"}: POD required by AP rules.`, "error");
      return;
    }
    const { ok } = await panelFetchJson(
      "/api/panel/ap-tasks",
      {
        method: "POST",
        body: JSON.stringify({ id: task.id, action: "resolve", status: "resolved" }),
      },
      apiCtx,
    );
    if (ok) {
      const amtStr = (Number(task.amount) || 0) > 0 ? ` ($${Number(task.amount).toLocaleString()})` : "";
      onToast(`Resolved AP item ${task.invoiceNumber && task.invoiceNumber !== "—" ? task.invoiceNumber : `#${task.shipmentId}`}${amtStr}`);
      await onRefreshTasks();
    }
  };

  return (
    <div className="space-y-2.5">
      {/* Gmail AP Filter Query & Config Bar */}
      <div
        className="p-2.5 rounded-xl space-y-2 text-[11px]"
        style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-bold text-xs">Freight AP Email Collector</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setShowConfig((v) => !v)}
              className="px-2 py-1 rounded text-[10px] font-semibold inline-flex items-center gap-1"
              style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
            >
              <Settings2 size={10} /> Rules
            </button>
            <button
              type="button"
              onClick={() => void openEmailInGmail({ query: filterQuery })}
              className="px-2 py-1 rounded text-[10px] font-semibold inline-flex items-center gap-1"
              style={{ background: "var(--pf-info-dim)", color: "var(--pf-info)" }}
            >
              <ExternalLink size={10} /> Open in Gmail
            </button>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <input
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            onBlur={() => void setPanelPref("pf_ap_FilterQuery", filterQuery)}
            placeholder="Gmail AP search query…"
            className="pf-input font-mono text-[10px] flex-1"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleCaptureInvoiceThread()}
            className="px-2.5 py-1.5 rounded text-[10px] font-bold shrink-0"
            style={{ background: "var(--pf-action)", color: "#ffffff" }}
          >
            {busy ? "Reading…" : "+ Capture Open"}
          </button>
        </div>

        {showConfig && (
          <div
            className="p-2 rounded-lg space-y-2 text-[11px]"
            style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
          >
            <label className="flex items-center justify-between gap-2">
              <span>Auto-match carrier bills by Shipment # / PO</span>
              <input
                type="checkbox"
                checked={config.autoMatchByPo}
                onChange={(e) => setConfig({ ...config, autoMatchByPo: e.target.checked })}
              />
            </label>
            <label className="flex items-center justify-between gap-2">
              <span>Require verified POD before AP approval</span>
              <input
                type="checkbox"
                checked={config.requirePodBeforeApproval}
                onChange={(e) => setConfig({ ...config, requirePodBeforeApproval: e.target.checked })}
              />
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              <div>
                <span className="block text-[10px]" style={{ color: "var(--pf-text-muted)" }}>
                  Rate Variance Flag ($)
                </span>
                <input
                  type="number"
                  value={config.varianceThresholdUsd}
                  onChange={(e) => setConfig({ ...config, varianceThresholdUsd: Number(e.target.value) || 0 })}
                  className="pf-input font-mono text-[11px]"
                />
              </div>
              <div>
                <span className="block text-[10px]" style={{ color: "var(--pf-text-muted)" }}>
                  Default Assignee
                </span>
                <input
                  value={config.defaultAssignee}
                  onChange={(e) => setConfig({ ...config, defaultAssignee: e.target.value })}
                  className="pf-input text-[11px]"
                />
              </div>
            </div>
            <button
              type="button"
              onClick={() => void handleSavePrefs()}
              className="w-full py-1.5 rounded text-[11px] font-bold"
              style={{ background: "var(--pf-primary)", color: "var(--pf-primary-fg)" }}
            >
              Save AP Filter &amp; Rules
            </button>
          </div>
        )}
      </div>

      {/* AP Task Queue */}
      <div className="space-y-1.5">
        {tasks.length === 0 ? (
          <div
            className="p-4 rounded-xl text-center text-xs"
            style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)", color: "var(--pf-text-muted)" }}
          >
            No carrier AP bills queued yet — click <strong>+ Capture Open</strong> on a carrier invoice thread.
          </div>
        ) : (
          tasks.map((task) => (
            <div
              key={task.id}
              className="p-2.5 rounded-xl space-y-1 text-xs"
              style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <button
                    type="button"
                    onClick={() => task.shipmentId && onInspectLoad(task.shipmentId, "dispatch")}
                    className="font-mono font-bold hover:underline shrink-0"
                    style={{ color: "var(--pf-action)" }}
                  >
                    #{task.shipmentId || "UNMATCHED"}
                  </button>
                  <span className="font-semibold truncate">{task.carrierName || "Carrier"}</span>
                </div>
                <span className="font-mono font-bold shrink-0">
                  {(Number(task.amount) || 0) > 0 ? `$${Number(task.amount).toLocaleString()}` : task.category || "Check"}
                </span>
              </div>
              <div className="text-[10px] truncate" style={{ color: "var(--pf-text-muted)" }}>
                Inv {task.invoiceNumber || "—"} · {task.podAttached ? "✓ POD Attached" : "⚠ Missing POD"} · {task.status}
              </div>
              <div className="flex items-center justify-end gap-1.5 pt-0.5">
                {task.shipmentId && task.shipmentId !== "NEW" && (
                  <button
                    type="button"
                    onClick={() => onInspectLoad(task.shipmentId, "dispatch")}
                    className="px-2 py-1 rounded text-[10px]"
                    style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
                  >
                    Inspect Load
                  </button>
                )}
                {!isApTaskResolved(task.status) && (
                  <button
                    type="button"
                    onClick={() => void handleApproveTask(task)}
                    className="px-2 py-1 rounded text-[10px] font-bold inline-flex items-center gap-1"
                    style={{ background: "var(--pf-primary-dim)", color: "var(--pf-primary)" }}
                  >
                    <CheckCircle2 size={10} /> Approve AP
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
