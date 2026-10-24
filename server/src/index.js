import Anthropic from '@anthropic-ai/sdk';
import { createAi, DEFAULT_MODEL } from './ai.js';
import { buildApp } from './app.js';
import { createChatStore, createTodoStore, openDb } from './db.js';

const {
  PORT = '3000',
  BOT_TOKEN,
  DB_PATH = './data/bot.db',
  ANTHROPIC_API_KEY,
  AI_MODEL = DEFAULT_MODEL,
  AI_HISTORY_TURNS = '10',
  AI_COOLDOWN_SEC = '5',
} = process.env;

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is not set. Copy .env.example to .env and set a token.');
  process.exit(1);
}

const db = openDb(DB_PATH);

const app = buildApp({
  todos: createTodoStore(db),
  token: BOT_TOKEN,
  logger: true,
  ai: createAi({
    client: ANTHROPIC_API_KEY
      ? new Anthropic({ apiKey: ANTHROPIC_API_KEY, timeout: 30_000, maxRetries: 1 })
      : null,
    chats: createChatStore(db),
    model: AI_MODEL,
    historyTurns: Number(AI_HISTORY_TURNS),
    cooldownSec: Number(AI_COOLDOWN_SEC),
    onError: (msg, err) => app.log.error({ err }, msg),
  }),
});

if (!ANTHROPIC_API_KEY) app.log.warn('ANTHROPIC_API_KEY is not set; !ai is disabled.');

await app.listen({ port: Number(PORT), host: '0.0.0.0' });
