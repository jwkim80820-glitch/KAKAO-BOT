// Redis(@upstash/redis 또는 memory-redis) 위에 얹은 저장소.
// 값은 전부 직접 JSON 문자열로 저장한다 (클라이언트는 automaticDeserialization: false).
// 키에 방 이름이 들어가므로 접두어를 서로 겹치지 않게 나눴다.

const kstNow = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' });

export function createChatStore(redis) {
  const key = (room) => `chat:${room}`;
  const askKey = (room, sender) => `ask:${room}\u0000${sender}`;

  return {
    /** 오래된→최신 순. 첫 메시지는 항상 user (API 요구사항). */
    async recent(room, maxMessages) {
      const raw = await redis.lrange(key(room), -maxMessages, -1);
      const rows = raw.map((r) => JSON.parse(r));
      while (rows.length && rows[0].role !== 'user') rows.shift();
      return rows;
    },
    /** user/assistant 한 쌍을 기록하고 방당 maxMessages개만 남긴다. */
    async appendTurn(room, userText, assistantText, maxMessages) {
      await redis.rpush(
        key(room),
        JSON.stringify({ role: 'user', content: userText }),
        JSON.stringify({ role: 'assistant', content: assistantText }),
      );
      await redis.ltrim(key(room), -maxMessages, -1);
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
      const all = (await redis.hgetall(itemsKey(room))) ?? {};
      return Object.entries(all)
        .map(([seq, raw]) => toItem(seq, raw))
        .sort((a, b) => a.seq - b.seq);
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
