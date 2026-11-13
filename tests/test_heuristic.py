from conftest import VI_TRANSCRIPT

from app.heuristic import analyze_heuristic, find_due, find_owner
from app.mindmap import count_nodes, flatten_titles


def test_vietnamese_analysis_extracts_structure():
    result = analyze_heuristic(VI_TRANSCRIPT, "Họp kế hoạch", ["An", "Bình", "Chi"], "vi")
    assert result["engine"] == "heuristic"
    assert 3 <= len(result["summary"]) <= 8
    assert any("thống nhất" in d for d in result["decisions"])
    owners = {item["owner"] for item in result["action_items"]}
    assert {"An", "Bình"} <= owners
    dues = {item["due"] for item in result["action_items"]}
    assert "ngày 15/11" in dues and "trước thứ sáu" in dues
    mindmap = result["mindmap"]
    assert mindmap["title"] == "Họp kế hoạch"
    titles = flatten_titles(mindmap)
    assert "Quyết định" in titles and "Việc cần làm" in titles
    assert count_nodes(mindmap) > 6


def test_owner_requires_whole_word_match():
    assert find_owner("Ngân sách chiến dịch sẽ được duyệt", ["Chi"]) == ""
    assert find_owner("Chi sẽ chuẩn bị demo", ["Chi"]) == "Chi"
    assert find_owner("Minh Quang sẽ phụ trách phần này", []) == "Minh Quang"


def test_find_due_patterns():
    assert find_due("gửi trước ngày 15 tháng 11") == "ngày 15 tháng 11"
    assert find_due("deadline is next week") == "next week"
    assert find_due("hoàn thành vào thứ 6 tuần sau") == "vào thứ 6 tuần sau"
    assert find_due("không có hạn") == ""


def test_english_analysis():
    text = ("We discussed the launch plan. The launch plan needs budget approval. We agreed to launch in March. "
            "Alice will prepare the campaign by Friday. Bob should send the budget review next week.")
    result = analyze_heuristic(text, "Launch sync", ["Alice", "Bob"], "en")
    assert any("agreed" in d for d in result["decisions"])
    assert {i["owner"] for i in result["action_items"]} >= {"Alice", "Bob"}
    assert result["mindmap"]["title"] == "Launch sync"


def test_empty_transcript_gives_empty_but_valid_result():
    result = analyze_heuristic("", "Trống", [], "vi")
    assert result["summary"] == [] and result["keywords"] == []
    assert result["mindmap"] == {"title": "Trống", "children": []}


def test_pipeline_language_helpers(settings):
    from app.pipeline import Pipeline

    assert Pipeline.whisper_language({"language": "auto"}) is None
    assert Pipeline.whisper_language({"language": ""}) is None
    assert Pipeline.whisper_language({"language": "EN"}) == "en"
    pipeline = Pipeline.__new__(Pipeline)
    pipeline.settings = settings
    assert pipeline.analysis_language({"language": "auto"}) == settings.language
    assert pipeline.analysis_language({"language": "en"}) == "en"


def test_repeated_sentences_are_deduplicated():
    text = ("Chúng ta thống nhất ra mắt vào tháng ba. An sẽ gửi kế hoạch trước thứ sáu. " * 4)
    result = analyze_heuristic(text, "Lặp", ["An"], "vi")
    assert len(result["summary"]) == len({s.lower() for s in result["summary"]})
    assert len(result["decisions"]) == 1
    assert len(result["action_items"]) == 1


def test_owner_is_a_name_not_a_pronoun_or_cue_word():
    """Bộ dự phòng từng điền "Cần", "We", "Tôi", "Need" vào cột Phụ trách vì coi mọi chữ viết hoa đầu câu là tên."""
    from app.heuristic import find_owner

    for sentence in ["Cần phải hoàn thành báo cáo trước thứ sáu.", "We will send the report by Friday.",
                     "Tôi sẽ gửi báo cáo tiến độ.", "Em sẽ chuẩn bị slide.", "Need to follow up with the vendor.",
                     "They should prepare the deck.", "Chúng ta sẽ họp lại vào tuần sau.", "Mọi người cần đọc tài liệu.",
                     "Sẽ phải làm lại từ đầu.", "Phải cần thêm hai người."]:
        assert find_owner(sentence, []) == "", sentence
    expected = {
        "An sẽ phụ trách liên hệ khách hàng.": "An",
        "Anna will contact the key customers.": "Anna",
        "Chị Lan sẽ gửi hợp đồng.": "Chị Lan",
        "anh Minh Quang phải gửi báo giá.": "Minh Quang",
        "Nguyễn Văn An phải gửi báo cáo.": "Nguyễn Văn An",
        "Sau đó Bình sẽ gửi biên bản.": "Bình",      # "đó" không phải chữ hoa dù nằm trong dải À-Ỹ
        "Marketing cần chuẩn bị chiến dịch.": "Marketing",
    }
    for sentence, owner in expected.items():
        assert find_owner(sentence, []) == owner, sentence
    # tên trong danh sách người tham gia vẫn được ưu tiên, khớp nguyên từ
    assert find_owner("Việc này giao cho chi nhánh, Chi sẽ theo dõi.", ["Chi"]) == "Chi"
    assert find_owner("Cần chuẩn bị chiến dịch.", ["Chi"]) == ""
