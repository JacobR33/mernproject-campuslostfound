const mongoose = require('mongoose');
const schema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
    state: { type: String, enum: ['writing', 'staged', 'attached', 'deleting'], required: true },
    filename: { type: String, required: true },
    mime: { type: String, enum: ['image/jpeg'], default: 'image/jpeg' },
    size: { type: Number, min: 1 },
    width: { type: Number, min: 1 },
    height: { type: Number, min: 1 },
    expiresAt: { type: Date, required: true },
  },
  { strict: 'throw', timestamps: true }
);
schema.index({ owner: 1, state: 1, expiresAt: 1 });
schema.index({ post: 1, state: 1 });
schema.index({ state: 1, expiresAt: 1 });
// No TTL: the cleanup worker must remove GridFS chunks before removing this ledger entry.
module.exports = mongoose.models.Upload || mongoose.model('Upload', schema);
