const jwt = require('jsonwebtoken');
const { trusted } = require('mongoose');
const { User } = require('../models');
const { AuthSession } = require('../models/auth');
const cookies = {
  access: '__Host-ucf_access',
  refresh: '__Host-ucf_refresh',
  csrf: '__Host-ucf_csrf',
};
const cookieOptions = Object.freeze({
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  path: '/',
});
function clearSessionCookies(res) {
  res.clearCookie(cookies.access, cookieOptions);
  res.clearCookie(cookies.refresh, cookieOptions);
}
async function resolveAuth(config, accessToken) {
  let claims;
  try {
    claims = jwt.verify(accessToken, config.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'ucf-lost-found',
      audience: 'ucf-lost-found-api',
      maxAge: config.ACCESS_TOKEN_TTL_SECONDS,
    });
    if (
      !claims ||
      typeof claims !== 'object' ||
      !/^[a-f0-9]{24}$/.test(claims.sub) ||
      !/^[a-f0-9]{64}$/.test(claims.sid) ||
      !Number.isInteger(claims.ver)
    ) {
      throw new Error('Invalid claims');
    }
  } catch {
    throw Object.assign(new Error('Authentication required'), { authStatus: 401 });
  }
  const user = await User.findOne({
    _id: claims.sub,
    authVersion: claims.ver,
    emailVerified: true,
    isBanned: false,
  }).select('+mfa');
  const family = await AuthSession.exists({
    _id: claims.sid,
    user: claims.sub,
    authVersion: claims.ver,
    revoked: false,
    ...(user?.mfa?.enabled ? { mfaAuthenticated: true } : {}),
    expiresAt: trusted({ $gt: new Date() }),
  });
  if (!user || !family) {
    throw Object.assign(new Error('Authentication required'), { authStatus: 401 });
  }
  return { user, claims };
}
function authenticate(config) {
  return async (req, res, next) => {
    try {
      const { user, claims } = await resolveAuth(config, req.cookies?.[cookies.access]);
      req.user = user;
      req.auth = { familyId: claims.sid, version: claims.ver };
      next();
    } catch (error) {
      if (error.authStatus === 401) {
        return res.status(401).json({ error: 'Authentication required', requestId: req.id });
      }
      next(error);
    }
  };
}
const requireRole = (role) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required', requestId: req.id });
  }
  if (req.user.role !== role) {
    return res.status(403).json({ error: 'Forbidden', requestId: req.id });
  }
  next();
};
// Call only after loading a resource with a permission-scoped query. No admin bypass by default.
const requireOwner = (getOwner) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required', requestId: req.id });
  }
  const owner = getOwner(req);
  if (!owner || String(owner) !== String(req.user._id)) {
    return res.status(404).json({ error: 'Not found', requestId: req.id });
  }
  next();
};
module.exports = {
  authenticate,
  resolveAuth,
  requireRole,
  requireOwner,
  cookies,
  cookieOptions,
  clearSessionCookies,
};
