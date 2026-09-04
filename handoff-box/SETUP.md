# iColor Plus — "Send to my phone" (offline photo handoff)

Let a guest pull their try-on **photos and videos onto their own phone** at an
event or retail display **with no internet at the venue**. The kiosk pushes the
session's media to a small on-site box; the guest scans a QR and downloads.

There are two deployment tiers. Pick per site by kiosk type:

| Tier | Kiosk types | The "box" | Guest gets photos by |
|------|-------------|-----------|----------------------|
| **Tier 2** | Android/iOS **tablets**, **Android-TV** (USB webcam) | a **GL.iNet router** (Beryl GL-MT1300) | joining the box Wi-Fi + scanning a QR |
| **Tier 0** | **Windows mini-PC** touchscreen | the **PC itself** (loopback) | joining the PC's Mobile Hotspot + scanning a QR |

> **Why a box at all?** A browser tab can't be a Wi-Fi hotspot or a file server,
> and the try-on runs over HTTPS (the camera requires it). An HTTPS page is
> blocked from uploading to a plain-HTTP device — so on tablets/TVs the box needs
> **real, browser-trusted HTTPS while offline**. We get that free with a DuckDNS
> name + a Let's Encrypt certificate (a cert validates by date + signature, not by
> internet — so it's trusted offline for its 90-day life). On a Windows mini-PC we
> sidestep it entirely by serving on `localhost`, which browsers treat as secure.

---

## Tier 2 — GL.iNet Beryl (tablets & Android-TV kiosks)

### Parts (per site)
- **GL.iNet GL-MT1300 "Beryl"** router (available on Lazada/Shopee PH).
- A **microSD card** (8–32 GB is plenty) for photo storage.
- A free **DuckDNS** subdomain (below). One domain can serve every site.

### A. Get a free DuckDNS name + token
1. Go to <https://www.duckdns.org>, sign in (GitHub/Google).
2. Create a subdomain, e.g. **`icolorkiosk`** → your name is `icolorkiosk.duckdns.org`.
3. Copy your **token** (top of the page). You'll need it once, to issue the cert.

> The DuckDNS *public* record doesn't matter for us — we override the name to the
> box's LAN IP locally (step D). DuckDNS is only used to prove domain control so
> Let's Encrypt will issue the cert.

### B. First-time router setup (do this once, at the office, with internet)
1. Power the Beryl, connect to its Wi-Fi (label on the box), open <http://192.168.8.1>.
2. Set an **admin password**. Give it internet (WAN cable, or Repeater/Tethering to office Wi-Fi) — needed **only** for provisioning.
3. Set the **guest Wi-Fi** name + password you want at the booth, e.g.
   SSID **`iColor-Kiosk`**, password **`greatlengths`**. Note them for the kiosk config.
4. Note the LAN IP — default **`192.168.8.1`**.

### C. Enable microSD storage
Insert the microSD. In the GL.iNet admin the card mounts automatically; via SSH
check the path:
```
ssh root@192.168.8.1
ls /mnt          # usually /mnt/mmcblk0p1 (microSD) or /mnt/sda1 (USB)
```
Use that path as `STORAGE` below (the examples assume `/mnt/mmcblk0p1`).

### D. Issue the Let's Encrypt certificate (via DuckDNS DNS-challenge)
Still over SSH, with internet attached:
```sh
# tools acme.sh needs
opkg update
opkg install openssl-util ca-bundle curl socat

# install acme.sh
wget -O - https://get.acme.sh | sh -s email=you@example.com
. ~/.acme.sh/acme.sh.env

# issue the cert for your DuckDNS name (DNS-01 — no open ports needed)
export DuckDNS_Token="PASTE-YOUR-DUCKDNS-TOKEN"
~/.acme.sh/acme.sh --issue --dns dns_duckdns -d icolorkiosk.duckdns.org --server letsencrypt

# install the cert where the handoff server will read it, and auto-restart on renew
mkdir -p /etc/icolor
~/.acme.sh/acme.sh --install-cert -d icolorkiosk.duckdns.org \
  --key-file       /etc/icolor/handoff.key \
  --fullchain-file /etc/icolor/fullchain.cer \
  --reloadcmd      "/etc/init.d/icolor-handoff restart"
```
acme.sh installs a daily cron that auto-renews (~every 60 days) whenever the box
has internet. See **Renewal** at the end.

### E. Point the name at the box on its own Wi-Fi (local DNS override)
So devices on the box Wi-Fi resolve `icolorkiosk.duckdns.org` → the box itself:
```sh
uci add_list dhcp.@dnsmasq[0].address='/icolorkiosk.duckdns.org/192.168.8.1'
uci commit dhcp
/etc/init.d/dnsmasq restart
```

