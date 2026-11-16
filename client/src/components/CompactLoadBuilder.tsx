import React, { useMemo, useState } from "react";
import {
  TAI_CREATE_PACKAGING_TYPES,
  TAI_CREATE_TRAILER_TYPES,
} from "@shared/tai-booking-enums";
import { QUICK_ACCESSORIALS, type AccessorialScope } from "@shared/accessorial-options";
import {
  buildTaiShipmentRequest,
  loadEntryTotals,
  validateTaiLoadEntry,
  type LoadEntry,
  type LoadEntryStop,
} from "@shared/load-entry";
import type { CarrierOption, CustomerOption, SavedFacility } from "@shared/tai-webhook-schema";
import { lookupZipCityState } from "../lib/zip-lookup";
import { ChevronDown, ChevronRight, FileText, MoreHorizontal, Plus, Rocket, Sparkles, X } from "lucide-react";

interface CompactLoadBuilderProps {
  compact?: boolean; // true inside the 420px Gmail Panel -> ultra-short zero-bloat layout!
  entry: LoadEntry;
  onChange: (next: LoadEntry) => void;
  facilities: SavedFacility[];
  customers: CustomerOption[];
  carriers: CarrierOption[];
  onBooked: (createdIds: string[], msg: string) => void;
  onToast: (msg: string) => void;
  onExtractSampleTender?: () => void;
}

const INSTRUCTION_CHIPS = [
  "4ft Tarps Required",
  "8ft Tarps Required",
  "Call 1 hr Prior",
  "MacroPoint Tracking",
  "Driver Assist",
  "No Touch Freight",
];

const COMMON_TRAILERS = [
  "48 ft Flatbed | Tarp",
  "48 ft Flatbed",
  "53 ft Flatbed | Tarp",
  "53 ft Flatbed",
  "53 ft Van | Dry",
  "48 ft Step Deck",
  "53 ft Step Deck",
  "53 ft Reefer",
  "40 ft HotShot",
  "Sprinter Van | Dry",
  "48 ft Conestoga / Curtain Side",
  "Power Only",
];

