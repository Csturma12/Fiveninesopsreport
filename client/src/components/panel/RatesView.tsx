import React, { useState } from "react";
import type { LoadEntry } from "@shared/load-entry";
import type { OpsShipment } from "@shared/tai-webhook-schema";
import { Calculator, FileSpreadsheet, PlusCircle, ShieldCheck } from "lucide-react";
import { lookupZipCityState } from "../../lib/zip-lookup";
import { panelFetchJson, type PanelApiContext } from "./panelApi";
import type { LaneRateEstimateResult, PanelViewId, QuoteDraftState } from "./panelTypes";

interface RatesViewProps {
  shipments: OpsShipment[];
  builderEntry: LoadEntry;
  onBuilderChange: (next: LoadEntry) => void;
  onSendToQuote: (patch: Partial<QuoteDraftState>) => void;
  onNavigate: (view: PanelViewId) => void;
  apiCtx?: PanelApiContext;
  onToast: (msg: string, kind?: "ok" | "error") => void;
}

function buildLocalFallbackEstimate(
  shipments: OpsShipment[],
  origin: string,
  destination: string,
  equipmentType: string,
): LaneRateEstimateResult {
  const oState = origin.trim().toUpperCase().match(/\b([A-Z]{2})\b/)?.[1] || "";
  const dState = destination.trim().toUpperCase().match(/\b([A-Z]{2})\b/)?.[1] || "";

  const matched = shipments.filter((s) => {
    const oOk = !oState || s.origin.toUpperCase().includes(oState);
    const dOk = !dState || s.dest.toUpperCase().includes(dState);
    return oOk && dOk && s.sell > 0;
  });

  const pool = matched.length > 0 ? matched : shipments.filter((s) => s.sell > 0);
  const sells = pool.map((s) => s.sell).sort((a, b) => a - b);
  const buys = pool.map((s) => (s.buy > 0 ? s.buy : Math.round(s.sell * 0.82)));
  const avgSell = sells.length > 0 ? Math.round(sells.reduce((a, b) => a + b, 0) / sells.length) : 2650;
  const avgBuy = buys.length > 0 ? Math.round(buys.reduce((a, b) => a + b, 0) / buys.length) : 2150;
  const estMiles =
    pool.find((s) => s.mileage > 0)?.mileage ||
    Math.max(250, Math.round(avgSell / (equipmentType.toLowerCase().includes("flat") ? 3.85 : 3.25)));

  return {
    ok: true,
    useDatLane: false,
    sampleSize: matched.length > 0 ? matched.length : pool.length,
    lowSell: sells[0] ? Math.round(sells[0] * 0.96) : Math.round(avgSell * 0.9),
    targetSell: avgSell,
    highSell: sells[sells.length - 1] ? Math.round(sells[sells.length - 1] * 1.06) : Math.round(avgSell * 1.12),
    targetBuy: avgBuy,
    estMiles,
    recentMatches: pool.slice(0, 5).map((s) => ({
      id: s.id,
      customer: s.customer,
      carrier: s.carrier || "Spot Carrier",
      origin: s.origin,
      dest: s.dest,
      equip: s.equip,
      sell: s.sell,
      buy: s.buy,
      shipDate: s.shipDate,
    })),
  };
}

function parseLocationInput(raw: string): { city: string; state: string; zipCode: string } {
  const trimmed = raw.trim();
  const zipMatch = trimmed.match(/\b(\d{5})\b/);
  if (zipMatch) {
    const known = lookupZipCityState(zipMatch[1]);
    if (known) return { city: known.city, state: known.state, zipCode: zipMatch[1] };
  }
  const stMatch = trimmed.toUpperCase().match(/\b([A-Z]{2})\b/);
  const cityPart = trimmed
    .replace(/\b\d{5}(-\d{4})?\b/g, "")
    .replace(/,\s*[A-Za-z]{2}\b/, "")
    .trim();
  return {
    city: cityPart || "Houston",
    state: stMatch?.[1] || "TX",
    zipCode: zipMatch?.[1] || "",
  };
}

