"""Tiện ích xử lý văn bản (tiếng Việt + tiếng Anh) không cần thư viện ngoài.

QUAN TRỌNG: các hàm phân tích ở đây có bản JavaScript tương ứng trong app/static/engine.js (chạy trên điện thoại khi
không có máy chủ). Hai bản phải cho kết quả giống hệt nhau: tests/test_engine_parity.py so từng kết quả. Vì vậy mã
được viết theo lối "dễ chuyển ngữ": vòng lặp tường minh, không dựa vào hành vi riêng của Python (str.split() không
tham số, \\b, \\s, sum() trên số thực, round()...). Sửa bên này thì sửa cả bên kia."""
from __future__ import annotations

import math
import re
import unicodedata

from .engine_data import DATA

VI_STOPWORDS = set(DATA["vi_stopwords"])
EN_STOPWORDS = set(DATA["en_stopwords"])
STOPWORDS = VI_STOPWORDS | EN_STOPWORDS

# Từ nối dùng để tách câu quá dài (transcript không có dấu câu)
CONJUNCTIONS = set(DATA["conjunctions"])
GENERIC = set(DATA["generic"])
ABBREVIATIONS = set(DATA["abbreviations"])
HONORIFICS = set(DATA["honorifics"])
PHRASE_EDGE_STOP = set(DATA["phrase_edge_stop"])
COMPOUNDS = set(DATA["vi_lexicon"]) | set(DATA["vi_stop_phrases"])

# Khoảng trắng: đúng tập \s của Python cộng thêm BOM, viết tường minh để JavaScript dùng y hệt
WS_CLASS = "[\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]"
_WS_RE = re.compile(WS_CLASS + "+")
_WS_ONE_RE = re.compile(WS_CLASS)
# Một "từ": dãy chữ cái, cho phép gạch nối/nháy đơn ở giữa (JavaScript: [\p{L}\p{Nl}\p{No}])
_WORD_RE = re.compile(r"[^\W\d_]+(?:[-'’][^\W\d_]+)*", re.UNICODE)
_SENT_END = ".!?…"


def nfc(text: str | None) -> str:
    """Chuẩn hóa Unicode về dạng dựng sẵn (NFC). Văn bản từ macOS/iOS hay ở dạng NFD (dấu tách rời),
    khiến tách từ và so khớp thuật ngữ sai."""
    return unicodedata.normalize("NFC", text) if text else (text or "")


_LONE_SURROGATE_RE = re.compile("[\ud800-\udfff]")
# Sâu hơn mức này không phải dữ liệu thật của ứng dụng (mind map người dùng sửa tối đa 12 cấp)
MAX_JSON_DEPTH = 64


def scrub_text(text: str) -> str:
    """Thay surrogate lẻ (nửa emoji do chuỗi bị cắt giữa chừng, viết thành "\\ud83d" trong JSON) bằng U+FFFD.

    Chuỗi còn surrogate lẻ không mã hóa được sang UTF-8: SQLite từ chối lưu, phản hồi JSON không gửi đi được."""
    return _LONE_SURROGATE_RE.sub("�", text)


def scrub_json(value, _depth: int = 0):
    """Làm sạch dữ liệu vừa đọc từ JSON (thân request hoặc trả lời của LLM): bỏ surrogate lẻ trong mọi chuỗi
    và cắt phần lồng sâu quá MAX_JSON_DEPTH để các bước đệ quy phía sau không tràn ngăn xếp."""
    if isinstance(value, str):
        return scrub_text(value)
    if isinstance(value, (list, dict)):
        if _depth >= MAX_JSON_DEPTH:
            return None
        if isinstance(value, list):
            return [scrub_json(v, _depth + 1) for v in value]
        return {scrub_text(k) if isinstance(k, str) else k: scrub_json(v, _depth + 1) for k, v in value.items()}
    return value


# ------------------------------------------------------------------ cơ bản
def normalize_ws(text: str) -> str:
    return _WS_RE.sub(" ", nfc(text)).strip(" ")


