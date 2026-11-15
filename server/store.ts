import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import type {
  BootstrapPayload,
  CarrierOption,
  CrucialEmailItem,
  CustomerOption,
  OpsKpis,
  OpsShipment,
  SavedFacility,
  WebhookEventLog,
} from "../shared/tai-webhook-schema";
import { extractDateShort, mapTaiStatusToStage } from "../shared/tai-webhook-schema";
import { broadcastOpsEvent } from "./events";
import { pollerConfigStatus } from "./tai-writeback-poller";

// Polyfill WebSocket for @supabase/supabase-js Realtime in Node 22 containers
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = WebSocket;
}

const INITIAL_KPIS: OpsKpis = {
  totalShipments: 12466,
  loads30d: 690,
  rev30d: 2296801,
  buy30d: 1996507,
  pickedUp7d: 137,
  delivered7d: 119,
  uncoveredCommitted: 380,
  inTransitNow: 150,
  missingPodDelivered: 191,
  emailPodReady: 66,
  openApTasks: 110,
  tmsMismatches: 78,
  customersCount: 342,
  facilitiesCount: 415,
  carriersCount: 5003,
};

const SEEDED_FACILITIES: SavedFacility[] = [
  {
    id: "fac-1",
    label: "CeramSource, Inc. — Beaver Falls, PA 15010",
    companyName: "CeramSource, Inc.",
    streetAddress: "400 Enterprise Drive",
    city: "Beaver Falls",
    state: "PA",
    zipCode: "15010",
    contactName: "Dock Supervisor",
    phone: "(732) 257-5002",
  },
  {
    id: "fac-2",
    label: "Management & Consulting — Monongahela, PA 15063",
    companyName: "Management & Consulting",
    streetAddress: "626 Riverview Rd.",
    city: "Monongahela",
    state: "PA",
    zipCode: "15063",
    contactName: "Dean Smith",
    phone: "(724) 258-5500",
  },
  {
    id: "fac-3",
    label: "Larkin Refractory Solutions — Lithonia, GA 30058",
    companyName: "Larkin Refractory Solutions",
    streetAddress: "2331 Varkel Way",
    city: "Lithonia",
    state: "GA",
    zipCode: "30058",
    contactName: "Receiving",
    phone: "(678) 336-7090",
  },
  {
    id: "fac-4",
    label: "IMC Wilmington Yard — Wilmington, CA 90744",
    companyName: "IMC Wilmington Yard",
    streetAddress: "1304 E Lomita Blvd",
    city: "Wilmington",
    state: "CA",
    zipCode: "90744",
    contactName: "Edgar Tafoya",
    phone: "(424) 349-1113",
  },
  {
    id: "fac-5",
    label: "West Monroe Paper Mill — West Monroe, LA 71292",
    companyName: "West Monroe Paper Mill",
    streetAddress: "810 Downing Pines Rd",
    city: "West Monroe",
    state: "LA",
    zipCode: "71292",
    contactName: "Receiving Gate 2",
    phone: "(318) 362-2000",
  },
];

const SEEDED_CARRIERS: CarrierOption[] = [
  {
    name: "EVANS DELIVERY COMPANY INC",
    mc: "117950",
    dot: "120991",
    scac: "EVNS",
    taiMasterId: "18412",
    insuranceStatus: "Active · 2027-09",
    laneNote: "12x PA→GA Runner",
    avgBuy: 2350,
  },
  {
    name: "FOX CARRIERS",
    mc: "994210",
    dot: "3112098",
    scac: "FXCR",
    taiMasterId: "23905",
    insuranceStatus: "Active · 2027-06",
    laneNote: "SE Flatbed Specialist",
    avgBuy: 1950,
  },
  {
    name: "AESJS INCORPORATED",
    mc: "884120",
    dot: "2940112",
    scac: "AESJ",
    taiMasterId: "25190",
    insuranceStatus: "Active · 2027-05",
    laneNote: "PA→GA Runner",
    avgBuy: 2400,
  },
  {
    name: "TRUCKLINE SOLUTIONS INC",
    mc: "1388412",
    dot: "3801120",
    scac: "TRKL",
    taiMasterId: "27401",
    insuranceStatus: "Active · 2027-08",
  },
  {
    name: "ROXOR INC",
    mc: "1244890",
    dot: "3609112",
    scac: "ROXR",
    taiMasterId: "29102",
    insuranceStatus: "Active · 2027-05",
  },
  {
    name: "S&S TEAM LLC",
    mc: "1494051",
    dot: "3986183",
    scac: "SSTM",
    taiMasterId: "28890",
    insuranceStatus: "Active · 2027-03",
  },
];

