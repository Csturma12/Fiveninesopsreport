import React, { useMemo, useState } from "react";
import type { CrmLeadItem, CrmLeadSource, CrmLeadStage } from "@shared/tai-webhook-schema";
import {
  Download,
  Edit3,
  ExternalLink,
  Plus,
  Rocket,
  Search,
  Send,
  Trash2,
  Upload,
} from "lucide-react";

interface SalesOpsCrmViewProps {
  leads: CrmLeadItem[];
  crmWebhookUrl: string;
  onAddLead: (payload: Partial<CrmLeadItem>) => Promise<void>;
  onBulkImportLeads: (leads: Array<Partial<CrmLeadItem>>) => Promise<void>;
  onUpdateLead: (id: string, patch: Partial<CrmLeadItem>) => Promise<void>;
  onDeleteLead: (id: string) => Promise<void>;
  onPushLead: (id: string) => Promise<void>;
  onBuildLoadFromLead: (lead: CrmLeadItem) => void;
}

const STAGES: CrmLeadStage[] = ["New", "Researching", "Contacted", "Qualified", "Converted"];
const SOURCES: CrmLeadSource[] = ["Manual", "Clay", "ImportYeti", "Gmail", "Quote"];

function exportForClay(leads: CrmLeadItem[]) {
  const cell = (v: string) => `"${(/^[=+@\-\t\r]/.test(v) ? "'" + v : v).replace(/"/g, '""')}"`;
  const rows = [
    ["Lead ID", "Company Name", "Location", "Source", "Contact Name", "Work Email", "Phone", "Stage", "Evidence", "Lanes"],
    ...leads.map((l) => [
      l.id,
      l.company,
      l.location,
      l.source,
      l.contact,
      l.email,
      l.phone,
      l.status,
      l.evidence,
      l.estimatedLanes || "",
    ]),
  ];
  const blob = new Blob([rows.map((r) => r.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "salesops-leads-for-clay.csv";
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function parseSimpleCsv(raw: string): Array<Partial<CrmLeadItem>> {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];
  const delim = lines[0].includes("\t") ? "\t" : ",";
  const splitRow = (line: string) =>
    line.split(delim).map((cell) => cell.trim().replace(/^"|"$/g, ""));

  const header = splitRow(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const hasHeader = header.some((h) => ["company", "companyname"].includes(h));
  const dataLines = hasHeader ? lines.slice(1) : lines;

  return dataLines
    .map((line) => {
      const cols = splitRow(line);
      if (!hasHeader) {
        return {
          company: cols[0] || "",
          contact: cols[1] || "",
          email: cols[2] || "",
          phone: cols[3] || "",
          location: cols[4] || "",
          evidence: cols[5] || "",
          source: "Clay" as CrmLeadSource,
        };
      }
      const getCol = (...names: string[]) => {
        const idx = header.findIndex((h) => names.includes(h));
        return idx >= 0 ? cols[idx] || "" : "";
      };
      return {
        company: getCol("company", "companyname"),
        contact: getCol("contact", "contactname", "name"),
        email: getCol("email", "workemail"),
        phone: getCol("phone", "phonenumber"),
        location: getCol("location", "citystate", "city"),
        evidence: getCol("evidence", "notes", "reason"),
        estimatedLanes: getCol("lanes", "estimatedlanes"),
        source: "Clay" as CrmLeadSource,
      };
    })
    .filter((r) => Boolean(r.company));
}

export const SalesOpsCrmView: React.FC<SalesOpsCrmViewProps> = ({
  leads,
  crmWebhookUrl,
  onAddLead,
  onBulkImportLeads,
  onUpdateLead,
  onDeleteLead,
  onPushLead,
  onBuildLoadFromLead,
}) => {
  const [stageFilter, setStageFilter] = useState<CrmLeadStage | "All">("All");
  const [search, setSearch] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [csvText, setCsvText] = useState("");
  const [editingLead, setEditingLead] = useState<CrmLeadItem | null>(null);

  const [newLead, setNewLead] = useState({
    company: "",
    contact: "",
    email: "",
    phone: "",
    location: "",
    source: "Manual" as CrmLeadSource,
    status: "New" as CrmLeadStage,
    followUp: "",
    evidence: "",
    estimatedLanes: "",
  });

  const externalCrmUrl = useMemo(() => {
    try {
      return new URL(crmWebhookUrl).origin;
    } catch {
      return "https://salesops-dashboard-coral-seven.vercel.app";
    }
  }, [crmWebhookUrl]);

  const counts = useMemo(() => {
    const out: Record<string, number> = { All: leads.length };
    for (const st of STAGES) out[st] = 0;
    for (const l of leads) out[l.status] = (out[l.status] || 0) + 1;
    return out;
  }, [leads]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return leads.filter((l) => {
      if (stageFilter !== "All" && l.status !== stageFilter) return false;
      if (!q) return true;
      return `${l.company} ${l.contact} ${l.email} ${l.location} ${l.evidence} ${l.estimatedLanes || ""}`
        .toLowerCase()
        .includes(q);
    });
  }, [leads, stageFilter, search]);

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLead.company.trim()) return;
    await onAddLead(newLead);
    setNewLead({
      company: "",
      contact: "",
      email: "",
      phone: "",
      location: "",
      source: "Manual",
      status: "New",
      followUp: "",
      evidence: "",
      estimatedLanes: "",
    });
    setShowAddForm(false);
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--pf-action)" }}>
            Pipeline, Clay / ImportYeti Capture &amp; 1-Click Quote Conversion
          </div>
          <h1 className="text-xl font-semibold tracking-tight mt-0.5">SalesOps CRM &amp; Leads</h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setShowAddForm(!showAddForm);
              setShowImport(false);
            }}
            className="px-3 py-1.5 rounded-lg text-xs font-bold inline-flex items-center gap-1.5"
            style={{ background: "var(--pf-action)", color: "#ffffff" }}
          >
            <Plus size={13} /> New Lead
          </button>
          <button
            type="button"
            onClick={() => {
              setShowImport(!showImport);
              setShowAddForm(false);
            }}
            className="px-3 py-1.5 rounded-lg text-xs font-medium inline-flex items-center gap-1.5"
            style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
          >
            <Upload size={13} /> Import CSV
          </button>
          <button
            type="button"
            disabled={filtered.length === 0}
            onClick={() => exportForClay(filtered)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium inline-flex items-center gap-1.5"
            style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
          >
            <Download size={13} /> Export Clay CSV
          </button>
          <a
            href={externalCrmUrl}
            target="_blank"
            rel="noreferrer"
            className="px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5"
            style={{ background: "var(--pf-info-dim)", color: "var(--pf-info)", border: "1px solid var(--pf-border)" }}
          >
            <ExternalLink size={12} /> Open SalesOps Dashboard
          </a>
        </div>
      </div>

      {/* Add Lead Form */}
      {showAddForm && (
        <form
          onSubmit={handleCreateSubmit}
          className="p-4 rounded-xl space-y-3"
          style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-action)" }}
        >
          <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--pf-text-muted)" }}>
            Add SalesOps Lead
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
            <input
              required
              value={newLead.company}
              onChange={(e) => setNewLead({ ...newLead, company: e.target.value })}
              placeholder="Company Name *"
              className="pf-input font-semibold"
            />
            <input
              value={newLead.contact}
              onChange={(e) => setNewLead({ ...newLead, contact: e.target.value })}
              placeholder="Contact Name"
              className="pf-input"
            />
            <input
              type="email"
              value={newLead.email}
              onChange={(e) => setNewLead({ ...newLead, email: e.target.value })}
              placeholder="Work Email"
              className="pf-input"
            />
            <input
              value={newLead.phone}
              onChange={(e) => setNewLead({ ...newLead, phone: e.target.value })}
              placeholder="Phone"
              className="pf-input font-mono"
            />
            <input
              value={newLead.location}
              onChange={(e) => setNewLead({ ...newLead, location: e.target.value })}
              placeholder="City, ST ZIP"
              className="pf-input"
            />
            <input
              value={newLead.estimatedLanes}
              onChange={(e) => setNewLead({ ...newLead, estimatedLanes: e.target.value })}
              placeholder="Target Lanes / Equipment"
              className="pf-input"
            />
            <select
              value={newLead.source}
              onChange={(e) => setNewLead({ ...newLead, source: e.target.value as CrmLeadSource })}
              className="pf-input"
            >
              {SOURCES.map((src) => (
                <option key={src} value={src}>
                  Source: {src}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={newLead.followUp}
              onChange={(e) => setNewLead({ ...newLead, followUp: e.target.value })}
              className="pf-input font-mono"
            />
          </div>
          <textarea
            rows={2}
            value={newLead.evidence}
            onChange={(e) => setNewLead({ ...newLead, evidence: e.target.value })}
            placeholder="Shipping evidence, ImportYeti volume, commodity fit, or call notes…"
            className="pf-input"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowAddForm(false)}
              className="px-3 py-1.5 rounded-lg text-xs"
              style={{ background: "var(--pf-surface-raised)" }}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 rounded-lg text-xs font-bold"
              style={{ background: "var(--pf-primary)", color: "var(--pf-primary-fg)" }}
            >
              Save Lead to CRM
            </button>
          </div>
        </form>
      )}

      {/* CSV Import Box */}
      {showImport && (
        <div
          className="p-4 rounded-xl space-y-2.5"
          style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-primary)" }}
        >
          <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--pf-text-muted)" }}>
            Paste CSV / TSV Rows (Company, Contact, Email, Phone, Location, Evidence)
          </div>
          <textarea
            rows={4}
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            placeholder={"Company Name, Contact Name, Email, Phone, Location, Evidence\nAcme Refractories, Jane Doe, jdoe@acme.com, 555-221-9000, Pittsburgh PA, 10 flatbed loads/mo"}
            className="pf-input font-mono"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowImport(false)}
              className="px-3 py-1.5 rounded-lg text-xs"
              style={{ background: "var(--pf-surface-raised)" }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={async () => {
                const parsed = parseSimpleCsv(csvText);
                if (parsed.length === 0) return;
                await onBulkImportLeads(parsed);
                setCsvText("");
                setShowImport(false);
              }}
              className="px-4 py-1.5 rounded-lg text-xs font-bold"
              style={{ background: "var(--pf-primary)", color: "var(--pf-primary-fg)" }}
            >
              Import Rows
            </button>
          </div>
        </div>
      )}

      {/* Stage Filter Pills & Search */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {(["All", ...STAGES] as const).map((st) => {
            const active = stageFilter === st;
            return (
              <button
                key={st}
                type="button"
                onClick={() => setStageFilter(st)}
                className="px-3 py-1.5 rounded-full text-xs font-medium transition-all"
                style={{
                  background: active ? "var(--pf-action)" : "var(--pf-surface)",
                  color: active ? "#ffffff" : "var(--pf-text-muted)",
                  border: `1px solid ${active ? "var(--pf-action)" : "var(--pf-border)"}`,
                }}
              >
                {st} · {counts[st] ?? 0}
              </button>
            );
          })}
        </div>

        <div
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg min-w-[240px]"
          style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
        >
          <Search size={13} style={{ color: "var(--pf-text-muted)" }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter leads by company, email, lane…"
            className="bg-transparent border-0 outline-none text-xs w-full"
            style={{ color: "var(--pf-text)" }}
          />
        </div>
      </div>

      {/* Leads List */}
      <div className="space-y-2.5">
        {filtered.length === 0 ? (
          <div
            className="p-8 rounded-xl text-center text-xs"
            style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)", color: "var(--pf-text-muted)" }}
          >
            No SalesOps leads match this view. Click <strong>+ New Lead</strong> above to add one.
          </div>
        ) : (
          filtered.map((lead) => (
            <div
              key={lead.id}
              className="p-4 rounded-xl flex flex-col lg:flex-row lg:items-center justify-between gap-4"
              style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
            >
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">{lead.company}</span>
                  <span
                    className="font-mono text-[10px] px-2 py-0.5 rounded font-semibold"
                    style={{ background: "var(--pf-surface-raised)", color: "var(--pf-text-muted)" }}
                  >
                    {lead.source}
                  </span>
                  {lead.location && (
                    <span className="text-xs font-mono" style={{ color: "var(--pf-text-muted)" }}>
                      · {lead.location}
                    </span>
                  )}
                  {lead.pushedToVercelCrm && (
                    <span
                      className="font-mono text-[10px] px-1.5 py-0.5 rounded"
                      style={{ background: "var(--pf-primary-dim)", color: "var(--pf-primary)" }}
                    >
                      ✓ SalesOps Synced
                    </span>
                  )}
                </div>

                <div className="text-xs flex flex-wrap items-center gap-3" style={{ color: "var(--pf-text-muted)" }}>
                  <span>{lead.contact || "No contact yet"}</span>
                  {lead.email && (
                    <a href={`mailto:${lead.email}`} className="underline" style={{ color: "var(--pf-primary)" }}>
                      {lead.email}
                    </a>
                  )}
                  {lead.phone && <span className="font-mono">{lead.phone}</span>}
                  {lead.followUp && <span className="font-mono">Follow-up: {lead.followUp}</span>}
                </div>

                {(lead.evidence || lead.estimatedLanes) && (
                  <div className="text-xs leading-relaxed" style={{ color: "var(--pf-text-subtle)" }}>
                    {lead.estimatedLanes ? <strong style={{ color: "var(--pf-text-muted)" }}>{lead.estimatedLanes} — </strong> : null}
                    {lead.evidence}
                  </div>
                )}
              </div>

              {/* Actions + Stage Selector + Delete */}
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <select
                  value={lead.status}
                  onChange={(e) => onUpdateLead(lead.id, { status: e.target.value as CrmLeadStage })}
                  className="pf-input !w-auto font-semibold"
                  title="Update SalesOps stage"
                >
                  {STAGES.map((st) => (
                    <option key={st} value={st}>
                      {st}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  onClick={() => onBuildLoadFromLead(lead)}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1"
                  style={{ background: "var(--pf-primary-dim)", color: "var(--pf-primary)" }}
                  title="Send company/lane into Compact Load Builder"
                >
                  <Rocket size={12} /> Quote / Load
                </button>

                <button
                  type="button"
                  onClick={() => onPushLead(lead.id)}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-medium inline-flex items-center gap-1"
                  style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
                  title="Push lead webhook to SalesOps Vercel CRM"
                >
                  <Send size={12} /> Push CRM
                </button>

                <button
                  type="button"
                  onClick={() => setEditingLead(lead)}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-medium inline-flex items-center gap-1"
                  style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
                >
                  <Edit3 size={12} /> Edit
                </button>

                <button
                  type="button"
                  onClick={() => onDeleteLead(lead.id)}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1"
                  style={{
                    background: "var(--pf-danger-dim)",
                    color: "var(--pf-danger)",
                    border: "1px solid rgba(226,75,74,0.35)",
                  }}
                  title="Delete lead from SalesOps CRM"
                >
                  <Trash2 size={12} /> Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Inline Edit Lead Modal */}
      {editingLead && (
        <div
          onClick={() => setEditingLead(null)}
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              await onUpdateLead(editingLead.id, editingLead);
              setEditingLead(null);
            }}
            className="max-w-lg w-full p-5 rounded-2xl space-y-3 shadow-2xl"
            style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">Edit Lead · {editingLead.company}</h3>
              <button
                type="button"
                onClick={async () => {
                  const id = editingLead.id;
                  setEditingLead(null);
                  await onDeleteLead(id);
                }}
                className="px-2.5 py-1 rounded text-xs font-semibold inline-flex items-center gap-1"
                style={{ background: "var(--pf-danger-dim)", color: "var(--pf-danger)" }}
              >
                <Trash2 size={12} /> Delete Lead
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2.5 text-xs">
              <label>
                Stage
                <select
                  value={editingLead.status}
                  onChange={(e) => setEditingLead({ ...editingLead, status: e.target.value as CrmLeadStage })}
                  className="pf-input mt-1"
                >
                  {STAGES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Follow-up Date
                <input
                  type="date"
                  value={editingLead.followUp}
                  onChange={(e) => setEditingLead({ ...editingLead, followUp: e.target.value })}
                  className="pf-input mt-1 font-mono"
                />
              </label>
              <label>
                Contact Name
                <input
                  value={editingLead.contact}
                  onChange={(e) => setEditingLead({ ...editingLead, contact: e.target.value })}
                  className="pf-input mt-1"
                />
              </label>
              <label>
                Email
                <input
                  value={editingLead.email}
                  onChange={(e) => setEditingLead({ ...editingLead, email: e.target.value })}
                  className="pf-input mt-1"
                />
              </label>
              <label>
                Phone
                <input
                  value={editingLead.phone}
                  onChange={(e) => setEditingLead({ ...editingLead, phone: e.target.value })}
                  className="pf-input mt-1 font-mono"
                />
              </label>
              <label>
                Owner
                <input
                  value={editingLead.owner}
                  onChange={(e) => setEditingLead({ ...editingLead, owner: e.target.value })}
                  className="pf-input mt-1"
                />
              </label>
            </div>
            <label className="block text-xs">
              Shipping Evidence / Notes
              <textarea
                rows={3}
                value={editingLead.evidence}
                onChange={(e) => setEditingLead({ ...editingLead, evidence: e.target.value })}
                className="pf-input mt-1"
              />
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setEditingLead(null)}
                className="px-3 py-1.5 rounded-lg text-xs"
                style={{ background: "var(--pf-surface-raised)" }}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 rounded-lg text-xs font-bold"
                style={{ background: "var(--pf-primary)", color: "var(--pf-primary-fg)" }}
              >
                Save Changes
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
