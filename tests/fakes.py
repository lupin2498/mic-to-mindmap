"""Đối tượng giả bám sát hợp đồng thật, dùng cho test (không cần Ollama/Whisper thật).

- FakeOllama: máy chủ HTTP thật chạy trong tiến trình test, cư xử như Ollama:
  /api/tags, /api/chat (404 khi thiếu model, hỗ trợ format=json), /api/embed và
  /api/embeddings (bản Ollama cũ không có /api/embed -> 404).
- FakeTranscriber: thay Transcriber, trả kết quả cấu hình sẵn hoặc ném lỗi.
- wait_until: chờ điều kiện thay cho sleep cố định.
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from app.transcription import TranscriptResult


def wait_until(cond, timeout: float = 10.0, interval: float = 0.02) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if cond():
            return True
        time.sleep(interval)
    return bool(cond())


def fake_vector(text: str, dims: int) -> list[float]:
    """Vector xác định theo nội dung: văn bản chung từ thì cosine > 0."""
    vec = [0.0] * dims
    for word in text.lower().split():
        digest = hashlib.blake2b(word.encode("utf-8"), digest_size=4).digest()
        vec[int.from_bytes(digest, "little") % dims] += 1.0
    return vec


class FakeOllama:
    def __init__(self, models: list[str] | None = None, *, chat_reply=None, legacy_embed: bool = False,
                 embed_dims: int = 16):
        self.models = list(models if models is not None else ["qwen2.5:7b", "nomic-embed-text:latest"])
        # chat_reply: str | dict | callable(payload) -> str | dict ; dict được json.dumps
        self.chat_reply = chat_reply if chat_reply is not None else {"summary": ["Ý từ LLM"]}
        self.legacy_embed = legacy_embed
        self.embed_dims = embed_dims
        self.chat_delay = 0.0
        self.chat_status = 200
        self.raw_chat_body: str | None = None  # gửi nguyên văn chuỗi này làm thân trả lời của /api/chat
        self.embed_fail = False
        self.requests: list[tuple[str, dict]] = []
        self._lock = threading.Lock()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):  # im lặng
                pass

            def _send(self, status: int, body: dict | str) -> None:
                raw = (body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                try:
                    self.wfile.write(raw)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def _installed(self, name: str) -> bool:
                canon = name if ":" in name else f"{name}:latest"
                return canon in {m if ":" in m else f"{m}:latest" for m in outer.models}

            def do_GET(self):  # noqa: N802
                if self.path == "/api/tags":
                    self._send(200, {"models": [{"name": m, "model": m, "size": 1} for m in outer.models]})
                else:
                    self._send(404, {"error": "not found"})

            def do_POST(self):  # noqa: N802
                length = int(self.headers.get("Content-Length") or 0)
                try:
                    payload = json.loads(self.rfile.read(length) or b"{}")
                except ValueError:
                    self._send(400, {"error": "invalid json"})
                    return
                with outer._lock:
                    outer.requests.append((self.path, payload))
                model = str(payload.get("model", ""))
                if self.path == "/api/chat":
                    if not self._installed(model):
                        self._send(404, {"error": f"model '{model}' not found"})
                        return
                    if outer.chat_delay:
                        time.sleep(outer.chat_delay)
                    if outer.chat_status != 200:
                        self._send(outer.chat_status, {"error": "boom"})
                        return
                    if outer.raw_chat_body is not None:
                        self._send(200, outer.raw_chat_body)
                        return
                    reply = outer.chat_reply(payload) if callable(outer.chat_reply) else outer.chat_reply
                    content = reply if isinstance(reply, str) else json.dumps(reply, ensure_ascii=False)
                    self._send(200, {"model": model, "message": {"role": "assistant", "content": content},
                                     "done": True})
                elif self.path == "/api/embed":
                    if outer.legacy_embed:
                        self._send(404, "404 page not found")
                        return
                    if not self._installed(model) or outer.embed_fail:
                        self._send(404 if not outer.embed_fail else 500, {"error": f"model '{model}' not found"})
                        return
                    self._send(200, {"model": model,
                                     "embeddings": [fake_vector(str(payload.get("input", "")), outer.embed_dims)]})
                elif self.path == "/api/embeddings":
                    if not self._installed(model) or outer.embed_fail:
                        self._send(404 if not outer.embed_fail else 500, {"error": f"model '{model}' not found"})
                        return
                    self._send(200, {"embedding": fake_vector(str(payload.get("prompt", "")), outer.embed_dims)})
                else:
                    self._send(404, {"error": "not found"})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self._thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self._thread.start()

    def calls(self, path: str) -> list[dict]:
        with self._lock:
            return [p for (pth, p) in self.requests if pth == path]

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class FakeTranscriber:
    """Thay cho Transcriber: cùng giao diện available()/status()/transcribe()."""

    def __init__(self, text: str = "", language: str | None = "vi", duration: float | None = 42.0,
                 error: Exception | None = None, gate: threading.Event | None = None):
        self.text = text
        self.language = language
        self.duration = duration
        self.error = error
        self.gate = gate
        self.started = threading.Event()
        self.calls: list[dict] = []

    def available(self) -> bool:
        return True

    def status(self) -> dict:
        return {"available": True, "loaded": True, "model": "fake", "device": "cpu", "compute_type": "int8",
                "error": None}

    def transcribe(self, audio_path, language=None, hot_words=None) -> TranscriptResult:
        self.calls.append({"audio_path": str(audio_path), "language": language, "hot_words": list(hot_words or [])})
        self.started.set()
        if self.gate is not None:
            assert self.gate.wait(15), "FakeTranscriber: không được mở cổng trong 15 giây"
        if self.error is not None:
            raise self.error
        segments = [{"start": 0.0, "end": 1.0, "text": self.text}] if self.text else []
        return TranscriptResult(text=self.text, language=self.language, duration=self.duration, segments=segments)
