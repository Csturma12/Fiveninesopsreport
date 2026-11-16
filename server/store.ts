import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import {
  buildGmailContainerSearchUrl,
  extractContainerNumbers,
  sameContainerNumber,
  synthesizeContainerExceptionNote,
} from "../shared/container-extractor";
import type {
  BootstrapPayload,
  CarrierOption,
  ContainerEventItem,
  CrmLeadItem,
  CrmLeadSource,
  CrmLeadStage,
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
  {
    id: "fac-6",
    label: "Larkin Zelienople Plant — Zelienople, PA 16063",
    companyName: "Larkin Refractory (Zelienople)",
    streetAddress: "300 Tomlinson Drive",
    city: "Zelienople",
    state: "PA",
    zipCode: "16063",
    contactName: "Shipping",
    phone: "",
  },
  {
    id: "fac-7",
    label: "West Monroe Receiving — 6551 Cypress St, West Monroe, LA 71291",
    companyName: "West Monroe Receiving",
    streetAddress: "6551 Cypress St",
    city: "West Monroe",
    state: "LA",
    zipCode: "71291",
    contactName: "",
    phone: "",
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
    containerNumber: "CAIU945654-4",
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
    containerNumber: "JXLU445216-4",
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
  {
    id: "132702126",
    customer: "IMC LOGISTICS",
    taiOrgId: "514220",
    origin: "Drayage Terminal · Ramp Pickup",
    dest: "Shipper Facility (Forklift Down)",
    stops: [
      {
        stopType: "First Pickup",
        companyName: "Shipper Warehouse",
        streetAddress: "",
        city: "Houston",
        state: "TX",
        zipCode: "77001",
        country: "USA",
        contactName: "",
        phone: "",
        instructions: "TONU paid — waiting for shipper forklift repair before rescheduling pickup",
        readyDate: "2026-11-16",
        timeOpen: "08:00",
        timeClose: "16:00",
        appointmentRequired: true,
      },
      {
        stopType: "Last Drop",
        companyName: "IMC Container Return",
        streetAddress: "",
        city: "Houston",
        state: "TX",
        zipCode: "77001",
        country: "USA",
        contactName: "",
        phone: "",
        instructions: "",
        readyDate: "2026-11-17",
        timeOpen: "08:00",
        timeClose: "16:00",
        appointmentRequired: false,
      },
    ],
    commodities: [
      {
        description: "Import Container CAAU724710-0 (Delayed — Forklift Breakdown)",
        packagingType: "Container",
        handlingQuantity: 1,
        piecesTotal: 1,
        weightTotal: 40000,
        hazardousMaterial: false,
        freightClass: "No Class",
        referenceNumber: "CAAU724710-0",
      },
    ],
    accessorials: ["TONU - Shipment"],
    stage: "Needs truck",
    rawStatus: "Committed · TONU Paid",
    carrier: "",
    mc: "",
    po: "CAAU724710-0",
    bol: "CAAU724710-0",
    pro: "",
    containerNumber: "CAAU724710-0",
    operationalNote:
      "⚠ TONU PAID · DID NOT PICK UP: Forklift went down at facility — paid TONU (Carrier Confirmation TONU sent by Marko Markovic) and waiting for forklift to be repaired before rescheduling pickup.",
    containerEvents: [
      {
        id: "ev-tonu-132702126",
        timestamp: "Today 7:58 AM",
        from: "Marko Markovic <team1@primarycompanies.com>",
        subject: "Shipment ID: 132702126 · Carrier Confirmation TONU (CAAU724710-0)",
        summary: "Carrier Confirmation TONU PDF attached — driver turned away because shipper forklift went down; waiting for forklift repair.",
        kind: "tonu",
        permalink: buildGmailContainerSearchUrl("CAAU724710-0", "132702126"),
      },
    ],
    shipDate: "Nov 16",
    delivDate: "Pending",
    equip: "Container - Standard",
    trailerSize: "Full",
    mileage: 0,
    sell: 0,
    buy: 250,
    podCount: 0,
    emailPodAvailable: false,
    rateconStatus: "Sent",
    writebackState: "TONU recorded · Container CAAU724710-0 awaiting forklift repair",
    location: "Hold at pickup · Forklift down (waiting repair)",
  },
];

const SHIPMENT_SELECT_COLS =
  "shipment_id,status,tai_raw_status,customer_name,customer_tai_organization_id,carrier_name,carrier_pro_number,customer_po,shipper_reference,ship_date,delivery_date,from_city,from_state,to_city,to_state,total_weight,equipment_type,buy,sell,invoice_status,current_location,notes,pod_document_count,ratecon_status,updated_at";

export const DEFAULT_CRM_LEADS_WEBHOOK_URL = "https://salesops-dashboard-coral-seven.vercel.app/api/webhooks/leads";

const SEEDED_CRM_LEADS: CrmLeadItem[] = [
  {
    id: "crm-1",
    company: "CeramSource, Inc.",
    contact: "Shipping Manager",
    email: "logistics@ceramsource.com",
    phone: "(732) 257-5002",
    location: "Beaver Falls, PA 15010",
    source: "ImportYeti",
    status: "Qualified",
    owner: "Chris Sturma",
    followUp: "2026-11-18",
    evidence: "Repeated refractory flatbed shipments PA → GA (PO #42705 multi-pick shipper).",
    estimatedLanes: "Beaver Falls, PA → Lithonia, GA (48 ft Flatbed | Tarp)",
    pushedToVercelCrm: true,
    capturedAt: "2026-11-10T14:00:00.000Z",
    updatedAt: "2026-11-16T08:00:00.000Z",
  },
  {
    id: "crm-2",
    company: "Management & Consulting",
    contact: "Dean Smith",
    email: "dsmith@mgmtconsulting-pa.com",
    phone: "(724) 258-5500",
    location: "Monongahela, PA 15063",
    source: "Gmail",
    status: "Contacted",
    owner: "Chris Sturma",
    followUp: "2026-11-19",
    evidence: "High-alumina castable overflow loads (32,000 lbs pallets, stop 2 on PA → GA tenders).",
    estimatedLanes: "Monongahela, PA → SE & Midwest Flatbed",
    capturedAt: "2026-11-11T16:30:00.000Z",
    updatedAt: "2026-11-16T08:00:00.000Z",
  },
  {
    id: "crm-3",
    company: "West Monroe Paper Mill",
    contact: "Gate 2 Receiving Desk",
    email: "traffic@westmonroepaper.com",
    phone: "(318) 362-2000",
    location: "West Monroe, LA 71292",
    source: "Clay",
    status: "Researching",
    owner: "Chris Sturma",
    followUp: "2026-11-20",
    evidence: "Consistent inbound flatbed & dry van industrial mill freight from GA & TX.",
    estimatedLanes: "GA / TX → West Monroe, LA",
    capturedAt: "2026-11-12T10:15:00.000Z",
    updatedAt: "2026-11-15T18:00:00.000Z",
  },
  {
    id: "crm-4",
    company: "Port Newark Container Drayage",
    contact: "Import Operations",
    email: "drayage@portnewarkterminal.com",
    phone: "(973) 555-0192",
    location: "Newark, NJ 07114",
    source: "Quote",
    status: "New",
    owner: "Chris Sturma",
    followUp: "2026-11-17",
    evidence: "Cross-country Port Newark container transloads & step deck team freight.",
    estimatedLanes: "Newark, NJ → Los Angeles, CA / Midwest",
    capturedAt: "2026-11-14T09:20:00.000Z",
    updatedAt: "2026-11-16T08:00:00.000Z",
  },
  {
    id: "crm-5",
    company: "Phoenix Industrial Pipe",
    contact: "Receiving & Procurement",
    email: "dispatch@phoenixindustrialpipe.com",
    phone: "(602) 555-0114",
    location: "Phoenix, AZ 85043",
    source: "Manual",
    status: "New",
    owner: "Chris Sturma",
    followUp: "2026-11-21",
    evidence: "42,000 lb bundled industrial pipe & refractory anchor lanes from LA.",
    estimatedLanes: "Ethel, LA → Phoenix, AZ (48 ft Flatbed)",
    capturedAt: "2026-11-15T11:00:00.000Z",
    updatedAt: "2026-11-16T08:00:00.000Z",
  },
];

const SEEDED_EMAILS: CrucialEmailItem[] = [
  {
    id: "em-tonu-132702126",
    category: "diffs",
    subject: "Shipment ID: 132702126 — Carrier Confirmation TONU (Container CAAU724710-0)",
    from: "team1@primarycompanies.com",
    senderName: "Marko Markovic",
    received: "Today 7:58 AM",
    loadId: "132702126",
    containerNumber: "CAAU724710-0",
    diffType: "rate_mismatch",
    diffLabel: "TONU Paid · Forklift Down (Waiting Repair)",
    diffValue: "CAAU724710-0 · TONU",
    ctaLabel: "Save Note & Review #132702126",
    operationalNote:
      "⚠ TONU PAID · DID NOT PICK UP: Forklift went down at facility — paid TONU and waiting for forklift to be repaired before rescheduling pickup.",
    attachments: [{ filename: "CarrierConfirmation_TONU_132702126.pdf", mimeType: "application/pdf" }],
    permalink: buildGmailContainerSearchUrl("CAAU724710-0", "132702126"),
    body: "Here is the Carrier Confirmation TONU for shipment 132702126 (Container CAAU724710-0). Load did not pick up because shipper forklift went down; TONU paid, waiting for forklift repair.",
    fullBody:
      "Here is the Carrier Confirmation TONU for shipment 132702126 (Container CAAU724710-0).\n\nOperational Status:\n- Container #: CAAU724710-0\n- Did NOT pick up because the facility forklift went down.\n- Paid TONU to carrier (Carrier Confirmation TONU PDF attached).\n- Waiting for forklift to be repaired before re-dispatching pickup.\n\nMarko Markovic\nCarrier Sales | Primary Freight\nDirect: 205-588-0062 x 139\nteam1@primarycompanies.com",
  },
  {
    id: "em-tender-42705",
    category: "tenders",
    subject: "NEW 2-PICK TENDER: Beaver Falls PA + Monongahela PA → Lithonia GA (#42705)",
    from: "shipping@larkinrefractory.com",
    senderName: "Larkin Dispatch",
    received: "12m ago",
    loadId: "NEW",
    diffType: "new_tender",
    diffLabel: "Unbooked Multi-Stop Tender · 22 Pallets · 38,644 lbs",
    diffValue: "PA (2 Picks) → Lithonia, GA 30058",
    ctaLabel: "Extract to Compact Builder",
    extractedPo: "42705",
    extractedAmount: 3050,
    permalink: "https://mail.google.com/mail/u/0/#search/42705",
    body: "Please book PO #42705: Pick 1 CeramSource, 400 Enterprise Dr, Beaver Falls PA 15010 (6 pallets, 6,644 lbs ceramic fiber blankets) + Pick 2 Management & Consulting, 626 Riverview Rd, Monongahela PA 15063 (16 pallets, 32,000 lbs alumina castables) → Drop Larkin Refractory, 2331 Varkel Way, Lithonia GA 30058. 48 ft Flatbed | Tarp, 8ft tarps required, MacroPoint.",
    fullBody:
      "Team,\n\nPlease book PO #42705 in TAI (2-stop pickup → Lithonia GA):\n\nStop 1 (First Pickup): CeramSource, Inc., 400 Enterprise Drive, Beaver Falls, PA 15010\n  - 6 pallets · 6,644 lbs Ceramic Fiber Refractory Blankets\n  - Open 08:00–14:00 (2026-11-16)\n\nStop 2 (Pick): Management & Consulting, 626 Riverview Rd., Monongahela, PA 15063\n  - 16 pallets · 32,000 lbs High-Alumina Refractory Castables\n  - Open 10:00–15:00 (2026-11-16)\n\nStop 3 (Last Drop): Larkin Refractory Solutions, 2331 Varkel Way, Lithonia, GA 30058\n  - Appt 07:00–10:00 (2026-11-17)\n\nEquipment: 48 ft Flatbed | Tarp (8ft tarps required, call 1 hr prior, MacroPoint tracking).",
  },
  {
    id: "em-po-132742212",
    category: "diffs",
    subject: "RE: Larkin Refractory — Lithonia pickup PO #LR-88412",
    from: "ops@larkinrefractory.com",
    senderName: "Larkin Ops",
    received: "24m ago",
    loadId: "132742212",
    diffType: "missing_po",
    diffLabel: "Load #132742212 missing Customer PO in TAI",
    diffValue: "→ PO: LR-88412",
    ctaLabel: "Write PO to TAI References",
    extractedPo: "LR-88412",
    permalink: "https://mail.google.com/mail/u/0/#search/132742212",
    body: "Team — please add Customer PO #LR-88412 to Load #132742212 (Lithonia, GA 30058 → West Monroe, LA 71292).",
    fullBody: "Team — please add Customer PO #LR-88412 to Load #132742212 (Lithonia, GA 30058 → West Monroe, LA 71292) so it matches our BOL at pickup.",
  },
  {
    id: "em-rate-132738007",
    category: "diffs",
    subject: "Rate Alert · #132738007 Container CAIU9456544 Buy Exceeds Sell",
    from: "dispatch@roxortrans.com",
    senderName: "Roxor Dispatch",
    received: "41m ago",
    loadId: "132738007",
    diffType: "rate_mismatch",
    diffLabel: "TMS Buy ($6,500) > DO Sell ($4,400)",
    diffValue: "-$2,100 Margin Alert",
    ctaLabel: "Revise Sell to $6,950",
    extractedAmount: 6950,
    extractedCarrier: "ROXOR INC",
    permalink: "https://mail.google.com/mail/u/0/#search/132738007",
    body: "Verified Roxor carrier rate is $6,500 while DO 95-505344 still reflects $4,400 sell.",
    fullBody: "Roxor Inc dispatch confirmed linehaul rate of $6,500 for Container CAIU9456544 (#132738007). Current sell rate on DO 95-505344 is $4,400; revise customer sell to $6,950 (+$450 net margin).",
  },
  {
    id: "em-pod-132647845",
    category: "pod",
    subject: "Signed POD Attached · #132647845 (Axis Industries)",
    from: "freightap@primarycompanies.com",
    senderName: "Freight AP",
    received: "1h ago",
    loadId: "132647845",
    diffType: "missing_pod",
    diffLabel: "Signed POD PDF in Gmail · 0 PODs in TAI",
    diffValue: "POD_132647845_signed.pdf",
    ctaLabel: "Upload POD & Verify Read-Back",
    attachments: [{ filename: "POD_132647845_signed.pdf", mimeType: "application/pdf" }],
    permalink: "https://mail.google.com/mail/u/0/#search/132647845",
    body: "Fox Carriers submitted signed POD for Ethel, LA → Phoenix, AZ (#132647845). Ready for TAI upload + read-back check.",
    fullBody: "Fox Carriers sent the signed Proof of Delivery PDF for Axis Industries Load #132647845 (Ethel, LA 70730 → Phoenix, AZ 85043). Upload to TAI so accounting can approve carrier settlement.",
  },
];

const CITY_STATE_ZIP_FALLBACK: Record<string, string> = {
  "BEAVER FALLS|PA": "15010",
  "MONONGAHELA|PA": "15063",
  "ZELIENOPLE|PA": "16063",
  "LITHONIA|GA": "30058",
  "MCDONOUGH|GA": "30253",
  "ATLANTA|GA": "30301",
  "SAVANNAH|GA": "31401",
  "WILMINGTON|CA": "90744",
  "LOS ANGELES|CA": "90058",
  "LONG BEACH|CA": "90802",
  "COMPTON|CA": "90220",
  "MEMPHIS|TN": "38141",
  "NASHVILLE|TN": "37210",
  "NEWARK|NJ": "07114",
  "TOLEDO|OH": "43612",
  "CLEVELAND|OH": "44101",
  "CINCINNATI|OH": "45202",
  "MARKHAM|IL": "60428",
  "CHICAGO|IL": "60601",
  "ETHEL|LA": "70730",
  "WEST MONROE|LA": "71291",
  "NEW ORLEANS|LA": "70112",
  "BATON ROUGE|LA": "70801",
  "PHOENIX|AZ": "85043",
  "HOUSTON|TX": "77013",
  "LA PORTE|TX": "77571",
  "DALLAS|TX": "75201",
  "EL PASO|TX": "79927",
  "NORTH CHARLESTON|SC": "29405",
  "CHARLESTON|SC": "29405",
  "LITTLE ROCK|AR": "72202",
  "SALEM|VA": "24153",
  "BIRMINGHAM|AL": "35203",
};

function resolveFacilityStopInfo(
  city: string,
  state: string,
  customerName: string,
  facilities: SavedFacility[],
): { companyName: string; streetAddress: string; zipCode: string; savedFacilityMatched: boolean } {
  const cNorm = String(city || "").trim().toUpperCase();
  const sNorm = String(state || "").trim().toUpperCase();
  const custNorm = String(customerName || "").trim().toUpperCase();

  // Prefer facility matching both city+state and customer name if possible
  const matches = facilities.filter(
    (f) =>
      f.city.trim().toUpperCase() === cNorm &&
      f.state.trim().toUpperCase() === sNorm &&
      /^\d{5}/.test(f.zipCode.trim()),
  );
  const exactCustMatch = custNorm
    ? matches.find((f) => f.companyName.toUpperCase().includes(custNorm.split(" ")[0] || ""))
    : undefined;
  const hit = exactCustMatch || matches[0];
  if (hit) {
    return {
      companyName: hit.companyName,
      streetAddress: hit.streetAddress,
      zipCode: hit.zipCode.slice(0, 5),
      savedFacilityMatched: true,
    };
  }

  const fallbackZip = CITY_STATE_ZIP_FALLBACK[`${cNorm}|${sNorm}`] || "";
  return {
    companyName: customerName || "",
    streetAddress: "",
    zipCode: fallbackZip,
    savedFacilityMatched: false,
  };
}

function mapSupabaseShipmentRow(
  r: Record<string, unknown>,
  existing?: OpsShipment,
  facilities: SavedFacility[] = SEEDED_FACILITIES,
): OpsShipment {
  const id = String(r.shipment_id || existing?.id || "");
  const customerName = String(r.customer_name || existing?.customer || "Customer");
  const fromCity = String(r.from_city || existing?.stops[0]?.city || "");
  const fromState = String(r.from_state || existing?.stops[0]?.state || "");
  const toCity = String(r.to_city || existing?.stops[existing.stops.length - 1]?.city || "");
  const toState = String(r.to_state || existing?.stops[existing.stops.length - 1]?.state || "");
  const wt = Number(r.total_weight) || existing?.commodities[0]?.weightTotal || 35000;
  const rawStatus = String(r.tai_raw_status || r.status || existing?.rawStatus || "Committed");
  const carrier = String(r.carrier_name ?? existing?.carrier ?? "");
  const podCount = Number(r.pod_document_count ?? existing?.podCount ?? 0);
  const dbNotes = typeof r.notes === "string" ? r.notes.trim() : "";
  const poStr = String(r.customer_po ?? existing?.po ?? "");
  const bolStr = String(r.shipper_reference ?? existing?.bol ?? "");
  const locStr = String(r.current_location || existing?.location || `${fromCity}, ${fromState} → ${toCity}, ${toState}`);
  const detectedContainers = extractContainerNumbers(`${poStr} ${bolStr} ${dbNotes} ${locStr}`);
  const containerNumber = detectedContainers[0] || existing?.containerNumber;

  const puResolved = resolveFacilityStopInfo(fromCity, fromState, customerName, facilities);
  const delResolved = resolveFacilityStopInfo(toCity, toState, customerName, facilities);

  const stops =
    existing?.stops &&
    existing.stops.length >= 2 &&
    existing.stops.every((s) => /^\d{5}/.test(s.zipCode) && s.zipCode !== "00000")
      ? existing.stops
      : [
          {
            stopType: "First Pickup" as const,
            companyName: puResolved.companyName || customerName,
            streetAddress: puResolved.streetAddress,
            city: fromCity,
            state: fromState,
            zipCode: puResolved.zipCode,
            country: "USA",
            contactName: "",
            phone: "",
            instructions: "",
            readyDate: String(r.ship_date || "2026-11-16").slice(0, 10),
            timeOpen: "08:00",
            timeClose: "15:00",
            appointmentRequired: false,
            savedFacilityMatched: puResolved.savedFacilityMatched,
          },
          {
            stopType: "Last Drop" as const,
            companyName: delResolved.companyName || "Consignee",
            streetAddress: delResolved.streetAddress,
            city: toCity,
            state: toState,
            zipCode: delResolved.zipCode,
            country: "USA",
            contactName: "",
            phone: "",
            instructions: "",
            readyDate: String(r.delivery_date || "2026-11-17").slice(0, 10),
            timeOpen: "09:00",
            timeClose: "16:00",
            appointmentRequired: false,
            savedFacilityMatched: delResolved.savedFacilityMatched,
          },
        ];

  return {
    id,
    customer: customerName,
    taiOrgId: r.customer_tai_organization_id ? String(r.customer_tai_organization_id) : existing?.taiOrgId,
    origin: `${fromCity}, ${fromState}`.replace(/^,\s*/, "") || existing?.origin || "Origin",
    dest: `${toCity}, ${toState}`.replace(/^,\s*/, "") || existing?.dest || "Destination",
    stops,
    commodities: existing?.commodities || [
      {
        description: containerNumber ? `Containerized Freight (${containerNumber})` : "General Freight",
        packagingType: containerNumber ? "Container" : "Pallet",
        handlingQuantity: 1,
        piecesTotal: 1,
        weightTotal: wt,
        hazardousMaterial: false,
        freightClass: "No Class",
        referenceNumber: poStr || containerNumber || "",
      },
    ],
    accessorials: existing?.accessorials || [],
    stage: mapTaiStatusToStage(rawStatus),
    rawStatus,
    carrier,
    mc: existing?.mc || "",
    po: poStr,
    bol: bolStr,
    pro: String(r.carrier_pro_number ?? existing?.pro ?? ""),
    containerNumber,
    operationalNote: dbNotes || existing?.operationalNote,
    containerEvents: existing?.containerEvents,
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
    location: locStr,
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
  crmLeads: CrmLeadItem[] = structuredClone(SEEDED_CRM_LEADS);
  dismissedEmailIds = new Set<string>();
  deletedShipmentIds = new Set<string>();
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
      // 1. Live Facilities w/ ZIP codes first so live shipments inherit real addresses & ZIPs
      const { data: facRows } = await sb
        .from("facilities")
        .select("id,company_name,street_address,city,state,zip_code,contact_name")
        .neq("zip_code", "")
        .limit(500);
      if (Array.isArray(facRows) && facRows.length > 0) {
        const remoteFacs = facRows.map((f: Record<string, unknown>) => ({
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
        const seenLabels = new Set(remoteFacs.map((f) => f.label.toLowerCase()));
        this.facilities = [
          ...remoteFacs,
          ...SEEDED_FACILITIES.filter((f) => !seenLabels.has(f.label.toLowerCase())),
        ];
      }

      // 2. Live Shipments
      const { data: shipRows } = await sb
        .from("shipments")
        .select(SHIPMENT_SELECT_COLS)
        .order("updated_at", { ascending: false })
        .limit(40);

      if (Array.isArray(shipRows) && shipRows.length > 0) {
        const byId = new Map(this.shipments.map((s) => [s.id, s]));
        const merged: OpsShipment[] = [];
        for (const r of shipRows as Record<string, unknown>[]) {
          const id = String(r.shipment_id || "");
          if (!id) continue;
          merged.push(mapSupabaseShipmentRow(r, byId.get(id), this.facilities));
          byId.delete(id);
        }
        this.shipments = [...merged, ...byId.values()];
      }

      // 3. Live Customers w/ TAI Organization IDs
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

      // 5. Crucial Action Emails & Tasks from freight_ap_emails / freight_ap_tasks
      //    Correlates BOTH by TAI Shipment ID and by ISO Container # (e.g. CAAU724710-0 for IMC loads)
      const [{ data: apRows }, { data: apTasks }] = await Promise.all([
        sb
          .from("freight_ap_emails")
          .select(
            "id,thread_id,sender_name,sender_email,subject,snippet,body_text,received_at,permalink,ap_category,load_ids,extracted_po,extracted_amount,extracted_carrier,extracted_invoice,attachments",
          )
          .in("ap_category", ["pod", "po", "rate", "ratecon", "invoice", "general"])
          .order("created_at", { ascending: false })
          .limit(60),
        sb
          .from("freight_ap_tasks")
          .select(
            "id,thread_id,shipment_id,customer_name,carrier_name,task_type,title,description,requested_action,notes,sender_email,subject,permalink,updated_at",
          )
          .order("updated_at", { ascending: false })
          .limit(60),
      ]);

      const taskNotesByShipment = new Map<string, string[]>();
      if (Array.isArray(apTasks)) {
        for (const t of apTasks as Record<string, unknown>[]) {
          const sid = String(t.shipment_id || "").trim();
          const joined = `${t.title || ""} ${t.description || ""} ${t.notes || ""} ${t.subject || ""}`.trim();
          const containers = extractContainerNumbers(joined);
          const keys = [sid, ...containers].filter(Boolean);
          for (const k of keys) {
            const list = taskNotesByShipment.get(k) || [];
            list.push(joined);
            taskNotesByShipment.set(k, list);
          }
        }
      }

      if (Array.isArray(apRows) && apRows.length > 0) {
        const seenKeys = new Set<string>();
        const liveEmails: CrucialEmailItem[] = [];

        for (const e of apRows as Record<string, unknown>[]) {
          const senderEmail = String(e.sender_email || "").trim();
          const subject = String(e.subject || "Operations Action Email").trim();
          const senderLower = senderEmail.toLowerCase();
          if (
            senderLower.includes("notifications@github.com") ||
            senderLower.includes("noreply@github.com") ||
            subject.includes("[Csturma12/")
          ) {
            continue;
          }

          const loadArr = Array.isArray(e.load_ids) ? e.load_ids : [];
          const loadId = loadArr[0] ? String(loadArr[0]).trim() : "NEW";
          const threadId = e.thread_id ? String(e.thread_id).trim() : "";
          const dedupKey = threadId || `${loadId}:${subject.toLowerCase()}`;
          if (seenKeys.has(dedupKey)) continue;
          seenKeys.add(dedupKey);

          const cat = String(e.ap_category || "pod");
          const rawBody = String(e.body_text || e.snippet || "").trim();
          const rawSnippet = String(e.snippet || rawBody).trim();
          const rawPermalink = typeof e.permalink === "string" ? e.permalink.trim() : "";
          const extractedPo = e.extracted_po ? String(e.extracted_po).trim() : undefined;
          const extractedAmount =
            typeof e.extracted_amount === "number"
              ? e.extracted_amount
              : Number(e.extracted_amount) > 0
              ? Number(e.extracted_amount)
              : undefined;
          const extractedCarrier = e.extracted_carrier ? String(e.extracted_carrier).trim() : undefined;
          const extractedInvoice = e.extracted_invoice ? String(e.extracted_invoice).trim() : undefined;

          const attachments = Array.isArray(e.attachments)
            ? e.attachments
                .filter((a): a is Record<string, unknown> => Boolean(a && typeof a === "object"))
                .map((a) => ({
                  filename: String(a.filename || a.name || "attachment"),
                  mimeType: a.mimeType ? String(a.mimeType) : undefined,
                }))
            : undefined;

          const attText = (attachments || []).map((a) => a.filename).join(" ");
          const detectedContainers = extractContainerNumbers(
            `${subject} ${rawBody} ${rawSnippet} ${attText} ${extractedPo || ""} ${extractedInvoice || ""}`,
          );
          const containerNumber =
            detectedContainers[0] || (loadId === "132702126" ? "CAAU724710-0" : undefined);

          const permalink = rawPermalink.startsWith("http")
            ? rawPermalink
            : containerNumber
            ? buildGmailContainerSearchUrl(containerNumber, loadId, subject)
            : threadId
            ? `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(threadId)}`
            : `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(loadId !== "NEW" ? loadId : subject)}`;

          const noteSynth = synthesizeContainerExceptionNote([
            subject,
            rawBody,
            rawSnippet,
            ...(taskNotesByShipment.get(loadId) || []),
            ...(containerNumber ? taskNotesByShipment.get(containerNumber) || [] : []),
          ]);

          const isTonu = noteSynth.hasTonu || /\btonu\b/i.test(`${subject} ${rawBody} ${attText}`);

          liveEmails.push({
            id: String(e.id),
            category: cat === "pod" ? "pod" : "diffs",
            subject,
            from: senderEmail,
            senderName: e.sender_name ? String(e.sender_name).trim() : undefined,
            received: String(e.received_at || "Recent").slice(0, 24),
            loadId,
            containerNumber,
            operationalNote: noteSynth.note || undefined,
            diffType: cat === "pod" ? "missing_pod" : cat === "po" ? "missing_po" : "rate_mismatch",
            diffLabel: isTonu
              ? "TONU / Pickup Exception · Review Load & Note"
              : cat === "pod"
              ? "POD Attachment Ready for TAI"
              : cat === "po"
              ? "Extracted PO Update"
              : "Rate / Operational Alert",
            diffValue:
              (containerNumber ? `${containerNumber} · ` : "") +
              (isTonu
                ? "TONU"
                : extractedPo || (extractedAmount ? `$${extractedAmount.toLocaleString()}` : "Review")),
            ctaLabel: isTonu
              ? "Review TONU & Exception Note"
              : cat === "pod"
              ? "Upload POD & Verify Read-Back"
              : cat === "po" && extractedPo
              ? `Write PO ${extractedPo} to Load`
              : "Apply Update to Load",
            body: rawSnippet.slice(0, 220) + (rawSnippet.length > 220 ? "…" : ""),
            fullBody: rawBody || rawSnippet,
            threadId: threadId || undefined,
            permalink,
            extractedPo,
            extractedAmount,
            extractedCarrier,
            extractedInvoice,
            attachments: attachments && attachments.length > 0 ? attachments : undefined,
          });
        }

        // Keep seeded tender + seeded #132702126 TONU context unless live DB already captured them
        const has132702126 = liveEmails.some((m) => m.loadId === "132702126" || sameContainerNumber(m.containerNumber, "CAAU724710-0"));
        this.crucialEmails = [
          SEEDED_EMAILS[1], // NEW 2-PICK TENDER (#42705)
          ...(has132702126 ? [] : [SEEDED_EMAILS[0]]),
          ...liveEmails,
        ].filter((m) => !this.dismissedEmailIds.has(m.id));

        // Guarantee every numeric loadId referenced by crucialEmails (plus #132702126) is hydrated into this.shipments
        const loadedIds = new Set(this.shipments.map((s) => s.id));
        const missingLoadIds = Array.from(
          new Set(
            [...this.crucialEmails.map((m) => m.loadId), "132702126"].filter(
              (id) => /^\d+$/.test(id) && !loadedIds.has(id),
            ),
          ),
        );
        if (missingLoadIds.length > 0) {
          const byId = new Map(this.shipments.map((s) => [s.id, s]));
          const { data: missingRows } = await sb
            .from("shipments")
            .select(SHIPMENT_SELECT_COLS)
            .in("shipment_id", missingLoadIds);
          if (Array.isArray(missingRows)) {
            for (const mr of missingRows as Record<string, unknown>[]) {
              const id = String(mr.shipment_id || "");
              if (id) {
                const updated = mapSupabaseShipmentRow(mr, byId.get(id), this.facilities);
                const existingIdx = this.shipments.findIndex((x) => x.id === id);
                if (existingIdx >= 0) this.shipments[existingIdx] = updated;
                else this.shipments.push(updated);
                loadedIds.add(id);
              }
            }
          }
        }
      }

      this.correlateContainerEventsAndNotes(taskNotesByShipment);

      // 6. Subscribe to Supabase Realtime so webhooks landing on primary-freight-dashboard
      //    update fivenines-ops live within ~1 second!
      sb.channel("fivenines-live-sync")
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "shipments" },
          (payload) => {
            const row = payload.new as Record<string, unknown> | undefined;
            const id = String(row?.shipment_id || "");
            if (!row || !id || this.deletedShipmentIds.has(id)) return;
            const idx = this.shipments.findIndex((s) => s.id === id);
            const updated = mapSupabaseShipmentRow(row, idx >= 0 ? this.shipments[idx] : undefined, this.facilities);
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

  correlateContainerEventsAndNotes(taskNotesByShipment: Map<string, string[]> = new Map()): void {
    for (const s of this.shipments) {
      if (!s.containerNumber) {
        const fromFields = extractContainerNumbers(
          `${s.po} ${s.bol} ${s.commodities.map((c) => `${c.description} ${c.referenceNumber}`).join(" ")} ${s.location} ${s.operationalNote || ""}`,
        );
        if (fromFields[0]) s.containerNumber = fromFields[0];
      }

      const matchedEmails = this.crucialEmails.filter(
        (em) =>
          em.loadId === s.id ||
          (Boolean(s.containerNumber) && Boolean(em.containerNumber) && sameContainerNumber(s.containerNumber, em.containerNumber)),
      );

      if (!s.containerNumber) {
        const fromEmail = matchedEmails.find((m) => Boolean(m.containerNumber))?.containerNumber;
        if (fromEmail) s.containerNumber = fromEmail;
      }

      const events: ContainerEventItem[] = [...(s.containerEvents || [])];
      const seenEventIds = new Set(events.map((ev) => ev.id));

      for (const em of matchedEmails) {
        const evId = `em:${em.id}`;
        if (seenEventIds.has(evId)) continue;
        seenEventIds.add(evId);
        const text = `${em.subject} ${em.fullBody || em.body}`;
        const synth = synthesizeContainerExceptionNote([text]);
        events.push({
          id: evId,
          timestamp: em.received,
          from: em.senderName ? `${em.senderName} <${em.from}>` : em.from,
          subject: em.subject,
          summary: em.operationalNote || synth.note || em.body,
          kind: synth.hasTonu ? "tonu" : synth.hasEquipmentIssue ? "exception" : "email",
          permalink: em.permalink,
        });
      }

      if (events.length > 0) {
        s.containerEvents = events;
      }

      const allTexts = [
        s.operationalNote,
        ...events.map((ev) => `${ev.subject} ${ev.summary}`),
        ...matchedEmails.map((em) => `${em.subject} ${em.fullBody || em.body}`),
        ...(taskNotesByShipment.get(s.id) || []),
        ...(s.containerNumber ? taskNotesByShipment.get(s.containerNumber) || [] : []),
      ];
      const synth = synthesizeContainerExceptionNote(allTexts);
      if (synth.note && (!s.operationalNote || synth.hasTonu || synth.hasEquipmentIssue)) {
        if (s.operationalNote && !s.operationalNote.includes(synth.note)) {
          // Keep user/explicit details if not already summarized cleanly
          if (!/forklift/i.test(s.operationalNote) && /forklift/i.test(synth.note)) {
            s.operationalNote = synth.note;
          }
        } else {
          s.operationalNote = synth.note;
        }
      }

      // Propagate shipment operationalNote back to any correlated CrucialEmailItem so the inbox tile shows it immediately!
      for (const em of matchedEmails) {
        if (!em.containerNumber && s.containerNumber) em.containerNumber = s.containerNumber;
        if (!em.operationalNote && s.operationalNote) em.operationalNote = s.operationalNote;
      }
    }
  }

  getCrmWebhookUrl(): string {
    return process.env.CRM_LEADS_WEBHOOK_URL?.trim() || DEFAULT_CRM_LEADS_WEBHOOK_URL;
  }

  addCrmLead(input: {
    company: string;
    contact?: string;
    email?: string;
    phone?: string;
    location?: string;
    source?: CrmLeadSource;
    sourceUrl?: string;
    status?: CrmLeadStage;
    owner?: string;
    followUp?: string;
    evidence?: string;
    estimatedLanes?: string;
  }): { lead: CrmLeadItem; duplicate: boolean } {
    const company = String(input.company || "").trim();
    const norm = company.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const existing = this.crmLeads.find((l) => l.company.toLowerCase().replace(/[^a-z0-9]+/g, "") === norm);
    if (existing) {
      return { lead: existing, duplicate: true };
    }
    const now = new Date().toISOString();
    const lead: CrmLeadItem = {
      id: `crm-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      company,
      contact: String(input.contact || "").trim(),
      email: String(input.email || "").trim(),
      phone: String(input.phone || "").trim(),
      location: String(input.location || "").trim(),
      source: input.source || "Manual",
      sourceUrl: input.sourceUrl ? String(input.sourceUrl).trim() : undefined,
      status: input.status || "New",
      owner: String(input.owner || "Chris Sturma").trim(),
      followUp: String(input.followUp || "").trim(),
      evidence: String(input.evidence || "").trim(),
      estimatedLanes: input.estimatedLanes ? String(input.estimatedLanes).trim() : undefined,
      capturedAt: now,
      updatedAt: now,
    };
    this.crmLeads.unshift(lead);
    return { lead, duplicate: false };
  }

  updateCrmLead(
    id: string,
    patch: Partial<
      Pick<
        CrmLeadItem,
        "company" | "contact" | "email" | "phone" | "location" | "status" | "owner" | "followUp" | "evidence" | "estimatedLanes" | "pushedToVercelCrm"
      >
    >,
  ): CrmLeadItem | null {
    const idx = this.crmLeads.findIndex((l) => l.id === id);
    if (idx < 0) return null;
    const updated: CrmLeadItem = {
      ...this.crmLeads[idx],
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.crmLeads[idx] = updated;
    if (updated.status === "Converted") {
      const existsInCustomers = this.customers.some(
        (c) => c.name.trim().toLowerCase() === updated.company.trim().toLowerCase(),
      );
      if (!existsInCustomers) {
        this.customers.unshift({
          name: updated.company.toUpperCase(),
          taiOrgId: "",
          city: updated.location.split(",")[0]?.trim() || "",
          state: updated.location.split(",")[1]?.trim().slice(0, 2) || "",
        });
      }
    }
    return updated;
  }

  deleteCrmLead(id: string): boolean {
    const before = this.crmLeads.length;
    this.crmLeads = this.crmLeads.filter((l) => l.id !== id);
    return this.crmLeads.length < before;
  }

  dismissEmail(id: string): boolean {
    this.dismissedEmailIds.add(id);
    const before = this.crucialEmails.length;
    this.crucialEmails = this.crucialEmails.filter((e) => e.id !== id);
    return this.crucialEmails.length < before;
  }

  deleteShipment(id: string): boolean {
    this.deletedShipmentIds.add(id);
    const before = this.shipments.length;
    this.shipments = this.shipments.filter((s) => s.id !== id);
    return this.shipments.length < before;
  }

  async getBootstrap(user?: BootstrapPayload["user"]): Promise<BootstrapPayload> {
    await this.initSupabaseSyncAndRealtime();
    this.shipments = this.shipments.filter((s) => !this.deletedShipmentIds.has(s.id));
    this.crucialEmails = this.crucialEmails.filter((e) => !this.dismissedEmailIds.has(e.id));
    this.correlateContainerEventsAndNotes();
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
      crmLeads: this.crmLeads,
      crmWebhookUrl: this.getCrmWebhookUrl(),
      webhookLogs: this.webhookLogs.slice(0, 25),
    };
  }
}

export const store = new OpsStore();
