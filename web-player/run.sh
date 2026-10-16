#!/usr/bin/env bash
# ===========================================================================
#  AuraWave Web Player launcher (macOS / Linux)
#  Usage:
#    ./run.sh                    prompts for the port (default 8000)
#    ./run.sh ~/Music            serves that folder, prompts for the port
#    ./run.sh ~/Music 8010       serves that folder on port 8010 (no prompt)
# ===========================================================================
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

MUSIC_DIR="${1:-$HOME/Music}"

PORT="${2:-}"
if [ -z "$PORT" ]; then
  read -r -p "Enter port to run on [default 8000]: " PORT
  PORT="${PORT:-8000}"
fi
if ! echo "$PORT" | grep -qE '^[1-9][0-9]*$' || [ "$PORT" -gt 65535 ]; then
  echo "  '$PORT' is not a valid port (1-65535)."
  exit 1
fi

PY="$(command -v python3 || command -v python)"
if [ -z "$PY" ]; then
  echo "Python 3 is required but was not found on PATH."
  exit 1
fi

echo
echo "Starting AuraWave Web Player"
echo "  Folder : $MUSIC_DIR"
echo "  Port   : $PORT"
echo
exec "$PY" "$DIR/web_player.py" --dir "$MUSIC_DIR" --port "$PORT"
