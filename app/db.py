"""Lớp truy cập SQLite: lưu cuộc họp, phản hồi, thuật ngữ, trí nhớ và nhật ký học hỏi."""
from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    participants TEXT NOT NULL DEFAULT '[]',
    language TEXT NOT NULL DEFAULT 'vi',
    status TEXT NOT NULL DEFAULT 'new',
    error TEXT,
    audio_path TEXT,
    audio_mime TEXT,
    duration_sec REAL,
    transcript TEXT,
    transcript_source TEXT,
    segments TEXT,
    analysis TEXT,
    engine TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    original TEXT,
    edited TEXT,
    rating INTEGER,
    comment TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS glossary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    term TEXT NOT NULL,
    variant TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'user',
    count INTEGER NOT NULL DEFAULT 1,
    hits INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(term, variant)
);

CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    payload TEXT,
    embedding TEXT NOT NULL,
    embedding_model TEXT NOT NULL,
    embedding_hash TEXT NOT NULL DEFAULT '[]',
    weight REAL NOT NULL DEFAULT 1.0,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);
CREATE INDEX IF NOT EXISTS idx_memories_meeting ON memories(meeting_id);

CREATE TABLE IF NOT EXISTS preferences (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL,
    meeting_id TEXT,
    created_at TEXT NOT NULL
);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def _loads(value: str | None, default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


class Database:
    def __init__(self, path: Path | str):
        self.path = str(path)
        self._lock = threading.RLock()
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as conn:
            conn.executescript(SCHEMA)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            conn = sqlite3.connect(self.path, timeout=30)
            conn.row_factory = sqlite3.Row
            try:
                conn.execute("PRAGMA journal_mode=WAL")
                conn.execute("PRAGMA foreign_keys=ON")
                yield conn
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.close()

    # ---------------------------------------------------------------- meetings
    @staticmethod
    def _meeting_row(row: sqlite3.Row | None, include_text: bool = True) -> dict | None:
        if row is None:
            return None
        data = dict(row)
        data["participants"] = _loads(data.get("participants"), [])
        data["analysis"] = _loads(data.get("analysis"), None)
        data["segments"] = _loads(data.get("segments"), [])
        data["has_audio"] = bool(data.get("audio_path"))
        if not include_text:
            transcript = data.get("transcript") or ""
            data["transcript_preview"] = transcript[:160]
            data.pop("transcript", None)
            data.pop("segments", None)
            analysis = data.get("analysis") or {}
            data["summary_preview"] = (analysis.get("summary") or [""])[0] if analysis else ""
            data.pop("analysis", None)
        data.pop("audio_path", None)
        return data

    def create_meeting(self, title: str, participants: list[str], language: str) -> dict:
        meeting_id = new_id()
        ts = now_iso()
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO meetings (id, title, participants, language, status, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, 'new', ?, ?)",
                (meeting_id, title, json.dumps(participants, ensure_ascii=False), language, ts, ts),
            )
        return self.get_meeting(meeting_id)

    def get_meeting(self, meeting_id: str, include_text: bool = True) -> dict | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
        return self._meeting_row(row, include_text)

    def get_meeting_audio_path(self, meeting_id: str) -> tuple[str | None, str | None]:
        with self.connect() as conn:
            row = conn.execute("SELECT audio_path, audio_mime FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
        if row is None:
            return None, None
        return row["audio_path"], row["audio_mime"]

    def list_meetings(self, query: str | None = None, limit: int = 200) -> list[dict]:
        sql = "SELECT * FROM meetings"
        params: list[Any] = []
        if query:
            sql += " WHERE title LIKE ? OR transcript LIKE ? OR analysis LIKE ?"
            like = f"%{query}%"
            params = [like, like, like]
        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        with self.connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [self._meeting_row(r, include_text=False) for r in rows]

    def update_meeting(self, meeting_id: str, **fields: Any) -> None:
        if not fields:
            return
        encoded: dict[str, Any] = {}
        for key, value in fields.items():
            if key in {"participants", "analysis", "segments"} and value is not None and not isinstance(value, str):
                value = json.dumps(value, ensure_ascii=False)
            encoded[key] = value
        encoded["updated_at"] = now_iso()
        assignments = ", ".join(f"{k} = ?" for k in encoded)
        with self.connect() as conn:
            conn.execute(f"UPDATE meetings SET {assignments} WHERE id = ?", (*encoded.values(), meeting_id))

    def delete_meeting(self, meeting_id: str) -> None:
        with self.connect() as conn:
            conn.execute("DELETE FROM meetings WHERE id = ?", (meeting_id,))
            conn.execute("DELETE FROM memories WHERE meeting_id = ?", (meeting_id,))
            conn.execute("DELETE FROM feedback WHERE meeting_id = ?", (meeting_id,))

    def count_meetings(self, status: str | None = None) -> int:
        with self.connect() as conn:
            if status:
                row = conn.execute("SELECT COUNT(*) FROM meetings WHERE status = ?", (status,)).fetchone()
            else:
                row = conn.execute("SELECT COUNT(*) FROM meetings").fetchone()
        return int(row[0])

    # ---------------------------------------------------------------- feedback
    def add_feedback(self, meeting_id: str, kind: str, original: Any = None, edited: Any = None,
                     rating: int | None = None, comment: str | None = None) -> int:
        def enc(v: Any) -> str | None:
            if v is None:
                return None
            return v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)

        with self.connect() as conn:
            cur = conn.execute(
                "INSERT INTO feedback (meeting_id, kind, original, edited, rating, comment, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (meeting_id, kind, enc(original), enc(edited), rating, comment, now_iso()),
            )
            return int(cur.lastrowid)

    def feedback_stats(self) -> dict:
        with self.connect() as conn:
            rows = conn.execute("SELECT kind, COUNT(*) AS n FROM feedback GROUP BY kind").fetchall()
            avg = conn.execute("SELECT AVG(rating) FROM feedback WHERE rating IS NOT NULL").fetchone()[0]
        return {"by_kind": {r["kind"]: r["n"] for r in rows}, "avg_rating": round(avg, 2) if avg else None}

    def list_feedback(self, kind: str | None = None, limit: int = 500) -> list[dict]:
        with self.connect() as conn:
            if kind:
                rows = conn.execute("SELECT * FROM feedback WHERE kind = ? ORDER BY id DESC LIMIT ?", (kind, limit)).fetchall()
            else:
                rows = conn.execute("SELECT * FROM feedback ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [dict(r) for r in rows]

    # ---------------------------------------------------------------- glossary
    def upsert_glossary(self, term: str, variant: str = "", source: str = "user", increment: int = 1) -> dict:
        ts = now_iso()
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM glossary WHERE term = ? AND variant = ?", (term, variant)).fetchone()
            if row is None:
                conn.execute(
                    "INSERT INTO glossary (term, variant, source, count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                    (term, variant, source, max(increment, 1), ts, ts),
                )
            else:
                new_source = "user" if "user" in (source, row["source"]) else row["source"]
                conn.execute(
                    "UPDATE glossary SET count = count + ?, source = ?, updated_at = ? WHERE id = ?",
                    (increment, new_source, ts, row["id"]),
                )
            row = conn.execute("SELECT * FROM glossary WHERE term = ? AND variant = ?", (term, variant)).fetchone()
        return dict(row)

    def list_glossary(self) -> list[dict]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM glossary ORDER BY CASE source WHEN 'user' THEN 0 ELSE 1 END, count DESC, term"
            ).fetchall()
        return [dict(r) for r in rows]

    def delete_glossary(self, entry_id: int) -> bool:
        with self.connect() as conn:
            cur = conn.execute("DELETE FROM glossary WHERE id = ?", (entry_id,))
            return cur.rowcount > 0

    def bump_glossary_hits(self, ids: list[int]) -> None:
        if not ids:
            return
        with self.connect() as conn:
            conn.executemany("UPDATE glossary SET hits = hits + 1 WHERE id = ?", [(i,) for i in ids])

    # ---------------------------------------------------------------- memories
    def add_memory(self, meeting_id: str | None, kind: str, text: str, embedding: list[float],
                   embedding_model: str, embedding_hash: list[float], payload: Any = None,
                   weight: float = 1.0) -> int:
        with self.connect() as conn:
            cur = conn.execute(
                "INSERT INTO memories (meeting_id, kind, text, payload, embedding, embedding_model, embedding_hash,"
                " weight, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    meeting_id, kind, text,
                    json.dumps(payload, ensure_ascii=False) if payload is not None else None,
                    json.dumps(embedding), embedding_model, json.dumps(embedding_hash), weight, now_iso(),
                ),
            )
            return int(cur.lastrowid)

    def update_memory_embedding(self, memory_id: int, embedding: list[float], embedding_model: str) -> None:
        with self.connect() as conn:
            conn.execute("UPDATE memories SET embedding = ?, embedding_model = ? WHERE id = ?",
                         (json.dumps(embedding), embedding_model, memory_id))

    def delete_memories(self, meeting_id: str, kind: str | None = None) -> None:
        with self.connect() as conn:
            if kind:
                conn.execute("DELETE FROM memories WHERE meeting_id = ? AND kind = ?", (meeting_id, kind))
            else:
                conn.execute("DELETE FROM memories WHERE meeting_id = ?", (meeting_id,))

    def iter_memories(self, kinds: list[str] | None = None, meeting_id: str | None = None) -> list[dict]:
        sql = "SELECT * FROM memories WHERE 1=1"
        params: list[Any] = []
        if kinds:
            sql += " AND kind IN (%s)" % ",".join("?" for _ in kinds)
            params.extend(kinds)
        if meeting_id:
            sql += " AND meeting_id = ?"
            params.append(meeting_id)
        with self.connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["embedding"] = _loads(d["embedding"], [])
            d["embedding_hash"] = _loads(d["embedding_hash"], [])
            d["payload"] = _loads(d.get("payload"), None)
            result.append(d)
        return result

    def count_memories(self, kind: str | None = None) -> int:
        with self.connect() as conn:
            if kind:
                row = conn.execute("SELECT COUNT(*) FROM memories WHERE kind = ?", (kind,)).fetchone()
            else:
                row = conn.execute("SELECT COUNT(*) FROM memories").fetchone()
        return int(row[0])

    # ------------------------------------------------------------- preferences
    def get_pref(self, key: str, default: Any = None) -> Any:
        with self.connect() as conn:
            row = conn.execute("SELECT value FROM preferences WHERE key = ?", (key,)).fetchone()
        return _loads(row["value"], default) if row else default

    def set_pref(self, key: str, value: Any) -> None:
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)"
                " ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                (key, json.dumps(value, ensure_ascii=False), now_iso()),
            )

    def all_prefs(self) -> dict:
        with self.connect() as conn:
            rows = conn.execute("SELECT key, value FROM preferences").fetchall()
        return {r["key"]: _loads(r["value"], None) for r in rows}

    # ------------------------------------------------------------------ events
    def log_event(self, kind: str, detail: str, meeting_id: str | None = None) -> None:
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO events (kind, detail, meeting_id, created_at) VALUES (?, ?, ?, ?)",
                (kind, detail, meeting_id, now_iso()),
            )

    def list_events(self, limit: int = 50) -> list[dict]:
        with self.connect() as conn:
            rows = conn.execute("SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [dict(r) for r in rows]

    def count_events(self) -> int:
        with self.connect() as conn:
            return int(conn.execute("SELECT COUNT(*) FROM events").fetchone()[0])
