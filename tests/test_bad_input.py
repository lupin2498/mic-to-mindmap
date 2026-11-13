"""Dữ liệu vào hỏng ở tầng JSON thô: nửa emoji (surrogate lẻ), lồng quá sâu, số quá cỡ.

Các test này gửi byte JSON thô vì thư viện client không tự gửi được chuỗi chứa surrogate lẻ,
trong khi trình duyệt thì gửi được (JSON.stringify của chuỗi bị cắt giữa một emoji ra "\\ud83d").
"""
import json

from app.llm import OllamaClient, extract_json
from app.summarizer import Analyzer

from tests.conftest import VI_TRANSCRIPT
from tests.fakes import FakeOllama

JSON_HEADERS = {"content-type": "application/json"}
HALF = "\\ud83d"  # nửa đầu của một emoji, viết dưới dạng mã thoát JSON


def _raw(client, method, url, body: str):
    return client.request(method, url, content=body.encode("ascii"), headers=JSON_HEADERS)


def test_half_emoji_in_json_is_replaced_instead_of_500(client):
    resp = _raw(client, "POST", "/api/meetings", '{"title": "Hop %s", "participants": ["An %s"]}' % (HALF, HALF))
    assert resp.status_code == 201, resp.text
    meeting = resp.json()
    mid = meeting["id"]
    assert meeting["title"] == "Hop �" and meeting["participants"] == ["An �"]

    resp = _raw(client, "PUT", f"/api/meetings/{mid}/transcript", '{"transcript": "An se gui bao cao %s. Binh can chot ngan sach."}' % HALF)
    assert resp.status_code == 200, resp.text
    assert "�" in resp.json()["transcript"]
    assert client.post(f"/api/meetings/{mid}/process", json={"transcribe": False}).status_code == 202

    resp = _raw(client, "PUT", f"/api/meetings/{mid}/analysis",
                '{"summary": ["y %s"], "action_items": [{"task": "viec %s", "owner": "%s"}],'
                ' "mindmap": {"title": "goc %s", "children": [{"title": "nhanh \\udc00"}]}}' % (HALF, HALF, HALF, HALF))
    assert resp.status_code == 200, resp.text
    analysis = resp.json()["analysis"]
    assert analysis["summary"] == ["y �"] and analysis["mindmap"]["children"][0]["title"] == "nhanh �"

    assert _raw(client, "POST", f"/api/meetings/{mid}/rating", '{"rating": 2, "comment": "te %s"}' % HALF).status_code == 200
    assert _raw(client, "POST", "/api/glossary", '{"term": "Ollama%s", "variant": "o la ma"}' % HALF).status_code == 201
    assert _raw(client, "POST", "/api/learning/ask", '{"question": "ngan sach %s?"}' % HALF).status_code == 200
    assert _raw(client, "PATCH", f"/api/meetings/{mid}", '{"title": "Doi ten %s"}' % HALF).status_code == 200

    # mọi thứ đã lưu vẫn đọc lại và xuất ra được
    for url in ("/api/meetings", f"/api/meetings/{mid}", f"/api/meetings/{mid}/export.md", "/api/learning/stats",
                "/api/learning/events", "/api/glossary", "/api/learning/export"):
        assert client.get(url).status_code == 200, url


def test_validation_error_with_half_emoji_is_422_not_500(client):
    resp = _raw(client, "POST", "/api/meetings", '{"title": "%s", "participants": 5}' % HALF)
    assert resp.status_code == 422, resp.text
    resp = _raw(client, "POST", "/api/glossary", '"%s"' % HALF)
    assert resp.status_code == 422, resp.text


