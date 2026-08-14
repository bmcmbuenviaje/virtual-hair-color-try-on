/* iColor Plus — client analytics dashboard */
(function () {
  const $ = (id) => document.getElementById(id);
  const A = window.Analytics, D = window.Dash;

  function cfg() { return A.resolvedConfig(); }
  function saveConfigLocation(loc) {
    // persist location into the localStorage config override so the app tags events
    let over = null;
    try { over = JSON.parse(localStorage.getItem("icolorConfig") || "null"); } catch (e) {}
    const base = over && Array.isArray(over.shades) ? over : JSON.parse(JSON.stringify(cfg()));
    base.location = loc;
    localStorage.setItem("icolorConfig", JSON.stringify(base));
  }

  function toast(m) { const t = $("toastA"); t.textContent = m; t.style.opacity = 1; clearTimeout(toast._t); toast._t = setTimeout(() => (t.style.opacity = 0), 1900); }
  function slug(s) { return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "loc-" + Date.now(); }
  function download(obj, name) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  }

  /* ---- gate (client admin creds) ---- */
  function unlock() {
    const admin = (cfg().admin || {});
    const u = ($("gu").value || "").trim(), p = $("gp").value || "";
    if (u === (admin.username || "admin") && p === (admin.password || admin.passcode || "icolor")) {
      if ((cfg().clientAdmin || {}).showAnalytics === false) { $("ge").textContent = "Analytics is disabled for this account."; return; }
      sessionStorage.setItem("icolorAdminOk", "1");
      $("gate").style.display = "none"; $("app").style.display = ""; boot();
    } else $("ge").textContent = "Incorrect username or password.";
  }
  $("gb").addEventListener("click", unlock);
  $("gp").addEventListener("keydown", (e) => { if (e.key === "Enter") unlock(); });
  if (sessionStorage.getItem("icolorAdminOk") === "1") { $("gate").style.display = "none"; $("app").style.display = ""; }

  /* ---- render ---- */
  function currentLoc() { return A.currentLocation(); }
  function locData() {
    const db = A.load();
    const id = currentLoc().id;
    return db.locations[id] || A.ensureLoc(db, currentLoc());
  }

  function render() {
    const loc = currentLoc();
    const L = locData();
    $("locSub").innerHTML = `<span class="pill-tag ${loc.type}">${loc.type}</span> &nbsp; ${loc.name}` +
      (L.lastSeen ? ` &nbsp;·&nbsp; last activity ${new Date(L.lastSeen).toLocaleString()}` : " · no activity yet");
    $("locName").value = loc.name === "Unassigned deployment" ? "" : loc.name;
    $("locType").value = loc.type;
    $("locId").value = loc.id === "unassigned" ? "" : loc.id;

    const t = L.totals;
    const captures = (t.photo || 0) + (t.video || 0);
    const convTryon = t.sessions ? Math.round((t.tryon / t.sessions) * 10) / 10 : 0;
    $("kpis").innerHTML =
      D.kpi("Sessions", D.fmt(t.sessions), "unique starts") +
      D.kpi("Try-ons", D.fmt(t.tryon), convTryon + " per session") +
      D.kpi("Captures", D.fmt(captures), D.fmt(t.photo) + " photo · " + D.fmt(t.video) + " video") +
      D.kpi("Analyses", D.fmt(t.analysis), "hair & skin") +
      D.kpi("Avg dwell", D.dwellStr(A.avgDwellSec(L)), "per session") +
      D.kpi("Leads", D.fmt(t.leads || 0), "opted-in") +
      D.kpi("QR scans", D.fmt(t.qrscan || 0), D.fmt(t.qrshow || 0) + " hand-offs") +
      D.kpi("Shares", D.fmt(t.share), "social cards");
    const heatEl = $("heat"); if (heatEl) heatEl.innerHTML = D.heat(L.perHour);

    const skus = D.topSkus(L.perSku, 12);
    $("skuBars").innerHTML = skus.length ? D.bars(skus) : `<p class="hint" style="color:var(--muted)">No try-ons recorded yet.</p>`;
    $("spark").innerHTML = D.spark(L.perDay, "tryon");
    const u = L.undertone || {};
    $("undertone").innerHTML = D.bars([
      { label: "Warm", value: u.warm || 0, color: "#B8942F" },
      { label: "Cool", value: u.cool || 0, color: "#5A78A0" },
      { label: "Neutral", value: u.neutral || 0, color: "#8FB24A" },
    ]);
    $("funnel").innerHTML = D.bars([
      { label: "Sessions", value: t.sessions || 0, color: "#5F7D2E" },
      { label: "Try-ons", value: t.tryon || 0, color: "#6E8F38" },
      { label: "Analyses", value: t.analysis || 0, color: "#8FB24A" },
      { label: "Captures", value: captures, color: "#B8942F" },
      { label: "Shares", value: t.share || 0, color: "#E0C46A" },
      { label: "QR scans", value: t.qrscan || 0, color: "#5A78A0" },
    ]);

    const db = A.load();
    const demo = !!db.locations["watsons-smnorth"] && Object.keys(db.locations).length >= 3;
    $("demoBanner").style.display = demo ? "" : "none";
  }

  function boot() {
    render();
    $("saveLoc").addEventListener("click", () => {
      const name = ($("locName").value || "").trim();
      if (!name) { toast("Enter a location name"); return; }
      const type = $("locType").value;
      const id = ($("locId").value || "").trim() || slug(name);
      const loc = { id, name, type };
      saveConfigLocation(loc);
      // create the location bucket if new
      const db = A.load(); A.ensureLoc(db, loc); A.save(db);
      toast("Location saved — try-ons will tag to “" + name + "”");
      render();
    });
    $("exportLoc").addEventListener("click", () => {
      const loc = currentLoc();
      download({ meta: loc, ...locData() }, "icolor-analytics-" + loc.id + ".json");
      toast("Exported this location");
    });
    $("seed").addEventListener("click", () => { A.seedDemo(); toast("Demo data loaded"); render(); });
    $("clear").addEventListener("click", () => {
      if (!confirm("Clear ALL usage data on this device? This cannot be undone.")) return;
      A.clearAll(); toast("Data cleared"); render();
    });
  }

  if ($("app").style.display !== "none") boot();
})();
