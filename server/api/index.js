// Vercel 서버리스 함수 진입점. vercel.json이 모든 경로를 이 함수로 보낸다.
import { createServerApp } from '../src/services.js';

let ready;

export default async function handler(req, res) {
  // 인스턴스가 살아 있는 동안 앱을 재사용한다 (콜드 스타트 때만 생성).
  ready ??= (async () => {
    const app = createServerApp();
    await app.ready();
    return app;
  })().catch((err) => {
    ready = undefined; // 설정 오류 후 환경변수를 고치면 다음 요청에서 다시 시도
    throw err;
  });

  const app = await ready;
  app.server.emit('request', req, res);
}
