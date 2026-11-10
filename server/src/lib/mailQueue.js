const { randomBytes, hkdfSync, createCipheriv, createDecipheriv } = require('node:crypto');
const { trusted } = require('mongoose');
const { MailOutbox } = require('../models/auth');
const { createMailer } = require('./mail');
const { hash } = require('./authCrypto');
const { User } = require('../models');
const { withTransaction } = require('./transaction');

function outboxKey(config) {
  // Domain separation: the validated encryption key is not used directly as a mail encryption key.
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(config.MFA_ENCRYPTION_KEY, 'hex'),
      Buffer.from('ucf-lost-found'),
      Buffer.from('mail-outbox-v1'),
      32
    )
  );
}
function encryptMessage(message, config) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', outboxKey(config), iv);
  cipher.setAAD(Buffer.from('ucf-mail-v1'));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(message), 'utf8'),
    cipher.final(),
  ]);
  return [
    'v1',
    iv.toString('hex'),
    cipher.getAuthTag().toString('hex'),
    ciphertext.toString('hex'),
  ].join('.');
}
function decryptMessage(value, config) {
  const [version, iv, tag, data] = value.split('.');
  if (
    version !== 'v1' ||
    !/^[a-f0-9]{24}$/.test(iv) ||
    !/^[a-f0-9]{32}$/.test(tag) ||
    !/^(?:[a-f0-9]{2})+$/.test(data)
  ) {
    throw new Error('Invalid mail envelope');
  }
  const decipher = createDecipheriv('aes-256-gcm', outboxKey(config), Buffer.from(iv, 'hex'));
  decipher.setAAD(Buffer.from('ucf-mail-v1'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return JSON.parse(
    Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()]).toString('utf8')
  );
}
function createQueuedMailer(config) {
  return {
    async send(message, { userId } = {}) {
      const envelope = {
        ...(userId ? { user: userId } : {}),
        recipientHash: hash(message.to.trim().toLowerCase()),
        payloadEncrypted: encryptMessage(message, config),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      };
      if (!userId) {
        return MailOutbox.create(envelope);
      }
      // Registration is intentionally allowed before verification. Lock the recipient
      // to serialize with account deletion/ban, without recording the plaintext email.
      return withTransaction(async (session) => {
        const result = await User.updateOne(
          { _id: userId, email: message.to, isBanned: false },
          { $inc: { activityVersion: 1 } },
          { session }
        );
        if (result.matchedCount !== 1) {
          return;
        }
        return MailOutbox.create([envelope], { session });
      });
    },
  };
}
async function deliverOne(config, { transport, logger }) {
  const now = new Date();
  const job = await MailOutbox.findOneAndUpdate(
    {
      attempts: trusted({ $lt: 10 }),
      availableAt: trusted({ $lte: now }),
      leasedUntil: trusted({ $lte: now }),
      expiresAt: trusted({ $gt: now }),
    },
    {
      $set: { leasedUntil: new Date(Date.now() + 60000) },
      $inc: { attempts: 1 },
    },
    { new: true, sort: { availableAt: 1 } }
  ).select('+payloadEncrypted');
  if (!job) {
    return false;
  }
  try {
    if (job.user && !(await User.exists({ _id: job.user, isBanned: false }))) {
      await MailOutbox.deleteOne({ _id: job._id });
      return true;
    }
    await transport.send(decryptMessage(job.payloadEncrypted, config));
    await MailOutbox.deleteOne({ _id: job._id });
  } catch {
    await MailOutbox.updateOne(
      { _id: job._id },
      {
        $set: {
          availableAt: new Date(Date.now() + Math.min(3600000, 30000 * 2 ** job.attempts)),
          leasedUntil: new Date(0),
        },
      }
    );
    logger('mail_delivery_failed', { code: 'transport' });
  }
  return true;
}
function startMailWorker(config, logger) {
  const transport = createMailer(config);
  let running = false;
  let stopped = false;
  let pending = Promise.resolve();
  const tick = () => {
    if (running || stopped) {
      return;
    }
    running = true;
    pending = deliverOne(config, { transport, logger })
      .catch(() => logger('mail_worker_failed'))
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(tick, 1000).unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await pending;
  };
}
module.exports = {
  encryptMessage,
  decryptMessage,
  createQueuedMailer,
  deliverOne,
  startMailWorker,
};
