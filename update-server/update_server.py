#!/usr/bin/env python3
"""
AuraWave App Update Server
==========================

A tiny, dependency-light update server for the AuraWave Android app.

What it does
------------
1. You drop a built ``app-debug.apk`` (or any ``*.apk``) into this folder.
2. You run this script (double-click ``run_update_server.bat`` on Windows).
3. It prints a **QR code** in the terminal (and serves a ``/qr`` web page).
4. In the AuraWave app you tap the **"Check for App Update"** button and scan
   the QR. The app fetches ``/update.json`` from this server, and if the APK is
   newer than the installed build it downloads and installs it.

Endpoints
---------
  GET /              -> human-readable status page
  GET /update.json   -> UpdateInfo JSON the app's AppUpdateManager expects
  GET /version.json  -> alias of /update.json
  GET /update.apk    -> downloads the APK
  GET /app-debug.apk -> alias of /update.apk
  GET /qr            -> web page showing the connect URL + a scannable QR
  GET /health        -> {"status":"ok"}

Run it
------
    python update_server.py                      # serve APKs from this folder
    python update_server.py --dir "D:\\builds"     # serve APKs from a folder
    python update_server.py --port 9696

Only the Python standard library is required. A terminal QR code is drawn if the
optional ``qrcode`` package is available (the launcher installs it); otherwise
the URL is printed prominently and the ``/qr`` page still works.
"""

import argparse
import glob
import json
import os
import socket
import sys
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Folder scanned for APKs and the release-notes file. Set in main().
APK_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_URL = "http://127.0.0.1:9696"
STREAM_CHUNK_SIZE = 64 * 1024

# Optional pretty terminal QR (installed by run_update_server.bat if missing).
try:
    import qrcode  # type: ignore
except Exception:
    qrcode = None


