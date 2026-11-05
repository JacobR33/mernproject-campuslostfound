const { lockActor } = require('../lib/lockActor');
const mongoose = require('mongoose');
const { Post, Item, User, Claim, Conversation } = require('../models');
const Notification = require('../models/notification');
const MatchRequest = require('../models/matchRequest');
const { verifyAnswers } = require('../lib/verificationAnswers');
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
    post.type === 'found' && ['open', 'claim_pending'].includes(post.status) && !post.approvedClaim,
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
function finderDTO(claim, post) {
  return {
    ...claimDTO(claim, post),
    claimant: { id: String(claim.claimant._id), displayName: claim.claimant.displayName },
    verificationPassed: claim.verificationPassed === true,
    submittedAnswers: post.verificationQuestions.map((question, index) => ({
      questionId: String(question._id),
      question: question.question,
      answer: claim.submittedAnswers[index],
    })),
  };
}
async function readablePost(id, owner) {
  const post = await Post.findOne({
    _id: id,
    type: 'found',
    ...(owner ? { author: owner } : {}),
    ...live(),
  })
    .select('type status item author expiresAt verificationQuestions +approvedClaim')
    .populate({ path: 'item', select: 'title' })
    .populate({ path: 'author', match: { isBanned: false }, select: 'displayName' });
  if (!post || !post.item || !post.author) {
    throw httpError(404, 'Not found');
  }
  return post;
}
async function notify(recipient, post, claim, kind, session) {
  await Notification.create(
    [{ recipient, post: post._id, claim: claim._id, kind, attemptCount: claim.attemptCount }],
    { session }
  );
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
    async submit(req, res) {
      let result;
      await transact(req, 'audit_claim_submit', async (session) => {
        // Updating the common post row serializes submissions, decisions, edits, deletion and cleanup.
        const post = await Post.findOneAndUpdate(
          {
            _id: req.validated.params.postId,
            type: 'found',
            author: trusted({ $ne: req.user._id }),
            status: trusted({ $in: ['open', 'claim_pending'] }),
            approvedClaim: null,
            ...live(),
          },
          { $set: { status: 'claim_pending', updatedAt: new Date() }, $inc: { revision: 1 } },
          { new: true, session }
        ).select(
          '+verificationQuestions.answerHash +verificationQuestions.answerSalt +approvedClaim'
        );
        if (
          !post ||
          !(await User.exists({ _id: post.author, isBanned: false, emailVerified: true }).session(
            session
          ))
        ) {
          throw httpError(404, 'Not found');
        }
        const supplied = new Map(
          req.validated.body.answers.map((value) => [value.questionId, value.answer])
        );
        if (
          supplied.size !== post.verificationQuestions.length ||
          post.verificationQuestions.some((question) => !supplied.has(String(question._id)))
        ) {
          throw httpError(400, 'Invalid request');
        }
        const existing = await Claim.findOne({ post: post._id, claimant: req.user._id }).session(
          session
        );
        if (existing && existing.attemptCount >= 3) {
          throw httpError(429, 'Too many requests');
        }
        if (existing?.status === 'approved') {
          throw httpError(409, 'Resource changed');
        }
        const submittedAnswers = post.verificationQuestions.map((question) =>
          supplied.get(String(question._id))
        );
        const verificationPassed = await verifyAnswers(
          post.verificationQuestions,
          submittedAnswers
        );
        let claim;
        if (existing) {
          claim = await Claim.findOneAndUpdate(
            {
              _id: existing._id,
              post: post._id,
              claimant: req.user._id,
              attemptCount: existing.attemptCount,
              status: trusted({ $in: ['pending', 'denied'] }),
            },
            {
              $set: {
                submittedAnswers,
                verificationPassed,
                status: 'pending',
                updatedAt: new Date(),
                conversation: null,
              },
              $unset: { decidedAt: 1 },
              $inc: { attemptCount: 1 },
            },
            { new: true, runValidators: true, session }
          );
          if (!claim) {
            throw httpError(409, 'Resource changed');
          }
        } else {
          [claim] = await Claim.create(
            [{ post: post._id, claimant: req.user._id, submittedAnswers, verificationPassed }],
            { session }
          );
        }
        const item = await Item.findById(post.item).select('title').session(session);
        if (!item) {
          throw httpError(404, 'Not found');
        }
        await notify(post.author, post, claim, 'claim_submitted', session);
        result = claimDTO(claim, { ...post.toObject(), item });
      });
      logger('audit_claim_submit', {
        actorId: String(req.user._id),
        requestId: req.id,
        postId: result.post.id,
        claimId: result.id,
        attemptCount: result.attemptCount,
        outcome: 'pending',
      });
      // Matching and mismatching answers have identical response shapes/status. Only finder review sees the result.
      res.status(202).json({ claim: result });
    },
    async mine(req, res) {
      const query = req.validated.query;
      const filter = { claimant: req.user._id, ...(query.status ? { status: query.status } : {}) };
      const [page] = await Claim.aggregate([
        { $match: filter },
        {
          $project: {
            post: 1,
            status: 1,
            attemptCount: 1,
            createdAt: 1,
            updatedAt: 1,
            decidedAt: 1,
            conversation: 1,
          },
        },
        ...joinLivePost(),
        {
          $facet: {
            total: [{ $count: 'count' }],
            results: [
              { $sort: { createdAt: -1, _id: -1 } },
              { $skip: (query.page - 1) * query.limit },
              { $limit: query.limit },
            ],
          },
        },
      ]).option({ maxTimeMS: 5000, allowDiskUse: false });
      res.json({
        claims: page.results.map((row) => claimDTO(row, row.post)),
        pagination: pageDTO(query, page.total[0]?.count || 0),
      });
    },
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
    async ownForPost(req, res) {
      const post = await readablePost(req.validated.params.postId);
      const claim = await Claim.findOne({ post: post._id, claimant: req.user._id }).maxTimeMS(5000);
      res.json({ claim: claim ? claimDTO(claim, post) : null });
    },
    async review(req, res, single = false) {
      const post = await readablePost(req.validated.params.postId, req.user._id);
      const filter = {
        post: post._id,
        ...(single ? { _id: req.validated.params.claimId } : {}),
        ...(req.validated.query.status ? { status: req.validated.query.status } : {}),
      };
      if (single) {
        const claim = await Claim.findOne(filter)
          .select('+submittedAnswers +verificationPassed')
          .populate({ path: 'claimant', select: 'displayName' })
          .maxTimeMS(5000);
        if (!claim || !claim.claimant) {
          throw httpError(404, 'Not found');
        }
        return res.json({ claim: finderDTO(claim, post) });
      }
      const query = req.validated.query;
      const claims = await Claim.find(filter)
        .select('+submittedAnswers +verificationPassed')
        .populate({ path: 'claimant', select: 'displayName' })
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .maxTimeMS(5000);
      const total = await Claim.countDocuments(filter).maxTimeMS(5000);
      res.json({
        claims: claims.filter((claim) => claim.claimant).map((claim) => finderDTO(claim, post)),
        pagination: pageDTO(query, total),
      });
    },
    async decide(req, res) {
      let result;
      const decision = req.validated.body.decision;
      await transact(req, `audit_claim_${decision}`, async (session) => {
        const post = await Post.findOneAndUpdate(
          {
            _id: req.validated.params.postId,
            author: req.user._id,
            type: 'found',
            status: trusted({ $in: ['open', 'claim_pending'] }),
            ...live(),
          },
          { $inc: { revision: 1 }, $set: { updatedAt: new Date() } },
          { new: true, session }
        ).select('+approvedClaim');
        if (!post) {
          throw httpError(404, 'Not found');
        }
        const claim = await Claim.findOne({ _id: req.validated.params.claimId, post: post._id })
          .select('+verificationPassed')
          .session(session);
        if (!claim) {
          throw httpError(404, 'Not found');
        }
        if (claim.status !== 'pending' || claim.attemptCount !== req.validated.body.attemptCount) {
          throw httpError(409, 'Resource changed');
        }
        let conversation = null;
        if (decision === 'approve') {
          if (post.approvedClaim || claim.verificationPassed !== true) {
            throw httpError(409, 'Resource changed');
          }
          if (
            !(await User.exists({
              _id: claim.claimant,
              isBanned: false,
              emailVerified: true,
            }).session(session))
          ) {
            throw httpError(409, 'Resource changed');
          }
          [conversation] = await Conversation.create(
            [{ post: post._id, claim: claim._id, participants: [req.user._id, claim.claimant] }],
            { session }
          );
          post.approvedClaim = claim._id;
        }
        const status = decision === 'approve' ? 'approved' : 'denied';
        const updated = await Claim.findOneAndUpdate(
          {
            _id: claim._id,
            post: post._id,
            status: 'pending',
            attemptCount: req.validated.body.attemptCount,
          },
          {
            $set: {
              status,
              conversation: conversation?._id || null,
              decidedAt: new Date(),
              updatedAt: new Date(),
            },
          },
          { new: true, runValidators: true, session }
        );
        if (!updated) {
          throw httpError(409, 'Resource changed');
        }
        if (decision === 'approve') {
          // Resolve competing pending claims without a transaction-sized per-user notification fanout.
          await Claim.updateMany(
            { post: post._id, _id: trusted({ $ne: claim._id }), status: 'pending' },
            { $set: { status: 'denied', decidedAt: new Date(), updatedAt: new Date() } },
            { session }
          );
        }
        const pending = await Claim.exists({ post: post._id, status: 'pending' }).session(session);
        const postStatus = post.approvedClaim || pending ? 'claim_pending' : 'open';
        const saved = await Post.updateOne(
          { _id: post._id, author: req.user._id, ...live() },
          {
            $set: { approvedClaim: post.approvedClaim, status: postStatus, updatedAt: new Date() },
          },
          { session }
        );
        if (saved.matchedCount !== 1) {
          throw httpError(409, 'Resource changed');
        }
        await notify(
          claim.claimant,
          post,
          updated,
          decision === 'approve' ? 'claim_approved' : 'claim_denied',
          session
        );
        const item = await Item.findById(post.item).select('title').session(session);
        if (!item) {
          throw httpError(404, 'Not found');
        }
        result = {
          claim: claimDTO(updated, {
            ...post.toObject(),
            approvedClaim: post.approvedClaim,
            status: postStatus,
            item,
          }),
          postRevision: post.revision,
        };
      });
      logger(`audit_claim_${decision}`, {
        actorId: String(req.user._id),
        requestId: req.id,
        postId: result.claim.post.id,
        claimId: result.claim.id,
        attemptCount: result.claim.attemptCount,
        outcome: decision === 'approve' ? 'approved' : 'denied',
      });
      res.json(result);
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
        if (post.revision !== req.validated.body.revision || post.status !== 'claim_pending') {
          throw httpError(409, 'Resource changed');
        }
        const claim =
          post.type === 'found' && post.approvedClaim
            ? await Claim.findOne({
                _id: post.approvedClaim,
                post: post._id,
                status: 'approved',
              }).session(session)
            : null;
        const match =
          post.type === 'lost' && post.approvedMatch
            ? await MatchRequest.findOne({
                _id: post.approvedMatch,
                post: post._id,
                status: 'accepted',
              }).session(session)
            : null;
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
