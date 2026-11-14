"""FastAPI: API + giao diện web."""
from __future__ import annotations

import logging
import math
import mimetypes
import shutil
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator

from . import __version__
from .config import Settings, load_settings
from .db import Database
from .learning import AutoEmbedder, FeedbackLearner, Glossary, MemoryStore
from .llm import OllamaClient
from .mindmap import USER_MAX_CHILDREN, USER_MAX_DEPTH, meeting_markdown, normalize_mindmap
from .pipeline import Pipeline
from .summarizer import Analyzer, _as_action_items, _as_str_list
from .textutil import nfc, scrub_json
from .transcription import Transcriber

log = logging.getLogger(__name__)


def nfc_tree(value: Any) -> Any:
    """Chuẩn hóa NFC mọi chuỗi trong cây JSON (mind map do giao diện gửi lên)."""
    if isinstance(value, str):
        return nfc(value)
    if isinstance(value, list):
        return [nfc_tree(v) for v in value]
    if isinstance(value, dict):
        return {nfc_tree(k): nfc_tree(v) for k, v in value.items()}
    return value


STATIC_DIR = Path(__file__).resolve().parent / "static"

# Thời lượng do client báo chỉ để hiển thị: bỏ qua giá trị âm, vô cực, NaN hay phi lý (trên 30 ngày)
MAX_DURATION_SEC = 30 * 24 * 3600
SQLITE_MAX_INT = 2**63 - 1

ALLOWED_AUDIO_EXT = {".webm", ".ogg", ".oga", ".opus", ".mp3", ".m4a", ".mp4", ".wav", ".flac", ".aac", ".wma", ".mkv"}


# ------------------------------------------------------------------ schemas
class ApiModel(BaseModel):
    """Mọi thân request JSON đi qua đây trước: bỏ surrogate lẻ, cắt phần lồng quá sâu (xem textutil.scrub_json)."""

    @model_validator(mode="before")
    @classmethod
    def _scrub(cls, data: Any) -> Any:
        return scrub_json(data)


class MeetingCreate(ApiModel):
    title: str = Field(default="", max_length=200)
    participants: list[str] = Field(default_factory=list)
    language: str | None = None


class MeetingUpdate(ApiModel):
    title: str | None = Field(default=None, max_length=200)
    participants: list[str] | None = None
    language: str | None = None


class TranscriptUpdate(ApiModel):
    transcript: str
    reanalyze: bool = False


class AnalysisUpdate(ApiModel):
    summary: list[str] | None = None
    decisions: list[str] | None = None
    action_items: list[dict] | None = None
    keywords: list[str] | None = None
    mindmap: Any | None = None


class RatingIn(ApiModel):
    rating: int = Field(ge=1, le=5)
    comment: str | None = Field(default=None, max_length=1000)


class GlossaryIn(ApiModel):
    term: str = Field(min_length=1, max_length=120)
    variant: str = Field(default="", max_length=120)


class AskIn(ApiModel):
    question: str = Field(min_length=1, max_length=1000)
    language: str | None = None


class ProcessIn(ApiModel):
    transcribe: bool = True
    force_transcribe: bool = False


