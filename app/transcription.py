"""Nhận dạng giọng nói offline bằng faster-whisper (tùy chọn)."""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from pathlib import Path

from .config import Settings

log = logging.getLogger(__name__)


class TranscriberUnavailable(RuntimeError):
    pass


@dataclass
class TranscriptResult:
    text: str
    language: str | None
    duration: float | None
    segments: list[dict] = field(default_factory=list)


class Transcriber:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._model = None
        self._lock = threading.Lock()
        self._import_error: str | None = None

    def available(self) -> bool:
        if self.settings.disable_whisper:
            return False
        try:
            import faster_whisper  # noqa: F401
        except Exception as exc:  # noqa: BLE001
            self._import_error = str(exc)
            return False
        return True

    def status(self) -> dict:
        return {
            "available": self.available(),
            "loaded": self._model is not None,
            "model": self.settings.whisper_model,
            "device": self.settings.whisper_device,
            "compute_type": self.settings.whisper_compute_type,
            "error": None if self.available() else (
                "Đã tắt bằng cấu hình" if self.settings.disable_whisper
                else "Chưa cài faster-whisper (pip install faster-whisper)"
            ),
        }

    def _load(self):
        if self._model is None:
            with self._lock:
                if self._model is None:
                    from faster_whisper import WhisperModel

                    log.info("Đang nạp Whisper model %s (%s/%s)", self.settings.whisper_model,
                             self.settings.whisper_device, self.settings.whisper_compute_type)
                    self._model = WhisperModel(
                        self.settings.whisper_model,
                        device=self.settings.whisper_device,
                        compute_type=self.settings.whisper_compute_type,
                    )
        return self._model

    @staticmethod
    def build_initial_prompt(hot_words: list[str] | None, max_words: int = 60) -> str | None:
        if not hot_words:
            return None
        words: list[str] = []
        total = 0
        for term in hot_words:
            n = len(term.split())
            if total + n > max_words:
                break
            words.append(term)
            total += n
        return ", ".join(words) + "." if words else None

    def transcribe(self, audio_path: str | Path, language: str | None = None,
                   hot_words: list[str] | None = None) -> TranscriptResult:
        if not self.available():
            raise TranscriberUnavailable(self._import_error or "faster-whisper chưa được cài đặt")
        model = self._load()
        segments_iter, info = model.transcribe(
            str(audio_path),
            language=language or None,
            beam_size=5,
            vad_filter=True,
            initial_prompt=self.build_initial_prompt(hot_words),
            condition_on_previous_text=False,
        )
        segments: list[dict] = []
        texts: list[str] = []
        for seg in segments_iter:
            text = seg.text.strip()
            if not text:
                continue
            segments.append({"start": round(seg.start, 2), "end": round(seg.end, 2), "text": text})
            texts.append(text)
        return TranscriptResult(
            text=" ".join(texts).strip(),
            language=getattr(info, "language", language),
            duration=getattr(info, "duration", None),
            segments=segments,
        )
