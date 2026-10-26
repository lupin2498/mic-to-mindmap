"""Tiện ích xử lý văn bản (tiếng Việt + tiếng Anh) không cần thư viện ngoài."""
from __future__ import annotations

import math
import re
from collections import Counter
from typing import Iterable

VI_STOPWORDS = set(
    """
    và là của có được cho trong này đó với các những một để thì mà cũng như khi đã sẽ đang về ra vào lên xuống
    tôi bạn anh chị em chúng ta mình họ nó ở từ đến nhưng hay hoặc nếu vì nên bị rất lại còn chỉ đều cái gì
    không chưa ạ à ừ ờ nhé nhỉ thôi đấy đây kia ấy rồi vậy thế nào sao bao nhiêu mấy theo trên dưới sau trước
    giữa ngoài bên cả mỗi từng nữa luôn hơn nhất quá lắm thật vẫn đi làm nói biết thấy ok okay dạ vâng ừm um uh
    ờm kiểu tức chứ bởi tại nọ dụ thực chung bản hiện giờ hôm nay mọi người bọn mình các bạn ông bà cô chú
    cậu mợ việc điều thứ lúc thời khoảng chút ít nhiều hết xong đó đâu đây hả hử ha hà ơi này ấy ấy à ừ ờ
    cái đó cái này mấy cái một số các thứ đại khái đại loại túm lại nói chung nhìn chung thật ra thực ra
    """.split()
)

EN_STOPWORDS = set(
    """
    a an the and or but if then so of to in on at for with by from as is are was were be been being am
    do does did done have has had having i you he she it we they me him her us them my your his its our
    their this that these those there here what which who whom whose when where why how all any both each
    few more most other some such no nor not only own same than too very can will just should would could
    may might must shall also about into over after before again further once up down out off under
    yeah yes okay ok um uh like well right actually basically literally kind sort gonna wanna
    """.split()
)

STOPWORDS = VI_STOPWORDS | EN_STOPWORDS

# Từ nối dùng để tách câu quá dài (transcript không có dấu câu)
CONJUNCTIONS = {"và", "nhưng", "thì", "nên", "rồi", "sau", "tiếp", "ngoài", "còn", "tuy", "vì", "nếu",
                "and", "but", "so", "then", "also", "because", "however"}

_WORD_RE = re.compile(r"[^\W\d_]+(?:[-'][^\W\d_]+)*", re.UNICODE)
_SENT_SPLIT_RE = re.compile(r"(?<=[.!?…])\s+|\n+")


