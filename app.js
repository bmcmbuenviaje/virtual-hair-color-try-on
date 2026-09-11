import {
  ImageSegmenter,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20";

/* ============================================================
   iColor Plus — Live Hair Color Try-On
   Real-time hair segmentation (MediaPipe) + luminance-preserving
   recolor. Modes: single live view, before/after split, and a
   live multi-shade compare grid. On-device photo & 30s video.
   ============================================================ */

const WASM_BASE =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/wasm";
const HAIR_MODEL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/hair_segmenter/float32/latest/hair_segmenter.tflite";

const MAX_RECORD_MS = 30000; // 30-second cap
const PROC_MAX_W = 640; // processing width cap for the pixel loop
const MASK_CUTOFF = 0.15; // legacy soft cutoff (kept for reference; see maskAlpha)

// Hair-mask edge firming. MediaPipe's confidence has a soft halo around the hair
// that spills onto the forehead / scalp / temples — so raw confidence would tint
// skin. maskAlpha() zeroes anything below MASK_LO (skin/scalp) and smoothsteps up
// to full only for solid hair, so the colour never lands on the scalp.
const MASK_LO = 0.55; // below this = not hair (skin/scalp/parting) → no colour
const MASK_HI = 0.9;  // at/above this = solid hair → full colour (soft feather between)
function maskAlpha(m) {
  if (m <= MASK_LO) return 0;
  if (m >= MASK_HI) return 1;
  const t = (m - MASK_LO) / (MASK_HI - MASK_LO);
  return t * t * (3 - 2 * t); // smoothstep — clean, firm hairline
}
// How "skin-like" a pixel is (0..1), RELATIVE to the person's own hair brightness:
// scalp showing through a parting (and the hairline/temples) is notably brighter
// than the hair and warm. Judging it relative to the hair's mean luminance is the
// key — it fades the scalp on dark hair (where it stands out) but does NOT touch
// light-brown / blonde hair (nothing there is much brighter than the hair itself).
function skinFactor(r, g, b, lum, hairLum) {
  const excess = lum - hairLum;
  if (excess < 30) return 0;   // not clearly brighter than the hair → it's hair
  const dr = r - g;
  if (dr <= 4) return 0;       // not warm (neutral highlight) → not skin
  return Math.min(1, (excess - 30) / 45) * Math.min(1, (dr - 4) / 16);
}
// Mean luminance of the confident-hair pixels in a buffer (coarse sample), so the
// skin guard can compare each pixel to the hair rather than an absolute threshold.
function hairMeanLum(buf, w, h, mapx, mapy, mirror) {
  let s = 0, n = 0;
  const X0 = mapx.i0, XF = mapx.fr, Y0 = mapy.i0, YF = mapy.fr, mW = maskW, mH = maskH, mWm1 = mW - 1;
  for (let y = 0; y < h; y += 4) {
    const y0 = Y0[y], fy = YF[y], y1 = y0 + 1 < mH ? y0 + 1 : y0, rA = y0 * mW, rB = y1 * mW, rp = y * w;
    for (let x = 0; x < w; x += 4) {
      let gx = X0[x] + XF[x]; if (mirror) gx = mWm1 - gx;
      let x0 = gx | 0; if (x0 < 0) x0 = 0; else if (x0 > mWm1) x0 = mWm1;
      const fx = gx - x0 < 0 ? 0 : gx - x0, x1 = x0 + 1 < mW ? x0 + 1 : x0;
      const a0 = maskData[rA + x0], b0 = maskData[rA + x1], a1 = maskData[rB + x0], b1 = maskData[rB + x1];
      const top = a0 + (b0 - a0) * fx;
      if (top + ((a1 + (b1 - a1) * fx) - top) * fy < 0.7) continue;
      const i = (rp + x) << 2;
      s += (buf[i] * 77 + buf[i + 1] * 150 + buf[i + 2] * 29) >> 8; n++;
    }
  }
  return n ? s / n : 0;
}

/* ---- Dye "deposit" model tuning ----
   Hair color is simulated as a subtractive (multiply) mix of the person's
   REAL hair color with the dye pigment — so a dye only ever deposits/darkens
   and tones, it can't lighten. That means dark hair resists pale shades and
   reds/coppers show through, mirroring how a shampoo-in color really behaves.
   The Brighten toggle simulates a pre-lightened base so pastels can show. */
const DEPOSIT_GAIN = 1.18; // gentle lift to counter multiply darkening
const BOOST_LIFT = 0.6; // simulated pre-lightening when Brighten is on
const SHINE_T = 150; // luminance above which hair highlights keep their sheen
const SHINE_K = 0.5;

/* ---- Deployment configuration (features + shade catalog) ----
   Resolved from an admin-saved override (localStorage) if present,
   otherwise from config.default.js. Lets the app ship in tiers. */
const CONFIG = (function resolveConfig() {
  const def = window.ICOLOR_DEFAULT_CONFIG || { features: {}, shades: [], maxShades: null };
  let over = null;
  try { over = JSON.parse(localStorage.getItem("icolorConfig") || "null"); } catch (e) {}
  return over && Array.isArray(over.shades) ? over : def;
})();

const FEATURES = Object.assign(
  {
    photo: true, video: true, upload: true, split: true, grid: true, brighten: true,
    analysis: true, statement: true, vibe: true, ratePicks: true, cards: true, print: true,
    watermark: false,
  },
  CONFIG.features || {}
);

// Printer routing (staff-declared type). See config.default.js → print.
const PRINT = Object.assign(
  { mode: "color", transport: "bluetooth", widthMm: 58, qr: true, copies: 1, header: "", footer: "Great Lengths PH", paperRoll: 0 },
  CONFIG.print || {}
);

// Count a print (consumable) + nudge staff when the day's count nears the roll size.
function notePrint() {
  trk("print");
  const roll = parseInt(PRINT.paperRoll, 10) || 0;
  if (roll <= 0) return;
  let n = 0;
  try { const A = window.Analytics, L = A.load().locations[A.currentLocation().id]; n = (L && L.perDay[A.dayKey()] && L.perDay[A.dayKey()].print) || 0; } catch (e) {}
  if (n >= roll) showToast("🧻 Printer likely out of paper — " + n + " prints today. Replace the roll/ream.");
  else if (n >= Math.round(roll * 0.8)) showToast("🧻 Paper running low — " + n + "/" + roll + " today.");
}

// Live kiosk health (for the fleet beacon + self-test). Flags flip as subsystems
// come up; pulseHealth() stamps a snapshot onto analytics (synced to Super Admin).
const HEALTH = { build: CONFIG.build || "", camera: false, model: false };
function printerReady() {
  if (!FEATURES.print) return null; // feature off → not applicable
  if ((PRINT.mode || "color") !== "thermal") return true; // OS dialog — always available
  return !!(window.ICPrinter && window.ICPrinter.supported(PRINT.transport || "bluetooth"));
}
function pulseHealth() {
  try {
    const A = window.Analytics; if (!A || !A.heartbeat) return;
    let printToday = 0;
    try { const L = A.load().locations[A.currentLocation().id]; printToday = (L && L.perDay[A.dayKey()] && L.perDay[A.dayKey()].print) || 0; } catch (e) {}
    A.heartbeat({ build: HEALTH.build, health: {
      camera: HEALTH.camera, model: HEALTH.model,
      printer: printerReady(), printMode: FEATURES.print ? (PRINT.mode || "color") : null,
      backend: !!(window.Backend && window.Backend.enabled()),
      online: navigator.onLine !== false, printToday,
      ua: (navigator.userAgent || "").slice(0, 120),
    } });
  } catch (e) {}
}

/* ---- i18n (Tagalog / English) ---- */
const I18N = {
  en: {
    tagline: "Live Hair-Colour Try-On", startCamera: "Start Camera", upload: "Upload a selfie",
    getlook: "Match a shade from a photo", lookTitle: "Match a shade",
    fineprint: "Camera works best in good lighting (needs HTTPS). Uploading analyzes your real hair colour and previews how each shade would mix with it.",
    lead: "See iColor Plus shades on your own hair in real time. Pick a colour, then capture a photo or a 30-second video — everything is saved straight to your device. Nothing is uploaded.",
    theLook: "The look", detectedColour: "Detected hair colour", closest: "Closest iColor Plus", topMatches: "Top matches", bestMatch: "Best match", tryIt: "Try it",
    pickImage: "Please choose an image file", analyzingLook: "Analyzing the look…", noHairLook: "Couldn't read hair in that photo — try a clearer one", lookFailed: "Couldn't analyze that photo",
    ho_title: "Get your photos", ho_lead: "Grab your photos on your phone 📱",
    ho_join: "Join the Wi-Fi", ho_join_sub: "Scan to connect — no password to type",
    ho_scan: "Scan for your photos", ho_scan_sub: "Opens a page with Save buttons",
    ho_code: "Code", ho_foot: "Your photos live only on the on-site box and are auto-deleted at end of day.",
    ho_prep: "Preparing your photos…", ho_err_title: "Couldn’t reach the photo box.",
    ho_err_sub: "Make sure this display is connected to the on-site Wi-Fi box, then try again.",
    ho_retry: "Try again", ho_send: "Send to my phone", ho_tophone: "To phone", beforeafter: "Before/After",
    ho_not_setup: "Photo transfer isn’t set up here.", ho_take_first: "Take a photo or clip first.",
    ho_nudge: "📱 Tap “Send to my phone” to take your photos home.",
    lvl_base: "Your hair (dark)", lvl_app_one: "After 1 app · Level {L}", lvl_app_n: "After {n} apps · Level {L}",
    lvl_hint: "💡 {name} shows best on lighter hair — slide right to preview it. To get it for real, lighten first (see “How to get your colour” in your analysis).",
    voice_welcome: "Welcome! Pick a colour to see it on your hair.", voice_result: "Here is your personalized colour analysis.",
    langName: "EN",
  },
  tl: {
    tagline: "Live na Hair-Colour Try-On", startCamera: "Simulan ang Camera", upload: "Mag-upload ng selfie",
    getlook: "Tumugma ng kulay mula sa larawan", lookTitle: "Tumugma ng kulay",
    fineprint: "Pinakamaganda ang camera sa maliwanag na ilaw (kailangan ng HTTPS). Ina-analyze ng upload ang totoong kulay ng buhok at ipinapakita kung paano ito hahaluan ng bawat shade.",
    lead: "Tingnan ang mga iColor Plus shade sa sarili mong buhok nang live. Pumili ng kulay, tapos kumuha ng larawan o 30-segundong video — direktang naka-save sa iyong device. Walang ina-upload.",
    theLook: "Ang hitsura", detectedColour: "Natukoy na kulay ng buhok", closest: "Pinakamalapit na iColor Plus", topMatches: "Nangungunang tugma", bestMatch: "Pinakamatugma", tryIt: "Subukan",
    pickImage: "Pumili ng larawan", analyzingLook: "Ina-analyze ang hitsura…", noHairLook: "Hindi mabasa ang buhok sa larawan — subukan ang mas malinaw", lookFailed: "Hindi ma-analyze ang larawan",
    ho_title: "Kunin ang iyong mga larawan", ho_lead: "Kunin ang mga larawan sa iyong telepono 📱",
    ho_join: "Kumonekta sa Wi-Fi", ho_join_sub: "I-scan para kumonekta — walang ita-type na password",
    ho_scan: "I-scan para sa mga larawan", ho_scan_sub: "May mga Save button ang bubukas na pahina",
    ho_code: "Code", ho_foot: "Ang mga larawan ay nasa on-site box lang at awtomatikong buburahin sa katapusan ng araw.",
    ho_prep: "Inihahanda ang iyong mga larawan…", ho_err_title: "Hindi maabot ang photo box.",
    ho_err_sub: "Siguraduhing nakakonekta ang display sa on-site Wi-Fi box, tapos subukan muli.",
    ho_retry: "Subukan muli", ho_send: "Ipadala sa telepono ko", ho_tophone: "Sa telepono", beforeafter: "Before/After",
    ho_not_setup: "Hindi naka-setup ang paglipat ng larawan dito.", ho_take_first: "Kumuha muna ng larawan o video.",
    ho_nudge: "📱 I-tap ang “Ipadala sa telepono ko” para maiuwi ang mga larawan.",
    lvl_base: "Buhok mo (madilim)", lvl_app_one: "Pagkatapos ng 1 app · Level {L}", lvl_app_n: "Pagkatapos ng {n} apps · Level {L}",
    lvl_hint: "💡 Mas maganda ang {name} sa mas maliwanag na buhok — i-slide pakanan para makita. Para makuha talaga, mag-lighten muna (tingnan ang “How to get your colour” sa analysis).",
    voice_welcome: "Maligayang pagdating! Pumili ng kulay para makita sa iyong buhok.", voice_result: "Narito ang iyong personalized na hair colour analysis.",
    langName: "TL",
  },
  // Cebuano / Bisaya — machine-assisted; please have a native speaker review before a big rollout.
  ceb: {
    tagline: "Live nga Try-On sa Kolor sa Buhok", startCamera: "Sugdi ang Camera", upload: "Mag-upload og selfie",
    getlook: "Pangitaa ang shade gikan sa litrato", lookTitle: "Pangitaa ang shade",
    fineprint: "Mas maayo ang camera sa hayag nga suga (kinahanglan og HTTPS). Ang pag-upload mo-analisa sa tinuod nga kolor sa imong buhok ug ipakita kung unsaon pagsagol sa matag shade.",
    lead: "Tan-awa ang mga iColor Plus shade sa imong kaugalingong buhok nga live. Pagpili og kolor, dayon pagkuha og litrato o 30-segundos nga video — direkta nga ma-save sa imong device. Walay gi-upload.",
    theLook: "Ang hitsura", detectedColour: "Nakit-an nga kolor sa buhok", closest: "Pinakaduol nga iColor Plus", topMatches: "Nag-unang tugma", bestMatch: "Pinakatugma", tryIt: "Sulayi",
    pickImage: "Palihug pagpili og litrato", analyzingLook: "Gi-analisa ang hitsura…", noHairLook: "Wala mabasa ang buhok sa litrato — sulayi ang mas klaro", lookFailed: "Dili ma-analisa ang litrato",
    ho_title: "Kuhaa ang imong mga litrato", ho_lead: "Kuhaa ang mga litrato sa imong telepono 📱",
    ho_join: "Sumpay sa Wi-Fi", ho_join_sub: "I-scan aron mo-konektar — walay password nga i-type",
    ho_scan: "I-scan para sa imong mga litrato", ho_scan_sub: "Mo-abli og pahina nga naay Save nga mga buton",
    ho_code: "Code", ho_foot: "Ang imong mga litrato naa lang sa on-site box ug awtomatik nga mapapas sa kataposan sa adlaw.",
    ho_prep: "Giandam ang imong mga litrato…", ho_err_title: "Dili maabot ang photo box.",
    ho_err_sub: "Siguroha nga konektado kining display sa on-site Wi-Fi box, dayon sulayi pag-usab.",
    ho_retry: "Sulayi pag-usab", ho_send: "Ipadala sa akong telepono", ho_tophone: "Sa telepono", beforeafter: "Antes/Human",
    ho_not_setup: "Wala pa ma-setup ang pagbalhin sa litrato dinhi.", ho_take_first: "Pagkuha usa og litrato o video.",
    ho_nudge: "📱 I-tap ang “Ipadala sa akong telepono” aron madala ang imong mga litrato.",
    lvl_base: "Imong buhok (itom)", lvl_app_one: "Human sa 1 ka aplikasyon · Level {L}", lvl_app_n: "Human sa {n} ka aplikasyon · Level {L}",
    lvl_hint: "💡 Mas nindot ang {name} sa mas hayag nga buhok — i-slide sa tuo aron makita. Aron makuha gyud, i-lighten una (tan-awa ang “How to get your colour” sa imong analysis).",
    voice_welcome: "Maayong pag-abot! Pagpili og kolor aron makita sa imong buhok.", voice_result: "Ania ang imong personalized nga hair colour analysis.",
    langName: "CEB",
  },
};
let LANG = "en";
try { LANG = localStorage.getItem("icolorLang") || (CONFIG.lang && CONFIG.lang.default) || "en"; } catch (e) {}
if (!I18N[LANG]) LANG = "en";
function t(k) { return (I18N[LANG] && I18N[LANG][k]) || I18N.en[k] || k; }
function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => { const s = t(el.getAttribute("data-i18n")); if (s) el.textContent = s; });
}
// Spoken prompts (accessibility). Off unless features.voice; uses the device's own
// speech synthesis (offline on most kiosks). Maps our language to a BCP-47 voice.
const VOICE_LANG = { en: "en-US", tl: "fil-PH", ceb: "fil-PH" };
let _voiceWarmed = false;
function speak(text) {
  if (!FEATURES.voice || !text) return;
  try {
    const synth = window.speechSynthesis; if (!synth) return;
    if (!_voiceWarmed) { try { synth.getVoices(); } catch (e) {} _voiceWarmed = true; }
    synth.cancel();
    const u = new SpeechSynthesisUtterance(String(text));
    u.lang = VOICE_LANG[LANG] || "en-US";
    u.rate = 1; u.pitch = 1; u.volume = 1;
    const v = (synth.getVoices() || []).find((x) => x.lang && x.lang.toLowerCase().startsWith((u.lang).slice(0, 2)));
    if (v) u.voice = v;
    synth.speak(u);
  } catch (e) {}
}

// Languages this deployment offers (config-driven, filtered to ones we actually ship).
function enabledLangs() {
  let list = (CONFIG.lang && Array.isArray(CONFIG.lang.enabled) && CONFIG.lang.enabled.length) ? CONFIG.lang.enabled.slice() : ["en"];
  list = list.filter((c) => I18N[c]);
  return list.length ? list : ["en"];
}
function cycleLang() {
  const list = enabledLangs();
  const i = list.indexOf(LANG);
  setLang(list[(i + 1) % list.length]);
}
function setLang(code) {
  LANG = I18N[code] ? code : "en";
  try { localStorage.setItem("icolorLang", LANG); } catch (e) {}
  applyI18n();
  const lb = document.getElementById("langBtn");
  if (lb) lb.textContent = I18N[LANG].langName;
  // The "After N uses" label is dynamic (not data-i18n) — refresh it too.
  try {
    const iv = document.getElementById("intensityVal"), inp = document.getElementById("intensity");
    if (iv && inp) iv.textContent = levelLabel(parseInt(inp.value, 10) || 0);
    updateLevelHint();
  } catch (e) {}
}

// Build the active shade list from config: skip hidden shades, cap to maxShades,
// always keep the "Off" (original) option first.
const SHADES = [{ id: "none", name: "Off", hex: null, collection: null }];
(CONFIG.shades || [])
  .filter((s) => s && s.hex && !s.hidden)
  .slice(0, CONFIG.maxShades ? CONFIG.maxShades : undefined)
  .forEach((s) =>
    SHADES.push({
      id: s.id, name: s.name, hex: s.hex, collection: s.collection || null,
      tone: s.tone || "neutral", statement: !!s.statement,
      // commerce ("shop the look") fields — needed for the in-camera product card
      buyUrl: s.buyUrl || "", buyImg: s.buyImg || "", buyPrice: s.buyPrice || "",
      buyVariant: s.buyVariant, buyAvail: s.buyAvail,
    })
  );

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const startScreen = $("startScreen");
const appScreen = $("appScreen");
const startBtn = $("startBtn");
const startStatus = $("startStatus");
const video = $("video");
const canvas = $("output");
const ctx = canvas.getContext("2d", { willReadFrequently: true });
const loader = $("loader");
const loaderText = $("loaderText");
const swatchesEl = $("swatches");
const intensity = $("intensity");
const intensityVal = $("intensityVal");
const shadeLabel = $("shadeLabel");
const flipBtn = $("flipBtn");
const uploadBtn = $("uploadBtn");
const cameraBtn = $("cameraBtn");
const startUploadBtn = $("startUploadBtn");
const fileInput = $("fileInput");
const lookBtn = $("lookBtn");
const lookFile = $("lookFile");
const lookModal = $("lookModal");
const lookBody = $("lookBody");
const splitBtn = $("splitBtn");
const gridBtn = $("gridBtn");
const boostBtn = $("boostBtn");
const sheetBtn = $("sheetBtn");
const photoBtn = $("photoBtn");
const recordBtn = $("recordBtn");
const galleryBtn = $("galleryBtn");
const galleryThumb = $("galleryThumb");
const recBadge = $("recBadge");
const recTime = $("recTime");
const hairStatus = $("hairStatus");
const flash = $("flash");
const toast = $("toast");
const galleryModal = $("galleryModal");
const galleryGrid = $("galleryGrid");
const galleryEmpty = $("galleryEmpty");
const analysisBtn = $("analysisBtn");
const analysisModal = $("analysisModal");
const analysisBody = $("analysisBody");
const printReport = $("printReport");

/* ---------- State ---------- */
let segmenter = null;
let stream = null;
let facingMode = "user";
let running = false;
let lastVideoTime = -1;

let selectedShade =
  SHADES.find((s) => s.id === "dark-brown") || SHADES.find((s) => s.hex) || SHADES[0]; // start shade
// --- Hair-level / lightening model (research-grounded to how iColor works) ---
// iColor Plus is a SHAMPOO-IN deposit colour: one 30–45 min application lays the
// colour down. How that colour READS depends on the hair's LIGHTNESS/level — which
// you raise with the Love Color Lightening Créme (~1 level per 35-min application:
// app 1 → Level 6 … app 5 → Level 10). So the slider walks the lightening ladder:
// darker base (colour looks deep/muted) → lighter base (ash/nude/pastels show true).
// Each stop maps to a "lift" that pre-lightens the base inside makeLUT(). This also
// covers the box swatches (virgin ≈ stop 0, pre-lightened ≈ mid, Level 9 ≈ stop 4).
const LEVEL_LIFT = [0.00, 0.30, 0.48, 0.63, 0.78, 0.90]; // stop 0..5 → base pre-lighten
const MAX_LEVEL = LEVEL_LIFT.length - 1;                 // 5 applications
// Overall AR colour opacity (config-driven). Subtle by default so it reads as a
// natural tint, not a painted-on coat.
const DEPOSIT_STRENGTH = Math.max(0.05, Math.min(1,
  parseFloat(CONFIG.colorStrength != null ? CONFIG.colorStrength : 0.22) || 0.22));
function levelLabel(i) {
  i = Math.max(0, Math.min(MAX_LEVEL, i | 0));
  if (i === 0) return t("lvl_base");
  return t(i === 1 ? "lvl_app_one" : "lvl_app_n").replace("{n}", i).replace("{L}", 5 + i);
}
// The hair level a shade needs to read true (from its own lightness), and the
// approx base level the current slider stop is previewing — used for the hint.
function shadeReqLevel(shade) {
  if (!shade || !shade.hex) return 1;
  const [r, g, b] = hexToRgb(shade.hex);
  return levelFor((r * 77 + g * 150 + b * 29) >> 8).level;
}
function previewBaseLevel() { return level === 0 ? 3 : 5 + level; }
function updateLevelHint() {
  const el = $("levelHint");
  if (!el) return;
  const s = selectedShade;
  const need = s && s.hex && s.id !== "none" && shadeReqLevel(s) > previewBaseLevel() + 1;
  if (need) { el.textContent = t("lvl_hint").replace("{name}", s.name); el.classList.remove("hidden"); }
  else el.classList.add("hidden");
}
let level = Math.max(0, Math.min(MAX_LEVEL,
  parseInt(CONFIG.defaultLevel != null ? CONFIG.defaultLevel : 0, 10) || 0));
let liftAmt = LEVEL_LIFT[level];   // current base pre-lightening (read by makeLUT)
let strength = DEPOSIT_STRENGTH;   // deposit alpha (fixed — colour is one application)
if (intensity) intensity.value = level;
if (intensityVal) intensityVal.textContent = levelLabel(level);

let splitView = false;
let splitX = 0.5;
let dragging = false;
let gridMode = false;
let boost = false; // "Brighten" — lifts luminance so pastels/blondes show on dark hair

// Source of truth for what gets drawn/segmented: live video or an uploaded still.
let activeSource = video;
let activeMirror = false; // mirror only the live front camera
let staticMode = false; // true when previewing an uploaded photo
let staticReady = false;
let needsRender = true; // dirty flag so a still only re-renders on change
let appInited = false;
const staticImg = document.createElement("canvas"); // holds the uploaded photo
const sictx = staticImg.getContext("2d", { willReadFrequently: true });

