const { trusted } = require('mongoose');
const { User } = require('../models');
const { AuthSession } = require('../models/auth');
const { token, hash, equal, hashPassword, verifyPassword } = require('../lib/authCrypto');
const { cookies, clearSessionCookies } = require('../middleware/auth');
const { withTransaction } = require('../lib/transaction');
const { lockActor } = require('../lib/lockActor');
const {
  publicUser,
  createFamily,
  setSessionCookies: writeSessionCookies,
} = require('../lib/sessions');
const { consumeMfa } = require('../lib/mfa');

const DAY = 24 * 60 * 60 * 1000;
const generic = { message: 'If eligible, you will receive an email with next steps.' };
function denied(status = 401) {
  return Object.assign(new Error('Authentication failed'), { authStatus: status });
}
let dummyHash;
async function recordFailure(user, session) {
  return User.findOneAndUpdate(
    { _id: user._id, authVersion: user.authVersion, passwordHash: user.passwordHash },
    [
      {
        $set: {
          failedLoginCount: { $min: [20, { $add: [{ $ifNull: ['$failedLoginCount', 0] }, 1] }] },
        },
      },
      {
        $set: {
          lockUntil: {
            $cond: [
              { $gte: ['$failedLoginCount', 5] },
              {
                $add: [
                  new Date(),
                  {
                    $min: [
                      3600000,
                      {
                        $multiply: [60000, { $pow: [2, { $subtract: ['$failedLoginCount', 5] }] }],
                      },
                    ],
                  },
                ],
              },
              '$lockUntil',
            ],
          },
        },
      },
    ],
    { session, new: true }
  ).select('+failedLoginCount');
}

