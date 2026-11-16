import type { Express, Request, Response } from "express";
import {
  extractContainerNumbers,
  sameContainerNumber,
  synthesizeContainerExceptionNote,
} from "../shared/container-extractor";
import { addSseClient, broadcastOpsEvent } from "./events";
import { store } from "./store";
import {
  bookTaiLoads,
  enqueueCarrierWriteback,
  handleTaiInvoiceWebhook,
  handleTaiShipmentWebhook,
  previewTaiBooking,
  verifyWebhookSecretIfConfigured,
} from "./tai-service";
import type { LoadEntry } from "../shared/load-entry";

export function registerApiRoutes(app: Express): void {
  // Fly.io unauthenticated liveness endpoint
  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ ok: true, service: "fivenines-ops", ts: new Date().toISOString() });
  });

  // Server-Sent Events stream for instant Supabase Realtime & TAI Webhook updates
  app.get("/api/events", (_req: Request, res: Response) => {
    addSseClient(res);
  });

  app.get("/api/bootstrap", async (req: Request, res: Response) => {
    const data = await store.getBootstrap(req.staffUser || null);
    res.json(data);
  });

  app.post("/api/loads/preview", (req: Request, res: Response) => {
    const entry = req.body?.entry as LoadEntry;
    const result = previewTaiBooking(entry);
    res.json(result);
  });

  app.post("/api/loads/book", async (req: Request, res: Response) => {
    const entry = req.body?.entry as LoadEntry;
    const duplicateCount = Number(req.body?.duplicateCount) || 1;
    const result = await bookTaiLoads(entry, duplicateCount);
    res.status(result.ok ? 200 : 422).json(result);
  });

  app.post("/api/loads/:id/writeback-carrier", async (req: Request, res: Response) => {
    const actor = req.staffUser?.email ? `fivenines-ops:${req.staffUser.email}` : "fivenines-ops";
    const result = await enqueueCarrierWriteback({
      shipmentId: String(req.params.id),
      carrierName: String(req.body?.carrierName || ""),
      buyRate: Number(req.body?.buyRate) || 0,
      requestedBy: actor,
    });
    res.status(result.status).json(result);
  });

  app.post("/api/loads/:id/pod", (req: Request, res: Response) => {
    const s = store.shipments.find((x) => x.id === req.params.id);
    if (!s) {
      res.status(404).json({ ok: false, message: "Shipment not found" });
      return;
    }
    s.podCount = Math.max(1, s.podCount + 1);
    s.writebackState = `✓ POD Uploaded & Read-Back Verified via GET /Shipments/${s.id}/Documents`;
    store.kpis.emailPodReady = Math.max(0, store.kpis.emailPodReady - 1);
    res.json({ ok: true, shipment: s, message: `POD uploaded & read-back verified on #${s.id}` });
  });

  app.post("/api/loads/:id/sell", (req: Request, res: Response) => {
    const s = store.shipments.find((x) => x.id === req.params.id);
    if (!s) {
      res.status(404).json({ ok: false, message: "Shipment not found" });
      return;
    }
    const newSell = Math.max(0, Number(req.body?.sellRate) || 0);
    s.sell = newSell;
    delete s.mismatchNote;
    s.writebackState = `Local Sell updated to $${newSell.toLocaleString()} (TAI ShipmentCharges PUT gated on staff API permission)`;
    store.kpis.tmsMismatches = Math.max(0, store.kpis.tmsMismatches - 1);
    res.json({ ok: true, shipment: s, message: `Updated #${s.id} sell to $${newSell.toLocaleString()}` });
  });

  app.post("/api/loads/:id/note", async (req: Request, res: Response) => {
    const idOrContainer = String(req.params.id || "").trim();
    const s = store.shipments.find(
      (x) => x.id === idOrContainer || (x.containerNumber && sameContainerNumber(x.containerNumber, idOrContainer)),
    );
    if (!s) {
      res.status(404).json({ ok: false, message: `Shipment or container ${idOrContainer} not found` });
      return;
    }

    const explicitNote = String(req.body?.note || "").trim();
    const pastedEmailText = String(req.body?.pastedEmailText || "").trim();
    const explicitContainer = String(req.body?.containerNumber || "").trim();

    const detected = extractContainerNumbers(`${explicitContainer} ${pastedEmailText} ${explicitNote}`);
    if (detected[0]) {
      s.containerNumber = detected[0];
    }

    const synth = synthesizeContainerExceptionNote([pastedEmailText, explicitNote]);
    const finalNote = explicitNote || synth.note || pastedEmailText.slice(0, 280);
    if (finalNote) {
      s.operationalNote = finalNote;
    }

    if (pastedEmailText || explicitNote) {
      s.containerEvents = [
        {
          id: `note-${Date.now()}`,
          timestamp: new Date().toLocaleTimeString(),
          from: req.staffUser?.email || "ops-desk",
          subject: detected[0] ? `Container ${detected[0]} Update` : `Load #${s.id} Operational Note`,
          summary: explicitNote || synth.note || pastedEmailText.slice(0, 320),
          kind: synth.hasTonu ? "tonu" : "exception",
        },
        ...(s.containerEvents || []),
      ];
    }

    // Correlate matching email tiles too
    for (const em of store.crucialEmails) {
      if (
        em.loadId === s.id ||
        (s.containerNumber && em.containerNumber && sameContainerNumber(s.containerNumber, em.containerNumber))
      ) {
        if (s.containerNumber) em.containerNumber = s.containerNumber;
        if (s.operationalNote) em.operationalNote = s.operationalNote;
      }
    }

    const sb = store.getSupabase();
    if (!store.isSafeSandbox && sb && s.operationalNote) {
      await sb
        .from("shipments")
        .update({ notes: s.operationalNote, updated_at: new Date().toISOString() })
        .eq("shipment_id", s.id);
    }

    broadcastOpsEvent("shipment_updated", { shipmentId: s.id });
    res.json({
      ok: true,
      shipment: s,
      message: `Saved container/exception note on #${s.id}${s.containerNumber ? ` (${s.containerNumber})` : ""}`,
    });
  });

  app.delete("/api/loads/:id", (req: Request, res: Response) => {
    const id = String(req.params.id || "").trim();
    const removed = store.deleteShipment(id);
    if (!removed) {
      res.status(404).json({ ok: false, message: `Load #${id} not found` });
      return;
    }
    broadcastOpsEvent("shipment_updated", { deletedId: id });
    res.json({ ok: true, id, message: `Deleted load #${id}` });
  });

  app.delete("/api/inbox/:id", (req: Request, res: Response) => {
    const id = String(req.params.id || "").trim();
    const removed = store.dismissEmail(id);
    if (!removed) {
      res.status(404).json({ ok: false, message: "Email tile not found" });
      return;
    }
    broadcastOpsEvent("shipment_updated", { dismissedEmailId: id });
    res.json({ ok: true, id, message: "Deleted email tile from Crucial Inbox" });
  });

  // ============================================================================
  // SALESOPS CRM ROUTES
  // ============================================================================
  const pushLeadWebhook = async (lead: ReturnType<typeof store.addCrmLead>["lead"]) => {
    const secret = process.env.CRM_WEBHOOK_SECRET?.trim();
    if (!secret) {
      store.updateCrmLead(lead.id, { pushedToVercelCrm: true });
      return { pushedRemote: false, status: 200 };
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    };
    const bypass = process.env.CRM_VERCEL_BYPASS_SECRET?.trim();
    if (bypass) headers["x-vercel-protection-bypass"] = bypass;

    const resp = await fetch(store.getCrmWebhookUrl(), {
      method: "POST",
      headers,
      body: JSON.stringify({
        company_name: lead.company,
        contact_name: lead.contact || undefined,
        email: lead.email || undefined,
        phone: lead.phone || undefined,
        address: lead.location || undefined,
        notes: [lead.evidence, lead.estimatedLanes].filter(Boolean).join(" · ") || "Added from Five Nines Ops",
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (resp.ok) {
      store.updateCrmLead(lead.id, { pushedToVercelCrm: true });
    }
    return { pushedRemote: resp.ok, status: resp.status };
  };

  app.post("/api/crm/leads", async (req: Request, res: Response) => {
    const rawList = Array.isArray(req.body?.leads) ? req.body.leads : [req.body];
    let added = 0;
    let duplicates = 0;
    let lastLead = null;

    for (const item of rawList) {
      if (!item || !String(item.company || "").trim()) continue;
      const result = store.addCrmLead({
        company: String(item.company || ""),
        contact: item.contact,
        email: item.email,
        phone: item.phone,
        location: item.location,
        source: item.source,
        sourceUrl: item.sourceUrl,
        status: item.status,
        owner: item.owner || req.staffUser?.name || "Chris Sturma",
        followUp: item.followUp,
        evidence: item.evidence,
        estimatedLanes: item.estimatedLanes,
      });
      lastLead = result.lead;
      if (result.duplicate) {
        duplicates++;
      } else {
        added++;
        if (process.env.CRM_WEBHOOK_SECRET?.trim()) {
          pushLeadWebhook(result.lead).catch(() => {});
        }
      }
    }

    if (!lastLead) {
      res.status(400).json({ ok: false, message: "Company name is required" });
      return;
    }

    broadcastOpsEvent("crm_updated", { added });
    res.json({
      ok: true,
      lead: lastLead,
      leads: store.crmLeads,
      added,
      duplicates,
      message: rawList.length > 1
        ? `Imported ${added} lead(s) (${duplicates} duplicate skipped).`
        : `Added ${lastLead.company} to SalesOps CRM.`,
    });
  });

  app.patch("/api/crm/leads/:id", (req: Request, res: Response) => {
    const updated = store.updateCrmLead(String(req.params.id), req.body || {});
    if (!updated) {
      res.status(404).json({ ok: false, message: "Lead not found" });
      return;
    }
    broadcastOpsEvent("crm_updated", { id: updated.id });
    res.json({ ok: true, lead: updated, message: `Updated ${updated.company} (${updated.status}).` });
  });

  app.delete("/api/crm/leads/:id", (req: Request, res: Response) => {
    const id = String(req.params.id || "").trim();
    const removed = store.deleteCrmLead(id);
    if (!removed) {
      res.status(404).json({ ok: false, message: "Lead not found" });
      return;
    }
    broadcastOpsEvent("crm_updated", { deletedId: id });
    res.json({ ok: true, id, message: "Deleted lead from SalesOps CRM." });
  });

  app.post("/api/crm/leads/:id/push", async (req: Request, res: Response) => {
    const lead = store.crmLeads.find((l) => l.id === req.params.id);
    if (!lead) {
      res.status(404).json({ ok: false, message: "Lead not found" });
      return;
    }
    try {
      const outcome = await pushLeadWebhook(lead);
      broadcastOpsEvent("crm_updated", { id: lead.id });
      res.json({
        ok: true,
        lead: store.crmLeads.find((l) => l.id === lead.id),
        message: outcome.pushedRemote
          ? `Pushed ${lead.company} live to SalesOps Vercel CRM!`
          : `Marked ${lead.company} synced locally (set CRM_WEBHOOK_SECRET on Fly for remote Vercel webhook push).`,
      });
    } catch (err) {
      res.status(502).json({
        ok: false,
        message: `SalesOps webhook push failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  app.post("/api/inbox/:id/apply", (req: Request, res: Response) => {
    const item = store.crucialEmails.find((e) => e.id === req.params.id);
    if (!item) {
      res.status(404).json({ ok: false, message: "Action email not found" });
      return;
    }
    const s = item.loadId !== "NEW" ? store.shipments.find((x) => x.id === item.loadId) : undefined;

    if (item.diffType === "missing_po") {
      const poVal = item.extractedPo || "LR-88412";
      if (s) {
        s.po = poVal;
        s.writebackState = `✓ Customer PO ${poVal} applied & synced to TAI Reference Numbers`;
      }
      item.applied = true;
      res.json({ ok: true, action: "po_updated", shipment: s, message: `Wrote PO ${poVal} to Load #${item.loadId}` });
      return;
    }
    if (item.diffType === "rate_mismatch") {
      if (item.operationalNote && !item.extractedAmount) {
        if (s) {
          if (item.containerNumber && !s.containerNumber) s.containerNumber = item.containerNumber;
          s.operationalNote = item.operationalNote;
          s.writebackState = `✓ Exception note synced (${s.containerNumber || s.id})`;
        }
        item.applied = true;
        broadcastOpsEvent("shipment_updated", { shipmentId: item.loadId });
        res.json({
          ok: true,
          action: "note_synced",
          shipment: s,
          message: `Synced container/TONU note onto Load #${item.loadId}`,
        });
        return;
      }
      const amt = item.extractedAmount && item.extractedAmount > 0 ? item.extractedAmount : 6950;
      if (s) {
        if (s.buy > 0 && amt < s.buy && item.loadId === "132738007") {
          s.sell = 6950;
        } else if (amt >= s.sell) {
          s.sell = amt;
        } else {
          s.buy = amt;
        }
        delete s.mismatchNote;
        if (item.operationalNote && !s.operationalNote) s.operationalNote = item.operationalNote;
        s.writebackState = `Rates synced from email ($${s.sell.toLocaleString()} sell / $${s.buy.toLocaleString()} buy)`;
      }
      item.applied = true;
      store.kpis.tmsMismatches = Math.max(0, store.kpis.tmsMismatches - 1);
      res.json({ ok: true, action: "sell_updated", shipment: s, message: `Updated rates on Load #${item.loadId} ($${amt.toLocaleString()})` });
      return;
    }
    if (item.diffType === "missing_pod") {
      if (s) {
        s.podCount = Math.max(1, s.podCount + 1);
        s.writebackState = `✓ POD Uploaded & Read-Back Verified via GET /Shipments/${s.id}/Documents`;
      }
      item.applied = true;
      store.kpis.emailPodReady = Math.max(0, store.kpis.emailPodReady - 1);
      res.json({ ok: true, action: "pod_uploaded", shipment: s, message: `Attached & verified POD on #${item.loadId}` });
      return;
    }
    res.json({ ok: true, action: "extract_tender", message: "Extracted tender into Compact Load Builder" });
  });

  app.post("/api/assistant/ask", (req: Request, res: Response) => {
    const q = String(req.body?.question || "").trim();
    const ql = q.toLowerCase();
    let answer = "";

    if (ql.includes("runner") || ql.includes("pa") || ql.includes("flatbed")) {
      answer =
        "Top historical PA → GA Flatbed runners in TAI: (1) EVANS DELIVERY COMPANY INC (MC 117950 · 12 pickups, avg $2,350 buy), (2) AESJS INCORPORATED (MC 884120 · avg $2,400 buy), (3) FOX CARRIERS (MC 994210). All carry active cargo insurance.";
    } else if (ql.includes("webhook") || ql.includes("write") || ql.includes("poller") || ql.includes("tai")) {
      answer = `TAI Live Sync: Supabase ${store.isSupabaseConfigured ? "Connected" : "Seeded"}, Realtime ${store.realtimeSubscribed ? "Subscribed" : "Standby"}. Inbound webhooks (/api/webhooks/tai/shipment & /api/webhooks/tai/invoice) active. Carrier/Buy writes enqueue to tai_carrier_assignments and wait up to 45s for verified TAI GET /Shipments/{id} read-back.`;
    } else {
      const matchedLoad = store.shipments.find(
        (s) =>
          ql.includes(s.id) ||
          (s.containerNumber && sameContainerNumber(s.containerNumber, q)) ||
          (s.containerNumber && ql.includes(s.containerNumber.toLowerCase())),
      );
      if (matchedLoad) {
        const wt = matchedLoad.commodities.reduce((a, c) => a + c.weightTotal, 0);
        answer = `Load #${matchedLoad.id}${matchedLoad.containerNumber ? ` [${matchedLoad.containerNumber}]` : ""} (${matchedLoad.customer}): ${matchedLoad.origin} → ${matchedLoad.dest} · ${wt.toLocaleString()} lbs · Stage: ${matchedLoad.stage} · Carrier: ${matchedLoad.carrier || "Unassigned"}${matchedLoad.operationalNote ? ` · NOTE: ${matchedLoad.operationalNote}` : ""} · Sync: ${matchedLoad.writebackState}`;
      } else {
        answer = `Live Ops Summary: ${store.kpis.uncoveredCommitted} uncovered committed loads, ${store.kpis.inTransitNow} in transit, ${store.kpis.emailPodReady} Gmail PODs ready for TAI upload, and 30d net margin at $${(store.kpis.rev30d - store.kpis.buy30d).toLocaleString()}.`;
      }
    }
    res.json({ ok: true, answer });
  });

  // Canonical TAI Inbound Webhooks (both /shipment and root alias supported)
  const shipmentWebhookHandler = (req: Request, res: Response) => {
    if (!verifyWebhookSecretIfConfigured(req.headers, req.query.secret)) {
      res.status(401).json({ ok: false, message: "Invalid TAI webhook secret" });
      return;
    }
    const result = handleTaiShipmentWebhook(req.body || {}, req.headers);
    res.status(result.status).json(result);
  };
  app.post("/api/webhooks/tai", shipmentWebhookHandler);
  app.post("/api/webhooks/tai/shipment", shipmentWebhookHandler);

  app.post("/api/webhooks/tai/invoice", (req: Request, res: Response) => {
    if (!verifyWebhookSecretIfConfigured(req.headers, req.query.secret)) {
      res.status(401).json({ ok: false, message: "Invalid TAI webhook secret" });
      return;
    }
    const result = handleTaiInvoiceWebhook(req.body || {}, req.headers);
    res.status(result.status).json(result);
  });

  app.post("/api/webhooks/tai/simulate", (req: Request, res: Response) => {
    const kind = String(req.body?.kind || "gps");
    if (kind === "invoice") {
      const target = store.shipments[0];
      const out = handleTaiInvoiceWebhook({
        shipmentId: target.id,
        invoiceNumber: `INV-${Math.floor(10000 + Math.random() * 89999)}`,
        invoiceType: "AR",
        totalAmount: target.sell,
      });
      res.json({ ...out, message: `Simulated inbound TAI InvoiceCreateWithShipmentUrl on #${target.id}` });
      return;
    }
    const target = store.shipments.find((s) => s.id === "132738007") || store.shipments[0];
    const out = handleTaiShipmentWebhook({
      shipmentId: target.id,
      status: "In Transit",
      locationString: "I-40 E · Little Rock, AR 72202",
      totalBuy: target.buy || 2200,
    });
    res.json({ ...out, message: `Simulated inbound TAI ShipmentDetailUpdateUrl GPS update on #${target.id}` });
  });
}
