"""Trí nhớ dài hạn: lưu tóm tắt/transcript/ví dụ kèm vector để tìm theo ngữ nghĩa."""
from __future__ import annotations

from ..db import Database
from ..textutil import normalize_ws, split_sentences
from .embeddings import AutoEmbedder, cosine

CHUNK_CHARS = 700
MAX_CHUNKS_PER_MEETING = 60


def chunk_text(text: str, max_chars: int = CHUNK_CHARS) -> list[str]:
    chunks: list[str] = []
    current = ""
    for sentence in split_sentences(text):
        if len(current) + len(sentence) + 1 > max_chars and current:
            chunks.append(current.strip())
            current = ""
        current += " " + sentence
    if current.strip():
        chunks.append(current.strip())
    return chunks


class MemoryStore:
    def __init__(self, db: Database, embedder: AutoEmbedder):
        self.db = db
        self.embedder = embedder

    # ------------------------------------------------------------------ write
    def remember(self, meeting_id: str | None, kind: str, text: str, payload: dict | None = None,
                 weight: float = 1.0) -> int:
        text = normalize_ws(text)
        if not text:
            return -1
        vec, model, hashed = self.embedder.embed(text)
        return self.db.add_memory(meeting_id, kind, text, vec, model, hashed, payload=payload, weight=weight)

    def remember_meeting(self, meeting: dict, analysis: dict) -> int:
        """Lưu tóm tắt cuộc họp (ghi đè bản cũ) và các đoạn transcript để hỏi đáp sau này."""
        meeting_id = meeting["id"]
        self.db.delete_memories(meeting_id, kind="meeting")
        self.db.delete_memories(meeting_id, kind="chunk")
        parts = [meeting.get("title", "")]
        parts.extend(analysis.get("summary", []))
        parts.extend(analysis.get("decisions", []))
        parts.extend(item.get("task", "") for item in analysis.get("action_items", []))
        parts.extend(analysis.get("keywords", []))
        payload = {
            "title": meeting.get("title"),
            "date": meeting.get("created_at"),
            "summary": analysis.get("summary", [])[:8],
            "decisions": analysis.get("decisions", [])[:6],
            "action_items": analysis.get("action_items", [])[:8],
            "keywords": analysis.get("keywords", [])[:10],
        }
        count = 1 if self.remember(meeting_id, "meeting", " . ".join(p for p in parts if p), payload) >= 0 else 0
        transcript = meeting.get("transcript") or ""
        for index, chunk in enumerate(chunk_text(transcript)[:MAX_CHUNKS_PER_MEETING]):
            self.remember(meeting_id, "chunk", chunk, {"title": meeting.get("title"), "index": index,
                                                       "date": meeting.get("created_at")})
            count += 1
        return count

    def forget_meeting(self, meeting_id: str) -> None:
        self.db.delete_memories(meeting_id)

    # ------------------------------------------------------------------- read
    def search(self, query: str, kinds: list[str] | None = None, k: int = 5,
               exclude_meeting: str | None = None, min_score: float = 0.02) -> list[dict]:
        query = normalize_ws(query)
        if not query:
            return []
        qvec, qmodel, qhash = self.embedder.embed(query)
        results: list[dict] = []
        for memory in self.db.iter_memories(kinds):
            if exclude_meeting and memory.get("meeting_id") == exclude_meeting:
                continue
            if memory["embedding_model"] == qmodel and memory["embedding"]:
                score = cosine(qvec, memory["embedding"])
            else:
                score = cosine(qhash, memory["embedding_hash"])
            score *= float(memory.get("weight") or 1.0)
            if score < min_score:
                continue
            results.append({
                "id": memory["id"],
                "meeting_id": memory.get("meeting_id"),
                "kind": memory["kind"],
                "text": memory["text"],
                "payload": memory.get("payload"),
                "score": round(score, 4),
                "created_at": memory.get("created_at"),
            })
        results.sort(key=lambda r: -r["score"])
        # mỗi cuộc họp chỉ lấy tối đa 2 mảnh để kết quả đa dạng
        per_meeting: dict = {}
        picked: list[dict] = []
        for r in results:
            key = r.get("meeting_id") or r["id"]
            if per_meeting.get(key, 0) >= 2:
                continue
            per_meeting[key] = per_meeting.get(key, 0) + 1
            picked.append(r)
            if len(picked) >= k:
                break
        return picked

    def reindex(self) -> int:
        """Nhúng lại toàn bộ trí nhớ bằng model hiện tại (sau khi cài Ollama chẳng hạn)."""
        model = self.embedder.primary_name
        updated = 0
        for memory in self.db.iter_memories():
            if memory["embedding_model"] == model:
                continue
            vec, name, _ = self.embedder.embed(memory["text"])
            self.db.update_memory_embedding(memory["id"], vec, name)
            updated += 1
        return updated

    def stats(self) -> dict:
        return {
            "meetings": self.db.count_memories("meeting"),
            "chunks": self.db.count_memories("chunk"),
            "examples": self.db.count_memories("example"),
            "embedder": self.embedder.primary_name,
        }
