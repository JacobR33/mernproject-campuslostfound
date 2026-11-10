const mongoose = require('mongoose');
const { User, Post, Item } = require('../models');
const { AuthSession } = require('../models/auth');
const Report = require('../models/report');
const Audit = require('../models/moderationAudit');
const { withTransaction } = require('../lib/transaction');
const { lockActor } = require('../lib/lockActor');
const { httpError } = require('../lib/httpError');
const { trusted } = mongoose;
const live = () => ({ deletedAt: null, expiresAt: trusted({ $gt: new Date() }) });
const page = (query, total) => ({
  page: query.page,
  limit: query.limit,
  total,
  pages: Math.ceil(total / query.limit),
});
function moderationController(logger) {
  const audit = async (req, session, action, target) =>
    Audit.create([{ actor: req.user._id, target, action }], { session });
  const log = (req, action) =>
    logger('audit_admin', { requestId: req.id, actorId: String(req.user._id), outcome: action });
  return {
    async report(req, res) {
      await withTransaction(async (session) => {
        await lockActor(session, req.user, req.auth.version);
        const post = await Post.findOneAndUpdate(
          { _id: req.validated.params.postId, ...live() },
          { $inc: { chatVersion: 1 } },
          { new: true, session }
        );
        if (
          !post ||
          String(post.author) === String(req.user._id) ||
          !(await User.exists({ _id: post.author, isBanned: false }).session(session))
        ) {
          throw httpError(404, 'Not found');
        }
        // One report per account/post, including after resolution. Replays never overwrite evidence.
        await Report.updateOne(
          { post: post._id, reporter: req.user._id },
          { $setOnInsert: req.validated.body },
          { upsert: true, session, runValidators: true }
        );
      });
      logger('audit_report', { actorId: String(req.user._id), outcome: 'recorded' });
      res.status(202).json({ message: 'Report received. A moderator can review it.' });
    },
    async reports(req, res) {
      const query = req.validated.query;
      const filter = query.status ? { status: query.status } : {};
      const [result] = await Report.aggregate([
        { $match: filter },
        {
          $facet: {
            total: [{ $count: 'count' }],
            results: [
              { $sort: { createdAt: -1, _id: -1 } },
              { $skip: (query.page - 1) * query.limit },
              { $limit: query.limit },
              {
                $lookup: {
                  from: 'posts',
                  localField: 'post',
                  foreignField: '_id',
                  pipeline: [{ $project: { author: 1, item: 1, deletedAt: 1, expiresAt: 1 } }],
                  as: 'postRow',
                },
              },
              {
                $lookup: {
                  from: 'users',
                  localField: 'reporter',
                  foreignField: '_id',
                  pipeline: [{ $project: { displayName: 1 } }],
                  as: 'reporterRow',
                },
              },
              {
                $lookup: {
                  from: 'items',
                  localField: 'postRow.item',
                  foreignField: '_id',
                  pipeline: [{ $project: { title: 1 } }],
                  as: 'item',
                },
              },
            ],
          },
        },
      ]).option({ maxTimeMS: 5000 });
      res.json({
        reports: result.results.map((row) => ({
          id: String(row._id),
          postId: String(row.post),
          title: row.item[0]?.title || 'Removed post',
          authorId: row.postRow[0] ? String(row.postRow[0].author) : null,
          reporter: {
            id: String(row.reporter),
            displayName: row.reporterRow[0]?.displayName || 'Deleted account',
          },
          reason: row.reason,
          details: row.details,
          status: row.status,
          revision: row.revision,
          createdAt: row.createdAt,
        })),
        pagination: page(query, result.total[0]?.count || 0),
      });
    },
    async decide(req, res) {
      const { revision, status } = req.validated.body;
      await withTransaction(async (session) => {
        await lockActor(session, req.user, req.auth.version);
        const report = await Report.findOneAndUpdate(
          { _id: req.validated.params.reportId, status: 'open', revision },
          { $set: { status, decidedAt: new Date() }, $inc: { revision: 1 } },
          { session }
        );
        if (!report) {
          throw httpError(409, 'Resource changed');
        }
        await audit(req, session, `report_${status}`, report._id);
      });
      log(req, `report_${status}`);
      res.status(204).end();
    },
    async remove(req, res) {
      await withTransaction(async (session) => {
        await lockActor(session, req.user, req.auth.version);
        const post = await Post.findOneAndUpdate(
          { _id: req.validated.params.postId, ...live() },
          { $set: { deletedAt: new Date(), status: 'closed' }, $inc: { revision: 1 } },
          { new: true, session }
        );
        if (!post) {
          throw httpError(404, 'Not found');
        }
        await Report.updateMany(
          { post: post._id, status: 'open' },
          { $set: { status: 'resolved', decidedAt: new Date() }, $inc: { revision: 1 } },
          { session }
        );
        await audit(req, session, 'post_removed', post._id);
      });
      log(req, 'post_removed');
      res.status(204).end();
    },
    async ban(req, res) {
      await withTransaction(async (session) => {
        await lockActor(session, req.user, req.auth.version);
        // No admin-to-admin bans or self-bans; role provisioning is an operator task.
        const user = await User.findOneAndUpdate(
          { _id: req.validated.params.userId, role: 'user', isBanned: false },
          {
            $set: { isBanned: true, refreshTokenHashes: [] },
            $inc: { authVersion: 1 },
            $unset: {
              verificationTokenHash: 1,
              verificationTokenExpiry: 1,
              resetTokenHash: 1,
              resetTokenExpiry: 1,
            },
          },
          { new: true, session }
        );
        if (!user) {
          throw httpError(404, 'Not found');
        }
        await AuthSession.updateMany({ user: user._id }, { $set: { revoked: true } }, { session });
        await audit(req, session, 'user_banned', user._id);
      });
      log(req, 'user_banned');
      res.status(204).end();
    },
  };
}
module.exports = { moderationController };
