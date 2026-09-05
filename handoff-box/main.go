// iColor Plus — offline photo-handoff box
// ---------------------------------------------------------------------------
// A tiny, dependency-free (stdlib-only) HTTP(S) server that lets a kiosk push a
// guest's try-on photos/videos to it, then lets the guest pull them onto their
// own phone over the local Wi-Fi — with NO internet at the venue.
//
//   Tier 2 (tablets / Android-TV kiosks): runs on a GL.iNet router (OpenWrt).
//     Serve HTTPS with a trusted Let's Encrypt cert (see SETUP.md) so the HTTPS
//     kiosk app is allowed to upload to it and iPhones trust the gallery page.
//   Tier 0 (Windows mini-PC kiosk): runs on the PC itself over http://localhost
//     (loopback is a "secure context", so the HTTPS app may fetch it); guests
//     join the PC's Mobile Hotspot and open the gallery at the PC's LAN IP.
//
// Routes:
//   POST /handoff          multipart "files" upload -> {ok,code,url,count}
//   GET  /g/{code}         mobile gallery page (Save buttons + Download all)
//   GET  /f/{code}/{name}  one file (inline; ?dl=1 forces download)
//   GET  /z/{code}         all files as a .zip
//   GET  /                 friendly landing page
//
// Build for the GL-MT1300 "Beryl" (MediaTek MT7621, mipsle):
//   GOOS=linux GOARCH=mipsle GOMIPS=softfloat go build -trimpath -ldflags "-s -w" -o icolor-handoff
// Build for a Windows mini-PC (Tier 0):
//   go build -o icolor-handoff.exe
package main

import (
	"archive/zip"
	"crypto/rand"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"html"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var (
	storageDir string
	publicBase string
	addrHTTP   string
	addrHTTPS  string
	redirAddr  string
	certFile   string
	keyFile    string
	retHours   int
	eodPurge   bool
	maxBytes   int64
)

// Unambiguous code alphabet (no 0/O/1/I/L).
const codeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
const codeLen = 4

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	flag.StringVar(&storageDir, "dir", env("HANDOFF_DIR", "./captures"), "where uploaded media is stored")
	flag.StringVar(&publicBase, "base", env("HANDOFF_BASE", ""), "public base URL for gallery links (blank = derive from request host)")
	flag.StringVar(&addrHTTP, "http", env("HANDOFF_HTTP", ":8787"), "HTTP listen address (Tier 0). When a cert is set this becomes an HTTPS redirect on :80")
	flag.StringVar(&addrHTTPS, "https", env("HANDOFF_HTTPS", ":8443"), "HTTPS listen address (Tier 2, used only when -cert/-key are set)")
	flag.StringVar(&redirAddr, "redirect", env("HANDOFF_REDIRECT", ""), "when a cert is set, also run an HTTP->HTTPS redirect on this address (blank = off, to avoid clashing with the router's own admin on :80)")
	flag.StringVar(&certFile, "cert", env("HANDOFF_CERT", ""), "TLS certificate (fullchain.pem). Set to enable HTTPS (Tier 2)")
	flag.StringVar(&keyFile, "key", env("HANDOFF_KEY", ""), "TLS private key (key.pem)")
	flag.IntVar(&retHours, "retention-hours", 0, "delete captures older than N hours (0 = use end-of-day purge)")
	flag.BoolVar(&eodPurge, "end-of-day", true, "delete captures from previous calendar days (default handoff policy)")
	flag.Int64Var(&maxBytes, "max-bytes", 250<<20, "max total bytes accepted per upload (default 250MB)")
	flag.Parse()

	if err := os.MkdirAll(storageDir, 0o755); err != nil {
		log.Fatalf("cannot create storage dir %q: %v", storageDir, err)
	}

	go purgeLoop()

	mux := http.NewServeMux()
	mux.HandleFunc("/handoff", handleHandoff)
	mux.HandleFunc("/g/", handleGallery)
	mux.HandleFunc("/f/", handleFile)
	mux.HandleFunc("/z/", handleZip)
	mux.HandleFunc("/", handleRoot)

	if certFile != "" && keyFile != "" {
		// Tier 2: HTTPS. Optionally an HTTP->HTTPS redirect (off by default so it
		// doesn't clash with the router's own admin UI on :80).
		if redirAddr != "" {
			go func() {
				log.Printf("iColor handoff: HTTP redirect on %s -> HTTPS", redirAddr)
				if err := http.ListenAndServe(redirAddr, http.HandlerFunc(redirectToHTTPS)); err != nil {
					log.Printf("http redirect server stopped: %v", err)
				}
			}()
		}
		log.Printf("iColor handoff: HTTPS on %s  (dir=%s)", addrHTTPS, storageDir)
		log.Fatal(http.ListenAndServeTLS(addrHTTPS, certFile, keyFile, mux))
	}
	// Tier 0: plain HTTP (loopback / hotspot LAN).
	log.Printf("iColor handoff: HTTP on %s  (dir=%s)", addrHTTP, storageDir)
	log.Fatal(http.ListenAndServe(addrHTTP, mux))
}

