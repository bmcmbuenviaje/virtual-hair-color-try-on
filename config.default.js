/* ============================================================
   iColor Plus — deployment configuration (DEFAULT / master)
   ------------------------------------------------------------
   This is the configuration a fresh deployment ships with.
   The Admin Console (admin.html) edits a copy of this and can:
     • save it to the current device (localStorage), and/or
     • export a replacement for THIS file to bake a client build.
   The app reads a saved override from localStorage if present,
   otherwise it falls back to this default.
   ============================================================ */
window.ICOLOR_DEFAULT_CONFIG = {
  // Package label (shown in the admin console only).
  tier: "All-in",

  // Build/version tag — reported per kiosk to the fleet view so you can spot
  // devices running an old build. Bump when you ship an update.
  build: "2026.08.14",

  // Soft gate for the admin console. Passwords are stored as salted SHA-256 hashes
  // (not plaintext) so this file no longer leaks credentials via "View Source".
  // Still a client-side gate — for real security serve admin only on the tailnet
  // or move auth to PocketBase. To change a password, recompute the hash:
  //   sha256Hex(salt + newPassword)   (see the gate helpers in admin.js/superadmin.js).
  admin: { username: "conrad", salt: "icp-admin-2f9a", passHash: "e6f297aa41b94e91d47e5c220a38c7676fdb65e3b0bb5c4a4e84a5c2e5ca0a56" },

  // Super Admin: controls the client's admin view and sees consolidated analytics.
  superAdmin: { username: "conrad", salt: "icp-super-8c3d", passHash: "f5f5da86a0f623da734a67192c64372f61eedaa8b21b364374702741087bdcde" },

  // This deployment's location tag — every try-on is recorded against it.
  // type: "store" | "event" | "web". Set per store/event via the Analytics page.
  location: { id: "unassigned", name: "Unassigned deployment", type: "web" },

  // What the CLIENT-level admin console may show/do (Super Admin controls this).
  // Note: package tier & feature switches are Super-Admin-only and never shown here.
  clientAdmin: {
    showShades: true,     // colour manager
    showExport: true,     // export/import a build
    showAnalytics: true,  // link to the usage analytics dashboard
    readOnly: false,      // view-only (client can see but not save changes)
  },

  // Cap the number of visible colours (null = no cap). Basic tier = 5.
  maxShades: null,

  // Feature switches. CONTROLLED BY SUPER ADMIN ONLY (superadmin.html).
  features: {
    photo: true,       // take photo
    video: true,       // record 30s video
    upload: true,      // upload a selfie
    split: true,       // before/after split
    grid: true,        // compare-all grid
    brighten: true,    // brighten (pre-lightened) toggle
    analysis: true,    // hair & skin analysis + recommendations
    statement: true,   // statement/bold colour section (within analysis)
    vibe: true,        // vibe filter (natural/bold/low-maintenance)
    ratePicks: true,   // rate-your-own-picks evaluator
    cards: true,       // save/share social cards
    print: true,       // print A5 analysis (connected printer)
    watermark: false,  // stamp iColor Plus watermark on captures
    qr: true,          // QR-to-phone handoff
    promo: true,       // shade-of-the-week promo banner
    coupon: false,     // voucher/coupon block on the A5 report
    leads: false,      // opt-in lead capture (consent only)
    heatmap: true,     // time-of-day / dwell tracking
    getlook: true,     // "get this look" — match a shade from an inspo photo
    multilang: true,   // Tagalog / English toggle
    offline: true,     // offline PWA cache
    attract: false,    // kiosk attract / idle camera-mirror teaser
  },

  // Shade-of-the-week promo banner (Super Admin sets; shows on the start screen).
  promo: {
    enabled: false,
    shadeId: "",          // featured shade id (optional)
    title: "Shade of the Week",
    message: "",          // campaign copy
    image: "",            // uploaded poster as a data: URL (optional, overrides card)
  },

  // Coupon on the A5 report.
  //   source "generated" — print a unique per-session code LOC3-CAMPAIGN-XXX
  //     (3-letter location code + campaign shortcode + 3 random); `code` is the
  //     fallback when unique:false.
  //   source "pool" — claim a code from the uploaded voucher pool on the server
  //     (client-supplied codes, each used once across all kiosks). Falls back to a
  //     generated code if the pool is empty or the server is unreachable.
  //   `campaign` also filters which pool codes are claimed.
  coupon: { enabled: false, code: "", label: "In-store offer", terms: "", campaign: "", unique: true, source: "generated" },

  // A5 print report design (edited in the client admin when 'print' is enabled).
  printLayout: {
    title: "Personalized Hair Colour Analysis",
    accentFrom: "#5f7d2e",
    accentTo: "#b8942f",
    footer: "iColor Plus · Shampoo-In Hair Colour · Great Lengths Philippines. Digital estimate from your photo, not a professional diagnosis. Always patch-test.",
    showBrighten: true,   // show the "make it brighter" panel
    showMatches: true,    // show the shade-strip (matches + bold picks)
  },

  // Opt-in lead capture (consent only — stored locally, exported as CSV by Super Admin).
  leads: {
    enabled: false,
    requireEmail: true,
    consentText: "I agree to receive iColor Plus updates and offers from Great Lengths.",
  },

  // Live backend (optional). provider: "none" | "pocketbase" | "supabase".
  // When url is set, analytics + leads sync live; otherwise localStorage is used.
  backend: { provider: "none", url: "", note: "" },

  // "Scan to phone" QR. The QR encodes a location-tagged deep link so a scan on
  // a customer's phone attributes back to THIS kiosk's store, and can be counted.
  //   baseUrl     — the PUBLIC url the QR points to (phones can't reach a tailnet
  //                 address, so set this to your GitHub Pages URL). Blank = current origin.
  //   scanPingUrl — optional PUBLIC endpoint (Tailscale Funnel) that logs a real
  //                 scan to the central server. Blank = scans counted on-phone only.
  //   includeShade— also encode the featured promo shade so the phone opens on it.
  qr: {
    baseUrl: "https://bmcmbuenviaje.github.io/virtual-hair-color-try-on/",
    scanPingUrl: "https://desktop-s8s5jql.tail38606b.ts.net:8443/scanping",
    includeShade: true,
  },

  // Kiosk attract / idle "mirror" teaser: after idleMs of no interaction on the start
  // screen, auto-start the live camera with a shade applied + a tap-to-start overlay
  // (only if camera permission is already granted, so it never surprise-prompts).
  // Turned on/off by features.attract (Super Admin); these are just the tuning params:
  // idle delay, teaser shade (blank = first shade), and the call-to-action text.
  attract: { idleMs: 45000, shadeId: "", cta: "Tap to try your color" },

  // Language. codes: "en" | "tl".
  lang: { default: "en", enabled: ["en", "tl"] },

  // The full colour catalog. `hidden: true` keeps a shade out of the app
  // without deleting it. Order here is the order shown in the app.
  shades: [
    { id: "natural-black", name: "Natural Black", hex: "#1A1A1A", collection: "Flagship", tone: "neutral", statement: false, hidden: false },
    { id: "dark-brown", name: "Dark Brown", hex: "#3D2314", collection: "Flagship", tone: "warm", statement: false, hidden: false },
    { id: "medium-brown", name: "Medium Brown", hex: "#5C3A21", collection: "Flagship", tone: "warm", statement: false, hidden: false },
    { id: "light-brown", name: "Light Brown", hex: "#8B5A2B", collection: "Flagship", tone: "warm", statement: false, hidden: false },
    { id: "chestnut-brown", name: "Chestnut Brown", hex: "#7B3F00", collection: "Flagship", tone: "warm", statement: true, hidden: false },
    { id: "burgundy", name: "Burgundy", hex: "#800020", collection: "Flagship", tone: "cool", statement: true, hidden: false },
    { id: "wild-cherry", name: "Wild Cherry", hex: "#9B111E", collection: "Flagship", tone: "warm", statement: true, hidden: false },
    { id: "triple-color-changer", name: "Triple Color Changer", hex: "#A67B5B", collection: "Flagship", tone: "warm", statement: false, hidden: false },
    { id: "ash-gray", name: "Ash Gray", hex: "#B2BEB5", collection: "Ash & Crème", tone: "cool", statement: false, hidden: false },
    { id: "ash-pink", name: "Ash Pink", hex: "#F2A2B1", collection: "Ash & Crème", tone: "cool", statement: true, hidden: false },
    { id: "ash-purple", name: "Ash Purple", hex: "#7851A9", collection: "Ash & Crème", tone: "cool", statement: true, hidden: false },
    { id: "ash-blue", name: "Ash Blue", hex: "#4A6B82", collection: "Ash & Crème", tone: "cool", statement: true, hidden: false },
    { id: "mahogany", name: "Mahogany", hex: "#4A2511", collection: "Ash & Crème", tone: "warm", statement: true, hidden: false },
    { id: "mens-natural-black", name: "Men's Natural Black", hex: "#111111", collection: "For Men", tone: "neutral", statement: false, hidden: false },
    { id: "mens-dark-brown", name: "Men's Dark Brown", hex: "#2B1810", collection: "For Men", tone: "warm", statement: false, hidden: false },
    { id: "timeless-natural-black", name: "Timeless Natural Black", hex: "#1F1F1F", collection: "Timeless", tone: "neutral", statement: false, hidden: false },
    { id: "timeless-natural-brown", name: "Timeless Natural Brown", hex: "#4A3319", collection: "Timeless", tone: "neutral", statement: false, hidden: false },
    { id: "timeless-nude-beige", name: "Timeless Nude Beige", hex: "#D1B89D", collection: "Timeless", tone: "warm", statement: false, hidden: false },
    { id: "timeless-nude-ash", name: "Timeless Nude Ash", hex: "#A09386", collection: "Timeless", tone: "cool", statement: false, hidden: false },
    { id: "brown-black", name: "Brown Black", hex: "#281E15", collection: "Collab", tone: "neutral", statement: false, hidden: false },
    { id: "vanilla-blonde", name: "Vanilla Blonde", hex: "#F3E5AB", collection: "Blonde Prep", tone: "warm", statement: false, hidden: false },
  ],
};
