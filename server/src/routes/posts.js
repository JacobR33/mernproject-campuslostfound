const express = require('express');
const { z } = require('zod');
const { authenticate } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { validate } = require('../middleware/validation');
const { objectId, createPost, editPost, listQuery } = require('../validation/posts');
const { createPostController } = require('../controllers/postController');
const wrap = (action) => (req, res, next) => Promise.resolve(action(req, res)).catch(next);
function postRoutes(config, { logger }) {
  const router = express.Router();
  const controller = createPostController(config, logger);
  const id = z.object({ id: objectId }).strict();
  router.get(
    '/',
    rateLimit('post-read', 300),
    validate({ query: listQuery }),
    wrap((req, res) => controller.list(req, res))
  );
  router.get(
    '/mine',
    validate({ query: listQuery }),
    authenticate(config),
    wrap((req, res) => controller.list(req, res, true))
  );
  router.get(
    '/:id/manage',
    validate({ params: id }),
    authenticate(config),
    wrap((req, res) => controller.detail(req, res, true))
  );
  router.get(
    '/:id',
    rateLimit('post-read', 300),
    validate({ params: id }),
    wrap((req, res) => controller.detail(req, res))
  );
  router.post(
    '/',
    validate({ body: createPost }),
    authenticate(config),
    rateLimit('post-write', 30),
    wrap(controller.create)
  );
  router.patch(
    '/:id',
    validate({ params: id, body: editPost }),
    authenticate(config),
    rateLimit('post-write', 30),
    wrap(controller.edit)
  );
  router.delete(
    '/:id',
    validate({ params: id, body: z.object({ revision: z.number().int().min(0) }).strict() }),
    authenticate(config),
    rateLimit('post-write', 30),
    wrap(controller.remove)
  );
  return router;
}
module.exports = { postRoutes };
