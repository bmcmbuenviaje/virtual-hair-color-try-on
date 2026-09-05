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
- A **GL.iNet router** running its OpenWrt firmware. Any of these work — pick by
  price/availability. Note the **CPU**, it decides which binary you run:

  | Model | Wi-Fi | CPU / binary | Storage on it |
  |-------|-------|--------------|----------------|
  | GL-MT1300 **Beryl** | AC | MIPS → `mipsle` | microSD slot |
  | GL-MT300N-V2 **Mango** (budget) | N | MIPS → `mipsle` | USB only (16 MB flash — cramped) |
  | GL-MT3000 **Beryl AX** | **Wi-Fi 6** | **ARM64** → `arm64` | **USB only** (no microSD) |
  | GL-AXT1800 **Slate AX** | **Wi-Fi 6** | **ARM64** → `arm64` | **microSD + USB 3.0** |

- **Storage:** a **microSD** card (8–32 GB) if the model has a slot, otherwise a
  small **USB flash drive**. Only a few photos live on it at a time.
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

### C. Enable storage (microSD or USB)
Insert the microSD **or** plug in a USB flash drive (Beryl AX has no card slot —
use USB). GL.iNet mounts it automatically; via SSH check the path:
```
ssh root@192.168.8.1
ls /mnt          # microSD → /mnt/mmcblk0p1   ·   USB stick → /mnt/sda1
```
Use that path as `STORAGE` below. Examples assume `/mnt/mmcblk0p1`; on the
**Beryl AX (USB)** it's typically `/mnt/sda1` — set it in the init script.

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
1. **Build the binary for your model's CPU** (see the parts table). On any PC with
   [Go](https://go.dev/dl/) installed, from the `handoff-box/` folder:
   ```sh
   # ARM64 models — Beryl AX (GL-MT3000), Slate AX (GL-AXT1800):
   GOOS=linux GOARCH=arm64 go build -trimpath -ldflags "-s -w" -o icolor-handoff .

   # MIPS models — Beryl (GL-MT1300), Mango (GL-MT300N-V2):
   GOOS=linux GOARCH=mipsle GOMIPS=softfloat go build -trimpath -ldflags "-s -w" -o icolor-handoff .
   ```
   (Binaries aren't committed to keep the repo light. Each build is ~7–8 MB and
   statically linked — no runtime to install on the router.)
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

### Mango (GL-MT300N-V2) — 16 MB flash: run everything from the USB stick
The Mango is the **cheapest** box (~₱1,200), but its 16 MB flash is too small for
the binary + captures — so keep those on a **USB flash drive** and point acme.sh
at the stick too. It's MIPS, so use the **`mipsle`** binary (same one as the
MT1300). Everything below **replaces** steps C/D/F for the Mango; A, B, E, G, H
are unchanged.

```sh
ssh root@192.168.8.1

# 1) Confirm the USB stick mounted (GL.iNet automounts it):
ls /mnt            # expect: sda1     →  we'll use /mnt/sda1
mkdir -p /mnt/sda1/icolor /mnt/sda1/captures

# 2) Cert via DuckDNS DNS-01 — acme.sh lives on the stick, not flash.
#    (DNS mode needs only curl + openssl, already in the firmware. If you hit a
#     TLS-trust error, run:  opkg update && opkg install ca-bundle )
export DuckDNS_Token="PASTE-YOUR-DUCKDNS-TOKEN"
wget -O - https://get.acme.sh | sh -s -- --home /mnt/sda1/.acme.sh --accountemail you@example.com
/mnt/sda1/.acme.sh/acme.sh --home /mnt/sda1/.acme.sh \
  --issue --dns dns_duckdns -d icolorkiosk.duckdns.org --server letsencrypt
/mnt/sda1/.acme.sh/acme.sh --home /mnt/sda1/.acme.sh \
  --install-cert -d icolorkiosk.duckdns.org \
  --key-file       /mnt/sda1/icolor/handoff.key \
  --fullchain-file /mnt/sda1/icolor/fullchain.cer \
  --reloadcmd      "/etc/init.d/icolor-handoff restart"
```

Then copy the **MIPS** binary + init script (from your PC):
```sh
scp icolor-handoff root@192.168.8.1:/mnt/sda1/
scp openwrt/icolor-handoff root@192.168.8.1:/etc/init.d/icolor-handoff
```

On the router, edit `/etc/init.d/icolor-handoff` so the top reads:
```sh
STORAGE=/mnt/sda1
BIN=$STORAGE/icolor-handoff
CERTDIR=/mnt/sda1/icolor
```
Then:
```sh
chmod +x /mnt/sda1/icolor-handoff /etc/init.d/icolor-handoff
/etc/init.d/icolor-handoff enable
/etc/init.d/icolor-handoff start
logread -e icolor      # should show "HTTPS on :8443"
```

Everything else (DuckDNS name, the dnsmasq override in step E, the kiosk config in
step G, testing in H) is the same. Kiosk **Box URL** stays
`https://icolorkiosk.duckdns.org:8443`.

> Note: the stock init script's `CERTDIR` is `/etc/icolor`; the Mango override
> above moves it to `/mnt/sda1/icolor` so nothing is written to the tiny flash.

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
