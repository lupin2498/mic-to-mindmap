"""Gom bối cảnh đã học để đưa vào prompt: thuật ngữ, cuộc họp liên quan, ví dụ mẫu, phong cách."""
from __future__ import annotations

from .feedback import FeedbackLearner
from .glossary import Glossary
from .memory import MemoryStore


def build_context(transcript: str, title: str, *, memory: MemoryStore, glossary: Glossary,
                  feedback: FeedbackLearner, exclude_meeting_id: str | None = None,
                  language: str = "vi") -> dict:
    query = f"{title}\n{transcript[:2000]}"
    past = memory.search(query, kinds=["meeting"], k=3, exclude_meeting=exclude_meeting_id, min_score=0.05)
    examples = memory.search(transcript[:2500], kinds=["example"], k=2, exclude_meeting=exclude_meeting_id,
                             min_score=0.03)
    return {
        "glossary_terms": glossary.hot_words(limit=40),
        "past_meetings": [
            {
                "title": (m.get("payload") or {}).get("title") or "",
                "date": ((m.get("payload") or {}).get("date") or "")[:10],
                "summary": ((m.get("payload") or {}).get("summary") or [])[:5],
                "decisions": ((m.get("payload") or {}).get("decisions") or [])[:3],
                "score": m["score"],
            }
            for m in past
        ],
        "examples": [
            {"input": m["text"][:1500], "output": {k: (m.get("payload") or {}).get(k) for k in
                                                   ("summary", "decisions", "action_items", "keywords")},
             "score": m["score"]}
            for m in examples
        ],
        "style_hints": feedback.style_hints(language),
    }


def context_summary(context: dict) -> dict:
    return {
        "glossary_terms": len(context.get("glossary_terms", [])),
        "past_meetings": len(context.get("past_meetings", [])),
        "examples": len(context.get("examples", [])),
        "style_hints": len(context.get("style_hints", [])),
    }
