#!/bin/sh
# Serve the repo root (so the app can import ../skills/...) and print the app URL.
#   app/serve.sh [port]        (or PORT=9000 app/serve.sh; default 8000)
set -eu
PORT="${1:-${PORT:-8000}}"
cd "$(dirname "$0")/.."
echo "Blob Tracker: http://localhost:$PORT/app/"
exec python3 -m http.server "$PORT" --bind 127.0.0.1