// Offscreen processing canvas (single-view path)
const proc = document.createElement("canvas");
const pctx = proc.getContext("2d", { willReadFrequently: true });

// Selected-shade lookup tables
let sel = null; // {r,g,b} Uint8ClampedArrays

// Stored mask for the current frame
let maskData = null,
  maskW = 0,
  maskH = 0;

// Coordinate maps (single-view path)
let mapX = null,
  mapY = null;
const mapKey = { pw: 0, ph: 0, mw: 0, mh: 0 };

// Grid resources
let gridItems = []; // { name, shade, lut }
const gridBase = document.createElement("canvas");
const gbctx = gridBase.getContext("2d", { willReadFrequently: true });
let gWork = null,
  gCellImg = null,
  gMapX = null,
  gMapY = null;
const gKey = { cw: 0, ch: 0, mw: 0, mh: 0 };
let gridLayout = { cols: 0, rows: 0, cw: 0, ch: 0 };

// Media captures
const captures = []; // { type, url, blob, name }
const triedShades = []; // shade ids tried this session (order preserved) — powers "shop the look" on the handoff page

// Usage analytics (no-op if analytics.js isn't present)
let sessionStartTs = null;
function trk(type, opts) {
  try { window.Analytics && window.Analytics.track(type, opts); } catch (e) {}
  if (type === "sessions") sessionStartTs = Date.now();
}
function flushDwell() {
  if (sessionStartTs) {
    const ms = Math.min(30 * 60 * 1000, Date.now() - sessionStartTs); // cap 30 min
    if (ms > 1500) trk("dwell", { ms });
    sessionStartTs = null;
  }
}

/* ---- Per-session coupon code:  LOC3-CAMPAIGN?-XXX  ----
   3-letter location code + optional campaign shortcode + 3 random alphanumerics
   (ambiguous chars I/O/0/1 excluded). Generated once per session, printed on the
   A5 report, and logged (locally + synced to the server) for reconciliation. */
let _sessionCoupon = null;
function couponCode() {
  const cp = CONFIG.coupon || {};
  if (cp.unique === false) return cp.code || "CODE"; // static code mode
  if (_sessionCoupon) return _sessionCoupon;
  const loc = (window.Analytics && window.Analytics.currentLocation()) || {};
  const alnum = (s) => (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const loc3 = (alnum(loc.code || loc.id || "LOC").slice(0, 3) || "LOC").padEnd(3, "X");
  const camp = alnum(cp.campaign || "").slice(0, 12);
  const AL = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1
  let rnd = ""; for (let i = 0; i < 3; i++) rnd += AL[Math.floor(Math.random() * AL.length)];
  _sessionCoupon = [loc3, camp, rnd].filter(Boolean).join("-");
  try { window.Analytics && window.Analytics.logCoupon && window.Analytics.logCoupon(_sessionCoupon, camp); } catch (e) {}
  try { window.Backend && window.Backend.enabled() && window.Backend.pushCoupon && window.Backend.pushCoupon(_sessionCoupon, camp); } catch (e) {}
  return _sessionCoupon;
}
// Resolve the coupon code for this session, awaiting a pool claim when configured.
// Call this (await) before rendering the report; couponCode() then returns the cached code.
async function ensureSessionCoupon() {
  const cp = CONFIG.coupon || {};
  if (_sessionCoupon) return _sessionCoupon;
  if (cp.unique === false) return couponCode(); // static code
  if (cp.source === "pool" && window.Backend && window.Backend.enabled()) {
    try {
      const claimed = await window.Backend.claimVoucher(cp.campaign || "");
      if (claimed) {
        _sessionCoupon = claimed;
        try { window.Analytics && window.Analytics.logCoupon && window.Analytics.logCoupon(claimed, cp.campaign || ""); } catch (e) {}
        return _sessionCoupon;
      }
    } catch (e) {}
    // pool empty / offline → fall through to a generated code so the customer still gets one
  }
  return couponCode();
}

/* ============================================================
   Recolor helpers
   ============================================================ */
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Per-CHANNEL deposit table: given a real hair channel value (0..255), returns
// the pigment-mixed channel value. This is a subtractive (multiply) mix of the
// hair with the dye, so darker hair keeps more of its own darkness while the
// dye's hue tints through — realistic "what this shade does to YOUR hair".
// Brighten pre-lightens the base first, standing in for pre-lightened hair.
function makeLUT(hex) {
  const [dr, dg, db] = hexToRgb(hex);
  const R = new Float32Array(256);
  const G = new Float32Array(256);
  const B = new Float32Array(256);
  const fr = (dr / 255) * DEPOSIT_GAIN;
  const fg = (dg / 255) * DEPOSIT_GAIN;
  const fb = (db / 255) * DEPOSIT_GAIN;
  // Gamma-based pre-lightening: raises the hair's LEVEL while preserving the
  // strand-to-strand light/dark texture (a linear lerp-to-white flattens it and
  // looks painted on). liftAmt 0 → gamma 1 (untouched); higher → brighter base.
  const glift = 1 / (1 + 2.4 * liftAmt);
  for (let v = 0; v < 256; v++) {
    const base = 255 * Math.pow(v / 255, glift);
    R[v] = base * fr;
    G[v] = base * fg;
    B[v] = base * fb;
  }
  return { r: R, g: G, b: B };
}

function setSelectedLUT(hex) {
  sel = hex ? makeLUT(hex) : null;
}

function buildMap(len, target) {
  const m = new Uint16Array(len);
  for (let i = 0; i < len; i++) m[i] = Math.min(target - 1, (i * target / len) | 0);
  return m;
}
// Bilinear map: per output pixel, the lower mask index (i0) + fractional weight (fr)
// so the low-res hair mask can be interpolated smoothly (no stair-stepped edges).
function buildMapBil(len, target) {
  const i0 = new Uint16Array(len), fr = new Float32Array(len);
  const maxI = target - 1;
  const scale = (len > 1 && target > 1) ? maxI / (len - 1) : 0;
  for (let i = 0; i < len; i++) {
    let g = i * scale;
    if (g > maxI) g = maxI; else if (g < 0) g = 0;
    let a = g | 0;
    if (a > maxI) a = maxI;
    i0[i] = a;
    fr[i] = g - a;
  }
  return { i0, fr };
}

/* ============================================================
   Camera + model init
   ============================================================ */
async function startCamera() {
  if (stream) stopStream();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: facingMode },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  });
  video.srcObject = stream;
  await video.play();
  await new Promise((res) => {
    if (video.readyState >= 2) return res();
    video.onloadeddata = () => res();
  });
  HEALTH.camera = true;
}

function stopStream() {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
}

let cpuMode = false; // true once we're on the CPU delegate
let switchingDelegate = false;
let gpuValidated = false; // GPU delegate produced a non-empty mask at least once
let emptyStreak = 0; // consecutive empty masks seen (drives auto-fallback)

async function initSegmenter(delegate = "GPU") {
  const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
  const make = (d) =>
    ImageSegmenter.createFromOptions(vision, {
      baseOptions: { modelAssetPath: HAIR_MODEL, delegate: d },
      runningMode: "VIDEO",
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    });
  try {
    segmenter = await make(delegate);
    if (delegate === "CPU") cpuMode = true;
  } catch (e) {
    if (delegate !== "CPU") {
      console.warn("[iColor] " + delegate + " delegate failed to create — using CPU", e);
      segmenter = await make("CPU");
      cpuMode = true;
    } else throw e;
  }
  HEALTH.model = true;
}

// Run segmentation on a source (video/canvas) and store a private copy of the
// hair mask. The copy matters: closing the result can free the underlying buffer.
// ---- Mask post-processing (reused buffers) ----
// Temporal EMA (kills frame-to-frame flicker) → erode (pulls the mask OFF the
// skin: hairline, temples, and the scalp showing through a parting) → box blur
// (smooth, anti-aliased edges). This runs on the small model mask (~256²), cheap.
let _mPrev = null, _mA = null, _mB = null, _mN = 0;
function ensureMaskBufs(n) {
  if (_mN === n) return;
  _mPrev = new Float32Array(n); _mA = new Float32Array(n); _mB = new Float32Array(n); _mN = n;
}
function erode3(src, dst, w, h) {
  for (let y = 0; y < h; y++) {
    const r0 = (y > 0 ? y - 1 : 0) * w, r1 = y * w, r2 = (y < h - 1 ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : 0, x1 = x, x2 = x < w - 1 ? x + 1 : w - 1;
      let m = src[r0 + x0];
      let v = src[r0 + x1]; if (v < m) m = v; v = src[r0 + x2]; if (v < m) m = v;
      v = src[r1 + x0]; if (v < m) m = v; v = src[r1 + x1]; if (v < m) m = v; v = src[r1 + x2]; if (v < m) m = v;
      v = src[r2 + x0]; if (v < m) m = v; v = src[r2 + x1]; if (v < m) m = v; v = src[r2 + x2]; if (v < m) m = v;
      dst[r1 + x] = m;
    }
  }
}
function boxBlur3(src, dst, w, h) {
  for (let y = 0; y < h; y++) {
    const r0 = (y > 0 ? y - 1 : 0) * w, r1 = y * w, r2 = (y < h - 1 ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : 0, x1 = x, x2 = x < w - 1 ? x + 1 : w - 1;
      dst[r1 + x] = (
        src[r0 + x0] + src[r0 + x1] + src[r0 + x2] +
        src[r1 + x0] + src[r1 + x1] + src[r1 + x2] +
        src[r2 + x0] + src[r2 + x1] + src[r2 + x2]) / 9;
    }
  }
}
function processMask(raw, w, h) {
  const n = w * h;
  ensureMaskBufs(n);
  const a = 0.55; // weight of the current frame in the temporal average
  for (let i = 0; i < n; i++) { const v = _mPrev[i] * (1 - a) + raw[i] * a; _mA[i] = v; _mPrev[i] = v; }
  erode3(_mA, _mB, w, h);   // shrink off skin / scalp / parting
  boxBlur3(_mB, _mA, w, h); // then soften the edge
  return _mA;
}

function segmentSource(src) {
  const result = segmenter.segmentForVideo(src, performance.now());
  const masks = result && result.confidenceMasks;
  if (masks && masks.length) {
    const hair = masks[masks.length > 1 ? 1 : 0];
    maskW = hair.width;
    maskH = hair.height;
    maskData = processMask(hair.getAsFloat32Array(), maskW, maskH);
  }
  result && result.close && result.close();
}

// Cheap sampled read of the current mask: peak confidence + hair coverage.
function maskSignal() {
  if (!maskData) return { max: 0, cover: 0 };
  let mx = 0, hot = 0, tot = 0;
  const step = Math.max(1, (maskData.length / 4096) | 0);
  for (let i = 0; i < maskData.length; i += step) {
    const v = maskData[i];
    if (v > mx) mx = v;
    if (v > 0.3) hot++;
    tot++;
  }
  return { max: mx, cover: tot ? hot / tot : 0 };
}
// Live "hair detected" badge (also shows GPU/CPU delegate).
let lastHairKey = "";
function updateHairStatus(sig) {
  if (!hairStatus) return;
  // Coverage (how much of the frame is confidently hair) is the reliable signal —
  // a broken delegate can spike a stray peak but covers ~0% of the frame.
  const state = sig.cover > 0.008 ? "ok" : sig.cover > 0.0015 ? "weak" : "none";
  const mode = cpuMode ? "CPU" : "GPU";
  const key = state + mode;
  if (key === lastHairKey) return;
  lastHairKey = key;
  hairStatus.classList.remove("ok", "weak", "none");
  hairStatus.classList.add(state);
  hairStatus.querySelector(".hs-text").textContent =
    state === "ok" ? "Hair detected" : state === "weak" ? "Hair barely visible" : "No hair — center your hair";
  hairStatus.querySelector(".hs-mode").textContent = mode;
  hairStatus.title = `coverage ${(sig.cover * 100).toFixed(1)}% · peak ${sig.max.toFixed(2)} · ${mode} delegate`;
}

// If the GPU delegate keeps returning an empty mask, rebuild on CPU (reliable).
async function switchToCpu(resegmentSrc) {
  if (cpuMode || switchingDelegate) return;
  switchingDelegate = true;
  try {
    console.warn("[iColor] hair mask empty on GPU — switching to CPU delegate");
    showToast("Optimizing hair detection…");
    const old = segmenter;
    await initSegmenter("CPU");
    cpuMode = true;
    old && old.close && old.close();
    lastVideoTime = -1;
    emptyStreak = 0;
    if (resegmentSrc) segmentSource(resegmentSrc);
    else if (staticMode && staticReady) segmentSource(staticImg);
    updateHairStatus(maskSignal());
    invalidate();
  } catch (e) {
    console.warn("[iColor] CPU switch failed", e);
  }
  switchingDelegate = false;
}

function validateDelegate(sig) {
  if (cpuMode || gpuValidated || switchingDelegate) return;
  if (sig.cover > 0.006) gpuValidated = true; // real hair area found
  else if (++emptyStreak >= 24) switchToCpu(); // sustained empty → CPU
}

/* ============================================================
   Render loop
   ============================================================ */
function sizeCanvases() {
  const vw = video.videoWidth || 1280;
  const vh = video.videoHeight || 720;
  const scale = Math.min(1, PROC_MAX_W / vw);
  const pw = Math.round(vw * scale);
  const ph = Math.round(vh * scale);
  if (proc.width !== pw || proc.height !== ph) {
    proc.width = pw;
    proc.height = ph;
  }
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
}

function invalidate() {
  needsRender = true;
}

function renderLoop() {
  if (!running) return;
  requestAnimationFrame(renderLoop);

  // ---- Uploaded still: only redraw when something changed ----
  if (staticMode) {
    if (!staticReady || (!needsRender && !isRecording())) return;
    needsRender = false;
    activeSource = staticImg;
    activeMirror = false;
    const pw = proc.width, ph = proc.height;
    pctx.drawImage(staticImg, 0, 0, pw, ph);
    if (gridMode) renderGrid();
    else {
      if (sel && maskData) recolorProc(pw, ph);
      blitDisplay();
    }
    return;
  }

  // ---- Live camera ----
  if (video.readyState < 2) return;
  activeSource = video;
  activeMirror = facingMode === "user";
  sizeCanvases();
  const pw = proc.width;
  const ph = proc.height;

  // Base frame for the single-view path (unmirrored).
  pctx.drawImage(video, 0, 0, pw, ph);

  // Segment only on new frames; keep last mask otherwise.
  const t = video.currentTime;
  if (segmenter && !switchingDelegate && t !== lastVideoTime) {
    lastVideoTime = t;
    segmentSource(video);
    const sig = maskSignal();
    validateDelegate(sig);
    updateHairStatus(sig);
  }

  if (gridMode) {
    renderGrid();
  } else {
    if (sel && maskData) recolorProc(pw, ph);
    blitDisplay();
  }

  // WATERMARK (disabled) — bake the iColor Plus mark into recorded video frames.
  // To re-enable, uncomment the next two lines:
  // if (recorder && recorder.state === "recording")
  //   drawWatermark(ctx, canvas.width, canvas.height);
}

function isRecording() {
  return recorder && recorder.state === "recording";
}

function recolorProc(pw, ph) {
  if (mapKey.pw !== pw || mapKey.ph !== ph || mapKey.mw !== maskW || mapKey.mh !== maskH) {
    mapX = buildMapBil(pw, maskW);
    mapY = buildMapBil(ph, maskH);
    Object.assign(mapKey, { pw, ph, mw: maskW, mh: maskH });
  }
  const frame = pctx.getImageData(0, 0, pw, ph);
  const d = frame.data;
  const s = strength;
  const R = sel.r, G = sel.g, B = sel.b;
  const X0 = mapX.i0, XF = mapX.fr, Y0 = mapY.i0, YF = mapY.fr, mW = maskW, mH = maskH;
  const hairLum = hairMeanLum(d, pw, ph, mapX, mapY, false); // for the relative skin guard
  // Optional dip-dye: gentle darker roots → lighter ends. Fully off (identical path)
  // unless features.twotone is on; then modulate the deposited colour by vertical
  // position within the hair's bounding box.
  const twoTone = FEATURES.twotone;
  let ttTop = 0, ttRange = 1, ttOn = false;
  if (twoTone) { const bb = hairVBox(); if (bb && bb.bot > bb.top + 0.05) { ttTop = bb.top; ttRange = bb.bot - bb.top; ttOn = true; } }
  for (let y = 0; y < ph; y++) {
    // per-row two-tone factor (0.9 at roots → 1.14 at ends)
    let ttF = 1;
    if (ttOn) { let p = (y / ph - ttTop) / ttRange; p = p < 0 ? 0 : p > 1 ? 1 : p; ttF = 0.9 + 0.24 * p; }
    const y0 = Y0[y], fy = YF[y], y1 = y0 + 1 < mH ? y0 + 1 : y0;
    const rowA = y0 * mW, rowB = y1 * mW;
    const rowPix = y * pw;
    for (let x = 0; x < pw; x++) {
      const x0 = X0[x], fx = XF[x], x1 = x0 + 1 < mW ? x0 + 1 : x0;
      const a0 = maskData[rowA + x0], b0 = maskData[rowA + x1];
      const a1 = maskData[rowB + x0], b1 = maskData[rowB + x1];
      const top = a0 + (b0 - a0) * fx, bot = a1 + (b1 - a1) * fx;
      const ma = maskAlpha(top + (bot - top) * fy); // bilinear-sampled hair confidence
      if (ma <= 0) continue;
      const i = (rowPix + x) << 2;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const lum = (r * 77 + g * 150 + b * 29) >> 8;
      const a = ma * s * (1 - 0.92 * skinFactor(r, g, b, lum, hairLum)); // never colour scalp/skin
      if (a <= 0.003) continue;
      const shine = lum > SHINE_T ? (lum - SHINE_T) * SHINE_K : 0;
      let tR = R[r], tG = G[g], tB = B[b];
      if (ttOn) { tR *= ttF; if (tR > 255) tR = 255; tG *= ttF; if (tG > 255) tG = 255; tB *= ttF; if (tB > 255) tB = 255; }
      d[i] = r + (tR + shine - r) * a;
      d[i + 1] = g + (tG + shine - g) * a;
      d[i + 2] = b + (tB + shine - b) * a;
    }
  }
  pctx.putImageData(frame, 0, 0);
}

// Vertical bounding box of confident hair (normalized 0..1) — for the two-tone effect.
function hairVBox() {
  if (!maskData) return null;
  let top = -1, bot = -1;
  for (let my = 0; my < maskH; my++) {
    const row = my * maskW;
    let any = false;
    for (let mx = 0; mx < maskW; mx += 2) { if (maskData[row + mx] > 0.6) { any = true; break; } }
    if (any) { if (top < 0) top = my; bot = my; }
  }
  return top < 0 ? null : { top: top / maskH, bot: bot / maskH };
}

