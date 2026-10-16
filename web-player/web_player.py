#!/usr/bin/env python3
"""
AuraWave Web Player  —  browser music player + streaming server
===============================================================

A single, dependency-light HTTP server that turns a folder of local music into a
full **browser** music player that mirrors the AuraWave Android app's features:

  * Song library with live search, sorting and grouping (section headers).
  * Gapless-ish queue with shuffle (non-repeating) and repeat OFF / ALL / ONE.
  * A 10-band graphic equalizer with JetAudio-style genre presets, plus Reverb,
    Stereo-Widen, X-Bass and X-Surround effects and 0.5x-2.0x playback speed
    (all implemented client-side with the Web Audio API).
  * Favorites, recently-played, search history and user playlists (saved in the
    browser's localStorage).
  * OS media controls / keyboard media keys via the Media Session API.

It is intentionally **standard-library only** so it just runs with `python`.
`mutagen` is used *if present* (e.g. the desktop-server venv) to read embedded
year / genre / music-director / duration tags; otherwise those come from an
optional ``metadata.json`` sidecar in the music folder, exactly like the other
AuraWave servers.

Audio is served with full HTTP Range (206 Partial Content) support so FLAC / WAV
seek instantly, with permissive CORS.

Run it:
    python web_player.py --dir "D:\\Music"
    python web_player.py --dir "D:\\Music" --port 8000

Then open the printed URL in any browser (phone or PC on the same Wi-Fi).

Ports used elsewhere in this workspace: 8080 (desktop-server), 9696
(update-server), 9595 (all-in-one CLI). This server defaults to **8000**.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import re
import socket
import sqlite3
import sys
import threading
import time
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# mutagen is optional: if installed we read embedded tags, otherwise we fall back
# to the filename + an optional metadata.json sidecar (same as server/server.py).
# When present it ALSO enables the in-browser tag + cover-art editor.
try:
    import mutagen  # type: ignore
    from mutagen import File as MutagenFile  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    mutagen = None
    MutagenFile = None

# watchdog is optional: if installed we watch the music folder for live changes;
# otherwise a lightweight polling thread provides the same auto-rescan behaviour.
try:
    from watchdog.observers import Observer  # type: ignore
    from watchdog.events import FileSystemEventHandler  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    Observer = None
    FileSystemEventHandler = object


# ---------------------------------------------------------------------------
# Configuration / constants
# ---------------------------------------------------------------------------

SUPPORTED_EXTENSIONS = {".flac", ".wav", ".mp3", ".m4a", ".aac", ".ogg"}

AUDIO_MIME_TYPES = {
    ".flac": "audio/flac",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
}

STREAM_CHUNK_SIZE = 64 * 1024
DEFAULT_ARTIST = "Local Library"
DEFAULT_PORT = 8000

# Folder holding the browser UI (index.html / styles.css / app.js), next to this file.
WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

# Embedded SQLite index: a metadata cache (so re-scans don't re-parse unchanged
# files — crucial for libraries with tens of thousands of lossless tracks), a
# full-text search index, and the local play-history ("scrobble") log.
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "library.db")
_DB_LOCK = threading.RLock()
_HAS_FTS = False  # set by init_db(): True when this sqlite3 build has FTS5.

# Filled in by main() before the server starts.
MUSIC_DIR = os.getcwd()
BASE_URL = f"http://127.0.0.1:{DEFAULT_PORT}"

# --- Online album artwork -------------------------------------------------
# When enabled, the server looks up cover art by album (+ artist) from the free
# iTunes Search API (no key needed), caches the image on disk, and serves it to
# clients. Works offline once cached; shows a placeholder when there is neither a
# cached image nor internet.
ONLINE_ART = True
ART_CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "art_cache")
ART_NEG_TTL = 7 * 24 * 3600            # re-try a failed lookup after a week
ITUNES_SEARCH = "https://itunes.apple.com/search"
_ART_LOCK = threading.Lock()           # serialise online fetches (gentle on the API)
_ART_UA = {"User-Agent": "AuraWaveWebPlayer/1.0 (+local)"}

# --- Online lyrics (LRCLIB: free, no API key, time-synced) -----------------
ONLINE_LYRICS = True
LYRICS_CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lyrics_cache")
LYRICS_NEG_TTL = 7 * 24 * 3600
LRCLIB_BASE = "https://lrclib.net/api"
_LYRICS_LOCK = threading.Lock()


def _art_paths(artist: str, album: str):
    """Return (hit_jpg_path, miss_marker_path) for an album's cached artwork."""
    key = ((artist or "").strip().lower() + "|" + (album or "").strip().lower())
    h = hashlib.sha1(key.encode("utf-8")).hexdigest()
    base = os.path.join(ART_CACHE_DIR, h)
    return base + ".jpg", base + ".miss"


def fetch_album_art(artist: str, album: str, timeout: int = 6):
    """Look up and download album cover art bytes online, or None on any failure."""
    term = " ".join(x for x in [artist, album] if x).strip() or (album or "")
    if not term:
        return None
    url = f"{ITUNES_SEARCH}?" + urllib.parse.urlencode(
        {"term": term, "entity": "album", "limit": 1}
    )
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=_ART_UA),
                                    timeout=timeout) as r:
            data = json.loads(r.read().decode("utf-8", "replace"))
    except Exception:
        return None
    results = data.get("results") or []
    if not results:
        return None
    art = results[0].get("artworkUrl100") or results[0].get("artworkUrl60")
    if not art:
        return None
    # iTunes returns a 100px thumbnail URL; request a larger 600px version.
    hi = art.replace("100x100bb", "600x600bb").replace("100x100", "600x600")
    for candidate in (hi, art):
        try:
            with urllib.request.urlopen(
                urllib.request.Request(candidate, headers=_ART_UA), timeout=timeout
            ) as ir:
                body = ir.read()
                if body:
                    return body
        except Exception:
            continue
    return None