def normalize_ws(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def tokenize(text: str) -> list[str]:
    return [m.group(0).lower() for m in _WORD_RE.finditer(text or "")]


def content_tokens(text: str) -> list[str]:
    return [t for t in tokenize(text) if t not in STOPWORDS and len(t) > 1]


def split_long(sentence: str, max_tokens: int = 28) -> list[str]:
    """Tách một 'câu' quá dài (thường do transcript không có dấu câu) thành các mệnh đề ngắn hơn."""
    words = sentence.split()
    if len(words) <= max_tokens:
        return [sentence]
    parts: list[str] = []
    current: list[str] = []
    for word in words:
        bare = word.lower().strip(",;:")
        if current and len(current) >= max_tokens // 2 and bare in CONJUNCTIONS:
            parts.append(" ".join(current))
            current = []
        current.append(word)
        if len(current) >= max_tokens:
            parts.append(" ".join(current))
            current = []
    if current:
        parts.append(" ".join(current))
    return [p for p in parts if p]


def split_sentences(text: str, max_tokens: int = 28) -> list[str]:
    text = (text or "").strip()
    if not text:
        return []
    raw = [s.strip() for s in _SENT_SPLIT_RE.split(text) if s and s.strip()]
    sentences: list[str] = []
    for s in raw:
        sentences.extend(split_long(s, max_tokens=max_tokens))
    return sentences


def truncate(text: str, max_chars: int = 80) -> str:
    text = normalize_ws(text)
    if len(text) <= max_chars:
        return text
    cut = text[:max_chars].rsplit(" ", 1)[0]
    return cut.rstrip(",;:") + "…"


def keyword_scores(text: str) -> tuple[Counter, Counter, Counter, Counter]:
    """Trả về (unigram, bigram, trigram, standalone) counter đã loại stopword.

    n-gram không vượt qua ranh giới câu. `standalone` đếm số lần một từ đơn xuất hiện
    mà không đứng cạnh từ nội dung nào khác (dấu hiệu nó là một từ độc lập, không phải
    một âm tiết của từ ghép tiếng Việt).
    """
    unigrams: Counter = Counter()
    bigrams: Counter = Counter()
    trigrams: Counter = Counter()
    standalone: Counter = Counter()
    for sentence in split_sentences(text, max_tokens=10_000):
        tokens = tokenize(sentence)
        content = [t not in STOPWORDS and len(t) > 1 for t in tokens]
        for i, tok in enumerate(tokens):
            if not content[i]:
                continue
            unigrams[tok] += 1
            left = content[i - 1] if i > 0 else False
            right = content[i + 1] if i + 1 < len(tokens) else False
            if not left and not right:
                standalone[tok] += 1
            if right:
                bigrams[f"{tok} {tokens[i + 1]}"] += 1
                if i + 2 < len(tokens) and content[i + 2]:
                    trigrams[f"{tok} {tokens[i + 1]} {tokens[i + 2]}"] += 1
    return unigrams, bigrams, trigrams, standalone


def extract_keywords(text: str, limit: int = 10, language: str = "vi") -> list[str]:
    """Trích từ khóa: ưu tiên cụm từ (2-3 âm tiết) lặp lại, sau đó đến từ đơn."""
    unigrams, bigrams, trigrams, standalone = keyword_scores(text)
    if not unigrams:
        return []
    lowered = text.lower()
    vietnamese = language.lower().startswith("vi")
    candidates: list[tuple[float, int, int, str]] = []  # (-score, -độ dài, vị trí, cụm)
    for phrase, count in trigrams.items():
        if count >= 2:
            candidates.append((-(count * 2.0 + 0.5), -3, lowered.find(phrase), phrase))
    for phrase, count in bigrams.items():
        if count >= 2:
            candidates.append((-(count * 1.6 + 0.5), -2, lowered.find(phrase), phrase))
    for word, count in unigrams.items():
        if count < 2 or len(word) <= 2:
            continue
        if vietnamese and standalone[word] == 0 and count < 3:
            continue  # nhiều khả năng chỉ là một âm tiết của từ ghép
        candidates.append((-float(count), -1, lowered.find(word), word))
    candidates.sort()
    chosen: list[str] = []
    chosen_tokens: set[str] = set()
    for _, _, _, phrase in candidates:
        parts = phrase.split()
        if len(parts) == 1:
            if phrase in chosen_tokens:
                continue
        elif any(p in chosen_tokens for p in parts):
            continue
        chosen.append(phrase)
        chosen_tokens.update(parts)
        if len(chosen) >= limit:
            break
    return chosen


def score_sentences(sentences: Iterable[str], text: str) -> list[tuple[int, float, str]]:
    unigrams, bigrams, _, _ = keyword_scores(text)
    if not unigrams:
        return []
    max_uni = max(unigrams.values())
    scored: list[tuple[int, float, str]] = []
    for idx, sentence in enumerate(sentences):
        toks = tokenize(sentence)
        content = [t for t in toks if t in unigrams]
        if len(toks) < 4:
            continue
        score = sum(unigrams[t] / max_uni for t in content)
        for i in range(len(toks) - 1):
            pair = f"{toks[i]} {toks[i + 1]}"
            if bigrams.get(pair, 0) >= 2:
                score += 0.8
        score /= math.sqrt(len(toks))
        scored.append((idx, score, sentence))
    return scored


def top_sentences(text: str, limit: int | None = None) -> list[str]:
    sentences = split_sentences(text)
    if not sentences:
        return []
    if limit is None:
        limit = max(3, min(8, len(sentences) // 6 + 2))
    scored = score_sentences(sentences, text)
    best = sorted(scored, key=lambda item: -item[1])[:limit]
    best.sort(key=lambda item: item[0])
    return [s for _, _, s in best]


def contains_phrase(sentence: str, phrase: str) -> bool:
    toks = tokenize(sentence)
    parts = phrase.split()
    n = len(parts)
    if n == 1:
        return parts[0] in toks
    return any(toks[i:i + n] == parts for i in range(len(toks) - n + 1))


def capitalize_first(text: str) -> str:
    text = normalize_ws(text)
    return text[:1].upper() + text[1:] if text else text
