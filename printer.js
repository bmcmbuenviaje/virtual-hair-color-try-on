/* ============================================================
   iColor Plus — printer core (shared)  →  window.ICPrinter
   ------------------------------------------------------------
   Browser-only thermal (ESC/POS) receipt printing over Web
   Bluetooth or WebUSB, plus small helpers. Loaded as a classic
   script by index.html, admin.html and superadmin.html so the
   live app and the admin "Test print" share ONE implementation.

   Colour / B&W (full-page) printing does NOT go through here — it
   uses the device's own OS print dialog (window.print) in app.js,
   which reaches AirPrint / Mopria / Windows printers. This file is
   only for direct-to-device thermal RECEIPT printers.

   Support: Web Bluetooth & WebUSB work in Chrome/Edge on Windows,
   Android and ChromeOS (needs HTTPS + a user gesture). They are NOT
   available in iOS/iPadOS Safari — callers should fall back to OS
   print or show guidance there.
   ============================================================ */
(function () {
  "use strict";

  // ---- byte encoding (ESC/POS default code page ~ CP437 / ASCII) ----
  // Receipt printers are ASCII-only; map the few symbols we emit and drop
  // anything else so a stray emoji/accent can never corrupt the stream.
  const SUBS = {
    "₱": "PHP ", "‘": "'", "’": "'", "“": '"', "”": '"',
    "–": "-", "—": "-", "…": "...", " ": " ", "•": "*",
    "°": " deg", "é": "e", "ñ": "n", "Ñ": "N", "½": "1/2",
  };
  function ascii(str) {
    let s = String(str == null ? "" : str);
    s = s.replace(/[₱‘’“”–—… •°éñÑ½]/g, (c) => SUBS[c] || " ");
    let out = "";
    for (let i = 0; i < s.length; i++) { const cc = s.charCodeAt(i); out += cc >= 0x20 && cc <= 0x7E ? s[i] : (cc === 0x0A ? "\n" : ""); }
    return out;
  }
  function bytesOf(str) { const s = ascii(str); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff; return a; }

  // Characters per line for the paper width (Font A ≈ 12 dots wide → 32/48 cols).
  function colsFor(widthMm) { return widthMm >= 76 ? 48 : 32; }

  // ---- ESC/POS receipt builder ----
  // Fluent: receipt(opts).align('center').size(2).text('Hi').feed().cut().bytes()
  function receipt(opts) {
    opts = opts || {};
    const cols = colsFor(opts.widthMm || 58);
    const parts = []; // array of Uint8Array
    const push = (arr) => parts.push(arr instanceof Uint8Array ? arr : new Uint8Array(arr));
    const api = {};

    push([0x1b, 0x40]); // ESC @  — init
    push([0x1b, 0x74, 0x00]); // ESC t 0 — code page CP437

    api.cols = cols;
    api.align = (a) => { push([0x1b, 0x61, a === "center" ? 1 : a === "right" ? 2 : 0]); return api; };
    api.bold = (on) => { push([0x1b, 0x45, on ? 1 : 0]); return api; };
    api.underline = (on) => { push([0x1b, 0x2d, on ? 1 : 0]); return api; };
    // size: 1 = normal, 2 = double, {w,h} for independent (1..8)
    api.size = (n) => {
      let w = 0, h = 0;
      if (typeof n === "object") { w = Math.max(0, Math.min(7, (n.w || 1) - 1)); h = Math.max(0, Math.min(7, (n.h || 1) - 1)); }
      else { const k = Math.max(0, Math.min(7, (n || 1) - 1)); w = k; h = k; }
      push([0x1d, 0x21, (w << 4) | h]); return api;
    };
    api.text = (s) => { push(bytesOf(s)); push([0x0a]); return api; };
    api.raw = (s) => { push(bytesOf(s)); return api; };
    api.feed = (n) => { push([0x1b, 0x64, Math.max(1, n || 1)]); return api; };
    api.rule = (ch) => { push(bytesOf((ch || "-").repeat(cols))); push([0x0a]); return api; };
    // left text + right text on one line (wraps within cols)
    api.row = (left, right) => {
      left = ascii(left); right = ascii(right);
      const space = cols - left.length - right.length;
      if (space >= 1) push(bytesOf(left + " ".repeat(space) + right));
      else push(bytesOf((left + " " + right).slice(0, cols)));
      push([0x0a]); return api;
    };
    // word-wrapped paragraph
    api.wrap = (s, indent) => {
      s = ascii(s); indent = indent || "";
      const words = s.split(/\s+/).filter(Boolean); let line = indent;
      for (const w of words) {
        if ((line + (line === indent ? "" : " ") + w).length > cols) { push(bytesOf(line)); push([0x0a]); line = indent + w; }
        else line += (line === indent ? "" : " ") + w;
      }
      if (line.trim()) { push(bytesOf(line)); push([0x0a]); }
      return api;
    };
    // QR code (ESC/POS GS ( k, model 2)
    api.qr = (data, moduleSize) => {
      const d = bytesOf(data); const store = new Uint8Array(d.length + 3);
      const total = d.length + 3, pL = total & 0xff, pH = (total >> 8) & 0xff;
      push([0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]); // model 2
      push([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, Math.max(1, Math.min(16, moduleSize || 6))]); // module size
      push([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31]); // error correction M
      push([0x1d, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30]); push(d); // store
      push([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]); // print
      return api;
    };
    api.cut = () => { push([0x1b, 0x64, 0x03]); push([0x1d, 0x56, 0x42, 0x00]); return api; }; // feed + partial cut

    api.bytes = () => {
      let len = 0; parts.forEach((p) => (len += p.length));
      const out = new Uint8Array(len); let o = 0; parts.forEach((p) => { out.set(p, o); o += p.length; });
      return out;
    };
    return api;
  }

  // ---- capability ----
  const hasBluetooth = () => typeof navigator !== "undefined" && !!navigator.bluetooth;
  const hasUSB = () => typeof navigator !== "undefined" && !!navigator.usb;
  function supported(transport) { return transport === "usb" ? hasUSB() : hasBluetooth(); }

  // Common BLE services exposed by generic ESC/POS printers.
  const BLE_SERVICES = [
    0x18f0, 0xff00, 0xffe0, 0xff90, 0xfff0, 0xae30,
    "0000ff00-0000-1000-8000-00805f9b34fb",
    "49535343-fe7d-4ae5-8fa9-9fafd205e455", // Microchip/ISSC transparent UART
    "e7810a71-73ae-499d-8c15-faa9aef0c3f2",
  ];

  async function pickWritable(server) {
    const services = await server.getPrimaryServices();
    for (const svc of services) {
      let chars = [];
      try { chars = await svc.getCharacteristics(); } catch (e) { continue; }
      for (const ch of chars) {
        if (ch.properties && (ch.properties.writeWithoutResponse || ch.properties.write)) return ch;
      }
    }
    return null;
  }

  async function bleWrite(ch, bytes, status) {
    const withoutResp = ch.properties && ch.properties.writeWithoutResponse;
    const CHUNK = 180; // safe below typical negotiated MTU
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const slice = bytes.slice(i, i + CHUNK);
      if (withoutResp && ch.writeValueWithoutResponse) await ch.writeValueWithoutResponse(slice);
      else await ch.writeValue(slice);
      if (status && bytes.length > CHUNK) status("Sending… " + Math.min(100, Math.round(((i + CHUNK) / bytes.length) * 100)) + "%");
      await new Promise((r) => setTimeout(r, 18)); // let the buffer drain
    }
  }

  async function printBluetooth(bytes, status) {
    if (!hasBluetooth()) throw new Error("Web Bluetooth is not available on this device/browser.");
    let device = null;
    try { const known = await navigator.bluetooth.getDevices(); if (known && known.length) device = known[known.length - 1]; } catch (e) { /* older browsers */ }
    if (!device) {
      status && status("Select your printer…");
      device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
    }
    status && status("Connecting…");
    const server = await device.gatt.connect();
    const ch = await pickWritable(server);
    if (!ch) { try { device.gatt.disconnect(); } catch (e) {} throw new Error("No writable characteristic — is this an ESC/POS Bluetooth printer?"); }
    await bleWrite(ch, bytes, status);
    await new Promise((r) => setTimeout(r, 350));
    try { device.gatt.disconnect(); } catch (e) {}
  }

  async function printUSB(bytes, status) {
    if (!hasUSB()) throw new Error("WebUSB is not available on this device/browser.");
    let device = null;
    try { const known = await navigator.usb.getDevices(); if (known && known.length) device = known[0]; } catch (e) {}
    if (!device) {
      status && status("Select your printer…");
      device = await navigator.usb.requestDevice({ filters: [{ classCode: 7 }] }); // 7 = printer class
    }
    status && status("Connecting…");
    await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);
    // find an interface with a bulk OUT endpoint
    let ifaceNum = -1, epOut = -1;
    for (const iface of device.configuration.interfaces) {
      const alt = iface.alternate;
      const out = alt.endpoints.find((e) => e.direction === "out" && e.type === "bulk");
      if (out) { ifaceNum = iface.interfaceNumber; epOut = out.endpointNumber; break; }
    }
    if (ifaceNum < 0) { try { await device.close(); } catch (e) {} throw new Error("No USB printer endpoint found."); }
    try { await device.claimInterface(ifaceNum); } catch (e) { /* may already be claimed */ }
    const CHUNK = 4096;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      await device.transferOut(epOut, bytes.slice(i, i + CHUNK));
      if (status && bytes.length > CHUNK) status("Sending… " + Math.min(100, Math.round(((i + CHUNK) / bytes.length) * 100)) + "%");
    }
    await new Promise((r) => setTimeout(r, 200));
    try { await device.close(); } catch (e) {}
  }

  async function printThermal(bytes, opts) {
    opts = opts || {};
    const status = opts.onStatus || null;
    const copies = Math.max(1, Math.min(5, opts.copies || 1));
    let payload = bytes;
    if (copies > 1) {
      const one = bytes; const full = new Uint8Array(one.length * copies);
      for (let i = 0; i < copies; i++) full.set(one, i * one.length); payload = full;
    }
    if (opts.transport === "usb") return printUSB(payload, status);
    return printBluetooth(payload, status);
  }

  // ---- staff "Test print" (shared by Admin + Super Admin) ----
  function osTestPage(mode) {
    const w = window.open("", "_blank");
    if (!w) return false;
    const swatch = mode === "bw" ? "" : '<div style="width:120px;height:120px;border-radius:14px;background:linear-gradient(135deg,#800020,#b8942f);margin:0 auto 14px"></div>';
    const note = mode === "bw" ? '<p style="color:#777">Black &amp; White mode — the guest photo is omitted on real prints.</p>' : "";
    const html = '<!doctype html><meta charset="utf-8"><title>iColor Plus — printer test</title>' +
      '<body style="font-family:system-ui,Segoe UI,sans-serif;text-align:center;padding:34px;color:#1a1a1a">' +
      swatch + "<h2 style='margin:6px 0'>iColor Plus — printer test</h2><p>" + new Date().toLocaleString() + "</p>" + note +
      '<p style="color:#999;font-size:12px">If this page prints, your ' + (mode === "bw" ? "B&amp;W" : "colour") + " printer is ready.</p>" +
      "<scr" + "ipt>window.onload=function(){setTimeout(function(){window.print()},250)}</scr" + "ipt>";
    w.document.write(html); w.document.close();
    return true;
  }

  async function testPrint(cfg, onStatus) {
    cfg = cfg || {};
    const mode = cfg.mode || "color";
    if (mode === "thermal") {
      const transport = cfg.transport || "bluetooth";
      if (!supported(transport)) throw new Error((transport === "usb" ? "WebUSB" : "Web Bluetooth") + " isn't available on this device/browser (iOS Safari can't).");
      const width = cfg.widthMm || 58;
      const r = receipt({ widthMm: width });
      r.align("center").bold(true).size(1).text(cfg.header || "iColor Plus").bold(false).text("Test print").rule();
      r.align("left").text("Printer connected OK.").text(new Date().toLocaleString());
      r.text("Paper: " + width + "mm (" + colsFor(width) + " cols)");
      if (cfg.qr !== false) { r.feed(1).align("center").text("QR test").qr("https://greatlengths.ph", width >= 76 ? 7 : 5); }
      r.feed(1).align("center"); if (cfg.footer) r.wrap(cfg.footer); r.cut();
      await printThermal(r.bytes(), { transport, copies: 1, onStatus });
      return "thermal";
    }
    if (!osTestPage(mode)) throw new Error("Pop-up blocked — allow pop-ups, then tap Test print again.");
    return "os";
  }

  window.ICPrinter = { receipt, printThermal, testPrint, osTestPage, supported, hasBluetooth, hasUSB, colsFor, ascii };
})();
