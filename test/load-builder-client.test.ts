import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { LoadEntry } from "../shared/load-entry";

/**
 * Generate Load in TAI — client contract for the Compact Load Builder (the same
 * component the /gmail-panel builder tab mounts). The real component renders in
 * jsdom; only `fetch` is replaced, so no request leaves this process.
 */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1/" });
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;

type FetchCall = { url: string; body: Record<string, unknown> };
type Scripted = { status: number; body: unknown; wait?: Promise<void> };
let fetchCalls: FetchCall[] = [];
let script: Record<string, Scripted[]> = {};

let React: typeof import("react");
let act: typeof import("react").act;
let createRoot: (typeof import("react-dom/client"))["createRoot"];
let CompactLoadBuilder: (typeof import("../client/src/components/CompactLoadBuilder"))["CompactLoadBuilder"];

before(async () => {
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Event: dom.window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    fetchCalls.push({ url, body });
    const queue = script[url];
    const next = queue?.shift();
    if (!next) throw new Error(`Test guard: unscripted fetch to ${url}`);
    if (next.wait) await next.wait;
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  React = await import("react");
  act = React.act;
  ({ createRoot } = await import("react-dom/client"));
  ({ CompactLoadBuilder } = await import("../client/src/components/CompactLoadBuilder"));
});

