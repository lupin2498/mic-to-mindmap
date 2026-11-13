"""Tương tranh và vòng đời: pipeline chạy bằng thread thật, máy chủ HTTP thật (uvicorn) nhận nhiều request cùng lúc."""
import io
import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
import uvicorn
from conftest import VI_TRANSCRIPT
from fakes import FakeTranscriber, wait_until

from app.config import Settings
from app.main import create_app


@pytest.fixture
def threaded_settings(tmp_path) -> Settings:
    return Settings(data_dir=tmp_path / "data", sync_jobs=False, disable_ollama=True, disable_whisper=True)


@pytest.fixture
def tclient(threaded_settings):
    from fastapi.testclient import TestClient

    return TestClient(create_app(threaded_settings))


class GatedAnalyzer:
    """Bọc Analyzer thật: dừng ở analyze() cho tới khi test mở cổng, để giữ pipeline ở trạng thái đang chạy."""

    def __init__(self, inner):
        self.inner = inner
        self.gate = threading.Event()
        self.entered = threading.Event()
        self.calls = 0

    def __getattr__(self, name):
        return getattr(self.inner, name)

    def analyze(self, *args, **kwargs):
        self.calls += 1
        self.entered.set()
        assert self.gate.wait(15), "GatedAnalyzer: không được mở cổng trong 15 giây"
        return self.inner.analyze(*args, **kwargs)


def _gate(client) -> GatedAnalyzer:
    pipeline = client.app.state.pipeline
    gated = GatedAnalyzer(pipeline.analyzer)
    pipeline.analyzer = gated
    return gated


def _new_with_transcript(client, title="Họp") -> str:
    mid = client.post("/api/meetings", json={"title": title}).json()["id"]
    assert client.put(f"/api/meetings/{mid}/transcript", json={"transcript": VI_TRANSCRIPT}).status_code == 200
    return mid


def _idle(client, mid) -> bool:
    return not client.app.state.pipeline.is_running(mid)


def test_thread_mode_runs_to_done_and_rejects_double_process(tclient):
    gated = _gate(tclient)
    mid = _new_with_transcript(tclient)
    first = tclient.post(f"/api/meetings/{mid}/process", json={"transcribe": False})
    assert first.status_code == 202 and first.json()["started"] is True
    assert gated.entered.wait(5)
    second = tclient.post(f"/api/meetings/{mid}/process", json={"transcribe": False}).json()
    assert second["started"] is False
    m = tclient.get(f"/api/meetings/{mid}").json()
    assert m["processing"] is True and m["status"] == "analyzing"
    assert tclient.put(f"/api/meetings/{mid}/transcript", json={"transcript": "x"}).status_code == 409
    gated.gate.set()
    assert wait_until(lambda: _idle(tclient, mid))
    m = tclient.get(f"/api/meetings/{mid}").json()
    assert m["status"] == "done" and m["processing"] is False and gated.calls == 1
    assert tclient.app.state.db.count_memories("meeting") == 1


def test_delete_while_processing_leaves_no_orphan_memory(tclient, threaded_settings):
    gated = _gate(tclient)
    mid = tclient.post("/api/meetings", json={"title": "Sắp xóa"}).json()["id"]
    tclient.post(f"/api/meetings/{mid}/audio", files={"audio": ("a.webm", io.BytesIO(b"abc"), "audio/webm")},
                 data={"live_transcript": VI_TRANSCRIPT})
    tclient.post(f"/api/meetings/{mid}/process", json={"transcribe": False})
    assert gated.entered.wait(5)

    # Xóa đúng lúc pipeline vừa ghi kết quả và sắp ghi trí nhớ (khe hở giữa update_meeting và remember_meeting)
    memory = tclient.app.state.pipeline.memory
    real_remember = memory.remember_meeting
    deleted = []

    def delete_then_remember(meeting, analysis):
        deleted.append(tclient.delete(f"/api/meetings/{mid}").status_code)
        return real_remember(meeting, analysis)

    memory.remember_meeting = delete_then_remember
    gated.gate.set()
    assert wait_until(lambda: _idle(tclient, mid))
    assert deleted == [204]
    assert tclient.get(f"/api/meetings/{mid}").status_code == 404
    db = tclient.app.state.db
    assert db.count_memories() == 0, "trí nhớ của cuộc họp đã xóa vẫn còn (sẽ hiện lại khi hỏi trí nhớ)"
    assert tclient.get("/api/learning/search?q=ngân sách chiến dịch").json() == []
    assert list(threaded_settings.audio_dir.iterdir()) == []


def test_upload_is_rejected_while_processing_and_keeps_audio(tclient, threaded_settings):
    gate = threading.Event()
    fake = FakeTranscriber(text=VI_TRANSCRIPT, gate=gate)
    tclient.app.state.pipeline.transcriber = fake
    mid = tclient.post("/api/meetings", json={"title": "Đang nhận dạng"}).json()["id"]
    tclient.post(f"/api/meetings/{mid}/audio", files={"audio": ("a.webm", io.BytesIO(b"first"), "audio/webm")})
    tclient.post(f"/api/meetings/{mid}/process")
    assert fake.started.wait(5)
    resp = tclient.post(f"/api/meetings/{mid}/audio", files={"audio": ("b.webm", io.BytesIO(b"second"), "audio/webm")},
                        data={"live_transcript": "chen ngang"})
    assert resp.status_code == 409
    files = list(threaded_settings.audio_dir.iterdir())
    assert len(files) == 1 and files[0].read_bytes() == b"first"  # file Whisper đang đọc không bị xóa
    gate.set()
    assert wait_until(lambda: _idle(tclient, mid))
    m = tclient.get(f"/api/meetings/{mid}").json()
    assert m["status"] == "done" and m["transcript"] == VI_TRANSCRIPT