def get_lan_ip() -> str:
    """Best-effort discovery of this machine's LAN IP (no packets are sent)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except Exception:
        try:
            ip = socket.gethostbyname(socket.gethostname())
        except Exception:
            ip = "127.0.0.1"
    finally:
        s.close()
    return ip


def find_apk():
    """Return the newest ``*.apk`` under APK_DIR (and an optional ./apk subdir).

    Returns the absolute path, or None if no APK is present.
    """
    patterns = [
        os.path.join(APK_DIR, "*.apk"),
        os.path.join(APK_DIR, "apk", "*.apk"),
    ]
    candidates = []
    for pattern in patterns:
        candidates.extend(glob.glob(pattern))
    if not candidates:
        return None
    # Newest by modification time wins (a freshly copied build is "the update").
    return max(candidates, key=os.path.getmtime)


def apk_version_code(apk_path):
    """Read the real android:versionCode straight from the APK's binary manifest.

    This is the ground truth — independent of file timestamps or the sidecar — so any
    APK dropped into the folder advertises its genuine version. Returns int or None.
    """
    import struct
    import zipfile
    try:
        with zipfile.ZipFile(apk_path) as z:
            data = z.read("AndroidManifest.xml")
    except Exception:
        return None
    try:
        ATTR_VERSIONCODE = 0x0101021B
        if len(data) < 8:
            return None
        pos = 8  # skip the file chunk header (type u16, headerSize u16, size u32)
        res_ids = None
        while pos + 8 <= len(data):
            ctype, chdr, csize = struct.unpack_from("<HHI", data, pos)
            if csize < 8:
                break
            if ctype == 0x0180:  # RES_XML_RESOURCE_MAP_TYPE
                count = (csize - 8) // 4
                res_ids = list(struct.unpack_from("<%dI" % count, data, pos + 8))
            elif ctype == 0x0102:  # RES_XML_START_ELEMENT_TYPE (first = <manifest>)
                ext = pos + chdr
                attr_start, attr_size, attr_count = struct.unpack_from("<HHH", data, ext + 8)
                attrs = ext + attr_start
                if res_ids is not None:
                    try:
                        vc_idx = res_ids.index(ATTR_VERSIONCODE)
                    except ValueError:
                        vc_idx = -1
                    if vc_idx >= 0:
                        for i in range(attr_count):
                            a = attrs + i * attr_size
                            a_name = struct.unpack_from("<i", data, a + 4)[0]
                            if a_name == vc_idx:
                                return int(struct.unpack_from("<I", data, a + 16)[0])
                return None  # only the first (manifest) element matters
            pos += csize
    except Exception:
        return None
    return None


def read_release_notes() -> str:
    """Release notes from release_notes.txt next to the APK, else a default."""
    notes_path = os.path.join(APK_DIR, "release_notes.txt")
    if os.path.isfile(notes_path):
        try:
            with open(notes_path, "r", encoding="utf-8") as f:
                text = f.read().strip()
                if text:
                    return text
        except OSError:
            pass
    return "Latest AuraWave build served from your local update server."


def find_sidecar_file():
    """Return the path to app-version.json next to the APK, or None."""
    for d in (APK_DIR, os.path.join(APK_DIR, "apk")):
        path = os.path.join(d, "app-version.json")
        if os.path.isfile(path):
            return path
    return None


def read_version_sidecar():
    """Read versionCode/versionName from app-version.json, or None if absent/invalid."""
    import json
    path = find_sidecar_file()
    if path:
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            return int(data["versionCode"]), str(data.get("versionName", "1.0.0"))
        except Exception:
            pass
    return None


def build_update_payload() -> dict:
    """Build the UpdateInfo JSON matching the app's model.

    Fields: versionCode, versionName, apkUrl, fileSizeBytes, releaseNotes.
    Prefers the real build versionCode from app-version.json — but only when that sidecar
    is at least as new as the APK. If a newer APK was dropped in manually (sidecar now
    stale), the APK's own modification time is used instead so the update is still offered.
    """
    apk = find_apk()
    if not apk:
        return {
            "versionCode": 0,
            "versionName": "0.0.0",
            "apkUrl": "",
            "fileSizeBytes": 0,
            "releaseNotes": "No APK found on the update server yet.",
        }
    sidecar = read_version_sidecar()
    real_vc = apk_version_code(apk)
    if real_vc is not None:
        # Ground truth: the APK's own versionCode. Use the sidecar's name if available.
        version_code = real_vc
        version_name = sidecar[1] if sidecar else f"1.0.0-build{real_vc}"
    else:
        # Couldn't parse the APK: fall back to sidecar (if fresh) then file mtime.
        apk_mtime = int(os.path.getmtime(apk))
        sidecar_file = find_sidecar_file()
        sidecar_fresh = (
            sidecar is not None
            and sidecar_file is not None
            and os.path.getmtime(sidecar_file) >= os.path.getmtime(apk) - 1
        )
        if sidecar_fresh:
            version_code, version_name = sidecar
        else:
            version_code, version_name = apk_mtime, f"1.0.0-build{apk_mtime}"
    return {
        "versionCode": version_code,
        "versionName": version_name,
        "apkUrl": f"{BASE_URL}/update.apk",
        "fileSizeBytes": os.path.getsize(apk),
        "releaseNotes": read_release_notes(),
    }


class UpdateHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "AuraWaveUpdate/1.0"

    # ---- header helpers --------------------------------------------------

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range, Content-Type")

    def _send_bytes(self, body: bytes, content_type: str, status=HTTPStatus.OK):
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_text(self, status, message):
        self._send_bytes(message.encode("utf-8"), "text/plain; charset=utf-8", status)

    # ---- verbs -----------------------------------------------------------

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            if path in ("/update.json", "/version.json"):
                body = json.dumps(build_update_payload(), indent=2).encode("utf-8")
                self._send_bytes(body, "application/json; charset=utf-8")
                return

            if path in ("/update.apk", "/app-debug.apk"):
                self._serve_apk()
                return

            if path in ("/qr", "/qr.html"):
                self._send_bytes(self._render_qr(), "text/html; charset=utf-8")
                return

            if path == "/health":
                self._send_bytes(b'{"status":"ok"}', "application/json; charset=utf-8")
                return

            if path in ("/", "/index.html"):
                self._send_bytes(self._render_index(), "text/html; charset=utf-8")
                return

            self._send_text(HTTPStatus.NOT_FOUND, "404 Not Found")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            try:
                self._send_text(HTTPStatus.INTERNAL_SERVER_ERROR, f"Server error: {exc}")
            except Exception:
                pass

    # ---- APK download ----------------------------------------------------

    def _serve_apk(self):
        apk = find_apk()
        if not apk:
            self._send_text(HTTPStatus.NOT_FOUND, "No APK available on the update server.")
            return
        try:
            size = os.path.getsize(apk)
        except OSError:
            self._send_text(HTTPStatus.NOT_FOUND, "APK file is not readable.")
            return

        self.send_response(HTTPStatus.OK)
        self._cors()
        self.send_header("Content-Type", "application/vnd.android.package-archive")
        self.send_header("Content-Length", str(size))
        self.send_header("Content-Disposition", 'attachment; filename="app-debug.apk"')
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        if self.command == "HEAD":
            return
        try:
            with open(apk, "rb") as f:
                while True:
                    chunk = f.read(STREAM_CHUNK_SIZE)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass

    # ---- HTML pages ------------------------------------------------------

    def _render_index(self) -> bytes:
        payload = build_update_payload()
        apk = find_apk()
        apk_name = os.path.basename(apk) if apk else "(none — drop an .apk in this folder)"
        page = f"""<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AuraWave Update Server</title>
