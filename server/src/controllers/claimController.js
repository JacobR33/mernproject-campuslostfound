const { lockActor } = require('../lib/lockActor');
const mongoose = require('mongoose');
const { Post, Item, User, Claim, Conversation } = require('../models');
const Notification = require('../models/notification');
const MatchRequest = require('../models/matchRequest');
const { withTransaction } = require('../lib/transaction');
const { httpError } = require('../lib/httpError');
const { trusted } = mongoose;
const live = () => ({ deletedAt: null, expiresAt: trusted({ $gt: new Date() }) });
const liveAggregate = () => ({ deletedAt: null, expiresAt: { $gt: new Date() } });
const postSummary = (post) => ({
  id: String(post._id),
  type: post.type,
  status: post.status,
  title: post.item.title,
  acceptingClaims:
    post.type === 'found' && ['open', 'claim_pending'].includes(post.status),
});
function claimDTO(claim, post) {
  return {
    id: String(claim._id),
    post: postSummary(post),
    status: claim.status,
    attemptCount: claim.attemptCount,
    createdAt: claim.createdAt,
    updatedAt: claim.updatedAt,
    decidedAt: claim.decidedAt || null,
    conversationId:
      claim.status === 'approved' && claim.conversation ? String(claim.conversation) : null,
  };
}
async function readablePost(id, owner) {
  const post = await Post.findOne({
    _id: id,
    type: 'found',
    ...(owner ? { author: owner } : {}),
    ...live(),
  })
    .select('type status item author expiresAt +approvedClaim')
    .populate({ path: 'item', select: 'title' })
    .populate({ path: 'author', match: { isBanned: false }, select: 'displayName' });
  if (!post || !post.item || !post.author) {
    throw httpError(404, 'Not found');
  }
  return post;
}
const pageDTO = (query, total) => ({
  page: query.page,
  limit: query.limit,
  total,
  pages: Math.ceil(total / query.limit),
});
const summaryProjection = { _id: 1, type: 1, status: 1, item: 1, author: 1, approvedClaim: 1 };
const joinLivePost = () => [
  {
    $lookup: {
      from: 'posts',
      localField: 'post',
      foreignField: '_id',
      pipeline: [{ $match: liveAggregate() }, { $project: summaryProjection }],
      as: 'post',
    },
  },
  { $unwind: '$post' },
  {
    $lookup: {
      from: 'users',
      localField: 'post.author',
      foreignField: '_id',
      pipeline: [{ $match: { isBanned: false } }, { $project: { _id: 1 } }],
      as: 'author',
    },
  },
  { $unwind: '$author' },
  {
    $lookup: {
      from: 'items',
      localField: 'post.item',
      foreignField: '_id',
      pipeline: [{ $project: { title: 1 } }],
      as: 'item',
    },
  },
  { $unwind: '$item' },
  { $set: { 'post.item': '$item' } },
];
function createClaimController(logger) {
  const transact = (req, event, work) =>
    withTransaction(async (session) => {
      await lockActor(session, req.user, req.auth.version);
      return work(session);
    }).catch((error) => {
      logger(event, {
        actorId: String(req.user._id),
        requestId: req.id,
        postId: req.validated.params.postId,
        claimId: req.validated.params.claimId,
        outcome: 'rejected',
      });
      throw error;
    });
  return {
    async detail(req, res) {
      const claim = await Claim.findOne({
        _id: req.validated.params.claimId,
        claimant: req.user._id,
      }).maxTimeMS(5000);
      if (!claim) {
        throw httpError(404, 'Not found');
      }
      const post = await readablePost(claim.post);
      res.json({ claim: claimDTO(claim, post) });
    },
    async returned(req, res) {
      await transact(req, 'audit_post_return', async (session) => {
        const post = await Post.findOne({
          _id: req.validated.params.postId,
          author: req.user._id,
          ...live(),
        })
          .select('+approvedClaim +approvedMatch')
          .session(session);
        if (!post) {
          throw httpError(404, 'Not found');
        }
        if (
          post.revision !== req.validated.body.revision ||
          !['open', 'claim_pending'].includes(post.status)
        ) {
          throw httpError(409, 'Resource changed');
        }
        const claim =
          post.type === 'found'
            ? await Claim.findOne({
                post: post._id,
                status: 'approved',
              }).session(session)
            : null;
        const match = await MatchRequest.findOne({ post: post._id, status: 'accepted' }).session(session);
        const conversation = claim
          ? await Conversation.exists({
              _id: claim.conversation,
              post: post._id,
              claim: claim._id,
            }).session(session)
          : match
            ? await Conversation.exists({
                _id: match.conversation,
                post: post._id,
                matchRequest: match._id,
              }).session(session)
            : null;
        if (!conversation) {
          throw httpError(409, 'Resource changed');
        }
        const saved = await Post.updateOne(
          { _id: post._id, author: req.user._id, revision: post.revision, ...live() },
          { $set: { status: 'returned', updatedAt: new Date() }, $inc: { revision: 1 } },
          { session }
        );
        if (saved.matchedCount !== 1) {
          throw httpError(409, 'Resource changed');
        }
      });
      logger('audit_post_return', {
        actorId: String(req.user._id),
        requestId: req.id,
        postId: req.validated.params.postId,
        outcome: 'returned',
      });
      res.status(204).end();
    },
  };
}
module.exports = { createClaimController, joinLivePost, pageDTO };
