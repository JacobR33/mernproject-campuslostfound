const express = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validation');
const { authenticate, requireRole } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { objectId } = require('../validation/posts');
const { pagination } = require('../validation/chat');
const { moderationController } = require('../controllers/moderationController');
const { accountController } = require('../controllers/accountController');
const { codeSchema } = require('../lib/mfa');
const wrap = (action) => (req, res, next) => Promise.resolve(action(req, res)).catch(next);
const param = (name) => z.object({ [name]: objectId }).strict();
function moderationRoutes(config, { logger }) {
  const router = express.Router();
  const auth = authenticate(config);
  const admin = requireRole('admin');
  const controller = moderationController(logger);
  router.post(
    '/posts/:postId/reports',
    validate({
      params: param('postId'),
      body: z
        .object({
          reason: z.enum(['privacy', 'unsafe', 'spam', 'other']),
          details: z.string().trim().min(5).max(1000),
        })
        .strict(),
    }),
    auth,
    rateLimit('report', 10),
    wrap(controller.report)
  );
  router.get(
    '/admin/reports',
    validate({
      query: pagination.extend({ status: z.enum(['open', 'resolved', 'dismissed']).optional() }),
    }),
    auth,
    admin,
    rateLimit('admin-read', 120),
    wrap(controller.reports)
  );
  router.patch(
    '/admin/reports/:reportId',
    validate({
      params: param('reportId'),
      body: z
        .object({
          status: z.enum(['resolved', 'dismissed']),
          revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        })
        .strict(),
    }),
    auth,
    admin,
    rateLimit('admin-action', 60),
    wrap(controller.decide)
  );
  router.delete(
    '/admin/posts/:postId',
    validate({ params: param('postId') }),
    auth,
    admin,
    rateLimit('admin-action', 60),
    wrap(controller.remove)
  );
  router.get(
    '/admin/users/:userId',
    validate({ params: param('userId') }),
    auth,
    admin,
    rateLimit('admin-read', 120),
    wrap(controller.user)
  );
  router.post(
    '/admin/users/:userId/ban',
    validate({ params: param('userId') }),
    auth,
    admin,
    rateLimit('admin-action', 60),
    wrap(controller.ban)
  );
  router.delete(
    '/account',
    validate({
      body: z
        .object({
          password: z
            .string()
            .min(1)
            .max(72)
            .refine((v) => Buffer.byteLength(v) <= 72 && !v.includes('\0')),
          confirmation: z.literal('DELETE'),
          code: codeSchema.optional(),
        })
        .strict(),
    }),
    auth,
    rateLimit('account-delete', 5),
    wrap(accountController(config, logger).remove)
  );
  return router;
}
module.exports = { moderationRoutes };