def test_deeply_nested_json_does_not_crash(client):
    mid = client.post("/api/meetings", json={"title": "Sâu"}).json()["id"]
    client.put(f"/api/meetings/{mid}/transcript", json={"transcript": VI_TRANSCRIPT})
    client.post(f"/api/meetings/{mid}/process", json={"transcribe": False})
    for depth in (300, 3000):
        body = '{"mindmap": ' + '{"title": "n", "children": [' * depth + '{"title": "la"}' + "]}" * depth + "}"
        resp = _raw(client, "PUT", f"/api/meetings/{mid}/analysis", body)
        assert resp.status_code < 500, (depth, resp.text[:200])
    assert client.get(f"/api/meetings/{mid}").status_code == 200
    # cây hợp lệ 12 cấp của người dùng vẫn được giữ đủ
    tree = {"title": "c11", "children": []}
    for level in range(10, -1, -1):
        tree = {"title": f"c{level}", "children": [tree]}
    saved = client.put(f"/api/meetings/{mid}/analysis", json={"mindmap": tree}).json()["analysis"]["mindmap"]
    levels = 0
    while saved:
        levels += 1
        saved = saved["children"][0] if saved["children"] else None
    assert levels == 12


def test_llm_reply_with_half_emoji_or_deep_nesting_is_cleaned():
    assert extract_json('{"summary": ["tốt %s"]}' % HALF) == {"summary": ["tốt �"]}
    assert extract_json('{"a": ' + "[" * 500 + "]" * 500 + "}") is not None
    server = FakeOllama(chat_reply='{"summary": ["Ý chính %s"], "keywords": ["k%s"]}' % (HALF, HALF))
    try:
        client = OllamaClient(server.url, "qwen2.5:7b", "nomic-embed-text", timeout=5)
        result = Analyzer(client).analyze(VI_TRANSCRIPT, "Họp", [], "vi", None)
        assert result["engine"] == "ollama:qwen2.5:7b" and result["summary"] == ["Ý chính �"]
        json.dumps(result, ensure_ascii=False).encode("utf-8")  # lưu được vào CSDL
    finally:
        server.close()


def test_llm_text_answer_with_half_emoji_does_not_break_ask(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from app.config import Settings
    from app.main import create_app

    server = FakeOllama(chat_reply={"summary": ["Ngân sách 500 triệu"]})
    try:
        monkeypatch.setenv("OLLAMA_URL", server.url)
        client = TestClient(create_app(Settings(data_dir=tmp_path / "data", sync_jobs=True, disable_whisper=True)))
        mid = client.post("/api/meetings", json={"title": "Họp"}).json()["id"]
        client.put(f"/api/meetings/{mid}/transcript", json={"transcript": VI_TRANSCRIPT})
        client.post(f"/api/meetings/{mid}/process", json={"transcribe": False})
        # Ollama gửi mã thoát surrogate lẻ ngay trong JSON bao ngoài của câu trả lời dạng văn bản
        server.raw_chat_body = '{"message": {"role": "assistant", "content": "Tra loi %s"}, "done": true}' % HALF
        resp = client.post("/api/learning/ask", json={"question": "ngân sách chiến dịch bao nhiêu?"})
        assert resp.status_code == 200, resp.text
        assert resp.json()["answer"] == "Tra loi �"
    finally:
        server.close()


def test_out_of_range_numbers_are_rejected_cleanly(client):
    assert client.delete("/api/glossary/99999999999999999999999").status_code == 404
    assert client.delete("/api/glossary/-1").status_code == 404
    mid = client.post("/api/meetings", json={"title": "Thời lượng"}).json()["id"]
    for bad in ("-5", "inf", "nan", "1e308"):
        resp = client.post(f"/api/meetings/{mid}/audio", files={"audio": ("a.webm", b"abc", "audio/webm")},
                           data={"duration_sec": bad})
        assert resp.status_code == 200, (bad, resp.text)
        assert resp.json()["duration_sec"] is None, bad
    resp = client.post(f"/api/meetings/{mid}/audio", files={"audio": ("a.webm", b"abc", "audio/webm")},
                       data={"duration_sec": "12.5"})
    assert resp.json()["duration_sec"] == 12.5
