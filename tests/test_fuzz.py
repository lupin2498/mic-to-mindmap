"""Fuzz với hạt giống cố định: dữ liệu vào bất kỳ không được làm sập lõi phân tích hay API (không có 500)."""
import json
import random
import unicodedata

from app.heuristic import analyze_heuristic
from app.learning.glossary import Glossary
from app.llm import extract_json
from app.mindmap import MAX_CHILDREN, MAX_DEPTH, MAX_TITLE, normalize_mindmap, to_markdown
from app.textutil import extract_keywords, split_sentences

SEED = 20261113
PIECES = [
    "họp", "kế hoạch", "ngân sách", "An sẽ", "cần", "chốt", "thống nhất", "trước thứ sáu", "tháng 10", "năm 2026",
    "phòng 301", "500 triệu", "deadline", "will", "agreed", "by Friday", ".", ",", "!", "?", "…", "\n", "\n\n", "\t",
    " ", "  ", "🙂", "👨‍👩‍👧", "‏", "‮", "﻿", "\x00", "\x07", "а", "е", "null", "NaN", "<b>", "'; --", "%", "_", "\\1", "C:\\new", "\\g<0>", "$1", "(", "[a-",
    unicodedata.normalize("NFD", "Nguyễn Thị Hồng"), "ạ" * 3, "A" * 300, "１２３", "١٢٣", "\ud83d".encode("utf-16", "surrogatepass").decode("utf-16", "ignore"),
]


def _text(rng: random.Random, max_parts: int = 120) -> str:
    return "".join(rng.choice(PIECES) + rng.choice(["", " ", " "]) for _ in range(rng.randint(0, max_parts)))


def _junk(rng: random.Random, depth: int = 0):
    kinds = ["str", "int", "float", "none", "bool", "list", "dict"] if depth < 6 else ["str", "int", "none"]
    kind = rng.choice(kinds)
    if kind == "str":
        return _text(rng, 6)
    if kind == "int":
        return rng.randint(-5, 10**9)
    if kind == "float":
        return rng.choice([0.0, -1.5, 1e308])
    if kind == "none":
        return None
    if kind == "bool":
        return rng.random() < 0.5
    if kind == "list":
        return [_junk(rng, depth + 1) for _ in range(rng.randint(0, 15))]
    keys = ["title", "name", "children", "nodes", "items", "text", "task", "owner", "due", "sub", _text(rng, 2)]
    return {rng.choice(keys): _junk(rng, depth + 1) for _ in range(rng.randint(0, 5))}


def _check_tree(tree, depth=0):
    assert isinstance(tree["title"], str) and 0 < len(tree["title"]) <= MAX_TITLE
    assert depth < MAX_DEPTH and len(tree["children"]) <= MAX_CHILDREN
    for child in tree["children"]:
        _check_tree(child, depth + 1)


def test_fuzz_core_text_functions():
    rng = random.Random(SEED)
    runs = 0
    for _ in range(300):
        text = _text(rng)
        for language in ("vi", "en", "auto"):
            result = analyze_heuristic(text, _text(rng, 3), [_text(rng, 2) for _ in range(rng.randint(0, 3))], language)
            json.dumps(result)  # phải tuần tự hóa được
            assert len(result["summary"]) <= 12 and len(result["action_items"]) <= 12 and len(result["keywords"]) <= 10
            assert len(result["decisions"]) <= 6
            assert all(len(s) <= 181 for s in result["summary"])
            assert all(0 < len(i["task"]) <= 161 and isinstance(i["owner"], str) and isinstance(i["due"], str)
                       for i in result["action_items"])
            _check_tree(result["mindmap"])
            assert to_markdown(result["mindmap"]).startswith("# ")
            runs += 1
        assert all(s.strip() for s in split_sentences(text))
        assert len(extract_keywords(text, limit=5)) <= 5
    assert runs == 900


def test_fuzz_mindmap_and_json_parsers():
    rng = random.Random(SEED + 1)
    normalized = 0
    for _ in range(1500):
        raw = _junk(rng)
        tree = normalize_mindmap(raw, root_title="Gốc")
        if tree is not None:
            _check_tree(tree)
            assert normalize_mindmap(tree, root_title="Gốc") == tree  # chuẩn hóa hai lần cho cùng kết quả
            normalized += 1
        blob = json.dumps(raw, ensure_ascii=False)
        cut = blob[: rng.randint(0, len(blob))]
        for candidate in (blob, cut, "```json\n" + blob + "\n```", "lời dẫn " + blob + " hết", cut + "}"):
            parsed = extract_json(candidate)
            assert parsed is None or isinstance(parsed, dict)
    assert normalized > 300
    # cây rất sâu và rất rộng không gây tràn ngăn xếp, bị cắt đúng giới hạn
    deep = {"title": "0"}
    node = deep
    for i in range(5000):
        node["children"] = [{"title": str(i + 1)}]
        node = node["children"][0]
    _check_tree(normalize_mindmap(deep))
    _check_tree(normalize_mindmap({"title": "rộng", "children": [{"title": str(i)} for i in range(10000)]}))


