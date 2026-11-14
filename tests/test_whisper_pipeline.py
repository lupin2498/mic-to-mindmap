"""Đường Whisper: Transcriber thật với module faster_whisper giả, và pipeline với FakeTranscriber."""
import io
import sys
import types

import pytest
from conftest import VI_TRANSCRIPT
from fakes import FakeTranscriber

from app.config import Settings
from app.transcription import Transcriber, TranscriberUnavailable

EN_TRANSCRIPT = (
    "Today we reviewed the launch plan for the new product. The launch plan is scheduled for December. "
    "Anna will contact the key customers by Friday. We agreed to approve the marketing budget. "
    "The marketing team should prepare the campaign next week."
)


class _Seg:
    def __init__(self, start, end, text):
        self.start, self.end, self.text = start, end, text


@pytest.fixture
def fake_whisper_module(monkeypatch):
    calls = {"init": [], "transcribe": []}

    class WhisperModel:
        def __init__(self, name, device="cpu", compute_type="int8"):
            calls["init"].append((name, device, compute_type))

        def transcribe(self, path, **kwargs):
            calls["transcribe"].append((path, kwargs))
            info = types.SimpleNamespace(language=kwargs.get("language") or "en", duration=3.5)
            return iter([_Seg(0.0, 1.234, " Xin chào "), _Seg(1.2, 1.3, "   "), _Seg(1.3, 3.5, "các bạn.")]), info

    module = types.ModuleType("faster_whisper")
    module.WhisperModel = WhisperModel
    monkeypatch.setitem(sys.modules, "faster_whisper", module)
    return calls


def test_transcriber_contract_with_fake_module(tmp_path, fake_whisper_module):
    t = Transcriber(Settings(data_dir=tmp_path, whisper_model="tiny"))
    assert t.available() and t.status()["loaded"] is False and t.status()["error"] is None
    result = t.transcribe(tmp_path / "a.webm", language="auto", hot_words=["Nguyễn Minh Quang", "bản beta"])
    assert result.text == "Xin chào các bạn." and result.language == "en" and result.duration == 3.5
    assert result.segments == [{"start": 0.0, "end": 1.23, "text": "Xin chào"}, {"start": 1.3, "end": 3.5, "text": "các bạn."}]
    path, kwargs = fake_whisper_module["transcribe"][0]
    assert path.endswith("a.webm") and kwargs["language"] is None  # "auto" -> để Whisper tự nhận dạng
    assert kwargs["initial_prompt"] == "Nguyễn Minh Quang, bản beta." and kwargs["vad_filter"] is True
    t.transcribe(tmp_path / "a.webm", language="vi")
    assert fake_whisper_module["transcribe"][1][1]["language"] == "vi"
    assert fake_whisper_module["init"] == [("tiny", "cpu", "int8")]  # model chỉ nạp một lần
    assert t.status()["loaded"] is True


def test_transcriber_disabled_or_missing(tmp_path, monkeypatch):
    t = Transcriber(Settings(data_dir=tmp_path, disable_whisper=True))
    assert not t.available() and "tắt" in t.status()["error"]
    with pytest.raises(TranscriberUnavailable):
        t.transcribe("x.webm")
    monkeypatch.setitem(sys.modules, "faster_whisper", None)  # import sẽ ném ImportError
    t2 = Transcriber(Settings(data_dir=tmp_path))
    assert not t2.available() and "faster-whisper" in t2.status()["error"]
    assert Transcriber.build_initial_prompt([]) is None
    assert Transcriber.build_initial_prompt(["a b c"] * 100, max_words=6) == "a b c, a b c."


def _meeting_with_audio(client, language="vi", live_transcript=None, title="Họp Whisper"):
    meeting = client.post("/api/meetings", json={"title": title, "language": language}).json()
    data = {"live_transcript": live_transcript} if live_transcript else {}
    resp = client.post(f"/api/meetings/{meeting['id']}/audio",
                       files={"audio": ("rec.webm", io.BytesIO(b"\x1aE\xdf\xa3fake"), "audio/webm")}, data=data)
    assert resp.status_code == 200
    return meeting["id"]


