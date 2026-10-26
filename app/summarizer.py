"""Phân tích transcript: dùng LLM local (Ollama) có bối cảnh đã học, dự phòng bằng heuristic."""
from __future__ import annotations

import json
import logging

from .heuristic import analyze_heuristic
from .llm import OllamaClient
from .mindmap import normalize_mindmap
from .textutil import normalize_ws, split_sentences

log = logging.getLogger(__name__)

MAX_DIRECT_CHARS = 12_000
CHUNK_CHARS = 9_000

PROMPTS = {
    "vi": {
        "system": (
            "Bạn là thư ký cuộc họp chuyên nghiệp. Bạn đọc transcript (có thể chứa lỗi nhận dạng giọng nói) "
            "và trả về kết quả bằng tiếng Việt dưới dạng JSON hợp lệ, không thêm lời dẫn."
        ),
        "task": (
            "Hãy phân tích transcript và trả về JSON với đúng các khóa sau:\n"
            '- "summary": mảng 3-8 ý chính, mỗi ý là một câu ngắn gọn, đủ nghĩa.\n'
            '- "decisions": mảng các quyết định đã được chốt (có thể rỗng).\n'
            '- "action_items": mảng các việc cần làm, mỗi phần tử {"task": "...", "owner": "...", "due": "..."} '
            '(owner/due để chuỗi rỗng nếu không rõ).\n'
            '- "keywords": mảng 5-10 từ khóa/chủ đề.\n'
            '- "mindmap": cây {"title": "<chủ đề cuộc họp>", "children": [{"title": "...", "children": [...]}]} '
            "có 3-6 nhánh chính, mỗi nhánh 2-5 nhánh con, tối đa 3 cấp, tiêu đề nút ngắn (dưới 12 từ).\n"
            "Chỉ dùng thông tin có trong transcript; không bịa đặt."
        ),
        "notes_task": (
            "Đây là một phần của transcript dài. Hãy liệt kê các ý chính, quyết định và việc cần làm trong phần này "
            'dưới dạng JSON {"notes": ["...", "..."]} (8-15 ghi chú ngắn, giữ nguyên tên riêng và con số).'
        ),
        "glossary": "Thuật ngữ, tên riêng cần viết đúng (ưu tiên dùng đúng các từ này):",
        "past": "Bối cảnh từ các cuộc họp trước có liên quan (dùng để hiểu mạch, KHÔNG đưa vào kết quả nếu transcript không nhắc tới):",
        "examples": "Ví dụ về phong cách tóm tắt mà người dùng đã duyệt (hãy bắt chước cách viết, độ dài, mức chi tiết):",
        "style": "Sở thích trình bày của người dùng:",
        "title": "Tiêu đề cuộc họp",
        "participants": "Người tham gia",
        "transcript": "Transcript",
        "condensed": "Ghi chú rút gọn từ transcript dài",
        "ask_system": (
            "Bạn là trợ lý trí nhớ cuộc họp. Trả lời câu hỏi CHỈ dựa trên các trích đoạn được cung cấp, bằng tiếng Việt, "
            "ngắn gọn. Nếu không có thông tin thì nói rõ là không tìm thấy."
        ),
    },
    "en": {
        "system": (
            "You are a professional meeting secretary. You read a transcript (which may contain speech recognition "
            "errors) and return the result in English as valid JSON, with no preamble."
        ),
        "task": (
            "Analyze the transcript and return JSON with exactly these keys:\n"
            '- "summary": array of 3-8 key points, each a short complete sentence.\n'
            '- "decisions": array of decisions that were made (may be empty).\n'
            '- "action_items": array of {"task": "...", "owner": "...", "due": "..."} (empty strings when unknown).\n'
            '- "keywords": array of 5-10 keywords/topics.\n'
            '- "mindmap": tree {"title": "<meeting topic>", "children": [{"title": "...", "children": [...]}]} '
            "with 3-6 main branches, 2-5 children each, at most 3 levels, short node titles (under 12 words).\n"
            "Use only information from the transcript; do not invent facts."
        ),
        "notes_task": (
            "This is one part of a long transcript. List the key points, decisions and action items of this part as "
            'JSON {"notes": ["...", "..."]} (8-15 short notes, keep names and numbers).'
        ),
        "glossary": "Terms and proper nouns to spell correctly (prefer these spellings):",
        "past": "Context from related earlier meetings (for understanding only; do NOT add to the output unless the transcript mentions it):",
        "examples": "Examples of summaries the user approved (imitate the style, length and level of detail):",
        "style": "User presentation preferences:",
        "title": "Meeting title",
        "participants": "Participants",
        "transcript": "Transcript",
        "condensed": "Condensed notes from a long transcript",
        "ask_system": (
            "You are a meeting memory assistant. Answer ONLY from the provided excerpts, briefly. "
            "If the information is missing, say so."
        ),
    },
}


