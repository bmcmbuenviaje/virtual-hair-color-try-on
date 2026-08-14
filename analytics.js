/* ============================================================
   iColor Plus — usage analytics engine (client-side)
   ------------------------------------------------------------
   Tracks try-on activity to localStorage, tagged by the
   deployment's LOCATION (store / event / web). A single device =
   one location. Super Admin consolidates locations via import
   (or all locations stored on one demo browser).
   No backend required — export/import moves data between devices.
   ============================================================ */
(function () {
  const KEY = "icolorAnalytics";

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || "null") || { locations: {} }; }
    catch (e) { return { locations: {} }; }
  }
  function save(db) { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {} }

  function dayKey(d) {
    d = d || new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function resolvedConfig() {
    const def = window.ICOLOR_DEFAULT_CONFIG || {};
    let over = null;
    try { over = JSON.parse(localStorage.getItem("icolorConfig") || "null"); } catch (e) {}
    return over && Array.isArray(over.shades) ? over : def;
  }
  // A location-tagged deep link (from a scanned QR) overrides the device's own
  // configured location, so a scan on a customer's phone — and anything they then
  // do on it — attributes back to the kiosk's store. Persisted for the session so
  // in-app navigation that drops the query string keeps the attribution.
  let _urlLoc;
  function urlLoc() {
    if (_urlLoc !== undefined) return _urlLoc;
    _urlLoc = null;
    try {
      const p = new URLSearchParams(location.search);
      const id = p.get("loc");
      if (id) {
        _urlLoc = { id: id, name: p.get("locn") || id, type: p.get("loct") || "qr", qr: p.get("src") === "qr" };
        sessionStorage.setItem("icolorUrlLoc", JSON.stringify(_urlLoc));
      } else {
        const s = sessionStorage.getItem("icolorUrlLoc");
        if (s) _urlLoc = JSON.parse(s);
      }
    } catch (e) {}
    return _urlLoc;
  }
  function isQrLanding() { const u = urlLoc(); return !!(u && u.qr); }

  function currentLocation() {
    const u = urlLoc();
    if (u && u.id) return { id: u.id, name: u.name, type: u.type };
    const cfg = resolvedConfig();
    return cfg.location || { id: "unassigned", name: "Unassigned", type: "web" };
  }

  function blankLoc(meta) {
    return {
      meta: meta,
      totals: { sessions: 0, tryon: 0, photo: 0, video: 0, analysis: 0, share: 0, leads: 0 },
      perSku: {}, perDay: {}, perHour: {}, undertone: { warm: 0, cool: 0, neutral: 0 }, hairLevel: {},
      dwellMs: 0, dwellN: 0, leads: [], lastSeen: null,
    };
  }
  function ensureLoc(db, loc) {
    if (!db.locations[loc.id]) db.locations[loc.id] = blankLoc(loc);
    else db.locations[loc.id].meta = loc;
    return db.locations[loc.id];
  }

  function track(type, opts) {
    opts = opts || {};
    const db = load();
    const L = ensureLoc(db, currentLocation());
    if (type === "dwell") {
      L.dwellMs = (L.dwellMs || 0) + (opts.ms || 0);
      L.dwellN = (L.dwellN || 0) + 1;
      save(db);
      return;
    }
    if (L.totals[type] == null) L.totals[type] = 0;
    L.totals[type]++;
    const t = dayKey();
    L.perDay[t] = L.perDay[t] || { sessions: 0, tryon: 0, photo: 0, video: 0, analysis: 0, share: 0 };
    L.perDay[t][type] = (L.perDay[t][type] || 0) + 1;
    if (type === "tryon") {
      if (opts.sku) L.perSku[opts.sku] = (L.perSku[opts.sku] || 0) + 1;
      const h = new Date().getHours();
      L.perHour = L.perHour || {};
      L.perHour[h] = (L.perHour[h] || 0) + 1;
    }
    if (type === "analysis") {
      if (opts.undertone) L.undertone[opts.undertone] = (L.undertone[opts.undertone] || 0) + 1;
      if (opts.hairLevel != null) L.hairLevel[opts.hairLevel] = (L.hairLevel[opts.hairLevel] || 0) + 1;
    }
    L.lastSeen = new Date().toISOString();
    save(db);
  }

  // Opt-in lead (consent-only; stored locally, exported as CSV by Super Admin).
  function addLead(lead) {
    const db = load();
    const L = ensureLoc(db, currentLocation());
    L.leads = L.leads || [];
    L.leads.push(Object.assign({ ts: new Date().toISOString(), loc: L.meta.name }, lead));
    L.totals.leads = (L.totals.leads || 0) + 1;
    L.lastSeen = new Date().toISOString();
    save(db);
  }
  function leadsCSV() {
    const db = load();
    const rows = [["Timestamp", "Location", "Email", "Mobile", "Consent"]];
    for (const id in db.locations) {
      (db.locations[id].leads || []).forEach((l) =>
        rows.push([l.ts, l.loc || db.locations[id].meta.name, l.email || "", l.mobile || "", l.consent ? "yes" : "no"])
      );
    }
    return rows.map((r) => r.map((f) => '"' + String(f).replace(/"/g, '""') + '"').join(",")).join("\n");
  }
  function avgDwellSec(L) { return L && L.dwellN ? Math.round(L.dwellMs / L.dwellN / 1000) : 0; }

  // Merge every location into one aggregate (for Super Admin).
  function consolidate(db) {
    db = db || load();
    const agg = blankLoc({ id: "ALL", name: "All activations", type: "all" });
    agg.perLocation = {};
    for (const id in db.locations) {
      const L = db.locations[id];
      for (const k in L.totals) agg.totals[k] = (agg.totals[k] || 0) + (L.totals[k] || 0);
      for (const sku in L.perSku) agg.perSku[sku] = (agg.perSku[sku] || 0) + L.perSku[sku];
      for (const day in L.perDay) {
        agg.perDay[day] = agg.perDay[day] || {};
        for (const k in L.perDay[day]) agg.perDay[day][k] = (agg.perDay[day][k] || 0) + L.perDay[day][k];
      }
      for (const u in L.undertone) agg.undertone[u] = (agg.undertone[u] || 0) + L.undertone[u];
      for (const lv in L.hairLevel) agg.hairLevel[lv] = (agg.hairLevel[lv] || 0) + L.hairLevel[lv];
      for (const h in (L.perHour || {})) agg.perHour[h] = (agg.perHour[h] || 0) + L.perHour[h];
      agg.dwellMs += L.dwellMs || 0;
      agg.dwellN += L.dwellN || 0;
      if (L.leads) agg.leads = agg.leads.concat(L.leads);
      agg.perLocation[id] = {
        meta: L.meta,
        sessions: L.totals.sessions || 0,
        tryon: L.totals.tryon || 0,
        captures: (L.totals.photo || 0) + (L.totals.video || 0),
        analysis: L.totals.analysis || 0,
        qrscan: L.totals.qrscan || 0,
        qrshow: L.totals.qrshow || 0,
        leads: L.totals.leads || 0,
        lastSeen: L.lastSeen,
      };
    }
    return agg;
  }

  function mergeImport(imported) {
    const db = load();
    if (imported && imported.locations) {
      for (const id in imported.locations) db.locations[id] = imported.locations[id];
    } else if (imported && imported.meta) {
      db.locations[imported.meta.id] = imported;
    } else throw new Error("Unrecognized analytics file");
    save(db);
    return db;
  }

  function exportLocation(id) {
    const db = load();
    if (id && db.locations[id]) return db.locations[id];
    return db; // whole set
  }

  function seedDemo() {
    const db = load();
    const shades = (resolvedConfig().shades || []).filter((s) => s.hex).map((s) => s.id);
    const locs = [
      { id: "watsons-smnorth", name: "Watsons — SM North EDSA", type: "store" },
      { id: "watsons-moa", name: "Watsons — SM Mall of Asia", type: "store" },
      { id: "glorietta-activation", name: "Glorietta Activation", type: "event" },
      { id: "web-qr", name: "Web / QR Campaign", type: "web" },
    ];
    const R = (a, b) => Math.floor(a + Math.random() * (b - a));
    locs.forEach((loc, li) => {
      const L = ensureLoc(db, loc);
      const scale = [1.0, 0.85, 1.7, 0.6][li];
      L.totals.sessions = Math.round(R(220, 560) * scale);
      L.totals.tryon = Math.round(L.totals.sessions * R(5, 9));
      L.totals.photo = Math.round(L.totals.tryon * 0.22);
      L.totals.video = Math.round(L.totals.tryon * 0.07);
      L.totals.analysis = Math.round(L.totals.sessions * 0.55);
      L.totals.share = Math.round(L.totals.photo * 0.45);
      L.perSku = {};
      shades.forEach((sk, i) => {
        // popular shades weighted toward the top of the list
        const base = Math.max(2, 90 - i * 4);
        if (Math.random() < 0.9) L.perSku[sk] = Math.round(R(base * 0.4, base) * scale);
      });
      L.undertone = { warm: R(90, 220), cool: R(70, 170), neutral: R(30, 90) };
      L.hairLevel = { 1: R(30, 90), 2: R(60, 160), 3: R(80, 200), 4: R(40, 120), 5: R(10, 50) };
      L.perHour = {};
      for (let h = 0; h < 24; h++) {
        const peak = h >= 11 && h <= 20 ? 1 : h >= 9 && h <= 21 ? 0.4 : 0.05;
        L.perHour[h] = Math.round(R(4, 45) * peak * scale);
      }
      L.dwellN = L.totals.sessions;
      L.dwellMs = L.dwellN * R(45, 130) * 1000;
      L.leads = [];
      const nLeads = Math.round(L.totals.analysis * 0.15);
      for (let k = 0; k < nLeads; k++) {
        L.totals.leads = (L.totals.leads || 0) + 1;
        L.leads.push({
          ts: new Date(Date.now() - R(0, 14) * 86400000).toISOString(),
          loc: loc.name,
          email: "shopper" + li + "-" + k + "@example.com",
          mobile: Math.random() < 0.5 ? "09" + R(100000000, 999999999) : "",
          consent: true,
        });
      }
      L.perDay = {};
      for (let d = 13; d >= 0; d--) {
        const key = dayKey(new Date(Date.now() - d * 86400000));
        L.perDay[key] = { sessions: R(8, 55), tryon: R(40, 300), photo: R(5, 55), video: R(0, 14), analysis: R(5, 40), share: R(2, 24) };
      }
      L.lastSeen = new Date().toISOString();
    });
    save(db);
    return db;
  }

  function clearAll() { try { localStorage.removeItem(KEY); } catch (e) {} }

  function shadeName(id) { const s = (resolvedConfig().shades || []).find((x) => x.id === id); return s ? s.name : id; }
  function shadeHex(id) { const s = (resolvedConfig().shades || []).find((x) => x.id === id); return s ? s.hex : "#888888"; }

  window.Analytics = {
    KEY, load, save, track, addLead, leadsCSV, avgDwellSec, consolidate, mergeImport,
    exportLocation, seedDemo, clearAll, currentLocation, ensureLoc, shadeName, shadeHex,
    dayKey, resolvedConfig, isQrLanding, urlLoc,
  };

  /* ---- shared render helpers for the dashboards ---- */
  window.Dash = {
    fmt(n) { return (n || 0).toLocaleString("en-US"); },
    bars(items, unit) {
      const max = Math.max(1, ...items.map((i) => i.value));
      return items.map((i) =>
        `<div class="bar-row"><span class="bar-lab" title="${i.label}">${i.label}</span>` +
        `<span class="bar-track"><span class="bar-fill" style="width:${(i.value / max * 100).toFixed(1)}%;background:${i.color || "#5F7D2E"}"></span></span>` +
        `<span class="bar-val">${(i.value || 0).toLocaleString("en-US")}${unit || ""}</span></div>`
      ).join("");
    },
    spark(perDay, metric) {
      const days = Object.keys(perDay).sort().slice(-14);
      const vals = days.map((d) => (perDay[d] && perDay[d][metric]) || 0);
      const max = Math.max(1, ...vals);
      return `<div class="spark">` + vals.map((v, i) =>
        `<span class="spk" style="height:${Math.max(4, v / max * 100).toFixed(0)}%" title="${days[i]}: ${v}"></span>`
      ).join("") + `</div>`;
    },
    kpi(label, value, sub) {
      return `<div class="kpi"><div class="kpi-v">${value}</div><div class="kpi-l">${label}</div>${sub ? `<div class="kpi-s">${sub}</div>` : ""}</div>`;
    },
    heat(perHour) {
      const hours = [...Array(24).keys()];
      const vals = hours.map((h) => (perHour && perHour[h]) || 0);
      const max = Math.max(1, ...vals);
      return `<div class="heat">` + hours.map((h) =>
        `<div class="heatcol" title="${h}:00 — ${vals[h]}"><span class="heatbar" style="height:${Math.max(3, (vals[h] / max) * 100).toFixed(0)}%"></span><span class="heathr">${h % 3 === 0 ? h : ""}</span></div>`
      ).join("") + `</div>`;
    },
    dwellStr(sec) {
      if (!sec) return "—";
      if (sec < 60) return sec + "s";
      return Math.floor(sec / 60) + "m " + (sec % 60) + "s";
    },
    topSkus(perSku, n) {
      return Object.keys(perSku)
        .map((id) => ({ id, value: perSku[id] }))
        .sort((a, b) => b.value - a.value)
        .slice(0, n || 10)
        .map((x) => ({ label: window.Analytics.shadeName(x.id), value: x.value, color: window.Analytics.shadeHex(x.id) }));
    },
  };
})();