def test_pipeline_whisper_replaces_browser_transcript_and_applies_glossary(client):
    fake = FakeTranscriber(text=VI_TRANSCRIPT.replace("bản thử nghiệm", "bản thử nghịm"), duration=77.0)
    client.app.state.pipeline.transcriber = fake
    client.post("/api/glossary", json={"term": "thử nghiệm", "variant": "thử nghịm"})
    mid = _meeting_with_audio(client, live_transcript="phụ đề trình duyệt kém chất lượng")
    client.post(f"/api/meetings/{mid}/process")
    m = client.get(f"/api/meetings/{mid}").json()
    assert m["status"] == "done", m["error"]
    assert m["transcript_source"] == "whisper:small" and m["transcript"] == VI_TRANSCRIPT
    assert m["duration_sec"] == 77.0 and m["segments"]
    assert fake.calls[0]["language"] == "vi" and fake.calls[0]["hot_words"] == ["thử nghiệm"]
    # xử lý lại không ép buộc: giữ transcript Whisper, không nhận dạng lại
    client.post(f"/api/meetings/{mid}/process")
    assert len(fake.calls) == 1
    client.post(f"/api/meetings/{mid}/process", json={"force_transcribe": True})
    assert len(fake.calls) == 2


def test_pipeline_auto_language_is_detected_and_used_for_analysis(client):
    fake = FakeTranscriber(text=EN_TRANSCRIPT, language="en")
    client.app.state.pipeline.transcriber = fake
    mid = _meeting_with_audio(client, language="auto")
    client.post(f"/api/meetings/{mid}/process")
    m = client.get(f"/api/meetings/{mid}").json()
    assert fake.calls[0]["language"] is None
    assert m["status"] == "done" and m["language"] == "en"
    assert any("launch plan" in k for k in m["analysis"]["keywords"])
    assert any(item["owner"] == "Anna" for item in m["analysis"]["action_items"])


def test_pipeline_whisper_error_falls_back_to_browser_transcript(client):
    client.app.state.pipeline.transcriber = FakeTranscriber(error=RuntimeError("không tải được model"))
    mid = _meeting_with_audio(client, live_transcript=VI_TRANSCRIPT)
    client.post(f"/api/meetings/{mid}/process")
    m = client.get(f"/api/meetings/{mid}").json()
    assert m["status"] == "done" and m["transcript_source"] == "browser"
    assert any(e["kind"] == "warning" and "Whisper lỗi" in e["detail"] for e in client.get("/api/learning/events").json())


def test_pipeline_whisper_error_or_silence_without_transcript_reports_error(client):
    client.app.state.pipeline.transcriber = FakeTranscriber(error=RuntimeError("file hỏng"))
    mid = _meeting_with_audio(client)
    client.post(f"/api/meetings/{mid}/process")
    m = client.get(f"/api/meetings/{mid}").json()
    assert m["status"] == "error" and "Whisper lỗi: file hỏng" in m["error"]

    client.app.state.pipeline.transcriber = FakeTranscriber(text="   ")
    mid = _meeting_with_audio(client)
    client.post(f"/api/meetings/{mid}/process")
    m = client.get(f"/api/meetings/{mid}").json()
    assert m["status"] == "error" and "không nhận dạng được" in m["error"]
    # lỗi xong vẫn xử lý lại được (không kẹt trạng thái)
    client.app.state.pipeline.transcriber = FakeTranscriber(text=VI_TRANSCRIPT)
    assert client.post(f"/api/meetings/{mid}/process").json()["started"] is True
    assert client.get(f"/api/meetings/{mid}").json()["status"] == "done"


def test_edited_transcript_is_not_overwritten_by_whisper(client):
    fake = FakeTranscriber(text=VI_TRANSCRIPT)
    client.app.state.pipeline.transcriber = fake
    mid = _meeting_with_audio(client)
    client.post(f"/api/meetings/{mid}/process")
    edited = VI_TRANSCRIPT.replace("500 triệu", "600 triệu")
    client.put(f"/api/meetings/{mid}/transcript", json={"transcript": edited, "reanalyze": True})
    m = client.get(f"/api/meetings/{mid}").json()
    assert m["transcript"] == edited and len(fake.calls) == 1
    # sửa nhiều lần: nhãn nguồn không được dài ra mãi
    client.put(f"/api/meetings/{mid}/transcript", json={"transcript": edited + " Thêm."})
    client.put(f"/api/meetings/{mid}/transcript", json={"transcript": edited + " Thêm nữa."})
    assert client.get(f"/api/meetings/{mid}").json()["transcript_source"] == "whisper:small+edited"