def prompts_for(language: str) -> dict:
    return PROMPTS["vi"] if (language or "vi").lower().startswith("vi") else PROMPTS["en"]


def _chunks(text: str, max_chars: int = CHUNK_CHARS) -> list[str]:
    chunks: list[str] = []
    current = ""
    for sentence in split_sentences(text, max_tokens=10_000):
        if len(current) + len(sentence) + 1 > max_chars and current:
            chunks.append(current.strip())
            current = ""
        current += " " + sentence
    if current.strip():
        chunks.append(current.strip())
    return chunks


def _as_str_list(value, limit: int = 12, max_len: int = 400) -> list[str]:
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        if isinstance(item, dict):
            item = item.get("text") or item.get("title") or item.get("task") or ""
        text = normalize_ws(str(item))
        if text and text not in out:
            out.append(text[:max_len])
        if len(out) >= limit:
            break
    return out


def _as_action_items(value, limit: int = 15) -> list[dict]:
    if not isinstance(value, list):
        return []
    items: list[dict] = []
    for item in value:
        if isinstance(item, str):
            item = {"task": item}
        if not isinstance(item, dict):
            continue
        task = normalize_ws(str(item.get("task") or item.get("title") or item.get("text") or ""))
        if not task:
            continue
        owner = item.get("owner") or item.get("assignee") or ""
        due = item.get("due") or item.get("deadline") or item.get("due_date") or ""
        items.append({"task": task[:300], "owner": normalize_ws(str(owner))[:80], "due": normalize_ws(str(due))[:80]})
        if len(items) >= limit:
            break
    return items


def merge_llm_result(data: dict | None, fallback: dict, title: str) -> dict:
    """Ghép kết quả LLM với kết quả heuristic: trường nào LLM trả về hợp lệ thì dùng, còn lại dự phòng."""
    result = dict(fallback)
    if not data:
        return result
    summary = _as_str_list(data.get("summary") or data.get("key_points"))
    if summary:
        result["summary"] = summary
    decisions = _as_str_list(data.get("decisions"))
    if "decisions" in data:
        result["decisions"] = decisions
    actions = _as_action_items(data.get("action_items") or data.get("actions"))
    if "action_items" in data or "actions" in data:
        result["action_items"] = actions
    keywords = _as_str_list(data.get("keywords") or data.get("topics"), limit=12, max_len=60)
    if keywords:
        result["keywords"] = keywords
    mindmap = normalize_mindmap(data.get("mindmap") or data.get("mind_map"), root_title=title or "Cuộc họp")
    if mindmap and mindmap.get("children"):
        result["mindmap"] = mindmap
    return result


