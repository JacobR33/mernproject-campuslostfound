const express = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validation');
const { authenticate } = require('../middleware/auth');
const { rateLimit, consumeRate } = require('../middleware/rateLimit');
const { codeSchema } = require('../lib/mfa');
const { mfaController } = require('../controllers/mfaController');
const password = z
  .string()
  .min(1)
  .max(72)
  .refine((value) => Buffer.byteLength(value) <= 72 && !value.includes('\0'));
const wrap = (action) => (req, res, next) => Promise.resolve(action(req, res)).catch(next);
function mfaRoutes(config, { logger }) {
  const router = express.Router();
  const auth = authenticate(config);
  const controller = mfaController(config, logger);
  // This limiter calls next only after the persistent counter commits.
  const perAccount = (req, res, next) =>
    Promise.resolve(consumeRate('mfa-account', String(req.user._id), 10, 15 * 60000))
      .then(() => next())
      .catch(next);
  const mutation = [auth, rateLimit('mfa-manage', 20), perAccount];
  router.get('/', validate(), auth, rateLimit('mfa-read', 120), wrap(controller.status));
  router.post(
    '/enrollment',
    validate({ body: z.object({ password }).strict() }),
    ...mutation,
    wrap(controller.enroll)
  );
  router.post(
    '/confirm',
    validate({
      body: z
        .object({
          password,
          enrollmentId: z.string().regex(/^[a-f0-9]{64}$/),
          code: z.string().regex(/^\d{6}$/),
        })
        .strict(),
    }),
    ...mutation,
    wrap(controller.confirm)
  );
  const proof = { body: z.object({ password, code: codeSchema }).strict() };
  router.post(
    '/backup-codes',
    validate(proof),
    ...mutation,
    wrap((req, res) => controller.manage(req, res))
  );
  router.post(
    '/disable',
    validate(proof),
    ...mutation,
    wrap((req, res) => controller.manage(req, res, true))
  );
  return router;
}
module.exports = { mfaRoutes };
