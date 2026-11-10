const { lockActor } = require('../lib/lockActor');
const mongoose = require('mongoose');
const { Post, Item } = require('../models');
const Upload = require('../models/upload');
const { httpError } = require('../lib/httpError');
const { withTransaction } = require('../lib/transaction');
const { trusted } = mongoose;
const activePost = () => ({ deletedAt: null, expiresAt: trusted({ $gt: new Date() }) });

function itemFields(value, type) {
  const result = {};
  for (const key of [
    'category',
    'title',
    'publicDescription',
    'privateDetails',
    'images',
    'dateFoundOrLost',
  ])
    if (value[key] !== undefined) {
      result[key] = value[key];
    }
  if (value.location !== undefined) {
    result[type === 'found' ? 'locationFound' : 'lastSeen'] = value.location;
  }
  return result;
}
function postDTO(post, item, author, owner = false) {
  const location = item[post.type === 'found' ? 'locationFound' : 'lastSeen'];
  const itemDTO = {
    id: String(item._id),
    category: item.category,
    title: item.title,
    publicDescription: item.publicDescription,
    images: item.images.map((id) => ({ id: String(id), url: `/api/uploads/${id}` })),
    dateFoundOrLost: item.dateFoundOrLost,
    [post.type === 'found' ? 'locationFound' : 'lastSeen']: location
      ? {
          campusArea: location.campusArea,
          ...(location.buildingName ? { buildingName: location.buildingName } : {}),
          ...(location.coordinates ? { coordinates: location.coordinates } : {}),
        }
      : undefined,
  };
  if (owner) {
    itemDTO.privateDetails = item.privateDetails || '';
  }
  return {
    id: String(post._id),
    type: post.type,
    status: post.status,
    revision: post.revision,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    expiresAt: post.expiresAt,
    acceptingMatches:
      typeof post.acceptingMatches === 'boolean'
        ? post.acceptingMatches
        : ['open', 'claim_pending'].includes(post.status),
    author: { id: String(author._id), displayName: author.displayName },
    item: itemDTO,
  };
}
async function attachImages(ids, post, owner, session) {
  for (const id of ids) {
    const upload = await Upload.findOneAndUpdate(
      {
        _id: id,
        owner,
        $or: [
          { state: 'staged', expiresAt: trusted({ $gt: new Date() }) },
          { state: 'attached', post: post._id },
        ],
      },
      { $set: { state: 'attached', post: post._id, expiresAt: post.expiresAt } },
      { new: true, session }
    );
    if (!upload) {
      throw httpError(400, 'Invalid image reference');
    }
  }
  await Upload.updateMany(
    { post: post._id, owner, state: 'attached', _id: trusted({ $nin: ids }) },
    { $set: { state: 'deleting' } },
    { session }
  );
}

const postProjection = {
  _id: 1,
  type: 1,
  status: 1,
  author: 1,
  createdAt: 1,
  updatedAt: 1,
  expiresAt: 1,
  revision: 1,
  acceptingMatches: {
    $and: [
      { $in: ['$status', ['open', 'claim_pending']] },
    ],
  },
};
function itemProjection(owner) {
  return {
    _id: 1,
    category: 1,
    title: 1,
    publicDescription: 1,
    images: 1,
    dateFoundOrLost: 1,
    locationFound: 1,
    lastSeen: 1,
    ...(owner ? { privateDetails: 1 } : {}),
  };
}
const joinAuthor = [
  {
    $lookup: {
      from: 'users',
      localField: 'post.author',
      foreignField: '_id',
      pipeline: [{ $match: { isBanned: false } }, { $project: { displayName: 1 } }],
      as: 'author',
    },
  },
  { $unwind: '$author' },
];