def test_first_manual_transcript_is_not_recorded_as_an_edit(client):
    meeting = client.post("/api/meetings", json={"title": "Dán tay"}).json()
    m = client.put(f"/api/meetings/{meeting['id']}/transcript", json={"transcript": VI_TRANSCRIPT}).json()
    assert m["transcript_source"] == "manual"
    assert client.get("/api/learning/stats").json()["feedback"].get("ratings") == 0
    assert client.app.state.db.list_feedback("transcript_edit") == []


def test_device_speech_text_is_a_draft_that_whisper_replaces(client):
    """Văn bản nhận dạng trực tiếp trên điện thoại ("device") cũng chỉ là bản nháp: máy chủ có Whisper và có file âm thanh
    thì nhận dạng lại; không có file thì giữ nguyên văn bản của điện thoại."""
    fake = FakeTranscriber(text=VI_TRANSCRIPT)
    client.app.state.pipeline.transcriber = fake
    meeting = client.post("/api/meetings", json={"title": "Từ điện thoại"}).json()
    mid = meeting["id"]
    client.put(f"/api/meetings/{mid}/transcript", json={"transcript": "văn bản nháp từ điện thoại", "source": "device"})
    client.post(f"/api/meetings/{mid}/process")
    m = client.get(f"/api/meetings/{mid}").json()
    assert m["status"] == "done" and m["transcript_source"] == "device" and fake.calls == []
    assert m["transcript"] == "văn bản nháp từ điện thoại"
    client.post(f"/api/meetings/{mid}/audio", files={"audio": ("rec.m4a", io.BytesIO(b"fake-m4a"), "audio/mp4")})
    client.post(f"/api/meetings/{mid}/process")
    m = client.get(f"/api/meetings/{mid}").json()
    assert len(fake.calls) == 1 and m["transcript"] == VI_TRANSCRIPT and m["transcript_source"] == "whisper:small"
    # người dùng đã sửa tay văn bản của điện thoại thì Whisper không được ghi đè
    other = client.post("/api/meetings", json={"title": "Đã sửa tay"}).json()
    client.put(f"/api/meetings/{other['id']}/transcript", json={"transcript": "bản nháp", "source": "device"})
    client.put(f"/api/meetings/{other['id']}/transcript", json={"transcript": VI_TRANSCRIPT + " Câu thêm tay."})
    client.post(f"/api/meetings/{other['id']}/audio", files={"audio": ("rec.m4a", io.BytesIO(b"fake-m4a"), "audio/mp4")})
    client.post(f"/api/meetings/{other['id']}/process")
    m = client.get(f"/api/meetings/{other['id']}").json()
    assert len(fake.calls) == 1 and m["transcript_source"] == "device+edited" and m["transcript"].endswith("Câu thêm tay.")


def test_text_recognized_from_an_imported_file_is_redone_by_whisper(client):
    """Văn bản do thiết bị nhận dạng từ file ("file") cũng là bản nháp: máy chủ có Whisper thì nhận dạng lại."""
    fake = FakeTranscriber(text=VI_TRANSCRIPT)
    client.app.state.pipeline.transcriber = fake
    meeting = client.post("/api/meetings", json={"title": "File nhập"}).json()
    client.post(f"/api/meetings/{meeting['id']}/audio", files={"audio": ("hop.mp3", io.BytesIO(b"ID3fake"), "audio/mpeg")},
                data={"live_transcript": "bản nháp của điện thoại", "transcript_source": "file"})
    client.post(f"/api/meetings/{meeting['id']}/process")
    m = client.get(f"/api/meetings/{meeting['id']}").json()
    assert len(fake.calls) == 1 and m["transcript"] == VI_TRANSCRIPT and m["transcript_source"] == "whisper:small"