/* ---- single-view / split blit ---- */
function drawFull(src) {
  const W = canvas.width, H = canvas.height;
  if (activeMirror) ctx.setTransform(-1, 0, 0, 1, W, 0);
  else ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(src, 0, 0, W, H);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function blitDisplay() {
  const W = canvas.width, H = canvas.height;
  // "After" (colored) fills the frame.
  drawFull(proc);

  if (splitView) {
    const sx = Math.round(clamp(splitX, 0.04, 0.96) * W);
    // "Before" (original) clipped to the left of the divider.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.rect(0, 0, sx, H);
    ctx.clip();
    if (activeMirror) ctx.setTransform(-1, 0, 0, 1, W, 0);
    ctx.drawImage(activeSource, 0, 0, W, H);
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawDivider(sx, W, H);
  }
}

function drawDivider(sx, W, H) {
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = Math.max(2, W * 0.006);
  ctx.beginPath();
  ctx.moveTo(sx, 0);
  ctx.lineTo(sx, H);
  ctx.stroke();

  // handle
  const r = Math.max(16, W * 0.03);
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.beginPath();
  ctx.arc(sx, H / 2, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#5f7d2e";
  const a = r * 0.42;
  // left/right arrows
  ctx.beginPath();
  ctx.moveTo(sx - a * 0.3, H / 2 - a);
  ctx.lineTo(sx - a * 1.1, H / 2);
  ctx.lineTo(sx - a * 0.3, H / 2 + a);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(sx + a * 0.3, H / 2 - a);
  ctx.lineTo(sx + a * 1.1, H / 2);
  ctx.lineTo(sx + a * 0.3, H / 2 + a);
  ctx.closePath();
  ctx.fill();

  // labels
  const f = Math.max(12, Math.round(W * 0.03));
  ctx.font = `700 ${f}px "Segoe UI", system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  pill(ctx, "BEFORE", 12, 16 + f / 2, f, "left");
  pill(ctx, "AFTER", W - 12, 16 + f / 2, f, "right");
  ctx.restore();
}

function pill(c, text, x, y, f, align) {
  const padX = f * 0.6;
  c.font = `700 ${f}px "Segoe UI", system-ui, sans-serif`;
  const w = c.measureText(text).width + padX * 2;
  const h = f * 1.7;
  let bx = align === "left" ? x : x - w;
  c.fillStyle = "rgba(0,0,0,0.5)";
  roundRect(c, bx, y - h / 2, w, h, h / 2);
  c.fill();
  c.fillStyle = "#fff";
  c.textAlign = "left";
  c.fillText(text, bx + padX, y);
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/* ============================================================
   Watermark (subtle iColor Plus branding on exports)
   ---
   CURRENTLY DISABLED. To re-enable, uncomment the two call sites
   marked "WATERMARK (disabled)" — one in renderLoop() (for video)
   and one in takePhoto() (for photos). This function can stay as-is.
   ============================================================ */
function drawWatermark(c, W, H) {
  const m = Math.round(Math.min(W, H) * 0.035);
  const fs = Math.max(13, Math.round(Math.min(W, H) * 0.045));
  const serif = `700 ${fs}px Georgia, 'Times New Roman', serif`;
  const script = `italic 700 ${fs}px 'Segoe Script','Brush Script MT','Snell Roundhand',cursive`;
  c.save();
  c.globalAlpha = 0.72;
  c.shadowColor = "rgba(0,0,0,0.55)";
  c.shadowBlur = Math.max(2, fs * 0.2);
  c.shadowOffsetY = 1;
  c.textBaseline = "alphabetic";
  c.textAlign = "left";
  c.font = serif;
  const iw = c.measureText("iColor").width;
  c.font = script;
  const pw = c.measureText("plus").width;
  const gap = fs * 0.22;
  const x = W - m - (iw + gap + pw);
  const y = H - m;
  c.font = serif;
  c.fillStyle = "rgba(255,255,255,0.92)";
  c.fillText("iColor", x, y);
  c.font = script;
  c.fillStyle = "rgba(232,206,120,0.96)";
  c.fillText("plus", x + iw + gap, y);
  c.restore();
}

/* ============================================================
   Grid (multi-shade compare)
   ============================================================ */
function buildGridItems() {
  gridItems = [{ name: "Original", shade: SHADES[0], lut: null }];
  SHADES.filter((s) => s.hex).forEach((s) =>
    gridItems.push({ name: s.name, shade: s, lut: makeLUT(s.hex) })
  );
}

function renderGrid() {
  const W = canvas.width, H = canvas.height;
  const n = gridItems.length;
  const cols = H >= W ? 3 : 4;
  const rows = Math.ceil(n / cols);
  const cw = Math.floor(W / cols);
  const ch = Math.floor(H / rows);

  if (gridBase.width !== cw || gridBase.height !== ch) {
    gridBase.width = cw;
    gridBase.height = ch;
    gWork = new Uint8ClampedArray(cw * ch * 4);
    gCellImg = ctx.createImageData(cw, ch);
  }
  gridLayout = { cols, rows, cw, ch };

  // Base frame shared by every cell (mirrored only for the live front camera).
  if (activeMirror) gbctx.setTransform(-1, 0, 0, 1, cw, 0);
  else gbctx.setTransform(1, 0, 0, 1, 0, 0);
  gbctx.drawImage(activeSource, 0, 0, cw, ch);
  gbctx.setTransform(1, 0, 0, 1, 0, 0);
  const baseImg = gbctx.getImageData(0, 0, cw, ch);
  const baseData = baseImg.data;

  const mirror = activeMirror;
  if (maskData && (gKey.cw !== cw || gKey.ch !== ch || gKey.mw !== maskW || gKey.mh !== maskH)) {
    gMapX = buildMapBil(cw, maskW);
    gMapY = buildMapBil(ch, maskH);
    Object.assign(gKey, { cw, ch, mw: maskW, mh: maskH });
  }

  // Clear letterbox areas.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);

  for (let i = 0; i < n; i++) {
    const cx = (i % cols) * cw;
    const cy = Math.floor(i / cols) * ch;
    const item = gridItems[i];
    if (item.lut && maskData) {
      gWork.set(baseData);
      recolorBuffer(gWork, cw, ch, item.lut, gMapX, gMapY, mirror);
      gCellImg.data.set(gWork);
      ctx.putImageData(gCellImg, cx, cy);
    } else {
      ctx.putImageData(baseImg, cx, cy);
    }
  }

  // Labels + selected highlight (drawn on top).
  const f = Math.max(9, Math.round(ch * 0.11));
  ctx.textBaseline = "alphabetic";
  for (let i = 0; i < n; i++) {
    const cx = (i % cols) * cw;
    const cy = Math.floor(i / cols) * ch;
    // label bar
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(cx, cy + ch - f * 1.7, cw, f * 1.7);
    ctx.fillStyle = "#fff";
    ctx.font = `600 ${f}px "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = "center";
    fitText(ctx, item.name, cx + cw / 2, cy + ch - f * 0.55, cw - 8);
    // selected border
    if (item.shade.id === selectedShade.id) {
      ctx.strokeStyle = "#e6b93f";
      ctx.lineWidth = Math.max(3, cw * 0.02);
      ctx.strokeRect(cx + ctx.lineWidth / 2, cy + ctx.lineWidth / 2, cw - ctx.lineWidth, ch - ctx.lineWidth);
    }
    // thin cell separators
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.lineWidth = 1;
    ctx.strokeRect(cx + 0.5, cy + 0.5, cw - 1, ch - 1);
  }
  ctx.textAlign = "left";
}

// Recolor a copied pixel buffer in place using per-luminance LUTs + hair mask.
// Shared by the live grid and the exported comparison sheet.
function recolorBuffer(work, w, h, lut, mapx, mapy, mirror) {
  const s = strength;
  const R = lut.r, G = lut.g, B = lut.b;
  const X0 = mapx.i0, XF = mapx.fr, Y0 = mapy.i0, YF = mapy.fr, mW = maskW, mH = maskH, mWm1 = mW - 1;
  const hairLum = hairMeanLum(work, w, h, mapx, mapy, mirror); // for the relative skin guard
  for (let y = 0; y < h; y++) {
    const y0 = Y0[y], fy = YF[y], y1 = y0 + 1 < mH ? y0 + 1 : y0;
    const rowA = y0 * mW, rowB = y1 * mW;
    const rowPix = y * w;
    for (let x = 0; x < w; x++) {
      let gx = X0[x] + XF[x];            // float mask-x (unmirrored)
      if (mirror) gx = mWm1 - gx;
      let x0 = gx | 0; if (x0 < 0) x0 = 0; else if (x0 > mWm1) x0 = mWm1;
      let fx = gx - x0; if (fx < 0) fx = 0;
      const x1 = x0 + 1 < mW ? x0 + 1 : x0;
      const a0 = maskData[rowA + x0], b0 = maskData[rowA + x1];
      const a1 = maskData[rowB + x0], b1 = maskData[rowB + x1];
      const top = a0 + (b0 - a0) * fx, bot = a1 + (b1 - a1) * fx;
      const ma = maskAlpha(top + (bot - top) * fy); // bilinear-sampled hair confidence
      if (ma <= 0) continue;
      const i = (rowPix + x) << 2;
      const r = work[i], g = work[i + 1], b = work[i + 2];
      const lum = (r * 77 + g * 150 + b * 29) >> 8;
      const a = ma * s * (1 - 0.92 * skinFactor(r, g, b, lum, hairLum)); // never colour scalp/skin
      if (a <= 0.003) continue;
      const shine = lum > SHINE_T ? (lum - SHINE_T) * SHINE_K : 0;
      work[i] = r + (R[r] + shine - r) * a;
      work[i + 1] = g + (G[g] + shine - g) * a;
      work[i + 2] = b + (B[b] + shine - b) * a;
    }
  }
}

/* ============================================================
   Exported comparison sheet (all shades, labeled, branded)
   ============================================================ */
function buildComparisonSheet() {
  const vw = activeSource.videoWidth || activeSource.width;
  const vh = activeSource.videoHeight || activeSource.height;
  if (!maskData || !vw) return null;
  const items = gridItems;
  const n = items.length;
  const cols = 3;
  const rows = Math.ceil(n / cols);
  const cellW = 300;
  const imgH = Math.round((cellW * vh) / vw);
  const capH = 40;
  const cellH = imgH + capH;
  const pad = 12;
  const headerH = 108;
  const footerH = 40;
  const W = cols * cellW + pad * (cols + 1);
  const H = headerH + rows * cellH + pad * (rows + 1) + footerH;

  const sheet = document.createElement("canvas");
  sheet.width = W;
  sheet.height = H;
  const c = sheet.getContext("2d");
  c.fillStyle = "#0d0f0a";
  c.fillRect(0, 0, W, H);

  // Header band
  const grad = c.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, "#5f7d2e");
  grad.addColorStop(1, "#b8942f");
  c.fillStyle = grad;
  c.fillRect(0, 0, W, headerH);
  c.fillStyle = "#ffffff";
  c.textBaseline = "middle";
  c.textAlign = "left";
  c.font = "800 40px Georgia, 'Times New Roman', serif";
  c.fillText("iColor", 34, headerH / 2 - 6);
  const iw = c.measureText("iColor").width;
  c.font = "italic 700 34px 'Segoe Script','Brush Script MT',cursive";
  c.fillText("plus", 34 + iw + 8, headerH / 2 - 2);
  c.font = "600 17px 'Segoe UI', system-ui, sans-serif";
  c.fillText("SHAMPOO-IN HAIR COLOR", 36, headerH / 2 + 26);
  c.textAlign = "right";
  c.font = "700 22px 'Segoe UI', system-ui, sans-serif";
  c.fillText("Hair Color Comparison", W - 34, headerH / 2);
  c.textAlign = "left";

  // Mirrored base frame at cell resolution
  const base = document.createElement("canvas");
  base.width = cellW;
  base.height = imgH;
  const bctx = base.getContext("2d", { willReadFrequently: true });
  if (activeMirror) bctx.setTransform(-1, 0, 0, 1, cellW, 0);
  bctx.drawImage(activeSource, 0, 0, cellW, imgH);
  bctx.setTransform(1, 0, 0, 1, 0, 0);
  const baseImg = bctx.getImageData(0, 0, cellW, imgH);
  const mirror = activeMirror;
  const mapx = buildMapBil(cellW, maskW);
  const mapy = buildMapBil(imgH, maskH);
  const work = new Uint8ClampedArray(baseImg.data.length);
  const cellImg = c.createImageData(cellW, imgH);

  for (let i = 0; i < n; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = pad + col * (cellW + pad);
    const y = headerH + pad + row * (cellH + pad);

    if (items[i].lut) {
      work.set(baseImg.data);
      recolorBuffer(work, cellW, imgH, items[i].lut, mapx, mapy, mirror);
      cellImg.data.set(work);
      c.putImageData(cellImg, x, y);
    } else {
      c.putImageData(baseImg, x, y);
    }

    // caption bar
    c.fillStyle = "#151810";
    c.fillRect(x, y + imgH, cellW, capH);
    const cy = y + imgH + capH / 2;
    let tx = x + 14;
    if (items[i].shade.hex) {
      c.fillStyle = items[i].shade.hex;
      c.beginPath();
      c.arc(x + 20, cy, 8, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = "rgba(255,255,255,0.5)";
      c.lineWidth = 1.5;
      c.stroke();
      tx = x + 36;
    }
    c.fillStyle = "#f5f0f7";
    c.font = "600 15px 'Segoe UI', system-ui, sans-serif";
    c.textBaseline = "middle";
    c.fillText(items[i].name, tx, cy + 1);

    // frame
    c.strokeStyle = "rgba(255,255,255,0.08)";
    c.lineWidth = 1;
    c.strokeRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);
  }

  // Footer
  c.fillStyle = "#8a8f7e";
  c.font = "12px 'Segoe UI', system-ui, sans-serif";
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText(
    "Digital preview — actual results may vary. " + levelLabel(level) + ".",
    W / 2,
    H - footerH / 2
  );
  c.textAlign = "left";
  return sheet;
}

function saveComparisonSheet() {
  const sheet = buildComparisonSheet();
  if (!sheet) {
    showToast("Point the camera at your hair first");
    return;
  }
  doFlash();
  sheet.toBlob(
    (blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const name = `icolorplus-comparison-${timestamp()}.jpg`;
      addCapture({ type: "photo", url, blob, name });
      triggerDownload(url, name);
      showToast("Comparison sheet saved to your device");
    },
    "image/jpeg",
    0.95
  );
}

function fitText(c, text, x, y, maxW) {
  let t = text;
  while (c.measureText(t).width > maxW && t.length > 3) t = t.slice(0, -1);
  if (t !== text) t = t.slice(0, -1) + "…";
  c.fillText(t, x, y);
}

/* ============================================================
   Hair & skin analysis + recommendations
   ============================================================ */
