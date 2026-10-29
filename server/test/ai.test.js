import { test } from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { createAi } from '../src/ai.js';
import { buildApp } from '../src/app.js';
import { runCommand } from '../src/commands.js';
import { createMemoryRedis } from '../src/memory-redis.js';
import { createChatStore, createTodoStore } from '../src/store.js';

/**
 * responses: create/stream 호출마다 순서대로 소비. Error면 throw.
 * 응답은 문자열(답변) 또는 { text, sessionId }.
 */
function fakeClient(responses) {
  const calls = { create: [], stream: [], delete: [] };
  const turn = (r, sessionId) => ({
    withResultCollection() {
      return this;
    },
    async finalResult() {
      if (r instanceof Error) throw r;
      return { output_text: r, session_id: sessionId };
    },
  });
  return {
    calls,
    beta: {
      agents: {
        sessions: {
          async create(params) {
            calls.create.push(structuredClone(params));
            const r = responses.shift();
            if (r instanceof Error) throw r;
            return turn(r, `sess_${calls.create.length}`);
          },
          stream(sessionId, params) {
            calls.stream.push({ sessionId, ...structuredClone(params) });
            return turn(responses.shift(), sessionId);
          },
          async delete(sessionId) {
            calls.delete.push(sessionId);
          },
        },
      },
    },
  };
}

function setup({ responses = [], ...opts } = {}) {
  const db = createMemoryRedis();
  const client = fakeClient(responses);
  let clock = 1_000_000;
  const ai = createAi({
    client: opts.noClient ? null : client,
    agentId: 'agent_test',
    chats: createChatStore(db),
    now: () => clock,
    ...opts,
  });
  return { ai, client, advance: (ms) => (clock += ms), todos: createTodoStore(db) };
}

const ask = (ai, question, room = 'A', sender = 'kim') => ai.ask({ room, sender, question });

test('first question creates a session from the saved agent', async () => {
  const { ai, client } = setup({ responses: ['안녕하세요!'] });
  assert.equal(await ask(ai, '안녕'), '안녕하세요!');

  const req = client.calls.create[0];
  assert.equal(req.agent_id, 'agent_test');
  assert.equal(req.input, '[kim] 안녕');
  assert.equal(req.stream, true);
  assert.deepEqual(req.environment, { type: 'none' });
  assert.match(req.agent.instructions, /한국어/);
  assert.equal(client.calls.stream.length, 0);
});

test('later questions in the same room continue the stored session', async () => {
  const { ai, client, advance } = setup({ responses: ['첫 답', '둘째 답'] });
  await ask(ai, '하나');
  advance(10_000);
  assert.equal(await ask(ai, '둘', 'A', 'lee'), '둘째 답');

  assert.equal(client.calls.create.length, 1);
  assert.deepEqual(client.calls.stream, [{ sessionId: 'sess_1', input: '[lee] 둘' }]);
});

test('sessions are separated per room', async () => {
  const { ai, client, advance } = setup({ responses: ['a', 'b'] });
  await ask(ai, 'q', 'A');
  advance(10_000);
  await ask(ai, 'q', 'B');
  assert.equal(client.calls.create.length, 2);
  assert.equal(client.calls.stream.length, 0);
});

test('reset forgets the session and deletes it on the server', async () => {
  const { ai, client, advance } = setup({ responses: ['x', 'y'] });
  await ask(ai, '기억해');
  assert.match(await ai.reset('A'), /지웠어요/);
  assert.deepEqual(client.calls.delete, ['sess_1']);
  advance(10_000);
  await ask(ai, '다시');
  assert.equal(client.calls.create.length, 2);
});

test('reset without a session does not call the API', async () => {
  const { ai, client } = setup();
  assert.match(await ai.reset('A'), /지웠어요/);
  assert.deepEqual(client.calls.delete, []);
});

test('an expired session is replaced by a new one', async () => {
  const gone = new OpenAI.NotFoundError(404, {}, 'not found', new Headers());
  const { ai, client, advance } = setup({ responses: ['첫 답', gone, '새 답'] });
  await ask(ai, '하나');
  advance(10_000);
  assert.equal(await ask(ai, '둘'), '새 답');
  assert.equal(client.calls.create.length, 2);
  assert.equal(client.calls.create[1].input, '[kim] 둘');
});

test('cooldown, empty and too long questions never call the API', async () => {
  const { ai, client, advance } = setup({ responses: ['x', 'z', 'y'] });
  assert.match(await ask(ai, '  '), /사용법/);
  assert.match(await ask(ai, 'x'.repeat(501)), /500자/);
  await ask(ai, '하나');
  assert.match(await ask(ai, '또'), /5초 뒤/);
  assert.equal(client.calls.create.length + client.calls.stream.length, 1);

  assert.equal(await ask(ai, '다른 사람', 'A', 'lee'), 'z'); // 쿨다운은 보낸이별
  advance(5_000);
  assert.equal(await ask(ai, '이제 가능'), 'y');
});

test('missing API key or agent id gives a setup hint', async () => {
  assert.match(await ask(setup({ noClient: true }).ai, '안녕'), /OPENAI_AGENT_ID/);
  assert.match(await ask(setup({ agentId: '' }).ai, '안녕'), /OPENAI_AGENT_ID/);
});

test('empty reply and API errors reply politely', async () => {
  const errors = [];
  const rateLimit = new OpenAI.RateLimitError(429, {}, 'slow down', new Headers());
  const { ai, advance } = setup({
    onError: (m) => errors.push(m),
    responses: ['', rateLimit, new Error('boom'), '정상'],
  });
  const replies = [];
  for (const q of ['1', '2', '3', '4']) {
    replies.push(await ask(ai, q));
    advance(10_000);
  }
  assert.match(replies[0], /다시 물어봐/);
  assert.match(replies[1], /요청이 많아요/);
  assert.match(replies[2], /문제가 생겼어요/);
  assert.equal(replies[3], '정상');
  assert.equal(errors.length, 2);
});

test('long replies are truncated', async () => {
  const { ai } = setup({ responses: ['가'.repeat(2000)] });
  const long = await ask(ai, '길게');
  assert.equal(long.length, 1501);
  assert.ok(long.endsWith('…'));
});

test('!ai command routing through runCommand and POST /command', async () => {
  const { ai, todos, client } = setup({ responses: ['pong 아닌 답'] });
  const run = (msg) => runCommand({ room: 'A', sender: 'kim', msg }, { todos, ai });

  assert.match(await run('!ai'), /사용법/);
  assert.equal(await run('!ai 안녕 반가워'), 'pong 아닌 답');
  assert.equal(client.calls.create[0].input, '[kim] 안녕 반가워');
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
