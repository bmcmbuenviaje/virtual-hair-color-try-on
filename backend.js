/* ============================================================
   iColor Plus — optional live backend adapter (PocketBase)
   ------------------------------------------------------------
   No-op unless config.backend = { provider:"pocketbase", url:"https://..." }.
   Keeps localStorage as the source of truth (offline-safe) and, when a URL
   is set, mirrors the location snapshot + leads to PocketBase and lets Super
   Admin pull consolidated data + push config to the fleet.
   Server is self-hosted by Mineski (see POCKETBASE.md).
   ============================================================ */
(function () {
  const SDK = "https://cdn.jsdelivr.net/npm/pocketbase@0.21.5/dist/pocketbase.umd.js";
  let pb = null, loading = null;

  function cfg() {
    if (window.Analytics && window.Analytics.resolvedConfig) return window.Analytics.resolvedConfig();
    let over = null;
    try { over = JSON.parse(localStorage.getItem("icolorConfig") || "null"); } catch (e) {}
    return over && Array.isArray(over.shades) ? over : (window.ICOLOR_DEFAULT_CONFIG || {});
  }
  function beCfg() { return cfg().backend || { provider: "none", url: "" }; }
  function enabled() { const b = beCfg(); return b.provider === "pocketbase" && !!b.url; }

  function loadSDK() {
    if (window.PocketBase) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = SDK; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
    return loading;
  }
  async function init() {
    if (!enabled()) return false;
    try { await loadSDK(); pb = new window.PocketBase(beCfg().url); return true; }
    catch (e) { console.warn("[iColor] backend init failed", e); return false; }
  }

  async function upsertLocation() {
    if (!pb || !window.Analytics) return;
    try {
      const db = window.Analytics.load();
      const loc = window.Analytics.currentLocation();
      const L = db.locations[loc.id];
      if (!L) return;
      const rec = { locId: loc.id, name: (L.meta && L.meta.name) || loc.name, type: loc.type, data: JSON.stringify(L), updated: new Date().toISOString() };
      const found = await pb.collection("locations").getFirstListItem('locId="' + loc.id + '"').catch(() => null);
      if (found) await pb.collection("locations").update(found.id, rec);
      else await pb.collection("locations").create(rec);
    } catch (e) { /* offline / permissions — localStorage still holds it */ }
  }
  async function pushLead(lead) {
    if (!pb || !window.Analytics) return;
    try {
      await pb.collection("leads").create({
        locId: window.Analytics.currentLocation().id,
        email: lead.email || "", mobile: lead.mobile || "", consent: !!lead.consent, ts: lead.ts || new Date().toISOString(),
      });
    } catch (e) {}
  }
  async function fetchAllLocations() {
    if (!pb) { if (!(await init())) return null; }
    try {
      const list = await pb.collection("locations").getFullList({ sort: "-updated" });
      const db = { locations: {} };
      list.forEach((r) => { try { db.locations[r.locId] = JSON.parse(r.data); } catch (e) {} });
      return db;
    } catch (e) { return null; }
  }
  // Confirmed QR scans (written by the public /scanping Funnel endpoint). Returns
  // { locId: count } so Super Admin can fold real scan counts into the analytics.
  async function fetchScans() {
    if (!pb) { if (!(await init())) return null; }
    try {
      const list = await pb.collection("scans").getFullList({ sort: "-created" });
      const byLoc = {};
      list.forEach((r) => { if (r.locId) byLoc[r.locId] = (byLoc[r.locId] || 0) + 1; });
      return byLoc;
    } catch (e) { return null; }
  }
  // Fleet management: pull the active pushed config (Super Admin controls all mirrors).
  async function fetchConfig() {
    if (!pb) { if (!(await init())) return null; }
    try {
      const rec = await pb.collection("configs").getFirstListItem("active=true", { sort: "-updated" }).catch(() => null);
      if (rec && rec.config) return JSON.parse(rec.config);
    } catch (e) {}
    return null;
  }
  async function pushConfig(config) {
    if (!pb) { if (!(await init())) return false; }
    try {
      const rec = await pb.collection("configs").getFirstListItem("active=true").catch(() => null);
      const payload = { active: true, config: JSON.stringify(config), updated: new Date().toISOString() };
      if (rec) await pb.collection("configs").update(rec.id, payload);
      else await pb.collection("configs").create(payload);
      return true;
    } catch (e) { return false; }
  }

  window.Backend = { enabled, init, upsertLocation, pushLead, fetchAllLocations, fetchScans, fetchConfig, pushConfig, beCfg };
})();
