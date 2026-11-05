const express = require('express');
const { z } = require('zod');
const { createAuthController } = require('../controllers/authController');
const { authenticate, cookies, cookieOptions } = require('../middleware/auth');
const { validate } = require('../middleware/validation');
const { rateLimit, limits } = require('../middleware/rateLimit');
const { passwordSchema, mintCsrf } = require('../lib/authCrypto');
const { codeSchema } = require('../lib/mfa');

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .email()
  .regex(/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@ucf\.edu$/);
const rawToken = z.string().regex(/^[a-f0-9]{64}$/);
const body = (shape) => ({ body: z.object(shape).strict() });
const wrap = (action) => (req, res, next) => Promise.resolve(action(req, res, next)).catch(next);
function authRoutes(config, dependencies) {
  const router = express.Router();
  const controller = createAuthController(config, dependencies);
  const limiter = (scope, category = scope) =>
    rateLimit(scope, dependencies.rateLimits?.[category] ?? limits[category]);
  router.get('/csrf', limiter('csrf'), validate(), (req, res) => {
    const value = mintCsrf(config.JWT_SECRET);
    res.cookie(cookies.csrf, value, { ...cookieOptions, maxAge: 3600000 });
    res.json({ csrfToken: value });
  });
  router.post(
    '/register',
    limiter('register'),
    validate(
      body({ email, password: passwordSchema, displayName: z.string().trim().min(1).max(80) })
    ),
    wrap(controller.register)
  );
  router.post(
    '/resend-verification',
    limiter('resend', 'verify'),
    validate(body({ email })),
    wrap(controller.resendVerification)
  );
  router.post(
    '/verify-email',
    limiter('verify'),
    validate(body({ token: rawToken })),
    wrap(controller.verifyEmail)
  );
  router.post(
    '/login',
    limiter('login'),
    validate(
      body({
        email,
        password: z
          .string()
          .min(1)
          .max(72)
          .refine((v) => Buffer.byteLength(v) <= 72 && !v.includes('\0')),
        code: codeSchema.optional(),
      })
    ),
    wrap(controller.login)
  );
  router.post('/refresh', limiter('refresh'), validate(), wrap(controller.refresh));
  router.post('/logout', limiter('logout'), validate(), wrap(controller.logout));
  router.post(
    '/forgot-password',
    limiter('reset-request', 'reset'),
    validate(body({ email })),
    wrap(controller.forgotPassword)
  );
  router.post(
    '/reset-password',
    limiter('reset-confirm', 'reset'),
    validate(body({ token: rawToken, password: passwordSchema })),
    wrap(controller.resetPassword)
  );
  router.get('/me', validate(), authenticate(config), controller.me);
  return router;
}
module.exports = { authRoutes };