### F. Install the handoff server + autostart
1. **Build the binary** for the Beryl (MediaTek MT7621 = `mipsle`). On any PC with
   [Go](https://go.dev/dl/) installed, from the `handoff-box/` folder:
   ```sh
   GOOS=linux GOARCH=mipsle GOMIPS=softfloat go build -trimpath -ldflags "-s -w" -o icolor-handoff .
   ```
   (A prebuilt binary may already be in `handoff-box/dist/` — see the repo.)
2. **Copy** the binary to the microSD and the init script into place:
   ```sh
   scp icolor-handoff root@192.168.8.1:/mnt/mmcblk0p1/
   scp openwrt/icolor-handoff root@192.168.8.1:/etc/init.d/icolor-handoff
   ```
3. On the router:
   ```sh
   chmod +x /mnt/mmcblk0p1/icolor-handoff /etc/init.d/icolor-handoff
   # if your microSD path differs, edit STORAGE at the top of /etc/init.d/icolor-handoff
   /etc/init.d/icolor-handoff enable
   /etc/init.d/icolor-handoff start
   logread -e icolor    # should show "HTTPS on :8443"
   ```

### G. Point the kiosks at the box
On each tablet / Android-TV kiosk, open **Super Admin → Content & config**:
- Turn on the **"Send to my phone"** feature (Features tab).
- **Send to my phone** card:
  - **Box URL:** `https://icolorkiosk.duckdns.org:8443`
  - **Box Wi-Fi name (SSID):** `iColor-Kiosk`
  - **Box Wi-Fi password:** `greatlengths`
  - **Button label:** `Send to my phone` (or your wording)
- Save. Then **connect each kiosk to the box Wi-Fi** (so the kiosk and the guests
  share the box's LAN). The try-on app keeps running from its offline cache.

### H. Test
1. On a kiosk, do a try-on, take a photo, open **Your Captures → Send to my phone**.
2. It should show a **Wi-Fi-join QR** and a **photos QR**.
3. On a phone: scan the join QR (connects to `iColor-Kiosk`), then scan the photos
   QR → a gallery opens at `https://icolorkiosk.duckdns.org:8443/g/XXXX` with
   **Save** buttons. Save a photo; play/save a video.

---

## Tier 0 — Windows mini-PC (self-host, no extra hardware, ₱0)

The PC runs the box on `localhost` and shares its own **Mobile Hotspot**.

1. **Build** the server (once), with [Go](https://go.dev/dl/) installed, from `handoff-box/`:
   ```powershell
   go build -o icolor-handoff.exe .
   ```
2. **Turn on Mobile Hotspot:** Windows Settings → *Network & internet* → *Mobile
   hotspot* → On. Note the **hotspot SSID + password**. Find the hotspot IP with
   `ipconfig` (the "Local Area Connection*" adapter — usually **`192.168.137.1`**).
3. **Run the server**, telling it the guest-facing address (the hotspot IP):
   ```powershell
   .\icolor-handoff.exe -http :8787 -base http://192.168.137.1:8787
   ```
   (To auto-start on boot, drop a shortcut with those args in `shell:startup`, or
   register a Scheduled Task at logon.)
4. **Point the kiosk** (Super Admin → Send to my phone):
   - **Box URL:** `http://localhost:8787`   ← the kiosk uploads over loopback
   - **Box Wi-Fi name (SSID):** your hotspot name
   - **Box Wi-Fi password:** your hotspot password
   - Save.

The kiosk uploads to `localhost` (allowed — loopback is a secure context); the QR
sent to the guest points at `http://192.168.137.1:8787/g/XXXX`, which they reach
over the hotspot. No certificate needed.

---

## How it behaves
- **Storage & privacy:** media lives only on the box; nothing goes to the cloud.
  Files are **auto-deleted at end of day** (`-end-of-day`, the default). To keep
  for a fixed window instead, run with e.g. `-retention-hours 6`.
- **Codes:** each handoff gets a short unambiguous code (e.g. `K7Q2`); the gallery
  is at `/g/<code>`. Codes are the only access control — fine for a walk-up booth
  on a local, internet-less Wi-Fi.
- **Size cap:** 250 MB per handoff by default (`-max-bytes`).

## Renewal (Tier 2 only)
The Let's Encrypt cert lasts 90 days. acme.sh auto-renews (~day 60) **whenever the
box has internet**. In practice: about once a month, give the box internet for a
minute (plug in WAN, or use its Repeater mode near any Wi-Fi). If a site is truly
never online, bring the box to the office every ~8 weeks — it renews on its own.
Force a renew + check:
```sh
~/.acme.sh/acme.sh --renew -d icolorkiosk.duckdns.org --force
```

## Troubleshooting
- **Kiosk says "Couldn't reach the photo box":** the kiosk isn't on the box Wi-Fi,
  the Box URL/port is wrong, or the server isn't running (`logread -e icolor`).
- **iPhone won't open the gallery / cert warning:** the name isn't resolving to the
  box — recheck the dnsmasq `address=` line (step E) and that the phone is on the
  box Wi-Fi. The URL must use the **DuckDNS name**, never a bare IP (a cert can't
  cover an IP).
- **"Mixed content" / upload blocked in the kiosk console:** the Box URL must be
  **https** (Tier 2) or **http://localhost** (Tier 0) — a plain `http://<ip>` box
  URL will be blocked from the HTTPS app.
- **Android-TV note:** the TV never scans anything — only the guest's phone does.
  The TV just uploads and shows the QR, so its USB webcam is only used by the
  try-on itself.