func redirectToHTTPS(w http.ResponseWriter, r *http.Request) {
	host := r.Host
	if i := strings.IndexByte(host, ':'); i >= 0 {
		host = host[:i]
	}
	port := strings.TrimPrefix(addrHTTPS, ":")
	target := "https://" + host
	if port != "" && port != "443" {
		target += ":" + port
	}
	http.Redirect(w, r, target+r.URL.RequestURI(), http.StatusMovedPermanently)
}

// ---- CORS + Private Network Access (so an HTTPS kiosk app may upload) ----
func setCORS(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	// Chrome Private Network Access: a public (HTTPS) page reaching this local box
	// sends a preflight that requires this header on the response.
	w.Header().Set("Access-Control-Allow-Private-Network", "true")
	w.Header().Set("Access-Control-Max-Age", "86400")
}

func handleHandoff(w http.ResponseWriter, r *http.Request) {
	setCORS(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	mr, err := r.MultipartReader()
	if err != nil {
		http.Error(w, "expected multipart/form-data", http.StatusBadRequest)
		return
	}
	code, dir, err := newCodeDir()
	if err != nil {
		http.Error(w, "server busy", http.StatusInternalServerError)
		return
	}
	meta := map[string]any{"created": time.Now().Format(time.RFC3339)}
	var total int64
	var count int
	fail := func(status int, msg string) {
		_ = os.RemoveAll(dir)
		http.Error(w, msg, status)
	}
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			fail(http.StatusBadRequest, "bad upload")
			return
		}
		name := part.FileName()
		if name == "" {
			// small text field (loc / locn / info) — capture into meta, cap the size
			// ("info" carries the branding + shop-the-look JSON incl. an inline logo).
			limit := int64(4096)
			if part.FormName() == "info" {
				limit = 256 << 10
			}
			val, _ := io.ReadAll(io.LimitReader(part, limit))
			meta[part.FormName()] = string(val)
			part.Close()
			continue
		}
		safe := sanitizeName(name)
		dst, err := os.Create(filepath.Join(dir, safe))
		if err != nil {
			part.Close()
			fail(http.StatusInternalServerError, "write failed")
			return
		}
		// Stream to disk, enforcing the global size cap.
		n, err := io.Copy(dst, io.LimitReader(part, maxBytes-total+1))
		dst.Close()
		part.Close()
		total += n
		if err != nil || total > maxBytes {
			fail(http.StatusRequestEntityTooLarge, "too large")
			return
		}
		count++
	}
	if count == 0 {
		fail(http.StatusBadRequest, "no files")
		return
	}
	if b, err := json.Marshal(meta); err == nil {
		_ = os.WriteFile(filepath.Join(dir, "meta.json"), b, 0o644)
	}
	url := galleryURL(r, code)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "code": code, "url": url, "count": count})
	log.Printf("handoff %s: %d file(s), %d bytes, loc=%v", code, count, total, meta["loc"])
}

func galleryURL(r *http.Request, code string) string {
	base := strings.TrimRight(publicBase, "/")
	if base == "" {
		scheme := "http"
		if r.TLS != nil {
			scheme = "https"
		}
		base = scheme + "://" + r.Host
	}
	return base + "/g/" + code
}

// ---- Gallery + file serving ----
func handleGallery(w http.ResponseWriter, r *http.Request) {
	code := sanitizeCode(strings.TrimPrefix(r.URL.Path, "/g/"))
	if code == "" {
		http.NotFound(w, r)
		return
	}
	dir := filepath.Join(storageDir, code)
	files, err := listMedia(dir)
	if err != nil || len(files) == 0 {
		writeHTML(w, http.StatusNotFound, pageExpired())
		return
	}
	writeHTML(w, http.StatusOK, pageGallery(code, files, loadInfo(dir)))
}

