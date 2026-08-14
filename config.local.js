/* ============================================================
   iColor Plus — PER-DEVICE overrides (optional)
   ------------------------------------------------------------
   Loaded AFTER config.default.js. This file is for settings that
   differ per install (which backend a kiosk syncs to, which store
   it is) and that must SURVIVE app updates. The public GitHub Pages
   deploy ships this file empty; a kiosk keeps its own copy (the
   pb_public sync deliberately does NOT overwrite it).
   Not for secrets — it's still shipped to the browser.
   ============================================================ */
(function () {
  var c = window.ICOLOR_DEFAULT_CONFIG;
  if (!c) return;
  // --- Example kiosk overrides (uncomment + edit on the device) ---
  // c.backend  = { provider: "pocketbase", url: "https://desktop-s8s5jql.tail38606b.ts.net" };
  // c.location = { id: "watsons-smnorth", name: "Watsons — SM North EDSA", type: "store" };
})();
