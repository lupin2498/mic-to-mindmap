"""Bộ phân tích dự phòng không cần LLM: tóm tắt trích xuất, quyết định, việc cần làm, mind map."""
from __future__ import annotations

import re

from .mindmap import normalize_mindmap
from .textutil import (
    capitalize_first,
    contains_phrase,
    extract_keywords,
    nfc,
    normalize_ws,
    score_sentences,
    split_sentences,
    tokenize,
    truncate,
)

DECISION_CUES = [
    "quyết định", "thống nhất", "chốt", "đồng ý", "phê duyệt", "kết luận", "nhất trí", "duyệt",
    "agreed", "agree", "decided", "decision", "approved", "concluded", "finalized", "sign off", "signed off",
]
ACTION_CUES = [
    "cần", "phải", "sẽ", "giao", "phụ trách", "đảm nhận", "hoàn thành", "deadline", "hạn chót", "trước ngày",
    "trước thứ", "tuần sau", "tuần tới", "gửi", "chuẩn bị", "liên hệ", "triển khai", "theo dõi", "báo cáo",
    "todo", "to do", "action", "will", "should", "must", "need to", "needs to", "by friday", "by monday",
    "next week", "follow up", "prepare", "send", "deliver", "schedule",
]
DUE_PATTERNS = [
    r"\b\d{1,2}/\d{1,2}(?:/\d{2,4})?\b",
    r"\bngày \d{1,2}(?:/\d{1,2}(?:/\d{2,4})?|(?: tháng \d{1,2})?(?: năm \d{4})?)\b",
    r"\b(?:trước |vào |đến )?(?:thứ (?:hai|ba|tư|năm|sáu|bảy|[2-7])|chủ nhật)(?: tuần (?:sau|tới|này))?\b",
    r"\b(?:ngày mai|ngày kia|hôm nay|tuần sau|tuần tới|tuần này|cuối tuần|cuối tháng|đầu tháng|cuối quý|cuối năm)\b",
    r"\b(?:tháng \d{1,2}|quý [1-4])\b",
    r"\b(?:by |on |before |until )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b",
    r"\b(?:tomorrow|today|next week|this week|end of (?:week|month|day|quarter)|eod|eow|q[1-4])\b",
]
_DUE_RE = re.compile("|".join(DUE_PATTERNS), re.IGNORECASE)


def _dedupe(items: list, key=lambda item: item) -> list:
    seen: set[str] = set()
    out = []
    for item in items:
        k = normalize_ws(str(key(item))).lower()
        if not k or k in seen:
            continue
        seen.add(k)
        out.append(item)
    return out


def _has_cue(sentence: str, cues: list[str]) -> bool:
    lowered = f" {sentence.lower()} "
    return any(f" {cue} " in lowered or lowered.strip().startswith(cue) for cue in cues)


def find_due(sentence: str) -> str:
    match = _DUE_RE.search(sentence)
    return match.group(0).strip() if match else ""


def find_owner(sentence: str, participants: list[str]) -> str:
    for name in participants:
        name = name.strip()
        if name and re.search(r"(?<!\w)" + re.escape(name) + r"(?!\w)", sentence, re.IGNORECASE):
            return name
    # Tên riêng viết hoa đứng đầu mệnh đề (vd: "An sẽ ...")
    match = re.match(r"^\s*(?:anh|chị|em|bạn|mr\.?|ms\.?)?\s*([A-ZÀ-Ỹ][\wÀ-ỹ]+(?:\s[A-ZÀ-Ỹ][\wÀ-ỹ]+){0,2})\s+(?:sẽ|cần|phải|phụ trách|đảm nhận|will|should|must|to)\b",
                     sentence)
    if match:
        return match.group(1)
    return ""


def extract_decisions(sentences: list[str], limit: int = 6) -> list[str]:
    found = [capitalize_first(s) for s in sentences if _has_cue(s, DECISION_CUES)]
    return _dedupe([truncate(s, 160) for s in found])[:limit]


def extract_action_items(sentences: list[str], participants: list[str], limit: int = 8) -> list[dict]:
    items: list[dict] = []
    for sentence in sentences:
        if not _has_cue(sentence, ACTION_CUES):
            continue
        if len(tokenize(sentence)) < 4:
            continue
        items.append({
            "task": truncate(capitalize_first(sentence), 160),
            "owner": find_owner(sentence, participants),
            "due": find_due(sentence),
        })
    items.sort(key=lambda it: (-(bool(it["owner"]) + bool(it["due"]))))
    return _dedupe(items, key=lambda it: it["task"])[:limit]


def build_mindmap(title: str, keywords: list[str], sentences: list[str], decisions: list[str],
                  action_items: list[dict], max_branches: int = 6) -> dict:
    used: set[int] = set()
    branches: list[dict] = []
    for keyword in keywords[:max_branches]:
        leaves: list[dict] = []
        for idx, sentence in enumerate(sentences):
            if idx in used or not contains_phrase(sentence, keyword):
                continue
            leaves.append({"title": truncate(capitalize_first(sentence), 70), "children": []})
            used.add(idx)
            if len(leaves) >= 3:
                break
        if leaves:
            branches.append({"title": capitalize_first(keyword), "children": leaves})
    if decisions:
        branches.append({"title": "Quyết định", "children": [{"title": truncate(d, 70), "children": []} for d in decisions[:4]]})
    if action_items:
        leaves = []
        for item in action_items[:5]:
            meta = ", ".join(x for x in (item.get("owner"), item.get("due")) if x)
            label = truncate(item["task"], 60) + (f" ({meta})" if meta else "")
            leaves.append({"title": label, "children": []})
        branches.append({"title": "Việc cần làm", "children": leaves})
    return normalize_mindmap({"title": title or "Cuộc họp", "children": branches}, root_title=title or "Cuộc họp")


def analyze_heuristic(transcript: str, title: str = "", participants: list[str] | None = None,
                      language: str = "vi") -> dict:
    participants = participants or []
    transcript = nfc(transcript)
    sentences = split_sentences(transcript)
    keywords = extract_keywords(transcript, limit=10, language=language)
    scored = score_sentences(sentences, transcript)
    limit = max(3, min(8, len(sentences) // 6 + 2))
    best = sorted(scored, key=lambda item: -item[1])[:limit]
    best.sort(key=lambda item: item[0])
    summary = _dedupe([truncate(capitalize_first(s), 180) for _, _, s in best])
    decisions = extract_decisions(sentences)
    action_items = extract_action_items(sentences, participants)
    mindmap = build_mindmap(title or ("Cuộc họp" if language == "vi" else "Meeting"), keywords, sentences,
                            decisions, action_items)
    return {
        "summary": summary,
        "decisions": decisions,
        "action_items": action_items,
        "keywords": keywords,
        "mindmap": mindmap,
        "engine": "heuristic",
    }
