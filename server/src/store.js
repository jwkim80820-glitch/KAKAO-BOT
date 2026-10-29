// Redis(@upstash/redis 또는 memory-redis) 위에 얹은 저장소.
// 값은 전부 직접 JSON 문자열로 저장한다 (클라이언트는 automaticDeserialization: false).
// 키에 방 이름이 들어가므로 접두어를 서로 겹치지 않게 나눴다.

const kstNow = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' });

export function createChatStore(redis) {
  // 예전 `chat:` 키는 대화 목록(list)이었으므로 타입이 충돌하지 않게 다른 접두어를 쓴다.
  const key = (room) => `agent-session:${room}`;
  const askKey = (room, sender) => `ask:${room}\u0000${sender}`;

  return {
    /** 방이 이어서 쓰는 OpenAI 에이전트 세션 ID. 없으면 null. */
    async getSession(room) {
      return redis.get(key(room));
    },
    async setSession(room, sessionId) {
      await redis.set(key(room), sessionId);
    },
    async reset(room) {
      await redis.del(key(room));
    },
    /** 보낸이별 마지막 질문 시각(ms). 서버리스는 인스턴스가 바뀌므로 Redis에 둔다. */
    async lastAsk(room, sender) {
      const v = await redis.get(askKey(room, sender));
      return v === null ? 0 : Number(v);
    },
    async markAsk(room, sender, at, ttlSec) {
      await redis.set(askKey(room, sender), at, { ex: Math.max(1, Math.ceil(ttlSec)) });
    },
  };
}

export function createTodoStore(redis) {
  const seqKey = (room) => `todo:seq:${room}`;
  const itemsKey = (room) => `todo:items:${room}`;
  const toItem = (seq, raw) => ({ seq: Number(seq), ...JSON.parse(raw) });

  return {
    async add(room, text, sender) {
      const seq = await redis.incr(seqKey(room));
      const item = { text, done: 0, sender: sender ?? null, created_at: kstNow() };
      await redis.hset(itemsKey(room), { [seq]: JSON.stringify(item) });
      return seq;
    },
    async list(room) {
      // automaticDeserialization: false 이면 hgetall이 객체가 아니라 [필드, 값, 필드, 값, ...] 배열을 준다.
      const flat = (await redis.hgetall(itemsKey(room))) ?? [];
      const items = [];
      for (let i = 0; i < flat.length; i += 2) items.push(toItem(flat[i], flat[i + 1]));
      return items.sort((a, b) => a.seq - b.seq);
    },
    async get(room, seq) {
      const raw = await redis.hget(itemsKey(room), seq);
      return raw === null ? null : toItem(seq, raw);
    },
    async done(room, seq) {
      const item = await this.get(room, seq);
      if (!item) return false;
      const { seq: _, ...rest } = item;
      await redis.hset(itemsKey(room), { [seq]: JSON.stringify({ ...rest, done: 1 }) });
      return true;
    },
    async remove(room, seq) {
      return (await redis.hdel(itemsKey(room), seq)) > 0;
    },
  };
}
