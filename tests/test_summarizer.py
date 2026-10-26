from conftest import VI_TRANSCRIPT

from app.heuristic import analyze_heuristic
from app.summarizer import Analyzer, merge_llm_result


class FakeOllama:
    """Giả lập Ollama: trả về JSON cố định, ghi lại prompt."""

    model = "fake-llm"

    def __init__(self, responses):
        self.responses = list(responses)
        self.prompts = []

    def chat_available(self):
        return True

    def chat_json(self, system, user, **kwargs):
        self.prompts.append(user)
        return self.responses.pop(0) if self.responses else None

    def chat(self, system, user, **kwargs):
        self.prompts.append(user)
        return "Trả lời giả"


def test_merge_llm_result_overrides_valid_fields_only():
    fallback = analyze_heuristic(VI_TRANSCRIPT, "Họp", ["An"], "vi")
    merged = merge_llm_result({"summary": ["A", "B"], "decisions": [], "action_items": "không phải list",
                               "keywords": [], "mindmap": {"title": "x", "children": []}}, fallback, "Họp")
    assert merged["summary"] == ["A", "B"]
    assert merged["decisions"] == []
    assert merged["action_items"] == []  # khóa có mặt nhưng sai kiểu -> rỗng
    assert merged["keywords"] == fallback["keywords"]  # rỗng -> giữ heuristic
    assert merged["mindmap"] == fallback["mindmap"]  # mindmap không có nhánh -> giữ heuristic
    assert merge_llm_result(None, fallback, "Họp") == fallback


def test_analyzer_falls_back_without_ollama(offline_ollama):
    result = Analyzer(offline_ollama).analyze(VI_TRANSCRIPT, "Họp", ["An"], "vi", {})
    assert result["engine"] == "heuristic"


def test_analyzer_uses_llm_and_context():
    fake = FakeOllama([{"summary": ["Ý từ LLM"], "decisions": ["Chốt"], "action_items": [{"task": "Làm X", "owner": "An"}],
                        "keywords": ["x"], "mindmap": {"title": "Họp", "children": [{"title": "N", "children": ["c"]}]}}])
    context = {"glossary_terms": ["Alpha"], "past_meetings": [{"title": "Họp cũ", "date": "2026-01-01", "summary": ["cũ"]}],
               "examples": [{"input": "abc", "output": {"summary": ["mẫu"]}}], "style_hints": ["Giữ 5 ý"]}
    result = Analyzer(fake).analyze(VI_TRANSCRIPT, "Họp", ["An"], "vi", context)
    assert result["engine"] == "ollama:fake-llm"
    assert result["summary"] == ["Ý từ LLM"] and result["action_items"][0]["due"] == ""
    assert result["mindmap"]["children"][0]["children"][0]["title"] == "c"
    prompt = fake.prompts[0]
    for needle in ("Alpha", "Họp cũ", "mẫu", "Giữ 5 ý", "Người tham gia: An"):
        assert needle in prompt


def test_analyzer_falls_back_when_llm_returns_garbage():
    result = Analyzer(FakeOllama([None])).analyze(VI_TRANSCRIPT, "Họp", [], "vi", {})
    assert result["engine"].startswith("heuristic")


def test_long_transcript_is_condensed_first():
    long_text = (VI_TRANSCRIPT + " ") * 40
    fake = FakeOllama([{"notes": ["ghi chú 1", "ghi chú 2"]}] * 3 + [{"summary": ["Tổng hợp"]}])
    result = Analyzer(fake).analyze(long_text, "Họp dài", [], "vi", {})
    assert result["summary"] == ["Tổng hợp"]
    assert len(fake.prompts) >= 3
    assert "Ghi chú rút gọn" in fake.prompts[-1]


def test_answer_uses_snippets():
    fake = FakeOllama([])
    answer = Analyzer(fake).answer("ngân sách?", [{"text": "ngân sách 500 triệu", "payload": {"title": "Họp", "date": "2026-10-01"}}], "vi")
    assert answer == "Trả lời giả" and "500 triệu" in fake.prompts[0]
