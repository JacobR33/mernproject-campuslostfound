const Notification = require('../models/notification');
const { Post, User } = require('../models');
const { trusted } = require('mongoose');
const { httpError } = require('../lib/httpError');
const { joinLivePost, pageDTO } = require('./claimController');
function notificationDTO(row) {
  return {
    id: String(row._id),
    kind: row.kind,
    postId: String(row.post._id),
    claimId: row.kind.startsWith('match_') ? null : String(row.claim),
    matchRequestId: row.kind.startsWith('match_') ? String(row.claim) : null,
    attemptCount: row.attemptCount,
    createdAt: row.createdAt,
    readAt: row.readAt || null,
  };
}
const notificationController = {
  async list(req, res) {
    const query = req.validated.query;
    const [page] = await Notification.aggregate([
      { $match: { recipient: req.user._id, ...(query.unread ? { readAt: null } : {}) } },
      { $project: { post: 1, claim: 1, kind: 1, attemptCount: 1, createdAt: 1, readAt: 1 } },
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
      notifications: page.results.map(notificationDTO),
      pagination: pageDTO(query, page.total[0]?.count || 0),
    });
  },
  async read(req, res) {
    const notification = await Notification.findOne({
      _id: req.validated.params.notificationId,
      recipient: req.user._id,
    });
    if (!notification) {
      throw httpError(404, 'Not found');
    }
    const post = await Post.findOne({
      _id: notification.post,
      deletedAt: null,
      expiresAt: trusted({ $gt: new Date() }),
    }).select('author');
    if (!post || !(await User.exists({ _id: post.author, isBanned: false }))) {
      throw httpError(404, 'Not found');
    }
    await Notification.updateOne(
      { _id: notification._id, recipient: req.user._id, readAt: null },
      { $set: { readAt: new Date() } }
    );
    res.status(204).end();
  },
};
module.exports = { notificationController };
