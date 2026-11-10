const { lockActor } = require('../lib/lockActor');
const { withTransaction } = require('../lib/transaction');
const { httpError } = require('../lib/httpError');
const { Conversation, Message, Post } = require('../models');
const { trusted } = require('mongoose');
const {
  accessPipeline,
  accessConversation,
  conversationDTO,
  messageDTO,
} = require('../services/conversations');
const { pageDTO } = require('./claimController');
const chatController = {
  async close(req, res) {
    await withTransaction(async (session) => {
      await lockActor(session, req.user, req.auth.version);
      const access = await accessConversation(req.user._id, req.validated.params.conversationId, session);
      const post = await Post.updateOne(
        { _id: access.post._id, deletedAt: null, expiresAt: trusted({ $gt: new Date() }) },
        { $inc: { chatVersion: 1 } },
        { session }
      );
      if (!post.matchedCount) throw httpError(404, 'Not found');
      const closed = await Conversation.updateOne(
        { _id: access._id, participants: req.user._id, closedAt: null },
        { $set: { closedAt: new Date() } },
        { session }
      );
      if (!closed.matchedCount) throw httpError(409, 'Conversation already closed');
    });
    res.status(204).end();
  },
  async list(req, res) {
    const query = req.validated.query;
    const [page] = await Conversation.aggregate([
      ...accessPipeline(req.user._id),
      {
        $facet: {
          total: [{ $count: 'count' }],
          results: [
            { $sort: { updatedAt: -1, _id: -1 } },
            { $skip: (query.page - 1) * query.limit },
            { $limit: query.limit },
          ],
        },
      },
    ]).option({ maxTimeMS: 5000, allowDiskUse: false });
    res.json({
      conversations: page.results.map(conversationDTO),
      pagination: pageDTO(query, page.total[0]?.count || 0),
    });
  },
  async detail(req, res) {
    res.json({
      conversation: conversationDTO(
        await accessConversation(req.user._id, req.validated.params.conversationId)
      ),
    });
  },
  async history(req, res) {
    const query = req.validated.query;
    const access = await accessConversation(req.user._id, req.validated.params.conversationId);
    const rows = await Message.find({
      conversation: access._id,
      sender: trusted({ $in: access.participants }),
      sequence: trusted({ $gte: 1, ...(query.before ? { $lt: query.before } : {}) }),
    })
      .sort({ sequence: -1 })
      .limit(query.limit + 1)
      .maxTimeMS(5000);
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit).reverse();
    res.json({
      messages: page.map((row) => messageDTO(row, access)),
      nextBefore: hasMore ? page[0].sequence : null,
    });
  },
};
module.exports = { chatController };
