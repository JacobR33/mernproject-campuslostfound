const express = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validation');
const { authenticate } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { objectId } = require('../validation/posts');
const { pagination, historyQuery } = require('../validation/chat');
const { chatController } = require('../controllers/chatController');
const { createMatchController } = require('../controllers/matchController');
const wrap = (action) => (req, res, next) => Promise.resolve(action(req, res)).catch(next);
function chatRoutes(config, { logger }) {
  const router = express.Router();
  const auth = authenticate(config);
  const matches = createMatchController(logger);
  const conversation = z.object({ conversationId: objectId }).strict();
  const post = z.object({ postId: objectId }).strict();
  router.get(
    '/conversations',
    validate({ query: pagination }),
    auth,
    rateLimit('chat-read', 120),
    wrap(chatController.list)
  );
  router.post(
    '/conversations/:conversationId/close',
    validate({ params: conversation, body: z.object({}).strict() }),
    auth,
    rateLimit('chat-close', 60),
    wrap(chatController.close)
  );
  router.get(
    '/conversations/:conversationId',
    validate({ params: conversation }),
    auth,
    rateLimit('chat-read', 120),
    wrap(chatController.detail)
  );
  router.get(
    '/conversations/:conversationId/messages',
    validate({ params: conversation, query: historyQuery }),
    auth,
    rateLimit('chat-history', 120),
    wrap(chatController.history)
  );
  router.post(
    '/posts/:postId/matches',
    validate({ params: post }),
    auth,
    rateLimit('match-request', 10, 60000, { perUser: true }),
    wrap(matches.request)
  );
  router.get(
    '/matches/incoming',
    validate({ query: pagination }),
    auth,
    rateLimit('match-read', 120),
    wrap((req, res) => matches.list(req, res, true))
  );
  router.get(
    '/matches/mine',
    validate({ query: pagination }),
    auth,
    rateLimit('match-read', 120),
    wrap((req, res) => matches.list(req, res, false))
  );
  router.post(
    '/posts/:postId/matches/:requestId/decision',
    validate({
      params: z.object({ postId: objectId, requestId: objectId }).strict(),
      body: z.object({ decision: z.enum(['accept', 'deny']) }).strict(),
    }),
    auth,
    rateLimit('match-decision', 60),
    wrap(matches.decide)
  );
  return router;
}
module.exports = { chatRoutes };