const HAIR_LEVELS = [
  { max: 24, level: 1, name: "Level 1 · Black" },
  { max: 44, level: 2, name: "Level 2 · Soft Black" },
  { max: 69, level: 3, name: "Level 3 · Dark Brown" },
  { max: 94, level: 4, name: "Level 4 · Medium Brown" },
  { max: 119, level: 5, name: "Level 5 · Light Brown" },
  { max: 144, level: 6, name: "Level 6 · Dark Blonde" },
  { max: 169, level: 7, name: "Level 7 · Blonde" },
  { max: 194, level: 8, name: "Level 8 · Light Blonde" },
  { max: 219, level: 9, name: "Level 9 · Very Light Blonde" },
  { max: 255, level: 10, name: "Level 10 · Lightest Blonde" },
];
function levelFor(lum) {
  return HAIR_LEVELS.find((b) => lum <= b.max) || HAIR_LEVELS[HAIR_LEVELS.length - 1];
}
function skinDepthName(lum) {
  return lum >= 200 ? "Fair" : lum >= 168 ? "Light" : lum >= 136 ? "Medium" : lum >= 104 ? "Tan" : "Deep";
}
function rgbToHex([r, g, b]) {
  return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, "0")).join("");
}
function saturationOf([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx === 0 ? 0 : (mx - mn) / mx;
}
// Warm (yellow/golden) vs cool (pink/red) vs neutral, normalized for depth.
function undertoneOf([r, g, b]) {
  const score = ((r - 2 * g + b) / (r + g + b + 1)) * 100;
  if (score < -2) return "warm";
  if (score > 4) return "cool";
  return "neutral";
}
function hairToneOf(rgb) {
  if (saturationOf(rgb) < 0.14) return "neutral";
  return undertoneOf(rgb);
}

// Average the real hair color and (roughly) the skin color from the current frame.
// Confidence-weighted so a soft hair mask still analyzes; stores a diagnostic.
const HAIR_ANALYZE_MIN = 0.25; // hair inclusion threshold (aligned closer to the recolor cutoff)
function analyzeCurrent() {
  const dbg = { hasMask: !!maskData, maskMax: 0, hairPixels: 0, skinPixels: 0 };
  window.__hairAnalysisDebug = dbg;
  if (!maskData) return null;
  const src = staticMode ? staticImg : video;
  const sw = src.videoWidth || src.width;
  if (!sw) return null;

  const W = proc.width, H = proc.height;
  const acan = document.createElement("canvas");
  acan.width = W;
  acan.height = H;
  const actx = acan.getContext("2d", { willReadFrequently: true });
  actx.drawImage(src, 0, 0, W, H); // original (unrecolored) frame
  const data = actx.getImageData(0, 0, W, H).data;
  const mapx = buildMap(W, maskW), mapy = buildMap(H, maskH);

  let hr = 0, hg = 0, hb = 0, hw = 0, hcount = 0; // confidence-weighted hair
  let sr = 0, sg = 0, sb = 0, sn = 0; // skin accumulators
  let maskMax = 0;
  for (let y = 0; y < H; y += 2) {
    const rowMask = mapy[y] * maskW;
    const faceY = y > H * 0.34;
    for (let x = 0; x < W; x += 2) {
      const m = maskData[rowMask + mapx[x]];
      if (m > maskMax) maskMax = m;
      const i = (y * W + x) << 2;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (m > HAIR_ANALYZE_MIN) {
        hr += r * m; hg += g * m; hb += b * m; hw += m; hcount++;
      } else if (m < 0.2 && faceY && x > W * 0.14 && x < W * 0.86) {
        // crude skin filter: warm-ish, mid-bright, R>=G>=B
        if (r > 45 && r < 252 && r >= g && g >= b - 12 && r - b > 6) {
          sr += r; sg += g; sb += b; sn++;
        }
      }
    }
  }
  dbg.maskMax = +maskMax.toFixed(3);
  dbg.hairPixels = hcount;
  dbg.skinPixels = sn;
  if (hcount < 15 || hw <= 0) return null;

  const hair = [Math.round(hr / hw), Math.round(hg / hw), Math.round(hb / hw)];
  const hairLum = (hair[0] * 77 + hair[1] * 150 + hair[2] * 29) >> 8;
  const level = levelFor(hairLum);
  const hairTone = hairToneOf(hair);

  let skin = null, skinDepth = null, skinUndertone = null;
  if (sn > 30) {
    skin = [Math.round(sr / sn), Math.round(sg / sn), Math.round(sb / sn)];
    const sLum = (skin[0] * 77 + skin[1] * 150 + skin[2] * 29) >> 8;
    skinDepth = skinDepthName(sLum);
    skinUndertone = undertoneOf(skin);
  }

  const under = skinUndertone || hairTone;
  const recs = buildRecommendations(under, level.level);
  const statements = pickStatements(under, level.level);
  const brightening = brighteningAdvice(level);
  return { hair, level, hairTone, skin, skinDepth, skinUndertone, under, recs, statements, brightening };
}

function buildRecommendations(under, hairLevel, vibe) {
  let meta = SHADES.filter((s) => s.hex).map((s) => {
    const [r, g, b] = hexToRgb(s.hex);
    const lum = (r * 77 + g * 150 + b * 29) >> 8;
    return { shade: s, level: levelFor(lum).level, tone: s.tone };
  });
  const achievable = (m) => m.level <= hairLevel + 1;
  // Vibe filters
  if (vibe === "natural") meta = meta.filter((m) => !m.shade.statement);
  else if (vibe === "bold") meta = meta.filter((m) => m.shade.statement);
  else if (vibe === "low") meta = meta.filter((m) => !m.shade.statement && achievable(m));

  const scored = meta
    .map((m) => {
      let s = 0;
      if (under === "neutral") s += 2;
      else if (m.tone === under) s += 3;
      else if (m.tone === "neutral") s += 1.5;
      if (achievable(m)) s += 1.5;
      if (vibe === "low" && m.level <= hairLevel) s += 1.5; // darker = hides regrowth
      if (vibe === "bold" && m.tone === under) s += 1;
      return { ...m, s };
    })
    .sort((a, b) => b.s - a.s);

  const picks = [];
  const levels = new Set();
  for (const m of scored) {
    if (picks.length >= 4) break;
    if (picks.length >= 2 && levels.has(m.level) && vibe !== "bold") continue; // depth variety
    picks.push(m);
    levels.add(m.level);
  }
  return picks.map((m) => ({
    shade: m.shade,
    level: m.level,
    achievable: achievable(m),
    reason: reasonFor(m, under, achievable(m)),
    tag: shadeTag(m, under, hairLevel, achievable(m)),
  }));
}

// Short "why this shade" one-liner tag.
function shadeTag(m, under, hairLevel, ok) {
  if (m.shade.statement) return under === "neutral" || m.tone === under ? "Bold & suits you" : "Bold contrast";
  if (ok && m.level <= hairLevel && (m.tone === "neutral" || m.tone === under)) return "Low-upkeep match";
  if (m.tone === under) return m.tone === "warm" ? "Warm & flattering" : "Cool & flattering";
  if (m.tone === "neutral") return "Natural & safe";
  return under === "neutral" ? "Versatile pick" : "Softer contrast";
}

// Verdict on a shade the user picked themselves: does it suit them, and why.
function evaluatePick(shade, a) {
  const under = a.under, hairLevel = a.level.level;
  const [r, g, b] = hexToRgb(shade.hex);
  const level = levelFor((r * 77 + g * 150 + b * 29) >> 8).level;
  const tone = shade.tone;
  const ok = level <= hairLevel + 1;
  const clash = under !== "neutral" && tone !== "neutral" && tone !== under;
  let verdict, why;
  if (clash) {
    const base = tone === "warm"
      ? "This warm, golden shade can look brassy or orange against your cool undertone"
      : "This cool, ashy shade can read flat or greyish against your warm undertone";
    if (shade.statement) {
      verdict = "bold";
      why = base + " — but as a deliberate statement it can still look striking if that's the vibe you want." + (ok ? "" : " It would need pre-lightening first.");
    } else {
      verdict = "poor";
      why = base + `; a ${under === "warm" ? "warmer" : "cooler"} shade will flatter you more.` + (ok ? "" : " It would also need pre-lightening.");
    }
  } else if (ok) {
    verdict = "great";
    why = `Suits your ${under === "neutral" ? "versatile neutral" : under} undertone and needs no lightening on your Level ${hairLevel} hair — an easy, flattering pick.`;
  } else {
    verdict = "good";
    why = `Flatters your ${under === "neutral" ? "neutral" : under} undertone, but it sits lighter than your Level ${hairLevel} hair — pre-lighten first to get the true colour.`;
  }
  return { shade, verdict, why, ok, level };
}

// Bold statement colours that still flatter (or intentionally contrast) the skin tone.
function pickStatements(under, hairLevel) {
  const meta = SHADES.filter((s) => s.hex && s.statement).map((s) => {
    const [r, g, b] = hexToRgb(s.hex);
    const lum = (r * 77 + g * 150 + b * 29) >> 8;
    return { shade: s, level: levelFor(lum).level, tone: s.tone };
  });
  const scored = meta
    .map((m) => {
      let s = 0;
      if (under === "neutral") s += 1.5;
      else if (m.tone === under) s += 2.5;
      else s += 1; // statements can still work as a bold contrast
      return { ...m, s };
    })
    .sort((a, b) => b.s - a.s);
  return scored.slice(0, 2).map((m) => ({
    shade: m.shade,
    level: m.level,
    achievable: m.level <= hairLevel + 1,
    reason: statementReason(m, under),
    tag: (under === "neutral" || m.tone === under) ? "Bold & suits you" : "Bold statement",
  }));
}

function statementReason(m, under) {
  const tw = m.tone === "warm" ? "fiery" : m.tone === "cool" ? "cool-toned" : "bold";
  const fit =
    under === "neutral" ? "your neutral undertone can carry it"
    : m.tone === under ? `plays into your ${under} undertone`
    : `makes a striking contrast with your ${under} undertone`;
  return `A ${tw} statement shade — ${fit}. Shows most vivid on a pre-lightened base.`;
}

// Advice on getting brighter/livelier colour (lightening), tuned to hair level.
function brighteningAdvice(lvl) {
  const L = lvl.level;
  if (L <= 3)
    return {
      headline: "Your hair is naturally dark, so blues, pastels and bright reds need lightening first to show.",
      tips: [
        "Pre-lighten (bleach) to a pale level 7–9 base before vivid or pastel shades — the lighter and more even the base, the truer the colour.",
        "Dark hair usually needs professional lightening over 1–2+ sessions; forcing it in one go seriously damages hair.",
        "Always use a bond-builder (Olaplex-type) while lightening, then deep-condition and go sulfate-free.",
        "Low commitment? Burgundy, wild cherry and mahogany glow on dark hair with NO bleaching needed.",
      ],
    };
  if (L <= 6)
    return {
      headline: "Your medium base takes colour well and needs only light lifting for bright shades.",
      tips: [
        "A gentle lift to level 8–9 makes you bright/pastel-ready without heavy bleaching.",
        "Warm reds, coppers and violets show beautifully on your base with little or no lightening.",
        "Use a bond-builder when lifting and a weekly mask to keep hair strong and glossy.",
      ],
    };
  return {
    headline: "Your light base is ideal — vivid and pastel shades show almost true with little to no lightening.",
    tips: [
      "You can usually apply pastels/brights directly; tone to a clean pale blonde first for the purest result.",
      "Use a bond-builder if you do lift, and a sulfate-free routine to hold vibrancy longer.",
    ],
  };
}

function reasonFor(m, under, ok) {
  const toneWord = m.tone === "warm" ? "warm, golden" : m.tone === "cool" ? "cool, ashy" : "balanced, neutral";
  const fit =
    under === "neutral" ? "your neutral undertone wears almost anything"
    : m.tone === under ? `mirrors your ${under} undertone for a natural, harmonious look`
    : m.tone === "neutral" ? "a safe, universally flattering choice"
    : `adds flattering contrast to your ${under} undertone`;
  const how = ok
    ? "deposits straight onto your current hair"
    : "sits lighter than your hair — pre-lighten first for the true colour";
  return `A ${toneWord} shade — ${fit}; ${how}.`;
}

function applicationTips(top) {
  const steps = [
    "Do a 48-hour skin patch test and a strand test first — especially for reds and fashion shades.",
    "Start on dry, product-free hair. Wear the gloves provided and drape your shoulders.",
    "Section hair into four. Apply the iColor Plus shampoo-in colour root-to-tip, saturating every strand.",
    "Comb through for even coverage, then leave on per the pack (about 15–30 min). Longer develops a deeper, richer tone.",
    "Rinse with cool water until it runs clear, then seal the cuticle with the conditioner sachet.",
  ];
  if (top && !top.achievable)
    steps.splice(2, 0, "Your target is lighter than your hair — pre-lighten with LoveColor Lightening Crème (or Vanilla Blonde prep) to a pale, even base first, then apply the shade to tone.");
  if (top && top.shade.tone === "cool")
    steps.push("Cool/ash tones grab fast — check every few minutes so it doesn't over-deposit.");
  if (top && top.shade.tone === "warm")
    steps.push("Wrapping hair in a warm towel for a few minutes boosts warmth and shine.");
  return steps;
}

function aftercareTips(top) {
  const t = [
    "Wait 48–72 hours before the first wash so the colour fully sets.",
    "Wash less often, in lukewarm/cool water, with a sulfate-free colour-safe shampoo.",
    "Refresh every 4–6 weeks with the matching iColor Plus shampoo-in shade — it tops up tone as you wash.",
    "Deep-condition weekly and always use heat protectant before styling.",
    "Shield hair from sun, chlorine and salt water, which speed up fading.",
  ];
  const name = top ? top.shade.name.toLowerCase() : "";
  if (top && /red|cherry|burgundy|copper|mahogany/.test(name))
    t.splice(2, 0, "Reds and coppers fade fastest — refresh a little more often and skip hot showers.");
  else if (top && top.shade.tone === "cool")
    t.splice(2, 0, "Use a purple/blue toning wash between refreshes to keep ash tones from turning brassy.");
  if (top && !top.achievable)
    t.push("Pre-lightened hair is porous — weekly bond-repair or keratin masks keep it strong and glossy.");
  return t;
}

function stripTags(s) { return String(s).replace(/<[^>]*>/g, ""); }
function shadeFamily(name) {
  const n = (name || "").toLowerCase();
  if (/red|cherry|burgundy|copper|mahogany|wine/.test(n)) return "red";
  if (/pink|purple|blue|pastel/.test(n)) return "pastel";
  if (/ash|silver|grey|gray/.test(n)) return "ash";
  if (/nude|beige/.test(n)) return "nude";
  if (/blonde|vanilla/.test(n)) return "blonde";
  return "natural";
}

// Consultant-style, product-led "how to get the colour you want." Built around the
// shade being tried (selectedShade), falling back to the top recommendation. Copy is
// tailored per shade family; upsells the iColor / LoveColor / Argan Beauty line, adds
// the SKU price + the backend promo/coupon as an offer. Returns HTML + plain variants
// (the printed/saved cards draw plain text on canvas).
function colourGamePlan(a) {
  let target = (selectedShade && selectedShade.hex && selectedShade.id !== "none")
    ? selectedShade
    : (a.recs && a.recs[0] && a.recs[0].shade);
  if (!target || !target.hex) return null;
  const targetLevel = shadeReqLevel(target);
  const hairLevel = a.level.level;
  const apps = Math.max(0, targetLevel - hairLevel); // ≈ one LoveColor application per level
  const name = target.name;
  const baseName = a.level.name.replace(/^Level \d+ · /, "").toLowerCase();
  const cur = (CONFIG.commerce || {}).currency || "₱";
  const fam = shadeFamily(name);
  const cool = fam === "pastel" || fam === "ash" || fam === "blonde" || target.tone === "cool";
  const red = fam === "red";
  const steps = [], kit = [];

  const FAM = {
    red:     { emoji: "🍒", hook: "rich, glossy reds are having a major moment" },
    pastel:  { emoji: "💗", hook: "pastels are pure main-character energy" },
    ash:     { emoji: "🧊", hook: "cool ash tones look so expensive" },
    nude:    { emoji: "🤎", hook: "soft nude tones read effortless and pricey" },
    blonde:  { emoji: "🌟", hook: "going blonde is bold and so worth it" },
    natural: { emoji: "✨", hook: "a timeless, everyday-gorgeous choice" },
  };
  const f = FAM[fam] || FAM.natural;
  const headline = `${f.emoji} <b>${name}</b> — ${f.hook}. ` + (apps > 0
    ? `It sits lighter than your ${baseName}, so here's exactly how we get you there:`
    : `And it's a <b>direct colour</b> — no lightening needed. Here's how to nail a salon finish:`);

  if (apps > 0) {
    steps.push(`<b>Lighten the base with LoveColor Hair Lightening Crème.</b> Each 35-minute application lifts about one level — from your Level ${hairLevel}, plan on about <b>${apps} application${apps > 1 ? "s" : ""}</b> to reach <b>Level ${targetLevel}</b>. Rest 30 minutes between rounds (same-day, or spaced over weeks to keep hair healthy).`);
    kit.push({ name: "LoveColor Hair Lightening Crème", price: "" });
    if (targetLevel >= 9) {
      steps.push(`Keep the blonde bright and brass-free with <b>LoveColor Purple Shampoo &amp; Conditioner</b> — it's what makes an ash or pastel really pay off.`);
      kit.push({ name: "LoveColor Purple Shampoo & Conditioner", price: "" });
    }
  }
  steps.push(`<b>Colour with iColor Plus ${name} Shampoo-In.</b> On ${apps > 0 ? "the lightened, towel-dried base" : "clean, dry hair"}, massage in 5 minutes, leave <b>30–45 minutes</b> for a full, even deposit, then rinse cool.`);
  kit.push({ name: `iColor Plus ${name}`, price: target.buyPrice ? cur + target.buyPrice : "" });
  if (red) steps.push(`Reds are vivid but fade first — a quick <b>${name}</b> refresh every couple of weeks keeps it juicy.`);
  else if (cool) steps.push(`Cool &amp; ash tones grab fast — check every few minutes and keep a purple toning wash in rotation so it never turns brassy.`);
  else if (fam === "nude") steps.push(`Nudes look best kept soft — a weekly toning wash stops any warm/yellow from creeping in.`);
  steps.push(`<b>Seal &amp; nourish with the Argan Beauty Hair Mask &amp; Serum.</b> 5 minutes of mask, then a few drops of serum for that glassy, salon shine.`);
  kit.push({ name: "Argan Beauty Hair Mask & Serum", price: "" });
  steps.push(`<b>Keep it gorgeous:</b> refresh <b>${name}</b> every 4–6 weeks, wash cool and less often, and always patch-test first. 💛`);

  // Offer line from whatever the client set in the backend admin (coupon first, else promo).
  let offer = null;
  const cp = CONFIG.coupon || {};
  if (FEATURES.coupon && cp.enabled && (cp.code || cp.label)) {
    offer = "🎁 " + (cp.label || "Special offer") + (cp.code ? " — code " + cp.code : "");
  } else if (FEATURES.promo && (CONFIG.promo || {}).enabled) {
    const ap = activePromo();
    if (ap && (ap.title || ap.message)) offer = "✨ " + [ap.title, ap.message].filter(Boolean).join(" — ");
  }

  const summary = apps > 0
    ? `Lighten ~${apps}× to Level ${targetLevel} → colour with ${name} → nourish with Argan Beauty.`
    : `Colour with ${name} → nourish with Argan Beauty → refresh every 4–6 weeks.`;

  return {
    family: fam, apps, targetLevel, shadeName: name,
    headline, headlinePlain: stripTags(headline),
    steps, stepsPlain: steps.map(stripTags),
    kit, kitNames: kit.map((k) => k.name), offer, summary,
  };
}

// "Add the whole kit to cart" — resolve one URL that carries as much of the
// recommended kit as possible: a client bundle URL, else a combined Shopify cart
// permalink of the SKUs that share one store, else at least the colour's page.
const KIT_MATCH = { lighten: /lighten|bleach|crème|creme/i, purple: /purple|toning|violet/i, argan: /argan|mask|serum|treatment/i };
function kitItemFor(name) {
  const items = (CONFIG.kit && Array.isArray(CONFIG.kit.items)) ? CONFIG.kit.items : [];
  const n = String(name || "").toLowerCase();
  for (const it of items) { const re = KIT_MATCH[it.key]; if (re && re.test(n)) return it; }
  return null;
}
function buildKitCart(gp) {
  if (!FEATURES.commerce) return null;
  const kit = CONFIG.kit || {};
  if (kit.bundleUrl) return { url: kit.bundleUrl, kind: "bundle" };
  const parts = [];
  const push = (url, variant) => { if (!url || !variant) return; try { parts.push({ origin: new URL(url).origin, variant: String(variant) }); } catch (e) {} };
  if (selectedShade && selectedShade.buyUrl) push(selectedShade.buyUrl, selectedShade.buyVariant);
  ((gp && gp.kit) || []).forEach((k) => { const it = kitItemFor(k.name); if (it) push(it.url, it.variant); });
  if (parts.length) {
    const origin = parts[0].origin;
    const same = parts.filter((p) => p.origin === origin);
    if (same.length) return { url: origin + "/cart/" + same.map((p) => p.variant + ":1").join(","), kind: "cart", n: same.length };
  }
  if (selectedShade && selectedShade.buyUrl) return { url: selectedShade.buyUrl, kind: "product" };
  return null;
}

// Draw the game-plan into a canvas rect — shared by the printed A5 + saved cards.
function drawGamePlanPanel(c, gp, x, y, w, h, sans, o) {
  o = o || {};
  const accent = o.accent || "#5f7d2e";
  const pad = o.pad || 30;
  const titleSize = o.titleSize || 28, headSize = o.headSize || 22, stepSize = o.stepSize || 20;
  c.fillStyle = "#f2f5ea";
  roundRect(c, x, y, w, h, 18); c.fill();
  // pill (top-right)
  const pill = gp.apps > 0 ? "NEEDS LIGHTENING" : "DIRECT COLOUR";
  c.font = "700 15px " + sans;
  const pw = c.measureText(pill).width + 26;
  c.fillStyle = gp.apps > 0 ? "#b8942f" : "#5f7d2e";
  roundRect(c, x + w - pad - pw, y + pad - 4, pw, 30, 15); c.fill();
  c.fillStyle = "#fff"; c.textAlign = "center"; c.textBaseline = "middle";
  c.fillText(pill, x + w - pad - pw / 2, y + pad + 11);
  c.textAlign = "left"; c.textBaseline = "alphabetic";
  // title
  c.fillStyle = accent; c.font = "700 " + titleSize + "px " + sans;
  let ty = y + pad + titleSize;
  fitLeft(c, "HOW TO GET " + gp.shadeName.toUpperCase(), x + pad, ty, w - pad * 2 - pw - 16);
  ty += headSize + 10;
  const offerH = gp.offer ? stepSize + 8 : 0;
  const kitY = y + h - pad - offerH - stepSize;
  if (o.compact) {
    // Tight panels: the title already names the shade, so show the actionable summary.
    c.fillStyle = "#3a3a3a"; c.font = "400 " + stepSize + "px " + sans;
    fitLeft(c, gp.summary, x + pad, ty, w - pad * 2);
  } else {
    c.fillStyle = "#1a1a1a"; c.font = "600 " + headSize + "px " + sans;
    ty = wrapText(c, gp.headlinePlain, x + pad, ty, w - pad * 2, headSize + 8, 2) + 8;
    c.fillStyle = "#3a3a3a"; c.font = "400 " + stepSize + "px " + sans;
    const maxY = kitY - 2 * (stepSize + 7) - 4; // leave room for a full 2-line step above the kit line
    const maxSteps = o.maxSteps || 4;
    for (let i = 0; i < Math.min(maxSteps, gp.stepsPlain.length); i++) {
      if (ty > maxY) break;
      ty = wrapText(c, "•  " + gp.stepsPlain[i], x + pad, ty, w - pad * 2, stepSize + 7, 2) + 6;
    }
  }
  // kit + offer pinned to the bottom
  c.fillStyle = accent; c.font = "700 " + stepSize + "px " + sans;
  fitLeft(c, "🛍  Kit: " + gp.kitNames.join(" · "), x + pad, kitY, w - pad * 2);
  if (gp.offer) { c.fillStyle = "#b8942f"; c.font = "700 " + stepSize + "px " + sans; fitLeft(c, gp.offer, x + pad, y + h - pad, w - pad * 2); }
}

let lastAnalysis = null;
let recVibe = "all"; // recommendation filter: all | natural | bold | low
const likeSel = new Set(); // user-picked "colours you like" (max 3)
const stmtSel = new Set(); // user-picked statement shades (max 2)

function openAnalysis(auto) {
  if (!FEATURES.analysis) return;
  const a = analyzeCurrent();
  if (!a) {
    const d = window.__hairAnalysisDebug || {};
    console.warn("[iColor] analysis found no hair:", d);
    if (!auto) {
      if (!d.hasMask) {
        showToast("Hair detector still warming up — wait a second and tap again");
      } else if ((d.maskMax || 0) < 0.2) {
        showToast("No hair detected (signal " + (d.maskMax || 0) + "). Make sure hair is clearly visible and well-lit.");
      } else {
        showToast("Couldn't read enough hair — fill more of the frame with your hair and try again.");
      }
    }
    return;
  }
  lastAnalysis = a;
  trk("analysis", { undertone: a.under, hairLevel: a.level.level });
  renderAnalysis(a);
  analysisModal.classList.remove("hidden");
  speak(t("voice_result"));
}

function renderAnalysis(a) {
  const lead =
    a.under === "warm" ? "Your warm undertone glows with golden, caramel and chocolate tones."
    : a.under === "cool" ? "Your cool undertone pops with ash, cocoa and berry tones."
    : "Neutral undertones are lucky — most shades flatter you, so pick by mood.";
  const top = a.recs[0];

  const detected = `
    <section class="an-detected">
      <div class="an-card">
        <span class="an-swatch" style="background:${rgbToHex(a.hair)}"></span>
        <div><h4>Your hair</h4><p>${a.level.name}</p>
        <p class="an-sub">${cap(a.hairTone)} undertone</p></div>
      </div>
      <div class="an-card">
        <span class="an-swatch" style="background:${a.skin ? rgbToHex(a.skin) : "#333"}"></span>
        <div><h4>Your skin</h4><p>${a.skin ? a.skinDepth : "Not detected"}</p>
        <p class="an-sub">${a.skinUndertone ? cap(a.skinUndertone) + " undertone" : "show more face to read undertone"}</p></div>
      </div>
    </section>`;

  const recRow = (r) => `
    <div class="an-rec">
      <span class="an-dot" style="background:${r.shade.hex}"></span>
      <div class="an-rec-body">
        <div class="an-rec-top"><strong>${r.shade.name}</strong>
          ${r.tag ? `<span class="an-tag">${r.tag}</span>` : ""}
          <span class="an-badge ${r.achievable ? "ok" : "lift"}">${r.achievable ? "Direct colour" : "Needs lightening"}</span></div>
        <p>${r.reason}</p>
      </div>
      <button class="an-try" data-id="${r.shade.id}">Try</button>
    </div>`;

  const vibeControl = FEATURES.vibe ? `
      <div class="an-vibe">
        <span>Filter by vibe:</span>
        <div class="seg">
          <button data-vibe="all" class="on">All</button>
          <button data-vibe="natural">Natural</button>
          <button data-vibe="bold">Bold</button>
          <button data-vibe="low">Low-maintenance</button>
        </div>
      </div>` : "";
  const recs = `
    <section>
      <h3>Recommended shades for you</h3>
      <p class="an-lead">${lead}</p>
      ${vibeControl}
      <div class="an-recs" id="recsList"></div>
    </section>`;

  const statement = FEATURES.statement ? `
    <section>
      <h3>✨ Statement colours</h3>
      <p class="an-lead">Feeling bold? These lively shades still work with your ${a.under} undertone.</p>
      <div class="an-recs" id="stmtList">${a.statements.map(recRow).join("")}</div>
    </section>` : "";

  const chip = (s) => `<button class="pick-chip" data-id="${s.id}"><span class="dot" style="background:${s.hex}"></span>${s.name}</button>`;
  const picks = FEATURES.ratePicks ? `
    <section class="an-picks">
      <h3>Rate your own picks</h3>
      <p class="an-lead">Tap up to 3 colours you like and up to 2 statement shades — we'll show what works, what doesn't, and why.</p>
      <div class="pick-group"><h5>Colours you like <span class="pick-count" data-c="like">0/3</span></h5>
        <div class="pick-chips">${SHADES.filter((s) => s.hex && !s.statement).map(chip).join("")}</div></div>
      <div class="pick-group"><h5>Statement colours <span class="pick-count" data-c="stmt">0/2</span></h5>
        <div class="pick-chips">${SHADES.filter((s) => s.hex && s.statement).map(chip).join("")}</div></div>
      <div id="pickResults" class="pick-results"><p class="an-lead">Pick shades above to see your personalized verdict.</p></div>
    </section>` : "";

  const brighten = `
    <section>
      <h3>Make it brighter &amp; livelier</h3>
      <p class="an-lead">${a.brightening.headline}</p>
      <ul class="an-care">${a.brightening.tips.map((s) => `<li>${s}</li>`).join("")}</ul>
    </section>`;

  const gp = FEATURES.gameplan ? colourGamePlan(a) : null;
  const gameplan = gp ? `
    <section class="an-plan">
      <h3>How to get your colour ${gp.apps > 0 ? `<span class="an-badge lift">Needs lightening</span>` : `<span class="an-badge ok">Direct colour</span>`}</h3>
      <p class="an-lead">${gp.headline}</p>
      <ol class="an-steps an-plan-steps">${gp.steps.map((s) => `<li>${s}</li>`).join("")}</ol>
      <div class="an-kit"><h5>🛍️ Your iColor kit for this look</h5>
        <ul>${gp.kit.map((k) => `<li>${k.name}${k.price ? ` <span class="an-price">${k.price}</span>` : ""}</li>`).join("")}</ul>
        ${gp.offer ? `<p class="an-offer">${gp.offer}</p>` : ""}
        ${(() => { const kc = buildKitCart(gp); if (!kc) return ""; const qr = qrSvg(kc.url, 3); return `<div class="an-kitcart"><button id="kitCartBtn" class="an-try">🛒 Add the whole kit to cart</button>${qr ? `<div class="an-kitqr"><div class="an-kitqr-img">${qr}</div><span>Scan to add it on your phone</span></div>` : ""}</div>`; })()}
      </div>
    </section>` : "";

  const apply = `
    <section>
      <h3>How to apply for the best result</h3>
      <ol class="an-steps">${applicationTips(top).map((s) => `<li>${s}</li>`).join("")}</ol>
    </section>`;

  const care = `
    <section>
      <h3>How to care for it — with iColor Plus</h3>
      <ul class="an-care">${aftercareTips(top).map((s) => `<li>${s}</li>`).join("")}</ul>
    </section>`;

  const fmt = (FEATURES.cards || FEATURES.print) ? `
    <div class="an-format">
      <span>Share / Save card:</span>
      <div class="seg">
        <button data-fmt="square" class="${cardFormat === "square" ? "on" : ""}">Square 1:1</button>
        <button data-fmt="portrait" class="${cardFormat === "portrait" ? "on" : ""}">Portrait 4:5</button>
      </div>
    </div>` : "";

  // Fresh per analysis
  recVibe = "all";
  likeSel.clear();
  stmtSel.clear();

  const PV = CONFIG.privacy || {};
  const policyLink = PV.policyUrl ? ` <a href="${PV.policyUrl}" target="_blank" rel="noopener noreferrer">Privacy Policy</a>` : "";
  const privacyNote = (PV.noticeText
    ? PV.noticeText
    : `Your details are stored only to send your results and offers, kept up to ${PV.retentionDays || 365} days, and never sold.`) + policyLink;
  const leadsSec = FEATURES.leads ? `
    <section class="an-leads">
      <h3>Get your results &amp; offers</h3>
      <p class="an-lead">Leave your email to receive your iColor Plus card and offers.</p>
      <div class="lead-form">
        <input id="leadEmail" type="email" placeholder="Email address" />
        <input id="leadMobile" type="tel" placeholder="Mobile (optional)" />
        <label class="lead-consent"><input id="leadConsent" type="checkbox" /> <span>${((CONFIG.leads || {}).consentText) || "I agree to receive updates and offers."}</span></label>
        <p class="lead-privacy">${privacyNote}</p>
        <button id="leadSubmit" class="an-try" style="align-self:flex-start">Sign me up</button>
        <div id="leadMsg" class="lead-msg"></div>
      </div>
    </section>` : "";

  analysisBody.innerHTML =
    fmt + detected + recs + gameplan + statement + picks + brighten + leadsSec + apply + care +
    `<p class="an-disc">This is a digital estimate from your photo and its lighting — not a professional diagnosis. Colours preview how each shade mixes with your real hair. Bleaching/lightening stresses hair — do it gradually, ideally with a professional, and always patch-test.</p>`;

  const kitBtn = analysisBody.querySelector("#kitCartBtn");
  if (kitBtn) kitBtn.addEventListener("click", () => {
    const kc = buildKitCart(FEATURES.gameplan ? colourGamePlan(a) : null);
    if (!kc || !kc.url) { showToast("Add product links in Admin → Kit first"); return; }
    try { trk("shopclick", { sku: (selectedShade && selectedShade.id) || "", kit: true }); } catch (e) {}
    window.open(kc.url, "_blank", "noopener");
  });

  const leadBtn = analysisBody.querySelector("#leadSubmit");
  if (leadBtn) leadBtn.addEventListener("click", () => {
    const email = (analysisBody.querySelector("#leadEmail").value || "").trim();
    const mobile = (analysisBody.querySelector("#leadMobile").value || "").trim();
    const consent = analysisBody.querySelector("#leadConsent").checked;
    const req = (CONFIG.leads || {}).requireEmail !== false;
    const msg = analysisBody.querySelector("#leadMsg");
    if (!consent) { msg.textContent = "Please tick the consent box first."; msg.className = "lead-msg err"; return; }
    if (req && !/.+@.+\..+/.test(email)) { msg.textContent = "Please enter a valid email."; msg.className = "lead-msg err"; return; }
    const lead = { email, mobile, consent };
    try { window.Analytics && window.Analytics.addLead(lead); } catch (e) {}
    try { window.Backend && window.Backend.enabled() && window.Backend.pushLead(lead); } catch (e) {}
    try { window.Backend && window.Backend.pushLeadWebhook && window.Backend.pushLeadWebhook(lead); } catch (e) {} // CRM webhook (independent of PocketBase)
    msg.textContent = "Thanks — you're on the list!";
    msg.className = "lead-msg ok";
    analysisBody.querySelector("#leadEmail").value = "";
    analysisBody.querySelector("#leadMobile").value = "";
    analysisBody.querySelector("#leadConsent").checked = false;
  });

  const wireTry = (root) =>
    root.querySelectorAll(".an-try").forEach((btn) => {
      btn.addEventListener("click", () => {
        const shade = SHADES.find((s) => s.id === btn.dataset.id);
        if (shade) {
          if (gridMode) setGridMode(false);
          selectShade(shade);
        }
        analysisModal.classList.add("hidden");
      });
    });

  const renderRecsInto = (vibe) => {
    const list = analysisBody.querySelector("#recsList");
    const rs = buildRecommendations(a.under, a.level.level, vibe);
    list.innerHTML = rs.length ? rs.map(recRow).join("") : `<p class="an-lead">No ${vibe} shades matched — try another vibe.</p>`;
    wireTry(list);
  };

  const renderPickResults = () => {
    const box = analysisBody.querySelector("#pickResults");
    const ids = [...likeSel, ...stmtSel];
    if (!ids.length) { box.innerHTML = `<p class="an-lead">Pick shades above to see your personalized verdict.</p>`; return; }
    const order = { great: 0, good: 1, bold: 2, poor: 3 };
    const label = { great: "Great for you", good: "Works with effort", bold: "Bold — your call", poor: "Not your best" };
    const evals = ids.map((id) => evaluatePick(SHADES.find((s) => s.id === id), a)).sort((x, y) => order[x.verdict] - order[y.verdict]);
    box.innerHTML = evals.map((e) => `
      <div class="pick-res ${e.verdict}">
        <span class="an-dot" style="background:${e.shade.hex}"></span>
        <div><div class="pick-res-top"><strong>${e.shade.name}</strong>
          <span class="pick-verdict ${e.verdict}">${label[e.verdict]}</span></div><p>${e.why}</p></div>
      </div>`).join("");
  };

  const updateCounts = () => {
    const l = analysisBody.querySelector('[data-c="like"]');
    const s = analysisBody.querySelector('[data-c="stmt"]');
    if (l) l.textContent = likeSel.size + "/3";
    if (s) s.textContent = stmtSel.size + "/2";
  };

  // Wire: format
  analysisBody.querySelectorAll(".an-format .seg button").forEach((b) => {
    b.addEventListener("click", () => {
      cardFormat = b.dataset.fmt;
      analysisBody.querySelectorAll(".an-format .seg button").forEach((x) => x.classList.toggle("on", x.dataset.fmt === cardFormat));
    });
  });
  // Wire: vibe filter
  analysisBody.querySelectorAll(".an-vibe button").forEach((b) => {
    b.addEventListener("click", () => {
      recVibe = b.dataset.vibe;
      analysisBody.querySelectorAll(".an-vibe button").forEach((x) => x.classList.toggle("on", x.dataset.vibe === recVibe));
      renderRecsInto(recVibe);
    });
  });
  // Wire: pick chips
  analysisBody.querySelectorAll(".pick-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const isStmt = !!SHADES.find((s) => s.id === id).statement;
      const set = isStmt ? stmtSel : likeSel;
      const max = isStmt ? 2 : 3;
      if (set.has(id)) set.delete(id);
      else if (set.size >= max) { showToast(`Pick up to ${max} ${isStmt ? "statement" : "liked"} colours`); return; }
      else set.add(id);
      btn.classList.toggle("on", set.has(id));
      updateCounts();
      renderPickResults();
    });
  });

  renderRecsInto("all");
  wireTry(analysisBody.querySelector("#stmtList"));
}

function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/* ============================================================
   Printable / saveable branded analysis report
   ============================================================ */
// Preload the logo into a data URL so the printout embeds it reliably
// (prefers a real assets/logo.png, falls back to the bundled SVG).
let logoDataURL = "assets/logo.svg";
function preloadLogo() {
  const attempt = (src, next) => {
    const img = new Image();
    img.onload = () => {
      try {
        const cv = document.createElement("canvas");
        cv.width = img.naturalWidth || 360;
        cv.height = img.naturalHeight || 210;
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        logoDataURL = cv.toDataURL("image/png");
      } catch (e) {
        logoDataURL = src;
      }
    };
    img.onerror = next;
    img.src = src;
  };
  attempt("assets/logo.png", () => attempt("assets/logo.svg", () => {}));
}
preloadLogo();

