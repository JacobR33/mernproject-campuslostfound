const mongoose = require('mongoose');
const { Schema } = mongoose;
// A single family document makes rotation and replay invalidation atomic without a replica set.
const sessionSchema = new Schema(
  {
    _id: { type: String, required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    authVersion: { type: Number, required: true },
    mfaAuthenticated: { type: Boolean, default: false },
    currentHash: { type: String, required: true, select: false },
    consumedHashes: { type: [String], default: [], select: false },
    rotations: { type: Number, default: 0 },
    revoked: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true },
  },
  { strict: 'throw', timestamps: true }
);
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const rateSchema = new Schema(
  { _id: String, count: { type: Number, default: 0 }, expiresAt: { type: Date, required: true } },
  { strict: 'throw' }
);
rateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const outboxSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    recipientHash: { type: String, select: false, index: true },
    payloadEncrypted: { type: String, required: true, select: false },
    attempts: { type: Number, default: 0 },
    availableAt: { type: Date, default: Date.now },
    leasedUntil: { type: Date, default: () => new Date(0) },
    expiresAt: { type: Date, required: true },
  },
  { strict: 'throw' }
);
outboxSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
outboxSchema.index({ availableAt: 1, leasedUntil: 1 });
module.exports = {
  AuthSession: mongoose.models.AuthSession || mongoose.model('AuthSession', sessionSchema),
  RateBucket: mongoose.models.RateBucket || mongoose.model('RateBucket', rateSchema),
  MailOutbox: mongoose.models.MailOutbox || mongoose.model('MailOutbox', outboxSchema),
};
