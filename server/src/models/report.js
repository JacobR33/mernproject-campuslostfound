const mongoose = require('mongoose');
const schema = new mongoose.Schema(
  {
    post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true },
    reporter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, enum: ['privacy', 'unsafe', 'spam', 'other'], required: true },
    details: { type: String, required: true, maxlength: 1000 },
    status: { type: String, enum: ['open', 'resolved', 'dismissed'], default: 'open' },
    revision: { type: Number, default: 0 },
    decidedAt: Date,
  },
  { strict: 'throw', timestamps: { createdAt: true, updatedAt: false } }
);
schema.index({ post: 1, reporter: 1 }, { unique: true });
schema.index({ status: 1, createdAt: -1, _id: -1 });
schema.index({ reporter: 1 });
module.exports = mongoose.models.Report || mongoose.model('Report', schema);