export const RatesView: React.FC<RatesViewProps> = ({
  shipments,
  builderEntry,
  onBuilderChange,
  onSendToQuote,
  onNavigate,
  apiCtx,
  onToast,
}) => {
  const firstStop = builderEntry.stops[0];
  const lastStop = builderEntry.stops[builderEntry.stops.length - 1];

  const [origin, setOrigin] = useState(
    firstStop ? `${firstStop.city}, ${firstStop.state} ${firstStop.zipCode}`.trim() : "Beaver Falls, PA 15010",
  );
  const [destination, setDestination] = useState(
    lastStop ? `${lastStop.city}, ${lastStop.state} ${lastStop.zipCode}`.trim() : "Lithonia, GA 30058",
  );
  const [equipmentType, setEquipmentType] = useState(builderEntry.equipment.trailerType || "48 ft Flatbed | Tarp");
  const [weightLbs, setWeightLbs] = useState(
    builderEntry.items.reduce((sum, i) => sum + i.weightTotal, 0) || 40000,
  );
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<LaneRateEstimateResult | null>(() =>
    buildLocalFallbackEstimate(shipments, "Beaver Falls, PA 15010", "Lithonia, GA 30058", "48 ft Flatbed | Tarp"),
  );

  const runEstimate = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!origin.trim() || !destination.trim()) {
      onToast("Enter both Origin and Destination city/state or ZIP.", "error");
      return;
    }
    setLoading(true);
    try {
      const oParsed = parseLocationInput(origin);
      const dParsed = parseLocationInput(destination);
      const { ok, data } = await panelFetchJson<Partial<LaneRateEstimateResult> & { message?: string }>(
        "/api/rates/estimate",
        {
          method: "POST",
          body: JSON.stringify({
            origin,
            destination,
            originCity: oParsed.city,
            originState: oParsed.state,
            originZip: oParsed.zipCode,
            destCity: dParsed.city,
            destState: dParsed.state,
            destZip: dParsed.zipCode,
            equipment: equipmentType,
            trailerType: equipmentType,
            equipmentType,
            weightLbs,
            useDatLane: false,
          }),
        },
        apiCtx,
      );

      if (ok && typeof data.targetSell === "number") {
        setResult({
          ok: true,
          useDatLane: false,
          comparisonBasis: data.comparisonBasis,
          linehaulPerMile: typeof data.linehaulPerMile === "number" ? data.linehaulPerMile : undefined,
          allInPerMile: typeof data.allInPerMile === "number" ? data.allInPerMile : undefined,
          sampleSize: Number(data.sampleSize) || 0,
          lowSell: Number(data.lowSell) || 0,
          targetSell: Number(data.targetSell) || 0,
          highSell: Number(data.highSell) || 0,
          targetBuy: Number(data.targetBuy) || 0,
          estMiles: Number(data.estMiles) || 0,
          recentMatches: Array.isArray(data.recentMatches) ? data.recentMatches : [],
        });
      } else {
        setResult(buildLocalFallbackEstimate(shipments, origin, destination, equipmentType));
      }
    } catch {
      setResult(buildLocalFallbackEstimate(shipments, origin, destination, equipmentType));
    } finally {
      setLoading(false);
    }
  };

  const applyToQuoteBuilder = () => {
    if (!result) return;
    onSendToQuote({
      origin,
      destination,
      equipmentType,
      estMiles: result.estMiles,
      linehaulRate: result.targetSell,
      fuelSurcharge: 0,
    });
    onToast(`Sent $${result.targetSell.toLocaleString()} target lane rate to Formal Quote Builder`);
    onNavigate("quote-builder");
  };

  const applyToLoadBuilder = () => {
    if (!result) return;
    const oParsed = parseLocationInput(origin);
    const dParsed = parseLocationInput(destination);
    const nextStops = [...builderEntry.stops];
    if (nextStops[0]) {
      nextStops[0] = {
        ...nextStops[0],
        city: oParsed.city,
        state: oParsed.state,
        zipCode: oParsed.zipCode || nextStops[0].zipCode,
      };
    }
    if (nextStops.length >= 2) {
      const lastIdx = nextStops.length - 1;
      nextStops[lastIdx] = {
        ...nextStops[lastIdx],
        city: dParsed.city,
        state: dParsed.state,
        zipCode: dParsed.zipCode || nextStops[lastIdx].zipCode,
      };
    }
    onBuilderChange({
      ...builderEntry,
      stops: nextStops,
      equipment: {
        ...builderEntry.equipment,
        trailerType: equipmentType,
        mileage: result.estMiles || builderEntry.equipment.mileage,
      },
      pricing: {
        ...builderEntry.pricing,
        linehaulSell: result.targetSell,
        linehaulBuy: result.targetBuy,
      },
    });
    onToast(`Applied $${result.targetSell.toLocaleString()} sell / $${result.targetBuy.toLocaleString()} buy to Load Builder`);
    onNavigate("build-load");
  };

  return (
    <div className="space-y-2.5">
      {/* Mandatory Historical TAI Only Badge (useDatLane: false) */}
      <div
        className="px-2.5 py-1.5 rounded-lg flex items-center justify-between gap-2 text-[10px]"
        style={{
          background: "var(--pf-info-dim)",
          color: "var(--pf-info)",
          border: "1px solid rgba(107,143,191,0.4)",
        }}
      >
        <span className="font-semibold inline-flex items-center gap-1">
          <ShieldCheck size={12} /> Historical TAI Shipments Only
        </span>
        <span className="font-mono font-bold">useDatLane: false</span>
      </div>

      {/* Lane Estimator Form */}
      <form
        onSubmit={runEstimate}
        className="p-2.5 rounded-xl space-y-2"
        style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
      >
        <div className="grid grid-cols-2 gap-1.5">
          <div>
            <label className="block text-[10px] mb-0.5" style={{ color: "var(--pf-text-muted)" }}>
              Origin (City, ST or ZIP)
            </label>
            <input
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
              placeholder="e.g. Houston, TX 77015"
              className="pf-input text-[11px]"
            />
          </div>
          <div>
            <label className="block text-[10px] mb-0.5" style={{ color: "var(--pf-text-muted)" }}>
              Destination (City, ST or ZIP)
            </label>
            <input
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              placeholder="e.g. Tulsa, OK 74107"
              className="pf-input text-[11px]"
            />
          </div>
        </div>

        <div className="grid grid-cols-12 gap-1.5 items-end">
          <div className="col-span-7">
            <label className="block text-[10px] mb-0.5" style={{ color: "var(--pf-text-muted)" }}>
              Equipment
            </label>
            <select
              value={equipmentType}
              onChange={(e) => setEquipmentType(e.target.value)}
              className="pf-input text-[11px] font-medium"
            >
              <option value="48 ft Flatbed | Tarp">48 ft Flatbed | Tarp</option>
              <option value="48 ft Flatbed">48 ft Flatbed</option>
              <option value="53 ft Flatbed | Tarp">53 ft Flatbed | Tarp</option>
              <option value="53 ft Step Deck">53 ft Step Deck</option>
              <option value="53 ft Van | Dry">53 ft Van | Dry</option>
              <option value="53 ft Reefer">53 ft Reefer</option>
              <option value="48 ft Conestoga / Curtain Side">48 ft Conestoga</option>
              <option value="40 ft HotShot">40 ft HotShot</option>
            </select>
          </div>
          <div className="col-span-5">
            <label className="block text-[10px] mb-0.5" style={{ color: "var(--pf-text-muted)" }}>
              Weight (lbs)
            </label>
            <input
              type="number"
              value={weightLbs || ""}
              onChange={(e) => setWeightLbs(Number(e.target.value) || 0)}
              className="pf-input font-mono text-[11px]"
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full py-1.5 px-3 rounded-lg text-xs font-bold inline-flex items-center justify-center gap-1.5"
          style={{ background: "var(--pf-action)", color: "#ffffff" }}
        >
          <Calculator size={12} /> {loading ? "Calculating Historical Lane…" : "Estimate FTL Lane Pricing"}
        </button>
      </form>

      {/* Pricing Band Output */}
      {result && (
        <div
          className="p-2.5 rounded-xl space-y-2.5"
          style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
        >
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-semibold">
              Sample Size: <strong className="font-mono">{result.sampleSize}</strong> TAI loads
            </span>
            <span className="font-mono" style={{ color: "var(--pf-text-muted)" }}>
              Est. {result.estMiles.toLocaleString()} mi
              {result.linehaulPerMile
                ? ` · $${result.linehaulPerMile.toFixed(2)}/mi LH`
                : result.estMiles > 0
                ? ` · $${(result.targetSell / result.estMiles).toFixed(2)}/mi`
                : ""}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-1.5 text-center font-mono">
            <div className="p-2 rounded-lg" style={{ background: "var(--pf-surface-raised)" }}>
              <div className="text-[10px]" style={{ color: "var(--pf-text-muted)" }}>
                Low Sell
              </div>
              <div className="text-xs font-bold">${result.lowSell.toLocaleString()}</div>
            </div>
            <div
              className="p-2 rounded-lg"
              style={{ background: "var(--pf-primary-dim)", border: "1px solid var(--pf-primary)" }}
            >
              <div className="text-[10px]" style={{ color: "var(--pf-primary)" }}>
                Target Sell
              </div>
              <div className="text-sm font-bold" style={{ color: "var(--pf-primary)" }}>
                ${result.targetSell.toLocaleString()}
              </div>
            </div>
            <div className="p-2 rounded-lg" style={{ background: "var(--pf-surface-raised)" }}>
              <div className="text-[10px]" style={{ color: "var(--pf-text-muted)" }}>
                High Sell
              </div>
              <div className="text-xs font-bold">${result.highSell.toLocaleString()}</div>
            </div>
          </div>

          <div
            className="p-2 rounded-lg flex items-center justify-between text-xs font-mono"
            style={{ background: "var(--pf-surface-raised)" }}
          >
            <div>
              <span style={{ color: "var(--pf-text-muted)" }}>Target Buy: </span>
              <strong>${result.targetBuy.toLocaleString()}</strong>
            </div>
            <div style={{ color: "var(--pf-primary)" }}>
              Est. Margin: +${Math.max(0, result.targetSell - result.targetBuy).toLocaleString()}
            </div>
          </div>

          {/* 1-Click Send Actions */}
          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={applyToQuoteBuilder}
              className="py-1.5 px-2 rounded-lg text-[11px] font-bold inline-flex items-center justify-center gap-1"
              style={{ background: "var(--pf-primary)", color: "var(--pf-primary-fg)" }}
            >
              <FileSpreadsheet size={11} /> Send to Quote Builder
            </button>
            <button
              type="button"
              onClick={applyToLoadBuilder}
              className="py-1.5 px-2 rounded-lg text-[11px] font-bold inline-flex items-center justify-center gap-1"
              style={{ background: "var(--pf-action)", color: "#ffffff" }}
            >
              <PlusCircle size={11} /> Send to Load Builder
            </button>
          </div>

          {/* Historical Matches */}
          {result.recentMatches.length > 0 && (
            <div className="space-y-1 pt-1" style={{ borderTop: "1px dashed var(--pf-border)" }}>
              <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "var(--pf-text-muted)" }}>
                Recent Completed / Active TAI Comps
              </div>
              {result.recentMatches.map((m) => (
                <div
                  key={m.id}
                  className="p-1.5 rounded text-[10px] flex items-center justify-between gap-2"
                  style={{ background: "var(--pf-surface-raised)" }}
                >
                  <div className="min-w-0">
                    <div className="font-semibold truncate">
                      <span className="font-mono" style={{ color: "var(--pf-action)" }}>
                        #{m.id}
                      </span>{" "}
                      · {m.customer}
                    </div>
                    <div className="truncate" style={{ color: "var(--pf-text-muted)" }}>
                      {m.origin} → {m.dest} · {m.carrier || "Spot"}
                    </div>
                  </div>
                  <div className="font-mono text-right shrink-0">
                    <div className="font-bold">${m.sell.toLocaleString()}</div>
                    <div style={{ color: "var(--pf-text-subtle)" }}>${m.buy.toLocaleString()} buy</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
