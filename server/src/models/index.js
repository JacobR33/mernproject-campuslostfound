const mongoose = require('mongoose');
const { Schema } = mongoose;
const ref = (model) => ({ type: Schema.Types.ObjectId, ref: model, required: true });
const secret = { type: String, select: false };
const options = {
  strict: 'throw',
  timestamps: { createdAt: true, updatedAt: false },
  toJSON: { transform: redact },
  toObject: { transform: redact },
};
const hidden = new Set([
  'email',
  'passwordHash',
  'verificationTokenHash',
  'verificationTokenExpiry',
  'resetTokenHash',
  'resetTokenExpiry',
  'authVersion',
  'mfa',
  'refreshTokenHashes',
  'failedLoginCount',
  'lockUntil',
  'privateDetails',
  'answerHash',
  'answerSalt',
  'submittedAnswers',
  'verificationPassed',
  'approvedClaim',
  'approvedMatch',
  'chatVersion',
  'activityVersion',
]);
function redact(doc, value) {
  function walk(obj) {
    if (
      !obj ||
      typeof obj !== 'object' ||
      obj instanceof Date ||
      obj instanceof mongoose.Types.ObjectId
    ) {
      return;
    }
    for (const key of Object.keys(obj)) {
      if (hidden.has(key)) {
        delete obj[key];
      } else {
        walk(obj[key]);
      }
    }
  }
  walk(value);
  delete value.__v;
  return value;
}
const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@ucf\.edu$/,
      select: false,
      maxlength: 254,
    },
    passwordHash: { ...secret, required: true },
    displayName: { type: String, required: true, trim: true, minlength: 1, maxlength: 80 },
    emailVerified: { type: Boolean, default: false },
    verificationTokenHash: secret,
    verificationTokenExpiry: { type: Date, select: false },
    resetTokenHash: secret,
    resetTokenExpiry: { type: Date, select: false },
    authVersion: { type: Number, default: 0, select: false, min: 0 },
    isBanned: { type: Boolean, default: false },
    activityVersion: { type: Number, default: 0, select: false },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    mfa: {
      type: new Schema(
        {
          enabled: { type: Boolean, default: false },
          secretEncrypted: secret,
          backupCodeHashes: { type: [String], default: [], select: false },
          lastUsedStep: { type: Number, default: -1, select: false },
          pending: {
            type: new Schema(
              {
                id: { type: String, required: true },
                secretEncrypted: { ...secret, required: true },
                expiresAt: { type: Date, required: true },
              },
              { _id: false, strict: 'throw' }
            ),
            default: undefined,
          },
        },
        { _id: false, strict: 'throw' }
      ),
      default: () => ({}),
      select: false,
    },
    failedLoginCount: { type: Number, min: 0, default: 0, select: false },
    lockUntil: { type: Date, select: false },
    refreshTokenHashes: { type: [String], default: [], select: false },
  },
  options
);
userSchema.index({ verificationTokenHash: 1 }, { sparse: true });
userSchema.index({ resetTokenHash: 1 }, { sparse: true });
// Expiry cleanup unsets only pending enrollment, never expires the User document.
userSchema.index({ 'mfa.pending.expiresAt': 1 }, { sparse: true });
const location = new Schema(
  {
    buildingName: { type: String, trim: true, maxlength: 120 },
    campusArea: { type: String, required: true, trim: true, maxlength: 120 },
    coordinates: {
      type: [Number],
      default: undefined,
      validate: (v) =>
        v === undefined ||
        (v.length === 2 &&
          v.every(Number.isFinite) &&
          Math.abs(v[0]) <= 180 &&
          Math.abs(v[1]) <= 90),
    },
  },
  { _id: false, strict: 'throw' }
);
const itemSchema = new Schema(
  {
    category: { type: String, required: true, trim: true, maxlength: 60 },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    publicDescription: { type: String, required: true, trim: true, maxlength: 2000 },
    privateDetails: { ...secret, maxlength: 2000 },
    images: { type: [ref('Upload')], default: [], validate: (v) => v.length <= 4 },
    locationFound: location,
    lastSeen: location,
    dateFoundOrLost: { type: Date, required: true },
  },
  options
);
itemSchema.index({ title: 'text', publicDescription: 'text' });
itemSchema.index({ category: 1, dateFoundOrLost: -1 });
itemSchema.index({ 'locationFound.campusArea': 1 });
itemSchema.index({ 'lastSeen.campusArea': 1 });
const questionSchema = new Schema(
  {
    question: { type: String, required: true, trim: true, maxlength: 250 },
    answerHash: { ...secret, required: true },
    answerSalt: { ...secret, required: true },
  },
  { _id: true, strict: 'throw', toJSON: { transform: redact }, toObject: { transform: redact } }
);
const postSchema = new Schema(
  {
    type: { type: String, enum: ['found', 'lost'], required: true },
    item: ref('Item'),
    author: ref('User'),
    status: {
      type: String,
      enum: ['open', 'claim_pending', 'returned', 'closed'],
      default: 'open',
    },
    verificationQuestions: {
      type: [questionSchema],
      default: [],
      validate: {
        validator: function (v) {
          return this.type === 'found' ? v.length >= 2 && v.length <= 3 : v.length === 0;
        },
        message: 'Invalid verification question count',
      },
    },
    expiresAt: { type: Date, required: true },
    deletedAt: { type: Date, default: null },
    updatedAt: { type: Date, default: Date.now },
    revision: { type: Number, default: 0, min: 0 },
    approvedClaim: { type: Schema.Types.ObjectId, ref: 'Claim', default: null, select: false },
    approvedMatch: {
      type: Schema.Types.ObjectId,
      ref: 'MatchRequest',
      default: null,
      select: false,
    },
    chatVersion: { type: Number, default: 0, select: false },
  },
  options
);
postSchema.index({ item: 1 }, { unique: true });
postSchema.index({ type: 1, status: 1, createdAt: -1, _id: -1 });
postSchema.index({ author: 1, createdAt: -1 });
// Indexed expiry for a future coordinated cleanup job, deliberately not a destructive TTL.
postSchema.index({ expiresAt: 1 });
const claimSchema = new Schema(
  {
    post: ref('Post'),
    claimant: ref('User'),
    submittedAnswers: {
      type: [String],
      required: true,
      select: false,
      validate: (v) =>
        v.length >= 2 && v.length <= 3 && v.every((a) => a.trim().length > 0 && a.length <= 500),
    },
    verificationPassed: { type: Boolean, default: false, select: false },
    status: { type: String, enum: ['pending', 'approved', 'denied'], default: 'pending' },
    attemptCount: { type: Number, default: 1, min: 1, max: 3 },
    updatedAt: { type: Date, default: Date.now },
    decidedAt: Date,
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', default: null },
  },
  options
);
claimSchema.index({ post: 1, claimant: 1 }, { unique: true });
claimSchema.index({ claimant: 1, createdAt: -1 });
claimSchema.index({ post: 1, status: 1, createdAt: -1 });
const conversationSchema = new Schema(
  {
    post: ref('Post'),
    claim: { type: Schema.Types.ObjectId, ref: 'Claim' },
    matchRequest: { type: Schema.Types.ObjectId, ref: 'MatchRequest' },
    messageSequence: { type: Number, default: 0, min: 0 },
    updatedAt: { type: Date, default: Date.now },
    participants: {
      type: [ref('User')],
      required: true,
      validate: (v) => v.length === 2 && String(v[0]) !== String(v[1]),
    },
  },
  options
);
conversationSchema.index({ matchRequest: 1 }, { unique: true, sparse: true });
conversationSchema.index({ claim: 1 }, { unique: true, sparse: true });
conversationSchema.index({ post: 1, participants: 1 });
conversationSchema.index({ participants: 1, createdAt: -1 });
const messageSchema = new Schema(
  {
    conversation: ref('Conversation'),
    sender: ref('User'),
    body: { type: String, required: true, trim: true, minlength: 1, maxlength: 2000 },
    clientMessageId: String,
    sequence: { type: Number, min: 1 },
  },
  options
);
messageSchema.index(
  { conversation: 1, sender: 1, clientMessageId: 1 },
  { unique: true, partialFilterExpression: { clientMessageId: { $type: 'string' } } }
);
messageSchema.index({ conversation: 1, sequence: -1 });
messageSchema.index({ conversation: 1, createdAt: -1, _id: -1 });
messageSchema.index({ sender: 1 });
module.exports = Object.fromEntries(
  Object.entries({
    User: userSchema,
    Item: itemSchema,
    Post: postSchema,
    Claim: claimSchema,
    Conversation: conversationSchema,
    Message: messageSchema,
  }).map(([name, schema]) => [name, mongoose.models[name] || mongoose.model(name, schema)])
);