def test_reanalyze_retries_transcription_when_first_attempt_failed(tclient):
    """Nhận dạng lỗi (vd: chưa tải được model) -> sửa xong nhấn "Phân tích lại" (transcribe=false) phải chạy được."""
    pipeline = tclient.app.state.pipeline
    pipeline.transcriber = FakeTranscriber(error=RuntimeError("chưa tải được model"))
    mid = tclient.post("/api/meetings", json={"title": "Thử lại"}).json()["id"]
    tclient.post(f"/api/meetings/{mid}/audio", files={"audio": ("a.webm", io.BytesIO(b"abc"), "audio/webm")})
    tclient.post(f"/api/meetings/{mid}/process")
    assert wait_until(lambda: _idle(tclient, mid))
    assert tclient.get(f"/api/meetings/{mid}").json()["status"] == "error"
    pipeline.transcriber = FakeTranscriber(text=VI_TRANSCRIPT)
    tclient.post(f"/api/meetings/{mid}/process", json={"transcribe": False})
    assert wait_until(lambda: _idle(tclient, mid))
    m = tclient.get(f"/api/meetings/{mid}").json()
    assert m["status"] == "done", m["error"]
    assert m["transcript"] == VI_TRANSCRIPT


def test_interrupted_meetings_are_recovered_on_restart(tmp_path):
    """Máy chủ bị tắt giữa lúc xử lý: lần khởi động sau không được để cuộc họp kẹt mãi ở "đang xử lý"."""
    from fastapi.testclient import TestClient

    settings = Settings(data_dir=tmp_path / "data", sync_jobs=True, disable_ollama=True, disable_whisper=True)
    client = TestClient(create_app(settings))
    ids = {}
    for status in ("queued", "transcribing", "analyzing", "done", "recorded"):
        ids[status] = _new_with_transcript(client, title=status)
        client.app.state.db.update_meeting(ids[status], status=status)

    restarted = TestClient(create_app(settings))  # cùng thư mục dữ liệu = khởi động lại
    for status in ("queued", "transcribing", "analyzing"):
        m = restarted.get(f"/api/meetings/{ids[status]}").json()
        assert m["status"] == "error" and m["processing"] is False and "gián đoạn" in m["error"]
    assert restarted.get(f"/api/meetings/{ids['done']}").json()["status"] == "done"
    assert restarted.get(f"/api/meetings/{ids['recorded']}").json()["status"] == "recorded"
    # và xử lý lại được
    restarted.post(f"/api/meetings/{ids['analyzing']}/process", json={"transcribe": False})
    m = restarted.get(f"/api/meetings/{ids['analyzing']}").json()
    assert m["status"] == "done" and m["error"] is None


# ---------------------------------------------------------------- máy chủ HTTP thật
@pytest.fixture
def live_server(threaded_settings):
    app = create_app(threaded_settings)
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning"))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
    thread.start()
    assert wait_until(lambda: server.started, timeout=10)
    yield f"http://127.0.0.1:{port}", app
    server.should_exit = True
    thread.join(timeout=10)
    sock.close()


def test_many_concurrent_requests_against_real_server(live_server):
    base, app = live_server
    count = 24

    def one(i: int) -> tuple[str, list[int]]:
        codes = []
        with httpx.Client(base_url=base, timeout=30) as c:
            r = c.post("/api/meetings", json={"title": f"Họp {i}", "participants": ["An"]})
            codes.append(r.status_code)
            mid = r.json()["id"]
            codes.append(c.put(f"/api/meetings/{mid}/transcript", json={"transcript": VI_TRANSCRIPT}).status_code)
            codes.append(c.post(f"/api/meetings/{mid}/process", json={"transcribe": False}).status_code)
            codes.append(c.post(f"/api/meetings/{mid}/process", json={"transcribe": False}).status_code)
            codes.append(c.post("/api/glossary", json={"term": "Mic to Mindmap", "variant": "mic tu mai map"}).status_code)
            codes.append(c.get("/api/meetings").status_code)
            codes.append(c.get("/api/learning/stats").status_code)
        return mid, codes

    with ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(one, range(count)))
    assert all(codes == [201, 200, 202, 202, 201, 200, 200] for _, codes in results), results
    pipeline, db = app.state.pipeline, app.state.db
    assert wait_until(lambda: not pipeline._running, timeout=30)
    with httpx.Client(base_url=base, timeout=30) as c:
        meetings = c.get("/api/meetings").json()
        assert len(meetings) == count and {m["status"] for m in meetings} == {"done"}
        assert c.get("/api/learning/stats").json()["analyzed"] == count
        glossary = c.get("/api/glossary").json()
        assert len(glossary) == 1 and glossary[0]["count"] == count  # không mất lần cộng nào
    assert db.count_memories("meeting") == count  # mỗi cuộc họp đúng một bản tóm tắt trong trí nhớ
