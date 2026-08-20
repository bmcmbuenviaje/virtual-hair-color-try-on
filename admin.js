/* iColor Plus — Admin Console logic */
(function () {
  const $ = (id) => document.getElementById(id);
  const clone = (o) => JSON.parse(JSON.stringify(o));

  const DEFAULT = window.ICOLOR_DEFAULT_CONFIG || { features: {}, shades: [], maxShades: null, admin: {} };
  const STORAGE_KEY = "icolorConfig";

  const FEATURE_LABELS = [
    ["photo", "Take photo"],
    ["video", "Record video (30s)"],
    ["upload", "Upload selfie"],
    ["split", "Before / after split"],
    ["grid", "Compare grid"],
    ["brighten", "Brighten toggle"],
    ["analysis", "Hair & skin analysis"],
    ["statement", "Statement colours"],
    ["vibe", "Vibe filter"],
    ["ratePicks", "Rate your picks"],
    ["cards", "Save / Share cards"],
    ["print", "Print (A5)"],
    ["watermark", "Watermark captures"],
  ];
  const ALL_FEATURES = FEATURE_LABELS.map((f) => f[0]);
  const TONES = ["warm", "cool", "neutral"];

  const PRESETS = {
    basic: {
      label: "Basic",
      maxShades: 5,
      features: { photo: true, video: false, upload: false, split: false, grid: false, brighten: false, analysis: false, statement: false, vibe: false, ratePicks: false, cards: false, print: false, watermark: false },
    },
    standard: {
      label: "Standard",
      maxShades: null,
      features: { photo: true, video: true, upload: true, split: true, grid: true, brighten: true, analysis: false, statement: false, vibe: false, ratePicks: false, cards: true, print: false, watermark: false },
    },
    pro: {
      label: "Pro",
      maxShades: null,
      features: { photo: true, video: true, upload: true, split: true, grid: true, brighten: true, analysis: true, statement: true, vibe: true, ratePicks: true, cards: true, print: false, watermark: false },
    },
    allin: {
      label: "All-in",
      maxShades: null,
      features: { photo: true, video: true, upload: true, split: true, grid: true, brighten: true, analysis: true, statement: true, vibe: true, ratePicks: true, cards: true, print: true, watermark: false },
    },
  };

  // Resolve the config the app is currently using (override or default).
  function resolveCurrent() {
    let over = null;
    try { over = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); } catch (e) {}
    const base = over && Array.isArray(over.shades) ? over : DEFAULT;
    const cfg = clone(base);
    cfg.features = Object.assign({}, DEFAULT.features, cfg.features || {});
    ALL_FEATURES.forEach((k) => { if (typeof cfg.features[k] !== "boolean") cfg.features[k] = true; });
    cfg.admin = cfg.admin || DEFAULT.admin || { username: "admin", password: "icolor" };
    cfg.shades = cfg.shades || [];
    return cfg;
  }

  let cfg = resolveCurrent();
  cfg.promo = Object.assign({ enabled: false, shadeId: "", title: "Shade of the Week", message: "", image: "", popup: false, popupText: "Tap the screen, and try-on our iColor products!" }, cfg.promo || {});
  cfg.coupon = Object.assign({ enabled: false, code: "", label: "In-store offer", terms: "", campaign: "", unique: true, source: "generated" }, cfg.coupon || {});
  cfg.printLayout = Object.assign({ title: "Personalized Hair Colour Analysis", accentFrom: "#5f7d2e", accentTo: "#b8942f", footer: "", showBrighten: true, showMatches: true }, cfg.printLayout || {});
  cfg.commerce = Object.assign({ currency: "₱", buttonLabel: "Add to Cart", showQr: true, checkout: "product" }, cfg.commerce || {});

  function renderContentEditors() {
    if ($("promoEnabled")) {
      $("promoEnabled").checked = !!cfg.promo.enabled;
      const shades = (cfg.shades || []).filter((s) => s.hex);
      $("promoShade").innerHTML = `<option value="">— none —</option>` + shades.map((s) => `<option value="${s.id}" ${cfg.promo.shadeId === s.id ? "selected" : ""}>${s.name}</option>`).join("");
      $("promoTitle").value = cfg.promo.title || "";
      $("promoMsg").value = cfg.promo.message || "";
      const pv = $("promoPrev");
      if (cfg.promo.image) { pv.src = cfg.promo.image; pv.style.display = ""; } else pv.style.display = "none";
      if ($("promoPopup")) $("promoPopup").checked = !!cfg.promo.popup;
      if ($("promoPopupText")) $("promoPopupText").value = cfg.promo.popupText || "";
    }
    if ($("couponEnabled")) {
      $("couponEnabled").checked = !!cfg.coupon.enabled;
      $("couponCode").value = cfg.coupon.code || "";
      $("couponLabel").value = cfg.coupon.label || "";
      $("couponTerms").value = cfg.coupon.terms || "";
      if ($("couponCampaign")) $("couponCampaign").value = cfg.coupon.campaign || "";
      if ($("couponUnique")) $("couponUnique").checked = cfg.coupon.unique !== false;
      if ($("couponSource")) $("couponSource").value = cfg.coupon.source || "generated";
    }
    if ($("plTitle")) {
      $("plTitle").value = cfg.printLayout.title || "";
      $("plFrom").value = cfg.printLayout.accentFrom || "#5f7d2e";
      $("plTo").value = cfg.printLayout.accentTo || "#b8942f";
      $("plFooter").value = cfg.printLayout.footer || "";
      $("plBrighten").checked = cfg.printLayout.showBrighten !== false;
      $("plMatches").checked = cfg.printLayout.showMatches !== false;
    }
  }
  function wireContentEditors() {
    const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
    on("promoEnabled", "change", (e) => (cfg.promo.enabled = e.target.checked));
    on("promoShade", "change", (e) => (cfg.promo.shadeId = e.target.value));
    on("promoTitle", "input", (e) => (cfg.promo.title = e.target.value));
    on("promoMsg", "input", (e) => (cfg.promo.message = e.target.value));
    on("promoPopup", "change", (e) => (cfg.promo.popup = e.target.checked));
    on("promoPopupText", "input", (e) => (cfg.promo.popupText = e.target.value));
    on("promoUpload", "click", () => $("promoFile").click());
    on("promoFile", "change", (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ""; if (!f) return; const rd = new FileReader(); rd.onload = () => { cfg.promo.image = rd.result; renderContentEditors(); }; rd.readAsDataURL(f); });
    on("promoClear", "click", () => { cfg.promo.image = ""; renderContentEditors(); });
    on("couponEnabled", "change", (e) => (cfg.coupon.enabled = e.target.checked));
    on("couponCode", "input", (e) => (cfg.coupon.code = e.target.value));
    on("couponLabel", "input", (e) => (cfg.coupon.label = e.target.value));
    on("couponTerms", "input", (e) => (cfg.coupon.terms = e.target.value));
    on("couponCampaign", "input", (e) => (cfg.coupon.campaign = e.target.value));
    on("couponUnique", "change", (e) => (cfg.coupon.unique = e.target.checked));
    on("couponSource", "change", (e) => (cfg.coupon.source = e.target.value));
    on("plTitle", "input", (e) => (cfg.printLayout.title = e.target.value));
    on("plFrom", "input", (e) => (cfg.printLayout.accentFrom = e.target.value));
    on("plTo", "input", (e) => (cfg.printLayout.accentTo = e.target.value));
    on("plFooter", "input", (e) => (cfg.printLayout.footer = e.target.value));
    on("plBrighten", "change", (e) => (cfg.printLayout.showBrighten = e.target.checked));
    on("plMatches", "change", (e) => (cfg.printLayout.showMatches = e.target.checked));
  }
  wireContentEditors();

  /* -------- passcode gate (salted SHA-256; no plaintext creds shipped) -------- */
  async function sha256Hex(s) {
    const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
  }
  async function checkCred(c, user, pass) {
    if (!c || user !== (c.username || "admin")) return false;
    if (c.passHash && c.salt) return (await sha256Hex(c.salt + pass)) === c.passHash;
    const pw = c.password || c.passcode; // back-compat with older plaintext configs
    return pw != null && pass === pw;
  }
  async function tryUnlock() {
    const user = ($("gateUser").value || "").trim();
    const pass = $("gatePass").value || "";
    if (await checkCred(cfg.admin || {}, user, pass)) {
      sessionStorage.setItem("icolorAdminOk", "1");
      $("gate").style.display = "none";
      $("app").style.display = "";
      render();
    } else {
      $("gateErr").textContent = "Incorrect username or password.";
    }
  }
  $("gateBtn").addEventListener("click", tryUnlock);
  $("gateUser").addEventListener("keydown", (e) => { if (e.key === "Enter") tryUnlock(); });
  $("gatePass").addEventListener("keydown", (e) => { if (e.key === "Enter") tryUnlock(); });
  if (sessionStorage.getItem("icolorAdminOk") === "1") {
    $("gate").style.display = "none";
    $("app").style.display = "";
  }

  /* -------- rendering -------- */
  function activePreset() {
    for (const key in PRESETS) {
      const p = PRESETS[key];
      const sameFeat = ALL_FEATURES.every((k) => !!cfg.features[k] === !!p.features[k]);
      const sameMax = (cfg.maxShades || null) === (p.maxShades || null);
      if (sameFeat && sameMax) return key;
    }
    return "custom";
  }

  function renderPresets() {
    const wrap = $("presets");
    if (!wrap) return; // tier presets moved to Super Admin
    const cur = activePreset();
    wrap.innerHTML =
      Object.keys(PRESETS)
        .map((k) => `<button class="btn ${cur === k ? "on" : ""}" data-preset="${k}">${PRESETS[k].label}</button>`)
        .join("") + `<button class="btn ${cur === "custom" ? "on" : ""}" data-preset="custom" disabled style="opacity:.7">Custom</button>`;
    wrap.querySelectorAll("[data-preset]").forEach((b) => {
      if (b.dataset.preset === "custom") return;
      b.addEventListener("click", () => {
        const p = PRESETS[b.dataset.preset];
        cfg.features = clone(p.features);
        cfg.maxShades = p.maxShades;
        cfg.tier = p.label;
        render();
      });
    });
  }

  function renderFeatures() {
    if (!$("features")) return; // feature switches moved to Super Admin
    $("features").innerHTML = FEATURE_LABELS
      .map(([k, label]) => `<label class="feat"><input type="checkbox" data-feat="${k}" ${cfg.features[k] ? "checked" : ""}/> ${label}</label>`)
      .join("");
    $("features").querySelectorAll("[data-feat]").forEach((c) => {
      c.addEventListener("change", () => {
        cfg.features[c.dataset.feat] = c.checked;
        renderPresets();
        $("tierName").value = cfg.tier = (activePreset() === "custom" ? "Custom" : PRESETS[activePreset()].label);
      });
    });
  }

  function renderShades() {
    const tb = $("shadeRows");
    tb.innerHTML = cfg.shades
      .map((s, i) => `
        <tr data-i="${i}">
          <td style="white-space:nowrap">
            <button class="btn sm ghost" data-move="up" ${i === 0 ? "disabled" : ""}>▲</button>
            <button class="btn sm ghost" data-move="down" ${i === cfg.shades.length - 1 ? "disabled" : ""}>▼</button>
          </td>
          <td><input type="color" data-f="hex" value="${s.hex || "#000000"}" /></td>
          <td><input type="text" data-f="name" value="${(s.name || "").replace(/"/g, "&quot;")}" /></td>
          <td><input type="text" data-f="collection" value="${(s.collection || "").replace(/"/g, "&quot;")}" /></td>
          <td><select data-f="tone">${TONES.map((t) => `<option ${s.tone === t ? "selected" : ""}>${t}</option>`).join("")}</select></td>
          <td style="text-align:center"><input type="checkbox" data-f="statement" ${s.statement ? "checked" : ""} /></td>
          <td style="text-align:center"><input type="checkbox" data-f="hidden" ${s.hidden ? "checked" : ""} /></td>
          <td><button class="btn sm danger" data-del="1">✕</button></td>
        </tr>`)
      .join("");

    tb.querySelectorAll("tr").forEach((tr) => {
      const i = +tr.dataset.i;
      tr.querySelectorAll("[data-f]").forEach((inp) => {
        inp.addEventListener("input", () => {
          const f = inp.dataset.f;
          cfg.shades[i][f] = inp.type === "checkbox" ? inp.checked : inp.value;
          renderPreview();
        });
      });
      tr.querySelector("[data-del]").addEventListener("click", () => { cfg.shades.splice(i, 1); render(); });
      tr.querySelectorAll("[data-move]").forEach((b) => {
        b.addEventListener("click", () => {
          const dir = b.dataset.move === "up" ? -1 : 1;
          const j = i + dir;
          if (j < 0 || j >= cfg.shades.length) return;
          const tmp = cfg.shades[i];
          cfg.shades[i] = cfg.shades[j];
          cfg.shades[j] = tmp;
          render();
        });
      });
    });
  }

  function renderPreview() {
    const cap = cfg.maxShades ? +cfg.maxShades : Infinity;
    const shown = cfg.shades.filter((s) => s.hex && !s.hidden).slice(0, cap);
    $("preview").innerHTML =
      `<div class="pv"><span class="chip" style="background:repeating-conic-gradient(#3a3350 0 25%,#2a2440 0 50%) 50%/12px 12px"></span><span class="nm">Off</span></div>` +
      shown.map((s) => `<div class="pv"><span class="chip" style="background:${s.hex}"></span><span class="nm">${s.name}</span></div>`).join("");
    $("json").value = buildExport();
  }

  function slugify(name) {
    return (name || "shade").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "shade-" + Date.now();
  }

  function applyClientPerms() {
    const ca = Object.assign(
      { showTier: true, showFeatures: true, showShades: true, showExport: true, showAnalytics: true, readOnly: false },
      cfg.clientAdmin || {}
    );
    const hide = (id, show) => { const el = $(id); if (el) el.style.display = show ? "" : "none"; };
    hide("card-tier", ca.showTier);
    hide("card-features", ca.showFeatures);
    hide("card-shades", ca.showShades);
    hide("card-export", ca.showExport);
    const F = cfg.features || {};
    hide("card-promo", !!F.promo);
    hide("card-coupon", !!F.coupon);
    hide("card-print", !!F.print);
    hide("card-commerce", !!F.commerce);
    const al = $("analyticsLink"); if (al) al.style.display = ca.showAnalytics ? "" : "none";
    const sb = $("save"); const rb = $("reset");
    if (ca.readOnly) {
      if (sb) { sb.disabled = true; sb.textContent = "View only (locked by Super Admin)"; sb.style.opacity = 0.6; }
      if (rb) { rb.disabled = true; rb.style.opacity = 0.6; }
    } else if (sb) { sb.disabled = false; sb.textContent = "Save to this device"; sb.style.opacity = 1; if (rb) { rb.disabled = false; rb.style.opacity = 1; } }
  }

  // Make each feature card collapsible; header toggles it. Closed by default on load.
  function setupCollapsibles() {
    document.querySelectorAll("#app .a-card").forEach((card) => {
      const h = card.querySelector(":scope > h2");
      if (!h || card.dataset.collapsibleReady) return;
      card.dataset.collapsibleReady = "1";
      const body = document.createElement("div");
      body.className = "a-body";
      let n = h.nextSibling;
      while (n) { const nx = n.nextSibling; body.appendChild(n); n = nx; }
      card.appendChild(body);
      card.classList.add("collapsible", "collapsed"); // closed by default every load
      h.setAttribute("role", "button");
      h.setAttribute("tabindex", "0");
      h.setAttribute("aria-expanded", "false");
      const toggle = () => {
        const collapsed = card.classList.toggle("collapsed");
        h.setAttribute("aria-expanded", collapsed ? "false" : "true");
      };
      h.addEventListener("click", toggle);
      h.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    });
  }

  function render() {
    if ($("tierName")) $("tierName").value = cfg.tier || "";
    if ($("maxShades")) $("maxShades").value = cfg.maxShades || "";
    renderPresets();
    renderFeatures();
    renderShades();
    renderPreview();
    renderContentEditors();
    if (window.CommerceEditor) window.CommerceEditor.mount(cfg, $("commerceRows"), { toast: toast });
    applyClientPerms();
    setupCollapsibles();
  }

  /* -------- export / import / save -------- */
  function normalize() {
    // ensure ids unique + present
    const seen = {};
    cfg.shades.forEach((s) => {
      if (!s.id) s.id = slugify(s.name);
      while (seen[s.id]) s.id += "-x";
      seen[s.id] = 1;
      s.statement = !!s.statement;
      s.hidden = !!s.hidden;
      if (!TONES.includes(s.tone)) s.tone = "neutral";
    });
    cfg.maxShades = cfg.maxShades ? +cfg.maxShades : null;
    cfg.tier = (($("tierName") && $("tierName").value) || cfg.tier || "").trim();
  }

  function buildExport() {
    normalize();
    return "window.ICOLOR_DEFAULT_CONFIG = " + JSON.stringify(cfg, null, 2) + ";\n";
  }

  function toast(msg) {
    const t = $("toastA");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), 2000);
  }

  if ($("tierName")) $("tierName").addEventListener("input", () => { cfg.tier = $("tierName").value; renderPreview(); });
  if ($("maxShades")) $("maxShades").addEventListener("input", () => { cfg.maxShades = $("maxShades").value ? +$("maxShades").value : null; renderPreview(); });

  $("addShade").addEventListener("click", () => {
    cfg.shades.push({ id: "new-" + (cfg.shades.length + 1), name: "New Colour", hex: "#7a4a2a", collection: "Custom", tone: "warm", statement: false, hidden: false });
    render();
  });

  $("save").addEventListener("click", () => {
    normalize();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
      toast("Saved — the app on this device now uses this config.");
    } catch (e) { toast("Save failed: " + e.message); }
  });

  $("reset").addEventListener("click", () => {
    if (!confirm("Reset to the shipped default config? This clears the saved override on this device.")) return;
    localStorage.removeItem(STORAGE_KEY);
    cfg = clone(DEFAULT);
    cfg.features = Object.assign({}, DEFAULT.features);
    render();
    toast("Reset to default.");
  });

  $("download").addEventListener("click", () => {
    const blob = new Blob([buildExport()], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "config.default.js";
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast("Downloaded config.default.js — commit it to ship this build.");
  });

  $("copyJson").addEventListener("click", async () => {
    normalize();
    const text = JSON.stringify(cfg, null, 2);
    try { await navigator.clipboard.writeText(text); toast("Config JSON copied."); }
    catch (e) { $("json").value = text; toast("Copied to the box below."); }
  });

  $("importJson").addEventListener("click", () => {
    let raw = $("json").value.trim();
    // allow pasting the exported "window.ICOLOR_DEFAULT_CONFIG = {...};"
    const m = raw.match(/=\s*(\{[\s\S]*\})\s*;?\s*$/);
    if (m) raw = m[1];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.shades)) throw new Error("missing shades[]");
      cfg = parsed;
      cfg.features = Object.assign({}, DEFAULT.features, cfg.features || {});
      cfg.admin = cfg.admin || DEFAULT.admin;
      render();
      toast("Imported. Review, then Save or Download.");
    } catch (e) { toast("Import failed: " + e.message); }
  });

  // initial paint if already unlocked
  if ($("app").style.display !== "none") render();
})();
