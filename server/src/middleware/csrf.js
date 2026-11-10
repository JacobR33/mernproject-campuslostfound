const { equal, validCsrf } = require('../lib/authCrypto');
const { cookies } = require('./auth');
function csrfProtection(config) {
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return next();
    }
    const cookie = req.cookies?.[cookies.csrf];
    if (
      req.headers.origin !== config.CLIENT_ORIGIN ||
      !equal(cookie, req.get('X-CSRF-Token')) ||
      !validCsrf(cookie, config.JWT_SECRET)
    ) {
      return res.status(403).json({ error: 'Request rejected', requestId: req.id });
    }
    const imageUpload =
      req.method === 'POST' &&
      /^\/uploads\/?$/.test(req.path || '') &&
      req.is('multipart/form-data');
    if (!req.is('application/json') && !imageUpload) {
      return res.status(415).json({ error: 'JSON required', requestId: req.id });
    }
    next();
  };
}
module.exports = { csrfProtection };
