"""Bộ máy phân tích KHÔNG cần AI: tóm tắt trích xuất, quyết định, việc cần làm, sơ đồ tư duy.

Chỉ dùng thống kê từ và luật ngôn ngữ (từ điển từ ghép, từ gợi ý, mẫu ngày tháng), nên chạy tức thì trên mọi máy.
Bản JavaScript tương ứng nằm ở app/static/engine.js và phải cho kết quả giống hệt (xem ghi chú đầu textutil.py)."""
from __future__ import annotations

import math
import re

from .engine_data import DATA
from .mindmap import normalize_mindmap
from .textutil import (
    COMPOUNDS,
    GENERIC,
    HONORIFICS,
    STOPWORDS,
    Sentence,
    analyze_sentences,
    build_index,
    capitalize_first,
    contains_words,
    find_phrase,
    is_word_char,
    keyphrase_stats,
    match_at,
    nfc,
    normalize_ws,
    pick_keywords,
    resolve_language,
    round_half_up,
    score_sentences,
    segment_phrases,
    strip_punct,
    truncate,
    ws_words,
)

LABELS = DATA["labels"]

# Từ gợi ý, so ở mức TỪ sau khi gộp từ ghép ("cần" không khớp trong "cần thiết", "phải" không khớp trong "không phải")
_DECISION = segment_phrases(DATA["decision_cues"])
_ACTION_STRONG = segment_phrases(DATA["action_strong"])
_ACTION_WEAK = segment_phrases(DATA["action_weak"])
_GREETING = segment_phrases(DATA["greeting_cues"])
_INTRO = segment_phrases(DATA["intro_cues"])
_CONCLUSION = segment_phrases(DATA["conclusion_cues"])
_IMPORTANCE = segment_phrases(DATA["importance_cues"])
_QUESTION_STARTS = segment_phrases(DATA["question_starts"])
_QUESTION_ENDS = segment_phrases(DATA["question_ends"])
NEGATIONS = set(DATA["negations"])


def _plain_index(key: str) -> dict[str, list[list[str]]]:
    """Chỉ mục so trên các từ tách theo khoảng trắng (đã bỏ dấu câu, chữ thường)."""
    return build_index([phrase.split(" ") for phrase in DATA[key]])


_OWNER_VERBS = _plain_index("owner_verbs")
_MODALS = _plain_index("modals")
_ORG_UNITS = _plain_index("org_units")
_SUBJECTS = _plain_index("subject_pronouns")
_LEAD = _plain_index("lead_fillers")
_TRAIL = _plain_index("trail_particles")
_DECISION_SUBJECTS = _plain_index("decision_subjects")
_DECISION_VERBS = _plain_index("decision_verbs")
_DECISION_LEAD = _plain_index("decision_lead")
_TOPIC_INTRO = _plain_index("topic_intro")
TITLE_SKIP = set(DATA["title_skip"])
ORG_SUFFIXES = set(DATA["org_suffixes"])
DONE_MARKERS = set(DATA["done_markers"])
PENDING_NEAR = set(DATA["pending_near"])
PENDING_FAR = set(DATA["pending_far"])
AGREEMENT_FOLLOWERS = set(DATA["agreement_followers"])
METRIC_UNITS = set(DATA["metric_units"])
GAP_WORDS = set(DATA["gap_words"])
NOT_NAMES = set(DATA["not_names"])
NOT_NAMES_AFTER_HONORIFIC = set(DATA["not_names_after_honorific"])
STUTTER = set(DATA["stutter_words"])
DUE_PREPOSITIONS = set(DATA["due_prepositions"])

_DUE_RE = re.compile("|".join("(?:" + pattern + ")" for pattern in DATA["due_patterns"]))
# "thứ hai", "thứ ba"... đứng đầu câu hoặc trước "là" nghĩa là "điều thứ hai", không phải ngày trong tuần
_ORDINAL_DAYS = {"thứ hai", "thứ ba", "thứ tư", "thứ năm", "thứ sáu", "thứ bảy"}
_TERMINAL = ".,;:… "
_CLOSERS = "\"'”’)]»"

MAX_SUMMARY = 12
MAX_DECISIONS = 6
SUMMARY_CHARS = 180
ITEM_CHARS = 160
LEAF_CHARS = 80
TITLE_CHARS = 60