def get_album_art(artist: str, album: str):
    """Return album art bytes from the on-disk cache, fetching online if needed.

    Returns None when artwork can't be obtained (offline + not cached, or no
    match). A negative result is remembered for [ART_NEG_TTL] so we don't hammer
    the API for albums with no cover.
    """
    hit, miss = _art_paths(artist, album)
    if os.path.isfile(hit):
        try:
            with open(hit, "rb") as f:
                return f.read()
        except OSError:
            pass
    if not ONLINE_ART:
        return None
    if os.path.isfile(miss) and (time.time() - os.path.getmtime(miss)) < ART_NEG_TTL:
        return None
    with _ART_LOCK:
        # Re-check: another thread may have fetched it while we waited for the lock.
        if os.path.isfile(hit):
            try:
                with open(hit, "rb") as f:
                    return f.read()
            except OSError:
                pass
        img = fetch_album_art(artist, album)
        try:
            os.makedirs(ART_CACHE_DIR, exist_ok=True)
            if img:
                with open(hit, "wb") as f:
                    f.write(img)
            else:
                open(miss, "wb").close()   # remember the miss
        except OSError:
            pass
        return img


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def get_lan_ip() -> str:
    """Best-effort discovery of this machine's LAN IP (the one a phone connects to)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))  # no packets are actually sent
        ip = s.getsockname()[0]
    except Exception:
        try:
            ip = socket.gethostbyname(socket.gethostname())
        except Exception:
            ip = "127.0.0.1"
    finally:
        s.close()
    return ip


def mime_for(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    if ext in AUDIO_MIME_TYPES:
        return AUDIO_MIME_TYPES[ext]
    guessed, _ = mimetypes.guess_type(path)
    return guessed or "application/octet-stream"


def title_from_filename(filename: str) -> str:
    # Keep " - " separators so lyrics lookup can split off a "Title - Artist" tail.
    stem = os.path.splitext(filename)[0].replace("_", " ")
    return re.sub(r"[ \t]+", " ", stem).strip() or filename


def make_track_id(rel_path: str) -> str:
    return urllib.parse.quote(rel_path.replace(os.sep, "/"), safe="")


def year_from(value):
    if value is None:
        return None
    m = re.search(r"\d{4}", str(value))
    return int(m.group()) if m else None


def _first(value):
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        return value[0] if value else None
    return value


def read_tags(path: str) -> dict:
    """Best-effort embedded-tag read via mutagen. Never raises; empty dict if unavailable."""
    tags: dict = {}
    if mutagen is None:
        return tags
    try:
        easy = mutagen.File(path, easy=True)
    except Exception:
        easy = None
    if easy is not None:
        try:
            get = easy.get
            if _first(get("title")):
                tags["title"] = _first(get("title"))
            if _first(get("artist")):
                tags["artist"] = _first(get("artist"))
            if _first(get("albumartist")):
                tags["albumArtist"] = _first(get("albumartist"))
            if _first(get("album")):
                tags["album"] = _first(get("album"))
            y = year_from(_first(get("date")) or _first(get("originaldate")))
            if y is not None:
                tags["year"] = y
            composer = _first(get("composer"))
            if composer:
                tags["musicDirector"] = composer
            genre = _first(get("genre"))
            if genre:
                tags["genre"] = genre
            tn = _first(get("tracknumber"))
            if tn is not None:
                try:
                    tags["trackNumber"] = int(str(tn).split("/")[0].strip())
                except ValueError:
                    pass
        except Exception:
            pass
        try:
            info = getattr(easy, "info", None)
            if info is not None and getattr(info, "length", None):
                tags["duration"] = int(info.length)
        except Exception:
            pass
    return tags


def load_metadata_sidecar(music_dir: str) -> dict:
    """Load optional per-track overrides from `<music_dir>/metadata.json` (guarded)."""
    path = os.path.join(music_dir, "metadata.json")
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return {}


# ---------------------------------------------------------------------------
# SQLite index: metadata cache + full-text search + scrobble log
# ---------------------------------------------------------------------------

def _db():
    """Open a short-lived SQLite connection (one per operation; thread-safe)."""
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """Create tables (and the FTS index when available). Safe to call repeatedly."""
    global _HAS_FTS
    with _DB_LOCK, _db() as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS meta_cache (
                path  TEXT PRIMARY KEY,
                mtime REAL,
                size  INTEGER,
                tags  TEXT
            );
            CREATE TABLE IF NOT EXISTS tracks (
                id            TEXT PRIMARY KEY,
                title         TEXT,
                artist        TEXT,
                album         TEXT,
                albumArtist   TEXT,
                musicDirector TEXT,
                genre         TEXT,
                json          TEXT
            );
            CREATE TABLE IF NOT EXISTS scrobbles (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                ts       REAL,
                path     TEXT,
                title    TEXT,
                artist   TEXT,
                album    TEXT,
                duration INTEGER
            );
            CREATE INDEX IF NOT EXISTS ix_scrobbles_ts ON scrobbles(ts);
            """
        )
        try:
            c.execute(
                "CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5("
                "id UNINDEXED, title, artist, album, albumArtist, musicDirector, genre, "
                "json UNINDEXED)"
            )
            _HAS_FTS = True
        except sqlite3.OperationalError:
            _HAS_FTS = False  # this Python's sqlite3 wasn't built with FTS5 -> LIKE fallback


def _load_meta_cache():
    """Load the whole tag cache into a dict {path: (mtime, size, tags)} once per scan."""
    out = {}
    try:
        with _DB_LOCK, _db() as c:
            for row in c.execute("SELECT path, mtime, size, tags FROM meta_cache"):
                try:
                    out[row["path"]] = (row["mtime"], row["size"], json.loads(row["tags"] or "{}"))
                except Exception:
                    continue
    except Exception:
        pass
    return out


def _flush_meta_cache(rows):
    """Persist freshly-parsed (path, mtime, size, tags) rows in one transaction."""
    if not rows:
        return
    try:
        with _DB_LOCK, _db() as c:
            c.executemany(
                "INSERT OR REPLACE INTO meta_cache(path, mtime, size, tags) VALUES(?,?,?,?)",
                [(p, m, s, json.dumps(t)) for (p, m, s, t) in rows],
            )
    except Exception:
        pass


def _prune_meta_cache(valid_paths):
    """Drop cache rows for files that no longer exist, in one statement batch."""
    try:
        with _DB_LOCK, _db() as c:
            existing = {r["path"] for r in c.execute("SELECT path FROM meta_cache")}
            stale = [(p,) for p in existing - set(valid_paths)]
            if stale:
                c.executemany("DELETE FROM meta_cache WHERE path=?", stale)
    except Exception:
        pass


def index_tracks(tracks):
    """Rebuild the `tracks` table + FTS index from a freshly-scanned catalog."""
    try:
        with _DB_LOCK, _db() as c:
            c.execute("DELETE FROM tracks")
            rows = [
                (
                    t["id"], t.get("title"), t.get("artist"), t.get("album"),
                    t.get("albumArtist"), t.get("musicDirector"), t.get("genre"),
                    json.dumps(t),
                )
                for t in tracks
            ]
            c.executemany(
                "INSERT OR REPLACE INTO tracks"
                "(id,title,artist,album,albumArtist,musicDirector,genre,json)"
                " VALUES(?,?,?,?,?,?,?,?)",
                rows,
            )
            if _HAS_FTS:
                c.execute("DELETE FROM tracks_fts")
                c.executemany(
                    "INSERT INTO tracks_fts"
                    "(id,title,artist,album,albumArtist,musicDirector,genre,json)"
                    " VALUES(?,?,?,?,?,?,?,?)",
                    rows,
                )
    except Exception as exc:
        print(f"  [index] failed: {exc}", file=sys.stderr)


def search_tracks(query: str, limit: int = 500):
    """Full-text (FTS5) search of the indexed catalog; LIKE fallback otherwise."""
    q = (query or "").strip()
    if not q:
        return []
    try:
        with _DB_LOCK, _db() as c:
            if _HAS_FTS:
                # Prefix-match each term so partial words match as you type.
                terms = [t for t in re.split(r"\s+", q) if t]
                match = " ".join('"' + t.replace('"', '""') + '"*' for t in terms)
                rows = c.execute(
                    "SELECT json FROM tracks_fts WHERE tracks_fts MATCH ? LIMIT ?",
                    (match, limit),
                ).fetchall()
            else:
                like = "%" + q.replace("%", "").replace("_", "") + "%"
                rows = c.execute(
                    "SELECT json FROM tracks WHERE title LIKE ? OR artist LIKE ? "
                    "OR album LIKE ? OR albumArtist LIKE ? OR musicDirector LIKE ? "
                    "OR genre LIKE ? LIMIT ?",
                    (like, like, like, like, like, like, limit),
                ).fetchall()
        return [json.loads(r["json"]) for r in rows]
    except Exception as exc:
        print(f"  [search] failed: {exc}", file=sys.stderr)
        return []


