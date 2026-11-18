import React, { useRef, useState } from "react";
import type { OpsShipment } from "@shared/tai-webhook-schema";
import { POD_FILE_ACCEPT, podMimeTypeForFile } from "../../lib/pod-file";
import { CheckCircle2, FileWarning, Search, Upload } from "lucide-react";

interface PodFilesViewProps {
  shipments: OpsShipment[];
  onUploadPod?: (shipmentId: string) => void;
  onRefresh: () => Promise<void>;
  onToast: (msg: string, kind?: "ok" | "error") => void;
  onInspectLoad: (shipmentId: string) => void;
}

export const PodFilesView: React.FC<PodFilesViewProps> = ({
  shipments,
  onUploadPod,
  onRefresh,
  onToast,
  onInspectLoad,
}) => {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"missing" | "verified" | "all">("missing");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const targetIdRef = useRef<string | null>(null);

  const triggerUpload = (shipmentId: string) => {
    if (onUploadPod) {
      onUploadPod(shipmentId);
      return;
    }
    targetIdRef.current = shipmentId;
    fileInputRef.current?.click();
  };

  const handleDirectUpload = async (shipmentId: string, file: File) => {
    const mime = podMimeTypeForFile(file);
    if (!mime) {
      onToast("Only PDF or JPEG POD files can be uploaded to TAI.", "error");
      return;
    }
    onToast(`Uploading ${file.name} to TAI for #${shipmentId}…`);
    const res = await fetch(
      `/api/loads/${encodeURIComponent(shipmentId)}/pod?fileName=${encodeURIComponent(file.name)}`,
      {
        method: "POST",
        headers: { "Content-Type": mime },
        body: file,
        credentials: "include",
      },
    );
    const out = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
    const verified = res.ok && out.ok === true;
    onToast(
      out.message || (verified ? `POD verified in TAI on #${shipmentId}` : `POD upload failed (HTTP ${res.status})`),
      verified ? "ok" : "error",
    );
    if (verified) await onRefresh();
  };

  const visible = shipments.filter((s) => {
    if (filter === "missing" && !(s.stage === "Delivered" && s.podCount === 0)) return false;
    if (filter === "verified" && s.podCount === 0) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return `${s.id} ${s.customer} ${s.carrier} ${s.po} ${s.origin} ${s.dest}`.toLowerCase().includes(q);
  });

  return (
    <div className="space-y-3">
      <input
        ref={fileInputRef}
        type="file"
        accept={POD_FILE_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          const id = targetIdRef.current;
          e.target.value = "";
          targetIdRef.current = null;
          if (f && id) void handleDirectUpload(id, f);
        }}
      />

      <div>
        <h1 className="text-lg font-bold tracking-tight">POD</h1>
        <p className="text-xs mt-0.5" style={{ color: "var(--pf-text-muted)" }}>
          Upload PDF or JPEG Proof of Delivery files — verified via live TAI read-back
        </p>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {(
          [
            ["missing", "Needs POD"],
            ["verified", "Verified in TAI"],
            ["all", "All Loads"],
          ] as const
        ).map(([id, label]) => {
          const active = filter === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setFilter(id)}
              className="px-3 py-1.5 rounded-full text-xs font-medium transition-colors"
              style={{
                background: active ? "rgba(56,201,118,0.14)" : "var(--pf-surface)",
                color: active ? "#38c976" : "var(--pf-text)",
                border: `1px solid ${active ? "rgba(56,201,118,0.45)" : "var(--pf-border)"}`,
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div
        className="flex items-center gap-2 px-3 py-2 rounded-xl"
        style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
      >
        <Search size={13} style={{ color: "var(--pf-text-muted)" }} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by load #, PO, customer, or carrier…"
          className="bg-transparent border-0 outline-none text-xs w-full"
          style={{ color: "var(--pf-text)" }}
        />
      </div>

      <div className="space-y-2">
        {visible.length === 0 ? (
          <div
            className="p-5 rounded-2xl text-center text-xs"
            style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)", color: "var(--pf-text-muted)" }}
          >
            No shipments match this POD filter.
          </div>
        ) : (
          visible.map((s) => (
            <div
              key={s.id}
              className="p-3.5 rounded-2xl flex items-center justify-between gap-3"
              style={{ background: "var(--pf-surface)", border: "1px solid var(--pf-border)" }}
            >
              <div className="min-w-0 space-y-1">
                <div className="text-xs font-semibold truncate">
                  {s.customer} · {s.origin.split(",")[0]} → {s.dest.split(",")[0]}{" "}
                  <span className="font-mono font-normal" style={{ color: "var(--pf-text-muted)" }}>
                    ({s.id})
                  </span>
                </div>
                <div className="text-[11px] flex items-center gap-2" style={{ color: "var(--pf-text-muted)" }}>
                  <span>{s.carrier || "Unassigned"}</span>
                  <span>·</span>
                  {s.podCount > 0 ? (
                    <span className="inline-flex items-center gap-1 font-medium" style={{ color: "#38c976" }}>
                      <CheckCircle2 size={11} /> {s.podCount} POD verified
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 font-medium" style={{ color: "var(--pf-warning)" }}>
                      <FileWarning size={11} /> Awaiting POD
                    </span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => triggerUpload(s.id)}
                  className="px-3 py-1.5 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5"
                  style={{ background: "#38c976", color: "#07130c" }}
                >
                  <Upload size={12} /> Upload
                </button>
                <button
                  type="button"
                  onClick={() => onInspectLoad(s.id)}
                  className="px-2.5 py-1.5 rounded-xl text-xs"
                  style={{ background: "var(--pf-surface-raised)", border: "1px solid var(--pf-border)" }}
                >
                  Open
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
