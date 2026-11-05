const jwt = require('jsonwebtoken');
const { AuthSession } = require('../models/auth');
const { token, hash } = require('./authCrypto');
const { cookies, cookieOptions } = require('../middleware/auth');
const publicUser = (user) => ({
  id: String(user._id),
  displayName: user.displayName,
  role: user.role,
  emailVerified: user.emailVerified,
});
async function createFamily(session, user, mfaAuthenticated = false) {
  const raw = token();
  const [family] = await AuthSession.create(
    [
      {
        _id: token(),
        user: user._id,
        authVersion: user.authVersion,
        mfaAuthenticated,
        currentHash: hash(raw),
        expiresAt: new Date(Date.now() + 7 * 86400000),
      },
    ],
    { session }
  );
  return { family, raw };
}
function setSessionCookies(config, res, user, family, rawRefresh) {
  const access = jwt.sign({ ver: user.authVersion, sid: family._id }, config.JWT_SECRET, {
    algorithm: 'HS256',
    subject: String(user._id),
    issuer: 'ucf-lost-found',
    audience: 'ucf-lost-found-api',
    expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
  });
  res.cookie(cookies.access, access, {
    ...cookieOptions,
    maxAge: config.ACCESS_TOKEN_TTL_SECONDS * 1000,
  });
  res.cookie(cookies.refresh, `${family._id}.${rawRefresh}`, {
    ...cookieOptions,
    maxAge: Math.max(0, family.expiresAt - Date.now()),
  });
}
module.exports = { publicUser, createFamily, setSessionCookies };
