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
