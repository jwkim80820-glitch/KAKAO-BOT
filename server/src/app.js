import Fastify from 'fastify';
import { isValidToken } from './auth.js';
import { runCommand } from './commands.js';

export function buildApp({ todos, ai, token, logger = false }) {
  const app = Fastify({ logger });

  app.get('/health', async () => ({ ok: true }));

  app.post(
    '/command',
    {
      schema: {
        body: {
          type: 'object',
          required: ['room', 'msg'],
          properties: {
            room: { type: 'string', maxLength: 200 },
            sender: { type: 'string', maxLength: 100 },
            msg: { type: 'string', maxLength: 2000 },
            isGroupChat: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      if (!isValidToken(req.headers['x-bot-token'], token)) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      return { reply: await runCommand(req.body, { todos, ai }) };
    },
  );

  return app;
}
