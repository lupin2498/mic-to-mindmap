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
    assert markdown.startswith("# Họp kế hoạch") and "## Sơ đồ tư duy" in markdown and "## Việc cần làm" in markdown
    assert "## Văn bản" in markdown and markdown.endswith(meeting["transcript"] + "\n")


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


def test_auto_language_and_cors(client):
    meeting = client.post("/api/meetings", json={"title": "Auto", "language": "auto"}).json()
    assert meeting["language"] == "auto"
    client.put(f"/api/meetings/{meeting['id']}/transcript", json={"transcript": VI_TRANSCRIPT})
    client.post(f"/api/meetings/{meeting['id']}/process", json={"transcribe": False})
    meeting = client.get(f"/api/meetings/{meeting['id']}").json()
    assert meeting["status"] == "done" and meeting["analysis"]["mindmap"]["title"] == "Auto"
    assert client.post("/api/meetings", json={"title": "x", "language": "  "}).json()["language"] == "vi"
    resp = client.options("/api/meetings", headers={"Origin": "http://localhost", "Access-Control-Request-Method": "POST"})
    assert resp.status_code == 200 and resp.headers.get("access-control-allow-origin") == "*"


def test_edits_are_rejected_while_processing(client):
    meeting = client.post("/api/meetings", json={"title": "Bận"}).json()
    client.put(f"/api/meetings/{meeting['id']}/transcript", json={"transcript": VI_TRANSCRIPT})
    pipeline = client.app.state.pipeline
    pipeline._running.add(meeting["id"])
    try:
        assert client.put(f"/api/meetings/{meeting['id']}/transcript", json={"transcript": "x"}).status_code == 409
        assert client.put(f"/api/meetings/{meeting['id']}/analysis", json={"summary": ["x"]}).status_code == 409
        assert client.post(f"/api/meetings/{meeting['id']}/process").json()["started"] is False
        assert client.get(f"/api/meetings/{meeting['id']}").json()["processing"] is True
    finally:
        pipeline._running.discard(meeting["id"])
    assert client.put(f"/api/meetings/{meeting['id']}/transcript", json={"transcript": VI_TRANSCRIPT}).status_code == 200


def test_nfd_unicode_is_normalized_on_input(client):
    import unicodedata

    title_nfd = unicodedata.normalize("NFD", "Họp sản phẩm")
    meeting = client.post("/api/meetings", json={"title": title_nfd, "participants": [unicodedata.normalize("NFD", "Bình")]}).json()
    assert meeting["title"] == "Họp sản phẩm" and meeting["participants"] == ["Bình"]
    client.put(f"/api/meetings/{meeting['id']}/transcript", json={"transcript": unicodedata.normalize("NFD", VI_TRANSCRIPT)})
    client.post(f"/api/meetings/{meeting['id']}/process", json={"transcribe": False})
    meeting = client.get(f"/api/meetings/{meeting['id']}").json()
    assert meeting["transcript"] == VI_TRANSCRIPT
    assert "khách hàng" in meeting["analysis"]["keywords"]
    entry = client.post("/api/glossary", json={"term": unicodedata.normalize("NFD", "Nguyễn Minh Quang")}).json()
    assert entry["term"] == "Nguyễn Minh Quang"


def test_user_edits_are_not_truncated_by_llm_output_limits(client):
    """Giới hạn 12 ý / 12 nhánh / 4 cấp là để gọt kết quả LLM; bản người dùng tự sửa phải được lưu đủ."""
    meeting = _create_and_process(client)
    mid = meeting["id"]
    summary = [f"Ý chính số {i}" for i in range(20)]
    decisions = [f"Quyết định {i}" for i in range(15)]
    actions = [{"task": f"Việc {i}", "owner": "An", "due": ""} for i in range(25)]
    keywords = [f"từ khóa {i}" for i in range(20)]
    deep = {"title": "Cấp 4", "children": [{"title": "Cấp 5", "children": [{"title": "Cấp 6", "children": []}]}]}
    mindmap = {"title": "Gốc", "children": [{"title": f"Nhánh {i}", "children": []} for i in range(16)]}
    mindmap["children"][0]["children"] = [{"title": "Cấp 2", "children": [{"title": "Cấp 3", "children": [deep]}]}]
    body = client.put(f"/api/meetings/{mid}/analysis", json={"summary": summary, "decisions": decisions, "action_items": actions,
                                                              "keywords": keywords, "mindmap": mindmap}).json()
    saved = client.get(f"/api/meetings/{mid}").json()["analysis"]
    assert body["analysis"] == saved
    assert saved["summary"] == summary and saved["decisions"] == decisions and saved["keywords"] == keywords
    assert saved["action_items"] == actions
    assert saved["mindmap"] == mindmap

    # xóa hết nhánh mind map rồi lưu: phải lưu đúng cây chỉ còn nút gốc, không âm thầm giữ cây cũ
    body = client.put(f"/api/meetings/{mid}/analysis", json={"mindmap": {"title": "Gốc", "children": []}}).json()
    assert body["analysis"]["mindmap"] == {"title": "Gốc", "children": []}
    assert body["analysis"]["summary"] == summary  # trường không gửi lên thì giữ nguyên
    # dữ liệu rác vẫn được chuẩn hóa, không gây lỗi
    body = client.put(f"/api/meetings/{mid}/analysis", json={"mindmap": "không phải cây", "action_items": [{"x": 1}, {"task": "  "}]})
    assert body.status_code == 200 and body.json()["analysis"]["action_items"] == []
    assert body.json()["analysis"]["mindmap"]["title"] == "không phải cây"


