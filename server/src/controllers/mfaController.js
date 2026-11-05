const OTPAuth = require('otpauth');
const QRCode = require('qrcode');
const { User } = require('../models');
const { AuthSession } = require('../models/auth');
const { token, verifyPassword } = require('../lib/authCrypto');
const {
  mfaSelection,
  encryptSecret,
  decryptSecret,
  authenticator,
  matchingStep,
  newBackupCodes,
  consumeMfa,
  denied,
} = require('../lib/mfa');
const { withTransaction } = require('../lib/transaction');
const { lockActor } = require('../lib/lockActor');
const { publicUser, createFamily, setSessionCookies } = require('../lib/sessions');
const { httpError } = require('../lib/httpError');
function mfaController(config, logger) {
  async function reauthenticate(req, session) {
    await lockActor(session, req.user, req.auth.version);
    const user = await User.findById(req.user._id)
      .select(`+passwordHash +authVersion ${mfaSelection}`)
      .session(session);
    if (!user || !(await verifyPassword(req.validated.body.password, user.passwordHash))) {
      throw denied();
    }
    return user;
  }
  async function rotateSession(user, session, enabled) {
    const current = await User.findOneAndUpdate(
      { _id: user._id, authVersion: user.authVersion },
      { $inc: { authVersion: 1 }, $set: { refreshTokenHashes: [] } },
      { session, new: true }
    ).select('+authVersion');
    if (!current) {
      throw denied();
    }
    await AuthSession.updateMany({ user: user._id }, { $set: { revoked: true } }, { session });
    return { user: current, ...(await createFamily(session, current, enabled)) };
  }
  const audit = (req, outcome) =>
    logger('audit_mfa', { requestId: req.id, actorId: String(req.user._id), outcome });
  return {
    async status(req, res) {
      const user = await User.findById(req.user._id).select('+mfa +mfa.backupCodeHashes');
      if (!user) {
        throw denied();
      }
      res.json({
        enabled: user.mfa?.enabled === true,
        backupCodesRemaining: user.mfa?.enabled ? user.mfa.backupCodeHashes.length : 0,
      });
    },
    async enroll(req, res) {
      const secret = new OTPAuth.Secret({ size: 20 }).base32;
      const enrollmentId = token();
      const expiresAt = new Date(Date.now() + 10 * 60000);
      const otp = authenticator(secret);
      otp.label = String(req.user._id);
      const uri = otp.toString();
      const qrDataUrl = await QRCode.toDataURL(uri, {
        type: 'image/png',
        width: 320,
        margin: 4,
        errorCorrectionLevel: 'M',
      });
      await withTransaction(async (session) => {
        const user = await reauthenticate(req, session);
        if (user.mfa?.enabled) {
          throw httpError(409, 'MFA already enabled');
        }
        await User.updateOne(
          { _id: user._id },
          {
            $set: {
              'mfa.pending': {
                id: enrollmentId,
                secretEncrypted: encryptSecret(secret, user._id, `pending:${enrollmentId}`, config),
                expiresAt,
              },
            },
          },
          { session }
        );
      });
      audit(req, 'enrollment_started');
      // This is the only endpoint returning a plaintext seed. It is private, no-store,
      // password-protected, and cannot be fetched again without replacing the seed.
      res.json({ enrollmentId, expiresAt, secret, qrDataUrl });
    },
    async confirm(req, res) {
      let issued;
      let backup;
      await withTransaction(async (session) => {
        const user = await reauthenticate(req, session);
        const pending = user.mfa?.pending;
        if (
          user.mfa?.enabled ||
          !pending ||
          pending.id !== req.validated.body.enrollmentId ||
          pending.expiresAt <= new Date()
        ) {
          throw denied();
        }
        const secret = decryptSecret(
          pending.secretEncrypted,
          user._id,
          `pending:${pending.id}`,
          config
        );
        const step = matchingStep(secret, req.validated.body.code);
        if (step === null) {
          throw denied();
        }
        backup = newBackupCodes(user._id, config);
        await User.updateOne(
          { _id: user._id },
          {
            $set: {
              mfa: {
                enabled: true,
                secretEncrypted: encryptSecret(secret, user._id, 'active', config),
                lastUsedStep: step,
                backupCodeHashes: backup.hashes,
              },
            },
          },
          { session }
        );
        issued = await rotateSession(user, session, true);
      });
      setSessionCookies(config, res, issued.user, issued.family, issued.raw);
      audit(req, 'enabled');
      res.json({ user: publicUser(issued.user), backupCodes: backup.codes });
    },
    async manage(req, res, disable = false) {
      let issued;
      let backup;
      await withTransaction(async (session) => {
        const user = await reauthenticate(req, session);
        await consumeMfa(user._id, req.validated.body.code, config, session);
        if (disable) {
          await User.updateOne(
            { _id: user._id },
            { $set: { mfa: { enabled: false, backupCodeHashes: [], lastUsedStep: -1 } } },
            { session }
          );
        } else {
          backup = newBackupCodes(user._id, config);
          await User.updateOne(
            { _id: user._id },
            { $set: { 'mfa.backupCodeHashes': backup.hashes } },
            { session }
          );
        }
        issued = await rotateSession(user, session, !disable);
      });
      setSessionCookies(config, res, issued.user, issued.family, issued.raw);
      audit(req, disable ? 'disabled' : 'backup_codes_replaced');
      res.json({ user: publicUser(issued.user), ...(backup ? { backupCodes: backup.codes } : {}) });
    },
  };
}
module.exports = { mfaController };