def _dedupe(items: list, key=lambda item: item) -> list:
    seen: set[str] = set()
    out = []
    for item in items:
        k = normalize_ws(str(key(item))).lower()
        if not k or k in seen:
            continue
        seen.add(k)
        out.append(item)
    return out


# ------------------------------------------------------------- làm gọn câu
def strip_terminal(text: str) -> str:
    """Bỏ dấu chấm, phẩy... ở cuối (giữ ? và !)."""
    end = len(text)
    while end > 0 and text[end - 1] in _TERMINAL:
        end -= 1
    return text[:end]


def clean_sentence(sentence: str) -> str:
    """Bỏ từ đệm của lời nói ở đầu/cuối câu ("à thì", "nhé mọi người"), gộp từ nói vấp, viết hoa chữ đầu."""
    words = ws_words(sentence)
    n = len(words)
    if n == 0:
        return ""
    low = [strip_punct(w).lower() for w in words]
    start = 0
    for _ in range(6):
        size = match_at(low, start, _LEAD)
        if size == 0 or start + size >= n:
            break
        # "thế giới", "là do"...: âm tiết trông như từ đệm nhưng thật ra mở đầu một từ ghép
        if size == 1 and (low[start] + " " + low[start + 1]) in COMPOUNDS:
            break
        start += size
    end = n
    last = words[n - 1]
    k = len(last)
    while k > 0 and last[k - 1] in ".!?…":
        k -= 1
    tail = last[k:]
    for _ in range(3):
        cut = 0
        for size in (3, 2, 1):
            i = end - size
            if i < start + 3:
                continue  # chừa lại ít nhất ba từ
            if match_at(low, i, _TRAIL) == size:
                cut = size
                break
        if cut == 0:
            break
        end -= cut
    kept = words[start:end]
    if end < n:
        kept[len(kept) - 1] = kept[len(kept) - 1].rstrip(",;:") + tail
    out: list[str] = []
    previous = ""
    for word in kept:
        bare = strip_punct(word).lower()
        if out and bare and bare == previous and bare in STUTTER and strip_punct(out[len(out) - 1]) == out[len(out) - 1]:
            continue
        out.append(word)
        previous = bare
    return capitalize_first(" ".join(out))


# ------------------------------------------------------------------ hạn chót
def find_due(sentence: str) -> str:
    text = normalize_ws(sentence)
    low = text.lower()
    same = len(low) == len(text)
    for match in _DUE_RE.finditer(low):
        start, end = match.start(), match.end()
        if start == end:
            continue
        if start > 0 and is_word_char(low[start - 1]):
            continue
        if end < len(low) and is_word_char(low[end]):
            continue
        found = low[start:end]
        if found in _ORDINAL_DAYS and (start == 0 or low[end:end + 3] == " là"):
            continue
        return text[start:end] if same else found
    return ""


# ----------------------------------------------------------- người phụ trách
def _is_name_token(token: str) -> bool:
    return len(token) >= 2 and token[0].isupper() and token.replace(".", "").replace("-", "").isalpha()


