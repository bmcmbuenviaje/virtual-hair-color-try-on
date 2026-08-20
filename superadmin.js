/* iColor Plus — Super Admin: client-view controls + consolidated analytics */
(function () {
  const $ = (id) => document.getElementById(id);
  const A = window.Analytics, D = window.Dash;
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // Fleet health: online = the kiosk is currently CONNECTED and syncing to this
  // server. Connected kiosks push a heartbeat every 30s (over Tailscale), so a
  // sync within a few cycles means it's live — a powered-on but quiet kiosk never
  // wrongly shows offline (no activity-based timeout). Offline = stopped syncing.
  const ONLINE_WINDOW_MS = 3 * 60 * 1000; // ~6 missed 30s heartbeats
  function lastContact(r) { return (r && (r.lastSync || r.lastSeen)) || null; }
  function isOnline(r) {
    const t = lastContact(r);
    return !!t && (Date.now() - new Date(t).getTime()) < ONLINE_WINDOW_MS;
  }
  function onlinePill(r) {
    return isOnline(r)
      ? '<span class="status-pill status-on">● Online</span>'
      : '<span class="status-pill status-off">● Offline</span>';
  }

  const PERMS = [
    ["showShades", "Colour manager"],
    ["showExport", "Export / import build"],
    ["showAnalytics", "Usage analytics link"],
    ["readOnly", "View-only (client can't save)"],
  ];

  const FEATURE_LABELS = [
    ["photo", "Take photo"], ["video", "Record video (30s)"], ["upload", "Upload selfie"],
    ["split", "Before/after split"], ["grid", "Compare grid"], ["brighten", "Brighten toggle"],
    ["analysis", "Hair & skin analysis"], ["statement", "Statement colours"], ["vibe", "Vibe filter"],
    ["ratePicks", "Rate your picks"], ["cards", "Save/Share cards"], ["print", "Print (A5)"],
    ["watermark", "Watermark captures"], ["qr", "QR to phone"], ["promo", "Promo banner"],
    ["coupon", "Coupon on report"], ["leads", "Lead capture"], ["heatmap", "Time-of-day / heatmap"],
    ["getlook", "Get this look"], ["multilang", "Tagalog / English"], ["offline", "Offline mode"],
    ["attract", "Attract / idle mirror"], ["commerce", "Shop the look (ecommerce) — paid"],
    ["camguide", "Camera fit guidance"],
  ];
  const ALLF = FEATURE_LABELS.map((f) => f[0]);
  const PRESETS = {
    basic: { label: "Basic", maxShades: 5, on: ["photo", "qr", "offline"] },
    standard: { label: "Standard", maxShades: null, on: ["photo", "video", "upload", "split", "grid", "brighten", "cards", "qr", "promo", "multilang", "offline"] },
    pro: { label: "Pro", maxShades: null, on: ["photo", "video", "upload", "split", "grid", "brighten", "analysis", "statement", "vibe", "ratePicks", "cards", "qr", "promo", "getlook", "heatmap", "multilang", "offline"] },
    allin: { label: "All-in", maxShades: null, on: ALLF.filter((k) => k !== "watermark" && k !== "attract" && k !== "commerce") },
  };

  function resolved() { return A.resolvedConfig(); }
  // working config = localStorage override if present, else default (deep clone)
  function loadCfg() {
    let over = null;
    try { over = JSON.parse(localStorage.getItem("icolorConfig") || "null"); } catch (e) {}
    const base = over && Array.isArray(over.shades) ? over : (window.ICOLOR_DEFAULT_CONFIG || {});
    const cfg = clone(base);
    cfg.clientAdmin = Object.assign(
      { showShades: true, showExport: true, showAnalytics: true, readOnly: false },
      cfg.clientAdmin || {}
    );
    cfg.features = cfg.features || {};
    ALLF.forEach((k) => { if (typeof cfg.features[k] !== "boolean") cfg.features[k] = false; });
    cfg.promo = Object.assign({ enabled: false, shadeId: "", title: "Shade of the Week", message: "", image: "" }, cfg.promo || {});
    cfg.promo.ab = Object.assign({ enabled: false, title: "", message: "", shadeId: "" }, cfg.promo.ab || {});
    cfg.coupon = Object.assign({ enabled: false, code: "", label: "In-store offer", terms: "", campaign: "", unique: true, source: "generated" }, cfg.coupon || {});
    cfg.printLayout = Object.assign({ title: "Personalized Hair Colour Analysis", accentFrom: "#5f7d2e", accentTo: "#b8942f", footer: "", showBrighten: true, showMatches: true }, cfg.printLayout || {});
    cfg.attract = Object.assign({ idleMs: 45000, shadeId: "", cta: "Tap to try your color" }, cfg.attract || {});
    cfg.qr = Object.assign({ baseUrl: "", scanPingUrl: "", includeShade: true }, cfg.qr || {});
    cfg.commerce = Object.assign({ currency: "₱", buttonLabel: "Add to Cart", showQr: true, checkout: "product" }, cfg.commerce || {});
    cfg.privacy = Object.assign({ policyUrl: "", noticeText: "", retentionDays: 365 }, cfg.privacy || {});
    cfg.backend = Object.assign({ provider: "none", url: "" }, cfg.backend || {});
    return cfg;
  }
  let cfg = loadCfg();

  function toast(m) { const t = $("toastA"); t.textContent = m; t.style.opacity = 1; clearTimeout(toast._t); toast._t = setTimeout(() => (t.style.opacity = 0), 1900); }
  function download(obj, name, type) {
    const blob = new Blob([type === "js" ? obj : JSON.stringify(obj, null, 2)], { type: type === "js" ? "text/javascript" : "application/json" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  }

  /* ---- gate ---- */
  async function sha256Hex(s) {
    const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
  }
  async function checkCred(c, u, p) {
    if (!c || !c.username || u !== c.username) return false;
    if (c.passHash && c.salt) return (await sha256Hex(c.salt + p)) === c.passHash;
    return c.password != null && p === c.password; // back-compat with older plaintext configs
  }
  async function unlock() {
    // Accept the baked default creds OR a saved override — a stale override must
    // never lock out the real (config.default.js) super-admin login. Salted hashes,
    // so this page ships no plaintext password.
    const def = (window.ICOLOR_DEFAULT_CONFIG && window.ICOLOR_DEFAULT_CONFIG.superAdmin) || {};
    const over = (resolved().superAdmin || {});
    const u = ($("gu").value || "").trim(), p = $("gp").value || "";
    if ((await checkCred(def, u, p)) || (await checkCred(over, u, p))) {
      sessionStorage.setItem("icolorSuperOk", "1");
      $("gate").style.display = "none"; $("app").style.display = ""; boot();
    } else $("ge").textContent = "Incorrect credentials.";
  }
  $("gb").addEventListener("click", unlock);
  $("gp").addEventListener("keydown", (e) => { if (e.key === "Enter") unlock(); });
  if (sessionStorage.getItem("icolorSuperOk") === "1") { $("gate").style.display = "none"; $("app").style.display = ""; }

  /* ---- client-view perms ---- */
  function renderPerms() {
    $("perms").innerHTML = PERMS.map(([k, label]) =>
      `<label class="perm"><input type="checkbox" data-perm="${k}" ${cfg.clientAdmin[k] ? "checked" : ""}/> ${label}</label>`
    ).join("");
    $("perms").querySelectorAll("[data-perm]").forEach((c) =>
      c.addEventListener("change", () => { cfg.clientAdmin[c.dataset.perm] = c.checked; })
    );
  }

  /* ---- package tier + features + promo + coupon ---- */
  function activePreset() {
    for (const k in PRESETS) {
      const on = new Set(PRESETS[k].on);
      const match = ALLF.every((f) => !!cfg.features[f] === on.has(f)) && (cfg.maxShades || null) === (PRESETS[k].maxShades || null);
      if (match) return k;
    }
    return "custom";
  }
  function renderPresets() {
    const cur = activePreset();
    $("presets").innerHTML =
      Object.keys(PRESETS).map((k) => `<button class="btn ${cur === k ? "on" : ""}" data-preset="${k}">${PRESETS[k].label}</button>`).join("") +
      `<button class="btn ${cur === "custom" ? "on" : ""}" disabled style="opacity:.7">Custom</button>`;
    $("presets").querySelectorAll("[data-preset]").forEach((b) =>
      b.addEventListener("click", () => {
        const p = PRESETS[b.dataset.preset]; const on = new Set(p.on);
        ALLF.forEach((f) => (cfg.features[f] = on.has(f)));
        cfg.maxShades = p.maxShades; cfg.tier = p.label;
        renderPresets(); renderFeatures(); if ($("tierName")) $("tierName").value = cfg.tier;
      })
    );
  }
  function renderFeatures() {
    $("features").innerHTML = FEATURE_LABELS.map(([k, l]) => `<label class="feat"><input type="checkbox" data-feat="${k}" ${cfg.features[k] ? "checked" : ""}/> ${l}</label>`).join("");
    $("features").querySelectorAll("[data-feat]").forEach((c) =>
      c.addEventListener("change", () => {
        cfg.features[c.dataset.feat] = c.checked;
        cfg.tier = activePreset() === "custom" ? "Custom" : PRESETS[activePreset()].label;
        if ($("tierName")) $("tierName").value = cfg.tier;
        renderPresets();
      })
    );
  }
  function renderBackend() {
    if ($("beProvider")) $("beProvider").value = cfg.backend.provider || "none";
    if ($("beUrl")) $("beUrl").value = cfg.backend.url || "";
  }
  /* ---- promo / coupon / print override editors (edit content on behalf of the client) ---- */
  function renderContentEditors() {
    if ($("promoEnabled")) {
      $("promoEnabled").checked = !!cfg.promo.enabled;
      const shades = (cfg.shades || []).filter((s) => s.hex);
      $("promoShade").innerHTML = `<option value="">— none —</option>` + shades.map((s) => `<option value="${s.id}" ${cfg.promo.shadeId === s.id ? "selected" : ""}>${s.name}</option>`).join("");
      $("promoTitle").value = cfg.promo.title || "";
      $("promoMsg").value = cfg.promo.message || "";
      const pv = $("promoPrev");
      if (cfg.promo.image) { pv.src = cfg.promo.image; pv.style.display = ""; } else pv.style.display = "none";
    }
    if ($("promoAb")) {
      $("promoAb").checked = !!cfg.promo.ab.enabled;
      const shades = (cfg.shades || []).filter((s) => s.hex);
      $("promoBShade").innerHTML = `<option value="">— same as A —</option>` + shades.map((s) => `<option value="${s.id}" ${cfg.promo.ab.shadeId === s.id ? "selected" : ""}>${s.name}</option>`).join("");
      $("promoBTitle").value = cfg.promo.ab.title || "";
      $("promoBMsg").value = cfg.promo.ab.message || "";
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
    if ($("attractIdle")) {
      $("attractIdle").value = Math.round((cfg.attract.idleMs || 45000) / 1000);
      const shades = (cfg.shades || []).filter((s) => s.hex);
      $("attractShade").innerHTML = `<option value="">— first shade —</option>` + shades.map((s) => `<option value="${s.id}" ${cfg.attract.shadeId === s.id ? "selected" : ""}>${s.name}</option>`).join("");
      $("attractCta").value = cfg.attract.cta || "";
    }
    if ($("qrBaseUrl")) {
      $("qrBaseUrl").value = cfg.qr.baseUrl || "";
      $("qrScanPing").value = cfg.qr.scanPingUrl || "";
    }
    if ($("pvPolicy")) {
      $("pvPolicy").value = cfg.privacy.policyUrl || "";
      $("pvRetention").value = cfg.privacy.retentionDays != null ? cfg.privacy.retentionDays : 365;
      $("pvNotice").value = cfg.privacy.noticeText || "";
    }
  }
  function wireContentEditors() {
    const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
    on("promoEnabled", "change", (e) => (cfg.promo.enabled = e.target.checked));
    on("promoShade", "change", (e) => (cfg.promo.shadeId = e.target.value));
    on("promoTitle", "input", (e) => (cfg.promo.title = e.target.value));
    on("promoMsg", "input", (e) => (cfg.promo.message = e.target.value));
    on("promoAb", "change", (e) => (cfg.promo.ab.enabled = e.target.checked));
    on("promoBShade", "change", (e) => (cfg.promo.ab.shadeId = e.target.value));
    on("promoBTitle", "input", (e) => (cfg.promo.ab.title = e.target.value));
    on("promoBMsg", "input", (e) => (cfg.promo.ab.message = e.target.value));
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
    on("attractIdle", "input", (e) => { const s = parseInt(e.target.value, 10); cfg.attract.idleMs = (s > 0 ? s : 45) * 1000; });
    on("attractShade", "change", (e) => (cfg.attract.shadeId = e.target.value));
    on("attractCta", "input", (e) => (cfg.attract.cta = e.target.value));
    on("qrBaseUrl", "input", (e) => (cfg.qr.baseUrl = e.target.value.trim()));
    on("qrScanPing", "input", (e) => (cfg.qr.scanPingUrl = e.target.value.trim()));
    on("pvPolicy", "input", (e) => (cfg.privacy.policyUrl = e.target.value.trim()));
    on("pvNotice", "input", (e) => (cfg.privacy.noticeText = e.target.value));
    on("pvRetention", "input", (e) => (cfg.privacy.retentionDays = parseInt(e.target.value, 10) || 0));
    on("pvPurge", "click", () => {
      const n = A.purgeOldLeads(cfg.privacy.retentionDays);
      const m = $("pvMsg"); if (m) m.textContent = "Purged " + n + " lead(s) past retention.";
      renderAnalytics();
    });
  }
  function renderConfig() {
    if ($("tierName")) $("tierName").value = cfg.tier || "";
    renderPresets(); renderFeatures(); renderBackend(); renderPerms(); renderContentEditors();
    if (window.CommerceEditor) window.CommerceEditor.mount(cfg, $("commerceRows"), { toast: toast });
  }
  function wireConfig() {
    wireContentEditors();
    if ($("beProvider")) $("beProvider").addEventListener("change", (e) => (cfg.backend.provider = e.target.value));
    if ($("beUrl")) $("beUrl").addEventListener("input", (e) => (cfg.backend.url = e.target.value.trim()));
    if ($("tierName")) $("tierName").addEventListener("input", () => (cfg.tier = $("tierName").value));
    // Tabs
    document.querySelectorAll("#tabs button").forEach((b) =>
      b.addEventListener("click", () => {
        document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("on", x === b));
        const cfgT = b.dataset.tab === "cfg";
        $("tabCfg").style.display = cfgT ? "" : "none";
        $("tabAn").style.display = cfgT ? "none" : "";
      })
    );
  }

  /* ---- consolidated analytics ---- */
  function renderAnalytics() {
    const db = A.load();
    const agg = A.consolidate(db);
    const t = agg.totals;
    const captures = (t.photo || 0) + (t.video || 0);
    const nLoc = Object.keys(agg.perLocation).length;
    const nOnline = Object.keys(agg.perLocation).filter((id) => isOnline(agg.perLocation[id])).length;
    $("kpis").innerHTML =
      D.kpi("Kiosks online", nOnline + "/" + nLoc, "connected & syncing") +
      D.kpi("Activations", D.fmt(nLoc), "locations & events") +
      D.kpi("Sessions", D.fmt(t.sessions), "network total") +
      D.kpi("Try-ons", D.fmt(t.tryon), "all SKUs") +
      D.kpi("Captures", D.fmt(captures), "photo + video") +
      D.kpi("Analyses", D.fmt(t.analysis), "consultations") +
      D.kpi("Avg dwell", D.dwellStr(agg.dwellN ? Math.round(agg.dwellMs / agg.dwellN / 1000) : 0), "per session") +
      D.kpi("Leads", D.fmt(t.leads || 0), "opted-in") +
      D.kpi("QR scans", D.fmt(t.qrscan || 0), D.fmt(t.qrshow || 0) + " hand-offs") +
      D.kpi("Shop clicks", D.fmt(t.shopclick || 0), "buy taps") +
      D.kpi("Shares", D.fmt(t.share), "social cards");
    const heatEl = $("heat"); if (heatEl) heatEl.innerHTML = D.heat(agg.perHour);
    // A/B promo comparison
    const abEl = $("abTable"), abCard = $("abCard");
    if (abEl && abCard) {
      const ab = agg.ab || {};
      const variants = ["A", "B"].filter((v) => ab[v]);
      if (variants.length) {
        abCard.style.display = "";
        abEl.querySelector("tbody").innerHTML = variants.map((v) => {
          const a = ab[v] || {}, sess = a.sessions || 0;
          const conv = sess ? Math.round(((a.shopclick || 0) / sess) * 1000) / 10 : 0;
          return `<tr><td><b>${v}</b></td><td class="num">${D.fmt(sess)}</td><td class="num">${D.fmt(a.tryon || 0)}</td><td class="num">${D.fmt(a.leads || 0)}</td><td class="num">${D.fmt(a.shopclick || 0)}</td><td class="num">${conv}%</td></tr>`;
        }).join("");
      } else abCard.style.display = "none";
    }
    const funnelEl = $("funnel");
    if (funnelEl) funnelEl.innerHTML = D.bars([
      { label: "Sessions", value: t.sessions || 0, color: "#5F7D2E" },
      { label: "Try-ons", value: t.tryon || 0, color: "#6E8F38" },
      { label: "Analyses", value: t.analysis || 0, color: "#8FB24A" },
      { label: "Leads", value: t.leads || 0, color: "#B8942F" },
      { label: "Shop clicks", value: t.shopclick || 0, color: "#C06A9A" },
      { label: "QR scans", value: t.qrscan || 0, color: "#5A78A0" },
    ]);

    const rows = Object.keys(agg.perLocation).map((id) => agg.perLocation[id])
      .sort((a, b) => b.tryon - a.tryon);
    $("locTable").querySelector("tbody").innerHTML = rows.length ? rows.map((r) =>
      `<tr><td>${r.meta.name}</td><td><span class="pill-tag ${r.meta.type}">${r.meta.type}</span></td>` +
      `<td class="num">${D.fmt(r.sessions)}</td><td class="num">${D.fmt(r.tryon)}</td>` +
      `<td class="num">${D.fmt(r.captures)}</td><td class="num">${D.fmt(r.analysis)}</td>` +
      `<td class="num">${D.fmt(r.qrscan || 0)}</td>` +
      `<td>${r.build ? r.build : "—"}</td>` +
      `<td>${onlinePill(r)}</td>` +
      `<td>${r.lastSeen ? new Date(r.lastSeen).toLocaleString() : "—"}</td></tr>`
    ).join("") : `<tr><td colspan="10" style="color:var(--muted)">No data yet — import location exports or load demo data.</td></tr>`;

    const skus = D.topSkus(agg.perSku, 12);
    $("skuBars").innerHTML = skus.length ? D.bars(skus) : `<p class="hint" style="color:var(--muted)">No product data yet.</p>`;

    const byLoc = rows.map((r) => ({ label: r.meta.name, value: r.tryon, color: r.meta.type === "event" ? "#B8942F" : r.meta.type === "web" ? "#5A78A0" : "#5F7D2E" }));
    $("byLoc").innerHTML = byLoc.length ? D.bars(byLoc) : "";
    const u = agg.undertone || {};
    $("undertone").innerHTML = D.bars([
      { label: "Warm", value: u.warm || 0, color: "#B8942F" },
      { label: "Cool", value: u.cool || 0, color: "#5A78A0" },
      { label: "Neutral", value: u.neutral || 0, color: "#8FB24A" },
    ]);
    $("spark").innerHTML = D.spark(agg.perDay, "tryon");

    const demo = !!db.locations["watsons-smnorth"];
    $("demoBanner").style.display = demo ? "" : "none";
  }

  function boot() {
    renderConfig();
    wireConfig();
    renderAnalytics();

    $("savePerms").addEventListener("click", () => {
      localStorage.setItem("icolorConfig", JSON.stringify(cfg));
      toast("Saved — features, promo, coupon & client view updated on this device.");
    });
    $("downloadCfg").addEventListener("click", () => {
      download("window.ICOLOR_DEFAULT_CONFIG = " + JSON.stringify(cfg, null, 2) + ";\n", "config.default.js", "js");
      toast("Downloaded config.default.js");
    });

    $("importBtn").addEventListener("click", () => $("importFile").click());
    $("importFile").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0]; e.target.value = "";
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        try { A.mergeImport(JSON.parse(rd.result)); toast("Imported"); renderAnalytics(); }
        catch (err) { toast("Import failed: " + err.message); }
      };
      rd.readAsText(f);
    });
    $("exportAll").addEventListener("click", () => { download(A.load(), "icolor-analytics-consolidated.json"); toast("Exported consolidated"); });
    $("exportLeads").addEventListener("click", () => {
      const csv = A.leadsCSV();
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "icolor-leads.csv"; document.body.appendChild(a); a.click(); a.remove();
      toast("Exported leads CSV");
    });
    const ecEl = $("exportCoupons");
    if (ecEl) ecEl.addEventListener("click", () => {
      const blob = new Blob([A.couponsCSV()], { type: "text/csv" });
      const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "icolor-coupon-codes.csv"; document.body.appendChild(a); a.click(); a.remove();
      toast("Exported coupon codes CSV");
    });
    // Pull the fleet from the cloud (data + confirmed QR scans) and re-render.
    // Used by the manual button AND the auto-refresh loop (silent).
    let _syncing = false;
    async function cloudSync(opts) {
      const silent = opts && opts.silent;
      if (!window.Backend || !cfg.backend || cfg.backend.provider !== "pocketbase" || !cfg.backend.url) {
        if (!silent) toast("Set & save a PocketBase URL first");
        return false;
      }
      if (_syncing) return false; // don't overlap slow requests
      _syncing = true;
      try {
        const db = await window.Backend.fetchAllLocations();
        if (!db) { if (!silent) toast("Cloud sync failed — check URL/permissions"); return false; }
        A.save(db);
        // Fold confirmed QR scans (from the public /scanping endpoint) into each location.
        const scans = await window.Backend.fetchScans();
        if (scans) {
          const db2 = A.load();
          for (const locId in scans) {
            const L = db2.locations[locId] || A.ensureLoc(db2, { id: locId, name: locId, type: "qr" });
            L.totals.qrscan = scans[locId]; // server is authoritative for confirmed scans
          }
          A.save(db2);
        }
        renderAnalytics();
        if ($("autoSyncStatus")) $("autoSyncStatus").textContent = "● Live · updated " + new Date().toLocaleTimeString();
        if (!silent) toast("Synced from cloud");
        return true;
      } finally { _syncing = false; }
    }
    $("syncCloud").addEventListener("click", () => cloudSync({ silent: false }));
    // Auto-refresh the fleet every 30s (matches the kiosk heartbeat); pause when the
    // tab is hidden to save requests. Only runs when a PocketBase backend is set.
    if (cfg.backend && cfg.backend.provider === "pocketbase" && cfg.backend.url) {
      const tick = () => { if (!document.hidden) cloudSync({ silent: true }); };
      setInterval(tick, 30000);
      document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
      tick(); // immediate first pull
    }
    $("pushConfig").addEventListener("click", async () => {
      const st = $("beStatus");
      if (!window.Backend || cfg.backend.provider !== "pocketbase" || !cfg.backend.url) { st.textContent = "Set provider = PocketBase and a URL, then Save, first."; return; }
      st.textContent = "Pushing config to the fleet…";
      const ok = await window.Backend.pushConfig(cfg);
      st.textContent = ok ? "Config pushed — mirrors pick it up on next load." : "Push failed — check URL/permissions.";
    });
    $("seed").addEventListener("click", () => { A.seedDemo(); toast("Demo data loaded"); renderAnalytics(); });
    $("clear").addEventListener("click", () => {
      if (!confirm("Clear ALL analytics on this device (every location)?")) return;
      A.clearAll(); toast("Cleared"); renderAnalytics();
    });

    // ---- Voucher pool (import + stats) ----
    const backendSet = () => window.Backend && cfg.backend && cfg.backend.provider === "pocketbase" && cfg.backend.url;
    async function refreshVoucherStats() {
      const el = $("vpStats"); if (!el) return;
      if (!backendSet()) { el.textContent = "Set a PocketBase backend below to use the pool."; return; }
      el.textContent = "Loading pool…";
      const s = await window.Backend.voucherStats();
      el.textContent = s ? "Pool: " + D.fmt(s.total) + " total · " + D.fmt(s.used) + " used · " + D.fmt(s.remaining) + " remaining"
                         : "Couldn't read the pool (check backend).";
    }
    const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
    on("vpUpload", "click", () => $("vpFile").click());
    on("vpFile", "change", (e) => {
      const f = e.target.files && e.target.files[0]; e.target.value = ""; if (!f) return;
      const rd = new FileReader(); rd.onload = () => { $("vpCodes").value = String(rd.result || ""); }; rd.readAsText(f);
    });
    on("vpRefresh", "click", refreshVoucherStats);
    on("vpImport", "click", async () => {
      if (!backendSet()) { toast("Set & save a PocketBase backend first"); return; }
      const raw = ($("vpCodes").value || "").split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean);
      const codes = Array.from(new Set(raw));
      if (!codes.length) { toast("Paste or load some codes first"); return; }
      const campaign = ($("vpCampaign").value || "").trim();
      toast("Importing " + codes.length + " codes…");
      let added = 0, skipped = 0;
      for (let i = 0; i < codes.length; i += 5000) { // hook caps at 5000/request
        const res = await window.Backend.importVouchers(codes.slice(i, i + 5000), campaign);
        if (res) { added += res.added || 0; skipped += res.skipped || 0; }
      }
      toast("Imported " + added + " new · " + skipped + " skipped (duplicates)");
      $("vpCodes").value = "";
      refreshVoucherStats();
    });
    refreshVoucherStats();
  }

  if ($("app").style.display !== "none") boot();
})();
