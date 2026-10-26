#!/usr/bin/env bash
# Tải các model AI local: LLM + model nhúng cho Ollama, và model Whisper (faster-whisper).
# Dùng: ./scripts/setup_models.sh
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi
LLM="${OLLAMA_MODEL:-qwen2.5:7b}"
EMBED="${OLLAMA_EMBED_MODEL:-nomic-embed-text}"
WHISPER="${WHISPER_MODEL:-small}"

if command -v ollama >/dev/null 2>&1; then
  echo "==> Tải model Ollama: $LLM và $EMBED"
  ollama pull "$LLM"
  ollama pull "$EMBED"
else
  echo "!! Chưa cài Ollama. Cài tại https://ollama.com rồi chạy lại script này."
fi

echo "==> Cài faster-whisper và tải trước model Whisper '$WHISPER'"
python3 -m pip install -q faster-whisper
python3 - <<PY
from faster_whisper import WhisperModel
WhisperModel("$WHISPER", device="${WHISPER_DEVICE:-cpu}", compute_type="${WHISPER_COMPUTE_TYPE:-int8}")
print("Whisper '$WHISPER' sẵn sàng.")
PY
echo "==> Xong. Chạy ./run.sh để khởi động ứng dụng."