// ---- branding / shop-the-look payload the kiosk sends with an upload ----
type shadeInfo struct {
	Name   string `json:"name"`
	Hex    string `json:"hex"`
	BuyURL string `json:"buyUrl"`
	Price  string `json:"price"`
}
type handoffInfo struct {
	Lang     string      `json:"lang"`
	Currency string      `json:"currency"`
	Brand    string      `json:"brand"`
	Logo     string      `json:"logo"`
	Shades   []shadeInfo `json:"shades"`
	Promo    *struct {
		Title   string `json:"title"`
		Message string `json:"message"`
	} `json:"promo"`
	Coupon *struct {
		Code  string `json:"code"`
		Label string `json:"label"`
		Terms string `json:"terms"`
	} `json:"coupon"`
}

func loadInfo(dir string) *handoffInfo {
	b, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	if err != nil {
		return nil
	}
	var m map[string]string
	if json.Unmarshal(b, &m) != nil || m["info"] == "" {
		return nil
	}
	var info handoffInfo
	if json.Unmarshal([]byte(m["info"]), &info) != nil {
		return nil
	}
	return &info
}

func handleFile(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/f/")
	slash := strings.IndexByte(rest, '/')
	if slash < 0 {
		http.NotFound(w, r)
		return
	}
	code := sanitizeCode(rest[:slash])
	name := sanitizeName(rest[slash+1:])
	if code == "" || name == "" {
		http.NotFound(w, r)
		return
	}
	p := filepath.Join(storageDir, code, name)
	f, err := os.Open(p)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", contentType(name))
	if r.URL.Query().Get("dl") != "" {
		w.Header().Set("Content-Disposition", "attachment; filename=\""+name+"\"")
	}
	http.ServeContent(w, r, name, st.ModTime(), f)
}

func handleZip(w http.ResponseWriter, r *http.Request) {
	code := sanitizeCode(strings.TrimPrefix(r.URL.Path, "/z/"))
	if code == "" {
		http.NotFound(w, r)
		return
	}
	dir := filepath.Join(storageDir, code)
	files, err := listMedia(dir)
	if err != nil || len(files) == 0 {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", "attachment; filename=\"icolor-"+code+".zip\"")
	zw := zip.NewWriter(w)
	defer zw.Close()
	for _, name := range files {
		fw, err := zw.Create(name)
		if err != nil {
			return
		}
		f, err := os.Open(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		_, _ = io.Copy(fw, f)
		f.Close()
	}
}

func handleRoot(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	writeHTML(w, http.StatusOK, pageRoot())
}

// ---- helpers ----
func newCodeDir() (string, string, error) {
	for attempt := 0; attempt < 40; attempt++ {
		code, err := randomCode()
		if err != nil {
			return "", "", err
		}
		dir := filepath.Join(storageDir, code)
		if err := os.Mkdir(dir, 0o755); err == nil {
			return code, dir, nil
		} else if !os.IsExist(err) {
			return "", "", err
		}
	}
	return "", "", errors.New("could not allocate a code")
}

func randomCode() (string, error) {
	b := make([]byte, codeLen)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	out := make([]byte, codeLen)
	for i, v := range b {
		out[i] = codeAlphabet[int(v)%len(codeAlphabet)]
	}
	return string(out), nil
}

func sanitizeCode(s string) string {
	s = strings.TrimRight(s, "/")
	if len(s) == 0 || len(s) > 12 {
		return ""
	}
	for _, c := range s {
		if !strings.ContainsRune(codeAlphabet, c) {
			return ""
		}
	}
	return s
}

func sanitizeName(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.TrimSpace(name)
	if name == "" || name == "." || name == ".." || strings.HasPrefix(name, ".") || name == "meta.json" {
		return "capture-" + time.Now().Format("150405.000")
	}
	// keep it simple + safe
	var b strings.Builder
	for _, c := range name {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '.' || c == '-' || c == '_':
			b.WriteRune(c)
		default:
			b.WriteByte('_')
		}
	}
	out := b.String()
	if len(out) > 80 {
		out = out[len(out)-80:]
	}
	return out
}

func listMedia(dir string) ([]string, error) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range ents {
		if e.IsDir() || e.Name() == "meta.json" {
			continue
		}
		out = append(out, e.Name())
	}
	return out, nil
}

