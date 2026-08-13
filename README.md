# iColor Plus — Live Hair Color Try-On

A browser-based **AR hair-color filter** for the iColor Plus brand (Philippines).
Users point their device camera (phone, tablet, laptop, or desktop) at themselves,
tap an iColor Plus shade, and see the color applied to their hair **live**. They can
then **capture a photo** or **record a 30-second video** — both saved directly to
their own device. No images or video ever leave the browser.

## Features

- 🛠️ **Admin console + package tiers** — `/admin.html` lets you turn features on/off, add/edit/hide/reorder colours, and ship anything from a Basic 5-colour filter to an All-in analysis+print package (see below)
- 📱 **QR-to-phone handoff**, ⭐ **shade-of-the-week promo banner** (with poster upload), 🎟️ **coupon on the A5 report**, 📧 **opt-in lead capture** (consent-only, CSV export), ⏰ **time-of-day heatmap + dwell**, ✨ **"get this look"** (match a shade from an inspiration photo), 🌐 **Tagalog/English toggle**, 📴 **offline PWA** — all Super-Admin-gated feature toggles
- ☁️ **Optional live backend** (self-hosted PocketBase) for real-time consolidation + fleet config push — see [POCKETBASE.md](POCKETBASE.md); works fully offline without it
- 📊 **Usage analytics + two-tier back-office** — client dashboard (`/analytics.html`) tracks try-ons per SKU, sessions, captures, undertone mix and more, tagged by store/event; a Mineski **Super Admin** (`/superadmin.html`) controls the client's admin view and sees consolidated analytics across all activations

- 🎥 **Live AR filter** using the device camera via `getUserMedia`
- 🖼️ **Upload a selfie** instead of using the camera — the same analysis runs on the still photo
- 🧪 **Realistic dye mixing** — the color you see is the dye pigment *mixed with your real hair color*, so results depend on your starting shade (dark hair resists pale colors; reds/coppers show through), like a lightweight hair analysis
- 🟢 **Live hair-detection status** — a badge shows whether hair is detected (and GPU/CPU), with automatic CPU fallback if the GPU delegate returns an empty mask
- 🔬 **Hair & skin analysis with recommendations** — reads your hair level/undertone and skin depth/undertone from the photo, then recommends iColor Plus shades that flatter your skin tone, with **how to apply** and **how to care for it** using iColor products (auto-opens after an upload; also available any time from the ✨ button)
- ✨ **Statement / bold colour picks** — beyond the natural matches, it suggests lively shades (blue, red, berry, purple) that still suit your undertone, and explains **how to go brighter** (lightening/bleaching, done healthily) based on your hair level
- 🏷️ **"Why this shade" tags** — every recommendation carries a short reason (Warm & flattering, Low-upkeep match, Bold contrast…)
- 🎚️ **Filter by vibe** — view recommendations as **Natural**, **Bold**, or **Low-maintenance**
- ✅ **Rate your own picks** — choose up to 3 colours you like + 2 statement shades and get a per-shade verdict (Great / Works with effort / Bold — your call / Not your best) with the reasoning, including **what doesn't suit you and why**
- 🖨️ **Shareable branded cards** — a high-resolution card with your photo, profile, recommended + bold shades, and a "go brighter" tip. Pick **Square 1:1 (1080×1080)** or **Portrait 4:5 (1080×1350)** for social, then:
  - **Share** posts the card via the device share sheet (Web Share API on mobile)
  - **Save** downloads it as a social-ready image
  - **Print** fits an **A5 landscape** version to one page
