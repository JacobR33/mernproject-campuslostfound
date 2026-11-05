const mongoose = require('mongoose');
const { User, Post, Item, Claim, Conversation, Message } = require('../models');
const Upload = require('../models/upload');
const Notification = require('../models/notification');
const MatchRequest = require('../models/matchRequest');
const Report = require('../models/report');
const { withTransaction } = require('../lib/transaction');
const { trusted } = mongoose;
const expiredOrDeleted = (now) => ({
  $or: [{ deletedAt: trusted({ $ne: null }) }, { expiresAt: trusted({ $lte: now }) }],
});

async function purgePost(id, now) {
  await withTransaction(async (session) => {
    const post = await Post.findOneAndUpdate(
      { _id: id, ...expiredOrDeleted(now) },
      { $set: { status: 'closed', deletedAt: now } },
      { new: true, session }
    );
    if (!post) {
      return;
    }
    const conversations = await Conversation.find({ post: post._id })
      .select('_id')
      .session(session);
    await Message.deleteMany(
      { conversation: trusted({ $in: conversations.map((row) => row._id) }) },
      { session }
    );
    await Conversation.deleteMany({ post: post._id }, { session });
    await Claim.deleteMany({ post: post._id }, { session });
    await MatchRequest.deleteMany({ post: post._id }, { session });
    await Report.deleteMany({ post: post._id }, { session });
    await Notification.deleteMany({ post: post._id }, { session });
    await Upload.updateMany({ post: post._id }, { $set: { state: 'deleting' } }, { session });
    await Item.deleteOne({ _id: post.item }, { session });
    await Post.deleteOne({ _id: post._id }, { session });
  });
}
async function runPostCleanup({ storage, logger }, now = new Date(), batchSize = 50) {
  await User.updateMany(
    { 'mfa.enabled': false, 'mfa.pending.expiresAt': trusted({ $lte: now }) },
    { $unset: { 'mfa.pending': 1 } }
  );
  const posts = await Post.find(expiredOrDeleted(now)).select('_id').limit(batchSize);
  for (const post of posts) await purgePost(post._id, now);
  await Upload.updateMany(
    { state: trusted({ $in: ['writing', 'staged'] }), expiresAt: trusted({ $lte: now }) },
    { $set: { state: 'deleting' } }
  );
  const files = await Upload.find({ state: 'deleting' }).select('_id').limit(batchSize);
  for (const file of files) {
    try {
      await storage.remove(file._id);
      await Upload.deleteOne({ _id: file._id, state: 'deleting' });
    } catch {
      logger('upload_cleanup_deferred', { code: 'storage' });
    }
  }
  if (storage.sweepOrphans) {
    await storage.sweepOrphans(new Date(now - 24 * 60 * 60 * 1000), batchSize);
  }
  return { posts: posts.length, uploads: files.length };
}
function startPostCleanup(config, dependencies) {
  let stopping = false;
  let running = false;
  let pending = Promise.resolve();
  const tick = () => {
    if (stopping || running) {
      return;
    }
    running = true;
    pending = runPostCleanup(dependencies)
      .catch(() => dependencies.logger('post_cleanup_failed'))
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(tick, config.CLEANUP_INTERVAL_SECONDS * 1000).unref();
  tick();
  return async () => {
    stopping = true;
    clearInterval(timer);
    await pending;
  };
}
module.exports = { runPostCleanup, purgePost, startPostCleanup };
