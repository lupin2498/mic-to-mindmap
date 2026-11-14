"""Bộ máy tóm tắt + sơ đồ tư duy không cần AI: kiểm trên văn bản giống thật (kể cả văn bản do nhận dạng giọng nói
tạo ra: chữ thường, không dấu câu, lẫn từ đệm)."""
from samples import SAMPLES

from app.heuristic import analyze_heuristic, find_due, find_owner, make_task, title_for
from app.mindmap import MAX_CHILDREN, count_nodes, flatten_titles, meeting_markdown
from app.textutil import split_sentences


def _run(name: str, **overrides) -> dict:
    sample = dict(SAMPLES[name], **overrides)
    return analyze_heuristic(sample["text"], sample["title"], sample["participants"], sample["language"],
                             sample.get("style"))


def _branch(mindmap: dict, title: str) -> list[str]:
    for child in mindmap["children"]:
        if child["title"] == title:
            return [leaf["title"] for leaf in child["children"]]
    return []


def test_speech_transcript_gives_decisions_owners_and_deadlines():
    result = _run("vi_speech")
    assert result["engine"] == "heuristic"
    assert result["decisions"] == [
        "Chúng ta thống nhất chuyển 20% ngân sách quảng cáo sang tiktok từ tháng 11.",
        "Chúng ta quyết định chạy chương trình khuyến mãi xả tồn kho trong tháng 10.",
    ]
    items = {(i["owner"], i["task"], i["due"]) for i in result["action_items"]}
    # tên viết thường sau từ xưng hô (kiểu văn bản nhận dạng giọng nói) vẫn nhận ra, bộ phận cũng là người phụ trách
    assert ("anh Hùng", "Phụ trách tìm mặt bằng", "ngày 20 tháng 10") in items
    assert ("chị Lan", "Lên kế hoạch quảng cáo tiktok và gửi cho mọi người", "vào thứ sáu tuần này") in items
    assert ("em Minh", "Tổng hợp phản hồi khách hàng về sản phẩm mới", "cuối tháng") in items
    assert ("Phòng kế toán", "Gửi báo cáo tồn kho chi tiết", "trước thứ tư") in items
    # câu hỏi, câu đồng tình, câu nêu ý kiến không phải là việc cần làm hay quyết định
    assert len(result["action_items"]) == 4
    assert 4 <= len(result["summary"]) <= 8
    for line in result["summary"]:
        low = line.lower()
        assert not low.startswith(("alo", "ok ", "ừm", "à ")), line          # từ đệm đầu câu đã được bỏ
        assert "cảm ơn" not in low and "nghe rõ không" not in low, line       # không lấy câu chào hỏi
        assert line[0].isupper() and line.endswith("."), line
    assert {"doanh thu", "quảng cáo", "tồn kho"} <= set(result["keywords"])
    # tên người và từ đệm không được thành từ khóa
    assert not {"hùng", "lan", "minh", "alo", "ok"} & set(result["keywords"])


def test_mindmap_has_topic_branches_then_decisions_and_actions():
    mindmap = _run("vi_speech")["mindmap"]
    assert mindmap["title"] == "Tình hình doanh thu quý ba và kế hoạch quý bốn"    # lấy từ câu mở đầu
    branches = [child["title"] for child in mindmap["children"]]
    assert branches[-2:] == ["Quyết định", "Việc cần làm"]
    assert {"Doanh thu", "Quảng cáo", "Tồn kho"} <= set(branches[:-2])
    assert 4 <= len(branches) <= MAX_CHILDREN
    assert _branch(mindmap, "Quyết định") == ["Chuyển 20% ngân sách quảng cáo sang tiktok từ tháng 11",
                                               "Chạy chương trình khuyến mãi xả tồn kho trong tháng 10"]
    assert "Phụ trách tìm mặt bằng (anh Hùng, ngày 20 tháng 10)" in _branch(mindmap, "Việc cần làm")
    # mỗi ý chỉ nằm ở một nhánh, mọi nhánh đều có lá
    titles = flatten_titles(mindmap)
    assert len(titles) == len(set(titles))
    assert all(child["children"] for child in mindmap["children"])
    assert count_nodes(mindmap) >= 15
    # nhánh chủ đề xếp theo thứ tự được nhắc tới trong buổi họp
    assert branches.index("Doanh thu") < branches.index("Quảng cáo") < branches.index("Tồn kho")