def locate_owner(sentence: str, participants: list[str]) -> tuple[str, str, bool]:
    """(người phụ trách, loại, chắc chắn).

    loại: "participant" (có trong danh sách người tham gia), "org" (bộ phận/nhóm), "name" (tên riêng), "" (không có).
    chắc chắn: tên đứng ngay trước động từ giao việc ("An sẽ...", "em Minh thì cần...")."""
    words = ws_words(sentence)
    n = len(words)
    if n == 0:
        return "", "", False
    bare = [strip_punct(w) for w in words]
    low = [b.lower() for b in bare]
    verb_at = -1
    for i in range(n):
        if match_at(low, i, _OWNER_VERBS) > 0:
            verb_at = i
            break
    # tên có thể cách động từ một từ đệm: "em Minh thì cần ..."
    name_end = verb_at
    if verb_at >= 2 and low[verb_at - 1] in GAP_WORDS:
        name_end = verb_at - 1
    # 1) Người tham gia được nêu tên: lấy tên đứng gần nhất phía trước động từ giao việc, không có thì tên nhắc đầu tiên
    before_pos, before_size, before_name = -1, 0, ""
    first_pos, first_size, first_name = -1, 0, ""
    for name in participants:
        label = normalize_ws(name)
        parts = [p for p in [strip_punct(w).lower() for w in ws_words(label)] if p]
        size = len(parts)
        if size == 0:
            continue
        for i in range(n - size + 1):
            ok = True
            for k in range(size):
                if low[i + k] != parts[k]:
                    ok = False
                    break
            if not ok:
                continue
            # "phương án", "chi nhánh": trùng tên người tham gia nhưng là một phần của từ ghép
            if i + size < n and (low[i + size - 1] + " " + low[i + size]) in COMPOUNDS:
                continue
            if i > 0 and (low[i - 1] + " " + low[i]) in COMPOUNDS:
                continue
            if first_pos < 0 or i < first_pos or (i == first_pos and size > first_size):
                first_pos, first_size, first_name = i, size, label
            if verb_at >= 0 and i < verb_at and (i > before_pos or (i == before_pos and size > before_size)):
                before_pos, before_size, before_name = i, size, label
    if before_pos >= 0:
        return before_name, "participant", before_pos + before_size == name_end
    if first_pos >= 0:
        return first_name, "participant", False
    if verb_at <= 0:
        return "", "", False
    # 2) Đơn vị/nhóm: "bộ phận marketing cần...", "phòng kế toán sẽ...", "the marketing team should..."
    for j in range(max(0, name_end - 5), name_end):
        size = match_at(low, j, _ORG_UNITS)
        if size == 0:
            continue
        rest = name_end - (j + size)
        if rest < 1 or rest > 3:
            continue
        if j > 0 and low[j - 1] not in STOPWORDS and low[j - 1] not in NOT_NAMES and words[j - 1][-1:] not in (",", ";", ":", "."):
            continue  # "văn phòng công ty": chữ "phòng" ở đây không mở đầu tên đơn vị
        ok = True
        for k in range(j + size, name_end):
            word = low[k]
            if not word or word in NOT_NAMES or word in GENERIC or word in STOPWORDS or word in HONORIFICS:
                ok = False
                break
        if ok:
            return capitalize_first(" ".join(bare[j:name_end])), "org", True
    if name_end >= 2 and low[name_end - 1] in ORG_SUFFIXES:
        j = name_end - 2
        if low[j] and low[j] not in STOPWORDS and low[j] not in NOT_NAMES:
            if j >= 1 and low[j - 1] and low[j - 1] not in STOPWORDS and low[j - 1] not in NOT_NAMES:
                j -= 1
            return capitalize_first(" ".join(bare[j:name_end])), "org", True
    # 3) Tên riêng viết hoa đứng ngay trước động từ giao việc ở đầu mệnh đề (vd: "An sẽ ...", "Sau đó Bình sẽ ...")
    if verb_at <= 7:
        name: list[str] = []
        k = name_end - 1
        while k >= 0 and len(name) < 3:
            token = words[k].strip(",;:")
            # str.isupper thay cho dải ký tự [À-Ỹ]: dải đó chứa cả chữ thường như "đ", "ó"
            if not _is_name_token(token):
                break
            name.insert(0, token)
            k -= 1
        if name:
            honorific = name[0].rstrip(".").lower() in HONORIFICS
            core = name[1:] if honorific else name
            valid = len(core) > 0
            for part in core:
                if part.lower() in NOT_NAMES:
                    valid = False
                    break
            if valid:
                return " ".join(name), "name", True
    # 4) Xưng hô + tên viết thường (văn bản nhận dạng giọng nói thường không viết hoa): "anh an sẽ ..."
    for size in (2, 1):
        h = name_end - size - 1
        if h < 0 or low[h] not in HONORIFICS:
            continue
        ok = True
        for k in range(h + 1, name_end):
            word = low[k]
            if (len(word) < 2 or not word.isalpha() or word in NOT_NAMES_AFTER_HONORIFIC or word in NOT_NAMES
                    or word in HONORIFICS):
                ok = False
                break
        if ok:
            return bare[h] + " " + " ".join([capitalize_first(bare[k]) for k in range(h + 1, name_end)]), "name", True
    return "", "", False


def find_owner(sentence: str, participants: list[str]) -> str:
    return locate_owner(sentence, participants)[0]


