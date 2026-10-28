import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { runCommand } from '../src/commands.js';
import { createMemoryRedis } from '../src/memory-redis.js';
import { createTodoStore } from '../src/store.js';

const newStore = () => createTodoStore(createMemoryRedis());
const say = (todos, msg, room = 'A', sender = 'kim') => runCommand({ room, sender, msg }, { todos, ai: null });

test('ping / help / non-command / unknown', async () => {
  const todos = newStore();
  assert.equal(await say(todos, '!ping'), 'pong!');
  assert.match(await say(todos, '!help'), /!todo add/);
  assert.equal(await say(todos, '안녕'), null);
  assert.equal(await say(todos, '!nope'), null);
});

test('todo add/list/get/done/del', async () => {
  const todos = newStore();
  assert.equal(await say(todos, '!todo add 우유 사기'), '#1 추가했어요.');
  assert.equal(await say(todos, '!todo add 운동하기'), '#2 추가했어요.');
  assert.equal(await say(todos, '!todo list'), '⬜ 1. 우유 사기\n⬜ 2. 운동하기');
  assert.match(await say(todos, '!todo 1'), /^⬜ 1\. 우유 사기\n\(kim · /);
  assert.equal(await say(todos, '!todo done 1'), '#1 완료!');
  assert.match(await say(todos, '!todo list'), /^✅ 1\./);
  assert.equal(await say(todos, '!todo del 1'), '#1 삭제했어요.');
  assert.equal(await say(todos, '!todo 1'), '#1 항목이 없어요.');
  assert.equal(await say(todos, '!todo add 새 항목'), '#3 추가했어요.');
});

test('todos are separated per room', async () => {
  const todos = newStore();
  await say(todos, '!todo add 가', 'A');
  await say(todos, '!todo add 나', 'B');
  assert.equal(await say(todos, '!todo list', 'A'), '⬜ 1. 가');
  assert.equal(await say(todos, '!todo list', 'B'), '⬜ 1. 나');
});

test('todo input validation', async () => {
  const todos = newStore();
  assert.match(await say(todos, '!todo add'), /추가할 내용/);
  assert.match(await say(todos, '!todo add ' + 'x'.repeat(201)), /200자/);
  assert.match(await say(todos, '!todo abc'), /번호/);
  assert.match(await say(todos, '!todo done'), /번호/);
  assert.equal(await say(todos, '!todo list'), '할 일이 없어요.');
});

test('POST /command requires token and returns reply', async () => {
  const app = buildApp({ todos: newStore(), ai: null, token: 'secret' });
  const body = { room: 'A', sender: 'kim', msg: '!ping', isGroupChat: true };

  const bad = await app.inject({ method: 'POST', url: '/command', payload: body });
  assert.equal(bad.statusCode, 401);

  const ok = await app.inject({
    method: 'POST',
    url: '/command',
    headers: { 'x-bot-token': 'secret' },
    payload: body,
  });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { reply: 'pong!' });

  const none = await app.inject({
    method: 'POST',
    url: '/command',
    headers: { 'x-bot-token': 'secret' },
    payload: { ...body, msg: '그냥 대화' },
  });
  assert.deepEqual(none.json(), { reply: null });

  const health = await app.inject({ method: 'GET', url: '/health' });
  assert.deepEqual(health.json(), { ok: true });
});
