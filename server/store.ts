import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import {
  buildGmailContainerSearchUrl,
  extractContainerNumbers,
  sameContainerNumber,
  synthesizeContainerExceptionNote,
} from "../shared/container-extractor";
import { extractLoadEntryFromEmail } from "../shared/email-extractor";
import type {
  BootstrapCounts,
  BootstrapPayload,
  CarrierOption,
  ContainerEventItem,
  CrmLeadItem,
  CrmLeadSource,
  CrmLeadStage,
  CrucialEmailItem,
  CustomerOption,
  ExtractedEmailFields,
  OpsKpis,
  OpsShipment,
  SavedFacility,
  WebhookEventLog,
} from "../shared/tai-webhook-schema";
import { deriveRateconStatus, extractDateShort, isHiddenCustomer, mapTaiStatusToStage } from "../shared/tai-webhook-schema";
import { broadcastOpsEvent } from "./events";
import { pollerConfigStatus } from "./tai-writeback-poller";

// Polyfill WebSocket for @supabase/supabase-js Realtime in Node 22 containers
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = WebSocket;
}

const INITIAL_KPIS: OpsKpis = {
  totalShipments: 5,
  loads30d: 5,
  rev30d: 18300,
  buy30d: 16650,
  pickedUp7d: 3,
  delivered7d: 1,
  uncoveredCommitted: 2,
  inTransitNow: 2,
  missingPodDelivered: 1,
  emailPodReady: 1,
  openApTasks: 4,
  tmsMismatches: 1,
  customersCount: 5,
  facilitiesCount: 7,
  carriersCount: 6,
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
    taiRawStatus: "Committed",
    carrier: "",
    mc: "",
    po: "",
    bol: "BOL-42212",
    pro: "",
    shipDate: "Nov 16",
    delivDate: "Nov 17",
    shipDateIso: "2026-11-16",
    delivDateIso: "2026-11-17",
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
    taiRawStatus: "In Transit",
    carrier: "ROXOR INC",
    mc: "1244890",
    po: "CAIU9456544",
    bol: "95-505344",
    pro: "RX-8812",
    containerNumber: "CAIU945654-4",
    shipDate: "Nov 13",
    delivDate: "Nov 16",
    shipDateIso: "2026-11-13",
    delivDateIso: "2026-11-16",
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
    currentLocation: "Gateway Blvd, El Paso, TX 79927",
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
    taiRawStatus: "Out for Delivery",
    carrier: "TRUCKLINE SOLUTIONS INC",
    mc: "1388412",
    po: "JXLU4452164",
    bol: "BL-99201",
    pro: "TL-4402",
    containerNumber: "JXLU445216-4",
    shipDate: "Nov 13",
    delivDate: "Nov 17",
    shipDateIso: "2026-11-13",
    delivDateIso: "2026-11-17",
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
    currentLocation: "1304 E Lomita Blvd, Los Angeles, CA 90744",
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
    taiRawStatus: "Delivered",
    carrier: "FOX CARRIERS",
    mc: "994210",
    po: "AX-9921",
    bol: "AX-1094",
    pro: "FX-7812",
    shipDate: "Nov 10",
    delivDate: "Nov 13",
    shipDateIso: "2026-11-10",
    delivDateIso: "2026-11-13",
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
    rawStatus: "Committed",
    taiRawStatus: "Committed",
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
        summary:
          "Carrier Confirmation TONU PDF attached — driver turned away because shipper forklift went down; waiting for forklift repair.",
        kind: "tonu",
        permalink: buildGmailContainerSearchUrl("CAAU724710-0", "132702126"),
      },
    ],
    shipDate: "Nov 16",
    delivDate: "Pending",
    shipDateIso: "2026-11-16",
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

export const SHIPMENT_SELECT_COLS =
  "shipment_id,status,tai_raw_status,customer_name,customer_tai_organization_id,carrier_name,driver_phone,trailer_number,carrier_pro_number,customer_po,shipper_reference,ship_date,delivery_date,from_city,from_state,to_city,to_state,total_weight,equipment_type,tracking,buy,sell,margin,invoice_status,invoice_date,invoice_paid_date,carrier_pay_status,current_location,location_updated_at,notes,pod_status,pod_document_count,pod_evidence,ratecon_status,ratecon_source,ratecon_tai_carrier_confirmation,updated_at,created_at";

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
    updatedAt: "2026-11-15T18:00.000Z",
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
    source: "seed",
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
    extractedFields: {
      customerPO: "CAAU724710-0",
      buyRate: 250,
      notes:
        "⚠ TONU PAID · DID NOT PICK UP: Forklift went down at facility — paid TONU and waiting for forklift to be repaired before rescheduling pickup.",
    },
  },
  {
    id: "em-rate-132738007",
    category: "diffs",
    source: "seed",
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
    fullBody:
      "Roxor Inc dispatch confirmed linehaul rate of $6,500 for Container CAIU9456544 (#132738007). Current sell rate on DO 95-505344 is $4,400; revise customer sell to $6,950 (+$450 net margin).",
    extractedFields: {
      customerPO: "CAIU9456544",
      sellRate: 6950,
      buyRate: 6500,
    },
  },
  {
    id: "em-pod-132647845",
    category: "pod",
    source: "seed",
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
    fullBody:
      "Fox Carriers sent the signed Proof of Delivery PDF for Axis Industries Load #132647845 (Ethel, LA 70730 → Phoenix, AZ 85043). Upload to TAI so accounting can approve carrier settlement.",
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

const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "icloud.com",
  "aol.com",
  "msn.com",
  "live.com",
  "protonmail.com",
  "primarycompanies.com",
  "shipfivenines.com",
  "fiveninesfreight.com",
]);

export const PLACEHOLDER_CUSTOMER_NAMES = new Set([
  "walkin unlinked spot customer",
  "unlinked spot customer",
  "tai webhook customer",
  "customer",
  "spot customer",
]);

/**
 * Normalizes company names for strict CRM net-new customer deduplication:
 * strips legal/generic suffixes (`INC`, `LLC`, `CORP`, `CO`, `LTD`, `SOLUTIONS`, `COMPANY`, etc.) and punctuation.
 */
