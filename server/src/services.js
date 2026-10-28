import { Redis } from '@upstash/redis';
import OpenAI from 'openai';
import { createAi, DEFAULT_MODEL } from './ai.js';
import { buildApp } from './app.js';
import { createMemoryRedis } from './memory-redis.js';
import { createChatStore, createTodoStore } from './store.js';

/** env로부터 Fastify 앱을 만든다. 로컬 실행(index.js)과 Vercel(api/index.js)이 공유한다. */
export function createServerApp(env = process.env) {
  const {
    BOT_TOKEN,
    OPENAI_API_KEY,
    OPENAI_BASE_URL,
    AI_MODEL = DEFAULT_MODEL,
    AI_REASONING_EFFORT = '',
    AI_HISTORY_TURNS = '10',
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
      // baseURL이 비어 있으면 SDK 기본값(https://api.openai.com/v1)을 쓴다.
      client: OPENAI_API_KEY
        ? new OpenAI({
            apiKey: OPENAI_API_KEY,
            baseURL: OPENAI_BASE_URL || undefined,
            timeout: 30_000,
            maxRetries: 1,
          })
        : null,
      chats: createChatStore(redis),
      model: AI_MODEL,
      reasoningEffort: AI_REASONING_EFFORT,
      historyTurns: Number(AI_HISTORY_TURNS),
      cooldownSec: Number(AI_COOLDOWN_SEC),
      onError: (msg, err) => app.log.error({ err }, msg),
    }),
  });

  if (!persistent) {
    app.log.warn('UPSTASH_REDIS_REST_URL/TOKEN is not set; using in-memory storage (data is lost on restart).');
  }
  if (!OPENAI_API_KEY) app.log.warn('OPENAI_API_KEY is not set; !ai is disabled.');

  return app;
}
