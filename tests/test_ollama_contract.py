"""Đường Ollama thật chưa chạy được ở môi trường test: kiểm bằng máy chủ HTTP giả bám sát hợp đồng."""
import pytest
from conftest import VI_TRANSCRIPT
from fakes import FakeOllama

from app.config import Settings
from app.learning import AutoEmbedder, MemoryStore
from app.llm import OllamaClient
from app.summarizer import MAX_DIRECT_CHARS, Analyzer

GOOD_REPLY = {
    "summary": ["Ra mắt sản phẩm vào tháng 12", "Chốt ngân sách 500 triệu"],
    "decisions": ["Chốt ngân sách 500 triệu"],
    "action_items": [{"task": "Liên hệ khách hàng lớn", "owner": "An", "due": "thứ sáu"}],
    "keywords": ["ra mắt", "ngân sách"],
    "mindmap": {"title": "Kế hoạch ra mắt", "children": [{"title": "Ngân sách", "children": [{"title": "500 triệu"}]}]},
}


@pytest.fixture
def ollama_server():
    server = FakeOllama(chat_reply=GOOD_REPLY)
    yield server
    server.close()


def _client(server, model="qwen2.5:7b", embed="nomic-embed-text", timeout=5.0) -> OllamaClient:
    return OllamaClient(server.url, model, embed, timeout=timeout)


def test_status_and_chat_json_follow_contract(ollama_server):
    client = _client(ollama_server)
    status = client.status()
    assert status["available"] and status["model_ready"] and status["embed_ready"]
    assert client.chat_json("hệ thống", "người dùng") == GOOD_REPLY
    payload = ollama_server.calls("/api/chat")[0]
    assert payload["model"] == "qwen2.5:7b" and payload["stream"] is False and payload["format"] == "json"
    assert [m["role"] for m in payload["messages"]] == ["system", "user"]


def test_analyzer_uses_llm_result(ollama_server):
    result = Analyzer(_client(ollama_server)).analyze(VI_TRANSCRIPT, "Họp kế hoạch", ["An"], "vi", None)
    assert result["engine"] == "ollama:qwen2.5:7b"
    assert result["summary"] == GOOD_REPLY["summary"]
    assert result["action_items"] == GOOD_REPLY["action_items"]
    assert result["mindmap"]["children"][0]["title"] == "Ngân sách"


def test_model_tag_must_match_like_real_ollama():
    """Ollama chỉ chạy đúng tag đã tải: có qwen2.5:14b thì gọi qwen2.5:7b vẫn 404.
    Trước đây has_model so khớp theo tên gốc nên báo "sẵn sàng" rồi mọi lần phân tích âm thầm rơi về heuristic."""
    server = FakeOllama(models=["qwen2.5:14b", "nomic-embed-text:latest"])
    try:
        client = _client(server)
        status = client.status()
        assert status["available"] is True
        assert status["model_ready"] is False
        assert status["embed_ready"] is True          # không ghi tag = :latest
        assert client.chat_available() is False
        analyzer = Analyzer(client)
        assert analyzer.engine_name() == "heuristic"
        assert analyzer.analyze(VI_TRANSCRIPT, "T", [], "vi", None)["engine"] == "heuristic"
        assert server.calls("/api/chat") == []        # không gọi model không tồn tại
        assert OllamaClient(server.url, "qwen2.5:14b", "nomic-embed-text:latest").status()["model_ready"] is True
        assert OllamaClient(server.url, "qwen2.5", "x").status()["model_ready"] is False
    finally:
        server.close()


@pytest.mark.parametrize("reply", ["xin lỗi tôi không làm được", '{"summary": ["dở dang"', "[1, 2, 3]", ""])
def test_broken_json_falls_back_to_heuristic(ollama_server, reply):
    ollama_server.chat_reply = reply
    result = Analyzer(_client(ollama_server)).analyze(VI_TRANSCRIPT, "Họp", ["An"], "vi", None)
    assert result["engine"] == "heuristic (LLM lỗi)"
    assert result["summary"] and result["mindmap"]["children"]


def test_wrong_types_in_llm_json_do_not_break_result(ollama_server):
    ollama_server.chat_reply = {"summary": "chỉ một chuỗi", "decisions": None, "action_items": {"task": "x"},
                                "keywords": [1, 2, {"text": "ba"}], "mindmap": "không phải cây"}
    result = Analyzer(_client(ollama_server)).analyze(VI_TRANSCRIPT, "Họp", [], "vi", None)
    assert result["engine"] == "ollama:qwen2.5:7b"
    assert result["summary"] == ["chỉ một chuỗi"]
    assert result["decisions"] == [] and result["action_items"] == []
    assert result["keywords"] == ["1", "2", "ba"]
    assert result["mindmap"]["children"]  # giữ mind map heuristic khi LLM trả cây hỏng


def test_chat_timeout_and_http_error_fall_back(ollama_server):
    ollama_server.chat_delay = 1.5
    client = _client(ollama_server, timeout=0.3)
    assert client.chat("s", "u") is None
    assert Analyzer(client).analyze(VI_TRANSCRIPT, "Họp", [], "vi", None)["engine"] == "heuristic (LLM lỗi)"
    ollama_server.chat_delay = 0
    ollama_server.chat_status = 500
    assert _client(ollama_server).chat_json("s", "u") is None