def log_scrobble(path, title, artist, album, duration):
    """Record one play in the local history (and optionally push to Last.fm)."""
    try:
        with _DB_LOCK, _db() as c:
            c.execute(
                "INSERT INTO scrobbles(ts, path, title, artist, album, duration)"
                " VALUES(?,?,?,?,?,?)",
                (time.time(), path, title, artist, album, int(duration or 0)),
            )
    except Exception as exc:
        print(f"  [scrobble] failed: {exc}", file=sys.stderr)
    lastfm_scrobble(artist, title, album, duration)


def get_stats():
    """Aggregate the local play history into a small dashboard payload."""
    out = {"totalPlays": 0, "totalSeconds": 0, "uniqueTracks": 0,
           "topTracks": [], "topArtists": [], "recent": []}
    try:
        with _DB_LOCK, _db() as c:
            r = c.execute(
                "SELECT COUNT(*) n, COALESCE(SUM(duration),0) s, "
                "COUNT(DISTINCT path) u FROM scrobbles"
            ).fetchone()
            out["totalPlays"] = r["n"] or 0
            out["totalSeconds"] = int(r["s"] or 0)
            out["uniqueTracks"] = r["u"] or 0
            out["topTracks"] = [
                {"title": x["title"], "artist": x["artist"], "plays": x["plays"]}
                for x in c.execute(
                    "SELECT title, artist, COUNT(*) plays FROM scrobbles "
                    "GROUP BY path ORDER BY plays DESC, MAX(ts) DESC LIMIT 20"
                ).fetchall()
            ]
            out["topArtists"] = [
                {"artist": x["artist"], "plays": x["plays"]}
                for x in c.execute(
                    "SELECT artist, COUNT(*) plays FROM scrobbles "
                    "WHERE artist IS NOT NULL AND artist <> '' "
                    "GROUP BY artist ORDER BY plays DESC LIMIT 20"
                ).fetchall()
            ]
            out["recent"] = [
                {"title": x["title"], "artist": x["artist"], "ts": x["ts"]}
                for x in c.execute(
                    "SELECT title, artist, ts FROM scrobbles ORDER BY ts DESC LIMIT 30"
                ).fetchall()
            ]
    except Exception as exc:
        print(f"  [stats] failed: {exc}", file=sys.stderr)
    return out


# --- Optional Last.fm push (best-effort; local scrobbling is the primary store) ---
# Set these via --lastfm-* flags. Requires a pre-obtained session key (no
# interactive auth flow here); when unset, scrobbles stay purely local.
LASTFM_API_KEY = None
LASTFM_SECRET = None
LASTFM_SESSION = None
LASTFM_API = "https://ws.audioscrobbler.com/2.0/"