def test_fuzz_glossary_learn_and_apply(db):
    rng = random.Random(SEED + 2)
    glossary = Glossary(db, threshold=1)
    for _ in range(200):
        a, b = _text(rng, 30), _text(rng, 30)
        for entry in glossary.learn_from_edit(a, b):
            assert entry["term"].strip() and entry["variant"].strip()
            assert entry["term"].lower() != entry["variant"].lower()
        # thuật ngữ người dùng tự thêm: ký tự bất kỳ, kể cả thứ trông như mã thoát của biểu thức chính quy
        term = (rng.choice(["", "\\1", "a\\Tb", "\\g<9>", "$&"]) + _text(rng, 2))[:120]
        variant = " ".join(_text(rng, 2).split())[:100] or f"dạng sai {rng.randint(0, 5)}"
        if " ".join(term.split()):
            glossary.add(term, variant)
        out, applied = glossary.apply(f"{a} {variant} {a}")  # văn bản chắc chắn chứa dạng sai vừa thêm
        assert isinstance(out, str) and applied >= 0
    assert glossary.learn_from_edit("giống hệt nhau", "giống hệt nhau") == []


def test_fuzz_api_never_returns_500(client):
    rng = random.Random(SEED + 3)
    statuses: dict[int, int] = {}

    def hit(method, url, **kwargs):
        resp = client.request(method, url, **kwargs)
        statuses[resp.status_code] = statuses.get(resp.status_code, 0) + 1
        assert resp.status_code < 500, (method, url, kwargs, resp.text[:300])
        return resp

    for i in range(60):
        resp = hit("POST", "/api/meetings", json={"title": _text(rng, 4)[:200], "participants": [_text(rng, 2) for _ in range(rng.randint(0, 4))],
                                                    "language": rng.choice(["vi", "en", "auto", "", None, "AUTO ", "xx-YY", "🙂"])})
        mid = resp.json()["id"]
        hit("PUT", f"/api/meetings/{mid}/transcript", json={"transcript": _text(rng), "reanalyze": rng.random() < 0.5})
        hit("POST", f"/api/meetings/{mid}/process", json={"transcribe": rng.random() < 0.5, "force_transcribe": rng.random() < 0.2})
        hit("PUT", f"/api/meetings/{mid}/analysis", json={"summary": [_text(rng, 5) for _ in range(rng.randint(0, 4))],
                                                           "action_items": [j for j in (_junk(rng) for _ in range(3)) if isinstance(j, dict)],
                                                           "keywords": [_text(rng, 2)], "mindmap": _junk(rng)})
        hit("PUT", f"/api/meetings/{mid}/analysis", json=_junk(rng) if rng.random() < 0.5 else {"mindmap": _junk(rng)})
        hit("POST", f"/api/meetings/{mid}/rating", json={"rating": rng.randint(-1, 7), "comment": _text(rng, 5)[:1000]})
        hit("PATCH", f"/api/meetings/{mid}", json={"title": _text(rng, 3)[:200], "language": rng.choice([None, "", "en"])})
        hit("POST", "/api/glossary", json={"term": _text(rng, 2)[:120], "variant": _text(rng, 2)[:120]})
        hit("POST", "/api/learning/ask", json={"question": _text(rng, 6)[:1000]})
        hit("GET", "/api/learning/search", params={"q": _text(rng, 4), "k": rng.randint(-3, 50)})
        hit("GET", "/api/meetings", params={"q": _text(rng, 2)})
        hit("GET", f"/api/meetings/{mid}")
        hit("GET", f"/api/meetings/{mid}/export.md")
        if i % 7 == 0:
            hit("DELETE", f"/api/meetings/{mid}")
    for url in ("/api/learning/stats", "/api/learning/events?limit=-5", "/api/learning/export", "/api/glossary", "/api/health"):
        hit("GET", url)
    hit("POST", "/api/learning/reindex")
    assert statuses.get(200, 0) > 300, statuses
