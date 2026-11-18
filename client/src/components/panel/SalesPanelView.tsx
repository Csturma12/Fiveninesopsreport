import React, { useMemo, useState } from "react";
import type { LoadEntry } from "@shared/load-entry";
import type { CrmLeadItem, CrmLeadStage, CustomerOption, OpsShipment } from "@shared/tai-webhook-schema";
import { AlertTriangle, Plus, Rocket, Search, Send } from "lucide-react";
import { panelFetchJson, type PanelApiContext } from "./panelApi";
import { buildExistingCustomerSet, isKnownExistingCustomer, type PanelViewId } from "./panelTypes";

interface SalesPanelViewProps {
  leads: CrmLeadItem[];
  customers?: CustomerOption[];
  shipments?: OpsShipment[];
  builderEntry: LoadEntry;
  onBuilderChange: (next: LoadEntry) => void;
  apiCtx?: PanelApiContext;
  onRefresh: () => Promise<void>;
  onToast: (msg: string, kind?: "ok" | "error") => void;
  onNavigate: (view: PanelViewId) => void;
}

const STAGES: CrmLeadStage[] = ["New", "Researching", "Contacted", "Qualified", "Converted"];

export const SalesPanelView: React.FC<SalesPanelViewProps> = ({
  leads,
  customers = [],
  shipments = [],
  builderEntry,
  onBuilderChange,
  apiCtx,
  onRefresh,
  onToast,
  onNavigate,
}) => {
  const [stageFilter, setStageFilter] = useState<CrmLeadStage | "All">("All");
  const [query, setQuery] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);

  const [company, setCompany] = useState("");
  const [contact, setContact] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [location, setLocation] = useState("Houston, TX");
  const [estimatedLanes, setEstimatedLanes] = useState("");
  const [evidence, setEvidence] = useState("");

  const existingCustomerKeys = useMemo(
    () => buildExistingCustomerSet(customers, shipments),
    [customers, shipments],
  );

  const netNewLeads = useMemo(
    () => leads.filter((l) => !isKnownExistingCustomer(l.company, existingCustomerKeys)),
    [leads, existingCustomerKeys],
  );

  const typedCompanyIsExisting = useMemo(
    () => isKnownExistingCustomer(company, existingCustomerKeys),
    [company, existingCustomerKeys],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return netNewLeads.filter((l) => {
      if (stageFilter !== "All" && l.status !== stageFilter) return false;
      if (!q) return true;
      return `${l.company} ${l.contact} ${l.email} ${l.location} ${l.estimatedLanes || ""} ${l.evidence}`
        .toLowerCase()
        .includes(q);
    });
  }, [netNewLeads, stageFilter, query]);

  const handleAddLead = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!company.trim()) return;
    if (typedCompanyIsExisting) {
      onToast(`"${company.trim()}" is already an existing TAI customer — Sales CRM is for net-new prospects only.`, "error");
      return;
    }
    setSaving(true);
    try {
      const { ok, data } = await panelFetchJson<{ ok?: boolean; blockedExistingCustomer?: boolean; message?: string }>(
        "/api/crm/leads",
        {
          method: "POST",
          body: JSON.stringify({
            company: company.trim(),
            contact: contact.trim(),
            email: email.trim(),
            phone: phone.trim(),
            location: location.trim(),
            estimatedLanes: estimatedLanes.trim(),
            evidence: evidence.trim(),
            source: "Gmail",
            status: "New",
          }),
        },
        apiCtx,
      );
      if (!ok || data.ok === false) {
        onToast(data.message || "Failed to save lead", "error");
        return;
      }
      onToast(data.message || `Added ${company.trim()} to SalesOps CRM`);
      setCompany("");
      setContact("");
      setEmail("");
      setPhone("");
      setEstimatedLanes("");
      setEvidence("");
      setShowAdd(false);
      await onRefresh();
    } finally {
      setSaving(false);
    }
  };

  const handleStageUpdate = async (id: string, status: CrmLeadStage) => {
    const { ok, data } = await panelFetchJson<{ ok?: boolean; message?: string }>(
      `/api/crm/leads/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ status }),
      },
      apiCtx,
    );
    onToast(data.message || `Updated stage to ${status}`, ok && data.ok !== false ? "ok" : "error");
    await onRefresh();
  };

  const handlePushLead = async (id: string) => {
    const { ok, data } = await panelFetchJson<{ ok?: boolean; message?: string }>(
      `/api/crm/leads/${encodeURIComponent(id)}/push`,
      { method: "POST" },
      apiCtx,
    );
    onToast(data.message || "SalesOps push finished", ok && data.ok === true ? "ok" : "error");
    await onRefresh();
  };

  const handleBuildFromLead = (lead: CrmLeadItem) => {
    onBuilderChange({
      ...builderEntry,
      customer: {
        ...builderEntry.customer,
        name: lead.company.toUpperCase(),
        taiOrganizationId: "",
        contactName: lead.contact,
        email: lead.email,
      },
      specialInstructions: lead.estimatedLanes || lead.evidence || builderEntry.specialInstructions,
    });
    onToast(`Prefilled Load Builder for ${lead.company}`);
    onNavigate("build-load");
  };

  return (
    <div className="space-y-2.5">
      {/* Header & Quick Add Toggle */}
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-xs font-bold">Houston / Five Nines Net-New Prospects</div>
          <div className="text-[10px]" style={{ color: "var(--pf-text-muted)" }}>
            {netNewLeads.length} net-new leads · Existing TAI customers excluded
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowAdd((v) => !v)}
          className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold inline-flex items-center gap-1 shrink-0"
          style={{ background: "var(--pf-action)", color: "#ffffff" }}
        >
          <Plus size={12} /> {showAdd ? "Close" : "Add Lead"}
        </button>
      </div>

      {/* Quick Add Lead Form */}
      {showAdd && (
        <form
          onSubmit={handleAddLead}
          className="p-2.5 rounded-xl space-y-1.5"
          style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-action)" }}
        >
          {typedCompanyIsExisting && (
            <div
              className="p-2 rounded-lg text-[10.5px] font-semibold inline-flex items-center gap-1 w-full"
              style={{ background: "var(--pf-warning-dim)", color: "var(--pf-warning)" }}
            >
              <AlertTriangle size={12} /> Existing TAI customer — Sales CRM accepts net-new prospects only.
            </div>
          )}
          <div className="grid grid-cols-2 gap-1.5">
            <input
              required
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="Company Name *"
              className="pf-input font-semibold text-[11px]"
            />
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Location (e.g. Houston, TX)"
              className="pf-input text-[11px]"
            />
            <input
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              placeholder="Contact Name"
              className="pf-input text-[11px]"
            />
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="Phone"
              className="pf-input font-mono text-[11px]"
            />
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Work Email"
              className="pf-input text-[11px]"
            />
            <input
              value={estimatedLanes}
              onChange={(e) => setEstimatedLanes(e.target.value)}
              placeholder="Lanes (e.g. TX→OK Flatbed)"
              className="pf-input text-[11px]"
            />
          </div>
          <input
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
            placeholder="Shipping notes / commodity / volume…"
            className="pf-input text-[11px]"
          />
          <button
            type="submit"
            disabled={saving || typedCompanyIsExisting}
            className="w-full py-1.5 rounded-lg text-xs font-bold disabled:opacity-45"
            style={{ background: "var(--pf-primary)", color: "var(--pf-primary-fg)" }}
          >
            {saving ? "Saving…" : "Save Lead to SalesOps CRM"}
          </button>
        </form>
      )}

      {/* Search + Stage Filter */}
      <div className="flex items-center gap-1.5">
        <div
          className="flex items-center gap-1.5 px-2 py-1 rounded-lg flex-1"
          style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
        >
          <Search size={11} style={{ color: "var(--pf-text-muted)" }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search company, Houston shipper, lane…"
            className="bg-transparent border-0 outline-none text-[11px] w-full"
            style={{ color: "var(--pf-text)" }}
          />
        </div>
        <select
          value={stageFilter}
          onChange={(e) => setStageFilter(e.target.value as CrmLeadStage | "All")}
          className="pf-input !w-[116px] text-[11px]"
        >
          <option value="All">All Stages</option>
          {STAGES.map((st) => (
            <option key={st} value={st}>
              {st}
            </option>
          ))}
        </select>
      </div>

      {/* Compact Lead Cards */}
      <div className="space-y-1.5">
        {visible.length === 0 ? (
          <div
            className="p-4 rounded-xl text-center text-xs"
            style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)", color: "var(--pf-text-muted)" }}
          >
            No CRM leads match this filter.
          </div>
        ) : (
          visible.map((lead) => (
            <div
              key={lead.id}
              className="p-2.5 rounded-xl space-y-1.5 text-xs"
              style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold truncate">{lead.company}</div>
                  <div className="text-[10px] truncate" style={{ color: "var(--pf-text-muted)" }}>
                    {lead.location || "Houston Metro"} · {lead.contact || "No contact"} {lead.phone ? `· ${lead.phone}` : ""}
                  </div>
                </div>
                <select
                  value={lead.status}
                  onChange={(e) => void handleStageUpdate(lead.id, e.target.value as CrmLeadStage)}
                  className="pf-input !w-auto text-[10px] font-semibold"
                >
                  {STAGES.map((st) => (
                    <option key={st} value={st}>
                      {st}
                    </option>
                  ))}
                </select>
              </div>

              {(lead.estimatedLanes || lead.evidence) && (
                <div className="text-[11px] line-clamp-2" style={{ color: "var(--pf-text-subtle)" }}>
                  {lead.estimatedLanes ? <strong>{lead.estimatedLanes}: </strong> : null}
                  {lead.evidence}
                </div>
              )}

              <div className="flex items-center gap-1.5 pt-0.5">
                <button
                  type="button"
                  onClick={() => handleBuildFromLead(lead)}
                  className="flex-1 py-1 px-2 rounded text-[10px] font-bold inline-flex items-center justify-center gap-1"
                  style={{ background: "var(--pf-primary-dim)", color: "var(--pf-primary)" }}
                >
                  <Rocket size={10} /> Build Load
                </button>
                <button
                  type="button"
                  onClick={() => void handlePushLead(lead.id)}
                  className="py-1 px-2 rounded text-[10px] font-medium inline-flex items-center gap-1"
                  style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
                >
                  <Send size={10} /> {lead.pushedToVercelCrm ? "Synced" : "Push CRM"}
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