// Render the current photo/frame with a given shade LUT to an offscreen canvas.
function previewCanvas(lut, w) {
  const src = staticMode ? staticImg : video;
  const sw = src.videoWidth || src.width;
  const sh = src.videoHeight || src.height;
  const h = Math.max(1, Math.round((w * sh) / sw));
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const c = cv.getContext("2d", { willReadFrequently: true });
  const mirror = activeMirror;
  if (mirror) c.setTransform(-1, 0, 0, 1, w, 0);
  c.drawImage(src, 0, 0, w, h);
  c.setTransform(1, 0, 0, 1, 0, 0);
  if (lut && maskData) {
    const img = c.getImageData(0, 0, w, h);
    const work = new Uint8ClampedArray(img.data);
    const mapx = buildMapBil(w, maskW), mapy = buildMapBil(h, maskH);
    recolorBuffer(work, w, h, lut, mapx, mapy, mirror);
    img.data.set(work);
    c.putImageData(img, 0, 0);
  }
  return cv;
}

/* ---- canvas layout helpers ---- */
function loadImage(src) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });
}
function drawCover(c, img, dx, dy, dw, dh) {
  const iw = img.width, ih = img.height;
  const s = Math.max(dw / iw, dh / ih);
  const cw = dw / s, ch = dh / s;
  c.drawImage(img, (iw - cw) / 2, (ih - ch) / 2, cw, ch, dx, dy, dw, dh);
}
function wrapText(c, text, x, y, maxW, lineH, maxLines) {
  const words = String(text).split(" ");
  let line = "", lines = 0;
  for (let i = 0; i < words.length; i++) {
    const test = line ? line + " " + words[i] : words[i];
    if (c.measureText(test).width > maxW && line) {
      c.fillText(line, x, y);
      y += lineH;
      lines++;
      line = words[i];
      if (maxLines && lines >= maxLines - 1) {
        let rest = words.slice(i).join(" ");
        const full = rest;
        while (c.measureText(rest + "…").width > maxW && rest.length > 1) rest = rest.slice(0, -1);
        c.fillText(rest + (rest !== full ? "…" : ""), x, y);
        return y + lineH;
      }
    } else line = test;
  }
  if (line) { c.fillText(line, x, y); y += lineH; }
  return y;
}
function fitLeft(c, text, x, y, maxW) {
  let t = String(text);
  if (c.measureText(t).width <= maxW) { c.fillText(t, x, y); return; }
  while (c.measureText(t + "…").width > maxW && t.length > 1) t = t.slice(0, -1);
  c.fillText(t + "…", x, y);
}

let cardFormat = "square"; // social card shape for Share/Save: "square" | "portrait"

// Dispatch to the right card layout.
async function buildReportCard(a, format, opts) {
  if (format === "square") return buildSquareCard(a);
  if (format === "portrait") return buildPortraitCard(a);
  return buildLandscapeCard(a, opts);
}

// Build a high-resolution A5-landscape analysis card (print-friendly + shareable).
// opts.noPhoto — omit the guest photo (for B&W printers, where grey photos look
// muddy); the hero cell becomes a text "your colour" panel instead.
async function buildLandscapeCard(a, opts) {
  const noPhoto = !!(opts && opts.noPhoto);
  // Resolve the coupon code first (may claim one from the server pool) so it's
  // ready when the coupon is drawn below.
  if (FEATURES.coupon && CONFIG.coupon && CONFIG.coupon.enabled) {
    try { await ensureSessionCoupon(); } catch (e) {}
  }
  const W = 2100, H = 1485; // A5 landscape @ ~254 dpi
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const c = cv.getContext("2d");
  const PL = CONFIG.printLayout || {};
  const logo = await loadImage(logoDataURL).catch(() => null);
  const dateStr = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const sans = "'Segoe UI', system-ui, sans-serif";
  c.fillStyle = "#ffffff";
  c.fillRect(0, 0, W, H);

  // Header band
  const hg = c.createLinearGradient(0, 0, W, 0);
  hg.addColorStop(0, PL.accentFrom || "#5f7d2e");
  hg.addColorStop(1, PL.accentTo || "#b8942f");
  c.fillStyle = hg;
  c.fillRect(0, 0, W, 160);
  roundRect(c, 50, 30, 360, 100, 16);
  c.fillStyle = "#fff";
  c.fill();
  if (logo) {
    const la = logo.width / logo.height;
    let lw = 320, lh = lw / la;
    if (lh > 76) { lh = 76; lw = lh * la; }
    c.drawImage(logo, 50 + (360 - lw) / 2, 30 + (100 - lh) / 2, lw, lh);
  }
  c.fillStyle = "#fff";
  c.textAlign = "right";
  c.textBaseline = "alphabetic";
  c.font = "700 40px Georgia, serif";
  c.fillText(PL.title || "Personalized Hair Colour Analysis", W - 50, 76);
  c.font = "400 26px " + sans;
  c.fillText(dateStr, W - 50, 120);
  c.textAlign = "left";

  // Hero: photo + profile + brighten panel
  const px = 60, py = 195, pw = 340, ph = 420;
  if (noPhoto) {
    // B&W printer: skip the guest photo (muddy in grey) — show a clean "your
    // colour" text panel that reads well in monochrome instead.
    c.fillStyle = "#f5f5f2";
    roundRect(c, px, py, pw, ph, 18);
    c.fill();
    c.strokeStyle = "#e3e3e3";
    c.lineWidth = 2;
    roundRect(c, px, py, pw, ph, 18);
    c.stroke();
    c.textAlign = "center";
    c.fillStyle = "#b8942f";
    c.font = "700 26px " + sans;
    c.fillText("YOUR COLOUR", px + pw / 2, py + 70);
    c.fillStyle = "#1a1a1a";
    c.font = "700 40px " + sans;
    wrapText(c, selectedShade.name, px + pw / 2, py + 130, pw - 48, 46, 2, "center");
    c.fillStyle = "#555";
    c.font = "400 24px " + sans;
    c.fillText(a.level.name, px + pw / 2, py + 250);
    c.fillText(cap(a.hairTone) + " undertone", px + pw / 2, py + 288);
    c.fillStyle = "#999";
    c.font = "italic 20px " + sans;
    c.fillText("(photo omitted — B&W print)", px + pw / 2, py + ph - 34);
    c.textAlign = "left";
  } else {
    const photo = previewCanvas(sel, 520);
    c.save();
    roundRect(c, px, py, pw, ph, 18);
    c.clip();
    drawCover(c, photo, px, py, pw, ph);
    c.restore();
    c.strokeStyle = "#e3e3e3";
    c.lineWidth = 2;
    roundRect(c, px, py, pw, ph, 18);
    c.stroke();
  }

  let bx = 430, by = 235;
  c.fillStyle = "#b8942f";
  c.font = "700 26px " + sans;
  c.fillText("YOUR PROFILE", bx, by);
  by += 46;
  const profRow = (dotHex, title, sub) => {
    c.fillStyle = dotHex;
    c.beginPath();
    c.arc(bx + 16, by - 8, 16, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = "#ccc";
    c.lineWidth = 1.5;
    c.stroke();
    c.fillStyle = "#1a1a1a";
    c.font = "700 29px " + sans;
    c.fillText(title, bx + 46, by);
    by += 34;
    c.fillStyle = "#666";
    c.font = "400 23px " + sans;
    c.fillText(sub, bx + 46, by);
    by += 52;
  };
  profRow(rgbToHex(a.hair), a.level.name, cap(a.hairTone) + " undertone");
  profRow(a.skin ? rgbToHex(a.skin) : "#ccc", "Skin — " + (a.skin ? a.skinDepth : "n/a"),
    a.skinUndertone ? cap(a.skinUndertone) + " undertone" : "undertone not detected");
  c.fillStyle = "#333";
  c.font = "italic 24px " + sans;
  c.fillText("Previewing: " + selectedShade.name, bx, by - 6);

  // Right-of-hero panel: the "How to get your colour" game plan (paid feature),
  // else the brighten tips.
  {
    const gx = 980, gy = 195, gw = W - gx - 60, gh = 420;
    const gp = FEATURES.gameplan ? colourGamePlan(a) : null;
    if (gp) {
      drawGamePlanPanel(c, gp, gx, gy, gw, gh, sans, { accent: PL.accentFrom || "#5f7d2e", pad: 34, titleSize: 30, headSize: 26, stepSize: 22, maxSteps: 4 });
    } else if (PL.showBrighten !== false) {
      c.fillStyle = "#f2f5ea";
      roundRect(c, gx, gy, gw, gh, 18);
      c.fill();
      c.fillStyle = PL.accentFrom || "#5f7d2e";
      c.font = "700 30px " + sans;
      c.fillText("MAKE IT BRIGHTER / LIVELIER", gx + 30, gy + 52);
      c.fillStyle = "#1a1a1a";
      c.font = "600 26px " + sans;
      let ty = wrapText(c, a.brightening.headline, gx + 30, gy + 100, gw - 60, 36, 3);
      c.fillStyle = "#4a4a4a";
      c.font = "400 23px " + sans;
      ty += 10;
      for (const tip of a.brightening.tips.slice(0, 2)) {
        ty = wrapText(c, "•  " + tip, gx + 30, ty, gw - 60, 31, 3) + 8;
      }
    }
  }

  // Shade strip: 3 matches + 2 bold picks
  if (PL.showMatches !== false) {
  const strip = a.recs.slice(0, 3).map((r) => ({ ...r, tag: "MATCH" }))
    .concat(a.statements.slice(0, 2).map((r) => ({ ...r, tag: "BOLD" })));
  c.fillStyle = PL.accentFrom || "#5f7d2e";
  c.font = "700 30px " + sans;
  c.fillText("YOUR MATCHES", 60, 685);
  c.fillStyle = PL.accentTo || "#b8942f";
  c.fillText("+  BOLD PICKS", 340, 685);

  const n = strip.length, gap = 20, sx0 = 60, availW = W - 120;
  const tW = (availW - gap * (n - 1)) / n;
  const sy = 715, imgH = 430;
  strip.forEach((r, i) => {
    const x = sx0 + i * (tW + gap);
    const prev = previewCanvas(makeLUT(r.shade.hex), Math.round(tW));
    c.save();
    roundRect(c, x, sy, tW, imgH, 16);
    c.clip();
    drawCover(c, prev, x, sy, tW, imgH);
    c.restore();
    c.strokeStyle = "#e3e3e3";
    c.lineWidth = 2;
    roundRect(c, x, sy, tW, imgH, 16);
    c.stroke();
    // tag pill
    const isBold = r.tag === "BOLD";
    c.fillStyle = isBold ? "#b8942f" : "#5f7d2e";
    roundRect(c, x + 12, sy + 12, isBold ? 96 : 108, 34, 17);
    c.fill();
    c.fillStyle = "#fff";
    c.font = "700 18px " + sans;
    c.textAlign = "center";
    c.fillText(isBold ? "BOLD" : "MATCH", x + 12 + (isBold ? 48 : 54), sy + 35);
    c.textAlign = "left";
    // swatch dot + name + badge
    let ly = sy + imgH + 42;
    c.fillStyle = "#1a1a1a";
    c.font = "700 27px " + sans;
    fitLeft(c, r.shade.name, x, ly, tW);
    ly += 36;
    c.font = "700 18px " + sans;
    c.fillStyle = r.achievable ? "#4a6321" : "#8a6a1e";
    fitLeft(c, "● " + (r.tag || (r.achievable ? "Direct colour" : "Needs lightening")) + (r.achievable ? "" : " · lift"), x, ly, tW);
  });
  } // showMatches

  // Coupon / voucher (printed on the A5 report)
  if (FEATURES.coupon && CONFIG.coupon && CONFIG.coupon.enabled) {
    const cyy = 1245, chh = 70, cxx = 60, cww = W - 120;
    c.save();
    c.setLineDash([11, 8]);
    c.strokeStyle = "#b8942f";
    c.lineWidth = 2.5;
    roundRect(c, cxx, cyy, cww, chh, 10);
    c.stroke();
    c.restore();
    c.textBaseline = "middle";
    c.fillStyle = "#5f7d2e";
    c.font = "700 22px " + sans;
    c.fillText((CONFIG.coupon.label || "In-store offer").toUpperCase(), cxx + 26, cyy + chh / 2 - 12);
    c.fillStyle = "#666";
    c.font = "400 16px " + sans;
    fitLeft(c, CONFIG.coupon.terms || "", cxx + 26, cyy + chh / 2 + 15, cww - 360);
    const chipW = 300, chipX = cxx + cww - chipW - 12;
    c.fillStyle = "#14210F";
    roundRect(c, chipX, cyy + 13, chipW, chh - 26, 8);
    c.fill();
    c.fillStyle = "#E0C46A";
    c.font = "800 30px " + sans;
    c.textAlign = "center";
    c.font = "800 26px " + sans;
    c.fillText(couponCode(), chipX + chipW / 2, cyy + chh / 2);
    c.textAlign = "left";
    c.textBaseline = "alphabetic";
  }

  // Footer
  const fy = H - 150;
  c.strokeStyle = PL.accentTo || "#b8942f";
  c.lineWidth = 3;
  c.beginPath();
  c.moveTo(60, fy);
  c.lineTo(W - 60, fy);
  c.stroke();
  let flw = 190, flh = 60;
  if (logo) { flh = flw / (logo.width / logo.height); c.drawImage(logo, 60, fy + 26, flw, flh); }
  c.fillStyle = "#666";
  c.font = "400 22px " + sans;
  wrapText(c,
    PL.footer || "Apply per pack & patch-test first · Refresh every 4–6 weeks with the matching iColor Plus shampoo-in shade. Digital estimate from your photo — not a professional diagnosis.",
    60 + flw + 34, fy + 44, W - 60 - (60 + flw + 34), 30, 3);
  c.fillStyle = PL.accentFrom || "#5f7d2e";
  c.font = "700 22px " + sans;
  c.textAlign = "right";
  c.fillText("iColor Plus · Great Lengths PH", W - 60, H - 26);
  c.textAlign = "left";
  return cv;
}

// Build a 1080×1080 square card, sized for Instagram / social feeds.
async function buildSquareCard(a) {
  const W = 1080, H = 1080;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const c = cv.getContext("2d");
  const logo = await loadImage(logoDataURL).catch(() => null);
  const dateStr = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const sans = "'Segoe UI', system-ui, sans-serif";
  c.fillStyle = "#ffffff";
  c.fillRect(0, 0, W, H);

  // Header
  const headH = 112;
  const hg = c.createLinearGradient(0, 0, W, 0);
  hg.addColorStop(0, "#5f7d2e");
  hg.addColorStop(1, "#b8942f");
  c.fillStyle = hg;
  c.fillRect(0, 0, W, headH);
  roundRect(c, 32, 22, 236, 68, 12);
  c.fillStyle = "#fff";
  c.fill();
  if (logo) {
    const la = logo.width / logo.height;
    let lw = 210, lh = lw / la;
    if (lh > 52) { lh = 52; lw = lh * la; }
    c.drawImage(logo, 32 + (236 - lw) / 2, 22 + (68 - lh) / 2, lw, lh);
  }
  c.fillStyle = "#fff";
  c.textAlign = "right";
  c.textBaseline = "alphabetic";
  c.font = "700 30px Georgia, serif";
  c.fillText("Hair Colour Analysis", W - 32, 52);
  c.font = "400 17px " + sans;
  c.fillText(dateStr, W - 32, 80);
  c.textAlign = "left";

  // Hero: photo + profile + brighten one-liner
  const photo = previewCanvas(sel, 440);
  const px = 32, py = 135, pw = 300, ph = 360;
  c.save();
  roundRect(c, px, py, pw, ph, 16);
  c.clip();
  drawCover(c, photo, px, py, pw, ph);
  c.restore();
  c.strokeStyle = "#e3e3e3";
  c.lineWidth = 2;
  roundRect(c, px, py, pw, ph, 16);
  c.stroke();

  let bx = 360, by = 175;
  c.fillStyle = "#b8942f";
  c.font = "700 20px " + sans;
  c.fillText("YOUR PROFILE", bx, by);
  by += 40;
  const row = (dot, title, sub) => {
    c.fillStyle = dot;
    c.beginPath();
    c.arc(bx + 14, by - 7, 14, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = "#ccc";
    c.lineWidth = 1.2;
    c.stroke();
    c.fillStyle = "#1a1a1a";
    c.font = "700 24px " + sans;
    c.fillText(title, bx + 40, by);
    by += 28;
    c.fillStyle = "#666";
    c.font = "400 18px " + sans;
    c.fillText(sub, bx + 40, by);
    by += 44;
  };
  row(rgbToHex(a.hair), a.level.name, cap(a.hairTone) + " undertone");
  row(a.skin ? rgbToHex(a.skin) : "#ccc", "Skin — " + (a.skin ? a.skinDepth : "n/a"),
    a.skinUndertone ? cap(a.skinUndertone) + " undertone" : "undertone n/a");
  c.fillStyle = "#333";
  c.font = "italic 18px " + sans;
  c.fillText("Previewing: " + selectedShade.name, bx, by - 8);
  const gpS = FEATURES.gameplan ? colourGamePlan(a) : null;
  if (gpS) {
    c.fillStyle = "#5f7d2e"; c.font = "700 18px " + sans;
    c.fillText(gpS.apps > 0 ? "HOW TO GET IT · lighten first" : "HOW TO GET IT · direct colour", bx, by + 24);
    c.fillStyle = "#444"; c.font = "400 17px " + sans;
    let ty2 = wrapText(c, gpS.summary, bx, by + 50, W - bx - 32, 24, 2);
    c.fillStyle = "#5f7d2e"; c.font = "700 15px " + sans;
    fitLeft(c, "🛍 Kit: " + gpS.kitNames.join(" · "), bx, ty2 + 6, W - bx - 32);
    if (gpS.offer) { c.fillStyle = "#b8942f"; c.font = "700 15px " + sans; fitLeft(c, gpS.offer, bx, ty2 + 30, W - bx - 32); }
  } else {
    c.fillStyle = "#5f7d2e"; c.font = "700 18px " + sans;
    c.fillText("GO BRIGHTER", bx, by + 24);
    c.fillStyle = "#444"; c.font = "400 17px " + sans;
    wrapText(c, a.brightening.headline, bx, by + 50, W - bx - 32, 24, 3);
  }

  // Shade strip: 3 matches + 2 bold
  c.fillStyle = "#5f7d2e";
  c.font = "700 22px " + sans;
  c.fillText("YOUR MATCHES", 32, 558);
  c.fillStyle = "#b8942f";
  c.fillText("+ BOLD", 250, 558);
  const strip = a.recs.slice(0, 3).map((r) => ({ ...r, tag: "MATCH" }))
    .concat(a.statements.slice(0, 2).map((r) => ({ ...r, tag: "BOLD" })));
  const m = 32, gap = 14, n = strip.length, availW = W - 2 * m;
  const tW = (availW - gap * (n - 1)) / n;
  const sy = 583, imgH = 300;
  strip.forEach((r, i) => {
    const x = m + i * (tW + gap);
    const prev = previewCanvas(makeLUT(r.shade.hex), Math.round(tW));
    c.save();
    roundRect(c, x, sy, tW, imgH, 12);
    c.clip();
    drawCover(c, prev, x, sy, tW, imgH);
    c.restore();
    c.strokeStyle = "#e3e3e3";
    c.lineWidth = 2;
    roundRect(c, x, sy, tW, imgH, 12);
    c.stroke();
    const isBold = r.tag === "BOLD";
    c.fillStyle = isBold ? "#b8942f" : "#5f7d2e";
    roundRect(c, x + 8, sy + 8, isBold ? 66 : 78, 26, 13);
    c.fill();
    c.fillStyle = "#fff";
    c.font = "700 14px " + sans;
    c.textAlign = "center";
    c.fillText(isBold ? "BOLD" : "MATCH", x + 8 + (isBold ? 33 : 39), sy + 26);
    c.textAlign = "left";
    let ly = sy + imgH + 30;
    c.fillStyle = "#1a1a1a";
    c.font = "700 19px " + sans;
    fitLeft(c, r.shade.name, x, ly, tW);
    ly += 25;
    c.font = "700 13px " + sans;
    c.fillStyle = r.achievable ? "#4a6321" : "#8a6a1e";
    fitLeft(c, "● " + (r.tag || "") + (r.achievable ? "" : " · lift"), x, ly, tW);
  });

  // Footer
  const fy = H - 92;
  c.strokeStyle = "#b8942f";
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(32, fy);
  c.lineTo(W - 32, fy);
  c.stroke();
  let flw = 150, flh = 46;
  if (logo) { flh = flw / (logo.width / logo.height); c.drawImage(logo, 32, fy + 18, flw, flh); }
  c.fillStyle = "#666";
  c.font = "400 15px " + sans;
  wrapText(c,
    "Patch-test first · Refresh every 4–6 weeks with iColor Plus · Bleach gradually with a bond-builder. Digital estimate — not a diagnosis.",
    32 + flw + 22, fy + 34, W - 32 - (32 + flw + 22), 21, 3);
  c.fillStyle = "#5f7d2e";
  c.font = "700 15px " + sans;
  c.textAlign = "right";
  c.fillText("iColor Plus · Great Lengths PH", W - 32, H - 20);
  c.textAlign = "left";
  return cv;
}

// Build a 1080×1350 portrait card (Instagram feed / stories-friendly).
async function buildPortraitCard(a) {
  const W = 1080, H = 1350;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const c = cv.getContext("2d");
  const logo = await loadImage(logoDataURL).catch(() => null);
  const dateStr = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const sans = "'Segoe UI', system-ui, sans-serif";
  c.fillStyle = "#ffffff";
  c.fillRect(0, 0, W, H);

  // Header
  const hg = c.createLinearGradient(0, 0, W, 0);
  hg.addColorStop(0, "#5f7d2e");
  hg.addColorStop(1, "#b8942f");
  c.fillStyle = hg;
  c.fillRect(0, 0, W, 120);
  roundRect(c, 40, 26, 248, 68, 12);
  c.fillStyle = "#fff";
  c.fill();
  if (logo) {
    const la = logo.width / logo.height;
    let lw = 222, lh = lw / la;
    if (lh > 52) { lh = 52; lw = lh * la; }
    c.drawImage(logo, 40 + (248 - lw) / 2, 26 + (68 - lh) / 2, lw, lh);
  }
  c.fillStyle = "#fff";
  c.textAlign = "right";
  c.textBaseline = "alphabetic";
  c.font = "700 32px Georgia, serif";
  c.fillText("Hair Colour Analysis", W - 40, 56);
  c.font = "400 18px " + sans;
  c.fillText(dateStr, W - 40, 86);
  c.textAlign = "left";

  // Hero: photo + profile
  const photo = previewCanvas(sel, 520);
  const px = 40, py = 145, pw = 420, ph = 500;
  c.save();
  roundRect(c, px, py, pw, ph, 18);
  c.clip();
  drawCover(c, photo, px, py, pw, ph);
  c.restore();
  c.strokeStyle = "#e3e3e3";
  c.lineWidth = 2;
  roundRect(c, px, py, pw, ph, 18);
  c.stroke();

  let bx = 485, by = 195;
  c.fillStyle = "#b8942f";
  c.font = "700 22px " + sans;
  c.fillText("YOUR PROFILE", bx, by);
  by += 46;
  const row = (dot, title, sub) => {
    c.fillStyle = dot;
    c.beginPath();
    c.arc(bx + 15, by - 8, 15, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = "#ccc";
    c.lineWidth = 1.3;
    c.stroke();
    c.fillStyle = "#1a1a1a";
    c.font = "700 26px " + sans;
    c.fillText(title, bx + 44, by);
    by += 30;
    c.fillStyle = "#666";
    c.font = "400 19px " + sans;
    c.fillText(sub, bx + 44, by);
    by += 50;
  };
  row(rgbToHex(a.hair), a.level.name, cap(a.hairTone) + " undertone");
  row(a.skin ? rgbToHex(a.skin) : "#ccc", "Skin — " + (a.skin ? a.skinDepth : "n/a"),
    a.skinUndertone ? cap(a.skinUndertone) + " undertone" : "undertone n/a");
  c.fillStyle = "#333";
  c.font = "italic 19px " + sans;
  c.fillText("Previewing: " + selectedShade.name, bx, by - 10);

  // Full-width panel: the "How to get your colour" game plan (compact), else brighten.
  {
    const gy = 675, gh = 185;
    const gp = FEATURES.gameplan ? colourGamePlan(a) : null;
    if (gp) {
      drawGamePlanPanel(c, gp, 40, gy, W - 80, gh, sans, { accent: "#5f7d2e", pad: 26, titleSize: 24, headSize: 20, stepSize: 18, compact: true });
    } else {
      c.fillStyle = "#f2f5ea";
      roundRect(c, 40, gy, W - 80, gh, 16);
      c.fill();
      c.fillStyle = "#5f7d2e";
      c.font = "700 24px " + sans;
      c.fillText("MAKE IT BRIGHTER / LIVELIER", 70, gy + 42);
      c.fillStyle = "#1a1a1a";
      c.font = "600 21px " + sans;
      let ty = wrapText(c, a.brightening.headline, 70, gy + 80, W - 140, 30, 2);
      c.fillStyle = "#4a4a4a";
      c.font = "400 19px " + sans;
      wrapText(c, "•  " + a.brightening.tips[0], 70, ty + 6, W - 140, 27, 2);
    }
  }

  // Shade strip
  c.fillStyle = "#5f7d2e";
  c.font = "700 24px " + sans;
  c.fillText("YOUR MATCHES", 40, 895);
  c.fillStyle = "#b8942f";
  c.fillText("+ BOLD PICKS", 290, 895);
  const strip = a.recs.slice(0, 3).map((r) => ({ ...r, tag: "MATCH" }))
    .concat(a.statements.slice(0, 2).map((r) => ({ ...r, tag: "BOLD" })));
  const m = 40, gap = 16, n = strip.length, availW = W - 2 * m;
  const tW = (availW - gap * (n - 1)) / n;
  const sy = 920, imgH = 260;
  strip.forEach((r, i) => {
    const x = m + i * (tW + gap);
    const prev = previewCanvas(makeLUT(r.shade.hex), Math.round(tW));
    c.save();
    roundRect(c, x, sy, tW, imgH, 12);
    c.clip();
    drawCover(c, prev, x, sy, tW, imgH);
    c.restore();
    c.strokeStyle = "#e3e3e3";
    c.lineWidth = 2;
    roundRect(c, x, sy, tW, imgH, 12);
    c.stroke();
    const isBold = r.tag === "BOLD";
    c.fillStyle = isBold ? "#b8942f" : "#5f7d2e";
    roundRect(c, x + 8, sy + 8, isBold ? 66 : 78, 26, 13);
    c.fill();
    c.fillStyle = "#fff";
    c.font = "700 14px " + sans;
    c.textAlign = "center";
    c.fillText(isBold ? "BOLD" : "MATCH", x + 8 + (isBold ? 33 : 39), sy + 26);
    c.textAlign = "left";
    let ly = sy + imgH + 30;
    c.fillStyle = "#1a1a1a";
    c.font = "700 20px " + sans;
    fitLeft(c, r.shade.name, x, ly, tW);
    ly += 26;
    c.font = "700 13px " + sans;
    c.fillStyle = r.achievable ? "#4a6321" : "#8a6a1e";
    fitLeft(c, "● " + (r.tag || "") + (r.achievable ? "" : " · lift"), x, ly, tW);
  });

  // Footer
  const fy = H - 95;
  c.strokeStyle = "#b8942f";
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(40, fy);
  c.lineTo(W - 40, fy);
  c.stroke();
  let flw = 160, flh = 48;
  if (logo) { flh = flw / (logo.width / logo.height); c.drawImage(logo, 40, fy + 20, flw, flh); }
  c.fillStyle = "#666";
  c.font = "400 16px " + sans;
  wrapText(c,
    "Patch-test first · Refresh every 4–6 weeks with iColor Plus · Bleach gradually with a bond-builder. Digital estimate — not a diagnosis.",
    40 + flw + 24, fy + 36, W - 40 - (40 + flw + 24), 22, 3);
  c.fillStyle = "#5f7d2e";
  c.font = "700 16px " + sans;
  c.textAlign = "right";
  c.fillText("iColor Plus · Great Lengths PH", W - 40, H - 22);
  c.textAlign = "left";
  return cv;
}

// Share the selected social card via the native share sheet (falls back to download).
async function shareReportCard() {
  const a = lastAnalysis || analyzeCurrent();
  if (!a) { showToast("Analyze your hair first"); return; }
  showToast("Preparing your card…");
  const cv = await buildReportCard(a, cardFormat);
  trk("share");
  cv.toBlob(async (blob) => {
    if (!blob) return;
    const name = `icolorplus-analysis-${timestamp()}.jpg`;
    // Always keep the card in the gallery so it's available to "Send to my phone".
    const url = URL.createObjectURL(blob);
    addCapture({ type: "photo", url, blob, name });
    const file = new File([blob], name, { type: "image/jpeg" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          files: [file],
          title: "My iColor Plus Hair Analysis",
          text: "My personalized iColor Plus hair colour analysis ✨",
        });
      } catch (e) {
        /* user dismissed the share sheet */
      }
    } else {
      triggerDownload(url, name);
      showToast("Sharing not supported here — saved to your gallery");
    }
  }, "image/jpeg", 0.92);
}

async function saveReportImage() {
  const a = lastAnalysis || analyzeCurrent();
  if (!a) { showToast("Analyze your hair first"); return; }
  showToast("Building your card…");
  const cv = await buildReportCard(a, cardFormat);
  cv.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const name = `icolorplus-analysis-${timestamp()}.jpg`;
    addCapture({ type: "photo", url, blob, name });
    triggerDownload(url, name);
    showToast("Saved — shareable card in your gallery");
    trk("share");
  }, "image/jpeg", 0.92);
}

