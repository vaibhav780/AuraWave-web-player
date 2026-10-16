# AuraWave Web Player

A **browser** version of the AuraWave music player. It serves a folder of local
music *and* a modern web UI that mirrors the Android app's features — so you can
play your library from any browser (phone or PC) on the same Wi-Fi, with no app
install.

This is a fourth, independent subproject alongside `desktop-server`,
`update-server` and the all-in-one `server/server.py`. It is **standard-library
only** (optionally uses `mutagen` for richer tags if it happens to be installed),
and listens on **port 8000** by default so it won't clash with the others
(8080 / 9696 / 9595).

## Run

```bat
:: easiest — serves a folder; prompts you for the port (Enter = 8000)
run.bat "D:\Music"

:: skip the prompt by passing the port as the 2nd argument
run.bat "D:\Music" 8010

:: or directly with Python (--port is optional, default 8000)
python web_player.py --dir "D:\Music"
python web_player.py --dir "D:\Music" --port 8010
```

Then open the printed URL in a browser:

```
        >>>  http://<your-lan-ip>:8000/  <<<
```

- On a phone: open `http://<lan-ip>:8000/qr` on the PC and scan the QR code, or
  just type the URL. Both devices must be on the same Wi-Fi.
- `run.bat` automatically prefers the `desktop-server/.venv` Python if it exists
  (that venv has `mutagen`, giving year / genre / music-director / duration from
  embedded tags). Otherwise plain `python` works too — those fields then come
  from an optional `metadata.json` sidecar (see below).

## Features (matching the Android app)

- **Library, Favorites, Recently played, Playlists** — favorites / recents /
  playlists / search history persist in the browser's `localStorage`.
- **Search** across title / artist / album / music director / actors.
- **Sort** by Title, Artist, Album Artist, Album, Release Year, Music Director,
  Actor/Actress or Duration.
- **Group** (with sticky section headers) by Album, Artist, Album Artist, Year,
  Music Director or Actor.
- **Queue** with **shuffle** (non-repeating order) and **repeat OFF / ALL / ONE**.
- **10-band graphic equalizer** with JetAudio-style **genre presets** (Flat,
  Rock, Pop, Jazz, Classical, Dance, Bass, Treble) and an EQ on/off switch.
- **Effects:** Reverb (Off / Room / Hall / Stadium), Stereo Widen, X-Bass,
  X-Surround — all via the Web Audio API.
- **Playback speed** 0.5×–2.0× with optional **pitch preservation**.
- **Volume**, seek bar, keyboard shortcuts (Space = play/pause, Shift+←/→ =
  prev/next) and **OS media controls / media keys** via the Media Session API.