export const CompactLoadBuilder: React.FC<CompactLoadBuilderProps> = ({
  compact = false,
  entry,
  onChange,
  facilities,
  customers,
  carriers,
  onBooked,
  onToast,
  onExtractSampleTender,
}) => {
  const [expandedStopIdx, setExpandedStopIdx] = useState<number | null>(null);
  const [showExtras, setShowExtras] = useState<boolean>(false);
  const [showMoreMenu, setShowMoreMenu] = useState<boolean>(false);
  const [showJsonPreview, setShowJsonPreview] = useState<boolean>(false);
  const [showConfirmModal, setShowConfirmModal] = useState<boolean>(false);
  const [duplicateCount, setDuplicateCount] = useState<number>(1);
  const [submitting, setSubmitting] = useState<boolean>(false);

  const issues = useMemo(() => validateTaiLoadEntry(entry), [entry]);
  const totals = useMemo(() => loadEntryTotals(entry), [entry]);
  const taiRequestPreview = useMemo(() => buildTaiShipmentRequest(entry), [entry]);

  const updateStop = (idx: number, patch: Partial<LoadEntryStop>) => {
    const nextStops = entry.stops.map((s, i) => (i === idx ? { ...s, ...patch } : s));
    onChange({ ...entry, stops: nextStops });
  };

  const handleZipChange = (idx: number, zipVal: string) => {
    const hit = lookupZipCityState(zipVal);
    const savedHit = facilities.find((f) => f.zipCode === zipVal.trim());
    if (savedHit && !entry.stops[idx].companyName) {
      updateStop(idx, {
        zipCode: zipVal,
        companyName: savedHit.companyName,
        streetAddress: savedHit.streetAddress,
        city: savedHit.city,
        state: savedHit.state,
        contactName: savedHit.contactName,
        phone: savedHit.phone,
        savedFacilityMatched: true,
      });
      return;
    }
    updateStop(idx, {
      zipCode: zipVal,
      ...(hit ? { city: hit.city, state: hit.state } : {}),
    });
  };

  const applySavedFacility = (stopIdx: number, facId: string) => {
    const f = facilities.find((x) => x.id === facId);
    if (!f) return;
    updateStop(stopIdx, {
      companyName: f.companyName,
      streetAddress: f.streetAddress,
      city: f.city,
      state: f.state,
      zipCode: f.zipCode,
      contactName: f.contactName,
      phone: f.phone,
      savedFacilityMatched: true,
    });
    onToast(`Matched saved TAI location: ${f.companyName} (${f.zipCode})`);
  };

  const addStop = (kind: "Pick" | "Drop") => {
    const blank: LoadEntryStop = {
      stopType: kind,
      companyName: "",
      streetAddress: "",
      city: "",
      state: "",
      zipCode: "",
      country: "USA",
      contactName: "",
      phone: "",
      instructions: "",
      readyDate: entry.stops[entry.stops.length - 1]?.readyDate || "2026-11-17",
      timeOpen: "08:00",
      timeClose: "15:00",
      appointmentRequired: false,
    };
    const next = [...entry.stops];
    if (kind === "Pick") {
      next.splice(next.length - 1, 0, blank);
    } else {
      next[next.length - 1] = { ...next[next.length - 1], stopType: "Drop" };
      next.push({ ...blank, stopType: "Last Drop" });
    }
    onChange({ ...entry, stops: next });
  };

  const removeStop = (idx: number) => {
    if (entry.stops.length <= 2) return;
    const next = entry.stops.filter((_, i) => i !== idx);
    next[0] = { ...next[0], stopType: "First Pickup" };
    next[next.length - 1] = { ...next[next.length - 1], stopType: "Last Drop" };
    onChange({ ...entry, stops: next });
  };

  const updateItem = (idx: number, patch: Partial<LoadEntry["items"][number]>) => {
    const nextItems = entry.items.map((it, i) => (i === idx ? { ...it, ...patch } : it));
    onChange({ ...entry, items: nextItems });
  };

  const addItem = () => {
    onChange({
      ...entry,
      items: [
        ...entry.items,
        {
          description: "",
          packagingType: "Pallet",
          handlingQuantity: 1,
          piecesTotal: 1,
          weightTotal: 0,
          hazardousMaterial: false,
          freightClass: "No Class",
          referenceNumber: "",
        },
      ],
    });
  };

  const removeItem = (idx: number) => {
    if (entry.items.length <= 1) return;
    onChange({ ...entry, items: entry.items.filter((_, i) => i !== idx) });
  };

  const toggleAccessorial = (scope: AccessorialScope, name: string) => {
    const exists = entry.accessorials.some((a) => a.scope === scope && a.name === name);
    const nextAcc = exists
      ? entry.accessorials.filter((a) => !(a.scope === scope && a.name === name))
      : [...entry.accessorials, { scope, code: "CUSTOM", name, sell: 0, buy: 0 }];
    onChange({ ...entry, accessorials: nextAcc });
  };

  const requestTaiBookingConfirm = () => {
    if (issues.length > 0) {
      onToast(`Complete required TAI field: ${issues[0].message}`);
      return;
    }
    setShowConfirmModal(true);
  };

  const executeTaiBooking = async () => {
    setSubmitting(true);
    try {
      const res = await fetch("/api/loads/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry, duplicateCount }),
      });
      const data = await res.json();
      if (!data.ok) {
        onToast(data.message || "TAI validation blocked booking");
      } else {
        setShowConfirmModal(false);
        onBooked(data.createdIds, data.message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const trailerChoices = Array.from(new Set([...COMMON_TRAILERS, ...TAI_CREATE_TRAILER_TYPES]));

  return (
    <div className={compact ? "space-y-2.5" : "space-y-3.5"}>
      {/* 1. ULTRA-COMPACT TOP STATUS + EXTRACT BAR */}
      <div
        className="px-3 py-2 rounded-lg flex items-center justify-between gap-2 text-xs"
        style={{
          background: issues.length === 0 ? "var(--pf-primary-dim)" : "var(--pf-danger-dim)",
          color: issues.length === 0 ? "var(--pf-primary)" : "var(--pf-danger)",
          border: `1px solid ${issues.length === 0 ? "rgba(62,191,130,0.35)" : "rgba(226,75,74,0.4)"}`,
        }}
      >
        <div className="truncate font-semibold">
          {issues.length === 0
            ? `✓ TAI Ready · ${entry.stops.length} Stops · ${totals.totalPieces} pcs · ${totals.totalWeight.toLocaleString()} lbs`
            : `⚠ ${issues[0].message}${issues.length > 1 ? ` (+${issues.length - 1} more)` : ""}`}
        </div>
        {onExtractSampleTender && (
          <button
            type="button"
            onClick={onExtractSampleTender}
            className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded font-medium"
            style={{ background: "var(--pf-surface)", color: "var(--pf-text)", border: "1px solid var(--pf-border)" }}
          >
            <Sparkles size={11} /> Auto-Fill
          </button>
        )}
      </div>

      {/* 2. CUSTOMER (OPTIONAL TAI LINK) + PO / BOL IN ONE COMPACT BLOCK */}
      <div
        className="p-2.5 rounded-lg space-y-2"
        style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
      >
        <div className={`grid ${compact ? "grid-cols-12" : "grid-cols-12"} gap-2 items-end`}>
          <div className={compact ? "col-span-7" : "col-span-6"}>
            <div className="flex items-center justify-between mb-0.5">
              <label className="text-[11px] font-medium" style={{ color: "var(--pf-text-muted)" }}>
                Customer (TAI Link Optional)
              </label>
              <button
                type="button"
                onClick={() =>
                  onChange({
                    ...entry,
                    customer: {
                      ...entry.customer,
                      taiOrganizationId: entry.customer.taiOrganizationId ? "" : "698049",
                    },
                  })
                }
                className="font-mono text-[10px] px-1.5 py-0.2 rounded"
                style={{
                  background: entry.customer.taiOrganizationId ? "var(--pf-primary-dim)" : "var(--pf-surface-raised)",
                  color: entry.customer.taiOrganizationId ? "var(--pf-primary)" : "var(--pf-text-muted)",
                }}
                title="Toggle TAI Organization ID link (unlinked customers still register in TAI)"
              >
                {entry.customer.taiOrganizationId ? `#${entry.customer.taiOrganizationId}` : "Unlinked OK"}
              </button>
            </div>
            <input
              list="pf-customer-list"
              value={entry.customer.name}
              onChange={(e) => {
                const val = e.target.value;
                const match = customers.find((c) => c.name.toLowerCase() === val.toLowerCase());
                onChange({
                  ...entry,
                  customer: {
                    ...entry.customer,
                    name: val,
                    taiOrganizationId: match ? match.taiOrgId : entry.customer.taiOrganizationId,
                  },
                });
              }}
              placeholder="Customer name (optional)"
              className="pf-input font-medium"
            />
            <datalist id="pf-customer-list">
              {customers.map((c) => (
                <option key={c.name} value={c.name} />
              ))}
            </datalist>
          </div>

          <div className={compact ? "col-span-5" : "col-span-3"}>
            <label className="block text-[11px] mb-0.5" style={{ color: "var(--pf-text-muted)" }}>
              Customer PO #
            </label>
            <input
              value={entry.references.customerPO}
              onChange={(e) =>
                onChange({
                  ...entry,
                  references: { ...entry.references, customerPO: e.target.value, bolNumber: entry.references.bolNumber || e.target.value },
                })
              }
              placeholder="PO #"
              className="pf-input font-mono"
            />
          </div>

          {!compact && (
            <div className="col-span-3">
              <label className="block text-[11px] mb-0.5" style={{ color: "var(--pf-text-muted)" }}>
                BOL / Ref #
              </label>
              <input
                value={entry.references.bolNumber}
                onChange={(e) => onChange({ ...entry, references: { ...entry.references, bolNumber: e.target.value } })}
                placeholder="BOL #"
                className="pf-input font-mono"
              />
            </div>
          )}
        </div>
      </div>

      {/* 3. COMPACT STOPS & REQUIRED ZIPS (2-line inline rows — NO scroll wall!) */}
      <div
        className="p-2.5 rounded-lg space-y-2"
        style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
      >
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--pf-text-muted)" }}>
            Stops ({entry.stops.length}) · ZIP Required
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => addStop("Pick")}
              className="px-2 py-0.5 rounded text-[11px] font-medium"
              style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
            >
              + Pick
            </button>
            <button
              type="button"
              onClick={() => addStop("Drop")}
              className="px-2 py-0.5 rounded text-[11px] font-medium"
              style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
            >
              + Drop
            </button>
          </div>
        </div>

        <div className="space-y-1.5">
          {entry.stops.map((st, idx) => {
            const isPick = st.stopType.toLowerCase().includes("pick");
            const badgeText = idx === 0 ? "PU1" : idx === entry.stops.length - 1 ? "DEL" : isPick ? `PU${idx + 1}` : `DP${idx + 1}`;
            const isExpanded = expandedStopIdx === idx;
            const zipInvalid = !/^\d{5}(-\d{4})?$/.test(String(st.zipCode || "").trim());

            return (
              <div
                key={idx}
                className="p-2 rounded-md space-y-1.5"
                style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
              >
                {/* Row 1: Badge + Company + Saved Quick-Select + ZIP* */}
                <div className="flex items-center gap-1.5">
                  <span
                    className="px-1.5 py-0.5 rounded font-mono text-[10px] font-bold shrink-0"
                    style={{
                      background: isPick ? "var(--pf-info-dim)" : "var(--pf-primary-dim)",
                      color: isPick ? "var(--pf-info)" : "var(--pf-primary)",
                    }}
                  >
                    {badgeText}
                  </span>
                  <input
                    value={st.companyName}
                    onChange={(e) => updateStop(idx, { companyName: e.target.value })}
                    placeholder="Facility / Company *"
                    className={`pf-input flex-1 ${!st.companyName.trim() ? "pf-input-missing" : ""}`}
                  />
                  <input
                    value={st.zipCode}
                    onChange={(e) => handleZipChange(idx, e.target.value)}
                    placeholder="ZIP *"
                    maxLength={10}
                    className={`pf-input font-mono font-semibold !w-[68px] shrink-0 ${zipInvalid ? "pf-input-missing" : ""}`}
                    title="5-digit ZIP (auto-fills City & State)"
                  />
                  <button
                    type="button"
                    onClick={() => setExpandedStopIdx(isExpanded ? null : idx)}
                    className="p-1 rounded shrink-0"
                    style={{ color: "var(--pf-text-muted)" }}
                    title="Saved location, street address & contact"
                  >
                    <MoreHorizontal size={13} />
                  </button>
                  {entry.stops.length > 2 && (
                    <button
                      type="button"
                      onClick={() => removeStop(idx)}
                      className="p-0.5 rounded shrink-0"
                      style={{ color: "var(--pf-danger)" }}
                      title="Remove stop"
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>

                {/* Row 2: City + ST + Date + Window (Compact single strip) */}
                <div className="grid grid-cols-12 gap-1.5">
                  <input
                    value={st.city}
                    onChange={(e) => updateStop(idx, { city: e.target.value })}
                    placeholder="City *"
                    className={`pf-input col-span-5 ${!st.city.trim() ? "pf-input-missing" : ""}`}
                  />
                  <input
                    value={st.state}
                    maxLength={2}
                    onChange={(e) => updateStop(idx, { state: e.target.value.toUpperCase() })}
                    placeholder="ST"
                    className={`pf-input font-mono text-center col-span-2 ${!st.state.trim() ? "pf-input-missing" : ""}`}
                  />
                  <input
                    type="date"
                    value={st.readyDate}
                    onChange={(e) => updateStop(idx, { readyDate: e.target.value })}
                    className="pf-input font-mono col-span-5"
                  />
                </div>

                {/* Optional On-Demand Stop Drawer (Saved TAI Location, Street, Window, Contact) */}
                {isExpanded && (
                  <div className="pt-1.5 space-y-1.5" style={{ borderTop: "1px dashed var(--pf-border)" }}>
                    <select
                      value=""
                      onChange={(e) => e.target.value && applySavedFacility(idx, e.target.value)}
                      className="pf-input text-[11px]"
                    >
                      <option value="">⚡ Fill from Saved TAI Facility…</option>
                      {facilities.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                    <div className="grid grid-cols-2 gap-1.5">
                      <input
                        value={st.streetAddress}
                        onChange={(e) => updateStop(idx, { streetAddress: e.target.value })}
                        placeholder="Street address"
                        className="pf-input"
                      />
                      <div className="grid grid-cols-2 gap-1">
                        <input
                          value={st.timeOpen}
                          onChange={(e) => updateStop(idx, { timeOpen: e.target.value })}
                          placeholder="08:00"
                          className="pf-input font-mono"
                        />
                        <input
                          value={st.timeClose}
                          onChange={(e) => updateStop(idx, { timeClose: e.target.value })}
                          placeholder="15:00"
                          className="pf-input font-mono"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 4. ULTRA-COMPACT COMMODITIES (Piece Count + Pkg + Weight + Description in 1 single row!) */}
      <div
        className="p-2.5 rounded-lg space-y-1.5"
        style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
      >
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--pf-action)" }}>
            Commodities · Pcs, Lbs &amp; Desc *
          </span>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px]" style={{ color: "var(--pf-text-muted)" }}>
              {totals.totalPieces} pcs · {totals.totalWeight.toLocaleString()} lbs
            </span>
            <button
              type="button"
              onClick={addItem}
              className="px-1.5 py-0.5 rounded text-[11px] font-semibold inline-flex items-center gap-0.5"
              style={{ background: "var(--pf-primary-dim)", color: "var(--pf-primary)" }}
            >
              <Plus size={11} /> Line
            </button>
          </div>
        </div>

        <div className="space-y-1.5">
          {entry.items.map((it, idx) => (
            <div key={idx} className="flex items-center gap-1.5">
              <input
                type="number"
                min={1}
                value={it.piecesTotal || ""}
                onChange={(e) => {
                  const n = Number(e.target.value) || 0;
                  updateItem(idx, { piecesTotal: n, handlingQuantity: n });
                }}
                placeholder="Pcs*"
                title="Piece count (required by TAI)"
                className={`pf-input font-mono !w-[54px] shrink-0 ${it.piecesTotal <= 0 ? "pf-input-missing" : ""}`}
              />
              <select
                value={it.packagingType}
                onChange={(e) => updateItem(idx, { packagingType: e.target.value })}
                className="pf-input !w-[82px] shrink-0"
                title="TAI Packaging Type"
              >
                {TAI_CREATE_PACKAGING_TYPES.slice(0, 14).map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={1}
                value={it.weightTotal || ""}
                onChange={(e) => updateItem(idx, { weightTotal: Number(e.target.value) || 0 })}
                placeholder="Lbs *"
                title="Total Weight in lbs (required by TAI)"
                className={`pf-input font-mono !w-[76px] shrink-0 ${it.weightTotal <= 0 ? "pf-input-missing" : ""}`}
              />
              <input
                value={it.description}
                onChange={(e) => updateItem(idx, { description: e.target.value })}
                placeholder={`Description * (Line ${idx + 1})`}
                className={`pf-input flex-1 ${!it.description.trim() ? "pf-input-missing" : ""}`}
              />
              {entry.items.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeItem(idx)}
                  className="p-0.5 shrink-0"
                  style={{ color: "var(--pf-danger)" }}
                >
                  <X size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 5. EQUIPMENT + LIVE MARGIN CALCULATOR IN ONE COMPACT CARD */}
      <div
        className="p-2.5 rounded-lg space-y-2"
        style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
      >
        <div className="grid grid-cols-12 gap-1.5 items-end">
          <div className={compact ? "col-span-8" : "col-span-5"}>
            <label className="block text-[11px] mb-0.5" style={{ color: "var(--pf-text-muted)" }}>
              TAI Equipment *
            </label>
            <select
              value={entry.equipment.trailerType}
              onChange={(e) => onChange({ ...entry, equipment: { ...entry.equipment, trailerType: e.target.value } })}
              className="pf-input font-semibold"
            >
              {trailerChoices.map((eq) => (
                <option key={eq} value={eq}>
                  {eq}
                </option>
              ))}
            </select>
          </div>

          <div className={compact ? "col-span-4" : "col-span-2"}>
            <label className="block text-[11px] mb-0.5" style={{ color: "var(--pf-text-muted)" }}>
              Size
            </label>
            <select
              value={entry.equipment.trailerSize}
              onChange={(e) =>
                onChange({ ...entry, equipment: { ...entry.equipment, trailerSize: e.target.value as "Full" | "Partial" } })
              }
              className="pf-input"
            >
              <option value="Full">Full (FTL)</option>
              <option value="Partial">Partial</option>
            </select>
          </div>

          <div className={compact ? "col-span-4" : "col-span-2"}>
            <label className="block text-[11px] mb-0.5" style={{ color: "var(--pf-text-muted)" }}>
              Sell ($)
            </label>
            <input
              type="number"
              value={entry.pricing.linehaulSell || ""}
              onChange={(e) =>
                onChange({ ...entry, pricing: { ...entry.pricing, linehaulSell: Number(e.target.value) || 0 } })
              }
              className="pf-input font-mono font-bold"
            />
          </div>

          <div className={compact ? "col-span-4" : "col-span-2"}>
            <label className="block text-[11px] mb-0.5" style={{ color: "var(--pf-text-muted)" }}>
              Buy ($)
            </label>
            <input
              type="number"
              value={entry.pricing.linehaulBuy || ""}
              onChange={(e) =>
                onChange({ ...entry, pricing: { ...entry.pricing, linehaulBuy: Number(e.target.value) || 0 } })
              }
              className="pf-input font-mono font-bold"
            />
          </div>

          <div
            className={`${compact ? "col-span-4" : "col-span-1"} px-2 py-1.5 rounded text-right font-mono`}
            style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
          >
            <div className="text-[10px]" style={{ color: "var(--pf-text-muted)" }}>
              Margin ({totals.marginPct}%)
            </div>
            <div
              className="text-xs font-bold"
              style={{ color: totals.totalMargin >= 0 ? "var(--pf-primary)" : "var(--pf-danger)" }}
            >
              {totals.totalMargin >= 0 ? "+" : "-"}${Math.abs(Math.round(totals.totalMargin)).toLocaleString()}
            </div>
          </div>
        </div>

        {/* Collapsible Extras Toggle (keeps panel short by default!) */}
        <button
          type="button"
          onClick={() => setShowExtras(!showExtras)}
          className="w-full pt-1.5 flex items-center justify-between text-[11px] font-medium"
          style={{ borderTop: "1px solid var(--pf-border)", color: "var(--pf-text-muted)" }}
        >
          <span className="inline-flex items-center gap-1">
            {showExtras ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            Accessorials ({entry.accessorials.length}), Fuel Split, Lane Runners &amp; Instructions
          </span>
          <span className="font-mono text-[10px]">Optional</span>
        </button>

        {showExtras && (
          <div className="pt-2 space-y-2.5 text-xs" style={{ borderTop: "1px dashed var(--pf-border)" }}>
            {/* Fuel Split */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[11px] mb-0.5" style={{ color: "var(--pf-text-muted)" }}>
                  Fuel Surcharge Sell ($)
                </label>
                <input
                  type="number"
                  value={entry.pricing.fuelSell || ""}
                  onChange={(e) => onChange({ ...entry, pricing: { ...entry.pricing, fuelSell: Number(e.target.value) || 0 } })}
                  className="pf-input font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] mb-0.5" style={{ color: "var(--pf-text-muted)" }}>
                  Fuel Surcharge Buy ($)
                </label>
                <input
                  type="number"
                  value={entry.pricing.fuelBuy || ""}
                  onChange={(e) => onChange({ ...entry, pricing: { ...entry.pricing, fuelBuy: Number(e.target.value) || 0 } })}
                  className="pf-input font-mono"
                />
              </div>
            </div>

            {/* Quick Accessorials */}
            {(["pickup", "delivery", "shipment"] as AccessorialScope[]).map((scope) => (
              <div key={scope}>
                <div className="text-[10px] uppercase font-semibold mb-1" style={{ color: "var(--pf-text-subtle)" }}>
                  {scope} Accessorials
                </div>
                <div className="flex flex-wrap gap-1">
                  {QUICK_ACCESSORIALS[scope].map((acc) => {
                    const active = entry.accessorials.some((a) => a.scope === scope && a.name === acc);
                    return (
                      <button
                        key={acc}
                        type="button"
                        onClick={() => toggleAccessorial(scope, acc)}
                        className="px-2 py-0.5 rounded-full text-[11px]"
                        style={{
                          background: active ? "var(--pf-primary-dim)" : "var(--pf-surface-raised)",
                          color: active ? "var(--pf-primary)" : "var(--pf-text-muted)",
                          border: `1px solid ${active ? "var(--pf-primary)" : "var(--pf-border)"}`,
                        }}
                      >
                        {active ? "✓ " : "+ "}
                        {acc}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}

            {/* Special Instructions + Chips */}
            <div>
              <input
                value={entry.specialInstructions}
                onChange={(e) => onChange({ ...entry, specialInstructions: e.target.value })}
                placeholder="Special instructions (tarps, tracking, call prior…)"
                className="pf-input mb-1"
              />
              <div className="flex flex-wrap gap-1">
                {INSTRUCTION_CHIPS.map((ch) => (
                  <button
                    key={ch}
                    type="button"
                    onClick={() => {
                      if (!entry.specialInstructions.includes(ch)) {
                        onChange({
                          ...entry,
                          specialInstructions: entry.specialInstructions ? `${entry.specialInstructions} | ${ch}` : ch,
                        });
                      }
                    }}
                    className="px-2 py-0.5 rounded text-[10px]"
                    style={{ background: "var(--pf-surface-raised)", color: "var(--pf-text-muted)" }}
                  >
                    + {ch}
                  </button>
                ))}
              </div>
            </div>

            {/* Historical Lane Runners (1-click prefill!) */}
            <div>
              <div className="text-[10px] uppercase font-semibold mb-1" style={{ color: "var(--pf-text-subtle)" }}>
                Historical Lane Runners (Click to Prefill Carrier &amp; Buy)
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {carriers.slice(0, 2).map((c) => (
                  <button
                    key={c.name}
                    type="button"
                    onClick={() => {
                      onChange({
                        ...entry,
                        carrier: { name: c.name, scac: c.scac, mcNumber: c.mc, serviceLevel: "Normal" },
                        pricing: { ...entry.pricing, linehaulBuy: c.avgBuy || entry.pricing.linehaulBuy },
                      });
                      onToast(`Prefilled ${c.name} ($${(c.avgBuy || 2350).toLocaleString()} avg buy)`);
                    }}
                    className="p-1.5 rounded text-left text-[11px]"
                    style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
                  >
                    <div className="font-semibold truncate">{c.name}</div>
                    <div style={{ color: "var(--pf-text-muted)" }}>
                      {c.laneNote || `MC ${c.mc}`} {c.avgBuy ? `· $${c.avgBuy}` : ""}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 6. STICKY SINGLE-ROW ACTION BAR (Replaces 6 giant stacked buttons!) */}
      <div
        className="p-2 rounded-lg flex items-center justify-between gap-2 relative"
        style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
      >
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-[11px]" style={{ color: "var(--pf-text-muted)" }}>
            Qty
          </span>
          <input
            type="number"
            min={1}
            max={10}
            value={duplicateCount}
            onChange={(e) => setDuplicateCount(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
            className="pf-input font-mono font-bold text-center !w-[46px]"
            title="Duplicate to N orders (same lane, separate PO suffix)"
          />
        </div>

        <div className="flex items-center gap-1.5 flex-1 justify-end">
          <button
            type="button"
            disabled={submitting}
            onClick={requestTaiBookingConfirm}
            className="flex-1 max-w-[260px] py-2 px-3 rounded-lg text-xs font-bold inline-flex items-center justify-center gap-1.5 transition-opacity"
            style={{ background: "var(--pf-action)", color: "#ffffff" }}
          >
            <Rocket size={13} />
            {submitting ? "Booking…" : `Book in TAI${duplicateCount > 1 ? ` (×${duplicateCount})` : ""}`}
          </button>

          <button
            type="button"
            onClick={() => setShowMoreMenu(!showMoreMenu)}
            className="px-2.5 py-2 rounded-lg text-xs font-medium inline-flex items-center gap-1"
            style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
            title="BOL Only, Customer Quote, PDF RateCon & TAI API Preview"
          >
            <FileText size={13} />
            {!compact && <span>Docs &amp; JSON</span>}
          </button>
        </div>

        {showMoreMenu && (
          <div
            className="absolute right-2 bottom-12 w-56 rounded-lg p-1.5 shadow-xl z-20 space-y-1 text-xs"
            style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
          >
            <button
              type="button"
              onClick={() => {
                setShowMoreMenu(false);
                onToast(`Generated standalone BOL PDF (${entry.items.length} commodity lines) — no TAI booking sent.`);
              }}
              className="w-full text-left px-2.5 py-1.5 rounded hover:opacity-90"
              style={{ background: "var(--pf-surface)" }}
            >
              📋 Generate BOL Only
            </button>
            <button
              type="button"
              onClick={() => {
                setShowMoreMenu(false);
                onToast(`Generated Formal Customer Quote ($${totals.totalSell.toLocaleString()}) for ${entry.customer.name || "Customer"}.`);
              }}
              className="w-full text-left px-2.5 py-1.5 rounded hover:opacity-90"
              style={{ background: "var(--pf-surface)" }}
            >
              $ Formal Customer Quote
            </button>
            <button
              type="button"
              onClick={() => {
                setShowMoreMenu(false);
                onToast(`Generated PDF RateCon Sheet for PO #${entry.references.customerPO || "TBD"}.`);
              }}
              className="w-full text-left px-2.5 py-1.5 rounded hover:opacity-90"
              style={{ background: "var(--pf-surface)" }}
            >
              📄 PDF RateCon Sheet
            </button>
            <button
              type="button"
              onClick={() => {
                setShowMoreMenu(false);
                setShowJsonPreview(!showJsonPreview);
              }}
              className="w-full text-left px-2.5 py-1.5 rounded font-mono hover:opacity-90"
              style={{ background: "var(--pf-surface)", color: "var(--pf-primary)" }}
            >
              {showJsonPreview ? "Hide TAI JSON Payload" : "{ } View TAI API Payload"}
            </button>
          </div>
        )}
      </div>

      {showJsonPreview && (
        <pre
          className="p-3 rounded-lg text-[11px] font-mono overflow-x-auto max-h-56 pf-scroll"
          style={{ background: "#0b0e12", color: "#8ce6b8", border: "1px solid var(--pf-border)" }}
        >
          {JSON.stringify(taiRequestPreview, null, 2)}
        </pre>
      )}

      {showConfirmModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-3"
          style={{ background: "rgba(9, 12, 18, 0.78)" }}
          onClick={() => !submitting && setShowConfirmModal(false)}
        >
          <div
            className="w-full max-w-md rounded-xl p-4 space-y-3 shadow-2xl text-xs"
            style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)", color: "var(--pf-text)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2 pb-2" style={{ borderBottom: "1px solid var(--pf-border)" }}>
              <div>
                <div className="font-serif font-bold text-sm">Generate this load in TAI?</div>
                <div className="text-[11px]" style={{ color: "var(--pf-text-muted)" }}>
                  Verify stops, equipment &amp; commodity before sending to TAI
                  {duplicateCount > 1 ? ` (${duplicateCount} duplicate orders)` : ""}
                </div>
              </div>
              <button
                type="button"
                disabled={submitting}
                onClick={() => setShowConfirmModal(false)}
                className="p-1 rounded"
                style={{ color: "var(--pf-text-muted)" }}
              >
                <X size={14} />
              </button>
            </div>

            <div className="space-y-1.5 leading-relaxed">
              <div>
                <strong style={{ color: "var(--pf-text-muted)" }}>Customer:</strong>{" "}
                <span className="font-semibold">{entry.customer.name || "Unlinked Spot Customer"}</span>{" "}
                <span className="font-mono text-[11px]" style={{ color: "var(--pf-primary)" }}>
                  ({entry.customer.taiOrganizationId ? `TAI Org #${entry.customer.taiOrganizationId}` : "Unlinked OK"})
                </span>
              </div>

              {entry.stops.map((st, idx) => {
                const roleLabel =
                  idx === 0 ? "Pickup" : idx === entry.stops.length - 1 ? "Delivery" : `Stop ${idx + 1}`;
                return (
                  <div key={idx}>
                    <strong style={{ color: "var(--pf-text-muted)" }}>{roleLabel}:</strong>{" "}
                    <span>
                      {st.companyName} — {[st.streetAddress, st.city, st.state, st.zipCode].filter(Boolean).join(", ")}{" "}
                      <span className="font-mono text-[11px]" style={{ color: "var(--pf-text-subtle)" }}>
                        ({st.readyDate}T{st.timeOpen || "08:00"})
                      </span>
                    </span>
                  </div>
                );
              })}

              <div>
                <strong style={{ color: "var(--pf-text-muted)" }}>Equipment:</strong>{" "}
                <span className="font-semibold" style={{ color: "var(--pf-action)" }}>
                  {entry.equipment.trailerType}
                </span>{" "}
                · {totals.totalWeight.toLocaleString()} lbs ({entry.items[0]?.packagingType || "Pallet"})
                <div className="flex flex-wrap gap-1 mt-1">
                  {[
                    "48 ft Flatbed | Tarp",
                    "53 ft Flatbed | Tarp",
                    "53 ft Conestoga / Curtain Side",
                    "48 ft Flatbed",
                    "53 ft Van | Dry",
                  ].map((eqOption) => {
                    const active = entry.equipment.trailerType === eqOption;
                    return (
                      <button
                        key={eqOption}
                        type="button"
                        onClick={() =>
                          onChange({
                            ...entry,
                            equipment: { ...entry.equipment, trailerType: eqOption },
                          })
                        }
                        className="px-2 py-0.5 rounded text-[10px] font-medium"
                        style={{
                          background: active ? "var(--pf-action)" : "var(--pf-surface-raised)",
                          color: active ? "#ffffff" : "var(--pf-text-muted)",
                          border: `1px solid ${active ? "var(--pf-action)" : "var(--pf-border)"}`,
                        }}
                      >
                        {eqOption}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <strong style={{ color: "var(--pf-text-muted)" }}>Commodity:</strong>{" "}
                {entry.items.map((it) => `${it.piecesTotal} ${it.packagingType} — ${it.description}`).join("; ")}
              </div>

              {entry.specialInstructions && (
                <div>
                  <strong style={{ color: "var(--pf-text-muted)" }}>Instructions:</strong>{" "}
                  <span style={{ color: "var(--pf-warning)" }}>{entry.specialInstructions}</span>
                </div>
              )}

              <div>
                <strong style={{ color: "var(--pf-text-muted)" }}>Customer Rate:</strong>{" "}
                <span className="font-mono font-bold" style={{ color: totals.totalSell > 0 ? "var(--pf-primary)" : "var(--pf-text-muted)" }}>
                  {totals.totalSell > 0
                    ? `$${totals.totalSell.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                    : "Pending / TBD"}
                </span>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2" style={{ borderTop: "1px solid var(--pf-border)" }}>
              <button
                type="button"
                disabled={submitting}
                onClick={() => setShowConfirmModal(false)}
                className="px-3 py-1.5 rounded-lg font-medium"
                style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={executeTaiBooking}
                className="px-4 py-1.5 rounded-lg font-bold inline-flex items-center gap-1.5"
                style={{ background: "var(--pf-action)", color: "#ffffff" }}
              >
                <Rocket size={12} />
                {submitting ? "Sending to TAI…" : "OK · Generate in TAI"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