def ws_words(text: str) -> list[str]:
    """Tách theo khoảng trắng, giữ nguyên dấu câu dính vào từ."""
    norm = normalize_ws(text)
    return norm.split(" ") if norm else []


def is_word_char(ch: str) -> bool:
    return ch.isalnum() or ch == "_"


def strip_punct(word: str) -> str:
    """Bỏ ký tự không phải chữ/số ở hai đầu ("(An," -> "An")."""
    start, end = 0, len(word)
    while start < end and not word[start].isalnum():
        start += 1
    while end > start and not word[end - 1].isalnum():
        end -= 1
    return word[start:end]


def tokenize_cased(text: str) -> list[str]:
    return [m.group(0).replace("’", "'") for m in _WORD_RE.finditer(nfc(text))]


def tokenize(text: str) -> list[str]:
    return [t.lower() for t in tokenize_cased(text)]


def content_tokens(text: str) -> list[str]:
    return [t for t in tokenize(text) if t not in STOPWORDS and len(t) > 1]


def capitalize_first(text: str) -> str:
    text = normalize_ws(text)
    return text[:1].upper() + text[1:] if text else text


def truncate(text: str, max_chars: int = 80) -> str:
    text = normalize_ws(text)
    if len(text) <= max_chars:
        return text
    cut = text[:max_chars]
    space = cut.rfind(" ")
    if space >= 0:
        cut = cut[:space]
    return cut.rstrip(",;:") + "…"


def round_half_up(value: float) -> int:
    return int(math.floor(value + 0.5))


# ------------------------------------------------------------- khớp cụm từ
def build_index(phrases: list[list[str]]) -> dict[str, list[list[str]]]:
    """Từ đầu tiên -> các cụm (mỗi cụm là danh sách từ), cụm dài xếp trước."""
    index: dict[str, list[list[str]]] = {}
    for parts in phrases:
        if not parts:
            continue
        bucket = index.get(parts[0])
        if bucket is None:
            bucket = []
            index[parts[0]] = bucket
        bucket.append(parts)
    for key in index:
        index[key].sort(key=lambda parts: -len(parts))
    return index


def match_at(words: list[str], i: int, index: dict[str, list[list[str]]]) -> int:
    """Số từ của cụm dài nhất trong index khớp tại vị trí i (0 nếu không có)."""
    bucket = index.get(words[i])
    if not bucket:
        return 0
    n = len(words)
    for parts in bucket:
        size = len(parts)
        if i + size > n:
            continue
        ok = True
        for k in range(1, size):
            if words[i + k] != parts[k]:
                ok = False
                break
        if ok:
            return size
    return 0


def find_phrase(words: list[str], index: dict[str, list[list[str]]], start: int = 0) -> int:
    """Vị trí đầu tiên (từ start) có một cụm trong index, -1 nếu không có."""
    for i in range(start, len(words)):
        if match_at(words, i, index) > 0:
            return i
    return -1


# ----------------------------------------------------- gộp từ ghép tiếng Việt
def _phrase_table() -> dict[str, list[tuple[list[str], bool]]]:
    """Âm tiết đầu -> [(các âm tiết, là_cụm_hư_từ)], cụm dài trước. Cụm hư từ được ưu tiên khi trùng."""
    table: dict[str, list[tuple[list[str], bool]]] = {}
    seen: set[str] = set()
    for phrases, is_stop in ((DATA["vi_stop_phrases"], True), (DATA["vi_lexicon"], False)):
        for phrase in phrases:
            if phrase in seen:
                continue
            seen.add(phrase)
            parts = phrase.split(" ")
            if len(parts) < 2:
                continue
            bucket = table.get(parts[0])
            if bucket is None:
                bucket = []
                table[parts[0]] = bucket
            bucket.append((parts, is_stop))
    for key in table:
        table[key].sort(key=lambda item: -len(item[0]))
    return table


_PHRASES = _phrase_table()


