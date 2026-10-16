# AuraWave 🎵

Self-hosted, local Wi-Fi music streaming — no cloud, no account, no subscription.
Point a small Python server at a folder of your music and play it from any web
browser on the same network, with lossless (FLAC/WAV) instant seeking via HTTP
range requests.

This repository contains two independent, complementary servers:

| Folder | What it is | Stack | Default port |
|--------|-----------|-------|:---:|
| [`web-player/`](web-player/) | A full **browser music player** + streaming server. Dependency-light (standard library; a few optional extras unlock more). | Python stdlib + static HTML/CSS/JS | **8000** |
| [`desktop-server/`](desktop-server/) | A **GUI streaming server** with a live connected-devices panel. Also serves the web player at `/player/`. | CustomTkinter + Flask/waitress | **8080** |

They can run at the same time (different ports), and the desktop server reuses the
web player's UI from the sibling `web-player/web` folder.

---

## Features

**Playback & library**
- Library with **live search**, sort and group; a dedicated **Songs** (all-tracks) tab;
  **Albums / Artists / Years** browsing; Favorites, Recently Played and Playlists.
- Queue with non-repeating **shuffle** and **repeat OFF / ALL / ONE**.
- **Dual-deck** audio engine for true **crossfade / gapless** playback.
- Instant seeking on FLAC/WAV (HTTP Range `206`), permissive CORS, path-traversal-safe.

**Audio effects (Web Audio, client-side)**
- 10-band **graphic equalizer** with JetAudio-style genre presets **and** a
  **parametric EQ** mode (per-band frequency / Q / shelving).
- **Headphone crossfeed** (BS2B-style), reverb (Room/Hall/Stadium), stereo-widen,
  X-Bass, X-Surround, playback speed 0.5×–2.0× (pitch-preserving), loudness
  normalization, and a 4-style visualizer.

**Library management & data (web-player server)**
- **Live folder watcher** — auto re-index when files are added/removed/changed
  (uses `watchdog` if installed, else a stdlib polling fallback).
- **SQLite index** with **FTS5 full-text search** — fast search on large libraries,
  and a metadata cache so re-scans skip re-parsing unchanged files.
- **In-browser tag & cover-art editor** (requires `mutagen`).
- **M3U / PLS** playlist **import & export**.
- **Local scrobbling + a Stats view** (top tracks/artists, listening time); optional
  Last.fm push.

**Lyrics & artwork**
- Synced `.lrc` / plain-text lyrics from local sidecars or the free LRCLIB API.
- Album artwork fetched and cached server-side, plus embedded-cover support.

---

## Quick start

> Requires **Python 3.8+**. Everything core runs on the standard library.

### Web player (fastest)

```bash
cd web-player
python web_player.py --dir "C:\path\to\your\Music"
# then open the printed URL, e.g. http://localhost:8000/
```

Optional extras (richer tags + the tag editor, and instant folder-watch):

```bash
pip install -r web-player/requirements-optional.txt   # mutagen + watchdog
```

### Desktop GUI server

```bash
cd desktop-server
python -m venv .venv
# Windows:
.venv\Scripts\activate
pip install -r requirements.txt
python app.py            # serves on http://localhost:8080  (browser UI at /player/)
```

On a phone: open `http://<your-lan-ip>:<port>/qr` and scan the QR, or just type the
URL. Both devices must be on the same Wi-Fi.

---

## Repository layout

```
AuraWave/
├─ README.md               ← you are here
├─ PUBLISH.md              ← how this repo was published (git/GitHub steps)
├─ .gitignore
├─ web-player/             ← browser player + streaming server (port 8000)
│  ├─ web_player.py
│  ├─ requirements-optional.txt
│  ├─ run.bat / run.sh
│  └─ web/ (index.html, app.js, styles.css)
└─ desktop-server/         ← GUI streaming server (port 8080)
   ├─ app.py
   ├─ requirements.txt
   └─ run.bat
```

Each subfolder has its own README with details and options.

---

## Notes

- Audio effects need the **Web Audio API** (all modern browsers); without it,
  playback still works and effects become no-ops.
- Your music files, the SQLite index (`library.db`), and the artwork/lyrics caches
  are **git-ignored** — the repo ships code only, never your library.
- This is a LAN tool: it binds `0.0.0.0` by default so other devices on your network
  can reach it. Only run it on networks you trust.

## License

Add a license of your choice (e.g. MIT) as a `LICENSE` file if you intend others to
use it.
