"""Chuẩn hóa và chuyển đổi cấu trúc mind map (cây JSON)."""
from __future__ import annotations

from typing import Any

from .textutil import normalize_ws

MAX_DEPTH = 4
MAX_CHILDREN = 12
MAX_TITLE = 140
# Giới hạn cho cây do người dùng tự sửa trên giao diện (chỉ để chặn dữ liệu quá khổ)
USER_MAX_DEPTH = 12
USER_MAX_CHILDREN = 100

_TITLE_KEYS = ("title", "name", "label", "text", "topic", "node")
_CHILD_KEYS = ("children", "nodes", "items", "subtopics", "branches", "sub")


def _title_of(node: Any) -> str:
    if isinstance(node, str):
        return normalize_ws(node)
    if isinstance(node, (int, float)):
        return str(node)
    if isinstance(node, dict):
        for key in _TITLE_KEYS:
            value = node.get(key)
            if isinstance(value, (str, int, float)) and normalize_ws(str(value)):
                return normalize_ws(str(value))
        # dict dạng {"Chủ đề": [...]}
        if len(node) == 1 and not any(k in node for k in _TITLE_KEYS + _CHILD_KEYS):
            return normalize_ws(str(next(iter(node.keys()))))
    return ""


def _children_of(node: Any) -> list:
    if isinstance(node, dict):
        for key in _CHILD_KEYS:
            value = node.get(key)
            if isinstance(value, list):
                return value
            if isinstance(value, dict):
                return [{"title": k, "children": v if isinstance(v, list) else [v]} for k, v in value.items()]
        if len(node) == 1 and not any(k in node for k in _TITLE_KEYS):
            value = next(iter(node.values()))
            if isinstance(value, list):
                return value
            if isinstance(value, dict):
                return [{"title": k, "children": v if isinstance(v, list) else [v]} for k, v in value.items()]
    return []


def normalize_mindmap(raw: Any, root_title: str = "Cuộc họp", depth: int = 0, *, max_depth: int = MAX_DEPTH,
                      max_children: int = MAX_CHILDREN) -> dict | None:
    """Chuyển cấu trúc bất kỳ (từ LLM hoặc người dùng) thành {"title", "children": [...]}.

    Giới hạn mặc định dùng để gọt kết quả LLM; bản người dùng tự sửa truyền giới hạn rộng hơn (USER_MAX_*)."""
    if raw is None:
        return None
    if isinstance(raw, list):
        raw = {"title": root_title, "children": raw}
    title = _title_of(raw) or (root_title if depth == 0 else "")
    if not title:
        return None
    title = title[:MAX_TITLE]
    children: list[dict] = []
    seen: set[str] = set()
    if depth < max_depth - 1:
        for child in _children_of(raw):
            norm = normalize_mindmap(child, root_title="", depth=depth + 1, max_depth=max_depth,
                                     max_children=max_children)
            if not norm:
                continue
            key = norm["title"].lower()
            if key in seen:
                continue
            seen.add(key)
            children.append(norm)
            if len(children) >= max_children:
                break
    return {"title": title, "children": children}


def to_markdown(tree: dict | None) -> str:
    if not tree:
        return ""
    lines = [f"# {tree.get('title', '')}"]

    def walk(node: dict, level: int) -> None:
        for child in node.get("children", []) or []:
            lines.append(f"{'  ' * level}- {child.get('title', '')}")
            walk(child, level + 1)

    walk(tree, 0)
    return "\n".join(lines)


def meeting_markdown(meeting: dict) -> str:
    """Biên bản Markdown của một cuộc họp (bản JavaScript tương ứng: meetingMarkdown trong app/static/engine.js)."""
    analysis = meeting.get("analysis") or {}
    lines = [f"# {meeting['title']}", "", f"- Thời gian: {meeting['created_at']}"]
    if meeting.get("participants"):
        lines.append(f"- Người tham gia: {', '.join(meeting['participants'])}")
    if analysis.get("summary"):   # chưa xử lý thì không in đề mục rỗng
        lines += ["", "## Ý chính"] + [f"- {s}" for s in analysis["summary"]]
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
        lines += ["", "## Sơ đồ tư duy", "", to_markdown(analysis["mindmap"])]
    if meeting.get("transcript"):
        lines += ["", "## Văn bản", "", meeting["transcript"]]
    return "\n".join(lines) + "\n"


def count_nodes(tree: dict | None) -> int:
    if not tree:
        return 0
    return 1 + sum(count_nodes(c) for c in tree.get("children", []) or [])


def flatten_titles(tree: dict | None) -> list[str]:
    if not tree:
        return []
    out = [tree.get("title", "")]
    for child in tree.get("children", []) or []:
        out.extend(flatten_titles(child))
    return out
