from app.learning.embeddings import HashingEmbedder, cosine
from app.learning.feedback import FeedbackLearner


def _meeting(db, title, transcript):
    m = db.create_meeting(title, ["An"], "vi")
    db.update_meeting(m["id"], transcript=transcript)
    return db.get_meeting(m["id"])


def test_hashing_embedder_similarity():
    emb = HashingEmbedder()
    a = emb.embed("kế hoạch ra mắt sản phẩm mới cho khách hàng")
    b = emb.embed("sản phẩm mới sẽ ra mắt khách hàng theo kế hoạch")
    c = emb.embed("bảo trì máy chủ và sao lưu dữ liệu")
    assert cosine(a, b) > cosine(a, c)
    assert abs(cosine(a, a) - 1.0) < 1e-9
    assert emb.embed("") == [0.0] * emb.dims


def test_memory_search_and_forget(db, memory):
    m1 = _meeting(db, "Họp dự án Alpha", "Dự án Alpha cần hoàn thành giai đoạn một. Khách hàng muốn demo sớm.")
    m2 = _meeting(db, "Họp hạ tầng", "Bảo trì máy chủ và sao lưu dữ liệu định kỳ.")
    memory.remember_meeting(m1, {"summary": ["Alpha xong giai đoạn một"], "decisions": [], "action_items": [], "keywords": ["alpha"]})
    memory.remember_meeting(m2, {"summary": ["Bảo trì máy chủ"], "decisions": [], "action_items": [], "keywords": []})
    hits = memory.search("demo dự án alpha cho khách hàng", kinds=["meeting"], k=2)
    assert hits and hits[0]["meeting_id"] == m1["id"]
    assert memory.search("demo alpha", kinds=["meeting"], exclude_meeting=m1["id"])[0:1] != hits[0:1]
    assert memory.stats()["meetings"] == 2 and memory.stats()["chunks"] >= 2
    memory.forget_meeting(m1["id"])
    assert memory.stats()["meetings"] == 1
    # ghi đè khi nhớ lại cùng một cuộc họp
    memory.remember_meeting(m2, {"summary": ["Bảo trì"], "decisions": [], "action_items": [], "keywords": []})
    assert memory.stats()["meetings"] == 1


def test_glossary_learns_from_edits_with_threshold(db, glossary):
    learned = glossary.learn_from_edit("dự án an pha cần demo", "dự án Alpha cần demo")
    assert learned and learned[0]["variant"] == "an pha" and learned[0]["term"] == "Alpha"
    assert glossary.apply("dự án an pha chạy tốt") == ("dự án an pha chạy tốt", 0)  # chưa đủ ngưỡng
    glossary.learn_from_edit("an pha", "Alpha")
    text, applied = glossary.apply("Dự án AN PHA chạy tốt, anphabet không đổi")
    assert text == "Dự án Alpha chạy tốt, anphabet không đổi" and applied == 1
    assert glossary.hot_words() == ["Alpha"]
    stats = glossary.stats()
    assert stats["inferred"] == 1 and stats["active"] == 1 and stats["hits"] == 1


def test_glossary_user_entries_apply_immediately(db, glossary):
    glossary.add("Nguyễn Minh Quang", "nguyễn minh quan")
    glossary.add("Kubernetes")
    text, applied = glossary.apply("anh nguyễn minh quan phụ trách kubernetes")
    assert text == "anh Nguyễn Minh Quang phụ trách kubernetes" and applied == 1
    assert set(glossary.hot_words()) == {"Nguyễn Minh Quang", "Kubernetes"}
    entry = [e for e in glossary.entries() if e["term"] == "Kubernetes"][0]
    assert entry["active"] and glossary.remove(entry["id"]) and not any(e["term"] == "Kubernetes" for e in glossary.entries())


def test_glossary_ignores_long_or_punctuation_only_edits(glossary):
    assert glossary.learn_from_edit("a b c d e f", "x y z w v u") == []
    assert glossary.learn_from_edit("xin chào.", "xin chào!") == []
    assert glossary.learn_from_edit("", "gì đó") == []


def test_feedback_learns_examples_and_style(db, memory, feedback):
    meeting = _meeting(db, "Họp A", "Nội dung cuộc họp A về sản phẩm.")
    original = {"summary": ["a"], "decisions": [], "action_items": [], "keywords": [], "mindmap": {"title": "Họp A", "children": []}}
    edited = dict(original, summary=["Ý một đã sửa", "Ý hai đã sửa", "Ý ba"], mindmap={"title": "Họp A", "children": [{"title": "x", "children": []}]})
    result = feedback.record_analysis_edit(meeting, original, edited)
    assert result["learned"] and result["changed"]["summary"] and not result["changed"]["decisions"]
    assert memory.stats()["examples"] == 1
    assert feedback.style_hints("vi") == []  # chưa đủ số lần sửa để kết luận
    feedback.record_analysis_edit(meeting, original, dict(edited, summary=["Ý một", "Ý hai", "Ý ba", "Ý bốn", "Ý năm"]))
    hints = feedback.style_hints("vi")
    assert any("ý chính" in h for h in hints)
    assert memory.stats()["examples"] == 1  # mỗi cuộc họp chỉ giữ một ví dụ
    assert feedback.record_analysis_edit(meeting, edited, edited)["learned"] is False


def test_rating_adds_or_removes_examples(db, memory, feedback):
    meeting = _meeting(db, "Họp B", "Nội dung cuộc họp B.")
    db.update_meeting(meeting["id"], analysis={"summary": ["tốt"], "decisions": [], "action_items": [], "keywords": []})
    meeting = db.get_meeting(meeting["id"])
    assert feedback.record_rating(meeting, 5, "rất tốt")["learned"] is True
    assert memory.stats()["examples"] == 1
    assert feedback.record_rating(meeting, 1, "sai hết")["learned"] is False
    assert memory.stats()["examples"] == 0
    stats = feedback.stats()
    assert stats["ratings"] == 2 and stats["avg_rating"] == 3.0
    assert any("rất tốt" in h or "sai hết" in h for h in feedback.style_hints("vi"))


def test_export_examples_jsonl(db, memory, feedback):
    meeting = _meeting(db, "Họp C", "Nội dung C.")
    db.update_meeting(meeting["id"], analysis={"summary": ["x"], "decisions": [], "action_items": [], "keywords": []})
    feedback.record_rating(db.get_meeting(meeting["id"]), 4)
    rows = feedback.export_examples()
    assert len(rows) == 1 and rows[0]["output"]["summary"] == ["x"]
    assert FeedbackLearner.to_jsonl(rows).count("\n") == 1
    assert FeedbackLearner.to_jsonl([]) == ""


def test_glossary_ignores_rewrites_and_strips_punctuation(glossary):
    original = " ".join(f"từ{i}" for i in range(30))
    rewritten = " ".join(f"khác{i}" for i in range(30))
    assert glossary.learn_from_edit(original, rewritten) == []  # viết lại gần hết -> không học
    learned = glossary.learn_from_edit("dự án an pha, bắt đầu " + original, "dự án Alpha, bắt đầu " + original)
    assert [(e["variant"], e["term"]) for e in learned] == [("an pha", "Alpha")]
    learned = glossary.learn_from_edit("gặp an pha. Xong", "gặp Alpha, xong")
    assert [(e["variant"], e["term"]) for e in learned] == [("an pha", "Alpha")]
