import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { LoadEntry } from "@shared/load-entry";
import type { CrucialEmailItem, OpsShipment } from "@shared/tai-webhook-schema";
import {
  CheckCircle2,
  ExternalLink,
  Eye,
  Mail,
  PlusCircle,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";
import {
  captureGmailInbox,
  openEmailInGmail,
  type CapturedGmailThread,
} from "./extensionBridge";
import { panelFetchJson, type PanelApiContext } from "./panelApi";
import type { LiveCrucialEmail, PanelViewId } from "./panelTypes";

interface InboxStreamViewProps {
  crucialEmails: CrucialEmailItem[];
  shipments: OpsShipment[];
  onBuilderChange: (next: LoadEntry) => void;
  onThreadSelected: (thread: CapturedGmailThread) => void;
  onInspectLoad: (shipmentId: string, targetView?: "dispatch" | "all-loads") => void;
  onNavigate: (view: PanelViewId) => void;
  onRefreshBootstrap: () => Promise<void>;
  apiCtx?: PanelApiContext;
  onToast: (msg: string, kind?: "ok" | "error") => void;
}

type InboxFilterTab = "all" | "crucial" | "matched";

export const InboxStreamView: React.FC<InboxStreamViewProps> = ({
  crucialEmails,
  shipments,
  onBuilderChange,
  onThreadSelected,
  onInspectLoad,
  onNavigate,
  onRefreshBootstrap,
  apiCtx,
  onToast,
}) => {
  const [filter, setFilter] = useState<InboxFilterTab>("all");
  const [query, setQuery] = useState<string>("");
  const [serverItems, setServerItems] = useState<LiveCrucialEmail[]>([]);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [expandedEmailId, setExpandedEmailId] = useState<string | null>(null);
  const [extractingId, setExtractingId] = useState<string | null>(null);

  // Inline editable review fields per email
  const [reviewPo, setReviewPo] = useState<Record<string, string>>({});
  const [reviewRate, setReviewRate] = useState<Record<string, number>>({});
  const [reviewNote, setReviewNote] = useState<Record<string, string>>({});

  const fetchServerInbox = useCallback(async () => {
    try {
      const { ok, data } = await panelFetchJson<{
        ok?: boolean;
        items?: LiveCrucialEmail[];
        emails?: LiveCrucialEmail[];
      }>("/api/inbox", { method: "GET" }, apiCtx);
      const rows = data.items || data.emails;
      if (ok && Array.isArray(rows)) {
        setServerItems(rows);
      }
    } catch {
      // Keep prop-based fallback
    }
  }, [apiCtx]);

  useEffect(() => {
    void fetchServerInbox();
  }, [fetchServerInbox, crucialEmails]);

  const handleSyncActiveGmailInbox = async () => {
    setSyncing(true);
    try {
      const cap = await captureGmailInbox();
      if (cap.ok && cap.items.length > 0) {
        // Also ensure /api/inbox/ingest receives items when running same-origin
        await panelFetchJson(
          "/api/inbox/ingest",
          {
            method: "POST",
            body: JSON.stringify({ items: cap.items }),
          },
          apiCtx,
        ).catch(() => {});
        await Promise.all([fetchServerInbox(), onRefreshBootstrap()]);
        onToast(`Synced ${cap.items.length} Gmail thread(s) from active inbox!`);
      } else {
        await Promise.all([fetchServerInbox(), onRefreshBootstrap()]);
        onToast(
          cap.outsideIframe
            ? "Refreshed live server Gmail & AP stream."
            : cap.error || "Refreshed inbox stream.",
          cap.ok || cap.outsideIframe ? "ok" : "error",
        );
      }
    } finally {
      setSyncing(false);
    }
  };

  // Merge server /api/inbox items with crucialEmails without duplicates
  const mergedEmails = useMemo<LiveCrucialEmail[]>(() => {
    const map = new Map<string, LiveCrucialEmail>();
    for (const item of serverItems) {
      const key = item.threadId || item.id;
      map.set(key, item);
    }
    for (const em of crucialEmails as LiveCrucialEmail[]) {
      const key = em.threadId || em.id;
      if (!map.has(key)) {
        map.set(key, em);
      }
    }
    return [...map.values()];
  }, [serverItems, crucialEmails]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return mergedEmails.filter((em) => {
      if (filter === "crucial" && !(em.diffType === "new_tender" || !em.applied)) return false;
      if (filter === "matched" && (!em.loadId || em.loadId === "NEW")) return false;
      if (!q) return true;
      return `${em.subject} ${em.from} ${em.senderName || ""} ${em.loadId} ${em.containerNumber || ""} ${em.body || ""}`
        .toLowerCase()
        .includes(q);
    });
  }, [mergedEmails, filter, query]);

  const handleFillLoadBuilder = async (em: LiveCrucialEmail) => {
    setExtractingId(em.id);
    try {
      const { ok, data } = await panelFetchJson<{
        ok?: boolean;
        entry?: LoadEntry;
        summary?: string;
        message?: string;
      }>(
        "/api/extract-email",
        {
          method: "POST",
          body: JSON.stringify({
            subject: em.subject,
            sender: em.from,
            bodyText: em.fullBody || em.body || em.subject,
          }),
        },
        apiCtx,
      );
      if (ok && data.ok && data.entry) {
        onBuilderChange(data.entry);
        onToast(data.summary || `Extracted "${em.subject}" into Load Builder`);
        onNavigate("build-load");
      } else {
        onToast(data.message || "Opened Load Builder for tender entry", "error");
        onNavigate("build-load");
      }
    } finally {
      setExtractingId(null);
    }
  };

  const handleCheckAgainstLoads = (em: LiveCrucialEmail) => {
    onThreadSelected({
      subject: em.subject,
      sender: em.from,
      timestamp: em.received,
      bodyText: em.fullBody || em.body || "",
      permalink: em.permalink || "",
      messageId: em.messageId || em.threadId,
      attachments: [],
    });
    onNavigate("check-email");
  };

  const handleApplyReviewedExtraction = async (em: LiveCrucialEmail) => {
    setExtractingId(em.id);
    try {
      const poVal = reviewPo[em.id] ?? em.extractedFields?.customerPO ?? em.extractedPo ?? "";
      const rateVal = reviewRate[em.id] ?? em.extractedFields?.sellRate ?? em.extractedAmount ?? 0;
      const noteVal = reviewNote[em.id] ?? em.extractedFields?.notes ?? em.operationalNote ?? "";

      if (em.loadId && em.loadId !== "NEW") {
        await panelFetchJson(
          `/api/loads/${encodeURIComponent(em.loadId)}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              ...(poVal ? { po: poVal } : {}),
              ...(rateVal > 0 ? { sell: rateVal } : {}),
              ...(noteVal ? { operationalNote: noteVal } : {}),
              pushToTai: true,
            }),
          },
          apiCtx,
        );
      }

      const { ok, data } = await panelFetchJson<{ ok?: boolean; entry?: LoadEntry; message?: string }>(
        `/api/inbox/${encodeURIComponent(em.id)}/apply`,
        {
          method: "POST",
          body: JSON.stringify({
            customerPO: poVal || undefined,
            sellRate: rateVal > 0 ? rateVal : undefined,
            notes: noteVal || undefined,
          }),
        },
        apiCtx,
      );

      if (data.entry && (!em.loadId || em.loadId === "NEW")) {
        onBuilderChange(data.entry);
        onNavigate("build-load");
      }

      onToast(
        ok && data.ok !== false
          ? data.message || `Applied update from "${em.subject}"`
          : `Updated Load #${em.loadId}`,
      );
      await Promise.all([fetchServerInbox(), onRefreshBootstrap()]);
    } finally {
      setExtractingId(null);
    }
  };

  return (
    <div className="space-y-3">
      {/* Header + Sync Active Gmail Inbox Trigger */}
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-[18px] font-bold text-white tracking-tight">Live Gmail Inbox</h1>
          <p className="text-[11px]" style={{ color: "#8b95a5" }}>
            {mergedEmails.length} thread(s) · Live extension &amp; AP stream
          </p>
        </div>

        <button
          type="button"
          disabled={syncing}
          onClick={() => void handleSyncActiveGmailInbox()}
          className="px-3 py-1.5 rounded-xl text-xs font-bold inline-flex items-center gap-1.5 shrink-0"
          style={{ background: "#1768b2", color: "#ffffff" }}
        >
          <RefreshCw size={12} className={syncing ? "animate-spin" : ""} />
          {syncing ? "Syncing…" : "↻ Sync Gmail"}
        </button>
      </div>

      {/* Filter Pills */}
      <div className="flex flex-wrap gap-1.5">
        {(
          [
            ["all", `All Mail (${mergedEmails.length})`],
            ["crucial", "Crucial / Tenders"],
            ["matched", "Matched Loads"],
          ] as const
        ).map(([id, label]) => {
          const active = filter === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setFilter(id)}
              className="px-3 py-1 rounded-full text-[11px] font-semibold transition-colors"
              style={
                active
                  ? {
                      background: "rgba(33,185,117,0.16)",
                      color: "#66d9a2",
                      border: "1px solid #21b975",
                    }
                  : {
                      background: "#13171d",
                      color: "#94a3b8",
                      border: "1px solid #222933",
                    }
              }
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Quick Search */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 rounded-xl"
        style={{ background: "#13171d", border: "1px solid #222933" }}
      >
        <Search size={12} style={{ color: "#64748b" }} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search subject, sender, load #, PO, container…"
          className="bg-transparent border-0 outline-none text-xs w-full text-slate-100 placeholder:text-[#64748b]"
        />
      </div>

      {/* Live Email Stream Cards */}
      <div className="space-y-2">
        {filtered.length === 0 ? (
          <div
            className="p-5 rounded-2xl text-center text-xs space-y-2"
            style={{ background: "#13171d", border: "1px solid #222933", color: "#94a3b8" }}
          >
            <Mail size={18} className="mx-auto opacity-60" />
            <div>No emails match this filter yet — click <strong>↻ Sync Gmail</strong> above with Gmail open.</div>
          </div>
        ) : (
          filtered.map((em) => {
            const isExp = expandedEmailId === em.id;
            const matchedLoad =
              em.loadId && em.loadId !== "NEW" ? shipments.find((s) => s.id === em.loadId) : undefined;
            const ef = em.extractedFields || {};
            const defaultPo = ef.customerPO || em.extractedPo || matchedLoad?.po || "";
            const defaultRate = ef.sellRate || em.extractedAmount || matchedLoad?.sell || 0;
            const defaultNote = ef.notes || em.operationalNote || "";

            return (
              <div
                key={em.id}
                className="rounded-2xl overflow-hidden transition-colors"
                style={{
                  background: "#13171d",
                  border: `1px solid ${isExp ? "#21b975" : "#222933"}`,
                }}
              >
                <div className="p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {em.unread && (
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: "#21b975" }} />
                      )}
                      {em.loadId && em.loadId !== "NEW" ? (
                        <button
                          type="button"
                          onClick={() => onInspectLoad(em.loadId, "dispatch")}
                          className="font-mono font-bold hover:underline shrink-0"
                          style={{ color: "#66d9a2" }}
                        >
                          #{em.loadId}
                        </button>
                      ) : (
                        <span
                          className="px-1.5 py-0.5 rounded font-mono text-[10px] font-bold shrink-0"
                          style={{ background: "rgba(245,174,57,0.16)", color: "#f5ae39" }}
                        >
                          TENDER / MAIL
                        </span>
                      )}
                      <span className="truncate" style={{ color: "#94a3b8" }}>
                        {em.senderName || em.from}
                      </span>
                    </div>
                    <span className="font-mono text-[10px] shrink-0" style={{ color: "#64748b" }}>
                      {em.received}
                    </span>
                  </div>

                  <div className="text-xs font-bold text-white leading-snug">{em.subject}</div>

                  {em.body && (
                    <p className="text-[11px] line-clamp-2 leading-relaxed" style={{ color: "#94a3b8" }}>
                      {em.body}
                    </p>
                  )}

                  {/* 4 Working Action Buttons */}
                  <div className="grid grid-cols-2 gap-1.5 pt-1">
                    <button
                      type="button"
                      onClick={() => setExpandedEmailId(isExp ? null : em.id)}
                      className="py-1.5 px-2 rounded-xl text-[10.5px] font-semibold inline-flex items-center justify-center gap-1"
                      style={{
                        background: isExp ? "rgba(33,185,117,0.16)" : "#191f28",
                        color: isExp ? "#66d9a2" : "#f8fafc",
                        border: "1px solid #222933",
                      }}
                    >
                      <Eye size={11} /> Review Extraction
                    </button>

                    <button
                      type="button"
                      disabled={extractingId === em.id}
                      onClick={() => void handleFillLoadBuilder(em)}
                      className="py-1.5 px-2 rounded-xl text-[10.5px] font-bold inline-flex items-center justify-center gap-1"
                      style={{ background: "#21b975", color: "#04130b" }}
                    >
                      <PlusCircle size={11} /> {extractingId === em.id ? "Extracting…" : "Fill Load Builder"}
                    </button>

                    <button
                      type="button"
                      onClick={() => handleCheckAgainstLoads(em)}
                      className="py-1.5 px-2 rounded-xl text-[10.5px] font-medium inline-flex items-center justify-center gap-1"
                      style={{ background: "#191f28", border: "1px solid #222933", color: "#c1d1e0" }}
                    >
                      <Sparkles size={11} /> Check Loads
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        void openEmailInGmail({
                          permalink: em.permalink,
                          threadId: em.threadId,
                          messageId: em.messageId,
                          subject: em.subject,
                          loadId: em.loadId,
                        })
                      }
                      className="py-1.5 px-2 rounded-xl text-[10.5px] font-medium inline-flex items-center justify-center gap-1"
                      style={{ background: "#191f28", border: "1px solid #222933", color: "#58a6ff" }}
                    >
                      <ExternalLink size={11} /> Open in Gmail
                    </button>
                  </div>
                </div>

                {/* Inline Review Extraction & Apply Drawer */}
                {isExp && (
                  <div
                    className="p-3 space-y-2.5 text-[11px]"
                    style={{ background: "#0b0e11", borderTop: "1px solid #222933" }}
                  >
                    <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "#66d9a2" }}>
                      Extracted Freight Fields {matchedLoad ? `· Matched Load #${matchedLoad.id}` : "· Unbooked Tender"}
                    </div>

                    {(ef.origin || ef.dest || ef.equipment) && (
                      <div className="p-2 rounded-lg text-[10.5px]" style={{ background: "#13171d" }}>
                        {ef.origin || "Origin TBD"} → {ef.dest || "Dest TBD"}{" "}
                        {ef.equipment ? `· ${ef.equipment}` : ""}{" "}
                        {ef.readyDate ? `· PU ${ef.readyDate}` : ""}
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-1.5">
                      <div>
                        <label className="block text-[10px] mb-0.5" style={{ color: "#94a3b8" }}>
                          Extracted PO #
                        </label>
                        <input
                          value={reviewPo[em.id] ?? defaultPo}
                          onChange={(e) => setReviewPo({ ...reviewPo, [em.id]: e.target.value })}
                          placeholder="Customer PO"
                          className="pf-input font-mono text-[11px]"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] mb-0.5" style={{ color: "#94a3b8" }}>
                          Extracted Rate ($)
                        </label>
                        <input
                          type="number"
                          value={reviewRate[em.id] ?? (defaultRate || "")}
                          onChange={(e) => setReviewRate({ ...reviewRate, [em.id]: Number(e.target.value) || 0 })}
                          placeholder="0"
                          className="pf-input font-mono text-[11px]"
                        />
                      </div>
                    </div>

                    <input
                      value={reviewNote[em.id] ?? defaultNote}
                      onChange={(e) => setReviewNote({ ...reviewNote, [em.id]: e.target.value })}
                      placeholder="Extracted note / exception update…"
                      className="pf-input text-[11px]"
                    />

                    <div
                      className="p-2 rounded-lg max-h-32 overflow-y-auto pf-scroll whitespace-pre-wrap text-[10.5px]"
                      style={{ background: "#13171d", border: "1px solid #222933", color: "#94a3b8" }}
                    >
                      {em.fullBody || em.body || em.subject}
                    </div>

                    <button
                      type="button"
                      disabled={extractingId === em.id}
                      onClick={() => void handleApplyReviewedExtraction(em)}
                      className="w-full py-1.5 px-3 rounded-xl text-xs font-bold inline-flex items-center justify-center gap-1.5"
                      style={{ background: "#21b975", color: "#04130b" }}
                    >
                      <CheckCircle2 size={12} />
                      {em.loadId && em.loadId !== "NEW"
                        ? `Apply Update to Load #${em.loadId} & Sync TAI`
                        : "Extract into Load Builder"}
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