<style>
  body {{ font-family:system-ui,sans-serif; margin:2rem; background:#111; color:#eee; }}
  h1 {{ color:#6cf; }} a {{ color:#9cf; }} code {{ background:#222; padding:2px 6px; border-radius:4px; }}
</style></head><body>
  <h1>AuraWave App Update Server</h1>
  <p>Status: <b>running</b></p>
  <p>APK: <code>{apk_name}</code></p>
  <p>Version code: <b>{payload['versionCode']}</b> &middot; Size: <b>{payload['fileSizeBytes']}</b> bytes</p>
  <p><a href="/qr">Show connect QR</a> &middot; <a href="/update.json">/update.json</a>
     &middot; <a href="/update.apk">/update.apk</a></p>
  <p>In the app: tap <b>Check for App Update</b> and scan the QR.</p>
</body></html>"""
        return page.encode("utf-8")

    def _render_qr(self) -> bytes:
        base_url = f"{BASE_URL}/"
        apk_url = f"{BASE_URL}/update.apk"

        def qr_src(data: str) -> str:
            enc = urllib.parse.quote(data, safe="")
            return f"https://api.qrserver.com/v1/create-qr-code/?size=300x300&data={enc}"

        page = f"""<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Get / Update AuraWave</title>
<style>
  body {{ font-family:system-ui,sans-serif; margin:2rem; background:#111; color:#eee; text-align:center; }}
  h1 {{ color:#6cf; }} h2 {{ color:#9cf; margin-bottom:.25rem; }}
  .cards {{ display:flex; flex-wrap:wrap; gap:2rem; justify-content:center; align-items:flex-start; }}
  .card {{ background:#1b1b1b; border-radius:16px; padding:1.5rem; max-width:360px; }}
  .url {{ font-size:1rem; font-weight:bold; color:#9cf; word-break:break-all; margin:.75rem 0; }}
  img {{ background:#fff; padding:10px; border-radius:12px; }}
  .hint {{ color:#aaa; font-size:.9rem; }}
  a.btn {{ display:inline-block; margin-top:.75rem; padding:.6rem 1.2rem; background:#1f8a4c;
           color:#fff; border-radius:10px; text-decoration:none; font-weight:bold; }}
</style></head><body>
  <h1>AuraWave</h1>
  <div class="cards">
    <div class="card">
      <h2>1. First install</h2>
      <p class="hint">App not installed yet? Scan with your phone's <b>normal camera</b>
         to download the APK, then tap it to install.</p>
      <img src="{qr_src(apk_url)}" alt="QR to download APK" width="300" height="300">
      <div class="url">{apk_url}</div>
      <a class="btn" href="/update.apk">Download APK</a>
    </div>
    <div class="card">
      <h2>2. In-app update</h2>
      <p class="hint">Already have AuraWave? Open it, tap <b>Check for App Update</b>,
         and scan this code.</p>
      <img src="{qr_src(base_url)}" alt="QR for in-app update" width="300" height="300">
      <div class="url">{base_url}</div>
    </div>
  </div>
  <p class="hint">Both devices must be on the same Wi-Fi network.</p>
</body></html>"""
        return page.encode("utf-8")

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s - %s\n" % (self.address_string(), fmt % args))


def print_terminal_qr(url: str, label: str):
    """Draw a labelled, scannable QR in the terminal if `qrcode` is available."""
    if qrcode is not None:
        try:
            qr = qrcode.QRCode(border=2)
            qr.add_data(url)
            qr.make(fit=True)
            print(f"\n  {label}\n")
            qr.print_ascii(invert=True)
            return
        except Exception:
            pass
    print(f"\n  {label}\n    {url}")
    print("  (Install the 'qrcode' package for a terminal QR, or open the /qr page.)")


def print_banner(ip, port, apk):
    url = f"http://{ip}:{port}/"
    apk_url = f"http://{ip}:{port}/update.apk"
    line = "=" * 60
    print()
    print(line)
    print("  AuraWave App Update Server is RUNNING")
    print(line)
    if apk:
        print(f"  Serving APK : {os.path.basename(apk)} ({os.path.getsize(apk)} bytes)")
    else:
        print("  Serving APK : NONE  ->  copy an .apk into this folder, then restart")
    print(f"  Folder      : {APK_DIR}")
    print(f"  Web page    : {url}   (both QRs also shown there at {url}qr)")
    print(line)
    # Two QRs for two situations:
    #   1) First time (app NOT installed yet): scan with the phone CAMERA to
    #      download + install the APK straight from the browser.
    print_terminal_qr(
        apk_url,
        "FIRST INSTALL  ->  scan with your phone's CAMERA to download + install the APK",
    )
    print(line)
    #   2) Already installed: scan inside the app ('Check for App Update') to
    #      self-update to this build.
    print_terminal_qr(
        url,
        "IN-APP UPDATE  ->  scan inside AuraWave ('Check for App Update')",
    )
    print(line)
    print("  Both devices must be on the SAME Wi-Fi network.")
    print("  Press Ctrl+C to stop.")
    print(line)
    print()
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser(description="AuraWave app update server.")
    parser.add_argument("--dir", "-d", default=None,
                        help="Folder containing the APK (default: this script's folder).")
    parser.add_argument("--port", "-p", type=int, default=9696,
                        help="Port to listen on (default: 9696).")
    parser.add_argument("--host", default="0.0.0.0",
                        help="Interface to bind (default: 0.0.0.0).")
    args = parser.parse_args()

    global APK_DIR, BASE_URL
    if args.dir:
        APK_DIR = os.path.abspath(os.path.expanduser(args.dir))
    if not os.path.isdir(APK_DIR):
        print(f"ERROR: folder does not exist: {APK_DIR}", file=sys.stderr)
        sys.exit(1)

    ip = get_lan_ip()
    port = args.port
    BASE_URL = f"http://{ip}:{port}"

    try:
        httpd = ThreadingHTTPServer((args.host, port), UpdateHandler)
    except OSError as exc:
        print(f"ERROR: could not bind to {args.host}:{port} -> {exc}", file=sys.stderr)
        print("Try another port, e.g. python update_server.py --port 9700", file=sys.stderr)
        sys.exit(1)

    httpd.daemon_threads = True
    print_banner(ip, port, find_apk())

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down (Ctrl+C)...")
    finally:
        httpd.shutdown()
        httpd.server_close()
        print("Update server stopped. Goodbye!")


if __name__ == "__main__":
    main()