- **Light / dark theme** toggle (dark by default, matching the app's palette).
- **Online album artwork** — the server looks up each album's cover art by album
  (+ artist) from the free iTunes Search API, **caches it to disk**, and shows it
  in the track rows, Now Playing bar and OS media controls. First lookup needs
  internet; after that it's served from cache (works offline). No API key needed.
  Disable with `--no-online-art`; change the cache folder with `--art-cache <dir>`.
- **Instant seeking** on FLAC/WAV — audio is served with HTTP Range (206) support.
- **All-songs list** — a dedicated **Songs** tab shows every track as a flat list
  (no facet sub-tabs), alongside the faceted **Library** tab.

## Server & library enhancements

These build on the basics above and all degrade gracefully — the server advertises
what's active at `GET /capabilities` and in the startup banner.

- **Live folder watching (auto-rescan).** Add, remove or edit files in your music
  folder and the catalog updates automatically — no manual `/rescan`. Uses the
  `watchdog` library for instant events when installed, otherwise a built-in
  polling thread (every 5 s). Disable with `--no-watch`.
- **SQLite index for large libraries.** Parsed tags are cached in an embedded
  SQLite DB keyed by file path + mtime, so re-scans never re-parse unchanged files
  — essential for tens of thousands of lossless tracks. The catalog is also mirrored
  into an **FTS5 full-text index**, exposed at `GET /search?q=` (falls back to
  `LIKE` if your Python's sqlite3 lacks FTS5). DB path defaults to `./library.db`
  (`--db <path>` to change).
- **In-browser tag & cover-art editor.** With `mutagen` installed, edit a track's
  Title / Artist / Album / Album Artist / Year / Genre / Music Director and upload
  embedded cover art straight from the player (✎ on any track). Backed by
  `POST /edit-tags` and `POST /edit-art`; disabled (hidden in the UI) without mutagen.
- **M3U / PLS playlist import & export.** Import `.m3u` / `.m3u8` / `.pls` files
  sitting in your music folder (`GET /playlists/disk`), and export any web playlist
  back to disk as a portable `.m3u` sidecar (`POST /playlists/export`).
- **Local scrobbling & stats.** Every play is logged to the SQLite DB; a **Stats**
  view shows total plays, listening time, and your top tracks/artists
  (`POST /scrobble`, `GET /stats`). Optional Last.fm push with
  `--lastfm-key/--lastfm-secret/--lastfm-session` (a pre-obtained session key;
  local history is always the primary store).
- **Audiophile effects (client-side, Web Audio):** **headphone crossfeed**
  (BS2B-style channel blending for natural headphone listening) and a
  **parametric EQ** mode (adjustable frequency / Q / shelving per band) layered on
  top of the existing 10-band graphic EQ, reverb, widen, X-Bass and X-Surround.

Optional dependencies live in **`requirements-optional.txt`**
(`pip install -r requirements-optional.txt` for `mutagen` + `watchdog`). SQLite
and scrobbling need nothing beyond the standard library.

## Use the SAME server your Android app connects to (recommended)

You don't have to run this standalone server at all. The two streaming servers
the Android app uses now **serve this exact player UI themselves**, same-origin,
at `/player`:

| Server | Open in a browser |
|--------|-------------------|
| All-in-one CLI (`server/server.py`, port 9595) | `http://<host>:9595/player` |
| Desktop GUI (`desktop-server/app.py`, port 8080) | `http://<host>:8080/player` |

So whichever URL you type into the AuraWave app, just open that same host with
`/player` on the end in any browser — the player loads the identical catalog and
streams from that one server. No second process, no CORS. Those servers find the
UI via a sibling `web-player/web` folder (this project), so keep this folder in
the workspace.

## How it talks to servers

The page loads its catalog from `GET /songs.json` on whatever host served it.
You can also point it at a *different* AuraWave server (desktop-server /
all-in-one) by typing that server's base URL in the top bar and pressing
**Connect** — any server that serves the same `songs.json` shape works.

Each track carries a relative `streamPath`, so audio is fetched same-origin
(important: the Web Audio effects graph outputs silence for tainted, non-CORS
cross-origin media — same-origin streaming avoids that entirely).

## Optional `metadata.json`

Without `mutagen`, drop a `metadata.json` in your music folder to fill in rich
metadata (same format as the other AuraWave servers):

```json
{
  "Chennai/Kaavaalaa.flac": { "musicDirector": "Anirudh", "year": 2023,
                              "actors": "Rajinikanth, Tamannaah" },
  "Jailer.flac": { "actors": "Rajinikanth" }
}
```

Keys are the track's relative path (posix slashes) or its bare filename.
Supported fields: `title, artist, albumArtist, album, year, musicDirector,
genre, actors`.

## Layout

```
web-player/
  web_player.py     # the HTTP server (catalog + ranged streaming + static UI)
  run.bat           # launcher (picks the mutagen venv if available)
  web/
    index.html      # UI shell
    styles.css      # styling (AuraWave emerald/teal theme)
    app.js          # all player logic (library, queue, Web Audio effects…)
```

## Notes / limits

- Equalizer and effects need the **Web Audio API** (every modern browser). If a
  browser lacks it, playback still works; the effects simply become no-ops.
- `preservesPitch` support when changing speed varies slightly by browser.
- This server has no device-tracking GUI — it's headless. Use `desktop-server`
  if you want the live connected-devices panel.
```
