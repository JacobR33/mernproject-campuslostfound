const express = require('express');
const { z } = require('zod');
const { authenticate } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { validate } = require('../middleware/validation');
const { objectId } = require('../validation/posts');
const { createUploadController } = require('../controllers/uploadController');
const wrap = (action) => (req, res, next) => Promise.resolve(action(req, res)).catch(next);
function uploadRoutes(config, { storage, logger }) {
  const router = express.Router();
  const controller = createUploadController(storage, logger);
  const id = { params: z.object({ id: objectId }).strict() };
  router.post(
    '/',
    validate(),
    authenticate(config),
    rateLimit('upload', 20),
    wrap(controller.upload)
  );
  router.get(
    '/:id/preview',
    validate(id),
    authenticate(config),
    wrap((req, res) => controller.serve(req, res, true))
  );
  router.get(
    '/:id',
    validate(id),
    wrap((req, res) => controller.serve(req, res))
  );
  router.delete('/:id', validate(id), authenticate(config), wrap(controller.discard));
  return router;
}
module.exports = { uploadRoutes };