func contentType(name string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".png":
		return "image/png"
	case ".webp":
		return "image/webp"
	case ".gif":
		return "image/gif"
	case ".webm":
		return "video/webm"
	case ".mp4":
		return "video/mp4"
	case ".mov":
		return "video/quicktime"
	}
	if ct := mime.TypeByExtension(filepath.Ext(name)); ct != "" {
		return ct
	}
	return "application/octet-stream"
}

func isVideo(name string) bool {
	return strings.HasPrefix(contentType(name), "video/")
}

func writeHTML(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}

// ---- purge ----
func purgeLoop() {
	purgeOnce()
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for range t.C {
		purgeOnce()
	}
}

func purgeOnce() {
	ents, err := os.ReadDir(storageDir)
	if err != nil {
		return
	}
	now := time.Now()
	today := now.Format("2006-01-02")
	for _, e := range ents {
		if !e.IsDir() {
			continue
		}
		p := filepath.Join(storageDir, e.Name())
		info, err := e.Info()
		if err != nil {
			continue
		}
		remove := false
		if retHours > 0 {
			if now.Sub(info.ModTime()) > time.Duration(retHours)*time.Hour {
				remove = true
			}
		} else if eodPurge {
			if info.ModTime().Format("2006-01-02") != today {
				remove = true
			}
		}
		if remove {
			if err := os.RemoveAll(p); err == nil {
				log.Printf("purged %s", e.Name())
			}
		}
	}
}

// ---- pages (self-contained, no external assets — works fully offline) ----
const pageCSS = `*{box-sizing:border-box}body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0d0f0a;color:#f5f0f7}
.wrap{max-width:640px;margin:0 auto;padding:20px 16px 60px}
.top{display:flex;align-items:center;gap:10px;padding:6px 0 14px}
.dot{width:10px;height:10px;border-radius:50%;background:#7ac943;box-shadow:0 0 0 4px rgba(122,201,67,.18)}
h1{font-size:20px;margin:0}
.sub{color:#a99fb8;font-size:13.5px;margin:2px 0 18px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:420px){.grid{grid-template-columns:1fr}}
.card{background:#151810;border:1px solid rgba(255,255,255,.12);border-radius:16px;overflow:hidden}
.card img,.card video{width:100%;display:block;background:#000;aspect-ratio:3/4;object-fit:cover}
.card .row{display:flex;gap:8px;padding:10px}
.btn{flex:1;text-align:center;text-decoration:none;padding:10px 8px;border-radius:10px;font-weight:700;font-size:14px;border:0;cursor:pointer}
.btn.p{background:linear-gradient(135deg,#5f7d2e,#b8942f);color:#fff}
.btn.g{background:rgba(255,255,255,.08);color:#f5f0f7}
.all{display:block;text-align:center;text-decoration:none;margin:18px 0 6px;padding:14px;border-radius:12px;background:rgba(255,255,255,.06);color:#f5f0f7;font-weight:700}
.tip{background:rgba(184,148,47,.12);border:1px solid rgba(184,148,47,.35);border-radius:12px;padding:12px 14px;font-size:13px;color:#e8dcc0;margin:0 0 18px}
.foot{color:#6f677d;font-size:12px;text-align:center;margin-top:26px}
.big{text-align:center;padding:60px 16px}.big .e{font-size:52px}
.brand{display:flex;align-items:center;gap:10px;margin:0 0 4px}
.brand img{height:34px;width:auto;background:transparent}
.brand-name{font-weight:800;font-size:15px;color:#e8dcc0}
.btn.share{background:linear-gradient(135deg,#3fa7a0,#4f8f52);color:#fff;display:none;width:100%;margin:16px 0 0;padding:14px;border-radius:12px;font-weight:800;font-size:15px;border:0;cursor:pointer}
.btn.share:disabled{opacity:.6}
.sec{margin:26px 0 10px;font-size:16px;font-weight:800}
.shop{display:flex;flex-direction:column;gap:10px}
.shop-item{display:flex;align-items:center;gap:12px;background:#151810;border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:10px 12px}
.sw{width:34px;height:34px;border-radius:50%;flex:0 0 auto;border:1px solid rgba(255,255,255,.25)}
.shop-item .n{flex:1;min-width:0}
.shop-item .n b{display:block;font-size:14.5px}
.shop-item .n span{color:#a99fb8;font-size:12.5px}
.shop-item .buy{background:linear-gradient(135deg,#5f7d2e,#b8942f);color:#fff;text-decoration:none;padding:9px 14px;border-radius:10px;font-weight:700;font-size:13.5px;white-space:nowrap}
.promo{background:linear-gradient(135deg,rgba(95,125,46,.25),rgba(184,148,47,.25));border:1px solid rgba(184,148,47,.4);border-radius:14px;padding:14px;margin:16px 0}
.promo b{display:block;font-size:15px}
.promo span{color:#d8cbe0;font-size:13px}
.coupon{border:1px dashed rgba(184,148,47,.7);border-radius:14px;padding:14px;text-align:center;margin:16px 0}
.coupon .code{font-size:22px;font-weight:800;letter-spacing:2px;color:#b8942f}
.coupon .lbl{font-size:13px;color:#e8dcc0}
.coupon .terms{font-size:11px;color:#6f677d;margin-top:4px}`

