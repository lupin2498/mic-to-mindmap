/* Bộ máy tóm tắt và vẽ sơ đồ tư duy KHÔNG cần AI, chạy ngay trong trình duyệt / ứng dụng di động.

   Đây là bản JavaScript của app/textutil.py + app/heuristic.py + app/mindmap.py. Hai bản phải cho kết quả GIỐNG HỆT
   nhau trên cùng dữ liệu: tests/test_engine_parity.py chạy cả hai rồi so từng kết quả. Vì vậy:
   - mọi thay đổi thuật toán phải sửa ở cả hai nơi (tên hàm giữ tương ứng: clean_sentence <-> cleanSentence);
   - danh sách từ nằm ở engine-data.js, dùng chung cho cả hai bản;
   - độ dài/cắt chuỗi tính theo ký tự Unicode (code point) như Python, không theo đơn vị UTF-16;
   - mọi phép sắp xếp đều có tiêu chí phụ để không phụ thuộc việc sort có ổn định hay không. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine-data.js'));
  else root.M2MEngine = factory(root.M2M_ENGINE_DATA);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (DATA) {
  'use strict';

  const STOPWORDS = new Set(DATA.vi_stopwords.concat(DATA.en_stopwords));
  const CONJUNCTIONS = new Set(DATA.conjunctions);
  const GENERIC = new Set(DATA.generic);
  const ABBREVIATIONS = new Set(DATA.abbreviations);
  const HONORIFICS = new Set(DATA.honorifics);
  const PHRASE_EDGE_STOP = new Set(DATA.phrase_edge_stop);
  const COMPOUNDS = new Set(DATA.vi_lexicon.concat(DATA.vi_stop_phrases));
  const LABELS = DATA.labels;

  // Khoảng trắng: đúng tập \s của Python cộng thêm BOM (xem WS_CLASS trong textutil.py)
  const WS_CLASS = '[\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]';
  const WS_RE = new RegExp(WS_CLASS + '+', 'g');
  const WS_ONE_RE = new RegExp('^' + WS_CLASS + '$');
  const WS_EDGES_RE = new RegExp('^' + WS_CLASS + '+|' + WS_CLASS + '+$', 'g');
  // Một "từ": dãy chữ cái, cho phép gạch nối/nháy đơn ở giữa (Python: [^\W\d_])
  const WORD_RE = /[\p{L}\p{Nl}\p{No}]+(?:[-'’][\p{L}\p{Nl}\p{No}]+)*/gu;
  const EDGE_PUNCT_RE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
  const ALPHA_ONLY_RE = /^\p{L}+$/u;
  const ALPHA_RUN_RE = /\p{L}+/uy;
  const WORD_CHAR_RE = /^[\p{L}\p{N}_]$/u;
  const UPPER_START_RE = /^\p{Uppercase}/u;
  const SURROGATE_RE = /[\ud800-\udfff]/;
  const ASCII_RE = /^[\x00-\x7f]*$/;
  const SENT_END = new Set(['.', '!', '?', '…']);

  // ---------------------------------------------------------------- cơ bản
  function nfc(text) {
    return text ? String(text).normalize('NFC') : '';
  }
  function normalizeWs(text) {
    return nfc(text).replace(WS_RE, ' ').replace(/^ +| +$/g, '');
  }
  function wsWords(text) {
    const norm = normalizeWs(text);
    return norm ? norm.split(' ') : [];
  }
  function isWs(ch) {
    return WS_ONE_RE.test(ch);
  }
  /* Độ dài theo ký tự Unicode (như len() của Python). */
  function cpLen(text) {
    return SURROGATE_RE.test(text) ? Array.from(text).length : text.length;
  }
  function cpSlice(text, count) {
    return SURROGATE_RE.test(text) ? Array.from(text).slice(0, count).join('') : text.slice(0, count);
  }
  /* Ký tự (code point) đứng ngay trước vị trí i. */
  function charBefore(text, i) {
    if (i >= 2) {
      const lo = text.charCodeAt(i - 1), hi = text.charCodeAt(i - 2);
      if (lo >= 0xdc00 && lo <= 0xdfff && hi >= 0xd800 && hi <= 0xdbff) return text.slice(i - 2, i);
    }
    return text.charAt(i - 1);
  }
  function charAt(text, i) {
    return String.fromCodePoint(text.codePointAt(i));
  }
  function isWordChar(ch) {
    return WORD_CHAR_RE.test(ch);
  }
  /* Bỏ ký tự không phải chữ/số ở hai đầu ("(An," -> "An"). */
  function stripPunct(word) {
    return word.replace(EDGE_PUNCT_RE, '');
  }
  function tokenizeCased(text) {
    const found = nfc(text).match(WORD_RE);
    if (!found) return [];
    for (let i = 0; i < found.length; i++) if (found[i].indexOf('’') >= 0) found[i] = found[i].replace(/’/g, "'");
    return found;
  }
  function tokenize(text) {
    return tokenizeCased(text).map((t) => t.toLowerCase());
  }
  function capitalizeFirst(text) {
    text = normalizeWs(text);
    if (!text) return text;
    const first = charAt(text, 0);
    return first.toUpperCase() + text.slice(first.length);
  }
  function truncate(text, maxChars) {
    text = normalizeWs(text);
    if (cpLen(text) <= maxChars) return text;
    let cut = cpSlice(text, maxChars);
    const space = cut.lastIndexOf(' ');
    if (space >= 0) cut = cut.slice(0, space);
    return cut.replace(/[,;:]+$/, '') + '…';
  }
  function roundHalfUp(value) {
    return Math.floor(value + 0.5);
  }
  function lastChar(word) {
    return word.length ? word.charAt(word.length - 1) : '';
  }

  // ----------------------------------------------------------- khớp cụm từ
  /* Từ đầu tiên -> các cụm (mỗi cụm là mảng từ), cụm dài xếp trước. */
  function buildIndex(phrases) {
    const index = new Map();
    let seq = 0;
    for (const parts of phrases) {
      if (!parts.length) continue;
      let bucket = index.get(parts[0]);
      if (!bucket) { bucket = []; index.set(parts[0], bucket); }
      bucket.push({ parts, seq: seq++ });
    }
    for (const bucket of index.values()) bucket.sort((a, b) => (b.parts.length - a.parts.length) || (a.seq - b.seq));
    return index;
  }
  /* Số từ của cụm dài nhất trong index khớp tại vị trí i (0 nếu không có). */
  function matchAt(words, i, index) {
    const bucket = index.get(words[i]);
    if (!bucket) return 0;
    const n = words.length;
    for (const item of bucket) {
      const parts = item.parts, size = parts.length;
      if (i + size > n) continue;
      let ok = true;
      for (let k = 1; k < size; k++) if (words[i + k] !== parts[k]) { ok = false; break; }
      if (ok) return size;
    }
    return 0;
  }
  function findPhrase(words, index) {
    for (let i = 0; i < words.length; i++) if (matchAt(words, i, index) > 0) return i;
    return -1;
  }
  function plainIndex(key) {
    return buildIndex(DATA[key].map((phrase) => phrase.split(' ')));
  }

  // --------------------------------------------------- gộp từ ghép tiếng Việt
  const PHRASES = (function () {
    const table = new Map();
    const seen = new Set();
    let seq = 0;
    for (const [phrases, stop] of [[DATA.vi_stop_phrases, true], [DATA.vi_lexicon, false]]) {
      for (const phrase of phrases) {
        if (seen.has(phrase)) continue;
        seen.add(phrase);
        const parts = phrase.split(' ');
        if (parts.length < 2) continue;
        let bucket = table.get(parts[0]);
        if (!bucket) { bucket = []; table.set(parts[0], bucket); }
        bucket.push({ parts, stop, seq: seq++ });
      }
    }
    for (const bucket of table.values()) bucket.sort((a, b) => (b.parts.length - a.parts.length) || (a.seq - b.seq));
    return table;
  })();

  /* Gộp các âm tiết thành từ theo từ điển (khớp dài nhất từ trái sang). Trả về {words, flags}: từ ghép trong từ điển
     là một từ nội dung, cụm hư từ ("chúng ta") là một từ không mang nội dung. */
  function segment(tokens) {
    const words = [], flags = [];
    const n = tokens.length;
    let i = 0;
    while (i < n) {
      const token = tokens[i];
      let size = 0, isStop = false;
      const bucket = PHRASES.get(token);
      if (bucket) {
        for (const item of bucket) {
          const parts = item.parts, length = parts.length;
          if (i + length > n) continue;
          let ok = true;
          for (let k = 1; k < length; k++) if (tokens[i + k] !== parts[k]) { ok = false; break; }
          if (ok) { size = length; isStop = item.stop; break; }
        }
      }
      if (size) {
        words.push(tokens.slice(i, i + size).join(' '));
        flags.push(!isStop);
        i += size;
      } else {
        words.push(token);
        flags.push(!STOPWORDS.has(token) && cpLen(token) > 1);
        i += 1;
      }
    }
    return { words, flags };
  }
  /* Chỉ mục khớp cụm ở mức TỪ (sau khi gộp từ ghép), để "cần" không khớp nhầm trong "cần thiết". */
  function segmentPhrases(phrases) {
    return buildIndex(phrases.map((phrase) => segment(phrase.split(' ')).words));
  }

  // ---------------------------------------------------------------- tách câu
  const MARKERS = plainIndex('discourse_markers');
  const COMMA_END = new Set([',', ';']);

  /* Tách một "câu" quá dài (thường do transcript không có dấu câu) thành các mệnh đề ngắn hơn. */
  function splitLong(sentence, maxTokens) {
    const words = wsWords(sentence);
    if (words.length <= maxTokens) return [sentence];
    const bare = words.map((w) => stripPunct(w).toLowerCase());
    const total = words.length;
    const half = Math.floor(maxTokens / 2);
    const soft = Math.floor(maxTokens / 4) + 1;
    const parts = [];
    let current = [];
    for (let i = 0; i < total; i++) {
      if (current.length && current.length >= soft) {
        const afterComma = COMMA_END.has(lastChar(words[i - 1]));
        const joined = COMPOUNDS.has(bare[i - 1] + ' ' + bare[i]);
        if (afterComma || (!joined && (matchAt(bare, i, MARKERS) > 0
            || (current.length >= half && CONJUNCTIONS.has(bare[i]))))) {
          parts.push(current.join(' '));
          current = [];
        }
      }
      current.push(words[i]);
      if (current.length >= maxTokens) {
        if (i + 1 < total && current.length > 1 && COMPOUNDS.has(bare[i] + ' ' + bare[i + 1])) {
          parts.push(current.slice(0, current.length - 1).join(' '));
          current = [words[i]];
        } else {
          parts.push(current.join(' '));
          current = [];
        }
      }
    }
    if (current.length) parts.push(current.join(' '));
    return parts;
  }
  /* Bỏ khoảng trắng hai đầu, không đụng tới bên trong. */
  function normalizeEdges(text) {
    let start = 0, end = text.length;
    while (start < end && isWs(text.charAt(start))) start++;
    while (end > start && isWs(text.charAt(end - 1))) end--;
    return text.slice(start, end);
  }
  /* Tách theo dấu kết câu (. ! ? …) có khoảng trắng theo sau và theo dấu xuống dòng. */
  function splitRawSentences(text) {
    const out = [];
    const n = text.length;
    let start = 0, i = 0;
    while (i < n) {
      const ch = text.charAt(i);
      let cut = -1;
      if (ch === '\n') {
        cut = i;
      } else if (SENT_END.has(ch) && i + 1 < n && isWs(text.charAt(i + 1))) {
        cut = i + 1;
        if (ch === '.') {
          // "TP. Hồ Chí Minh", "Mr. An": dấu chấm của chữ viết tắt không kết câu
          let j = i;
          while (j > start) {
            const prev = charBefore(text, j);
            if (!ALPHA_ONLY_RE.test(prev)) break;
            j -= prev.length;
          }
          if (ABBREVIATIONS.has(text.slice(j, i).toLowerCase()) && (j === start || !isWordChar(charBefore(text, j)))) cut = -1;
        }
      }
      if (cut < 0) { i++; continue; }
      const piece = normalizeEdges(text.slice(start, cut));
      if (piece) out.push(piece);
      i = cut;
      while (i < n && isWs(text.charAt(i))) i++;
      start = i;
    }
    const piece = normalizeEdges(text.slice(start));
    if (piece) out.push(piece);
    return out;
  }
  function splitSentences(text, maxTokens) {
    const limit = maxTokens === undefined ? 28 : maxTokens;
    const sentences = [];
    for (const raw of splitRawSentences(text || '')) {
      for (const part of splitLong(raw, limit)) if (part) sentences.push(part);
    }
    return sentences;
  }

  // ------------------------------------------------------------ câu đã phân tích
  function makeSentence(idx, text) {
    const cased = tokenizeCased(text);
    const tokens = cased.map((t) => t.toLowerCase());
    const seg = segment(tokens);
    const content = [];
    for (let i = 0; i < seg.words.length; i++) if (seg.flags[i]) content.push(seg.words[i]);
    return {
      idx, text, cased, tokens, words: seg.words, flags: seg.flags, content, cset: new Set(content), ntok: tokens.length,
      score: 0, question: false, greeting: false, decision: false, action: false, owner: '', due: '', hasNumber: false,
      repeat: false,
    };
  }
  function analyzeSentences(text) {
    const sentences = splitSentences(nfc(text)).map((s, i) => makeSentence(i, s));
    // câu lặp lại nguyên văn: chỉ tính lần đầu
    const seen = new Set();
    for (const sentence of sentences) {
      const key = sentence.tokens.join(' ');
      if (seen.has(key)) sentence.repeat = true;
      else seen.add(key);
    }
    return sentences;
  }
  function containsWords(words, parts) {
    const size = parts.length;
    if (size === 0) return false;
    for (let i = 0; i + size <= words.length; i++) {
      let ok = true;
      for (let k = 0; k < size; k++) if (words[i + k] !== parts[k]) { ok = false; break; }
      if (ok) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- từ khóa
  function newStats() {
    return { count: new Map(), first: new Map(), parts: new Map(), standalone: new Map(), proper: new Map(), order: 0 };
  }
  function statsAdd(stats, parts) {
    const phrase = parts.join(' ');
    if (stats.count.has(phrase)) {
      stats.count.set(phrase, stats.count.get(phrase) + 1);
    } else {
      stats.count.set(phrase, 1);
      stats.first.set(phrase, stats.order);
      stats.parts.set(phrase, parts);
      stats.order += 1;
    }
  }
  function bump(map, key, by) {
    map.set(key, (map.get(key) || 0) + by);
  }
  /* Đếm từ đơn, cụm 2 và 3 từ nội dung đứng liền nhau trong cùng một câu (không vượt qua hư từ). */
  function keyphraseStats(sentences) {
    const stats = newStats();
    for (const sentence of sentences) {
      const words = sentence.words, flags = sentence.flags;
      const n = words.length;
      let offset = 0;
      for (let i = 0; i < n; i++) {
        const word = words[i];
        const size = word.split(' ').length;
        // "chị lan", "anh hùng": âm tiết ngay sau từ xưng hô là tên người, không phải chủ đề
        const named = i > 0 && size === 1 && HONORIFICS.has(words[i - 1]);
        if (flags[i] && !named) {
          statsAdd(stats, [word]);
          let left = i > 0 ? flags[i - 1] : false;
          const right = i + 1 < n ? flags[i + 1] : false;
          if (left && i > 1 && HONORIFICS.has(words[i - 2]) && words[i - 1].indexOf(' ') < 0) left = false;
          if (!left && !right) bump(stats.standalone, word, 1);
          if (offset > 0 && UPPER_START_RE.test(sentence.cased[offset])) bump(stats.proper, word, 1);
          if (right) {
            statsAdd(stats, [word, words[i + 1]]);
            if (i + 2 < n && flags[i + 2]) statsAdd(stats, [word, words[i + 1], words[i + 2]]);
          }
        }
        offset += size;
      }
    }
    return stats;
  }
  /* Chọn cụm từ khóa: ưu tiên cụm lặp lại, bỏ mảnh vụn nằm trọn trong cụm dài hơn, bỏ từ quá chung chung.
     exclude: các từ không được làm từ khóa (tên người tham gia, tên người phụ trách). */
  function pickKeywords(stats, title, language, limit, exclude) {
    if (!stats.count.size || limit <= 0) return [];
    const vietnamese = String(language || '').toLowerCase().indexOf('vi') === 0;
    const count = stats.count;
    exclude = exclude || new Set();
    const nested = new Set();
    for (const [phrase, parts] of stats.parts) {
      const size = parts.length;
      if (size < 2 || count.get(phrase) < 2) continue;
      const subs = [[parts[0]], [parts[size - 1]]];
      if (size === 3) subs.push([parts[1]], [parts[0], parts[1]], [parts[1], parts[2]]);
      for (const sub of subs) {
        const key = sub.join(' ');
        if (count.has(key) && count.get(phrase) * 5 >= count.get(key) * 4) nested.add(key);
      }
    }
    // âm tiết lẻ hầu như chỉ xuất hiện trong vài cụm hai từ ("pha" trong "pha sáng", "pha tối"): nhường cho các cụm đó
    const covered = new Map();
    for (const [phrase, parts] of stats.parts) {
      if (parts.length === 2 && count.get(phrase) >= 2) for (const part of parts) bump(covered, part, count.get(phrase));
    }
    for (const [word, total] of covered) {
      if (word.indexOf(' ') < 0 && count.has(word) && total * 5 >= count.get(word) * 4) nested.add(word);
    }
    const titleWords = title ? segment(tokenize(title)).words : [];
    const candidates = [];
    const fallback = [];
    for (const [phrase, parts] of stats.parts) {
      const size = parts.length;
      const times = count.get(phrase);
      let allGeneric = true, excluded = false;
      for (const part of parts) {
        if (!GENERIC.has(part)) allGeneric = false;
        if (exclude.has(part)) excluded = true;
      }
      if (allGeneric || excluded) continue;
      let score;
      if (size === 1) {
        const compound = phrase.indexOf(' ') >= 0;
        if (!compound && cpLen(phrase) <= 2) continue;
        const proper = stats.proper.get(phrase) || 0;
        if (times < 2) {
          if (compound || proper > 0) fallback.push({ first: stats.first.get(phrase), phrase });
          continue;
        }
        if (vietnamese && !compound && proper === 0) {
          if ((stats.standalone.get(phrase) || 0) * 3 < times) continue;
          if (times < 3 && !ASCII_RE.test(phrase)) continue;
        }
        score = times * (compound ? 1.3 : 1.0);
        if (proper > 0) score *= 1.2;
      } else {
        if (times < 2 || PHRASE_EDGE_STOP.has(parts[0]) || PHRASE_EDGE_STOP.has(parts[size - 1])) continue;
        score = times * (1.0 + 0.5 * (size - 1));
      }
      if (nested.has(phrase)) continue;
      if (titleWords.length && containsWords(titleWords, parts)) score *= 1.3;
      candidates.push({ score, first: stats.first.get(phrase), phrase });
    }
    candidates.sort((a, b) => (b.score - a.score) || (a.first - b.first));
    const chosen = [];
    const used = new Set();
    for (const cand of candidates) {
      const parts = stats.parts.get(cand.phrase);
      let clash = false;
      for (const part of parts) if (used.has(part)) { clash = true; break; }
      if (!clash) {
        // không lấy cả cụm lẫn cụm con của nó ("đặt lịch" và "phần đặt lịch")
        for (const other of chosen) {
          const otherParts = stats.parts.get(other);
          if (containsWords(parts, otherParts) || containsWords(otherParts, parts)) { clash = true; break; }
        }
      }
      if (clash) continue;
      chosen.push(cand.phrase);
      for (const part of parts) {
        if (parts.length === 1 || (!nested.has(part) && !GENERIC.has(part))) used.add(part);
      }
      if (chosen.length >= limit) return chosen;
    }
    if (chosen.length < 3) {
      fallback.sort((a, b) => a.first - b.first);
      for (const item of fallback) {
        if (used.has(item.phrase) || nested.has(item.phrase)) continue;
        chosen.push(item.phrase);
        used.add(item.phrase);
        if (chosen.length >= Math.min(limit, 5)) break;
      }
    }
    return chosen;
  }

  // ------------------------------------------------------------ chấm điểm câu
  function scoreSentences(sentences, stats, keywords) {
    let maxCount = 0;
    for (const [phrase, parts] of stats.parts) {
      if (parts.length === 1 && stats.count.get(phrase) > maxCount) maxCount = stats.count.get(phrase);
    }
    const keywordParts = [];
    for (const k of keywords) if (stats.parts.has(k)) keywordParts.push(stats.parts.get(k));
    for (const sentence of sentences) {
      if (sentence.ntok < 4 || maxCount === 0) { sentence.score = 0; continue; }
      let total = 0;
      for (const word of sentence.content) total += (stats.count.get(word) || 0) / maxCount;
      for (const parts of keywordParts) if (containsWords(sentence.words, parts)) total += 0.8;
      sentence.score = total / Math.sqrt(sentence.ntok);
    }
  }

  // ----------------------------------------------------------- nhận ngôn ngữ
  const VI_LETTERS = new Set(Array.from('ăâđêôơưĂÂĐÊÔƠƯ'));
  function detectLanguage(text, fallback) {
    let letters = 0, vietnamese = 0, seen = 0;
    for (const ch of text) {
      if (seen >= 4000) break;
      seen += 1;
      if (ALPHA_ONLY_RE.test(ch)) {
        letters += 1;
        const cp = ch.codePointAt(0);
        if (VI_LETTERS.has(ch) || (cp >= 0x1ea0 && cp <= 0x1ef9)) vietnamese += 1;
      }
    }
    if (letters === 0) return fallback || 'vi';
    return vietnamese * 50 >= letters ? 'vi' : 'en';
  }
  function resolveLanguage(language, text) {
    const lang = String(language || '').replace(WS_EDGES_RE, '').toLowerCase();
    if (lang.indexOf('vi') === 0) return 'vi';
    if (lang.indexOf('en') === 0) return 'en';
    return detectLanguage(text);
  }

  // =================================================================== phân tích
  const DECISION = segmentPhrases(DATA.decision_cues);
  const ACTION_STRONG = segmentPhrases(DATA.action_strong);
  const ACTION_WEAK = segmentPhrases(DATA.action_weak);
  const GREETING = segmentPhrases(DATA.greeting_cues);
  const INTRO = segmentPhrases(DATA.intro_cues);
  const CONCLUSION = segmentPhrases(DATA.conclusion_cues);
  const IMPORTANCE = segmentPhrases(DATA.importance_cues);
  const QUESTION_STARTS = segmentPhrases(DATA.question_starts);
  const QUESTION_ENDS = segmentPhrases(DATA.question_ends);
  const NEGATIONS = new Set(DATA.negations);
  const OWNER_VERBS = plainIndex('owner_verbs');
  const MODALS = plainIndex('modals');
  const ORG_UNITS = plainIndex('org_units');
  const SUBJECTS = plainIndex('subject_pronouns');
  const LEAD = plainIndex('lead_fillers');
  const TRAIL = plainIndex('trail_particles');
  const DECISION_SUBJECTS = plainIndex('decision_subjects');
  const DECISION_VERBS = plainIndex('decision_verbs');
  const DECISION_LEAD = plainIndex('decision_lead');
  const TOPIC_INTRO = plainIndex('topic_intro');
  const TITLE_SKIP = new Set(DATA.title_skip);
  const ORG_SUFFIXES = new Set(DATA.org_suffixes);
  const DONE_MARKERS = new Set(DATA.done_markers);
  const PENDING_NEAR = new Set(DATA.pending_near);
  const PENDING_FAR = new Set(DATA.pending_far);
  const AGREEMENT_FOLLOWERS = new Set(DATA.agreement_followers);
  const METRIC_UNITS = new Set(DATA.metric_units);
  const GAP_WORDS = new Set(DATA.gap_words);
  const NOT_NAMES = new Set(DATA.not_names);
  const NOT_NAMES_AFTER_HONORIFIC = new Set(DATA.not_names_after_honorific);
  const STUTTER = new Set(DATA.stutter_words);
  const DUE_PREPOSITIONS = new Set(DATA.due_prepositions);
  const DUE_RE = new RegExp(DATA.due_patterns.map((p) => '(?:' + p + ')').join('|'), 'g');
  const ORDINAL_DAYS = new Set(['thứ hai', 'thứ ba', 'thứ tư', 'thứ năm', 'thứ sáu', 'thứ bảy']);
  const TERMINAL = new Set(['.', ',', ';', ':', '…', ' ']);
  const CLOSERS = new Set(['"', "'", '”', '’', ')', ']', '»']);
  const CLAUSE_END = new Set([',', ';', ':', '.']);
  const TITLE_END = new Set([',', ';', '.', '!', '?', ':']);
  const DECISION_LINKS = new Set(['là', 'rằng', 'việc', 'that']);
  const TOPIC_LEADS = new Set(['về', 'còn', 'riêng']);
  const SENT_TAIL = new Set(['.', '!', '?', '…']);

  const MAX_SUMMARY = 12, MAX_DECISIONS = 6, SUMMARY_CHARS = 180, ITEM_CHARS = 160, LEAF_CHARS = 80, TITLE_CHARS = 60;

  function dedupe(items, key) {
    const seen = new Set();
    const out = [];
    for (const item of items) {
      const k = normalizeWs(String(key ? key(item) : item)).toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(item);
    }
    return out;
  }

  // ----------------------------------------------------------- làm gọn câu
  /* Bỏ dấu chấm, phẩy... ở cuối (giữ ? và !). */
  function stripTerminal(text) {
    let end = text.length;
    while (end > 0 && TERMINAL.has(text.charAt(end - 1))) end--;
    return text.slice(0, end);
  }
  /* Bỏ từ đệm của lời nói ở đầu/cuối câu ("à thì", "nhé mọi người"), gộp từ nói vấp, viết hoa chữ đầu. */
  function cleanSentence(sentence) {
    const words = wsWords(sentence);
    const n = words.length;
    if (n === 0) return '';
    const low = words.map((w) => stripPunct(w).toLowerCase());
    let start = 0;
    for (let round = 0; round < 6; round++) {
      const size = matchAt(low, start, LEAD);
      if (size === 0 || start + size >= n) break;
      // "thế giới", "là do"...: âm tiết trông như từ đệm nhưng thật ra mở đầu một từ ghép
      if (size === 1 && COMPOUNDS.has(low[start] + ' ' + low[start + 1])) break;
      start += size;
    }
    let end = n;
    const last = words[n - 1];
    let k = last.length;
    while (k > 0 && SENT_TAIL.has(last.charAt(k - 1))) k--;
    const tail = last.slice(k);
    for (let round = 0; round < 3; round++) {
      let cut = 0;
      for (const size of [3, 2, 1]) {
        const i = end - size;
        if (i < start + 3) continue; // chừa lại ít nhất ba từ
        if (matchAt(low, i, TRAIL) === size) { cut = size; break; }
      }
      if (cut === 0) break;
      end -= cut;
    }
    const kept = words.slice(start, end);
    if (end < n) kept[kept.length - 1] = kept[kept.length - 1].replace(/[,;:]+$/, '') + tail;
    const out = [];
    let previous = '';
    for (const word of kept) {
      const bare = stripPunct(word).toLowerCase();
      if (out.length && bare && bare === previous && STUTTER.has(bare) && stripPunct(out[out.length - 1]) === out[out.length - 1]) continue;
      out.push(word);
      previous = bare;
    }
    return capitalizeFirst(out.join(' '));
  }

  // ---------------------------------------------------------------- hạn chót
  function findDue(sentence) {
    const text = normalizeWs(sentence);
    const low = text.toLowerCase();
    const same = low.length === text.length;
    DUE_RE.lastIndex = 0;
    let match;
    while ((match = DUE_RE.exec(low)) !== null) {
      const start = match.index, end = start + match[0].length;
      if (start === end) { DUE_RE.lastIndex = end + 1; continue; }
      if (start > 0 && isWordChar(charBefore(low, start))) continue;
      if (end < low.length && isWordChar(charAt(low, end))) continue;
      const found = match[0];
      if (ORDINAL_DAYS.has(found) && (start === 0 || low.slice(end, end + 3) === ' là')) continue;
      return same ? text.slice(start, end) : found;
    }
    return '';
  }

  // --------------------------------------------------------- người phụ trách
  function isNameToken(token) {
    return cpLen(token) >= 2 && UPPER_START_RE.test(token) && ALPHA_ONLY_RE.test(token.replace(/[.\-]/g, ''));
  }
  /* Trả về [người phụ trách, loại, chắc chắn]. loại: participant | org | name | ''. */
  function locateOwner(sentence, participants) {
    const words = wsWords(sentence);
    const n = words.length;
    if (n === 0) return ['', '', false];
    const bare = words.map(stripPunct);
    const low = bare.map((b) => b.toLowerCase());
    let verbAt = -1;
    for (let i = 0; i < n; i++) if (matchAt(low, i, OWNER_VERBS) > 0) { verbAt = i; break; }
    // tên có thể cách động từ một từ đệm: "em Minh thì cần ..."
    let nameEnd = verbAt;
    if (verbAt >= 2 && GAP_WORDS.has(low[verbAt - 1])) nameEnd = verbAt - 1;
    // 1) Người tham gia được nêu tên
    let beforePos = -1, beforeSize = 0, beforeName = '';
    let firstPos = -1, firstSize = 0, firstName = '';
    for (const name of participants) {
      const label = normalizeWs(name);
      const parts = wsWords(label).map((w) => stripPunct(w).toLowerCase()).filter((p) => p);
      const size = parts.length;
      if (size === 0) continue;
      for (let i = 0; i + size <= n; i++) {
        let ok = true;
        for (let k = 0; k < size; k++) if (low[i + k] !== parts[k]) { ok = false; break; }
        if (!ok) continue;
        // "phương án", "chi nhánh": trùng tên người tham gia nhưng là một phần của từ ghép
        if (i + size < n && COMPOUNDS.has(low[i + size - 1] + ' ' + low[i + size])) continue;
        if (i > 0 && COMPOUNDS.has(low[i - 1] + ' ' + low[i])) continue;
        if (firstPos < 0 || i < firstPos || (i === firstPos && size > firstSize)) { firstPos = i; firstSize = size; firstName = label; }
        if (verbAt >= 0 && i < verbAt && (i > beforePos || (i === beforePos && size > beforeSize))) {
          beforePos = i; beforeSize = size; beforeName = label;
        }
      }
    }
    if (beforePos >= 0) return [beforeName, 'participant', beforePos + beforeSize === nameEnd];
    if (firstPos >= 0) return [firstName, 'participant', false];
    if (verbAt <= 0) return ['', '', false];
    // 2) Đơn vị/nhóm: "bộ phận marketing cần...", "phòng kế toán sẽ...", "the marketing team should..."
    for (let j = Math.max(0, nameEnd - 5); j < nameEnd; j++) {
      const size = matchAt(low, j, ORG_UNITS);
      if (size === 0) continue;
      const rest = nameEnd - (j + size);
      if (rest < 1 || rest > 3) continue;
      if (j > 0 && !STOPWORDS.has(low[j - 1]) && !NOT_NAMES.has(low[j - 1]) && !CLAUSE_END.has(lastChar(words[j - 1]))) continue;
      let ok = true;
      for (let k = j + size; k < nameEnd; k++) {
        const word = low[k];
        if (!word || NOT_NAMES.has(word) || GENERIC.has(word) || STOPWORDS.has(word) || HONORIFICS.has(word)) { ok = false; break; }
      }
      if (ok) return [capitalizeFirst(bare.slice(j, nameEnd).join(' ')), 'org', true];
    }
    if (nameEnd >= 2 && ORG_SUFFIXES.has(low[nameEnd - 1])) {
      let j = nameEnd - 2;
      if (low[j] && !STOPWORDS.has(low[j]) && !NOT_NAMES.has(low[j])) {
        if (j >= 1 && low[j - 1] && !STOPWORDS.has(low[j - 1]) && !NOT_NAMES.has(low[j - 1])) j -= 1;
        return [capitalizeFirst(bare.slice(j, nameEnd).join(' ')), 'org', true];
      }
    }
    // 3) Tên riêng viết hoa đứng ngay trước động từ giao việc ở đầu mệnh đề
    if (verbAt <= 7) {
      const name = [];
      let k = nameEnd - 1;
      while (k >= 0 && name.length < 3) {
        const token = words[k].replace(/^[,;:]+|[,;:]+$/g, '');
        if (!isNameToken(token)) break;
        name.unshift(token);
        k -= 1;
      }
      if (name.length) {
        const honorific = HONORIFICS.has(name[0].replace(/\.+$/, '').toLowerCase());
        const core = honorific ? name.slice(1) : name;
        let valid = core.length > 0;
        for (const part of core) if (NOT_NAMES.has(part.toLowerCase())) { valid = false; break; }
        if (valid) return [name.join(' '), 'name', true];
      }
    }
    // 4) Xưng hô + tên viết thường (văn bản nhận dạng giọng nói thường không viết hoa): "anh an sẽ ..."
    for (const size of [2, 1]) {
      const h = nameEnd - size - 1;
      if (h < 0 || !HONORIFICS.has(low[h])) continue;
      let ok = true;
      for (let k = h + 1; k < nameEnd; k++) {
        const word = low[k];
        if (cpLen(word) < 2 || !ALPHA_ONLY_RE.test(word) || NOT_NAMES_AFTER_HONORIFIC.has(word) || NOT_NAMES.has(word)
            || HONORIFICS.has(word)) { ok = false; break; }
      }
      if (ok) {
        const rest = [];
        for (let k = h + 1; k < nameEnd; k++) rest.push(capitalizeFirst(bare[k]));
        return [bare[h] + ' ' + rest.join(' '), 'name', true];
      }
    }
    return ['', '', false];
  }
  function findOwner(sentence, participants) {
    return locateOwner(sentence, participants || [])[0];
  }

  // ----------------------------------------------------------- phân loại câu
  function firstSyllable(word) {
    const space = word.indexOf(' ');
    return space < 0 ? word : word.slice(0, space);
  }
  function preceded(words, pos, reach, markers) {
    for (let k = pos - 1; k > pos - 1 - reach; k--) if (k >= 0 && markers.has(firstSyllable(words[k]))) return true;
    return false;
  }
  /* "chưa có ai <làm>", "không ai <làm>": chưa có người nhận việc. */
  function nobody(words, pos) {
    if (pos < 2 || words[pos - 1] !== 'ai') return false;
    let k = pos - 2;
    if (words[k] === 'có' && k > 0) k -= 1;
    return NEGATIONS.has(firstSyllable(words[k]));
  }
  function isQuestion(sentence) {
    const text = sentence.text;
    let end = text.length;
    while (end > 0 && CLOSERS.has(text.charAt(end - 1))) end--;
    if (end > 0 && text.charAt(end - 1) === '?') return true;
    const words = sentence.words;
    const n = words.length;
    if (n === 0) return false;
    if (matchAt(words, 0, QUESTION_STARTS) > 0) return true;
    for (let i = Math.max(0, n - 3); i < n; i++) {
      const size = matchAt(words, i, QUESTION_ENDS);
      if (size > 0 && i + size === n) return true;
    }
    return false;
  }
  function isDecision(sentence) {
    if (sentence.question || sentence.greeting || sentence.ntok < 5) return false;
    const words = sentence.words;
    const n = words.length;
    for (let i = 0; i < n; i++) {
      const size = matchAt(words, i, DECISION);
      if (size === 0 || preceded(words, i, 2, NEGATIONS)) continue;
      // "cần giám đốc phê duyệt", "sẽ quyết định sau": việc còn treo, chưa phải quyết định
      if (preceded(words, i, 1, PENDING_NEAR) || preceded(words, i, 3, PENDING_FAR)) continue;
      // "em đồng ý với chị Lan": tán thành một người, không chốt việc gì
      if (i + size < n && AGREEMENT_FOLLOWERS.has(firstSyllable(words[i + size]))) continue;
      return true;
    }
    return false;
  }
  /* [số từ gợi ý mạnh, số từ gợi ý yếu khác nhau] không bị phủ định. */
  function actionStrength(words) {
    let strong = 0;
    const weak = new Set();
    const n = words.length;
    let i = 0;
    while (i < n) {
      let size = matchAt(words, i, ACTION_STRONG);
      let kind = 2;
      if (size === 0) { size = matchAt(words, i, ACTION_WEAK); kind = 1; }
      if (size === 0) { i += 1; continue; }
      if (!preceded(words, i, 1, NEGATIONS) && !preceded(words, i, 1, DONE_MARKERS) && !nobody(words, i)) {
        if (kind === 2) strong += 1;
        else weak.add(words.slice(i, i + size).join(' '));
      }
      i += size;
    }
    return [strong, weak.size];
  }
  /* Có con số kèm đơn vị ("12 tỷ", "15%", "20 triệu"): câu mang số liệu. */
  function hasMetric(text) {
    const n = text.length;
    let i = 0;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c < 48 || c > 57) { i += 1; continue; }
      let j = i;
      while (j < n) {
        const d = text.charCodeAt(j);
        if ((d >= 48 && d <= 57) || d === 46 || d === 44) j += 1; else break;
      }
      let k = j;
      if (k < n && text.charAt(k) === ' ') k += 1;
      if (k < n && text.charAt(k) === '%') return true;
      ALPHA_RUN_RE.lastIndex = k;
      const run = ALPHA_RUN_RE.exec(text);
      if (run && METRIC_UNITS.has(run[0].toLowerCase())) return true;
      i = j;
    }
    return false;
  }
  /* Gắn nhãn câu hỏi/chào hỏi/quyết định/việc cần làm. Trả về tập các từ là tên người (không lấy làm từ khóa). */
  function classify(sentences, participants) {
    const names = new Set();
    for (const name of participants) {
      for (const word of wsWords(name)) {
        const bare = stripPunct(word).toLowerCase();
        if (bare) names.add(bare);
      }
    }
    for (const s of sentences) {
      s.question = isQuestion(s);
      s.greeting = s.ntok <= 10 && findPhrase(s.words, GREETING) >= 0;
      s.hasNumber = /[0-9]/.test(s.text);
      s.decision = isDecision(s);
      s.action = false;
      s.owner = '';
      s.due = '';
      if (s.question || s.greeting || s.ntok < 4) continue;
      const strength = actionStrength(s.words);
      if (strength[0] === 0 && strength[1] === 0) continue;
      const located = locateOwner(s.text, participants);
      if (strength[0] > 0 || strength[1] >= 2 || located[2]) {
        s.action = true;
        s.owner = located[0];
        s.due = findDue(s.text);
        if (located[1] === 'name') {
          for (const word of wsWords(located[0])) {
            const bare = stripPunct(word).toLowerCase();
            if (bare && !HONORIFICS.has(bare)) names.add(bare);
          }
        }
      }
    }
    return names;
  }
  /* Cộng điểm cho câu mang quyết định, việc cần làm, số liệu, câu mở đầu/kết luận; trừ điểm câu hỏi và chào hỏi. */
  function applyBonuses(sentences) {
    const total = sentences.length;
    for (const s of sentences) {
      if (s.ntok < 4) { s.score = 0; continue; }
      let bonus = 0;
      if (s.decision) bonus += 0.5;
      if (s.action) bonus += 0.3;
      if (hasMetric(s.text)) bonus += 0.35;
      else if (s.hasNumber) bonus += 0.15;
      if (s.idx < 3 && total >= 4 && findPhrase(s.words, INTRO) >= 0) bonus += 0.4;
      if (findPhrase(s.words, CONCLUSION) >= 0) bonus += 0.4;
      if (findPhrase(s.words, IMPORTANCE) >= 0) bonus += 0.25;
      let score = s.score + bonus;
      if (s.question) score *= 0.5;
      if (s.greeting) score *= 0.15;
      s.score = score;
    }
  }

  // ------------------------------------------------------------------ ý chính
  /* Jaccard trên tập từ nội dung (hai câu đều không có từ nội dung coi như trùng nhau). */
  function similarity(a, b) {
    if (!a.cset.size && !b.cset.size) return 1.0;
    let shared = 0;
    for (const word of a.cset) if (b.cset.has(word)) shared += 1;
    return shared / (a.cset.size + b.cset.size - shared);
  }
  function byScore(a, b) {
    return (b.score - a.score) || (a.idx - b.idx);
  }
  function byIndex(a, b) {
    return a.idx - b.idx;
  }
  /* Chọn các câu điểm cao nhưng không lặp ý (MMR), trả về theo thứ tự xuất hiện. */
  function pickSummary(sentences, limit) {
    let ranked = sentences.filter((s) => s.ntok >= 4 && !s.greeting && !s.repeat);
    ranked.sort(byScore);
    ranked = ranked.slice(0, 200);
    if (!ranked.length) return [];
    const top = ranked[0].score;
    const chosen = [];
    let remaining = ranked;
    while (remaining.length && chosen.length < limit) {
      let best = null, bestValue = 0;
      const keep = [];
      for (const s of remaining) {
        let sim = 0;
        for (const c of chosen) {
          const value = similarity(s, c);
          if (value > sim) sim = value;
        }
        if (sim >= 0.6) continue; // gần trùng với ý đã chọn: loại hẳn
        keep.push(s);
        const relevance = top > 0 ? s.score / top : 0;
        const value = 0.7 * relevance - 0.3 * sim;
        if (best === null || value > bestValue) { best = s; bestValue = value; }
      }
      if (best === null) break;
      chosen.push(best);
      remaining = keep.filter((s) => s !== best);
    }
    chosen.sort(byIndex);
    return chosen;
  }
  function styleNumber(style, key) {
    const wanted = style ? style[key] : undefined;
    return typeof wanted === 'number' && wanted === wanted && wanted >= 1 && wanted <= 1000 ? wanted : null;
  }
  function summaryLimit(sentences, style) {
    const wanted = styleNumber(style, 'summary_items');
    if (wanted !== null) return Math.max(3, Math.min(MAX_SUMMARY, roundHalfUp(wanted)));
    let count = 0;
    for (const s of sentences) if (s.ntok >= 4 && !s.greeting && !s.repeat) count += 1;
    return Math.max(3, Math.min(MAX_SUMMARY, roundHalfUp(1.25 * Math.sqrt(count))));
  }

  // ------------------------------------------------------------ việc cần làm
  function bareParts(text) {
    return wsWords(text).map((w) => stripPunct(w).toLowerCase()).filter((p) => p);
  }
  /* Rút câu giao việc thành đầu việc: bỏ "<ai> sẽ/cần/phải" ở đầu và hạn chót ở cuối (đã có cột riêng). */
  function makeTask(sentence, owner, due) {
    const cleaned = cleanSentence(sentence);
    const words = wsWords(cleaned);
    const n = words.length;
    const low = words.map((w) => stripPunct(w).toLowerCase());
    let start = 0;
    if (owner) {
      const parts = bareParts(owner);
      const size = parts.length;
      if (size > 0) {
        for (let i = 0; i <= Math.min(n - size, 5); i++) {
          let ok = true;
          for (let k = 0; k < size; k++) if (low[i + k] !== parts[k]) { ok = false; break; }
          if (ok) {
            let j = i + size;
            if (j + 1 < n && GAP_WORDS.has(low[j])) j += 1;
            if (j < n) {
              const modal = matchAt(low, j, MODALS);
              if (modal > 0) start = j + modal;
            }
            break;
          }
        }
      }
    }
    if (start === 0 && n > 0) {
      const j = matchAt(low, 0, SUBJECTS);
      if (j < n) {
        const modal = matchAt(low, j, MODALS);
        if (modal > 0) start = j + modal;
      }
    }
    let end = n;
    if (due) {
      const parts = bareParts(due);
      const size = parts.length;
      if (size > 0 && end - size > start) {
        let ok = true;
        for (let k = 0; k < size; k++) if (low[end - size + k] !== parts[k]) { ok = false; break; }
        if (ok) {
          end -= size;
          if (end - 1 > start && DUE_PREPOSITIONS.has(low[end - 1])) end -= 1;
        }
      }
    }
    if (end - start < 2) { start = 0; end = n; }
    return truncate(capitalizeFirst(stripTerminal(words.slice(start, end).join(' '))), ITEM_CHARS);
  }
  /* "Vậy chúng ta thống nhất chốt ngân sách..." -> "Chốt ngân sách..." (nhánh Quyết định của sơ đồ). */
  function stripDecisionPrefix(cleaned) {
    const words = wsWords(cleaned);
    const n = words.length;
    if (n === 0) return cleaned;
    const low = words.map((w) => stripPunct(w).toLowerCase());
    let i = 0;
    for (let round = 0; round < 4; round++) {
      if (i >= n) break;
      const size = matchAt(low, i, DECISION_LEAD);
      if (size === 0) break;
      i += size;
    }
    if (i < n) i += matchAt(low, i, DECISION_SUBJECTS);
    if (i >= n) return cleaned;
    const verb = matchAt(low, i, DECISION_VERBS);
    if (verb === 0) return cleaned;
    i += verb;
    while (i < n && DECISION_LINKS.has(low[i])) i += 1;
    if (n - i < 3) return cleaned;
    return capitalizeFirst(words.slice(i).join(' '));
  }
  /* "Về chi phí thì chi phí quảng cáo tăng..." -> "Chi phí quảng cáo tăng..." (chỉ dùng khi nhãn quá dài). */
  function stripTopicMarker(text) {
    const words = wsWords(text);
    const n = words.length;
    if (n < 6 || !TOPIC_LEADS.has(stripPunct(words[0]).toLowerCase())) return text;
    for (let i = 2; i < Math.min(6, n - 3); i++) {
      if (stripPunct(words[i]).toLowerCase() === 'thì') return capitalizeFirst(words.slice(i + 1).join(' '));
    }
    return text;
  }
  /* Rút một câu thành nhãn ngắn cho nút lá của sơ đồ. */
  function compressLeaf(cleaned, phraseParts, limit) {
    const max = limit === undefined ? LEAF_CHARS : limit;
    let text = stripTerminal(cleaned);
    if (phraseParts && phraseParts.length) {
      const words = wsWords(text);
      const size = phraseParts.length;
      // chỉ bỏ khi sau cụm từ khóa là hư từ ("đã", "thì", "is"): nếu là danh từ thì cụm chưa hết ("dữ liệu bệnh nhân")
      if (words.length - size >= 3 && STOPWORDS.has(stripPunct(words[size]).toLowerCase())) {
        let ok = true;
        for (let k = 0; k < size; k++) if (words[k].toLowerCase() !== phraseParts[k]) { ok = false; break; }
        if (ok) {
          const rest = cleanSentence(words.slice(size).join(' '));
          if (rest) text = stripTerminal(rest);
        }
      }
    }
    if (cpLen(text) > max) text = stripTopicMarker(text);
    return truncate(capitalizeFirst(text), max);
  }
  /* "Hôm nay chúng ta họp về kế hoạch ra mắt sản phẩm mới" -> "Kế hoạch ra mắt sản phẩm mới". */
  function topicFromIntro(sentences) {
    let seen = 0;
    for (const s of sentences) {
      if (s.greeting || s.ntok < 4) continue;
      seen += 1;
      if (seen > 4) break;
      const words = wsWords(stripTerminal(cleanSentence(s.text)));
      const n = words.length;
      const low = words.map((w) => stripPunct(w).toLowerCase());
      for (let i = 0; i < n; i++) {
        const size = matchAt(low, i, TOPIC_INTRO);
        if (size === 0) continue;
        let j = i + size;
        while (j < n && TITLE_SKIP.has(low[j])) j += 1;
        let end = j;
        while (end < n && end - j < 12) {
          end += 1;
          if (TITLE_END.has(lastChar(words[end - 1]))) break;
        }
        if (end - j < 2 || STOPWORDS.has(low[j])) continue;
        return truncate(capitalizeFirst(stripTerminal(words.slice(j, end).join(' '))), TITLE_CHARS);
      }
    }
    return '';
  }
  /* Tiêu đề gợi ý: chủ đề nêu ở câu mở đầu, không có thì hai cụm từ khóa đầu, không có nữa thì câu đầu tiên. */
  function suggestTitle(keywords, sentences) {
    let title = topicFromIntro(sentences);
    if (title) return title;
    if (keywords.length) {
      title = capitalizeFirst(keywords[0]);
      if (keywords.length > 1) title += ', ' + keywords[1];
      return truncate(title, TITLE_CHARS);
    }
    for (const s of sentences) {
      if (s.ntok >= 2 && !s.greeting) return truncate(stripTerminal(cleanSentence(s.text)), TITLE_CHARS);
    }
    return '';
  }

  // ------------------------------------------------------------ sơ đồ tư duy
  const MAX_DEPTH = 4, MAX_CHILDREN = 12, MAX_TITLE = 140, USER_MAX_DEPTH = 12, USER_MAX_CHILDREN = 100;
  const TITLE_KEYS = ['title', 'name', 'label', 'text', 'topic', 'node'];
  const CHILD_KEYS = ['children', 'nodes', 'items', 'subtopics', 'branches', 'sub'];
  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
  function titleOf(node) {
    if (typeof node === 'string') return normalizeWs(node);
    if (typeof node === 'number') return String(node);
    if (isPlainObject(node)) {
      for (const key of TITLE_KEYS) {
        const value = node[key];
        if ((typeof value === 'string' || typeof value === 'number') && normalizeWs(String(value))) return normalizeWs(String(value));
      }
      const keys = Object.keys(node);
      if (keys.length === 1 && TITLE_KEYS.indexOf(keys[0]) < 0 && CHILD_KEYS.indexOf(keys[0]) < 0) return normalizeWs(keys[0]);
    }
    return '';
  }
  function childrenFromObject(value) {
    return Object.keys(value).map((k) => ({ title: k, children: Array.isArray(value[k]) ? value[k] : [value[k]] }));
  }
  function childrenOf(node) {
    if (!isPlainObject(node)) return [];
    for (const key of CHILD_KEYS) {
      const value = node[key];
      if (Array.isArray(value)) return value;
      if (isPlainObject(value)) return childrenFromObject(value);
    }
    const keys = Object.keys(node);
    if (keys.length === 1 && TITLE_KEYS.indexOf(keys[0]) < 0) {
      const value = node[keys[0]];
      if (Array.isArray(value)) return value;
      if (isPlainObject(value)) return childrenFromObject(value);
    }
    return [];
  }
  /* Chuyển cấu trúc bất kỳ thành {title, children: [...]}, bỏ nút trùng tên cùng cấp, giới hạn độ sâu và số nhánh. */
  function normalizeMindmap(raw, rootTitle, options, depth) {
    const opts = options || {};
    const maxDepth = opts.maxDepth || MAX_DEPTH, maxChildren = opts.maxChildren || MAX_CHILDREN;
    const level = depth || 0;
    const fallback = rootTitle === undefined ? 'Cuộc họp' : rootTitle;
    if (raw === null || raw === undefined) return null;
    if (Array.isArray(raw)) raw = { title: fallback, children: raw };
    let title = titleOf(raw) || (level === 0 ? fallback : '');
    if (!title) return null;
    title = cpSlice(title, MAX_TITLE);
    const children = [];
    const seen = new Set();
    if (level < maxDepth - 1) {
      for (const child of childrenOf(raw)) {
        const norm = normalizeMindmap(child, '', opts, level + 1);
        if (!norm) continue;
        const key = norm.title.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        children.push(norm);
        if (children.length >= maxChildren) break;
      }
    }
    return { title, children };
  }
  function toMarkdown(tree) {
    if (!tree) return '';
    const lines = ['# ' + (tree.title || '')];
    const walk = (node, level) => {
      for (const child of node.children || []) {
        lines.push('  '.repeat(level) + '- ' + (child.title || ''));
        walk(child, level + 1);
      }
    };
    walk(tree, 0);
    return lines.join('\n');
  }
  function countNodes(tree) {
    if (!tree) return 0;
    let total = 1;
    for (const child of tree.children || []) total += countNodes(child);
    return total;
  }

  /* Gốc -> các chủ đề (cụm từ khóa) -> ý ngắn; cộng nhánh Quyết định và Việc cần làm. Mỗi câu chỉ xuất hiện một lần. */
  function buildMindmap(title, labels, sentences, keywords, keyParts, summary, decisions, actions, style) {
    const longText = sentences.length >= 60;
    let maxTopics = longText ? 8 : 6;
    const maxLeaves = longText ? 4 : 3;
    const shownDecisions = decisions.slice(0, 6);
    const shownActions = actions.slice(0, 6);
    const special = (shownDecisions.length ? 1 : 0) + (shownActions.length ? 1 : 0);
    const wanted = styleNumber(style, 'branches');
    if (wanted !== null) maxTopics = Math.max(2, Math.min(8, roundHalfUp(wanted) - special));
    const used = new Set();
    for (const s of shownDecisions) used.add(s.idx);
    for (const pair of shownActions) used.add(pair[0].idx);
    let usable = 0;
    for (const s of sentences) if (s.ntok >= 4 && !s.greeting && !s.repeat) usable += 1;
    if (usable < 6) maxTopics = 0; // ghi chú vài câu: chia chủ đề chỉ làm rối, gom hết vào nhánh "Ý chính"
    const topics = [];
    for (const keyword of keywords) {
      if (topics.length >= maxTopics) break;
      const parts = keyParts.get(keyword);
      if (!parts || !parts.length) continue;
      const matches = sentences.filter((s) => !used.has(s.idx) && s.ntok >= 4 && !s.greeting && !s.question && !s.repeat
        && containsWords(s.words, parts));
      if (!matches.length) continue;
      matches.sort(byScore);
      const picked = matches.slice(0, maxLeaves);
      picked.sort(byIndex);
      const syllables = keyword.split(' ');
      const leaves = [];
      for (const s of picked) {
        used.add(s.idx);
        leaves.push({ title: compressLeaf(cleanSentence(s.text), syllables), children: [] });
      }
      topics.push({ first: picked[0].idx, branch: { title: capitalizeFirst(keyword), children: leaves } });
    }
    // các chủ đề xếp theo thứ tự được nhắc tới trong buổi nói
    topics.sort((a, b) => a.first - b.first);
    const branches = topics.map((t) => t.branch);
    let rest = summary.filter((s) => !used.has(s.idx));
    if (maxTopics === 0) rest = sentences.filter((s) => !used.has(s.idx) && s.ntok >= 2 && !s.greeting && !s.repeat);
    if (rest.length) {
      const leaves = [];
      for (const s of rest.slice(0, 5)) {
        used.add(s.idx);
        leaves.push({ title: compressLeaf(cleanSentence(s.text)), children: [] });
      }
      branches.push({ title: labels.main, children: leaves });
    }
    if (shownDecisions.length) {
      branches.push({
        title: labels.decisions,
        children: shownDecisions.map((s) => ({ title: compressLeaf(stripDecisionPrefix(cleanSentence(s.text))), children: [] })),
      });
    }
    if (shownActions.length) {
      const leaves = [];
      for (const pair of shownActions) {
        const item = pair[1];
        const meta = [item.owner, item.due].filter((x) => x).join(', ');
        leaves.push({ title: truncate(item.task, 60) + (meta ? ' (' + meta + ')' : ''), children: [] });
      }
      branches.push({ title: labels.actions, children: leaves });
    }
    const rootTitle = title || suggestTitle(keywords, sentences) || labels.meeting;
    return normalizeMindmap({ title: rootTitle, children: branches }, rootTitle);
  }

  // ---------------------------------------------------------------- đầu vào
  function extractDecisions(sentences) {
    const found = [];
    for (const s of sentences) if (s.decision) found.push([s, truncate(cleanSentence(s.text), ITEM_CHARS)]);
    return dedupe(found, (pair) => pair[1]).slice(0, MAX_DECISIONS);
  }
  function extractActionItems(sentences, limit) {
    const items = [];
    for (const s of sentences) {
      if (!s.action) continue;
      items.push({ s, item: { task: makeTask(s.text, s.owner, s.due), owner: s.owner, due: s.due }, seq: items.length });
    }
    // việc đã rõ người và hạn xếp trước
    const weight = (entry) => (entry.item.owner ? 1 : 0) + (entry.item.due ? 1 : 0);
    items.sort((a, b) => (weight(b) - weight(a)) || (a.seq - b.seq));
    return dedupe(items, (entry) => entry.item.task + ' | ' + entry.item.owner).slice(0, limit).map((entry) => [entry.s, entry.item]);
  }
  function stringList(value) {
    return Array.isArray(value) ? value.filter((p) => typeof p === 'string') : [];
  }
  /* Tiêu đề gợi ý cho một bản ghi chưa đặt tên. */
  function titleFor(transcript, language) {
    const text = nfc(transcript);
    const lang = resolveLanguage(language === undefined ? 'vi' : language, text);
    const sentences = analyzeSentences(text);
    const names = classify(sentences, []);
    return suggestTitle(pickKeywords(keyphraseStats(sentences), '', lang, 3, names), sentences);
  }
  /* Phân tích một bản ghi: {summary, decisions, action_items, keywords, mindmap, engine}.
     options: {title, participants, language, style: {summary_items, branches}}. */
  function analyze(transcript, options) {
    const opts = options || {};
    const participants = stringList(opts.participants);
    const text = nfc(transcript);
    const title = normalizeWs(opts.title || '');
    const lang = resolveLanguage(opts.language === undefined ? 'vi' : opts.language, text);
    const labels = LABELS[lang];
    const sentences = analyzeSentences(text);
    const names = classify(sentences, participants);
    const stats = keyphraseStats(sentences);
    const keywords = pickKeywords(stats, title, lang, 10, names);
    scoreSentences(sentences, stats, keywords);
    applyBonuses(sentences);
    const chosen = pickSummary(sentences, summaryLimit(sentences, opts.style));
    const summary = dedupe(chosen.map((s) => truncate(cleanSentence(s.text), SUMMARY_CHARS)));
    const decisions = extractDecisions(sentences);
    const actions = extractActionItems(sentences, sentences.length >= 60 ? 12 : 8);
    const mindmap = buildMindmap(title, labels, sentences, keywords, stats.parts, chosen, decisions.map((pair) => pair[0]),
      actions, opts.style);
    return {
      summary,
      decisions: decisions.map((pair) => pair[1]),
      action_items: actions.map((pair) => pair[1]),
      keywords,
      mindmap,
      engine: 'heuristic',
    };
  }
  function extractKeywords(text, limit, language) {
    const norm = nfc(text);
    return pickKeywords(keyphraseStats(analyzeSentences(norm)), '', resolveLanguage(language === undefined ? 'vi' : language, norm),
      limit === undefined ? 10 : limit);
  }

  /* Biên bản Markdown của một cuộc họp (giống /api/meetings/{id}/export.md của máy chủ). */
  function meetingMarkdown(meeting) {
    const analysis = meeting.analysis || {};
    const lines = ['# ' + meeting.title, '', '- Thời gian: ' + meeting.created_at];
    if (meeting.participants && meeting.participants.length) lines.push('- Người tham gia: ' + meeting.participants.join(', '));
    lines.push('', '## Ý chính');
    for (const s of analysis.summary || []) lines.push('- ' + s);
    if (analysis.decisions && analysis.decisions.length) {
      lines.push('', '## Quyết định');
      for (const d of analysis.decisions) lines.push('- ' + d);
    }
    if (analysis.action_items && analysis.action_items.length) {
      lines.push('', '## Việc cần làm');
      for (const item of analysis.action_items) {
        const meta = [item.owner, item.due].filter((x) => x).join(', ');
        lines.push('- [ ] ' + item.task + (meta ? ' (' + meta + ')' : ''));
      }
    }
    if (analysis.keywords && analysis.keywords.length) lines.push('', '## Từ khóa', analysis.keywords.join(', '));
    if (analysis.mindmap) lines.push('', '## Sơ đồ tư duy', '', toMarkdown(analysis.mindmap));
    if (meeting.transcript) lines.push('', '## Văn bản', '', meeting.transcript);
    return lines.join('\n') + '\n';
  }

  return {
    version: DATA.version,
    analyze, titleFor, extractKeywords, splitSentences, tokenize, normalizeWs, nfc, truncate, capitalizeFirst,
    cleanSentence, findDue, findOwner, makeTask, detectLanguage, resolveLanguage, segment, stripPunct, wsWords,
    normalizeMindmap, toMarkdown, countNodes, meetingMarkdown, cpLen,
    STOPWORDS, USER_MAX_DEPTH, USER_MAX_CHILDREN, MAX_TITLE,
  };
});
