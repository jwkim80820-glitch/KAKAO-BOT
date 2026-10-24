import Anthropic from '@anthropic-ai/sdk';

export const DEFAULT_MODEL = 'claude-haiku-5-5';

const MAX_QUESTION_LEN = 500;
const MAX_REPLY_LEN = 1500;

const SYSTEM_PROMPT = [
  '당신은 카카오톡 단톡방에서 대화하는 친근한 AI 도우미입니다.',
  '- 항상 한국어로, 일반 텍스트로만 답하세요. 마크다운(별표, 샵, 백틱, 표)은 쓰지 마세요.',
  '- 카톡 말풍선에 맞게 간결하게, 300자 안팎으로 답하세요. 목록이 필요하면 줄바꿈과 숫자만 쓰세요.',
  '- 여러 사람이 대화합니다. 각 질문 앞의 [이름]은 보낸 사람이며, 필요하면 이름을 불러 답하세요.',
  '- 모르는 것은 아는 척하지 말고 모른다고 말하세요.',
].join('\n');

const MSG = {
  noKey: 'AI가 아직 설정되지 않았어요. (서버에 ANTHROPIC_API_KEY가 필요해요)',
  usage: '사용법: !ai <질문> | !ai reset',
  tooLong: `질문은 ${MAX_QUESTION_LEN}자 이하로 입력해주세요.`,
  refusal: '그 질문에는 답변하기 어려워요.',
  empty: '답변을 만들지 못했어요. 다시 물어봐 주세요.',
  rateLimited: '요청이 많아요. 잠시 후 다시 시도해주세요.',
  failed: 'AI 서버에 문제가 생겼어요. 잠시 후 다시 시도해주세요.',
  reset: '이 방의 대화 기억을 지웠어요.',
};

const cooldownMsg = (sec) => `잠시만요, ${sec}초 뒤에 다시 물어봐 주세요.`;

/**
 * @param {object} opts
 * @param {import('@anthropic-ai/sdk').default | null} opts.client  키가 없으면 null
 * @param {ReturnType<import('./db.js').createChatStore>} opts.chats
 * @param {string} [opts.model]
 * @param {number} [opts.historyTurns]  방마다 기억할 (질문, 답변) 쌍 수
 * @param {number} [opts.cooldownSec]
 * @param {() => number} [opts.now]
 * @param {(msg: string, err: unknown) => void} [opts.onError]
 */
export function createAi({
  client,
  chats,
  model = DEFAULT_MODEL,
  historyTurns = 10,
  cooldownSec = 5,
  now = Date.now,
  onError = () => {},
}) {
  const lastAsk = new Map();
  const maxMessages = historyTurns * 2;

  function throttled(room, sender) {
    const key = `${room}\u0000${sender}`;
    const t = now();
    const waitMs = (lastAsk.get(key) ?? 0) + cooldownSec * 1000 - t;
    if (waitMs > 0) return Math.ceil(waitMs / 1000);
    lastAsk.set(key, t);
    return 0;
  }

  async function ask({ room, sender, question }) {
    const q = question.trim();
    if (!q) return MSG.usage;
    if (!client) return MSG.noKey;
    if (q.length > MAX_QUESTION_LEN) return MSG.tooLong;

    const wait = throttled(room, sender);
    if (wait) return cooldownMsg(wait);

    const userText = `[${sender || '?'}] ${q}`;
    try {
      const res = await client.messages.create({
        model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        // 채팅용: Haiku 5.5는 기본 effort가 medium이라 낮춰서 지연·비용을 줄인다.
        output_config: { effort: 'low' },
        messages: [
          ...chats.recent(room, maxMessages),
          { role: 'user', content: userText },
        ],
      });

      if (res.stop_reason === 'refusal') return MSG.refusal;

      // thinking 블록은 버리고 텍스트만 사용·저장한다.
      const text = res.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      if (!text) return MSG.empty;

      chats.appendTurn(room, userText, text, maxMessages);
      return text.length > MAX_REPLY_LEN ? `${text.slice(0, MAX_REPLY_LEN)}…` : text;
    } catch (err) {
      onError('ai request failed', err);
      if (err instanceof Anthropic.RateLimitError) return MSG.rateLimited;
      return MSG.failed;
    }
  }

  function reset(room) {
    chats.reset(room);
    return MSG.reset;
  }

  return { ask, reset };
}
