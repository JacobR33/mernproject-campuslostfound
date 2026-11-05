const express = require('express');
const { z } = require('zod');
const { authenticate } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { validate } = require('../middleware/validation');
const { objectId } = require('../validation/posts');
const {
  claimSubmission,
  decision,
  claimQuery,
  notificationQuery,
} = require('../validation/claims');
const { createClaimController } = require('../controllers/claimController');
const { notificationController } = require('../controllers/notificationController');
const wrap = (action) => (req, res, next) => Promise.resolve(action(req, res)).catch(next);
function claimRoutes(config, { logger }) {
  const router = express.Router();
  const controller = createClaimController(logger);
  const auth = authenticate(config);
  const postId = z.object({ postId: objectId }).strict();
  const claimId = z.object({ claimId: objectId }).strict();
  const both = z.object({ postId: objectId, claimId: objectId }).strict();
  router.post(
    '/posts/:postId/claims',
    validate({ params: postId, body: claimSubmission }),
    auth,
    rateLimit('claim-submit', 20),
    wrap(controller.submit)
  );
  router.get(
    '/posts/:postId/claims',
    validate({ params: postId, query: claimQuery }),
    auth,
    rateLimit('claim-read', 120),
    wrap((req, res) => controller.review(req, res))
  );
  router.get(
    '/posts/:postId/claims/:claimId',
    validate({ params: both }),
    auth,
    rateLimit('claim-read', 120),
    wrap((req, res) => controller.review(req, res, true))
  );
  router.post(
    '/posts/:postId/claims/:claimId/decision',
    validate({ params: both, body: decision }),
    auth,
    rateLimit('claim-decision', 60),
    wrap(controller.decide)
  );
  router.post(
    '/posts/:postId/return',
    validate({ params: postId, body: z.object({ revision: z.number().int().min(0) }).strict() }),
    auth,
    rateLimit('claim-decision', 60),
    wrap(controller.returned)
  );
  router.get(
    '/claims/mine',
    validate({ query: claimQuery }),
    auth,
    rateLimit('claim-read', 120),
    wrap(controller.mine)
  );
  router.get(
    '/claims/:claimId',
    validate({ params: claimId }),
    auth,
    rateLimit('claim-read', 120),
    wrap(controller.detail)
  );
  router.get(
    '/posts/:postId/my-claim',
    validate({ params: postId }),
    auth,
    rateLimit('claim-read', 120),
    wrap(controller.ownForPost)
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
