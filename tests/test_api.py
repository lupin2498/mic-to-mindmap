import io

from conftest import VI_TRANSCRIPT


def _create_and_process(client, title="Họp kế hoạch", transcript=VI_TRANSCRIPT, participants=("An", "Bình", "Chi")):
    meeting = client.post("/api/meetings", json={"title": title, "participants": list(participants)}).json()
    resp = client.post(
        f"/api/meetings/{meeting['id']}/audio",
        files={"audio": ("rec.webm", io.BytesIO(b"\x1aE\xdf\xa3fake-webm"), "audio/webm")},
        data={"duration_sec": "12.5", "live_transcript": transcript},
    )
    assert resp.status_code == 200 and resp.json()["status"] == "recorded"
    resp = client.post(f"/api/meetings/{meeting['id']}/process")
    assert resp.status_code == 202
    return client.get(f"/api/meetings/{meeting['id']}").json()


def test_health_reports_components(client):
    data = client.get("/api/health").json()
    assert data["whisper"]["available"] is False
    assert data["ollama"]["enabled"] is False
    assert data["engine"] == "heuristic" and data["embedder"] == "hash-512"


def test_full_flow_with_browser_transcript(client):
    meeting = _create_and_process(client)
    assert meeting["status"] == "done", meeting.get("error")
    assert meeting["transcript_source"] == "browser"
    assert meeting["duration_sec"] == 12.5 and meeting["has_audio"]
    analysis = meeting["analysis"]
    assert analysis["engine"] == "heuristic"
    assert analysis["summary"] and analysis["mindmap"]["title"] == "Họp kế hoạch"
    assert analysis["context_used"] == {"glossary_terms": 0, "past_meetings": 0, "examples": 0, "style_hints": 0}

    listing = client.get("/api/meetings").json()
    assert len(listing) == 1 and listing[0]["status"] == "done" and "transcript" not in listing[0]
    assert client.get("/api/meetings?q=ngân sách").json()[0]["id"] == meeting["id"]
    assert client.get("/api/meetings?q=không-có").json() == []

    audio = client.get(f"/api/meetings/{meeting['id']}/audio")
    assert audio.status_code == 200 and audio.content.startswith(b"\x1aE\xdf\xa3")

    markdown = client.get(f"/api/meetings/{meeting['id']}/export.md").text
    assert markdown.startswith("# Họp kế hoạch") and "## Mind map" in markdown and "## Việc cần làm" in markdown


