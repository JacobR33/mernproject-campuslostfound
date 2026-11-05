const { lockActor } = require('../lib/lockActor');
const mongoose = require('mongoose');
const { Post, Item, User, Conversation } = require('../models');
const MatchRequest = require('../models/matchRequest');
const { withTransaction } = require('../lib/transaction');
const { httpError } = require('../lib/httpError');
const { pageDTO } = require('./claimController');
const { trusted } = mongoose;
const live = () => ({ deletedAt: null, expiresAt: trusted({ $gt: new Date() }) });
function matchDTO(row, post, requester) {
  return {
    id: String(row._id),
    post: { id: String(post._id), title: post.item.title, status: post.status },
    requester: { id: String(requester._id), displayName: requester.displayName },
    status: row.status,
    createdAt: row.createdAt,
    conversationId: row.status === 'accepted' && row.conversation ? String(row.conversation) : null,
  };
}
function createMatchController(logger) {
  return {
    async request(req, res) {
      let result;
      let created = false;
      await withTransaction(async (session) => {
        await lockActor(session, req.user, req.auth.version);
        created = false;
        const post = await Post.findOneAndUpdate(
          {
            _id: req.validated.params.postId,
            type: 'lost',
            author: trusted({ $ne: req.user._id }),
            status: 'open',
            approvedMatch: null,
            ...live(),
          },
          { $inc: { chatVersion: 1 } },
          { new: true, session }
        );
        if (
          !post ||
          !(await User.exists({ _id: post.author, emailVerified: true, isBanned: false }).session(
            session
          ))
        ) {
          throw httpError(404, 'Not found');
        }
        let row = await MatchRequest.findOne({ post: post._id, requester: req.user._id }).session(
          session
        );
        if (row?.status === 'denied') {
          throw httpError(409, 'Request already resolved');
        }
        if (!row) {
          [row] = await MatchRequest.create([{ post: post._id, requester: req.user._id }], {
            session,
          });
          created = true;
        }
        const item = await Item.findById(post.item).select('title').session(session);
        if (!item) {
          throw httpError(404, 'Not found');
        }
        result = matchDTO(row, { ...post.toObject(), item }, req.user);
      });
      logger('audit_match_request', {
        actorId: String(req.user._id),
        postId: req.validated.params.postId,
        outcome: 'pending',
        requestId: req.id,
      });
      res.status(created ? 201 : 200).json({ request: result });
    },
    async list(req, res, incoming) {
      const query = req.validated.query;
      const [page] = await MatchRequest.aggregate([
        { $match: incoming ? {} : { requester: req.user._id } },
        {
          $lookup: {
            from: 'posts',
            localField: 'post',
            foreignField: '_id',
            pipeline: [
              {
                $match: {
                  type: 'lost',
                  deletedAt: null,
                  expiresAt: { $gt: new Date() },
                  ...(incoming ? { author: req.user._id } : {}),
                },
              },
              { $project: { status: 1, item: 1, author: 1 } },
            ],
            as: 'post',
          },
        },
        { $unwind: '$post' },
        {
          $lookup: {
            from: 'users',
            localField: 'requester',
            foreignField: '_id',
            pipeline: [
              { $match: { emailVerified: true, isBanned: false } },
              { $project: { displayName: 1 } },
            ],
            as: 'requester',
          },
        },
        { $unwind: '$requester' },
        {
          $lookup: {
            from: 'users',
            localField: 'post.author',
            foreignField: '_id',
            pipeline: [
              { $match: { emailVerified: true, isBanned: false } },
              { $project: { _id: 1 } },
            ],
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
        requests: page.results.map((row) => matchDTO(row, row.post, row.requester)),
        pagination: pageDTO(query, page.total[0]?.count || 0),
      });
    },
    async decide(req, res) {
      let result;
      await withTransaction(async (session) => {
        await lockActor(session, req.user, req.auth.version);
        const post = await Post.findOneAndUpdate(
          {
            _id: req.validated.params.postId,
            type: 'lost',
            author: req.user._id,
            status: 'open',
            approvedMatch: null,
            ...live(),
          },
          { $inc: { revision: 1 }, $set: { updatedAt: new Date() } },
          { new: true, session }
        );
        if (!post) {
          throw httpError(404, 'Not found');
        }
        const row = await MatchRequest.findOne({
          _id: req.validated.params.requestId,
          post: post._id,
        }).session(session);
        if (!row) {
          throw httpError(404, 'Not found');
        }
        if (row.status !== 'pending') {
          throw httpError(409, 'Request already resolved');
        }
        const requester = await User.findOne({
          _id: row.requester,
          emailVerified: true,
          isBanned: false,
        }).session(session);
        if (!requester) {
          throw httpError(409, 'Request unavailable');
        }
        let conversation;
        if (req.validated.body.decision === 'accept') {
          [conversation] = await Conversation.create(
            [
              {
                post: post._id,
                matchRequest: row._id,
                participants: [row.requester, req.user._id],
              },
            ],
            { session }
          );
          const saved = await Post.updateOne(
            { _id: post._id, author: req.user._id, ...live() },
            { $set: { status: 'claim_pending', approvedMatch: row._id } },
            { session }
          );
          if (!saved.matchedCount) {
            throw httpError(409, 'Resource changed');
          }
          await MatchRequest.updateMany(
            { post: post._id, _id: trusted({ $ne: row._id }), status: 'pending' },
            { $set: { status: 'denied', decidedAt: new Date() } },
            { session }
          );
        }
        const updated = await MatchRequest.findOneAndUpdate(
          { _id: row._id, post: post._id, status: 'pending' },
          {
            $set: {
              status: conversation ? 'accepted' : 'denied',
              conversation: conversation?._id || null,
              decidedAt: new Date(),
            },
          },
          { new: true, session }
        );
        if (!updated) {
          throw httpError(409, 'Resource changed');
        }
        const item = await Item.findById(post.item).select('title').session(session);
        if (!item) {
          throw httpError(404, 'Not found');
        }
        result = matchDTO(
          updated,
          { ...post.toObject(), status: conversation ? 'claim_pending' : post.status, item },
          requester
        );
      });
      logger('audit_match_decision', {
        actorId: String(req.user._id),
        postId: req.validated.params.postId,
        outcome: result.status,
        requestId: req.id,
      });
      res.json({ request: result });
    },
  };
}
module.exports = { createMatchController };
