#!/usr/bin/env python3
"""
AuraWave Desktop Music Server
=============================

A local Wi-Fi music streaming server with a modern CustomTkinter GUI.

What it does
------------
* Lets you pick a music folder and indexes every supported track in it.
* Runs a Flask HTTP server (on a background thread via the production-grade
  `waitress` WSGI server) so the GUI never freezes while serving audio.
* Exposes a JSON catalog and a byte-range-capable streaming endpoint so phones
  can stream MP3 / FLAC / WAV / M4A smoothly over the local network and seek
  instantly.
* Shows a live "Connected Devices" table: every phone that fetches the catalog
  or streams a track appears with its IP, status, the action/track it last
  requested, when it connected and how many requests it has made.

This file is intentionally self-contained and heavily commented so it can be
read top-to-bottom. It is split into three logical sections:

    1. ServerState      - thread-safe shared state (catalog + device registry)
    2. create_app()     - the Flask application (HTTP + API + streaming)
    3. ServerGUI        - the CustomTkinter desktop interface

Run it with:  python app.py
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Optional

# --- Third-party GUI / web dependencies (see requirements.txt) --------------
import customtkinter as ctk
from tkinter import ttk, filedialog
import tkinter as tk

from flask import (
    Flask, Response, jsonify, request, send_file, send_from_directory, abort, redirect,
)
from waitress.server import create_server

import qrcode  # pure-python QR encoder; we render its matrix onto a Tk canvas

# mutagen reads embedded audio tags (year / composer / genre / track number).
# It is optional: if it is missing or a file has no/broken tags, indexing still
# works and the affected fields simply fall back to defaults / null.
try:
    import mutagen  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    mutagen = None


# ---------------------------------------------------------------------------
# Configuration constants
# ---------------------------------------------------------------------------

# Audio formats we index and stream. FLAC and WAV are lossless; the rest lossy.
AUDIO_EXTENSIONS = {".mp3", ".flac", ".wav", ".m4a", ".aac", ".ogg"}

# Correct MIME types for reliable playback (Python's mimetypes module does not
# always know FLAC, so we map explicitly).
MIME_TYPES = {
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
}

DEFAULT_PORT = 8080

# Worker threads = how many requests (e.g. audio streams) are served at the exact
# same instant. Each active stream holds one thread until the player stops/seeks.
DEFAULT_THREADS = 16
# Hard ceiling on simultaneous open connections (browsing + streaming).
CONNECTION_LIMIT = 200

# A device is considered "online"/active if it made a request within this many
# seconds; otherwise it is shown as "idle".
ACTIVE_WINDOW_SECONDS = 15

# --- Online album artwork ---------------------------------------------------
# When enabled, the server looks up cover art by album (+ artist) from the free
# iTunes Search API (no key needed), caches the JPEG on disk, and serves it via
# the /art endpoint. Works offline once cached; 404s when neither cached nor
# reachable. Flip ONLINE_ART to False to disable online lookups entirely.
ONLINE_ART = True
ART_CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "art_cache")
ART_NEG_TTL = 7 * 24 * 3600            # re-try a failed lookup after a week
ITUNES_SEARCH = "https://itunes.apple.com/search"
_ART_LOCK = threading.Lock()           # serialise online fetches (gentle on the API)
_ART_UA = {"User-Agent": "AuraWaveDesktop/1.0 (+local)"}


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
    try:
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
            # Re-check: another thread may have fetched it while we waited.
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
    except Exception:
        return None


# --- Online lyrics (LRCLIB: free, no API key, time-synced) -----------------
# Looks up lyrics by title/artist(/album/duration), caches them on disk, and
# serves them via /lyrics. A local "<track>.lrc"/".txt" sidecar always wins.
ONLINE_LYRICS = True
LYRICS_CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lyrics_cache")
LYRICS_NEG_TTL = 7 * 24 * 3600
LRCLIB_BASE = "https://lrclib.net/api"
_LYRICS_LOCK = threading.Lock()


def find_lyrics_sidecar(abs_path: str):
    """Return {'format','text'} from a sidecar `<track>.lrc`/`.txt`, or None."""
    if not abs_path:
        return None
    stem = os.path.splitext(abs_path)[0]
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
                print(f"  [lyrics] GET {url} -> {len(results)} result(s)", flush=True)
                for item in results:
                    got = _best(item)
                    if got:
                        return got
        except Exception as exc:
            print(f"  [lyrics] GET {url} -> ERROR {exc}", flush=True)
        return None

    artist = _clean_artist(artist)
    cleaned = _clean_title(title)

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
            print(f"  [lyrics] GET {get_url} -> {'HIT' if got else 'no match'}", flush=True)
            if got:
                return got
    except Exception as exc:
        print(f"  [lyrics] GET {get_url} -> {exc}", flush=True)

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
        data = fetch_lyrics_online(artist, title, album, duration)
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


# ---------------------------------------------------------------------------
# Duplicate-song detection + relocation
# ---------------------------------------------------------------------------

DUP_DEST_FOLDER = "Duplicates"


def _safe_size(path: str) -> int:
    try:
        return os.path.getsize(path)
    except OSError:
        return 0


def _file_sha1(path: str, chunk: int = 1024 * 1024) -> str:
    """Full-content SHA-1 of a file (used to confirm byte-identical duplicates)."""
    h = hashlib.sha1()
    with open(path, "rb") as f:
        while True:
            block = f.read(chunk)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def _norm(text: str) -> str:
    """Normalize a title/artist for loose matching (lowercase, drop bracketed notes)."""
    return re.sub(r"\s+", " ", re.sub(r"[\(\[].*?[\)\]]", "", (text or "").lower())).strip()


def _meta_for_dup(path: str):
    tags = read_tags(path)
    title = tags.get("title") or os.path.splitext(os.path.basename(path))[0].replace("_", " ")
    artist = tags.get("artist") or ""
    return title, artist


def find_duplicate_groups(folder: str, mode: str = "content", progress=None):
    """Return duplicate groups (each a list of paths, len >= 2, keeper first).

    mode="content"  -> byte-identical files (size bucket, then SHA-1).
    mode="metadata" -> same normalized Title + Artist (catches different bitrates).
    The keeper (index 0) is the largest file in the group. The Duplicates
    destination subfolder is skipped so re-runs are safe.
    """
    dest = os.path.join(os.path.abspath(folder), DUP_DEST_FOLDER)
    files = []
    for root, _dirs, names in os.walk(folder):
        ar = os.path.abspath(root)
        if ar == dest or ar.startswith(dest + os.sep):
            continue
        for n in names:
            if os.path.splitext(n)[1].lower() in AUDIO_EXTENSIONS:
                files.append(os.path.join(root, n))

    groups: dict = {}
    if mode == "content":
        by_size: dict = {}
        for p in files:
            by_size.setdefault(_safe_size(p), []).append(p)
        candidates = [p for paths in by_size.values() if len(paths) > 1 for p in paths]
        total, done = len(candidates), 0
        for paths in by_size.values():
            if len(paths) < 2:
                continue
            for p in paths:
                try:
                    key = _file_sha1(p)
                except OSError:
                    done += 1
                    continue
                groups.setdefault(key, []).append(p)
                done += 1
                if progress:
                    progress(done, total)
    else:  # metadata
        for p in files:
            title, artist = _meta_for_dup(p)
            key = (_norm(title), _norm(artist))
            if not key[0]:
                continue
            groups.setdefault(key, []).append(p)

    result = []
    for paths in groups.values():
        if len(paths) > 1:
            result.append(sorted(paths, key=lambda x: (-_safe_size(x), x.lower())))
    result.sort(key=lambda g: g[0].lower())
    return result


def move_duplicates(folder: str, groups):
    """Move all-but-keeper of each group into <folder>/Duplicates. Returns (moved, errors)."""
    dest = os.path.join(folder, DUP_DEST_FOLDER)
    os.makedirs(dest, exist_ok=True)
    moved, errors = 0, []
    for group in groups:
        for p in group[1:]:  # keep index 0
            try:
                base, ext = os.path.splitext(os.path.basename(p))
                target = os.path.join(dest, base + ext)
                i = 1
                while os.path.exists(target):
                    target = os.path.join(dest, f"{base} ({i}){ext}")
                    i += 1
                shutil.move(p, target)
                moved += 1
            except Exception as exc:
                errors.append(f"{os.path.basename(p)}: {exc}")
    return moved, errors


def find_web_dir() -> Optional[str]:
    """Locate the AuraWave Web Player UI assets (index.html / styles.css / app.js).

    Checked in order: a ``web`` folder next to this app, then the sibling
    ``web-player/web`` subproject in the workspace. Returns the folder or None.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(here, "web"),
        os.path.abspath(os.path.join(here, "..", "web-player", "web")),
    ]
    for c in candidates:
        if os.path.isdir(c) and os.path.isfile(os.path.join(c, "index.html")):
            return c
    return None


def get_local_ip() -> str:
    """Return this machine's primary LAN IP (the one a phone would connect to)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # No packets are actually sent; this just picks the right interface.
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip


# ---------------------------------------------------------------------------
# Metadata helpers (embedded tags via mutagen + optional metadata.json sidecar)
# ---------------------------------------------------------------------------

def _first(value):
    """mutagen's easy tags come back as lists; return the first scalar or None."""
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        return value[0] if value else None
    return value


def _parse_year(raw) -> Optional[int]:
    """Pull the leading 4-digit year out of a date-ish value, else None."""
    if raw is None:
        return None
    m = re.search(r"\d{4}", str(raw))
    return int(m.group()) if m else None


def _parse_track_number(raw) -> Optional[int]:
    """Parse a 'tracknumber' tag (e.g. '3' or '3/12') into an int, else None."""
    if raw is None:
        return None
    s = str(raw).split("/")[0].strip()
    try:
        return int(s)
    except ValueError:
        return None