# ------------------------------------------------------------- phân loại câu
def _negated(words: list[str], pos: int, reach: int) -> bool:
    for k in range(pos - 1, pos - 1 - reach, -1):
        if k >= 0 and words[k].split(" ")[0] in NEGATIONS:
            return True
    return False


def _nobody(words: list[str], pos: int) -> bool:
    """"chưa có ai <làm>", "không ai <làm>": chưa có người nhận việc."""
    if pos < 2 or words[pos - 1] != "ai":
        return False
    k = pos - 2
    if words[k] == "có" and k > 0:
        k -= 1
    return words[k].split(" ")[0] in NEGATIONS


def _is_question(sentence: Sentence) -> bool:
    text = sentence.text
    end = len(text)
    while end > 0 and text[end - 1] in _CLOSERS:
        end -= 1
    if end > 0 and text[end - 1] == "?":
        return True
    words = sentence.words
    n = len(words)
    if n == 0:
        return False
    if match_at(words, 0, _QUESTION_STARTS) > 0:
        return True
    for i in range(max(0, n - 3), n):
        size = match_at(words, i, _QUESTION_ENDS)
        if size > 0 and i + size == n:
            return True
    return False


def _preceded(words: list[str], pos: int, reach: int, markers: set[str]) -> bool:
    for k in range(pos - 1, pos - 1 - reach, -1):
        if k >= 0 and words[k].split(" ")[0] in markers:
            return True
    return False


def _is_decision(sentence: Sentence) -> bool:
    if sentence.question or sentence.greeting or sentence.ntok < 5:
        return False
    words = sentence.words
    n = len(words)
    for i in range(n):
        size = match_at(words, i, _DECISION)
        if size == 0 or _negated(words, i, 2):
            continue
        # "cần giám đốc phê duyệt", "sẽ quyết định sau": việc còn treo, chưa phải quyết định
        if _preceded(words, i, 1, PENDING_NEAR) or _preceded(words, i, 3, PENDING_FAR):
            continue
        # "em đồng ý với chị Lan": tán thành một người, không chốt việc gì
        if i + size < n and words[i + size].split(" ")[0] in AGREEMENT_FOLLOWERS:
            continue
        return True
    return False


def _action_strength(words: list[str]) -> tuple[int, int]:
    """(số từ gợi ý mạnh, số từ gợi ý yếu khác nhau) không bị phủ định."""
    strong = 0
    weak: set[str] = set()
    i, n = 0, len(words)
    while i < n:
        size = match_at(words, i, _ACTION_STRONG)
        kind = 2
        if size == 0:
            size = match_at(words, i, _ACTION_WEAK)
            kind = 1
        if size == 0:
            i += 1
            continue
        # "không cần gửi", "đã hoàn thành", "chưa có ai phụ trách": bị phủ định hoặc đã xong thì không phải việc cần làm
        if not _negated(words, i, 1) and not _preceded(words, i, 1, DONE_MARKERS) and not _nobody(words, i):
            if kind == 2:
                strong += 1
            else:
                weak.add(" ".join(words[i:i + size]))
        i += size
    return strong, len(weak)


def has_metric(text: str) -> bool:
    """Có con số kèm đơn vị ("12 tỷ", "15%", "20 triệu"): câu mang số liệu."""
    n = len(text)
    i = 0
    while i < n:
        if not ("0" <= text[i] <= "9"):
            i += 1
            continue
        j = i
        while j < n and (("0" <= text[j] <= "9") or text[j] in ".,"):
            j += 1
        k = j
        if k < n and text[k] == " ":
            k += 1
        if k < n and text[k] == "%":
            return True
        m = k
        while m < n and text[m].isalpha():
            m += 1
        if m > k and text[k:m].lower() in METRIC_UNITS:
            return True
        i = j
    return False


