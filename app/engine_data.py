"""Dữ liệu ngôn ngữ của bộ máy tóm tắt không cần AI.

Dùng chung một file với giao diện (app/static/engine-data.js): bản JavaScript chạy trên điện thoại/trình duyệt và
bản Python chạy trên máy chủ phải cho cùng kết quả, nên không được có hai bản danh sách từ khác nhau."""
from __future__ import annotations

import json
from pathlib import Path

DATA_PATH = Path(__file__).resolve().parent / "static" / "engine-data.js"
_BEGIN, _END = "/*M2M-DATA-BEGIN*/", "/*M2M-DATA-END*/"


def load_engine_data(path: Path = DATA_PATH) -> dict:
    text = path.read_text(encoding="utf-8")
    start = text.index(_BEGIN) + len(_BEGIN)
    return json.loads(text[start:text.index(_END, start)])


DATA: dict = load_engine_data()