// Compose the ESC/POS thermal receipt (no photo — thermal is mono, low-res).
// Uses the same consultant game plan as the A5 report, condensed to a slip.
function buildThermalReceipt(a) {
  if (!window.ICPrinter) return null;
  const r = window.ICPrinter.receipt({ widthMm: PRINT.widthMm || 58 });
  const loc = (CONFIG.location || {}).name || "";
  const header = PRINT.header || loc || "iColor Plus";
  const dateStr = new Date().toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  r.align("center").bold(true).size(1).text(header).bold(false);
  r.text("Hair Colour Analysis").text(dateStr).rule();

  r.align("center").bold(true).size(2).text(selectedShade.name).size(1).bold(false);
  if (selectedShade.hex) r.text(selectedShade.hex.toUpperCase());
  r.feed(1);

  r.align("left");
  r.text("Your hair:  " + a.level.name);
  r.text("Undertone:  " + cap(a.hairTone));
  if (a.skin) r.text("Skin tone:  " + a.skinDepth + (a.skinUndertone ? " / " + cap(a.skinUndertone) : ""));
  r.rule();

  const gp = FEATURES.gameplan ? colourGamePlan(a) : null;
  if (gp) {
    r.bold(true).text("HOW TO GET YOUR COLOUR").bold(false);
    gp.stepsPlain.slice(0, 5).forEach((s, i) => r.wrap((i + 1) + ". " + s));
    r.feed(1);
    if (gp.kit && gp.kit.length) {
      r.bold(true).text("YOUR KIT").bold(false);
      gp.kit.forEach((k) => { if (k.price) r.row("- " + k.name, k.price); else r.wrap("- " + k.name); });
    }
    if (gp.offer) { r.feed(1); r.align("center").wrap(gp.offer.replace(/^[^A-Za-z0-9]+/, "")); r.align("left"); }
  } else {
    r.bold(true).text("TOP MATCHES").bold(false);
    (a.recs || []).slice(0, 3).forEach((m) => r.text("- " + m.shade.name));
  }

  // QR: prefer the offline "send to my phone" box; else a link to this shade.
  if (PRINT.qr !== false && window.ICPrinter) {
    let qrData = "";
    const ho = CONFIG.handoff || {};
    if (FEATURES.handoff && ho.url) qrData = ho.url;
    else { const base = (CONFIG.qr || {}).baseUrl || location.origin; qrData = base + (base.indexOf("?") >= 0 ? "&" : "?") + "shade=" + encodeURIComponent(selectedShade.id || ""); }
    if (qrData) { r.feed(1); r.align("center").text(FEATURES.handoff && ho.url ? "Scan to get your photos" : "Scan to try more shades").qr(qrData, PRINT.widthMm >= 76 ? 7 : 5); }
  }

  r.feed(1).align("center");
  if (PRINT.footer) r.wrap(PRINT.footer);
  r.wrap("Digital estimate — always patch-test.");
  r.cut();
  return r.bytes();
}

async function thermalPrintNow(a) {
  if (!window.ICPrinter) { showToast("Printer support not loaded"); return; }
  const transport = PRINT.transport || "bluetooth";
  if (!window.ICPrinter.supported(transport)) {
    showToast(transport === "usb"
      ? "This device can't use a USB printer here. Use an Android/Windows kiosk, or switch to a Wi-Fi printer (Colour/B&W)."
      : "This device can't use a Bluetooth printer here (iOS Safari can't). Use an Android/Windows kiosk, or a Wi-Fi printer (Colour/B&W).");
    return;
  }
  const bytes = buildThermalReceipt(a);
  if (!bytes) { showToast("Couldn't build the receipt"); return; }
  showToast("Printing…");
  try {
    await window.ICPrinter.printThermal(bytes, { transport, copies: PRINT.copies || 1, onStatus: (s) => showToast(s) });
    showToast("Printed ✓");
    notePrint();
  } catch (e) {
    showToast("Print failed: " + (e && e.message ? e.message : "check the printer & pairing"));
  }
}

async function printReportCard() {
  const a = lastAnalysis || analyzeCurrent();
  if (!a) { showToast("Analyze your hair first"); return; }
  if ((PRINT.mode || "color") === "thermal") { await thermalPrintNow(a); return; }
  // Colour or B&W → the device's OS print dialog. B&W drops the muddy photo.
  const cv = await buildReportCard(a, "landscape", { noPhoto: PRINT.mode === "bw" });
  printReport.innerHTML = `<img class="card" src="${cv.toDataURL("image/jpeg", 0.92)}" alt="iColor Plus hair analysis" />`;
  const img = printReport.querySelector("img");
  await (img.complete ? Promise.resolve() : new Promise((r) => { img.onload = img.onerror = r; }));
  window.print();
  notePrint();
}

/* ============================================================
   Pointer interaction (split drag + grid tap)
   ============================================================ */
function canvasPos(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) / rect.width,
    y: (e.clientY - rect.top) / rect.height,
  };
}

canvas.addEventListener("pointerdown", (e) => {
  if (splitView && !gridMode) {
    dragging = true;
    splitX = clamp(canvasPos(e).x, 0, 1);
    invalidate();
  }
});
window.addEventListener("pointermove", (e) => {
  if (dragging) {
    splitX = clamp(canvasPos(e).x, 0, 1);
    invalidate();
  }
});
window.addEventListener("pointerup", () => (dragging = false));

canvas.addEventListener("click", (e) => {
  if (!gridMode) return;
  const { x, y } = canvasPos(e);
  const { cols, rows } = gridLayout;
  if (!cols) return;
  const col = Math.min(cols - 1, Math.floor(x * cols));
  const row = Math.min(rows - 1, Math.floor(y * rows));
  const idx = row * cols + col;
  const item = gridItems[idx];
  if (!item) return;
  selectShade(item.shade);
  setGridMode(false); // jump into the live single view with that shade
});

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

/* ============================================================
   UI: swatches, intensity, mode toggles
   ============================================================ */
function buildSwatches() {
  swatchesEl.innerHTML = "";
  let lastCollection = null;
  SHADES.forEach((shade) => {
    if (shade.collection && shade.collection !== lastCollection) {
      lastCollection = shade.collection;
      const sep = document.createElement("div");
      sep.className = "swatch-sep";
      sep.innerHTML = `<span>${shade.collection}</span>`;
      swatchesEl.appendChild(sep);
    }
    const btn = document.createElement("button");
    btn.className = "swatch";
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-selected", shade.id === selectedShade.id);
    const chip = document.createElement("span");
    chip.className = "chip" + (shade.hex ? "" : " none");
    if (shade.hex) chip.style.background = shade.hex;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = shade.name;
    btn.append(chip, name);
    btn.addEventListener("click", () => { selectShade(shade); scheduleColorsCollapse(); });
    btn._shadeId = shade.id;
    swatchesEl.appendChild(btn);
  });
}

function selectShade(shade) {
  selectedShade = shade;
  setSelectedLUT(shade.hex);
  [...swatchesEl.children].forEach((c) =>
    c.setAttribute("aria-selected", c._shadeId === shade.id)
  );
  const s = swatchesEl.querySelector(`[aria-selected="true"]`);
  s?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  if (!gridMode) popShadeLabel(shade);
  invalidate();
  if (shade.hex) {
    trk("tryon", { sku: shade.id }); // count try-ons per SKU
    if (!triedShades.includes(shade.id)) triedShades.push(shade.id); // for "shop the look" on the handoff page
  }
  _shopDismissed = false; // a new pick re-enables the product card
  renderShopCard(shade);
  updateLevelHint();
}

/* ---- "Shop the look" in-camera product card (paid feature) ---- */
let _shopDismissed = false; // hidden via the card's × until the next shade pick
function renderShopCard(shade) {
  const card = $("shopCard");
  if (!card) return;
  // Never cover the swatches: only show when the colours dock is collapsed.
  const dc = $("colorsToggle") && $("colorsToggle").closest(".dock-colors");
  const colorsOpen = dc && !dc.classList.contains("collapsed");
  const on = FEATURES.commerce && shade && shade.hex && shade.buyUrl && !_shopDismissed && !colorsOpen;
  if (!on || gridMode) { card.classList.add("hidden"); return; }
  const cm = CONFIG.commerce || {};
  const img = $("shopImg"), buy = $("shopBuy"), qr = $("shopQr"), badge = $("shopStock");
  if (shade.buyImg) { img.src = shade.buyImg; img.style.display = ""; } else img.style.display = "none";
  $("shopName").textContent = shade.name;
  $("shopPrice").textContent = shade.buyPrice ? (cm.currency || "") + shade.buyPrice : "";
  const soldOut = shade.buyAvail === false;
  // stock badge (from Shopify auto-fill or the manual in-stock toggle)
  if (badge) {
    if (soldOut) { badge.textContent = "Sold out"; badge.className = "shop-stock out"; badge.style.display = ""; }
    else if (shade.buyAvail === true) { badge.textContent = "In stock"; badge.className = "shop-stock in"; badge.style.display = ""; }
    else badge.style.display = "none";
  }
  // the URL the button/QR points at (product page, Shopify cart, or cart+discount)
  const buildUrl = (code) => (window.Commerce && window.Commerce.buildBuyUrl) ? window.Commerce.buildBuyUrl(shade, CONFIG, code) : shade.buyUrl;
  const staticUrl = buildUrl(null);
  buy.textContent = soldOut ? "Sold out" : (cm.buttonLabel || "Add to Cart");
  buy.classList.toggle("disabled", soldOut);
  buy.href = staticUrl;
  buy.onclick = async (e) => {
    if (soldOut) { e.preventDefault(); return; }
    try { trk("shopclick", { sku: shade.id }); } catch (err) {}
    // "discount" mode: claim/resolve the session coupon and apply it at checkout
    if ((cm.checkout === "discount") && shade.buyVariant && FEATURES.coupon && CONFIG.coupon && CONFIG.coupon.enabled) {
      e.preventDefault();
      const w = window.open("about:blank", "_blank"); // open synchronously to survive popup blockers
      let url = staticUrl;
      try { url = buildUrl(await ensureSessionCoupon()); } catch (err) {}
      if (w) w.location.href = url; else window.location.href = url;
    }
    // otherwise the anchor navigates to staticUrl (product page or cart permalink)
  };
  // QR to buy on the customer's own phone (product / cart URL)
  if (qr) {
    if (cm.showQr !== false && !soldOut && window.qrcode) {
      try {
        const q = window.qrcode(0, "M"); q.addData(staticUrl); q.make();
        qr.innerHTML = q.createSvgTag({ cellSize: 3, margin: 0, scalable: true });
        qr.style.display = "";
      } catch (e) { qr.style.display = "none"; }
    } else qr.style.display = "none";
  }
  card.classList.remove("hidden");
}

/* ---- Camera fit guidance: positioning oval + live low-light hint ---- */
let _camGuideTimer = null, _camLightTimer = null;
const _camSampleCv = document.createElement("canvas");
_camSampleCv.width = 32; _camSampleCv.height = 24;
function camBrightness() {
  const v = $("video");
  if (!v || v.readyState < 2 || !v.videoWidth) return null;
  try {
    const cx = _camSampleCv.getContext("2d");
    cx.drawImage(v, 0, 0, 32, 24);
    const d = cx.getImageData(0, 0, 32, 24).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    return sum / (d.length / 4);
  } catch (e) { return null; }
}
function startCamGuide() {
  const g = $("camGuide");
  if (!g || !FEATURES.camguide) return;
  g.classList.remove("hidden", "faded");
  clearTimeout(_camGuideTimer);
  _camGuideTimer = setTimeout(() => g.classList.add("faded"), 5000); // fade oval+tip, keep watching light
  clearInterval(_camLightTimer);
  _camLightTimer = setInterval(() => {
    const b = camBrightness(), hint = $("camLight");
    if (hint && b != null) hint.classList.toggle("hidden", b >= 55); // ~55/255 luma = too dark
  }, 1500);
}
function stopCamGuide() {
  const g = $("camGuide"); if (g) g.classList.add("hidden");
  clearInterval(_camLightTimer); clearTimeout(_camGuideTimer);
}

/* ---- Camera dock: fullscreen, colours minimise (auto after pick), options bar ---- */
let _colorsCollapseTimer = null;
function setColorsCollapsed(collapsed) {
  const ct = $("colorsToggle"); if (!ct) return;
  const wrap = ct.closest(".dock-colors"); if (!wrap) return;
  wrap.classList.toggle("collapsed", collapsed);
  ct.setAttribute("aria-expanded", collapsed ? "false" : "true");
  try { renderShopCard(selectedShade); } catch (e) {} // show/hide the product card with the colours
}
// Auto-collapse the colours shortly after a pick (debounced, so browsing stays open).
function scheduleColorsCollapse() {
  clearTimeout(_colorsCollapseTimer);
  _colorsCollapseTimer = setTimeout(() => setColorsCollapsed(true), 1200);
}
{
  const fsBtn = $("fullscreenBtn");
  const target = $("appScreen");
  if (fsBtn && target) {
    fsBtn.addEventListener("click", () => {
      if (document.fullscreenElement) { document.exitFullscreen && document.exitFullscreen(); }
      else if (target.requestFullscreen) { target.requestFullscreen().catch(() => {}); }
    });
    document.addEventListener("fullscreenchange", () => {
      fsBtn.classList.toggle("on", !!document.fullscreenElement);
      fsBtn.setAttribute("aria-pressed", document.fullscreenElement ? "true" : "false");
    });
  }
  const ct = $("colorsToggle");
  if (ct) {
    const wrap = ct.closest(".dock-colors");
    ct.addEventListener("click", () => {
      clearTimeout(_colorsCollapseTimer); // manual toggle cancels the auto-collapse
      const collapsed = wrap.classList.toggle("collapsed");
      ct.setAttribute("aria-expanded", collapsed ? "false" : "true");
      try { renderShopCard(selectedShade); } catch (e) {}
    });
  }
  const sc = $("shopClose");
  if (sc) sc.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    _shopDismissed = true;
    const card = $("shopCard"); if (card) card.classList.add("hidden");
  });
  const ot = $("optionsToggle");
  if (ot) {
    const wrap = ot.closest(".top-right");
    ot.addEventListener("click", () => {
      const collapsed = wrap.classList.toggle("collapsed");
      ot.setAttribute("aria-expanded", collapsed ? "false" : "true");
      ot.title = collapsed ? "Show options" : "Hide options";
    });
  }
}

function popShadeLabel(shade) {
  shadeLabel.innerHTML = "";
  if (shade.hex) {
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = shade.hex;
    shadeLabel.append(dot, document.createTextNode(shade.name));
  } else {
    shadeLabel.textContent = "Original";
  }
  shadeLabel.classList.remove("hidden");
  shadeLabel.classList.add("show");
  clearTimeout(popShadeLabel._t);
  popShadeLabel._t = setTimeout(() => shadeLabel.classList.remove("show"), 1400);
}

function setSplitView(on) {
  splitView = on;
  if (on) setGridMode(false);
  splitBtn.setAttribute("aria-pressed", on);
  if (on) showToast("Before / after — drag the divider");
  invalidate();
}

function setGridMode(on) {
  gridMode = on;
  if (on) setSplitView(false);
  gridBtn.setAttribute("aria-pressed", on);
  document.querySelector(".swatches-wrap").style.opacity = on ? 0.4 : 1;
  sheetBtn.classList.toggle("hidden", !on);
  if (on) showToast(staticMode ? "Every shade on your photo" : "Tap any shade to try it live");
  invalidate();
}

function setBoost(on) {
  boost = on;
  boostBtn.setAttribute("aria-pressed", on);
  // Rebuild every LUT (selected shade + grid) with the new curve.
  setSelectedLUT(selectedShade.hex);
  buildGridItems();
  showToast(on ? "Brighten on — simulates pre-lightened hair" : "Brighten off");
  invalidate();
}

splitBtn.addEventListener("click", () => setSplitView(!splitView));
gridBtn.addEventListener("click", () => setGridMode(!gridMode));
boostBtn.addEventListener("click", () => setBoost(!boost));
sheetBtn.addEventListener("click", saveComparisonSheet);

intensity.addEventListener("input", () => {
  level = Math.max(0, Math.min(MAX_LEVEL, parseInt(intensity.value, 10) || 0));
  liftAmt = LEVEL_LIFT[level];
  setSelectedLUT(selectedShade.hex); // rebuild the LUT for the new base lightness
  if (gridMode) buildGridItems();    // the compare grid bakes per-shade LUTs too
  intensityVal.textContent = levelLabel(level);
  updateLevelHint();
  invalidate();
});

/* ============================================================
   Capture: photo
   ============================================================ */
function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(
    d.getHours()
  )}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function doFlash() {
  flash.classList.remove("go");
  void flash.offsetWidth;
  flash.classList.add("go");
}

function captureTag() {
  return gridMode ? "compare" : selectedShade.id;
}

function takePhoto() {
  doFlash();
  // WATERMARK (disabled): to stamp captures, composite onto an offscreen copy
  // first and export `tmp` instead of `canvas`:
  //   const tmp = document.createElement("canvas");
  //   tmp.width = canvas.width; tmp.height = canvas.height;
  //   const tctx = tmp.getContext("2d");
  //   tctx.drawImage(canvas, 0, 0);
  //   drawWatermark(tctx, tmp.width, tmp.height);
  //   tmp.toBlob( ...same callback..., "image/jpeg", 0.95);
  canvas.toBlob(
    (blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const name = `icolorplus-${captureTag()}-${timestamp()}.jpg`;
      addCapture({ type: "photo", url, blob, name });
      triggerDownload(url, name);
      showToast("Photo saved to your device");
      trk("photo");
    },
    "image/jpeg",
    0.95
  );
}

/* ============================================================
   Capture: 30s video
   ============================================================ */
let recorder = null;
let recChunks = [];
let recTimer = null;
let recStart = 0;
let recStream = null;

