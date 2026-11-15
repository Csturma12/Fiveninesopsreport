# Five Nines Operations Platform & Compact Gmail Freight Toolkit (v2)

Clean-slate rebuild of the **Primary Freight / Five Nines Operations Dashboard** and **Shared-Host Gmail Freight Toolkit** based on the **Paper** design system (`#0F1217` Paper Dark + `#3EBF82` Emerald + `#F0641E` Action Orange + `#F4F6FA` Primary Light toggle), engineered specifically to eliminate the endless vertical scrolling of the legacy Load Builder while preserving **100% TAI Domestic Shipment registration, webhook, and write-back compatibility**.

## What Changed vs. Legacy
1. **Ultra-Compact Zero-Scroll Load Builder (`client/src/components/CompactLoadBuilder.tsx`)**
   - Designed to fit cleanly inside the **410px Gmail Side Panel** without 5 screens of scrolling.
   - Captures every mandatory TAI field inline:
     - **Origin & Destination (Multi-Stop)** with mandatory **5-digit ZIP** (auto-fills City & State + matches Saved TAI Locations).
     - **`Items to Ship` (Commodities)** in a single compact row per line: **Piece Count\***, **Package Type**, **Total Weight (lbs)\***, and **Commodity Description\***.
     - **Canonical TAI Equipment** (`TAI_CREATE_TRAILER_TYPES`) + **Optional TAI Customer Link** (`customerId` omitted cleanly when unlinked so spot/unlinked customers still register in TAI).
     - **Live Margin Calculator** (`Sell` vs. `Buy` → `$` and `%` Margin), with Fuel Split, Accessorials, Special Instructions, and Historical Lane Runners tucked into a clean on-demand drawer.
     - Single action bar with **Book in TAI (`×1..10` Duplicate)** + compact **Docs & JSON** menu (`Generate BOL Only`, `Formal Customer Quote`, `PDF RateCon Sheet`, and live `CommitDomesticShipmentRequest` JSON preview).
2. **Crucial-Only Action Inbox (`/`)**
   - Zero general inbox clutter: surfaces **only** Unbooked Customer Tenders (1-click extraction to Compact Builder), Active Load PO/Rate Mismatches, and Delivered Loads Missing PODs.
   - In `/gmail-panel`, the top card always reflects the **currently open Gmail thread**.
3. **Unified Dispatch (`/dispatch`)**
   - Clicking any load expands **1 load inline at full width** with complete Stops + ZIPs, Commodities + Pieces + Weight, TAI Sync status, and inline Carrier + Buy Write-Back & POD upload controls.
4. **TAI Webhooks & Fly Poller Write-Back Compatibility (`server/tai-service.ts`)**
   - Inbound webhooks: `POST /api/webhooks/tai` (`ShipmentDetailUpdateUrl`) and `POST /api/webhooks/tai/invoice` (`InvoiceCreateWithShipmentUrl`).
   - Outbound carrier + buy write-back: Enqueues to `tai_carrier_assignments` for Fly's sole `tai-writeback-poller.ts` worker (never spawns a competing poller).
   - Runs in **Safe Sandbox Mode** by default (`ALLOW_LIVE_TAI_WRITES=false`).

## Quick Start
```bash
npm install
npm run check
npm test
npm run dev
```
- **Dashboard + Docked 410px Gmail Panel**: `http://127.0.0.1:5090`
- **Standalone Gmail Side-Panel Route**: `http://127.0.0.1:5090/gmail-panel`
- **Chrome MV3 Extension Wrapper**: Load `gmail-extension/` unpacked in `chrome://extensions`
