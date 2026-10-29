import { Redis } from '@upstash/redis';
import OpenAI from 'openai';
import { createAi } from './ai.js';
import { buildApp } from './app.js';
import { createMemoryRedis } from './memory-redis.js';
import { createChatStore, createTodoStore } from './store.js';

/** env로부터 Fastify 앱을 만든다. 로컬 실행(index.js)과 Vercel(api/index.js)이 공유한다. */
export function createServerApp(env = process.env) {
  const {
    BOT_TOKEN,
    OPENAI_API_KEY,
    OPENAI_AGENT_ID,
    AI_COOLDOWN_SEC = '5',
    // Vercel Marketplace의 Upstash 연동은 KV_REST_API_* 이름으로 넣어 준다.
    UPSTASH_REDIS_REST_URL = env.KV_REST_API_URL,
    UPSTASH_REDIS_REST_TOKEN = env.KV_REST_API_TOKEN,
  } = env;

  if (!BOT_TOKEN) throw new Error('BOT_TOKEN is not set. Copy .env.example to .env and set a token.');

  const persistent = Boolean(UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN);
  const redis = persistent
    ? new Redis({
        url: UPSTASH_REDIS_REST_URL,
        token: UPSTASH_REDIS_REST_TOKEN,
        automaticDeserialization: false, // store.js가 JSON을 직접 다룬다 ("123" 같은 문자열이 숫자로 바뀌는 것 방지)
      })
    : createMemoryRedis();

  const app = buildApp({
    todos: createTodoStore(redis),
    token: BOT_TOKEN,
    logger: true,
    ai: createAi({
      // 에이전트 한 턴이 오래 걸릴 수 있어 Vercel maxDuration(60초) 안쪽으로 제한한다.
      // 세션 생성을 재시도하면 세션이 중복으로 생길 수 있어 재시도는 끈다.
      client: OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY, timeout: 55_000, maxRetries: 0 }) : null,
      agentId: OPENAI_AGENT_ID,
      chats: createChatStore(redis),
      cooldownSec: Number(AI_COOLDOWN_SEC),
      onError: (msg, err) => app.log.error({ err }, msg),
    }),
  });

  if (!persistent) {
    app.log.warn('UPSTASH_REDIS_REST_URL/TOKEN is not set; using in-memory storage (data is lost on restart).');
  }
  if (!OPENAI_API_KEY || !OPENAI_AGENT_ID) app.log.warn('OPENAI_API_KEY/OPENAI_AGENT_ID is not set; !ai is disabled.');

  return app;
}
