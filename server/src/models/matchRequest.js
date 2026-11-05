const mongoose = require('mongoose');
const { Schema } = mongoose;
const schema = new Schema(
  {
    post: { type: Schema.Types.ObjectId, ref: 'Post', required: true },
    requester: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['pending', 'accepted', 'denied'], default: 'pending' },
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', default: null },
    decidedAt: Date,
  },
  { strict: 'throw', timestamps: { createdAt: true, updatedAt: false } }
);
schema.index({ post: 1, requester: 1 }, { unique: true });
schema.index({ requester: 1, createdAt: -1 });
schema.index({ post: 1, status: 1, createdAt: -1 });
module.exports = mongoose.models.MatchRequest || mongoose.model('MatchRequest', schema);
