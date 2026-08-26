# F-List Ledger

A small self-hosted ledger for the F-List SubscribeStar account.

It listens for SubscribeStar webhooks, verifies and stores every event durably in SQLite, derives each subscriber's current state, and shows staff a color-coded event feed.

- **Backend**: Express, TypeScript run natively by Node (no build step), `node:sqlite`.
- **Client**: Vite + vanilla TypeScript + Sass SPA.
- Staff access uses individual accounts with invite-only registration; the webhook endpoint authenticates via HMAC signature, not sessions.

## Configuration

All configuration is via environment variables:

| Variable | Required | Purpose |
|---|---|---|
| `SESSION_SECRET` | prod | Session cookie signing key |
| `WEBHOOK_SECRET` | prod | HMAC secret from SubscribeStar's webhook settings |
| `WEBHOOK_PATH_TOKEN` | prod | Random string; the webhook URL becomes `/api/webhook/<token>` |
| `BOOTSTRAP_INVITE_TOKEN` | first run | One-time invite for creating the first staff account |
| `PORT` | no | Default `3000` |
| `DB_PATH` | no | Default `data/ledger.db` (relative to the backend working directory) |
| `NODE_ENV` | no | `production` enforces the required variables above |

In dev, missing secrets fall back to ephemeral/known values with a console warning.

## Development

```sh
npm install
npm run dev        # backend on :3000 + Vite dev server on :5173 (proxies /api)
```

**App is served at http://localhost:5173/ during development** – that's the Vite dev server with live reload. The backend on `:3000` also serves a UI, but it's the last *built* copy from `client/dist/` (possibly stale or missing); in dev it only matters as the API the Vite proxy forwards to.

First account: set `BOOTSTRAP_INVITE_TOKEN` in `.env`, then visit `/register?token=<that value>`. It only works while no accounts exist; afterwards, use the "Generate invite" button (single-use links, 7-day expiry).

To feed the ledger locally, POST webhook payloads signed with your `WEBHOOK_SECRET` (hex HMAC-MD5 of the raw body in the `X-SubscribeStar-Signature` header) to `/api/webhook/<WEBHOOK_PATH_TOKEN>`.

```sh
npm test           # unit tests (node:test)
npm run typecheck
npm run lint
```

## Production

```sh
docker compose up --build -d
```

Compose refuses to start unless `SESSION_SECRET`, `WEBHOOK_SECRET`, and `WEBHOOK_PATH_TOKEN` are set (environment or `.env`). The SQLite database lives in the `data` named volume – back that up.

The app binds to `127.0.0.1:${PORT}` on the host (default 3000) — loopback only, so the reverse proxy is the sole public entry point. Inside the container the app always listens on 3000; `PORT` in `.env` controls only the host-side port.

The app is subpath-agnostic: it can be mounted at the domain root or under a prefix (e.g. `location /_ledger/ { proxy_pass http://127.0.0.1:8080/; ... }` — the trailing slash on `proxy_pass` strips the prefix, which the app expects). Assets are built with relative URLs and the client derives its mount point from the page URL at runtime. Always access it with the trailing slash (`/_ledger/`, not `/_ledger`).

Run behind a TLS-terminating reverse proxy (the app sets `trust proxy` and marks session cookies `Secure` on HTTPS requests). Point SubscribeStar's webhook setting at `https://<host>/api/webhook/<WEBHOOK_PATH_TOKEN>`.

## Importing subscriber data from CSV

A CLI imports the staff workbook export (the 16-column "Work list" CSV). It fills the manual columns (`flist_account`, `notes`) for subscribers the ledger already knows — **fill-only**: values entered through the UI are never overwritten — and creates placeholder rows (`seeded = 1`) for subscribers that haven't produced webhook events yet. Derived state is never touched; the CSV's `status` column is not trusted at all. Seeded rows start with status `imported` and flip to `active` (a visible change in the "changed since" view) as each subscriber's next renewal payment confirms them; rows still `imported` after a full billing cycle are your lapsed-or-prepaid follow-up list.

```sh
npm run import -w backend -- path/to/export.csv            # dry run: prints the plan, writes nothing
npm run import -w backend -- path/to/export.csv --apply    # commits (single transaction)
```

Always read the dry-run report first. It lists rows that need human attention: rows without a SubscribeStar id, unresolvable duplicate ids, tier titles that don't match any name in the Tiers panel (name tiers **before** importing so tier assignments resolve), and places where the CSV disagrees with values already in the database (the database wins).

Re-running the import is safe — an unchanged CSV produces zero writes.

Against the production container:

```sh
docker compose cp export.csv app:/app/data/import.csv
docker compose exec app node backend/src/import-csv.ts /app/data/import.csv          # dry run
docker compose exec app node backend/src/import-csv.ts /app/data/import.csv --apply
```

Operational notes:

- SubscribeStar retries failed deliveries at 5/25/125/625 minutes, then **drops the event** – an outage longer than ~13 hours loses events permanently, so keep the service up and monitored.
- Duplicate deliveries are deduped by `request_id`; events arriving out of order are handled by the state derivation.
- Shipping-address payloads are stripped before storage; the ledger never persists addresses.