def classify(sentences: list[Sentence], participants: list[str]) -> set[str]:
    """Gắn nhãn câu hỏi/chào hỏi/quyết định/việc cần làm. Trả về các từ là tên người (để không lấy làm từ khóa)."""
    names: set[str] = set()
    for name in participants:
        for word in ws_words(name):
            bare = strip_punct(word).lower()
            if bare:
                names.add(bare)
    for s in sentences:
        s.question = _is_question(s)
        s.greeting = s.ntok <= 10 and find_phrase(s.words, _GREETING) >= 0
        s.has_number = False
        for ch in s.text:
            if "0" <= ch <= "9":
                s.has_number = True
                break
        s.decision = _is_decision(s)
        s.action = False
        s.owner = ""
        s.due = ""
        if s.question or s.greeting or s.ntok < 4:
            continue
        strong, weak = _action_strength(s.words)
        if strong == 0 and weak == 0:
            continue
        owner, kind, sure = locate_owner(s.text, participants)
        if strong > 0 or weak >= 2 or sure:
            s.action = True
            s.owner = owner
            s.due = find_due(s.text)
            if kind == "name":
                for word in ws_words(owner):
                    bare = strip_punct(word).lower()
                    if bare and bare not in HONORIFICS:
                        names.add(bare)
    return names


def apply_bonuses(sentences: list[Sentence]) -> None:
    """Cộng điểm cho câu mang quyết định, việc cần làm, con số, câu mở đầu/kết luận; trừ điểm câu hỏi và chào hỏi."""
    total = len(sentences)
    for s in sentences:
        if s.ntok < 4:
            s.score = 0.0
            continue
        bonus = 0.0
        if s.decision:
            bonus += 0.5
        if s.action:
            bonus += 0.3
        if has_metric(s.text):
            bonus += 0.35
        elif s.has_number:
            bonus += 0.15
        if s.idx < 3 and total >= 4 and find_phrase(s.words, _INTRO) >= 0:
            bonus += 0.4
        if find_phrase(s.words, _CONCLUSION) >= 0:
            bonus += 0.4
        if find_phrase(s.words, _IMPORTANCE) >= 0:
            bonus += 0.25
        score = s.score + bonus
        if s.question:
            score *= 0.5
        if s.greeting:
            score *= 0.15
        s.score = score


# -------------------------------------------------------------------- ý chính
def _similarity(a: Sentence, b: Sentence) -> float:
    """Jaccard trên tập từ nội dung (hai câu đều không có từ nội dung coi như trùng nhau)."""
    if not a.cset and not b.cset:
        return 1.0
    shared = 0
    for word in a.cset:
        if word in b.cset:
            shared += 1
    return shared / (len(a.cset) + len(b.cset) - shared)


def pick_summary(sentences: list[Sentence], limit: int) -> list[Sentence]:
    """Chọn các câu điểm cao nhưng không lặp ý (MMR), trả về theo thứ tự xuất hiện."""
    ranked = [s for s in sentences if s.ntok >= 4 and not s.greeting and not s.repeat]
    ranked.sort(key=lambda s: (-s.score, s.idx))
    ranked = ranked[:200]
    if not ranked:
        return []
    top = ranked[0].score
    chosen: list[Sentence] = []
    remaining = ranked
    while remaining and len(chosen) < limit:
        best = None
        best_value = 0.0
        keep: list[Sentence] = []
        for s in remaining:
            sim = 0.0
            for c in chosen:
                value = _similarity(s, c)
                if value > sim:
                    sim = value
            if sim >= 0.6:
                continue  # gần trùng với ý đã chọn: loại hẳn
            keep.append(s)
            relevance = s.score / top if top > 0 else 0.0
            value = 0.7 * relevance - 0.3 * sim
            if best is None or value > best_value:
                best, best_value = s, value
        if best is None:
            break
        chosen.append(best)
        remaining = [s for s in keep if s is not best]
    chosen.sort(key=lambda s: s.idx)
    return chosen


def summary_limit(sentences: list[Sentence], style: dict | None) -> int:
    wanted = (style or {}).get("summary_items")
    if isinstance(wanted, (int, float)) and not isinstance(wanted, bool) and wanted == wanted and 1 <= wanted <= 1000:
        return max(3, min(MAX_SUMMARY, round_half_up(wanted)))
    count = 0
    for s in sentences:
        if s.ntok >= 4 and not s.greeting and not s.repeat:
            count += 1
    return max(3, min(MAX_SUMMARY, round_half_up(1.25 * math.sqrt(count))))


