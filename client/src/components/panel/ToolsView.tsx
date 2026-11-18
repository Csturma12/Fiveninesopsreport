import React, { useMemo, useState } from "react";
import type { LoadEntry } from "@shared/load-entry";
import { AlertTriangle, CheckCircle2, ExternalLink, FileSpreadsheet, FileText, Monitor, PlusCircle, Ruler } from "lucide-react";
import type { PanelViewId } from "./panelTypes";

interface ToolsViewProps {
  builderEntry: LoadEntry;
  onBuilderChange: (next: LoadEntry) => void;
  onNavigate: (view: PanelViewId) => void;
  onToast: (msg: string, kind?: "ok" | "error") => void;
}

type DeckTypeKey = "flatbed" | "step-deck" | "double-drop";

const DECK_SPECS: Record<
  DeckTypeKey,
  { label: string; defaultDeckInches: number; stdDeckLenFt: number; taiTrailer: string; tareLbs: number }
> = {
  flatbed: {
    label: "Flatbed (5'0\" Deck)",
    defaultDeckInches: 60,
    stdDeckLenFt: 48,
    taiTrailer: "48 ft Flatbed",
    tareLbs: 32000,
  },
  "step-deck": {
    label: "Step-Deck (3'4\" Lower)",
    defaultDeckInches: 40,
    stdDeckLenFt: 48,
    taiTrailer: "48 ft Step Deck",
    tareLbs: 34000,
  },
  "double-drop": {
    label: "Double-Drop / RGN (2'0\" Well)",
    defaultDeckInches: 24,
    stdDeckLenFt: 29,
    taiTrailer: "48 ft Double Drop",
    tareLbs: 38000,
  },
};

function fmtFeetInches(totalIn: number): string {
  const clean = Math.max(0, Math.round(totalIn));
  const ft = Math.floor(clean / 12);
  const inch = clean % 12;
  return `${ft}'${inch}" (${clean}")`;
}

