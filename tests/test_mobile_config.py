"""Kiểm tĩnh bản di động: www dựng từ app/static và cấu hình native (Capacitor 7) đủ quyền ghi âm, gọi HTTP trong LAN."""
import json
import plistlib
import re
import shutil
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
MOBILE = ROOT / "mobile"
ANDROID_NS = "{http://schemas.android.com/apk/res/android}"


@pytest.fixture(scope="module")
def www():
    if shutil.which("node") is None:
        pytest.skip("không có node để chạy mobile/build-web.js")
    subprocess.run(["node", str(MOBILE / "build-web.js")], check=True, capture_output=True)
    return MOBILE / "www"


def test_www_is_built_from_static_with_mobile_flag(www):
    html = (www / "index.html").read_text(encoding="utf-8")
    assert "/static/" not in html, "bản di động không được trỏ tới /static/ (Capacitor phục vụ từ gốc)"
    flag, mm, app = html.index("window.M2M_MOBILE = true"), html.index('src="./mindmap.js"'), html.index('src="./app.js"')
    assert flag < mm < app, "cờ M2M_MOBILE phải được đặt trước khi app.js chạy"
    assert 'href="./style.css"' in html
    for name in ("app.js", "mindmap.js", "style.css"):
        assert (www / name).read_bytes() == (ROOT / "app" / "static" / name).read_bytes()
    # mọi tài nguyên index.html tham chiếu đều có trong www và không phụ thuộc CDN
    refs = re.findall(r'<(?:script|img|audio)\b[^>]*\bsrc="([^"]+)"', html) + re.findall(r'<link\b[^>]*\bhref="([^"]+)"', html)
    assert len(refs) >= 3
    for ref in refs:
        if ref.startswith(("data:", "#")):
            continue
        assert ref.startswith("./"), f"tài nguyên ngoài gói: {ref}"
        assert (www / ref[2:]).is_file(), ref


def test_capacitor_config_allows_http_lan_server():
    config = json.loads((MOBILE / "capacitor.config.json").read_text(encoding="utf-8"))
    assert config["webDir"] == "www" and re.fullmatch(r"[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+", config["appId"])
    # origin http://localhost: gọi được API http trong LAN (không bị chặn nội dung hỗn hợp) và vẫn là secure context cho micro
    assert config["server"]["androidScheme"] == "http" and config["server"]["cleartext"] is True
    package = json.loads((MOBILE / "package.json").read_text(encoding="utf-8"))
    majors = {name: re.search(r"\d+", ver).group(0) for name, ver in {**package["dependencies"], **package["devDependencies"]}.items()
              if name.startswith("@capacitor/")}
    assert set(majors.values()) == {"7"}, f"các gói Capacitor phải cùng bản lớn: {majors}"
    gradle = (MOBILE / "android" / "app" / "build.gradle").read_text(encoding="utf-8")
    assert f'applicationId "{config["appId"]}"' in gradle


def test_android_manifest_permissions_and_cleartext():
    root = ET.parse(MOBILE / "android" / "app" / "src" / "main" / "AndroidManifest.xml").getroot()
    perms = {p.get(f"{ANDROID_NS}name") for p in root.iter("uses-permission")}
    # WebView getUserMedia cần RECORD_AUDIO + MODIFY_AUDIO_SETTINGS; gọi máy chủ LAN cần INTERNET
    assert {"android.permission.INTERNET", "android.permission.RECORD_AUDIO",
            "android.permission.MODIFY_AUDIO_SETTINGS"} <= perms
    app = root.find("application")
    assert app.get(f"{ANDROID_NS}usesCleartextTraffic") == "true"
    activity = app.find("activity")
    assert activity.get(f"{ANDROID_NS}exported") == "true"
    # xoay màn hình không được khởi động lại Activity (mất bản ghi đang dở)
    assert {"orientation", "screenSize", "keyboardHidden"} <= set(activity.get(f"{ANDROID_NS}configChanges").split("|"))
    dangerous = {p for p in perms if p.split(".")[-1] in {"READ_EXTERNAL_STORAGE", "WRITE_EXTERNAL_STORAGE", "CAMERA",
                                                           "ACCESS_FINE_LOCATION", "READ_CONTACTS"}}
    assert not dangerous, f"quyền thừa: {dangerous}"


def test_ios_info_plist_microphone_and_ats():
    with (MOBILE / "ios" / "App" / "App" / "Info.plist").open("rb") as fh:
        plist = plistlib.load(fh)
    assert plist["NSMicrophoneUsageDescription"].strip(), "thiếu mô tả quyền micro: iOS sẽ đóng app khi xin quyền"
    assert plist["NSLocalNetworkUsageDescription"].strip()
    ats = plist["NSAppTransportSecurity"]
    assert ats.get("NSAllowsArbitraryLoads") is True or ats.get("NSAllowsLocalNetworking") is True
    assert plist["CFBundleDisplayName"] == "Mic to Mindmap"
    assert "UIInterfaceOrientationPortrait" in plist["UISupportedInterfaceOrientations"]


def test_workflow_builds_both_platforms_from_fresh_www():
    text = (ROOT / ".github" / "workflows" / "mobile-build.yml").read_text(encoding="utf-8")
    assert text.count("npm run build:web") == 2, "cả hai job phải dựng lại www từ app/static"
    assert "npx cap sync android" in text and "npx cap copy ios" in text
    assert '"app/static/**"' in text and '"mobile/**"' in text
    assert "CODE_SIGNING_ALLOWED=NO" in text
