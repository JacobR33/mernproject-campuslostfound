const { lockActor } = require('../lib/lockActor');
const mongoose = require('mongoose');
const { Conversation, Post, Message } = require('../models');
const { withTransaction } = require('../lib/transaction');
const { httpError } = require('../lib/httpError');
const { trusted } = mongoose;
function accessPipeline(userId, id) {
  return [
    { $match: { closedAt: null, participants: userId, ...(id ? { _id: new mongoose.Types.ObjectId(id) } : {}) } },
    { $match: { $expr: { $eq: [{ $size: '$participants' }, 2] } } },
    {
      $lookup: {
        from: 'posts',
        localField: 'post',
        foreignField: '_id',
        pipeline: [
          {
            $match: {
              deletedAt: null,
              expiresAt: { $gt: new Date() },
              status: { $in: ['open', 'claim_pending', 'returned'] },
            },
          },
          {
            $project: {
              type: 1,
              status: 1,
              item: 1,
              author: 1,
              approvedClaim: 1,
              approvedMatch: 1,
            },
          },
        ],
        as: 'post',
      },
    },
    { $unwind: '$post' },
    {
      $lookup: {
        from: 'users',
        localField: 'participants',
        foreignField: '_id',
        pipeline: [
          { $match: { emailVerified: true, isBanned: false } },
          { $project: { displayName: 1 } },
        ],
        as: 'people',
      },
    },
    {
      $match: {
        $expr: {
          $and: [{ $eq: [{ $size: '$people' }, 2] }, { $in: ['$post.author', '$participants'] }],
        },
      },
    },
    {
      $lookup: {
        from: 'claims',
        localField: 'claim',
        foreignField: '_id',
        pipeline: [
          { $match: { status: 'approved' } },
          { $project: { post: 1, claimant: 1, conversation: 1 } },
        ],
        as: 'proof',
      },
    },
    {
      $lookup: {
        from: 'matchrequests',
        localField: 'matchRequest',
        foreignField: '_id',
        pipeline: [
          { $match: { status: 'accepted' } },
          { $project: { post: 1, requester: 1, conversation: 1 } },
        ],
        as: 'matchProof',
      },
    },
    {
      $set: {
        proof: { $arrayElemAt: ['$proof', 0] },
        matchProof: { $arrayElemAt: ['$matchProof', 0] },
      },
    },
    {
      $match: {
        $expr: {
          $or: [
            {
              $and: [
                { $eq: ['$post.type', 'found'] },
                { $eq: ['$proof.post', '$post._id'] },
                { $eq: ['$proof.conversation', '$_id'] },
                { $in: ['$proof.claimant', '$participants'] },
                { $ne: ['$proof.claimant', '$post.author'] },
              ],
            },
            {
              $and: [
                { $in: ['$post.type', ['lost', 'found']] },
                { $eq: ['$matchProof.post', '$post._id'] },
                { $eq: ['$matchProof.conversation', '$_id'] },
                { $in: ['$matchProof.requester', '$participants'] },
                { $ne: ['$matchProof.requester', '$post.author'] },
              ],
            },
          ],
        },
      },
    },
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
    {
      $project: {
        post: 1,
        people: 1,
        item: 1,
        participants: 1,
        messageSequence: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    },
  ];
}
async function accessConversation(userId, id, session) {
  const [result] = await Conversation.aggregate(accessPipeline(userId, id))
    .session(session || null)
    .option({ maxTimeMS: 5000 });
  if (!result) {
    throw httpError(404, 'Not found');
  }
  return result;
}
const conversationDTO = (row) => ({
  id: String(row._id),
  post: {
    id: String(row.post._id),
    title: row.item.title,
    type: row.post.type,
    status: row.post.status,
  },
  participants: row.people.map((person) => ({
    id: String(person._id),
    displayName: person.displayName,
  })),
  updatedAt: row.updatedAt,
  createdAt: row.createdAt,
});
function messageDTO(row, access) {
  const sender = access.people.find((person) => String(person._id) === String(row.sender));
  if (!sender) {
    throw httpError(404, 'Not found');
  }
  return {
    id: String(row._id),
    conversationId: String(row.conversation),
    sender: { id: String(sender._id), displayName: sender.displayName },
    body: row.body,
    sequence: row.sequence,
    clientMessageId: row.clientMessageId,
    createdAt: row.createdAt,
  };
}
async function saveMessage(identity, value) {
  let result;
  await withTransaction(async (session) => {
    await lockActor(session, identity.user, identity.claims.ver);
    const access = await accessConversation(identity.user._id, value.conversationId, session);
    const locked = await Post.updateOne(
      { _id: access.post._id, deletedAt: null, expiresAt: trusted({ $gt: new Date() }) },
      { $inc: { chatVersion: 1 } },
      { session }
    );
    if (!locked.matchedCount) {
      throw httpError(404, 'Not found');
    }
    const previous = await Message.findOne({
      conversation: value.conversationId,
      sender: identity.user._id,
      clientMessageId: value.clientMessageId,
    }).session(session);
    if (previous) {
      if (previous.body !== value.body) {
        throw httpError(409, 'Message ID already used');
      }
      result = { message: messageDTO(previous, access), created: false };
      return;
    }
    if (identity.claims.exp * 1000 <= Date.now()) {
      throw Object.assign(new Error('Authentication required'), { authStatus: 401 });
    }
    const conversation = await Conversation.findOneAndUpdate(
      { _id: value.conversationId, participants: identity.user._id, closedAt: null },
      { $inc: { messageSequence: 1 }, $set: { updatedAt: new Date() } },
      { new: true, session }
    );
    if (!conversation) {
      throw httpError(404, 'Not found');
    }
    const [message] = await Message.create(
      [
        {
          conversation: conversation._id,
          sender: identity.user._id,
          clientMessageId: value.clientMessageId,
          body: value.body,
          sequence: conversation.messageSequence,
        },
      ],
      { session }
    );
    result = { message: messageDTO(message, access), created: true };
  });
  return result;
}
module.exports = { accessPipeline, accessConversation, conversationDTO, messageDTO, saveMessage };
