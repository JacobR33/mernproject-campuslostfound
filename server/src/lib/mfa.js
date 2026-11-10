const {
  randomBytes,
  hkdfSync,
  createCipheriv,
  createDecipheriv,
  createHmac,
} = require('node:crypto');
const OTPAuth = require('otpauth');
const { z } = require('zod');
const { User } = require('../models');
const { equal } = require('./authCrypto');
const codeSchema = z
  .string()
  .trim()
  .regex(/^(?:\d{6}|[a-fA-F0-9]{20}|[a-fA-F0-9]{5}(?:-[a-fA-F0-9]{5}){3})$/);
const mfaSelection =
  '+mfa +mfa.secretEncrypted +mfa.backupCodeHashes +mfa.lastUsedStep +mfa.pending.secretEncrypted';
const denied = () => Object.assign(new Error('Authentication failed'), { authStatus: 401 });
function key(config, domain) {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(config.MFA_ENCRYPTION_KEY, 'hex'),
      Buffer.from('ucf-lost-found'),
      Buffer.from(domain),
      32
    )
  );
}
function encryptSecret(secret, userId, purpose, config) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(config, 'mfa-secret-v1'), iv);
  cipher.setAAD(Buffer.from(`mfa-v1:${userId}:${purpose}`));
  const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('hex'), cipher.getAuthTag().toString('hex'), data.toString('hex')].join(
    '.'
  );
}
function decryptSecret(envelope, userId, purpose, config) {
  if (
    typeof envelope !== 'string' ||
    !/^v1\.[a-f0-9]{24}\.[a-f0-9]{32}\.[a-f0-9]{64,208}$/.test(envelope)
  ) {
    throw new Error('Invalid MFA envelope');
  }
  const [, iv, tag, data] = envelope.split('.');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key(config, 'mfa-secret-v1'),
    Buffer.from(iv, 'hex')
  );
  decipher.setAAD(Buffer.from(`mfa-v1:${userId}:${purpose}`));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  const secret = Buffer.concat([
    decipher.update(Buffer.from(data, 'hex')),
    decipher.final(),
  ]).toString('utf8');
  if (!/^[A-Z2-7]{32,104}$/.test(secret)) {
    throw new Error('Invalid MFA secret');
  }
  return secret;
}
const authenticator = (secret) =>
  new OTPAuth.TOTP({
    issuer: 'UCF Lost & Found',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
function matchingStep(secret, code, timestamp = Date.now()) {
  if (!/^\d{6}$/.test(code || '')) {
    return null;
  }
  const delta = authenticator(secret).validate({ token: code, timestamp, window: 1 });
  return delta === null ? null : Math.floor(timestamp / 30000) + delta;
}
function backupHash(value, userId, config) {
  return createHmac('sha256', key(config, 'mfa-backup-v1'))
    .update(`${userId}:${value.replaceAll('-', '').toUpperCase()}`)
    .digest('hex');
}
function newBackupCodes(userId, config) {
  const codes = Array.from({ length: 10 }, () =>
    randomBytes(10).toString('hex').toUpperCase().match(/.{5}/g).join('-')
  );
  return { codes, hashes: codes.map((code) => backupHash(code, userId, config)) };
}
function factorProof(user, code, config) {
  if (!code) {
    return null;
  }
  if (/^\d{6}$/.test(code)) {
    const secret = decryptSecret(user.mfa.secretEncrypted, user._id, 'active', config);
    const step = matchingStep(secret, code);
    return step !== null && step > (user.mfa.lastUsedStep ?? -1) ? { step } : null;
  }
  const digest = backupHash(code, user._id, config);
  return user.mfa.backupCodeHashes?.some((value) => equal(value, digest)) ? { digest } : null;
}
async function consumeMfa(userId, code, config, session) {
  const user = await User.findById(userId).select(mfaSelection).session(session);
  if (!user?.mfa?.enabled) {
    throw denied();
  }
  const proof = factorProof(user, code, config);
  if (!proof) {
    throw denied();
  }
  const filter = { _id: userId, 'mfa.enabled': true };
  const update = proof.digest
    ? { $pull: { 'mfa.backupCodeHashes': proof.digest } }
    : { $set: { 'mfa.lastUsedStep': proof.step } };
  if (proof.digest) {
    filter['mfa.backupCodeHashes'] = proof.digest;
  } else {
    filter['mfa.lastUsedStep'] = user.mfa.lastUsedStep ?? -1;
  }
  const result = await User.updateOne(filter, update, { session });
  if (result.modifiedCount !== 1) {
    throw denied();
  }
}
module.exports = {
  codeSchema,
  mfaSelection,
  encryptSecret,
  decryptSecret,
  authenticator,
  matchingStep,
  backupHash,
  newBackupCodes,
  factorProof,
  consumeMfa,
  denied,
};
