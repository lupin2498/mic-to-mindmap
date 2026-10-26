from conftest import VI_TRANSCRIPT

from app.textutil import extract_keywords, split_long, split_sentences, top_sentences, truncate


def test_split_sentences_handles_punctuation_and_newlines():
    sentences = split_sentences("Câu một. Câu hai!\nCâu ba? Câu bốn")
    assert sentences == ["Câu một.", "Câu hai!", "Câu ba?", "Câu bốn"]


def test_split_long_breaks_unpunctuated_transcripts():
    words = " ".join(["từ"] * 30 + ["và"] + ["từ"] * 30)
    parts = split_long(words, max_tokens=28)
    assert len(parts) >= 3
    assert all(len(p.split()) <= 28 for p in parts)


def test_vietnamese_keywords_prefer_compound_phrases():
    keywords = extract_keywords(VI_TRANSCRIPT, limit=6, language="vi")
    assert "sản phẩm mới" in keywords
    assert "khách hàng" in keywords
    # âm tiết lẻ của từ ghép không được chọn làm từ khóa
    assert "phẩm" not in keywords and "cáo" not in keywords


def test_english_keywords():
    text = ("We discussed the launch plan. The launch plan needs budget approval. Marketing will prepare the "
            "campaign and the budget review is on Friday. Marketing owns the campaign.")
    keywords = extract_keywords(text, limit=5, language="en")
    assert keywords[0] == "launch plan"
    assert "budget" in keywords and "marketing" in keywords


def test_top_sentences_keeps_original_order():
    picked = top_sentences(VI_TRANSCRIPT, limit=3)
    assert len(picked) == 3
    positions = [VI_TRANSCRIPT.index(s) for s in picked]
    assert positions == sorted(positions)


def test_truncate_adds_ellipsis_on_word_boundary():
    assert truncate("một hai ba bốn năm", 10) == "một hai…"
    assert truncate("ngắn", 10) == "ngắn"
