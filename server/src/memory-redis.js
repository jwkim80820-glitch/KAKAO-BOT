/**
 * 테스트·로컬 실행용 메모리 Redis. store.js가 쓰는 명령만 @upstash/redis와 같은 모양으로 흉내 낸다.
 * (프로세스가 꺼지면 사라지고, ttl 옵션은 무시한다.)
 */
export function createMemoryRedis() {
  const kv = new Map();
  const hashes = new Map();
  const lists = new Map();

  const hash = (k) => hashes.get(k) ?? hashes.set(k, new Map()).get(k);
  const list = (k) => lists.get(k) ?? lists.set(k, []).get(k);
  // Redis 범위 인덱스(음수는 끝에서부터)를 slice 인자로 바꾼다.
  const range = (len, start, stop) => [
    Math.max(start < 0 ? len + start : start, 0),
    (stop < 0 ? len + stop : stop) + 1,
  ];

  return {
    async get(k) {
      return kv.get(k) ?? null;
    },
    async set(k, v) {
      kv.set(k, String(v));
      return 'OK';
    },
    async incr(k) {
      const n = Number(kv.get(k) ?? 0) + 1;
      kv.set(k, String(n));
      return n;
    },
    async hset(k, obj) {
      const h = hash(k);
      for (const [f, v] of Object.entries(obj)) h.set(f, v);
      return Object.keys(obj).length;
    },
    async hget(k, f) {
      return hashes.get(k)?.get(String(f)) ?? null;
    },
    // @upstash/redis를 automaticDeserialization: false 로 쓸 때와 같은 평평한 배열을 돌려준다.
    async hgetall(k) {
      return [...(hashes.get(k) ?? new Map()).entries()].flat();
    },
    async hdel(k, f) {
      return hashes.get(k)?.delete(String(f)) ? 1 : 0;
    },
    async rpush(k, ...vals) {
      return list(k).push(...vals);
    },
    async lrange(k, start, stop) {
      const l = lists.get(k) ?? [];
      return l.slice(...range(l.length, start, stop));
    },
    async ltrim(k, start, stop) {
      const l = lists.get(k);
      if (l) lists.set(k, l.slice(...range(l.length, start, stop)));
      return 'OK';
    },
    async del(...keys) {
      let n = 0;
      for (const k of keys) {
        n += [kv, hashes, lists].filter((m) => m.delete(k)).length;
      }
      return n;
    },
  };
}
