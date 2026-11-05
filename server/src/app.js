const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const hpp = require('hpp');
const mongoSanitize = require('express-mongo-sanitize');
const { randomUUID } = require('node:crypto');
const { validate } = require('./middleware/validation');
const { createLogger } = require('./lib/logger');
const cookieParser = require('cookie-parser');
const { authRoutes } = require('./routes/auth');
const { csrfProtection } = require('./middleware/csrf');
const { createQueuedMailer } = require('./lib/mailQueue');
const { postRoutes } = require('./routes/posts');
const { uploadRoutes } = require('./routes/uploads');
const { createGridFSStorage } = require('./storage/gridfs');
const { claimRoutes } = require('./routes/claims');
const { chatRoutes } = require('./routes/chat');
const { moderationRoutes } = require('./routes/moderation');
const { mfaRoutes } = require('./routes/mfa');
const { inputBounds } = require('./middleware/inputBounds');

function createApp(
  config,
  { logger = createLogger(), mailer, rateLimits, storage = createGridFSStorage() } = {}
) {
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  app.set('trust proxy', config.TRUST_PROXY?.length ? config.TRUST_PROXY : false);
  app.use((req, res, next) => {
    req.id = randomUUID();
    res.setHeader('X-Request-Id', req.id);
    res.setHeader('Cache-Control', 'no-store');
    const started = Date.now();
    res.on('finish', () =>
      logger('http_request', {
        requestId: req.id,
        method: req.method,
        status: res.statusCode,
        durationMs: Date.now() - started,
      })
    );
    next();
  });
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          baseUri: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'none'"],
        },
      },
      referrerPolicy: { policy: 'no-referrer' },
    })
  );
  app.use((req, res, next) => {
    if (req.headers.origin && req.headers.origin !== config.CLIENT_ORIGIN) {
      return res.status(403).json({ error: 'Origin not allowed', requestId: req.id });
    }
    next();
  });
  app.use(
    cors({
      origin: config.CLIENT_ORIGIN,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
    })
  );
  app.use(cookieParser());
  app.use(express.json({ limit: '32kb', strict: true, inflate: false }));
  app.use(inputBounds);
  app.use((req, res, next) => {
    if (mongoSanitize.has(req.body ?? {}) || mongoSanitize.has(req.query)) {
      return res.status(400).json({ error: 'Invalid request', requestId: req.id });
    }
    if (Object.values(req.query).some(Array.isArray)) {
      return res.status(400).json({ error: 'Invalid request', requestId: req.id });
    }
    next();
  });
  app.use(mongoSanitize());
  app.use(hpp());
  app.get('/api/health', validate(), (req, res) => res.json({ status: 'ok' }));
  app.use('/api', csrfProtection(config));
  app.use(
    '/api/auth',
    authRoutes(config, { logger, mailer: mailer || createQueuedMailer(config), rateLimits })
  );
  app.use('/api/mfa', mfaRoutes(config, { logger }));
  app.use('/api/posts', postRoutes(config, { logger }));
  app.use('/api/uploads', uploadRoutes(config, { storage, logger }));
  app.use('/api', claimRoutes(config, { logger }));
  app.use('/api', chatRoutes(config, { logger }));
  app.use('/api', moderationRoutes(config, { logger }));
  app.use((req, res) => res.status(404).json({ error: 'Not found', requestId: req.id }));
  app.use((err, req, res, next) => {
    if (res.headersSent) {
      return next(err);
    }
    const multerError = err.name === 'MulterError';
    const status =
      err.type === 'entity.too.large' || (multerError && err.code === 'LIMIT_FILE_SIZE')
        ? 413
        : ['encoding.unsupported', 'charset.unsupported'].includes(err.type)
          ? 415
          : ['entity.parse.failed', 'request.aborted', 'request.size.invalid'].includes(err.type) ||
              multerError
            ? 400
            : [400, 401].includes(err.authStatus)
              ? err.authStatus
              : [400, 404, 409, 429, 503].includes(err.httpStatus)
                ? err.httpStatus
                : 500;
    logger('request_error', { requestId: req.id, code: status });
    const messages = {
      400: 'Invalid request',
      401: 'Authentication failed',
      404: 'Not found',
      409: 'Resource changed. Reload and try again.',
      413: 'Request too large',
      415: 'Unsupported request format',
      429: 'Too many requests',
      503: 'Service busy. Try again.',
    };
    res
      .status(status)
      .json({ error: messages[status] || 'Internal server error', requestId: req.id });
  });
  return app;
}
module.exports = { createApp };
