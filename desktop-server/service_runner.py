#!/usr/bin/env python3
"""
AuraWave Headless Service Runner
================================

Runs the AuraWave Music Server in background / headless mode (no GUI).
Used by the Windows Service wrapper, scheduled tasks, and command-line
service invocations.

Defaults:
- Music Folder: D:\\songs
- Port: 8080
- Threads: 16
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import sys
import time
import warnings
warnings.filterwarnings("ignore")
from datetime import datetime
from typing import Optional

# Ensure the current directory is on sys.path
HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from app import (
    CONNECTION_LIMIT,
    DEFAULT_PORT,
    DEFAULT_THREADS,
    ServerState,
    create_app,
    get_local_ip,
)
from waitress.server import create_server

DEFAULT_MUSIC_FOLDER = r"D:\songs"
CONFIG_FILE = os.path.join(HERE, "config.json")
LOG_FILE = os.path.join(HERE, "service.log")
STATE_FILE = os.path.join(HERE, "service_state.json")

# Setup logging: stdout/stderr and service.log (best-effort)
logger = logging.getLogger("aurawave_service")
logger.setLevel(logging.INFO)

stream_handler = logging.StreamHandler(sys.stdout)
stream_handler.setFormatter(
    logging.Formatter("[%(asctime)s] [%(levelname)s] %(message)s", datefmt="%H:%M:%S")
)
logger.addHandler(stream_handler)

try:
    file_handler = logging.FileHandler(LOG_FILE, encoding="utf-8")
    file_handler.setFormatter(
        logging.Formatter("[%(asctime)s] [%(levelname)s] %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
    )
    logger.addHandler(file_handler)
except Exception:
    pass


def load_config() -> dict:
    """Load config.json if present, falling back to defaults."""
    cfg = {
        "music_folder": DEFAULT_MUSIC_FOLDER,
        "port": DEFAULT_PORT,
        "threads": DEFAULT_THREADS,
        "auto_start": True,
    }
    if os.path.isfile(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    cfg.update(data)
        except Exception as exc:
            logger.warning(f"Could not read config.json: {exc}")
    return cfg


def save_state(port: int, folder: str, song_count: int) -> None:
    """Record service process state for GUI / status scripts."""
    try:
        state = {
            "pid": os.getpid(),
            "port": port,
            "folder": folder,
            "song_count": song_count,
            "started_at": datetime.now().isoformat(),
            "ip": get_local_ip(),
        }
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)
    except Exception as exc:
        logger.warning(f"Could not write service_state.json: {exc}")


def clear_state() -> None:
    """Remove service state file upon shutdown."""
    try:
        if os.path.isfile(STATE_FILE):
            os.remove(STATE_FILE)
    except Exception:
        pass


def run_service(folder: Optional[str] = None, port: Optional[int] = None, threads: Optional[int] = None) -> None:
    cfg = load_config()
    music_folder = folder or cfg.get("music_folder") or DEFAULT_MUSIC_FOLDER
    srv_port = int(port or cfg.get("port") or DEFAULT_PORT)
    srv_threads = int(threads or cfg.get("threads") or DEFAULT_THREADS)

    logger.info("=" * 60)
    logger.info("AuraWave Music Server (Headless Service)")
    logger.info(f"Target folder:  {music_folder}")
    logger.info(f"Server Port:    {srv_port}")
    logger.info(f"Max Streams:    {srv_threads}")
    logger.info(f"Host LAN IP:    {get_local_ip()}")
    logger.info("=" * 60)

    srv_state = ServerState()

    if os.path.isdir(music_folder):
        logger.info(f"Scanning music folder '{music_folder}'...")
        count = srv_state.scan_folder(music_folder)
        logger.info(f"Scan complete: {count} track(s) indexed.")
    else:
        logger.warning(f"Music folder '{music_folder}' does not exist! Starting with empty library.")
        count = 0

    flask_app = create_app(srv_state)

    try:
        server = create_server(
            flask_app,
            host="0.0.0.0",
            port=srv_port,
            threads=srv_threads,
            connection_limit=max(CONNECTION_LIMIT, srv_threads * 4),
        )
    except Exception as exc:
        logger.error(f"FATAL: Failed to bind server to port {srv_port}: {exc}")
        sys.exit(1)

    save_state(srv_port, music_folder, count)

    def shutdown_signal(signum, _frame):
        logger.info(f"Shutdown signal received ({signum}). Stopping server...")
        try:
            server.close()
        except Exception:
            pass
        clear_state()
        logger.info("Server stopped cleanly.")
        sys.exit(0)

    # Register signals for clean shutdown
    signal.signal(signal.SIGINT, shutdown_signal)
    signal.signal(signal.SIGTERM, shutdown_signal)
    if hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, shutdown_signal)

    url = f"http://{get_local_ip()}:{srv_port}"
    logger.info(f"AuraWave Music Server is LIVE at {url}")
    logger.info(f"Ready for incoming connections. Press Ctrl+C to stop.")

    try:
        server.run()
    except Exception as exc:
        logger.error(f"Server error: {exc}")
    finally:
        clear_state()
        logger.info("AuraWave Service runner exited.")


def main():
    parser = argparse.ArgumentParser(description="AuraWave Headless Music Server")
    parser.add_argument("--folder", type=str, default=None, help=f"Music folder (default: {DEFAULT_MUSIC_FOLDER})")
    parser.add_argument("--port", type=int, default=None, help=f"Server port (default: {DEFAULT_PORT})")
    parser.add_argument("--threads", type=int, default=None, help=f"Max streams / worker threads (default: {DEFAULT_THREADS})")
    args = parser.parse_args()

    run_service(folder=args.folder, port=args.port, threads=args.threads)


if __name__ == "__main__":
    main()
