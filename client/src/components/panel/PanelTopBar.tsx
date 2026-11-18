import React, { useMemo, useRef, useState } from "react";
import type { OpsShipment } from "@shared/tai-webhook-schema";
import { Bot, ChevronLeft, Inbox, LayoutGrid, PlusCircle, RefreshCw, Search, X } from "lucide-react";
import {
  MAX_PANEL_ZOOM,
  MIN_PANEL_ZOOM,
  type PanelSessionInfo,
  type PanelViewId,
} from "./panelTypes";

interface PanelTopBarProps {
  fullScreen?: boolean;
  view: PanelViewId;
  onNavigate: (view: PanelViewId) => void;
  shipments: OpsShipment[];
  onInspectLoad: (shipmentId: string, targetView?: "dispatch" | "all-loads") => void;
  universalQuery: string;
  onUniversalQueryChange: (q: string) => void;
  zoom: number;
  onZoomStep: (delta: number) => void;
  onZoomReset: () => void;
  refreshing: boolean;
  onRefreshAll: () => void;
  session: PanelSessionInfo | null;
  fallbackUser?: { email: string; name: string } | null;
  attentionCount: number;
  inboxCount?: number;
  openApCount: number;
  liveThreadSubject: string;
  onQuickCaptureThread: () => void;
}

