"""Kiểm tĩnh bản di động: www dựng từ app/static, chạy độc lập được, và cấu hình native (Capacitor 7) đủ quyền ghi âm,
nhận dạng giọng nói bằng plugin M2MSpeech của chính ứng dụng, gọi HTTP trong LAN khi người dùng nhập máy chủ."""
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
    scripts = re.findall(r'<script src="([^"]+)"></script>', html)
    # thứ tự nạp: dữ liệu -> bộ máy -> nhận dạng giọng nói -> kho trên máy -> sơ đồ -> giao diện
    assert scripts == ["./engine-data.js", "./engine.js", "./speech.js", "./local.js", "./mindmap.js", "./app.js"]
    flag = html.index("window.M2M_MOBILE = true")
    assert flag < html.index('src="./engine-data.js"'), "cờ M2M_MOBILE phải được đặt trước mọi script (app.js dựa vào nó để chạy độc lập)"
    assert 'href="./style.css"' in html
    for name in ("app.js", "engine.js", "engine-data.js", "speech.js", "local.js", "mindmap.js", "style.css"):
        assert (www / name).read_bytes() == (ROOT / "app" / "static" / name).read_bytes()
    # mọi tài nguyên index.html tham chiếu đều có trong www và không phụ thuộc CDN: ứng dụng chạy được khi không có mạng
    refs = re.findall(r'<(?:script|img|audio)\b[^>]*\bsrc="([^"]+)"', html) + re.findall(r'<link\b[^>]*\bhref="([^"]+)"', html)
    assert len(refs) >= 7
    for ref in refs:
        if ref.startswith(("data:", "#")):
            continue
        assert ref.startswith("./"), f"tài nguyên ngoài gói: {ref}"
        assert (www / ref[2:]).is_file(), ref
    for name in ("app.js", "engine.js", "speech.js", "local.js", "mindmap.js"):
        source = (www / name).read_text(encoding="utf-8")
        assert not re.search(r"https?://(?!ollama\.com)[a-z0-9.-]+\.[a-z]{2,}", source.replace("http://www.w3.org/2000/svg", "")), \
            f"{name}: không được gọi ra dịch vụ bên ngoài"
        # WebView cũ của iOS (trước 16.4) báo lỗi cú pháp với lookbehind và cả file không chạy
        assert "(?<" not in source, f"{name}: không dùng lookbehind trong biểu thức chính quy"


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
    # Android 11+: không khai báo <queries> thì ứng dụng không thấy dịch vụ nhận dạng giọng nói của máy
    queried = {action.get(f"{ANDROID_NS}name") for queries in root.iter("queries") for action in queries.iter("action")}
    assert "android.speech.RecognitionService" in queried


def test_android_registers_the_speech_plugin():
    java = MOBILE / "android" / "app" / "src" / "main" / "java" / "vn" / "mictomindmap" / "app"
    activity = (java / "MainActivity.java").read_text(encoding="utf-8")
    register, create = activity.index("registerPlugin(SpeechPlugin.class)"), activity.index("super.onCreate(")
    assert register < create, "plugin phải được đăng ký trước super.onCreate, nếu không trang web không thấy nó"
    plugin = (java / "SpeechPlugin.java").read_text(encoding="utf-8")
    assert '@CapacitorPlugin(' in plugin and 'name = "M2MSpeech"' in plugin
    # đúng các phương thức và sự kiện mà app/static/speech.js dùng
    methods = set(re.findall(r"@PluginMethod\s+public void (\w+)\(", plugin))
    assert methods == {"available", "start", "stop", "keepAwake"}
    events = set(re.findall(r'notifyListeners\("(\w+)"', plugin))
    assert events == {"partial", "final", "state", "error", "level"}
    speech_js = (ROOT / "app" / "static" / "speech.js").read_text(encoding="utf-8")
    assert set(re.findall(r"on\('(\w+)'", speech_js)) == events
    for method in methods - {"available"}:
        assert f"plugin.{method}(" in speech_js, method
    # vòng lặp nhận dạng không được phụ thuộc Android để còn kiểm được trên JVM
    loop = (java / "SpeechLoop.java").read_text(encoding="utf-8")
    assert "import android" not in loop and "import com.getcapacitor" not in loop
    assert (MOBILE / "android" / "app" / "src" / "test" / "java" / "vn" / "mictomindmap" / "app" / "SpeechLoopTest.java").is_file()


def test_ios_registers_the_speech_plugin():
    app = MOBILE / "ios" / "App" / "App"
    plugin = (app / "SpeechPlugin.swift").read_text(encoding="utf-8")
    assert 'public let jsName = "M2MSpeech"' in plugin and "CAPBridgedPlugin" in plugin
    declared = set(re.findall(r'CAPPluginMethod\(name: "(\w+)"', plugin))
    implemented = set(re.findall(r"@objc func (\w+)\(_ call: CAPPluginCall\)", plugin))
    assert declared == implemented == {"available", "start", "stop", "keepAwake"}
    assert set(re.findall(r'notifyListeners\("(\w+)"', plugin)) == {"partial", "final", "state", "error", "level"}
    controller = (app / "MainViewController.swift").read_text(encoding="utf-8")
    assert "registerPluginInstance(SpeechPlugin())" in controller
    storyboard = ET.parse(app / "Base.lproj" / "Main.storyboard").getroot()
    scene = storyboard.find(".//viewController")
    assert scene.get("customClass") == "MainViewController" and scene.get("customModule") == "App"
    # file Swift mới phải nằm trong danh sách biên dịch của Xcode, nếu không ứng dụng dựng xong vẫn thiếu plugin
    project = (MOBILE / "ios" / "App" / "App.xcodeproj" / "project.pbxproj").read_text(encoding="utf-8")
    for name in ("SpeechPlugin.swift", "MainViewController.swift"):
        assert f"/* {name} in Sources */," in project and f"path = {name};" in project, name
    ids = re.findall(r"^\t\t([0-9A-F]{24}) /\* .*? \*/ = \{", project, flags=re.M)
    assert len(ids) == len(set(ids)), "mã đối tượng trùng trong project.pbxproj"


def test_ios_info_plist_microphone_and_ats():
    with (MOBILE / "ios" / "App" / "App" / "Info.plist").open("rb") as fh:
        plist = plistlib.load(fh)
    assert plist["NSMicrophoneUsageDescription"].strip(), "thiếu mô tả quyền micro: iOS sẽ đóng app khi xin quyền"
    assert plist["NSSpeechRecognitionUsageDescription"].strip(), "thiếu mô tả quyền nhận dạng giọng nói: iOS sẽ đóng app khi xin quyền"
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
    assert "testDebugUnitTest" in text, "CI phải chạy bài kiểm vòng lặp nhận dạng giọng nói của Android"