after(() => {
  globalThis.fetch = originalFetch;
  dom.window.close();
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

beforeEach(() => {
  fetchCalls = [];
  script = {};
});

function sampleEntry(): LoadEntry {
  return {
    shipmentType: "Truckload",
    status: "Committed",
    customer: { name: "Larkin Refractory", taiOrganizationId: "698049" },
    references: { customerPO: "42705", bolNumber: "42705", invoiceRef: "", carrierProNumber: "", pickupNumber: "" },
    stops: [
      {
        stopType: "First Pickup",
        companyName: "CeramSource",
        streetAddress: "400 Enterprise Dr",
        city: "Beaver Falls",
        state: "PA",
        zipCode: "15010",
        country: "USA",
        contactName: "",
        phone: "",
        instructions: "",
        readyDate: "2026-11-18",
        timeOpen: "08:00",
        timeClose: "14:00",
        appointmentRequired: false,
      },
      {
        stopType: "Last Drop",
        companyName: "Larkin Refractory",
        streetAddress: "2331 Varkel Way",
        city: "Lithonia",
        state: "GA",
        zipCode: "30058",
        country: "USA",
        contactName: "",
        phone: "",
        instructions: "",
        readyDate: "2026-11-19",
        timeOpen: "07:00",
        timeClose: "10:00",
        appointmentRequired: true,
      },
    ],
    items: [
      {
        description: "Ceramic Fiber Blankets",
        packagingType: "Pallet",
        handlingQuantity: 6,
        piecesTotal: 6,
        weightTotal: 6644,
        hazardousMaterial: false,
        freightClass: "No Class",
        referenceNumber: "",
      },
    ],
    accessorials: [{ scope: "pickup", code: "TARP", name: "Tarp Fee", sell: 150, buy: 100 }],
    equipment: { trailerSize: "Full", trailerType: "48 ft Flatbed | Tarp", equipmentLength: "48", mileage: 648, stackable: false },
    pricing: { linehaulSell: 2850, fuelSell: 0, linehaulBuy: 2300, fuelBuy: 0 },
    carrier: { name: "", serviceLevel: "Normal" },
    specialInstructions: "",
    sendToTai: true,
  };
}

const PREVIEW_URL = "/api/loads/preview";
const BOOK_URL = "/api/loads/book";
const TOKEN = "synthetic-preview-token";

function previewOk(): Scripted {
  return { status: 200, body: { ok: true, previewToken: TOKEN, request: { fixture: true }, issues: [] } };
}

function harness(initial: LoadEntry, compact = false) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const booked: Array<{ ids: string[]; msg: string }> = [];
  const toasts: string[] = [];
  let latestEntry = initial;
  let setEntryFromTest: React.Dispatch<React.SetStateAction<LoadEntry>> = () => {};

  const Host: React.FC = () => {
    const [entry, setEntry] = React.useState(initial);
    latestEntry = entry;
    setEntryFromTest = setEntry;
    return React.createElement(CompactLoadBuilder, {
      compact,
      entry,
      onChange: setEntry,
      facilities: [],
      customers: [],
      carriers: [],
      onBooked: (ids: string[], msg: string) => booked.push({ ids, msg }),
      onToast: (msg: string) => toasts.push(msg),
    });
  };

  const query = (id: string) => container.querySelector(`[data-testid="${id}"]`);
  return {
    container,
    booked,
    toasts,
    get entry() {
      return latestEntry;
    },
    setEntry(update: React.SetStateAction<LoadEntry>) {
      setEntryFromTest(update);
    },
    async render() {
      await act(async () => root.render(React.createElement(Host)));
    },
    find<T extends Element>(id: string): T {
      const node = query(id);
      assert.ok(node, `expected [data-testid="${id}"]`);
      return node as T;
    },
    has(id: string) {
      return Boolean(query(id));
    },
    async click(id: string) {
      await act(async () => (this.find<HTMLButtonElement>(id)).click());
    },
    async close() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("the action is labelled Generate Load in TAI and opens the existing confirm with customer, lane and rate", async () => {
  const h = harness(sampleEntry());
  try {
    await h.render();
    assert.match(h.find("button-clb-generate").textContent ?? "", /^Generate Load in TAI/);
    assert.equal(h.has("dialog-clb-confirm"), false);

    await h.click("button-clb-generate");
    assert.match(h.find("dialog-clb-confirm").textContent ?? "", /Generate this load in TAI\?/);
    assert.equal(h.find("text-clb-confirm-customer").textContent, "Larkin Refractory");
    assert.equal(h.find("text-clb-confirm-lane").textContent, "Beaver Falls, PA 15010 → Lithonia, GA 30058");
    assert.equal(
      h.find("text-clb-confirm-rate").textContent,
      `$${(3000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    );
    assert.equal(fetchCalls.length, 0, "opening the confirm sends nothing");
  } finally {
    await h.close();
  }
});

test("a missing sell rate shows Pending / TBD in the confirm", async () => {
  const entry = sampleEntry();
  entry.pricing.linehaulSell = 0;
  entry.accessorials = [];
  const h = harness(entry, true);
  try {
    await h.render();
    await h.click("button-clb-generate");
    assert.equal(h.find("text-clb-confirm-rate").textContent, "Pending / TBD");
  } finally {
    await h.close();
  }
});

test("Cancel books nothing: no preview, no create, no onBooked", async () => {
  const h = harness(sampleEntry());
  try {
    await h.render();
    await h.click("button-clb-generate");
    await h.click("button-clb-confirm-cancel");
    assert.equal(h.has("dialog-clb-confirm"), false);
    assert.equal(fetchCalls.length, 0);
    assert.equal(h.booked.length, 0);
  } finally {
    await h.close();
  }
});

test("OK runs the server preview first and sends its token with the create", async () => {
  script = {
    [PREVIEW_URL]: [previewOk()],
    [BOOK_URL]: [{ status: 200, body: { ok: true, createdIds: ["132799001"], message: "Generated 1 load(s) in TAI: #132799001" } }],
  };
  const h = harness(sampleEntry());
  try {
    await h.render();
    await h.click("button-clb-generate");
    await h.click("button-clb-confirm-ok");

    assert.deepEqual(fetchCalls.map((c) => c.url), [PREVIEW_URL, BOOK_URL]);
    assert.deepEqual(fetchCalls[0].body.entry, sampleEntry(), "preview sees the exact entry");
    assert.equal(fetchCalls[0].body.duplicateCount, 1, "preview is told the order Qty the token must cover");
    assert.equal(fetchCalls[1].body.previewToken, TOKEN);
    assert.equal(fetchCalls[1].body.duplicateCount, 1);
    assert.equal("confirmDuplicate" in fetchCalls[1].body, false);
    assert.deepEqual(h.booked, [{ ids: ["132799001"], msg: "Generated 1 load(s) in TAI: #132799001" }]);
    assert.equal(h.has("dialog-clb-confirm"), false);
  } finally {
    await h.close();
  }
});

test("a failed preview stops before create and shows the validator message", async () => {
  script = {
    [PREVIEW_URL]: [{ status: 422, body: { ok: false, issues: [{ field: "stops.0.zipCode", message: "Origin zip code is required (5-digit US ZIP)" }] } }],
  };
  const h = harness(sampleEntry());
  try {
    await h.render();
    await h.click("button-clb-generate");
    await h.click("button-clb-confirm-ok");
    assert.deepEqual(fetchCalls.map((c) => c.url), [PREVIEW_URL]);
    assert.equal(h.booked.length, 0);
    assert.match(h.find("text-clb-booking-error").textContent ?? "", /Origin zip code is required/);
    assert.equal(h.has("dialog-clb-confirm"), true, "stays open so the operator reads the reason");
    assert.equal(h.find<HTMLFieldSetElement>("fieldset-clb-form").disabled, false, "form unlocks after the failure");
  } finally {
    await h.close();
  }
});

test("a TAI refusal or sandbox answer on create is shown verbatim, offers a retry, and nothing is treated as booked", async () => {
  script = {
    [PREVIEW_URL]: [previewOk(), previewOk()],
    [BOOK_URL]: [
      { status: 502, body: { ok: false, createdIds: [], message: "TAI answered 400: customerId: customerId is required" } },
      { status: 503, body: { ok: false, createdIds: [], liveWritesEnabled: false, message: "Live TAI writes are switched off on this server." } },
    ],
  };
  const h = harness(sampleEntry());
  try {
    await h.render();
    await h.click("button-clb-generate");
    await h.click("button-clb-confirm-ok");
    assert.match(h.find("text-clb-booking-error").textContent ?? "", /TAI answered 400: customerId: customerId is required/);
    assert.match(h.find("button-clb-confirm-ok").textContent ?? "", /Retry/, "a definite TAI refusal is safe to retry");
    await h.click("button-clb-confirm-ok");
    assert.match(h.find("text-clb-booking-error").textContent ?? "", /Live TAI writes are switched off/);
    assert.equal(h.booked.length, 0);
    assert.equal(fetchCalls.filter((c) => c.url === BOOK_URL).length, 2);
  } finally {
    await h.close();
  }
});

test("an uncertain outcome (TAI accepted without an id, or the create answer was lost) offers no retry and tells the operator to check TAI", async () => {
  script = {
    [PREVIEW_URL]: [previewOk()],
    [BOOK_URL]: [{ status: 409, body: { ok: false, createdIds: [], requiresReconciliation: true, message: "TAI accepted the request but its answer carried no Shipment ID." } }],
  };
  const h = harness(sampleEntry());
  try {
    await h.render();
    await h.click("button-clb-generate");
    await h.click("button-clb-confirm-ok");
    const notice = h.find("panel-clb-reconcile").textContent ?? "";
    assert.match(notice, /TAI may already hold this load/);
    assert.match(notice, /no Shipment ID/);
    assert.match(notice, /Nothing was saved here/);
    assert.match(notice, /PO 42705 · BOL 42705/);
    assert.equal(h.has("text-clb-reconcile-saved"), false);
    assert.equal(h.has("button-clb-confirm-ok"), false, "no ordinary retry while the outcome is unknown");
    assert.equal(h.has("button-clb-confirm-duplicate"), false);
    assert.equal(h.has("text-clb-booking-error"), false);
    assert.match(h.find("button-clb-confirm-cancel").textContent ?? "", /Check TAI/);
    assert.equal(h.booked.length, 0);
    assert.equal(fetchCalls.filter((c) => c.url === BOOK_URL).length, 1);
    await h.click("button-clb-confirm-cancel");
    assert.equal(h.has("dialog-clb-confirm"), false);

    // Closing does not clear the guard: reopening shows the same notice and still no OK,
    // and the notice names the customer the uncertain request was sent for even if the
    // form was edited in between.
    assert.match(h.find("button-clb-generate").textContent ?? "", /Check TAI · Outcome Unknown/);
    await act(async () => h.setEntry((prev) => ({ ...prev, customer: { ...prev.customer, name: "Someone Else Inc" } })));
    await h.click("button-clb-generate");
    const reopened = h.find("panel-clb-reconcile").textContent ?? "";
    assert.match(reopened, /Larkin Refractory · PO 42705/);
    assert.doesNotMatch(reopened, /Someone Else Inc/);
    assert.equal(h.has("button-clb-confirm-ok"), false, "still no retry after close + reopen");
    assert.equal(fetchCalls.length, 2, "reopening sends nothing");

    // Only the explicit 'I checked TAI' acknowledgement restores Generate.
    await h.click("button-clb-reconcile-resolved");
    assert.equal(h.has("panel-clb-reconcile"), false);
    h.find("button-clb-confirm-ok");
    await h.click("button-clb-confirm-cancel");
    assert.match(h.find("button-clb-generate").textContent ?? "", /^Generate Load in TAI/);
  } finally {
    await h.close();
  }

  // Partial batch: TAI confirmed the first order, the second is uncertain. The notice must
  // name what was saved and the exact suffixed PO still to check — not the base PO.
  fetchCalls = [];
  script = {
    [PREVIEW_URL]: [previewOk()],
    [BOOK_URL]: [
      {
        status: 409,
        body: {
          ok: false,
          createdIds: ["132799020"],
          requiresReconciliation: true,
          pendingReference: { customerPO: "ORDER-2", bolNumber: "" },
          message: "TAI accepted the request but its answer carried no Shipment ID. TAI did confirm 1 load(s) before this: #132799020.",
        },
      },
    ],
  };
  const batchEntry = sampleEntry();
  batchEntry.references.customerPO = "ORDER";
  batchEntry.references.bolNumber = "";
  const batch = harness(batchEntry);
  try {
    await batch.render();
    await batch.click("button-clb-generate");
    await batch.click("button-clb-confirm-ok");
    assert.match(batch.find("text-clb-reconcile-saved").textContent ?? "", /#132799020/);
    const pending = batch.find("text-clb-reconcile-pending").textContent ?? "";
    assert.match(pending, /remaining order was not saved here/);
    assert.match(pending, /PO ORDER-2/);
    assert.doesNotMatch(pending, /PO ORDER\b(?!-)/, "the base PO is not what needs checking");
    assert.equal(batch.has("button-clb-confirm-ok"), false);
    assert.equal(batch.booked.length, 0);
  } finally {
    await batch.close();
  }

  // Lost create answer: the request left the browser, so TAI may have it.
  fetchCalls = [];
  script = { [PREVIEW_URL]: [previewOk()], [BOOK_URL]: [] };
  const lost = harness(sampleEntry());
  try {
    await lost.render();
    await lost.click("button-clb-generate");
    await lost.click("button-clb-confirm-ok");
    const lostText = lost.find("panel-clb-reconcile").textContent ?? "";
    assert.match(lostText, /answer never arrived/);
    assert.match(lostText, /PO 42705/);
    assert.equal(lost.has("button-clb-confirm-ok"), false);
    assert.equal(lost.booked.length, 0);
  } finally {
    await lost.close();
  }

  // Lost preview answer: preview never touches TAI, so an ordinary retry stays available.
  fetchCalls = [];
  script = { [PREVIEW_URL]: [] };
  const lostPreview = harness(sampleEntry());
  try {
    await lostPreview.render();
    await lostPreview.click("button-clb-generate");
    await lostPreview.click("button-clb-confirm-ok");
    assert.match(lostPreview.find("text-clb-booking-error").textContent ?? "", /Could not reach the ops server/);
    assert.equal(lostPreview.has("panel-clb-reconcile"), false);
    assert.match(lostPreview.find("button-clb-confirm-ok").textContent ?? "", /Retry/);
    assert.equal(fetchCalls.filter((c) => c.url === BOOK_URL).length, 0);
  } finally {
    await lostPreview.close();
  }
});

test("duplicate guard is an inline step in the same confirm: only its Yes re-sends with confirmDuplicate", async () => {
  script = {
    [PREVIEW_URL]: [previewOk(), previewOk()],
    [BOOK_URL]: [
      {
        status: 409,
        body: {
          ok: false,
          createdIds: [],
          requiresDuplicateConfirmation: true,
          duplicateOf: "132742212",
          matchedOn: "shipper reference",
          message: "Load #132742212 is already booked in TAI for Larkin Refractory with the same shipper reference (42705).",
        },
      },
      { status: 200, body: { ok: true, createdIds: ["132799003"], message: "Generated 1 load(s) in TAI: #132799003" } },
    ],
  };
  const h = harness(sampleEntry(), true);
  try {
    await h.render();
    await h.click("button-clb-generate");
    await h.click("button-clb-confirm-ok");
    assert.match(h.find("panel-clb-duplicate").textContent ?? "", /Possible duplicate of Load #132742212/);
    assert.equal(h.has("button-clb-confirm-ok"), false, "the plain OK is replaced by the explicit duplicate choice");
    assert.equal(h.booked.length, 0);
    assert.equal(fetchCalls.filter((c) => c.url === BOOK_URL).length, 1);

    await h.click("button-clb-confirm-duplicate");
    const books = fetchCalls.filter((c) => c.url === BOOK_URL);
    assert.equal(books.length, 2);
    assert.equal(books[0].body.confirmDuplicate, undefined);
    assert.equal(books[1].body.confirmDuplicate, true);
    assert.equal(books[1].body.previewToken, TOKEN);
    assert.deepEqual(h.booked.map((b) => b.ids), [["132799003"]]);
    assert.equal(h.has("dialog-clb-confirm"), false);
  } finally {
    await h.close();
  }
});

test("Cancel on the duplicate step books nothing", async () => {
  script = {
    [PREVIEW_URL]: [previewOk()],
    [BOOK_URL]: [{ status: 409, body: { ok: false, createdIds: [], requiresDuplicateConfirmation: true, duplicateOf: "132742212", message: "dup" } }],
  };
  const h = harness(sampleEntry());
  try {
    await h.render();
    await h.click("button-clb-generate");
    await h.click("button-clb-confirm-ok");
    h.find("panel-clb-duplicate");
    await h.click("button-clb-confirm-cancel");
    assert.equal(h.has("dialog-clb-confirm"), false);
    assert.equal(fetchCalls.filter((c) => c.url === BOOK_URL).length, 1);
    assert.equal(h.booked.length, 0);
  } finally {
    await h.close();
  }
});

test("while generating, the form is locked, the confirm cannot be closed and a second click does nothing", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  script = {
    [PREVIEW_URL]: [{ ...previewOk(), wait: gate }],
    [BOOK_URL]: [{ status: 200, body: { ok: true, createdIds: ["132799004"], message: "ok" } }],
  };
  const h = harness(sampleEntry());
  try {
    await h.render();
    await h.click("button-clb-generate");
    await h.click("button-clb-confirm-ok");

    assert.equal(fetchCalls.length, 1, "preview in flight");
    assert.equal(h.find<HTMLFieldSetElement>("fieldset-clb-form").disabled, true);
    assert.equal(h.find<HTMLButtonElement>("button-clb-generate").disabled, true);
    assert.equal(h.find<HTMLButtonElement>("button-clb-confirm-ok").disabled, true);
    assert.equal(h.find<HTMLButtonElement>("button-clb-confirm-cancel").disabled, true);

    await h.click("button-clb-confirm-ok");
    await h.click("button-clb-confirm-cancel");
    await act(async () => h.find<HTMLElement>("dialog-clb-confirm").click());
    assert.equal(fetchCalls.length, 1, "no second preview");
    assert.equal(h.has("dialog-clb-confirm"), true, "cannot close mid-flight");

    await act(async () => {
      release();
      await gate;
    });
    await act(async () => {});
    assert.deepEqual(fetchCalls.map((c) => c.url), [PREVIEW_URL, BOOK_URL]);
    assert.deepEqual(h.booked.map((b) => b.ids), [["132799004"]]);
    assert.equal(h.has("dialog-clb-confirm"), false);
    assert.equal(h.find<HTMLFieldSetElement>("fieldset-clb-form").disabled, false);
  } finally {
    await h.close();
  }
});