def test_lecture_has_no_fake_decisions_and_keeps_the_subject():
    result = _run("vi_lecture")
    assert result["decisions"] == []
    assert result["mindmap"]["title"] == "Quang hợp ở thực vật"
    assert result["keywords"][0] == "quang hợp" and {"pha sáng", "pha tối", "lục lạp"} <= set(result["keywords"])
    assert [i["due"] for i in result["action_items"]] == ["vào thứ hai tuần sau"]
    assert "Quyết định" not in [c["title"] for c in result["mindmap"]["children"]]
    assert any(line.startswith("Quang hợp là quá trình") for line in result["summary"])


def test_short_note_becomes_a_flat_map_of_main_points():
    result = _run("vi_short")
    assert result["summary"] == ["Mai nhớ mua sữa cho con.", "Gọi điện cho mẹ hỏi thăm sức khỏe.",
                                 "Chuẩn bị tài liệu cho buổi thuyết trình thứ năm."]
    assert [c["title"] for c in result["mindmap"]["children"]] == ["Ý chính"]
    assert _branch(result["mindmap"], "Ý chính") == ["Mai nhớ mua sữa cho con", "Gọi điện cho mẹ hỏi thăm sức khỏe",
                                                      "Chuẩn bị tài liệu cho buổi thuyết trình thứ năm"]
    assert result["mindmap"]["title"]


def test_english_transcript():
    result = _run("en")
    assert result["decisions"] == ["We agreed to approve the marketing budget of 50,000 dollars.",
                                   "We decided to postpone the mobile app until Q1."]
    items = {(i["owner"], i["task"], i["due"]) for i in result["action_items"]}
    assert ("Alice", "Redesign the onboarding flow", "by Friday") in items
    assert ("Marketing team", "Prepare the campaign", "next week") in items
    assert ("Bob", "Follow up with the payment vendor about the API limits", "") in items
    # câu hỏi còn bỏ ngỏ không phải việc cần làm
    assert not any("free tier" in i["task"] for i in result["action_items"])
    branches = [c["title"] for c in result["mindmap"]["children"]]
    assert branches[-2:] == ["Decisions", "Action items"]
    assert title_for(SAMPLES["en"]["text"], "en") == "Launch plan for the new product"


def test_negated_pending_and_finished_statements_are_not_decisions_or_tasks():
    def run(text):
        return analyze_heuristic(text, "", [], "vi")

    result = run("Chúng ta chưa thống nhất được ngân sách cho dự án. Mọi người không đồng ý tăng giá bán. "
                 "Chúng ta thống nhất lùi ngày ra mắt sang tháng một.")
    assert result["decisions"] == ["Chúng ta thống nhất lùi ngày ra mắt sang tháng một."]
    # việc đã làm xong và câu hỏi không phải việc cần làm
    result = run("An đã gửi báo cáo doanh thu hôm qua. Bình sẽ gửi báo cáo chi phí trước thứ sáu. "
                 "Ai sẽ phụ trách phần kiểm thử?")
    assert result["action_items"] == [{"task": "Gửi báo cáo chi phí", "owner": "Bình", "due": "trước thứ sáu"}]
    # "đồng ý với ai đó" chỉ là tán thành, chưa phải quyết định
    result = run("Em đồng ý với chị Lan. Mọi người đồng ý tổ chức demo tại văn phòng.")
    assert result["decisions"] == ["Mọi người đồng ý tổ chức demo tại văn phòng."]
    # "chưa có ai phụ trách" là nêu vấn đề, không phải giao việc
    result = run("Hiện tại chưa có ai phụ trách kiểm thử tự động. Tuấn cần rà soát lại phần lưu trữ dữ liệu.")
    assert result["action_items"] == [{"task": "Rà soát lại phần lưu trữ dữ liệu", "owner": "Tuấn", "due": ""}]
    # từ gợi ý nằm trong một từ ghép khác nghĩa thì không tính: "giao dịch" không phải "giao (việc)"
    assert run("Phí giao dịch qua ví điện tử khoảng 2%. Giao diện mới được khách hàng khen.")["action_items"] == []


