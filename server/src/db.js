import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room TEXT NOT NULL,
      seq INTEGER NOT NULL,
      text TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      sender TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      UNIQUE (room, seq)
    );
    CREATE TABLE IF NOT EXISTS chat_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_chat_history_room ON chat_history (room, id);
  `);
  return db;
}

export function createChatStore(db) {
  const insert = db.prepare('INSERT INTO chat_history (room, role, content) VALUES (?, ?, ?)');
  const latest = db.prepare(
    'SELECT role, content FROM chat_history WHERE room = ? ORDER BY id DESC LIMIT ?',
  );
  const trim = db.prepare(
    `DELETE FROM chat_history WHERE room = ? AND id NOT IN
       (SELECT id FROM chat_history WHERE room = ? ORDER BY id DESC LIMIT ?)`,
  );
  const clear = db.prepare('DELETE FROM chat_history WHERE room = ?');

  return {
    /** 오래된→최신 순. 첫 메시지는 항상 user (API 요구사항). */
    recent(room, maxMessages) {
      const rows = latest.all(room, maxMessages).reverse();
      while (rows.length && rows[0].role !== 'user') rows.shift();
      return rows;
    },
    /** user/assistant 한 쌍을 기록하고 방당 maxMessages개만 남긴다. */
    appendTurn(room, userText, assistantText, maxMessages) {
      insert.run(room, 'user', userText);
      insert.run(room, 'assistant', assistantText);
      trim.run(room, room, maxMessages);
    },
    reset(room) {
      return clear.run(room).changes;
    },
  };
}

export function createTodoStore(db) {
  const nextSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM todos WHERE room = ?');
  const insert = db.prepare('INSERT INTO todos (room, seq, text, sender) VALUES (?, ?, ?, ?)');
  const list = db.prepare('SELECT seq, text, done FROM todos WHERE room = ? ORDER BY seq');
  const get = db.prepare('SELECT seq, text, done, sender, created_at FROM todos WHERE room = ? AND seq = ?');
  const setDone = db.prepare('UPDATE todos SET done = 1 WHERE room = ? AND seq = ?');
  const remove = db.prepare('DELETE FROM todos WHERE room = ? AND seq = ?');

  return {
    add(room, text, sender) {
      const { n } = nextSeq.get(room);
      insert.run(room, n, text, sender ?? null);
      return n;
    },
    list: (room) => list.all(room),
    get: (room, seq) => get.get(room, seq) ?? null,
    done: (room, seq) => setDone.run(room, seq).changes > 0,
    remove: (room, seq) => remove.run(room, seq).changes > 0,
  };
}
