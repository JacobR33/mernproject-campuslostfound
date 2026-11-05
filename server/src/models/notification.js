const mongoose = require('mongoose');
const { Schema } = mongoose;
const schema = new Schema(
  {
    recipient: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    post: { type: Schema.Types.ObjectId, ref: 'Post', required: true },
    claim: { type: Schema.Types.ObjectId, ref: 'Claim', required: true },
    kind: {
      type: String,
      enum: ['claim_submitted', 'claim_approved', 'claim_denied'],
      required: true,
    },
    attemptCount: { type: Number, required: true, min: 1, max: 3 },
    readAt: { type: Date, default: null },
  },
  { strict: 'throw', timestamps: { createdAt: true, updatedAt: false } }
);
schema.index({ recipient: 1, createdAt: -1, _id: -1 });
schema.index({ post: 1 });
schema.index({ recipient: 1, claim: 1, kind: 1, attemptCount: 1 }, { unique: true });
module.exports = mongoose.models.Notification || mongoose.model('Notification', schema);
