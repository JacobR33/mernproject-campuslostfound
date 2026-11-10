const { trusted } = require('mongoose');
const { User } = require('../models');
const { AuthSession, MailOutbox } = require('../models/auth');
const Audit = require('../models/moderationAudit');
const { withTransaction } = require('../lib/transaction');
const { lockActor } = require('../lib/lockActor');
const { eraseAccountData } = require('../lib/accountDeletion');
const { verifyPassword, token, hash } = require('../lib/authCrypto');
const { consumeMfa } = require('../lib/mfa');
const { encryptMessage } = require('../lib/mailQueue');
const { httpError } = require('../lib/httpError');

// Include only these account fields, never credentials, tokens, or MFA secrets.
const accountFields =
  'displayName role isBanned emailVerified createdAt +email +lockUntil +failedLoginCount +verificationTokenExpiry';
const accountProjection = {
  displayName: 1,
  role: 1,
  isBanned: 1,
  emailVerified: 1,
  createdAt: 1,
  email: 1,
  lockUntil: 1,
  failedLoginCount: 1,
  verificationTokenExpiry: 1,
  'mfa.enabled': 1,
};

function accountDTO(user) {
  return {
    id: String(user._id),
    displayName: user.displayName,
    email: user.email,
    role: user.role,
    isBanned: user.isBanned,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt,
    lockUntil: user.lockUntil || null,
    isLocked: Boolean(user.lockUntil && new Date(user.lockUntil) > new Date()),
    failedLoginCount: user.failedLoginCount || 0,
    verificationExpiresAt: user.verificationTokenExpiry || null,
    mfaEnabled: Boolean(user.mfa?.enabled),
  };
}

function pagination(query, total) {
  return { page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit) };
}

