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
const { adminAccountController } = require('../controllers/adminAccountController');
const wrap = (action) => (req, res, next) => Promise.resolve(action(req, res)).catch(next);
const param = (name) => z.object({ [name]: objectId }).strict();
function moderationRoutes(config, { logger }) {
  const router = express.Router();
  const auth = authenticate(config);
  const admin = requireRole('admin');
  const controller = moderationController(logger);
  const accounts = adminAccountController(config, logger);
  router.get(
    '/admin/users',
    auth,
    admin,
    rateLimit('admin-read', 120),
    validate({
      query: pagination.extend({
        search: z.string().trim().max(120).optional(),
        status: z.enum(['verified', 'unverified', 'banned', 'locked']).optional(),
        role: z.enum(['user', 'admin']).optional(),
      }),
    }),
    wrap(accounts.list)
  );
  router.get(
    '/admin/activity',
    auth,
    admin,
    rateLimit('admin-read', 120),
    validate({
      query: pagination.extend({ userId: objectId.optional() }),
    }),
    wrap(accounts.activity)
  );
  router.post(
    '/admin/users/:userId/email/:kind',
    auth,
    admin,
    rateLimit('admin-mail', 10),
    validate({
      params: z
        .object({ userId: objectId, kind: z.enum(['verification', 'password-reset']) })
        .strict(),
    }),
    wrap(accounts.sendEmail)
  );
  router.post(
    '/admin/users/:userId/:action(unban|unlock|revoke-sessions)',
    auth,
    admin,
    rateLimit('admin-action', 60),
    validate({
      params: z
        .object({ userId: objectId, action: z.enum(['unban', 'unlock', 'revoke-sessions']) })
        .strict(),
    }),
    wrap(accounts.update)
  );
  router.delete(
    '/admin/users/:userId',
    auth,
    admin,
    rateLimit('admin-delete', 5),
    validate({
      params: param('userId'),
      body: z
        .object({
          password: z
            .string()
            .min(1)
            .max(72)
            .refine((value) => Buffer.byteLength(value) <= 72 && !value.includes('\0')),
          confirmation: z.literal('DELETE'),
          code: codeSchema.optional(),
        })
        .strict(),
    }),
    wrap(accounts.remove)
  );
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
    wrap(accounts.detail)
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