def test_delegated_owner_comes_after_the_cue():
    """"Giao cho <ai>": người nhận việc đứng sau từ gợi ý chứ không đứng đầu câu."""
    cases = [
        ("Việc liên hệ nhà cung cấp giao cho Bình trước thứ tư.", [], "Bình", "Liên hệ nhà cung cấp"),
        ("Giao cho Bình liên hệ nhà cung cấp trước thứ tư.", [], "Bình", "Liên hệ nhà cung cấp"),
        ("Anh Hùng sẽ giao cho Bình liên hệ nhà cung cấp.", [], "Bình", "Liên hệ nhà cung cấp"),
        ("phần báo cáo tài chính thì sẽ được giao cho chị lan.", [], "chị Lan", "Phần báo cáo tài chính"),
        ("giao cho anh hùng tìm mặt bằng trước ngày 20 tháng 10.", [], "anh Hùng", "Tìm mặt bằng"),
        ("Phân công chị Lan lên kế hoạch quảng cáo tiktok.", [], "chị Lan", "Lên kế hoạch quảng cáo tiktok"),
        ("giao cho anh An chuẩn bị slide.", ["An"], "An", "Chuẩn bị slide"),
        ("The vendor follow-up is assigned to Bob by Friday.", [], "Bob", "The vendor follow-up"),
        # không đủ chắc thì giữ nguyên câu, không đoán
        ("Việc này giao cho Bình.", [], "Bình", "Việc này giao cho Bình"),
        ("Việc này giao cho An và Bình cùng làm.", ["An", "Bình"], "An", "Việc này giao cho An và Bình cùng làm"),
        ("Giao cho Bình, Lan sẽ hỗ trợ phần số liệu.", [], "Bình", "Giao cho Bình, Lan sẽ hỗ trợ phần số liệu"),
    ]
    for sentence, participants, owner, task in cases:
        found = find_owner(sentence, participants)
        assert found == owner, sentence
        assert make_task(sentence, found, find_due(sentence)) == task, sentence
    # không phải tên người thì không điền bừa
    for sentence, participants in [("sếp giao cho em phụ trách mảng quảng cáo.", []),
                                   ("Giao cho chi nhánh Hà Nội xử lý đơn hàng tồn.", ["Chi"]),
                                   ("giao cho các bạn làm bài tập trang 45.", []),
                                   ("giao cho bạn nào rảnh thì làm báo cáo tuần.", []),
                                   ("giao cho chị kế toán tổng hợp chi phí.", []),
                                   ("Phí giao dịch qua ví điện tử khoảng 2%.", [])]:
        assert find_owner(sentence, participants) == "", sentence
    result = _run("vi_delegate")
    items = {(i["owner"], i["task"], i["due"]) for i in result["action_items"]}
    assert {("Bình", "Liên hệ nhà cung cấp kệ hàng", "trước thứ tư"), ("Dũng", "Kiểm kê hàng tồn", "ngày 20 tháng 12"),
            ("anh Hùng", "Tìm mặt bằng kho mới ở Thủ Đức", ""), ("Minh Quang", "Lập danh sách xe tải cần thuê", ""),
            ("chị Lan", "Phần báo cáo chi phí vận chuyển", ""), ("Bob", "The vendor follow-up", "by Friday")} <= items
    assert result["mindmap"]["title"] == "Chuyển kho hàng sang địa điểm mới"
    assert "giao" not in result["keywords"]      # từ gợi ý giao việc không phải chủ đề của buổi họp


def test_summary_size_follows_length_and_learned_style():
    short = _run("vi_clean")
    long = _run("vi_long_speech")
    assert 3 <= len(short["summary"]) < len(long["summary"]) <= 12
    # số ý người dùng hay giữ (học từ các lần họ sửa) quyết định cỡ tóm tắt, trong giới hạn 3-12
    assert len(_run("vi_long_speech", style={"summary_items": 4})["summary"]) == 4
    assert len(_run("vi_long_speech", style={"summary_items": 9.6})["summary"]) == 10
    assert len(_run("vi_long_speech", style={"summary_items": 500})["summary"]) == 12
    assert len(_run("vi_long_speech", style={"summary_items": 1})["summary"]) == 3
    for junk in ("x", True, None, float("nan"), -3, [4]):
        assert len(_run("vi_long_speech", style={"summary_items": junk})["summary"]) == len(long["summary"])
    # số nhánh sơ đồ cũng vậy: 3 nhánh chủ đề + Quyết định + Việc cần làm
    few = _run("vi_long_speech", style={"branches": 3})["mindmap"]["children"]
    assert len(few) < len(long["mindmap"]["children"])
    assert [c["title"] for c in few][-2:] == ["Quyết định", "Việc cần làm"]
    # tóm tắt giữ thứ tự xuất hiện trong buổi họp
    sentences = [s.lower() for s in split_sentences(SAMPLES["vi_long_speech"]["text"])]
    positions = [next(i for i, s in enumerate(sentences) if line.lower().rstrip(".") in s) for line in long["summary"]]
    assert positions == sorted(positions)