const SEEDED_CUSTOMERS: CustomerOption[] = [
  { name: "LARKIN REFRACTORY SOLUTIONS", taiOrgId: "698049", city: "Lithonia", state: "GA" },
  { name: "IMC LOGISTICS", taiOrgId: "514220", city: "Collierville", state: "TN" },
  { name: "Odyssey Intermodal LLC", taiOrgId: "601884", city: "Joliet", state: "IL" },
  { name: "AXIS INDUSTRIES", taiOrgId: "641002", city: "Baton Rouge", state: "LA" },
  { name: "WALK-IN / UNLINKED SPOT CUSTOMER", taiOrgId: "", city: "Any", state: "US" },
];

const SEEDED_SHIPMENTS: OpsShipment[] = [
  {
    id: "132742212",
    customer: "LARKIN REFRACTORY SOLUTIONS",
    taiOrgId: "698049",
    origin: "Lithonia, GA 30058",
    dest: "West Monroe, LA 71292",
    stops: [
      {
        stopType: "First Pickup",
        companyName: "Larkin Refractory Solutions",
        streetAddress: "2331 Varkel Way",
        city: "Lithonia",
        state: "GA",
        zipCode: "30058",
        country: "USA",
        contactName: "Receiving",
        phone: "(678) 336-7090",
        instructions: "8ft Tarps Required",
        readyDate: "2026-11-16",
        timeOpen: "08:00",
        timeClose: "15:00",
        appointmentRequired: false,
        savedFacilityMatched: true,
      },
      {
        stopType: "Last Drop",
        companyName: "West Monroe Paper Mill",
        streetAddress: "810 Downing Pines Rd",
        city: "West Monroe",
        state: "LA",
        zipCode: "71292",
        country: "USA",
        contactName: "Gate 2",
        phone: "(318) 362-2000",
        instructions: "Call 1 hr prior",
        readyDate: "2026-11-17",
        timeOpen: "07:00",
        timeClose: "15:00",
        appointmentRequired: true,
        savedFacilityMatched: true,
      },
    ],
    commodities: [
      {
        description: "Refractory Firebrick & Alumina Castables",
        packagingType: "Pallet",
        handlingQuantity: 18,
        piecesTotal: 18,
        weightTotal: 35404,
        hazardousMaterial: false,
        freightClass: "No Class",
        referenceNumber: "BOL-42212",
      },
    ],
    accessorials: ["Tarp Fee - Pickup", "Appointment - Delivery"],
    stage: "Needs truck",
    rawStatus: "Committed",
    carrier: "",
    mc: "",
    po: "",
    bol: "BOL-42212",
    pro: "",
    shipDate: "Nov 16",
    delivDate: "Nov 17",
    equip: "53 ft Flatbed | Tarp",
    trailerSize: "Full",
    mileage: 562,
    sell: 2450,
    buy: 0,
    podCount: 0,
    emailPodAvailable: false,
    rateconStatus: "Not Sent",
    writebackState: "Idle (Awaiting carrier assignment)",
    location: "Lithonia, GA 30058 · Needs carrier",
  },
  {
    id: "132738007",
    customer: "IMC LOGISTICS",
    taiOrgId: "514220",
    origin: "Wilmington, CA 90744",
    dest: "Memphis, TN 38141",
    stops: [
      {
        stopType: "First Pickup",
        companyName: "IMC Wilmington Yard",
        streetAddress: "1304 E Lomita Blvd",
        city: "Wilmington",
        state: "CA",
        zipCode: "90744",
        country: "USA",
        contactName: "Edgar Tafoya",
        phone: "(424) 349-1113",
        instructions: "",
        readyDate: "2026-11-13",
        timeOpen: "07:00",
        timeClose: "16:00",
        appointmentRequired: false,
        savedFacilityMatched: true,
      },
      {
        stopType: "Last Drop",
        companyName: "IMC Memphis Depot",
        streetAddress: "5707 E Holmes Rd",
        city: "Memphis",
        state: "TN",
        zipCode: "38141",
        country: "USA",
        contactName: "Dispatch",
        phone: "(901) 555-0140",
        instructions: "",
        readyDate: "2026-11-16",
        timeOpen: "08:00",
        timeClose: "17:00",
        appointmentRequired: false,
      },
    ],
    commodities: [
      {
        description: "Containerized General Merchandise (CAIU9456544)",
        packagingType: "Container",
        handlingQuantity: 1,
        piecesTotal: 420,
        weightTotal: 40000,
        hazardousMaterial: false,
        freightClass: "No Class",
        referenceNumber: "DO 95-505344",
      },
    ],
    accessorials: ["Tracking Fee - Shipment"],
    stage: "In transit",
    rawStatus: "In Transit",
    carrier: "ROXOR INC",
    mc: "1244890",
    po: "CAIU9456544",
    bol: "95-505344",
    pro: "RX-8812",
    shipDate: "Nov 13",
    delivDate: "Nov 16",
    equip: "48 ft Step Deck",
    trailerSize: "Full",
    mileage: 1804,
    sell: 4400,
    buy: 6500,
    podCount: 0,
    emailPodAvailable: false,
    rateconStatus: "Sent",
    writebackState: "Verified in TAI (Carrier #29102 · $6,500 Buy)",
    location: "Gateway Blvd, El Paso, TX 79927 (Webhook GPS 18m ago)",
    mismatchNote: "TMS Buy ($6,500) exceeds DO Sell ($4,400) by -$2,100",
  },
  {
    id: "132729887",
    customer: "IMC LOGISTICS",
    taiOrgId: "514220",
    origin: "Newark, NJ 07114",
    dest: "Los Angeles, CA 90744",
    stops: [
      {
        stopType: "First Pickup",
        companyName: "Port Newark Terminal",
        streetAddress: "260 Kellogg St",
        city: "Newark",
        state: "NJ",
        zipCode: "07114",
        country: "USA",
        contactName: "Port Gate",
        phone: "(973) 555-0192",
        instructions: "TWIC Required",
        readyDate: "2026-11-13",
        timeOpen: "08:00",
        timeClose: "16:00",
        appointmentRequired: true,
      },
      {
        stopType: "Last Drop",
        companyName: "IMC Los Angeles",
        streetAddress: "1304 E Lomita Blvd",
        city: "Los Angeles",
        state: "CA",
        zipCode: "90744",
        country: "USA",
        contactName: "Edgar Tafoya",
        phone: "(424) 349-1113",
        instructions: "",
        readyDate: "2026-11-17",
        timeOpen: "07:00",
        timeClose: "15:00",
        appointmentRequired: false,
      },
    ],
    commodities: [
      {
        description: "Imported Retail Goods — JXLU4452164",
        packagingType: "Pallet",
        handlingQuantity: 22,
        piecesTotal: 440,
        weightTotal: 35000,
        hazardousMaterial: false,
        freightClass: "No Class",
        referenceNumber: "JXLU4452164",
      },
    ],
    accessorials: ["Team Transit - Pickup", "Appointment - Delivery"],
    stage: "In transit",
    rawStatus: "Out for Delivery",
    carrier: "TRUCKLINE SOLUTIONS INC",
    mc: "1388412",
    po: "JXLU4452164",
    bol: "BL-99201",
    pro: "TL-4402",
    shipDate: "Nov 13",
    delivDate: "Nov 17",
    equip: "48 ft Step Deck",
    trailerSize: "Full",
    mileage: 2779,
    sell: 9000,
    buy: 8000,
    podCount: 0,
    emailPodAvailable: false,
    rateconStatus: "Sent",
    writebackState: "Verified in TAI (Carrier #27401 · $8,000 Buy)",
    location: "1304 E Lomita Blvd, Los Angeles, CA 90744 (At consignee)",
  },
  {
    id: "132647845",
    customer: "AXIS INDUSTRIES",
    taiOrgId: "641002",
    origin: "Ethel, LA 70730",
    dest: "Phoenix, AZ 85043",
    stops: [
      {
        stopType: "First Pickup",
        companyName: "Axis Ethel Yard",
        streetAddress: "4810 Hwy 19",
        city: "Ethel",
        state: "LA",
        zipCode: "70730",
        country: "USA",
        contactName: "Yard Boss",
        phone: "(225) 555-0181",
        instructions: "",
        readyDate: "2026-11-10",
        timeOpen: "08:00",
        timeClose: "15:00",
        appointmentRequired: false,
      },
      {
        stopType: "Last Drop",
        companyName: "Phoenix Industrial",
        streetAddress: "5100 W Buckeye Rd",
        city: "Phoenix",
        state: "AZ",
        zipCode: "85043",
        country: "USA",
        contactName: "Receiving",
        phone: "(602) 555-0114",
        instructions: "",
        readyDate: "2026-11-13",
        timeOpen: "07:00",
        timeClose: "14:00",
        appointmentRequired: false,
      },
    ],
    commodities: [
      {
        description: "Industrial Pipe & Refractory Anchors",
        packagingType: "Bundle",
        handlingQuantity: 12,
        piecesTotal: 144,
        weightTotal: 42000,
        hazardousMaterial: false,
        freightClass: "No Class",
        referenceNumber: "AX-9921",
      },
    ],
    accessorials: [],
    stage: "Delivered",
    rawStatus: "Delivered",
    carrier: "FOX CARRIERS",
    mc: "994210",
    po: "AX-9921",
    bol: "AX-1094",
    pro: "FX-7812",
    shipDate: "Nov 10",
    delivDate: "Nov 13",
    equip: "48 ft Flatbed",
    trailerSize: "Full",
    mileage: 1245,
    sell: 2450,
    buy: 1900,
    podCount: 0,
    emailPodAvailable: true,
    rateconStatus: "Sent",
    writebackState: "Delivered · Signed POD PDF ready in Gmail for TAI upload",
    location: "Delivered Nov 13 · Missing POD in TAI",
  },
];

