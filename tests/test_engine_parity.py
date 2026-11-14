"""Bản JavaScript (app/static/engine.js, chạy trên điện thoại/trình duyệt) và bản Python (máy chủ) của bộ máy tóm tắt
không cần AI phải cho kết quả giống hệt nhau. Mỗi ca được chạy ở cả hai phía rồi so nguyên kết quả."""
import json
import random
import shutil
import subprocess
import unicodedata
from pathlib import Path

import pytest
from samples import SAMPLES
from test_fuzz import PIECES

from app.engine_data import DATA, load_engine_data
from app.heuristic import analyze_heuristic, clean_sentence, find_due, find_owner, make_task, title_for
from app.mindmap import USER_MAX_CHILDREN, USER_MAX_DEPTH, meeting_markdown, normalize_mindmap
from app.textutil import extract_keywords, resolve_language, segment, split_sentences, tokenize, truncate

ROOT = Path(__file__).resolve().parent.parent
CLI = ROOT / "tests" / "js" / "engine_cli.js"
SEED = 20261114

FILLERS = ["à", "ờ", "ừm", "à thì", "dạ", "ok", "rồi", "thì", "là", "nhé", "ạ", "nhé mọi người", "um", "well"]
EXTRA = ["🙂", "👨‍👩‍👧", "…", "?!", " – ", "(", ")", "\"", "“", "”", "’", "TP. HCM", "v.v.", "12,5%", "3.000.000 đồng", "17h30",
         "ngày 5/12/2026", "Q4", "KPI", "A/B", "e-mail", "𝒜𝒷", "ǅ", "İstanbul", "ΑΣ", "ß", "²", "½", "Ⅷ", " ", " ",
         "\x1c", "﻿", "​", "\t", "\n", "\r\n"]


def _sentences() -> list[str]:
    out = []
    for sample in SAMPLES.values():
        out.extend(split_sentences(sample["text"]))
    return out


def _mutate(rng: random.Random, sentence: str) -> str:
    kind = rng.randrange(9)
    if kind == 0:
        return sentence.lower()
    if kind == 1:
        return "".join(ch for ch in sentence if ch not in ".,!?")
    if kind == 2:
        return unicodedata.normalize("NFD", sentence)
    if kind == 3:
        return rng.choice(FILLERS) + " " + sentence
    if kind == 4:
        words = sentence.split(" ")
        words.insert(rng.randrange(len(words) + 1), rng.choice(EXTRA + PIECES))
        return " ".join(words)
    if kind == 5:
        return sentence.rstrip(".") + " " + rng.choice(FILLERS) + "."
    if kind == 6:
        return sentence.upper()
    if kind == 7:
        words = sentence.split(" ")
        i = rng.randrange(len(words))
        return " ".join(words[:i] + [words[i]] + words[i:])   # nói vấp: lặp một từ
    return sentence


def _random_text(rng: random.Random, pool: list[str]) -> str:
    parts = []
    for _ in range(rng.randint(0, 40)):
        if rng.random() < 0.8:
            parts.append(_mutate(rng, rng.choice(pool)))
        else:
            parts.append("".join(rng.choice(PIECES + EXTRA) + rng.choice(["", " "]) for _ in range(rng.randint(1, 8))))
    return rng.choice([" ", " ", "\n", ". ", " "]).join(parts)


def _cases() -> list[dict]:
    rng = random.Random(SEED)
    pool = _sentences()
    cases: list[dict] = []
    names = ["An", "Bình", "Chi", "Tuấn", "Hà", "Phương", "Alice", "Bob", "Minh Quang", "chị Lan", " ", "A.B", "🙂"]
    for sample in SAMPLES.values():
        for language in (sample["language"], "auto"):
            cases.append({"fn": "analyze", "text": sample["text"], "title": sample["title"],
                          "participants": sample["participants"], "language": language})
        cases.append({"fn": "analyze", "text": sample["text"], "title": "", "participants": [], "language": "vi",
                      "style": {"summary_items": 5, "branches": 4}})
        cases.append({"fn": "title", "text": sample["text"], "language": sample["language"]})
        cases.append({"fn": "keywords", "text": sample["text"], "limit": 6, "language": sample["language"]})
    # văn bản rất dài: mọi mẫu nối lại rồi lặp, có và không có dấu câu
    long_text = " ".join(s["text"] for s in SAMPLES.values())
    cases.append({"fn": "analyze", "text": long_text * 3, "title": "Họp dài", "participants": ["Tuấn", "Hà"], "language": "vi"})
    cases.append({"fn": "analyze", "text": long_text.replace(".", "").replace(",", "").lower(), "title": "", "participants": [],
                  "language": "auto"})
    for _ in range(320):
        text = _random_text(rng, pool)
        title = rng.choice(["", "", "Họp tuần", _mutate(rng, rng.choice(pool))[:60]])
        participants = [rng.choice(names) for _ in range(rng.randint(0, 3))]
        style = rng.choice([None, None, {"summary_items": rng.choice([1, 4, 7.5, 50, 0, -1])}, {"branches": rng.choice([1, 3, 5.5, 9])}])
        case = {"fn": "analyze", "text": text, "title": title, "participants": participants,
                "language": rng.choice(["vi", "en", "auto", "", " VI "])}
        if style:
            case["style"] = style
        cases.append(case)
        cases.append({"fn": "sentences", "text": text})
        cases.append({"fn": "title", "text": text, "language": rng.choice(["vi", "en", "auto"])})
    for _ in range(500):
        sentence = _mutate(rng, _mutate(rng, rng.choice(pool)))
        cases.append({"fn": "clean", "text": sentence})
        cases.append({"fn": "due", "text": sentence})
        owner_case = {"fn": "owner", "text": sentence, "participants": [rng.choice(names) for _ in range(rng.randint(0, 2))]}
        cases.append(owner_case)
        cases.append({"fn": "task", "text": sentence, "owner": find_owner(sentence, owner_case["participants"]),
                      "due": find_due(sentence)})
        cases.append({"fn": "tokens", "text": sentence})
        cases.append({"fn": "segment", "text": sentence})
        cases.append({"fn": "truncate", "text": sentence, "limit": rng.choice([0, 1, 5, 10, 40, 70, 500])})
        cases.append({"fn": "language", "text": sentence, "language": rng.choice(["auto", "", "vi-VN", "EN", "fr", " vi\n"])})
    tree = {"title": "Gốc", "children": [{"title": "A", "children": [{"title": "a1"}, "a1", "a2", {"name": " x  y "}]}, "B", "b",
                                           {"label": "C", "items": ["c" * 200, {"text": "🙂" * 150}]}]}
    deep = {"title": "0"}
    node = deep
    for i in range(20):
        node["children"] = [{"title": str(i + 1)}, {"title": f"nhánh {i}"}]
        node = node["children"][0]
    for raw in (tree, deep, ["a", "b", "A"], {"title": "rộng", "children": [{"title": f"n{i}"} for i in range(150)]}, None, "chỉ một chuỗi"):
        cases.append({"fn": "mindmap", "tree": raw, "root": "Cuộc họp"})
        cases.append({"fn": "mindmap", "tree": raw, "root": "Gốc khác", "user": True})
    for sample in SAMPLES.values():
        analysis = analyze_heuristic(sample["text"], sample["title"], sample["participants"], sample["language"])
        for meeting in ({"title": sample["title"] or "Cuộc họp", "created_at": "2026-11-14T08:00:00+00:00",
                         "participants": sample["participants"], "analysis": analysis, "transcript": sample["text"]},
                        {"title": "Chưa xử lý", "created_at": "2026-11-14T08:00:00+00:00", "participants": [], "analysis": None,
                         "transcript": ""}):
            cases.append({"fn": "markdown", "meeting": meeting})
    return cases