def segment(tokens: list[str]) -> tuple[list[str], list[bool]]:
    """Gộp các âm tiết thành từ theo từ điển (khớp dài nhất từ trái sang).

    Trả về (từ, cờ nội dung): từ ghép trong từ điển là một từ nội dung ("khách hàng"), cụm hư từ ("chúng ta",
    "tuy nhiên") là một từ không mang nội dung, âm tiết lẻ là nội dung nếu không phải hư từ."""
    words: list[str] = []
    flags: list[bool] = []
    i, n = 0, len(tokens)
    while i < n:
        token = tokens[i]
        size = 0
        is_stop = False
        bucket = _PHRASES.get(token)
        if bucket:
            for parts, stop in bucket:
                length = len(parts)
                if i + length > n:
                    continue
                ok = True
                for k in range(1, length):
                    if tokens[i + k] != parts[k]:
                        ok = False
                        break
                if ok:
                    size, is_stop = length, stop
                    break
        if size:
            words.append(" ".join(tokens[i:i + size]))
            flags.append(not is_stop)
            i += size
        else:
            words.append(token)
            flags.append(token not in STOPWORDS and len(token) > 1)
            i += 1
    return words, flags


def segment_phrases(phrases: list[str]) -> dict[str, list[list[str]]]:
    """Chỉ mục khớp cụm ở mức TỪ (sau khi gộp từ ghép), để "cần" không khớp nhầm trong "cần thiết"."""
    return build_index([segment(phrase.split(" "))[0] for phrase in phrases])


# ------------------------------------------------------------------ tách câu
_MARKERS = build_index([m.split(" ") for m in DATA["discourse_markers"]])


def split_long(sentence: str, max_tokens: int = 28) -> list[str]:
    """Tách một 'câu' quá dài (thường do transcript không có dấu câu) thành các mệnh đề ngắn hơn."""
    words = ws_words(sentence)
    if len(words) <= max_tokens:
        return [sentence]
    bare = [strip_punct(w).lower() for w in words]
    total = len(words)
    half = max_tokens // 2
    soft = max_tokens // 4 + 1
    parts: list[str] = []
    current: list[str] = []
    for i in range(total):
        if current and len(current) >= soft:
            # ưu tiên ngắt ở dấu phẩy/chấm phẩy, rồi tới cụm mở ý mới ("ngoài ra", "tiếp theo"), sau cùng là từ nối
            after_comma = words[i - 1][-1:] in (",", ";")
            joined = (bare[i - 1] + " " + bare[i]) in COMPOUNDS
            if after_comma or (not joined and (match_at(bare, i, _MARKERS) > 0
                                               or (len(current) >= half and bare[i] in CONJUNCTIONS))):
                parts.append(" ".join(current))
                current = []
        current.append(words[i])
        if len(current) >= max_tokens:
            # buộc phải cắt: đừng cắt ngang một từ ghép ("trực | tiếp")
            if i + 1 < total and len(current) > 1 and (bare[i] + " " + bare[i + 1]) in COMPOUNDS:
                parts.append(" ".join(current[:len(current) - 1]))
                current = [words[i]]
            else:
                parts.append(" ".join(current))
                current = []
    if current:
        parts.append(" ".join(current))
    return parts


def split_raw_sentences(text: str) -> list[str]:
    """Tách theo dấu kết câu (. ! ? …) có khoảng trắng theo sau và theo dấu xuống dòng."""
    out: list[str] = []
    n = len(text)
    start = 0
    i = 0
    while i < n:
        ch = text[i]
        cut = -1
        if ch == "\n":
            cut = i
        elif ch in _SENT_END and i + 1 < n and _WS_ONE_RE.match(text[i + 1]):
            cut = i + 1
            if ch == ".":
                # "TP. Hồ Chí Minh", "Mr. An": dấu chấm của chữ viết tắt không kết câu
                j = i
                while j > start and text[j - 1].isalpha():
                    j -= 1
                if text[j:i].lower() in ABBREVIATIONS and (j == start or not is_word_char(text[j - 1])):
                    cut = -1
        if cut < 0:
            i += 1
            continue
        piece = normalize_edges(text[start:cut])
        if piece:
            out.append(piece)
        i = cut
        while i < n and _WS_ONE_RE.match(text[i]):
            i += 1
        start = i
    piece = normalize_edges(text[start:])
    if piece:
        out.append(piece)
    return out