function adminAccountController(config, logger) {
  async function record(req, session, action, target) {
    await Audit.create([{ actor: req.user._id, action, target }], { session });
  }

  function log(req, action) {
    logger('audit_admin', { requestId: req.id, actorId: String(req.user._id), outcome: action });
  }

  // Lock both the current administrator and target to serialize with login,
  // account deletion, and other moderation operations.
  async function targetForAction(req, session) {
    await lockActor(session, req.user, req.auth.version);
    const target = await User.findOneAndUpdate(
      { _id: req.validated.params.userId, role: 'user' },
      { $inc: { activityVersion: 1 } },
      { new: true, session }
    ).select(accountFields);
    if (!target) throw httpError(404, 'Account unavailable');
    return target;
  }

  return {
    async list(req, res) {
      const query = req.validated.query;
      const filter = {};
      if (query.search) {
        const literal = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Escape user text, cap query length at validation, and bound execution time.
        filter.$or = ['email', 'displayName'].map((field) => ({
          [field]: { $regex: literal, $options: 'i' },
        }));
      }
      if (query.status === 'unverified') filter.emailVerified = false;
      if (query.status === 'verified') filter.emailVerified = true;
      if (query.status === 'banned') filter.isBanned = true;
      if (query.status === 'locked') filter.lockUntil = { $gt: new Date() };
      if (query.role) filter.role = query.role;
      // Aggregation bypasses schema redaction only for this explicit admin projection.
      const [result] = await User.aggregate([
        { $match: filter },
        {
          $facet: {
            total: [{ $count: 'count' }],
            accounts: [
              { $sort: { createdAt: -1, _id: -1 } },
              { $skip: (query.page - 1) * query.limit },
              { $limit: query.limit },
              { $project: accountProjection },
            ],
          },
        },
      ]).option({ maxTimeMS: 5000 });
      log(req, 'accounts_viewed');
      res.json({
        users: result.accounts.map(accountDTO),
        pagination: pagination(query, result.total[0]?.count || 0),
      });
    },

    async detail(req, res) {
      const user = await User.findById(req.validated.params.userId)
        .select(`${accountFields} +mfa`)
        .lean();
      if (!user) throw httpError(404, 'Account unavailable');
      log(req, 'account_viewed');
      res.json({ user: accountDTO(user) });
    },

    async update(req, res) {
      const { action } = req.validated.params;
      const auditAction = {
        unban: 'user_unbanned',
        unlock: 'user_unlocked',
        'revoke-sessions': 'user_sessions_revoked',
      }[action];
      await withTransaction(async (session) => {
        const target = await targetForAction(req, session);
        const update =
          action === 'unban'
            ? { isBanned: false }
            : action === 'unlock'
              ? { failedLoginCount: 0, lockUntil: null }
              : {};
        await User.updateOne(
          { _id: target._id },
          {
            $set: { ...update, refreshTokenHashes: [] },
            $inc: { authVersion: 1 },
          },
          { session }
        );
        await AuthSession.updateMany(
          { user: target._id },
          { $set: { revoked: true } },
          { session }
        );
        await record(req, session, auditAction, target._id);
      });
      log(req, auditAction);
      res.status(204).end();
    },

    async sendEmail(req, res) {
      const verification = req.validated.params.kind === 'verification';
      await withTransaction(async (session) => {
        const target = await targetForAction(req, session);
        if (target.isBanned || (verification && target.emailVerified)) {
          throw httpError(409, 'Account is not eligible for this email');
        }
        const raw = token();
        const lifetime = verification ? 86400000 : 1800000;
        const prefix = verification ? 'verification' : 'reset';
        await User.updateOne(
          { _id: target._id },
          {
            $set: {
              [`${prefix}TokenHash`]: hash(raw),
              [`${prefix}TokenExpiry`]: new Date(Date.now() + lifetime),
            },
          },
          { session }
        );
        const route = verification ? 'verify-email' : 'reset-password';
        const message = {
          to: target.email,
          subject: verification
            ? 'Verify your UCF Lost & Found email'
            : 'Reset your UCF Lost & Found password',
          text: `Open this link to continue: ${config.CLIENT_ORIGIN}/${route}#token=${raw}\nIf you did not request this, ignore this message.`,
        };
        // Queue email in the same transaction as token rotation and the audit event.
        // The existing worker delivers through file or SMTP transport.
        await MailOutbox.create(
          [
            {
              user: target._id,
              recipientHash: hash(target.email),
              payloadEncrypted: encryptMessage(message, config),
              expiresAt: new Date(Date.now() + 86400000),
            },
          ],
          { session }
        );
        await record(
          req,
          session,
          verification ? 'verification_sent' : 'password_reset_sent',
          target._id
        );
      });
      log(req, verification ? 'verification_sent' : 'password_reset_sent');
      res.status(202).json({
        message: 'Email queued for delivery. Existing links of this type have been replaced.',
      });
    },

    async remove(req, res) {
      const admin = await User.findById(req.user._id).select('+passwordHash +authVersion');
      if (!admin || !(await verifyPassword(req.validated.body.password, admin.passwordHash))) {
        throw Object.assign(new Error('Authentication failed'), { authStatus: 401 });
      }
      await withTransaction(async (session) => {
        const target = await targetForAction(req, session);
        const currentAdmin = await User.findOne({
          _id: admin._id,
          passwordHash: admin.passwordHash,
          authVersion: admin.authVersion,
        })
          .select('+mfa')
          .session(session);
        if (!currentAdmin)
          throw Object.assign(new Error('Authentication failed'), { authStatus: 401 });
        if (currentAdmin.mfa?.enabled) {
          await consumeMfa(admin._id, req.validated.body.code, config, session);
        }
        await eraseAccountData(target, session, { preserveAudit: true });
        await record(req, session, 'user_deleted', target._id);
      });
      log(req, 'user_deleted');
      res.status(204).end();
    },

    async activity(req, res) {
      const query = req.validated.query;
      const filter = query.userId
        ? { $or: [{ actor: query.userId }, { target: query.userId }] }
        : {};
      const [rows, total] = await Promise.all([
        Audit.find(filter)
          .sort({ createdAt: -1, _id: -1 })
          .skip((query.page - 1) * query.limit)
          .limit(query.limit)
          .select('actor target action createdAt')
          .lean()
          .maxTimeMS(5000),
        Audit.countDocuments(filter).maxTimeMS(5000),
      ]);
      res.json({
        events: rows.map((row) => ({
          id: String(row._id),
          actorId: String(row.actor),
          targetId: String(row.target),
          action: row.action,
          createdAt: row.createdAt,
        })),
        pagination: pagination(query, total),
      });
    },
  };
}

module.exports = { adminAccountController };