func pageHead(title string) string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
		`<meta name="viewport" content="width=device-width,initial-scale=1">` +
		`<title>` + title + `</title><style>` + pageCSS + `</style></head><body><div class="wrap">`
}

func pageFoot() string {
	return `<p class="foot">iColor Plus · photos kept on this on-site box only, auto-deleted at end of day.</p></div></body></html>`
}

func pageGallery(code string, files []string, info *handoffInfo) string {
	he := html.EscapeString
	lang := "en"
	if info != nil && info.Lang == "tl" {
		lang = "tl"
	}
	L := func(k string) string { return tr(lang, k) }

	var b strings.Builder
	b.WriteString(pageHead(L("ready")))
	// Branding (logo if the kiosk sent one, else the store name).
	if info != nil && (info.Logo != "" || info.Brand != "") {
		b.WriteString(`<div class="brand">`)
		if info.Logo != "" {
			b.WriteString(`<img src="` + he(info.Logo) + `" alt="logo">`)
		} else {
			b.WriteString(`<span class="brand-name">` + he(info.Brand) + `</span>`)
		}
		b.WriteString(`</div>`)
	}
	b.WriteString(`<div class="top"><span class="dot"></span><h1>` + he(L("ready")) + `</h1></div>`)
	b.WriteString(`<p class="sub">` + he(L("code")) + ` ` + he(code) + ` · ` + itoa(len(files)) + ` ` + he(L("items")) + `</p>`)
	b.WriteString(`<div class="tip">` + L("tip") + `</div>`)

	b.WriteString(`<div class="grid">`)
	var imgSrcs []string
	for _, name := range files {
		src := "/f/" + code + "/" + name
		b.WriteString(`<div class="card">`)
		if isVideo(name) {
			b.WriteString(`<video src="` + src + `" controls playsinline></video>`)
		} else {
			imgSrcs = append(imgSrcs, src)
			b.WriteString(`<a href="` + src + `" target="_blank" rel="noopener"><img src="` + src + `" alt="capture" loading="lazy"></a>`)
		}
		b.WriteString(`<div class="row">`)
		b.WriteString(`<a class="btn g" href="` + src + `" target="_blank" rel="noopener">` + he(L("open")) + `</a>`)
		b.WriteString(`<a class="btn p" href="` + src + `?dl=1" download="` + name + `">` + he(L("save")) + `</a>`)
		b.WriteString(`</div></div>`)
	}
	b.WriteString(`</div>`)

	// One-tap "Save all to Photos" (native share; shown by the script only where
	// the browser supports sharing files — i.e. the HTTPS Tier-2 box).
	if len(imgSrcs) > 0 {
		b.WriteString(`<button id="saveAll" class="btn share">` + he(L("save_all")) + `</button>`)
	}
	if len(files) > 1 {
		b.WriteString(`<a class="all" href="/z/` + code + `">` + he(L("download_all")) + `</a>`)
	}

	// Shop the look.
	if info != nil && len(info.Shades) > 0 {
		b.WriteString(`<div class="sec">` + he(L("shop")) + `</div><div class="shop">`)
		for _, s := range info.Shades {
			b.WriteString(`<div class="shop-item"><span class="sw" style="background:` + he(s.Hex) + `"></span>`)
			b.WriteString(`<div class="n"><b>` + he(s.Name) + `</b>`)
			if s.Price != "" {
				b.WriteString(`<span>` + he(info.Currency) + he(s.Price) + `</span>`)
			}
			b.WriteString(`</div>`)
			if s.BuyURL != "" {
				b.WriteString(`<a class="buy" href="` + he(s.BuyURL) + `" target="_blank" rel="noopener">` + he(L("buy")) + `</a>`)
			}
			b.WriteString(`</div>`)
		}
		b.WriteString(`</div>`)
	}
	// Promo.
	if info != nil && info.Promo != nil && (info.Promo.Title != "" || info.Promo.Message != "") {
		b.WriteString(`<div class="promo"><b>` + he(info.Promo.Title) + `</b><span>` + he(info.Promo.Message) + `</span></div>`)
	}
	// Coupon.
	if info != nil && info.Coupon != nil && info.Coupon.Code != "" {
		b.WriteString(`<div class="coupon"><div class="code">` + he(info.Coupon.Code) + `</div>`)
		if info.Coupon.Label != "" {
			b.WriteString(`<div class="lbl">` + he(info.Coupon.Label) + `</div>`)
		}
		if info.Coupon.Terms != "" {
			b.WriteString(`<div class="terms">` + he(info.Coupon.Terms) + `</div>`)
		}
		b.WriteString(`</div>`)
	}

	b.WriteString(`<p class="foot">` + he(L("foot")) + `</p></div>`)
	// Save-all-to-Photos script.
	imgJSON, _ := json.Marshal(imgSrcs)
	b.WriteString(`<script>(function(){var imgs=` + string(imgJSON) + `;var btn=document.getElementById('saveAll');` +
		`if(!btn||!imgs.length||!(navigator.canShare&&navigator.share&&window.File))return;btn.style.display='block';` +
		`btn.addEventListener('click',async function(){btn.disabled=true;var o=btn.textContent;btn.textContent='…';try{var fs=[];` +
		`for(var i=0;i<imgs.length;i++){var r=await fetch(imgs[i]);var bl=await r.blob();fs.push(new File([bl],'icolor-'+(i+1)+'.jpg',{type:bl.type||'image/jpeg'}));}` +
		`if(navigator.canShare({files:fs})){await navigator.share({files:fs});}else{btn.style.display='none';}}catch(e){}btn.disabled=false;btn.textContent=o;});})();</script>`)
	b.WriteString(`</body></html>`)
	return b.String()
}

