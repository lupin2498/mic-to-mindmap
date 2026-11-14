#!/usr/bin/env node
/* Chạy bộ máy JavaScript (app/static/engine.js) trên các ca đọc từ stdin, in kết quả JSON ra stdout.
   Dùng cho tests/test_engine_parity.py (so với bản Python) và để thử nhanh bằng tay:
     echo '[{"fn":"analyze","text":"...","title":"","participants":[],"language":"vi"}]' | node tests/js/engine_cli.js */
'use strict';
const path = require('path');
const engine = require(path.resolve(__dirname, '..', '..', 'app', 'static', 'engine.js'));

function run(c) {
  switch (c.fn) {
    case 'analyze':
      return engine.analyze(c.text, { title: c.title, participants: c.participants, language: c.language, style: c.style });
    case 'title': return engine.titleFor(c.text, c.language);
    case 'keywords': return engine.extractKeywords(c.text, c.limit, c.language);
    case 'sentences': return engine.splitSentences(c.text);
    case 'tokens': return engine.tokenize(c.text);
    case 'segment': return engine.segment(engine.tokenize(c.text));
    case 'clean': return engine.cleanSentence(c.text);
    case 'due': return engine.findDue(c.text);
    case 'owner': return engine.findOwner(c.text, c.participants || []);
    case 'task': return engine.makeTask(c.text, c.owner || '', c.due || '');
    case 'truncate': return engine.truncate(c.text, c.limit);
    case 'mindmap': return engine.normalizeMindmap(c.tree, c.root, c.user ? { maxDepth: engine.USER_MAX_DEPTH, maxChildren: engine.USER_MAX_CHILDREN } : undefined);
    case 'markdown': return engine.meetingMarkdown(c.meeting);
    case 'language': return engine.resolveLanguage(c.language, c.text);
    default: throw new Error(`fn không hỗ trợ: ${c.fn}`);
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const cases = JSON.parse(input);
  const out = cases.map((c) => {
    try { return { ok: run(c) }; } catch (err) { return { error: String(err && err.stack || err) }; }
  });
  process.stdout.write(JSON.stringify(out));
});
