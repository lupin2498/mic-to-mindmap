"""Học từ phản hồi: bản tóm tắt người dùng đã sửa trở thành ví dụ mẫu; học phong cách trình bày."""
from __future__ import annotations

import json

from ..db import Database
from ..mindmap import flatten_titles
from .memory import MemoryStore

STYLE_KEY = "style"
EXAMPLE_EXCERPT_CHARS = 2500


def _avg(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _words(text: str) -> int:
    return len((text or "").split())


class FeedbackLearner:
    def __init__(self, db: Database, memory: MemoryStore):
        self.db = db
        self.memory = memory

    # -------------------------------------------------------------- helpers
    def _style(self) -> dict:
        return self.db.get_pref(STYLE_KEY, {
            "edits": 0,
            "avg_summary_items": None,
            "avg_words_per_item": None,
            "avg_mindmap_nodes": None,
            "avg_branches": None,
            "keeps_decisions": None,
            "keeps_action_items": None,
            "ratings": [],
        })

    @staticmethod
    def _ema(old: float | None, new: float, alpha: float = 0.3) -> float:
        return new if old is None else round(old * (1 - alpha) + new * alpha, 2)

    def _store_example(self, meeting: dict, analysis: dict, weight: float, source: str) -> None:
        transcript = (meeting.get("transcript") or "")[:EXAMPLE_EXCERPT_CHARS]
        if not transcript.strip():
            return
        # một cuộc họp chỉ giữ một ví dụ mới nhất
        self.db.delete_memories(meeting["id"], kind="example")
        payload = {
            "title": meeting.get("title"),
            "language": meeting.get("language"),
            "source": source,
            "summary": analysis.get("summary", []),
            "decisions": analysis.get("decisions", []),
            "action_items": analysis.get("action_items", []),
            "keywords": analysis.get("keywords", []),
            "mindmap": analysis.get("mindmap"),
        }
        self.memory.remember(meeting["id"], "example", transcript, payload, weight=weight)

    # ---------------------------------------------------------------- learn
    def record_analysis_edit(self, meeting: dict, original: dict | None, edited: dict) -> dict:
        original = original or {}
        changed = {
            key: (original.get(key) or None) != (edited.get(key) or None)
            for key in ("summary", "decisions", "action_items", "mindmap", "keywords")
        }
        self.db.add_feedback(meeting["id"], "analysis_edit", original=original, edited=edited)
        if not any(changed.values()):
            return {"changed": changed, "learned": False}

        style = self._style()
        style["edits"] = int(style.get("edits", 0)) + 1
        summary = edited.get("summary") or []
        if summary:
            style["avg_summary_items"] = self._ema(style.get("avg_summary_items"), len(summary))
            style["avg_words_per_item"] = self._ema(style.get("avg_words_per_item"), _avg([_words(s) for s in summary]))
        mindmap = edited.get("mindmap")
        if mindmap:
            style["avg_mindmap_nodes"] = self._ema(style.get("avg_mindmap_nodes"), len(flatten_titles(mindmap)))
            style["avg_branches"] = self._ema(style.get("avg_branches"), len(mindmap.get("children") or []))
        style["keeps_decisions"] = self._ema(style.get("keeps_decisions"), 1.0 if edited.get("decisions") else 0.0)
        style["keeps_action_items"] = self._ema(style.get("keeps_action_items"), 1.0 if edited.get("action_items") else 0.0)
        self.db.set_pref(STYLE_KEY, style)

        self._store_example(meeting, edited, weight=1.15, source="edit")
        parts = [k for k, v in changed.items() if v]
        self.db.log_event("feedback", f"Học từ bản chỉnh sửa của người dùng ({', '.join(parts)}) ở cuộc họp '{meeting.get('title')}'",
                          meeting["id"])
        return {"changed": changed, "learned": True}

    def record_rating(self, meeting: dict, rating: int, comment: str | None = None) -> dict:
        rating = max(1, min(5, int(rating)))
        self.db.add_feedback(meeting["id"], "rating", rating=rating, comment=comment)
        style = self._style()
        ratings = list(style.get("ratings") or [])[-49:] + [rating]
        style["ratings"] = ratings
        self.db.set_pref(STYLE_KEY, style)
        analysis = meeting.get("analysis") or {}
        learned = False
        if rating >= 4 and analysis:
            self._store_example(meeting, analysis, weight=1.0 + (rating - 3) * 0.1, source=f"rating{rating}")
            learned = True
            self.db.log_event("feedback", f"Đánh giá {rating}/5: dùng kết quả cuộc họp '{meeting.get('title')}' làm ví dụ mẫu",
                              meeting["id"])
        elif rating <= 2:
            self.db.delete_memories(meeting["id"], kind="example")
            self.db.log_event("feedback", f"Đánh giá {rating}/5 cho '{meeting.get('title')}': loại khỏi ví dụ mẫu"
                              + (f" - góp ý: {comment}" if comment else ""), meeting["id"])
        return {"rating": rating, "learned": learned}

    # ---------------------------------------------------------------- hints
    def style_hints(self, language: str = "vi") -> list[str]:
        style = self._style()
        hints: list[str] = []
        vi = language.lower().startswith("vi")
        edits = int(style.get("edits", 0))
        items = style.get("avg_summary_items") if edits >= 2 else None
        if items:
            n = max(3, min(10, round(items)))
            hints.append(f"Người dùng thường giữ khoảng {n} ý chính." if vi else f"The user usually keeps about {n} key points.")
        words = style.get("avg_words_per_item") if edits >= 2 else None
        if words:
            w = max(6, min(40, round(words)))
            hints.append(f"Mỗi ý chính dài khoảng {w} từ." if vi else f"Each key point is about {w} words long.")
        branches = style.get("avg_branches") if edits >= 2 else None
        if branches:
            b = max(3, min(8, round(branches)))
            hints.append(f"Mind map nên có khoảng {b} nhánh chính." if vi else f"The mind map should have about {b} main branches.")
        keeps_dec = style.get("keeps_decisions") if edits >= 4 else None
        if keeps_dec is not None and keeps_dec < 0.3:
            hints.append("Người dùng ít quan tâm mục quyết định, chỉ ghi khi thật rõ ràng." if vi
                         else "The user rarely keeps the decisions section; include only explicit decisions.")
        comments = [f["comment"] for f in self.db.list_feedback("rating", limit=20) if f.get("comment")]
        for comment in comments[:3]:
            hints.append((f"Góp ý trước đây của người dùng: {comment}" if vi else f"Earlier user feedback: {comment}"))
        return hints

    def stats(self) -> dict:
        style = self._style()
        ratings = style.get("ratings") or []
        return {
            "edits": style.get("edits", 0),
            "ratings": len(ratings),
            "avg_rating": round(sum(ratings) / len(ratings), 2) if ratings else None,
            "avg_summary_items": style.get("avg_summary_items"),
            "avg_words_per_item": style.get("avg_words_per_item"),
            "avg_branches": style.get("avg_branches"),
        }

    def export_examples(self) -> list[dict]:
        """Xuất cặp (transcript, kết quả đã duyệt) dạng JSONL để fine-tune sau này."""
        rows = []
        for memory in self.db.iter_memories(kinds=["example"]):
            payload = memory.get("payload") or {}
            rows.append({
                "meeting_id": memory.get("meeting_id"),
                "input": memory["text"],
                "output": {k: payload.get(k) for k in ("summary", "decisions", "action_items", "keywords", "mindmap")},
                "weight": memory.get("weight"),
                "source": payload.get("source"),
                "created_at": memory.get("created_at"),
            })
        return rows

    @staticmethod
    def to_jsonl(rows: list[dict]) -> str:
        return "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + ("\n" if rows else "")