# ------------------------------------------------------------ việc cần làm
def make_task(sentence: str, owner: str, due: str) -> str:
    """Rút câu giao việc thành đầu việc: bỏ "<ai> sẽ/cần/phải" ở đầu và hạn chót ở cuối (đã có cột riêng)."""
    cleaned = clean_sentence(sentence)
    words = ws_words(cleaned)
    n = len(words)
    low = [strip_punct(w).lower() for w in words]
    start = 0
    if owner:
        parts = [p for p in [strip_punct(w).lower() for w in ws_words(owner)] if p]
        size = len(parts)
        if size > 0:
            for i in range(0, min(n - size, 5) + 1):
                ok = True
                for k in range(size):
                    if low[i + k] != parts[k]:
                        ok = False
                        break
                if ok:
                    j = i + size
                    if j + 1 < n and low[j] in GAP_WORDS:
                        j += 1
                    if j < n:
                        modal = match_at(low, j, _MODALS)
                        if modal > 0:
                            start = j + modal
                    break
    if start == 0 and n > 0:
        j = match_at(low, 0, _SUBJECTS)
        if j < n:
            modal = match_at(low, j, _MODALS)
            if modal > 0:
                start = j + modal
    end = n
    if due:
        parts = [p for p in [strip_punct(w).lower() for w in ws_words(due)] if p]
        size = len(parts)
        if size > 0 and end - size > start:
            ok = True
            for k in range(size):
                if low[end - size + k] != parts[k]:
                    ok = False
                    break
            if ok:
                end -= size
                if end - 1 > start and low[end - 1] in DUE_PREPOSITIONS:
                    end -= 1
    if end - start < 2:
        start, end = 0, n
    return truncate(capitalize_first(strip_terminal(" ".join(words[start:end]))), ITEM_CHARS)


def strip_decision_prefix(cleaned: str) -> str:
    """"Vậy chúng ta thống nhất chốt ngân sách..." -> "Chốt ngân sách..." (dùng cho nhánh Quyết định của sơ đồ)."""
    words = ws_words(cleaned)
    n = len(words)
    if n == 0:
        return cleaned
    low = [strip_punct(w).lower() for w in words]
    i = 0
    # chỉ bỏ khi phía trước động từ toàn là từ nối và chủ ngữ chung ("vậy", "sau khi thảo luận thì", "mọi người")
    for _ in range(4):
        if i >= n:
            break
        size = match_at(low, i, _DECISION_LEAD)
        if size == 0:
            break
        i += size
    if i < n:
        i += match_at(low, i, _DECISION_SUBJECTS)
    if i >= n:
        return cleaned
    verb = match_at(low, i, _DECISION_VERBS)
    if verb == 0:
        return cleaned
    i += verb
    while i < n and low[i] in ("là", "rằng", "việc", "that"):
        i += 1
    if n - i < 3:
        return cleaned
    return capitalize_first(" ".join(words[i:]))


def strip_topic_marker(text: str) -> str:
    """"Về chi phí thì chi phí quảng cáo tăng..." -> "Chi phí quảng cáo tăng..." (chỉ dùng khi nhãn quá dài)."""
    words = ws_words(text)
    n = len(words)
    if n < 6 or strip_punct(words[0]).lower() not in ("về", "còn", "riêng"):
        return text
    for i in range(2, min(6, n - 3)):
        if strip_punct(words[i]).lower() == "thì":
            return capitalize_first(" ".join(words[i + 1:]))
    return text


def compress_leaf(cleaned: str, phrase_parts: list[str] | None = None, limit: int = LEAF_CHARS) -> str:
    """Rút một câu thành nhãn ngắn cho nút lá: bỏ cụm từ khóa ở đầu khi tên nhánh đã nói thay ("Khách hàng đã phản hồi
    tốt" dưới nhánh "Khách hàng" -> "Đã phản hồi tốt"), câu quá dài thì bỏ phần dẫn "về ... thì" rồi cắt gọn."""
    text = strip_terminal(cleaned)
    if phrase_parts:
        words = ws_words(text)
        size = len(phrase_parts)
        # chỉ bỏ khi sau cụm từ khóa là hư từ ("đã", "thì", "is"): nếu là danh từ thì cụm chưa hết ("dữ liệu bệnh nhân")
        if len(words) - size >= 3 and strip_punct(words[size]).lower() in STOPWORDS:
            ok = True
            for k in range(size):
                if words[k].lower() != phrase_parts[k]:
                    ok = False
                    break
            if ok:
                rest = clean_sentence(" ".join(words[size:]))
                if rest:
                    text = strip_terminal(rest)
    if len(text) > limit:
        text = strip_topic_marker(text)
    return truncate(capitalize_first(text), limit)


