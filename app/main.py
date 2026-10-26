"""FastAPI: API + giao diện web."""
from __future__ import annotations

import logging
import mimetypes
import shutil
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__
from .config import Settings, load_settings
from .db import Database
from .learning import AutoEmbedder, FeedbackLearner, Glossary, MemoryStore
from .llm import OllamaClient
from .mindmap import normalize_mindmap, to_markdown
from .pipeline import Pipeline
from .summarizer import Analyzer, merge_llm_result
from .transcription import Transcriber

log = logging.getLogger(__name__)
STATIC_DIR = Path(__file__).resolve().parent / "static"

ALLOWED_AUDIO_EXT = {".webm", ".ogg", ".oga", ".opus", ".mp3", ".m4a", ".mp4", ".wav", ".flac", ".aac", ".wma", ".mkv"}


# ------------------------------------------------------------------ schemas
class MeetingCreate(BaseModel):
    title: str = Field(default="", max_length=200)
    participants: list[str] = Field(default_factory=list)
    language: str | None = None


class MeetingUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    participants: list[str] | None = None
    language: str | None = None


class TranscriptUpdate(BaseModel):
    transcript: str
    reanalyze: bool = False


class AnalysisUpdate(BaseModel):
    summary: list[str] | None = None
    decisions: list[str] | None = None
    action_items: list[dict] | None = None
    keywords: list[str] | None = None
    mindmap: Any | None = None


class RatingIn(BaseModel):
    rating: int = Field(ge=1, le=5)
    comment: str | None = Field(default=None, max_length=1000)


class GlossaryIn(BaseModel):
    term: str = Field(min_length=1, max_length=120)
    variant: str = Field(default="", max_length=120)


class AskIn(BaseModel):
    question: str = Field(min_length=1, max_length=1000)
    language: str | None = None


class ProcessIn(BaseModel):
    transcribe: bool = True
    force_transcribe: bool = False


# ------------------------------------------------------------------ factory
def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    settings.ensure_dirs()
    db = Database(settings.db_path)
    ollama = OllamaClient(settings.ollama_url, settings.ollama_model, settings.ollama_embed_model,
                          timeout=settings.ollama_timeout, enabled=not settings.disable_ollama)
    transcriber = Transcriber(settings)
    analyzer = Analyzer(ollama)
    memory = MemoryStore(db, AutoEmbedder(ollama))
    glossary = Glossary(db, threshold=settings.correction_threshold)
    feedback = FeedbackLearner(db, memory)
    pipeline = Pipeline(settings, db, transcriber, analyzer, memory, glossary, feedback)

    app = FastAPI(title="Mic to Mindmap", version=__version__)
    app.state.settings = settings
    app.state.db = db
    app.state.pipeline = pipeline

    def get_meeting_or_404(meeting_id: str) -> dict:
        meeting = db.get_meeting(meeting_id)
        if meeting is None:
            raise HTTPException(404, "Không tìm thấy cuộc họp")
        return meeting

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
        return db.list_meetings(query=q)

    @app.post("/api/meetings", status_code=201)
    def create_meeting(body: MeetingCreate) -> dict:
        title = body.title.strip() or ("Cuộc họp" if settings.language.startswith("vi") else "Meeting")
        participants = [p.strip() for p in body.participants if p and p.strip()]
        return db.create_meeting(title, participants, body.language or settings.language)

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
            fields["title"] = body.title.strip()
        if body.participants is not None:
            fields["participants"] = [p.strip() for p in body.participants if p and p.strip()]
        if body.language:
            fields["language"] = body.language
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
        filename = audio.filename or "recording.webm"
        ext = Path(filename).suffix.lower()
        if ext not in ALLOWED_AUDIO_EXT:
            guessed = mimetypes.guess_extension((audio.content_type or "").split(";")[0]) or ""
            ext = guessed if guessed in ALLOWED_AUDIO_EXT else ".webm"
        target = settings.audio_dir / f"{meeting_id}-{uuid.uuid4().hex[:6]}{ext}"
        with target.open("wb") as fh:
            shutil.copyfileobj(audio.file, fh)
        old_path, _ = db.get_meeting_audio_path(meeting_id)
        if old_path and old_path != str(target):
            Path(old_path).unlink(missing_ok=True)
        fields: dict[str, Any] = {"audio_path": str(target), "audio_mime": audio.content_type, "status": "recorded"}
        if duration_sec:
            fields["duration_sec"] = float(duration_sec)
        if live_transcript and live_transcript.strip():
            fields["transcript"] = live_transcript.strip()
            fields["transcript_source"] = "browser"
        db.update_meeting(meeting_id, **fields)
        return get_meeting_or_404(meeting_id)

    @app.get("/api/meetings/{meeting_id}/audio")
    def get_audio(meeting_id: str) -> FileResponse:
        get_meeting_or_404(meeting_id)
        audio_path, mime = db.get_meeting_audio_path(meeting_id)
        if not audio_path or not Path(audio_path).exists():
            raise HTTPException(404, "Cuộc họp không có file âm thanh")
        return FileResponse(audio_path, media_type=(mime or "application/octet-stream").split(";")[0])

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
        original = meeting.get("transcript") or ""
        edited = body.transcript.strip()
        learned = glossary.learn_from_edit(original, edited) if original else []
        db.add_feedback(meeting_id, "transcript_edit", original=original, edited=edited)
        db.update_meeting(meeting_id, transcript=edited, transcript_source=(meeting.get("transcript_source") or "manual") + "+edited",
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
        original = meeting.get("analysis") or {}
        edited = dict(original)
        data = body.model_dump(exclude_none=True)
        if "mindmap" in data:
            data["mindmap"] = normalize_mindmap(data["mindmap"], root_title=meeting["title"])
        edited = merge_llm_result(data, edited, meeting["title"])
        for key in ("summary", "decisions", "action_items", "keywords"):
            if key in data and not data[key]:
                edited[key] = []
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
        analysis = meeting.get("analysis") or {}
        lines = [f"# {meeting['title']}", "", f"- Thời gian: {meeting['created_at']}"]
        if meeting.get("participants"):
            lines.append(f"- Người tham gia: {', '.join(meeting['participants'])}")
        lines += ["", "## Ý chính"] + [f"- {s}" for s in analysis.get("summary", [])]
        if analysis.get("decisions"):
            lines += ["", "## Quyết định"] + [f"- {d}" for d in analysis["decisions"]]
        if analysis.get("action_items"):
            lines += ["", "## Việc cần làm"]
            for item in analysis["action_items"]:
                meta = ", ".join(x for x in (item.get("owner"), item.get("due")) if x)
                lines.append(f"- [ ] {item.get('task')}" + (f" ({meta})" if meta else ""))
        if analysis.get("keywords"):
            lines += ["", "## Từ khóa", ", ".join(analysis["keywords"])]
        if analysis.get("mindmap"):
            lines += ["", "## Mind map", "", to_markdown(analysis["mindmap"])]
        if meeting.get("transcript"):
            lines += ["", "## Transcript", "", meeting["transcript"]]
        return PlainTextResponse("\n".join(lines) + "\n", media_type="text/markdown; charset=utf-8")

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
        snippets = memory.search(body.question, kinds=["meeting", "chunk"], k=6)
        answer = analyzer.answer(body.question, snippets, language)
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
            entry = glossary.add(body.term, body.variant, source="user")
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        entry["active"] = True
        return entry

    @app.delete("/api/glossary/{entry_id}", status_code=204)
    def delete_glossary(entry_id: int) -> Response:
        if not glossary.remove(entry_id):
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
