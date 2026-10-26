from app.llm import OllamaClient, extract_json


def test_extract_json_variants():
    assert extract_json('{"a": 1}') == {"a": 1}
    assert extract_json('```json\n{"a": [1, 2,],}\n```') == {"a": [1, 2]}
    assert extract_json('Kết quả: {"summary": ["x"]} hết.') == {"summary": ["x"]}
    assert extract_json("[1, 2]") is None
    assert extract_json("không có json") is None
    assert extract_json("") is None


def test_offline_client_is_safe():
    client = OllamaClient("http://127.0.0.1:1", "m", "e", timeout=1, enabled=True)
    assert client.available(refresh=True) is False
    assert client.chat_available() is False
    assert client.chat("s", "u") is None
    assert client.chat_json("s", "u") is None
    assert client.embed("xin chào") is None
    status = client.status()
    assert status["available"] is False and status["models"] == []


def test_disabled_client():
    client = OllamaClient("http://127.0.0.1:11434", "m", "e", enabled=False)
    assert client.models() == [] and client.status()["enabled"] is False
