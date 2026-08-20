/* ============================================================
   iColor Plus — "Shop the look" commerce helpers (shared)
   ------------------------------------------------------------
   - fetchShopify(url): title/image/price/variant/available from a Shopify
     product URL (CORS-permitting). Shopee/Lazada can't be read this way.
   - CommerceEditor.mount(cfg, container, {toast}): global checkout mode + a
     per-SKU editor (buyUrl / buyPrice / buyImg / in-stock), mutating cfg in
     place. Loaded by both the Admin console and Super Admin.
   - buildBuyUrl(shade, cfg, code): the URL the Buy button/QR opens — product
     page, Shopify cart permalink, or cart + applied discount code.
   ============================================================ */
(function () {
  async function fetchShopify(url) {
    try {
      const u = new URL(url);
      const m = u.pathname.match(/\/products\/([^/?#]+)/);
      if (!m) return null;
      const res = await fetch(u.origin + "/products/" + m[1] + ".js", { headers: { Accept: "application/json" } });
      if (!res.ok) return null;
      const p = await res.json();
      return {
        title: p.title || "",
        image: p.featured_image || (p.images && p.images[0]) || "",
        price: typeof p.price === "number" ? p.price / 100 : null,
        variantId: (p.variants && p.variants[0] && p.variants[0].id) || null,
        available: !!p.available,
      };
    } catch (e) { return null; }
  }

  // The destination for the Buy button / QR. `code` is an optional discount code.
  function buildBuyUrl(shade, cfg, code) {
    if (!shade || !shade.buyUrl) return "";
    const mode = (cfg.commerce && cfg.commerce.checkout) || "product";
    if ((mode === "cart" || mode === "discount") && shade.buyVariant) {
      try {
        const origin = new URL(shade.buyUrl).origin;
        let url = origin + "/cart/" + shade.buyVariant + ":1";
        if (mode === "discount" && code) url += "?discount=" + encodeURIComponent(code);
        return url;
      } catch (e) { /* fall through */ }
    }
    return shade.buyUrl;
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function mount(cfg, container, opts) {
    if (!container) return;
    opts = opts || {};
    const toast = opts.toast || function () {};
    const cm = (cfg.commerce = cfg.commerce || {});
    const checkout = cm.checkout || "product";
    const shades = (cfg.shades || []).filter((s) => s.hex);
    const opt = (v, label) => '<option value="' + v + '"' + (checkout === v ? " selected" : "") + ">" + label + "</option>";
    container.innerHTML =
      '<div class="cm-global"><label class="inline">Checkout action:</label> ' +
        '<select class="cm-checkout">' +
          opt("product", "Open product page") +
          opt("cart", "Add to cart (Shopify)") +
          opt("discount", "Add to cart + apply voucher (Shopify)") +
        "</select></div>" +
      (shades.length
        ? shades.map((s) =>
            '<div class="cm-row" data-id="' + esc(s.id) + '">' +
              '<div class="cm-head">' +
                '<span class="cm-swatch" style="background:' + esc(s.hex) + '"></span>' +
                '<span class="cm-name">' + esc(s.name) + "</span>" +
                '<label class="cm-stock"><input type="checkbox" class="cm-avail"' + (s.buyAvail !== false ? " checked" : "") + " /> In stock</label>" +
                '<img class="cm-thumb" alt="" ' + (s.buyImg ? 'src="' + esc(s.buyImg) + '"' : 'style="display:none"') + " />" +
              "</div>" +
              '<div class="cm-fields">' +
                '<input class="cm-url" type="text" placeholder="Product URL (Shopee / Lazada / Shopify)" value="' + esc(s.buyUrl || "") + '" />' +
                '<input class="cm-price" type="text" placeholder="Price" value="' + esc(s.buyPrice || "") + '" />' +
                '<input class="cm-img" type="text" placeholder="Image URL" value="' + esc(s.buyImg || "") + '" />' +
                '<button type="button" class="cm-up btn ghost sm">Upload</button>' +
                '<input class="cm-file" type="file" accept="image/*" hidden />' +
                '<button type="button" class="cm-fill btn ghost sm">Auto-fill (Shopify)</button>' +
              "</div>" +
            "</div>"
          ).join("")
        : '<p class="hint" style="color:var(--muted)">No colours to link yet.</p>');

    const sel = container.querySelector(".cm-checkout");
    if (sel) sel.addEventListener("change", (e) => { cm.checkout = e.target.value; });

    const byId = (id) => (cfg.shades || []).find((x) => x.id === id);
    container.querySelectorAll(".cm-row").forEach((row) => {
      const s = byId(row.dataset.id); if (!s) return;
      const q = (sel2) => row.querySelector(sel2);
      const setThumb = (src) => { const t = q(".cm-thumb"); if (src) { t.src = src; t.style.display = ""; } else t.style.display = "none"; };
      q(".cm-url").addEventListener("input", (e) => { s.buyUrl = e.target.value.trim(); });
      q(".cm-price").addEventListener("input", (e) => { s.buyPrice = e.target.value.trim(); });
      q(".cm-img").addEventListener("input", (e) => { s.buyImg = e.target.value.trim(); setThumb(s.buyImg); });
      q(".cm-avail").addEventListener("change", (e) => { s.buyAvail = e.target.checked; });
      q(".cm-up").addEventListener("click", () => q(".cm-file").click());
      q(".cm-file").addEventListener("change", (e) => {
        const f = e.target.files && e.target.files[0]; e.target.value = ""; if (!f) return;
        const rd = new FileReader();
        rd.onload = () => { s.buyImg = rd.result; q(".cm-img").value = ""; setThumb(rd.result); };
        rd.readAsDataURL(f);
      });
      q(".cm-fill").addEventListener("click", async () => {
        const url = (q(".cm-url").value || "").trim();
        if (!url) { toast("Enter the product URL first"); return; }
        toast("Fetching from Shopify…");
        const d = await fetchShopify(url);
        if (!d) { toast("Couldn't auto-fill (Shopify only) — enter image & price manually"); return; }
        if (d.price != null) { s.buyPrice = String(d.price); q(".cm-price").value = s.buyPrice; }
        if (d.image) { s.buyImg = d.image; q(".cm-img").value = d.image; setThumb(d.image); }
        if (d.variantId) s.buyVariant = d.variantId;
        s.buyAvail = d.available; q(".cm-avail").checked = d.available;
        toast("Filled from Shopify: " + (d.title || "product") + (d.available ? "" : " (SOLD OUT)"));
      });
    });
  }

  window.Commerce = { fetchShopify, buildBuyUrl };
  window.CommerceEditor = { mount };
})();
