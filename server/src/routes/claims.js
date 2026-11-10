const express = require('express');
const { z } = require('zod');
const { authenticate } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { validate } = require('../middleware/validation');
const { objectId } = require('../validation/posts');
const { notificationQuery } = require('../validation/claims');
const { createClaimController } = require('../controllers/claimController');
const { notificationController } = require('../controllers/notificationController');
const wrap = (action) => (req, res, next) => Promise.resolve(action(req, res)).catch(next);
function claimRoutes(config, { logger }) {
  const router = express.Router();
  const controller = createClaimController(logger);
  const auth = authenticate(config);
  const postId = z.object({ postId: objectId }).strict();
  const claimId = z.object({ claimId: objectId }).strict();
  router.post(
    '/posts/:postId/return',
    validate({ params: postId, body: z.object({ revision: z.number().int().min(0) }).strict() }),
    auth,
    rateLimit('claim-decision', 60),
    wrap(controller.returned)
  );
  router.get(
    '/claims/:claimId',
    validate({ params: claimId }),
    auth,
    rateLimit('claim-read', 120),
    wrap(controller.detail)
  );
  router.get(
    '/notifications',
    validate({ query: notificationQuery }),
    auth,
    rateLimit('notification-read', 120),
    wrap(notificationController.list)
  );
  router.patch(
    '/notifications/:notificationId/read',
    validate({ params: z.object({ notificationId: objectId }).strict() }),
    auth,
    rateLimit('notification-write', 60),
    wrap(notificationController.read)
  );
  return router;
}
module.exports = { claimRoutes };