def read_tags(path: str) -> dict:
    """Best-effort read of embedded audio tags via mutagen.

    Returns a dict possibly containing: title, artist, album, year,
    musicDirector, genre, trackNumber, duration. Missing/broken tags simply
    leave the corresponding key out. This never raises, so a file with no tags
    (or no mutagen installed) just yields an empty dict and the caller keeps its
    existing filename-based defaults.
    """
    tags: dict = {}
    if mutagen is None:
        return tags

    # Primary: the "easy" (human-friendly) tag mapping, which normalizes ID3 /
    # Vorbis / MP4 tag names into common keys like 'artist', 'composer', etc.
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
            year = _parse_year(_first(get("date")) or _first(get("originaldate")))
            if year is not None:
                tags["year"] = year
            composer = _first(get("composer"))
            if composer:
                tags["musicDirector"] = composer
            genre = _first(get("genre"))
            if genre:
                tags["genre"] = genre
            track_number = _parse_track_number(_first(get("tracknumber")))
            if track_number is not None:
                tags["trackNumber"] = track_number
        except Exception:
            pass
        # Bonus: duration straight from the decoded stream info, if available.
        try:
            info = getattr(easy, "info", None)
            if info is not None and getattr(info, "length", None):
                tags["duration"] = int(info.length)
        except Exception:
            pass

    # Fallback: raw ID3 frames for the fields the easy mapping can miss
    # (TDRC/TYER for the year, TCOM for the composer / music director,
    # TPE2 for the album artist).
    try:
        if "year" not in tags or "musicDirector" not in tags or "albumArtist" not in tags:
            raw = mutagen.File(path)
            raw_tags = getattr(raw, "tags", None) if raw is not None else None
            if raw_tags is not None:
                if "year" not in tags:
                    frame = raw_tags.get("TDRC") or raw_tags.get("TYER")
                    y = _parse_year(str(frame)) if frame else None
                    if y is not None:
                        tags["year"] = y
                if "musicDirector" not in tags:
                    tcom = raw_tags.get("TCOM")
                    if tcom:
                        tags["musicDirector"] = str(tcom)
                if "albumArtist" not in tags:
                    tpe2 = raw_tags.get("TPE2")
                    if tpe2:
                        tags["albumArtist"] = str(tpe2)
    except Exception:
        pass

    return tags


def load_metadata_sidecar(folder: str) -> dict:
    """Load optional per-track overrides from `<folder>/metadata.json`.

    The file maps a key -> an object of override fields. Keys may be either the
    track's relative path (posix slashes) OR its bare filename. Supported
    override fields: year, musicDirector, actors, album, artist, albumArtist,
    genre. ``actors`` is the ONLY place that value ever comes from.

    Returns an empty dict when the file is absent or malformed (guarded).
    """
    path = os.path.join(folder, "metadata.json")
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
# Advanced endpoints: SQLite scrobble/stats + search + playlists + tag editor
# ---------------------------------------------------------------------------
# A small SQLite DB (aurawave.db, next to this file) stores the local
# play-history ("scrobbles") and a catalog index used for /search (FTS5 when the
# sqlite3 build supports it, a LIKE substring search otherwise). The DB is
# created lazily and never crashes the server if it can't be written. The tag /
# cover-art editor uses mutagen (already a dependency here); when it is somehow
# unavailable those endpoints return an error JSON and /capabilities reports
# canEditTags=false.

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "aurawave.db")
_DB_LOCK = threading.RLock()
_HAS_FTS = False  # set True by init_db() when this sqlite3 build has FTS5.

PLAYLIST_EXTS = (".m3u", ".m3u8", ".pls")