def topic_from_intro(sentences: list[Sentence]) -> str:
    """"Hôm nay chúng ta họp về kế hoạch ra mắt sản phẩm mới" -> "Kế hoạch ra mắt sản phẩm mới"."""
    seen = 0
    for s in sentences:
        if s.greeting or s.ntok < 4:
            continue
        seen += 1
        if seen > 4:
            break
        words = ws_words(strip_terminal(clean_sentence(s.text)))
        n = len(words)
        low = [strip_punct(w).lower() for w in words]
        for i in range(n):
            size = match_at(low, i, _TOPIC_INTRO)
            if size == 0:
                continue
            j = i + size
            while j < n and low[j] in TITLE_SKIP:
                j += 1
            end = j
            while end < n and end - j < 12:
                end += 1
                if words[end - 1][-1:] in (",", ";", ".", "!", "?", ":"):
                    break
            if end - j < 2 or low[j] in STOPWORDS:
                continue
            return truncate(capitalize_first(strip_terminal(" ".join(words[j:end]))), TITLE_CHARS)
    return ""


def suggest_title(keywords: list[str], sentences: list[Sentence]) -> str:
    """Tiêu đề gợi ý khi người dùng không đặt: chủ đề nêu ở câu mở đầu, không có thì hai cụm từ khóa đầu,
    không có nữa thì câu đầu tiên."""
    title = topic_from_intro(sentences)
    if title:
        return title
    if keywords:
        title = capitalize_first(keywords[0])
        if len(keywords) > 1:
            title += ", " + keywords[1]
        return truncate(title, TITLE_CHARS)
    for s in sentences:
        if s.ntok >= 2 and not s.greeting:
            return truncate(strip_terminal(clean_sentence(s.text)), TITLE_CHARS)
    return ""


# -------------------------------------------------------------- sơ đồ tư duy
def build_mindmap(title: str, labels: dict, sentences: list[Sentence], keywords: list[str], key_parts: dict,
                  summary: list[Sentence], decisions: list[Sentence], actions: list[tuple[Sentence, dict]],
                  style: dict | None = None) -> dict:
    """Gốc -> các chủ đề (cụm từ khóa) -> ý ngắn; cộng nhánh Quyết định và Việc cần làm. Mỗi câu chỉ xuất hiện một lần."""
    long_text = len(sentences) >= 60
    max_topics = 8 if long_text else 6
    max_leaves = 4 if long_text else 3
    shown_decisions = decisions[:6]
    shown_actions = actions[:6]
    special = (1 if shown_decisions else 0) + (1 if shown_actions else 0)
    wanted = (style or {}).get("branches")
    if isinstance(wanted, (int, float)) and not isinstance(wanted, bool) and wanted == wanted and 1 <= wanted <= 1000:
        max_topics = max(2, min(8, round_half_up(wanted) - special))
    used: set[int] = set()
    for s in shown_decisions:
        used.add(s.idx)
    for s, _ in shown_actions:
        used.add(s.idx)
    usable = 0
    for s in sentences:
        if s.ntok >= 4 and not s.greeting and not s.repeat:
            usable += 1
    if usable < 6:
        max_topics = 0  # ghi chú vài câu: chia chủ đề chỉ làm rối, gom hết vào nhánh "Ý chính"
    topics: list[tuple[int, dict]] = []
    for keyword in keywords:
        if len(topics) >= max_topics:
            break
        parts = key_parts.get(keyword)
        if not parts:
            continue
        matches = [s for s in sentences if s.idx not in used and s.ntok >= 4 and not s.greeting and not s.question
                   and not s.repeat and contains_words(s.words, parts)]
        if not matches:
            continue
        matches.sort(key=lambda s: (-s.score, s.idx))
        picked = matches[:max_leaves]
        picked.sort(key=lambda s: s.idx)
        syllables = keyword.split(" ")
        leaves = []
        for s in picked:
            used.add(s.idx)
            leaves.append({"title": compress_leaf(clean_sentence(s.text), syllables), "children": []})
        topics.append((picked[0].idx, {"title": capitalize_first(keyword), "children": leaves}))
    # các chủ đề xếp theo thứ tự được nhắc tới trong buổi nói
    topics.sort(key=lambda item: item[0])
    branches = [branch for _, branch in topics]
    rest = [s for s in summary if s.idx not in used]
    if max_topics == 0:
        rest = [s for s in sentences if s.idx not in used and s.ntok >= 2 and not s.greeting and not s.repeat]
    if rest:
        leaves = []
        for s in rest[:5]:
            used.add(s.idx)
            leaves.append({"title": compress_leaf(clean_sentence(s.text)), "children": []})
        branches.append({"title": labels["main"], "children": leaves})
    if shown_decisions:
        leaves = [{"title": compress_leaf(strip_decision_prefix(clean_sentence(s.text))), "children": []}
                  for s in shown_decisions]
        branches.append({"title": labels["decisions"], "children": leaves})
    if shown_actions:
        leaves = []
        for _, item in shown_actions:
            meta = ", ".join([x for x in (item["owner"], item["due"]) if x])
            label = truncate(item["task"], 60) + ((" (" + meta + ")") if meta else "")
            leaves.append({"title": label, "children": []})
        branches.append({"title": labels["actions"], "children": leaves})
    root = title or suggest_title(keywords, sentences) or labels["meeting"]
    return normalize_mindmap({"title": root, "children": branches}, root_title=root)


