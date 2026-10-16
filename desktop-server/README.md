# AuraWave Desktop Music Server

A clean, modern **Python desktop application** that turns any folder on your PC
into a local Wi‑Fi music streaming server for the AuraWave Android app (or any
HTTP audio client / browser).

![status](https://img.shields.io/badge/status-production--ready-brightgreen)

---

## Features

- **📁 Select Music Folder** — a prominent button opens a native folder picker.
  The chosen path is shown in the UI and the directory is scanned automatically
  for `.mp3`, `.flac`, `.wav`, `.m4a`, `.aac`, `.ogg` files.
- **📡 Live Connected Devices panel** — a real‑time table showing every phone /
  browser that touches the server: **IP address, status (online/idle), the last
  action, the current/last track, when it connected, and its request count**,
  plus a live **active‑connections counter**.
- **🌐 Local HTTP + API server** — runs on a background thread using the
  production‑grade **waitress** WSGI server, so the GUI never freezes while
  serving audio.
  - `GET /api/songs` *(also `/songs.json`, `/music.json`)* → JSON list of all
    indexed tracks (`title`, `filename`, `artist`, `albumArtist`, `album`,
    `url`, `duration`, `format`, `sizeBytes`, `artworkUrl`) plus the richer metadata fields
    `year`, `musicDirector`, `genre`, `trackNumber`, and `actors` so the app can
    sort and group by them.
- **🏷️ Rich metadata from tags + sidecar** — `year`, `musicDirector`
  (composer), `genre` and `trackNumber` are read straight from each file's
  embedded tags (via **mutagen**). An optional `metadata.json` in the music
  folder supplies `actors` and can override/fill any of
  `year`, `musicDirector`, `actors`, `album`, `artist`, `albumArtist`, `genre`
  (see **Track metadata** below).
  - `GET /stream/<file>` → streams audio with full **HTTP byte‑range support**
    (HTTP `206 Partial Content`), so lossless **FLAC/WAV** files play smoothly
    and seek instantly on mobile.
- **🎨 Modern UI** — built with **CustomTkinter**, with a Dark / Light / System
  appearance switch and an activity log.
- **🔒 Safe** — the streaming endpoint resolves every request inside the chosen
  folder and refuses path‑traversal (`../`) attempts. CORS is enabled so the
  Android app and browsers can connect.

---

## Requirements

- **Windows 10/11** (also works on macOS/Linux)
- **Python 3.9+** (tested on 3.12). During install, tick **“Add Python to PATH”.**

---

## Setup & Run (Windows, step by step)

Open **Command Prompt** or **PowerShell** in this folder
(`desktop-server`) and run:

```bat
:: 1. (Recommended) create an isolated virtual environment
python -m venv .venv

:: 2. activate it
.venv\Scripts\activate

:: 3. install dependencies
pip install -r requirements.txt

:: 4. run the app
python app.py
```

> If `python` is not recognized, reinstall Python with **“Add to PATH”** checked,
> or use the launcher `py -3 app.py`.

The app window opens and the server starts automatically on **port 8080**.

---

## How to use it

1. Click **“Select Music Folder”** and pick a folder containing your music.
   The path and the number of indexed tracks appear in the header.
2. Note the **Server URL** shown in the status bar, e.g.
   `http://192.168.1.15:8080` — this is your PC’s LAN address.
3. On your phone (connected to the **same Wi‑Fi**), open the **AuraWave Android
   app** and enter that URL (including the port). The app will fetch the catalog
   and stream tracks.
4. Watch the **Connected Devices** table update live as the phone connects,
   fetches the song list, and streams tracks.

### Quick test from a browser
Visit `http://<your-pc-ip>:8080/` for a status page, or
`http://<your-pc-ip>:8080/api/songs` to see the JSON catalog. Opening a
`/stream/...` URL plays the file directly in the browser.

---

## Firewall note (important on first run)

The first time the server starts, Windows may show a **Windows Defender
Firewall** prompt. Click **“Allow access”** (at least on **Private networks**)
so phones on your Wi‑Fi can reach the server. If phones can’t connect:

- Ensure the PC and phone are on the **same network** (and the network is set to
  **Private**, not Public).
- Allow **Python** through the firewall for Private networks.
- If **port 8080** is already in use, change the **Port** field in the app to a
  free port (e.g. `8090`) and enter the matching URL in the phone app.

---

## API reference

| Method | Endpoint | Description |
|-------|----------|-------------|
| `GET` | `/api/songs` · `/songs.json` · `/music.json` | JSON array of indexed tracks |
| `GET` | `/stream/<relative-path>` | Streams an audio file (supports `Range`) |
| `GET` | `/` | Human‑readable status page |

**Example `/api/songs` item**

```json
{
  "id": "381294...",
  "title": "Acoustic Breeze",
  "filename": "Acoustic Breeze.flac",
  "artist": "Local Library",
  "albumArtist": "Various Artists",
  "album": "Chillout",
  "url": "http://192.168.1.15:8080/stream/Chillout/Acoustic%20Breeze.flac",
  "duration": 227,
  "format": "FLAC",
  "sizeBytes": 28491234,
  "artworkUrl": null,
  "year": 2023,
  "musicDirector": "Anirudh",
  "genre": "Soundtrack",
  "trackNumber": 3,
  "actors": "Rajinikanth, Tamannaah"
}
```

Any metadata that can't be determined is sent as JSON `null`.

---

## Track metadata (year, music director, genre, track number, actors)

Every track object includes six extra fields for sorting and grouping in the
Android app:

| Field | Type | Source |
|-------|------|--------|
| `albumArtist` | string / null | embedded tag (`albumartist` / ID3 `TPE2`) |
| `year` | integer / null | embedded tag (`date` / `originaldate` / ID3 `TDRC`/`TYER`) |
| `musicDirector` | string / null | embedded tag (`composer` / ID3 `TCOM`) |
| `genre` | string / null | embedded tag (`genre`) |
| `trackNumber` | integer / null | embedded tag (`tracknumber`, part before `/`) |
| `actors` | string / null | **`metadata.json` only** (comma-separated names) |

Embedded tags are read with **mutagen** when the file has them; `album`,
`artist` and `title` also prefer the embedded tag and fall back to the previous
folder-name / filename behavior. Any file without tags (or with broken tags) is
still indexed — the affected fields are just `null`.

### Optional `metadata.json` overrides

Drop a `metadata.json` file in your music folder to add `actors` and to
override or fill `year`, `musicDirector`, `actors`, `album`, `artist`,
`albumArtist`, `genre`.
It maps a key — either a track's **relative path** (use forward slashes) or its
**bare filename** — to an object of override fields:

```json
{
  "Chennai/Kaavaalaa.flac": { "musicDirector": "Anirudh", "year": 2023, "actors": "Rajinikanth, Tamannaah" },
  "Jailer.flac": { "actors": "Rajinikanth" }
}
```

Only the keys you list are overridden; everything else keeps its tag-derived
value. A missing or malformed `metadata.json` is ignored.

---

## Project files

```
desktop-server/
├── app.py            # the complete application (GUI + HTTP/API server)
├── requirements.txt  # Python dependencies
└── README.md         # this file
```

---

## Troubleshooting

| Symptom | Fix |
|--------|-----|
| GUI shows **“Start failed / Could not bind port”** | Port is busy — change the **Port** field and click **Start Server**. |
| Phone can’t connect | Same Wi‑Fi? Network set to **Private**? Firewall allowing Python? |
| FLAC won’t seek | Already handled — the server sends `Accept-Ranges` + `206` responses. |
| No songs listed | Click **Select Music Folder**, then **Rescan** if you added files. |