// ---- guest-page localization (en / tl) ----
var guestI18N = map[string]map[string]string{
	"en": {
		"ready":        "Your photos are ready",
		"code":         "Code",
		"items":        "item(s) · save the ones you want",
		"tip":          `📱 <b>iPhone:</b> tap “Open”, then press &amp; hold the photo → <b>Add to Photos</b>. <b>Android:</b> tap “Save”.`,
		"open":         "Open",
		"save":         "Save",
		"save_all":     "⬇ Save all to Photos",
		"download_all": "⬇ Download all (.zip)",
		"shop":         "Shop the look",
		"buy":          "Buy",
		"foot":         "Photos are kept on the on-site box only and auto-deleted at end of day.",
	},
	"tl": {
		"ready":        "Handa na ang mga larawan mo",
		"code":         "Code",
		"items":        "item · i-save ang gusto mo",
		"tip":          `📱 <b>iPhone:</b> i-tap ang “Open”, tapos pindutin nang matagal ang larawan → <b>Add to Photos</b>. <b>Android:</b> i-tap ang “Save”.`,
		"open":         "Buksan",
		"save":         "I-save",
		"save_all":     "⬇ I-save lahat sa Photos",
		"download_all": "⬇ I-download lahat (.zip)",
		"shop":         "Bilhin ang hitsura",
		"buy":          "Bilhin",
		"foot":         "Nasa on-site box lang ang mga larawan at awtomatikong buburahin sa katapusan ng araw.",
	},
}

func tr(lang, key string) string {
	if m, ok := guestI18N[lang]; ok {
		if v, ok := m[key]; ok && v != "" {
			return v
		}
	}
	return guestI18N["en"][key]
}

func pageExpired() string {
	return pageHead("Not found") +
		`<div class="big"><div class="e">🕓</div><h1>These photos aren’t here</h1>` +
		`<p class="sub">The link may have expired (photos are cleared at end of day) or the code is wrong. Please ask the display for a new code.</p></div>` +
		pageFoot()
}

func pageRoot() string {
	return pageHead("iColor photo box") +
		`<div class="big"><div class="e">✅</div><h1>Connected to the iColor photo box</h1>` +
		`<p class="sub">Scan the QR shown on the display to get your photos.</p></div>` +
		pageFoot()
}

func itoa(n int) string { return fmt.Sprintf("%d", n) }
