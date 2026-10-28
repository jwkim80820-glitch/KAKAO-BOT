const MAX_TODO_LEN = 200;

const HELP = [
  '[명령어]',
  '!ping',
  '!ai <질문>',
  '!ai reset',
  '!todo add <내용>',
  '!todo list',
  '!todo <번호>',
  '!todo done <번호>',
  '!todo del <번호>',
].join('\n');

const parseSeq = (s) => (/^\d{1,6}$/.test(s ?? '') ? Number(s) : null);

async function handleTodo(args, { room, sender }, todos) {
  const [sub, ...rest] = args;

  if (!sub) return '사용법: !todo add <내용> | list | <번호> | done <번호> | del <번호>';

  if (sub === 'add') {
    const text = rest.join(' ').trim();
    if (!text) return '추가할 내용을 입력하세요. 예) !todo add 우유 사기';
    if (text.length > MAX_TODO_LEN) return `내용은 ${MAX_TODO_LEN}자 이하로 입력하세요.`;
    return `#${await todos.add(room, text, sender)} 추가했어요.`;
  }

  if (sub === 'list') {
    const items = await todos.list(room);
    if (!items.length) return '할 일이 없어요.';
    return items.map((t) => `${t.done ? '✅' : '⬜'} ${t.seq}. ${t.text}`).join('\n');
  }

  const seq = parseSeq(sub === 'done' || sub === 'del' ? rest[0] : sub);
  if (seq === null) return '번호를 확인해주세요. 예) !todo 1';

  if (sub === 'done') return (await todos.done(room, seq)) ? `#${seq} 완료!` : `#${seq} 항목이 없어요.`;
  if (sub === 'del') return (await todos.remove(room, seq)) ? `#${seq} 삭제했어요.` : `#${seq} 항목이 없어요.`;

  const t = await todos.get(room, seq);
  if (!t) return `#${seq} 항목이 없어요.`;
  return `${t.done ? '✅' : '⬜'} ${t.seq}. ${t.text}\n(${t.sender ?? '?'} · ${t.created_at})`;
}

/** @returns {Promise<string|null>} 답장 문자열, 무응답이면 null */
export async function runCommand({ room, sender, msg }, { todos, ai }) {
  const text = String(msg ?? '').trim();
  if (!text.startsWith('!')) return null;

  const [cmd, ...args] = text.slice(1).split(/\s+/);
  switch (cmd.toLowerCase()) {
    case 'ping':
      return 'pong!';
    case 'help':
      return HELP;
    case 'todo':
      return await handleTodo(args, { room, sender }, todos);
    case 'ai':
      return args[0]?.toLowerCase() === 'reset'
        ? await ai.reset(room)
        : await ai.ask({ room, sender, question: args.join(' ') });
    default:
      return null;
  }
}