def lastfm_scrobble(artist, title, album, duration):
    if not (LASTFM_API_KEY and LASTFM_SECRET and LASTFM_SESSION and artist and title):
        return
    try:
        params = {
            "method": "track.scrobble", "api_key": LASTFM_API_KEY, "sk": LASTFM_SESSION,
            "artist": artist, "track": title, "timestamp": str(int(time.time())),
        }
        if album:
            params["album"] = album
        sig_src = "".join(k + params[k] for k in sorted(params)) + LASTFM_SECRET
        params["api_sig"] = hashlib.md5(sig_src.encode("utf-8")).hexdigest()
        params["format"] = "json"
        data = urllib.parse.urlencode(params).encode("utf-8")
        req = urllib.request.Request(LASTFM_API, data=data, headers=_ART_UA)
        with urllib.request.urlopen(req, timeout=6) as r:
            r.read()
    except Exception as exc:
        print(f"  [lastfm] scrobble failed: {exc}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Playlists on disk (M3U / PLS import + export) & the tag / cover-art editor
# ---------------------------------------------------------------------------

PLAYLIST_EXTS = (".m3u", ".m3u8", ".pls")


def _resolve_rel(rel: str):
    """Resolve a bare (non-url-encoded) relative posix path inside MUSIC_DIR."""
    decoded = (rel or "").lstrip("/").replace("/", os.sep)
    if not decoded:
        return None
    candidate = os.path.normpath(os.path.join(MUSIC_DIR, decoded))
    root = os.path.abspath(MUSIC_DIR)
    cand = os.path.abspath(candidate)
    if cand != root and not cand.startswith(root + os.sep):
        return None
    return cand if os.path.isfile(cand) else None


def _invalidate_track_cache(rel_posix: str):
    """Drop a file's cached tag parse so the next scan re-reads it from disk."""
    try:
        with _DB_LOCK, _db() as c:
            c.execute("DELETE FROM meta_cache WHERE path=?", (rel_posix,))
    except Exception:
        pass


def _parse_playlist_file(abs_path: str):
    """Parse a .m3u/.m3u8/.pls file into a list of local track ids inside MUSIC_DIR."""
    pdir = os.path.dirname(abs_path)
    ext = os.path.splitext(abs_path)[1].lower()
    entries = []
    try:
        with open(abs_path, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                if ext == ".pls":
                    m = re.match(r"(?i)file\d+\s*=\s*(.+)$", line)
                    if m:
                        entries.append(m.group(1).strip())
                else:  # m3u / m3u8
                    if line.startswith("#"):
                        continue
                    entries.append(line)
    except OSError:
        return []

    ids = []
    root = os.path.abspath(MUSIC_DIR)
    for entry in entries:
        if re.match(r"^[a-zA-Z][a-zA-Z0-9+.\-]*://", entry):
            continue  # skip remote URLs; we can only map local files to track ids
        cand = entry if os.path.isabs(entry) else os.path.join(pdir, entry)
        cand = os.path.abspath(os.path.normpath(cand))
        if (cand == root or cand.startswith(root + os.sep)) and os.path.isfile(cand):
            rel = os.path.relpath(cand, root)
            ids.append(make_track_id(rel))
    return ids


def import_disk_playlists():
    """Find .m3u/.m3u8/.pls files in the music folder and parse each to track ids."""
    out = []
    for root, dirs, files in os.walk(MUSIC_DIR, onerror=lambda e: None):
        dirs.sort()
        for name in sorted(files):
            if os.path.splitext(name)[1].lower() in PLAYLIST_EXTS:
                ids = _parse_playlist_file(os.path.join(root, name))
                if ids:
                    out.append({"name": os.path.splitext(name)[0], "songs": ids})
    return out


def export_playlist(name: str, paths):
    """Write an .m3u playlist into the music folder from a list of relative paths."""
    safe_name = re.sub(r'[\\/:*?"<>|]+', "_", (name or "playlist")).strip() or "playlist"
    out_path = os.path.join(MUSIC_DIR, safe_name + ".m3u")
    rels = [p for p in (paths or []) if isinstance(p, str) and p.strip()]
    if not rels:
        return {"ok": False, "error": "no tracks to export"}
    try:
        with open(out_path, "w", encoding="utf-8") as f:
            f.write("#EXTM3U\n")
            for rel in rels:
                f.write(rel.replace("/", os.sep) if os.sep != "/" else rel)
                f.write("\n")
        return {"ok": True, "file": safe_name + ".m3u", "count": len(rels)}
    except OSError as exc:
        return {"ok": False, "error": str(exc)}


def edit_tags(rel: str, fields: dict):
    """Write editable tags into a file via mutagen; refresh the catalog afterwards."""
    p = _resolve_rel(rel)
    if not p:
        return {"ok": False, "error": "file not found"}
    try:
        audio = MutagenFile(p, easy=True)
        if audio is None:
            return {"ok": False, "error": "unsupported format"}
        if audio.tags is None:
            try:
                audio.add_tags()
            except Exception:
                pass
        mapping = {
            "title": "title", "artist": "artist", "album": "album",
            "albumArtist": "albumartist", "genre": "genre", "musicDirector": "composer",
        }
        for key, ez in mapping.items():
            if fields.get(key) is not None:
                val = str(fields[key])
                if val == "":
                    try:
                        del audio[ez]
                    except (KeyError, Exception):
                        pass
                else:
                    audio[ez] = val
        if fields.get("year") is not None:
            y = str(fields["year"]).strip()
            if y == "":
                for key in ("date", "originaldate", "year"):
                    try:
                        del audio[key]
                    except (KeyError, Exception):
                        pass
            else:
                audio["date"] = y
        audio.save()
        _invalidate_track_cache(rel)
        get_catalog(force=True)
        return {"ok": True}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def embed_art(rel: str, data: bytes, ctype: str):
    """Embed cover-art bytes into a file's metadata (format-specific via mutagen)."""
    p = _resolve_rel(rel)
    if not p:
        return {"ok": False, "error": "file not found"}
    if not data:
        return {"ok": False, "error": "empty image"}
    ext = os.path.splitext(p)[1].lower()
    mime = (ctype or "image/jpeg").split(";")[0].strip() or "image/jpeg"
    try:
        if ext == ".mp3":
            from mutagen.id3 import ID3, APIC
            try:
                tags = ID3(p)
            except Exception:
                tags = ID3()
            tags.delall("APIC")
            tags.add(APIC(encoding=3, mime=mime, type=3, desc="Cover", data=data))
            tags.save(p)
        elif ext == ".flac":
            from mutagen.flac import FLAC, Picture
            fl = FLAC(p)
            fl.clear_pictures()
            pic = Picture()
            pic.type = 3
            pic.mime = mime
            pic.data = data
            fl.add_picture(pic)
            fl.save()
        elif ext in (".m4a", ".aac", ".mp4"):
            from mutagen.mp4 import MP4, MP4Cover
            mp = MP4(p)
            fmt = MP4Cover.FORMAT_PNG if "png" in mime else MP4Cover.FORMAT_JPEG
            mp["covr"] = [MP4Cover(data, imageformat=fmt)]
            mp.save()
        elif ext == ".ogg":
            import base64
            from mutagen.oggvorbis import OggVorbis
            from mutagen.flac import Picture
            pic = Picture()
            pic.type = 3
            pic.mime = mime
            pic.data = data
            og = OggVorbis(p)
            og["metadata_block_picture"] = [base64.b64encode(pic.write()).decode("ascii")]
            og.save()
        else:
            return {"ok": False, "error": f"art editing not supported for {ext}"}
        _invalidate_track_cache(rel)
        return {"ok": True}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def extract_embedded_art(abs_path: str):
    """Return (bytes, mime) of a file's embedded cover art, or (None, None)."""
    if MutagenFile is None:
        return None, None
    try:
        audio = MutagenFile(abs_path)
    except Exception:
        return None, None
    if audio is None:
        return None, None
    try:
        # FLAC pictures
        pics = getattr(audio, "pictures", None)
        if pics:
            return pics[0].data, (pics[0].mime or "image/jpeg")
        tags = getattr(audio, "tags", None) or {}
        # MP3 APIC
        for key in list(getattr(tags, "keys", lambda: [])()):
            if str(key).startswith("APIC"):
                apic = tags[key]
                return apic.data, (apic.mime or "image/jpeg")
        # MP4 cover
        if "covr" in tags:
            cover = tags["covr"][0]
            mime = "image/png" if getattr(cover, "imageformat", None) == 14 else "image/jpeg"
            return bytes(cover), mime
        # OGG metadata_block_picture
        mbp = tags.get("metadata_block_picture") if hasattr(tags, "get") else None
        if mbp:
            import base64
            from mutagen.flac import Picture
            pic = Picture(base64.b64decode(mbp[0]))
            return pic.data, (pic.mime or "image/jpeg")
    except Exception:
        pass
    return None, None


def scan_music(music_dir: str):
    """Recursively scan `music_dir` for supported audio, returning a list of track dicts.

    Each track carries a relative ``streamPath`` so the browser can fetch audio
    same-origin (which keeps the Web Audio effects graph un-tainted regardless of
    whether the page was opened via localhost or the LAN IP).

    Parsed tags are cached in SQLite keyed by (path, mtime, size) so unchanged
    files are never re-parsed on a re-scan — this is what keeps large lossless
    libraries fast. The resulting catalog is also pushed into the FTS index.
    """
    overrides = load_metadata_sidecar(music_dir)
    tracks = []
    tag_cache = _load_meta_cache()   # {rel_posix: (mtime, size, tags)}
    new_cache_rows = []              # freshly-parsed rows to persist at the end
    seen_paths = []                  # every track path we encounter (for pruning)
    for root, dirs, files in os.walk(music_dir, onerror=lambda e: None):
        dirs.sort()
        for name in sorted(files):
            ext = os.path.splitext(name)[1].lower()
            if ext not in SUPPORTED_EXTENSIONS:
                continue
            abs_path = os.path.join(root, name)
            try:
                st = os.stat(abs_path)
                size = st.st_size
                fmtime = st.st_mtime
            except OSError:
                size = None
                fmtime = None

            rel_path = os.path.relpath(abs_path, music_dir)
            parent = os.path.basename(os.path.dirname(abs_path))
            album = parent if parent else os.path.basename(music_dir)

            # Defaults from the filename / folder.
            title = title_from_filename(name)
            artist = DEFAULT_ARTIST
            album_artist = None
            year = None
            music_director = None
            genre = None
            track_number = None
            actors = None
            duration = 0

            # Embedded tags (best-effort, never fatal). Reuse the SQLite-cached
            # parse when the file is unchanged, so re-scans skip mutagen entirely.
            rel_posix_key = rel_path.replace(os.sep, "/")
            seen_paths.append(rel_posix_key)
            cached = tag_cache.get(rel_posix_key)
            if (cached is not None and abs((cached[0] or 0) - (fmtime or 0)) < 0.001
                    and cached[1] == size):
                tags = cached[2]
            else:
                tags = read_tags(abs_path)
                new_cache_rows.append((rel_posix_key, fmtime, size, tags))
            title = tags.get("title", title)
            album = tags.get("album", album)
            artist = tags.get("artist", artist)
            album_artist = tags.get("albumArtist", album_artist)
            year = tags.get("year", year)
            music_director = tags.get("musicDirector", music_director)
            genre = tags.get("genre", genre)
            track_number = tags.get("trackNumber", track_number)
            duration = tags.get("duration", duration)

            # metadata.json sidecar overrides (by rel posix path, then bare name).
            rel_posix = rel_path.replace(os.sep, "/")
            override = overrides.get(rel_posix) or overrides.get(name)
            if isinstance(override, dict):
                if override.get("title") is not None:
                    title = override["title"]
                if override.get("album") is not None:
                    album = override["album"]
                if override.get("artist") is not None:
                    artist = override["artist"]
                if override.get("albumArtist") is not None:
                    album_artist = override["albumArtist"]
                if override.get("year") is not None:
                    year = year_from(override["year"])
                if override.get("musicDirector") is not None:
                    music_director = override["musicDirector"]
                if override.get("genre") is not None:
                    genre = override["genre"]
                if override.get("actors") is not None:
                    actors = override["actors"]

            quoted = "/".join(urllib.parse.quote(seg) for seg in rel_path.split(os.sep))
            stream_path = f"/stream/{quoted}"

            stem = os.path.splitext(abs_path)[0]
            has_lyrics = os.path.isfile(stem + ".lrc") or os.path.isfile(stem + ".txt")

            # Relative, same-origin artwork URL looked up by album (+ artist) online.
            artwork_url = None
            if ONLINE_ART and album and not album.lower().startswith("unknown"):
                artwork_url = "/art?" + urllib.parse.urlencode(
                    {"album": album, "artist": (album_artist or artist or "")}
                )

            tracks.append(
                {
                    "id": make_track_id(rel_path),
                    "title": title,
                    "artist": artist,
                    "albumArtist": album_artist,
                    "album": album or "Unknown Album",
                    "url": f"{BASE_URL}{stream_path}",
                    "streamPath": stream_path,
                    "path": rel_path.replace(os.sep, "/"),  # for lyrics lookup
                    "hasLyrics": has_lyrics,
                    "duration": duration,
                    "format": (ext.lstrip(".") or None),
                    "sizeBytes": size,
                    "artworkUrl": artwork_url,
                    "year": year,
                    "musicDirector": music_director,
                    "genre": genre,
                    "trackNumber": track_number,
                    "actors": actors,
                }
            )
    _flush_meta_cache(new_cache_rows)
    _prune_meta_cache(seen_paths)
    return tracks


# --- Catalog cache (simple library "index") --------------------------------
# Re-scanning and re-reading tags on every request is slow for big libraries, so
# we cache the scan and reuse it until the folder changes or the TTL expires.
_CATALOG_TTL = 30
_catalog_cache = {"folder": None, "at": 0.0, "mtime": None, "tracks": None}


def get_catalog(force: bool = False):
    now = time.time()
    try:
        mtime = os.path.getmtime(MUSIC_DIR)
    except OSError:
        mtime = None
    c = _catalog_cache
    if (not force and c["tracks"] is not None and c["folder"] == MUSIC_DIR
            and c["mtime"] == mtime and (now - c["at"]) < _CATALOG_TTL):
        return c["tracks"]
    tracks = scan_music(MUSIC_DIR)
    c.update(folder=MUSIC_DIR, at=now, mtime=mtime, tracks=tracks)
    index_tracks(tracks)
    return tracks


def find_lyrics(rel_path: str):
    """Return {'format','text'} from a sidecar `<track>.lrc`/`.txt`, or None."""
    file_path = safe_resolve(MUSIC_DIR, rel_path)
    if not file_path:
        return None
    stem = os.path.splitext(file_path)[0]
    for ext, fmt in ((".lrc", "lrc"), (".txt", "text")):
        p = stem + ext
        if os.path.isfile(p):
            try:
                with open(p, encoding="utf-8", errors="replace") as f:
                    return {"format": fmt, "text": f.read()}
            except OSError:
                pass
    return None


def _lyrics_paths(artist: str, title: str, album: str):
    key = "|".join([(artist or "").strip().lower(),
                    (title or "").strip().lower(),
                    (album or "").strip().lower()])
    h = hashlib.sha1(key.encode("utf-8")).hexdigest()
    base = os.path.join(LYRICS_CACHE_DIR, h)
    return base + ".lrc", base + ".txt", base + ".miss"


_GENERIC_ARTISTS = {"", "local wi-fi stream", "local library", "local network audio", "local stream"}


def _clean_artist(a):
    return "" if (a or "").strip().lower() in _GENERIC_ARTISTS else (a or "")


def _clean_title(t):
    """Strip 'Title - Artist' filename tails and (bracketed) notes for matching."""
    base = re.split(r"\s[-–—]\s", t or "")[0]
    base = re.sub(r"[\(\[].*?[\)\]]", "", base)
    return base.strip() or (t or "").strip()


def fetch_lyrics_online(artist, title, album, duration, timeout=6):
    """Fetch lyrics from LRCLIB. Returns {'format','text'} (lrc preferred) or None."""
    if not title:
        return None

    def _best(obj):
        if not isinstance(obj, dict):
            return None
        if obj.get("syncedLyrics"):
            return {"format": "lrc", "text": obj["syncedLyrics"]}
        if obj.get("plainLyrics"):
            return {"format": "text", "text": obj["plainLyrics"]}
        return None

    def _search(params):
        url = LRCLIB_BASE + "/search?" + urllib.parse.urlencode(params)
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=_ART_UA), timeout=timeout) as r:
                results = json.loads(r.read().decode("utf-8", "replace")) or []
                print(f"  [lyrics] GET {url} -> {len(results)} result(s)", file=sys.stderr)
                for item in results:
                    got = _best(item)
                    if got:
                        return got
        except Exception as exc:
            print(f"  [lyrics] GET {url} -> ERROR {exc}", file=sys.stderr)
        return None

    artist = _clean_artist(artist)
    cleaned = _clean_title(title)

    # 1) Exact get (best when real tags exist).
    params = {"track_name": title, "artist_name": artist}
    if album:
        params["album_name"] = album
    try:
        if duration:
            params["duration"] = str(int(float(duration)))
    except (TypeError, ValueError):
        pass
    get_url = LRCLIB_BASE + "/get?" + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(urllib.request.Request(get_url, headers=_ART_UA), timeout=timeout) as r:
            got = _best(json.loads(r.read().decode("utf-8", "replace")))
            print(f"  [lyrics] GET {get_url} -> {'HIT' if got else 'no match'}", file=sys.stderr)
            if got:
                return got
    except Exception as exc:
        print(f"  [lyrics] GET {get_url} -> {exc}", file=sys.stderr)

    # 2) Progressively looser searches; first hit with lyrics wins.
    attempts = []
    if artist:
        attempts.append({"track_name": title, "artist_name": artist})
    attempts.append({"track_name": title})
    if cleaned != title:
        if artist:
            attempts.append({"track_name": cleaned, "artist_name": artist})
        attempts.append({"track_name": cleaned})
    attempts.append({"q": (cleaned + (" " + album if album else "")).strip()})
    for p in attempts:
        got = _search(p)
        if got:
            return got
    return None