class Analyzer:
    def __init__(self, ollama: OllamaClient):
        self.ollama = ollama

    def engine_name(self) -> str:
        return f"ollama:{self.ollama.model}" if self.ollama.chat_available() else "heuristic"

    # ---------------------------------------------------------------- prompt
    @staticmethod
    def build_prompt(transcript: str, title: str, participants: list[str], language: str,
                     context: dict | None, condensed: bool = False) -> str:
        p = prompts_for(language)
        context = context or {}
        parts: list[str] = [f"{p['title']}: {title or '(không có)'}"]
        if participants:
            parts.append(f"{p['participants']}: {', '.join(participants)}")
        if context.get("glossary_terms"):
            parts.append(f"{p['glossary']}\n" + ", ".join(context["glossary_terms"]))
        if context.get("past_meetings"):
            lines = []
            for m in context["past_meetings"]:
                bullets = "; ".join(m.get("summary") or [])
                lines.append(f"- [{m.get('date', '')}] {m.get('title', '')}: {bullets}")
            parts.append(f"{p['past']}\n" + "\n".join(lines))
        if context.get("examples"):
            blocks = []
            for ex in context["examples"]:
                blocks.append(
                    "Transcript (trích): " + ex["input"][:800] + "\nKết quả đã duyệt: "
                    + json.dumps(ex["output"], ensure_ascii=False)[:1500]
                )
            parts.append(f"{p['examples']}\n" + "\n---\n".join(blocks))
        if context.get("style_hints"):
            parts.append(f"{p['style']}\n" + "\n".join(f"- {h}" for h in context["style_hints"]))
        label = p["condensed"] if condensed else p["transcript"]
        parts.append(f'{label}:\n"""\n{transcript}\n"""')
        parts.append(p["task"])
        return "\n\n".join(parts)

    def _condense(self, transcript: str, language: str) -> str | None:
        p = prompts_for(language)
        notes: list[str] = []
        for index, chunk in enumerate(_chunks(transcript)):
            data = self.ollama.chat_json(p["system"], f"{p['notes_task']}\n\nPhần {index + 1}:\n\"\"\"\n{chunk}\n\"\"\"")
            chunk_notes = _as_str_list((data or {}).get("notes"), limit=20) if data else []
            if not chunk_notes:
                return None
            notes.extend(chunk_notes)
        return "\n".join(f"- {n}" for n in notes)

    # --------------------------------------------------------------- analyze
    def analyze(self, transcript: str, title: str = "", participants: list[str] | None = None,
                language: str = "vi", context: dict | None = None) -> dict:
        participants = participants or []
        fallback = analyze_heuristic(transcript, title, participants, language)
        if not self.ollama.chat_available():
            fallback["engine"] = "heuristic"
            return fallback
        p = prompts_for(language)
        text = transcript
        condensed = False
        if len(transcript) > MAX_DIRECT_CHARS:
            notes = self._condense(transcript, language)
            if notes:
                text, condensed = notes, True
            else:
                text = transcript[:MAX_DIRECT_CHARS]
        prompt = self.build_prompt(text, title, participants, language, context, condensed=condensed)
        data = self.ollama.chat_json(p["system"], prompt)
        if not data:
            log.warning("LLM không trả về kết quả hợp lệ, dùng heuristic")
            fallback["engine"] = "heuristic (LLM lỗi)"
            return fallback
        result = merge_llm_result(data, fallback, title)
        result["engine"] = f"ollama:{self.ollama.model}"
        return result

    # ------------------------------------------------------------------- ask
    def answer(self, question: str, snippets: list[dict], language: str = "vi") -> str | None:
        if not self.ollama.chat_available() or not snippets:
            return None
        p = prompts_for(language)
        lines = []
        for i, s in enumerate(snippets, 1):
            payload = s.get("payload") or {}
            lines.append(f"[{i}] ({(payload.get('date') or '')[:10]} - {payload.get('title', '')}) {s['text'][:900]}")
        user = "Trích đoạn:\n" + "\n\n".join(lines) + f"\n\nCâu hỏi: {question}"
        return self.ollama.chat(p["ask_system"], user, temperature=0.1)
