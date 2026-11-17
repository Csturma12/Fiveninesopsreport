# Five Nines Operations Platform & Compact Gmail Freight Toolkit (v2)

Clean-slate rebuild of the **Primary Freight / Five Nines Operations Dashboard** and **Shared-Host Gmail Freight Toolkit** (`#0F1217` Paper Dark + `#3EBF82` Emerald + `#F0641E` Action Orange + `#F4F6FA` Primary Light toggle), engineered to eliminate the endless vertical scrolling of the legacy Load Builder while supporting **100% live Supabase Realtime, Google Workspace Auth, TAI Booking, Webhooks, and Carrier/Buy Write-Back**.

---

## Deploying Side-by-Side on Fly.io (`fivenines-ops`)

You can run `fivenines-ops` live alongside `primary-freight-dashboard` against the **same Supabase database, same Google OAuth credentials, and same TAI API key**:

1. **Create the new Fly app** (`dfw` region):
   ```bash
   flyctl apps create fivenines-ops
   ```
2. **Add `https://fivenines-ops.fly.dev/auth/google/callback`** as an Authorized Redirect URI (and `https://fivenines-ops.fly.dev` as an Authorized JavaScript Origin) on your existing Google Cloud OAuth 2.0 Web Client.
3. **Set Fly secrets** (copying the values you already use on `primary-freight-dashboard`):
   ```bash
   flyctl secrets set -a fivenines-ops \
     SUPABASE_URL="https://nonqwidfqrklksjluloz.supabase.co" \
     SUPABASE_SERVICE_ROLE_KEY="<your-supabase-service-role-key>" \
     GOOGLE_CLIENT_ID="<your-google-oauth-client-id>" \
     GOOGLE_CLIENT_SECRET="<your-google-oauth-client-secret>" \
     SESSION_SECRET="<random-32-byte-hex>" \
     ALLOW_LIVE_TAI_WRITES="true" \
     TAI_WRITEBACK_POLLER_ENABLED="false"
   ```
   *(Also set your existing TAI API key secret and optional `TAI_WEBHOOK_SECRET` on `fivenines-ops`.)*
4. **Deploy**:
   ```bash
   flyctl deploy -a fivenines-ops
   ```
   *(Or add `FLY_API_TOKEN` to GitHub repo secrets—`.github/workflows/fly-deploy.yml` will auto-deploy every push to `main`.)*

### How Dual-App Poller & Webhooks Work Together
- **Why `TAI_WRITEBACK_POLLER_ENABLED="false"` works live right away**: Even when you are the only human user, a poller is an automated 15-second background timer inside the server. Keeping `TAI_WRITEBACK_POLLER_ENABLED="false"` on `fivenines-ops` means when you click **Queue TAI Write** in `fivenines-ops`, it inserts the row into Supabase `tai_carrier_assignments` and waits up to 45s while `primary-freight-dashboard`'s background timer sends `PUT CarrierCharges` + verifies `GET /Shipments/{id}` read-back, turning green in **both** apps!
- **Testing `fivenines-ops`'s own poller**: If you want `fivenines-ops` itself to execute the `PUT CarrierCharges` calls for actions taken in `fivenines-ops`, set `TAI_WRITEBACK_POLLER_ENABLED="true"` and `TAI_WRITEBACK_POLLER_SCOPE="own"` (atomic row claim ensures no double-PUTs). When retiring the old app later, set `TAI_WRITEBACK_POLLER_SCOPE="all"`.
- **Live Webhooks**: `fivenines-ops` subscribes to **Supabase Realtime (`postgres_changes`)** on `shipments` and `tai_carrier_assignments` and pushes updates to your browser via `/api/events` SSE within ~1s of any TAI webhook landing on `primary-freight-dashboard`. It also exposes `/api/webhooks/tai/shipment` and `/api/webhooks/tai/invoice` directly (and supports `TEE_WEBHOOK_URL` forwarding).

---

## Local Development
```bash
npm install
npm run check
npm test
npm run dev
```
- **Dashboard + Docked 410px Gmail Panel**: `http://127.0.0.1:5090`
- **Standalone Gmail Side-Panel Route**: `http://127.0.0.1:5090/gmail-panel`
- **Chrome MV3 Extension**: Update `gmail-extension/sidepanel.html` + `manifest.json` host to `https://fivenines-ops.fly.dev` when deployed, and load unpacked in `chrome://extensions`.

### Generate Load in TAI (Compact Builder & `/gmail-panel`)
One click, always behind the **Generate this load in TAI?** confirm (customer, lane, customer rate):
1. `POST /api/loads/preview` validates the entry, builds the exact `CommitDomesticShipmentRequest` and returns a `previewToken` bound to the entry, that request and the order Qty (no TAI call).
2. `POST /api/loads/book` with that `previewToken` (and the same Qty) creates the shipment in TAI. It refuses when the token is missing/stale (`409 requiresPreview`), asks before booking the same customer + PO/BOL twice (`409 requiresDuplicateConfirmation` → resend with `confirmDuplicate: true`), refuses when live writes are off (`503`), returns TAI's own body on refusal (`502`), and answers `requiresReconciliation` when TAI accepts without a shipment id (`409`) or the call times out / drops after being sent (`502`) — in both cases the UI offers no retry and names the exact PO/BOL to look up in TAI.

**Duplicate-check scope**: the guard compares against the loads this server holds in memory (seeded rows plus the ~40 most recently updated Supabase `shipments`, and anything generated in this process). It is a safety prompt against re-booking a recent order, not an exhaustive TAI search; older TAI loads are not seen. Bookings for the same customer are serialized in-process so two concurrent clicks cannot both pass the check.

TAI is the source of record: nothing is saved locally or to Supabase unless TAI confirmed a shipment id, and there is no sandbox-minted id. Locally (no `ALLOW_LIVE_TAI_WRITES="true"` + TAI key) the button validates, previews and then refuses loudly with "Live TAI writes are switched off". The TAI key never leaves the server; the Gmail extension only iframes `/gmail-panel`.
