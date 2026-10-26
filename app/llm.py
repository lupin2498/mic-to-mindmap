"""Client Ollama (LLM local) + tiện ích phân tích JSON an toàn."""
from __future__ import annotations

import json
import logging
import re
import threading
import time
from typing import Any

import httpx

log = logging.getLogger(__name__)


def extract_json(text: str) -> dict | None:
    """Tìm và parse đối tượng JSON đầu tiên trong văn bản trả về từ LLM."""
    if not text:
        return None
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.IGNORECASE | re.MULTILINE).strip()
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else None
    except ValueError:
        pass
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    candidate = text[start:end + 1]
    for attempt in (candidate, re.sub(r",\s*([}\]])", r"\1", candidate)):
        try:
            data = json.loads(attempt)
            return data if isinstance(data, dict) else None
        except ValueError:
            continue
    return None


class OllamaClient:
    """Giao tiếp với Ollama qua REST API. Mọi lỗi mạng được nuốt và trả về None."""

    def __init__(self, base_url: str, model: str, embed_model: str, timeout: float = 600, enabled: bool = True):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.embed_model = embed_model
        self.timeout = timeout
        self.enabled = enabled
        self._models: list[str] = []
        self._checked_at = 0.0
        self._lock = threading.Lock()

    # ------------------------------------------------------------ discovery
    def models(self, refresh: bool = False) -> list[str]:
        if not self.enabled:
            return []
        with self._lock:
            if not refresh and time.monotonic() - self._checked_at < 20:
                return self._models
            try:
                resp = httpx.get(f"{self.base_url}/api/tags", timeout=3.0)
                resp.raise_for_status()
                self._models = [m.get("name", "") for m in resp.json().get("models", [])]
            except Exception as exc:  # noqa: BLE001 - mọi lỗi đều nghĩa là "không có Ollama"
                log.debug("Ollama không khả dụng: %s", exc)
                self._models = []
            self._checked_at = time.monotonic()
            return self._models

    def available(self, refresh: bool = False) -> bool:
        return bool(self.models(refresh))

    def has_model(self, name: str) -> bool:
        base = name.split(":")[0]
        return any(m == name or m.split(":")[0] == base for m in self.models())

    def chat_available(self) -> bool:
        return self.available() and self.has_model(self.model)

    def embed_available(self) -> bool:
        return self.available() and self.has_model(self.embed_model)

    def status(self) -> dict:
        models = self.models(refresh=True)
        return {
            "enabled": self.enabled,
            "url": self.base_url,
            "available": bool(models),
            "model": self.model,
            "model_ready": self.has_model(self.model) if models else False,
            "embed_model": self.embed_model,
            "embed_ready": self.has_model(self.embed_model) if models else False,
            "models": models,
        }

    # ------------------------------------------------------------ generation
    def chat(self, system: str, user: str, *, json_mode: bool = False, temperature: float = 0.2,
             num_ctx: int = 12288) -> str | None:
        if not self.enabled:
            return None
        payload: dict[str, Any] = {
            "model": self.model,
            "stream": False,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "options": {"temperature": temperature, "num_ctx": num_ctx},
        }
        if json_mode:
            payload["format"] = "json"
        try:
            resp = httpx.post(f"{self.base_url}/api/chat", json=payload, timeout=self.timeout)
            resp.raise_for_status()
            return resp.json().get("message", {}).get("content", "")
        except Exception as exc:  # noqa: BLE001
            log.warning("Ollama chat lỗi: %s", exc)
            return None

    def chat_json(self, system: str, user: str, **kwargs: Any) -> dict | None:
        content = self.chat(system, user, json_mode=True, **kwargs)
        data = extract_json(content or "")
        if data is None and content:
            log.warning("Ollama trả về JSON không hợp lệ: %.200s", content)
        return data

    # ------------------------------------------------------------ embeddings
    def embed(self, text: str) -> list[float] | None:
        if not self.enabled or not text.strip():
            return None
        try:
            resp = httpx.post(
                f"{self.base_url}/api/embed",
                json={"model": self.embed_model, "input": text},
                timeout=min(self.timeout, 120),
            )
            if resp.status_code == 404:
                resp = httpx.post(
                    f"{self.base_url}/api/embeddings",
                    json={"model": self.embed_model, "prompt": text},
                    timeout=min(self.timeout, 120),
                )
                resp.raise_for_status()
                vec = resp.json().get("embedding")
            else:
                resp.raise_for_status()
                vectors = resp.json().get("embeddings") or []
                vec = vectors[0] if vectors else None
            return [float(x) for x in vec] if vec else None
        except Exception as exc:  # noqa: BLE001
            log.warning("Ollama embed lỗi: %s", exc)
            return None
