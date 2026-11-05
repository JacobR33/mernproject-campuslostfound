const { Conversation, Message } = require('../models');
const { trusted } = require('mongoose');
const {
  accessPipeline,
  accessConversation,
  conversationDTO,
  messageDTO,
} = require('../services/conversations');
const { pageDTO } = require('./claimController');
const chatController = {
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
