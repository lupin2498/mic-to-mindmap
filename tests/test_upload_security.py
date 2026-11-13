"""Tải file (tên lạ, rỗng, lớn, thay file cũ) và bảo mật cơ bản (path traversal, SQL injection, kiểu nội dung)."""
import io

from conftest import VI_TRANSCRIPT


def _new(client, title="Tải file") -> str:
    return client.post("/api/meetings", json={"title": title}).json()["id"]


def _upload(client, mid, name, data=b"abc", mime="audio/webm", **form):
    return client.post(f"/api/meetings/{mid}/audio", files={"audio": (name, io.BytesIO(data), mime)}, data=form)


def _audio_files(client):
    return sorted(client.app.state.settings.audio_dir.iterdir())


def test_weird_filenames_never_escape_audio_dir(client):
    mid = _new(client)
    names = ["../../etc/passwd", "..\\..\\evil.mp3", "a/b/c.wav", "tệp ghi âm cuộc họp số 1.m4a", "x" * 300 + ".ogg",
             ".webm", "không-có-đuôi", "con.MP3", "a.webm.exe", "bản ghi\x00.mp3"]
    for name in names:
        resp = _upload(client, mid, name)
        assert resp.status_code == 200, (name, resp.text)
        files = _audio_files(client)
        assert len(files) == 1, f"file cũ không được dọn sau khi tải {name!r}"
        assert files[0].parent == client.app.state.settings.audio_dir and files[0].name.startswith(mid + "-")
    assert _audio_files(client)[0].suffix == ".mp3"
    exts = {}
    for name, mime in [("a.M4A", "audio/mp4"), ("b.txt", "text/plain"), ("c.exe", "audio/ogg"), ("d", "")]:
        _upload(client, mid, name, mime=mime)
        exts[name] = _audio_files(client)[0].suffix
    assert exts["a.M4A"] == ".m4a" and exts["b.txt"] == ".webm" and exts["d"] == ".webm"
    assert exts["c.exe"] in (".ogg", ".oga", ".opus")  # đoán từ kiểu nội dung; tên đuôi tùy phiên bản Python


def test_empty_upload_is_rejected_and_keeps_previous_audio(client):
    mid = _new(client)
    assert _upload(client, mid, "ok.webm", data=b"good-audio").status_code == 200
    resp = _upload(client, mid, "rong.webm", data=b"")
    assert resp.status_code == 400 and "rỗng" in resp.json()["detail"]
    files = _audio_files(client)
    assert len(files) == 1 and files[0].read_bytes() == b"good-audio"
    assert client.get(f"/api/meetings/{mid}/audio").content == b"good-audio"
    # cuộc họp mới + file rỗng: không được chuyển sang "đã ghi âm"
    other = _new(client)
    assert _upload(client, other, "rong.webm", data=b"").status_code == 400
    m = client.get(f"/api/meetings/{other}").json()
    assert m["status"] == "new" and m["has_audio"] is False


def test_large_upload_roundtrip(client):
    mid = _new(client)
    blob = bytes(range(256)) * 4096 * 8  # 8 MB
    resp = _upload(client, mid, "lon.wav", data=blob, mime="audio/wav", duration_sec="3600.5")
    assert resp.status_code == 200 and resp.json()["duration_sec"] == 3600.5
    got = client.get(f"/api/meetings/{mid}/audio")
    assert got.headers["content-type"] == "audio/wav" and got.content == blob


def test_audio_is_never_served_as_html(client):
    """audio_mime do client gửi: nếu phát lại nguyên văn thì tải 'audio' kiểu text/html là XSS lưu trữ."""
    mid = _new(client)
    _upload(client, mid, "x.webm", data=b"<script>alert(1)</script>", mime="text/html")
    got = client.get(f"/api/meetings/{mid}/audio")
    assert got.headers["content-type"] == "application/octet-stream"
    assert got.headers.get("x-content-type-options") == "nosniff"
    _upload(client, mid, "x.webm", data=b"abc", mime="audio/webm;codecs=opus")
    assert client.get(f"/api/meetings/{mid}/audio").headers["content-type"] == "audio/webm"


def test_delete_removes_audio_file(client):
    mid = _new(client)
    _upload(client, mid, "a.webm")
    assert len(_audio_files(client)) == 1
    assert client.delete(f"/api/meetings/{mid}").status_code == 204
    assert _audio_files(client) == []
    assert _upload(client, mid, "a.webm").status_code == 404 and _audio_files(client) == []


def test_sql_injection_and_like_wildcards_in_search(client):
    a = _new(client, "Giảm giá 100% cho khách")
    b = _new(client, "Mã SP_01'; DROP TABLE meetings;--")
    c = _new(client, "Họp thường")
    ids = lambda q: {m["id"] for m in client.get("/api/meetings", params={"q": q}).json()}  # noqa: E731
    assert ids("'; DROP TABLE meetings;--") == {b}
    assert ids("' OR '1'='1") == set()
    assert len(client.get("/api/meetings").json()) == 3  # bảng vẫn còn nguyên
    assert ids("100%") == {a}
    assert ids("%") == {a}          # % là ký tự thường, không phải "khớp mọi thứ"
    assert ids("_") == {b}
    assert ids("SP_01") == {b}
    assert ids("thường") == {c}
    for path in (f"/api/meetings/{a}' OR '1'='1", "/api/meetings/..%2F..%2Fetc%2Fpasswd/audio", "/api/glossary/1 OR 1=1"):
        assert client.get(path).status_code in (404, 405, 422)
    assert client.delete("/api/glossary/1;DROP TABLE glossary").status_code == 422


def test_search_normalizes_nfd_query(client):
    import unicodedata

    mid = _new(client, "Họp ngân sách quý bốn")
    q = unicodedata.normalize("NFD", "ngân sách")
    assert q != "ngân sách"
    assert [m["id"] for m in client.get("/api/meetings", params={"q": q}).json()] == [mid]


def test_static_files_do_not_allow_path_traversal(client):
    for path in ("/static/../main.py", "/static/..%2Fmain.py", "/static/%2e%2e/config.py", "/static/..%5cmain.py"):
        resp = client.get(path)
        assert resp.status_code in (400, 404), path
        assert "FastAPI" not in resp.text and "create_app" not in resp.text


def test_html_in_user_text_is_stored_verbatim_as_json(client):
    """API trả dữ liệu thô (JSON); việc thoát HTML là của giao diện (xem tests/e2e)."""
    payload = '<img src=x onerror=alert(1)>'
    mid = client.post("/api/meetings", json={"title": payload, "participants": [payload]}).json()["id"]
    client.put(f"/api/meetings/{mid}/transcript", json={"transcript": VI_TRANSCRIPT + " " + payload})
    client.post(f"/api/meetings/{mid}/process", json={"transcribe": False})
    m = client.get(f"/api/meetings/{mid}")
    assert m.headers["content-type"].startswith("application/json") and m.json()["title"] == payload
    md = client.get(f"/api/meetings/{mid}/export.md")
    assert md.headers["content-type"].startswith("text/markdown")