const SEEDED_EMAILS: CrucialEmailItem[] = [
  {
    id: "em-tender-42705",
    category: "tenders",
    subject: "NEW 2-PICK TENDER: Beaver Falls PA + Monongahela PA → Lithonia GA (#42705)",
    from: "shipping@larkinrefractory.com",
    received: "12m ago",
    loadId: "NEW",
    diffType: "new_tender",
    diffLabel: "Unbooked Multi-Stop Tender · 22 Pallets · 38,644 lbs",
    diffValue: "PA (2 Picks) → Lithonia, GA 30058",
    ctaLabel: "Extract to Compact Builder",
    body: "Please book PO #42705: Pick 1 CeramSource, 400 Enterprise Dr, Beaver Falls PA 15010 (6 pallets, 6,644 lbs ceramic fiber blankets) + Pick 2 Management & Consulting, 626 Riverview Rd, Monongahela PA 15063 (16 pallets, 32,000 lbs alumina castables) → Drop Larkin Refractory, 2331 Varkel Way, Lithonia GA 30058. 48 ft Flatbed | Tarp, 8ft tarps required, MacroPoint.",
  },
  {
    id: "em-po-132742212",
    category: "diffs",
    subject: "RE: Larkin Refractory — Lithonia pickup PO #LR-88412",
    from: "ops@larkinrefractory.com",
    received: "24m ago",
    loadId: "132742212",
    diffType: "missing_po",
    diffLabel: "Load #132742212 missing Customer PO in TAI",
    diffValue: "→ PO: LR-88412",
    ctaLabel: "Write PO to TAI References",
    body: "Team — please add Customer PO #LR-88412 to Load #132742212 (Lithonia, GA 30058 → West Monroe, LA 71292).",
  },
  {
    id: "em-rate-132738007",
    category: "diffs",
    subject: "Rate Alert · #132738007 Container CAIU9456544 Buy Exceeds Sell",
    from: "dispatch@roxortrans.com",
    received: "41m ago",
    loadId: "132738007",
    diffType: "rate_mismatch",
    diffLabel: "TMS Buy ($6,500) > DO Sell ($4,400)",
    diffValue: "-$2,100 Margin Alert",
    ctaLabel: "Revise Sell to $6,950",
    body: "Verified Roxor carrier rate is $6,500 while DO 95-505344 still reflects $4,400 sell.",
  },
  {
    id: "em-pod-132647845",
    category: "pod",
    subject: "Signed POD Attached · #132647845 (Axis Industries)",
    from: "freightap@primarycompanies.com",
    received: "1h ago",
    loadId: "132647845",
    diffType: "missing_pod",
    diffLabel: "Signed POD PDF in Gmail · 0 PODs in TAI",
    diffValue: "POD_132647845_signed.pdf",
    ctaLabel: "Upload POD & Verify Read-Back",
    body: "Fox Carriers submitted signed POD for Ethel, LA → Phoenix, AZ (#132647845). Ready for TAI upload + read-back check.",
  },
];

