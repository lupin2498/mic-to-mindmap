"""Học thuật ngữ/tên riêng: sửa lỗi nhận dạng lặp lại và gợi ý từ nóng cho Whisper."""
from __future__ import annotations

import difflib
import re

from ..db import Database

_TOKEN_RE = re.compile(r"[^\W_]+(?:[-'][^\W_]+)*|[^\w\s]", re.UNICODE)
MAX_SPAN = 4


def _words(text: str) -> list[str]:
    return [m.group(0) for m in _TOKEN_RE.finditer(text or "")]


def _is_wordy(tokens: list[str]) -> bool:
    return bool(tokens) and any(re.search(r"[^\W\d_]", t) for t in tokens)


class Glossary:
    def __init__(self, db: Database, threshold: int = 2):
        self.db = db
        self.threshold = max(1, threshold)

    # ------------------------------------------------------------------ CRUD
    def add(self, term: str, variant: str = "", source: str = "user") -> dict:
        term = " ".join(term.split())
        variant = " ".join(variant.split())
        if not term:
            raise ValueError("Thuật ngữ không được để trống")
        if variant.lower() == term.lower():
            variant = ""
        entry = self.db.upsert_glossary(term, variant, source=source, increment=1)
        if source == "user":
            detail = f"Thêm thuật ngữ '{term}'" + (f" (sửa từ '{variant}')" if variant else "")
            self.db.log_event("glossary", detail)
        return entry

    def remove(self, entry_id: int) -> bool:
        return self.db.delete_glossary(entry_id)

    def entries(self) -> list[dict]:
        rows = self.db.list_glossary()
        for row in rows:
            row["active"] = self._is_active(row)
        return rows

    def _is_active(self, row: dict) -> bool:
        return row["source"] == "user" or int(row["count"]) >= self.threshold

    # ----------------------------------------------------------------- learn
    def learn_from_edit(self, original: str, edited: str) -> list[dict]:
        """So sánh transcript trước/sau khi người dùng sửa, ghi nhận các cặp sai -> đúng."""
        a, b = _words(original), _words(edited)
        if not a or not b or a == b:
            return []
        matcher = difflib.SequenceMatcher(a=[t.lower() for t in a], b=[t.lower() for t in b], autojunk=False)
        learned: list[dict] = []
        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            if tag != "replace":
                continue
            wrong, right = a[i1:i2], b[j1:j2]
            if len(wrong) > MAX_SPAN or len(right) > MAX_SPAN:
                continue
            if not _is_wordy(wrong) or not _is_wordy(right):
                continue
            variant = " ".join(wrong)
            term = " ".join(right)
            if variant.lower() == term.lower():
                continue
            entry = self.db.upsert_glossary(term, variant, source="inferred", increment=1)
            learned.append(entry)
            if int(entry["count"]) == self.threshold and entry["source"] != "user":
                self.db.log_event("glossary", f"Đã học sửa lỗi '{variant}' → '{term}' (thấy {entry['count']} lần, sẽ tự áp dụng)")
        return learned

    # ----------------------------------------------------------------- apply
    def apply(self, text: str) -> tuple[str, int]:
        """Áp dụng các sửa lỗi đã học/đã khai báo vào transcript."""
        if not text:
            return text, 0
        rows = [r for r in self.db.list_glossary() if r["variant"] and self._is_active(r)]
        rows.sort(key=lambda r: -len(r["variant"]))
        applied = 0
        hit_ids: list[int] = []
        for row in rows:
            pattern = re.compile(r"(?<!\w)" + re.escape(row["variant"]) + r"(?!\w)", re.IGNORECASE)
            text, n = pattern.subn(row["term"], text)
            if n:
                applied += n
                hit_ids.append(row["id"])
        self.db.bump_glossary_hits(hit_ids)
        return text, applied

    def hot_words(self, limit: int = 40) -> list[str]:
        seen: set[str] = set()
        words: list[str] = []
        for row in self.db.list_glossary():
            if not self._is_active(row):
                continue
            key = row["term"].lower()
            if key in seen:
                continue
            seen.add(key)
            words.append(row["term"])
            if len(words) >= limit:
                break
        return words

    def stats(self) -> dict:
        rows = self.db.list_glossary()
        return {
            "total": len(rows),
            "user": sum(1 for r in rows if r["source"] == "user"),
            "inferred": sum(1 for r in rows if r["source"] != "user"),
            "active": sum(1 for r in rows if self._is_active(r)),
            "hits": sum(int(r["hits"]) for r in rows),
        }