- 💇 **Real-time hair segmentation** with Google MediaPipe (runs 100% on-device)
- 🎨 **Full iColor Plus shade picker** — the complete product line (Flagship, Ash & Crème, For Men, Timeless, Collab, and Blonde Prep), grouped by collection; tap a product to recolor hair instantly
- ↔️ **Before/after split view** — drag a divider to compare original vs. colored
- ▦ **Compare grid** — see the live camera with every shade applied at once; tap a cell to go straight to that shade
- 🧾 **Save comparison sheet** — export one branded, labeled image showing your photo in every iColor Plus shade side by side
- 🎚️ **Intensity slider** to tune how strong the color looks
- ☀️ **Brighten toggle** — lifts luminance so pastel and blonde shades (Ash Pink, Vanilla Blonde, Nude Beige…) show vividly on dark hair
- 📷 **Photo capture** (JPEG) and 🎬 **30-second video capture** (MP4/WebM) — works in single, split, or grid view
- 💾 **On-device only** — captures download straight to the user's device; nothing is uploaded
- 🔄 Front/back **camera switch**, selfie mirroring
- 🖼️ In-app **gallery** to review and re-download captures
- 📱 Responsive — works on phones, tablets, laptops, and desktops

## How the color effect works

1. Each camera frame (or uploaded photo) is passed to MediaPipe's **hair
   segmentation** model, which returns a per-pixel confidence mask of where hair is.
2. For every hair pixel, the app **mixes the person's real hair color with the dye
   pigment** using a subtractive (multiply) model — the same physics as depositing
   color on hair. A dye can therefore only deposit/darken and tone; it can't lighten.
   That's why the preview depends on the starting hair color: pale shades barely show
   on dark hair, while reds and coppers tint through. Highlights keep a touch of sheen
   so the result still reads as real hair, not a flat sticker.
3. The **Brighten** toggle pre-lightens the simulated base — standing in for
   pre-lightened/bleached hair — so pastels and blondes can show on dark hair.
4. The mask confidence + intensity slider drive an alpha blend for soft, realistic edges.

Because it's a lightweight *hair analysis*, the honest default is that many shades look
subtle on very dark hair — which is what actually happens with a shampoo-in color.
Use Brighten to preview how they'd look on pre-lightened hair.

## Admin console & package tiers

The app is **config-driven** so you can sell it in tiers — from a **Basic** filter
(5 colours, nothing else) up to an **All-in** package (analysis + save/share/print).

- Open **`/admin.html`** and enter the passcode (default `icolor`, set in
  [`config.default.js`](config.default.js) → `admin.passcode`).
- **Pick a tier preset** (Basic / Standard / Pro / All-in) or fine-tune individual
  **feature switches** (photo, video, upload, split, grid, brighten, analysis,
  statement colours, vibe filter, rate-your-picks, cards, print, watermark).
- **Manage colours**: add / edit (name, hex, collection, tone, bold flag) / hide /
  delete / reorder, and cap how many show (`maxShades`). A live preview shows exactly
  what the app will display.
- **Apply it** two ways:
  - **Save to this device** — writes the config to `localStorage`; the app in that
    browser uses it immediately (great for an on-site tablet/kiosk).
  - **Download `config.default.js`** — commit it in place of the current file to bake
    a permanent build for a specific client, then deploy that copy.

How the app resolves config: a `localStorage` override (from "Save to this device")
wins; otherwise it uses the committed [`config.default.js`](config.default.js).

> The passcode is a **soft gate** (client-side) to keep casual users out — it is not
> real security. Don't put real secrets in the config.

### Back-office: two admin tiers + analytics

- **Client admin** — [`/admin.html`](admin.html) (username/password from `config.default.js` → `admin`). Configures the package the client received.
- **Usage analytics** — [`/analytics.html`](analytics.html) (same client login). Set the deployment's **location** (store / event / web) once, then every try-on is tagged to it. Shows **try-ons per product/SKU**, sessions, captures (photo/video), analyses, shares, a 14-day trend, skin-undertone mix, and an engagement funnel — the marketing data the client can view. Export the location's numbers as JSON.
- **Super Admin (Mineski)** — [`/superadmin.html`](superadmin.html) (separate `superAdmin` credentials). Two jobs:
  1. **Control the client's admin view** — toggle which sections the client admin can see (tier presets, features, colours, export, analytics) and set it view-only.
  2. **Consolidated analytics** — network-wide totals across **all** activations, a per-location comparison table, top products network-wide, and try-ons by location. Import each location's exported JSON to consolidate across devices (no backend needed). This consolidated view is visible **here only**.