def _python(case: dict):
    fn = case["fn"]
    if fn == "analyze":
        return analyze_heuristic(case["text"], case["title"], case["participants"], case["language"], case.get("style"))
    if fn == "title":
        return title_for(case["text"], case["language"])
    if fn == "keywords":
        return extract_keywords(case["text"], case["limit"], case["language"])
    if fn == "sentences":
        return split_sentences(case["text"])
    if fn == "tokens":
        return tokenize(case["text"])
    if fn == "segment":
        words, flags = segment(tokenize(case["text"]))
        return {"words": words, "flags": flags}
    if fn == "clean":
        return clean_sentence(case["text"])
    if fn == "due":
        return find_due(case["text"])
    if fn == "owner":
        return find_owner(case["text"], case["participants"])
    if fn == "task":
        return make_task(case["text"], case["owner"], case["due"])
    if fn == "truncate":
        return truncate(case["text"], case["limit"])
    if fn == "language":
        return resolve_language(case["language"], case["text"])
    if fn == "mindmap":
        if case.get("user"):
            return normalize_mindmap(case["tree"], root_title=case["root"], max_depth=USER_MAX_DEPTH, max_children=USER_MAX_CHILDREN)
        return normalize_mindmap(case["tree"], root_title=case["root"])
    if fn == "markdown":
        return meeting_markdown(case["meeting"])
    raise AssertionError(fn)


@pytest.fixture(scope="module")
def node():
    if shutil.which("node") is None:
        pytest.skip("không có node để chạy bản JavaScript của bộ máy")
    return "node"


def test_data_file_is_shared_and_strict_json():
    data = load_engine_data()
    assert data == DATA and data["version"] >= 1
    for key, value in data.items():
        if isinstance(value, list):
            assert value, key
            assert all(isinstance(item, str) and item == unicodedata.normalize("NFC", item) for item in value), key
            if key != "due_patterns":
                assert all(item == " ".join(item.lower().split()) for item in value), f"{key}: viết thường, một dấu cách"
                assert len(value) == len(set(value)), f"{key}: có mục trùng"
    # mẫu hạn chót phải chạy được ở cả hai máy biểu thức chính quy: không \b, không lookbehind, không \d
    for pattern in data["due_patterns"]:
        assert "\\" not in pattern and "(?<" not in pattern, pattern


def test_javascript_engine_matches_python(node):
    cases = _cases()
    assert len(cases) > 4000
    proc = subprocess.run([node, str(CLI)], input=json.dumps(cases), capture_output=True, text=True, encoding="utf-8", timeout=300)
    assert proc.returncode == 0, proc.stderr[-2000:]
    results = json.loads(proc.stdout)
    assert len(results) == len(cases)
    mismatches = []
    for case, result in zip(cases, results):
        assert "ok" in result, (case, result.get("error"))
        expected = json.loads(json.dumps(_python(case)))   # qua JSON để bộ ba/tuple thành mảng như bên JavaScript
        if result["ok"] != expected:
            mismatches.append((case, expected, result["ok"]))
    if mismatches:
        case, expected, got = mismatches[0]
        detail = json.dumps({"case": case, "python": expected, "javascript": got}, ensure_ascii=False)[:3000]
        pytest.fail(f"{len(mismatches)}/{len(cases)} ca lệch giữa Python và JavaScript. Ca đầu tiên: {detail}")