function pickMime() {
  const opts = [
    "video/mp4;codecs=h264",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  for (const m of opts)
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  return "";
}

function startRecording() {
  if (!canvas.captureStream || !window.MediaRecorder) {
    showToast("Video recording isn't supported on this browser");
    return;
  }
  const mime = pickMime();
  recStream = canvas.captureStream(30);
  try {
    recorder = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
  } catch (e) {
    showToast("Unable to start recording");
    return;
  }
  recChunks = [];
  recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
  recorder.onstop = onRecordingStop;
  recorder.start(100);
  recStart = performance.now();
  recordBtn.classList.add("is-recording");
  recBadge.classList.remove("hidden");
  updateRecTime();
  recTimer = setInterval(updateRecTime, 200);
}

function updateRecTime() {
  const elapsed = performance.now() - recStart;
  const remaining = Math.max(0, MAX_RECORD_MS - elapsed);
  const secs = Math.ceil(remaining / 1000);
  recTime.textContent = `0:${String(secs).padStart(2, "0")}`;
  if (elapsed >= MAX_RECORD_MS) stopRecording();
}

function stopRecording() {
  if (!recorder || recorder.state === "inactive") return;
  clearInterval(recTimer);
  recorder.stop();
  recStream?.getTracks().forEach((t) => t.stop());
  recordBtn.classList.remove("is-recording");
  recBadge.classList.add("hidden");
}

function onRecordingStop() {
  const type = recorder.mimeType || "video/webm";
  const ext = type.includes("mp4") ? "mp4" : "webm";
  const blob = new Blob(recChunks, { type });
  const url = URL.createObjectURL(blob);
  const name = `icolorplus-${captureTag()}-${timestamp()}.${ext}`;
  addCapture({ type: "video", url, blob, name });
  triggerDownload(url, name);
  showToast("Video saved to your device");
  trk("video");
}

recordBtn.addEventListener("click", () => {
  if (recorder && recorder.state === "recording") stopRecording();
  else startRecording();
});

/* ---- Before/after reveal clip (animates the split wipe while recording) ---- */
let clipRecording = false;
async function recordBeforeAfterClip() {
  if (clipRecording) return;
  if (!canvas.captureStream || !window.MediaRecorder) { showToast("Clips aren't supported on this browser"); return; }
  if (isRecording()) { showToast("Finish the video first"); return; }
  if (!sel || !maskData) { showToast("Pick a colour first"); return; }
  if (gridMode) { showToast("Exit the grid to make a clip"); return; }
  clipRecording = true;
  const prevSplit = splitView, prevX = splitX;
  splitView = true;
  const clipBtn = $("clipBtn"); if (clipBtn) clipBtn.classList.add("is-recording");
  const mime = pickMime();
  let stream, rec;
  try { stream = canvas.captureStream(30); rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
  catch (e) { clipRecording = false; splitView = prevSplit; splitX = prevX; if (clipBtn) clipBtn.classList.remove("is-recording"); showToast("Unable to record"); return; }
  const chunks = []; rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((res) => (rec.onstop = res));
  rec.start(100);
  showToast("Creating your before/after…");
  const DUR = 4200, t0 = performance.now();
  await new Promise((res) => {
    function step() {
      const t = (performance.now() - t0) / DUR;
      if (t >= 1) { res(); return; }
      // hold BEFORE → sweep to AFTER → hold → sweep back
      let x;
      if (t < 0.15) x = 0.05;
      else if (t < 0.5) x = 0.05 + 0.9 * ((t - 0.15) / 0.35);
      else if (t < 0.62) x = 0.95;
      else x = 0.95 - 0.9 * ((t - 0.62) / 0.38);
      splitX = x; invalidate();
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  });
  try { rec.stop(); } catch (e) {}
  try { stream.getTracks().forEach((tk) => tk.stop()); } catch (e) {}
  await stopped;
  splitView = prevSplit; splitX = prevX; invalidate();
  if (clipBtn) clipBtn.classList.remove("is-recording");
  clipRecording = false;
  const type = rec.mimeType || "video/webm", ext = type.includes("mp4") ? "mp4" : "webm";
  const blob = new Blob(chunks, { type });
  if (!blob.size) { showToast("Clip was empty — try again"); return; }
  const url = URL.createObjectURL(blob);
  const name = `icolorplus-beforeafter-${timestamp()}.${ext}`;
  addCapture({ type: "video", url, blob, name });
  triggerDownload(url, name);
  showToast("Before/after clip saved");
  trk("video");
}
{ const cb = $("clipBtn"); if (cb) cb.addEventListener("click", recordBeforeAfterClip); }

/* ============================================================
   Downloads + gallery
   ============================================================ */
function triggerDownload(url, name) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function addCapture(cap) {
  captures.unshift(cap);
  updateGalleryThumb();
  renderCamGallery();
  maybeHandoffNudge();
}

// One-time, per-session hint that guests can take their photos home. Also keeps
// the dock "To phone" button visible once there's something to send.
function maybeHandoffNudge() {
  if (!handoffEnabled()) return;
  const db = $("dockSendBtn"); if (db) db.classList.remove("hidden");
  try { if (sessionStorage.getItem("icolorHandoffNudge")) return; sessionStorage.setItem("icolorHandoffNudge", "1"); } catch (e) {}
  showToast(t("ho_nudge"));
}

// Bottom preview strip of recent captures (in the camera dock).
function renderCamGallery() {
  const strip = $("camGallery");
  if (!strip) return;
  if (!captures.length) { strip.classList.add("hidden"); strip.innerHTML = ""; return; }
  strip.classList.remove("hidden");
  strip.innerHTML = captures.slice(0, 12).map((c) =>
    `<div class="cam-thumb" title="Open captures">` +
    (c.type === "photo"
      ? `<img src="${c.url}" alt="capture" />`
      : `<video src="${c.url}" muted playsinline></video><span class="vb">🎬</span>`) +
    `</div>`
  ).join("");
  strip.querySelectorAll(".cam-thumb").forEach((el) => el.addEventListener("click", openGallery));
}

function updateGalleryThumb() {
  const latest = captures.find((c) => c.type === "photo") || captures[0];
  if (!latest) return;
  if (latest.type === "photo") {
    galleryThumb.innerHTML = `<img src="${latest.url}" alt="latest capture" />`;
  }
}

function openGallery() {
  galleryGrid.innerHTML = "";
  galleryEmpty.style.display = captures.length ? "none" : "block";
  const sp = $("sendPhotosBtn");
  if (sp) sp.classList.toggle("hidden", !(handoffEnabled() && captures.length));
  captures.forEach((cap, idx) => {
    const item = document.createElement("div");
    item.className = "gallery-item";
    const media =
      cap.type === "photo"
        ? `<img src="${cap.url}" alt="capture" />`
        : `<video src="${cap.url}" muted playsinline loop></video>`;
    const badge =
      cap.type === "photo"
        ? `<span class="badge">📷 Photo</span>`
        : `<span class="badge">🎬 Video</span>`;
    item.innerHTML = `
      ${media}
      ${badge}
      <button class="del" title="Remove" data-idx="${idx}">
        <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="m12 10.6 5-5 1.4 1.4-5 5 5 5L17 18.4l-5-5-5 5L5.6 17l5-5-5-5L7 5.6l5 5Z"/></svg>
      </button>
      <span class="dl">
        <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 3v10.2l3.6-3.6L17 11l-5 5-5-5 1.4-1.4L12 13.2V3h0ZM5 19h14v2H5z"/></svg>
      </span>`;
    item.addEventListener("click", (e) => {
      if (e.target.closest(".del")) {
        captures.splice(idx, 1);
        URL.revokeObjectURL(cap.url);
        openGallery();
        updateGalleryThumb();
        renderCamGallery();
        return;
      }
      triggerDownload(cap.url, cap.name);
      showToast("Downloading…");
    });
    const vid = item.querySelector("video");
    if (vid) {
      item.addEventListener("mouseenter", () => vid.play().catch(() => {}));
      item.addEventListener("mouseleave", () => vid.pause());
    }
    galleryGrid.appendChild(item);
  });
  galleryModal.classList.remove("hidden");
}

/* ============================================================
   Toast
   ============================================================ */
let toastTimer;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 2200);
}

/* ============================================================
   Send-to-phone — OFFLINE media handoff (Tier 0 mini-PC / Tier 2 box)
   ------------------------------------------------------------
   Uploads this session's captures to an on-site box (a GL.iNet router on its own
   Wi-Fi, or the mini-PC on loopback) and shows the guest a QR to a LOCAL gallery
   page they open on their own phone. Needs NO internet at the venue.
   See handoff-box/SETUP.md.
   ============================================================ */
function handoffCfg() { return CONFIG.handoff || {}; }
function handoffEnabled() { return !!(FEATURES.handoff && (handoffCfg().url || "").trim()); }
function handoffBase() { return (handoffCfg().url || "").trim().replace(/\/+$/, ""); }

// WIFI: QR payload so the guest joins the box Wi-Fi without typing a password.
function wifiJoinPayload() {
  const h = handoffCfg();
  const ssid = (h.wifiSsid || "").trim();
  if (!ssid) return "";
  const esc = (s) => String(s).replace(/([\\;,":])/g, "\\$1");
  const pass = (h.wifiPass || "").trim();
  return "WIFI:T:" + (pass ? "WPA" : "nopass") + ";S:" + esc(ssid) + ";" + (pass ? "P:" + esc(pass) + ";" : "") + ";";
}

function qrSvg(str, cell) {
  if (!window.qrcode || !str) return "";
  try { const q = window.qrcode(0, "M"); q.addData(str); q.make(); return q.createSvgTag({ cellSize: cell || 4, margin: 1, scalable: true }); }
  catch (e) { return ""; }
}

function openHandoffModal() { const m = $("handoffModal"); if (m) m.classList.remove("hidden"); }
function closeHandoffModal() { const m = $("handoffModal"); if (m) m.classList.add("hidden"); }

function renderHandoffState(state, data) {
  const body = $("handoffBody");
  if (!body) return;
  data = data || {};
  if (state === "uploading") {
    body.innerHTML = '<div class="handoff-loading"><div class="handoff-spinner" aria-hidden="true"></div><p>' + esc(t("ho_prep")) + '</p></div>';
    return;
  }
  if (state === "error") {
    body.innerHTML =
      '<div class="handoff-error"><p class="he-title">' + esc(t("ho_err_title")) + '</p>' +
      '<p class="muted">' + esc(t("ho_err_sub")) + '</p>' +
      '<button id="handoffRetry" class="pill-btn">' + esc(t("ho_retry")) + '</button></div>';
    const r = $("handoffRetry"); if (r) r.onclick = sendToPhone;
    return;
  }
  // state === "ready"
  const wifi = wifiJoinPayload();
  const wifiBlock = wifi
    ? '<div class="handoff-step"><div class="hs-num">1</div><div class="hs-txt"><b>' + esc(t("ho_join")) + '</b>' +
        '<span class="muted">' + esc(t("ho_join_sub")) + '</span></div>' +
        '<div class="hs-qr">' + qrSvg(wifi, 4) + '</div></div>'
    : '';
  const stepN = wifi ? "2" : "1";
  body.innerHTML =
    '<p class="handoff-lead">' + esc(t("ho_lead")) + '</p>' +
    wifiBlock +
    '<div class="handoff-step"><div class="hs-num">' + stepN + '</div><div class="hs-txt"><b>' + esc(t("ho_scan")) + '</b>' +
      '<span class="muted">' + esc(t("ho_scan_sub")) + '</span>' +
      (data.code ? '<span class="handoff-code">' + esc(t("ho_code")) + ': ' + esc(data.code) + '</span>' : '') +
    '</div><div class="hs-qr">' + qrSvg(data.url, 5) + '</div></div>' +
    '<p class="handoff-foot muted">' + esc(t("ho_foot")) + '</p>';
}

// The store logo, inlined as a data URL once, so the guest gallery can be branded
// even fully offline. Cached; failures are silently ignored.
let _logoDataUrl = null, _logoTried = false;
async function ensureLogoDataUrl() {
  if (_logoTried) return _logoDataUrl;
  _logoTried = true;
  try {
    const res = await fetch("assets/logo.svg", { cache: "force-cache" });
    if (res.ok) {
      const txt = await res.text();
      if (txt && txt.length < 40000) _logoDataUrl = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(txt)));
    }
  } catch (e) {}
  return _logoDataUrl;
}

// Compact JSON the box embeds in the guest gallery: brand, tried shades (with buy
// links), promo and coupon — so guests can shop the look after they leave.
async function buildHandoffInfo() {
  const cm = CONFIG.commerce || {};
  const byId = {}; SHADES.forEach((s) => (byId[s.id] = s));
  const shades = triedShades.map((id) => byId[id]).filter((s) => s && s.hex).map((s) => ({
    name: s.name, hex: s.hex,
    buyUrl: (FEATURES.commerce && s.buyUrl) ? s.buyUrl : "",
    price: (FEATURES.commerce && s.buyPrice) ? s.buyPrice : "",
  }));
  const info = { lang: LANG, currency: cm.currency || "", shades: shades };
  try { const loc = window.Analytics && window.Analytics.currentLocation(); info.brand = (loc && loc.name) || ""; } catch (e) {}
  const logo = await ensureLogoDataUrl(); if (logo) info.logo = logo;
  const promo = CONFIG.promo || {};
  if (FEATURES.promo && promo.enabled && (promo.title || promo.message)) info.promo = { title: promo.title || "", message: promo.message || "" };
  const coupon = CONFIG.coupon || {};
  if (FEATURES.coupon && coupon.enabled) {
    let code = coupon.code || "";
    // Per-guest UNIQUE voucher (claimed once per session) when toggled on in admin.
    if (handoffCfg().voucher) { try { code = await ensureSessionCoupon(); } catch (e) {} }
    if (code) info.coupon = { code: code, label: coupon.label || "", terms: coupon.terms || "" };
  }
  return info;
}

async function sendToPhone() {
  if (!handoffEnabled()) { showToast(t("ho_not_setup")); return; }
  if (!captures.length) { showToast(t("ho_take_first")); return; }
  const base = handoffBase();
  openHandoffModal();
  renderHandoffState("uploading");
  const fd = new FormData();
  try {
    const loc = window.Analytics && window.Analytics.currentLocation();
    if (loc) { fd.append("loc", loc.id || ""); fd.append("locn", loc.name || ""); }
  } catch (e) {}
  try { fd.append("info", JSON.stringify(await buildHandoffInfo())); } catch (e) {}
  // Oldest-first so the gallery reads in capture order.
  captures.slice().reverse().forEach((c, i) => {
    const ext = c.type === "video" ? "webm" : "jpg";
    fd.append("files", c.blob, c.name || ("icolor-" + (i + 1) + "." + ext));
  });
  try {
    const res = await fetch(base + "/handoff", { method: "POST", body: fd });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const url = (data && (data.url || (data.code ? base + "/g/" + data.code : ""))) || "";
    if (!url) throw new Error("no url");
    renderHandoffState("ready", { url: url, code: (data && data.code) || "" });
    try { trk("handoff"); } catch (e) {}
  } catch (err) {
    renderHandoffState("error");
  }
}

// Build the analysis / social card, drop it into the gallery, and hand it to the
// guest's phone in one tap (from the analysis modal).
async function sendAnalysisToPhone() {
  if (!handoffEnabled()) { showToast("Photo transfer isn’t set up here."); return; }
  const a = lastAnalysis || analyzeCurrent();
  if (!a) { showToast("Analyze your hair first"); return; }
  showToast("Building your card…");
  const cv = await buildReportCard(a, cardFormat);
  await new Promise((res) => cv.toBlob((blob) => {
    if (blob) {
      const url = URL.createObjectURL(blob);
      addCapture({ type: "photo", url, blob, name: `icolorplus-analysis-${timestamp()}.jpg` });
    }
    res();
  }, "image/jpeg", 0.92));
  sendToPhone();
}

// Small HTML-escape used by the handoff renderer.
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

/* ============================================================
   Wiring
   ============================================================ */
photoBtn.addEventListener("click", takePhoto);
galleryBtn.addEventListener("click", openGallery);
$("closeGallery").addEventListener("click", () =>
  galleryModal.classList.add("hidden")
);
$("sendPhotosBtn").addEventListener("click", sendToPhone);
$("closeHandoff").addEventListener("click", closeHandoffModal);
$("sendAnalysisPhone").addEventListener("click", sendAnalysisToPhone);
$("dockSendBtn").addEventListener("click", sendToPhone);
// Reveal the handoff affordances only when handoff is configured.
if (handoffEnabled()) {
  $("sendAnalysisPhone").classList.remove("hidden");
  if (captures.length) $("dockSendBtn").classList.remove("hidden");
  // Optional per-site custom label overrides the localized default on the main CTA.
  const hl = (handoffCfg().label || "").trim();
  const gp = $("sendPhotosLbl");
  if (gp && hl) { gp.textContent = hl; gp.removeAttribute("data-i18n"); }
}
analysisBtn.addEventListener("click", () => openAnalysis(false));
$("closeAnalysis").addEventListener("click", () =>
  analysisModal.classList.add("hidden")
);
$("shareBtn").addEventListener("click", shareReportCard);
$("saveImgBtn").addEventListener("click", saveReportImage);
$("printBtn").addEventListener("click", printReportCard);
// Hide the native Share button where the Web Share API (with files) isn't available.
if (typeof navigator.canShare !== "function") $("shareBtn").style.display = "none";

flipBtn.addEventListener("click", async () => {
  facingMode = facingMode === "user" ? "environment" : "user";
  try {
    await startCamera();
  } catch (e) {
    facingMode = facingMode === "user" ? "environment" : "user";
    showToast("Couldn't switch camera");
  }
});

async function ensureSegmenter() {
  if (!segmenter) await initSegmenter();
}

// One-time UI setup shared by the camera and upload entry points.
function initAppUIOnce() {
  if (appInited) return;
  appInited = true;
  setSelectedLUT(selectedShade.hex);
  buildSwatches();
  buildGridItems();
  selectShade(selectedShade);
  intensity.value = level;
  liftAmt = LEVEL_LIFT[level];
  intensityVal.textContent = levelLabel(level);
  updateLevelHint();
}

function setStaticUI(on) {
  flipBtn.classList.toggle("hidden", on);
  cameraBtn.classList.toggle("hidden", !on);
}

// Run hair segmentation on an uploaded photo and switch to static preview.
async function useUploadedPhoto(bitmap) {
  const scale = Math.min(1, PROC_MAX_W / bitmap.width);
  const pw = Math.max(1, Math.round(bitmap.width * scale));
  const ph = Math.max(1, Math.round(bitmap.height * scale));
  staticImg.width = pw;
  staticImg.height = ph;
  sictx.drawImage(bitmap, 0, 0, pw, ph);
  proc.width = pw;
  proc.height = ph;
  canvas.width = pw;
  canvas.height = ph;

  // Segment the still (VIDEO-mode segmenter accepts a canvas source).
  segmentSource(staticImg);
  // If the GPU delegate returned an empty mask (near-zero hair coverage),
  // rebuild on CPU and re-segment — this is the common broken-GPU case.
  if (!cpuMode && maskSignal().cover < 0.004) await switchToCpu(staticImg);
  updateHairStatus(maskSignal());

  stopStream(); // free the camera while viewing a photo
  staticMode = true;
  staticReady = true;
  setStaticUI(true);
  invalidate();
  if (!running) {
    running = true;
    renderLoop();
  }
}

async function loadBitmap(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (e) {
    // Fallback for browsers without createImageBitmap options.
    return await new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = URL.createObjectURL(file);
    });
  }
}

/* ---- "Get this look" — match an iColor shade from an inspiration photo ---- */
function redmean(c1, c2) {
  const rm = (c1[0] + c2[0]) / 2, dr = c1[0] - c2[0], dg = c1[1] - c2[1], db = c1[2] - c2[2];
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}
async function matchLookFromImage(bitmap) {
  await ensureSegmenter();
  const w = Math.min(480, bitmap.width || 480);
  const h = Math.max(1, Math.round((bitmap.height || 480) * (w / (bitmap.width || 480))));
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  cx.drawImage(bitmap, 0, 0, w, h);
  const res = segmenter.segmentForVideo(cv, performance.now());
  const masks = res && res.confidenceMasks;
  let mask = null, mw = 0, mh = 0;
  if (masks && masks.length) {
    const hair = masks[masks.length > 1 ? 1 : 0];
    mask = new Float32Array(hair.getAsFloat32Array());
    mw = hair.width; mh = hair.height;
  }
  res && res.close && res.close();
  if (!mask) return null;
  const data = cx.getImageData(0, 0, w, h).data;
  const mapx = buildMap(w, mw), mapy = buildMap(h, mh);
  let r = 0, g = 0, b = 0, wt = 0, cnt = 0;
  for (let y = 0; y < h; y += 2) {
    const rm = mapy[y] * mw, rp = y * w;
    for (let x = 0; x < w; x += 2) {
      const m = mask[rm + mapx[x]];
      if (m < 0.3) continue;
      const i = (rp + x) << 2;
      r += data[i] * m; g += data[i + 1] * m; b += data[i + 2] * m; wt += m; cnt++;
    }
  }
  if (cnt < 15 || wt <= 0) return null;
  const hair = [Math.round(r / wt), Math.round(g / wt), Math.round(b / wt)];
  const matches = SHADES.filter((s) => s.hex)
    .map((s) => ({ shade: s, dist: redmean(hair, hexToRgb(s.hex)) }))
    .sort((a, b2) => a.dist - b2.dist)
    .slice(0, 3);
  return { hair, matches };
}
function renderLookModal(res) {
  const top = res.matches[0];
  lookBody.innerHTML =
    `<section class="an-detected">
      <div class="an-card"><span class="an-swatch" style="background:${rgbToHex(res.hair)}"></span>
        <div><h4>${t("theLook")}</h4><p>${t("detectedColour")}</p></div></div>
      <div class="an-card"><span class="an-swatch" style="background:${top.shade.hex}"></span>
        <div><h4>${t("closest")}</h4><p>${top.shade.name}</p></div></div>
    </section>
    <section><h3>${t("topMatches")}</h3><div class="an-recs">` +
    res.matches.map((m, i) =>
      `<div class="an-rec"><span class="an-dot" style="background:${m.shade.hex}"></span>
        <div class="an-rec-body"><div class="an-rec-top"><strong>${m.shade.name}</strong>${i === 0 ? `<span class="an-badge ok">${t("bestMatch")}</span>` : ""}</div>
        <p>${m.shade.collection || ""}</p></div>
        <button class="an-try" data-id="${m.shade.id}">${t("tryIt")}</button></div>`
    ).join("") + `</div></section>`;
  lookBody.querySelectorAll(".an-try").forEach((btn) =>
    btn.addEventListener("click", () => { pendingPromoShade = btn.dataset.id; lookModal.classList.add("hidden"); startBtn.click(); })
  );
  lookModal.classList.remove("hidden");
}
async function handleLookFile(file) {
  if (!file || !file.type.startsWith("image/")) { showToast(t("pickImage")); return; }
  showToast(t("analyzingLook"));
  try {
    const bmp = await loadBitmap(file);
    const res = await matchLookFromImage(bmp);
    if (!res) { showToast(t("noHairLook")); return; }
    renderLookModal(res);
  } catch (e) { console.error(e); showToast(t("lookFailed")); }
}

async function handlePickedFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    showToast("Please choose an image file");
    return;
  }
  const firstEntry = appScreen.classList.contains("hidden");
  startScreen.classList.add("hidden");
  appScreen.classList.remove("hidden");
  stopCamGuide(); // static photo — no live-camera guidance
  loader.classList.remove("hidden");
  loaderText.textContent = segmenter ? "Analyzing your hair…" : "Loading AR engine…";
  try {
    await ensureSegmenter();
    initAppUIOnce();
    loaderText.textContent = "Analyzing your hair…";
    const bmp = await loadBitmap(file);
    await useUploadedPhoto(bmp);
    trk("sessions");
    loader.classList.add("hidden");
    // Give the first frame a beat to render, then present the analysis.
    if (FEATURES.analysis) setTimeout(() => openAnalysis(true), 350);
    else showToast("Analyzed — pick a shade to preview");
  } catch (err) {
    console.error(err);
    loader.classList.add("hidden");
    showToast("Couldn't analyze that photo — try another");
    if (firstEntry) {
      appScreen.classList.add("hidden");
      startScreen.classList.remove("hidden");
    }
  }
}

// Switch from an uploaded photo back to the live camera.
async function goLive() {
  loader.classList.remove("hidden");
  loaderText.textContent = "Starting camera…";
  try {
    await ensureSegmenter();
    await startCamera();
    staticMode = false;
    staticReady = false;
    lastVideoTime = -1;
    setStaticUI(false);
    loader.classList.add("hidden");
    if (!running) {
      running = true;
      renderLoop();
    }
    startCamGuide();
  } catch (err) {
    console.error(err);
    loader.classList.add("hidden");
    showToast("Couldn't start the camera");
  }
}

