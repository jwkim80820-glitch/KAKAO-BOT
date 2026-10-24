import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { createAi } from '../src/ai.js';
import { buildApp } from '../src/app.js';
import { runCommand } from '../src/commands.js';
import { createChatStore, createTodoStore, openDb } from '../src/db.js';

const text = (t) => ({ type: 'text', text: t });

/** responses: 호출마다 순서대로 소비. Error면 throw. */
function fakeClient(responses) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        calls.push(structuredClone(params));
        const r = responses.shift();
        if (r instanceof Error) throw r;
        return r;
      },
    },
  };
}

const ok = (t) => ({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, text(t)] });

function setup({ responses = [], ...opts } = {}) {
  const db = openDb();
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

test('sends the expected request for claude-haiku-5-5', async () => {
  const { ai, client } = setup({ responses: [ok('안녕하세요!')] });
  assert.equal(await ask(ai, '안녕'), '안녕하세요!');

  const req = client.calls[0];
  assert.equal(req.model, 'claude-haiku-5-5');
  assert.deepEqual(req.output_config, { effort: 'low' });
  assert.equal('temperature' in req, false);
  assert.deepEqual(req.messages, [{ role: 'user', content: '[kim] 안녕' }]);
  assert.match(req.system, /한국어/);
});

test('remembers the room conversation, only text is stored', async () => {
  const { ai, client, advance } = setup({ responses: [ok('첫 답'), ok('둘째 답')] });
  await ask(ai, '하나');
  advance(10_000);
  await ask(ai, '둘', 'A', 'lee');

  assert.deepEqual(client.calls[1].messages, [
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
  assert.equal(client.calls[3].messages.length, 1); // 방 B는 독립

  advance(10_000);
  await ask(ai, 'q4');
  const sent = client.calls[4].messages.map((m) => m.content);
  assert.deepEqual(sent, ['[kim] q2', 'a2', '[kim] q3', 'a3', '[kim] q4']); // q1 삭제됨
});

test('reset clears the room memory', async () => {
  const { ai, client, advance } = setup({ responses: [ok('x'), ok('y')] });
  await ask(ai, '기억해');
  assert.match(ai.reset('A'), /지웠어요/);
  advance(10_000);
  await ask(ai, '다시');
  assert.equal(client.calls[1].messages.length, 1);
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
  assert.match(await ask(ai, '안녕'), /ANTHROPIC_API_KEY/);
});

test('refusal, empty reply and API errors reply politely and are not stored', async () => {
  const errors = [];
  const rateLimit = new Anthropic.RateLimitError(429, {}, 'slow down', new Headers());
  const { ai, client, advance } = setup({
    onError: (m) => errors.push(m),
    responses: [
      { stop_reason: 'refusal', content: [] },
      { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }] },
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
  assert.deepEqual(client.calls[4].messages, [{ role: 'user', content: '[kim] 5' }]); // 실패한 질문은 기록 안 됨
});

test('long replies are truncated', async () => {
  const { ai } = setup({ responses: [ok('가'.repeat(2000))] });
  const reply = await ask(ai, '길게');
  assert.equal(reply.length, 1501);
  assert.ok(reply.endsWith('…'));
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
