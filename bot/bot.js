// 메신저봇R 호환 앱에 등록하는 스크립트 (Rhino/ES5: const·let·화살표 함수·fetch 사용 불가)
// 0단계(서버 없이 확인)만 하려면 USE_SERVER = false 로 두세요.
//
// 서버 주소와 토큰은 이 파일에 쓰지 않고 폰의 설정 파일에서 읽습니다 (bot/config.example.json 참고).
// 앱의 파일 접근 권한이 필요하며, 경로가 다르면 CONFIG_PATH 만 바꾸세요.

var USE_SERVER = true;
var CONFIG_PATH = "/sdcard/kakaobot/config.json";

function loadConfig() {
    var file = new java.io.File(CONFIG_PATH);
    if (!file.exists()) throw new Error("설정 파일이 없습니다: " + CONFIG_PATH);

    var reader = new java.io.BufferedReader(
        new java.io.InputStreamReader(new java.io.FileInputStream(file), "UTF-8")
    );
    var lines = [];
    try {
        var line;
        while ((line = reader.readLine()) !== null) lines.push(String(line));
    } finally {
        reader.close();
    }

    var cfg = JSON.parse(lines.join("\n").replace(/^﻿/, "")); // 메모장 저장 시 붙는 BOM 제거
    if (!cfg.serverUrl || !cfg.botToken) throw new Error("config.json 에 serverUrl, botToken 이 필요합니다");
    return { serverUrl: String(cfg.serverUrl).replace(/\/+$/, ""), botToken: String(cfg.botToken) };
}

function callServer(room, msg, sender, isGroupChat) {
    var cfg = loadConfig(); // 매번 읽으므로 파일을 고치면 스크립트 재시작 없이 반영됨
    var body = JSON.stringify({
        room: String(room),
        msg: String(msg),
        sender: String(sender),
        isGroupChat: !!isGroupChat
    });
    var text = org.jsoup.Jsoup.connect(cfg.serverUrl + "/command")
        .header("Content-Type", "application/json")
        .header("X-Bot-Token", cfg.botToken)
        .requestBody(body)
        .ignoreContentType(true)
        .timeout(45000) // !ai 는 LLM 응답을 기다려야 함
        .method(org.jsoup.Connection.Method.POST)
        .execute()
        .body();
    return JSON.parse(text).reply;
}

function response(room, msg, sender, isGroupChat, replier) {
    if (!isGroupChat) return;
    if (msg.charAt(0) !== "!") return;

    if (!USE_SERVER) {
        if (msg === "!ping") replier.reply("pong!");
        return;
    }

    try {
        var reply = callServer(room, msg, sender, isGroupChat);
        if (reply) replier.reply(reply);
    } catch (e) {
        Log.e("bot error: " + e); // 서버 꺼짐/네트워크 오류 시 조용히 무응답
    }
}
