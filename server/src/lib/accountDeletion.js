const { trusted } = require('mongoose');
const { User, Post, Claim, Conversation, Message } = require('../models');
const Upload = require('../models/upload');
const Report = require('../models/report');
const Audit = require('../models/moderationAudit');
const MatchRequest = require('../models/matchRequest');
const Notification = require('../models/notification');
const { AuthSession, MailOutbox } = require('../models/auth');
const { hash } = require('./authCrypto');

async function eraseAccountData(user, session, { preserveAudit = false } = {}) {
  const own = await Post.find({ author: user._id }).select('_id').session(session);
  const ownIds = own.map((post) => post._id);
  const inOwn = trusted({ $in: ownIds });
  // Tombstones immediately hide authored posts/images; the existing resumable worker
  // removes their items and GridFS data. No external storage I/O inside transactions.
  await Post.updateMany(
    { author: user._id },
    { $set: { deletedAt: new Date(), status: 'closed' }, $inc: { revision: 1 } },
    { session }
  );
  const claims = await Claim.find({ claimant: user._id }).select('_id').session(session);
  const matches = await MatchRequest.find({ requester: user._id }).select('_id').session(session);
  const claimIds = trusted({ $in: claims.map((row) => row._id) });
  const matchIds = trusted({ $in: matches.map((row) => row._id) });
  // A surviving owner's reserved post becomes open again; no consent reference survives.
  await Post.updateMany(
    {
      author: trusted({ $ne: user._id }),
      status: 'claim_pending',
      $or: [{ approvedClaim: claimIds }, { approvedMatch: matchIds }],
    },
    {
      $set: { status: 'open', approvedClaim: null, approvedMatch: null },
      $inc: { revision: 1 },
    },
    { session }
  );
  await Post.updateMany(
    {
      author: trusted({ $ne: user._id }),
      $or: [{ approvedClaim: claimIds }, { approvedMatch: matchIds }],
    },
    { $set: { approvedClaim: null, approvedMatch: null }, $inc: { revision: 1 } },
    { session }
  );
  const conversations = await Conversation.find({
    $or: [{ participants: user._id }, { post: inOwn }],
  })
    .select('_id')
    .session(session);
  const conversationIds = trusted({ $in: conversations.map((row) => row._id) });
  await Message.deleteMany(
    { $or: [{ conversation: conversationIds }, { sender: user._id }] },
    { session }
  );
  await Conversation.deleteMany({ _id: conversationIds }, { session });
  await Claim.deleteMany({ $or: [{ claimant: user._id }, { post: inOwn }] }, { session });
  await MatchRequest.deleteMany({ $or: [{ requester: user._id }, { post: inOwn }] }, { session });
  await Notification.deleteMany(
    { $or: [{ recipient: user._id }, { post: inOwn }, { claim: claimIds }] },
    { session }
  );
  await Report.deleteMany({ $or: [{ reporter: user._id }, { post: inOwn }] }, { session });
  if (!preserveAudit) {
    await Audit.deleteMany(
      { $or: [{ actor: user._id }, { target: user._id }, { target: inOwn }] },
      { session }
    );
  }
  await Upload.updateMany({ owner: user._id }, { $set: { state: 'deleting' } }, { session });
  await AuthSession.deleteMany({ user: user._id }, { session });
  await MailOutbox.deleteMany(
    { $or: [{ user: user._id }, { recipientHash: hash(user.email) }] },
    { session }
  );
  await User.deleteOne({ _id: user._id }, { session });
}

module.exports = { eraseAccountData };