def normalize_edges(text: str) -> str:
    """Bỏ khoảng trắng hai đầu (không đụng tới bên trong, để câu vẫn là một đoạn nguyên văn của transcript)."""
    start, end = 0, len(text)
    while start < end and _WS_ONE_RE.match(text[start]):
        start += 1
    while end > start and _WS_ONE_RE.match(text[end - 1]):
        end -= 1
    return text[start:end]


def split_sentences(text: str, max_tokens: int = 28) -> list[str]:
    text = text or ""
    sentences: list[str] = []
    for raw in split_raw_sentences(text):
        for part in split_long(raw, max_tokens=max_tokens):
            if part:
                sentences.append(part)
    return sentences


# -------------------------------------------------------------- câu đã phân tích
class Sentence:
    """Một câu kèm các dạng tách từ dùng lại nhiều lần."""

    __slots__ = ("idx", "text", "cased", "tokens", "words", "flags", "content", "cset", "ntok", "score",
                 "question", "greeting", "decision", "action", "owner", "due", "has_number", "repeat")

    def __init__(self, idx: int, text: str):
        self.idx = idx
        self.text = text
        self.cased = tokenize_cased(text)
        self.tokens = [t.lower() for t in self.cased]
        self.words, self.flags = segment(self.tokens)
        self.content = [w for w, flag in zip(self.words, self.flags) if flag]
        self.cset = set(self.content)
        self.ntok = len(self.tokens)
        self.score = 0.0
        self.question = False
        self.greeting = False
        self.decision = False
        self.action = False
        self.owner = ""
        self.due = ""
        self.has_number = False
        self.repeat = False


def analyze_sentences(text: str) -> list[Sentence]:
    sentences = [Sentence(i, s) for i, s in enumerate(split_sentences(nfc(text)))]
    # câu lặp lại nguyên văn (người nói nhắc lại, transcript bị dán hai lần): chỉ tính lần đầu
    seen: set[str] = set()
    for sentence in sentences:
        key = " ".join(sentence.tokens)
        if key in seen:
            sentence.repeat = True
        else:
            seen.add(key)
    return sentences


def contains_words(words: list[str], parts: list[str]) -> bool:
    size = len(parts)
    if size == 0:
        return False
    for i in range(len(words) - size + 1):
        ok = True
        for k in range(size):
            if words[i + k] != parts[k]:
                ok = False
                break
        if ok:
            return True
    return False


def contains_phrase(sentence: str, phrase: str) -> bool:
    return contains_words(tokenize(sentence), tokenize(phrase))


# ------------------------------------------------------------------ từ khóa
class KeyStats:
    """Thống kê cụm từ nội dung: số lần xuất hiện, vị trí đầu, số từ, số lần đứng riêng, số lần viết hoa giữa câu."""

    def __init__(self) -> None:
        self.count: dict[str, int] = {}
        self.first: dict[str, int] = {}
        self.parts: dict[str, list[str]] = {}
        self.standalone: dict[str, int] = {}
        self.proper: dict[str, int] = {}
        self.order = 0

    def add(self, parts: list[str]) -> str:
        phrase = " ".join(parts)
        if phrase in self.count:
            self.count[phrase] += 1
        else:
            self.count[phrase] = 1
            self.first[phrase] = self.order
            self.parts[phrase] = parts
            self.order += 1
        return phrase


def keyphrase_stats(sentences: list[Sentence]) -> KeyStats:
    """Đếm từ đơn, cụm 2 và 3 từ nội dung đứng liền nhau trong cùng một câu (không vượt qua hư từ)."""
    stats = KeyStats()
    for sentence in sentences:
        words, flags = sentence.words, sentence.flags
        n = len(words)
        # vị trí âm tiết đầu của từng từ, để biết từ đó có viết hoa giữa câu không (tên riêng, tên sản phẩm)
        offset = 0
        for i in range(n):
            word = words[i]
            size = word.count(" ") + 1
            # "chị lan", "anh hùng": âm tiết ngay sau từ xưng hô là tên người, không phải chủ đề
            named = i > 0 and size == 1 and words[i - 1] in HONORIFICS
            if flags[i] and not named:
                stats.add([word])
                left = flags[i - 1] if i > 0 else False
                right = flags[i + 1] if i + 1 < n else False
                if left and i > 1 and words[i - 2] in HONORIFICS and " " not in words[i - 1]:
                    left = False  # từ đứng trước là tên người
                if not left and not right:
                    stats.standalone[word] = stats.standalone.get(word, 0) + 1
                if offset > 0 and sentence.cased[offset][:1].isupper():
                    stats.proper[word] = stats.proper.get(word, 0) + 1
                if right:
                    stats.add([word, words[i + 1]])
                    if i + 2 < n and flags[i + 2]:
                        stats.add([word, words[i + 1], words[i + 2]])
            offset += size
    return stats


