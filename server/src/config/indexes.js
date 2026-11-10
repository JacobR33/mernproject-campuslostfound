const { User, Post, Item, Claim, Conversation, Message } = require('../models');
const Notification = require('../models/notification');
const MatchRequest = require('../models/matchRequest');
async function assertAuthIndexes() {
  const indexes = await User.collection.indexes();
  if (
    !indexes.some(
      (index) =>
        index.unique === true &&
        !index.partialFilterExpression &&
        !index.sparse &&
        index.key.email === 1 &&
        Object.keys(index.key).length === 1
    )
  ) {
    throw new Error('Required authentication indexes missing');
  }
}
async function assertPostIndexes() {
  const postIndexes = await Post.collection.indexes();
  const itemIndexes = await Item.collection.indexes();
  const uniqueItem = postIndexes.some(
    (index) =>
      index.unique === true &&
      !index.partialFilterExpression &&
      index.key.item === 1 &&
      Object.keys(index.key).length === 1
  );
  const publicText = itemIndexes.some(
    (index) =>
      index.weights &&
      Object.keys(index.weights).length === 2 &&
      index.weights.title &&
      index.weights.publicDescription
  );
  if (!uniqueItem || !publicText) {
    throw new Error('Required post indexes missing');
  }
}
async function assertClaimIndexes() {
  const claims = await Claim.collection.indexes();
  const conversations = await Conversation.collection.indexes();
  const notifications = await Notification.collection.indexes();
  const unique = (indexes, fields) =>
    indexes.some(
      (index) =>
        index.unique === true &&
        !index.partialFilterExpression &&
        Object.keys(index.key).length === fields.length &&
        fields.every((field) => index.key[field] === 1)
    );
  if (
    !unique(claims, ['post', 'claimant']) ||
    !unique(
      conversations.filter((index) => index.sparse === true),
      ['claim']
    ) ||
    !unique(notifications, ['recipient', 'claim', 'kind', 'attemptCount'])
  ) {
    throw new Error('Required claim indexes missing');
  }
}
async function assertChatIndexes() {
  const matches = await MatchRequest.collection.indexes();
  const conversations = await Conversation.collection.indexes();
  const messages = await Message.collection.indexes();
  if (
    !matches.some(
      (index) =>
        index.unique === true &&
        !index.partialFilterExpression &&
        index.key.post === 1 &&
        index.key.requester === 1 &&
        Object.keys(index.key).length === 2
    ) ||
    !conversations.some(
      (index) =>
        index.unique === true &&
        index.sparse === true &&
        index.key.matchRequest === 1 &&
        Object.keys(index.key).length === 1
    ) ||
    !messages.some(
      (index) =>
        index.unique === true &&
        index.key.conversation === 1 &&
        index.key.sender === 1 &&
        index.key.clientMessageId === 1 &&
        Object.keys(index.key).length === 3 &&
        index.partialFilterExpression?.clientMessageId?.$type === 'string'
    )
  ) {
    throw new Error('Required chat indexes missing');
  }
}
async function assertModerationIndexes() {
  const indexes = await require('../models/report').collection.indexes();
  if (
    !indexes.some(
      (index) =>
        index.unique === true &&
        !index.partialFilterExpression &&
        !index.sparse &&
        index.key.post === 1 &&
        index.key.reporter === 1 &&
        Object.keys(index.key).length === 2
    )
  ) {
    throw new Error('Required moderation indexes missing');
  }
}
async function assertRetentionIndexes() {
  const { AuthSession, RateBucket, MailOutbox } = require('../models/auth');
  for (const model of [AuthSession, RateBucket, MailOutbox]) {
    const indexes = await model.collection.indexes();
    if (
      !indexes.some(
        (index) =>
          index.expireAfterSeconds === 0 &&
          !index.partialFilterExpression &&
          !index.sparse &&
          index.key.expiresAt === 1 &&
          Object.keys(index.key).length === 1
      )
    ) {
      throw new Error('Required retention indexes missing');
    }
  }
}
module.exports = {
  assertAuthIndexes,
  assertPostIndexes,
  assertClaimIndexes,
  assertChatIndexes,
  assertModerationIndexes,
  assertRetentionIndexes,
};