def get_lyrics(artist: str, title: str, album: str, duration):
    """Lyrics from the on-disk cache, fetching from LRCLIB when needed (cached)."""
    hit_lrc, hit_txt, miss = _lyrics_paths(artist, title, album)
    for p, fmt in ((hit_lrc, "lrc"), (hit_txt, "text")):
        if os.path.isfile(p):
            try:
                with open(p, encoding="utf-8", errors="replace") as f:
                    return {"format": fmt, "text": f.read()}
            except OSError:
                pass
    if not ONLINE_LYRICS:
        return None
    if os.path.isfile(miss) and (time.time() - os.path.getmtime(miss)) < LYRICS_NEG_TTL:
        return None
    with _LYRICS_LOCK:
        for p, fmt in ((hit_lrc, "lrc"), (hit_txt, "text")):
            if os.path.isfile(p):
                try:
                    with open(p, encoding="utf-8", errors="replace") as f:
                        return {"format": fmt, "text": f.read()}
                except OSError:
                    pass
        print(f"  [lyrics] lookup: title={title!r} artist={artist!r} album={album!r}", file=sys.stderr)
        data = fetch_lyrics_online(artist, title, album, duration)
        print(f"  [lyrics] result: {('FOUND ' + data['format']) if data else 'NOT FOUND'}", file=sys.stderr)
        try:
            os.makedirs(LYRICS_CACHE_DIR, exist_ok=True)
            if data:
                with open(hit_lrc if data["format"] == "lrc" else hit_txt, "w", encoding="utf-8") as f:
                    f.write(data["text"])
            else:
                open(miss, "wb").close()
        except OSError:
            pass
        return data


