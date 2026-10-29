import OpenAI from 'openai';

const MAX_QUESTION_LEN = 500;
const MAX_REPLY_LEN = 1500;

// 저장된 에이전트의 지침 뒤에 덧붙는다 (세션을 만들 때 한 번만 적용).
const KAKAO_INSTRUCTIONS = [
  '카카오톡 단톡방에서 대화 중입니다.',
  '- 항상 한국어로, 일반 텍스트로만 답하세요. 마크다운(별표, 샵, 백틱, 표)은 쓰지 마세요.',
  '- 카톡 말풍선에 맞게 간결하게, 300자 안팎으로 답하세요. 목록이 필요하면 줄바꿈과 숫자만 쓰세요.',
  '- 여러 사람이 대화합니다. 각 질문 앞의 [이름]은 보낸 사람이며, 필요하면 이름을 불러 답하세요.',
  '- 모르는 것은 아는 척하지 말고 모른다고 말하세요.',
].join('\n');

const MSG = {
  noKey: 'AI가 아직 설정되지 않았어요. (서버에 OPENAI_API_KEY와 OPENAI_AGENT_ID가 필요해요)',
  usage: '사용법: !ai <질문> | !ai reset',
  tooLong: `질문은 ${MAX_QUESTION_LEN}자 이하로 입력해주세요.`,
  empty: '답변을 만들지 못했어요. 다시 물어봐 주세요.',
  rateLimited: '요청이 많아요. 잠시 후 다시 시도해주세요.',
  failed: 'AI 서버에 문제가 생겼어요. 잠시 후 다시 시도해주세요.',
  reset: '이 방의 대화 기억을 지웠어요.',
};

const cooldownMsg = (sec) => `잠시만요, ${sec}초 뒤에 다시 물어봐 주세요.`;

/**
 * 방마다 OpenAI 에이전트 세션 하나를 이어서 쓴다. 대화 기억은 세션이 들고 있다.
 *
 * @param {object} opts
 * @param {import('openai').default | null} opts.client  키가 없으면 null
 * @param {string} [opts.agentId]  저장된 에이전트 ID (agent_...). 없으면 !ai 비활성
 * @param {ReturnType<import('./store.js').createChatStore>} opts.chats
 * @param {number} [opts.cooldownSec]
 * @param {() => number} [opts.now]
 * @param {(msg: string, err: unknown) => void} [opts.onError]
 */
export function createAi({ client, agentId, chats, cooldownSec = 5, now = Date.now, onError = () => {} }) {
  const sessions = client?.beta.agents.sessions;

  async function throttled(room, sender) {
    const t = now();
    const waitMs = (await chats.lastAsk(room, sender)) + cooldownSec * 1000 - t;
    if (waitMs > 0) return Math.ceil(waitMs / 1000);
    await chats.markAsk(room, sender, t, cooldownSec);
    return 0;
  }

  /** 방의 세션에 이어서 묻고, 세션이 없으면 새로 만든다. @returns {Promise<{text: string, sessionId: string}>} */
  async function runTurn(room, userText, sessionId) {
    if (sessionId) {
      const result = await sessions.stream(sessionId, { input: userText }).withResultCollection().finalResult();
      return { text: result.output_text, sessionId };
    }
    const result = await (
      await sessions.create({
        agent_id: agentId,
        agent: { instructions: KAKAO_INSTRUCTIONS },
        environment: { type: 'none' },
        input: userText,
        stream: true,
        metadata: { room: room.slice(0, 512) },
      })
    )
      .withResultCollection()
      .finalResult();
    return { text: result.output_text, sessionId: result.session_id };
  }

  async function ask({ room, sender, question }) {
    const q = question.trim();
    if (!q) return MSG.usage;
    if (!client || !agentId) return MSG.noKey;
    if (q.length > MAX_QUESTION_LEN) return MSG.tooLong;

    const wait = await throttled(room, sender);
    if (wait) return cooldownMsg(wait);

    const userText = `[${sender || '?'}] ${q}`;
    try {
      let saved = await chats.getSession(room);
      let turn;
      try {
        turn = await runTurn(room, userText, saved);
      } catch (err) {
        // 보관 기간이 지나 세션이 사라졌으면 새 세션으로 다시 시도한다.
        if (!saved || !(err instanceof OpenAI.NotFoundError)) throw err;
        await chats.reset(room);
        turn = await runTurn(room, userText, null);
      }

      const text = (turn.text ?? '').trim();
      if (turn.sessionId !== saved) await chats.setSession(room, turn.sessionId);
      if (!text) return MSG.empty;
      return text.length > MAX_REPLY_LEN ? `${text.slice(0, MAX_REPLY_LEN)}…` : text;
    } catch (err) {
      onError('ai request failed', err);
      if (err instanceof OpenAI.RateLimitError) return MSG.rateLimited;
      return MSG.failed;
    }
  }

  async function reset(room) {
    const sessionId = await chats.getSession(room);
    await chats.reset(room);
    if (sessionId && sessions) {
      // 서버 쪽 세션 삭제는 실패해도 기억은 이미 끊겼으니 무시한다.
      await sessions.delete(sessionId).catch((err) => onError('ai session delete failed', err));
    }
    return MSG.reset;
  }

  return { ask, reset };
}