def test_long_meeting_is_bounded():
    text = " ".join(sample["text"] for sample in SAMPLES.values()) * 4
    result = analyze_heuristic(text, "Họp dài", ["Tuấn", "Hà"], "vi")
    assert len(result["summary"]) == 12 and len(result["decisions"]) <= 6 and len(result["action_items"]) <= 12
    assert len(result["keywords"]) <= 10
    assert len(result["mindmap"]["children"]) <= MAX_CHILDREN
    # nói lặp lại bốn lần cũng chỉ ghi một lần
    assert len(result["summary"]) == len({s.lower() for s in result["summary"]})
    tasks = [(i["task"], i["owner"]) for i in result["action_items"]]
    assert len(tasks) == len(set(tasks))


def test_title_for_untitled_recordings():
    assert title_for(SAMPLES["vi_clean"]["text"], "vi") == "Kế hoạch ra mắt sản phẩm mới"
    assert title_for(SAMPLES["vi_long_speech"]["text"], "vi") == "Dự án ứng dụng đặt lịch khám bệnh"
    assert title_for("Hôm nay chúng ta họp về việc chuyển kho hàng sang địa điểm mới.", "vi") == "Chuyển kho hàng sang địa điểm mới"
    assert title_for("Hello everyone. Today we will talk about the quarterly budget review.", "auto") == "Quarterly budget review"
    # không có câu mở đầu nêu chủ đề: ghép từ khóa
    assert title_for(SAMPLES["vi_short"]["text"], "vi") == "Sức khỏe, tài liệu"
    assert title_for("", "vi") == "" and title_for("   \n ", "auto") == ""
    assert len(title_for("họp về " + "kế hoạch phát triển sản phẩm " * 20, "vi")) <= 61


def test_meeting_markdown_export():
    sample = SAMPLES["vi_clean"]
    analysis = _run("vi_clean")
    meeting = {"title": "Họp kế hoạch", "created_at": "2026-11-14T08:00:00+00:00", "participants": sample["participants"],
               "analysis": analysis, "transcript": sample["text"]}
    markdown = meeting_markdown(meeting)
    assert markdown.startswith("# Họp kế hoạch\n")
    order = [markdown.index(h) for h in ("## Ý chính", "## Quyết định", "## Việc cần làm", "## Từ khóa", "## Sơ đồ tư duy",
                                         "## Văn bản")]
    assert order == sorted(order)
    assert "- [ ] Phụ trách liên hệ khách hàng lớn (An, trước thứ sáu)" in markdown
    assert "- [ ] Chuẩn bị chiến dịch quảng cáo cho sản phẩm mới (Bộ phận marketing)" in markdown
    assert "## Từ khóa\nkhách hàng, kế hoạch ra mắt, sản phẩm mới" in markdown
    assert "## Sơ đồ tư duy\n\n# Họp kế hoạch\n- Kế hoạch ra mắt\n  - " in markdown
    assert "- Người tham gia: An, Bình, Chi" in markdown
    assert markdown.endswith(sample["text"] + "\n")
    # chưa xử lý: vẫn xuất được, không có mục rỗng
    bare = meeting_markdown({"title": "Chưa xử lý", "created_at": "", "participants": [], "analysis": None, "transcript": ""})
    assert bare == "# Chưa xử lý\n\n- Thời gian: \n"


def test_run_on_speech_keeps_deadlines_whole_and_prefers_real_deadlines():
    # câu dài không dấu câu bị cắt ở 28 từ: trước đây cắt đúng giữa "thứ năm | tuần sau" và "cuối | tuần này"
    result = _run("vi_speech_run_on")
    sentences = [s.lower() for s in split_sentences(SAMPLES["vi_speech_run_on"]["text"])]
    assert any(s.endswith("trước thứ năm tuần sau") for s in sentences), sentences
    assert any(s.endswith("hạn là cuối tuần này") for s in sentences), sentences
    dues = {item["owner"]: item["due"] for item in result["action_items"]}
    assert dues.get("Tuấn") == "trước thứ năm tuần sau", result["action_items"]   # không phải "hôm nay" của "hôm nay mình họp"
    assert "cuối tuần này" in [item["due"] for item in result["action_items"]], result["action_items"]


def test_due_prefers_a_marked_deadline_over_a_narrative_time():
    assert find_due("hôm nay mình họp anh tuấn sẽ lo phần âm thanh trước thứ năm tuần sau") == "trước thứ năm tuần sau"
    assert find_due("tuần này chị lan gửi báo cáo, hạn là ngày 20 tháng 11") == "ngày 20 tháng 11"
    assert find_due("sáng nay Bình nhận việc, chậm nhất thứ sáu phải xong") == "thứ sáu"
    # chỉ có một mốc thời gian: vẫn lấy như trước
    assert find_due("Bình gửi báo cáo tuần sau") == "tuần sau"
    assert find_due("hôm nay An gửi báo cáo") == "hôm nay"