Analytics are tracked client-side (localStorage) per device/location; export/import moves them between devices. Use **Load demo data** on either dashboard for a populated pitch view. A **Load demo data** seed and **Clear data** are provided.

> Super Admin is URL-only (not linked from the client app) and uses separate credentials — change both `admin` and `superAdmin` in `config.default.js` before deploying.

### Tier presets at a glance

| Feature | Basic | Standard | Pro | All-in |
|---|:--:|:--:|:--:|:--:|
| Live filter + photo | ✓ | ✓ | ✓ | ✓ |
| Colours | 5 | all | all | all |
| Video, upload, split, grid, brighten | – | ✓ | ✓ | ✓ |
| Hair analysis + recommendations | – | – | ✓ | ✓ |
| Statement colours, vibe, rate-your-picks | – | – | ✓ | ✓ |
| Save / share social cards | – | ✓ | ✓ | ✓ |
| Print A5 report (connected printer) | – | – | – | ✓ |

Printing uses the browser's print dialog, so it goes to whatever printer the device
is connected to — set the client's kiosk browser to the in-store printer.

## Run locally

Because it uses the camera, the page must be served over **HTTPS** or from
**`localhost`** (not opened as a `file://` path).

```bash
# from the project folder
python -m http.server 8000
# then open http://localhost:8000
```

Or with Node: `npx serve`.

## Deploy to GitHub Pages

1. Create a repo and push these files (`index.html`, `styles.css`, `app.js`, `README.md`).
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source = Deploy from a branch**, branch
   `main`, folder `/ (root)`, and save.
4. Your app will be live at `https://<username>.github.io/<repo>/` — served over HTTPS,
   so the camera works.

No build step is required — it's a static site.

## Hair-detection status & troubleshooting

A small badge in the top-left of the camera shows the live hair-detection status:

- 🟢 **Hair detected** — the mask is working; recoloring and analysis will work.
- 🟡 **Hair barely visible** — center your hair and improve lighting.
- 🔴 **No hair — center your hair** — no hair mask (or hair not in frame).

The badge also shows the active inference **delegate** (`GPU` or `CPU`). On some
devices the GPU delegate loads but returns an empty mask (a known driver/browser
issue) — the app **auto-detects this and rebuilds on the CPU delegate** (you'll see
a brief "Optimizing hair detection…", and the badge flips to `CPU`). CPU is a little
slower but reliable everywhere.

If nothing recolors and the badge stays red even on CPU:

- Make sure you're on **HTTPS or localhost** (GitHub Pages is HTTPS). Opening the
  file directly (`file://`) or over plain `http://` can break the camera and model.
- Ensure your hair is clearly in frame and reasonably lit.
- Hover the badge (desktop) to see the raw `coverage %` / `peak` diagnostic, or check
  the browser console / `window.__hairAnalysisDebug`.

## Browser support notes

- **Camera** requires HTTPS (GitHub Pages provides this automatically).
- **Video recording** uses `MediaRecorder` + `canvas.captureStream`. This works in
  Chrome, Edge, Firefox, and recent Safari/iOS. On older iOS versions recording may
  be unavailable — photo capture still works. The app auto-detects and picks MP4
  when supported, otherwise WebM.
- First load downloads the MediaPipe model (~a few MB) from a CDN, then runs offline-capable in-session.

## Customizing the shades

Edit the `SHADES` array near the top of [`app.js`](app.js). Each entry is
`{ id, name, hex }`. The `hex` is the digital preview color; set it to match the
real product swatch. Use `hex: null` for the "Off / original" option.

## Logo

The app shows the iColor Plus logo from `assets/logo.png`, and automatically falls
back to a vector recreation in [`assets/logo.svg`](assets/logo.svg) if no PNG is
present. **To use the official brand asset**, just drop your file in as
`assets/logo.png` — no code changes needed.

## Privacy

All processing happens locally in the browser. The camera feed is never sent to a
server; captured photos and videos are created and downloaded on the user's own device.

---

*Prototype for demonstration. Shade previews are digital approximations and may differ
from actual results. iColor Plus is a trademark of its respective owner.*