export function normalizeCompanyIdentity(raw: string | undefined | null): string {
  let s = String(raw || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  const suffixPattern =
    /\b(incorporated|inc|llc|corp|corporation|company|companies|co|limited|ltd|solutions|lp|llp|plc|group|holdings)\b$/i;
  let prev = "";
  while (s && s !== prev) {
    prev = s;
    s = s.replace(suffixPattern, "").trim();
  }
  return s.replace(/\s+/g, " ").trim();
}

export function extractEmailDomain(email: string | undefined | null): string {
  const m = String(email || "")
    .trim()
    .toLowerCase()
    .match(/@([a-z0-9.-]+\.[a-z]{2,})$/);
  const domain = m ? m[1] : "";
  return domain && !FREE_EMAIL_DOMAINS.has(domain) ? domain : "";
}

/**
 * Builds a guaranteed-valid `https://mail.google.com/mail/u/0/...` URL:
 * - Uses `#all/<16-hex-id>` when a real Gmail hexadecimal thread/message ID exists
 * - Uses `#search/<encoded-query>` otherwise (never `#` or empty!)
 */
export function buildValidGmailPermalink(params: {
  permalink?: string | null;
  threadId?: string | null;
  messageId?: string | null;
  containerNumber?: string | null;
  loadId?: string | null;
  subject?: string | null;
}): string {
  const rawLink = String(params.permalink || "").trim();
  if (
    rawLink.startsWith("https://mail.google.com/mail/") &&
    rawLink.includes("#") &&
    !rawLink.endsWith("#")
  ) {
    return rawLink;
  }

  const candidateIds = [params.threadId, params.messageId]
    .map((v) => String(v || "").trim().replace(/^#?(?:thread-f:|msg-f:)/i, ""))
    .filter(Boolean);
  const hexId = candidateIds.find((id) => /^[0-9a-f]{15,18}$/i.test(id));
  if (hexId) {
    return `https://mail.google.com/mail/u/0/#all/${hexId}`;
  }

  if (params.containerNumber) {
    return buildGmailContainerSearchUrl(
      params.containerNumber,
      params.loadId && params.loadId !== "NEW" ? params.loadId : undefined,
      params.subject || undefined,
    );
  }

  const query =
    (params.loadId && params.loadId !== "NEW" ? params.loadId : "") ||
    String(params.subject || "").trim() ||
    "in:inbox";
  return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`;
}

function resolveFacilityStopInfo(
  city: string,
  state: string,
  customerName: string,
  facilities: SavedFacility[],
): { companyName: string; streetAddress: string; zipCode: string; savedFacilityMatched: boolean } {
  const cNorm = String(city || "").trim().toUpperCase();
  const sNorm = String(state || "").trim().toUpperCase();
  const custNorm = String(customerName || "").trim().toUpperCase();

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

export function mapSupabaseShipmentRow(
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
  const wt = Number(r.total_weight) || existing?.commodities[0]?.weightTotal || 0;

  const dbStatus = String(r.status || "").trim();
  const taiRawStatus = String(r.tai_raw_status ?? existing?.taiRawStatus ?? "").trim();
  const trackingStr = String(r.tracking || "").trim();
  const rawStatus = dbStatus || taiRawStatus || existing?.rawStatus || "Committed";
  const carrier = String(r.carrier_name ?? existing?.carrier ?? "").trim();

  // Combine status + tai_raw_status + tracking signal so Cancelled, In Transit, and Covered Committed are exact
  let stageSignal = rawStatus;
  if (/cancel/i.test(dbStatus) || /cancel/i.test(taiRawStatus)) {
    stageSignal = "Cancelled";
  } else if (/in\s*transit|picked|loaded|out\s*for\s*delivery|at\s*delivery|en\s*route/i.test(taiRawStatus) || /^picked up/i.test(trackingStr)) {
    stageSignal = taiRawStatus || "In Transit";
  } else if (/deliver|complete/i.test(dbStatus) || /\bdelivered\b|\bcompleted?\b/i.test(taiRawStatus)) {
    stageSignal = "Delivered";
  } else if (/dispatched/i.test(dbStatus) || /dispatched/i.test(taiRawStatus)) {
    stageSignal = "Dispatched";
  }
  const stage = mapTaiStatusToStage(stageSignal, carrier);

  const podStatus = r.pod_status != null ? String(r.pod_status).trim() : existing?.podStatus;
  const podCount = Math.max(
    Number(r.pod_document_count ?? existing?.podCount ?? 0) || 0,
    /^(found|received|verified)$/i.test(String(podStatus || "")) ? 1 : 0,
  );

  const dbNotes = typeof r.notes === "string" ? r.notes.trim() : "";
  const poStr = String(r.customer_po ?? existing?.po ?? "");
  const bolStr = String(r.shipper_reference ?? existing?.bol ?? "");
  const currentLoc = String(r.current_location ?? existing?.currentLocation ?? "").trim();
  const locStr =
    currentLoc ||
    trackingStr ||
    existing?.location ||
    `${fromCity}${fromState ? `, ${fromState}` : ""} → ${toCity}${toState ? `, ${toState}` : ""}`;
  const detectedContainers = extractContainerNumbers(`${poStr} ${bolStr} ${dbNotes} ${locStr}`);
  const containerNumber = detectedContainers[0] || existing?.containerNumber;

  const shipDateIso = String(r.ship_date ?? existing?.shipDateIso ?? "").trim().slice(0, 10);
  const delivDateIso = String(r.delivery_date ?? existing?.delivDateIso ?? "").trim().slice(0, 10);

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
            readyDate: shipDateIso || "",
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
            readyDate: delivDateIso || "",
            timeOpen: "09:00",
            timeClose: "16:00",
            appointmentRequired: false,
            savedFacilityMatched: delResolved.savedFacilityMatched,
          },
        ];

  const sellVal = Number(r.sell ?? existing?.sell ?? 0) || 0;
  const buyVal = Number(r.buy ?? existing?.buy ?? 0) || 0;

  return {
    id,
    customer: customerName,
    taiOrgId: r.customer_tai_organization_id ? String(r.customer_tai_organization_id) : existing?.taiOrgId,
    origin: `${fromCity}${fromState ? `, ${fromState}` : ""}`.trim() || existing?.origin || "Origin",
    dest: `${toCity}${toState ? `, ${toState}` : ""}`.trim() || existing?.dest || "Destination",
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
    stage,
    rawStatus,
    ...(taiRawStatus ? { taiRawStatus } : {}),
    carrier,
    mc: existing?.mc || "",
    po: poStr,
    bol: bolStr,
    pro: String(r.carrier_pro_number ?? existing?.pro ?? ""),
    containerNumber,
    operationalNote: dbNotes || existing?.operationalNote,
    containerEvents: existing?.containerEvents,
    shipDate: shipDateIso ? extractDateShort(shipDateIso) : existing?.shipDate || "",
    delivDate: delivDateIso ? extractDateShort(delivDateIso) : existing?.delivDate || "",
    ...(shipDateIso ? { shipDateIso } : {}),
    ...(delivDateIso ? { delivDateIso } : {}),
    equip: String(r.equipment_type || existing?.equip || "53 ft Van | Dry"),
    trailerSize: existing?.trailerSize || "Full",
    mileage: existing?.mileage || 0,
    sell: sellVal,
    buy: buyVal,
    podCount,
    ...(podStatus ? { podStatus } : {}),
    emailPodAvailable: existing?.emailPodAvailable || false,
    rateconStatus: deriveRateconStatus(r),
    writebackState: existing?.writebackState || "Synced live from Supabase shipments",
    location: locStr,
    ...(currentLoc ? { currentLocation: currentLoc } : {}),
    ...(r.driver_phone ? { driverPhone: String(r.driver_phone) } : existing?.driverPhone ? { driverPhone: existing.driverPhone } : {}),
    ...(r.trailer_number ? { trailerNumber: String(r.trailer_number) } : existing?.trailerNumber ? { trailerNumber: existing.trailerNumber } : {}),
    invoiceStatus: r.invoice_status ? String(r.invoice_status) : existing?.invoiceStatus,
    carrierPayStatus: r.carrier_pay_status ? String(r.carrier_pay_status) : existing?.carrierPayStatus,
    lastAgentAction:
      r.last_agent_action && typeof r.last_agent_action === "object"
        ? (r.last_agent_action as OpsShipment["lastAgentAction"])
        : existing?.lastAgentAction ||
          (dbNotes.includes("🤖 Grok")
            ? { agent: "Grok", action: "update", at: "", summary: (dbNotes.match(/\[🤖\s*Grok[^\]]*\]\s*([^\n]+)/)?.[1] || "Grok update").slice(0, 80) }
            : dbNotes.includes("🧠 Google")
            ? { agent: "Google Agent", action: "update", at: "", summary: (dbNotes.match(/\[🧠\s*Google[^\]]*\]\s*([^\n]+)/)?.[1] || "Google Agent update").slice(0, 80) }
            : undefined),
    ...(buyVal > sellVal && sellVal > 0
      ? { mismatchNote: `Buy ($${buyVal.toLocaleString()}) exceeds Sell ($${sellVal.toLocaleString()})` }
      : {}),
  };
}

export interface ShipmentsPageQuery {
  page?: number;
  pageSize?: number;
  status?: string;
  view?: string;
  search?: string;
  sortBy?: string;
  sortDir?: "asc" | "desc" | string;
}

export interface IngestEmailInput {
  id?: string;
  threadId?: string;
  messageId?: string;
  from?: string;
  sender?: string;
  senderName?: string;
  subject?: string;
  snippet?: string;
  bodyText?: string;
  body?: string;
  receivedAt?: string;
  unread?: boolean;
  permalink?: string;
  attachments?: Array<{ filename?: string; mimeType?: string }>;
}

class OpsStore {
  kpis: OpsKpis = { ...INITIAL_KPIS };
  shipments: OpsShipment[] = structuredClone(SEEDED_SHIPMENTS);
  crucialEmails: CrucialEmailItem[] = structuredClone(SEEDED_EMAILS);
  extensionEmails: CrucialEmailItem[] = [];
  facilities: SavedFacility[] = structuredClone(SEEDED_FACILITIES);
  carriers: CarrierOption[] = structuredClone(SEEDED_CARRIERS);
  customers: CustomerOption[] = structuredClone(SEEDED_CUSTOMERS);
  crmLeads: CrmLeadItem[] = structuredClone(SEEDED_CRM_LEADS);
  dismissedEmailIds = new Set<string>();
  deletedShipmentIds = new Set<string>();
  knownShipmentCustomerNames = new Set<string>();
  webhookLogs: WebhookEventLog[] = [];

  supabaseClient: SupabaseClient | null = null;
  supabaseConnected = false;
  supabaseError: string | null = null;
  lastSyncAt: string | undefined = undefined;
  supabaseSyncedOnce = false;
  realtimeSubscribed = false;
  refreshTimer: NodeJS.Timeout | null = null;
  refreshInFlight: Promise<void> | null = null;

  liveCounts: BootstrapCounts = {
    totalShipments: SEEDED_SHIPMENTS.length,
    uncoveredCommitted: 2,
    coveredCommitted: 0,
    dispatched: 0,
    inTransit: 2,
    delivered: 1,
    cancelled: 0,
    customers: SEEDED_CUSTOMERS.length,
    carriers: SEEDED_CARRIERS.length,
    facilities: SEEDED_FACILITIES.length,
  };

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

  /**
   * Checks whether `companyName` (or `email` domain) already belongs to an existing TAI/Supabase customer
   * across all `customers` and all shipment `customer_name` records.
   */
  isExistingCustomer(companyName: string, email?: string): { existing: boolean; matchedName?: string } {
    const targetNorm = normalizeCompanyIdentity(companyName);
    const targetDomain = extractEmailDomain(email);
    if (!targetNorm && !targetDomain) return { existing: false };

    const candidateNames: Array<{ name: string; email?: string }> = [
      ...this.customers.map((c) => ({ name: c.name, email: c.email })),
      ...this.shipments.map((s) => ({ name: s.customer })),
      ...Array.from(this.knownShipmentCustomerNames).map((name) => ({ name })),
    ];

    for (const cand of candidateNames) {
      const cNorm = normalizeCompanyIdentity(cand.name);
      if (!cNorm || PLACEHOLDER_CUSTOMER_NAMES.has(cNorm)) continue;
      if (targetNorm && cNorm === targetNorm) {
        return { existing: true, matchedName: cand.name };
      }
      if (targetDomain && cand.email && extractEmailDomain(cand.email) === targetDomain) {
        return { existing: true, matchedName: cand.name };
      }
    }
    return { existing: false };
  }

  filterCrmLeadsAgainstCustomers(): void {
    this.crmLeads = this.crmLeads.filter((lead) => !this.isExistingCustomer(lead.company, lead.email).existing);
  }

  buildExtractedEmailFields(input: {
    subject: string;
    sender: string;
    bodyText: string;
    explicitPo?: string;
    explicitAmount?: number;
    operationalNote?: string;
  }): ExtractedEmailFields {
    const extracted = extractLoadEntryFromEmail(
      { subject: input.subject, sender: input.sender, bodyText: input.bodyText },
      this.customers,
      this.facilities,
    );
    const entry = extracted.entry;
    const first = entry.stops[0];
    const last = entry.stops[entry.stops.length - 1];
    const origin =
      first?.city && first?.state ? `${first.city}, ${first.state}${first.zipCode ? ` ${first.zipCode}` : ""}` : undefined;
    const dest =
      last?.city && last?.state ? `${last.city}, ${last.state}${last.zipCode ? ` ${last.zipCode}` : ""}` : undefined;
    const customerPO = input.explicitPo || entry.references.customerPO || undefined;
    const sellRate =
      input.explicitAmount && input.explicitAmount > 0
        ? input.explicitAmount
        : entry.pricing.linehaulSell > 0
        ? entry.pricing.linehaulSell
        : undefined;
    const buyRate = entry.pricing.linehaulBuy > 0 ? entry.pricing.linehaulBuy : undefined;

    return {
      ...(customerPO ? { customerPO } : {}),
      ...(sellRate ? { sellRate } : {}),
      ...(buyRate ? { buyRate } : {}),
      ...(origin ? { origin } : {}),
      ...(dest ? { dest } : {}),
      ...(entry.equipment.trailerType ? { equipment: entry.equipment.trailerType } : {}),
      ...(first?.readyDate ? { readyDate: first.readyDate } : {}),
      ...(input.operationalNote || entry.specialInstructions
        ? { notes: input.operationalNote || entry.specialInstructions }
        : {}),
    };
  }

  /**
   * Ingests real Gmail inbox threads & opened emails from the Chrome extension (`POST /api/inbox/ingest`),
   * deduplicates, correlates to loads/containers, computes `extractedFields`, and broadcasts `inbox_updated`.
   */
  ingestExtensionEmails(rawItems: IngestEmailInput[]): { ingested: number; items: CrucialEmailItem[] } {
    let ingested = 0;
    for (const raw of rawItems) {
      if (!raw || typeof raw !== "object") continue;
      const subject = String(raw.subject || "").trim();
      const rawFrom = String(raw.from || raw.sender || "").trim();
      const snippet = String(raw.snippet || "").trim();
      const bodyText = String(raw.bodyText || raw.body || snippet || "").trim();
      if (!subject && !bodyText) continue;

      const emailMatch = rawFrom.match(/<([^>]+@[^>]+)>/) || rawFrom.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      const senderEmail = emailMatch ? emailMatch[1].trim() : rawFrom;
      const senderName =
        raw.senderName?.trim() ||
        (emailMatch ? rawFrom.replace(emailMatch[0], "").replace(/["<>]/g, "").trim() : undefined);

      if (
        /notifications@github\.com|noreply@github\.com/i.test(senderEmail) ||
        subject.includes("[Csturma12/")
      ) {
        continue;
      }

      const threadId = String(raw.threadId || "").trim().replace(/^#?thread-f:/i, "");
      const messageId = String(raw.messageId || "").trim().replace(/^#?msg-f:/i, "");
      const dedupKey =
        threadId ||
        messageId ||
        `${senderEmail.toLowerCase()}:${subject.toLowerCase()}`;
      const itemId = String(raw.id || `ext-${Buffer.from(dedupKey).toString("base64url").slice(0, 22)}`);

      if (this.dismissedEmailIds.has(itemId)) continue;

      const combined = `${subject}\n${bodyText}`;
      const containerNumbers = extractContainerNumbers(combined);
      const containerNumber = containerNumbers[0];

      // Correlate against live shipments
      let matchedShipment: OpsShipment | undefined;
      const idTokens = Array.from(combined.matchAll(/\b(\d{6,10})\b/g), (m) => m[1]);
      for (const tok of idTokens) {
        matchedShipment = this.shipments.find((s) => s.id === tok);
        if (matchedShipment) break;
      }
      if (!matchedShipment && containerNumber) {
        matchedShipment = this.shipments.find(
          (s) => s.containerNumber && sameContainerNumber(s.containerNumber, containerNumber),
        );
      }
      if (!matchedShipment) {
        matchedShipment = this.shipments.find(
          (s) =>
            (s.po && s.po.length >= 5 && combined.toLowerCase().includes(s.po.toLowerCase())) ||
            (s.bol && s.bol.length >= 5 && combined.toLowerCase().includes(s.bol.toLowerCase())),
        );
      }

      const loadId = matchedShipment ? matchedShipment.id : "NEW";
      const poMatch = combined.match(/(?:\bPO\b|\bP\.O\.\b|Purchase\s*Order)\s*#?:?\s*([A-Z0-9-]{3,24})/i);
      const extractedPo = poMatch ? poMatch[1].trim() : undefined;
      const amtMatch = combined.match(/\$\s?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,5})(?:\.\d{2})?/);
      const extractedAmount = amtMatch ? Number(amtMatch[1].replace(/,/g, "")) : undefined;
      const noteSynth = synthesizeContainerExceptionNote([subject, bodyText]);
      const isPod = /\bpod\b|proof\s+of\s+delivery/i.test(`${subject} ${(raw.attachments || []).map((a) => a.filename).join(" ")}`);
      const isTonu = noteSynth.hasTonu || /\btonu\b/i.test(combined);

      const extractedFields = this.buildExtractedEmailFields({
        subject,
        sender: rawFrom,
        bodyText,
        explicitPo: extractedPo,
        explicitAmount: extractedAmount,
        operationalNote: noteSynth.note || undefined,
      });

      const category: CrucialEmailItem["category"] = isPod
        ? "pod"
        : loadId === "NEW"
        ? "tenders"
        : "diffs";
      const diffType: CrucialEmailItem["diffType"] = isPod
        ? "missing_pod"
        : loadId === "NEW"
        ? "new_tender"
        : extractedPo && matchedShipment && !matchedShipment.po
        ? "missing_po"
        : "rate_mismatch";

      const permalink = buildValidGmailPermalink({
        permalink: raw.permalink,
        threadId,
        messageId,
        containerNumber,
        loadId,
        subject,
      });

      const existingIdx = this.extensionEmails.findIndex(
        (e) => e.id === itemId || (threadId && e.threadId === threadId),
      );
      const prevItem = existingIdx >= 0 ? this.extensionEmails[existingIdx] : undefined;

      const built: CrucialEmailItem = {
        id: prevItem?.id || itemId,
        category,
        source: "extension",
        subject: subject || "(No subject)",
        from: senderEmail || rawFrom || "gmail",
        ...(senderName ? { senderName } : {}),
        received: String(raw.receivedAt || prevItem?.received || "Just now").slice(0, 32),
        loadId,
        diffType,
        diffLabel: isTonu
          ? "TONU / Pickup Exception · Review Load & Note"
          : isPod
          ? "POD Email Captured from Gmail"
          : loadId === "NEW"
          ? `Live Gmail Tender${extractedFields.origin && extractedFields.dest ? ` · ${extractedFields.origin} → ${extractedFields.dest}` : ""}`
          : extractedPo
          ? `Extracted PO #${extractedPo} for Load #${loadId}`
          : `Matched Active Load #${loadId}`,
        diffValue:
          (containerNumber ? `${containerNumber} · ` : "") +
          (extractedPo
            ? `PO ${extractedPo}`
            : extractedAmount
            ? `$${extractedAmount.toLocaleString()}`
            : loadId === "NEW"
            ? "Extract Tender"
            : `#${loadId}`),
        ctaLabel:
          loadId === "NEW"
            ? "Extract to Compact Builder"
            : isPod
            ? "Upload POD & Verify Read-Back"
            : "Review & Apply to Load",
        body: (snippet || bodyText).slice(0, 240),
        fullBody: bodyText.length >= (prevItem?.fullBody?.length || 0) ? bodyText : prevItem!.fullBody,
        ...(threadId ? { threadId } : {}),
        ...(messageId ? { messageId } : {}),
        unread: typeof raw.unread === "boolean" ? raw.unread : prevItem?.unread ?? true,
        permalink,
        ...(containerNumber ? { containerNumber } : {}),
        ...(noteSynth.note ? { operationalNote: noteSynth.note } : {}),
        ...(extractedPo ? { extractedPo } : {}),
        ...(extractedAmount ? { extractedAmount } : {}),
        extractedFields,
        ...(Array.isArray(raw.attachments) && raw.attachments.length > 0 ? { attachments: raw.attachments } : {}),
        applied: prevItem?.applied ?? false,
      };

      if (existingIdx >= 0) {
        this.extensionEmails[existingIdx] = built;
      } else {
        this.extensionEmails.unshift(built);
        if (this.extensionEmails.length > 100) this.extensionEmails.length = 100;
      }
      ingested += 1;
    }

    this.rebuildMergedInbox();
    if (ingested > 0) {
      broadcastOpsEvent("inbox_updated", { ingested, count: this.crucialEmails.length, total: this.crucialEmails.length });

      // Best-effort durable mirror into Supabase `public.freight_ap_emails` when live so ingested threads survive restarts
      const sb = this.getSupabase();
      if (sb && this.supabaseConnected && !this.isSafeSandbox) {
        const recentToMirror = this.extensionEmails.slice(0, Math.min(ingested, 25));
        void (async () => {
          for (const em of recentToMirror) {
            try {
              const msgKey = em.messageId || em.threadId || em.id;
              await sb.from("freight_ap_emails").upsert(
                {
                  message_id: msgKey,
                  thread_id: em.threadId || msgKey,
                  sender_email: em.from,
                  sender_name: em.senderName || "",
                  subject: em.subject,
                  snippet: em.body,
                  body_text: em.fullBody || em.body,
                  received_at: em.received,
                  permalink: em.permalink || "",
                  ap_category: em.category === "pod" ? "pod" : em.extractedPo ? "po" : "general",
                  load_ids: em.loadId && em.loadId !== "NEW" ? [em.loadId] : [],
                  extracted_po: em.extractedPo || null,
                  extracted_amount: em.extractedAmount || null,
                  attachments: em.attachments || [],
                  created_by_extension: true,
                  updated_at: new Date().toISOString(),
                },
                { onConflict: "message_id" },
              );
            } catch {
              // ignore schema/conflict errors on optional durable mirror
            }
          }
        })();
      }
    }
    return { ingested, items: this.getInboxItems() };
  }

  private remoteInboxEmails: CrucialEmailItem[] = [];

  private rebuildMergedInbox(): void {
    if (!this.supabaseConnected && this.remoteInboxEmails.length === 0 && this.extensionEmails.length === 0) {
      this.crucialEmails = this.crucialEmails.filter((e) => !this.dismissedEmailIds.has(e.id));
      return;
    }
    const baseList = this.supabaseConnected ? this.remoteInboxEmails : [...this.remoteInboxEmails, ...SEEDED_EMAILS];
    const seen = new Set<string>();
    const merged: CrucialEmailItem[] = [];
    for (const item of [...this.extensionEmails, ...baseList]) {
      if (this.dismissedEmailIds.has(item.id)) continue;
      const key = item.threadId || `${item.from.toLowerCase()}:${item.subject.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
    this.crucialEmails = merged;
  }

  getInboxItems(): CrucialEmailItem[] {
    return this.crucialEmails.filter((e) => !this.dismissedEmailIds.has(e.id));
  }

  recomputeOfflineCounts(): void {
    const active = this.shipments.filter(
      (s) => !this.deletedShipmentIds.has(s.id) && !isHiddenCustomer(s.customer),
    );
    const uncoveredCommitted = active.filter(
      (s) => s.stage === "Needs truck" && /committed/i.test(s.rawStatus || "Committed") && !s.carrier.trim(),
    ).length;
    const coveredCommitted = active.filter(
      (s) => /committed/i.test(s.rawStatus || "") && Boolean(s.carrier.trim()),
    ).length;
    const dispatched = active.filter((s) => /dispatched/i.test(s.rawStatus)).length;
    const inTransit = active.filter((s) => s.stage === "In transit").length;
    const delivered = active.filter((s) => s.stage === "Delivered").length;
    const cancelled = active.filter((s) => s.stage === "Cancelled").length;

    this.liveCounts = {
      totalShipments: active.length,
      uncoveredCommitted,
      coveredCommitted,
      dispatched,
      inTransit,
      delivered,
      cancelled,
      customers: this.customers.filter((c) => !isHiddenCustomer(c.name)).length,
      carriers: this.carriers.length,
      facilities: this.facilities.length,
    };
  }

  /**
   * Full live Supabase hydration — replaces seeded demo rows completely when `supabaseConnected === true`.
   */
  async refreshFromSupabase(): Promise<void> {
    const sb = this.getSupabase();
    if (!sb) {
      this.supabaseConnected = false;
      this.recomputeOfflineCounts();
      return;
    }
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = (async () => {
      try {
        // 1. Paginate ALL Facilities (426 rows, including phone & email)
        const { data: facRows, error: facErr } = await sb
          .from("facilities")
          .select("id,company_name,street_address,city,state,zip_code,contact_name,phone,email")
          .order("updated_at", { ascending: false })
          .limit(1000);
        if (facErr) throw new Error(`facilities: ${facErr.message}`);

        const liveFacilities: SavedFacility[] = (facRows || []).map((f: Record<string, unknown>) => ({
          id: String(f.id),
          label: `${f.company_name || "Facility"} — ${f.city || ""}, ${f.state || ""} ${f.zip_code || ""}`.trim(),
          companyName: String(f.company_name || ""),
          streetAddress: String(f.street_address || ""),
          city: String(f.city || ""),
          state: String(f.state || ""),
          zipCode: String(f.zip_code || ""),
          contactName: String(f.contact_name || ""),
          phone: String(f.phone || ""),
          ...(f.email ? { email: String(f.email) } : {}),
        }));

        // 2. Paginate ALL Customers (342 rows)
        const liveCustomers: CustomerOption[] = [];
        for (let offset = 0; offset < 2000; offset += 1000) {
          const { data: custRows, error: custErr } = await sb
            .from("customers")
            .select("name,tai_organization_id,contact_name,phone,email,tai_address")
            .not("name", "is", null)
            .order("name", { ascending: true })
            .range(offset, offset + 999);
          if (custErr) throw new Error(`customers: ${custErr.message}`);
          if (!custRows || custRows.length === 0) break;
          for (const c of custRows as Record<string, unknown>[]) {
            const custName = String(c.name || "");
            if (isHiddenCustomer(custName)) continue;
            const addr = (c.tai_address && typeof c.tai_address === "object" ? c.tai_address : {}) as Record<
              string,
              unknown
            >;
            liveCustomers.push({
              name: custName,
              taiOrgId: c.tai_organization_id ? String(c.tai_organization_id) : "",
              city: String(addr.city || addr.City || ""),
              state: String(addr.state || addr.State || ""),
              ...(c.contact_name ? { contactName: String(c.contact_name) } : {}),
              ...(c.phone ? { phone: String(c.phone) } : {}),
              ...(c.email ? { email: String(c.email) } : {}),
            });
          }
          if (custRows.length < 1000) break;
        }

        // 3. Paginate ALL Carriers (5,022 rows across pages of 1,000 up to 6,000)
        const liveCarriers: CarrierOption[] = [];
        for (let offset = 0; offset < 6000; offset += 1000) {
          const { data: carrRows, error: carrErr } = await sb
            .from("carriers")
            .select("name,mc_number,dot_number,tai_carrier_master_id,insurance_expiry,phone,email,contact_name")
            .order("id", { ascending: true })
            .range(offset, offset + 999);
          if (carrErr) throw new Error(`carriers: ${carrErr.message}`);
          if (!carrRows || carrRows.length === 0) break;
          for (const c of carrRows as Record<string, unknown>[]) {
            const exp = c.insurance_expiry ? String(c.insurance_expiry).slice(0, 10) : "";
            liveCarriers.push({
              name: String(c.name || ""),
              mc: String(c.mc_number || ""),
              dot: String(c.dot_number || ""),
              scac: "",
              taiMasterId: c.tai_carrier_master_id != null ? String(c.tai_carrier_master_id) : "",
              insuranceStatus: exp ? `Exp ${exp}` : "On File",
              ...(exp ? { insuranceExpiry: exp } : {}),
              ...(c.contact_name ? { contactName: String(c.contact_name) } : {}),
              ...(c.phone ? { phone: String(c.phone) } : {}),
              ...(c.email ? { email: String(c.email) } : {}),
            });
          }
          if (carrRows.length < 1000) break;
        }

        // 4. Load ALL active shipments (~774 rows) + latest 400 Delivered/Cancelled rows (ZERO fake SEEDED_SHIPMENTS)
        const [activeRes, recentArchiveRes] = await Promise.all([
          sb
            .from("shipments")
            .select(SHIPMENT_SELECT_COLS)
            .in("status", ["Committed", "Dispatched", "In Transit", "Quote"])
            .order("ship_date", { ascending: false })
            .order("updated_at", { ascending: false })
            .limit(1500),
          sb
            .from("shipments")
            .select(SHIPMENT_SELECT_COLS)
            .in("status", ["Delivered", "Cancelled", "Complete"])
            .order("ship_date", { ascending: false })
            .order("updated_at", { ascending: false })
            .limit(400),
        ]);
        if (activeRes.error) throw new Error(`active shipments: ${activeRes.error.message}`);
        if (recentArchiveRes.error) throw new Error(`recent shipments: ${recentArchiveRes.error.message}`);

        const prevById = this.supabaseConnected
          ? new Map(this.shipments.map((s) => [s.id, s]))
          : new Map<string, OpsShipment>();

        const seenIds = new Set<string>();
        const liveShipments: OpsShipment[] = [];
        for (const r of [...(activeRes.data || []), ...(recentArchiveRes.data || [])] as Record<string, unknown>[]) {
          const id = String(r.shipment_id || "").trim();
          if (!id || seenIds.has(id) || this.deletedShipmentIds.has(id)) continue;
          if (isHiddenCustomer(String(r.customer_name || ""))) continue;
          const mapped = mapSupabaseShipmentRow(r, prevById.get(id), liveFacilities);
          if (isHiddenCustomer(mapped.customer)) continue;
          seenIds.add(id);
          liveShipments.push(mapped);
        }

        // 5. Exact live status counts + real 30-day revenue/buy/load KPIs + distinct shipment customer names
        const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
        const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);

        const [
          totalCntRes,
          deliveredCntRes,
          cancelledCntRes,
          recent30Res,
          missingPodCntRes,
          apEmailsRes,
          apTasksRes,
          intakeDraftsRes,
        ] = await Promise.all([
          sb.from("shipments").select("id", { count: "exact", head: true }),
          sb.from("shipments").select("id", { count: "exact", head: true }).eq("status", "Delivered"),
          sb.from("shipments").select("id", { count: "exact", head: true }).ilike("status", "Cancel%"),
          sb
            .from("shipments")
            .select("status,sell,buy,ship_date,delivery_date,customer_name")
            .gte("ship_date", thirtyDaysAgo)
            .not("status", "ilike", "Cancel%")
            .limit(3000),
          sb
            .from("shipments")
            .select("id", { count: "exact", head: true })
            .eq("status", "Delivered")
            .neq("pod_status", "found")
            .eq("pod_document_count", 0),
          sb
            .from("freight_ap_emails")
            .select(
              "id,thread_id,message_id,sender_name,sender_email,subject,snippet,body_text,received_at,permalink,ap_category,load_ids,extracted_po,extracted_amount,extracted_carrier,extracted_invoice,attachments",
            )
            .order("created_at", { ascending: false })
            .limit(50),
          sb
            .from("freight_ap_tasks")
            .select(
              "id,thread_id,shipment_id,customer_name,carrier_name,task_type,title,description,requested_action,notes,sender_email,subject,permalink,status,updated_at",
            )
            .order("updated_at", { ascending: false })
            .limit(110),
          sb
            .from("load_intake_drafts")
            .select("id,owner_email,state,status,version,created_at,updated_at")
            .order("updated_at", { ascending: false })
            .limit(25),
        ]);

        // Commit hydrated master tables & shipments cleanly
        this.facilities = liveFacilities;
        this.customers = liveCustomers;
        this.carriers = liveCarriers;
        this.shipments = liveShipments;

        for (const s of liveShipments) {
          if (s.customer && !isHiddenCustomer(s.customer)) this.knownShipmentCustomerNames.add(s.customer);
        }
        for (const r of (recent30Res.data || []) as Record<string, unknown>[]) {
          if (r.customer_name && !isHiddenCustomer(String(r.customer_name))) {
            this.knownShipmentCustomerNames.add(String(r.customer_name));
          }
        }

        // Compute exact active stage counts directly from the complete non-hidden active set
        const activeRows = ((activeRes.data || []) as Record<string, unknown>[]).filter(
          (r) => !isHiddenCustomer(String(r.customer_name || "")),
        );
        const uncoveredCommitted = activeRows.filter(
          (r) => /^committed$/i.test(String(r.status || "").trim()) && !String(r.carrier_name || "").trim(),
        ).length;
        const coveredCommitted = activeRows.filter(
          (r) => /^committed$/i.test(String(r.status || "").trim()) && Boolean(String(r.carrier_name || "").trim()),
        ).length;
        const dispatchedCount = activeRows.filter((r) => /^dispatched$/i.test(String(r.status || "").trim())).length;
        const inTransitCount = activeRows.filter(
          (r) =>
            /^in transit$/i.test(String(r.status || "").trim()) ||
            /in\s*transit|out\s*for\s*delivery/i.test(String(r.tai_raw_status || "")),
        ).length;

        const rows30 = (recent30Res.data || []) as Record<string, unknown>[];
        let rev30d = 0;
        let buy30d = 0;
        let pickedUp7d = 0;
        let delivered7d = 0;
        for (const r of rows30) {
          rev30d += Number(r.sell) || 0;
          buy30d += Number(r.buy) || 0;
          const sd = String(r.ship_date || "").slice(0, 10);
          const dd = String(r.delivery_date || "").slice(0, 10);
          const st = String(r.status || "");
          if (sd >= sevenDaysAgo && /dispatched|in transit|delivered|complete/i.test(st)) pickedUp7d += 1;
          if (dd >= sevenDaysAgo && /delivered|complete/i.test(st)) delivered7d += 1;
        }

        const totalShipments = totalCntRes.count ?? liveShipments.length;
        const deliveredTotal = deliveredCntRes.count ?? 0;
        const cancelledTotal = cancelledCntRes.count ?? 0;

        this.liveCounts = {
          totalShipments,
          uncoveredCommitted,
          coveredCommitted,
          dispatched: dispatchedCount,
          inTransit: inTransitCount,
          delivered: deliveredTotal,
          cancelled: cancelledTotal,
          customers: liveCustomers.length,
          carriers: liveCarriers.length,
          facilities: liveFacilities.length,
        };

        // 6. Hydrate real inbox items from freight_ap_emails + load_intake_drafts (ZERO fake SEEDED_EMAILS)
        const taskNotesByShipment = new Map<string, string[]>();
        const apTasksList = (apTasksRes.data || []) as Record<string, unknown>[];
        const openApTasksCount = apTasksList.filter(
          (t) => !/^resolved|closed|done$/i.test(String(t.status || "")),
        ).length;

        for (const t of apTasksList) {
          const sid = String(t.shipment_id || "").trim();
          const joined = `${t.title || ""} ${t.description || ""} ${t.notes || ""} ${t.subject || ""}`.trim();
          const containers = extractContainerNumbers(joined);
          for (const k of [sid, ...containers].filter(Boolean)) {
            const list = taskNotesByShipment.get(k) || [];
            list.push(joined);
            taskNotesByShipment.set(k, list);
          }
        }

        const builtRemoteEmails: CrucialEmailItem[] = [];
        const seenRemoteKeys = new Set<string>();
        let apPodEmailCount = 0;

        for (const e of (apEmailsRes.data || []) as Record<string, unknown>[]) {
          const senderEmail = String(e.sender_email || "").trim();
          const subject = String(e.subject || "Operations Email").trim();
          if (
            /notifications@github\.com|noreply@github\.com/i.test(senderEmail) ||
            subject.includes("[Csturma12/") ||
            isHiddenCustomer(subject) ||
            isHiddenCustomer(senderEmail)
          ) {
            continue;
          }

          const loadArr = Array.isArray(e.load_ids) ? e.load_ids : [];
          const loadId = loadArr[0] ? String(loadArr[0]).trim() : "NEW";
          const threadId = e.thread_id ? String(e.thread_id).trim() : "";
          const messageId = e.message_id ? String(e.message_id).trim() : "";
          const dedupKey = threadId || messageId || `${loadId}:${subject.toLowerCase()}`;
          if (seenRemoteKeys.has(dedupKey)) continue;
          seenRemoteKeys.add(dedupKey);

          const cat = String(e.ap_category || "general").toLowerCase();
          if (cat === "pod") apPodEmailCount += 1;

          const rawBody = String(e.body_text || e.snippet || "").trim();
          const rawSnippet = String(e.snippet || rawBody).trim();
          const extractedPo = e.extracted_po ? String(e.extracted_po).trim() : undefined;
          const extractedAmount = Number(e.extracted_amount) > 0 ? Number(e.extracted_amount) : undefined;
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
          const containerNumber = detectedContainers[0];

          const permalink = buildValidGmailPermalink({
            permalink: typeof e.permalink === "string" ? e.permalink : undefined,
            threadId,
            messageId,
            containerNumber,
            loadId,
            subject,
          });

          const noteSynth = synthesizeContainerExceptionNote([
            subject,
            rawBody,
            rawSnippet,
            ...(taskNotesByShipment.get(loadId) || []),
            ...(containerNumber ? taskNotesByShipment.get(containerNumber) || [] : []),
          ]);
          const isTonu = noteSynth.hasTonu || /\btonu\b/i.test(`${subject} ${rawBody} ${attText}`);

          const extractedFields = this.buildExtractedEmailFields({
            subject,
            sender: senderEmail,
            bodyText: rawBody || rawSnippet,
            explicitPo: extractedPo,
            explicitAmount: extractedAmount,
            operationalNote: noteSynth.note || undefined,
          });

          builtRemoteEmails.push({
            id: String(e.id),
            category: cat === "pod" ? "pod" : loadId === "NEW" ? "tenders" : "diffs",
            source: "ap_inbox",
            subject,
            from: senderEmail,
            senderName: e.sender_name ? String(e.sender_name).trim() : undefined,
            received: String(e.received_at || "Recent").slice(0, 24),
            loadId,
            ...(threadId ? { threadId } : {}),
            ...(messageId ? { messageId } : {}),
            containerNumber,
            operationalNote: noteSynth.note || undefined,
            diffType:
              cat === "pod"
                ? "missing_pod"
                : cat === "po"
                ? "missing_po"
                : loadId === "NEW"
                ? "new_tender"
                : "rate_mismatch",
            diffLabel: isTonu
              ? "TONU / Pickup Exception · Review Load & Note"
              : cat === "pod"
              ? "POD Attachment Ready for TAI"
              : cat === "po"
              ? "Extracted PO Update"
              : loadId === "NEW"
              ? "Inbound Tender / Quote Email"
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
              : loadId === "NEW"
              ? "Extract to Compact Builder"
              : "Review & Apply to Load",
            body: rawSnippet.slice(0, 220) + (rawSnippet.length > 220 ? "…" : ""),
            fullBody: rawBody || rawSnippet,
            permalink,
            extractedPo,
            extractedAmount,
            extractedCarrier,
            extractedInvoice,
            extractedFields,
            attachments: attachments && attachments.length > 0 ? attachments : undefined,
          });
        }

        // Also check `freight_email_archive.messages` (safe try/catch in case schema grants are restricted)
        try {
          const { data: archiveMsgs, error: archiveErr } = await sb
            .schema("freight_email_archive")
            .from("messages")
            .select(
              "id,provider_message_id,sent_at,received_at,sender_name,sender_email,subject,body_text,provider_url,attachments_metadata",
            )
            .order("received_at", { ascending: false })
            .limit(35);
          if (!archiveErr && Array.isArray(archiveMsgs)) {
            for (const am of archiveMsgs as Record<string, unknown>[]) {
              const senderEmail = String(am.sender_email || "").trim();
              const subject = String(am.subject || "(No subject)").trim();
              if (
                /notifications@github\.com|noreply@github\.com/i.test(senderEmail) ||
                subject.includes("[Csturma12/")
              ) {
                continue;
              }
              const provId = String(am.provider_message_id || "").trim();
              const dedupKey = provId || `arch-${am.id}`;
              if (seenRemoteKeys.has(dedupKey)) continue;
              seenRemoteKeys.add(dedupKey);

              const rawBody = String(am.body_text || "").trim();
              const combined = `${subject}\n${rawBody}`;
              const containers = extractContainerNumbers(combined);
              const containerNumber = containers[0];
              const idTokens = Array.from(combined.matchAll(/\b(\d{6,10})\b/g), (m) => m[1]);
              const matchedLoad = idTokens
                .map((tok) => liveShipments.find((s) => s.id === tok))
                .find(Boolean);
              const loadId = matchedLoad ? matchedLoad.id : "NEW";

              const extractedFields = this.buildExtractedEmailFields({
                subject,
                sender: senderEmail,
                bodyText: rawBody || subject,
              });

              builtRemoteEmails.push({
                id: `arch-${am.id}`,
                category: loadId === "NEW" ? "tenders" : "diffs",
                source: "ap_inbox",
                subject,
                from: senderEmail || "team-archive",
                senderName: am.sender_name ? String(am.sender_name).trim() : undefined,
                received: String(am.received_at || am.sent_at || "Archive").slice(0, 19),
                loadId,
                ...(provId ? { messageId: provId } : {}),
                ...(containerNumber ? { containerNumber } : {}),
                diffType: loadId === "NEW" ? "new_tender" : "rate_mismatch",
                diffLabel: loadId === "NEW" ? "Team Email Archive" : `Team Email · Load #${loadId}`,
                diffValue: extractedFields.customerPO
                  ? `PO ${extractedFields.customerPO}`
                  : loadId === "NEW"
                  ? "Review"
                  : `#${loadId}`,
                ctaLabel: loadId === "NEW" ? "Extract to Compact Builder" : "Review Email & Load",
                body: (rawBody || subject).slice(0, 220),
                fullBody: rawBody || subject,
                permalink: buildValidGmailPermalink({
                  permalink: typeof am.provider_url === "string" ? am.provider_url : undefined,
                  messageId: provId,
                  containerNumber,
                  loadId,
                  subject,
                }),
                extractedPo: extractedFields.customerPO,
                extractedAmount: extractedFields.sellRate,
                extractedFields,
              });
            }
          }
        } catch {
          // freight_email_archive schema may restrict service_role grants; ignore cleanly
        }

        // Also surface unsubmitted load_intake_drafts
        for (const d of (intakeDraftsRes.data || []) as Record<string, unknown>[]) {
          const draftStatus = String(d.status || "").toLowerCase();
          if (draftStatus === "submitted" || draftStatus === "booked" || draftStatus === "archived") continue;
          const stObj = (d.state && typeof d.state === "object" ? d.state : {}) as Record<string, unknown>;
          const draftSubject = String(stObj.subject || stObj.title || `Saved Intake Draft #${String(d.id).slice(0, 8)}`).trim();
          const draftSender = String(stObj.sender || d.owner_email || "gmail-intake").trim();
          const draftBody = String(stObj.bodyText || stObj.rawText || stObj.notes || "").trim();
          const draftThreadId = String(stObj.threadId || "").trim();
          const draftId = `intake-${d.id}`;
          if (seenRemoteKeys.has(draftId)) continue;
          seenRemoteKeys.add(draftId);

          const extractedFields = this.buildExtractedEmailFields({
            subject: draftSubject,
            sender: draftSender,
            bodyText: draftBody || draftSubject,
          });

          builtRemoteEmails.push({
            id: draftId,
            category: "tenders",
            source: "intake_draft",
            subject: draftSubject,
            from: draftSender,
            received: String(d.updated_at || d.created_at || "Draft").slice(0, 16),
            loadId: String(d.submission_id || "NEW"),
            ...(draftThreadId ? { threadId: draftThreadId } : {}),
            diffType: "new_tender",
            diffLabel: `Gmail Intake Draft (${d.status || "open"})`,
            diffValue: extractedFields.origin && extractedFields.dest
              ? `${extractedFields.origin} → ${extractedFields.dest}`
              : "Open Draft",
            ctaLabel: "Extract to Compact Builder",
            body: (draftBody || draftSubject).slice(0, 220),
            fullBody: draftBody || draftSubject,
            permalink: buildValidGmailPermalink({
              threadId: draftThreadId,
              subject: draftSubject,
            }),
            extractedPo: extractedFields.customerPO,
            extractedAmount: extractedFields.sellRate,
            extractedFields,
          });
        }

        this.remoteInboxEmails = builtRemoteEmails;
        this.supabaseConnected = true;
        this.supabaseError = null;
        this.lastSyncAt = new Date().toISOString();

        this.rebuildMergedInbox();

        // Ensure any numeric loadId referenced by inbox emails is hydrated in memory
        const loadedIds = new Set(this.shipments.map((s) => s.id));
        const missingIds = Array.from(
          new Set(
            this.crucialEmails
              .map((m) => m.loadId)
              .filter((id) => /^\d+$/.test(id) && !loadedIds.has(id) && !this.deletedShipmentIds.has(id)),
          ),
        );
        if (missingIds.length > 0) {
          const { data: missingRows } = await sb
            .from("shipments")
            .select(SHIPMENT_SELECT_COLS)
            .in("shipment_id", missingIds);
          if (Array.isArray(missingRows)) {
            for (const mr of missingRows as Record<string, unknown>[]) {
              const id = String(mr.shipment_id || "");
              if (id && !loadedIds.has(id)) {
                this.shipments.push(mapSupabaseShipmentRow(mr, undefined, this.facilities));
                loadedIds.add(id);
              }
            }
          }
        }

        const tmsMismatches = this.shipments.filter(
          (s) => s.stage !== "Cancelled" && s.buy > 0 && s.sell > 0 && s.buy > s.sell,
        ).length;

        this.kpis = {
          totalShipments,
          loads30d: rows30.length,
          rev30d: Math.round(rev30d),
          buy30d: Math.round(buy30d),
          pickedUp7d,
          delivered7d,
          uncoveredCommitted,
          inTransitNow: dispatchedCount + inTransitCount,
          missingPodDelivered: missingPodCntRes.count ?? 0,
          emailPodReady: apPodEmailCount,
          openApTasks: openApTasksCount,
          tmsMismatches,
          customersCount: liveCustomers.length,
          facilitiesCount: liveFacilities.length,
          carriersCount: liveCarriers.length,
        };

        this.correlateContainerEventsAndNotes(taskNotesByShipment);
        this.filterCrmLeadsAgainstCustomers();
      } catch (err) {
        this.supabaseConnected = false;
        this.supabaseError = err instanceof Error ? err.message : String(err);
        console.warn("[store] Supabase hydration error:", this.supabaseError);
      } finally {
        this.refreshInFlight = null;
      }
    })();

    return this.refreshInFlight;
  }

  async initSupabaseSyncAndRealtime(): Promise<void> {
    const sb = this.getSupabase();
    if (!sb) {
      this.recomputeOfflineCounts();
      return;
    }
    if (!this.supabaseSyncedOnce) {
      this.supabaseSyncedOnce = true;
      await this.refreshFromSupabase();

      // Subscribe to Supabase Realtime for instant cross-app updates
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
            if (updated.customer) this.knownShipmentCustomerNames.add(updated.customer);

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
              target.stage = mapTaiStatusToStage(target.rawStatus, target.carrier);
              target.writebackState = `✓ Verified in TAI via Poller Read-Back ($${target.buy.toLocaleString()} Buy)`;
              broadcastOpsEvent("writeback_verified", { shipmentId: id, status });
            }
          },
        )
        .subscribe((status) => {
          this.realtimeSubscribed = status === "SUBSCRIBED";
        });

      if (!this.refreshTimer) {
        this.refreshTimer = setInterval(() => {
          this.refreshFromSupabase().catch(() => {});
        }, 30_000);
        this.refreshTimer.unref?.();
      }
    }
  }

  /**
   * Server-paged All Loads query supporting all 12,572 Supabase `shipments` when live,
   * or deterministic in-memory pagination when offline / in unit tests.
   */
  async queryShipmentsPage(params: ShipmentsPageQuery = {}) {
    const page = Math.max(1, Math.floor(Number(params.page) || 1));
    const pageSize = Math.max(1, Math.min(250, Math.floor(Number(params.pageSize) || 100)));
    const statusFilter = String(params.status || "all").trim();
    const statusLower = statusFilter.toLowerCase();
    const view = String(params.view || "all").trim().toLowerCase();
    const search = String(params.search || "").trim();
    const sortBy = String(params.sortBy || "shipDate").trim();
    const sortAsc = String(params.sortDir || "desc").toLowerCase() === "asc";

    const sb = this.getSupabase();
    if (sb && this.supabaseConnected) {
      let q = sb
        .from("shipments")
        .select(SHIPMENT_SELECT_COLS, { count: "exact" })
        .not("customer_name", "ilike", "%quality sausage%")
        .not("customer_name", "ilike", "%qualitysausage%");

      if (view === "active") {
        q = q.in("status", ["Committed", "Dispatched", "In Transit", "Quote"]);
      }

      if (statusLower && statusLower !== "all") {
        if (statusLower === "needs truck" || statusLower === "needs_truck" || statusLower === "uncovered") {
          q = q.eq("status", "Committed").eq("carrier_name", "");
        } else if (
          statusLower === "committed (covered)" ||
          statusLower === "covered" ||
          statusLower === "assigned"
        ) {
          q = q.eq("status", "Committed").neq("carrier_name", "");
        } else if (statusLower === "committed") {
          q = q.eq("status", "Committed");
        } else if (statusLower === "dispatched") {
          q = q.eq("status", "Dispatched");
        } else if (statusLower === "in transit" || statusLower === "in_transit") {
          q = q.or("status.eq.In Transit,tai_raw_status.ilike.%In Transit%,tai_raw_status.ilike.%Out for Delivery%");
        } else if (statusLower === "delivered" || statusLower === "complete") {
          q = q.in("status", ["Delivered", "Complete"]);
        } else if (statusLower === "cancelled" || statusLower === "canceled") {
          q = q.ilike("status", "Cancel%");
        } else if (statusLower === "quote") {
          q = q.eq("status", "Quote");
        }
      }

      if (search) {
        const cleanQ = search.replace(/[,%()'"\\]/g, " ").trim();
        if (cleanQ) {
          q = q.or(
            [
              `shipment_id.ilike.%${cleanQ}%`,
              `customer_name.ilike.%${cleanQ}%`,
              `carrier_name.ilike.%${cleanQ}%`,
              `customer_po.ilike.%${cleanQ}%`,
              `shipper_reference.ilike.%${cleanQ}%`,
              `carrier_pro_number.ilike.%${cleanQ}%`,
              `from_city.ilike.%${cleanQ}%`,
              `from_state.ilike.%${cleanQ}%`,
              `to_city.ilike.%${cleanQ}%`,
              `to_state.ilike.%${cleanQ}%`,
            ].join(","),
          );
        }
      }

      const sortColumnMap: Record<string, string> = {
        shipDate: "ship_date",
        ship_date: "ship_date",
        customer: "customer_name",
        customerName: "customer_name",
        carrier: "carrier_name",
        carrierName: "carrier_name",
        sell: "sell",
        buy: "buy",
        margin: "margin",
        shipmentId: "shipment_id",
        updatedAt: "updated_at",
      };
      const dbSortCol = sortColumnMap[sortBy] || "ship_date";
      q = q.order(dbSortCol, { ascending: sortAsc }).order("updated_at", { ascending: false });

      const fromIdx = (page - 1) * pageSize;
      const { data, count, error } = await q.range(fromIdx, fromIdx + pageSize - 1);
      if (!error && Array.isArray(data)) {
        const byId = new Map(this.shipments.map((s) => [s.id, s]));
        const items = (data as Record<string, unknown>[])
          .filter(
            (r) =>
              !this.deletedShipmentIds.has(String(r.shipment_id || "")) &&
              !isHiddenCustomer(String(r.customer_name || "")),
          )
          .map((r) => mapSupabaseShipmentRow(r, byId.get(String(r.shipment_id || "")), this.facilities))
          .filter((s) => !isHiddenCustomer(s.customer));

        const c = this.liveCounts;
        const statusCounts: Record<string, number> = {
          all: c.totalShipments,
          active: c.uncoveredCommitted + c.coveredCommitted + c.dispatched + c.inTransit,
          "Needs Truck": c.uncoveredCommitted,
          "Needs truck": c.uncoveredCommitted,
          "Committed (Covered)": c.coveredCommitted,
          Committed: c.uncoveredCommitted + c.coveredCommitted,
          Assigned: c.coveredCommitted + c.dispatched,
          Dispatched: c.dispatched,
          "In Transit": c.inTransit,
          "In transit": c.inTransit,
          Delivered: c.delivered,
          Cancelled: c.cancelled,
        };

        return {
          ok: true as const,
          items,
          rows: items,
          total: count ?? items.length,
          page,
          pageSize,
          statusCounts,
        };
      }
    }

    // In-memory pagination (offline / unit tests)
    const allRows = this.shipments.filter(
      (s) => !this.deletedShipmentIds.has(s.id) && !isHiddenCustomer(s.customer),
    );
    const statusCounts: Record<string, number> = {
      all: allRows.length,
      active: allRows.filter((s) => s.stage !== "Delivered" && s.stage !== "Cancelled").length,
      "Needs Truck": allRows.filter((s) => s.stage === "Needs truck").length,
      "Needs truck": allRows.filter((s) => s.stage === "Needs truck").length,
      "Committed (Covered)": allRows.filter(
        (s) => /committed/i.test(s.rawStatus) && Boolean(s.carrier.trim()),
      ).length,
      Committed: allRows.filter((s) => /committed/i.test(s.rawStatus)).length,
      Assigned: allRows.filter((s) => s.stage === "Assigned").length,
      Dispatched: allRows.filter((s) => /dispatched/i.test(s.rawStatus)).length,
      "In Transit": allRows.filter((s) => s.stage === "In transit").length,
      "In transit": allRows.filter((s) => s.stage === "In transit").length,
      Delivered: allRows.filter((s) => s.stage === "Delivered").length,
      Cancelled: allRows.filter((s) => s.stage === "Cancelled").length,
    };

    const filtered = allRows.filter((s) => {
      if (view === "active" && (s.stage === "Delivered" || s.stage === "Cancelled")) return false;
      if (statusLower && statusLower !== "all") {
        if (statusLower === "needs truck" || statusLower === "needs_truck" || statusLower === "uncovered") {
          if (s.stage !== "Needs truck") return false;
        } else if (statusLower === "committed (covered)" || statusLower === "covered") {
          if (!(/committed/i.test(s.rawStatus) && Boolean(s.carrier.trim()))) return false;
        } else if (statusLower === "assigned") {
          if (s.stage !== "Assigned") return false;
        } else if (statusLower === "committed") {
          if (!/committed/i.test(s.rawStatus)) return false;
        } else if (statusLower === "dispatched") {
          if (!/dispatched/i.test(s.rawStatus)) return false;
        } else if (statusLower === "in transit" || statusLower === "in_transit") {
          if (s.stage !== "In transit") return false;
        } else if (statusLower === "delivered" || statusLower === "complete") {
          if (s.stage !== "Delivered") return false;
        } else if (statusLower === "cancelled" || statusLower === "canceled") {
          if (s.stage !== "Cancelled") return false;
        } else if (statusLower === "quote") {
          if (!/quote/i.test(s.rawStatus)) return false;
        }
      }
      if (search) {
        const ql = search.toLowerCase();
        const hay = `${s.id} ${s.customer} ${s.carrier} ${s.po} ${s.bol} ${s.pro} ${s.origin} ${s.dest} ${s.containerNumber || ""}`.toLowerCase();
        if (!hay.includes(ql)) return false;
      }
      return true;
    });

    filtered.sort((a, b) => {
      const dir = sortAsc ? 1 : -1;
      if (sortBy === "sell") return (a.sell - b.sell) * dir;
      if (sortBy === "buy") return (a.buy - b.buy) * dir;
      if (sortBy === "margin") return (a.sell - a.buy - (b.sell - b.buy)) * dir;
      if (sortBy === "customer" || sortBy === "customerName") return a.customer.localeCompare(b.customer) * dir;
      if (sortBy === "carrier" || sortBy === "carrierName") return a.carrier.localeCompare(b.carrier) * dir;
      const da = a.shipDateIso || a.stops[0]?.readyDate || "";
      const db = b.shipDateIso || b.stops[0]?.readyDate || "";
      return da.localeCompare(db) * dir;
    });

    const total = filtered.length;
    const start = (page - 1) * pageSize;
    const items = filtered.slice(start, start + pageSize);

    return {
      ok: true as const,
      items,
      rows: items,
      total,
      page,
      pageSize,
      statusCounts,
    };
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
          (Boolean(s.containerNumber) &&
            Boolean(em.containerNumber) &&
            sameContainerNumber(s.containerNumber, em.containerNumber)),
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
          if (!/forklift/i.test(s.operationalNote) && /forklift/i.test(synth.note)) {
            s.operationalNote = synth.note;
          }
        } else {
          s.operationalNote = synth.note;
        }
      }

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
  }): {
    lead: CrmLeadItem;
    duplicate: boolean;
    blockedExistingCustomer?: boolean;
    matchedCustomer?: string;
  } {
    const company = String(input.company || "").trim();
    const now = new Date().toISOString();

    const existingCustCheck = this.isExistingCustomer(company, input.email);
    if (existingCustCheck.existing) {
      const blockedPlaceholder: CrmLeadItem = {
        id: "blocked-existing-customer",
        company,
        contact: String(input.contact || "").trim(),
        email: String(input.email || "").trim(),
        phone: String(input.phone || "").trim(),
        location: String(input.location || "").trim(),
        source: input.source || "Manual",
        status: input.status || "New",
        owner: String(input.owner || "Chris Sturma").trim(),
        followUp: String(input.followUp || "").trim(),
        evidence: String(input.evidence || "").trim(),
        capturedAt: now,
        updatedAt: now,
      };
      return {
        lead: blockedPlaceholder,
        duplicate: false,
        blockedExistingCustomer: true,
        matchedCustomer: existingCustCheck.matchedName,
      };
    }

    const norm = normalizeCompanyIdentity(company);
    const existing = this.crmLeads.find((l) => normalizeCompanyIdentity(l.company) === norm);
    if (existing) {
      return { lead: existing, duplicate: true };
    }
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
        | "company"
        | "contact"
        | "email"
        | "phone"
        | "location"
        | "status"
        | "owner"
        | "followUp"
        | "evidence"
        | "estimatedLanes"
        | "pushedToVercelCrm"
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
        (c) => normalizeCompanyIdentity(c.name) === normalizeCompanyIdentity(updated.company),
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
    this.extensionEmails = this.extensionEmails.filter((e) => e.id !== id);
    this.remoteInboxEmails = this.remoteInboxEmails.filter((e) => e.id !== id);
    return this.crucialEmails.length < before;
  }

  deleteShipment(id: string): boolean {
    this.deletedShipmentIds.add(id);
    const before = this.shipments.length;
    this.shipments = this.shipments.filter((s) => s.id !== id);
    return this.shipments.length < before;
  }

  async getBootstrap(
    user?: BootstrapPayload["user"],
    options: { forceRefresh?: boolean } = {},
  ): Promise<BootstrapPayload> {
    if (options.forceRefresh && this.isSupabaseConfigured) {
      await this.refreshFromSupabase();
    } else {
      await this.initSupabaseSyncAndRealtime();
    }

    this.shipments = this.shipments.filter(
      (s) => !this.deletedShipmentIds.has(s.id) && !isHiddenCustomer(s.customer),
    );
    this.customers = this.customers.filter((c) => !isHiddenCustomer(c.name));
    this.rebuildMergedInbox();
    this.correlateContainerEventsAndNotes();
    this.filterCrmLeadsAgainstCustomers();
    if (!this.supabaseConnected) {
      this.recomputeOfflineCounts();
    }

    const poller = pollerConfigStatus();
    return {
      mode: {
        safeSandbox: this.isSafeSandbox,
        supabaseConnected: this.supabaseConnected,
        realtimeSubscribed: this.realtimeSubscribed,
        taiConfigured: this.isTaiConfigured,
        pollerEnabled: poller.enabled,
        pollerScope: poller.scope,
      },
      supabaseConnected: this.supabaseConnected,
      supabaseError: this.supabaseError,
      lastSyncAt: this.lastSyncAt,
      counts: this.liveCounts,
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