def pick_keywords(stats: KeyStats, title: str = "", language: str = "vi", limit: int = 10,
                  exclude: set[str] | None = None) -> list[str]:
    """Chọn cụm từ khóa: ưu tiên cụm lặp lại, bỏ mảnh vụn nằm trọn trong cụm dài hơn, bỏ từ quá chung chung.

    exclude: các từ không được làm từ khóa (tên người tham gia, tên người phụ trách)."""
    if not stats.count or limit <= 0:
        return []
    vietnamese = language.lower().startswith("vi")
    count = stats.count
    exclude = exclude or set()
    # cụm ngắn gần như luôn đi trong một cụm dài hơn ("kế hoạch" trong "kế hoạch ra mắt") thì nhường cho cụm dài
    nested: set[str] = set()
    for phrase, parts in stats.parts.items():
        size = len(parts)
        if size < 2 or count[phrase] < 2:
            continue
        subs = [[parts[0]], [parts[size - 1]]]
        if size == 3:
            subs += [[parts[1]], [parts[0], parts[1]], [parts[1], parts[2]]]
        for sub in subs:
            key = " ".join(sub)
            if key in count and count[phrase] * 5 >= count[key] * 4:
                nested.add(key)
    # âm tiết lẻ hầu như chỉ xuất hiện trong vài cụm hai từ ("pha" trong "pha sáng", "pha tối"): nhường cho các cụm đó
    covered: dict[str, int] = {}
    for phrase, parts in stats.parts.items():
        if len(parts) == 2 and count[phrase] >= 2:
            for part in parts:
                covered[part] = covered.get(part, 0) + count[phrase]
    for word, total in covered.items():
        if " " not in word and word in count and total * 5 >= count[word] * 4:
            nested.add(word)
    title_words = segment(tokenize(title))[0] if title else []
    candidates: list[tuple[float, int, str]] = []
    fallback: list[tuple[int, str]] = []
    for phrase, parts in stats.parts.items():
        size = len(parts)
        times = count[phrase]
        all_generic = True
        excluded = False
        for part in parts:
            if part not in GENERIC:
                all_generic = False
            if part in exclude:
                excluded = True
        if all_generic or excluded:
            continue
        if size == 1:
            compound = " " in phrase
            if not compound and len(phrase) <= 2:
                continue
            proper = stats.proper.get(phrase, 0)
            if times < 2:
                # văn bản ngắn hầu như không có gì lặp lại: giữ từ ghép/tên riêng làm ứng viên dự phòng
                if compound or proper > 0:
                    fallback.append((stats.first[phrase], phrase))
                continue
            if vietnamese and not compound and proper == 0:
                if stats.standalone.get(phrase, 0) * 3 < times:
                    continue  # hiếm khi đứng riêng: nhiều khả năng chỉ là một âm tiết của từ ghép chưa có trong từ điển
                if times < 3 and not phrase.isascii():
                    continue  # âm tiết tiếng Việt lẻ thường là động từ/tính từ; từ mượn ("demo", "tiktok") thì giữ
            score = times * (1.3 if compound else 1.0)
            if proper > 0:
                score *= 1.2
        else:
            if times < 2 or parts[0] in PHRASE_EDGE_STOP or parts[size - 1] in PHRASE_EDGE_STOP:
                continue
            score = times * (1.0 + 0.5 * (size - 1))
        if phrase in nested:
            continue
        if title_words and contains_words(title_words, parts):
            score *= 1.3
        candidates.append((score, stats.first[phrase], phrase))
    candidates.sort(key=lambda item: (-item[0], item[1]))
    chosen: list[str] = []
    used: set[str] = set()
    for _, _, phrase in candidates:
        parts = stats.parts[phrase]
        clash = False
        for part in parts:
            if part in used:
                clash = True
                break
        if not clash:
            # không lấy cả cụm lẫn cụm con của nó ("đặt lịch" và "phần đặt lịch")
            for other in chosen:
                other_parts = stats.parts[other]
                if contains_words(parts, other_parts) or contains_words(other_parts, parts):
                    clash = True
                    break
        if clash:
            continue
        chosen.append(phrase)
        for part in parts:
            # âm tiết đã nhường cho cụm và từ chung chung không chặn cụm khác ("pha sáng" không chặn "pha tối")
            if len(parts) == 1 or (part not in nested and part not in GENERIC):
                used.add(part)
        if len(chosen) >= limit:
            return chosen
    if len(chosen) < 3:
        fallback.sort(key=lambda item: item[0])
        for _, phrase in fallback:
            if phrase in used or phrase in nested:
                continue
            chosen.append(phrase)
            used.add(phrase)
            if len(chosen) >= min(limit, 5):
                break
    return chosen


