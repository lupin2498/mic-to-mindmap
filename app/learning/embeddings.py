"""Tạo vector nhúng: ưu tiên Ollama (nomic-embed-text...), dự phòng bằng hashing thuần Python."""
from __future__ import annotations

import hashlib
import math
from collections import Counter

from ..llm import OllamaClient
from ..textutil import content_tokens

HASH_DIMS = 512
HASH_MODEL_NAME = f"hash-{HASH_DIMS}"


def cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


class HashingEmbedder:
    """Vector túi-từ băm (unigram + bigram), chuẩn hóa L2. Không cần model, chạy mọi nơi."""

    name = HASH_MODEL_NAME

    def __init__(self, dims: int = HASH_DIMS):
        self.dims = dims

    def _slot(self, token: str) -> tuple[int, float]:
        digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
        index = int.from_bytes(digest[:4], "little") % self.dims
        sign = 1.0 if digest[4] & 1 else -1.0
        return index, sign

    def embed(self, text: str) -> list[float]:
        tokens = content_tokens(text)
        features: Counter = Counter(tokens)
        for a, b in zip(tokens, tokens[1:]):
            features[f"{a}_{b}"] += 1
        vec = [0.0] * self.dims
        for feature, count in features.items():
            index, sign = self._slot(feature)
            vec[index] += sign * (1.0 + math.log(count))
        norm = math.sqrt(sum(v * v for v in vec))
        if norm > 0:
            vec = [v / norm for v in vec]
        return vec


class AutoEmbedder:
    """Dùng Ollama nếu có model nhúng, luôn kèm vector băm để mọi trí nhớ đều tìm được."""

    def __init__(self, ollama: OllamaClient | None):
        self.ollama = ollama
        self.hashing = HashingEmbedder()

    @property
    def primary_name(self) -> str:
        if self.ollama and self.ollama.embed_available():
            return f"ollama:{self.ollama.embed_model}"
        return HASH_MODEL_NAME

    def embed(self, text: str) -> tuple[list[float], str, list[float]]:
        """Trả về (vector chính, tên model, vector băm)."""
        hashed = self.hashing.embed(text)
        if self.ollama and self.ollama.embed_available():
            vec = self.ollama.embed(text[:8000])
            if vec:
                return vec, f"ollama:{self.ollama.embed_model}", hashed
        return hashed, HASH_MODEL_NAME, hashed