function mapSupabaseShipmentRow(r: Record<string, unknown>, existing?: OpsShipment): OpsShipment {
  const id = String(r.shipment_id || existing?.id || "");
  const fromCity = String(r.from_city || existing?.stops[0]?.city || "");
  const fromState = String(r.from_state || existing?.stops[0]?.state || "");
  const toCity = String(r.to_city || existing?.stops[existing.stops.length - 1]?.city || "");
  const toState = String(r.to_state || existing?.stops[existing.stops.length - 1]?.state || "");
  const wt = Number(r.total_weight) || existing?.commodities[0]?.weightTotal || 35000;
  const rawStatus = String(r.tai_raw_status || r.status || existing?.rawStatus || "Committed");
  const carrier = String(r.carrier_name ?? existing?.carrier ?? "");
  const podCount = Number(r.pod_document_count ?? existing?.podCount ?? 0);

  return {
    id,
    customer: String(r.customer_name || existing?.customer || "Customer"),
    taiOrgId: r.customer_tai_organization_id ? String(r.customer_tai_organization_id) : existing?.taiOrgId,
    origin: `${fromCity}, ${fromState}`.replace(/^,\s*/, "") || existing?.origin || "Origin",
    dest: `${toCity}, ${toState}`.replace(/^,\s*/, "") || existing?.dest || "Destination",
    stops: existing?.stops || [
      {
        stopType: "First Pickup",
        companyName: String(r.customer_name || "Shipper"),
        streetAddress: "",
        city: fromCity,
        state: fromState,
        zipCode: "00000",
        country: "USA",
        contactName: "",
        phone: "",
        instructions: "",
        readyDate: String(r.ship_date || "2026-11-16").slice(0, 10),
        timeOpen: "08:00",
        timeClose: "15:00",
        appointmentRequired: false,
      },
      {
        stopType: "Last Drop",
        companyName: "Consignee",
        streetAddress: "",
        city: toCity,
        state: toState,
        zipCode: "00000",
        country: "USA",
        contactName: "",
        phone: "",
        instructions: "",
        readyDate: String(r.delivery_date || "2026-11-17").slice(0, 10),
        timeOpen: "09:00",
        timeClose: "16:00",
        appointmentRequired: false,
      },
    ],
    commodities: existing?.commodities || [
      {
        description: "General Freight",
        packagingType: "Pallet",
        handlingQuantity: 1,
        piecesTotal: 1,
        weightTotal: wt,
        hazardousMaterial: false,
        freightClass: "No Class",
        referenceNumber: String(r.customer_po || ""),
      },
    ],
    accessorials: existing?.accessorials || [],
    stage: mapTaiStatusToStage(rawStatus),
    rawStatus,
    carrier,
    mc: existing?.mc || "",
    po: String(r.customer_po ?? existing?.po ?? ""),
    bol: String(r.shipper_reference ?? existing?.bol ?? ""),
    pro: String(r.carrier_pro_number ?? existing?.pro ?? ""),
    shipDate: extractDateShort(String(r.ship_date || "")) !== "TBD" ? extractDateShort(String(r.ship_date || "")) : (existing?.shipDate || "TBD"),
    delivDate: extractDateShort(String(r.delivery_date || "")) !== "TBD" ? extractDateShort(String(r.delivery_date || "")) : (existing?.delivDate || "TBD"),
    equip: String(r.equipment_type || existing?.equip || "53 ft Van | Dry"),
    trailerSize: existing?.trailerSize || "Full",
    mileage: existing?.mileage || 0,
    sell: Number(r.sell ?? existing?.sell ?? 0),
    buy: Number(r.buy ?? existing?.buy ?? 0),
    podCount,
    emailPodAvailable: existing?.emailPodAvailable || false,
    rateconStatus: r.ratecon_status === "Sent" || carrier ? "Sent" : "Not Sent",
    writebackState: existing?.writebackState || "Synced live from Supabase shipments",
    location: String(r.current_location || existing?.location || `${fromCity}, ${fromState} → ${toCity}, ${toState}`),
    invoiceStatus: r.invoice_status ? String(r.invoice_status) : existing?.invoiceStatus,
  };
}

