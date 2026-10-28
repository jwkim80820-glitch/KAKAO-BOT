// 메신저봇R 호환 앱에 등록하는 스크립트 (Rhino/ES5: const·let·화살표 함수·fetch 사용 불가)
// 0단계(서버 없이 확인)만 하려면 USE_SERVER = false 로 두세요.

var USE_SERVER = true;
var SERVER_URL = "https://your-project.vercel.app"; // Vercel 배포 주소 (로컬 테스트면 http://<PC-IP>:3000)
var BOT_TOKEN = "change-me-to-a-long-random-string"; // Vercel 환경변수 BOT_TOKEN 과 동일하게

function callServer(room, msg, sender, isGroupChat) {
    var body = JSON.stringify({
        room: String(room),
        msg: String(msg),
        sender: String(sender),
        isGroupChat: !!isGroupChat
    });
    var text = org.jsoup.Jsoup.connect(SERVER_URL + "/command")
        .header("Content-Type", "application/json")
        .header("X-Bot-Token", BOT_TOKEN)
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
