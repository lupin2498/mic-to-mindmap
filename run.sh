#!/usr/bin/env bash
# Khởi chạy Mic to Mindmap. Dùng: ./run.sh [--port 8000]
set -euo pipefail
cd "$(dirname "$0")"
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi
HOST="${M2M_HOST:-127.0.0.1}"
PORT="${M2M_PORT:-8000}"
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    *) shift ;;
  esac
done
echo "Mic to Mindmap chạy tại http://${HOST}:${PORT}"
exec python3 -m uvicorn app.main:app --host "$HOST" --port "$PORT"