class OpsStore {
  kpis: OpsKpis = { ...INITIAL_KPIS };
  shipments: OpsShipment[] = structuredClone(SEEDED_SHIPMENTS);
  crucialEmails: CrucialEmailItem[] = structuredClone(SEEDED_EMAILS);
  facilities: SavedFacility[] = structuredClone(SEEDED_FACILITIES);
  carriers: CarrierOption[] = structuredClone(SEEDED_CARRIERS);
  customers: CustomerOption[] = structuredClone(SEEDED_CUSTOMERS);
  webhookLogs: WebhookEventLog[] = [
    {
      id: "wh-1",
      timestamp: new Date().toISOString(),
      type: "ShipmentDetailUpdateUrl",
      shipmentId: "132738007",
      summary: "MacroPoint GPS ping: El Paso, TX 79927 · Status In Transit",
    },
    {
      id: "wh-2",
      timestamp: new Date().toISOString(),
      type: "CarrierWriteBackPoller",
      shipmentId: "132729887",
      summary: "Fly poller verified Carrier #27401 ($8,000 Buy) via GET /Shipments/132729887",
    },
  ];

  supabaseClient: SupabaseClient | null = null;
  supabaseSyncedOnce = false;
  realtimeSubscribed = false;

  get isSafeSandbox(): boolean {
    return process.env.ALLOW_LIVE_TAI_WRITES !== "true";
  }