export const ToolsView: React.FC<ToolsViewProps> = ({
  builderEntry,
  onBuilderChange,
  onNavigate,
  onToast,
}) => {
  const [deckType, setDeckType] = useState<DeckTypeKey>("flatbed");
  const [deckHeightIn, setDeckHeightIn] = useState<number>(60);
  const [cargoHeightIn, setCargoHeightIn] = useState<number>(96); // 8'0"
  const [cargoWidthIn, setCargoWidthIn] = useState<number>(96);  // 8'0"
  const [cargoLengthFt, setCargoLengthFt] = useState<number>(40);
  const [cargoWeightLbs, setCargoWeightLbs] = useState<number>(42000);
  const [showEmbeddedDash, setShowEmbeddedDash] = useState<boolean>(false);

  const handleDeckTypeChange = (next: DeckTypeKey) => {
    setDeckType(next);
    setDeckHeightIn(DECK_SPECS[next].defaultDeckInches);
  };

  const analysis = useMemo(() => {
    const spec = DECK_SPECS[deckType];
    const loadedHeightIn = deckHeightIn + cargoHeightIn;
    const legalHeightIn = 162; // 13'6" standard federal/eastern US legal height
    const legalWidthIn = 102;  // 8'6" standard legal width
    const grossWeightLbs = cargoWeightLbs + spec.tareLbs;
    const legalGrossLbs = 80000;

    const overHeight = loadedHeightIn > legalHeightIn;
    const overWidth = cargoWidthIn > legalWidthIn;
    const overLength =
      deckType === "double-drop" ? cargoLengthFt > spec.stdDeckLenFt : cargoLengthFt > 53;
    const needs53Ft = deckType !== "double-drop" && cargoLengthFt > 48 && cargoLengthFt <= 53;
    const overWeight = grossWeightLbs > legalGrossLbs;

    const flags: string[] = [];
    if (overHeight) {
      flags.push(
        `OVERSIZE HEIGHT PERMIT: Loaded ${fmtFeetInches(loadedHeightIn)} exceeds 13'6" (162") legal height${
          loadedHeightIn > 174 ? " — Pole Car / Route Survey likely (>14'6\")" : ""
        }.`,
      );
    }
    if (overWidth) {
      flags.push(
        `OVERSIZE WIDTH PERMIT: Cargo width ${fmtFeetInches(cargoWidthIn)} exceeds 8'6" (102") legal limit${
          cargoWidthIn > 144 ? " — Escort vehicle required (>12'0\")" : ""
        }.`,
      );
    }
    if (overLength) {
      flags.push(
        deckType === "double-drop"
          ? `WELL LENGTH CHECK: ${cargoLengthFt} ft exceeds standard 29 ft RGN well — stretch RGN / permit required.`
          : `OVERLENGTH PERMIT: ${cargoLengthFt} ft exceeds 53 ft trailer length.`,
      );
    }
    if (overWeight) {
      flags.push(
        `OVERWEIGHT PERMIT: Est. GVW ${grossWeightLbs.toLocaleString()} lbs (${cargoWeightLbs.toLocaleString()} cargo + ${spec.tareLbs.toLocaleString()} tare) exceeds 80,000 lbs legal gross.`,
      );
    }

    let recommendation = "Legal on selected trailer — zero oversize/overweight permits needed.";
    if (overHeight && deckType === "flatbed" && 40 + cargoHeightIn <= legalHeightIn) {
      recommendation = "Switch to Step-Deck (40\" deck) to bring loaded height under 13'6\" and avoid height permits!";
    } else if (overHeight && deckType !== "double-drop" && 24 + cargoHeightIn <= legalHeightIn) {
      recommendation = "Switch to Double-Drop / RGN (24\" well) to clear 13'6\" legally without height permits!";
    } else if (flags.length > 0) {
      recommendation = "Order state Oversize/Overweight permits & add Permit/Escort accessorials before dispatch.";
    }

    return {
      spec,
      loadedHeightIn,
      grossWeightLbs,
      overHeight,
      overWidth,
      overLength,
      needs53Ft,
      overWeight,
      isLegal: flags.length === 0,
      flags,
      recommendation,
    };
  }, [deckType, deckHeightIn, cargoHeightIn, cargoWidthIn, cargoLengthFt, cargoWeightLbs]);

  const applyToLoadBuilder = () => {
    const trailerType =
      analysis.needs53Ft && deckType === "flatbed"
        ? "53 ft Flatbed"
        : analysis.needs53Ft && deckType === "step-deck"
        ? "53 ft Step Deck"
        : analysis.spec.taiTrailer;

    const nextItems = [...builderEntry.items];
    if (nextItems[0]) {
      nextItems[0] = {
        ...nextItems[0],
        weightTotal: cargoWeightLbs,
        length: Math.round(cargoLengthFt * 12),
        width: cargoWidthIn,
        height: cargoHeightIn,
      };
    }

    const permitNote = analysis.isLegal
      ? `Dims Verified Legal (${cargoLengthFt}'L × ${cargoWidthIn}"W × ${cargoHeightIn}"H · Loaded ${fmtFeetInches(analysis.loadedHeightIn)})`
      : `PERMIT LOAD (${cargoLengthFt}'L × ${cargoWidthIn}"W × ${cargoHeightIn}"H · Est GVW ${analysis.grossWeightLbs.toLocaleString()} lbs)`;

    onBuilderChange({
      ...builderEntry,
      items: nextItems,
      equipment: {
        ...builderEntry.equipment,
        trailerType,
        equipmentLength: analysis.needs53Ft ? "53" : "48",
      },
      specialInstructions: builderEntry.specialInstructions
        ? `${builderEntry.specialInstructions} | ${permitNote}`
        : permitNote,
    });
    onToast(`Applied ${trailerType} + cargo dims/permit check to Load Builder`);
    onNavigate("build-load");
  };

  const handleDashboardClick = (e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      window.open("/", "_blank", "noopener,noreferrer");
      return;
    }
    setShowEmbeddedDash((v) => !v);
  };

  return (
    <div className="space-y-2.5">
      {/* Quick Document & Embedded Dashboard Launcher */}
      <div className="grid grid-cols-3 gap-1.5">
        <button
          type="button"
          onClick={() => onNavigate("tools-bol")}
          className="p-2 rounded-xl text-left space-y-0.5 hover:border-[#F0641E]"
          style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
        >
          <FileText size={13} style={{ color: "var(--pf-warning)" }} />
          <div className="text-[11px] font-semibold">BOL Generator</div>
        </button>

        <button
          type="button"
          onClick={() => onNavigate("quote-builder")}
          className="p-2 rounded-xl text-left space-y-0.5 hover:border-[#F0641E]"
          style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
        >
          <FileSpreadsheet size={13} style={{ color: "var(--pf-primary)" }} />
          <div className="text-[11px] font-semibold">Quote Builder</div>
        </button>

        <button
          type="button"
          onClick={handleDashboardClick}
          className="p-2 rounded-xl text-left space-y-0.5 hover:border-[#F0641E]"
          style={{
            background: showEmbeddedDash ? "var(--pf-info-dim)" : "var(--pf-surface)",
            border: `1px solid ${showEmbeddedDash ? "var(--pf-info)" : "var(--pf-border)"}`,
          }}
          title="Click to toggle embedded dashboard · Ctrl+Click opens full dashboard in a new browser tab"
        >
          <div className="flex items-center justify-between">
            <Monitor size={13} style={{ color: "var(--pf-info)" }} />
            <ExternalLink size={10} style={{ color: "var(--pf-text-muted)" }} />
          </div>
          <div className="text-[11px] font-semibold">Full Dashboard</div>
        </button>
      </div>

      {/* Embedded Full Dashboard Frame (Ctrl+click opens in new tab) */}
      {showEmbeddedDash && (
        <div
          className="rounded-xl overflow-hidden space-y-1 p-1.5"
          style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-info)" }}
        >
          <div className="flex items-center justify-between px-1.5 text-[10px]">
            <span className="font-semibold">Embedded Five Nines Operations Workspace</span>
            <a
              href="/"
              target="_blank"
              rel="noopener noreferrer"
              className="underline inline-flex items-center gap-0.5 font-semibold"
              style={{ color: "var(--pf-action)" }}
            >
              Open Full Tab <ExternalLink size={10} />
            </a>
          </div>
          <iframe
            src="/dispatch"
            title="Five Nines Full Dashboard"
            className="w-full h-72 rounded-lg border-0"
            style={{ background: "var(--pf-bg)" }}
          />
        </div>
      )}

      {/* Interactive Deck & Permit Calculator */}
      <div
        className="p-2.5 rounded-xl space-y-2.5"
        style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
      >
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold inline-flex items-center gap-1.5">
            <Ruler size={13} style={{ color: "var(--pf-action)" }} /> Deck &amp; Oversize / Overweight Permit Calculator
          </span>
          <span className="font-mono text-[10px]" style={{ color: "var(--pf-text-muted)" }}>
            13&apos;6&quot; H · 8&apos;6&quot; W · 80k GVW
          </span>
        </div>

        {/* Deck Selector */}
        <div className="grid grid-cols-3 gap-1">
          {(Object.keys(DECK_SPECS) as DeckTypeKey[]).map((key) => {
            const active = deckType === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => handleDeckTypeChange(key)}
                className="py-1.5 px-1.5 rounded-lg text-[10px] font-semibold text-center"
                style={{
                  background: active ? "var(--pf-action)" : "var(--pf-surface-raised)",
                  color: active ? "#ffffff" : "var(--pf-text-muted)",
                  border: `1px solid ${active ? "var(--pf-action)" : "var(--pf-border)"}`,
                }}
              >
                {DECK_SPECS[key].label}
              </button>
            );
          })}
        </div>

        {/* Inputs */}
        <div className="grid grid-cols-2 gap-1.5 text-[11px]">
          <div>
            <label className="block text-[10px] mb-0.5" style={{ color: "var(--pf-text-muted)" }}>
              Deck Height (in)
            </label>
            <input
              type="number"
              min={12}
              max={72}
              value={deckHeightIn}
              onChange={(e) => setDeckHeightIn(Number(e.target.value) || 0)}
              className="pf-input font-mono"
            />
          </div>
          <div>
            <label className="block text-[10px] mb-0.5" style={{ color: "var(--pf-text-muted)" }}>
              Cargo Height (in) · {fmtFeetInches(cargoHeightIn)}
            </label>
            <input
              type="number"
              min={1}
              value={cargoHeightIn}
              onChange={(e) => setCargoHeightIn(Number(e.target.value) || 0)}
              className="pf-input font-mono"
            />
          </div>
          <div>
            <label className="block text-[10px] mb-0.5" style={{ color: "var(--pf-text-muted)" }}>
              Cargo Width (in) · Legal ≤ 102&quot; (8&apos;6&quot;)
            </label>
            <input
              type="number"
              min={1}
              value={cargoWidthIn}
              onChange={(e) => setCargoWidthIn(Number(e.target.value) || 0)}
              className="pf-input font-mono"
            />
          </div>
          <div>
            <label className="block text-[10px] mb-0.5" style={{ color: "var(--pf-text-muted)" }}>
              Cargo Length (ft)
            </label>
            <input
              type="number"
              min={1}
              value={cargoLengthFt}
              onChange={(e) => setCargoLengthFt(Number(e.target.value) || 0)}
              className="pf-input font-mono"
            />
          </div>
          <div className="col-span-2">
            <label className="block text-[10px] mb-0.5" style={{ color: "var(--pf-text-muted)" }}>
              Cargo Weight (lbs) · +{analysis.spec.tareLbs.toLocaleString()} lbs Tare ={" "}
              <strong>{analysis.grossWeightLbs.toLocaleString()} lbs GVW</strong>
            </label>
            <input
              type="number"
              min={100}
              step={500}
              value={cargoWeightLbs}
              onChange={(e) => setCargoWeightLbs(Number(e.target.value) || 0)}
              className="pf-input font-mono"
            />
          </div>
        </div>

        {/* Live Legal / Permit Readout */}
        <div
          className="p-2.5 rounded-lg space-y-1.5 text-xs"
          style={{
            background: analysis.isLegal ? "var(--pf-primary-dim)" : "var(--pf-danger-dim)",
            color: analysis.isLegal ? "var(--pf-primary)" : "var(--pf-danger)",
            border: `1px solid ${analysis.isLegal ? "var(--pf-primary)" : "var(--pf-danger)"}`,
          }}
        >
          <div className="font-bold flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1">
              {analysis.isLegal ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
              {analysis.isLegal ? "LEGAL DIMENSIONS & WEIGHT" : `${analysis.flags.length} PERMIT FLAG(S) DETECTED`}
            </span>
            <span className="font-mono text-[11px]">Loaded H: {fmtFeetInches(analysis.loadedHeightIn)}</span>
          </div>

          {analysis.flags.map((flag, idx) => (
            <div key={idx} className="text-[11px] leading-snug">
              • {flag}
            </div>
          ))}

          <div className="text-[11px] pt-1 font-medium" style={{ color: "var(--pf-text)" }}>
            💡 {analysis.recommendation}
          </div>
        </div>

        <button
          type="button"
          onClick={applyToLoadBuilder}
          className="w-full py-1.5 px-3 rounded-lg text-xs font-bold inline-flex items-center justify-center gap-1.5"
          style={{ background: "var(--pf-action)", color: "#ffffff" }}
        >
          <PlusCircle size={12} /> Apply Trailer &amp; Dims to Load Builder
        </button>
      </div>
    </div>
  );
};
