import React from "react";
import type { CustomerOption, OpsKpis, OpsShipment, SavedFacility } from "@shared/tai-webhook-schema";
import {
  AlertTriangle,
  Calculator,
  CircleDollarSign,
  ClipboardCheck,
  Copy,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  Inbox,
  LayoutGrid,
  Mail,
  MessageSquare,
  PlusSquare,
  Search,
  TrendingUp,
  Truck,
  type LucideIcon,
} from "lucide-react";
import type { PanelViewId } from "./panelTypes";

interface HomeLauncherViewProps {
  onNavigate: (view: PanelViewId) => void;
  attentionCount: number;
  inboxCount?: number;
  shipments: OpsShipment[];
  customers: CustomerOption[];
  facilities: SavedFacility[];
  kpis?: OpsKpis | null;
  taiPortalUrl?: string;
}

interface LauncherCardItem {
  id: string;
  title: string;
  subtitle: string;
  icon: LucideIcon;
  isAttention?: boolean;
  badgeCount?: number;
  badgeColor?: string;
  onClick: (e: React.MouseEvent) => void;
}

export const HomeLauncherView: React.FC<HomeLauncherViewProps> = ({
  onNavigate,
  attentionCount,
  inboxCount = 0,
  shipments,
  customers,
  facilities,
  kpis,
  taiPortalUrl,
}) => {
  const pickedUpWeek = kpis?.pickedUp7d ?? shipments.filter((s) => s.stage === "In transit" || s.stage === "Delivered").length;
  const deliveredWeek = kpis?.delivered7d ?? shipments.filter((s) => s.stage === "Delivered").length;
  const customersTotal = kpis?.customersCount ?? customers.length;
  const addressesTotal = kpis?.facilitiesCount ?? facilities.length;

  const workQueues: LauncherCardItem[] = [
    {
      id: "inbox",
      title: "Inbox",
      subtitle: "Live Gmail stream via extension",
      icon: Inbox,
      badgeCount: inboxCount,
      badgeColor: "#66d9a2",
      onClick: () => onNavigate("inbox"),
    },
    {
      id: "attention",
      title: "Attention",
      subtitle: "Items waiting on you",
      icon: AlertTriangle,
      isAttention: true,
      onClick: () => onNavigate("attention"),
    },
    {
      id: "dispatch",
      title: "Dispatch",
      subtitle: "Loads needing a truck",
      icon: Truck,
      onClick: () => onNavigate("dispatch"),
    },
    {
      id: "all-loads",
      title: "All Loads",
      subtitle: "Search every shipment",
      icon: FileSpreadsheet,
      onClick: () => onNavigate("all-loads"),
    },
    {
      id: "rates",
      title: "Rates",
      subtitle: "Quotes and rate history",
      icon: CircleDollarSign,
      onClick: () => onNavigate("rates"),
    },
  ];

  const documents: LauncherCardItem[] = [
    {
      id: "build-load",
      title: "Load Builder",
      subtitle: "Build a new load",
      icon: PlusSquare,
      onClick: () => onNavigate("build-load"),
    },
    {
      id: "tools-bol",
      title: "BOL Generator",
      subtitle: "Create a bill of lading",
      icon: FileText,
      onClick: () => onNavigate("tools-bol"),
    },
    {
      id: "quote-builder",
      title: "Quote Builder",
      subtitle: "Draft a customer quote",
      icon: Copy,
      onClick: () => onNavigate("quote-builder"),
    },
    {
      id: "pod",
      title: "POD",
      subtitle: "Proof of delivery files",
      icon: ClipboardCheck,
      onClick: () => onNavigate("pod"),
    },
  ];

  const emailAndAi: LauncherCardItem[] = [
    {
      id: "check-email",
      title: "Check against loads",
      subtitle: "Match this email to a load",
      icon: Search,
      onClick: () => onNavigate("check-email"),
    },
    {
      id: "ai-assistant",
      title: "AI Assistant",
      subtitle: "Ask about loads and carriers",
      icon: MessageSquare,
      onClick: () => onNavigate("ai-assistant"),
    },
    {
      id: "ap-tasks",
      title: "AP Emails",
      subtitle: "Invoices and payables",
      icon: Mail,
      onClick: () => onNavigate("ap-tasks"),
    },
  ];

  const moreCards: LauncherCardItem[] = [
    {
      id: "sales",
      title: "Sales",
      subtitle: "Customers and pipeline",
      icon: TrendingUp,
      onClick: () => onNavigate("sales"),
    },
    {
      id: "full-dashboard",
      title: "Full dashboard",
      subtitle: "Open the full app",
      icon: LayoutGrid,
      onClick: (e) => {
        if (e.ctrlKey || e.metaKey) {
          window.open("/", "_blank", "noopener,noreferrer");
          return;
        }
        window.open("/", "_blank", "noopener,noreferrer");
      },
    },
    {
      id: "open-tai",
      title: "Open TAI",
      subtitle: "Open Transportation AI",
      icon: ExternalLink,
      onClick: () => {
        if (taiPortalUrl) {
          window.open(taiPortalUrl, "_blank", "noopener,noreferrer");
        } else {
          onNavigate("dispatch");
        }
      },
    },
    {
      id: "tools",
      title: "Deck & Permits",
      subtitle: "Height & weight limits",
      icon: Calculator,
      onClick: () => onNavigate("tools"),
    },
  ];

  const renderSection = (heading: string, items: LauncherCardItem[]) => (
    <section className="space-y-2">
      <div
        className="text-[11px] font-semibold uppercase tracking-[0.08em] px-0.5"
        style={{ color: "#7d8797" }}
      >
        {heading}
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        {items.map((card) => {
          const Icon = card.icon;
          return (
            <button
              key={card.id}
              type="button"
              onClick={card.onClick}
              className="p-3.5 rounded-2xl text-left flex flex-col justify-between gap-3 transition-all hover:border-[#1768b2] hover:brightness-110"
              style={{
                background: "#13171d",
                border: "1px solid #222933",
              }}
            >
              <div className="flex items-start justify-between gap-2 w-full">
                <span
                  className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                  style={
                    card.isAttention
                      ? { background: "rgba(255, 82, 90, 0.15)", color: "#ff525a" }
                      : { background: "#191f28", color: "#c1d1e0" }
                  }
                >
                  <Icon size={17} strokeWidth={1.9} />
                </span>

                {card.isAttention && (
                  <span
                    id="nav-attention-badge"
                    className="px-2.5 py-0.5 rounded-full text-[11px] font-bold"
                    style={{ background: "#d42f34", color: "#ffffff" }}
                  >
                    {attentionCount}
                  </span>
                )}
                {!card.isAttention && typeof card.badgeCount === "number" && card.badgeCount > 0 && (
                  <span
                    className="px-2.5 py-0.5 rounded-full text-[11px] font-bold"
                    style={{ background: "rgba(33, 185, 117, 0.16)", color: card.badgeColor || "#66d9a2" }}
                  >
                    {card.badgeCount}
                  </span>
                )}
              </div>

              <div className="space-y-0.5 min-w-0">
                <div className="text-[14px] font-bold text-white truncate">{card.title}</div>
                <div className="text-[12px] leading-snug truncate" style={{ color: "#94a3b8" }}>
                  {card.subtitle}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );

  return (
    <div className="space-y-5 pb-3">
      {renderSection("WORK QUEUES", workQueues)}
      {renderSection("DOCUMENTS", documents)}
      {renderSection("EMAIL & AI", emailAndAi)}
      {renderSection("MORE", moreCards)}

      {/* Weekly KPI Footer Cards */}
      <div className="grid grid-cols-2 gap-2.5 pt-1">
        <div
          className="p-3.5 rounded-2xl space-y-1.5"
          style={{ background: "#13171d", border: "1px solid #222933" }}
        >
          <div
            className="text-[10.5px] font-semibold uppercase tracking-[0.07em]"
            style={{ color: "#94a3b8" }}
          >
            PICKED UP THIS WEEK
          </div>
          <div className="text-[22px] font-bold leading-none" style={{ color: "#66d9a2" }}>
            {pickedUpWeek}
          </div>
        </div>

        <div
          className="p-3.5 rounded-2xl space-y-1.5"
          style={{ background: "#13171d", border: "1px solid #222933" }}
        >
          <div
            className="text-[10.5px] font-semibold uppercase tracking-[0.07em]"
            style={{ color: "#94a3b8" }}
          >
            DELIVERED THIS WEEK
          </div>
          <div className="text-[22px] font-bold text-white leading-none">{deliveredWeek}</div>
        </div>
      </div>

      {/* Subtle Directory Counts Footer */}
      <div className="text-center text-xs pt-0.5" style={{ color: "#64748b" }}>
        {customersTotal.toLocaleString()} customers · {addressesTotal.toLocaleString()} addresses
      </div>
    </div>
  );
};
