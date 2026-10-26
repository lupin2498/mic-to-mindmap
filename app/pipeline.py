"""Pipeline xử lý một cuộc họp: nhận dạng giọng nói -> sửa thuật ngữ -> phân tích -> ghi nhớ."""
from __future__ import annotations

import logging
import threading
import traceback

from .config import Settings
from .db import Database
from .learning import FeedbackLearner, Glossary, MemoryStore, build_context, context_summary
from .summarizer import Analyzer
from .transcription import Transcriber, TranscriberUnavailable

log = logging.getLogger(__name__)


class Pipeline:
    def __init__(self, settings: Settings, db: Database, transcriber: Transcriber, analyzer: Analyzer,
                 memory: MemoryStore, glossary: Glossary, feedback: FeedbackLearner):
        self.settings = settings
        self.db = db
        self.transcriber = transcriber
        self.analyzer = analyzer
        self.memory = memory
        self.glossary = glossary
        self.feedback = feedback
        self._running: set[str] = set()
        self._lock = threading.Lock()

    def is_running(self, meeting_id: str) -> bool:
        with self._lock:
            return meeting_id in self._running

    @staticmethod
    def whisper_language(meeting: dict) -> str | None:
        lang = (meeting.get("language") or "").strip().lower()
        return None if lang in ("", "auto") else lang

    def analysis_language(self, meeting: dict) -> str:
        return self.whisper_language(meeting) or self.settings.language

    # ----------------------------------------------------------------- steps
    def transcribe(self, meeting_id: str, force: bool = False) -> dict:
        meeting = self.db.get_meeting(meeting_id)
        if meeting is None:
            raise KeyError(meeting_id)
        audio_path, _ = self.db.get_meeting_audio_path(meeting_id)
        has_transcript = bool((meeting.get("transcript") or "").strip())
        text = meeting.get("transcript") or ""
        source = meeting.get("transcript_source") or ("browser" if has_transcript else None)
        segments = meeting.get("segments") or []
        duration = meeting.get("duration_sec")

        if audio_path and self.transcriber.available() and (force or not has_transcript or source == "browser"):
            self.db.update_meeting(meeting_id, status="transcribing", error=None)
            hot_words = self.glossary.hot_words()
            try:
                result = self.transcriber.transcribe(audio_path, language=self.whisper_language(meeting),
                                                     hot_words=hot_words)
            except Exception as exc:  # noqa: BLE001 - vd: chưa tải được model
                if not has_transcript:
                    raise RuntimeError(f"Whisper lỗi: {exc}") from exc
                log.warning("Whisper lỗi, dùng transcript từ trình duyệt: %s", exc)
                self.db.log_event("warning", f"Whisper lỗi ({str(exc)[:120]}), dùng transcript từ trình duyệt", meeting_id)
                result = None
            if result and result.text.strip():
                text, source, segments = result.text, f"whisper:{self.settings.whisper_model}", result.segments
                duration = duration or result.duration
                if self.whisper_language(meeting) is None and result.language:
                    self.db.update_meeting(meeting_id, language=result.language)
                    self.db.log_event("memory", f"Tự nhận dạng ngôn ngữ cuộc họp: {result.language}", meeting_id)
            elif result is not None and not has_transcript:
                raise RuntimeError("Whisper không nhận dạng được nội dung nào trong file âm thanh")
        elif not has_transcript:
            if audio_path and not self.transcriber.available():
                raise TranscriberUnavailable(
                    "Chưa cài faster-whisper để nhận dạng giọng nói offline (pip install faster-whisper), "
                    "và không có transcript từ trình duyệt."
                )
            raise RuntimeError("Cuộc họp chưa có âm thanh hoặc transcript")

        text, applied = self.glossary.apply(text)
        if applied:
            self.db.log_event("glossary", f"Tự động sửa {applied} chỗ trong transcript theo thuật ngữ đã học", meeting_id)
        self.db.update_meeting(meeting_id, transcript=text, transcript_source=source, segments=segments,
                               duration_sec=duration, status="transcribed")
        return self.db.get_meeting(meeting_id)

    def analyze(self, meeting_id: str) -> dict:
        meeting = self.db.get_meeting(meeting_id)
        if meeting is None:
            raise KeyError(meeting_id)
        transcript = (meeting.get("transcript") or "").strip()
        if not transcript:
            raise RuntimeError("Chưa có transcript để phân tích")
        self.db.update_meeting(meeting_id, status="analyzing", error=None)
        language = self.analysis_language(meeting)
        context = build_context(transcript, meeting["title"], memory=self.memory, glossary=self.glossary,
                                feedback=self.feedback, exclude_meeting_id=meeting_id, language=language)
        analysis = self.analyzer.analyze(transcript, meeting["title"], meeting.get("participants") or [],
                                         language, context)
        analysis["context_used"] = context_summary(context)
        self.db.update_meeting(meeting_id, analysis=analysis, engine=analysis.get("engine"), status="done")
        meeting = self.db.get_meeting(meeting_id)
        remembered = self.memory.remember_meeting(meeting, analysis)
        self.db.log_event("memory", f"Ghi nhớ cuộc họp '{meeting['title']}' ({remembered} mảnh trí nhớ, engine {analysis.get('engine')})",
                          meeting_id)
        return meeting

    # --------------------------------------------------------------- runners
    def run(self, meeting_id: str, *, do_transcribe: bool = True, force_transcribe: bool = False) -> dict | None:
        try:
            if do_transcribe:
                self.transcribe(meeting_id, force=force_transcribe)
            return self.analyze(meeting_id)
        except Exception as exc:  # noqa: BLE001 - lỗi được ghi vào cuộc họp để UI hiển thị
            log.error("Xử lý cuộc họp %s thất bại: %s\n%s", meeting_id, exc, traceback.format_exc())
            self.db.update_meeting(meeting_id, status="error", error=str(exc))
            return None
        finally:
            with self._lock:
                self._running.discard(meeting_id)

    def start(self, meeting_id: str, *, do_transcribe: bool = True, force_transcribe: bool = False) -> bool:
        with self._lock:
            if meeting_id in self._running:
                return False
            self._running.add(meeting_id)
        self.db.update_meeting(meeting_id, status="queued", error=None)
        if self.settings.sync_jobs:
            self.run(meeting_id, do_transcribe=do_transcribe, force_transcribe=force_transcribe)
        else:
            thread = threading.Thread(
                target=self.run, args=(meeting_id,),
                kwargs={"do_transcribe": do_transcribe, "force_transcribe": force_transcribe}, daemon=True,
            )
            thread.start()
        return True