export const PanelTopBar: React.FC<PanelTopBarProps> = ({
  fullScreen = false,
  view,
  onNavigate,
  shipments,
  onInspectLoad,
  universalQuery,
  onUniversalQueryChange,
  zoom,
  onZoomStep,
  onZoomReset,
  refreshing,
  onRefreshAll,
  session,
  fallbackUser,
  attentionCount,
  inboxCount = 0,
  liveThreadSubject,
  onQuickCaptureThread,
}) => {
  const [searchFocused, setSearchFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const activeUser = session?.user || fallbackUser || null;
  const staffDisplayName = useMemo(() => {
    if (!activeUser) return "Staff";
    const raw =
      ("displayName" in activeUser && activeUser.displayName) ||
      ("name" in activeUser && activeUser.name) ||
      activeUser.email.split("@")[0] ||
      "Staff";
    return String(raw).split(" ")[0];
  }, [activeUser]);

  const staffEmail = activeUser?.email || "chriss@primarycompanies.com";

  const oauthHref = useMemo(() => {
    if (typeof window === "undefined") return "/auth/google";
    const returnTo = `${window.location.pathname}${window.location.search}`;
    return `/auth/google?returnTo=${encodeURIComponent(returnTo)}`;
  }, [view]);

  const quickMatches = useMemo(() => {
    const q = universalQuery.trim().toLowerCase();
    if (!q) return [];
    return shipments
      .filter((s) => {
        const hay = [
          s.id,
          s.po,
          s.bol,
          s.pro,
          s.customer,
          s.carrier,
          s.containerNumber || "",
          s.origin,
          s.dest,
          ...s.stops.map((st) => `${st.companyName} ${st.city} ${st.state} ${st.zipCode}`),
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 8);
  }, [shipments, universalQuery]);

  return (
    <header
      className="shrink-0 select-none relative z-30"
      style={{ background: "#0b0e11", color: "#f8fafc", borderBottom: "1px solid #222933" }}
    >
      {/* Calm Single-Row Top Bar matching reference mockups */}
      <div className="px-3 py-2.5 flex items-center gap-2.5 relative">
        {/* Left: ‹ Home back button on sub-views, or subtle launcher badge on Home */}
        {view !== "home" ? (
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => onNavigate("home")}
              className="inline-flex items-center gap-1 text-[13px] font-semibold text-white hover:opacity-80 transition-opacity py-1 pr-1"
              title="Back to Home Launcher"
            >
              <ChevronLeft size={16} strokeWidth={2.2} className="text-slate-300" />
              <span>Home</span>
            </button>
            <button
              type="button"
              onClick={() => onNavigate("attention")}
              className="px-1.5 py-0.5 rounded-full font-mono text-[10px] font-bold"
              style={{
                background: attentionCount > 0 ? "#d42f34" : "#191f28",
                color: "#ffffff",
              }}
              title="Open Attention items"
            >
              <span id="nav-attention-badge">{attentionCount}</span>
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 transition-colors hover:bg-white/10"
            style={{ background: "#13171d", border: "1px solid #222933", color: "#94a3b8" }}
            title="Five Nines / Primary Freight Panel Controls"
          >
            <LayoutGrid size={14} />
          </button>
        )}

        {/* Center: Full-width rounded search input */}
        <div className="flex-1 min-w-0 relative">
          <div
            className="flex items-center gap-2 px-3 py-2 rounded-xl transition-colors"
            style={{
              background: "#13171d",
              border: `1px solid ${searchFocused ? "#21b975" : "#222933"}`,
            }}
          >
            <Search size={14} style={{ color: "#6e7787" }} className="shrink-0" />
            <input
              ref={inputRef}
              id="universal-search-input"
              value={universalQuery}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => window.setTimeout(() => setSearchFocused(false), 180)}
              onChange={(e) => onUniversalQueryChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && universalQuery.trim()) {
                  if (quickMatches.length === 1) {
                    onInspectLoad(quickMatches[0].id, "dispatch");
                    setSearchFocused(false);
                  } else {
                    onNavigate("all-loads");
                    setSearchFocused(false);
                  }
                }
                if (e.key === "Escape") {
                  onUniversalQueryChange("");
                  inputRef.current?.blur();
                }
              }}
              placeholder="Search load #, PO, customer, anything..."
              className="bg-transparent border-0 outline-none text-xs w-full text-slate-100 placeholder:text-[#6e7787]"
            />
            {universalQuery && (
              <button
                type="button"
                onClick={() => onUniversalQueryChange("")}
                className="p-0.5 rounded hover:bg-white/10 text-slate-400"
                aria-label="Clear search"
              >
                <X size={12} />
              </button>
            )}
          </div>

          {/* Instant Cross-Load Match Dropdown */}
          {searchFocused && universalQuery.trim().length > 0 && (
            <div
              className="absolute left-0 right-0 top-full mt-1.5 rounded-2xl shadow-2xl overflow-hidden z-50 max-h-64 overflow-y-auto pf-scroll"
              style={{ background: "#131820", border: "1px solid #262f3d", color: "#f3f5f8" }}
            >
              {quickMatches.length === 0 ? (
                <div className="p-3 text-xs" style={{ color: "#8b95a5" }}>
                  No loads match &ldquo;{universalQuery}&rdquo;. Press Enter to search All Loads.
                </div>
              ) : (
                <>
                  <div
                    className="px-3 py-1.5 text-[10px] font-mono uppercase flex items-center justify-between"
                    style={{ background: "#181f2a", color: "#8b95a5" }}
                  >
                    <span>Matches ({quickMatches.length})</span>
                    <button
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        onNavigate("all-loads");
                        setSearchFocused(false);
                      }}
                      className="underline font-semibold"
                      style={{ color: "#66d9a2" }}
                    >
                      All Loads →
                    </button>
                  </div>
                  {quickMatches.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        onInspectLoad(s.id, "dispatch");
                        setSearchFocused(false);
                      }}
                      className="w-full text-left px-3 py-2 text-xs hover:bg-white/5 flex items-center justify-between gap-2"
                      style={{ borderTop: "1px solid #222933" }}
                    >
                      <div className="min-w-0">
                        <div className="font-semibold truncate">
                          {s.customer} · {s.origin.split(",")[0]} → {s.dest.split(",")[0]}{" "}
                          <span className="font-mono font-normal" style={{ color: "#94a3b8" }}>
                            ({s.id})
                          </span>
                        </div>
                        <div className="text-[11px] truncate" style={{ color: "#94a3b8" }}>
                          {s.po ? `PO ${s.po} · ` : ""}
                          {s.carrier || "Needs carrier"}
                          {s.containerNumber ? ` · ${s.containerNumber}` : ""}
                        </div>
                      </div>
                      <span
                        className="px-2 py-0.5 rounded-full text-[10px] font-medium shrink-0"
                        style={{ background: "rgba(33,185,117,0.16)", color: "#66d9a2" }}
                      >
                        {s.stage}
                      </span>
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>

        {/* Right: Signature Five Nines Signal Emerald Connection Dot */}
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 hover:bg-white/5 transition-colors"
          title={`Connected as ${staffEmail} · Zoom ${zoom}% · Click for controls`}
          aria-label="Toggle session, zoom, and refresh controls"
        >
          <span
            className="w-2.5 h-2.5 rounded-full block"
            style={{
              background: "#21b975",
              boxShadow: "0 0 8px rgba(33, 185, 117, 0.6)",
            }}
          />
        </button>

        {/* Session, Zoom (75%-130%) & Refresh Popover (kept mounted in DOM for instant keyboard & test access) */}
        <div
          className={`absolute right-3 top-full mt-1.5 w-64 rounded-2xl p-3 shadow-2xl space-y-2.5 z-50 transition-all ${
            menuOpen ? "opacity-100 pointer-events-auto translate-y-0" : "opacity-0 pointer-events-none -translate-y-1"
          }`}
          style={{ background: "#13171d", border: "1px solid #222933", color: "#f8fafc" }}
          aria-hidden={!menuOpen}
        >
          <div className="flex items-center justify-between gap-2 text-xs">
            <div className="min-w-0">
              <div className="font-semibold truncate" style={{ color: "#66d9a2" }}>
                ✓ {staffDisplayName}
              </div>
              <div className="text-[10px] font-mono truncate" style={{ color: "#94a3b8" }}>
                {staffEmail}
              </div>
            </div>
            <a
              href={oauthHref}
              className="px-2 py-1 rounded-lg text-[10px] font-semibold shrink-0"
              style={{ background: "#1768b2", color: "#ffffff" }}
            >
              Reconnect OAuth
            </a>
          </div>

          {/* Panel Zoom Controls */}
          <div
            className="flex items-center justify-between gap-2 pt-2 text-xs"
            style={{ borderTop: "1px solid #222936" }}
          >
            <span className="text-[11px]" style={{ color: "#8b95a5" }}>
              Panel Zoom
            </span>
            <div
              className="inline-flex items-center rounded-lg overflow-hidden font-mono text-[11px]"
              style={{ background: "#181f2a", border: "1px solid #262f3d" }}
            >
              <button
                type="button"
                disabled={zoom <= MIN_PANEL_ZOOM}
                onClick={() => onZoomStep(-5)}
                className="px-2.5 py-1 hover:bg-white/10 disabled:opacity-40"
              >
                −
              </button>
              <button
                type="button"
                onClick={onZoomReset}
                className="px-2.5 py-1 font-semibold hover:bg-white/10"
                title="Reset to 100% (Ctrl + 0)"
              >
                {zoom}%
              </button>
              <button
                type="button"
                disabled={zoom >= MAX_PANEL_ZOOM}
                onClick={() => onZoomStep(5)}
                className="px-2.5 py-1 hover:bg-white/10 disabled:opacity-40"
              >
                +
              </button>
            </div>
          </div>

          {/* Refresh & Quick Email Thread Indicator */}
          <div className="flex items-center justify-between gap-2 pt-1">
            <button
              id="btn-refresh-all"
              type="button"
              onClick={() => {
                onRefreshAll();
                setMenuOpen(false);
              }}
              className="flex-1 py-1.5 px-2.5 rounded-xl text-xs font-semibold inline-flex items-center justify-center gap-1.5"
              style={{ background: "#181f2a", border: "1px solid #262f3d" }}
            >
              <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
              Refresh Live Data
            </button>
          </div>

          {liveThreadSubject && (
            <button
              type="button"
              onClick={() => {
                onQuickCaptureThread();
                setMenuOpen(false);
              }}
              className="w-full text-left text-[11px] truncate pt-1 hover:underline"
              style={{ color: "#66d9a2" }}
            >
              📧 Open Thread: {liveThreadSubject}
            </button>
          )}
        </div>
      </div>

      {/* Docked Dashboard Quick Switcher: instant 1-click access between Live Inbox, Home, Load Builder & AI */}
      {!fullScreen && (
        <div
          className="px-3 pb-2 flex items-center gap-1.5"
          style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}
        >
          {(
            [
              { id: "inbox" as PanelViewId, label: "Inbox", icon: Inbox, badge: inboxCount > 0 ? inboxCount : null },
              { id: "home" as PanelViewId, label: "Toolkit Home", icon: LayoutGrid, badge: null },
              { id: "build-load" as PanelViewId, label: "Builder", icon: PlusCircle, badge: null },
              { id: "ai-assistant" as PanelViewId, label: "AI", icon: Bot, badge: null },
            ] as const
          ).map((tab) => {
            const Icon = tab.icon;
            const active = view === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => onNavigate(tab.id)}
                className="flex-1 py-1 px-2 rounded-lg text-[11px] font-semibold inline-flex items-center justify-center gap-1 transition-colors"
                style={{
                  background: active ? "rgba(23,104,178,0.24)" : "#13171d",
                  color: active ? "#ffffff" : "#94a3b8",
                  border: `1px solid ${active ? "#1768b2" : "#222933"}`,
                }}
              >
                <Icon size={11} />
                <span className="truncate">{tab.label}</span>
                {tab.badge !== null && (
                  <span
                    className="px-1 rounded-full font-mono text-[9px] font-bold"
                    style={{
                      background: active ? "#21b975" : "#191f28",
                      color: active ? "#04130b" : "#f8fafc",
                    }}
                  >
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </header>
  );
};