def test_device_speech_transcript_flow(client):
    """Điện thoại nhận dạng giọng nói ngay lúc nói: không có file âm thanh, chỉ gửi văn bản kèm thời lượng."""
    meeting = client.post("/api/meetings", json={"title": "", "language": "vi", "duration_sec": 754.5}).json()
    assert meeting["duration_sec"] == 754.5 and meeting["title"] == "Cuộc họp"
    mid = meeting["id"]
    resp = client.put(f"/api/meetings/{mid}/transcript", json={"transcript": VI_TRANSCRIPT, "source": "device", "reanalyze": True})
    assert resp.status_code == 200 and resp.json()["learned_corrections"] == []
    meeting = client.get(f"/api/meetings/{mid}").json()
    assert meeting["status"] == "done" and meeting["transcript_source"] == "device"
    assert not meeting["has_audio"] and meeting["duration_sec"] == 754.5
    analysis = meeting["analysis"]
    assert analysis["engine"] == "heuristic" and analysis["decisions"] and analysis["action_items"]
    assert [c["title"] for c in analysis["mindmap"]["children"]][-2:] == ["Quyết định", "Việc cần làm"]
    assert client.app.state.db.list_feedback("transcript_edit") == []     # lần ghi đầu không phải là "sửa"
    # người dùng sửa lại văn bản: nhãn nguồn ghi nhận, lần sửa được đưa vào để học
    edited = VI_TRANSCRIPT.replace("500 triệu", "600 triệu")
    client.put(f"/api/meetings/{mid}/transcript", json={"transcript": edited, "source": "manual"})
    assert client.get(f"/api/meetings/{mid}").json()["transcript_source"] == "device+edited"
    assert len(client.app.state.db.list_feedback("transcript_edit")) == 1

    # nguồn lạ hoặc bỏ trống thì coi là nhập tay; nhãn quá dài bị từ chối
    for source, expected in ((None, "manual"), ("", "manual"), ("whisper:large", "manual"), ("browser", "browser")):
        other = client.post("/api/meetings", json={"title": "Nguồn"}).json()
        body = {"transcript": VI_TRANSCRIPT} if source is None else {"transcript": VI_TRANSCRIPT, "source": source}
        assert client.put(f"/api/meetings/{other['id']}/transcript", json=body).json()["transcript_source"] == expected
    other = client.post("/api/meetings", json={"title": "Nguồn"}).json()
    assert client.put(f"/api/meetings/{other['id']}/transcript", json={"transcript": "x", "source": "d" * 21}).status_code == 422
    # thời lượng vô lý thì bỏ qua chứ không lưu
    for bad in (0, -5, 1e12):
        assert client.post("/api/meetings", json={"title": "Thời lượng", "duration_sec": bad}).json()["duration_sec"] is None
    assert client.post("/api/meetings", json={"title": "Thời lượng", "duration_sec": "abc"}).status_code == 422


def test_summary_size_follows_what_the_user_keeps(client):
    """Không cần AI vẫn "học" được: người dùng hay rút tóm tắt còn 3 ý thì lần sau bộ máy tự tóm tắt 3 ý."""
    from samples import SAMPLES

    long_text = SAMPLES["vi_long_speech"]["text"]

    def analyze(title):
        meeting = client.post("/api/meetings", json={"title": title}).json()
        client.put(f"/api/meetings/{meeting['id']}/transcript", json={"transcript": long_text, "source": "device", "reanalyze": True})
        return client.get(f"/api/meetings/{meeting['id']}").json()

    first = analyze("Họp dự án 1")
    assert first["status"] == "done" and len(first["analysis"]["summary"]) == 7
    assert len(first["analysis"]["mindmap"]["children"]) == 8
    kept = first["analysis"]["summary"][:3]
    tree = dict(first["analysis"]["mindmap"], children=first["analysis"]["mindmap"]["children"][:4])
    client.put(f"/api/meetings/{first['id']}/analysis", json={"summary": kept, "mindmap": tree})
    # một lần sửa chưa nói lên thói quen
    assert len(analyze("Họp dự án 2")["analysis"]["summary"]) == 7
    client.put(f"/api/meetings/{first['id']}/analysis", json={"summary": kept[:2] + ["Ý viết lại"], "mindmap": tree})
    third = analyze("Họp dự án 3")
    assert len(third["analysis"]["summary"]) == 3
    assert len(third["analysis"]["mindmap"]["children"]) < 8
    stats = client.get("/api/learning/stats").json()["feedback"]
    assert stats["edits"] == 2 and stats["avg_summary_items"] == 3
