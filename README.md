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

   **Auth fails closed in production.** When `NODE_ENV=production` (the Docker image) or `APP_BASE_URL` points anywhere other than loopback (e.g. `https://fivenines-ops.fly.dev`), the server **requires** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `SESSION_SECRET`. If any is missing it logs the missing names (never values) and refuses to boot; if it is somehow reached anyway, every `/api/*` route returns `503`. Unauthenticated requests get `401` (`/api/me` reports `authenticated: false`; `/healthz` and the TAI webhook routes stay public). `AUTH_DISABLED=true` is ignored in production and there is **no** local-preview identity or session-secret fallback. Generate `SESSION_SECRET` with `openssl rand -hex 32` and never reuse the Supabase service-role key.
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
- **Local preview without Google sign-in**: leave `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` blank (or set `AUTH_DISABLED=true`) and keep `APP_BASE_URL` on `127.0.0.1`/`localhost`. The preview identity is only granted to requests arriving over a loopback socket and never in production.
- **Standalone Gmail Side-Panel Route**: `http://127.0.0.1:5090/gmail-panel`
- **Chrome MV3 Extension**: Update `gmail-extension/sidepanel.html` + `manifest.json` host to `https://fivenines-ops.fly.dev` when deployed, and load unpacked in `chrome://extensions`.
