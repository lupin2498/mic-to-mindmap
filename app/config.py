"""Cấu hình ứng dụng, đọc từ biến môi trường."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(os.environ.get("M2M_DATA_DIR", "data")).resolve())
    language: str = field(default_factory=lambda: os.environ.get("M2M_LANGUAGE", "vi"))
    host: str = field(default_factory=lambda: os.environ.get("M2M_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: int(os.environ.get("M2M_PORT", "8000")))

    ollama_url: str = field(default_factory=lambda: os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434"))
    ollama_model: str = field(default_factory=lambda: os.environ.get("OLLAMA_MODEL", "qwen2.5:7b"))
    ollama_embed_model: str = field(default_factory=lambda: os.environ.get("OLLAMA_EMBED_MODEL", "nomic-embed-text"))
    ollama_timeout: float = field(default_factory=lambda: float(os.environ.get("OLLAMA_TIMEOUT", "600")))

    whisper_model: str = field(default_factory=lambda: os.environ.get("WHISPER_MODEL", "small"))
    whisper_device: str = field(default_factory=lambda: os.environ.get("WHISPER_DEVICE", "cpu"))
    whisper_compute_type: str = field(default_factory=lambda: os.environ.get("WHISPER_COMPUTE_TYPE", "int8"))

    correction_threshold: int = field(default_factory=lambda: int(os.environ.get("M2M_CORRECTION_THRESHOLD", "2")))
    # Chạy pipeline đồng bộ (dùng cho kiểm thử)
    sync_jobs: bool = field(default_factory=lambda: _env_bool("M2M_SYNC_JOBS", False))
    # Tắt hoàn toàn Ollama/Whisper (dùng cho kiểm thử)
    disable_ollama: bool = field(default_factory=lambda: _env_bool("M2M_DISABLE_OLLAMA", False))
    disable_whisper: bool = field(default_factory=lambda: _env_bool("M2M_DISABLE_WHISPER", False))

    @property
    def audio_dir(self) -> Path:
        return self.data_dir / "audio"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "mic_to_mindmap.sqlite3"

    def ensure_dirs(self) -> None:
        self.audio_dir.mkdir(parents=True, exist_ok=True)


def load_settings() -> Settings:
    return Settings()
