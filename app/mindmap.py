"""Chuẩn hóa và chuyển đổi cấu trúc mind map (cây JSON)."""
from __future__ import annotations

from typing import Any

from .textutil import normalize_ws

MAX_DEPTH = 4
MAX_CHILDREN = 12
MAX_TITLE = 140

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


def normalize_mindmap(raw: Any, root_title: str = "Cuộc họp", depth: int = 0) -> dict | None:
    """Chuyển cấu trúc bất kỳ (từ LLM hoặc người dùng) thành {"title", "children": [...]}."""
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
    if depth < MAX_DEPTH - 1:
        for child in _children_of(raw):
            norm = normalize_mindmap(child, root_title="", depth=depth + 1)
            if not norm:
                continue
            key = norm["title"].lower()
            if key in seen:
                continue
            seen.add(key)
            children.append(norm)
            if len(children) >= MAX_CHILDREN:
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
