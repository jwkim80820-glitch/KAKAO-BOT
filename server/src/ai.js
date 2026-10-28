import OpenAI from 'openai';

export const DEFAULT_MODEL = 'gpt-6-luna';

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
  noKey: 'AI가 아직 설정되지 않았어요. (서버에 OPENAI_API_KEY가 필요해요)',
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
 * @param {import('openai').default | null} opts.client  키가 없으면 null
 * @param {ReturnType<import('./store.js').createChatStore>} opts.chats
 * @param {string} [opts.model]
 * @param {string} [opts.reasoningEffort]  비우면 모델 기본값 (예: 'none', 'low')
 * @param {number} [opts.historyTurns]  방마다 기억할 (질문, 답변) 쌍 수
 * @param {number} [opts.cooldownSec]
 * @param {() => number} [opts.now]
 * @param {(msg: string, err: unknown) => void} [opts.onError]
 */
export function createAi({
  client,
  chats,
  model = DEFAULT_MODEL,
  reasoningEffort = '',
  historyTurns = 10,
  cooldownSec = 5,
  now = Date.now,
  onError = () => {},
}) {
  const maxMessages = historyTurns * 2;

  async function throttled(room, sender) {
    const t = now();
    const waitMs = (await chats.lastAsk(room, sender)) + cooldownSec * 1000 - t;
    if (waitMs > 0) return Math.ceil(waitMs / 1000);
    await chats.markAsk(room, sender, t, cooldownSec);
    return 0;
  }

  async function ask({ room, sender, question }) {
    const q = question.trim();
    if (!q) return MSG.usage;
    if (!client) return MSG.noKey;
    if (q.length > MAX_QUESTION_LEN) return MSG.tooLong;

    const wait = await throttled(room, sender);
    if (wait) return cooldownMsg(wait);

    const userText = `[${sender || '?'}] ${q}`;
    try {
      const res = await client.chat.completions.create({
        model,
        // 추론 토큰도 이 한도에 포함되므로 넉넉히 둔다.
        max_completion_tokens: 2048,
        ...(reasoningEffort && { reasoning_effort: reasoningEffort }),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...(await chats.recent(room, maxMessages)),
          { role: 'user', content: userText },
        ],
      });

      const choice = res.choices?.[0];
      if (choice?.finish_reason === 'content_filter') return MSG.refusal;

      const text = (choice?.message?.content ?? '').trim();
      if (!text) return MSG.empty;

      await chats.appendTurn(room, userText, text, maxMessages);
      return text.length > MAX_REPLY_LEN ? `${text.slice(0, MAX_REPLY_LEN)}…` : text;
    } catch (err) {
      onError('ai request failed', err);
      if (err instanceof OpenAI.RateLimitError) return MSG.rateLimited;
      return MSG.failed;
    }
  }

  async function reset(room) {
    await chats.reset(room);
    return MSG.reset;
  }

  return { ask, reset };
}
