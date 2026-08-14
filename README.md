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

Run behind a TLS-terminating reverse proxy (the app sets `trust proxy` and marks session cookies `Secure` on HTTPS requests). Point SubscribeStar's webhook setting at `https://<host>/api/webhook/<WEBHOOK_PATH_TOKEN>`.

Operational notes:

- SubscribeStar retries failed deliveries at 5/25/125/625 minutes, then **drops the event** – an outage longer than ~13 hours loses events permanently, so keep the service up and monitored.
- Duplicate deliveries are deduped by `request_id`; events arriving out of order are handled by the state derivation.
- Shipping-address payloads are stripped before storage; the ledger never persists addresses.