def extract_keywords(text: str, limit: int = 10, language: str = "vi") -> list[str]:
    """Trích từ khóa: ưu tiên cụm từ lặp lại, sau đó đến từ đơn."""
    return pick_keywords(keyphrase_stats(analyze_sentences(text)), "", resolve_language(language, text), limit)


# --------------------------------------------------------------- chấm điểm câu
def score_sentences(sentences: list[Sentence], stats: KeyStats, keywords: list[str]) -> None:
    """Điểm nội dung của từng câu: từ càng hay được nhắc và càng chứa cụm từ khóa thì điểm càng cao."""
    max_count = 0
    for phrase, parts in stats.parts.items():
        if len(parts) == 1 and stats.count[phrase] > max_count:
            max_count = stats.count[phrase]
    keyword_parts = [stats.parts[k] for k in keywords if k in stats.parts]
    for sentence in sentences:
        if sentence.ntok < 4 or max_count == 0:
            sentence.score = 0.0
            continue
        total = 0.0
        for word in sentence.content:
            total += stats.count.get(word, 0) / max_count
        for parts in keyword_parts:
            if contains_words(sentence.words, parts):
                total += 0.8
        sentence.score = total / math.sqrt(sentence.ntok)


def top_sentences(text: str, limit: int | None = None) -> list[str]:
    sentences = analyze_sentences(text)
    if not sentences:
        return []
    if limit is None:
        limit = max(3, min(8, len(sentences) // 6 + 2))
    stats = keyphrase_stats(sentences)
    score_sentences(sentences, stats, pick_keywords(stats))
    ranked = [s for s in sentences if s.ntok >= 4 and not s.repeat]
    ranked.sort(key=lambda s: (-s.score, s.idx))
    best = ranked[:limit]
    best.sort(key=lambda s: s.idx)
    return [s.text for s in best]


# ------------------------------------------------------------ nhận ngôn ngữ
_VI_LETTERS = set("ăâđêôơưĂÂĐÊÔƠƯ")


def detect_language(text: str, default: str = "vi") -> str:
    """vi nếu văn bản có chữ cái riêng của tiếng Việt, en nếu toàn chữ Latinh không dấu, mặc định khi không có chữ."""
    letters = 0
    vietnamese = 0
    for ch in text[:4000]:
        if ch.isalpha():
            letters += 1
            if ch in _VI_LETTERS or "Ạ" <= ch <= "ỹ":
                vietnamese += 1
    if letters == 0:
        return default
    return "vi" if vietnamese * 50 >= letters else "en"


def resolve_language(language: str | None, text: str) -> str:
    lang = normalize_edges(language or "").lower()
    if lang.startswith("vi"):
        return "vi"
    if lang.startswith("en"):
        return "en"
    return detect_language(text)
