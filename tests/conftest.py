import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.config import Settings  # noqa: E402
from app.db import Database  # noqa: E402
from app.learning import AutoEmbedder, FeedbackLearner, Glossary, MemoryStore  # noqa: E402
from app.llm import OllamaClient  # noqa: E402

VI_TRANSCRIPT = (
    "Hôm nay chúng ta họp về kế hoạch ra mắt sản phẩm mới. Kế hoạch ra mắt dự kiến vào tháng 12. "
    "Khách hàng đã phản hồi tốt về bản thử nghiệm. Bộ phận marketing cần chuẩn bị chiến dịch quảng cáo cho sản phẩm mới. "
    "An sẽ phụ trách liên hệ khách hàng lớn trước thứ sáu. Chúng ta thống nhất chốt ngân sách 500 triệu cho chiến dịch. "
    "Bình phải gửi báo cáo tiến độ vào ngày 15/11. Chi đề xuất tổ chức buổi demo cho khách hàng vào tuần sau. "
    "Mọi người đồng ý tổ chức demo tại văn phòng."
)


@pytest.fixture
def settings(tmp_path) -> Settings:
    s = Settings(data_dir=tmp_path / "data", sync_jobs=True, disable_ollama=True, disable_whisper=True,
                 correction_threshold=2)
    s.ensure_dirs()
    return s


@pytest.fixture
def db(settings) -> Database:
    return Database(settings.db_path)


@pytest.fixture
def offline_ollama() -> OllamaClient:
    return OllamaClient("http://127.0.0.1:1", "test-model", "test-embed", timeout=1, enabled=False)


@pytest.fixture
def memory(db, offline_ollama) -> MemoryStore:
    return MemoryStore(db, AutoEmbedder(offline_ollama))


@pytest.fixture
def glossary(db) -> Glossary:
    return Glossary(db, threshold=2)


@pytest.fixture
def feedback(db, memory) -> FeedbackLearner:
    return FeedbackLearner(db, memory)


@pytest.fixture
def client(settings):
    from fastapi.testclient import TestClient

    from app.main import create_app

    return TestClient(create_app(settings))
