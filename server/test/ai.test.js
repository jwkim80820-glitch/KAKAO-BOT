import { test } from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { createAi } from '../src/ai.js';
import { buildApp } from '../src/app.js';
import { runCommand } from '../src/commands.js';
import { createMemoryRedis } from '../src/memory-redis.js';
import { createChatStore, createTodoStore } from '../src/store.js';

/** responses: 호출마다 순서대로 소비. Error면 throw. */
function fakeClient(responses) {
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        async create(params) {
          calls.push(structuredClone(params));
          const r = responses.shift();
          if (r instanceof Error) throw r;
          return r;
        },
      },
    },
  };
}

const reply = (finish_reason, content) => ({ choices: [{ finish_reason, message: { role: 'assistant', content } }] });
const ok = (t) => reply('stop', t);

function setup({ responses = [], ...opts } = {}) {
  const db = createMemoryRedis();
  const client = fakeClient(responses);
  let clock = 1_000_000;
  const ai = createAi({
    client: opts.noClient ? null : client,
    chats: createChatStore(db),
    now: () => clock,
    ...opts,
  });
  return { ai, client, advance: (ms) => (clock += ms), todos: createTodoStore(db) };
}

const ask = (ai, question, room = 'A', sender = 'kim') => ai.ask({ room, sender, question });

test('sends the expected chat completions request', async () => {
  const { ai, client } = setup({ responses: [ok('안녕하세요!')] });
  assert.equal(await ask(ai, '안녕'), '안녕하세요!');

  const req = client.calls[0];
  assert.equal(req.model, 'gpt-6-luna');
  assert.equal(req.max_completion_tokens, 2048);
  assert.equal('reasoning_effort' in req, false);
  assert.equal(req.messages[0].role, 'system');
  assert.match(req.messages[0].content, /한국어/);
  assert.deepEqual(req.messages.slice(1), [{ role: 'user', content: '[kim] 안녕' }]);
});

test('reasoningEffort is sent only when configured', async () => {
  const { ai, client } = setup({ reasoningEffort: 'low', responses: [ok('x')] });
  await ask(ai, '안녕');
  assert.equal(client.calls[0].reasoning_effort, 'low');
});

// 시스템 메시지를 뺀 대화 내역
const history = (call) => call.messages.slice(1);

test('remembers the room conversation, only text is stored', async () => {
  const { ai, client, advance } = setup({ responses: [ok('첫 답'), ok('둘째 답')] });
  await ask(ai, '하나');
  advance(10_000);
  await ask(ai, '둘', 'A', 'lee');

  assert.deepEqual(history(client.calls[1]), [
    { role: 'user', content: '[kim] 하나' },
    { role: 'assistant', content: '첫 답' },
    { role: 'user', content: '[lee] 둘' },
  ]);
});

test('history is separated per room and trimmed to historyTurns', async () => {
  const { ai, client, advance } = setup({
    historyTurns: 2,
    responses: [ok('a1'), ok('a2'), ok('a3'), ok('b1'), ok('a4')],
  });
  for (const q of ['q1', 'q2', 'q3']) {
    await ask(ai, q);
    advance(10_000);
  }
  await ask(ai, 'other', 'B');
  assert.equal(history(client.calls[3]).length, 1); // 방 B는 독립

  advance(10_000);
  await ask(ai, 'q4');
  const sent = history(client.calls[4]).map((m) => m.content);
  assert.deepEqual(sent, ['[kim] q2', 'a2', '[kim] q3', 'a3', '[kim] q4']); // q1 삭제됨
});

test('reset clears the room memory', async () => {
  const { ai, client, advance } = setup({ responses: [ok('x'), ok('y')] });
  await ask(ai, '기억해');
  assert.match(await ai.reset('A'), /지웠어요/);
  advance(10_000);
  await ask(ai, '다시');
  assert.equal(history(client.calls[1]).length, 1);
});

test('cooldown, empty and too long questions never call the API', async () => {
  const { ai, client, advance } = setup({ responses: [ok('x'), ok('z'), ok('y')] });
  assert.match(await ask(ai, '  '), /사용법/);
  assert.match(await ask(ai, 'x'.repeat(501)), /500자/);
  await ask(ai, '하나');
  assert.match(await ask(ai, '또'), /5초 뒤/);
  assert.equal(client.calls.length, 1);

  assert.equal(await ask(ai, '다른 사람', 'A', 'lee'), 'z'); // 쿨다운은 보낸이별
  advance(5_000);
  assert.equal(await ask(ai, '이제 가능'), 'y');
});

test('missing API key gives a setup hint', async () => {
  const { ai } = setup({ noClient: true });
  assert.match(await ask(ai, '안녕'), /OPENAI_API_KEY/);
});

test('refusal, empty reply and API errors reply politely and are not stored', async () => {
  const errors = [];
  const rateLimit = new OpenAI.RateLimitError(429, {}, 'slow down', new Headers());
  const { ai, client, advance } = setup({
    onError: (m) => errors.push(m),
    responses: [
      reply('content_filter', ''),
      reply('stop', ''),
      rateLimit,
      new Error('boom'),
      ok('정상'),
    ],
  });
  const replies = [];
  for (const q of ['1', '2', '3', '4', '5']) {
    replies.push(await ask(ai, q));
    advance(10_000);
  }
  assert.match(replies[0], /답변하기 어려워요/);
  assert.match(replies[1], /다시 물어봐/);
  assert.match(replies[2], /요청이 많아요/);
  assert.match(replies[3], /문제가 생겼어요/);
  assert.equal(replies[4], '정상');
  assert.equal(errors.length, 2);
  assert.deepEqual(history(client.calls[4]), [{ role: 'user', content: '[kim] 5' }]); // 실패한 질문은 기록 안 됨
});

test('long replies are truncated', async () => {
  const { ai } = setup({ responses: [ok('가'.repeat(2000))] });
  const long = await ask(ai, '길게');
  assert.equal(long.length, 1501);
  assert.ok(long.endsWith('…'));
});

test('!ai command routing through runCommand and POST /command', async () => {
  const { ai, todos, client } = setup({ responses: [ok('pong 아닌 답')] });
  const run = (msg) => runCommand({ room: 'A', sender: 'kim', msg }, { todos, ai });

  assert.match(await run('!ai'), /사용법/);
  assert.equal(await run('!ai 안녕 반가워'), 'pong 아닌 답');
  assert.equal(client.calls[0].messages.at(-1).content, '[kim] 안녕 반가워');
  assert.match(await run('!ai reset'), /지웠어요/);
  assert.match(await run('!help'), /!ai <질문>/);

  const app = buildApp({ todos, ai, token: 't' });
  const res = await app.inject({
    method: 'POST',
    url: '/command',
    headers: { 'x-bot-token': 't' },
    payload: { room: 'B', sender: 'kim', msg: '!ai reset', isGroupChat: true },
  });
  assert.match(res.json().reply, /지웠어요/);
});
