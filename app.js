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
const MASK_CUTOFF = 0.15; // ignore pixels below this hair confidence

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

/* ---- i18n (Tagalog / English) ---- */
const I18N = {
  en: {
    tagline: "Live Hair-Colour Try-On", startCamera: "Start Camera", upload: "Upload a selfie",
    getlook: "Match a shade from a photo", lookTitle: "Match a shade",
    fineprint: "Camera works best in good lighting (needs HTTPS). Uploading analyzes your real hair colour and previews how each shade would mix with it.",
    lead: "See iColor Plus shades on your own hair in real time. Pick a colour, then capture a photo or a 30-second video — everything is saved straight to your device. Nothing is uploaded.",
    theLook: "The look", detectedColour: "Detected hair colour", closest: "Closest iColor Plus", topMatches: "Top matches", bestMatch: "Best match", tryIt: "Try it",
    pickImage: "Please choose an image file", analyzingLook: "Analyzing the look…", noHairLook: "Couldn't read hair in that photo — try a clearer one", lookFailed: "Couldn't analyze that photo",
    langName: "EN",
  },
  tl: {
    tagline: "Live na Hair-Colour Try-On", startCamera: "Simulan ang Camera", upload: "Mag-upload ng selfie",
    getlook: "Tumugma ng kulay mula sa larawan", lookTitle: "Tumugma ng kulay",
    fineprint: "Pinakamaganda ang camera sa maliwanag na ilaw (kailangan ng HTTPS). Ina-analyze ng upload ang totoong kulay ng buhok at ipinapakita kung paano ito hahaluan ng bawat shade.",
    lead: "Tingnan ang mga iColor Plus shade sa sarili mong buhok nang live. Pumili ng kulay, tapos kumuha ng larawan o 30-segundong video — direktang naka-save sa iyong device. Walang ina-upload.",
    theLook: "Ang hitsura", detectedColour: "Natukoy na kulay ng buhok", closest: "Pinakamalapit na iColor Plus", topMatches: "Nangungunang tugma", bestMatch: "Pinakamatugma", tryIt: "Subukan",
    pickImage: "Pumili ng larawan", analyzingLook: "Ina-analyze ang hitsura…", noHairLook: "Hindi mabasa ang buhok sa larawan — subukan ang mas malinaw", lookFailed: "Hindi ma-analyze ang larawan",
    langName: "TL",
  },
};
let LANG = "en";
try { LANG = localStorage.getItem("icolorLang") || (CONFIG.lang && CONFIG.lang.default) || "en"; } catch (e) {}
if (!I18N[LANG]) LANG = "en";
function t(k) { return (I18N[LANG] && I18N[LANG][k]) || I18N.en[k] || k; }
function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => { const s = t(el.getAttribute("data-i18n")); if (s) el.textContent = s; });
}
function setLang(code) {
  LANG = I18N[code] ? code : "en";
  try { localStorage.setItem("icolorLang", LANG); } catch (e) {}
  applyI18n();
  const lb = document.getElementById("langBtn");
  if (lb) lb.textContent = I18N[LANG].langName;
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
let strength = 0.85;

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
  for (let v = 0; v < 256; v++) {
    const base = boost ? v + (255 - v) * BOOST_LIFT : v;
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
}

// Run segmentation on a source (video/canvas) and store a private copy of the
// hair mask. The copy matters: closing the result can free the underlying buffer.
function segmentSource(src) {
  const result = segmenter.segmentForVideo(src, performance.now());
  const masks = result && result.confidenceMasks;
  if (masks && masks.length) {
    const hair = masks[masks.length > 1 ? 1 : 0];
    maskData = new Float32Array(hair.getAsFloat32Array());
    maskW = hair.width;
    maskH = hair.height;
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
    mapX = buildMap(pw, maskW);
    mapY = buildMap(ph, maskH);
    Object.assign(mapKey, { pw, ph, mw: maskW, mh: maskH });
  }
  const frame = pctx.getImageData(0, 0, pw, ph);
  const d = frame.data;
  const s = strength;
  const R = sel.r, G = sel.g, B = sel.b;
  for (let y = 0; y < ph; y++) {
    const rowMask = mapY[y] * maskW;
    const rowPix = y * pw;
    for (let x = 0; x < pw; x++) {
      const m = maskData[rowMask + mapX[x]];
      if (m < MASK_CUTOFF) continue;
      const a = m * s;
      const i = (rowPix + x) << 2;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const lum = (r * 77 + g * 150 + b * 29) >> 8;
      const shine = lum > SHINE_T ? (lum - SHINE_T) * SHINE_K : 0;
      d[i] = r + (R[r] + shine - r) * a;
      d[i + 1] = g + (G[g] + shine - g) * a;
      d[i + 2] = b + (B[b] + shine - b) * a;
    }
  }
  pctx.putImageData(frame, 0, 0);
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
    gMapX = buildMap(cw, maskW);
    gMapY = buildMap(ch, maskH);
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
  for (let y = 0; y < h; y++) {
    const rowMask = mapy[y] * maskW;
    const rowPix = y * w;
    for (let x = 0; x < w; x++) {
      const mx = mirror ? maskW - 1 - mapx[x] : mapx[x];
      const m = maskData[rowMask + mx];
      if (m < MASK_CUTOFF) continue;
      const a = m * s;
      const i = (rowPix + x) << 2;
      const r = work[i], g = work[i + 1], b = work[i + 2];
      const lum = (r * 77 + g * 150 + b * 29) >> 8;
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
  const mapx = buildMap(cellW, maskW);
  const mapy = buildMap(imgH, maskH);
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
    "Digital preview — actual results may vary. Intensity " +
      Math.round(strength * 100) +
      "%.",
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

  const leadsSec = FEATURES.leads ? `
    <section class="an-leads">
      <h3>Get your results &amp; offers</h3>
      <p class="an-lead">Leave your email to receive your iColor Plus card and offers.</p>
      <div class="lead-form">
        <input id="leadEmail" type="email" placeholder="Email address" />
        <input id="leadMobile" type="tel" placeholder="Mobile (optional)" />
        <label class="lead-consent"><input id="leadConsent" type="checkbox" /> <span>${((CONFIG.leads || {}).consentText) || "I agree to receive updates and offers."}</span></label>
        <button id="leadSubmit" class="an-try" style="align-self:flex-start">Sign me up</button>
        <div id="leadMsg" class="lead-msg"></div>
      </div>
    </section>` : "";

  analysisBody.innerHTML =
    fmt + detected + recs + statement + picks + brighten + leadsSec + apply + care +
    `<p class="an-disc">This is a digital estimate from your photo and its lighting — not a professional diagnosis. Colours preview how each shade mixes with your real hair. Bleaching/lightening stresses hair — do it gradually, ideally with a professional, and always patch-test.</p>`;

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
    const mapx = buildMap(w, maskW), mapy = buildMap(h, maskH);
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
async function buildReportCard(a, format) {
  if (format === "square") return buildSquareCard(a);
  if (format === "portrait") return buildPortraitCard(a);
  return buildLandscapeCard(a);
}

// Build a high-resolution A5-landscape analysis card (print-friendly + shareable).
async function buildLandscapeCard(a) {
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
  const photo = previewCanvas(sel, 520);
  const px = 60, py = 195, pw = 340, ph = 420;
  c.save();
  roundRect(c, px, py, pw, ph, 18);
  c.clip();
  drawCover(c, photo, px, py, pw, ph);
  c.restore();
  c.strokeStyle = "#e3e3e3";
  c.lineWidth = 2;
  roundRect(c, px, py, pw, ph, 18);
  c.stroke();

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

  // Brighten panel (right of hero)
  if (PL.showBrighten !== false) {
    const gx = 980, gy = 195, gw = W - gx - 60, gh = 420;
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
  c.fillStyle = "#5f7d2e";
  c.font = "700 18px " + sans;
  c.fillText("GO BRIGHTER", bx, by + 24);
  c.fillStyle = "#444";
  c.font = "400 17px " + sans;
  wrapText(c, a.brightening.headline, bx, by + 50, W - bx - 32, 24, 3);

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

  // Brighten panel (full width)
  const gy = 675, gh = 185;
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
      const url = URL.createObjectURL(blob);
      addCapture({ type: "photo", url, blob, name });
      triggerDownload(url, name);
      showToast("Sharing not supported here — saved the image instead");
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

async function printReportCard() {
  const a = lastAnalysis || analyzeCurrent();
  if (!a) { showToast("Analyze your hair first"); return; }
  const cv = await buildReportCard(a);
  printReport.innerHTML = `<img class="card" src="${cv.toDataURL("image/jpeg", 0.92)}" alt="iColor Plus hair analysis" />`;
  const img = printReport.querySelector("img");
  await (img.complete ? Promise.resolve() : new Promise((r) => { img.onload = img.onerror = r; }));
  window.print();
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
    btn.addEventListener("click", () => selectShade(shade));
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
  if (shade.hex) trk("tryon", { sku: shade.id }); // count try-ons per SKU
  renderShopCard(shade);
}

/* ---- "Shop the look" in-camera product card (paid feature) ---- */
function renderShopCard(shade) {
  const card = $("shopCard");
  if (!card) return;
  const on = FEATURES.commerce && shade && shade.hex && shade.buyUrl;
  if (!on || gridMode) { card.classList.add("hidden"); return; }
  const cm = CONFIG.commerce || {};
  const img = $("shopImg"), buy = $("shopBuy"), qr = $("shopQr");
  if (shade.buyImg) { img.src = shade.buyImg; img.style.display = ""; } else img.style.display = "none";
  $("shopName").textContent = shade.name;
  $("shopPrice").textContent = shade.buyPrice ? (cm.currency || "") + shade.buyPrice : "";
  buy.textContent = cm.buttonLabel || "Add to Cart";
  buy.href = shade.buyUrl;
  buy.onclick = () => { try { trk("shopclick", { sku: shade.id }); } catch (e) {} };
  // QR to buy on the customer's own phone
  if (qr) {
    if (cm.showQr !== false && window.qrcode) {
      try {
        const q = window.qrcode(0, "M"); q.addData(shade.buyUrl); q.make();
        qr.innerHTML = q.createSvgTag({ cellSize: 3, margin: 0, scalable: true });
        qr.style.display = "";
      } catch (e) { qr.style.display = "none"; }
    } else qr.style.display = "none";
  }
  card.classList.remove("hidden");
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
  strength = intensity.value / 100;
  intensityVal.textContent = intensity.value + "%";
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
   Wiring
   ============================================================ */
photoBtn.addEventListener("click", takePhoto);
galleryBtn.addEventListener("click", openGallery);
$("closeGallery").addEventListener("click", () =>
  galleryModal.classList.add("hidden")
);
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
  intensity.value = 85;
  strength = 0.85;
  intensityVal.textContent = "85%";
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
{ const lb = $("langBtn"); if (lb) lb.addEventListener("click", () => setLang(LANG === "en" ? "tl" : "en")); }

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
    trk("sessions");
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
    if (attractOverlay) attractOverlay.classList.remove("hidden");
  } catch (e) { attractActive = false; } // no camera → stay on the start screen
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
  if (!FEATURES.grid) { hideEl(gridBtn); hideEl(sheetBtn); }
  if (!FEATURES.brighten) hideEl(boostBtn);
  if (!FEATURES.analysis) hideEl(analysisBtn);
  if (!FEATURES.photo && !FEATURES.video) hideEl(galleryBtn);
  if (!FEATURES.cards) { hideEl($("shareBtn")); hideEl($("saveImgBtn")); }
  if (!FEATURES.print) hideEl($("printBtn"));
  if (FEATURES.getlook) lookBtn.classList.remove("hidden"); else hideEl(lookBtn);
  const lb = $("langBtn");
  if (lb) { if (FEATURES.multilang) lb.classList.remove("hidden"); else hideEl(lb); }
}
applyFeatureGating();
applyI18n();
setLang(LANG);

// Offline PWA — cache the app + model so kiosks survive wifi drops.
if (FEATURES.offline && "serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").catch(() => {}); });
}

// Live backend (optional): mirror this location to the cloud + pull fleet config.
if (window.Backend && window.Backend.enabled()) {
  window.Backend.init().then((ok) => {
    if (!ok) return;
    const flush = () => { try { window.Backend.flushLeadOutbox && window.Backend.flushLeadOutbox(); } catch (e) {} };
    setInterval(() => { window.Backend.upsertLocation(); flush(); }, 30000);
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

/* ---- Promo banner + QR handoff (start screen) ---- */
let pendingPromoShade = null;
function renderPromoBanner() {
  const box = $("promoBanner");
  if (!box) return;
  const p = CONFIG.promo || {};
  if (!(FEATURES.promo && p.enabled)) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  if (p.image) {
    box.innerHTML = `<img src="${p.image}" alt="Promo" />`;
  } else {
    const shade = SHADES.find((s) => s.id === p.shadeId);
    box.innerHTML =
      `<div class="promo-card">` +
      (shade ? `<span class="p-dot" style="background:${shade.hex}"></span>` : "") +
      `<div><div class="p-tag">${p.title || "Featured"}</div>` +
      (shade ? `<div class="p-title">${shade.name}</div>` : "") +
      `<div class="p-msg">${p.message || ""}</div></div></div>`;
  }
  box.style.cursor = "pointer";
  box.onclick = () => { if (p.shadeId) pendingPromoShade = p.shadeId; startBtn.click(); };
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
renderPromoBanner();
renderQR();
handleQrLanding();

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
