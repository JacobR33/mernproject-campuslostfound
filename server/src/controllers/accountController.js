const { User } = require('../models');
const { verifyPassword } = require('../lib/authCrypto');
const { withTransaction } = require('../lib/transaction');
const { lockActor } = require('../lib/lockActor');
const { eraseAccountData } = require('../lib/accountDeletion');
const { clearSessionCookies, cookies, cookieOptions } = require('../middleware/auth');
const { consumeMfa } = require('../lib/mfa');
function accountController(config, logger) {
  return {
    async remove(req, res) {
      const user = await User.findById(req.user._id).select('+passwordHash +authVersion +email');
      if (!user || !(await verifyPassword(req.validated.body.password, user.passwordHash))) {
        throw Object.assign(new Error('Authentication failed'), { authStatus: 401 });
      }
      await withTransaction(async (session) => {
        await lockActor(session, req.user, req.auth.version);
        const current = await User.findOne({
          _id: user._id,
          passwordHash: user.passwordHash,
          authVersion: user.authVersion,
        }).session(session);
        if (!current) {
          throw Object.assign(new Error('Authentication failed'), { authStatus: 401 });
        }
        const mfa = await User.findById(user._id).select('+mfa').session(session);
        if (mfa?.mfa?.enabled) {
          await consumeMfa(user._id, req.validated.body.code, config, session);
        }
        await eraseAccountData(user, session);
      });
      logger('audit_account_delete', { requestId: req.id, outcome: 'deleted' });
      clearSessionCookies(res);
      res.clearCookie(cookies.csrf, cookieOptions);
      res.status(204).end();
    },
  };
}
module.exports = { accountController };