fileInput.addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ""; // allow re-picking the same file
  if (file) handlePickedFile(file);
});
startUploadBtn.addEventListener("click", () => fileInput.click());
uploadBtn.addEventListener("click", () => fileInput.click());
cameraBtn.addEventListener("click", goLive);
lookBtn.addEventListener("click", () => lookFile.click());
lookFile.addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ""; if (f) handleLookFile(f); });
$("closeLook").addEventListener("click", () => lookModal.classList.add("hidden"));
{ const lb = $("langBtn"); if (lb) lb.addEventListener("click", cycleLang); }

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  startStatus.classList.remove("error");
  try {
    startStatus.textContent = "Requesting camera access…";
    await startCamera();
    startScreen.classList.add("hidden");
    appScreen.classList.remove("hidden");
    loader.classList.remove("hidden");
    loaderText.textContent = "Loading AR engine…";
    await ensureSegmenter();
    initAppUIOnce();
    staticMode = false;
    setStaticUI(false);
    loader.classList.add("hidden");
    running = true;
    renderLoop();
    speak(t("voice_welcome"));
    trk("sessions");
    startCamGuide();
    if (pendingPromoShade) {
      const sh = SHADES.find((s) => s.id === pendingPromoShade);
      if (sh) selectShade(sh);
      pendingPromoShade = null;
    }
  } catch (err) {
    console.error(err);
    startBtn.disabled = false;
    startScreen.classList.remove("hidden");
    appScreen.classList.add("hidden");
    loader.classList.remove("hidden");
    startStatus.classList.add("error");
    startStatus.textContent =
      err && err.name === "NotAllowedError"
        ? "Camera permission was denied. Please allow access, or upload a photo instead."
        : "Couldn't start the camera. Try uploading a photo instead. " + (err?.message || "");
  }
});

/* ============================================================
   Kiosk attract / idle "mirror" teaser
   Reuses the normal camera pipeline; only runs if camera permission is already
   granted (so it never surprise-prompts). Feature-flagged (off by default).
   ============================================================ */
const ATTRACT = CONFIG.attract || {};
let attractActive = false, _idleTimer = null;
const attractOverlay = $("attractOverlay");
async function cameraGranted() {
  try { const p = await navigator.permissions.query({ name: "camera" }); return p.state === "granted"; }
  catch (e) { return false; }
}
function armIdle() {
  if (!FEATURES.attract) return;
  clearTimeout(_idleTimer);
  if (!attractActive && !startScreen.classList.contains("hidden")) {
    _idleTimer = setTimeout(enterAttract, ATTRACT.idleMs || 45000);
  }
}
async function enterAttract() {
  if (!FEATURES.attract || attractActive) return;
  if (startScreen.classList.contains("hidden")) return; // only from the start screen
  // Idle promo mode: pop up the campaign (no camera) instead of the mirror
  const pr = CONFIG.promo || {};
  if (ATTRACT.usePromo && FEATURES.promo && pr.enabled) {
    attractActive = true;
    openPromoModal();
    return;
  }
  if (!(await cameraGranted())) return;                 // never surprise-prompt
  try {
    await ensureSegmenter();
    await startCamera();
    attractActive = true;
    startScreen.classList.add("hidden");
    appScreen.classList.remove("hidden");
    initAppUIOnce();
    staticMode = false; setStaticUI(false);
    if (!running) { running = true; renderLoop(); }
    const sh = SHADES.find((s) => s.id === ATTRACT.shadeId) || SHADES[0];
    if (sh) selectShade(sh);
    if ($("attractCta") && ATTRACT.cta) $("attractCta").textContent = ATTRACT.cta;
    renderAttractBoard();
    if (attractOverlay) attractOverlay.classList.remove("hidden");
  } catch (e) { attractActive = false; } // no camera → stay on the start screen
}
// "Most-loved shades here" leaderboard on the idle attract mirror (this location's
// top try-ons). Hidden until there's a little data so it never shows a lonely "1".
function renderAttractBoard() {
  const el = $("attractBoard"); if (!el) return;
  let perSku = {};
  try { const A = window.Analytics, L = A.load().locations[A.currentLocation().id]; perSku = (L && L.perSku) || {}; } catch (e) {}
  let top = [];
  try { top = window.Dash ? window.Dash.topSkus(perSku, 3) : []; } catch (e) {}
  if (!top.length || top[0].value < 3) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  el.classList.remove("hidden");
  el.innerHTML = '<div class="attract-board-title">🔥 Most-loved shades here</div>' +
    top.map((s, i) => `<div class="ab-row"><span class="ab-rank">${i + 1}</span><span class="ab-sw" style="background:${s.color}"></span><span class="ab-name">${s.label}</span></div>`).join("");
}
function exitAttract() {
  if (!attractActive) return;
  attractActive = false;
  if (attractOverlay) attractOverlay.classList.add("hidden");
  trk("sessions"); // visitor is now engaging with a live session
}
if (attractOverlay) {
  attractOverlay.addEventListener("pointerdown", exitAttract);
  attractOverlay.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); exitAttract(); } });
}
["pointerdown", "keydown", "touchstart"].forEach((ev) =>
  window.addEventListener(ev, () => { if (!attractActive) armIdle(); }, { passive: true })
);
armIdle();

/* ============================================================
   Feature gating (package tiers from config)
   ============================================================ */
function hideEl(el) { if (el) el.style.display = "none"; }
function applyFeatureGating() {
  if (!FEATURES.upload) { hideEl(uploadBtn); hideEl(startUploadBtn); hideEl(document.querySelector(".or-sep")); }
  if (!FEATURES.photo) hideEl(photoBtn);
  if (!FEATURES.video) hideEl(recordBtn);
  if (!FEATURES.split) hideEl(splitBtn);
  if (!FEATURES.video || !FEATURES.split) { const cb = $("clipBtn"); if (cb) hideEl(cb); } // before/after clip needs both
  if (!FEATURES.grid) { hideEl(gridBtn); hideEl(sheetBtn); }
  hideEl(boostBtn); // the hair-level slider replaces the old Brighten toggle
  if (!FEATURES.analysis) hideEl(analysisBtn);
  if (!FEATURES.photo && !FEATURES.video) hideEl(galleryBtn);
  if (!FEATURES.cards) { hideEl($("shareBtn")); hideEl($("saveImgBtn")); }
  if (!FEATURES.print) hideEl($("printBtn"));
  if (FEATURES.getlook) lookBtn.classList.remove("hidden"); else hideEl(lookBtn);
  const lb = $("langBtn");
  if (lb) { if (FEATURES.multilang && enabledLangs().length > 1) lb.classList.remove("hidden"); else hideEl(lb); }
}
applyFeatureGating();
document.body.classList.toggle("kiosk-lg", !!FEATURES.bigtap); // large-tap kiosk theme
applyI18n();
setLang(LANG);

// Offline PWA — cache the app + model so kiosks survive wifi drops.
if (FEATURES.offline && "serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").catch(() => {}); });
}

// Fleet health beacon: stamp build + a health snapshot locally on load and every
// 60s (works offline; travels to Super Admin via the backend sync below or export).
pulseHealth();
setInterval(pulseHealth, 60000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) pulseHealth(); });

// CRM lead webhook: drain any queued leads (works without PocketBase; retries online).
if (window.Backend && window.Backend.flushLeadHookOutbox) {
  const fh = () => { try { window.Backend.flushLeadHookOutbox(); } catch (e) {} };
  fh();
  window.addEventListener("online", fh);
  setInterval(fh, 60000);
}

// Live backend (optional): mirror this location to the cloud + pull fleet config.
if (window.Backend && window.Backend.enabled()) {
  window.Backend.init().then((ok) => {
    if (!ok) return;
    const flush = () => { try { window.Backend.flushLeadOutbox && window.Backend.flushLeadOutbox(); } catch (e) {} };
    setInterval(() => { pulseHealth(); window.Backend.upsertLocation(); flush(); }, 30000);
    pulseHealth();
    window.Backend.upsertLocation();
    flush(); // drain any leads captured while offline
    window.addEventListener("online", flush);
    if (!sessionStorage.getItem("icolorFleetPulled")) {
      sessionStorage.setItem("icolorFleetPulled", "1");
      window.Backend.fetchConfig().then((remote) => {
        if (remote && JSON.stringify(remote) !== localStorage.getItem("icolorConfig")) {
          localStorage.setItem("icolorConfig", JSON.stringify(remote));
          location.reload();
        }
      }).catch(() => {});
    }
  });
}

/* ============================================================
   Kiosk self-test — pre-shift diagnostics (camera / model / printer /
   backend / offline cache). Open with ?selftest=1, triple-tap the logo,
   or the "Self-test" button in the Admin console.
   ============================================================ */
function ensureSelfTestModal() {
  let m = $("selfTestModal");
  if (m) return m;
  m = document.createElement("div");
  m.id = "selfTestModal";
  m.className = "modal hidden";
  m.innerHTML =
    '<div class="modal-head"><h2>Kiosk self-test</h2>' +
    '<button class="icon-btn" data-st-close aria-label="Close"><svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="m12 10.6 5-5 1.4 1.4-5 5 5 5L17 18.4l-5-5-5 5L5.6 17l5-5-5-5L7 5.6l5 5Z"/></svg></button></div>' +
    '<div class="st-body"><div id="stList" class="st-list"></div>' +
    '<div class="st-actions"><button id="stRun" class="btn">Run checks</button> <span id="stSummary" class="muted"></span></div></div>';
  document.body.appendChild(m);
  m.querySelector("[data-st-close]").addEventListener("click", () => m.classList.add("hidden"));
  m.querySelector("#stRun").addEventListener("click", () => runSelfTest());
  return m;
}
async function probeCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return { status: "bad", detail: "No camera API (needs HTTPS)" };
  let s = null;
  try {
    s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facingMode } }, audio: false });
    const track = s.getVideoTracks()[0];
    HEALTH.camera = true;
    return { status: "ok", detail: ((track && track.label) || "camera").slice(0, 42) };
  } catch (e) {
    HEALTH.camera = false;
    return { status: "bad", detail: e && e.name === "NotAllowedError" ? "Permission denied" : (e && e.name) || "No camera" };
  } finally { if (s) s.getTracks().forEach((t) => t.stop()); }
}
async function probeModel() {
  if (segmenter && HEALTH.model) return { status: "ok", detail: cpuMode ? "loaded (CPU)" : "loaded (GPU)" };
  try { await initSegmenter(cpuMode ? "CPU" : "GPU"); return { status: "ok", detail: "loaded " + (cpuMode ? "(CPU)" : "(GPU)") }; }
  catch (e) { return { status: "bad", detail: "model/wasm failed (needs internet on first load)" }; }
}
function probePrinter() {
  if (!FEATURES.print) return { status: "info", detail: "Print feature off" };
  const mode = PRINT.mode || "color";
  if (mode !== "thermal") return { status: "ok", detail: mode.toUpperCase() + " → device print dialog" };
  const sup = window.ICPrinter && window.ICPrinter.supported(PRINT.transport || "bluetooth");
  return sup
    ? { status: "ok", detail: "Thermal " + (PRINT.transport || "bluetooth") + " ready (pair in Admin → Test print)" }
    : { status: "bad", detail: (PRINT.transport || "bluetooth") + " not supported here (iOS can't)" };
}
async function probeBackend() {
  if (!(window.Backend && window.Backend.enabled())) return { status: "info", detail: "Local only (no backend)" };
  try { const ok = await window.Backend.init(); return ok ? { status: "ok", detail: "connected" } : { status: "bad", detail: "unreachable" }; }
  catch (e) { return { status: "bad", detail: "unreachable" }; }
}
async function probeSW() {
  if (!FEATURES.offline) return { status: "info", detail: "Offline cache off" };
  if (!("serviceWorker" in navigator)) return { status: "warn", detail: "No service-worker support" };
  try { const reg = await navigator.serviceWorker.getRegistration(); return reg ? { status: "ok", detail: navigator.serviceWorker.controller ? "active (offline-ready)" : "registered" } : { status: "warn", detail: "not registered yet" }; }
  catch (e) { return { status: "warn", detail: "unknown" }; }
}
async function runSelfTest() {
  ensureSelfTestModal();
  const list = $("stList"); if (!list) return;
  const checks = [
    { name: "App build", run: () => ({ status: "info", detail: CONFIG.build || "—" }) },
    { name: "Location", run: () => { const l = (window.Analytics && window.Analytics.currentLocation()) || {}; return { status: l.id && l.id !== "unassigned" ? "ok" : "warn", detail: l.name || "unassigned" }; } },
    { name: "Network", run: () => ({ status: navigator.onLine === false ? "warn" : "info", detail: navigator.onLine === false ? "Offline (fine for kiosks)" : "Online" }) },
    { name: "Camera", run: probeCamera },
    { name: "Hair model", run: probeModel },
    { name: "Printer", run: probePrinter },
    { name: "Backend sync", run: probeBackend },
    { name: "Offline cache", run: probeSW },
  ];
  list.innerHTML = checks.map((c, i) => `<div class="st-item" data-i="${i}"><span class="st-dot run">⋯</span><span class="st-name">${c.name}</span><span class="st-detail">testing…</span></div>`).join("");
  const sum = $("stSummary"); if (sum) sum.textContent = "";
  let bad = 0;
  for (let i = 0; i < checks.length; i++) {
    let r; try { r = await checks[i].run(); } catch (e) { r = { status: "bad", detail: (e && e.message) || "error" }; }
    const row = list.querySelector(`[data-i="${i}"]`); if (!row) continue;
    const dot = row.querySelector(".st-dot"), det = row.querySelector(".st-detail");
    dot.className = "st-dot " + r.status;
    dot.textContent = r.status === "ok" ? "✓" : r.status === "bad" ? "✕" : r.status === "warn" ? "!" : "i";
    det.textContent = r.detail || "";
    if (r.status === "bad") bad++;
  }
  if (sum) sum.textContent = bad ? bad + " issue" + (bad > 1 ? "s" : "") + " — see the red rows" : "All good — ready for the shift ✓";
  pulseHealth();
}
function openSelfTest() { const m = ensureSelfTestModal(); m.classList.remove("hidden"); runSelfTest(); }
// Triggers: ?selftest=1 on load, and a triple-tap on the start-screen logo.
try { if (new URLSearchParams(location.search).get("selftest")) setTimeout(openSelfTest, 500); } catch (e) {}
{
  const plate = document.querySelector(".logo-plate");
  if (plate) {
    let taps = 0, tmr = null;
    plate.addEventListener("click", () => { taps++; clearTimeout(tmr); if (taps >= 3) { taps = 0; openSelfTest(); } else tmr = setTimeout(() => (taps = 0), 600); });
  }
}

/* ---- Promo banner + QR handoff (start screen) ---- */
let pendingPromoShade = null;
// Resolve the promo to show, applying the A/B variant when active.
function resolvedPromo() {
  const p0 = CONFIG.promo || {};
  if (window._abVariant === "B" && p0.ab && p0.ab.enabled) {
    return Object.assign({}, p0, {
      title: p0.ab.title || p0.title,
      message: p0.ab.message || p0.message,
      shadeId: p0.ab.shadeId || p0.shadeId,
      image: p0.ab.image || p0.image,
    });
  }
  return p0;
}
function promoInnerHTML(p) {
  if (p.image) return `<img src="${p.image}" alt="Promo" />`;
  const shade = SHADES.find((s) => s.id === p.shadeId);
  return `<div class="promo-card">` +
    (shade ? `<span class="p-dot" style="background:${shade.hex}"></span>` : "") +
    `<div><div class="p-tag">${p.title || "Featured"}</div>` +
    (shade ? `<div class="p-title">${shade.name}</div>` : "") +
    `<div class="p-msg">${p.message || ""}</div></div></div>`;
}
// The full set of campaigns to rotate through: A, B (if set), then extra campaigns.
let _promoRotateTimer = null, _promoIdx = 0;
function promoSet() {
  const p = CONFIG.promo || {};
  const set = [{ label: "A", title: p.title, message: p.message, shadeId: p.shadeId, image: p.image }];
  const b = p.ab || {};
  if (b.enabled || b.title || b.message || b.shadeId || b.image) {
    set.push({ label: "B", title: b.title || p.title, message: b.message || p.message, shadeId: b.shadeId || p.shadeId, image: b.image || p.image });
  }
  (p.campaigns || []).forEach((c, i) => {
    if (!c) return;
    set.push({ label: String.fromCharCode(67 + i), title: c.title || p.title, message: c.message || p.message, shadeId: c.shadeId || p.shadeId, image: c.image || p.image });
  });
  return set;
}
function promoRotating() {
  const p = CONFIG.promo || {};
  return p.rotateSec > 0 && promoSet().length > 1;
}
// The promo to show right now: rotating campaign, else the A/B-resolved one.
function activePromo() {
  if (promoRotating()) {
    const set = promoSet(), c = set[_promoIdx % set.length];
    try { window.Analytics && window.Analytics.setVariant(c.label); } catch (e) {}
    return c;
  }
  return resolvedPromo();
}
function startPromoRotation() {
  clearInterval(_promoRotateTimer);
  if (!(FEATURES.promo && (CONFIG.promo || {}).enabled && promoRotating())) return;
  const secs = Math.max(2, CONFIG.promo.rotateSec);
  _promoRotateTimer = setInterval(() => {
    _promoIdx = (_promoIdx + 1) % promoSet().length;
    const banner = $("promoBanner");
    if (banner && !banner.classList.contains("hidden")) renderPromoBanner();
    const modal = $("promoModal");
    if (modal && !modal.classList.contains("hidden")) {
      const body = $("promoModalBody"); if (body) body.innerHTML = promoInnerHTML(activePromo());
    }
  }, secs * 1000);
}
function renderPromoBanner() {
  const box = $("promoBanner");
  if (!box) return;
  const p0 = CONFIG.promo || {};
  if (!(FEATURES.promo && p0.enabled)) { box.classList.add("hidden"); return; }
  const p = activePromo();
  box.classList.remove("hidden");
  box.innerHTML = promoInnerHTML(p);
  box.style.cursor = "pointer";
  box.onclick = () => { if (p.shadeId) pendingPromoShade = p.shadeId; startBtn.click(); };
}

/* ---- Promo / campaign popup (start screen + idle attract) ---- */
function openPromoModal() {
  const m = $("promoModal"); if (!m) return;
  const p = activePromo();
  const body = $("promoModalBody"); if (body) body.innerHTML = promoInnerHTML(p);
  const cta = $("promoModalCta"); if (cta) cta.textContent = (CONFIG.promo || {}).popupText || "Tap the screen, and try-on our iColor products!";
  m.classList.remove("hidden");
  startPromoRotation();
}
function closePromoModal(start) {
  const m = $("promoModal"); if (m) m.classList.add("hidden");
  attractActive = false;
  if (start) {
    const p = activePromo();
    if (p.shadeId) pendingPromoShade = p.shadeId;
    if (startBtn) startBtn.click();
  } else {
    try { armIdle(); } catch (e) {} // dismissed → re-arm the idle timer
  }
}
{
  const m = $("promoModal");
  if (m) {
    m.addEventListener("click", (e) => { if (e.target && e.target.id === "promoModalClose") return; closePromoModal(true); });
    const x = $("promoModalClose");
    if (x) x.addEventListener("click", (e) => { e.stopPropagation(); closePromoModal(false); });
  }
}
// Build the location-tagged deep link the QR encodes. Points at the PUBLIC base
// (phones can't reach a tailnet address), carries this kiosk's location so a scan
// attributes to the right store, and optionally the featured shade.
function qrTargetUrl() {
  const q = CONFIG.qr || {};
  let base = (q.baseUrl || "").trim();
  if (!base) base = location.href.split("#")[0].split("?")[0]; // fallback: current page
  const p = new URLSearchParams();
  try {
    const loc = window.Analytics && window.Analytics.currentLocation();
    if (loc && loc.id && loc.id !== "unassigned") {
      p.set("loc", loc.id);
      if (loc.name) p.set("locn", loc.name);
      if (loc.type) p.set("loct", loc.type);
    }
  } catch (e) {}
  p.set("src", "qr");
  const promo = CONFIG.promo || {};
  if (q.includeShade !== false && promo.enabled && promo.shadeId) p.set("shade", promo.shadeId);
  return base + (base.indexOf("?") >= 0 ? "&" : "?") + p.toString();
}
function renderQR() {
  const box = $("qrBox"), img = $("qrImg");
  if (!box || !img) return;
  if (!(FEATURES.qr && window.qrcode)) { box.classList.add("hidden"); return; }
  try {
    const qr = window.qrcode(0, "M");
    qr.addData(qrTargetUrl());
    qr.make();
    img.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 1, scalable: true });
    box.classList.remove("hidden");
    box.style.cursor = "pointer";
    box.setAttribute("role", "button");
    box.setAttribute("tabindex", "0");
    box.setAttribute("aria-label", "Scan or tap to continue on your phone");
    // Tap = hand-off intent, counted once per session on the kiosk (syncs via backend).
    const handoff = () => {
      if (!sessionStorage.getItem("icolorQrHandoff")) {
        sessionStorage.setItem("icolorQrHandoff", "1");
        trk("qrshow");
      }
      box.classList.toggle("qr-zoom");
    };
    box.onclick = handoff;
    box.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handoff(); } };
  } catch (e) { box.classList.add("hidden"); }
}
// If THIS page was opened by scanning a kiosk QR, record the scan once and, when a
// public scan-ping endpoint is configured, report it to the central server (the phone
// isn't on the tailnet, so this is the only way the scan reaches consolidated analytics).
function handleQrLanding() {
  try {
    const A = window.Analytics;
    if (!A || !A.isQrLanding || !A.isQrLanding()) return;
    if (sessionStorage.getItem("icolorQrCounted")) return;
    sessionStorage.setItem("icolorQrCounted", "1");
    trk("qrscan");
    const url = ((CONFIG.qr || {}).scanPingUrl || "").trim();
    if (url) {
      const loc = A.currentLocation();
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loc: loc.id, name: loc.name, type: loc.type, ts: new Date().toISOString() }),
        keepalive: true,
      }).catch(() => {});
    }
  } catch (e) {}
}
// A/B promo test: assign this session to variant A or B (sticky per session) and
// tell analytics, so conversions are tallied per variant.
(function initAbVariant() {
  const p = CONFIG.promo || {};
  if (!(FEATURES.promo && p.enabled && p.ab && p.ab.enabled)) return;
  if (p.rotateSec > 0 && promoSet().length > 1) return; // rotation controls the variant instead
  let v = "A";
  try {
    v = sessionStorage.getItem("icolorVariant");
    if (!v) { v = Math.random() < 0.5 ? "A" : "B"; sessionStorage.setItem("icolorVariant", v); }
  } catch (e) {}
  window._abVariant = v;
  try { window.Analytics && window.Analytics.setVariant(v); } catch (e) {}
})();
renderPromoBanner();
startPromoRotation();
renderQR();
handleQrLanding();
// Promo popup on the start screen (skip if the visitor arrived from a QR scan).
if (FEATURES.promo && (CONFIG.promo || {}).enabled && (CONFIG.promo || {}).popup) {
  let fromQr = false;
  try { fromQr = window.Analytics && window.Analytics.isQrLanding && window.Analytics.isQrLanding(); } catch (e) {}
  if (!fromQr) openPromoModal();
}

// Fleet heartbeat: stamp this device's build + refresh last-seen on every load,
// so Super Admin can spot offline or out-of-date kiosks.
try {
  const A = window.Analytics;
  if (A) {
    const db = A.load();
    const L = A.ensureLoc(db, A.currentLocation());
    L.build = CONFIG.build || "";
    L.lastSeen = new Date().toISOString();
    A.save(db);
  }
} catch (e) {}
// Data-privacy: auto-purge stored leads older than the retention window.
try { window.Analytics && window.Analytics.purgeOldLeads((CONFIG.privacy || {}).retentionDays); } catch (e) {}
// Show the build tag on the start-screen footer.
try {
  const f = document.querySelector(".disclaimer");
  if (f && CONFIG.build) {
    const s = document.createElement("span");
    s.style.cssText = "display:block;opacity:.5;font-size:10px;margin-top:4px";
    s.textContent = "Build " + CONFIG.build;
    f.appendChild(s);
  }
} catch (e) {}

window.addEventListener("pagehide", flushDwell);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    running = false;
    flushDwell();
  } else if (segmenter && (stream || staticMode) && !running) {
    running = true;
    lastVideoTime = -1;
    invalidate();
    renderLoop();
  }
});