# ------------------------------------------------------------------ đầu vào
def extract_decisions(sentences: list[Sentence], limit: int = MAX_DECISIONS) -> list[tuple[Sentence, str]]:
    found = [(s, truncate(clean_sentence(s.text), ITEM_CHARS)) for s in sentences if s.decision]
    return _dedupe(found, key=lambda pair: pair[1])[:limit]


def extract_action_items(sentences: list[Sentence], limit: int = 8) -> list[tuple[Sentence, dict]]:
    items: list[tuple[Sentence, dict]] = []
    for s in sentences:
        if not s.action:
            continue
        items.append((s, {"task": make_task(s.text, s.owner, s.due), "owner": s.owner, "due": s.due}))
    # việc đã rõ người và hạn xếp trước
    items.sort(key=lambda pair: -((1 if pair[1]["owner"] else 0) + (1 if pair[1]["due"] else 0)))
    return _dedupe(items, key=lambda pair: pair[1]["task"] + " | " + pair[1]["owner"])[:limit]


def title_for(transcript: str, language: str = "vi") -> str:
    """Tiêu đề gợi ý cho một bản ghi chưa đặt tên."""
    transcript = nfc(transcript)
    lang = resolve_language(language, transcript)
    sentences = analyze_sentences(transcript)
    names = classify(sentences, [])
    return suggest_title(pick_keywords(keyphrase_stats(sentences), "", lang, 3, names), sentences)


def analyze_heuristic(transcript: str, title: str = "", participants: list[str] | None = None,
                      language: str = "vi", style: dict | None = None) -> dict:
    participants = [p for p in (participants or []) if isinstance(p, str)]
    transcript = nfc(transcript)
    title = normalize_ws(title or "")
    lang = resolve_language(language, transcript)
    labels = LABELS[lang]
    sentences = analyze_sentences(transcript)
    names = classify(sentences, participants)
    stats = keyphrase_stats(sentences)
    keywords = pick_keywords(stats, title, lang, 10, names)
    score_sentences(sentences, stats, keywords)
    apply_bonuses(sentences)
    chosen = pick_summary(sentences, summary_limit(sentences, style))
    summary = _dedupe([truncate(clean_sentence(s.text), SUMMARY_CHARS) for s in chosen])
    decisions = extract_decisions(sentences)
    actions = extract_action_items(sentences, 12 if len(sentences) >= 60 else 8)
    mindmap = build_mindmap(title, labels, sentences, keywords, stats.parts, chosen, [s for s, _ in decisions],
                            actions, style)
    return {
        "summary": summary,
        "decisions": [text for _, text in decisions],
        "action_items": [item for _, item in actions],
        "keywords": keywords,
        "mindmap": mindmap,
        "engine": "heuristic",
    }