function createPostController(config, logger) {
  return {
    async create(req, res) {
      const value = req.validated.body;
      let result;
      await withTransaction(async (session) => {
        await lockActor(session, req.user, req.auth.version);
        const [item] = await Item.create([itemFields(value, value.type)], { session });
        const [post] = await Post.create(
          [
            {
              type: value.type,
              item: item._id,
              author: req.user._id,
              verificationQuestions: [],
              expiresAt: new Date(Date.now() + config.POST_RETENTION_DAYS * 86400000),
            },
          ],
          { session }
        );
        await attachImages(value.images, post, req.user._id, session);
        result = postDTO(post, item, req.user, true);
      });
      logger('audit_post_create', { actorId: String(req.user._id), outcome: 'created' });
      res.status(201).json({ post: result });
    },
    async list(req, res, owner = false) {
      const query = req.validated.query;
      const itemFilter = {};
      if (query.q) {
        itemFilter.$text = { $search: query.q, $caseSensitive: false, $diacriticSensitive: false };
      }
      if (query.category) {
        itemFilter.category = query.category;
      }
      if (query.location) {
        itemFilter.$or = [
          'locationFound.campusArea',
          'locationFound.buildingName',
          'lastSeen.campusArea',
          'lastSeen.buildingName',
        ].map((key) => ({ [key]: query.location }));
      }
      if (query.from || query.to) {
        itemFilter.dateFoundOrLost = {
          ...(query.from ? { $gte: query.from } : {}),
          ...(query.to ? { $lte: query.to } : {}),
        };
      }
      const postFilter = { deletedAt: null, expiresAt: { $gt: new Date() } };
      if (owner) {
        postFilter.author = req.user._id;
      }
      if (query.type) {
        postFilter.type = query.type;
      }
      if (query.status) {
        postFilter.status = query.status;
      }
      const [page] = await Item.aggregate([
        { $match: itemFilter },
        { $project: itemProjection(owner) },
        {
          $lookup: {
            from: 'posts',
            localField: '_id',
            foreignField: 'item',
            pipeline: [{ $match: postFilter }, { $project: postProjection }],
            as: 'post',
          },
        },
        { $unwind: '$post' },
        ...joinAuthor,
        {
          $facet: {
            total: [{ $count: 'count' }],
            results: [
              { $sort: { 'post.createdAt': -1, 'post._id': -1 } },
              { $skip: (query.page - 1) * query.limit },
              { $limit: query.limit },
            ],
          },
        },
      ]).option({ maxTimeMS: 5000, allowDiskUse: false });
      const total = page.total[0]?.count || 0;
      res.json({
        posts: page.results.map((row) => postDTO(row.post, row, row.author, owner)),
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          pages: Math.ceil(total / query.limit),
        },
      });
    },
    async detail(req, res, owner = false) {
      if (owner) {
        const post = await Post.findOne({
          _id: req.validated.params.id,
          author: req.user._id,
          ...activePost(),
        }).select('+approvedClaim +approvedMatch');
        if (!post) {
          throw httpError(404, 'Not found');
        }
        const item = await Item.findById(post.item).select('+privateDetails');
        if (!item) {
          throw httpError(404, 'Not found');
        }
        return res.json({ post: postDTO(post, item, req.user, true) });
      }
      const [row] = await Post.aggregate([
        {
          $match: {
            _id: new mongoose.Types.ObjectId(req.validated.params.id),
            deletedAt: null,
            expiresAt: { $gt: new Date() },
          },
        },
        { $project: { ...postProjection, item: 1 } },
        {
          $lookup: {
            from: 'items',
            localField: 'item',
            foreignField: '_id',
            pipeline: [{ $project: itemProjection(false) }],
            as: 'item',
          },
        },
        { $unwind: '$item' },
        {
          $lookup: {
            from: 'users',
            localField: 'author',
            foreignField: '_id',
            pipeline: [{ $match: { isBanned: false } }, { $project: { displayName: 1 } }],
            as: 'author',
          },
        },
        { $unwind: '$author' },
      ]).option({ maxTimeMS: 5000 });
      if (!row) {
        throw httpError(404, 'Not found');
      }
      res.json({ post: postDTO(row, row.item, row.author) });
    },
    async edit(req, res) {
      const value = req.validated.body;
      let result;
      await withTransaction(async (session) => {
        await lockActor(session, req.user, req.auth.version);
        const post = await Post.findOne({
          _id: req.validated.params.id,
          author: req.user._id,
          ...activePost(),
        }).session(session);
        if (!post) {
          throw httpError(404, 'Not found');
        }
        if (post.revision !== value.revision) {
          throw httpError(409, 'Post changed. Reload and try again.');
        }
        if (!['open', 'closed'].includes(post.status)) {
          throw httpError(409, 'Post cannot be edited in its current state');
        }
        if (post.type === 'found' && value.images?.length === 0) {
          throw httpError(400, 'Found posts require an image');
        }
        const item = await Item.findOneAndUpdate(
          { _id: post.item },
          { $set: itemFields(value, post.type) },
          { new: true, runValidators: true, session }
        ).select('+privateDetails');
        if (!item) {
          throw httpError(404, 'Not found');
        }
        if (value.images) {
          await attachImages(value.images, post, req.user._id, session);
        }
        const updated = await Post.findOneAndUpdate(
          { _id: post._id, author: req.user._id, revision: value.revision, ...activePost() },
          {
            $set: { ...(value.status ? { status: value.status } : {}), updatedAt: new Date() },
            $inc: { revision: 1 },
          },
          { new: true, runValidators: true, session }
        );
        if (!updated) {
          throw httpError(409, 'Post changed. Reload and try again.');
        }
        result = postDTO(updated, item, req.user, true);
      });
      res.json({ post: result });
    },
    async remove(req, res) {
      const filter = { _id: req.validated.params.id, author: req.user._id, ...activePost() };
      const exists = await Post.exists(filter);
      if (!exists) {
        throw httpError(404, 'Not found');
      }
      const post = await Post.findOneAndUpdate(
        { ...filter, revision: req.validated.body.revision },
        { $set: { deletedAt: new Date(), status: 'closed' }, $inc: { revision: 1 } },
        { new: true }
      );
      if (!post) {
        throw httpError(409, 'Post changed. Reload and try again.');
      }
      logger('audit_post_delete', { actorId: String(req.user._id), outcome: 'hidden' });
      // Tombstone hides the post and attached images immediately; the resumable worker cascades deletion.
      res.status(204).end();
    },
  };
}
module.exports = { createPostController };