def test_long_transcript_goes_through_map_reduce(ollama_server):
    def reply(payload):
        user = payload["messages"][1]["content"]
        if '{"notes"' in user:
            return {"notes": ["ghi chú A", "ghi chú B"]}
        assert "ghi chú A" in user and len(user) < MAX_DIRECT_CHARS
        return GOOD_REPLY

    ollama_server.chat_reply = reply
    long_text = " ".join(f"Câu số {i} nói về kế hoạch ra mắt sản phẩm và ngân sách quảng cáo." for i in range(600))
    assert len(long_text) > MAX_DIRECT_CHARS * 2
    result = Analyzer(_client(ollama_server)).analyze(long_text, "Họp dài", [], "vi", None)
    assert result["engine"] == "ollama:qwen2.5:7b" and result["summary"] == GOOD_REPLY["summary"]
    assert len(ollama_server.calls("/api/chat")) >= 4  # >= 3 phần + 1 lần tổng hợp


def test_embed_new_endpoint_and_legacy_fallback():
    new = FakeOllama(embed_dims=16)
    old = FakeOllama(embed_dims=16, legacy_embed=True)
    try:
        vec = _client(new).embed("xin chào thế giới")
        assert vec and len(vec) == 16 and new.calls("/api/embed")[0] == {"model": "nomic-embed-text", "input": "xin chào thế giới"}
        legacy = _client(old).embed("xin chào thế giới")
        assert legacy == vec
        assert old.calls("/api/embeddings")[0] == {"model": "nomic-embed-text", "prompt": "xin chào thế giới"}
        assert _client(new, embed="model-chua-tai").embed("abc") is None
    finally:
        new.close()
        old.close()


def test_switching_embed_model_then_reindex(tmp_path):
    """Đổi model nhúng giữa chừng: trí nhớ cũ vẫn tìm được (qua vector băm), reindex chuyển hết sang model mới."""
    from app.db import Database

    server = FakeOllama(models=["qwen2.5:7b", "embed-a:latest", "embed-b:latest"], embed_dims=16)
    try:
        db = Database(tmp_path / "m.sqlite3")
        store_a = MemoryStore(db, AutoEmbedder(_client(server, embed="embed-a")))
        store_a.remember("m1", "meeting", "ngân sách chiến dịch quảng cáo 500 triệu", {"title": "A"})
        store_a.remember("m2", "meeting", "tuyển dụng kỹ sư phần mềm", {"title": "B"})
        assert {m["embedding_model"] for m in db.iter_memories()} == {"ollama:embed-a"}

        server.embed_dims = 24  # model mới có số chiều khác
        store_b = MemoryStore(db, AutoEmbedder(_client(server, embed="embed-b")))
        hits = store_b.search("ngân sách chiến dịch", kinds=["meeting"])
        assert hits and hits[0]["meeting_id"] == "m1"  # chưa reindex vẫn tìm ra nhờ vector băm

        assert store_b.reindex() == 2
        rows = db.iter_memories()
        assert {m["embedding_model"] for m in rows} == {"ollama:embed-b"} and all(len(m["embedding"]) == 24 for m in rows)
        assert store_b.reindex() == 0
        assert store_b.search("ngân sách chiến dịch", kinds=["meeting"])[0]["meeting_id"] == "m1"

        # Ollama tắt hẳn: vẫn tìm được bằng vector băm, không lỗi
        offline = MemoryStore(db, AutoEmbedder(OllamaClient("http://127.0.0.1:1", "m", "embed-b", timeout=1)))
        assert offline.search("tuyển dụng kỹ sư", kinds=["meeting"])[0]["meeting_id"] == "m2"
    finally:
        server.close()


def test_reindex_does_not_count_failed_embeddings(tmp_path):
    """Model nhúng lỗi giữa lúc reindex: không được báo "đã nhúng lại" cho các mảnh thực ra chưa nhúng được."""
    from app.db import Database

    server = FakeOllama(embed_dims=16)
    try:
        db = Database(tmp_path / "m.sqlite3")
        offline = MemoryStore(db, AutoEmbedder(None))
        offline.remember("m1", "meeting", "ngân sách chiến dịch", {"title": "A"})
        store = MemoryStore(db, AutoEmbedder(_client(server)))
        server.embed_fail = True
        assert store.reindex() == 0
        assert db.iter_memories()[0]["embedding_model"] == "hash-512"
        server.embed_fail = False
        assert store.reindex() == 1
        assert db.iter_memories()[0]["embedding_model"] == "ollama:nomic-embed-text"
    finally:
        server.close()


def test_api_end_to_end_with_fake_ollama(tmp_path, ollama_server, monkeypatch):
    from fastapi.testclient import TestClient

    from app.main import create_app

    monkeypatch.setenv("OLLAMA_URL", ollama_server.url)
    settings = Settings(data_dir=tmp_path / "data", sync_jobs=True, disable_whisper=True)
    client = TestClient(create_app(settings))
    health = client.get("/api/health").json()
    assert health["engine"] == "ollama:qwen2.5:7b" and health["embedder"] == "ollama:nomic-embed-text"
    meeting = client.post("/api/meetings", json={"title": "Họp LLM"}).json()
    client.put(f"/api/meetings/{meeting['id']}/transcript", json={"transcript": VI_TRANSCRIPT})
    client.post(f"/api/meetings/{meeting['id']}/process", json={"transcribe": False})
    meeting = client.get(f"/api/meetings/{meeting['id']}").json()
    assert meeting["status"] == "done" and meeting["engine"] == "ollama:qwen2.5:7b"
    assert meeting["analysis"]["summary"] == GOOD_REPLY["summary"]
    ollama_server.chat_reply = "Ngân sách là 500 triệu."
    answer = client.post("/api/learning/ask", json={"question": "ngân sách chiến dịch bao nhiêu?"}).json()
    assert answer["answer"] == "Ngân sách là 500 triệu." and answer["sources"]
    assert "format" not in ollama_server.calls("/api/chat")[-1]  # hỏi đáp không ép JSON