def _db():
    """Open a short-lived SQLite connection (one per operation; thread-safe)."""
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """Create tables (and the FTS index when available). Safe to call repeatedly;
    never raises — a DB that can't be created just disables scrobble/search."""
    global _HAS_FTS
    try:
        with _DB_LOCK, _db() as c:
            c.executescript(
                """
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
                    "id UNINDEXED, title, artist, album, albumArtist, "
                    "musicDirector, genre, json UNINDEXED)"
                )
                _HAS_FTS = True
            except sqlite3.OperationalError:
                _HAS_FTS = False  # sqlite3 built without FTS5 -> LIKE fallback
    except Exception as exc:
        print(f"  [db] init failed: {exc}", flush=True)


def index_tracks(tracks):
    """Rebuild the `tracks` table + FTS index from a list of catalog track dicts."""
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
        print(f"  [index] failed: {exc}", flush=True)


def search_tracks(query, limit: int = 500):
    """Full-text (FTS5) search of the indexed catalog; LIKE fallback otherwise."""
    q = (query or "").strip()
    if not q:
        return []
    try:
        with _DB_LOCK, _db() as c:
            if _HAS_FTS:
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
        print(f"  [search] failed: {exc}", flush=True)
        return []


def log_scrobble(path, title, artist, album, duration):
    """Record one play in the local history."""
    try:
        with _DB_LOCK, _db() as c:
            c.execute(
                "INSERT INTO scrobbles(ts, path, title, artist, album, duration)"
                " VALUES(?,?,?,?,?,?)",
                (time.time(), path, title, artist, album, int(duration or 0)),
            )
    except Exception as exc:
        print(f"  [scrobble] failed: {exc}", flush=True)


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
        print(f"  [stats] failed: {exc}", flush=True)
    return out


def _desktop_track_id(rel_path: str) -> str:
    """Track id matching Song.id in /songs.json (str(abs(hash(rel_path))))."""
    return str(abs(hash(rel_path)))


def _parse_playlist_file(abs_path: str, folder: str):
    """Parse a .m3u/.m3u8/.pls file into local track ids inside `folder`.

    Ids use the same scheme as /songs.json so they line up with the catalog."""
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
    root = os.path.abspath(folder)
    for entry in entries:
        if re.match(r"^[a-zA-Z][a-zA-Z0-9+.\-]*://", entry):
            continue  # skip remote URLs; we can only map local files to track ids
        cand = entry if os.path.isabs(entry) else os.path.join(pdir, entry)
        cand = os.path.abspath(os.path.normpath(cand))
        if (cand == root or cand.startswith(root + os.sep)) and os.path.isfile(cand):
            rel = os.path.relpath(cand, root)
            ids.append(_desktop_track_id(rel))
    return ids


def import_disk_playlists(folder: str):
    """Find .m3u/.m3u8/.pls files in `folder` and parse each to track ids."""
    out = []
    if not folder or not os.path.isdir(folder):
        return out
    for root, dirs, files in os.walk(folder, onerror=lambda e: None):
        dirs.sort()
        for name in sorted(files):
            if os.path.splitext(name)[1].lower() in PLAYLIST_EXTS:
                ids = _parse_playlist_file(os.path.join(root, name), folder)
                if ids:
                    out.append({"name": os.path.splitext(name)[0], "songs": ids})
    return out


def export_playlist(folder: str, name: str, paths):
    """Write an .m3u playlist into `folder` from a list of relative paths."""
    if not folder or not os.path.isdir(folder):
        return {"ok": False, "error": "no music folder selected"}
    safe_name = re.sub(r'[\\/:*?"<>|]+', "_", (name or "playlist")).strip() or "playlist"
    out_path = os.path.join(folder, safe_name + ".m3u")
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


def edit_tags_file(abs_path: str, fields: dict):
    """Write editable tags into the file at `abs_path` via mutagen."""
    if mutagen is None:
        return {"ok": False, "error": "mutagen not installed"}
    try:
        audio = mutagen.File(abs_path, easy=True)
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
                    except Exception:
                        pass
                else:
                    audio[ez] = val
        if fields.get("year") is not None:
            y = str(fields["year"]).strip()
            if y == "":
                for key in ("date", "originaldate", "year"):
                    try:
                        del audio[key]
                    except Exception:
                        pass
            else:
                audio["date"] = y
        audio.save()
        return {"ok": True}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def embed_art_file(abs_path: str, data: bytes, ctype: str):
    """Embed cover-art bytes into the file at `abs_path` (format-specific via mutagen)."""
    if mutagen is None:
        return {"ok": False, "error": "mutagen not installed"}
    if not data:
        return {"ok": False, "error": "empty image"}
    ext = os.path.splitext(abs_path)[1].lower()
    mime = (ctype or "image/jpeg").split(";")[0].strip() or "image/jpeg"
    try:
        if ext == ".mp3":
            from mutagen.id3 import ID3, APIC
            try:
                tags = ID3(abs_path)
            except Exception:
                tags = ID3()
            tags.delall("APIC")
            tags.add(APIC(encoding=3, mime=mime, type=3, desc="Cover", data=data))
            tags.save(abs_path)
        elif ext == ".flac":
            from mutagen.flac import FLAC, Picture
            fl = FLAC(abs_path)
            fl.clear_pictures()
            pic = Picture()
            pic.type = 3
            pic.mime = mime
            pic.data = data
            fl.add_picture(pic)
            fl.save()
        elif ext in (".m4a", ".aac", ".mp4"):
            from mutagen.mp4 import MP4, MP4Cover
            mp = MP4(abs_path)
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
            og = OggVorbis(abs_path)
            og["metadata_block_picture"] = [base64.b64encode(pic.write()).decode("ascii")]
            og.save()
        else:
            return {"ok": False, "error": f"art editing not supported for {ext}"}
        return {"ok": True}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


# ---------------------------------------------------------------------------
# 1. Shared, thread-safe state
# ---------------------------------------------------------------------------

@dataclass
class DeviceInfo:
    """Live record of one connected client (phone / browser)."""
    ip: str
    first_seen: float
    last_seen: float
    last_action: str = "Connected"
    last_track: str = "-"
    request_count: int = 0


@dataclass
class Song:
    """One indexed audio file. Field names match the Android app's JSON model."""
    id: str
    title: str
    filename: str
    rel_path: str          # path relative to the music folder (used for streaming)
    artist: str
    album: str
    album_artist: Optional[str]             # album-level artist (TPE2 / albumartist)
    fmt: str               # e.g. "FLAC"
    size_bytes: int
    duration: int = 0                       # seconds; from tags when available
    year: Optional[int] = None              # release year
    music_director: Optional[str] = None    # composer / music director
    genre: Optional[str] = None
    track_number: Optional[int] = None
    actors: Optional[str] = None            # comma-separated; sidecar-only
    has_lyrics: bool = False                 # a .lrc/.txt sidecar exists

    def to_json(self, base_url: str) -> dict:
        """Serialize to the JSON shape the mobile client expects.

        `base_url` is derived from the incoming request so the stream URL always
        points back at the exact interface the phone used to reach us.
        """
        quoted = urllib.parse.quote(self.rel_path.replace("\\", "/"))
        # Absolute artwork URL looked up by album (+ albumArtist/artist) online,
        # but only when the album is known and not an "unknown"-style placeholder.
        # Built off the request-derived base_url so it points at the right NIC.
        artwork_url = None
        if ONLINE_ART and self.album and not self.album.lower().startswith("unknown"):
            artwork_url = f"{base_url}/art?" + urllib.parse.urlencode(
                {"album": self.album, "artist": (self.album_artist or self.artist or "")}
            )
        return {
            "id": self.id,
            "title": self.title,
            "filename": self.filename,
            "artist": self.artist,
            "albumArtist": self.album_artist,
            "album": self.album,
            "url": f"{base_url}/stream/{quoted}",
            "path": self.rel_path.replace("\\", "/"),  # for lyrics sidecar lookup
            "hasLyrics": self.has_lyrics,
            "duration": self.duration,
            "format": self.fmt,
            "sizeBytes": self.size_bytes,
            "artworkUrl": artwork_url,
            # Richer metadata for sorting / grouping in the Android app.
            "year": self.year,
            "musicDirector": self.music_director,
            "genre": self.genre,
            "trackNumber": self.track_number,
            "actors": self.actors,
        }


class ServerState:
    """Holds the catalog and the device registry, guarded by a single lock.

    Both the Flask worker threads and the Tkinter GUI thread touch this object,
    so every read/write goes through `self._lock`.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.music_folder: Optional[str] = None
        self.songs: List[Song] = []
        self._devices: Dict[str, DeviceInfo] = {}
        # Simple event log (ring buffer) surfaced in the GUI.
        self._log: List[str] = []

    # --- catalog ----------------------------------------------------------
    def scan_folder(self, folder: str) -> int:
        """Index all supported audio files under `folder`. Returns the count.

        For each file we start from the historical filename/folder-based
        defaults, then layer embedded tags (via mutagen) on top, then finally
        apply any overrides from an optional ``metadata.json`` sidecar in the
        served folder (the only source of the ``actors`` field).
        """
        overrides = load_metadata_sidecar(folder)
        songs: List[Song] = []
        for root, _dirs, files in os.walk(folder):
            for name in sorted(files):
                ext = os.path.splitext(name)[1].lower()
                if ext not in AUDIO_EXTENSIONS:
                    continue
                full_path = os.path.join(root, name)
                rel_path = os.path.relpath(full_path, folder)
                try:
                    size = os.path.getsize(full_path)
                except OSError:
                    size = 0

                # --- 1) current (filename / folder) defaults ------------------
                # Keep " - " so lyrics lookup can split off a "Title - Artist" tail.
                title = os.path.splitext(name)[0].replace("_", " ").strip()
                album = os.path.basename(os.path.dirname(full_path)) or "Local Music"
                artist = "Local Library"
                album_artist = None
                year = None
                music_director = None
                genre = None
                track_number = None
                actors = None
                duration = 0

                # --- 2) embedded tags (best-effort, never fatal) --------------
                tags = read_tags(full_path)
                if tags.get("title"):
                    title = tags["title"]
                if tags.get("album"):
                    album = tags["album"]
                if tags.get("artist"):
                    artist = tags["artist"]
                if tags.get("albumArtist"):
                    album_artist = tags["albumArtist"]
                year = tags.get("year", year)
                music_director = tags.get("musicDirector", music_director)
                genre = tags.get("genre", genre)
                track_number = tags.get("trackNumber", track_number)
                duration = tags.get("duration", duration)

                # --- 3) metadata.json sidecar overrides -----------------------
                # Match by relative posix path first, then by bare filename.
                rel_posix = rel_path.replace("\\", "/")
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
                        year = _parse_year(override["year"])
                    if override.get("musicDirector") is not None:
                        music_director = override["musicDirector"]
                    if override.get("genre") is not None:
                        genre = override["genre"]
                    if override.get("actors") is not None:
                        actors = override["actors"]

                songs.append(
                    Song(
                        id=str(abs(hash(rel_path))),
                        title=title,
                        filename=name,
                        rel_path=rel_path,
                        artist=artist,
                        album=album,
                        album_artist=album_artist,
                        fmt=ext.strip(".").upper(),
                        size_bytes=size,
                        duration=duration,
                        year=year,
                        music_director=music_director,
                        genre=genre,
                        track_number=track_number,
                        actors=actors,
                        has_lyrics=(os.path.isfile(os.path.splitext(full_path)[0] + ".lrc")
                                    or os.path.isfile(os.path.splitext(full_path)[0] + ".txt")),
                    )
                )
        with self._lock:
            self.music_folder = folder
            self.songs = songs
        return len(songs)

    def get_songs_json(self, base_url: str) -> List[dict]:
        with self._lock:
            return [s.to_json(base_url) for s in self.songs]

    def resolve_stream_path(self, rel_path: str) -> Optional[str]:
        """Safely resolve a requested relative path to an absolute file path.

        Guards against path-traversal (`../`) so only files inside the selected
        music folder can ever be served.
        """
        with self._lock:
            folder = self.music_folder
        if not folder:
            return None
        base = os.path.realpath(folder)
        target = os.path.realpath(os.path.join(base, rel_path))
        if target != base and not target.startswith(base + os.sep):
            return None  # escaped the music folder -> refuse
        if not os.path.isfile(target):
            return None
        return target

    # --- device registry --------------------------------------------------
    def record_request(self, ip: str, action: str, track: str = "-") -> None:
        now = time.time()
        with self._lock:
            dev = self._devices.get(ip)
            if dev is None:
                dev = DeviceInfo(ip=ip, first_seen=now, last_seen=now)
                self._devices[ip] = dev
            dev.last_seen = now
            dev.last_action = action
            dev.last_track = track
            dev.request_count += 1

    def devices_snapshot(self) -> List[DeviceInfo]:
        """Return a copy of all known devices, newest activity first."""
        with self._lock:
            return sorted(
                (DeviceInfo(**vars(d)) for d in self._devices.values()),
                key=lambda d: d.last_seen,
                reverse=True,
            )

    def active_count(self) -> int:
        cutoff = time.time() - ACTIVE_WINDOW_SECONDS
        with self._lock:
            return sum(1 for d in self._devices.values() if d.last_seen >= cutoff)

    def clear_devices(self) -> None:
        with self._lock:
            self._devices.clear()

    # --- log --------------------------------------------------------------
    def add_log(self, message: str) -> None:
        stamp = datetime.now().strftime("%H:%M:%S")
        with self._lock:
            self._log.append(f"[{stamp}] {message}")
            # Keep only the most recent 200 lines.
            if len(self._log) > 200:
                self._log = self._log[-200:]

    def drain_log(self) -> List[str]:
        with self._lock:
            lines, self._log = self._log, []
            return lines


# ---------------------------------------------------------------------------
# 1b. AI vocal removal + stem mixer (server-side Demucs, background + parallel)
# ---------------------------------------------------------------------------
# Runs a neural source-separation model (Demucs) to produce a vocal-free mix
# ("instrumental") or a full 4-stem split (vocals/drums/bass/other) that the
# browser re-mixes at chosen volumes. Separation is slow, so results are cached
# on disk and produced by a pool of background workers (AI_WORKERS). A single
# Demucs pass already yields every stem, so parallelism only helps DIFFERENT
# tracks (e.g. the current track + a prefetched upcoming one) separate at once.
# Config via env vars so the GUI build needs no CLI flags.

STEM_CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "stem_cache")
DEMUCS_MODEL = os.environ.get("AURAWAVE_DEMUCS_MODEL", "htdemucs")
AI_DEVICE = os.environ.get("AURAWAVE_AI_DEVICE") or None       # "cuda" | "cpu" | None(auto)
ENABLE_AI = os.environ.get("AURAWAVE_NO_AI", "") not in ("1", "true", "True")
AI_WORKERS = max(1, int(os.environ.get("AURAWAVE_AI_WORKERS", "1") or 1))
FFMPEG_PATH = os.environ.get("AURAWAVE_FFMPEG") or None
STEM_NAMES = ("vocals", "drums", "bass", "other")

_STEM_JOBS: Dict[str, dict] = {}    # key -> {status,out,error,progress}  (instrumental)
_STEM4_JOBS: Dict[str, dict] = {}   # key -> {status,error,progress}      (4-stem mixer)
_STEM_JOBS_LOCK = threading.Lock()
_STEM_QUEUE = None                  # queue.Queue of 0-arg task callables
_STEM_WORKERS: List[threading.Thread] = []
_FFMPEG_CACHE = None
_AI_LOG = None                      # set by create_app() -> state.add_log


def _ailog(msg: str) -> None:
    if _AI_LOG:
        try:
            _AI_LOG(msg)
            return
        except Exception:
            pass
    print(msg, file=sys.stderr)


def demucs_available() -> bool:
    if not ENABLE_AI:
        return False
    try:
        import importlib.util
        return importlib.util.find_spec("demucs") is not None
    except Exception:
        return False


def _ffmpeg() -> Optional[str]:
    """Resolve ffmpeg: explicit override, PATH, then common install locations."""
    global _FFMPEG_CACHE
    if _FFMPEG_CACHE and os.path.isfile(_FFMPEG_CACHE):
        return _FFMPEG_CACHE
    if FFMPEG_PATH and os.path.isfile(FFMPEG_PATH):
        _FFMPEG_CACHE = FFMPEG_PATH
        return _FFMPEG_CACHE
    found = shutil.which("ffmpeg")
    if found:
        _FFMPEG_CACHE = found
        return found
    import glob
    cands = []
    la = os.environ.get("LOCALAPPDATA", "")
    if la:
        cands += glob.glob(os.path.join(la, "Microsoft", "WinGet", "Packages",
                                        "Gyan.FFmpeg*", "**", "ffmpeg.exe"), recursive=True)
    up = os.environ.get("USERPROFILE", "")
    if up:
        cands += glob.glob(os.path.join(up, "scoop", "apps", "ffmpeg", "**", "ffmpeg.exe"), recursive=True)
    pd = os.environ.get("ProgramData", "")
    if pd:
        cands.append(os.path.join(pd, "chocolatey", "bin", "ffmpeg.exe"))
    cands += glob.glob(r"C:\ffmpeg\**\ffmpeg.exe", recursive=True)
    for c in cands:
        if os.path.isfile(c):
            _FFMPEG_CACHE = c
            return c
    return None


def _stem_key(abs_path: str) -> str:
    try:
        st = os.stat(abs_path)
        sig = f"{abs_path}|{st.st_mtime}|{st.st_size}"
    except OSError:
        sig = abs_path
    return hashlib.sha1(sig.encode("utf-8")).hexdigest()


def _instrumental_file(key: str) -> str:
    return os.path.join(STEM_CACHE_DIR, key + ".mp3")


def _stem_dir(key: str) -> str:
    return os.path.join(STEM_CACHE_DIR, key)


def _stems_ready(key: str) -> bool:
    d = _stem_dir(key)
    return all(os.path.isfile(os.path.join(d, s + ".mp3")) for s in STEM_NAMES)


def _set_progress(key: str, pct: int) -> None:
    with _STEM_JOBS_LOCK:
        job = _STEM_JOBS.setdefault(key, {"status": "processing", "out": None, "error": None})
        job["progress"] = max(0, min(100, int(pct)))
        if job.get("status") in (None, "idle"):
            job["status"] = "processing"


def _set_progress4(key: str, pct: int) -> None:
    with _STEM_JOBS_LOCK:
        job = _STEM4_JOBS.setdefault(key, {"status": "processing", "error": None})
        job["progress"] = max(0, min(100, int(pct)))
        if job.get("status") in (None, "idle"):
            job["status"] = "processing"


def _demucs_env() -> dict:
    """Env for a Demucs subprocess that caps its math-thread count to the CPU's
    fair share (total threads / AI_WORKERS). Without this, each job would grab
    every core and parallel workers would just oversubscribe the CPU — this is
    what makes AI_WORKERS>1 genuinely faster on a multi-core CPU."""
    env = os.environ.copy()
    try:
        total = os.cpu_count() or 2
        per = max(1, total // max(1, int(AI_WORKERS)))
    except Exception:
        per = 1
    for k in ("OMP_NUM_THREADS", "MKL_NUM_THREADS",
              "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
        env[k] = str(per)
    return env


def _demucs_stream(cmd, name, progress_cb) -> None:
    """Run Demucs, parsing its tqdm 'NN%' output live via progress_cb."""
    _ailog(f"[ai] separating: {name}")
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1, encoding="utf-8", errors="replace",
        env=_demucs_env(),
    )
    pat = re.compile(r"(\d+)%")
    buf, tail, last = "", "", -1
    while True:
        ch = proc.stdout.read(1)
        if ch == "":
            if proc.poll() is not None:
                break
            continue
        if ch in ("\r", "\n"):
            line = buf.strip()
            buf = ""
            if line:
                tail = line
                m = pat.search(line)
                if m:
                    pct = int(m.group(1))
                    progress_cb(pct)
                    if pct != last and (pct % 5 == 0 or pct == 99):
                        last = pct
                        _ailog(f"[ai] {name} — {pct}%")
        else:
            buf += ch
    rc = proc.wait()
    if rc != 0:
        raise RuntimeError(tail or f"demucs exited {rc}")


def _run_demucs(abs_path: str, key: str) -> str:
    out_final = _instrumental_file(key)
    if os.path.isfile(out_final):
        _set_progress(key, 100)
        return out_final
    os.makedirs(STEM_CACHE_DIR, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix="demucs_", dir=STEM_CACHE_DIR)
    try:
        cmd = [sys.executable, "-m", "demucs", "--two-stems", "vocals",
               "-n", DEMUCS_MODEL, "--mp3", "-o", tmp]
        if AI_DEVICE:
            cmd += ["-d", AI_DEVICE]
        cmd.append(abs_path)
        _set_progress(key, 0)
        _demucs_stream(cmd, os.path.basename(abs_path), lambda p: _set_progress(key, p))
        found = None
        for root, _dirs, files in os.walk(tmp):
            for f in files:
                if f.lower().startswith("no_vocals"):
                    found = os.path.join(root, f)
                    break
            if found:
                break
        if not found:
            raise RuntimeError("demucs produced no instrumental stem")
        shutil.move(found, out_final)
        _set_progress(key, 100)
        _ailog(f"[ai] done -> {os.path.basename(out_final)}")
        return out_final
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _run_demucs_4(abs_path: str, key: str) -> str:
    sdir = _stem_dir(key)
    if _stems_ready(key):
        _set_progress4(key, 100)
        return sdir
    os.makedirs(STEM_CACHE_DIR, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix="demucs4_", dir=STEM_CACHE_DIR)
    try:
        cmd = [sys.executable, "-m", "demucs", "-n", DEMUCS_MODEL, "--mp3", "-o", tmp]
        if AI_DEVICE:
            cmd += ["-d", AI_DEVICE]
        cmd.append(abs_path)
        _set_progress4(key, 0)
        _demucs_stream(cmd, os.path.basename(abs_path) + " [stems]", lambda p: _set_progress4(key, p))
        srcdir = None
        for root, _dirs, files in os.walk(tmp):
            if any(f.lower().startswith("vocals") for f in files):
                srcdir = root
                break
        if not srcdir:
            raise RuntimeError("demucs produced no stems")
        os.makedirs(sdir, exist_ok=True)
        for stem in STEM_NAMES:
            moved = False
            for f in os.listdir(srcdir):
                if f.lower().startswith(stem):
                    shutil.move(os.path.join(srcdir, f), os.path.join(sdir, stem + ".mp3"))
                    moved = True
                    break
            if not moved:
                raise RuntimeError(f"missing '{stem}' stem")
        _set_progress4(key, 100)
        _ailog(f"[stems] done -> {key}")
        return sdir
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def mix_stems(key: str, gains) -> str:
    v, d, b, o = (max(0, min(100, int(g))) for g in gains)
    out = os.path.join(_stem_dir(key), f"mix_{v}_{d}_{b}_{o}.mp3")
    if os.path.isfile(out):
        return out
    ff = _ffmpeg()
    if not ff:
        raise RuntimeError("ffmpeg not found (needed to mix stems)")
    sdir = _stem_dir(key)
    ins = []
    for stem in STEM_NAMES:
        ins += ["-i", os.path.join(sdir, stem + ".mp3")]
    fc = (f"[0:a]volume={v/100:.3f}[a0];[1:a]volume={d/100:.3f}[a1];"
          f"[2:a]volume={b/100:.3f}[a2];[3:a]volume={o/100:.3f}[a3];"
          f"[a0][a1][a2][a3]amix=inputs=4:normalize=0[out]")
    cmd = [ff, "-nostdin", "-y", *ins, "-filter_complex", fc,
           "-map", "[out]", "-ac", "2", "-b:a", "256k", out]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          stdin=subprocess.DEVNULL)
    if proc.returncode != 0:
        # Clean up any partial file so a failed mix isn't served as "ready".
        try:
            if os.path.isfile(out):
                os.remove(out)
        except OSError:
            pass
        raise RuntimeError((proc.stdout or b"").decode("utf-8", "replace")[-400:] or "ffmpeg mix failed")
    return out


def _stem_worker_loop() -> None:
    while True:
        task = _STEM_QUEUE.get()
        try:
            task()
        except Exception as exc:
            _ailog(f"[ai] worker task failed: {exc}")
        finally:
            _STEM_QUEUE.task_done()


def _ensure_worker() -> None:
    global _STEM_QUEUE, _STEM_WORKERS
    if _STEM_QUEUE is None:
        import queue
        _STEM_QUEUE = queue.Queue()
    _STEM_WORKERS = [t for t in _STEM_WORKERS if t.is_alive()]
    while len(_STEM_WORKERS) < max(1, int(AI_WORKERS)):
        t = threading.Thread(target=_stem_worker_loop, daemon=True)
        t.start()
        _STEM_WORKERS.append(t)


def _job_instrumental(key, abs_path):
    try:
        out = _run_demucs(abs_path, key)
        with _STEM_JOBS_LOCK:
            _STEM_JOBS[key] = {"status": "ready", "out": out, "error": None, "progress": 100}
    except Exception as exc:
        with _STEM_JOBS_LOCK:
            _STEM_JOBS[key] = {"status": "error", "out": None, "error": str(exc), "progress": 0}
        _ailog(f"[ai] separation failed: {exc}")


def _job_stems(key, abs_path):
    try:
        _run_demucs_4(abs_path, key)
        with _STEM_JOBS_LOCK:
            _STEM4_JOBS[key] = {"status": "ready", "error": None, "progress": 100}
    except Exception as exc:
        with _STEM_JOBS_LOCK:
            _STEM4_JOBS[key] = {"status": "error", "error": str(exc), "progress": 0}
        _ailog(f"[stems] separation failed: {exc}")


def request_instrumental(abs_path: Optional[str]) -> dict:
    if not demucs_available():
        return {"status": "unsupported", "error": "Demucs is not installed on the server"}
    if not abs_path:
        return {"status": "error", "error": "file not found"}
    key = _stem_key(abs_path)
    if os.path.isfile(_instrumental_file(key)):
        with _STEM_JOBS_LOCK:
            _STEM_JOBS[key] = {"status": "ready", "out": _instrumental_file(key), "error": None, "progress": 100}
        return {"status": "ready", "key": key, "progress": 100}
    with _STEM_JOBS_LOCK:
        job = _STEM_JOBS.get(key)
        if job and job["status"] in ("processing", "ready"):
            return {"status": job["status"], "key": key, "progress": job.get("progress", 0)}
        _STEM_JOBS[key] = {"status": "processing", "out": None, "error": None, "progress": 0}
    _ensure_worker()
    _STEM_QUEUE.put(lambda: _job_instrumental(key, abs_path))
    return {"status": "processing", "key": key, "progress": 0}


def instrumental_status(abs_path: Optional[str]) -> dict:
    if not demucs_available():
        return {"status": "unsupported"}
    if not abs_path:
        return {"status": "error", "error": "file not found"}
    key = _stem_key(abs_path)
    if os.path.isfile(_instrumental_file(key)):
        return {"status": "ready", "key": key, "progress": 100}
    with _STEM_JOBS_LOCK:
        job = _STEM_JOBS.get(key)
    if job:
        return {"status": job["status"], "key": key,
                "error": job.get("error"), "progress": job.get("progress", 0)}
    return {"status": "idle", "key": key, "progress": 0}


def request_stems(abs_path: Optional[str]) -> dict:
    if not demucs_available():
        return {"status": "unsupported", "error": "Demucs is not installed on the server"}
    if not _ffmpeg():
        return {"status": "unsupported", "error": "ffmpeg not found (needed to mix stems)"}
    if not abs_path:
        return {"status": "error", "error": "file not found"}
    key = _stem_key(abs_path)
    if _stems_ready(key):
        with _STEM_JOBS_LOCK:
            _STEM4_JOBS[key] = {"status": "ready", "error": None, "progress": 100}
        return {"status": "ready", "key": key, "progress": 100}
    with _STEM_JOBS_LOCK:
        job = _STEM4_JOBS.get(key)
        if job and job["status"] in ("processing", "ready"):
            return {"status": job["status"], "key": key, "progress": job.get("progress", 0)}
        _STEM4_JOBS[key] = {"status": "processing", "error": None, "progress": 0}
    _ensure_worker()
    _STEM_QUEUE.put(lambda: _job_stems(key, abs_path))
    return {"status": "processing", "key": key, "progress": 0}


def stems_status(abs_path: Optional[str]) -> dict:
    if not demucs_available():
        return {"status": "unsupported"}
    if not _ffmpeg():
        return {"status": "unsupported", "error": "ffmpeg not found"}
    if not abs_path:
        return {"status": "error", "error": "file not found"}
    key = _stem_key(abs_path)
    if _stems_ready(key):
        return {"status": "ready", "key": key, "progress": 100}
    with _STEM_JOBS_LOCK:
        job = _STEM4_JOBS.get(key)
    if job:
        return {"status": job["status"], "key": key,
                "error": job.get("error"), "progress": job.get("progress", 0)}
    return {"status": "idle", "key": key, "progress": 0}


# --- Batch pre-processing: separate the whole library ahead of time ----------

def batch_prepare(state, kind: str = "stems"):
    """Queue AI separation for every song in the catalog so playback never waits.

    `kind` is "stems" (full 4-stem mixer) or "instrumental" (2-stem vocal removal).
    Returns (keys, error): the per-track job keys to poll, or an error string.
    Already-cached tracks come back 'ready' instantly. The shared worker pool
    (AI_WORKERS threads) then separates the rest in parallel.
    """
    if not demucs_available():
        return [], "Demucs not installed"
    if kind == "stems" and not _ffmpeg():
        return [], "ffmpeg not found (needed to mix stems)"
    with state._lock:
        songs = list(state.songs)
    keys = []
    for s in songs:
        abs_path = state.resolve_stream_path(s.rel_path)
        if not abs_path:
            continue
        res = request_stems(abs_path) if kind == "stems" else request_instrumental(abs_path)
        k = res.get("key")
        if k:
            keys.append(k)
    return keys, None


def batch_done_count(keys, kind: str = "stems") -> int:
    """How many of the batch's jobs have finished (cached on disk)."""
    if kind == "stems":
        return sum(1 for k in keys if _stems_ready(k))
    return sum(1 for k in keys if os.path.isfile(_instrumental_file(k)))


# ---------------------------------------------------------------------------
# 2. Flask application (HTTP API + audio streaming)
# ---------------------------------------------------------------------------

def create_app(state: ServerState) -> Flask:
    """Build the Flask app bound to a given ServerState."""
    app = Flask(__name__)

    # Create the scrobble/search SQLite DB lazily (never fatal).
    init_db()

    # Route AI separation progress into the GUI log panel.
    global _AI_LOG
    _AI_LOG = state.add_log

    def client_ip() -> str:
        # Honour a proxy header if present, else the socket address.
        return request.headers.get("X-Forwarded-For", request.remote_addr or "?").split(",")[0].strip()

    # -- CORS + preflight: allow the Android app / browsers to call us -----
    @app.after_request
    def add_cors_headers(resp: Response) -> Response:
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Range, Content-Type"
        # Advertise range support so players know they can seek.
        resp.headers.setdefault("Accept-Ranges", "bytes")
        return resp

    @app.before_request
    def handle_preflight():
        if request.method == "OPTIONS":
            return Response(status=204)
        return None

    # -- JSON catalog -----------------------------------------------------
    # Served at several paths so both the task spec (/api/songs) and the
    # existing Android client (/songs.json, /music.json) are satisfied.
    @app.route("/api/songs")
    @app.route("/songs.json")
    @app.route("/music.json")
    def songs_catalog():
        base_url = request.host_url.rstrip("/")  # e.g. http://192.168.1.15:8080
        payload = state.get_songs_json(base_url)
        state.record_request(client_ip(), f"Fetched catalog ({len(payload)} songs)")
        state.add_log(f"{client_ip()} fetched song list ({len(payload)} songs)")
        return jsonify(payload)

    # -- Audio streaming with byte-range support --------------------------
    @app.route("/stream/<path:rel_path>")
    def stream(rel_path: str):
        # Flask has already URL-decoded rel_path.
        file_path = state.resolve_stream_path(rel_path)
        if not file_path:
            state.add_log(f"{client_ip()} requested missing file: {rel_path}")
            abort(404)

        ext = os.path.splitext(file_path)[1].lower()
        mimetype = MIME_TYPES.get(ext, "application/octet-stream")
        track_name = os.path.basename(file_path)

        state.record_request(client_ip(), "Streaming", track_name)
        state.add_log(f"{client_ip()} streaming: {track_name}")

        # conditional=True makes Flask honour the Range header and reply with
        # HTTP 206 Partial Content + Content-Range, which is what ExoPlayer and
        # browsers use to seek within lossless files.
        return send_file(
            file_path,
            mimetype=mimetype,
            conditional=True,
            as_attachment=False,
            download_name=track_name,
        )

    # -- Album artwork (cached/online cover art by album + artist) --------
    @app.route("/art")
    def art():
        album = request.args.get("album", "", type=str)
        artist = request.args.get("artist", "", type=str)
        try:
            img = get_album_art(artist, album) if album else None
        except Exception:
            img = None
        if not img:
            abort(404)
        resp = Response(img, mimetype="image/jpeg")
        resp.headers["Cache-Control"] = "public, max-age=604800"
        return resp

    # -- Lyrics (local sidecar first, then cached/online via LRCLIB) -------
    @app.route("/lyrics")
    def lyrics():
        rel = request.args.get("path", "", type=str)
        data = None
        if rel:
            abs_path = state.resolve_stream_path(rel)
            data = find_lyrics_sidecar(abs_path) if abs_path else None
        if not data:
            data = get_lyrics(
                request.args.get("artist", "", type=str),
                request.args.get("title", "", type=str),
                request.args.get("album", "", type=str),
                request.args.get("duration", "", type=str),
            )
        return jsonify(data or {"format": None, "text": ""})

    # -- Capabilities: what advanced features this server supports ----------
    @app.route("/capabilities")
    def capabilities():
        return jsonify({
            "canEditTags": mutagen is not None,
            "fts": _HAS_FTS,
            "watch": False,
            "aiInstrumental": demucs_available(),
            "stemMixer": demucs_available() and bool(_ffmpeg()),
        })

    # -- AI vocal removal (2-stem) ----------------------------------------
    @app.route("/instrumental/prepare", methods=["POST"])
    def instrumental_prepare():
        d = request.get_json(silent=True) or {}
        abs_path = state.resolve_stream_path(d.get("path") or "")
        res = request_instrumental(abs_path)
        return jsonify(res), (200 if res.get("status") != "error" else 400)

    @app.route("/instrumental/status")
    def instrumental_status_route():
        abs_path = state.resolve_stream_path(request.args.get("path", "", type=str))
        return jsonify(instrumental_status(abs_path))

    @app.route("/instrumental")
    def instrumental_route():
        abs_path = state.resolve_stream_path(request.args.get("path", "", type=str))
        st = instrumental_status(abs_path)
        if st.get("status") == "idle":
            st = request_instrumental(abs_path)
        if st.get("status") == "ready":
            return send_file(_instrumental_file(st["key"]), mimetype="audio/mpeg", conditional=True)
        return jsonify(st), 202

    # -- AI stem mixer (full 4-stem + on-demand re-mix) -------------------
    @app.route("/stems/prepare", methods=["POST"])
    def stems_prepare():
        d = request.get_json(silent=True) or {}
        abs_path = state.resolve_stream_path(d.get("path") or "")
        res = request_stems(abs_path)
        return jsonify(res), (200 if res.get("status") != "error" else 400)

    @app.route("/stems/status")
    def stems_status_route():
        abs_path = state.resolve_stream_path(request.args.get("path", "", type=str))
        return jsonify(stems_status(abs_path))

    @app.route("/stems/mix")
    def stems_mix_route():
        abs_path = state.resolve_stream_path(request.args.get("path", "", type=str))
        st = stems_status(abs_path)
        if st.get("status") == "idle":
            st = request_stems(abs_path)
        if st.get("status") != "ready":
            return jsonify(st), 202

        def g(k):
            try:
                return int(float(request.args.get(k, 100)))
            except Exception:
                return 100
        gains = (g("v"), g("d"), g("b"), g("o"))
        try:
            out = mix_stems(st["key"], gains)
        except Exception as exc:
            state.add_log(f"[stems] mix failed (v,d,b,o={gains}): {exc}")
            return jsonify({"status": "error", "error": str(exc)}), 500
        return send_file(out, mimetype="audio/mpeg", conditional=True)

    # -- Full-text / substring search over the catalog --------------------
    @app.route("/search")
    def search():
        q = request.args.get("q", "", type=str)
        base_url = request.host_url.rstrip("/")
        # Refresh the index from the current catalog, then search it.
        index_tracks(state.get_songs_json(base_url))
        return jsonify(search_tracks(q))

    # -- Local play-history dashboard -------------------------------------
    @app.route("/stats")
    def stats():
        return jsonify(get_stats())

    # -- Scrobble (record one play) ---------------------------------------
    @app.route("/scrobble", methods=["POST"])
    def scrobble():
        d = request.get_json(silent=True) or {}
        log_scrobble(d.get("path"), d.get("title"), d.get("artist"),
                     d.get("album"), d.get("duration"))
        return jsonify({"ok": True})

    # -- Disk playlists (.m3u/.m3u8/.pls) parsed to track ids -------------
    @app.route("/playlists/disk")
    def playlists_disk():
        with state._lock:
            folder = state.music_folder
        return jsonify(import_disk_playlists(folder))

    # -- Export a playlist to an .m3u in the music folder -----------------
    @app.route("/playlists/export", methods=["POST"])
    def playlists_export():
        d = request.get_json(silent=True) or {}
        with state._lock:
            folder = state.music_folder
        res = export_playlist(folder, d.get("name") or "playlist", d.get("paths") or [])
        return jsonify(res), (200 if res.get("ok") else 400)

    # -- Edit embedded tags (mutagen) -------------------------------------
    @app.route("/edit-tags", methods=["POST"])
    def edit_tags_route():
        if mutagen is None:
            return jsonify({"ok": False, "error": "mutagen not installed"}), 501
        d = request.get_json(silent=True) or {}
        abs_path = state.resolve_stream_path(d.get("path") or "")
        if not abs_path:
            return jsonify({"ok": False, "error": "file not found"}), 400
        res = edit_tags_file(abs_path, d)
        if res.get("ok") and state.music_folder:
            try:
                state.scan_folder(state.music_folder)  # refresh the served catalog
            except Exception:
                pass
        return jsonify(res), (200 if res.get("ok") else 400)

    # -- Edit embedded cover art (raw image bytes in the body) ------------
    @app.route("/edit-art", methods=["POST"])
    def edit_art_route():
        if mutagen is None:
            return jsonify({"ok": False, "error": "mutagen not installed"}), 501
        rel = request.args.get("path", "", type=str)
        abs_path = state.resolve_stream_path(rel)
        if not abs_path:
            return jsonify({"ok": False, "error": "file not found"}), 400
        ctype = request.headers.get("Content-Type", "image/jpeg")
        res = embed_art_file(abs_path, request.get_data(), ctype)
        if res.get("ok") and state.music_folder:
            try:
                state.scan_folder(state.music_folder)
            except Exception:
                pass
        return jsonify(res), (200 if res.get("ok") else 400)

    # -- Browser music player UI (AuraWave Web Player) --------------------
    # Served same-origin from this server so its Web Audio effects graph is not
    # tainted and streaming "just works". "/player" -> "/player/" so the UI's
    # relative asset URLs (styles.css / app.js) resolve under /player/.
    @app.route("/player")
    def player_redirect():
        return redirect("/player/", code=301)

    @app.route("/player/")
    @app.route("/player/<path:asset>")
    def player_asset(asset: str = "index.html"):
        web_dir = find_web_dir()
        if not web_dir:
            abort(404, "Web Player UI not found (expected a 'web' folder next to "
                       "app.py or the sibling 'web-player/web' project).")
        return send_from_directory(web_dir, asset)

    # -- QR page: scan to open the responsive player on a phone -----------
    @app.route("/qr")
    def qr_page():
        url = request.host_url.rstrip("/") + "/player/"
        qr_img = ("https://api.qrserver.com/v1/create-qr-code/?size=320x320&data="
                  + urllib.parse.quote(url, safe=""))
        return Response(
            f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
            <title>Open AuraWave Player</title><style>
            body{{font-family:system-ui,sans-serif;margin:0;padding:6vw 5vw;background:#0E0F11;color:#E6E7E9;text-align:center}}
            h1{{color:#1ED760;font-size:clamp(20px,6vw,28px)}}
            .url{{font-size:clamp(14px,4.5vw,20px);font-weight:bold;color:#17C9C0;word-break:break-all;margin:1rem 0}}
            img{{background:#fff;padding:12px;border-radius:12px;width:min(320px,80vw);height:auto}}
            a.open{{display:inline-block;margin-top:1rem;background:#1ED760;color:#00210D;font-weight:800;text-decoration:none;padding:12px 20px;border-radius:10px}}
            .hint{{color:#888;margin-top:1.5rem;font-size:14px}}</style></head>
            <body><h1>🎵 AuraWave Player</h1>
            <p>Scan this on your phone to open the player, or tap below:</p>
            <img src="{qr_img}" alt="QR">
            <div class="url">{url}</div>
            <a class="open" href="/player/">Open the player ▸</a>
            <p class="hint">Both devices must be on the same Wi-Fi network.</p></body></html>""",
            mimetype="text/html",
        )

    # -- Friendly landing / health page -----------------------------------
    @app.route("/")
    def index():
        with state._lock:  # read-only peek for a status page
            count = len(state.songs)
            folder = state.music_folder or "(no folder selected)"
        return Response(
            f"""<!doctype html><html><head><meta charset="utf-8">
            <title>AuraWave Server</title>
            <style>body{{font-family:system-ui;background:#111;color:#eee;
            margin:0;padding:40px;}}a{{color:#4aa3ff}}code{{background:#222;
            padding:2px 6px;border-radius:4px}}</style></head>
            <body><h1>🎵 AuraWave Music Server</h1>
            <p>Status: <b>running</b></p>
            <p>Folder: <code>{folder}</code></p>
            <p>Indexed songs: <b>{count}</b></p>
            <p>Catalog: <a href="/api/songs">/api/songs</a> ·
               <a href="/songs.json">/songs.json</a></p>
            <p>🎧 Browser player: <a href="/player/">/player</a>
               &mdash; play your library from any browser.</p>
            </body></html>""",
            mimetype="text/html",
        )

    return app


# ---------------------------------------------------------------------------
# 3. CustomTkinter desktop GUI
# ---------------------------------------------------------------------------

ctk.set_appearance_mode("dark")       # "dark", "light" or "system"
ctk.set_default_color_theme("blue")


class ServerGUI(ctk.CTk):
    def __init__(self) -> None:
        super().__init__()

        self.srv_state = ServerState()
        self.app = create_app(self.srv_state)
        self._wsgi_server = None          # waitress server instance when running
        self._server_thread: Optional[threading.Thread] = None
        self.host_ip = get_local_ip()
        self.port = DEFAULT_PORT
        self.threads = DEFAULT_THREADS

        # --- window ------------------------------------------------------
        self.title("AuraWave  —  Local Music Server")
        self.geometry("980x680")
        self.minsize(820, 560)
        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(2, weight=1)

        self._build_header()
        self._build_server_bar()
        self._build_devices_panel()
        self._build_log_panel()

        # The server does NOT auto-start. Pick a music folder, then click
        # "Start Server" — this avoids accidentally serving an empty library.
        self.status_dot.configure(text_color="#e74c3c")
        self.status_label.configure(text="Stopped")
        self.srv_state.add_log("Select a music folder, then click Start Server.")

        # Begin the periodic GUI refresh loop (devices table + log).
        self.after(1000, self._refresh_loop)
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    # ------------------------------------------------------------------ UI
    def _build_header(self) -> None:
        header = ctk.CTkFrame(self, corner_radius=12)
        header.grid(row=0, column=0, padx=16, pady=(16, 8), sticky="ew")
        header.grid_columnconfigure(1, weight=1)

        ctk.CTkLabel(
            header, text="🎵 AuraWave", font=ctk.CTkFont(size=24, weight="bold")
        ).grid(row=0, column=0, padx=16, pady=16, sticky="w")

        self.select_btn = ctk.CTkButton(
            header,
            text="📁  Select Music Folder",
            height=42,
            font=ctk.CTkFont(size=15, weight="bold"),
            command=self.select_folder,
        )
        self.select_btn.grid(row=0, column=1, padx=8, pady=16, sticky="e")

        # Appearance toggle (dark / light / system).
        self.appearance = ctk.CTkOptionMenu(
            header,
            values=["Dark", "Light", "System"],
            width=110,
            command=lambda v: ctk.set_appearance_mode(v.lower()),
        )
        self.appearance.set("Dark")
        self.appearance.grid(row=0, column=2, padx=(8, 16), pady=16, sticky="e")

        # Folder path + song count line.
        self.folder_label = ctk.CTkLabel(
            header,
            text="No folder selected — choose a folder to begin.",
            font=ctk.CTkFont(size=13),
            text_color=("gray40", "gray70"),
            anchor="w",
        )
        self.folder_label.grid(row=1, column=0, columnspan=3, padx=16, pady=(0, 6), sticky="ew")

        # --- AI status + parallel-workers control ------------------------
        ai_row = ctk.CTkFrame(header, fg_color="transparent")
        ai_row.grid(row=2, column=0, columnspan=3, padx=16, pady=(0, 14), sticky="ew")
        self.ai_label = ctk.CTkLabel(
            ai_row, text="AI: …", font=ctk.CTkFont(size=12), anchor="w",
        )
        self.ai_label.grid(row=0, column=0, sticky="w")
        ctk.CTkLabel(ai_row, text="AI workers:", font=ctk.CTkFont(size=12)).grid(
            row=0, column=1, padx=(16, 4)
        )
        self.workers_menu = ctk.CTkOptionMenu(
            ai_row, width=64, values=["1", "2", "3", "4"], command=self._set_ai_workers,
        )
        self.workers_menu.set(str(AI_WORKERS))
        self.workers_menu.grid(row=0, column=2)

        # Button: pre-separate the whole library now (uses the worker pool).
        self.prepare_btn = ctk.CTkButton(
            ai_row, text="⚙ Pre-process library (stems)", width=210,
            font=ctk.CTkFont(size=12, weight="bold"), command=self.start_ai_batch,
        )
        self.prepare_btn.grid(row=0, column=3, padx=(16, 8))
        self.ai_batch_label = ctk.CTkLabel(ai_row, text="", font=ctk.CTkFont(size=12), anchor="w")
        self.ai_batch_label.grid(row=0, column=4, sticky="w")

        self._ai_batch_active = False   # a batch is running
        self._ai_batch_keys = None      # job keys to poll (None = still queuing)
        self._ai_batch_total = 0
        self._ai_batch_err = None
        self._update_ai_label()

    def start_ai_batch(self) -> None:
        """Queue AI stem separation for the whole library (background worker pool)."""
        if not demucs_available():
            self.srv_state.add_log("AI batch: Demucs not installed in this venv")
            return
        if self._ai_batch_active:
            self.srv_state.add_log("AI batch: already running")
            return
        with self.srv_state._lock:
            n = len(self.srv_state.songs)
        if n == 0:
            self.srv_state.add_log("AI batch: no songs loaded — select a music folder first")
            return
        self._ai_batch_active = True
        self._ai_batch_keys = None
        self._ai_batch_err = None
        self.prepare_btn.configure(state="disabled", text="Processing…")
        self.ai_batch_label.configure(text="Queuing…")
        self.srv_state.add_log(
            f"AI batch: starting on {n} track(s) with {AI_WORKERS} worker(s) "
            f"(raise 'AI workers' for more CPU parallelism)"
        )
        # Enqueue off the GUI thread (resolving paths for a big library can take a moment).
        threading.Thread(target=self._do_ai_batch, daemon=True).start()

    def _do_ai_batch(self) -> None:
        keys, err = batch_prepare(self.srv_state, "stems")
        # Only hand results back to the GUI thread (via flags); it manages widgets.
        if err:
            self._ai_batch_err = err
            return
        self._ai_batch_total = len(keys)
        self._ai_batch_keys = keys
        self.srv_state.add_log(f"AI batch: queued {len(keys)} track(s) for stem separation")

    def _refresh_ai_batch(self) -> None:
        """GUI-thread poll of batch progress; updates the label + re-enables the button."""
        if not self._ai_batch_active:
            return
        if self._ai_batch_err:
            self.srv_state.add_log(f"AI batch: {self._ai_batch_err}")
            self._finish_ai_batch()
            return
        if self._ai_batch_keys is None:
            self.ai_batch_label.configure(text="Queuing…")
            return
        total = self._ai_batch_total
        if total == 0:
            self.srv_state.add_log("AI batch: nothing to process")
            self._finish_ai_batch()
            return
        done = batch_done_count(self._ai_batch_keys, "stems")
        self.ai_batch_label.configure(text=f"AI batch: {done}/{total}")
        if done >= total:
            self.srv_state.add_log(f"AI batch complete: {total} track(s) ready")
            self.ai_batch_label.configure(text=f"AI batch: {total}/{total} ✓")
            self._finish_ai_batch(keep_label=True)

    def _finish_ai_batch(self, keep_label: bool = False) -> None:
        self._ai_batch_active = False
        self._ai_batch_keys = None
        self._ai_batch_err = None
        self.prepare_btn.configure(state="normal", text="⚙ Pre-process library (stems)")
        if not keep_label:
            self.ai_batch_label.configure(text="")

    def _set_ai_workers(self, value: str) -> None:
        """Set how many AI separations run in parallel. Increasing is live;
        decreasing only takes effect after a restart (threads can't be killed)."""
        global AI_WORKERS
        try:
            AI_WORKERS = max(1, int(value))
        except Exception:
            AI_WORKERS = 1
        try:
            _ensure_worker()   # spawn extra workers immediately when increasing
        except Exception:
            pass
        self.srv_state.add_log(
            f"AI workers set to {AI_WORKERS} "
            f"(increase is live; decrease needs a restart)"
        )
        self._update_ai_label()

    def _update_ai_label(self) -> None:
        if not demucs_available():
            txt = "AI: OFF  —  install 'demucs' in this venv to enable vocal removal / stem mixer"
            color = "#e67e22"
        else:
            dev = AI_DEVICE or "auto device"
            ff = "ffmpeg ✓" if _ffmpeg() else "ffmpeg ✗ (stem mixer off — add ffmpeg to PATH)"
            txt = f"AI: ON  —  Demucs ({dev}) · {ff} · {AI_WORKERS} worker(s)"
            color = "#2ecc71"
        try:
            self.ai_label.configure(text=txt, text_color=color)
        except Exception:
            pass

    def _build_server_bar(self) -> None:
        bar = ctk.CTkFrame(self, corner_radius=12)
        bar.grid(row=1, column=0, padx=16, pady=8, sticky="ew")
        bar.grid_columnconfigure(6, weight=1)   # the URL label absorbs slack

        self.status_dot = ctk.CTkLabel(bar, text="●", font=ctk.CTkFont(size=18), text_color="#e74c3c")
        self.status_dot.grid(row=0, column=0, padx=(16, 4), pady=12)

        self.status_label = ctk.CTkLabel(bar, text="Stopped", font=ctk.CTkFont(size=14, weight="bold"))
        self.status_label.grid(row=0, column=1, padx=(0, 16), pady=12)

        # Port chooser (8080 matches the Android app's default; change it if busy).
        ctk.CTkLabel(bar, text="Port:", font=ctk.CTkFont(size=13)).grid(row=0, column=2, padx=(0, 4), pady=12)
        self.port_var = tk.StringVar(value=str(self.port))
        self.port_entry = ctk.CTkEntry(bar, width=72, textvariable=self.port_var)
        self.port_entry.grid(row=0, column=3, padx=(0, 12), pady=12)

        # Max simultaneous streams = waitress worker threads. Each active audio
        # stream holds one thread, so this is roughly "phones playing at once".
        ctk.CTkLabel(bar, text="Max streams:", font=ctk.CTkFont(size=13)).grid(
            row=0, column=4, padx=(0, 4), pady=12
        )
        self.threads_var = tk.StringVar(value=str(self.threads))
        self.threads_entry = ctk.CTkEntry(bar, width=56, textvariable=self.threads_var)
        self.threads_entry.grid(row=0, column=5, padx=(0, 12), pady=12)

        self.url_label = ctk.CTkLabel(bar, text="Server URL: —", font=ctk.CTkFont(size=14), anchor="w")
        self.url_label.grid(row=0, column=6, padx=8, pady=12, sticky="w")

        self.toggle_btn = ctk.CTkButton(bar, text="Start Server", width=120, command=self.toggle_server)
        self.toggle_btn.grid(row=0, column=7, padx=8, pady=12)

        self.qr_btn = ctk.CTkButton(
            bar, text="📱 QR Code", width=110, fg_color="#1f8a4c", hover_color="#176b3b",
            command=self.show_qr,
        )
        self.qr_btn.grid(row=0, column=8, padx=8, pady=12)

        self.rescan_btn = ctk.CTkButton(
            bar, text="Rescan", width=90, fg_color="gray30", hover_color="gray25",
            command=self.rescan,
        )
        self.rescan_btn.grid(row=0, column=9, padx=8, pady=12)

        self.dupes_btn = ctk.CTkButton(
            bar, text="🔁 Duplicates", width=120, fg_color="#8a5a1f", hover_color="#6b451b",
            command=self.show_duplicates,
        )
        self.dupes_btn.grid(row=0, column=10, padx=(8, 16), pady=12)

    def _build_devices_panel(self) -> None:
        panel = ctk.CTkFrame(self, corner_radius=12)
        panel.grid(row=2, column=0, padx=16, pady=8, sticky="nsew")
        panel.grid_columnconfigure(0, weight=1)
        panel.grid_rowconfigure(1, weight=1)

        head = ctk.CTkFrame(panel, fg_color="transparent")
        head.grid(row=0, column=0, padx=12, pady=(12, 4), sticky="ew")
        head.grid_columnconfigure(0, weight=1)

        ctk.CTkLabel(
            head, text="Connected Devices", font=ctk.CTkFont(size=18, weight="bold")
        ).grid(row=0, column=0, sticky="w")

        self.active_label = ctk.CTkLabel(
            head, text="Active: 0   |   Total seen: 0",
            font=ctk.CTkFont(size=13, weight="bold"),
            text_color=("#1f6aa5", "#4aa3ff"),
        )
        self.active_label.grid(row=0, column=1, sticky="e")

        # ttk.Treeview is the most practical cross-platform table widget. We
        # theme it to blend with the CustomTkinter dark surface.
        columns = ("ip", "status", "action", "track", "connected", "requests")
        headings = {
            "ip": "IP Address",
            "status": "Status",
            "action": "Last Action",
            "track": "Current / Last Track",
            "connected": "Connected At",
            "requests": "Requests",
        }
        widths = {"ip": 140, "status": 90, "action": 170, "track": 240, "connected": 110, "requests": 90}

        style = ttk.Style()
        style.theme_use("default")
        style.configure(
            "Devices.Treeview",
            background="#242424", fieldbackground="#242424", foreground="#e5e5e5",
            rowheight=30, borderwidth=0, font=("Segoe UI", 10),
        )
        style.configure(
            "Devices.Treeview.Heading",
            background="#1f6aa5", foreground="white",
            font=("Segoe UI", 10, "bold"), relief="flat",
        )
        style.map("Devices.Treeview", background=[("selected", "#2d5f8a")])

        table_frame = tk.Frame(panel, bg="#242424")
        table_frame.grid(row=1, column=0, padx=12, pady=(4, 12), sticky="nsew")
        table_frame.grid_columnconfigure(0, weight=1)
        table_frame.grid_rowconfigure(0, weight=1)

        self.tree = ttk.Treeview(
            table_frame, columns=columns, show="headings", style="Devices.Treeview",
        )
        for col in columns:
            self.tree.heading(col, text=headings[col])
            self.tree.column(col, width=widths[col], anchor="w")
        self.tree.grid(row=0, column=0, sticky="nsew")

        scrollbar = ttk.Scrollbar(table_frame, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=scrollbar.set)
        scrollbar.grid(row=0, column=1, sticky="ns")

        # Colour tags for online vs idle rows.
        self.tree.tag_configure("online", foreground="#2ecc71")
        self.tree.tag_configure("idle", foreground="#999999")

    def _build_log_panel(self) -> None:
        frame = ctk.CTkFrame(self, corner_radius=12)
        frame.grid(row=3, column=0, padx=16, pady=(8, 16), sticky="ew")
        frame.grid_columnconfigure(0, weight=1)

        header = ctk.CTkFrame(frame, fg_color="transparent")
        header.grid(row=0, column=0, padx=12, pady=(10, 0), sticky="ew")
        header.grid_columnconfigure(0, weight=1)
        ctk.CTkLabel(
            header, text="Activity Log", font=ctk.CTkFont(size=14, weight="bold")
        ).grid(row=0, column=0, sticky="w")
        ctk.CTkButton(
            header, text="Clear devices", width=110, fg_color="gray30",
            hover_color="gray25", command=self.clear_devices,
        ).grid(row=0, column=1, sticky="e")

        self.log_box = ctk.CTkTextbox(frame, height=120, font=ctk.CTkFont(family="Consolas", size=12))
        self.log_box.grid(row=1, column=0, padx=12, pady=12, sticky="ew")
        self.log_box.configure(state="disabled")

    # -------------------------------------------------------------- actions
    def select_folder(self) -> None:
        folder = filedialog.askdirectory(title="Select your music folder")
        if not folder:
            return
        count = self.srv_state.scan_folder(folder)
        self.folder_label.configure(
            text=f"📂  {folder}      ·      {count} track(s) indexed"
        )
        self.srv_state.add_log(f"Indexed {count} track(s) from {folder}")
        if self._wsgi_server is None:
            self.srv_state.add_log("Folder ready — click Start Server to go live.")

    def rescan(self) -> None:
        if not self.srv_state.music_folder:
            self.srv_state.add_log("Rescan requested but no folder is selected.")
            return
        count = self.srv_state.scan_folder(self.srv_state.music_folder)
        self.folder_label.configure(
            text=f"📂  {self.srv_state.music_folder}      ·      {count} track(s) indexed"
        )
        self.srv_state.add_log(f"Rescanned: {count} track(s)")

    def clear_devices(self) -> None:
        self.srv_state.clear_devices()
        for item in self.tree.get_children():
            self.tree.delete(item)
        self.srv_state.add_log("Cleared device list.")

    # --------------------------------------------------------- duplicate finder
    def show_duplicates(self) -> None:
        """Open a window to scan for duplicate songs and move them to /Duplicates."""
        folder = self.srv_state.music_folder
        if not folder:
            self.folder_label.configure(text="Select a music folder first, then find duplicates.")
            return

        win = ctk.CTkToplevel(self)
        win.title("Find Duplicate Songs")
        win.geometry("760x560")
        win.transient(self)
        win.grid_columnconfigure(0, weight=1)
        win.grid_rowconfigure(2, weight=1)
        win._groups = []  # type: ignore[attr-defined]

        # --- controls ---
        top = ctk.CTkFrame(win, corner_radius=12)
        top.grid(row=0, column=0, sticky="ew", padx=14, pady=(14, 8))
        top.grid_columnconfigure(3, weight=1)
        ctk.CTkLabel(top, text="Detect by:", font=ctk.CTkFont(size=13, weight="bold")).grid(
            row=0, column=0, padx=(14, 8), pady=12)
        mode_var = tk.StringVar(value="content")
        ctk.CTkRadioButton(top, text="Exact file (byte-identical)", variable=mode_var,
                           value="content").grid(row=0, column=1, padx=8, pady=12)
        ctk.CTkRadioButton(top, text="Same Title + Artist", variable=mode_var,
                           value="metadata").grid(row=0, column=2, padx=8, pady=12)
        scan_btn = ctk.CTkButton(top, text="🔍 Scan", width=100)
        scan_btn.grid(row=0, column=4, padx=8, pady=12)
        move_btn = ctk.CTkButton(top, text="📦 Move duplicates → /Duplicates", width=230,
                                 state="disabled", fg_color="#8a5a1f", hover_color="#6b451b")
        move_btn.grid(row=0, column=5, padx=(8, 14), pady=12)

        status = ctk.CTkLabel(win, text="Choose a mode and press Scan.",
                              font=ctk.CTkFont(size=13), text_color=("gray40", "gray70"), anchor="w")
        status.grid(row=1, column=0, sticky="ew", padx=20, pady=(0, 4))

        results = ctk.CTkScrollableFrame(win, label_text="Duplicate groups")
        results.grid(row=2, column=0, sticky="nsew", padx=14, pady=(4, 14))
        results.grid_columnconfigure(0, weight=1)

        def render_results(groups):
            for c in results.winfo_children():
                c.destroy()
            if not groups:
                ctk.CTkLabel(results, text="No duplicates found. 🎉",
                             text_color=("gray40", "gray70")).grid(row=0, column=0, pady=30)
                return
            for gi, group in enumerate(groups):
                box = ctk.CTkFrame(results, fg_color=("gray92", "gray17"), corner_radius=8)
                box.grid(row=gi, column=0, sticky="ew", pady=5, padx=2)
                box.grid_columnconfigure(0, weight=1)
                ctk.CTkLabel(box, text=f"Group {gi + 1}  ·  {len(group)} files",
                             font=ctk.CTkFont(size=12, weight="bold"),
                             text_color=("#1f6aa5", "#4aa3ff"), anchor="w").grid(
                    row=0, column=0, sticky="ew", padx=12, pady=(8, 2))
                for fi, p in enumerate(group):
                    rel = os.path.relpath(p, folder)
                    keep = fi == 0
                    tag = "✓ keep" if keep else "→ move"
                    color = ("#15A049", "#1ED760") if keep else ("#b58900", "#e0b030")
                    ctk.CTkLabel(box, text=f"{tag}   {rel}    ({_safe_size(p) // 1024} KB)",
                                 font=ctk.CTkFont(size=12), text_color=color, anchor="w").grid(
                        row=fi + 1, column=0, sticky="ew", padx=20, pady=1)
                ctk.CTkLabel(box, text="", height=4).grid(row=len(group) + 1, column=0)

        def on_scan():
            scan_btn.configure(state="disabled", text="Scanning…")
            move_btn.configure(state="disabled")
            status.configure(text="Scanning… this can take a while for large libraries.")
            mode = mode_var.get()

            def worker():
                def progress(done, total):
                    win.after(0, lambda: status.configure(text=f"Hashing files… {done}/{total}"))
                try:
                    groups = find_duplicate_groups(folder, mode, progress if mode == "content" else None)
                except Exception as exc:
                    win.after(0, lambda: status.configure(text=f"Scan failed: {exc}"))
                    win.after(0, lambda: scan_btn.configure(state="normal", text="🔍 Scan"))
                    return

                def done_ui():
                    win._groups = groups
                    dup_count = sum(len(g) - 1 for g in groups)
                    render_results(groups)
                    status.configure(
                        text=f"Found {len(groups)} duplicate group(s) — {dup_count} file(s) can be moved.")
                    scan_btn.configure(state="normal", text="🔍 Scan")
                    move_btn.configure(state="normal" if groups else "disabled")
                win.after(0, done_ui)

            threading.Thread(target=worker, daemon=True).start()

        def on_move():
            groups = getattr(win, "_groups", [])
            if not groups:
                return
            move_btn.configure(state="disabled")
            status.configure(text="Moving duplicates…")

            def worker():
                moved, errors = move_duplicates(folder, groups)
                def done_ui():
                    msg = f"Moved {moved} duplicate(s) to the 'Duplicates' subfolder."
                    if errors:
                        msg += f"  ({len(errors)} error(s))"
                    status.configure(text=msg)
                    self.srv_state.add_log(msg)
                    win._groups = []
                    render_results([])
                    self.rescan()  # refresh the served catalog (duplicates now moved out)
                win.after(0, done_ui)

            threading.Thread(target=worker, daemon=True).start()

        scan_btn.configure(command=on_scan)
        move_btn.configure(command=on_move)
        win.after(120, win.lift)

    # --------------------------------------------------------------- QR code
    def show_qr(self) -> None:
        """Open a window with a scannable QR code of the server URL.

        The phone's camera (or the AuraWave app) scans it to get
        ``http://<ip>:<port>/`` and connect without typing anything.
        """
        if self._wsgi_server is None:
            self.srv_state.add_log("Start the server before showing the QR code.")
            self.url_label.configure(text="Start the server first, then show the QR code.")
            return
        if not self.srv_state.music_folder:
            self.srv_state.add_log("Select a music folder before showing the QR code.")
            self.folder_label.configure(
                text="Select a music folder first, then show the QR code."
            )
            return

        url = f"http://{self.host_ip}:{self.port}/"

        # Build the QR matrix (list of rows of booleans). No Pillow required —
        # we paint each module as a small rectangle on a Tk canvas.
        qr = qrcode.QRCode(
            version=None,
            error_correction=qrcode.constants.ERROR_CORRECT_M,
            box_size=1,
            border=2,
        )
        qr.add_data(url)
        qr.make(fit=True)
        matrix = qr.get_matrix()

        modules = len(matrix)
        scale = max(4, 320 // modules)        # target ~320px, snapped to whole pixels
        canvas_px = modules * scale

        win = ctk.CTkToplevel(self)
        win.title("Connect — Scan QR Code")
        win.resizable(False, False)
        win.transient(self)
        win.grab_set()                        # keep it on top of the main window

        ctk.CTkLabel(
            win, text="Scan to connect", font=ctk.CTkFont(size=18, weight="bold")
        ).grid(row=0, column=0, padx=24, pady=(20, 4))
        ctk.CTkLabel(
            win,
            text="Point your phone's camera at this code.",
            font=ctk.CTkFont(size=12),
            text_color=("gray40", "gray70"),
        ).grid(row=1, column=0, padx=24, pady=(0, 12))

        # White border frame so the QR has a quiet zone against dark UI.
        holder = tk.Frame(win, bg="white", bd=0, highlightthickness=0)
        holder.grid(row=2, column=0, padx=24, pady=4)
        canvas = tk.Canvas(
            holder, width=canvas_px, height=canvas_px,
            bg="white", bd=0, highlightthickness=0,
        )
        canvas.pack(padx=16, pady=16)
        for r, row in enumerate(matrix):
            for c, cell in enumerate(row):
                if cell:
                    x0, y0 = c * scale, r * scale
                    canvas.create_rectangle(
                        x0, y0, x0 + scale, y0 + scale, fill="black", width=0,
                    )

        ctk.CTkLabel(
            win, text=url, font=ctk.CTkFont(family="Consolas", size=14, weight="bold")
        ).grid(row=3, column=0, padx=24, pady=(12, 4))

        def copy_url() -> None:
            self.clipboard_clear()
            self.clipboard_append(url)
            copy_btn.configure(text="Copied!")
            win.after(1200, lambda: copy_btn.configure(text="Copy URL"))

        copy_btn = ctk.CTkButton(win, text="Copy URL", width=120, command=copy_url)
        copy_btn.grid(row=4, column=0, padx=24, pady=(4, 20))

        self.srv_state.add_log(f"Displayed connection QR code for {url}")

    # -------------------------------------------------------- server control
    def start_server(self) -> None:
        if self._wsgi_server is not None:
            return

        # Require a music folder first (the whole point is to serve songs).
        if not self.srv_state.music_folder:
            self.status_dot.configure(text_color="#e67e22")
            self.status_label.configure(text="No folder")
            self.url_label.configure(text="Select a music folder first, then click Start Server.")
            self.srv_state.add_log("Cannot start — select a music folder first.")
            return

        # Read (and validate) the port from the entry field.
        try:
            self.port = int(self.port_var.get().strip())
            if not (1 <= self.port <= 65535):
                raise ValueError
        except ValueError:
            self.status_dot.configure(text_color="#e74c3c")
            self.status_label.configure(text="Bad port")
            self.srv_state.add_log("Invalid port number — enter a value between 1 and 65535.")
            return

        # Read (and validate) the max-streams / worker-thread count.
        try:
            self.threads = int(self.threads_var.get().strip())
            if not (1 <= self.threads <= 256):
                raise ValueError
        except ValueError:
            self.status_dot.configure(text_color="#e74c3c")
            self.status_label.configure(text="Bad streams")
            self.srv_state.add_log("Invalid 'Max streams' — enter a value between 1 and 256.")
            return

        try:
            # create_server binds immediately (so port errors surface now),
            # then we run its loop on a daemon thread.
            self._wsgi_server = create_server(
                self.app,
                host="0.0.0.0",
                port=self.port,
                threads=self.threads,
                connection_limit=max(CONNECTION_LIMIT, self.threads * 4),
            )
        except Exception as exc:  # e.g. port already in use / permission denied
            self.status_dot.configure(text_color="#e74c3c")
            self.status_label.configure(text="Start failed")
            self.url_label.configure(
                text=f"Could not bind port {self.port}: {exc}. Try another port, then Start Server."
            )
            self.srv_state.add_log(f"Failed to start server on port {self.port}: {exc}")
            self._wsgi_server = None
            return

        self._server_thread = threading.Thread(
            target=self._wsgi_server.run, daemon=True, name="waitress"
        )
        self._server_thread.start()

        url = f"http://{self.host_ip}:{self.port}"
        self.status_dot.configure(text_color="#2ecc71")
        self.status_label.configure(text="Running")
        self.url_label.configure(text=f"Server URL:  {url}   (enter this in the Android app)")
        self.toggle_btn.configure(text="Stop Server")
        self.srv_state.add_log(
            f"Server started at {url} (up to {self.threads} simultaneous streams)"
        )

    def stop_server(self) -> None:
        if self._wsgi_server is None:
            return
        try:
            self._wsgi_server.close()
        except Exception:
            pass
        self._wsgi_server = None
        self._server_thread = None
        self.status_dot.configure(text_color="#e74c3c")
        self.status_label.configure(text="Stopped")
        self.url_label.configure(text="Server URL: —")
        self.toggle_btn.configure(text="Start Server")
        self.srv_state.add_log("Server stopped.")

    def toggle_server(self) -> None:
        if self._wsgi_server is None:
            self.start_server()
        else:
            self.stop_server()

    # --------------------------------------------------------- refresh loop
    def _refresh_loop(self) -> None:
        """Runs on the GUI thread every second to reflect live server state."""
        self._refresh_devices()
        self._refresh_log()
        self._refresh_ai_batch()
        self.after(1000, self._refresh_loop)

    def _refresh_devices(self) -> None:
        devices = self.srv_state.devices_snapshot()
        now = time.time()

        # Rebuild table rows (small N, so a full refresh is simplest & flicker-free).
        existing = set(self.tree.get_children())
        seen_ids = set()
        for dev in devices:
            online = (now - dev.last_seen) <= ACTIVE_WINDOW_SECONDS
            status = "🟢 Online" if online else "⚪ Idle"
            connected_at = datetime.fromtimestamp(dev.first_seen).strftime("%H:%M:%S")
            values = (
                dev.ip, status, dev.last_action, dev.last_track, connected_at, dev.request_count,
            )
            tag = "online" if online else "idle"
            iid = dev.ip  # use IP as a stable row id
            seen_ids.add(iid)
            if iid in existing:
                self.tree.item(iid, values=values, tags=(tag,))
            else:
                self.tree.insert("", "end", iid=iid, values=values, tags=(tag,))

        # Remove rows for devices that were cleared.
        for iid in existing - seen_ids:
            self.tree.delete(iid)

        self.active_label.configure(
            text=f"Active: {self.srv_state.active_count()}   |   Total seen: {len(devices)}"
        )

    def _refresh_log(self) -> None:
        lines = self.srv_state.drain_log()
        if not lines:
            return
        self.log_box.configure(state="normal")
        for line in lines:
            self.log_box.insert("end", line + "\n")
        self.log_box.see("end")
        self.log_box.configure(state="disabled")

    # -------------------------------------------------------------- closing
    def _on_close(self) -> None:
        self.stop_server()
        self.destroy()


def main() -> None:
    app = ServerGUI()
    app.mainloop()


if __name__ == "__main__":
    main()