  get isSupabaseConfigured(): boolean {
    return Boolean(process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
  }

  get isTaiConfigured(): boolean {
    const k = String(process.env[["TAI", "API", "KEY"].join("_")] || "").trim();
    return Boolean(k);
  }

  getSupabase(): SupabaseClient | null {
    if (!this.isSupabaseConfigured) return null;
    if (!this.supabaseClient) {
      this.supabaseClient = createClient(
        process.env.SUPABASE_URL!.trim(),
        process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
        { auth: { persistSession: false } },
      );
    }
    return this.supabaseClient;
  }

  async initSupabaseSyncAndRealtime(): Promise<void> {
    const sb = this.getSupabase();
    if (!sb || this.supabaseSyncedOnce) return;
    this.supabaseSyncedOnce = true;

    try {
      // 1. Live Shipments
      const { data: shipRows } = await sb
        .from("shipments")
        .select(
          "shipment_id,status,tai_raw_status,customer_name,customer_tai_organization_id,carrier_name,carrier_pro_number,customer_po,shipper_reference,ship_date,delivery_date,from_city,from_state,to_city,to_state,total_weight,equipment_type,buy,sell,invoice_status,current_location,pod_document_count,ratecon_status,updated_at",
        )
        .order("updated_at", { ascending: false })
        .limit(40);

      if (Array.isArray(shipRows) && shipRows.length > 0) {
        const byId = new Map(this.shipments.map((s) => [s.id, s]));
        const merged: OpsShipment[] = [];
        for (const r of shipRows as Record<string, unknown>[]) {
          const id = String(r.shipment_id || "");
          if (!id) continue;
          merged.push(mapSupabaseShipmentRow(r, byId.get(id)));
          byId.delete(id);
        }
        this.shipments = [...merged, ...byId.values()];
      }

      // 2. Live Customers w/ TAI Organization IDs
      const { data: custRows } = await sb
        .from("customers")
        .select("name,tai_organization_id")
        .not("name", "is", null)
        .limit(200);
      if (Array.isArray(custRows) && custRows.length > 0) {
        this.customers = custRows.map((c: Record<string, unknown>) => ({
          name: String(c.name || ""),
          taiOrgId: c.tai_organization_id ? String(c.tai_organization_id) : "",
          city: "",
          state: "",
        }));
      }

      // 3. Live Facilities w/ ZIP codes
      const { data: facRows } = await sb
        .from("facilities")
        .select("id,company_name,street_address,city,state,zip_code,contact_name")
        .neq("zip_code", "")
        .limit(150);
      if (Array.isArray(facRows) && facRows.length > 0) {
        this.facilities = facRows.map((f: Record<string, unknown>) => ({
          id: String(f.id),
          label: `${f.company_name} — ${f.city}, ${f.state} ${f.zip_code}`,
          companyName: String(f.company_name || ""),
          streetAddress: String(f.street_address || ""),
          city: String(f.city || ""),
          state: String(f.state || ""),
          zipCode: String(f.zip_code || ""),
          contactName: String(f.contact_name || ""),
          phone: "",
        }));
      }

      // 4. Live Carriers w/ tai_carrier_master_id
      const { data: carrRows } = await sb
        .from("carriers")
        .select("name,mc_number,dot_number,tai_carrier_master_id,insurance_expiry")
        .not("tai_carrier_master_id", "is", null)
        .limit(200);
      if (Array.isArray(carrRows) && carrRows.length > 0) {
        this.carriers = carrRows.map((c: Record<string, unknown>) => ({
          name: String(c.name || ""),
          mc: String(c.mc_number || ""),
          dot: String(c.dot_number || ""),
          scac: "",
          taiMasterId: String(c.tai_carrier_master_id || ""),
          insuranceStatus: c.insurance_expiry ? `Exp ${String(c.insurance_expiry).slice(0, 10)}` : "On File",
        }));
      }

      // 5. Crucial Action Emails from freight_ap_emails (pod / po / rate)
      const { data: apRows } = await sb
        .from("freight_ap_emails")
        .select("id,subject,sender_email,received_at,ap_category,load_ids,extracted_po,extracted_amount,snippet")
        .in("ap_category", ["pod", "po", "rate"])
        .order("created_at", { ascending: false })
        .limit(10);
      if (Array.isArray(apRows) && apRows.length > 0) {
        const liveEmails: CrucialEmailItem[] = apRows.map((e: Record<string, unknown>) => {
          const loadArr = Array.isArray(e.load_ids) ? e.load_ids : [];
          const loadId = loadArr[0] ? String(loadArr[0]) : "NEW";
          const cat = String(e.ap_category || "pod");
          return {
            id: String(e.id),
            category: cat === "pod" ? "pod" : "diffs",
            subject: String(e.subject || "Operations Action Email"),
            from: String(e.sender_email || ""),
            received: String(e.received_at || "Recent").slice(0, 16),
            loadId,
            diffType: cat === "pod" ? "missing_pod" : cat === "po" ? "missing_po" : "rate_mismatch",
            diffLabel: cat === "pod" ? "POD Attachment Ready for TAI" : `Extracted ${cat.toUpperCase()} Update`,
            diffValue: String(e.extracted_po || (e.extracted_amount ? `$${e.extracted_amount}` : "Review")),
            ctaLabel: cat === "pod" ? "Upload POD & Verify Read-Back" : "Apply Update to Load",
            body: String(e.snippet || ""),
          };
        });
        this.crucialEmails = [SEEDED_EMAILS[0], ...liveEmails];
      }

      // 6. Subscribe to Supabase Realtime so webhooks landing on primary-freight-dashboard
      //    update fivenines-ops live within ~1 second!
      sb.channel("fivenines-live-sync")
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "shipments" },
          (payload) => {
            const row = payload.new as Record<string, unknown> | undefined;
            const id = String(row?.shipment_id || "");
            if (!row || !id) return;
            const idx = this.shipments.findIndex((s) => s.id === id);
            const updated = mapSupabaseShipmentRow(row, idx >= 0 ? this.shipments[idx] : undefined);
            if (idx >= 0) this.shipments[idx] = updated;
            else this.shipments.unshift(updated);

            this.webhookLogs.unshift({
              id: `rt-${Date.now()}`,
              timestamp: new Date().toISOString(),
              type: "SupabaseRealtime",
              shipmentId: id,
              summary: `Live Supabase sync: ${updated.rawStatus} · ${updated.carrier || "Unassigned"}`,
            });
            broadcastOpsEvent("shipment_updated", { shipmentId: id });
          },
        )
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "tai_carrier_assignments" },
          (payload) => {
            const row = payload.new as Record<string, unknown> | undefined;
            const id = String(row?.shipment_id || "");
            const status = String(row?.status || "");
            if (!id) return;
            const target = this.shipments.find((s) => s.id === id);
            if (target && status === "sent") {
              const verifiedBuy = Number((row?.response_body as { verifiedBuy?: unknown } | null)?.verifiedBuy);
              if (row?.carrier_name) target.carrier = String(row.carrier_name);
              if (Number.isFinite(verifiedBuy) && verifiedBuy > 0) target.buy = verifiedBuy;
              target.writebackState = `✓ Verified in TAI via Poller Read-Back ($${target.buy.toLocaleString()} Buy)`;
              broadcastOpsEvent("writeback_verified", { shipmentId: id, status });
            }
          },
        )
        .subscribe((status) => {
          this.realtimeSubscribed = status === "SUBSCRIBED";
        });
    } catch (err) {
      console.warn("[store] Supabase hydration fallback:", err instanceof Error ? err.message : err);
    }
  }

  async getBootstrap(user?: BootstrapPayload["user"]): Promise<BootstrapPayload> {
    await this.initSupabaseSyncAndRealtime();
    const poller = pollerConfigStatus();
    return {
      mode: {
        safeSandbox: this.isSafeSandbox,
        supabaseConnected: this.isSupabaseConfigured,
        realtimeSubscribed: this.realtimeSubscribed,
        taiConfigured: this.isTaiConfigured,
        pollerEnabled: poller.enabled,
        pollerScope: poller.scope,
      },
      user: user ?? null,
      kpis: this.kpis,
      shipments: this.shipments,
      crucialEmails: this.crucialEmails,
      facilities: this.facilities,
      carriers: this.carriers,
      customers: this.customers,
      webhookLogs: this.webhookLogs.slice(0, 25),
    };
  }
}

export const store = new OpsStore();