function createAuthController(config, { mailer, logger }) {
  // Unknown accounts still pay the same bcrypt work factor; this value is not an account credential.
  dummyHash ||= hashPassword(token());
  const audit = (event, user, outcome, req) =>
    logger(`audit_${event}`, {
      requestId: req?.id,
      actorId: user ? String(user._id) : undefined,
      outcome,
    });
  const lockoutAlert = (user, req) => {
    if (user?.failedLoginCount >= 5) {
      logger('security_account_lockout', {
        requestId: req.id,
        actorId: String(user._id),
        attemptCount: user.failedLoginCount,
        outcome: 'locked',
      });
    }
  };
  async function sendLink(user, raw, kind) {
    const route = kind === 'verify' ? 'verify-email' : 'reset-password';
    // Fragment keeps tokens out of HTTP paths, access logs, and referrers; the future client POSTs it.
    const url = `${config.CLIENT_ORIGIN}/${route}#token=${raw}`;
    try {
      await mailer.send(
        {
          to: user.email,
          subject:
            kind === 'verify'
              ? 'Verify your UCF Lost & Found email'
              : 'Reset your UCF Lost & Found password',
          text: `Open this link to continue: ${url}\nIf you did not request this, ignore this message.`,
        },
        { userId: user._id }
      );
    } catch {
      // Delivery failures must not turn account existence into a status-code oracle.
      logger('mail_queue_failed', { code: kind });
    }
  }
  const setSessionCookies = (...args) => writeSessionCookies(config, ...args);
  async function rejectRefresh(res) {
    clearSessionCookies(res);
    throw denied();
  }
  return {
    async register(req, res) {
      const { email, password, displayName } = req.validated.body;
      const passwordHash = await hashPassword(password);
      const raw = token();
      let user;
      try {
        user = await User.create({
          email,
          displayName,
          passwordHash,
          verificationTokenHash: hash(raw),
          verificationTokenExpiry: new Date(Date.now() + DAY),
        });
      } catch (error) {
        if (error.code !== 11000) {
          throw error;
        }
        return res.status(202).json(generic);
      }
      await sendLink(user, raw, 'verify');
      audit('register', user, 'created', req);
      res.status(202).json(generic);
    },
    async resendVerification(req, res) {
      const raw = token();
      const user = await User.findOneAndUpdate(
        { email: req.validated.body.email, emailVerified: false, isBanned: false },
        {
          $set: {
            verificationTokenHash: hash(raw),
            verificationTokenExpiry: new Date(Date.now() + DAY),
          },
        },
        { new: true }
      ).select('+email');
      if (user) {
        await sendLink(user, raw, 'verify');
      }
      res.status(202).json(generic);
    },
    async verifyEmail(req, res) {
      const user = await User.findOneAndUpdate(
        {
          verificationTokenHash: hash(req.validated.body.token),
          verificationTokenExpiry: trusted({ $gt: new Date() }),
          emailVerified: false,
          isBanned: false,
        },
        {
          $set: { emailVerified: true },
          $unset: { verificationTokenHash: 1, verificationTokenExpiry: 1 },
        },
        { new: true }
      );
      if (!user) {
        throw denied(400);
      }
      audit('verify_email', user, 'verified', req);
      res.json({ message: 'Email verified. You can now sign in.' });
    },
    async login(req, res) {
      const { email, password, code } = req.validated.body;
      const user = await User.findOne({ email }).select('+passwordHash +authVersion +lockUntil');
      const correct = await verifyPassword(password, user ? user.passwordHash : await dummyHash);
      if (
        !user ||
        !user.emailVerified ||
        user.isBanned ||
        (user.lockUntil && user.lockUntil > new Date())
      ) {
        audit('login', user, 'denied', req);
        throw denied();
      }
      if (!correct) {
        const failed = await recordFailure(user);
        lockoutAlert(failed, req);
        audit('login', user, 'denied', req);
        throw denied();
      }
      let issued;
      let current;
      let failed;
      await withTransaction(async (session) => {
        issued = undefined;
        failed = undefined;
        await lockActor(session, user, user.authVersion);
        current = await User.findOne({
          _id: user._id,
          authVersion: user.authVersion,
          passwordHash: user.passwordHash,
        })
          .select('+authVersion +passwordHash +lockUntil +mfa')
          .session(session);
        if (!current || (current.lockUntil && current.lockUntil > new Date())) {
          return;
        }
        if (current.mfa?.enabled) {
          try {
            await consumeMfa(current._id, code, config, session);
          } catch (error) {
            if (error.authStatus !== 401) {
              throw error;
            }
            // Commit the denial counter rather than rolling it back with a thrown error.
            failed = await recordFailure(current, session);
            return;
          }
        }
        await User.updateOne(
          { _id: current._id },
          { $set: { failedLoginCount: 0 }, $unset: { lockUntil: 1 } },
          { session }
        );
        issued = await createFamily(session, current, current.mfa?.enabled === true);
      }).catch((error) => {
        audit('login', user, 'denied', req);
        throw error;
      });
      if (!issued) {
        lockoutAlert(failed, req);
        audit('login', user, 'denied', req);
        throw denied();
      }
      setSessionCookies(res, current, issued.family, issued.raw);
      audit('login', current, 'success', req);
      res.json({ user: publicUser(current) });
    },
    async refresh(req, res) {
      const value = req.cookies?.[cookies.refresh];
      if (typeof value !== 'string' || !/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(value)) {
        return rejectRefresh(res);
      }
      const [familyId, raw] = value.split('.');
      const digest = hash(raw);
      const family = await AuthSession.findById(familyId).select('+currentHash +consumedHashes');
      if (!family || family.revoked || family.expiresAt <= new Date()) {
        return rejectRefresh(res);
      }
      if (!equal(digest, family.currentHash)) {
        if (family.consumedHashes.includes(digest)) {
          await AuthSession.updateOne({ _id: familyId }, { $set: { revoked: true } });
          audit('refresh_reuse', { _id: family.user }, 'revoked', req);
        }
        return rejectRefresh(res);
      }
      const user = await User.findOne({
        _id: family.user,
        authVersion: family.authVersion,
        emailVerified: true,
        isBanned: false,
      }).select('+authVersion +mfa');
      if (!user || (user.mfa?.enabled && family.mfaAuthenticated !== true)) {
        return rejectRefresh(res);
      }
      const nextRaw = token();
      const rotated = await AuthSession.findOneAndUpdate(
        {
          _id: familyId,
          currentHash: digest,
          revoked: false,
          rotations: trusted({ $lt: 1000 }),
          expiresAt: trusted({ $gt: new Date() }),
        },
        {
          $set: { currentHash: hash(nextRaw) },
          $push: { consumedHashes: digest },
          $inc: { rotations: 1 },
        },
        { new: true }
      );
      if (!rotated) {
        // A simultaneous use of the same token is also replay. Revoke even the winning rotation.
        await AuthSession.updateOne({ _id: familyId }, { $set: { revoked: true } });
        audit('refresh_reuse', user, 'revoked', req);
        return rejectRefresh(res);
      }
      setSessionCookies(res, user, rotated, nextRaw);
      res.json({ user: publicUser(user) });
    },
    async logout(req, res) {
      // Logout works even after access expiry. Only a proven refresh secret can revoke a family.
      const value = req.cookies?.[cookies.refresh];
      if (typeof value === 'string' && /^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(value)) {
        const [familyId, raw] = value.split('.');
        const digest = hash(raw);
        const family = await AuthSession.findOneAndUpdate(
          { _id: familyId, $or: [{ currentHash: digest }, { consumedHashes: digest }] },
          { $set: { revoked: true } },
          { new: true }
        );
        if (family) {
          audit('logout', { _id: family.user }, 'revoked', req);
        }
      }
      clearSessionCookies(res);
      res.status(204).end();
    },
    async forgotPassword(req, res) {
      const raw = token();
      const user = await User.findOneAndUpdate(
        { email: req.validated.body.email, isBanned: false },
        {
          $set: {
            resetTokenHash: hash(raw),
            resetTokenExpiry: new Date(Date.now() + 30 * 60 * 1000),
          },
        },
        { new: true }
      ).select('+email');
      if (user) {
        await sendLink(user, raw, 'reset');
      }
      res.status(202).json(generic);
    },
    async resetPassword(req, res) {
      const passwordHash = await hashPassword(req.validated.body.password);
      let user;
      await withTransaction(async (session) => {
        user = await User.findOneAndUpdate(
          {
            resetTokenHash: hash(req.validated.body.token),
            resetTokenExpiry: trusted({ $gt: new Date() }),
            isBanned: false,
          },
          {
            $set: { passwordHash, failedLoginCount: 0, refreshTokenHashes: [] },
            $inc: { authVersion: 1 },
            $unset: { resetTokenHash: 1, resetTokenExpiry: 1, lockUntil: 1, 'mfa.pending': 1 },
          },
          { new: true, session }
        );
        if (!user) {
          throw denied(400);
        }
        await AuthSession.updateMany({ user: user._id }, { $set: { revoked: true } }, { session });
      });
      clearSessionCookies(res);
      audit('password_reset', user, 'success', req);
      res.json({ message: 'Password reset. Sign in again.' });
    },
    me(req, res) {
      res.json({ user: publicUser(req.user) });
    },
  };
}
module.exports = { createAuthController };
