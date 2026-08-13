# Live backend (PocketBase) — setup

The app works fully **without** a backend (localStorage + export/import). Turning on
PocketBase adds **real-time consolidation** in Super Admin and **fleet config push**.
PocketBase is free and open-source; you self-host it (single binary).

## 1. Run PocketBase

- Download the binary for your OS from **pocketbase.io/docs** (or use a free host like
  PocketHost / Fly.io / a small VPS / an office mini-PC).
- Start it:

```bash
./pocketbase serve --http 0.0.0.0:8090
```

- Open `http://YOUR-HOST:8090/_/`, create the **admin** account.
- Put it behind HTTPS for production (reverse proxy / the host's TLS). GitHub Pages is
  HTTPS, so the backend URL must be HTTPS too, or browsers block mixed content.

## 2. Create three collections

**`locations`** (one row per store/event, upserted by the app)

| field | type |
|---|---|
| `locId` | Text |
| `name` | Text |
| `type` | Text |
| `data` | JSON (or Text) |
| `updated` | Text (or Date) |

**`leads`** (opt-in leads)

| field | type |
|---|---|
| `locId` | Text |
| `email` | Text |
| `mobile` | Text |
| `consent` | Bool |
| `ts` | Text |

**`configs`** (fleet config push)

| field | type |
|---|---|
| `active` | Bool |
| `config` | JSON (or Text) |
| `updated` | Text |

## 3. API rules (prototype vs production)

For a quick pilot you can set **List/View/Create/Update** rules to open (`""`) on
`locations` and `leads`, and List/View open on `configs`. For production, lock this
down — e.g. require an app token, restrict `configs` writes to the admin, and treat
`leads` as PII (least-privilege, retention policy, consent already captured in-app).

## 4. Point the app at it

- Open **`/superadmin.html`** → **Live backend** → Provider = **PocketBase**, paste the
  **URL** (e.g. `https://icolor.pockethost.io`), **Save to this device** (or Download
  `config.default.js` to bake it into the deployed build).
- Each device then mirrors its **location snapshot** (every ~30s) and **leads** to
  PocketBase automatically, and still keeps localStorage (offline-safe).

## 5. Use it

- **Super Admin → “Sync from cloud”** pulls every location live and shows the
  consolidated dashboard across all activations.
- **Super Admin → “Push config to fleet”** writes the current config to `configs`;
  every mirror applies it on next load (remote feature/shade/promo updates — no visit).

## Notes

- All sync is best-effort: if the backend is unreachable, the app silently falls back
  to localStorage and retries later. Nothing breaks offline.
- The PocketBase JS SDK loads from jsDelivr on demand and is cached by the offline
  service worker.