# ------------------------------------------------------------------ factory
def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    settings.ensure_dirs()
    db = Database(settings.db_path)
    # Máy chủ bị tắt giữa lúc xử lý: không còn luồng nào chạy tiếp, đừng để cuộc họp kẹt ở "đang xử lý"
    interrupted = db.fail_interrupted_meetings(
        "Quá trình xử lý bị gián đoạn vì máy chủ dừng giữa chừng. Nhấn \"Phân tích lại\" để chạy lại.")
    if interrupted:
        log.warning("Đặt lại %d cuộc họp bị gián đoạn khi máy chủ dừng", interrupted)
    ollama = OllamaClient(settings.ollama_url, settings.ollama_model, settings.ollama_embed_model,
                          timeout=settings.ollama_timeout, enabled=not settings.disable_ollama)
    transcriber = Transcriber(settings)
    analyzer = Analyzer(ollama)
    memory = MemoryStore(db, AutoEmbedder(ollama))
    glossary = Glossary(db, threshold=settings.correction_threshold)
    feedback = FeedbackLearner(db, memory)
    pipeline = Pipeline(settings, db, transcriber, analyzer, memory, glossary, feedback)

    app = FastAPI(title="Mic to Mindmap", version=__version__)
    # Ứng dụng di động (Capacitor) gọi API từ origin khác trong mạng LAN
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
    app.state.settings = settings
    app.state.db = db
    app.state.pipeline = pipeline

    def get_meeting_or_404(meeting_id: str) -> dict:
        meeting = db.get_meeting(meeting_id)
        if meeting is None:
            raise HTTPException(404, "Không tìm thấy cuộc họp")
        return meeting

    def ensure_not_processing(meeting_id: str) -> None:
        if pipeline.is_running(meeting_id):
            raise HTTPException(409, "Cuộc họp đang được xử lý, vui lòng đợi xong rồi sửa")

    def normalize_language(value: str | None) -> str:
        value = (value or "").strip().lower()
        return value if value else settings.language

    # ------------------------------------------------------------- health
    @app.get("/api/health")
    def health() -> dict:
        return {
            "version": __version__,
            "whisper": transcriber.status(),
            "ollama": ollama.status(),
            "engine": analyzer.engine_name(),
            "embedder": memory.embedder.primary_name,
            "language": settings.language,
            "data_dir": str(settings.data_dir),
        }

    # ----------------------------------------------------------- meetings
    @app.get("/api/meetings")
    def list_meetings(q: str | None = None) -> list[dict]:
        return db.list_meetings(query=nfc(q).strip() if q else None)

    @app.post("/api/meetings", status_code=201)
    def create_meeting(body: MeetingCreate) -> dict:
        title = nfc(body.title).strip() or ("Cuộc họp" if settings.language.startswith("vi") else "Meeting")
        participants = [nfc(p).strip() for p in body.participants if p and p.strip()]
        return db.create_meeting(title, participants, normalize_language(body.language))

    @app.get("/api/meetings/{meeting_id}")
    def get_meeting(meeting_id: str) -> dict:
        meeting = get_meeting_or_404(meeting_id)
        meeting["processing"] = pipeline.is_running(meeting_id)
        return meeting

    @app.patch("/api/meetings/{meeting_id}")
    def update_meeting(meeting_id: str, body: MeetingUpdate) -> dict:
        get_meeting_or_404(meeting_id)
        fields: dict[str, Any] = {}
        if body.title is not None and body.title.strip():
            fields["title"] = nfc(body.title).strip()
        if body.participants is not None:
            fields["participants"] = [nfc(p).strip() for p in body.participants if p and p.strip()]
        if body.language:
            fields["language"] = normalize_language(body.language)
        db.update_meeting(meeting_id, **fields)
        return get_meeting_or_404(meeting_id)

    @app.delete("/api/meetings/{meeting_id}", status_code=204)
    def delete_meeting(meeting_id: str) -> Response:
        get_meeting_or_404(meeting_id)
        audio_path, _ = db.get_meeting_audio_path(meeting_id)
        db.delete_meeting(meeting_id)
        memory.forget_meeting(meeting_id)
        if audio_path:
            Path(audio_path).unlink(missing_ok=True)
        return Response(status_code=204)

    @app.post("/api/meetings/{meeting_id}/audio")
    def upload_audio(meeting_id: str, audio: UploadFile = File(...), duration_sec: float | None = Form(None),
                     live_transcript: str | None = Form(None)) -> dict:
        get_meeting_or_404(meeting_id)
        ensure_not_processing(meeting_id)
        filename = audio.filename or "recording.webm"
        ext = Path(filename).suffix.lower()
        if ext not in ALLOWED_AUDIO_EXT:
            guessed = mimetypes.guess_extension((audio.content_type or "").split(";")[0]) or ""
            ext = guessed if guessed in ALLOWED_AUDIO_EXT else ".webm"
        target = settings.audio_dir / f"{meeting_id}-{uuid.uuid4().hex[:6]}{ext}"
        try:
            with target.open("wb") as fh:
                shutil.copyfileobj(audio.file, fh)
        except Exception:
            target.unlink(missing_ok=True)  # ghi dở (vd: hết dung lượng): không để lại file rác
            raise
        if target.stat().st_size == 0:
            target.unlink(missing_ok=True)
            raise HTTPException(400, "File âm thanh rỗng")
        old_path, _ = db.get_meeting_audio_path(meeting_id)
        fields: dict[str, Any] = {"audio_path": str(target), "audio_mime": audio.content_type, "status": "recorded"}
        if duration_sec and math.isfinite(duration_sec) and 0 < duration_sec < MAX_DURATION_SEC:
            fields["duration_sec"] = float(duration_sec)
        if live_transcript and live_transcript.strip():
            fields["transcript"] = nfc(live_transcript).strip()
            fields["transcript_source"] = "browser"
        db.update_meeting(meeting_id, **fields)
        if db.get_meeting(meeting_id) is None:
            target.unlink(missing_ok=True)  # cuộc họp bị xóa trong lúc đang tải lên
            raise HTTPException(404, "Không tìm thấy cuộc họp")
        # ghi bản mới xong mới xóa bản cũ
        if old_path and old_path != str(target):
            Path(old_path).unlink(missing_ok=True)
        return get_meeting_or_404(meeting_id)

    @app.get("/api/meetings/{meeting_id}/audio")
    def get_audio(meeting_id: str) -> FileResponse:
        get_meeting_or_404(meeting_id)
        audio_path, mime = db.get_meeting_audio_path(meeting_id)
        if not audio_path or not Path(audio_path).exists():
            raise HTTPException(404, "Cuộc họp không có file âm thanh")
        # audio_mime do client gửi lên: chỉ phát lại dưới dạng âm thanh/video, không bao giờ là HTML/script
        media_type = (mime or "").split(";")[0].strip().lower()
        if not media_type.startswith(("audio/", "video/")):
            media_type = "application/octet-stream"
        return FileResponse(audio_path, media_type=media_type, headers={"X-Content-Type-Options": "nosniff"})

    @app.post("/api/meetings/{meeting_id}/process", status_code=202)
    def process_meeting(meeting_id: str, body: ProcessIn | None = None) -> dict:
        meeting = get_meeting_or_404(meeting_id)
        body = body or ProcessIn()
        audio_path, _ = db.get_meeting_audio_path(meeting_id)
        if not audio_path and not (meeting.get("transcript") or "").strip():
            raise HTTPException(400, "Cuộc họp chưa có âm thanh hoặc transcript")
        started = pipeline.start(meeting_id, do_transcribe=body.transcribe, force_transcribe=body.force_transcribe)
        return {"started": started, "meeting": get_meeting_or_404(meeting_id)}

    @app.put("/api/meetings/{meeting_id}/transcript")
    def update_transcript(meeting_id: str, body: TranscriptUpdate) -> dict:
        meeting = get_meeting_or_404(meeting_id)
        ensure_not_processing(meeting_id)
        original = meeting.get("transcript") or ""
        edited = nfc(body.transcript).strip()
        learned = glossary.learn_from_edit(original, edited) if original else []
        source = meeting.get("transcript_source") or "manual"
        if original.strip() and edited != original:
            # chỉ là "chỉnh sửa" khi đã có transcript trước đó và nội dung thật sự đổi
            db.add_feedback(meeting_id, "transcript_edit", original=original, edited=edited)
            if not source.endswith("+edited"):
                source += "+edited"
        db.update_meeting(meeting_id, transcript=edited, transcript_source=source,
                          status="transcribed" if not meeting.get("analysis") else meeting["status"])
        if learned:
            db.log_event("glossary", f"Ghi nhận {len(learned)} cặp sửa lỗi từ chỉnh sửa transcript", meeting_id)
        if body.reanalyze:
            pipeline.start(meeting_id, do_transcribe=False)
        result = get_meeting_or_404(meeting_id)
        result["learned_corrections"] = [{"variant": e["variant"], "term": e["term"], "count": e["count"]} for e in learned]
        return result

    @app.put("/api/meetings/{meeting_id}/analysis")
    def update_analysis(meeting_id: str, body: AnalysisUpdate) -> dict:
        meeting = get_meeting_or_404(meeting_id)
        ensure_not_processing(meeting_id)
        original = meeting.get("analysis") or {}
        edited = dict(original)
        data = body.model_dump(exclude_none=True)
        # Bản người dùng tự sửa: chỉ làm sạch, không cắt theo giới hạn dành cho kết quả LLM (12 ý, 12 nhánh, 4 cấp)
        for key, max_len in (("summary", 2000), ("decisions", 2000), ("keywords", 200)):
            if key in data:
                edited[key] = _as_str_list([nfc(str(x)) for x in data[key]], limit=500, max_len=max_len)
        if "action_items" in data:
            edited["action_items"] = _as_action_items(
                [{k: nfc(v) if isinstance(v, str) else v for k, v in item.items()}
                 for item in data["action_items"] if isinstance(item, dict)], limit=500)
        if "mindmap" in data:
            mindmap = normalize_mindmap(nfc_tree(data["mindmap"]), root_title=meeting["title"],
                                        max_depth=USER_MAX_DEPTH, max_children=USER_MAX_CHILDREN)
            if mindmap:
                edited["mindmap"] = mindmap  # kể cả khi chỉ còn nút gốc: người dùng đã chủ động xóa hết nhánh
        edited["engine"] = original.get("engine", "manual")
        edited["edited"] = True
        db.update_meeting(meeting_id, analysis=edited)
        meeting = get_meeting_or_404(meeting_id)
        learn = feedback.record_analysis_edit(meeting, original, edited)
        if learn.get("learned"):
            memory.remember_meeting(meeting, edited)
        meeting["learning"] = learn
        return meeting

    @app.post("/api/meetings/{meeting_id}/rating")
    def rate_meeting(meeting_id: str, body: RatingIn) -> dict:
        meeting = get_meeting_or_404(meeting_id)
        return feedback.record_rating(meeting, body.rating, body.comment)

    @app.get("/api/meetings/{meeting_id}/export.md")
    def export_markdown(meeting_id: str) -> PlainTextResponse:
        meeting = get_meeting_or_404(meeting_id)
        return PlainTextResponse(meeting_markdown(meeting), media_type="text/markdown; charset=utf-8")

    # ----------------------------------------------------------- learning
    @app.get("/api/learning/stats")
    def learning_stats() -> dict:
        return {
            "meetings": db.count_meetings(),
            "analyzed": db.count_meetings("done"),
            "memory": memory.stats(),
            "glossary": glossary.stats(),
            "feedback": feedback.stats(),
            "events": db.count_events(),
            "engine": analyzer.engine_name(),
            "style_hints": feedback.style_hints(settings.language),
        }

    @app.get("/api/learning/events")
    def learning_events(limit: int = 50) -> list[dict]:
        return db.list_events(limit=max(1, min(limit, 500)))

    @app.get("/api/learning/search")
    def learning_search(q: str, k: int = 6) -> list[dict]:
        return memory.search(q, kinds=["meeting", "chunk"], k=max(1, min(k, 20)))

    @app.post("/api/learning/ask")
    def learning_ask(body: AskIn) -> dict:
        language = body.language or settings.language
        question = nfc(body.question)
        snippets = memory.search(question, kinds=["meeting", "chunk"], k=6)
        answer = analyzer.answer(question, snippets, language)
        if answer is None:
            if snippets:
                answer = ("Không có LLM local để trả lời; đây là các đoạn liên quan nhất:" if language.startswith("vi")
                          else "No local LLM available; these are the most relevant excerpts:")
            else:
                answer = "Chưa có trí nhớ nào liên quan." if language.startswith("vi") else "No related memory yet."
        return {"answer": answer, "sources": snippets, "engine": analyzer.engine_name()}

    @app.post("/api/learning/reindex")
    def learning_reindex() -> dict:
        updated = memory.reindex()
        if updated:
            db.log_event("memory", f"Nhúng lại {updated} mảnh trí nhớ bằng {memory.embedder.primary_name}")
        return {"updated": updated, "embedder": memory.embedder.primary_name}

    @app.get("/api/learning/export")
    def learning_export() -> PlainTextResponse:
        rows = feedback.export_examples()
        return PlainTextResponse(FeedbackLearner.to_jsonl(rows), media_type="application/jsonl; charset=utf-8",
                                 headers={"Content-Disposition": "attachment; filename=mic-to-mindmap-examples.jsonl"})

    @app.get("/api/glossary")
    def list_glossary() -> list[dict]:
        return glossary.entries()

    @app.post("/api/glossary", status_code=201)
    def add_glossary(body: GlossaryIn) -> dict:
        try:
            entry = glossary.add(nfc(body.term), nfc(body.variant), source="user")
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        entry["active"] = True
        return entry

    @app.delete("/api/glossary/{entry_id}", status_code=204)
    def delete_glossary(entry_id: int) -> Response:
        # số ngoài khoảng INTEGER của SQLite chắc chắn không phải id có thật (và làm sqlite3 ném OverflowError)
        if not 0 < entry_id <= SQLITE_MAX_INT or not glossary.remove(entry_id):
            raise HTTPException(404, "Không tìm thấy thuật ngữ")
        return Response(status_code=204)

    # ------------------------------------------------------------- static
    @app.get("/", include_in_schema=False)
    def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    if STATIC_DIR.exists():
        app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    @app.exception_handler(Exception)
    async def unhandled(_, exc: Exception) -> JSONResponse:  # pragma: no cover - lưới an toàn
        log.exception("Lỗi không xử lý: %s", exc)
        return JSONResponse(status_code=500, content={"detail": str(exc)})

    return app


app = create_app()