def safe_resolve(music_dir: str, url_path: str):
    """Resolve a /stream/ request path to a real file inside `music_dir` (traversal-safe)."""
    decoded = urllib.parse.unquote(url_path.split("?", 1)[0]).lstrip("/")
    candidate = os.path.normpath(os.path.join(music_dir, decoded))
    root = os.path.abspath(music_dir)
    cand_abs = os.path.abspath(candidate)
    if cand_abs != root and not cand_abs.startswith(root + os.sep):
        return None
    if not os.path.isfile(cand_abs):
        return None
    return cand_abs


def safe_resolve_web(url_path: str):
    """Resolve a static-asset request to a real file inside WEB_DIR (traversal-safe)."""
    decoded = urllib.parse.unquote(url_path.split("?", 1)[0]).lstrip("/")
    if not decoded:
        decoded = "index.html"
    candidate = os.path.normpath(os.path.join(WEB_DIR, decoded))
    root = os.path.abspath(WEB_DIR)
    cand_abs = os.path.abspath(candidate)
    if cand_abs != root and not cand_abs.startswith(root + os.sep):
        return None
    if not os.path.isfile(cand_abs):
        return None
    return cand_abs


def parse_range(range_header: str, file_size: int):
    """Parse a single `Range: bytes=start-end` header -> (start, end) inclusive, or None."""
    if not range_header:
        return None
    m = re.match(r"bytes=(\d*)-(\d*)", range_header.strip())
    if not m:
        return None
    start_s, end_s = m.group(1), m.group(2)
    if start_s == "" and end_s == "":
        return None
    if start_s == "":
        length = int(end_s)
        if length <= 0:
            return None
        start = max(0, file_size - length)
        end = file_size - 1
    else:
        start = int(start_s)
        end = int(end_s) if end_s != "" else file_size - 1
    end = min(end, file_size - 1)
    if start > end or start >= file_size:
        return None
    return start, end


def render_qr() -> bytes:
    """A tiny /qr page showing the URL + a scannable QR (rendered by a free web service)."""
    url = f"{BASE_URL}/"
    enc = urllib.parse.quote(url, safe="")
    qr_img = f"https://api.qrserver.com/v1/create-qr-code/?size=320x320&data={enc}"
    page = f"""<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Open AuraWave Web Player</title>
<style>body{{font-family:system-ui,sans-serif;margin:0;padding:6vw 5vw;background:#0E0F11;color:#E6E7E9;text-align:center}}
h1{{color:#1ED760;font-size:clamp(20px,6vw,28px)}}
.url{{font-size:clamp(14px,4.5vw,20px);font-weight:bold;color:#17C9C0;word-break:break-all;margin:1rem 0}}
img{{background:#fff;padding:12px;border-radius:12px;width:min(320px,80vw);height:auto}}
a.open{{display:inline-block;margin-top:1rem;background:#1ED760;color:#00210D;font-weight:800;text-decoration:none;padding:12px 20px;border-radius:10px}}
.hint{{color:#888;margin-top:1.5rem;font-size:14px}}</style></head>
<body><h1>&#127925; AuraWave Web Player</h1>
<p>Scan to open the player on your phone, or tap below:</p>
<img src="{qr_img}" alt="QR">
<div class="url">{url}</div>
<a class="open" href="/">Open the player &#9656;</a>
<p class="hint">Both devices must be on the same Wi-Fi network.</p></body></html>"""
    return page.encode("utf-8")


# ---------------------------------------------------------------------------
# Request handler
# ---------------------------------------------------------------------------

class WebPlayerHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "AuraWaveWebPlayer/1.0"

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range, Content-Type")
        self.send_header("Access-Control-Expose-Headers",
                         "Content-Range, Accept-Ranges, Content-Length")

    def _send_bytes(self, body: bytes, content_type: str, status=HTTPStatus.OK,
                    cache: bool = False):
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if cache:
            self.send_header("Cache-Control", "public, max-age=3600")
        else:
            self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_error_text(self, status, message):
        self._send_bytes(message.encode("utf-8"), "text/plain; charset=utf-8", status)

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        self.do_GET()

    def _read_body(self) -> bytes:
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        return self.rfile.read(n) if n > 0 else b""

    def _send_json(self, obj, status=HTTPStatus.OK):
        self._send_bytes(json.dumps(obj).encode("utf-8"),
                         "application/json; charset=utf-8", status)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            if path == "/scrobble":
                d = json.loads(self._read_body() or b"{}")
                log_scrobble(d.get("path"), d.get("title"), d.get("artist"),
                             d.get("album"), d.get("duration"))
                self._send_json({"ok": True})
                return
            if path == "/playlists/export":
                d = json.loads(self._read_body() or b"{}")
                res = export_playlist(d.get("name") or "playlist", d.get("paths") or [])
                self._send_json(res, HTTPStatus.OK if res.get("ok") else HTTPStatus.BAD_REQUEST)
                return
            if path == "/edit-tags":
                if mutagen is None:
                    self._send_json({"ok": False, "error": "mutagen not installed"},
                                    HTTPStatus.NOT_IMPLEMENTED)
                    return
                d = json.loads(self._read_body() or b"{}")
                res = edit_tags(d.get("path"), d)
                self._send_json(res, HTTPStatus.OK if res.get("ok") else HTTPStatus.BAD_REQUEST)
                return
            if path == "/edit-art":
                if mutagen is None:
                    self._send_json({"ok": False, "error": "mutagen not installed"},
                                    HTTPStatus.NOT_IMPLEMENTED)
                    return
                qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                rel = (qs.get("path") or [""])[0]
                ctype = self.headers.get("Content-Type", "image/jpeg")
                res = embed_art(rel, self._read_body(), ctype)
                self._send_json(res, HTTPStatus.OK if res.get("ok") else HTTPStatus.BAD_REQUEST)
                return
            self._send_json({"ok": False, "error": "unknown endpoint"}, HTTPStatus.NOT_FOUND)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            try:
                self._send_json({"ok": False, "error": str(exc)},
                                HTTPStatus.INTERNAL_SERVER_ERROR)
            except Exception:
                pass

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            if path in ("/songs.json", "/api/songs", "/music.json"):
                body = json.dumps(get_catalog()).encode("utf-8")
                self._send_bytes(body, "application/json; charset=utf-8")
                return
            if path == "/rescan":
                body = json.dumps({"count": len(get_catalog(force=True))}).encode("utf-8")
                self._send_bytes(body, "application/json; charset=utf-8")
                return
            if path == "/capabilities":
                body = json.dumps({
                    "canEditTags": mutagen is not None,
                    "fts": _HAS_FTS,
                    "watch": True,
                }).encode("utf-8")
                self._send_bytes(body, "application/json; charset=utf-8")
                return
            if path == "/search":
                qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                q = (qs.get("q") or [""])[0]
                get_catalog()  # make sure the index reflects the current library
                body = json.dumps(search_tracks(q)).encode("utf-8")
                self._send_bytes(body, "application/json; charset=utf-8")
                return
            if path == "/stats":
                self._send_bytes(json.dumps(get_stats()).encode("utf-8"),
                                 "application/json; charset=utf-8")
                return
            if path == "/playlists/disk":
                self._send_bytes(json.dumps(import_disk_playlists()).encode("utf-8"),
                                 "application/json; charset=utf-8")
                return
            if path == "/lyrics":
                qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                g = lambda k: (qs.get(k) or [""])[0]
                rel = g("path")
                # Local sidecar wins; otherwise fetch (and cache) from LRCLIB.
                data = (find_lyrics(rel) if rel else None)
                if not data:
                    data = get_lyrics(g("artist"), g("title"), g("album"), g("duration"))
                data = data or {"format": None, "text": ""}
                self._send_bytes(json.dumps(data).encode("utf-8"), "application/json; charset=utf-8")
                return
            if path == "/health":
                self._send_bytes(b'{"status":"ok"}', "application/json; charset=utf-8")
                return
            if path in ("/qr", "/qr.html"):
                self._send_bytes(render_qr(), "text/html; charset=utf-8")
                return
            if path == "/art":
                qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                self._serve_art((qs.get("artist") or [""])[0],
                                (qs.get("album") or [""])[0],
                                (qs.get("path") or [""])[0])
                return
            if path.startswith("/stream/"):
                self._serve_file(path[len("/stream"):])
                return
            # Everything else: a static asset from the web/ UI folder ("/" -> index.html).
            self._serve_web_asset(path)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # last-resort guard
            try:
                self._send_error_text(HTTPStatus.INTERNAL_SERVER_ERROR, f"Server error: {exc}")
            except Exception:
                pass

    def _serve_web_asset(self, path):
        file_path = safe_resolve_web(path)
        if not file_path:
            self._send_error_text(HTTPStatus.NOT_FOUND, "404 Not Found")
            return
        ctype, _ = mimetypes.guess_type(file_path)
        if file_path.endswith(".js"):
            ctype = "text/javascript; charset=utf-8"
        elif file_path.endswith(".css"):
            ctype = "text/css; charset=utf-8"
        elif file_path.endswith(".html"):
            ctype = "text/html; charset=utf-8"
        try:
            with open(file_path, "rb") as f:
                body = f.read()
        except OSError:
            self._send_error_text(HTTPStatus.NOT_FOUND, "404 Not Found")
            return
        # Don't cache index.html so UI edits show immediately; cache static assets.
        self._send_bytes(body, ctype or "application/octet-stream",
                         cache=not file_path.endswith("index.html"))

    def _serve_art(self, artist, album, rel_path=""):
        """Serve artwork as an image: a track's embedded cover (when `path` is given
        and present) takes priority, else the cached/online album art. 404 if none."""
        img = None
        mime = "image/jpeg"
        if rel_path:
            abs_path = _resolve_rel(rel_path)
            if abs_path:
                data, m = extract_embedded_art(abs_path)
                if data:
                    img, mime = data, (m or "image/jpeg")
        if not img:
            img = get_album_art(artist, album) if album else None
        if not img:
            self._send_error_text(HTTPStatus.NOT_FOUND, "no artwork")
            return
        self.send_response(HTTPStatus.OK)
        self._cors()
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(img)))
        self.send_header("Cache-Control", "public, max-age=604800")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(img)

    def _serve_file(self, url_path):
        file_path = safe_resolve(MUSIC_DIR, url_path)
        if not file_path:
            self._send_error_text(HTTPStatus.NOT_FOUND, "404 Not Found")
            return
        try:
            file_size = os.path.getsize(file_path)
        except OSError:
            self._send_error_text(HTTPStatus.NOT_FOUND, "404 Not Found")
            return

        content_type = mime_for(file_path)
        range_header = self.headers.get("Range")
        rng = parse_range(range_header, file_size) if range_header else None

        try:
            if rng is None:
                if range_header:  # a Range header was sent but is unsatisfiable
                    self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                    self._cors()
                    self.send_header("Content-Range", f"bytes */{file_size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                self.send_response(HTTPStatus.OK)
                self._cors()
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(file_size))
                self.send_header("Accept-Ranges", "bytes")
                self.end_headers()
                if self.command == "HEAD":
                    return
                self._pump(file_path, 0, file_size - 1)
            else:
                start, end = rng
                length = end - start + 1
                self.send_response(HTTPStatus.PARTIAL_CONTENT)
                self._cors()
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(length))
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
                self.end_headers()
                if self.command == "HEAD":
                    return
                self._pump(file_path, start, end)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _pump(self, file_path, start, end):
        remaining = end - start + 1
        with open(file_path, "rb") as f:
            f.seek(start)
            while remaining > 0:
                chunk = f.read(min(STREAM_CHUNK_SIZE, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s - %s\n" % (self.address_string(), fmt % args))


# ---------------------------------------------------------------------------
# Live folder watcher (auto-rescan)
# ---------------------------------------------------------------------------
# Detects files being added / removed / changed in the music folder and rebuilds
# the catalog automatically — no manual /rescan needed. Uses `watchdog` when it is
# installed, otherwise falls back to a lightweight polling thread so the feature
# works with a plain stdlib install too.

_rescan_timer = None
_rescan_lock = threading.Lock()


def _schedule_rescan(delay: float = 1.5):
    """Debounced rebuild: coalesce a burst of file events into one re-scan."""
    global _rescan_timer
    with _rescan_lock:
        if _rescan_timer is not None:
            _rescan_timer.cancel()

        def _do():
            try:
                n = len(get_catalog(force=True))
                print(f"  [watch] library changed -> re-indexed {n} track(s)", file=sys.stderr)
            except Exception as exc:
                print(f"  [watch] rescan failed: {exc}", file=sys.stderr)

        _rescan_timer = threading.Timer(delay, _do)
        _rescan_timer.daemon = True
        _rescan_timer.start()


def _folder_signature(music_dir: str):
    """A cheap fingerprint of the audio files in the tree (count/size/newest mtime)."""
    count = 0
    total = 0
    newest = 0.0
    for root, dirs, files in os.walk(music_dir, onerror=lambda e: None):
        dirs.sort()
        for name in files:
            if os.path.splitext(name)[1].lower() in SUPPORTED_EXTENSIONS:
                try:
                    st = os.stat(os.path.join(root, name))
                except OSError:
                    continue
                count += 1
                total += st.st_size
                newest = max(newest, st.st_mtime)
    return (count, total, round(newest, 3))


def _poll_watch(music_dir: str, interval: float = 5.0):
    last = None
    while True:
        time.sleep(interval)
        try:
            sig = _folder_signature(music_dir)
        except Exception:
            continue
        if last is not None and sig != last:
            _schedule_rescan(0.1)
        last = sig


class _AudioEventHandler(FileSystemEventHandler):
    def _relevant(self, event):
        for p in (getattr(event, "src_path", ""), getattr(event, "dest_path", "")):
            if p and os.path.splitext(p)[1].lower() in SUPPORTED_EXTENSIONS:
                return True
        return getattr(event, "is_directory", False)

    def on_any_event(self, event):
        if self._relevant(event):
            _schedule_rescan()


def start_watcher(music_dir: str):
    """Start watching `music_dir`; returns a short description of the mode used."""
    if Observer is not None:
        try:
            obs = Observer()
            obs.schedule(_AudioEventHandler(), music_dir, recursive=True)
            obs.daemon = True
            obs.start()
            return "watchdog (instant)"
        except Exception as exc:
            print(f"  [watch] watchdog failed ({exc}); using polling", file=sys.stderr)
    t = threading.Thread(target=_poll_watch, args=(music_dir,), daemon=True)
    t.start()
    return "polling (every 5s)"


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

def print_banner(ip, port, music_dir, track_count, watch_mode="off"):
    url = f"http://{ip}:{port}/"
    line = "=" * 62
    print()
    print(line)
    print("  AuraWave WEB PLAYER is RUNNING")
    print(line)
    print(f"  Serving folder : {music_dir}")
    print(f"  Tracks found   : {track_count}")
    print()
    print("  Open THIS in your browser (phone or PC on the same Wi-Fi):")
    print()
    print(f"        >>>  {url}  <<<")
    print()
    print(f"  Scan a QR to open on your phone:  {url}qr")
    print(f"  JSON catalog:  {url}songs.json")
    print(f"  Album artwork: {'ON (downloaded online + cached)' if ONLINE_ART else 'OFF'}")
    print(f"  Online lyrics: {'ON (LRCLIB + cached; sidecars still used)' if ONLINE_LYRICS else 'OFF (sidecar files only)'}")
    print(f"  Folder watch : {watch_mode}")
    print(f"  SQLite index : {DB_PATH} (FTS5 {'ON' if _HAS_FTS else 'OFF -> LIKE search'})")
    print(f"  Tag editor   : {'ON (mutagen)' if mutagen is not None else 'OFF (install mutagen to enable)'}")
    if mutagen is None:
        print()
        print("  (mutagen not installed: year/genre/duration come from metadata.json;")
        print("   the in-browser tag/cover-art editor is disabled)")
    print(line)
    print("  Press Ctrl+C to stop the server.")
    print(line)
    print()


def main():
    parser = argparse.ArgumentParser(
        description="AuraWave web music player + streaming server (stdlib only)."
    )
    parser.add_argument("--dir", "-d", default=None,
                        help="Folder of music to serve (default: current directory).")
    parser.add_argument("--port", "-p", type=int, default=DEFAULT_PORT,
                        help=f"Port to listen on (default: {DEFAULT_PORT}).")
    parser.add_argument("--host", default="0.0.0.0",
                        help="Interface to bind (default: 0.0.0.0 = all interfaces).")
    parser.add_argument("--no-online-art", action="store_true",
                        help="Disable downloading album artwork from the internet.")
    parser.add_argument("--art-cache", default=None,
                        help="Folder to cache downloaded artwork (default: ./art_cache).")
    parser.add_argument("--no-online-lyrics", action="store_true",
                        help="Disable downloading lyrics from LRCLIB (sidecar files still work).")
    parser.add_argument("--lyrics-cache", default=None,
                        help="Folder to cache downloaded lyrics (default: ./lyrics_cache).")
    parser.add_argument("--no-watch", action="store_true",
                        help="Disable the live folder watcher (manual /rescan only).")
    parser.add_argument("--db", default=None,
                        help="Path to the SQLite index/scrobble DB (default: ./library.db).")
    parser.add_argument("--lastfm-key", default=None, help="Last.fm API key (optional scrobble push).")
    parser.add_argument("--lastfm-secret", default=None, help="Last.fm shared secret.")
    parser.add_argument("--lastfm-session", default=None, help="Pre-obtained Last.fm session key.")
    args = parser.parse_args()

    global MUSIC_DIR, BASE_URL, ONLINE_ART, ART_CACHE_DIR, ONLINE_LYRICS, LYRICS_CACHE_DIR
    global DB_PATH, LASTFM_API_KEY, LASTFM_SECRET, LASTFM_SESSION
    ONLINE_ART = not args.no_online_art
    if args.art_cache:
        ART_CACHE_DIR = os.path.abspath(os.path.expanduser(args.art_cache))
    ONLINE_LYRICS = not args.no_online_lyrics
    if args.lyrics_cache:
        LYRICS_CACHE_DIR = os.path.abspath(os.path.expanduser(args.lyrics_cache))
    if args.db:
        DB_PATH = os.path.abspath(os.path.expanduser(args.db))
    LASTFM_API_KEY = args.lastfm_key
    LASTFM_SECRET = args.lastfm_secret
    LASTFM_SESSION = args.lastfm_session

    music_dir = os.path.abspath(os.path.expanduser(args.dir or os.getcwd()))
    if not os.path.isdir(music_dir):
        print(f"ERROR: music folder does not exist: {music_dir}", file=sys.stderr)
        sys.exit(1)
    MUSIC_DIR = music_dir

    if not os.path.isdir(WEB_DIR):
        print(f"ERROR: web UI folder missing: {WEB_DIR}", file=sys.stderr)
        print("The 'web' folder must sit next to web_player.py.", file=sys.stderr)
        sys.exit(1)

    ip = get_lan_ip()
    BASE_URL = f"http://{ip}:{args.port}"

    for ext, mt in AUDIO_MIME_TYPES.items():
        mimetypes.add_type(mt, ext)

    init_db()

    try:
        initial = get_catalog(force=True)  # scan + build the SQLite/FTS index
    except PermissionError:
        initial = []

    watch_mode = "off"
    if not args.no_watch:
        try:
            watch_mode = start_watcher(MUSIC_DIR)
        except Exception as exc:
            print(f"  [watch] could not start watcher: {exc}", file=sys.stderr)

    try:
        httpd = ThreadingHTTPServer((args.host, args.port), WebPlayerHandler)
    except OSError as exc:
        print(f"ERROR: could not bind {args.host}:{args.port} -> {exc}", file=sys.stderr)
        print("Try another port, e.g. python web_player.py --port 8010", file=sys.stderr)
        sys.exit(1)
    httpd.daemon_threads = True

    print_banner(ip, args.port, MUSIC_DIR, len(initial), watch_mode)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down (Ctrl+C)...")
    finally:
        httpd.shutdown()
        httpd.server_close()
        print("Server stopped. Goodbye!")


if __name__ == "__main__":
    main()