def test_manual_transcript_flow_and_learning_cycle(client):
    meeting = client.post("/api/meetings", json={"title": "Họp dự án", "participants": []}).json()
    resp = client.put(f"/api/meetings/{meeting['id']}/transcript", json={"transcript": VI_TRANSCRIPT})
    assert resp.status_code == 200 and resp.json()["learned_corrections"] == []
    resp = client.post(f"/api/meetings/{meeting['id']}/process", json={"transcribe": False})
    assert resp.status_code == 202
    meeting = client.get(f"/api/meetings/{meeting['id']}").json()
    assert meeting["status"] == "done"

    # sửa transcript 2 lần cùng một lỗi -> thuật ngữ được học và tự áp dụng
    edited = meeting["transcript"].replace("bản thử nghiệm", "bản beta")
    resp = client.put(f"/api/meetings/{meeting['id']}/transcript", json={"transcript": edited})
    assert resp.json()["learned_corrections"] == [{"variant": "thử nghiệm", "term": "beta", "count": 1}]
    client.put(f"/api/meetings/{meeting['id']}/transcript", json={"transcript": meeting["transcript"]})
    client.put(f"/api/meetings/{meeting['id']}/transcript", json={"transcript": edited, "reanalyze": True})
    glossary = client.get("/api/glossary").json()
    assert glossary[0]["term"] == "beta" and glossary[0]["count"] == 2 and glossary[0]["active"] is True

    # sửa tóm tắt -> học ví dụ mẫu
    resp = client.put(f"/api/meetings/{meeting['id']}/analysis",
                      json={"summary": ["Ý một", "Ý hai"], "decisions": [], "mindmap": {"title": "Họp dự án", "children": ["Nhánh A"]}})
    body = resp.json()
    assert body["learning"]["learned"] is True
    assert body["analysis"]["summary"] == ["Ý một", "Ý hai"] and body["analysis"]["decisions"] == []
    assert body["analysis"]["mindmap"]["children"][0]["title"] == "Nhánh A" and body["analysis"]["edited"] is True

    assert client.post(f"/api/meetings/{meeting['id']}/rating", json={"rating": 5, "comment": "ghi rõ số"}).json()["learned"] is True
    assert client.post(f"/api/meetings/{meeting['id']}/rating", json={"rating": 9}).status_code == 422

    stats = client.get("/api/learning/stats").json()
    assert stats["analyzed"] == 1 and stats["memory"]["examples"] == 1
    assert stats["glossary"]["active"] == 1 and stats["feedback"]["edits"] == 1
    events = client.get("/api/learning/events").json()
    assert any(e["kind"] == "glossary" for e in events) and any(e["kind"] == "feedback" for e in events)

    # cuộc họp thứ hai nhận được bối cảnh từ cuộc họp trước + thuật ngữ + ví dụ
    second = _create_and_process(client, title="Họp theo dõi", transcript=(
        "Tiếp tục theo dõi chiến dịch quảng cáo cho sản phẩm mới. Ngân sách chiến dịch 500 triệu đã được duyệt. "
        "Khách hàng đã dùng bản thử nghiệm. An đã liên hệ khách hàng lớn. Cần chuẩn bị buổi demo cho khách hàng vào thứ năm."
    ))
    assert second["status"] == "done"
    assert "bản beta" in second["transcript"]  # thuật ngữ đã học được tự áp dụng
    assert second["analysis"]["context_used"]["past_meetings"] == 1
    assert second["analysis"]["context_used"]["glossary_terms"] == 1
    assert second["analysis"]["context_used"]["examples"] == 1

    # hỏi trí nhớ
    answer = client.post("/api/learning/ask", json={"question": "ngân sách chiến dịch bao nhiêu?"}).json()
    assert answer["sources"] and answer["engine"] == "heuristic"
    assert client.get("/api/learning/search?q=demo khách hàng").json()
    export = client.get("/api/learning/export")
    assert export.status_code == 200 and export.text.count("\n") == 1
    assert client.post("/api/learning/reindex").json()["updated"] == 0


def test_glossary_endpoints(client):
    resp = client.post("/api/glossary", json={"term": "Nguyễn Minh Quang", "variant": "nguyễn minh quan"})
    assert resp.status_code == 201 and resp.json()["active"] is True
    assert client.post("/api/glossary", json={"term": "   "}).status_code in (400, 422)
    entry_id = resp.json()["id"]
    assert client.delete(f"/api/glossary/{entry_id}").status_code == 204
    assert client.delete(f"/api/glossary/{entry_id}").status_code == 404
    assert client.get("/api/glossary").json() == []


def test_errors_and_delete(client):
    assert client.get("/api/meetings/nope").status_code == 404
    meeting = client.post("/api/meetings", json={}).json()
    assert meeting["title"] == "Cuộc họp"
    assert client.post(f"/api/meetings/{meeting['id']}/process").status_code == 400
    assert client.get(f"/api/meetings/{meeting['id']}/audio").status_code == 404
    renamed = client.patch(f"/api/meetings/{meeting['id']}", json={"title": "Đổi tên", "participants": ["An"]}).json()
    assert renamed["title"] == "Đổi tên" and renamed["participants"] == ["An"]
    assert client.delete(f"/api/meetings/{meeting['id']}").status_code == 204
    assert client.delete(f"/api/meetings/{meeting['id']}").status_code == 404
    assert client.get("/").status_code == 200 and "Mic to Mindmap" in client.get("/").text


def test_audio_without_transcript_and_without_whisper_reports_error(client):
    meeting = client.post("/api/meetings", json={"title": "Chỉ có audio"}).json()
    client.post(f"/api/meetings/{meeting['id']}/audio", files={"audio": ("a.mp3", io.BytesIO(b"abc"), "audio/mpeg")})
    client.post(f"/api/meetings/{meeting['id']}/process")
    meeting = client.get(f"/api/meetings/{meeting['id']}").json()
    assert meeting["status"] == "error" and "faster-whisper" in meeting["error"]
