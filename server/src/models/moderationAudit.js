const mongoose = require('mongoose');
// Deliberately no report text, email, answers, credentials or message bodies.
const schema = new mongoose.Schema(
  {
    actor: { type: mongoose.Schema.Types.ObjectId, required: true },
    target: { type: mongoose.Schema.Types.ObjectId, required: true },
    action: {
      type: String,
      enum: [
        'report_resolved',
        'report_dismissed',
        'post_removed',
        'user_banned',
        'user_unbanned',
        'user_unlocked',
        'user_sessions_revoked',
        'user_deleted',
        'verification_sent',
        'password_reset_sent',
      ],
      required: true,
    },
  },
  { strict: 'throw', timestamps: { createdAt: true, updatedAt: false } }
);
schema.index({ createdAt: -1 });
schema.index({ actor: 1 });
schema.index({ target: 1 });
module.exports = mongoose.models.ModerationAudit || mongoose.model('ModerationAudit', schema);
